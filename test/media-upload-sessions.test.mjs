import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createFileStore } from "../src/fileStore.mjs";
import { createMediaRetentionRunner } from "../src/mediaRetention.mjs";
import {
  createMediaUploadIntent,
  finalizeMediaUpload,
  writeMediaUploadSession,
} from "../src/mediaStore.mjs";
import { createStore } from "../src/store.mjs";

const BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const SHA256 = createHash("sha256").update(BYTES).digest("hex");

test("raw owner uploads stay private until integrity-checked finalize and replay idempotently", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-raw-upload-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));
  const { server } = createApp({
    config: {
      demoMode: false,
      mediaDir,
      maxMediaBytes: 1024,
      mediaUploadSessionTtlMs: 60_000,
      defaultMediaRetentionDays: 30,
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const owner = await authHeaders(baseUrl, "user_owner");
  const stranger = await authHeaders(baseUrl, "user_stranger");

  const descriptor = {
    clientRequestId: "web:raw-upload-0001",
    kind: "image",
    contentType: "image/png",
    sizeBytes: BYTES.length,
    sha256: SHA256,
    originalName: "private name.png",
  };
  const created = await json(baseUrl, "/v1/media/uploads", {
    method: "POST",
    headers: owner,
    body: descriptor,
    expectedStatus: 201,
  });
  assert.equal(created.session.status, "pending");
  assert.equal(created.session.upload.method, "PUT");
  assert.equal(created.session.upload.sizeBytes, BYTES.length);
  assert.ok(Buffer.byteLength(JSON.stringify(created)) < 1024, "session projection stays sub-kilobyte");
  assert.equal("storagePath" in created.session, false);
  assert.equal("originalName" in created.session, false);
  assert.equal("clientRequestId" in created.session, false);

  const mediaBefore = await json(baseUrl, "/v1/media", { headers: owner });
  assert.deepEqual(mediaBefore.media, [], "a pending session is not an attachable media record");
  assert.equal((await fetch(new URL(created.session.statusUrl, baseUrl), { headers: stranger })).status, 404);

  const wrong = await fetch(new URL(created.session.upload.url, baseUrl), {
    method: "PUT",
    headers: { ...owner, "content-type": "image/png" },
    body: Buffer.alloc(BYTES.length, 0),
  });
  assert.equal(wrong.status, 422);

  const uploaded = await fetch(new URL(created.session.upload.url, baseUrl), {
    method: "PUT",
    headers: { ...owner, "content-type": "image/png" },
    body: BYTES,
  });
  assert.equal(uploaded.status, 200);
  assert.equal((await uploaded.json()).session.status, "uploaded");
  assert.deepEqual((await json(baseUrl, "/v1/media", { headers: owner })).media, []);

  const finalized = await json(baseUrl, created.session.finalizeUrl, {
    method: "POST",
    headers: owner,
    body: {},
  });
  assert.equal(finalized.session.status, "finalized");
  assert.equal(finalized.media.sizeBytes, BYTES.length);
  assert.equal(finalized.media.sha256, SHA256);
  assert.equal("storagePath" in finalized.media, false);
  assert.equal("uploadSessionId" in finalized.media, false);

  const replay = await json(baseUrl, created.session.finalizeUrl, {
    method: "POST",
    headers: owner,
    body: {},
  });
  assert.equal(replay.media.id, finalized.media.id);
  const intentReplay = await json(baseUrl, "/v1/media/uploads", {
    method: "POST",
    headers: owner,
    body: descriptor,
  });
  assert.equal(intentReplay.session.id, created.session.id);
  assert.equal(intentReplay.session.status, "finalized");

  const listed = await json(baseUrl, "/v1/media", { headers: owner });
  assert.deepEqual(listed.media.map((media) => media.id), [finalized.media.id]);
  const ownerKey = createHash("sha256").update("user_owner", "utf8").digest("hex").slice(0, 24);
  assert.deepEqual(await readFile(join(mediaDir, ownerKey, `${SHA256}-${created.session.id}.png`)), BYTES);
});

test("upload-session dedup state is capped per owner without evicting unfinished work", () => {
  const store = createStore();
  const common = {
    userId: "user_bounded",
    deviceId: null,
    kind: "image",
    contentType: "image/png",
    expectedSizeBytes: BYTES.length,
    expectedSha256: SHA256,
    storagePath: "/private/staging/object.png",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  for (let index = 0; index < 256; index += 1) {
    assert.equal(store.createMediaUploadSession({
      ...common,
      clientRequestId: `web:bounded-${String(index).padStart(4, "0")}`,
    }).created, true);
  }
  assert.equal(store.createMediaUploadSession({
    ...common,
    clientRequestId: "web:bounded-overflow",
  }).limitExceeded, true);
});

test("descriptor conflicts, content-type mismatches and explicit abort are bounded", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-upload-abort-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));
  const { server } = createApp({
    config: { demoMode: false, mediaDir, maxMediaBytes: 128, mediaUploadSessionTtlMs: 60_000 },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = await authHeaders(baseUrl, "user_abort");
  const body = {
    clientRequestId: "web:raw-upload-abort",
    kind: "image",
    contentType: "image/png",
    sizeBytes: BYTES.length,
    sha256: SHA256,
  };
  const created = await json(baseUrl, "/v1/media/uploads", {
    method: "POST", headers, body, expectedStatus: 201,
  });
  const conflict = await fetch(new URL("/v1/media/uploads", baseUrl), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ ...body, sha256: "0".repeat(64) }),
  });
  assert.equal(conflict.status, 409);
  const wrongType = await fetch(new URL(created.session.upload.url, baseUrl), {
    method: "PUT",
    headers: { ...headers, "content-type": "image/jpeg" },
    body: BYTES,
  });
  assert.equal(wrongType.status, 415);
  const aborted = await json(baseUrl, created.session.statusUrl, { method: "DELETE", headers, body: {} });
  assert.equal(aborted.session.status, "aborted");
  const uploadAfterAbort = await fetch(new URL(created.session.upload.url, baseUrl), {
    method: "PUT",
    headers: { ...headers, "content-type": "image/png" },
    body: BYTES,
  });
  assert.equal(uploadAfterAbort.status, 409);
});

