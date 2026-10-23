import { randomUUID } from "node:crypto";

import { mediaJobEvent } from "./deviceAudio.mjs";
import { MEDIA_JOB_TERMINAL_STAGES } from "./store.mjs";
import {
  TranscriptionError,
  classifyTranscriptionFailure,
  createTranscriptionProvider,
  describeTranscriptChange,
  normalizeTranscriptText,
} from "./transcription.mjs";

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_BATCH_SIZE = 4;

// Durable media processing, roadmap Phase 6's other half.
//
// Transcription used to run inside the HTTP handler: the request awaited a call that can take
// thirty seconds, and a deploy in the middle of one lost the work with no trace beyond a media
// record stuck at `processing`. Jobs are rows now and this worker drives them.
//
// The shape deliberately mirrors src/snapshotPoller.mjs — started from src/server.mjs, never from
// createApp(), with a runOnce() tests call directly so no suite ever depends on a timer firing.
//
// Stages: queued -> transcribing -> normalizing -> review_required|ready -> dispatching ->
// dispatched, with `failed` as the terminal error state. "dispatched" means the finished transcript
// has been written onto the media record, which is what the audio-prompt path in src/media.mjs
// reads. The audio itself is never touched: a transcript is a derived artefact and the original
// upload has to stay playable.
export function createMediaJobRunner({
  store,
  config = {},
  events = null,
  provider = null,
  // Sends a finished transcript on to the agent. Injected rather than imported because the worker
  // has no business knowing what an intent or a policy is — it hands over the finished text and
  // records whatever the caller says happened to it. Absent (as in every unit test here) the
  // transcript is simply written onto the media record and waits.
  dispatchTranscript = null,
  onQueued = null,
  // Cleanup is replaceable, which is exactly why the guard below exists: a substitute that
  // rewrote the user's words instead of tidying them would otherwise dispatch as if they had
  // said it.
  normalize = normalizeTranscriptText,
  intervalMs = DEFAULT_INTERVAL_MS,
  leaseMs = DEFAULT_LEASE_MS,
  batchSize = DEFAULT_BATCH_SIZE,
  workerId = `worker_${randomUUID().slice(0, 8)}`,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const transcriber = provider ?? createTranscriptionProvider(config);
  let timer = null;
  let inFlight = false;

  function iso() {
    return new Date(now()).toISOString();
  }

  async function runOnce() {
    // A second tick landing on top of a slow ASR call would double-lease nothing (the lease
    // protects that) but would still pile up concurrent provider calls for no benefit.
    if (inFlight) return { skipped: true, processed: [] };
    inFlight = true;
    try {
      let claimed;
      try {
        claimed = await store.claimMediaJobs({
          owner: workerId,
          leaseMs,
          limit: batchSize,
          now: iso(),
        });
      } catch (error) {
        logger?.warn?.(`media job claim failed: ${message(error)}`);
        return { skipped: false, processed: [] };
      }

      const processed = [];
      for (const job of claimed ?? []) {
        try {
          processed.push(await processJob(job));
        } catch (error) {
          // An unexpected throw must not abandon the rest of the batch, and must not leave the
          // job holding a lease until it expires either.
          logger?.warn?.(`media job ${job.id} threw: ${message(error)}`);
          processed.push(await recordFailure(job, error));
        }
      }
      return { skipped: false, processed };
    } finally {
      inFlight = false;
    }
  }

  async function processJob(job) {
    const media = await store.getMediaForUser(job.userId, job.mediaId);
    if (!media) {
      // Nothing about the deployment brings deleted bytes back.
      return await abandon(job, "Media upload no longer exists.", "input");
    }
    if (media.kind !== "audio") {
      return await abandon(job, "Only audio media can be transcribed.", "input");
    }

    let current = job;

    if (current.stage === "transcribing") {
      // Measured before the call, so a job that waited behind three others reports the wait rather
      // than hiding it inside the provider's number.
      const queueWaitMs = elapsedSince(current.timings?.queuedAt, now());
      const startedAtMs = now();
      let result;
      try {
        result = await transcriber.transcribe({ media, job: current, config });
      } catch (error) {
        return await recordFailure(current, error);
      }
      current = await store.updateMediaJob({
        jobId: current.id,
        stage: "normalizing",
        rawTranscript: result.text,
        provider: result.provider ?? transcriber.name,
        model: result.model ?? transcriber.model,
        language: result.language ?? null,
        lastError: null,
        failureKind: null,
        timings: {
          transcribedAt: iso(),
          providerMs: result.durationMs ?? now() - startedAtMs,
          ...roundedMs("queueWaitMs", queueWaitMs),
          // Whatever the adapter could measure of its own stages — decode and inference are the
          // sidecar's to report, and only the parakeet adapter has them today.
          ...numericTimings(result.timings),
        },
      });
      publish(current);
    }

    if (current.stage === "normalizing") {
      const startedAtMs = now();
      const normalized = normalize(current.rawTranscript);
      const normalizeMs = now() - startedAtMs;
      if (!normalized) {
        return await abandon(current, "Transcription produced no usable text.", "input");
      }
      // Cleanup is allowed to move spacing, punctuation and case — nothing else. If the letters
      // moved, a "correction" changed what the user actually said, and a person has to see the
      // diff rather than have the rewrite dispatched as their command.
      const change = describeTranscriptChange(current.rawTranscript, normalized);
      const rewritten = change?.contentPreserved === false;
      if (rewritten) {
        logger?.warn?.(
          `media job ${current.id}: normalization altered the wording at character`
          + ` ${change.firstDivergenceIndex}; holding for review instead of dispatching.`,
        );
      }
      const reviewRequired = current.reviewRequired === true || rewritten;
      current = await store.updateMediaJob({
        jobId: current.id,
        stage: reviewRequired ? "review_required" : "ready",
        normalizedTranscript: normalized,
        timings: {
          normalizedAt: iso(),
          ...roundedMs("normalizeMs", normalizeMs),
          ...(reviewRequired
            ? roundedMs("totalMs", elapsedSince(current.timings?.queuedAt, now()))
            : { readyAt: iso() }),
        },
        // A job waiting on a person must not keep a lease a worker would later "resume".
        releaseLease: reviewRequired,
      });
      publish(current);
      if (reviewRequired) {
        await writeMediaProcessing(current, "processing", null);
        return { jobId: current.id, mediaId: current.mediaId, stage: current.stage };
      }
    }

    // The last gate before a transcript can be sent anywhere, and the one that cannot be walked
    // around. The normalizing stage above is where review is normally decided, but a job that
    // already holds both transcript versions resumes straight at `dispatching` — which is exactly
    // what a job requeued through the configuration-retry path can do. A capture that must be
    // reviewed has no human version yet, so it waits here rather than dispatching words the owner
    // spoke before whatever went wrong was fixed.
    if ((current.stage === "ready" || current.stage === "dispatching")
      && current.reviewRequired === true
      && !current.userEditedTranscript) {
      current = await store.updateMediaJob({
        jobId: current.id,
        stage: "review_required",
        // A job waiting on a person must not keep a lease a worker would later "resume".
        releaseLease: true,
        timings: { ...roundedMs("totalMs", elapsedSince(current.timings?.queuedAt, now())) },
      });
      publish(current);
      await writeMediaProcessing(current, "processing", null);
      return { jobId: current.id, mediaId: current.mediaId, stage: current.stage };
    }

    if (current.stage === "ready") {
      current = await store.updateMediaJob({
        jobId: current.id,
        stage: "dispatching",
        timings: { readyAt: current.timings?.readyAt ?? iso() },
      });
    }

    if (current.stage === "dispatching") {
      const transcript = effectiveTranscript(current);
      if (!transcript) return await abandon(current, "No transcript version is available to dispatch.", "unknown");
      // Writing the transcript onto the media record is the job's product and happens either way.
      // Sending it to an agent is a separate decision, made next.
      await store.updateMediaTranscript({
        userId: current.userId,
        mediaId: current.mediaId,
        transcript,
        source: current.provider ?? transcriber.name,
      });
      const outcome = await attemptDispatch(current, transcript);
      current = await store.updateMediaJob({
        jobId: current.id,
        stage: "dispatched",
        lastError: null,
        failureKind: null,
        releaseLease: true,
        ...outcome,
        timings: {
          dispatchedAt: iso(),
          ...roundedMs("totalMs", elapsedSince(current.timings?.queuedAt, now())),
        },
      });
      publish(current);
    }

    return { jobId: current.id, mediaId: current.mediaId, stage: current.stage };
  }

  /**
   * Asks the caller whether this transcript goes anywhere, and records the answer.
   *
   * A refusal is not a job failure. Transcription succeeded and the transcript is already on the
   * media record; only the send was declined, so the outcome is kept on its own fields and the job
   * still reaches `dispatched`. Collapsing the two would tell the owner the gateway never heard
   * them, when in fact it heard them and declined to act.
   */
  async function attemptDispatch(job, transcript) {
    const idle = { autoSend: false, dispatchStatus: null, dispatchError: null, commandId: null };
    if (!dispatchTranscript) return idle;
    try {
      const outcome = await dispatchTranscript({ job, transcript });
      if (!outcome) return idle;
      return {
        autoSend: outcome.autoSend === true,
        dispatchStatus: outcome.dispatchStatus ?? null,
        dispatchError: outcome.dispatchError ?? null,
        commandId: outcome.commandId ?? null,
      };
    } catch (error) {
      logger?.warn?.(`media job ${job.id}: dispatch failed: ${message(error)}`);
      return { autoSend: true, dispatchStatus: "failed", dispatchError: message(error), commandId: null };
    }
  }

  /**
   * Retryable failures go back to `queued` and cost one attempt; terminal ones stop immediately.
   *
   * Without the distinction a missing API key would occupy the retry budget three times over
   * before reporting the same answer it had on the first call.
   */
  async function recordFailure(job, error) {
    const lastError = message(error);
    const retryable = error instanceof TranscriptionError ? error.retryable : true;
    const exhausted = job.attempts >= job.maxAttempts;
    const stage = retryable && !exhausted ? "queued" : "failed";
    // Recorded on every failure, not only the terminal ones: a retryable failure that later burns
    // the last attempt is failed inside claimMediaJobs, which has no error to look at and reads
    // the cause left here instead.
    const failureCause = classifyTranscriptionFailure(error);

    const updated = await store.updateMediaJob({
      jobId: job.id,
      stage,
      lastError,
      failureKind: retryable ? "retryable" : "terminal",
      failureCause,
      releaseLease: true,
      ...(stage === "failed" ? { timings: { failedAt: iso() } } : {}),
    });
    await writeMediaProcessing(updated ?? job, stage === "failed" ? "failed" : "processing", lastError);
    publish(updated ?? job);
    if (stage === "queued") {
      try { await onQueued?.(updated ?? job); }
      catch { logger?.warn?.("Cloud media scheduling unavailable; durable work awaits the recovery scheduler."); }
    }
    return { jobId: job.id, mediaId: job.mediaId, stage, lastError, retryable, failureCause };
  }

  async function abandon(job, lastError, failureCause = "unknown") {
    const updated = await store.updateMediaJob({
      jobId: job.id,
      stage: "failed",
      lastError,
      failureKind: "terminal",
      failureCause,
      releaseLease: true,
      timings: { failedAt: iso() },
    });
    await writeMediaProcessing(updated ?? job, "failed", lastError);
    publish(updated ?? job);
    return { jobId: job.id, mediaId: job.mediaId, stage: "failed", lastError, retryable: false, failureCause };
  }

  async function writeMediaProcessing(job, transcriptionStatus, lastError) {
    try {
      await store.updateMediaProcessing?.({
        userId: job.userId,
        mediaId: job.mediaId,
        processing: {
          transcriptionStatus,
          transcriptSource: job.provider ?? transcriber.name,
          lastError,
        },
      });
    } catch (error) {
      logger?.warn?.(`media job ${job.id}: processing update failed: ${message(error)}`);
    }
  }

  function publish(job) {
    if (!job) return;
    events?.broadcastToUser?.(job.userId, "media.job", {
      ...mediaJobEvent(job, iso()),
      terminal: MEDIA_JOB_TERMINAL_STAGES.has(job.stage),
    });
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      runOnce().catch((error) => logger?.warn?.(`media job run failed: ${message(error)}`));
    }, intervalMs);
    // Never hold the process open purely to drain a queue.
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop, workerId, provider: transcriber };
}

/** The version that wins: a human review beats the cleanup, which beats the raw ASR output. */
export function effectiveTranscript(job) {
  return job?.userEditedTranscript
    ?? job?.normalizedTranscript
    ?? (typeof job?.rawTranscript === "string" ? job.rawTranscript.trim() || null : null);
}

/** Milliseconds from an ISO timestamp to now, or null when the timestamp is missing or unparseable. */
function elapsedSince(isoTime, nowMs) {
  const startedAt = Date.parse(isoTime ?? "");
  if (!Number.isFinite(startedAt)) return null;
  return Math.max(0, nowMs - startedAt);
}

/** Omits the key entirely when there is no number: a timings map full of nulls measures nothing. */
function roundedMs(key, value) {
  return typeof value === "number" && Number.isFinite(value) ? { [key]: Math.round(value) } : {};
}

/** Provider-reported stage timings, kept only where the provider actually reported a number. */
function numericTimings(timings) {
  if (!timings || typeof timings !== "object") return {};
  const kept = {};
  for (const [key, value] of Object.entries(timings)) {
    if (typeof value === "number" && Number.isFinite(value)) kept[key] = value;
  }
  return kept;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
