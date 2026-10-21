import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createMediaAccessToken, verifyMediaAccessToken } from "../src/mediaLinks.mjs";

// A 1x1 PNG. Small enough to be inlined, real enough to round-trip byte for byte.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const WEBM_BASE64 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString("base64");
const MP3_BASE64 = Buffer.from([0xff, 0xfb, 0x90, 0x64]).toString("base64");

const MEDIA_CONFIG = {
  maxMediaBytes: 64 * 1024,
  mediaSigningKey: "test-media-signing-key",
  mediaLinkTtlSeconds: 900,
  mediaInlineMaxBytes: 256 * 1024,
  defaultMediaRetentionDays: 30,
  demoMode: false,
};

test("camera prompt delivers the image to T3 as a real attachment", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-attach-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({ config: { ...MEDIA_CONFIG, mediaDir } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });

  const upload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: PNG_BASE64,
      originalName: "snapshot.png",
    },
  });

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_media",
      intent: {
        type: "camera_prompt",
        prompt: "What is in this photo?",
        mediaUploadId: upload.media.id,
      },
    },
  });

  assert.equal(dispatched.command.status, "dispatched");
  assert.equal(dispatches.length, 1);

  const attachments = dispatches[0].message.attachments;
  assert.equal(attachments.length, 1, "the dispatched turn must carry exactly one attachment");

  const [attachment] = attachments;
  assert.equal(attachment.type, "image");
  assert.equal(attachment.mediaId, upload.media.id);
  assert.equal(attachment.contentType, "image/png");
  assert.equal(attachment.sha256, upload.media.sha256);
  assert.equal(attachment.name, "snapshot.png");

  // The agent must receive the actual bytes, not just metadata about them.
  assert.equal(attachment.dataBase64, PNG_BASE64);
  assert.ok(attachment.url, "attachment must carry a signed callback URL");
  assert.ok(attachment.urlExpiresAt);
});

test("signed media URL serves bytes without a session and rejects tampering", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-signed-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({ config: { ...MEDIA_CONFIG, mediaDir } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const upload = await requestJson(fetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: { kind: "image", contentType: "image/png", dataBase64: PNG_BASE64 },
  });

  const token = createMediaAccessToken({
    mediaId: upload.media.id,
    userId: "user_dev",
    secret: MEDIA_CONFIG.mediaSigningKey,
    expiresAtMs: Date.now() + 60_000,
  });

  // No authorization header at all: this is what the T3 environment does.
  const contentUrl = new URL(`/v1/media/${upload.media.id}/content`, baseUrl);
  contentUrl.searchParams.set("token", token);
  const response = await fetch(contentUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString("base64"), PNG_BASE64);

  const tampered = new URL(`/v1/media/${upload.media.id}/content`, baseUrl);
  tampered.searchParams.set("token", `${token.slice(0, -4)}AAAA`);
  assert.equal((await fetch(tampered)).status, 403);

  const missingToken = new URL(`/v1/media/${upload.media.id}/content`, baseUrl);
  assert.equal((await fetch(missingToken)).status, 403);
});

test("a media token is scoped to one media id and expires", () => {
  const secret = "signing-secret";
  const token = createMediaAccessToken({
    mediaId: "media_a",
    userId: "user_1",
    secret,
    expiresAtMs: Date.now() + 60_000,
  });

  assert.deepEqual(
    verifyMediaAccessToken({ token, secret }),
    { mediaId: "media_a", userId: "user_1", expiresAtMs: verifyMediaAccessToken({ token, secret }).expiresAtMs },
  );
  assert.equal(verifyMediaAccessToken({ token, secret: "wrong-secret" }), null);
  assert.equal(
    verifyMediaAccessToken({ token, secret, now: Date.now() + 120_000 }),
    null,
    "an expired token must not verify",
  );

  const expired = createMediaAccessToken({
    mediaId: "media_b",
    userId: "user_1",
    secret,
    expiresAtMs: Date.now() - 1,
  });
  assert.equal(verifyMediaAccessToken({ token: expired, secret }), null);
});

