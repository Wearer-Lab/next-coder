import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { buildFirmwareArtifactUrl } from "../src/firmwareLinks.mjs";

test("gateway profiles switch with exact revisions and retain the active URL on failure", async (t) => {
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const auth = await createAuthHeaders(baseUrl);
  const created = await requestJson(baseUrl, "/v1/devices", {
    method: "POST", headers: auth, body: { label: "Gateway controller", profile: "next-coder" },
  });
  const deviceAuth = { "x-device-id": created.device.id, "x-device-secret": created.secret };

  const invalid = await fetch(new URL("/v1/gateway-profiles", baseUrl), { method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ label: "Unsafe", mode: "lan", url: "http://public.example.com" }) });
  assert.equal(invalid.status, 400);

  const lan = (await requestJson(baseUrl, "/v1/gateway-profiles", { method: "POST", headers: auth,
    body: { label: "Home LAN", mode: "lan", url: "http://192.168.1.20:3996" } })).profile;
  const tailnet = (await requestJson(baseUrl, "/v1/gateway-profiles", { method: "POST", headers: auth,
    body: { label: "Private tailnet", mode: "tailnet", baseUrl: "https://gateway.example.ts.net" } })).profile;
  assert.equal(tailnet.url, "https://gateway.example.ts.net");
  assert.equal(tailnet.baseUrl, tailnet.url);

  const staged = await requestJson(baseUrl, `/v1/devices/${created.device.id}/gateway`, {
    method: "PUT", headers: auth, body: { profileId: tailnet.id },
  });
  assert.equal(staged.revision, 1);
  assert.equal(staged.state, "pending");
  assert.equal(staged.pendingProfileId, tailnet.id);

  const failed = await requestJson(baseUrl, "/v1/device/gateway/switch", {
    method: "POST", headers: deviceAuth,
    body: { revision: 1, profileId: tailnet.id, status: "failed", detail: "probe timeout" },
  });
  assert.equal(failed.state, "failed");
  assert.equal(failed.activeProfileId, null);
  assert.equal(failed.lastError, "probe timeout");

  const restaged = await requestJson(baseUrl, `/v1/devices/${created.device.id}/gateway`, {
    method: "PUT", headers: auth, body: { profileId: lan.id },
  });
  const applied = await requestJson(baseUrl, "/v1/device/gateway/switch", {
    method: "POST", headers: deviceAuth,
    body: { revision: restaged.revision, profileId: lan.id, status: "applied", activeUrl: lan.url },
  });
  assert.equal(applied.state, "stable");
  assert.equal(applied.activeProfileId, lan.id);

  // A hardware-menu selection may promote another assigned profile directly at the exact current
  // revision; this is intentionally independent from dashboard staging.
  const hardwareApplied = await requestJson(baseUrl, "/v1/device/gateway/switch", {
    method: "POST", headers: deviceAuth,
    body: { revision: applied.revision, profileId: tailnet.id, status: "applied", activeUrl: tailnet.url },
  });
  assert.equal(hardwareApplied.activeProfileId, tailnet.id);
  assert.equal(hardwareApplied.revision, applied.revision + 1);

  const config = await requestJson(baseUrl, "/v1/device/config", { method: "GET", headers: deviceAuth });
  assert.equal(config.config.gatewayProfiles.length, 2);
  assert.equal(config.config.activeGatewayProfileId, tailnet.id);

  const unsafeEdit = await fetch(new URL(`/v1/gateway-profiles/${tailnet.id}`, baseUrl), {
    method: "PUT", headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ url: "https://replacement.example.ts.net" }),
  });
  assert.equal(unsafeEdit.status, 409);

  await requestJson(baseUrl, "/v1/device/heartbeat", { method: "POST", headers: deviceAuth,
    body: { status: { firmwareVersion: "0.2.0" }, gateway: { activeProfileId: tailnet.id,
      activeUrl: tailnet.url, state: "failed", detail: "candidate HTTP -1" } } });
  const inventory = await requestJson(baseUrl, "/v1/devices", { method: "GET", headers: auth });
  assert.equal(inventory.devices[0].status.gateway.activeProfileId, tailnet.id);
  assert.equal(inventory.devices[0].status.gateway.switchStatus, "failed");

  const blockedDelete = await fetch(new URL(`/v1/gateway-profiles/${tailnet.id}`, baseUrl), {
    method: "DELETE", headers: auth,
  });
  assert.equal(blockedDelete.status, 409);
});

