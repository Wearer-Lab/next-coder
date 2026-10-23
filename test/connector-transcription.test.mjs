import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { createTranscriptionProvider, TranscriptionError } from "../src/transcription.mjs";
import { readStoredMedia } from "../src/mediaStore.mjs";

const audio = Buffer.from("RIFF-private-controller-audio-WAVE");

async function fixture(t, { provider = "mock", router = null, claim = true, leaseMs = 120000, claimTime } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "connector-asr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createMemoryStore();
  async function enroll(userId) {
    const environment = await store.upsertEnvironment({ userId, label: "Laptop", transportMode: "connector", scopes: ["orchestration:read", "orchestration:operate"] });
    const enrolled = await store.createConnector({ userId, environmentId: environment.id, scopes: ["connector:connect", "t3:proxy"], capabilities: ["media.transcribe"] });
    return { environment, connector: enrolled.connector, secret: enrolled.secret, authorization: `Connector ${enrolled.connector.id}.${enrolled.secret}` };
  }
  const owner = await enroll("owner_one"), secondEnvironment = await enroll("owner_one"), otherOwner = await enroll("owner_two");
  const storagePath = join(directory, "voice.wav"); await writeFile(storagePath, audio);
  const media = await store.createMediaUpload({ userId: "owner_one", kind: "audio", contentType: "audio/wav", sizeBytes: audio.length, sha256: createHash("sha256").update(audio).digest("hex"), storagePath });
  const job = await store.createMediaJob({ userId: "owner_one", mediaId: media.id, environmentId: owner.environment.id, threadId: "thread_voice", provider, reviewRequired: true });
  if (claim) await store.claimMediaJobs({ owner: "fixture-worker", limit: 1, leaseMs, ...(claimTime ? { now: claimTime } : {}) });
  const app = createApp({ store, config: { mediaDir: directory, transcriptionProvider: provider, transcriptionTimeoutMs: 90000, transcriptionLeaseMs: 120000, transcriptionBatchSize: 1 }, connectorRouter: router, logger: { warn() {}, error() {} } });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { app.server.closeAllConnections(); app.server.close(resolve); }));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const path = `/v1/connector/media/${media.id}?jobId=${job.id}`;
  const fetchMedia = (authorization = owner.authorization, suffix = path) => fetch(origin + suffix, { headers: { authorization } });
  return { ...app, origin, store, owner, secondEnvironment, otherOwner, media, job, storagePath, fetchMedia };
}

test("connector realm downloads only its owned environment's active leased audio with integrity headers", async (t) => {
  const f = await fixture(t);
  const response = await f.fetchMedia(); assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
  assert.equal(response.headers.get("x-media-sha256"), f.media.sha256);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal((await f.fetchMedia(f.secondEnvironment.authorization)).status, 404);
  assert.equal((await f.fetchMedia(f.otherOwner.authorization)).status, 404);
  assert.equal((await f.fetchMedia("Bearer wrong-realm")).status, 401);
  assert.equal((await f.fetchMedia(f.owner.authorization, `/v1/connector/media/${f.media.id}`)).status, 400);
  assert.equal((await f.fetchMedia(f.owner.authorization, `/v1/connector/media/other-media?jobId=${f.job.id}`)).status, 404);
  await f.store.updateMediaJob({ jobId: f.job.id, stage: "normalizing" });
  assert.equal((await f.fetchMedia()).status, 404);
});

test("connector audio route rejects expired leases, revoked or superseded connectors", async (t) => {
  const f = await fixture(t, { claimTime: new Date(Date.now() - 180000).toISOString(), leaseMs: 1000 });
  assert.equal((await f.fetchMedia()).status, 404);
  await f.store.claimMediaJobs({ owner: "new-worker", limit: 1, leaseMs: 120000 });
  const replacement = await f.store.createConnector({ userId: "owner_one", environmentId: f.owner.environment.id, scopes: ["t3:proxy"], capabilities: ["media.transcribe"] });
  assert.equal((await f.fetchMedia()).status, 401);
  const auth = `Connector ${replacement.connector.id}.${replacement.secret}`;
  assert.equal((await f.fetchMedia(auth)).status, 200);
  await f.store.revokeConnector({ userId: "owner_one", connectorId: replacement.connector.id });
  assert.equal((await f.fetchMedia(auth)).status, 401);
});

test("audio transfer rechecks revocation after storage access", async (t) => {
  const f = await fixture(t);
  const original = f.store.getConnectorForUser;
  let checks = 0;
  f.store.getConnectorForUser = async (...args) => {
    if (++checks === 2) await f.store.revokeConnector({ userId: "owner_one", connectorId: f.owner.connector.id });
    return original(...args);
  };
  const response = await f.fetchMedia(); assert.equal(response.status, 404);
  assert.equal((await response.text()).includes(audio.toString()), false);
});