test("device upload sessions enforce the device realm and finalize without WebSocket media", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-device-raw-upload-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));
  const { server } = createApp({
    config: { demoMode: false, mediaDir, maxMediaBytes: 1024, mediaUploadSessionTtlMs: 60_000 },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const owner = await authHeaders(baseUrl, "user_device_upload");
  const device = await json(baseUrl, "/v1/devices", {
    method: "POST",
    headers: owner,
    body: { label: "Raw upload controller", profile: "next-coder" },
    expectedStatus: 201,
  });
  const deviceHeaders = { "x-device-id": device.device.id, "x-device-secret": device.secret };
  const created = await json(baseUrl, "/v1/device/media/uploads", {
    method: "POST",
    headers: deviceHeaders,
    body: {
      clientRequestId: "device:image-upload-0001",
      kind: "image",
      contentType: "image/png",
      sizeBytes: BYTES.length,
      sha256: SHA256,
    },
    expectedStatus: 201,
  });
  assert.match(created.session.upload.url, /^\/v1\/device\/media\/uploads\//u);
  assert.equal((await fetch(new URL(created.session.upload.url, baseUrl), {
    method: "PUT",
    headers: { ...owner, "content-type": "image/png" },
    body: BYTES,
  })).status, 400, "a platform token is never accepted by a device upload route");
  assert.equal((await fetch(new URL(created.session.upload.url, baseUrl), {
    method: "PUT",
    headers: { ...deviceHeaders, "content-type": "image/png" },
    body: BYTES,
  })).status, 200);
  const finalized = await json(baseUrl, created.session.finalizeUrl, {
    method: "POST", headers: deviceHeaders, body: {},
  });
  assert.equal(finalized.session.status, "finalized");
  assert.equal(finalized.media.deviceId, device.device.id);
  assert.equal(finalized.job, null, "images do not invent a transcription job");
});

test("FileStore persists sessions and retention removes abandoned staged bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "next-coder-upload-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataFile = join(root, "store.json");
  const mediaDir = join(root, "media");
  const config = { mediaDir, maxMediaBytes: 1024, mediaUploadSessionTtlMs: 60_000 };
  const first = await createFileStore(dataFile);
  const actor = { type: "user", id: "user_file", userId: "user_file" };
  const created = await createMediaUploadIntent({
    store: first,
    config,
    actor,
    payload: {
      clientRequestId: "web:file-store-upload",
      kind: "image",
      contentType: "image/png",
      sizeBytes: BYTES.length,
      sha256: SHA256,
    },
  });
  await writeMediaUploadSession({ store: first, config, actor, sessionId: created.session.id, buffer: BYTES });
  const internal = await first.getMediaUploadSessionForActor({ userId: actor.userId, sessionId: created.session.id });
  await access(internal.storagePath);

  const restarted = await createFileStore(dataFile);
  assert.equal((await restarted.getMediaUploadSessionForActor({
    userId: actor.userId,
    sessionId: created.session.id,
  })).status, "uploaded");
  const result = await createMediaRetentionRunner({
    store: restarted,
    config,
    now: () => Date.now() + 120_000,
  }).runOnce({ userId: actor.userId });
  assert.equal(result.abandonedCount, 1);
  assert.equal((await restarted.getMediaUploadSessionForActor({
    userId: actor.userId,
    sessionId: created.session.id,
  })).status, "expired");
  await assert.rejects(access(internal.storagePath), { code: "ENOENT" });
});

