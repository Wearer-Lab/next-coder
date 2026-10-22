import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStore } from "../src/fileStore.mjs";

import { createMediaJobRunner, effectiveTranscript } from "../src/mediaJobs.mjs";
import { createMemoryStore } from "../src/store.mjs";
import {
  TranscriptionError,
  describeTranscriptChange,
  normalizeTranscriptText,
} from "../src/transcription.mjs";

const USER_ID = "user_dev";

test("device capture enqueue reuses both terminal outcomes while an explicit owner transcription may create a new job", () => {
  for (const stage of ["dispatched", "failed"]) {
    const store = createMemoryStore();
    const media = seedAudio(store);
    const input = { userId: USER_ID, mediaId: media.id, deviceId: "device_capture" };
    const job = store.createMediaJob(input);
    store.updateMediaJob({ jobId: job.id, stage });
    const replay = store.createMediaJob(input);
    assert.equal(replay.id, job.id);
    assert.equal(replay.stage, stage);
    assert.equal(store.listMediaJobs({ userId: USER_ID, mediaId: media.id }).length, 1);
    assert.notEqual(store.createMediaJob({ userId: USER_ID, mediaId: media.id }).id, job.id);
  }
});

test("completed capture idempotency survives a file-store restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "next-coder-capture-replay-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "store.json");
  const first = await createFileStore(path);
  const media = seedAudio(first);
  const input = { userId: USER_ID, mediaId: media.id, deviceId: "device_capture" };
  const job = first.createMediaJob(input);
  first.updateMediaJob({ jobId: job.id, stage: "dispatched" });
  await first.flush();
  const reloaded = await createFileStore(path);
  assert.equal(reloaded.createMediaJob(input).id, job.id);
  assert.equal(reloaded.listMediaJobs({ userId: USER_ID, mediaId: media.id }).length, 1);
});

function seedAudio(store, { userId = USER_ID, originalName = "clip.webm" } = {}) {
  store.ensureUser({ userId });
  return store.createMediaUpload({
    userId,
    deviceId: null,
    kind: "audio",
    contentType: "audio/webm",
    sizeBytes: 16,
    sha256: "a".repeat(64),
    storagePath: `/tmp/${originalName}`,
    originalName,
  });
}

/** A provider stub. `fail` is called per attempt so a test can fail once and then succeed. */
function stubProvider({ text = "  deploy the staging branch  ", fail = null } = {}) {
  const calls = [];
  return {
    name: "stub",
    model: "stub-1",
    available: true,
    calls,
    async transcribe({ media }) {
      calls.push(media.id);
      const error = fail?.(calls.length);
      if (error) throw error;
      return { text, provider: "stub", model: "stub-1", language: "en", durationMs: 7 };
    },
  };
}

/** Wraps a store so a test can watch every stage the job passes through, in order. */
function recordStages(store) {
  const stages = [];
  return {
    stages,
    store: {
      ...store,
      claimMediaJobs: async (args) => {
        const claimed = await store.claimMediaJobs(args);
        for (const job of claimed) stages.push(job.stage);
        return claimed;
      },
      updateMediaJob: async (args) => {
        const job = await store.updateMediaJob(args);
        if (job) stages.push(job.stage);
        return job;
      },
    },
  };
}

function recordingEvents() {
  const published = [];
  return { published, broadcastToUser: (userId, event, payload) => published.push({ userId, event, payload }) };
}