test("audio transfer bounds actual filesystem bytes and rejects stored checksum corruption", async (t) => {
  const f = await fixture(t);
  await writeFile(f.storagePath, Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.equal((await f.fetchMedia()).status, 413);
  await assert.rejects(readStoredMedia({ ...f.media, storagePath: f.storagePath }, {}, { maxBytes: 8 }), (error) => error.status === 413);
  await writeFile(f.storagePath, Buffer.alloc(audio.length));
  assert.equal((await f.fetchMedia()).status, 502);
});

test("real media runner routes metadata through the selected laptop and receives audio over authenticated HTTP", async (t) => {
  const routed = [];
  let f;
  const router = { async request(environment, input, options) {
    routed.push({ environment, input, options });
    const response = await f.fetchMedia(); assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
    return { text: "Please inspect the project", model: "nvidia/parakeet-tdt-0.6b-v2", language: "en", durationMs: 12, timings: { inferenceMs: 10 } };
  } };
  f = await fixture(t, { provider: "connector", router, claim: false });
  await f.mediaJobRunner.runOnce();
  assert.equal(routed.length, 1);
  assert.equal(routed[0].environment.id, f.owner.environment.id);
  assert.equal(routed[0].environment.connectorId, f.owner.connector.id);
  assert.deepEqual(routed[0].input, { method: "media.transcribe", payload: { mediaId: f.media.id, jobId: f.job.id } });
  assert.equal(routed[0].options.timeoutMs, 90000);
  assert.equal(routed[0].options.idempotencyKey, `media-transcribe:${f.job.id}:1`);
  assert.equal(JSON.stringify(routed[0].input).includes(audio.toString()), false);
  const completed = await f.store.getMediaJobForUser("owner_one", f.job.id);
  assert.equal(completed.rawTranscript, "Please inspect the project");
  assert.equal(completed.provider, "connector"); assert.equal(completed.stage, "review_required");
  assert.equal((await f.fetchMedia()).status, 404);
});

test("connector transcription rejects cross-job input, unsafe provider output and private error details", async () => {
  const media = { id: "media", userId: "owner" }, job = { id: "job", mediaId: "media", userId: "owner", environmentId: "env" };
  const provider = createTranscriptionProvider({ transcriptionProvider: "connector" }, { transcribeWithConnector: async () => { throw Object.assign(new Error("PRIVATE_PATH_AND_TOKEN"), { code: "connector_offline", retryable: true }); } });
  await assert.rejects(provider.transcribe({ media, job }), (error) => error instanceof TranscriptionError && error.retryable && error.failureCause === "configuration" && !error.message.includes("PRIVATE_PATH"));
  await assert.rejects(provider.transcribe({ media, job: { ...job, mediaId: "other" } }), (error) => error.failureCause === "configuration" && !error.retryable);
  const empty = createTranscriptionProvider({ transcriptionProvider: "connector" }, { transcribeWithConnector: async () => ({ text: " " }) });
  await assert.rejects(empty.transcribe({ media, job }), (error) => error.failureCause === "input" && !error.retryable);
  const oversized = createTranscriptionProvider({ transcriptionProvider: "connector" }, { transcribeWithConnector: async () => ({ text: "x".repeat(12001) }) });
  await assert.rejects(oversized.transcribe({ media, job }), (error) => error.failureCause === "provider");
});


test("laptop ASR input and missing-runtime failures retain their declared retry semantics across the router", async () => {
  const media = { id: "media", userId: "owner" }, job = { id: "job", mediaId: "media", userId: "owner", environmentId: "env" };
  for (const [code, retryable, failureCause] of [["transcription_invalid_audio", false, "input"], ["transcription_empty", false, "input"], ["transcription_unconfigured", false, "configuration"], ["transcription_unavailable", true, "configuration"], ["transcription_timeout", true, "provider"]]) {
    const provider = createTranscriptionProvider({ transcriptionProvider: "connector" }, { transcribeWithConnector: async () => { throw Object.assign(new Error("PRIVATE_RUNTIME_DETAILS"), { code, status: 502, retryable: true }); } });
    await assert.rejects(provider.transcribe({ media, job }), (error) => error.retryable === retryable && error.failureCause === failureCause && !error.message.includes("PRIVATE_RUNTIME"));
  }
});

test("a laptop transcript is discarded if the connector is revoked while inference is running", async (t) => {
  let f;
  const router = { async request() {
    await f.store.revokeConnector({ userId: "owner_one", connectorId: f.owner.connector.id });
    return { text: "Late private words", model: "parakeet", language: "en" };
  } };
  f = await fixture(t, { provider: "connector", router, claim: false });
  await f.mediaJobRunner.runOnce();
  const job = await f.store.getMediaJobForUser("owner_one", f.job.id);
  assert.equal(job.stage, "failed"); assert.equal(job.failureCause, "configuration");
  assert.equal(job.rawTranscript, null); assert.equal(job.lastError.includes("Late private words"), false);
});

test("configuration retry fails closed when the connector router binding is absent", async (t) => {
  const f = await fixture(t, { provider: "connector", router: null, claim: false });
  await f.store.updateMediaJob({ jobId: f.job.id, stage: "failed", failureKind: "terminal", failureCause: "configuration" });
  const signedIn = await fetch(`${f.origin}/v1/users/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: "owner_one" }) });
  const { apiToken } = await signedIn.json();
  const response = await fetch(`${f.origin}/v1/media/jobs/retry-configuration`, {
    method: "POST", headers: { authorization: `Bearer ${apiToken.secret}`, "content-type": "application/json" }, body: JSON.stringify({ jobIds: [f.job.id] }),
  });
  assert.equal(response.status, 409);
  assert.equal((await f.store.getMediaJobForUser("owner_one", f.job.id)).stage, "failed");
  assert.equal(createTranscriptionProvider({ transcriptionProvider: "connector" }).available, false);
});

test("a connector replacement during inference cannot publish the previous connector's transcript", async (t) => {
  let f;
  f = await fixture(t, { provider: "connector", claim: false, router: { async request() {
    await f.store.createConnector({ userId: "owner_one", environmentId: f.owner.environment.id,
      scopes: ["t3:proxy"], capabilities: ["media.transcribe"] });
    return { text: "Late result from the superseded connector", language: "en" };
  } } });
  await f.mediaJobRunner.runOnce();
  const job = await f.store.getMediaJobForUser("owner_one", f.job.id);
  assert.equal(job.stage, "failed");
  assert.equal(job.rawTranscript, null);
  assert.equal(job.failureCause, "configuration");
});
