import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createConvexStoreAdapter } from "../src/convexStore.mjs";
import { createFileStore } from "../src/fileStore.mjs";

const AUDIO = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

test("companion handoff is scoped, short-lived, single-use, and records truthful media origin", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-companion-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));
  const { server } = createApp({ config: { demoMode: false, mediaDir, maxMediaBytes: 4096 } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const owner = await authHeaders(baseUrl, "user_owner");
  const stranger = await authHeaders(baseUrl, "user_stranger");
  const environment = await json(baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: owner,
    body: { label: "Private T3", baseUrl: "https://t3.example", accessToken: "local-only-token" },
    expectedStatus: 201,
  });

  const minted = await json(baseUrl, "/v1/companion-handoffs", {
    method: "POST",
    headers: owner,
    body: { environmentId: environment.environment.id, threadId: "thread_phone", action: "record_audio" },
    expectedStatus: 201,
  });
  assert.equal(minted.handoff.status, "waiting");
  assert.equal(Date.parse(minted.handoff.expiresAt) - Date.parse(minted.handoff.createdAt) <= 5 * 60 * 1000, true);
  assert.doesNotMatch(minted.launchUrl, /environment|thread_phone|record_audio/u);
  assert.equal(new URL(minted.launchUrl).search, "");
  const code = new URLSearchParams(new URL(minted.launchUrl).hash.split("?", 2)[1]).get("handoff");
  assert.match(code, /^[A-Za-z0-9_-]{32}$/u);
  assert.doesNotMatch(minted.qrSvg, /thread_phone|local-only-token/u);

  await json(baseUrl, "/v1/companion-handoffs/claim", {
    method: "POST", headers: stranger, body: { code }, expectedStatus: 404,
  });
  const claimed = await json(baseUrl, "/v1/companion-handoffs/claim", {
    method: "POST", headers: owner, body: { code },
  });
  assert.equal(claimed.handoff.status, "claimed");
  await json(baseUrl, "/v1/companion-handoffs/claim", {
    method: "POST", headers: owner, body: { code }, expectedStatus: 404,
  });

  const sha256 = createHash("sha256").update(AUDIO).digest("hex");
  const upload = await json(baseUrl, "/v1/media/uploads", {
    method: "POST",
    headers: owner,
    body: {
      clientRequestId: "web:companion-audio-0001",
      kind: "audio",
      contentType: "audio/webm",
      sizeBytes: AUDIO.length,
      sha256,
      companionHandoffId: claimed.handoff.id,
      captureSource: "upload",
    },
    expectedStatus: 201,
  });
  await json(baseUrl, "/v1/media/uploads", {
    method: "POST",
    headers: owner,
    body: {
      clientRequestId: "web:companion-audio-0002",
      kind: "audio",
      contentType: "audio/webm",
      sizeBytes: AUDIO.length,
      sha256,
      companionHandoffId: claimed.handoff.id,
    },
    expectedStatus: 409,
  });
  const written = await fetch(new URL(upload.session.upload.url, baseUrl), {
    method: "PUT",
    headers: { ...owner, "content-type": "audio/webm" },
    body: AUDIO,
  });
  assert.equal(written.status, 200);
  const finalized = await json(baseUrl, upload.session.finalizeUrl, { method: "POST", headers: owner, body: {} });
  assert.equal(finalized.media.origin.source, "companion_recording");
  assert.equal(finalized.media.origin.environmentId, environment.environment.id);
  assert.equal(finalized.media.origin.threadId, "thread_phone");
  assert.equal((await json(baseUrl, `/v1/companion-handoffs/${claimed.handoff.id}`, { headers: owner })).handoff.status, "completed");

  const createdDevice = await json(baseUrl, "/v1/devices", {
    method: "POST", headers: owner, body: { label: "No-camera controller", profile: "next-coder" }, expectedStatus: 201,
  });
  await json(baseUrl, `/v1/devices/${createdDevice.device.id}/config`, {
    method: "PUT",
    headers: owner,
    body: { environmentId: environment.environment.id, threadId: "thread_phone" },
  });
  const deviceHandoff = await json(baseUrl, "/v1/device/companion-handoffs", {
    method: "POST",
    headers: { "x-device-id": createdDevice.device.id, "x-device-secret": createdDevice.secret },
    body: { action: "capture_image" },
    expectedStatus: 201,
  });
  assert.equal(deviceHandoff.handoff.deviceId, createdDevice.device.id);
  assert.equal(deviceHandoff.handoff.environmentId, environment.environment.id);
  assert.equal(deviceHandoff.handoff.threadId, "thread_phone");
  assert.equal(deviceHandoff.qrPayload, deviceHandoff.launchUrl);
  assert.equal("qrSvg" in deviceHandoff, false);
  assert.ok(Buffer.byteLength(JSON.stringify(deviceHandoff)) < 1400, "device handoff stays compact");
});

test("FileStore persists only a handoff digest and Convex receives the same boundary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "next-coder-companion-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const code = "privateOneTimeCompanionCode123456";
  const store = await createFileStore(statePath);
  const created = await store.createCompanionHandoff({
    userId: "user_owner",
    environmentId: "env_1",
    threadId: "thread_1",
    action: "record_audio",
    code,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  await store.flush();
  const persisted = await readFile(statePath, "utf8");
  assert.doesNotMatch(persisted, new RegExp(code, "u"));
  assert.match(persisted, /"codeHash": "[a-f0-9]{64}"/u);
  assert.equal((await createFileStore(statePath)).getCompanionHandoffForUser("user_owner", created.handoff.id).status, "waiting");

  const calls = [];
  const convex = createConvexStoreAdapter({
    gatewaySecret: "gateway-secret",
    client: {
      query: async () => null,
      mutation: async (name, args) => { calls.push({ name, args }); return { handoff: { id: "handoff_1" } }; },
    },
  });
  await convex.createCompanionHandoff({
    userId: "user_owner",
    environmentId: "env_1",
    threadId: "thread_1",
    action: "record_audio",
    code,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  assert.equal(calls[0].name, "gatewayStore:createCompanionHandoff");
  assert.equal("code" in calls[0].args, false);
  assert.equal(calls[0].args.codeHash, createHash("sha256").update(code).digest("hex"));
});

async function authHeaders(baseUrl, userId) {
  const result = await json(baseUrl, "/v1/users/dev", {
    method: "POST",
    body: { userId, email: `${userId}@example.local` },
    expectedStatus: 201,
  });
  return { authorization: `Bearer ${result.apiToken.secret}` };
}

async function json(baseUrl, path, { method = "GET", headers = {}, body, expectedStatus = 200 } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, text);
  return text ? JSON.parse(text) : null;
}