test("the S3-compatible adapter keeps staging private and commits an independently deletable object", async (t) => {
  const originalFetch = globalThis.fetch;
  const objects = new Map();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const key = decodeURIComponent(url.pathname.replace(/^\/media\//u, ""));
    if (init.method === "PUT") {
      objects.set(key, Buffer.from(init.body));
      return new Response(null, { status: 200, headers: { etag: "mock-etag" } });
    }
    if (init.method === "GET" && objects.has(key)) {
      return new Response(objects.get(key), { status: 200, headers: { "content-type": "image/png" } });
    }
    if (init.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response("<Error><Code>NoSuchKey</Code></Error>", {
      status: 404,
      headers: { "content-type": "application/xml" },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const config = {
    mediaStorageProvider: "s3",
    s3Endpoint: "https://mock-media.invalid",
    s3Region: "auto",
    s3Bucket: "media",
    s3AccessKeyId: "test-key",
    s3SecretAccessKey: "test-secret",
    maxMediaBytes: 1024,
    mediaUploadSessionTtlMs: 60_000,
    defaultMediaRetentionDays: 30,
  };
  const store = createStore();
  const actor = { type: "user", id: "user_object", userId: "user_object" };
  const created = await createMediaUploadIntent({
    store,
    config,
    actor,
    payload: {
      clientRequestId: "web:object-store-upload",
      kind: "image",
      contentType: "image/png",
      sizeBytes: BYTES.length,
      sha256: SHA256,
    },
  });
  await writeMediaUploadSession({ store, config, actor, sessionId: created.session.id, buffer: BYTES });
  assert.equal([...objects.keys()].filter((key) => key.startsWith("staging/")).length, 1);
  assert.deepEqual(store.listMediaUploads(actor.userId), []);

  const finalized = await finalizeMediaUpload({ store, config, actor, sessionId: created.session.id });
  assert.equal(finalized.media.sha256, SHA256);
  assert.equal([...objects.keys()].some((key) => key.startsWith("staging/")), false);
  const [finalKey] = [...objects.keys()];
  assert.match(finalKey, new RegExp(`/${SHA256}-${created.session.id}\\.png$`, "u"));
  assert.deepEqual(objects.get(finalKey), BYTES);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function authHeaders(baseUrl, userId) {
  const result = await json(baseUrl, "/v1/users/dev", {
    method: "POST",
    body: { userId, email: `${userId}@example.local` },
    expectedStatus: 201,
  });
  return { authorization: `Bearer ${result.apiToken.secret}` };
}

async function json(baseUrl, path, { method = "GET", headers = {}, body, expectedStatus } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, expectedStatus ?? 200, text);
  return text ? JSON.parse(text) : null;
}