test("factory upload stores an immutable managed artifact and devices download through authenticated gateway", async (t) => {
  const firmwareDir = await mkdtemp(join(tmpdir(), "next-coder-firmware-"));
  t.after(() => rm(firmwareDir, { recursive: true, force: true }));
  const config = { ...loadConfig({}), factoryToken: "factory-secret", otaSigningKey: "test-signing-key",
    firmwareDir, firmwareStorageProvider: "disk", maxFirmwareBytes: 1024 * 1024,
    firmwareDownloadTtlSeconds: 60, demoMode: false, devTokenCreationEnabled: true };
  const { server } = createApp({ config });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const artifact = Buffer.from("signed-esp32-firmware-image");
  const uploadUrl = new URL("/v1/factory/firmware/releases/upload", baseUrl);
  uploadUrl.search = new URLSearchParams({ version: "0.2.0", channel: "stable",
    hardwareModel: "e213-esp32-s3r8", releaseNotes: "Managed upload", mandatory: "1" }).toString();
  const uploadResponse = await fetch(uploadUrl, { method: "POST", headers: {
    authorization: "Bearer factory-secret", "content-type": "application/octet-stream",
    "content-length": String(artifact.length),
  }, body: artifact });
  assert.equal(uploadResponse.status, 201);
  const upload = await uploadResponse.json();
  assert.equal(upload.managedArtifact, true);
  assert.equal(upload.release.sizeBytes, artifact.length);
  assert.equal(Object.hasOwn(upload.release, "artifactKey"), false);
  assert.match(upload.manifest.url, /^http:\/\/127\.0\.0\.1:\d+\/v1\/device\/firmware\/artifacts\/[a-f0-9]{64}$/u);

  const auth = await createAuthHeaders(baseUrl);
  const created = await requestJson(baseUrl, "/v1/devices", { method: "POST", headers: auth,
    body: { label: "OTA controller", profile: "next-coder" } });
  const download = await fetch(upload.manifest.url, { headers: {
    "x-device-id": created.device.id, "x-device-secret": created.secret,
  } });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), artifact);

  const update = await requestJson(baseUrl, "/v1/device/firmware?version=0.1.6&hardware=e213-esp32-s3r8", {
    method: "GET", headers: { "x-device-id": created.device.id, "x-device-secret": created.secret },
  });
  assert.equal(update.updateAvailable, true);
  assert.match(update.manifest.url, /[?&]expires=\d+/u);
  assert.match(update.manifest.url, /[?&]token=[A-Za-z0-9_-]{43}/u);
  const legacyDownload = await fetch(update.manifest.url);
  assert.equal(legacyDownload.status, 200);
  assert.deepEqual(Buffer.from(await legacyDownload.arrayBuffer()), artifact);

  const tampered = new URL(update.manifest.url);
  const originalToken = tampered.searchParams.get("token");
  tampered.searchParams.set("token", `${originalToken.slice(0, -1)}${originalToken.endsWith("A") ? "B" : "A"}`);
  assert.equal((await fetch(tampered)).status, 403);

  const secondArtifact = Buffer.from("another-valid-firmware-image");
  const secondUrl = new URL(uploadUrl);
  secondUrl.searchParams.set("version", "0.2.1");
  const secondResponse = await fetch(secondUrl, { method: "POST", headers: {
    authorization: "Bearer factory-secret", "content-type": "application/octet-stream",
    "content-length": String(secondArtifact.length),
  }, body: secondArtifact });
  const second = await secondResponse.json();
  assert.equal(secondResponse.status, 201);
  const wrongArtifact = new URL(update.manifest.url);
  wrongArtifact.pathname = new URL(second.manifest.url).pathname;
  assert.equal((await fetch(wrongArtifact)).status, 403);

  const expired = buildFirmwareArtifactUrl({ release: upload.release, baseUrl,
    signingKey: "test-signing-key", ttlSeconds: 60, now: Date.now() - 120_000 });
  assert.equal((await fetch(expired)).status, 403);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function requestJson(baseUrl, path, input) {
  const response = await fetch(new URL(path, baseUrl), { method: input.method,
    headers: { "content-type": "application/json", ...input.headers },
    body: input.body === undefined ? undefined : JSON.stringify(input.body) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function createAuthHeaders(baseUrl) {
  const created = await requestJson(baseUrl, "/v1/users/dev", { method: "POST", headers: {},
    body: { userId: "user_gateway", email: "gateway@example.local" } });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}
