import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createMediaJobRunner } from "../src/mediaJobs.mjs";
import { createMemoryStore } from "../src/store.mjs";

// Why a terminal failure was terminal, and what an owner is allowed to do about it.
//
// The incident: two clips failed permanently because TRANSCRIPTION_PROVIDER was unset. That is a
// fault in the deployment, not in the audio, and it stopped being true the moment somebody fixed
// it — but `failed` is terminal and never re-claimed, so the recordings stayed dead and looked
// exactly like a clip nothing can transcribe.
//
// Everything below is about keeping those two apart, and about the one thing that must not follow
// from being able to re-run old captures: a batch of transcripts from hours ago arriving at a
// coding agent as instructions, because auto-send now defaults on for a microphone device.

const USER_ID = "user_dev";
const WEBM_BASE64 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString("base64");

function wavClip(seconds, { sampleRate = 16000, channels = 1, bitsPerSample = 16 } = {}) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const dataBytes = Math.round(byteRate * seconds);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

/** A real file on disk, because every adapter reads the bytes before it decides anything. */
async function seedAudio(t, {
  store = createMemoryStore(),
  contentType = "audio/wav",
  originalName = "clip.wav",
  bytes = wavClip(2),
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "media-job-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storagePath = join(dir, originalName);
  await writeFile(storagePath, bytes);

  store.ensureUser({ userId: USER_ID });
  const media = store.createMediaUpload({
    userId: USER_ID,
    deviceId: null,
    kind: "audio",
    contentType,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    storagePath,
    originalName,
  });
  return { store, media };
}

/**
 * Replaces globalThis.fetch for one test, restoring the *pristine* implementation afterwards.
 *
 * A test that stubs twice must not restore its own first stub: the second call would capture it as
 * "the original" and leave it installed for every test that follows, which is how a socket error
 * from one case ends up failing an unrelated one three tests later.
 */
const PRISTINE_FETCH = new WeakMap();
function stubFetch(t, handler) {
  if (!PRISTINE_FETCH.has(t)) {
    const original = globalThis.fetch;
    PRISTINE_FETCH.set(t, original);
    t.after(() => {
      globalThis.fetch = original;
    });
  }
  globalThis.fetch = handler;
}

/**
 * Runs one job to a standstill with the real provider adapter, and answers with the job row.
 *
 * The point of using the real adapter rather than a stub that throws a pre-labelled error is that
 * the label is the thing under test: a cause asserted against an error the test itself constructed
 * would prove only that the test can spell it.
 */
async function failWith(t, { config, media, store, maxAttempts = 1 }) {
  store.createMediaJob({ userId: USER_ID, mediaId: media.id, provider: config.transcriptionProvider, maxAttempts });
  const runner = createMediaJobRunner({ store, config });
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) await runner.runOnce();
  const [job] = store.listMediaJobs({ userId: USER_ID, mediaId: media.id });
  return job;
}

test("a deployment with no provider fails for configuration reasons, not for the audio", async (t) => {
  const { store, media } = await seedAudio(t);
  const job = await failWith(t, { config: { transcriptionProvider: "disabled" }, media, store });

  assert.equal(job.stage, "failed");
  assert.equal(job.failureKind, "terminal");
  assert.equal(job.failureCause, "configuration");
  assert.match(job.lastError, /No transcription provider is configured/u);
});

test("a provider selected without its credential is a configuration failure", async (t) => {
  const { store, media } = await seedAudio(t);
  const job = await failWith(t, {
    config: { transcriptionProvider: "openai", transcriptionApiKey: null },
    media,
    store,
  });

  assert.equal(job.stage, "failed");
  assert.equal(job.failureCause, "configuration");
});

