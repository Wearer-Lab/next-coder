import { createHash } from "node:crypto";
import { connectorAuthorization } from "./http.mjs";

export const DEFAULT_PARAKEET_URL = "http://127.0.0.1:8977/v1/transcribe";
export const MAX_VOICE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/webm", "audio/ogg", "audio/mpeg", "audio/flac", "audio/mp4"]);
const opaqueId = (value) => typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/u.test(value);
function fail(code, message, retryable = false) { return Object.assign(new Error(message), { code, retryable }); }

export function validateParakeetUrl(value = DEFAULT_PARAKEET_URL) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
      || url.pathname !== "/v1/transcribe" || url.search || url.hash || url.username || url.password) {
    throw fail("TRANSCRIPTION_UNCONFIGURED", "Local transcription must use a loopback /v1/transcribe endpoint.");
  }
  return url.href;
}

async function boundedBody(response, limit, signal) {
  if (Number(response.headers.get("content-length")) > limit) throw fail("TRANSCRIPTION_INVALID_AUDIO", "Voice payload exceeds its size limit.");
  const chunks = [];
  let length = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw fail("TRANSCRIPTION_INVALID_AUDIO", "Voice payload exceeds its size limit.");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal?.removeEventListener("abort", cancel); reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

export async function inspectLocalTranscription({ url = DEFAULT_PARAKEET_URL, fetchImpl = globalThis.fetch, signal = null } = {}) {
  try {
    const endpoint = validateParakeetUrl(url);
    const healthSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000);
    const response = await fetchImpl(new URL("/healthz", endpoint), { redirect: "error", signal: healthSignal });
    if (!response.ok) return { ready: false, code: "TRANSCRIPTION_UNAVAILABLE" };
    const payload = JSON.parse((await boundedBody(response, 8192, healthSignal)).toString("utf8"));
    return payload.status === "ok" && payload.model === "nvidia/parakeet-tdt-0.6b-v2" && payload.precision === "int8" ? { ready: true, provider: "parakeet-local", model: String(payload.model ?? "").slice(0, 128), language: "en" }
      : { ready: false, code: "TRANSCRIPTION_UNAVAILABLE" };
  } catch { return { ready: false, code: "TRANSCRIPTION_UNAVAILABLE" }; }
}

export function createLocalTranscriber({ state, fetchImpl = globalThis.fetch, url = state?.voice?.url ?? DEFAULT_PARAKEET_URL, timeoutMs = 120000, ensureReady = null } = {}) {
  const endpoint = validateParakeetUrl(url);
  let busy = false;
  return {
    health: () => inspectLocalTranscription({ url: endpoint, fetchImpl }),
    async transcribe(payload, { signal } = {}) {
      if (!opaqueId(payload?.mediaId) || !opaqueId(payload?.jobId) || Object.keys(payload).some((key) => !["mediaId", "jobId"].includes(key))) {
        throw fail("TRANSCRIPTION_INVALID_AUDIO", "Voice processing requires only valid media and job identifiers.");
      }
      const cloud = new URL(state.server);
      if (cloud.protocol !== "https:" || cloud.username || cloud.password) throw fail("TRANSCRIPTION_UNCONFIGURED", "Voice media requires a secure cloud origin.");
      if (busy) throw fail("TRANSCRIPTION_UNAVAILABLE", "Local transcription is busy; retry later.", true);
      busy = true;
      const deadline = AbortSignal.timeout(Math.max(1000, Math.min(120000, timeoutMs)));
      const activeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      try {
        activeSignal.throwIfAborted();
        let health = await inspectLocalTranscription({ url: endpoint, fetchImpl, signal: activeSignal });
        if (!health.ready && ensureReady) {
          await ensureReady({ signal: activeSignal });
          health = await inspectLocalTranscription({ url: endpoint, fetchImpl, signal: activeSignal });
        }
        if (!health.ready) throw fail("TRANSCRIPTION_UNAVAILABLE", "Local speech runtime is unavailable. Run next-coder-connect voice setup, then restart the connector.", true);
        const mediaUrl = new URL(`/v1/connector/media/${encodeURIComponent(payload.mediaId)}`, cloud.origin);
        mediaUrl.searchParams.set("jobId", payload.jobId);
        const media = await fetchImpl(mediaUrl, { headers: { authorization: connectorAuthorization(state) }, signal: activeSignal, redirect: "error" });
        if (!media.ok) throw media.status >= 500 || media.status === 429
          ? fail("TRANSCRIPTION_UNAVAILABLE", "Voice media is temporarily unavailable.", true)
          : fail("MEDIA_ACCESS_DENIED", "The cloud did not authorize this voice job.");
        const type = (media.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (!AUDIO_TYPES.has(type)) throw fail("TRANSCRIPTION_INVALID_AUDIO", "The voice job is not a supported audio type.");
        const bytes = await boundedBody(media, MAX_VOICE_BYTES, activeSignal);
        if (!bytes.length) throw fail("TRANSCRIPTION_INVALID_AUDIO", "The voice recording is empty.");
        const digest = media.headers.get("x-media-sha256");
        if (!digest || !/^[a-f0-9]{64}$/iu.test(digest) || createHash("sha256").update(bytes).digest("hex") !== digest.toLowerCase()) {
          throw fail("TRANSCRIPTION_INVALID_AUDIO", "The voice recording checksum is invalid.");
        }
        const form = new FormData();
        form.set("model", "nvidia/parakeet-tdt-0.6b-v2");
        form.set("language", "en");
        form.set("max_clip_seconds", "60");
        form.set("file", new Blob([bytes], { type }), "recording.audio");
        const inferenceStarted = performance.now();
        const response = await fetchImpl(endpoint, { method: "POST", body: form, signal: activeSignal, redirect: "error" });
        if (!response.ok) throw response.status >= 500 || response.status === 429
          ? fail("TRANSCRIPTION_UNAVAILABLE", "Local speech processing failed.", true)
          : fail("TRANSCRIPTION_INVALID_AUDIO", "Local speech processing could not decode this recording.");
        const result = JSON.parse((await boundedBody(response, MAX_TEXT_BYTES, activeSignal)).toString("utf8"));
        if (typeof result.text !== "string" || !result.text.trim() || result.text.length > 12000) throw fail("TRANSCRIPTION_EMPTY", "Local speech processing returned no usable bounded transcript.");
        return { text: result.text.trim(), language: "en", provider: "parakeet-local", model: "nvidia/parakeet-tdt-0.6b-v2",
          durationMs: Math.max(0, Math.min(300000, Math.round(performance.now() - inferenceStarted))) };
      } catch (error) {
        if (activeSignal.aborted) throw fail("TRANSCRIPTION_TIMEOUT", "Local speech processing was cancelled or timed out.", true);
        if (error?.code?.startsWith("TRANSCRIPTION_") || error?.code === "MEDIA_ACCESS_DENIED") throw error;
        throw fail("TRANSCRIPTION_UNAVAILABLE", "Local speech processing could not complete.", true);
      } finally { busy = false; }
    },
  };
}