test("stored command records omit media bytes and the signed URL", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") return jsonResponse({ status: "accepted" }, 200);
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-redact-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({ config: { ...MEDIA_CONFIG, mediaDir } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });
  const upload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: { kind: "image", contentType: "image/png", dataBase64: PNG_BASE64 },
  });

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_media",
      intent: { type: "camera_prompt", mediaUploadId: upload.media.id },
    },
  });

  const stored = dispatched.command.normalized.message.attachments[0];
  assert.equal(stored.mediaId, upload.media.id);
  assert.equal(stored.sha256, upload.media.sha256);
  assert.equal(stored.dataBase64, undefined, "media bytes must not be persisted on the command");
  assert.equal(stored.url, undefined, "a live signed URL must not be persisted on the command");
  assert.equal(stored.inlined, true);
  assert.equal(stored.urlIssued, true);

  const serialized = JSON.stringify(dispatched.command);
  assert.ok(!serialized.includes(PNG_BASE64), "command payload must not embed the image bytes");
});

test("text-only prompts still dispatch with no attachments", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { ...MEDIA_CONFIG, mediaDir: tmpdir() } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });

  await requestJson(originalFetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_text",
      intent: { type: "agent_prompt", text: "Run the tests." },
    },
  });

  assert.deepEqual(dispatches[0].message.attachments, []);
});

test("openai transcription provider transcribes stored audio", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ text: "  Deploy the staging branch.  " }, 200);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-stt-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server, mediaJobRunner } = createApp({
    config: {
      ...MEDIA_CONFIG,
      mediaDir,
      transcriptionProvider: "openai",
      transcriptionApiKey: "sk-test",
      transcriptionUrl: "https://stt.example/v1/audio/transcriptions",
      transcriptionModel: "whisper-1",
      transcriptionTimeoutMs: 5000,
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const upload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "audio",
      contentType: "audio/webm",
      dataBase64: WEBM_BASE64,
      originalName: "clip.webm",
    },
  });

  const queued = await requestJson(originalFetch, baseUrl, `/v1/media/${upload.media.id}/transcribe`, {
    method: "POST",
    headers: authHeaders,
  });
  assert.equal(queued.job.stage, "queued");
  assert.equal(calls.length, 0, "enqueuing must not call the provider from inside the request.");

  await mediaJobRunner.runOnce();

  const { job } = await requestJson(originalFetch, baseUrl, `/v1/media/jobs/${queued.job.id}`, {
    headers: authHeaders,
  });
  assert.equal(job.stage, "dispatched");
  assert.equal(job.provider, "openai");
  // The versions are distinct records: raw is verbatim ASR output, normalized is the cleanup.
  assert.equal(job.rawTranscript, "  Deploy the staging branch.  ");
  assert.equal(job.normalizedTranscript, "Deploy the staging branch.");
  assert.equal(job.userEditedTranscript, null);

  const listed = await requestJson(originalFetch, baseUrl, "/v1/media", { headers: authHeaders });
  const stored = listed.media.find((item) => item.id === upload.media.id);
  assert.equal(stored.transcript, "Deploy the staging branch.");
  assert.equal(stored.processing.transcriptionStatus, "ready");

  // The audio is a source, not an intermediate: a transcript never consumes it.
  const audio = await originalFetch(new URL(`/v1/media/${upload.media.id}`, baseUrl), {
    headers: authHeaders,
  });
  assert.equal(audio.status, 200);
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), Buffer.from(WEBM_BASE64, "base64"));

  const [call] = calls;
  assert.equal(call.url, "https://stt.example/v1/audio/transcriptions");
  assert.equal(call.init.headers.authorization, "Bearer sk-test");
  assert.ok(call.init.body instanceof FormData);
  assert.equal(call.init.body.get("model"), "whisper-1");
});