test("a transcription job walks every stage from queued to dispatched", async () => {
  const base = createMemoryStore();
  const media = seedAudio(base);
  const { store, stages } = recordStages(base);
  const provider = stubProvider();
  const events = recordingEvents();

  base.createMediaJob({ userId: USER_ID, mediaId: media.id, provider: "stub" });
  const runner = createMediaJobRunner({ store, provider, events });

  const { skipped, processed } = await runner.runOnce();
  assert.equal(skipped, false);
  assert.equal(processed.length, 1);
  assert.equal(processed[0].mediaId, media.id);
  assert.equal(processed[0].stage, "dispatched");

  assert.deepEqual(stages, ["transcribing", "normalizing", "ready", "dispatching", "dispatched"]);

  const [job] = base.listMediaJobs({ userId: USER_ID });
  assert.equal(job.stage, "dispatched");
  assert.equal(job.attempts, 1);
  assert.equal(job.leaseOwner, null, "a finished job must not keep its lease.");
  assert.equal(job.lastError, null);
  assert.ok(job.timings.queuedAt && job.timings.startedAt && job.timings.transcribedAt);
  assert.ok(job.timings.normalizedAt && job.timings.readyAt && job.timings.dispatchedAt);
  assert.equal(job.timings.providerMs, 7);

  // Dispatch means the finished transcript reached the media record, which is what the
  // audio_prompt path reads.
  const stored = base.listMediaUploads(USER_ID).find((item) => item.id === media.id);
  assert.equal(stored.transcript, "Deploy the staging branch.");
  assert.equal(stored.processing.transcriptionStatus, "ready");
  assert.equal(stored.processing.transcriptSource, "stub");

  assert.deepEqual(
    events.published.filter((entry) => entry.event === "media.job").map((entry) => entry.payload.stage),
    ["normalizing", "ready", "dispatched"],
  );
});

test("a job that requires review parks for a person instead of dispatching", async () => {
  const store = createMemoryStore();
  const media = seedAudio(store);
  const provider = stubProvider();
  const queued = store.createMediaJob({
    userId: USER_ID,
    mediaId: media.id,
    provider: "stub",
    reviewRequired: true,
  });
  const runner = createMediaJobRunner({ store, provider });

  await runner.runOnce();
  let job = store.getMediaJobForUser(USER_ID, queued.id);
  assert.equal(job.stage, "review_required");
  assert.equal(job.leaseExpiresAt, null, "a job waiting on a person must not hold a lease.");
  assert.equal(store.listMediaUploads(USER_ID)[0].transcript, null);

  // A worker must never pick a review_required job back up, however many ticks pass.
  await runner.runOnce();
  await runner.runOnce();
  assert.equal(provider.calls.length, 1);
  assert.equal(store.getMediaJobForUser(USER_ID, queued.id).stage, "review_required");

  store.updateMediaJob({
    jobId: queued.id,
    userId: USER_ID,
    userEditedTranscript: "Deploy the staging branch to prod.",
    stage: "ready",
  });
  await runner.runOnce();

  job = store.getMediaJobForUser(USER_ID, queued.id);
  assert.equal(job.stage, "dispatched");
  assert.equal(provider.calls.length, 1, "review must not re-run the ASR call.");
  assert.equal(job.rawTranscript, "  deploy the staging branch  ");
  assert.equal(job.normalizedTranscript, "Deploy the staging branch.");
  assert.equal(job.userEditedTranscript, "Deploy the staging branch to prod.");
  assert.equal(store.listMediaUploads(USER_ID)[0].transcript, "Deploy the staging branch to prod.");
});

test("transcript versions are immutable once written; only the reviewed one stays writable", () => {
  const store = createMemoryStore();
  const media = seedAudio(store);
  const job = store.createMediaJob({ userId: USER_ID, mediaId: media.id });

  const first = store.updateMediaJob({
    jobId: job.id,
    rawTranscript: "  raw one  ",
    normalizedTranscript: "Raw one.",
  });
  // Whitespace survives verbatim: the point of keeping the raw version is seeing what the
  // provider actually returned.
  assert.equal(first.rawTranscript, "  raw one  ");
  assert.equal(first.normalizedTranscript, "Raw one.");

  const second = store.updateMediaJob({
    jobId: job.id,
    rawTranscript: "raw two",
    normalizedTranscript: "Raw two.",
  });
  assert.equal(second.rawTranscript, "  raw one  ", "the ASR record must never be rewritten.");
  assert.equal(second.normalizedTranscript, "Raw one.");

  const edited = store.updateMediaJob({ jobId: job.id, userEditedTranscript: "Reviewed value." });
  assert.equal(edited.userEditedTranscript, "Reviewed value.");
  assert.equal(edited.rawTranscript, "  raw one  ");
  assert.equal(effectiveTranscript(edited), "Reviewed value.");

  const reEdited = store.updateMediaJob({ jobId: job.id, userEditedTranscript: "Reviewed again." });
  assert.equal(reEdited.userEditedTranscript, "Reviewed again.");
  assert.equal(effectiveTranscript({ ...reEdited, userEditedTranscript: null }), "Raw one.");
  assert.equal(
    effectiveTranscript({ rawTranscript: "  only raw  ", normalizedTranscript: null, userEditedTranscript: null }),
    "only raw",
  );
});

