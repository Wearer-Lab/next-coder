/**
 * Media creation surfaces shared by the Media library and the Operate composer.
 *
 * `MediaCaptureDialog` owns the three ways to make a new upload (file, microphone, camera); the
 * capture mechanics themselves stay in `useAudioRecorder`/`useCameraCapture` so there is exactly
 * one implementation of permission handling and teardown. `MediaPicker` is the read-only list of
 * existing uploads, used by the composer to attach something already stored.
 */

import {
  Camera,
  FileAudio,
  FileImage,
  FileUp,
  Image,
  Mic,
  Square,
  UploadCloud,
  VideoOff,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { recordingActivity } from "../activity";
import type { Controller, MediaUploadProgress } from "../controller";
import { CAPTURE_STATUS_LABEL, useAudioRecorder, useCameraCapture } from "../mediaCapture";
import { ActivityOrb } from "../motion";
import type { MediaItem } from "../types";
import { Button, EmptyState, Field, StatusBadge } from "../ui";

export type MediaSource = "upload" | "audio" | "camera";

export const MEDIA_FILE_ACCEPT =
  "image/png,image/jpeg,image/webp,audio/wav,audio/mpeg,audio/mp4,audio/webm,audio/ogg";

/** Only images and audio can become agent context, whatever the OS lets the user drop. */
export function isAttachableFile(file: { type?: string }): boolean {
  const type = file.type ?? "";
  return type.startsWith("image/") || type.startsWith("audio/");
}

/**
 * The one name a capture goes by, everywhere.
 *
 * The gateway derives it (device, destination thread, time) because it is the only side that knows
 * all three; the client never composes its own, so what the library shows and what an attachment
 * chip shows cannot drift apart. `originalName` is the fallback for a record served by an older
 * gateway, and the id is the last resort.
 */
export function mediaLabel(item: MediaItem): string {
  return item.displayName ?? item.originalName ?? item.id;
}

export function mediaState(item: MediaItem): string {
  const processing = item.processing ?? {};
  const status = item.kind === "image"
    ? processing.visionStatus ?? (item.description ? "described" : "stored")
    : processing.transcriptionStatus ?? (item.transcript ? "transcribed" : "stored");
  return status === "not_applicable" ? "stored" : status;
}

export function mediaOriginLabel(item: MediaItem): string {
  const source = item.origin?.source;
  if (source === "controller_capture") return item.origin?.deviceLabel ?? "Controller capture";
  if (source === "browser_recording") return "Browser recording";
  if (source === "browser_camera") return "Browser camera";
  if (source === "companion_recording") return "Phone recording";
  if (source === "companion_camera") return "Phone camera";
  return "File upload";
}

export function MediaPicker({
  media,
  onSelect,
  emptyMessage = "No stored media yet.",
  label = "Media library",
}: {
  media: MediaItem[];
  onSelect: (item: MediaItem) => void;
  emptyMessage?: string;
  label?: string;
}) {
  if (media.length === 0) {
    return <p className="media-picker__empty">{emptyMessage}</p>;
  }
  return (
    <ul className="media-picker" aria-label={label}>
      {media.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            aria-label={`Attach ${mediaLabel(item)}`}
            onClick={() => onSelect(item)}
          >
            {item.kind === "audio" ? <FileAudio className="size-4" /> : <FileImage className="size-4" />}
            <span className="media-picker__name">{mediaLabel(item)}</span>
            <small>Reused from library · {mediaOriginLabel(item)} · {mediaState(item)}</small>
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface MediaCaptureDialogProps {
  controller: Controller;
  /** Render this component only while the dialog is open — unmounting is what releases devices. */
  onClose: () => void;
  initialSource?: MediaSource;
  /** Called after every successful upload, with the stored record. */
  onUploaded?: (media: MediaItem) => void;
  title?: string;
  description?: string;
  allowedSources?: MediaSource[];
  companionHandoffId?: string;
}

export function MediaCaptureDialog({
  controller: c,
  onClose,
  initialSource = "upload",
  onUploaded,
  title = "Add media",
  description = "Choose one source. You can attach the result from Operations.",
  allowedSources = ["upload", "audio", "camera"],
  companionHandoffId,
}: MediaCaptureDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [uploadTranscript, setUploadTranscript] = useState("");
  const [audioInputId, setAudioInputId] = useState("");
  const [source, setSource] = useState<MediaSource>(initialSource);
  const [uploadProgress, setUploadProgress] = useState<MediaUploadProgress | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [retryPayload, setRetryPayload] = useState<Record<string, unknown> | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const uploadActive = uploadProgress !== null;
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const notifyError = (message: string) => c.setNotice({ tone: "danger", message });

  const store = async (payload: Record<string, unknown>) => {
    const scopedPayload = companionHandoffId ? { ...payload, companionHandoffId } : payload;
    const abort = new AbortController();
    uploadAbortRef.current = abort;
    if (mountedRef.current) {
      setUploadError(null);
      setRetryPayload(null);
    }
    try {
      const media = await c.uploadMedia(scopedPayload, {
        signal: abort.signal,
        onProgress: (progress) => {
          if (mountedRef.current) setUploadProgress(progress);
        },
      });
      // Mark transport completion before onUploaded closes and unmounts the dialog; teardown must
      // abort only work that is still in flight, not an upload that already reached finalize.
      if (uploadAbortRef.current === abort) uploadAbortRef.current = null;
      if (mountedRef.current) {
        setUploadProgress(null);
        onUploaded?.(media);
      }
      return media;
    } catch (error) {
      if (mountedRef.current) {
        setUploadProgress(null);
        if (abort.signal.aborted) {
          setUploadError("Upload cancelled. The staged bytes were discarded.");
        } else {
          setUploadError(error instanceof Error ? error.message : "Media upload failed.");
        setRetryPayload(scopedPayload);
        }
      }
      throw error;
    } finally {
      if (uploadAbortRef.current === abort) uploadAbortRef.current = null;
    }
  };

  const uploadFile = async () => {
    if (!file) {
      c.setNotice({ tone: "danger", message: "Choose an image or audio file first." });
      return;
    }
    await c.run("upload-media", "Media uploaded.", async () => {
      const kind = file.type.startsWith("audio/") ? "audio" : "image";
      const result = await store({
        kind,
        contentType: file.type,
        blob: file,
        originalName: file.name,
        captureSource: "upload",
        ...(kind === "audio" && uploadTranscript.trim()
          ? { transcript: uploadTranscript.trim() }
          : {}),
      });
      setFile(null);
      setUploadTranscript("");
      return result;
    });
  };

  const recorder = useAudioRecorder({
    onError: notifyError,
    onComplete: async (blob, contentType) => {
      await c.run("upload-recording", "Recording uploaded.", async () => store({
        kind: "audio",
        contentType,
        blob,
        transcript: uploadTranscript.trim() || undefined,
        originalName: `recording-${new Date().toISOString()}.webm`,
        captureSource: "browser_recording",
      }));
    },
  });

  const camera = useCameraCapture({ onError: notifyError });

  useEffect(() => {
    if (source === "audio") void recorder.refreshInputs().catch(() => undefined);
  }, [source, recorder.refreshInputs]);

  const requestClose = () => {
    if (recorder.recording) {
      c.setNotice({ tone: "info", message: `Stop the recording before closing ${title}.` });
      return;
    }
    if (uploadAbortRef.current) {
      c.setNotice({ tone: "info", message: "Cancel the active upload before closing this dialog." });
      return;
    }
    camera.close();
    onClose();
  };

  const selectSource = (next: MediaSource) => {
    if (recorder.recording) return;
    if (source === "camera" && next !== "camera") camera.close();
    setSource(next);
  };

  useEffect(() => {
    mountedRef.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current?.click();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      mountedRef.current = false;
      // Navigation and parent teardown cannot use requestClose(). Abort here so uploadMedia can
      // discard the staged server session rather than leaving an XHR and staged bytes behind.
      uploadAbortRef.current?.abort();
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, []);

  const captureCamera = async () => {
    const blob = await camera.capture().catch((error: unknown) => {
      notifyError(error instanceof Error ? error.message : "Camera capture failed.");
      return null;
    });
    if (!blob) return;
    await c.run("capture-camera", "Camera frame uploaded.", async () => {
      camera.setStatus("saving");
      const result = await store({
        kind: "image",
        contentType: "image/png",
        blob,
        originalName: `snapshot-${new Date().toISOString()}.png`,
        captureSource: "browser_camera",
      });
      camera.setStatus("uploaded");
      return result;
    });
  };

  return (
    <div
      className="media-creator-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={dialogRef}
        className="media-creator"
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-creator-title"
        aria-describedby="media-creator-description"
      >
        <header className="media-creator__header">
          <div>
            <p className="eyebrow">New context</p>
            <h2 id="media-creator-title" className="ac-display-title">{title}</h2>
            <p id="media-creator-description">{description}</p>
          </div>
          <Button
            ref={closeRef}
            size="icon"
            variant="ghost"
            disabled={recorder.recording || uploadActive}
            aria-label={`Close ${title}`}
            title={recorder.recording
              ? "Stop recording before closing"
              : uploadActive
                ? "Cancel the upload before closing"
                : `Close ${title}`}
            onClick={requestClose}
          >
            <X className="size-4" />
          </Button>
        </header>

        <div className="media-source-tabs" role="tablist" aria-label="Media source">
          {allowedSources.includes("upload") ? <button
            id="media-tab-upload"
            type="button"
            role="tab"
            aria-selected={source === "upload"}
            aria-controls="media-panel-upload"
            data-active={source === "upload" || undefined}
            disabled={recorder.recording || uploadActive}
            onClick={() => selectSource("upload")}
          >
            <UploadCloud className="size-4" /> Upload file
          </button> : null}
          {allowedSources.includes("audio") ? <button
            id="media-tab-audio"
            type="button"
            role="tab"
            aria-selected={source === "audio"}
            aria-controls="media-panel-audio"
            data-active={source === "audio" || undefined}
            disabled={uploadActive}
            onClick={() => selectSource("audio")}
          >
            <Mic className="size-4" /> Record audio
          </button> : null}
          {allowedSources.includes("camera") ? <button
            id="media-tab-camera"
            type="button"
            role="tab"
            aria-selected={source === "camera"}
            aria-controls="media-panel-camera"
            data-active={source === "camera" || undefined}
            disabled={recorder.recording || uploadActive}
            onClick={() => selectSource("camera")}
          >
            <Camera className="size-4" /> Use camera
          </button> : null}
        </div>

        {uploadProgress || uploadError ? (
          <div className="media-upload-progress" role="status" aria-live="polite">
            {uploadProgress ? (
              <>
                <div className="media-upload-progress__copy">
                  <strong>{uploadStageLabel(uploadProgress.stage)}</strong>
                  <span>{uploadProgress.stage === "uploading"
                    ? `${Math.round((uploadProgress.loaded / Math.max(1, uploadProgress.total)) * 100)}%`
                    : "Please keep this dialog open"}</span>
                </div>
                <progress
                  max={Math.max(1, uploadProgress.total)}
                  value={uploadProgress.stage === "creating"
                    ? 0
                    : uploadProgress.stage === "finalizing"
                      ? uploadProgress.total
                      : uploadProgress.loaded}
                />
                <Button variant="secondary" onClick={() => uploadAbortRef.current?.abort()}>
                  Cancel upload
                </Button>
              </>
            ) : (
              <>
                <p>{uploadError}</p>
                {retryPayload ? (
                  <Button
                    variant="secondary"
                    onClick={() => void c.run(
                      "retry-upload",
                      "Media uploaded.",
                      async () => await store(retryPayload),
                    )}
                  >
                    Retry upload
                  </Button>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        <div className="media-creator__body">
          {source === "upload" ? (
            <div
              id="media-panel-upload"
              className="media-creator-panel"
              role="tabpanel"
              aria-labelledby="media-tab-upload"
            >
              <label className="upload-drop">
                <input
                  type="file"
                  className="sr-only"
                  accept={MEDIA_FILE_ACCEPT}
                  disabled={uploadActive}
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    setUploadTranscript("");
                  }}
                />
                <UploadCloud className="size-6 text-primary" />
                <span className="font-display text-sm font-semibold">{file?.name ?? "Choose an image or audio file"}</span>
                <span className="text-xs text-ink-muted">PNG, JPEG, WebP, WAV, MP3, MP4, WebM, or OGG</span>
              </label>
              {file?.type.startsWith("audio/") ? (
                <Field label="Audio transcript" htmlFor="upload-transcript" hint="Optional. You can also add or generate it later.">
                  <textarea
                    id="upload-transcript"
                    rows={3}
                    value={uploadTranscript}
                    onChange={(event) => setUploadTranscript(event.target.value)}
                    placeholder="Paste or enter a transcript"
                  />
                </Field>
              ) : null}
              <Button
                className="w-full"
                variant="primary"
                disabled={!file || uploadActive}
                busy={c.busyAction === "upload-media"}
                onClick={() => void uploadFile()}
              >
                <FileUp className="size-4" /> Upload file
              </Button>
            </div>
          ) : null}

          {source === "audio" ? (
            <div
              id="media-panel-audio"
              className="media-creator-panel media-capture-panel"
              role="tabpanel"
              aria-labelledby="media-tab-audio"
            >
              <div className="media-capture-panel__icon" data-live={recorder.recording || undefined}>
                {recorder.recording
                  ? <ActivityOrb activity={recordingActivity(true)} size={64} />
                  : <Mic className="size-7" aria-hidden="true" />}
              </div>
              <div className="media-capture-panel__copy">
                <div className="flex items-center justify-center gap-2">
                  <h3>{recorder.recording ? "Recording…" : "Record a voice clip"}</h3>
                  {recorder.status !== "idle" ? (
                    <StatusBadge
                      tone={recorder.recording ? "danger" : recorder.status === "uploaded" ? "success" : "neutral"}
                      label={CAPTURE_STATUS_LABEL[recorder.status]}
                    />
                  ) : null}
                </div>
                <p>
                  {recorder.supported
                    ? "The recording uploads when you stop it."
                    : "Microphone recording is unavailable in this browser."}
                </p>
              </div>
              {!recorder.recording ? (
                <>
                <Field label="Microphone" htmlFor="recording-input" hint="Bluetooth earbuds appear here when the browser exposes them.">
                  <select
                    id="recording-input"
                    value={audioInputId}
                    onChange={(event) => setAudioInputId(event.target.value)}
                  >
                    <option value="">System default</option>
                    {recorder.inputs.map((input, index) => (
                      <option key={input.deviceId} value={input.deviceId}>
                        {input.label || `Microphone ${index + 1}`}
                      </option>
                    ))}
                  </select>
                </Field>
                <details className="media-creator-optional">
                  <summary>Add transcript (optional)</summary>
                  <Field label="Transcript" htmlFor="recording-transcript" hint="You can also generate it from the library later.">
                    <textarea
                      id="recording-transcript"
                      rows={3}
                      value={uploadTranscript}
                      onChange={(event) => setUploadTranscript(event.target.value)}
                      placeholder="Paste or enter a transcript"
                    />
                  </Field>
                </details>
                </>
              ) : null}
              <Button
                className="w-full"
                variant={recorder.recording ? "danger" : "primary"}
                disabled={!recorder.supported || recorder.status === "saving" || c.busyAction === "upload-recording"}
                onClick={recorder.recording ? recorder.stop : () => void recorder.start(audioInputId || undefined)}
              >
                {recorder.recording ? <Square className="size-4" /> : <Mic className="size-4" />}
                {recorder.recording ? "Stop recording" : "Start recording"}
              </Button>
            </div>
          ) : null}

          {source === "camera" ? (
            <div
              id="media-panel-camera"
              className="media-creator-panel"
              role="tabpanel"
              aria-labelledby="media-tab-camera"
            >
              {camera.active ? (
                <>
                  <div className="media-camera-preview relative overflow-hidden rounded-lg border border-white/10 bg-black">
                    <video ref={camera.videoRef} className="size-full object-cover" playsInline muted />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Button onClick={camera.close}>
                      <VideoOff className="size-4" /> Close camera
                    </Button>
                    <Button
                      variant="primary"
                      busy={c.busyAction === "capture-camera"}
                      onClick={() => void captureCamera()}
                    >
                      <Image className="size-4" /> Capture image
                    </Button>
                  </div>
                </>
              ) : (
                <EmptyState
                  compact
                  icon={VideoOff}
                  title="Camera is off"
                  description={camera.supported
                    ? "Open it only when you are ready to capture a frame."
                    : "Camera capture is unavailable in this browser."}
                  action={
                    <Button variant="primary" disabled={!camera.supported} onClick={() => void camera.open()}>
                      <Camera className="size-4" /> Open camera
                    </Button>
                  }
                />
              )}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function uploadStageLabel(stage: MediaUploadProgress["stage"]): string {
  return stage === "creating" ? "Preparing private upload"
    : stage === "uploading" ? "Uploading media"
      : "Verifying integrity";
}