test("the parakeet sidecar drives the same job pipeline, over HTTP and off the request path", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return jsonResponse({
      text: "Deploy the staging branch.",
      model: "nvidia/parakeet-tdt-0.6b-v2",
      language: "en",
      duration_seconds: 4,
      timings: { decode_ms: 24, inference_ms: 2000 },
    }, 200);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-parakeet-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server, mediaJobRunner } = createApp({
    config: {
      ...MEDIA_CONFIG,
      mediaDir,
      transcriptionProvider: "parakeet",
      parakeetUrl: "http://127.0.0.1:8977/v1/transcribe",
      parakeetModel: "nvidia/parakeet-tdt-0.6b-v2",
      parakeetLanguage: "en",
      parakeetMaxClipSeconds: 120,
      parakeetConcurrency: 1,
      parakeetAcceptedContentTypes: ["audio/wav", "audio/webm", "audio/ogg", "audio/mp4"],
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const upload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "audio",
      contentType: "audio/webm",
      dataBase64: WEBM_BASE64,
      originalName: "voice.webm",
    },
  });

  const queued = await requestJson(originalFetch, baseUrl, `/v1/media/${upload.media.id}/transcribe`, {
    method: "POST",
    headers: authHeaders,
  });
  assert.equal(queued.job.stage, "queued");
  assert.equal(queued.job.provider, "parakeet");
  // Local inference is still inference: the request must not hold a socket open for it.
  assert.equal(calls.length, 0);

  await mediaJobRunner.runOnce();

  const [call] = calls;
  assert.equal(call.url, "http://127.0.0.1:8977/v1/transcribe");
  assert.ok(call.init.body instanceof FormData);
  assert.equal(call.init.body.get("model"), "nvidia/parakeet-tdt-0.6b-v2");
  assert.equal(call.init.body.get("language"), "en");
  assert.equal(call.init.body.get("max_clip_seconds"), "120");
  assert.equal(call.init.body.get("file").name, "voice.webm");

  const { job } = await requestJson(originalFetch, baseUrl, `/v1/media/jobs/${queued.job.id}`, {
    headers: authHeaders,
  });
  assert.equal(job.stage, "dispatched");
  assert.equal(job.provider, "parakeet");
  assert.equal(job.model, "nvidia/parakeet-tdt-0.6b-v2");
  assert.equal(job.language, "en");
  // Parakeet already punctuates and capitalises, so cleanup has nothing left to do here.
  assert.equal(job.rawTranscript, "Deploy the staging branch.");
  assert.equal(job.normalizedTranscript, "Deploy the staging branch.");
  // The diff is served alongside the versions, so a rewrite could never pass unnoticed.
  assert.equal(job.transcriptChange.changed, false);
  assert.equal(job.transcriptChange.contentPreserved, true);
  // Per-stage timings, including the two only the sidecar can measure.
  assert.equal(job.timings.decodeMs, 24);
  assert.equal(job.timings.inferenceMs, 2000);
  assert.equal(job.timings.realtimeFactor, 0.5);
  assert.equal(typeof job.timings.queueWaitMs, "number");
  assert.equal(typeof job.timings.normalizeMs, "number");
  assert.equal(typeof job.timings.totalMs, "number");

  const listed = await requestJson(originalFetch, baseUrl, "/v1/media", { headers: authHeaders });
  assert.equal(listed.media[0].transcript, "Deploy the staging branch.");
  assert.equal(listed.media[0].processing.transcriptSource, "parakeet");
});

