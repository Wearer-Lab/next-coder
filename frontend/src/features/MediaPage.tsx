import {
  FileAudio,
  FileImage,
  Plus,
  RefreshCw,
  Save,
  Smartphone,
  Trash2,
  UploadCloud,
  WandSparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { mediaJobActivity } from "../activity";
import type { Controller } from "../controller";
import {
  formatMediaExpiry,
  formatMediaJob,
  formatMediaProcessing,
  mediaJobFailureLabel,
  mediaJobRetryable,
  mediaJobTone,
} from "../format";
import { ActivityOrb } from "../motion";
import { clearCompanionCode } from "../companionLink";
import type { CompanionHandoff, MediaItem, MediaJob } from "../types";
import {
  Button,
  EmptyState,
  Field,
  Panel,
  StatusBadge,
  useConfirm,
} from "../ui";
import { MediaCaptureDialog, mediaLabel, mediaOriginLabel } from "./MediaCapture";
import "./intelligence-library.css";

interface HandoffMint {
  handoff: CompanionHandoff;
  launchUrl: string;
  qrSvg: string;
}

export function MediaPage({ controller: c, companionCode = null }: { controller: Controller; companionCode?: string | null }) {
  const confirm = useConfirm();
  const [transcriptDrafts, setTranscriptDrafts] = useState<Record<string, string>>({});
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [companion, setCompanion] = useState<CompanionHandoff | null>(null);
  const [companionError, setCompanionError] = useState<string | null>(null);
  const [handoffMint, setHandoffMint] = useState<HandoffMint | null>(null);
  const creatorTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setTranscriptDrafts((current) => {
      const next = { ...current };
      for (const item of c.media) {
        if (!(item.id in next)) next[item.id] = item.transcript ?? "";
      }
      return next;
    });
  }, [c.media]);

  useEffect(() => {
    if (!companionCode || companion || companionError) return;
    let active = true;
    void c.api<{ handoff: CompanionHandoff }>("/v1/companion-handoffs/claim", {
      method: "POST",
      body: { code: companionCode },
    }).then(({ handoff }) => {
      if (!active) return;
      clearCompanionCode();
      setCompanion(handoff);
      setCreatorOpen(true);
    }).catch((error: unknown) => {
      if (!active) return;
      const message = error instanceof Error ? error.message : "Companion handoff could not be claimed.";
      setCompanionError(message);
      clearCompanionCode();
    });
    return () => { active = false; };
  }, [c.api, companion, companionCode, companionError]);

  useEffect(() => {
    if (!handoffMint || handoffMint.handoff.status !== "waiting") return;
    const timer = window.setInterval(() => {
      void c.api<{ handoff: CompanionHandoff }>(
        `/v1/companion-handoffs/${encodeURIComponent(handoffMint.handoff.id)}`,
      ).then(({ handoff }) => setHandoffMint((current) => current ? { ...current, handoff } : null))
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [c.api, handoffMint]);

  const createHandoff = async (action: CompanionHandoff["action"]) => {
    if (!c.selectedEnvironmentId || !c.selectedThreadId) {
      c.setNotice({ tone: "danger", message: "Select an environment and thread before opening phone capture." });
      return;
    }
    await c.run("create-companion-handoff", "Phone capture link is ready.", async () => {
      const minted = await c.api<HandoffMint>("/v1/companion-handoffs", {
        method: "POST",
        body: { environmentId: c.selectedEnvironmentId, threadId: c.selectedThreadId, action },
      });
      setHandoffMint(minted);
      return minted;
    });
  };

  const cancelHandoff = async () => {
    if (!handoffMint) return;
    const result = await c.api<{ handoff: CompanionHandoff }>(
      `/v1/companion-handoffs/${encodeURIComponent(handoffMint.handoff.id)}`,
      { method: "DELETE", body: {} },
    );
    setHandoffMint({ ...handoffMint, handoff: result.handoff });
  };

  const saveTranscript = async (item: MediaItem) => {
    const transcript = transcriptDrafts[item.id]?.trim();
    if (!transcript) {
      c.setNotice({ tone: "danger", message: "Enter a transcript before saving." });
      return;
    }
    await c.run(`transcript-${item.id}`, "Transcript saved.", async () => {
      const result = await c.api(`/v1/media/${encodeURIComponent(item.id)}/transcript`, {
        method: "PUT",
        body: { transcript },
      });
      await c.refreshMedia();
      return result;
    });
  };

  // The gateway answers 202 with a job: the transcription itself runs on its worker, survives a
  // restart, and reports back over the event stream.
  const transcribe = async (item: MediaItem) => {
    await c.run(`transcribe-${item.id}`, "Transcription queued.", async () => {
      const result = await c.api(`/v1/media/${encodeURIComponent(item.id)}/transcribe`, {
        method: "POST",
        body: {},
      });
      await c.refreshMedia();
      return result;
    });
  };

  // Requeueing a job that failed on the deployment rather than on the audio. Scoped to the one job
  // the owner is looking at, and the answer says what happens next: the gateway holds a requeued
  // transcript for review whatever the device's auto-send grant says, because a capture from hours
  // ago is not something anyone is still expecting an agent to act on.
  const retryConfiguration = async (job: MediaJob) => {
    await c.run(`retry-${job.id}`, "Queued again — the transcript will wait for your review.", async () => {
      const result = await c.api("/v1/media/jobs/retry-configuration", {
        method: "POST",
        body: { jobIds: [job.id] },
      });
      await c.refreshMedia();
      return result;
    });
  };

  // Accepting or correcting a transcript records a new version; the raw ASR output is untouched.
  const submitReview = async (item: MediaItem, job: MediaJob) => {
    const transcript = transcriptDrafts[item.id]?.trim();
    if (!transcript) {
      c.setNotice({ tone: "danger", message: "Enter a transcript before approving." });
      return;
    }
    await c.run(`review-${job.id}`, "Transcript approved.", async () => {
      const result = await c.api(`/v1/media/jobs/${encodeURIComponent(job.id)}/transcript`, {
        method: "POST",
        body: { transcript },
      });
      await c.refreshMedia();
      return result;
    });
  };

  // The newest job wins: re-transcribing an old clip should not be described by the first attempt.
  const latestJobFor = (mediaId: string): MediaJob | null => c.mediaJobs
    .filter((job) => job.mediaId === mediaId)
    .reduce<MediaJob | null>(
      (latest, job) => (!latest || (job.createdAt ?? "") >= (latest.createdAt ?? "") ? job : latest),
      null,
    );

  const deleteMedia = async (item: MediaItem) => {
    const accepted = await confirm({
      title: `Delete ${mediaLabel(item)}?`,
      description: "The stored capture and its transcript will be permanently removed.",
      confirmLabel: "Delete media",
    });
    if (!accepted) return;
    await c.run(`delete-media-${item.id}`, "Media deleted.", async () => {
      const result = await c.api(`/v1/media/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      await c.refreshAll();
      return result;
    });
  };

  return (
    <div className="page-stack media-workspace media-library-workspace">
      <header className="media-library-header">
        <div>
          <p className="eyebrow ac-eyebrow">Library</p>
          <h2>Media context</h2>
          <p>Uploads and captures available to attach from Operations.</p>
        </div>
        <div className="media-library-header__actions">
          <Button size="sm" variant="secondary" onClick={() => void createHandoff("record_audio")}>
            <Smartphone className="size-4" /> Record on phone
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void createHandoff("capture_image")}>
            <FileImage className="size-4" /> Photo on phone
          </Button>
          <Button size="sm" onClick={() => void c.refreshMedia()}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
          {c.media.length ? (
            <Button
              ref={creatorTriggerRef}
              size="sm"
              variant="primary"
              onClick={() => setCreatorOpen(true)}
            >
              <Plus className="size-4" /> Add media
            </Button>
          ) : null}
        </div>
      </header>

      {companionError ? (
        <Panel className="p-4" role="alert">
          <p className="font-semibold">Phone capture unavailable</p>
          <p className="mt-1 text-sm text-ink-muted">{companionError}</p>
        </Panel>
      ) : companion ? (
        <Panel className="p-4" role="status">
          <p className="eyebrow">Phone companion</p>
          <p className="mt-1 font-semibold">Connected to the requested thread</p>
          <p className="mt-1 text-sm text-ink-muted">
            {companion.action === "record_audio" ? "Record audio" : "Capture an image"}. No prompt or device credential was included in the link.
          </p>
        </Panel>
      ) : null}

      {handoffMint ? (
        <Panel className="grid gap-4 p-4 sm:grid-cols-[180px_1fr] sm:items-center" role="status" aria-live="polite">
          <img
            className="size-[180px] rounded-lg bg-white p-2"
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(handoffMint.qrSvg)}`}
            alt="QR code to open phone capture"
            width="180"
            height="180"
          />
          <div>
            <p className="eyebrow">Phone companion</p>
            <h3 className="mt-1 font-display text-lg">{handoffStatusLabel(handoffMint.handoff.status)}</h3>
            <p className="mt-1 text-sm text-ink-muted">
              The link is bound to the selected environment, thread, and capture action. It expires at {new Date(handoffMint.handoff.expiresAt).toLocaleTimeString()}.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {handoffMint.handoff.status === "waiting" ? (
                <>
                  <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard.writeText(handoffMint.launchUrl)}>
                    Copy private link
                  </Button>
                  <Button size="sm" variant="danger-ghost" onClick={() => void cancelHandoff()}>Cancel</Button>
                </>
              ) : null}
              {["expired", "cancelled"].includes(handoffMint.handoff.status) ? (
                <Button size="sm" onClick={() => void createHandoff(handoffMint.handoff.action)}>Create a new link</Button>
              ) : null}
            </div>
          </div>
        </Panel>
      ) : null}

      <Panel className="media-library overflow-hidden">
        {c.media.length ? (
          <div className="media-library__grid">
            {c.media.map((item) => {
              const job = latestJobFor(item.id);
              return (
              <article key={item.id} className="media-library__item grid gap-4 p-4 lg:grid-cols-[auto_minmax(180px,0.55fr)_minmax(260px,1fr)_auto] lg:items-center">
                <div className="media-library__icon grid size-10 place-items-center rounded-lg border border-control bg-surface-inset text-primary">
                  {item.kind === "audio" ? <FileAudio className="size-5" /> : <FileImage className="size-5" />}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="media-library__name truncate text-sm font-semibold">{mediaLabel(item)}</p>
                    <StatusBadge
                      tone={item.processing?.lastError ? "danger" : item.processing?.transcriptionStatus === "processing" ? "warning" : "success"}
                      label={formatMediaProcessing(item)}
                    />
                    {job ? <StatusBadge tone={mediaJobTone(job)} label={formatMediaJob(job)} /> : null}
                    <ActivityOrb activity={job ? mediaJobActivity(job.stage) : null} />
                  </div>
                  {/*
                    The derived name is the heading; what the client actually uploaded is still
                    here, next to the id, because it is the record of the file and a name that is
                    derived must never be mistaken for the one that was given.
                  */}
                  <p className="media-library__id truncate font-mono text-[11px] text-ink-faint">
                    {item.originalName ? `${item.originalName} · ${item.id}` : item.id}
                  </p>
                  {/*
                    No relative time here any more: the derived name already carries the moment the
                    capture was taken, and "24 Aug 19:32" plus "16m ago" is one fact printed twice.
                    What is left is what the name cannot say — the container and how big it is.
                  */}
                  <p className="media-library__meta text-xs text-ink-muted">
                    {item.contentType} · {item.sizeBytes ?? 0} B
                  </p>
                  <p className="media-library__meta text-xs text-ink-muted">Origin: {mediaOriginLabel(item)}</p>
                  <p className="media-library__meta text-xs text-ink-muted">
                    {formatMediaExpiry(item.expiresAt)}
                  </p>
                </div>
                <div>
                  <MediaPreview controller={c} item={item} />
                  {item.kind === "audio" ? (
                    <>
                      <Field label="Transcript" htmlFor={`transcript-${item.id}`}>
                        <textarea
                          id={`transcript-${item.id}`}
                          rows={3}
                          value={transcriptDrafts[item.id] ?? ""}
                          onChange={(event) => setTranscriptDrafts((current) => ({
                            ...current,
                            [item.id]: event.target.value,
                          }))}
                          placeholder="No transcript"
                        />
                      </Field>
                      {/*
                        Cleanup may only move spacing, punctuation and case. When it moved letters
                        instead, nothing is applied — the speaker sees both versions and picks.
                      */}
                      {/*
                        A failure an owner can act on, or knowingly leave alone. The category is the
                        actionable half — "failed" alone sent people to the server logs.
                      */}
                      {job?.stage === "failed" ? (
                        <div className="media-library__notice mt-2 rounded-lg border border-control bg-surface-inset p-2 text-xs">
                          <p className="font-semibold text-ink">Transcription failed</p>
                          <p className="mt-1 text-ink-muted">{mediaJobFailureLabel(job)}</p>
                          {job.lastError ? (
                            <p className="mt-1 font-mono text-ink-faint">{job.lastError}</p>
                          ) : null}
                        </div>
                      ) : null}
                      {job?.transcriptChange?.contentPreserved === false ? (
                        <div className="media-library__notice mt-2 rounded-lg border border-control bg-surface-inset p-2 text-xs">
                          <p className="font-semibold text-ink">Cleanup changed the wording</p>
                          <p className="mt-1 text-ink-muted">
                            Heard: <span className="font-mono">{job.rawTranscript}</span>
                          </p>
                          <p className="mt-1 text-ink-muted">
                            Cleaned: <span className="font-mono">{job.normalizedTranscript}</span>
                          </p>
                          <p className="mt-1 text-ink-muted">
                            Nothing was applied. Approve the version you meant.
                          </p>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="media-library__placeholder rounded-lg border border-dashed border-control p-4 text-center text-xs text-ink-muted">
                      Image context is ready to attach from Operations.
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 lg:flex-col">
                  {item.kind === "audio" ? (
                    <>
                      <Button size="sm" onClick={() => void transcribe(item)}>
                        <WandSparkles className="size-3.5" /> Transcribe
                      </Button>
                      <Button size="sm" onClick={() => void saveTranscript(item)}>
                        <Save className="size-3.5" /> Save
                      </Button>
                      {job && mediaJobRetryable(job) ? (
                        <Button size="sm" onClick={() => void retryConfiguration(job)}>
                          <RefreshCw className="size-3.5" /> Retry after fixing config
                        </Button>
                      ) : null}
                      {job?.stage === "review_required" ? (
                        <Button size="sm" variant="primary" onClick={() => void submitReview(item, job)}>
                          <Save className="size-3.5" /> Approve transcript
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                  <Button size="sm" variant="danger-ghost" onClick={() => void deleteMedia(item)}>
                    <Trash2 className="size-3.5" /> Delete
                  </Button>
                </div>
              </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={UploadCloud}
            title="No stored media"
            description="Add a file, voice recording, or camera frame when you need visual or audio context."
            action={
              <Button variant="primary" onClick={() => setCreatorOpen(true)}>
                <Plus className="size-4" /> Add media
              </Button>
            }
          />
        )}
      </Panel>

      {creatorOpen ? (
        <MediaCaptureDialog
          controller={c}
          onClose={() => setCreatorOpen(false)}
          {...(companion ? {
            initialSource: companion.action === "record_audio" ? "audio" as const : "camera" as const,
            allowedSources: [companion.action === "record_audio" ? "audio" as const : "camera" as const],
            companionHandoffId: companion.id,
            title: companion.action === "record_audio" ? "Record on this phone" : "Capture on this phone",
            description: "The result is pinned to the thread chosen on the originating controller or console.",
            onUploaded: () => setCompanion((current) => current ? { ...current, status: "completed" } : null),
          } : {})}
        />
      ) : null}
    </div>
  );
}

function handoffStatusLabel(status: CompanionHandoff["status"]): string {
  if (status === "waiting") return "Waiting for phone";
  if (status === "claimed") return "Claimed on phone";
  if (status === "completed") return "Capture completed";
  if (status === "expired") return "Link expired";
  return "Handoff cancelled";
}

function MediaPreview({ controller, item }: { controller: Controller; item: MediaItem }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const blob = await controller.loadMediaPreview(item);
      setUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(blob);
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Preview failed.");
    } finally {
      setLoading(false);
    }
  };

  if (!url) {
    return (
      <div className="media-library__preview mb-3 rounded-lg border border-dashed border-control p-3 text-center text-xs text-ink-muted">
        {error ? <p role="alert" className="mb-2 text-danger">{error}</p> : null}
        <Button size="sm" variant="secondary" busy={loading} onClick={() => void load()}>
          {error ? "Retry preview" : `Load ${item.kind} preview`}
        </Button>
        <p className="mt-2">Loaded only on request; preview bytes are not cached by the app.</p>
      </div>
    );
  }
  return item.kind === "audio" ? (
    <audio className="media-library__audio mb-3 w-full" controls preload="metadata" src={url}>
      Audio preview is unavailable in this browser.
    </audio>
  ) : (
    <img
      className="media-library__image mb-3 max-h-56 w-full rounded-lg border border-control bg-black/20 object-contain"
      src={url}
      alt={`Preview of ${mediaLabel(item)}`}
      loading="lazy"
      decoding="async"
    />
  );
}
