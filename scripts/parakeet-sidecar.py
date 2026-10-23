#!/usr/bin/env python3
"""Local Parakeet ASR sidecar for the Next Coder gateway.

The gateway never imports Python and never blocks its event loop on inference: `src/transcription.mjs`
POSTs a clip here over HTTP and waits on a socket, exactly as it would wait on a hosted API. This
process is the other end of that socket and nothing else — it owns the model, the audio decoding and
the inference, and it holds no gateway state.

Runtime is onnxruntime via onnx-asr, not nemo_toolkit. NVIDIA publishes parakeet-tdt-0.6b-v2 as a
2.4 GB `.nemo` archive that only NeMo can open, and NeMo pulls in PyTorch, Lightning and Hydra to
run 600M parameters of CPU inference. istupakov/parakeet-tdt-0.6b-v2-onnx is the same checkpoint
exported to ONNX; the int8 export is ~630 MB and onnxruntime plus numpy is the entire dependency
list. Same weights, same English-only model, a dependency surface that installs in seconds.

Wire protocol (what src/transcription.mjs sends and expects back):

    POST /v1/transcribe            multipart/form-data
      model             str        checkpoint the caller believes is loaded
      language          str        BCP-47 primary subtag; v2 is English only
      max_clip_seconds  str        caller's ceiling, enforced here as well
      sample_rate       str        optional, from the WAV header when the caller could read it
      channels          str        optional, likewise
      file              binary     the clip, with its content type

    200 {"text", "model", "language", "durationSeconds", "timings": {"decodeMs", "inferenceMs"}}
    4xx {"error": "..."}           terminal to the gateway: no retry changes the answer
    5xx {"error": "..."}           retryable

Start it with:

    npm run parakeet:sidecar
    # or
    .venv-parakeet/bin/python scripts/parakeet-sidecar.py --port 8977
"""

from __future__ import annotations

import argparse
import errno
import json
import io
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
import wave
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8977
DEFAULT_PATH = "/v1/transcribe"
DEFAULT_MODEL_DIR = ".data/models/parakeet-tdt-0.6b-v2-onnx"
DEFAULT_MODEL = "nvidia/parakeet-tdt-0.6b-v2"
DEFAULT_PRECISION = "int8"
TARGET_SAMPLE_RATE = 16_000
MAX_UPLOAD_BYTES = 64 * 1024 * 1024

# The checkpoint is English. Pointing it at another language does not produce that language, it
# produces confident English-shaped nonsense — which would then be dispatched to an agent as if the
# user had said it. The gateway refuses the mismatch before it gets here; this is the same refusal
# on the other side of the wire, so a hand-rolled caller cannot route around it.
ENGLISH_ONLY_MODELS = {
    "nvidia/parakeet-tdt-0.6b-v2",
    "nemo-parakeet-tdt-0.6b-v2",
    "istupakov/parakeet-tdt-0.6b-v2-onnx",
}

# Containers the sidecar will decode, mirroring PARAKEET_ACCEPTED_CONTENT_TYPES on the gateway.
# WAV is decoded in-process; everything else needs ffmpeg.
NATIVE_CONTENT_TYPES = {"audio/wav", "audio/x-wav", "audio/wave"}
FFMPEG_CONTENT_TYPES = {"audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/m4a"}

log = logging.getLogger("parakeet-sidecar")