test("a container the sidecar cannot open fails clearly and leaves the audio playable", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ text: "should never happen" }, 200);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-parakeet-container-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server, mediaJobRunner } = createApp({
    config: {
      ...MEDIA_CONFIG,
      mediaDir,
      transcriptionProvider: "parakeet",
      parakeetUrl: "http://127.0.0.1:8977/v1/transcribe",
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const upload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "audio",
      contentType: "audio/mpeg",
      dataBase64: MP3_BASE64,
      originalName: "voice.mp3",
    },
  });

  const queued = await requestJson(originalFetch, baseUrl, `/v1/media/${upload.media.id}/transcribe`, {
    method: "POST",
    headers: authHeaders,
  });
  await mediaJobRunner.runOnce();

  const { job } = await requestJson(originalFetch, baseUrl, `/v1/media/jobs/${queued.job.id}`, {
    headers: authHeaders,
  });
  assert.equal(job.stage, "failed");
  assert.equal(job.failureKind, "terminal", "an unopenable container is not worth the retry budget.");
  assert.equal(job.attempts, 1, "and it is refused on the first attempt, not the third.");
  assert.match(job.lastError, /does not accept audio\/mpeg/u);
  assert.match(job.lastError, /Accepted: audio\/wav, audio\/webm, audio\/ogg, audio\/mp4/u);
  assert.equal(calls.length, 0, "nothing unsupported reaches the sidecar in the first place.");

  // The upload itself survives: the owner can still play it back, or transcribe it elsewhere.
  const audio = await originalFetch(new URL(`/v1/media/${upload.media.id}`, baseUrl), {
    headers: authHeaders,
  });
  assert.equal(audio.status, 200);
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), Buffer.from(MP3_BASE64, "base64"));

  const listed = await requestJson(originalFetch, baseUrl, "/v1/media", { headers: authHeaders });
  assert.equal(listed.media[0].transcript, null);
  assert.equal(listed.media[0].processing.transcriptionStatus, "failed");
});

test("a rate-limited provider is retried until the budget runs out, then fails terminally", async (t) => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return jsonResponse({ error: "rate limited" }, 429);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-stt-fail-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server, mediaJobRunner } = createApp({
    config: {
      ...MEDIA_CONFIG,
      mediaDir,
      transcriptionProvider: "openai",
      transcriptionApiKey: "sk-test",
      transcriptionTimeoutMs: 5000,
      transcriptionMaxAttempts: 2,
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const upload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "audio",
      contentType: "audio/webm",
      dataBase64: WEBM_BASE64,
    },
  });

  const response = await originalFetch(new URL(`/v1/media/${upload.media.id}/transcribe`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
  });
  // Enqueued, not run: the caller is no longer waiting on the provider.
  assert.equal(response.status, 202);
  const { job: queued } = await response.json();

  // 429 is retryable, so the first tick puts the job back in the queue rather than failing it.
  await mediaJobRunner.runOnce();
  const afterFirst = await requestJson(originalFetch, baseUrl, `/v1/media/jobs/${queued.id}`, {
    headers: authHeaders,
  });
  assert.equal(afterFirst.job.stage, "queued");
  assert.equal(afterFirst.job.attempts, 1);
  assert.equal(afterFirst.job.failureKind, "retryable");
  assert.match(afterFirst.job.lastError, /HTTP 429/u);
  assert.equal(afterFirst.job.leaseExpiresAt, null, "a failed attempt must release its lease.");

  await mediaJobRunner.runOnce();
  const afterSecond = await requestJson(originalFetch, baseUrl, `/v1/media/jobs/${queued.id}`, {
    headers: authHeaders,
  });
  assert.equal(afterSecond.job.stage, "failed");
  assert.equal(afterSecond.job.attempts, 2);
  assert.equal(providerCalls, 2);

  // A terminal job is never handed out again, however many ticks run.
  await mediaJobRunner.runOnce();
  assert.equal(providerCalls, 2);

  const listed = await requestJson(originalFetch, baseUrl, "/v1/media", { headers: authHeaders });
  const stored = listed.media.find((item) => item.id === upload.media.id);
  assert.equal(stored.processing.transcriptionStatus, "failed");
  assert.match(stored.processing.lastError, /HTTP 429/u);
});

test("a provider error that cannot succeed on retry fails on the first attempt", async (t) => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return jsonResponse({ error: "bad audio" }, 400);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-stt-terminal-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server, mediaJobRunner } = createApp({
    config: {
      ...MEDIA_CONFIG,
      mediaDir,
      transcriptionProvider: "openai",
      transcriptionApiKey: "sk-test",
      transcriptionTimeoutMs: 5000,
      transcriptionMaxAttempts: 5,
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const upload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "audio",
      contentType: "audio/webm",
      dataBase64: WEBM_BASE64,
    },
  });
  const queued = await requestJson(originalFetch, baseUrl, `/v1/media/${upload.media.id}/transcribe`, {
    method: "POST",
    headers: authHeaders,
  });

  await mediaJobRunner.runOnce();
  await mediaJobRunner.runOnce();

  const { job } = await requestJson(originalFetch, baseUrl, `/v1/media/jobs/${queued.job.id}`, {
    headers: authHeaders,
  });
  // A 400 will answer identically forever; spending the other four attempts on it is waste.
  assert.equal(job.stage, "failed");
  assert.equal(job.failureKind, "terminal");
  assert.equal(job.attempts, 1);
  assert.equal(providerCalls, 1);
});