test("a live lease hides a job from other workers, and an expired one hands it back", () => {
  const store = createMemoryStore();
  const media = seedAudio(store);
  const job = store.createMediaJob({ userId: USER_ID, mediaId: media.id });

  const start = "2026-01-01T00:00:00.000Z";
  const claimed = store.claimMediaJobs({ owner: "worker-a", leaseMs: 60_000, now: start });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].leaseOwner, "worker-a");
  assert.equal(claimed[0].attempts, 1);
  assert.equal(claimed[0].leaseExpiresAt, "2026-01-01T00:01:00.000Z");

  // Still inside the lease: worker-b sees nothing, so the ASR call is never made twice.
  assert.deepEqual(store.claimMediaJobs({ owner: "worker-b", now: "2026-01-01T00:00:30.000Z" }), []);
  // Even the original owner has to wait — a re-entrant claim would be the same double call.
  assert.deepEqual(store.claimMediaJobs({ owner: "worker-a", now: "2026-01-01T00:00:59.000Z" }), []);

  // worker-a is gone. Once the lease lapses the job is recoverable rather than lost.
  const recovered = store.claimMediaJobs({ owner: "worker-b", leaseMs: 60_000, now: "2026-01-01T00:01:01.000Z" });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, job.id);
  assert.equal(recovered[0].leaseOwner, "worker-b");
  assert.equal(recovered[0].attempts, 2);
  assert.equal(recovered[0].stage, "transcribing");
});

test("a resumed job restarts from the evidence it already stored", () => {
  const store = createMemoryStore();
  const media = seedAudio(store);
  const job = store.createMediaJob({ userId: USER_ID, mediaId: media.id });

  store.claimMediaJobs({ owner: "worker-a", leaseMs: 1000, now: "2026-01-01T00:00:00.000Z" });
  // The worker got as far as recording the ASR output, then died.
  store.updateMediaJob({ jobId: job.id, stage: "normalizing", rawTranscript: "already heard" });

  const [resumed] = store.claimMediaJobs({ owner: "worker-b", now: "2026-01-01T00:05:00.000Z" });
  assert.equal(resumed.stage, "normalizing", "a stored raw transcript must not be paid for twice.");

  store.updateMediaJob({ jobId: job.id, stage: "ready", normalizedTranscript: "Already heard." });
  const [again] = store.claimMediaJobs({ owner: "worker-c", now: "2026-01-01T00:10:00.000Z" });
  assert.equal(again.stage, "dispatching");
});

test("the retry budget is bounded and ends in a terminal failure", async () => {
  const store = createMemoryStore();
  const media = seedAudio(store);
  const provider = stubProvider({ fail: () => new TranscriptionError("upstream is unwell", { retryable: true }) });
  const queued = store.createMediaJob({ userId: USER_ID, mediaId: media.id, maxAttempts: 3, provider: "stub" });
  const runner = createMediaJobRunner({ store, provider });

  await runner.runOnce();
  assert.equal(store.getMediaJobForUser(USER_ID, queued.id).stage, "queued");
  await runner.runOnce();
  assert.equal(store.getMediaJobForUser(USER_ID, queued.id).stage, "queued");
  await runner.runOnce();

  const job = store.getMediaJobForUser(USER_ID, queued.id);
  assert.equal(job.stage, "failed");
  assert.equal(job.attempts, 3);
  assert.equal(job.failureKind, "retryable");
  assert.equal(job.lastError, "upstream is unwell");
  assert.ok(job.timings.failedAt);

  // Terminal means terminal: further ticks must not resurrect it.
  await runner.runOnce();
  await runner.runOnce();
  assert.equal(provider.calls.length, 3);
  assert.equal(store.listMediaUploads(USER_ID)[0].processing.transcriptionStatus, "failed");
});