class ClientError(Exception):
    """A request that will fail identically however many times it is retried."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


# --- audio ------------------------------------------------------------------------------------


def decode_audio(data: bytes, content_type: str) -> tuple["np.ndarray", float]:
    """Returns 16 kHz mono float32 PCM plus the clip length in seconds."""
    content_type = (content_type or "").split(";")[0].strip().lower()
    if content_type in NATIVE_CONTENT_TYPES:
        try:
            return decode_wav(data)
        except wave.Error:
            # A ".wav" that is not plain PCM — some encoders write ADPCM or a float subformat.
            # ffmpeg can still read it, so fall through rather than refusing a real recording.
            if ffmpeg_path():
                return decode_with_ffmpeg(data)
            raise ClientError(
                "The upload is labelled audio/wav but is not PCM WAV, and ffmpeg is not installed "
                "to decode it.",
                status=415,
            ) from None
    if content_type in FFMPEG_CONTENT_TYPES:
        if not ffmpeg_path():
            raise ClientError(
                f"Decoding {content_type} needs ffmpeg on PATH. Install it (brew install ffmpeg) or "
                "have the client upload 16 kHz mono WAV, which this sidecar decodes on its own.",
                status=415,
            )
        return decode_with_ffmpeg(data)
    raise ClientError(
        f"Unsupported content type {content_type or '(none)'}. Accepted: "
        + ", ".join(sorted(NATIVE_CONTENT_TYPES | FFMPEG_CONTENT_TYPES))
        + ".",
        status=415,
    )


def decode_wav(data: bytes) -> tuple["np.ndarray", float]:
    with wave.open(io.BytesIO(data), "rb") as clip:
        channels = clip.getnchannels()
        width = clip.getsampwidth()
        rate = clip.getframerate()
        frames = clip.readframes(clip.getnframes())

    if width not in (1, 2, 3, 4):
        raise ClientError(f"WAV sample width {width * 8} bit is not supported.", status=415)

    samples = pcm_to_float32(frames, width)
    if channels > 1:
        usable = (samples.size // channels) * channels
        samples = samples[:usable].reshape(-1, channels).mean(axis=1)
    duration = samples.size / rate if rate else 0.0
    return resample(samples, rate), duration


def pcm_to_float32(frames: bytes, width: int) -> "np.ndarray":
    if width == 1:
        # 8-bit WAV is unsigned by definition.
        return (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    if width == 2:
        return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if width == 3:
        raw = np.frombuffer(frames, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        value = raw[:, 0] | (raw[:, 1] << 8) | (raw[:, 2] << 16)
        value = np.where(value & 0x800000, value - 0x1000000, value)
        return value.astype(np.float32) / 8388608.0
    return np.frombuffer(frames, dtype="<i4").astype(np.float32) / 2147483648.0


def resample(samples: "np.ndarray", rate: int) -> "np.ndarray":
    """Linear resample to 16 kHz.

    A controller uploads 16 kHz mono already, so the common path is a no-op. Browser capture arrives
    at 48 kHz, where linear interpolation is adequate for a speech model whose front end throws away
    everything above 8 kHz anyway.
    """
    if rate == TARGET_SAMPLE_RATE or samples.size == 0:
        return np.ascontiguousarray(samples, dtype=np.float32)
    if rate <= 0:
        raise ClientError("The audio declares a sample rate of zero.", status=415)
    count = int(round(samples.size * TARGET_SAMPLE_RATE / rate))
    if count <= 0:
        raise ClientError("The audio is too short to resample.", status=415)
    source = np.linspace(0.0, samples.size - 1, num=count, dtype=np.float64)
    return np.interp(source, np.arange(samples.size), samples).astype(np.float32)


def decode_with_ffmpeg(data: bytes) -> tuple["np.ndarray", float]:
    """Decodes a compressed container to 16 kHz mono float32 by shelling out to ffmpeg.

    The clip goes to a temporary file rather than down ffmpeg's stdin. An MP4 written by Safari
    keeps its moov atom at the end of the file, and ffmpeg cannot seek a pipe — piping one in
    produces a clean exit and zero samples, which reads as "the microphone recorded silence"
    rather than "this container needs a seekable input". A file is seekable and costs one write.
    """
    with tempfile.NamedTemporaryFile(prefix="parakeet-", suffix=".clip", delete=True) as clip:
        clip.write(data)
        clip.flush()
        command = [
            ffmpeg_path(), "-hide_banner", "-loglevel", "error",
            "-i", clip.name,
            "-ac", "1", "-ar", str(TARGET_SAMPLE_RATE), "-f", "f32le", "pipe:1",
        ]
        try:
            result = subprocess.run(command, capture_output=True, timeout=120, check=False)
        except subprocess.TimeoutExpired:
            raise ClientError("ffmpeg did not finish decoding the clip within 120s.", status=500) from None

    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip().splitlines()
        raise ClientError(
            "ffmpeg could not decode the upload: " + (detail[-1] if detail else "no detail given"),
            status=415,
        )
    samples = np.frombuffer(result.stdout, dtype="<f4")
    return np.ascontiguousarray(samples), samples.size / TARGET_SAMPLE_RATE


_FFMPEG: str | None | bool = False


def ffmpeg_path() -> str | None:
    global _FFMPEG
    if _FFMPEG is False:
        import shutil

        _FFMPEG = shutil.which("ffmpeg")
    return _FFMPEG  # type: ignore[return-value]


# --- model ------------------------------------------------------------------------------------


class Recognizer:
    """The loaded model, plus the lock that keeps one graph to one clip at a time."""

    def __init__(self, model_dir: Path, precision: str, model_name: str) -> None:
        self.model_dir = model_dir
        self.precision = precision
        self.model_name = model_name
        self._lock = threading.Lock()
        started = time.monotonic()
        import onnx_asr

        self._model = onnx_asr.load_model(
            "nemo-parakeet-tdt-0.6b-v2",
            str(model_dir),
            quantization=None if precision == "fp32" else precision,
        )
        self.load_seconds = time.monotonic() - started

    def transcribe(self, samples: "np.ndarray") -> str:
        # onnxruntime sessions are thread-safe, but a single CPU model served concurrently just
        # makes every clip slower; the gateway's own gate defaults to one in flight for the same
        # reason. Serialising here means that holds however many callers there are.
        with self._lock:
            return self._model.recognize(samples, sample_rate=TARGET_SAMPLE_RATE)

    def warm_up(self) -> float:
        """Runs a second of silence so the first real clip does not pay for graph initialisation."""
        started = time.monotonic()
        self.transcribe(np.zeros(TARGET_SAMPLE_RATE, dtype=np.float32))
        return time.monotonic() - started


# --- http -------------------------------------------------------------------------------------


def parse_multipart(body: bytes, content_type: str) -> dict[str, object]:
    """Fields by name; the file field becomes {"filename", "contentType", "bytes"}."""
    if "multipart/form-data" not in content_type:
        raise ClientError("Expected a multipart/form-data body.")
    parsed = BytesParser(policy=HTTP).parsebytes(
        b"Content-Type: " + content_type.encode("utf-8") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    )
    if not parsed.is_multipart():
        raise ClientError("The multipart body could not be parsed; check the boundary.")

    fields: dict[str, object] = {}
    for part in parsed.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        filename = part.get_filename()
        payload = part.get_payload(decode=True) or b""
        if filename is None:
            fields[name] = payload.decode("utf-8", "replace").strip()
        else:
            fields[name] = {
                "filename": filename,
                "contentType": part.get_content_type(),
                "bytes": payload,
            }
    return fields


def handle_transcribe(recognizer: Recognizer, fields: dict[str, object], default_language: str) -> dict:
    upload = fields.get("file")
    if not isinstance(upload, dict) or not upload.get("bytes"):
        raise ClientError("No audio was attached under the 'file' field.")

    requested_model = str(fields.get("model") or recognizer.model_name)
    if requested_model not in ENGLISH_ONLY_MODELS and requested_model != recognizer.model_name:
        raise ClientError(
            f"This sidecar has {recognizer.model_name} loaded, but the caller asked for "
            f"{requested_model}. Start a sidecar for that checkpoint or correct PARAKEET_MODEL.",
        )

    language = (str(fields.get("language") or default_language) or "en").lower().split("-")[0]
    if requested_model in ENGLISH_ONLY_MODELS and language != "en":
        raise ClientError(
            f"{requested_model} transcribes English only, but the request asked for '{language}'. "
            "Load a multilingual checkpoint rather than expecting an English model to cope.",
        )

    decode_started = time.monotonic()
    samples, duration = decode_audio(upload["bytes"], upload.get("contentType", ""))
    decode_ms = (time.monotonic() - decode_started) * 1000

    if samples.size == 0:
        raise ClientError("The upload decoded to zero samples.", status=415)

    max_clip_seconds = positive_float(fields.get("max_clip_seconds"))
    if max_clip_seconds and duration > max_clip_seconds:
        raise ClientError(
            f"Audio clip is {duration:.1f}s, over the {max_clip_seconds:g}s limit the caller set.",
        )

    inference_started = time.monotonic()
    text = recognizer.transcribe(samples)
    inference_ms = (time.monotonic() - inference_started) * 1000

    log.info(
        "transcribed %.2fs of audio in %.0fms (decode %.0fms, rtf %.2f)",
        duration, inference_ms, decode_ms, inference_ms / (duration * 1000) if duration else 0.0,
    )
    return {
        "text": text,
        "model": recognizer.model_name,
        "language": language,
        "durationSeconds": round(duration, 3),
        "timings": {"decodeMs": round(decode_ms), "inferenceMs": round(inference_ms)},
    }


def positive_float(value: object) -> float | None:
    try:
        parsed = float(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def build_handler(recognizer: Recognizer, route: str, api_key: str | None, language: str):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "parakeet-sidecar"

        def log_message(self, fmt: str, *args) -> None:  # noqa: A002
            log.debug("%s - %s", self.address_string(), fmt % args)

        def _send(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            if self.path.split("?")[0] in ("/healthz", "/health", "/"):
                self._send(200, {
                    "status": "ok",
                    "model": recognizer.model_name,
                    "precision": recognizer.precision,
                    "modelDir": str(recognizer.model_dir),
                    "route": route,
                })
                return
            self._send(404, {"error": f"No such route {self.path}."})

        def do_POST(self) -> None:  # noqa: N802
            if self.path.split("?")[0] != route:
                self._send(404, {"error": f"No such route {self.path}. Transcription is at {route}."})
                return
            if api_key and self.headers.get("authorization") != f"Bearer {api_key}":
                self._send(401, {"error": "Bad or missing bearer token."})
                return

            try:
                length = int(self.headers.get("content-length") or 0)
            except ValueError:
                self._send(400, {"error": "Invalid content-length."})
                return
            if length <= 0:
                self._send(400, {"error": "Empty request body."})
                return
            if length > MAX_UPLOAD_BYTES:
                self._send(413, {"error": f"Upload exceeds {MAX_UPLOAD_BYTES} bytes."})
                return

            body = self.rfile.read(length)
            try:
                fields = parse_multipart(body, self.headers.get("content-type", ""))
                self._send(200, handle_transcribe(recognizer, fields, language))
            except ClientError as error:
                log.warning("rejected audio request (status %s)", error.status)
                self._send(error.status, {"error": str(error)})
            except Exception as error:  # noqa: BLE001
                # Anything unexpected is the sidecar's fault, not the caller's, so it is a 5xx and
                # the gateway is right to try the clip again.
                log.error("transcription failed (%s)", type(error).__name__)
                self._send(500, {"error": f"{type(error).__name__}: {error}"})

    return Handler


# --- startup ----------------------------------------------------------------------------------


def require_dependencies() -> None:
    global np
    missing = []
    try:
        import numpy as np  # noqa: PLC0415
    except ImportError:
        missing.append("numpy")
    try:
        import onnx_asr  # noqa: F401,PLC0415
    except ImportError:
        missing.append("onnx-asr")
    try:
        import onnxruntime  # noqa: F401,PLC0415
    except ImportError:
        missing.append("onnxruntime")
    if missing:
        sys.exit(
            f"\nMissing Python packages: {', '.join(missing)}.\n\n"
            "This sidecar wants its own virtualenv rather than the system interpreter:\n\n"
            "    uv venv --python 3.12 .venv-parakeet\n"
            "    uv pip install --python .venv-parakeet/bin/python onnx-asr onnxruntime\n"
            "    .venv-parakeet/bin/python scripts/parakeet-sidecar.py\n\n"
            "(or `python3 -m venv .venv-parakeet && .venv-parakeet/bin/pip install onnx-asr onnxruntime`)\n"
        )


def require_model(model_dir: Path, precision: str) -> None:
    encoder = "encoder-model.onnx" if precision == "fp32" else f"encoder-model.{precision}.onnx"
    needed = ["config.json", "vocab.txt", "nemo128.onnx", encoder]
    absent = [name for name in needed if not (model_dir / name).is_file()]
    if not absent:
        return
    sys.exit(
        f"\nThe Parakeet weights are not in {model_dir} (missing: {', '.join(absent)}).\n\n"
        "Fetch them first — they are CC-BY-4.0 and need no Hugging Face token:\n\n"
        f"    npm run parakeet:fetch{'' if precision == 'int8' else f' -- --precision {precision}'}\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Local Parakeet ASR sidecar for the gateway.")
    parser.add_argument("--host", default=os.environ.get("PARAKEET_SIDECAR_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PARAKEET_SIDECAR_PORT", DEFAULT_PORT)))
    parser.add_argument("--model-dir", default=os.environ.get("PARAKEET_MODEL_DIR", DEFAULT_MODEL_DIR))
    parser.add_argument(
        "--precision",
        choices=["int8", "fp32"],
        default=os.environ.get("PARAKEET_MODEL_PRECISION", DEFAULT_PRECISION),
    )
    parser.add_argument("--model-name", default=os.environ.get("PARAKEET_MODEL", DEFAULT_MODEL))
    parser.add_argument("--language", default=os.environ.get("PARAKEET_LANGUAGE", "en"))
    parser.add_argument("--route", default=DEFAULT_PATH)
    parser.add_argument("--api-key", default=os.environ.get("PARAKEET_API_KEY"))
    parser.add_argument("--no-warmup", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    require_dependencies()
    model_dir = Path(args.model_dir).expanduser().resolve()
    require_model(model_dir, args.precision)

    log.info("loading %s (%s)", args.model_name, args.precision)
    try:
        recognizer = Recognizer(model_dir, args.precision, args.model_name)
    except Exception as error:  # noqa: BLE001
        sys.exit(
            f"\nLoading the model failed: {type(error).__name__}: {error}\n\n"
            "If this mentions a protobuf or ONNX parse error the weights are probably truncated.\n"
            "Re-verify them with:  node scripts/fetch-parakeet-model.mjs --check\n"
        )
    log.info("model ready in %.1fs", recognizer.load_seconds)

    if not args.no_warmup:
        log.info("warm-up pass took %.1fs", recognizer.warm_up())

    # Bind failures are the one startup error a person is likely to hit twice, because the usual
    # cause is a sidecar they already started and forgot — often detached, so it is not in any
    # window they can see. A bare OSError traceback here also wastes the model load that just
    # succeeded, which is the most expensive part of starting up.
    try:
        server = ThreadingHTTPServer((args.host, args.port), build_handler(
            recognizer, args.route, args.api_key, args.language,
        ))
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise
        log.error("port %d on %s is already in use.", args.port, args.host)
        log.error("Most likely another parakeet sidecar is already running — quite possibly a")
        log.error("detached one with no terminal of its own. Find it and decide which to keep:")
        log.error("    lsof -nP -iTCP:%d -sTCP:LISTEN", args.port)
        log.error("If it is a healthy sidecar you can simply use it; check with:")
        log.error("    curl http://%s:%d/healthz", args.host, args.port)
        log.error("Otherwise stop it, or start this one elsewhere with --port <n> (and set")
        log.error("PARAKEET_URL to match).")
        raise SystemExit(1)
    server.daemon_threads = True
    url = f"http://{args.host}:{args.port}{args.route}"
    log.info("listening on %s", url)
    log.info("point the gateway at it with PARAKEET_URL=%s and TRANSCRIPTION_PROVIDER=parakeet", url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("stopping")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
