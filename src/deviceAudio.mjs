// The device-facing view of a voice capture.
//
// A controller with a microphone has a few square centimetres of screen and no room for the job
// row behind it: stages, leases, attempt counts and provider timings are worker bookkeeping. What
// it can render is a single word plus a line of text, so this module projects a media job onto the
// six milestones a small screen can actually show and nothing else.
//
// `recorded` and `uploading` are never produced from a job — the gateway does not exist yet at
// those points in the capture. They are listed here anyway so firmware, console and gateway share
// one vocabulary rather than three near-identical ones.
export const VOICE_MILESTONES = [
  "recorded",
  "uploading",
  "transcribing",
  "review",
  "ready",
  "sent",
  "failed",
];

/** Milestones the device owns, before the upload has produced a job to ask about. */
export const DEVICE_LOCAL_MILESTONES = new Set(["recorded", "uploading"]);

const MILESTONE_LABELS = {
  recorded: "Recorded",
  uploading: "Uploading",
  transcribing: "Transcribing",
  review: "Needs review",
  ready: "Ready to send",
  sent: "Sent",
  failed: "Failed",
};

/**
 * How a dispatch attempt ended. `null` means one was never made — auto-send is off for this
 * device, which is the default and is not an error.
 */
export const VOICE_DISPATCH_STATUSES = ["sent", "approval_required", "blocked", "failed"];

/**
 * Collapses a media job onto one milestone.
 *
 * Two independent things can go wrong and the device has to tell them apart, which is why the
 * dispatch outcome is read before the stage: a job whose transcription succeeded but whose send
 * was refused by policy sits at stage `dispatched` with a `dispatchStatus` of `blocked`. Reporting
 * that as "ready" would tell the owner their words are waiting when the gateway has already
 * decided they are not going anywhere.
 */
export function milestoneForJob(job) {
  if (!job) return "failed";
  if (job.dispatchStatus === "sent") return "sent";
  if (job.dispatchStatus === "approval_required") return "review";
  if (job.dispatchStatus === "blocked" || job.dispatchStatus === "failed") return "failed";
  if (job.stage === "failed") return "failed";
  if (job.stage === "review_required") return "review";
  // `ready` and `dispatching` precede the asynchronous auto-send decision. A controller must
  // continue polling until that decision settles, or it can miss Sent and its reply cursor.
  // A settled job with no dispatch outcome means auto-send was declined: its transcript is ready.
  if (job.stage === "dispatched") return "ready";
  return "transcribing";
}

/** The winning transcript version, matching the precedence the job runner dispatches. */
function transcriptForDevice(job) {
  return job?.userEditedTranscript ?? job?.normalizedTranscript ?? null;
}

/**
 * The whole payload a controller ever needs about one capture.
 *
 * Deliberately not the job row. Attempts, leases, provider names and stage timings are things the
 * hardware cannot render and would only spend bandwidth and flash on, so they stay on the
 * owner-facing `/v1/media/jobs/:id` view.
 */
export function deviceJobStatus(job) {
  if (!job) return null;
  const milestone = milestoneForJob(job);
  return {
    jobId: job.id,
    mediaId: job.mediaId,
    milestone,
    label: MILESTONE_LABELS[milestone],
    reviewReason: milestone !== "review" ? null
      : job.dispatchStatus === "approval_required" ? "gateway_approval"
        : job.stage === "review_required" ? "transcript_review" : null,
    // One boolean for "stop polling", so firmware does not have to know the milestone list.
    done: milestone === "sent" || milestone === "failed" || milestone === "ready" || milestone === "review",
    ok: milestone !== "failed",
    // Present from `ready` onwards; the screen shows it so the owner can confirm what was heard.
    transcript: transcriptForDevice(job),
    autoSend: job.autoSend === true,
    commandId: job.commandId ?? null,
    error: job.dispatchError ?? job.lastError ?? null,
    updatedAt: job.updatedAt,
  };
}

/**
 * The SSE payload for `media.job`.
 *
 * The console and the device see the same milestone, computed once here, so a screen that polls
 * and a screen that listens never disagree about which stage a capture reached.
 */
export function mediaJobEvent(job, observedAt) {
  return {
    jobId: job.id,
    mediaId: job.mediaId,
    deviceId: job.deviceId ?? null,
    kind: job.kind,
    stage: job.stage,
    milestone: milestoneForJob(job),
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    provider: job.provider ?? null,
    autoSend: job.autoSend === true,
    dispatchStatus: job.dispatchStatus ?? null,
    commandId: job.commandId ?? null,
    lastError: job.lastError ?? null,
    dispatchError: job.dispatchError ?? null,
    failureKind: job.failureKind ?? null,
    // Why a terminal failure was terminal, so the console can offer the retry that fits it rather
    // than a "try again" button that would fail identically.
    failureCause: job.failureCause ?? null,
    observedAt,
  };
}

/**
 * Whether this device may send a finished transcript on without a person looking at it.
 *
 * Reads the answer the store already derived (`normalizeVoiceAutoSend` in src/store.mjs), which is
 * three-valued underneath: the owner's explicit choice if they made one, and otherwise the
 * hardware's default — on for a device that has declared a microphone on a heartbeat, off for one
 * that never has. A controller whose purpose is to be spoken to should work when it is spoken to;
 * a board with no microphone is never handed a licence it could not use.
 *
 * Still per device, never per account. Auto-send is a trust decision about one microphone in one
 * room: an account-wide switch would extend it to the next controller the owner claims, and a
 * device that arrives later must earn its own answer from its own hardware. `enabledBy` is the
 * owner who granted it explicitly, and stays null for the default — a default has nobody behind it
 * and must not be recorded as though somebody signed for it.
 */
export function voiceAutoSendEnabled(device) {
  return device?.voiceAutoSend?.enabled === true;
}