test("transcription is refused up front when no provider is configured", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ error: "unexpected" }, 500);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-stt-off-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({
    config: { ...MEDIA_CONFIG, mediaDir, transcriptionProvider: "disabled" },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const upload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "audio",
      contentType: "audio/webm",
      dataBase64: WEBM_BASE64,
    },
  });

  // Queueing work guaranteed to fail identically on every attempt would swap a clear error for a
  // silent one, so this stays a synchronous refusal.
  const response = await originalFetch(new URL(`/v1/media/${upload.media.id}/transcribe`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
  });
  assert.equal(response.status, 409);

  const jobs = await requestJson(originalFetch, baseUrl, "/v1/media/jobs", { headers: authHeaders });
  assert.deepEqual(jobs.jobs, []);

  const listed = await requestJson(originalFetch, baseUrl, "/v1/media", { headers: authHeaders });
  const stored = listed.media.find((item) => item.id === upload.media.id);
  assert.equal(stored.processing.transcriptionStatus, "unavailable");
});

test("transcript versions are redacted from a support bundle, the stage machine is not", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ error: "unexpected" }, 500);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-stt-support-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server, mediaJobRunner } = createApp({
    config: { ...MEDIA_CONFIG, mediaDir, transcriptionProvider: "mock" },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const upload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "audio",
      contentType: "audio/webm",
      dataBase64: WEBM_BASE64,
      originalName: "standup.webm",
    },
  });
  const queued = await requestJson(originalFetch, baseUrl, `/v1/media/${upload.media.id}/transcribe`, {
    method: "POST",
    headers: authHeaders,
  });
  await mediaJobRunner.runOnce();

  const { job } = await requestJson(originalFetch, baseUrl, `/v1/media/jobs/${queued.job.id}`, {
    headers: authHeaders,
  });
  const diagnostics = await requestJson(originalFetch, baseUrl, "/v1/support/diagnostics", {
    headers: authHeaders,
  });
  const serialized = JSON.stringify(diagnostics);

  for (const version of [job.rawTranscript, job.normalizedTranscript]) {
    assert.ok(version);
    assert.ok(
      !serialized.includes(version),
      "every transcript version is user content and must not appear verbatim in a support bundle",
    );
  }
  // The part worth shipping to support is the machine around the text, not the text.
  assert.equal(diagnostics.counts.mediaJobs, 1);
  assert.equal(diagnostics.mediaJobs[0].stage, "dispatched");
  assert.equal(diagnostics.mediaJobs[0].attempts, 1);
  assert.equal(typeof diagnostics.mediaJobs[0].rawTranscript.sha256, "string");
});

test("a project launch carries media on its very first turn", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({
        projects: [{
          id: "project_launch",
          title: "Launch",
          defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
        }],
        threads: [],
      }, 200);
    }
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ accepted: true }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-launch-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({ config: { ...MEDIA_CONFIG, mediaDir } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });
  const upload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: PNG_BASE64,
      originalName: "snapshot.png",
    },
  });

  const launched = await requestJson(
    originalFetch,
    baseUrl,
    `/v1/t3/environments/${environment.environment.id}/threads`,
    {
      method: "POST",
      headers: authHeaders,
      body: {
        projectId: "project_launch",
        text: "Look at this screenshot before you start.",
        mediaUploadIds: [upload.media.id],
      },
    },
  );

  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[0].type, "thread.create");
  const startTurn = dispatches[1];
  assert.equal(startTurn.type, "thread.turn.start");
  assert.equal(startTurn.message.attachments.length, 1, "the first turn must carry the attachment");

  const [attachment] = startTurn.message.attachments;
  assert.equal(attachment.type, "image");
  assert.equal(attachment.mediaId, upload.media.id);
  assert.equal(attachment.name, "snapshot.png");
  assert.equal(attachment.dataBase64, PNG_BASE64);
  assert.ok(attachment.url, "attachment must carry a signed callback URL");

  const stored = launched.command.normalized.startTurn.message.attachments[0];
  assert.equal(stored.mediaId, upload.media.id);
  assert.equal(stored.dataBase64, undefined, "media bytes must not be persisted on the command");
  assert.equal(stored.url, undefined, "a live signed URL must not be persisted on the command");
  assert.equal(stored.inlined, true);
  assert.equal(stored.urlIssued, true);
  assert.deepEqual(launched.command.intent.mediaUploadIds, [upload.media.id]);

  const serialized = JSON.stringify(launched.command);
  assert.ok(!serialized.includes(PNG_BASE64), "command payload must not embed the image bytes");
});