test("a rejected credential is configuration; a 500 is the provider having a bad day", async (t) => {
  const rejected = await seedAudio(t);
  stubFetch(t, async () => new Response("nope", { status: 401 }));
  const unauthorized = await failWith(t, {
    config: { transcriptionProvider: "openai", transcriptionApiKey: "sk-wrong" },
    media: rejected.media,
    store: rejected.store,
  });
  assert.equal(unauthorized.failureCause, "configuration");

  const broken = await seedAudio(t);
  stubFetch(t, async () => new Response("boom", { status: 500 }));
  // Retryable, so it only becomes terminal once the budget is spent — and the cause recorded on
  // the last attempt is the cause the abandonment inherits.
  const unwell = await failWith(t, {
    config: { transcriptionProvider: "openai", transcriptionApiKey: "sk-live" },
    media: broken.media,
    store: broken.store,
    maxAttempts: 2,
  });
  assert.equal(unwell.stage, "failed");
  assert.equal(unwell.failureCause, "provider");
});

test("things about the audio are input failures, which no configuration change fixes", async (t) => {
  // A container the sidecar does not decode.
  const wrongContainer = await seedAudio(t, { contentType: "audio/mpeg", originalName: "clip.mp3" });
  const refused = await failWith(t, {
    config: { transcriptionProvider: "parakeet" },
    media: wrongContainer.media,
    store: wrongContainer.store,
  });
  assert.equal(refused.failureCause, "input");
  assert.match(refused.lastError, /does not accept audio\/mpeg/u);

  // A clip longer than the sidecar will take.
  const tooLong = await seedAudio(t, { bytes: wavClip(400) });
  const overLength = await failWith(t, {
    config: { transcriptionProvider: "parakeet", parakeetMaxClipSeconds: 120 },
    media: tooLong.media,
    store: tooLong.store,
  });
  assert.equal(overLength.failureCause, "input");

  // Silence: the provider answered, and there was nothing in it.
  const silent = await seedAudio(t);
  stubFetch(t, async () => new Response(JSON.stringify({ text: "   " }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  const empty = await failWith(t, {
    config: { transcriptionProvider: "openai", transcriptionApiKey: "sk-live" },
    media: silent.media,
    store: silent.store,
  });
  assert.equal(empty.failureCause, "input");
});

test("an English-only checkpoint pointed at another language is a configuration error", async (t) => {
  const { store, media } = await seedAudio(t);
  const job = await failWith(t, {
    config: {
      transcriptionProvider: "parakeet",
      parakeetModel: "nvidia/parakeet-tdt-0.6b-v2",
      parakeetLanguage: "fr",
    },
    media,
    store,
  });

  assert.equal(job.failureCause, "configuration");
  assert.match(job.lastError, /transcribes English only/u);
});

test("a sidecar that was not running is configuration; one that ran out of time is not", async (t) => {
  const down = await seedAudio(t);
  stubFetch(t, async () => {
    throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8977"), { name: "TypeError" });
  });
  const unreachable = await failWith(t, {
    config: { transcriptionProvider: "parakeet" },
    media: down.media,
    store: down.store,
  });
  assert.equal(unreachable.failureCause, "configuration");

  const slow = await seedAudio(t);
  stubFetch(t, async () => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  });
  const timedOut = await failWith(t, {
    config: { transcriptionProvider: "parakeet" },
    media: slow.media,
    store: slow.store,
  });
  assert.equal(timedOut.failureCause, "provider");
});

test("an unexpected throw is unknown rather than quietly filed as retryable configuration", async (t) => {
  const { store, media } = await seedAudio(t);
  store.createMediaJob({ userId: USER_ID, mediaId: media.id, maxAttempts: 1 });
  const runner = createMediaJobRunner({
    store,
    provider: {
      name: "stub",
      model: "stub-1",
      available: true,
      async transcribe() {
        throw new Error("something nobody labelled");
      },
    },
  });
  await runner.runOnce();

  const [job] = store.listMediaJobs({ userId: USER_ID });
  assert.equal(job.stage, "failed");
  assert.equal(job.failureCause, "unknown");
});

test("only a configuration failure can be requeued, and the budget starts over", async (t) => {
  const { store, media } = await seedAudio(t);
  const configFailed = await failWith(t, { config: { transcriptionProvider: "disabled" }, media, store });
  assert.equal(configFailed.attempts, 1);

  const requeued = store.requeueMediaJob({ userId: USER_ID, jobId: configFailed.id, actorId: USER_ID });
  assert.equal(requeued.stage, "queued");
  // The attempts were spent on a fault that no longer exists; charging the clip for them would
  // fail it again after one bad tick.
  assert.equal(requeued.attempts, 0);
  assert.equal(requeued.failureCause, null);
  assert.equal(requeued.lastError, null);
  assert.equal(requeued.requeueCount, 1);
  assert.equal(requeued.requeuedBy, USER_ID);
  // The safety rule, and not a caller's choice.
  assert.equal(requeued.reviewRequired, true);

  const audit = store.listAuditLogs(USER_ID).find((event) => event.action === "media_job.requeued");
  assert.equal(audit.metadata.holdForReview, true);
  assert.equal(audit.metadata.requeueCount, 1);

  // An input failure is not eligible however it is asked for. Its own store, because one tick
  // claims every runnable job there is and the requeued job above is runnable again.
  const clip = await seedAudio(t, { contentType: "audio/mpeg", originalName: "other.mp3" });
  const inputFailed = await failWith(t, {
    config: { transcriptionProvider: "parakeet" },
    media: clip.media,
    store: clip.store,
  });
  assert.equal(inputFailed.failureCause, "input");
  assert.equal(clip.store.requeueMediaJob({ userId: USER_ID, jobId: inputFailed.id }), null);

  // Nor is a job that is not finished, or one that belongs to somebody else.
  const live = store.createMediaJob({ userId: USER_ID, mediaId: media.id, kind: "other" });
  assert.equal(store.requeueMediaJob({ userId: USER_ID, jobId: live.id }), null);
  assert.equal(store.requeueMediaJob({ userId: "user_other", jobId: configFailed.id }), null);
});

// --- The HTTP path, and the interaction with a default-on microphone -------------------------

/**
 * A gateway whose transcription provider is selected but has no credential.
 *
 * That is the incident, reproduced: jobs enqueue happily and then fail terminally on something an
 * operator can fix. `config` is the live object the app reads, so a test can fix the deployment
 * mid-flight exactly as an operator would and then ask for the retry.
 */
async function setupGateway(t, { features = ["display", "buttons", "microphone"] } = {}) {
  const mediaDir = await mkdtemp(join(tmpdir(), "media-job-retry-http-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  const dispatches = [];
  const transcripts = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    if (parsed.pathname === "/v1/audio/transcriptions") {
      const text = transcripts.length > 0 ? transcripts.shift() : "ship the release branch";
      return jsonResponse({ text }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const config = {
    mediaDir,
    maxMediaBytes: 4096,
    transcriptionProvider: "openai",
    transcriptionApiKey: null,
    demoMode: false,
  };
  const { server, mediaJobRunner, store } = createApp({ config });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = (path, input = {}) => requestJson(originalFetch, baseUrl, path, input);

  const auth = await call("/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: USER_ID, email: "dev@example.local" },
  });
  const authHeaders = { authorization: `Bearer ${auth.apiToken.secret}` };
  const environment = await call("/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });
  const created = await call("/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Kitchen controller", profile: "next-coder" },
  });
  const deviceHeaders = { "x-device-id": created.device.id, "x-device-secret": created.secret };
  await call(`/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: { environmentId: environment.environment.id, threadId: "thread_voice" },
  });
  await call("/v1/device/heartbeat", {
    method: "POST",
    headers: deviceHeaders,
    body: { status: { features, firmwareVersion: "1.0.0" } },
  });

  return {
    call,
    config,
    store,
    dispatches,
    transcripts,
    authHeaders,
    deviceHeaders,
    device: created.device,
    mediaJobRunner,
    fixDeployment: () => {
      config.transcriptionApiKey = "sk-live";
      config.transcriptionUrl = "https://api.openai.example/v1/audio/transcriptions";
    },
    upload: (body = {}) => call("/v1/device/media", {
      method: "POST",
      headers: deviceHeaders,
      body: {
        kind: "audio",
        contentType: "audio/webm",
        dataBase64: WEBM_BASE64,
        originalName: "note.webm",
        ...body,
      },
    }),
  };
}

test("the retry is refused while the deployment would fail identically", async (t) => {
  const gateway = await setupGateway(t);
  const uploaded = await gateway.upload();
  await gateway.mediaJobRunner.runOnce();

  const failed = await gateway.call(`/v1/media/jobs/${uploaded.job.jobId}`, { headers: gateway.authHeaders });
  assert.equal(failed.job.stage, "failed");
  assert.equal(failed.job.failureCause, "configuration");

  // Refusing with a reason beats requeueing into the same wall and spending the fresh budget on it.
  await assert.rejects(
    () => gateway.call("/v1/media/jobs/retry-configuration", {
      method: "POST",
      headers: gateway.authHeaders,
      body: {},
    }),
    (error) => /409/u.test(error.message) && /credential is missing/u.test(error.message),
  );

  const untouched = await gateway.call(`/v1/media/jobs/${uploaded.job.jobId}`, { headers: gateway.authHeaders });
  assert.equal(untouched.job.stage, "failed");
  assert.equal(untouched.job.requeueCount, 0);
});

test("retrying requeues the configuration failures and reports the rest", async (t) => {
  const gateway = await setupGateway(t);
  const spoken = await gateway.upload();
  await gateway.mediaJobRunner.runOnce();

  // A second clip that failed for a reason no configuration change touches.
  const otherFailure = await gateway.upload({ originalName: "silence.webm" });
  await gateway.mediaJobRunner.runOnce();
  await gateway.store.updateMediaJob({
    jobId: otherFailure.job.jobId,
    failureCause: "input",
    lastError: "Transcription provider returned an empty transcript.",
  });

  gateway.fixDeployment();
  const result = await gateway.call("/v1/media/jobs/retry-configuration", {
    method: "POST",
    headers: gateway.authHeaders,
    body: {},
  });

  assert.equal(result.counts.requeued, 1);
  assert.equal(result.counts.skipped, 1);
  assert.equal(result.requeued[0].jobId, spoken.job.jobId);
  assert.equal(result.requeued[0].attempts, 0);
  assert.match(result.requeued[0].previousError, /TRANSCRIPTION_API_KEY/u);
  assert.deepEqual(result.skipped, [{
    jobId: otherFailure.job.jobId,
    mediaId: otherFailure.media.id,
    stage: "failed",
    failureCause: "input",
  }]);
  // Stated in the answer, because it is a promise about what happens next.
  assert.equal(result.holdForReview, true);

  const requeued = await gateway.call(`/v1/media/jobs/${spoken.job.jobId}`, { headers: gateway.authHeaders });
  assert.equal(requeued.job.stage, "queued");
  assert.equal(requeued.job.reviewRequired, true);
  assert.equal(requeued.job.requeueCount, 1);

  // A job id that is not the owner's is a mistake worth naming rather than silently dropping.
  await assert.rejects(
    () => gateway.call("/v1/media/jobs/retry-configuration", {
      method: "POST",
      headers: gateway.authHeaders,
      body: { jobIds: ["mjob_nonexistent"] },
    }),
    /404/u,
  );

  // And naming a job that exists but is not a terminal configuration failure answers with the
  // reason instead of doing nothing at all: the job above is queued again, not failed.
  const named = await gateway.call("/v1/media/jobs/retry-configuration", {
    method: "POST",
    headers: gateway.authHeaders,
    body: { jobIds: [spoken.job.jobId] },
  });
  assert.deepEqual(named.skipped, [{
    jobId: spoken.job.jobId,
    mediaId: spoken.media.id,
    stage: "queued",
    failureCause: null,
  }]);
  assert.equal(named.counts.requeued, 0);
});

test("a requeued capture waits for a person even though this microphone auto-sends", async (t) => {
  const gateway = await setupGateway(t);

  // The default, not a grant: this controller reported a microphone and nobody has said otherwise.
  const grant = await gateway.call(`/v1/devices/${gateway.device.id}/voice-auto-send`, {
    headers: gateway.authHeaders,
  });
  assert.equal(grant.voiceAutoSend.enabled, true);
  assert.equal(grant.voiceAutoSend.source, "default");

  const spoken = await gateway.upload();
  await gateway.mediaJobRunner.runOnce();
  assert.deepEqual(gateway.dispatches, []);

  gateway.fixDeployment();
  gateway.transcripts.push("delete the staging database");
  await gateway.call("/v1/media/jobs/retry-configuration", {
    method: "POST",
    headers: gateway.authHeaders,
    body: {},
  });
  await gateway.mediaJobRunner.runOnce();

  // Transcribed, and going nowhere. The grant says "send what I say as I say it"; it was never
  // consent for something said before the incident was fixed.
  const parked = await gateway.call(`/v1/media/jobs/${spoken.job.jobId}`, { headers: gateway.authHeaders });
  assert.equal(parked.job.stage, "review_required");
  assert.equal(parked.job.normalizedTranscript, "Delete the staging database.");
  assert.deepEqual(gateway.dispatches, []);

  // The device is told the same thing, so a controller is not left claiming the words were sent.
  const onDevice = await gateway.call(`/v1/device/media/jobs/${spoken.job.jobId}`, {
    headers: gateway.deviceHeaders,
  });
  assert.equal(onDevice.job.milestone, "review");

  // And once a person has actually looked at it, the ordinary path resumes — with the grant still
  // in force, because now there is a human decision behind the send.
  await gateway.call(`/v1/media/jobs/${spoken.job.jobId}/transcript`, {
    method: "POST",
    headers: gateway.authHeaders,
    body: { transcript: "Delete the staging database." },
  });
  await gateway.mediaJobRunner.runOnce();

  assert.equal(gateway.dispatches.length, 1);
  const sent = await gateway.call(`/v1/media/jobs/${spoken.job.jobId}`, { headers: gateway.authHeaders });
  assert.equal(sent.job.stage, "dispatched");
  assert.equal(sent.job.dispatchStatus, "sent");
});

test("a worker restart cannot walk a requeued capture past the review gate", async (t) => {
  const gateway = await setupGateway(t);
  gateway.fixDeployment();
  const spoken = await gateway.upload();
  await gateway.mediaJobRunner.runOnce();

  // A finished capture, already dispatched once with both transcript versions on the row. Forced
  // back to `failed` with a configuration cause, which is the shape a job would have if the
  // deployment broke after transcription — the case where resuming skips normalisation entirely.
  await gateway.store.updateMediaJob({
    jobId: spoken.job.jobId,
    stage: "failed",
    failureKind: "terminal",
    failureCause: "configuration",
    lastError: "No transcription provider is configured.",
  });
  gateway.dispatches.length = 0;

  await gateway.call("/v1/media/jobs/retry-configuration", {
    method: "POST",
    headers: gateway.authHeaders,
    body: {},
  });
  await gateway.mediaJobRunner.runOnce();

  // resumeStageFor() sends a job holding both versions straight to `dispatching`, so the review
  // rule cannot live only in the normalizing stage.
  const parked = await gateway.call(`/v1/media/jobs/${spoken.job.jobId}`, { headers: gateway.authHeaders });
  assert.equal(parked.job.stage, "review_required");
  assert.deepEqual(gateway.dispatches, []);
});

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function requestJson(fetchImpl, baseUrl, path, input = {}) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: input.method,
    headers: { "content-type": "application/json", ...input.headers },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}