test("a retryable failure that later succeeds keeps its earlier attempts", async () => {
  const store = createMemoryStore();
  const media = seedAudio(store);
  const provider = stubProvider({
    fail: (attempt) => (attempt === 1 ? new TranscriptionError("timed out", { retryable: true }) : null),
  });
  const queued = store.createMediaJob({ userId: USER_ID, mediaId: media.id, provider: "stub" });
  const runner = createMediaJobRunner({ store, provider });

  await runner.runOnce();
  await runner.runOnce();

  const job = store.getMediaJobForUser(USER_ID, queued.id);
  assert.equal(job.stage, "dispatched");
  assert.equal(job.attempts, 2);
  assert.equal(job.lastError, null, "a success must clear the earlier error.");
  assert.equal(job.failureKind, null);
});

test("a job whose attempts were exhausted while leased is failed rather than re-run forever", async () => {
  const store = createMemoryStore();
  const media = seedAudio(store);
  const job = store.createMediaJob({ userId: USER_ID, mediaId: media.id, maxAttempts: 1 });

  store.claimMediaJobs({ owner: "worker-a", leaseMs: 1000, now: "2026-01-01T00:00:00.000Z" });
  // worker-a never came back and the budget is spent.
  const claimed = store.claimMediaJobs({ owner: "worker-b", now: "2026-01-01T01:00:00.000Z" });
  assert.deepEqual(claimed, []);

  const failed = store.getMediaJobForUser(USER_ID, job.id);
  assert.equal(failed.stage, "failed");
  assert.equal(failed.failureKind, "terminal");
  assert.match(failed.lastError, /abandoned after 1 attempts/u);
  assert.equal(failed.leaseExpiresAt, null);
});

test("a restart resumes queued work without dispatching it twice", async () => {
  const before = createMemoryStore();
  const media = seedAudio(before);
  const queued = before.createMediaJob({ userId: USER_ID, mediaId: media.id, provider: "stub" });

  const finished = seedAudio(before, { originalName: "done.webm" });
  const done = before.createMediaJob({ userId: USER_ID, mediaId: finished.id, provider: "stub" });
  before.updateMediaJob({
    jobId: done.id,
    stage: "dispatched",
    rawTranscript: "already sent",
    normalizedTranscript: "Already sent.",
    releaseLease: true,
  });

  // The process dies here. A file store would have persisted exactly this.
  const snapshot = JSON.parse(JSON.stringify(before.exportState()));
  const after = createMemoryStore(snapshot);

  assert.equal(after.getMediaJobForUser(USER_ID, queued.id).stage, "queued");
  const provider = stubProvider();
  const runner = createMediaJobRunner({ store: after, provider });
  await runner.runOnce();
  await runner.runOnce();

  assert.deepEqual(provider.calls, [media.id], "only the unfinished job may be picked back up.");
  assert.equal(after.getMediaJobForUser(USER_ID, queued.id).stage, "dispatched");
  assert.equal(after.getMediaJobForUser(USER_ID, done.id).stage, "dispatched");
  assert.equal(after.getMediaJobForUser(USER_ID, done.id).rawTranscript, "already sent");

  // The audio itself is untouched by any of this — a transcript is derived, the upload is source.
  assert.equal(after.listMediaUploads(USER_ID).length, 2);
  assert.ok(after.getMediaForUser(USER_ID, media.id).storagePath);
});

test("two workers on one store cannot dispatch the same job twice", async () => {
  const store = createMemoryStore();
  const media = seedAudio(store);
  const job = store.createMediaJob({ userId: USER_ID, mediaId: media.id });
  const provider = stubProvider();

  const first = createMediaJobRunner({ store, provider, workerId: "worker-a" });
  const second = createMediaJobRunner({ store, provider, workerId: "worker-b" });
  const [a, b] = await Promise.all([first.runOnce(), second.runOnce()]);

  assert.equal(provider.calls.length, 1);
  assert.equal(a.processed.length + b.processed.length, 1);
  assert.equal(store.getMediaJobForUser(USER_ID, job.id).stage, "dispatched");
});