test("a project launch refuses media owned by another user", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({
        projects: [{
          id: "project_launch",
          defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
        }],
        threads: [],
      }, 200);
    }
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ accepted: true }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-launch-owner-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({ config: { ...MEDIA_CONFIG, mediaDir } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const ownerHeaders = await createAuthHeaders(originalFetch, baseUrl, "user_dev");
  const intruderHeaders = await createAuthHeaders(originalFetch, baseUrl, "user_intruder");

  const upload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: ownerHeaders,
    body: { kind: "image", contentType: "image/png", dataBase64: PNG_BASE64 },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: intruderHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });

  const response = await originalFetch(
    new URL(`/v1/t3/environments/${environment.environment.id}/threads`, baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json", ...intruderHeaders },
      body: JSON.stringify({
        projectId: "project_launch",
        text: "Read the other tenant's screenshot.",
        mediaUploadIds: [upload.media.id],
      }),
    },
  );

  assert.equal(response.status, 404);
  assert.equal(dispatches.length, 0, "nothing may reach T3 when the media is not the caller's");
});

test("a turn is refused when it references unknown media or too many attachments", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ accepted: true }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-limits-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({ config: { ...MEDIA_CONFIG, mediaDir } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });

  const submit = (mediaUploadIds) => originalFetch(new URL("/v1/intents", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({
      environmentId: environment.environment.id,
      threadId: "thread_limits",
      mediaUploadIds,
      intent: { type: "agent_prompt", text: "Look at these." },
    }),
  });

  const unknown = await submit(["media_does_not_exist"]);
  assert.equal(unknown.status, 404);

  const uploads = [];
  for (let index = 0; index < 9; index += 1) {
    const upload = await requestJson(originalFetch, baseUrl, "/v1/media", {
      method: "POST",
      headers: authHeaders,
      body: { kind: "image", contentType: "image/png", dataBase64: PNG_BASE64 },
    });
    uploads.push(upload.media.id);
  }

  const tooMany = await submit(uploads);
  assert.equal(tooMany.status, 400);

  const withinLimit = await submit(uploads.slice(0, 8));
  assert.equal(withinLimit.status, 202);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].message.attachments.length, 8);
});

test("an intent attaches every listed upload, in the order the client listed them", async (t) => {
  const gateway = await startGateway(t);
  const first = await uploadImage(gateway, "first.png");
  const second = await uploadImage(gateway, "second.png");
  const third = await uploadImage(gateway, "third.png");

  const dispatched = await requestJson(gateway.fetch, gateway.baseUrl, "/v1/intents", {
    method: "POST",
    headers: gateway.authHeaders,
    body: {
      environmentId: gateway.environmentId,
      threadId: "thread_multi",
      intent: {
        type: "camera_prompt",
        prompt: "Compare these three shots.",
        mediaUploadIds: [third, first, second],
      },
    },
  });

  assert.equal(dispatched.command.status, "dispatched");
  assert.equal(gateway.dispatches.length, 1);

  const attachments = gateway.dispatches[0].message.attachments;
  assert.deepEqual(attachments.map((attachment) => attachment.mediaId), [third, first, second]);
  assert.deepEqual(attachments.map((attachment) => attachment.name), [
    "third.png",
    "first.png",
    "second.png",
  ]);
  assert.deepEqual(dispatched.command.intent.mediaUploadIds, [third, first, second]);

  // Every attachment is described to the agent, not only the first one.
  const text = gateway.dispatches[0].message.text;
  for (const mediaId of [first, second, third]) {
    assert.ok(text.includes(`id=${mediaId}`), `prompt must describe ${mediaId}`);
  }
});