test("overlapping ticks on one runner are skipped rather than queued up", async () => {
  const store = createMemoryStore();
  const media = seedAudio(store);
  store.createMediaJob({ userId: USER_ID, mediaId: media.id });

  let concurrent = 0;
  let maxConcurrent = 0;
  const provider = {
    name: "slow",
    model: null,
    available: true,
    async transcribe() {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent -= 1;
      return { text: "slow answer", provider: "slow", model: null, language: null, durationMs: 10 };
    },
  };

  const runner = createMediaJobRunner({ store, provider });
  const [first, second] = await Promise.all([runner.runOnce(), runner.runOnce()]);
  assert.equal(maxConcurrent, 1);
  assert.ok(first.skipped || second.skipped);
});

test("enqueueing is idempotent while a job is unfinished", () => {
  const store = createMemoryStore();
  const media = seedAudio(store);

  const first = store.createMediaJob({ userId: USER_ID, mediaId: media.id });
  const second = store.createMediaJob({ userId: USER_ID, mediaId: media.id });
  assert.equal(second.id, first.id, "a second click must not race the first worker.");

  store.updateMediaJob({ jobId: first.id, stage: "dispatched" });
  const third = store.createMediaJob({ userId: USER_ID, mediaId: media.id });
  assert.notEqual(third.id, first.id, "a finished job must not block a fresh transcription.");

  assert.equal(store.createMediaJob({ userId: "user_other", mediaId: media.id }), null);
  assert.equal(store.getMediaJobForUser("user_other", first.id), null);
});

test("deleting the media clears the jobs that could never finish", () => {
  const store = createMemoryStore();
  const media = seedAudio(store);
  store.createMediaJob({ userId: USER_ID, mediaId: media.id });

  store.deleteMediaUpload({ userId: USER_ID, mediaId: media.id });
  assert.deepEqual(store.listMediaJobs({ userId: USER_ID }), []);
  assert.deepEqual(store.claimMediaJobs({ owner: "worker-a" }), []);
});

test("a job whose media vanished mid-flight fails terminally", async () => {
  const store = createMemoryStore();
  const media = seedAudio(store);
  const job = store.createMediaJob({ userId: USER_ID, mediaId: media.id });
  const provider = stubProvider();
  // The record is already gone by the time the worker reaches it.
  const runner = createMediaJobRunner({ store: { ...store, getMediaForUser: () => null }, provider });

  const { processed } = await runner.runOnce();
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(processed.map((entry) => entry.stage), ["failed"]);

  const failed = store.getMediaJobForUser(USER_ID, job.id);
  assert.equal(failed.stage, "failed");
  assert.equal(failed.failureKind, "terminal");
  assert.match(failed.lastError, /no longer exists/u);
});

test("listMediaJobs filters by media and stage and stays user scoped", () => {
  const store = createMemoryStore();
  const first = seedAudio(store, { originalName: "one.webm" });
  const second = seedAudio(store, { originalName: "two.webm" });
  store.ensureUser({ userId: "user_other", email: "other@example.local" });

  const a = store.createMediaJob({ userId: USER_ID, mediaId: first.id });
  store.createMediaJob({ userId: USER_ID, mediaId: second.id });
  store.updateMediaJob({ jobId: a.id, stage: "failed" });

  assert.equal(store.listMediaJobs({ userId: USER_ID }).length, 2);
  assert.deepEqual(store.listMediaJobs({ userId: USER_ID, mediaId: second.id }).map((job) => job.mediaId), [second.id]);
  assert.deepEqual(store.listMediaJobs({ userId: USER_ID, stage: "failed" }).map((job) => job.id), [a.id]);
  assert.deepEqual(store.listMediaJobs({ userId: "user_other" }), []);
});