test("an intent listing more uploads than the attachment limit is refused", async (t) => {
  const gateway = await startGateway(t);
  const mediaUploadIds = [];
  for (let index = 0; index < 9; index += 1) {
    mediaUploadIds.push(await uploadImage(gateway, `shot-${index}.png`));
  }

  const response = await gateway.fetch(new URL("/v1/intents", gateway.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...gateway.authHeaders },
    body: JSON.stringify({
      environmentId: gateway.environmentId,
      threadId: "thread_multi",
      intent: { type: "camera_prompt", prompt: "Too many.", mediaUploadIds },
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(gateway.dispatches.length, 0, "nothing may reach T3 over the attachment limit");
});

test("an intent is refused when any listed upload belongs to another user", async (t) => {
  const gateway = await startGateway(t);
  const own = await uploadImage(gateway, "mine.png");
  const strangerHeaders = await createAuthHeaders(gateway.fetch, gateway.baseUrl, "user_stranger");
  const foreign = await requestJson(gateway.fetch, gateway.baseUrl, "/v1/media", {
    method: "POST",
    headers: strangerHeaders,
    body: { kind: "image", contentType: "image/png", dataBase64: PNG_BASE64 },
  });

  const response = await gateway.fetch(new URL("/v1/intents", gateway.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...gateway.authHeaders },
    body: JSON.stringify({
      environmentId: gateway.environmentId,
      threadId: "thread_multi",
      intent: {
        type: "camera_prompt",
        prompt: "One of these is not mine.",
        mediaUploadIds: [own, foreign.media.id],
      },
    }),
  });

  assert.equal(response.status, 404);
  assert.equal(gateway.dispatches.length, 0, "a foreign id anywhere in the list fails the turn");
});

test("the scalar mediaUploadId stays an accepted alias for a one-item list", async (t) => {
  const gateway = await startGateway(t);
  const mediaId = await uploadImage(gateway, "legacy.png");

  const dispatched = await requestJson(gateway.fetch, gateway.baseUrl, "/v1/intents", {
    method: "POST",
    headers: gateway.authHeaders,
    body: {
      environmentId: gateway.environmentId,
      threadId: "thread_multi",
      // protocol-v1 firmware sends exactly this shape.
      intent: { type: "camera_prompt", mediaUploadId: mediaId },
    },
  });

  assert.deepEqual(dispatched.command.intent.mediaUploadIds, [mediaId]);
  const attachments = gateway.dispatches[0].message.attachments;
  assert.deepEqual(attachments.map((attachment) => attachment.mediaId), [mediaId]);
});

async function startGateway(t) {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-multi-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({ config: { ...MEDIA_CONFIG, mediaDir } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });

  return {
    fetch: originalFetch,
    baseUrl,
    authHeaders,
    dispatches,
    environmentId: environment.environment.id,
  };
}

async function uploadImage(gateway, originalName) {
  const upload = await requestJson(gateway.fetch, gateway.baseUrl, "/v1/media", {
    method: "POST",
    headers: gateway.authHeaders,
    body: { kind: "image", contentType: "image/png", dataBase64: PNG_BASE64, originalName },
  });
  return upload.media.id;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function requestJson(fetchImpl, baseUrl, path, input) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: input.method ?? "GET",
    headers: { "content-type": "application/json", ...(input.headers ?? {}) },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${path}: ${text}`);
  }
  return JSON.parse(text);
}

async function createAuthHeaders(fetchImpl, baseUrl, userId = "user_dev") {
  const auth = await requestJson(fetchImpl, baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId, email: `${userId}@example.local` },
  });
  return { authorization: `Bearer ${auth.apiToken.secret}` };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