test("normalization cleans up spacing without mangling filenames or numbers", () => {
  assert.equal(normalizeTranscriptText("  deploy   the staging branch  "), "Deploy the staging branch.");
  assert.equal(normalizeTranscriptText("run it ,then stop ."), "Run it, then stop.");
  assert.equal(normalizeTranscriptText("done.Next up"), "Done. Next up.");
  // A sentence-boundary rule that broke "clip.webm" into "clip. webm" would corrupt the text it
  // was meant to tidy.
  assert.equal(normalizeTranscriptText("open clip.webm now"), "Open clip.webm now.");
  assert.equal(normalizeTranscriptText("we shipped 3,000 builds at 10:30"), "We shipped 3,000 builds at 10:30.");
  assert.equal(normalizeTranscriptText("already fine!"), "Already fine!");
  assert.equal(normalizeTranscriptText("   "), null);
  assert.equal(normalizeTranscriptText(null), null);
});

test("a provider that returns nothing usable fails terminally instead of dispatching silence", async () => {
  const store = createMemoryStore();
  const media = seedAudio(store);
  const queued = store.createMediaJob({ userId: USER_ID, mediaId: media.id });
  const runner = createMediaJobRunner({ store, provider: stubProvider({ text: "   " }) });

  await runner.runOnce();
  const job = store.getMediaJobForUser(USER_ID, queued.id);
  assert.equal(job.stage, "failed");
  assert.equal(job.failureKind, "terminal");
  assert.match(job.lastError, /no usable text/u);
  assert.equal(store.listMediaUploads(USER_ID)[0].transcript, null);
});

test("a cleanup that rewrites the user's words parks for review instead of dispatching", async () => {
  const store = createMemoryStore();
  const media = seedAudio(store);
  const provider = stubProvider({ text: "deploy the staging branch" });
  const warnings = [];
  const queued = store.createMediaJob({ userId: USER_ID, mediaId: media.id, provider: "stub" });
  const runner = createMediaJobRunner({
    store,
    provider,
    // Stands in for any second-pass "correction". The guard does not care where it came from —
    // only that the letters moved, which cleanup is never allowed to do.
    normalize: () => "Deploy the stating branch.",
    logger: { warn: (entry) => warnings.push(entry) },
  });

  await runner.runOnce();

  const job = store.getMediaJobForUser(USER_ID, queued.id);
  assert.equal(job.stage, "review_required");
  assert.equal(job.reviewRequired, false, "review was not configured; the rewrite is what forced it.");
  assert.equal(job.rawTranscript, "deploy the staging branch", "the ASR record survives the rewrite.");
  assert.equal(job.normalizedTranscript, "Deploy the stating branch.", "and so does the evidence of it.");
  assert.equal(
    store.listMediaUploads(USER_ID)[0].transcript,
    null,
    "a changed command is never applied on the user's behalf.",
  );
  assert.match(warnings.join(" "), /altered the wording/u);

  const change = describeTranscriptChange(job.rawTranscript, job.normalizedTranscript);
  assert.equal(change.contentPreserved, false);
  assert.equal(change.firstDivergenceIndex, 12);

  // And it stays parked however many ticks pass, until a person decides.
  await runner.runOnce();
  await runner.runOnce();
  assert.equal(store.getMediaJobForUser(USER_ID, queued.id).stage, "review_required");
  assert.equal(provider.calls.length, 1);
});

test("spacing, punctuation and case may move freely; the letters may not", async () => {
  const store = createMemoryStore();
  const media = seedAudio(store);
  // Parakeet punctuates its own output, so the cleanup usually only trims — and a run-together
  // sentence boundary is still cleanup, because no letter changed.
  const provider = stubProvider({ text: "  restart the worker.Then tail the logs  " });
  const queued = store.createMediaJob({ userId: USER_ID, mediaId: media.id, provider: "stub" });

  await createMediaJobRunner({ store, provider }).runOnce();

  const job = store.getMediaJobForUser(USER_ID, queued.id);
  assert.equal(job.stage, "dispatched");
  assert.equal(job.normalizedTranscript, "Restart the worker. Then tail the logs.");
  assert.equal(describeTranscriptChange(job.rawTranscript, job.normalizedTranscript).contentPreserved, true);
});
