import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { createFileStore } from "../src/fileStore.mjs";
import { createReleaseRolloutRunner, targetSelected } from "../src/releaseRollouts.mjs";
import { createMemoryStore } from "../src/store.mjs";

test("firmware rollout reconciliation is compatible, idempotent, observable, and reversible", async () => {
  const store = createMemoryStore();
  const userId = "user_rollout";
  const created = store.createDevice({ userId, label: "Canary" });
  store.recordDeviceHeartbeat({ deviceId: created.device.id, status: {
    firmwareVersion: "0.1.0", hardwareModel: "ips28-esp32-s3r8", protocolVersion: 2,
    features: ["ota_confirm"],
  } });
  const release = store.createFirmwareRelease({
    version: "0.2.0", channel: "stable", hardwareModel: "ips28-esp32-s3r8",
    url: "https://updates.invalid/0.2.0.bin", sha256: "a".repeat(64), sizeBytes: 1024,
    mandatory: false,
  });
  store.createFirmwareRelease({
    version: "0.1.0", channel: "stable", hardwareModel: "ips28-esp32-s3r8",
    url: "https://updates.invalid/0.1.0.bin", sha256: "b".repeat(64), sizeBytes: 1024,
    mandatory: false,
  });
  const rollout = store.createReleaseRollout({
    userId, name: "Canary firmware", targetKind: "firmware", targetVersion: "0.2.0",
    rollbackVersion: "0.1.0", releaseId: release.id, channel: "stable",
    cohort: { type: "allowlist", targetIds: [created.device.id] },
    minimumProtocolVersion: 2, requiredCapabilities: ["ota_confirm"],
  });
  const started = store.transitionReleaseRollout({
    userId, rolloutId: rollout.id, action: "start", evidenceRef: "test:firmware-canary",
  }).rollout;
  const runner = createReleaseRolloutRunner({ store });
  assert.equal((await runner.reconcile(started)).assignments, 1);
  assert.equal(store.getDeviceFirmwarePolicy({ userId, deviceId: created.device.id }).desiredVersion, "0.2.0");
  assert.equal(store.listRolloutAssignments({ userId, rolloutId: rollout.id })[0].status, "queued");

  await runner.reconcile(started);
  assert.equal(store.listRolloutAssignments({ userId, rolloutId: rollout.id })[0].attempts, 1,
    "reconciliation must not count the same queued assignment twice");

  store.recordDeviceHeartbeat({ deviceId: created.device.id, status: {
    firmwareVersion: "0.2.0", hardwareModel: "ips28-esp32-s3r8", protocolVersion: 2,
    features: ["ota_confirm"],
  } });
  await runner.reconcile(started);
  assert.equal(store.listRolloutAssignments({ userId, rolloutId: rollout.id })[0].status, "succeeded");
  const completed = store.transitionReleaseRollout({
    userId, rolloutId: rollout.id, action: "complete", evidenceRef: "test:firmware-verified",
  }).rollout;
  assert.equal(completed.state, "completed");

  const rollingBack = store.transitionReleaseRollout({
    userId, rolloutId: rollout.id, action: "rollback", evidenceRef: "incident:regression-17",
  }).rollout;
  await runner.reconcile(rollingBack);
  assert.equal(store.getDeviceFirmwarePolicy({ userId, deviceId: created.device.id }).desiredVersion, "0.1.0");
  assert.equal(store.listRolloutAssignments({ userId, rolloutId: rollout.id })[0].status, "rollback_queued");
});

test("connector cohorts remain stable and report local update truth without remote execution", async () => {
  const store = createMemoryStore();
  const userId = "user_connector_rollout";
  const environment = store.upsertEnvironment({ userId, label: "Mac", transportMode: "connector",
    scopes: ["orchestration:read"], status: "paired" });
  const enrolled = store.createConnector({ userId, environmentId: environment.id,
    connectorVersion: "0.1.0", protocolVersion: 1, capabilities: ["snapshot"] });
  const rollout = store.createReleaseRollout({
    userId, name: "Connector canary", targetKind: "connector", targetVersion: "0.2.0",
    rollbackVersion: "0.1.0", channel: "stable", cohort: { type: "percentage", percentage: 100 },
    minimumProtocolVersion: 1, requiredCapabilities: ["snapshot"],
  });
  const started = store.transitionReleaseRollout({ userId, rolloutId: rollout.id,
    action: "start", evidenceRef: "test:connector-pack" }).rollout;
  const runner = createReleaseRolloutRunner({ store });
  await runner.reconcile(started);
  const assignment = store.listRolloutAssignments({ userId, rolloutId: rollout.id })[0];
  assert.equal(assignment.targetId, enrolled.connector.id);
  assert.equal(assignment.status, "awaiting_operator_update");
  assert.equal(assignment.reasonCode, "connector_update_requires_local_cli");
  assert.equal(store.getConnectorForUser(userId, enrolled.connector.id).connectorVersion, "0.1.0");
  assert.equal(targetSelected(started, enrolled.connector.id), true);
});

test("pause, resume, explicit expansion, compatibility blocks, and cancel are fail-closed", async () => {
  const store = createMemoryStore();
  const userId = "user_state_machine";
  const environment = store.upsertEnvironment({ userId, label: "Old Mac", transportMode: "connector",
    scopes: ["orchestration:read"], status: "paired" });
  const enrolled = store.createConnector({ userId, environmentId: environment.id,
    connectorVersion: "0.1.0", protocolVersion: 1, capabilities: [] });
  const rollout = store.createReleaseRollout({ userId, name: "Gated connector", targetKind: "connector",
    targetVersion: "0.2.0", channel: "stable", cohort: { type: "percentage", percentage: 10 },
    minimumProtocolVersion: 2, requiredCapabilities: ["snapshot"] });
  let transition = store.transitionReleaseRollout({ userId, rolloutId: rollout.id,
    action: "start", evidenceRef: "test:start" });
  assert.equal(transition.rollout.state, "running");
  transition = store.transitionReleaseRollout({ userId, rolloutId: rollout.id,
    action: "expand", percentage: 5, evidenceRef: "test:invalid-shrink" });
  assert.equal(transition.conflict, true);
  transition = store.transitionReleaseRollout({ userId, rolloutId: rollout.id,
    action: "expand", percentage: 100, evidenceRef: "test:reviewed" });
  assert.equal(transition.rollout.cohort.percentage, 100);
  const runner = createReleaseRolloutRunner({ store });
  await runner.reconcile(transition.rollout);
  const blocked = store.listRolloutAssignments({ userId, rolloutId: rollout.id })[0];
  assert.equal(blocked.targetId, enrolled.connector.id);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reasonCode, "protocol_version_too_old");

  const paused = store.transitionReleaseRollout({ userId, rolloutId: rollout.id,
    action: "pause", evidenceRef: "incident:pause" }).rollout;
  assert.equal(paused.state, "paused");
  assert.equal((await runner.runOnce()).processed, 0);
  const resumed = store.transitionReleaseRollout({ userId, rolloutId: rollout.id,
    action: "resume", evidenceRef: "test:resume" }).rollout;
  assert.equal(resumed.state, "running");
  const cancelled = store.transitionReleaseRollout({ userId, rolloutId: rollout.id,
    action: "cancel", evidenceRef: "incident:cancel" }).rollout;
  await runner.reverseAssignments(cancelled);
  assert.equal(store.listRolloutAssignments({ userId, rolloutId: rollout.id })[0].status, "cancelled");
  assert.equal(store.transitionReleaseRollout({ userId, rolloutId: rollout.id,
    action: "resume", evidenceRef: "test:invalid" }).conflict, true);
  const persisted = JSON.stringify(store.exportState());
  assert.equal(persisted.includes("snapshot payload"), false);
});

test("owner rollout API rejects cross-account allowlists and evidence-free promotion", async (t) => {
  const store = createMemoryStore();
  const release = store.createFirmwareRelease({ version: "0.2.0", channel: "stable",
    hardwareModel: "ips28-esp32-s3r8", url: "https://updates.invalid/image.bin",
    sha256: "c".repeat(64), sizeBytes: 1024, mandatory: false });
  const { server } = createApp({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const owner = await auth(baseUrl, "owner");
  const other = await auth(baseUrl, "other");
  const otherDevice = await json(baseUrl, "/v1/devices", { method: "POST", headers: other,
    body: { label: "Other device", profile: "next-coder" } });

  const crossAccount = await fetch(new URL("/v1/release-rollouts", baseUrl), { method: "POST",
    headers: { "content-type": "application/json", ...owner }, body: JSON.stringify({
      name: "Unsafe", targetKind: "firmware", targetVersion: "0.2.0", releaseId: release.id,
      channel: "stable", cohort: { type: "allowlist", targetIds: [otherDevice.device.id] },
      requiredCapabilities: [], minimumProtocolVersion: 1,
    }) });
  assert.equal(crossAccount.status, 404);

  const draft = await json(baseUrl, "/v1/release-rollouts", { method: "POST", headers: owner, body: {
    name: "Connector beta", targetKind: "connector", targetVersion: "0.2.0", channel: "beta",
    cohort: { type: "percentage", percentage: 10 }, requiredCapabilities: [], minimumProtocolVersion: 1,
  } });
  const missingEvidence = await fetch(new URL(`/v1/release-rollouts/${draft.rollout.id}/actions`, baseUrl), {
    method: "POST", headers: { "content-type": "application/json", ...owner }, body: JSON.stringify({ action: "start" }),
  });
  assert.equal(missingEvidence.status, 400);
  const started = await json(baseUrl, `/v1/release-rollouts/${draft.rollout.id}/actions`, { method: "POST", headers: owner,
    body: { action: "start", evidenceRef: "test:connector-beta" } });
  assert.equal(started.rollout.state, "running");
  const ownerList = await json(baseUrl, "/v1/release-rollouts", { headers: owner });
  const otherList = await json(baseUrl, "/v1/release-rollouts", { headers: other });
  assert.equal(ownerList.rollouts.length, 1);
  assert.equal(otherList.rollouts.length, 0);
});

test("file store acknowledges rollout mutations only after they survive restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "next-coder-rollout-"));
  const path = join(directory, "store.json");
  const first = await createFileStore(path);
  const rollout = await first.createReleaseRollout({
    userId: "user_file", name: "Persistent canary", targetKind: "connector", targetVersion: "0.2.0",
    rollbackVersion: "0.1.0", channel: "stable", cohort: { type: "percentage", percentage: 10 },
    minimumProtocolVersion: 1, requiredCapabilities: [],
  });
  await first.transitionReleaseRollout({ userId: "user_file", rolloutId: rollout.id,
    action: "start", evidenceRef: "test:persisted" });
  await first.upsertRolloutAssignment({ userId: "user_file", rolloutId: rollout.id,
    targetId: "ctr_1", patch: { status: "awaiting_operator_update", reasonCode: "connector_update_requires_local_cli" } });
  const second = await createFileStore(path);
  assert.equal(second.getReleaseRolloutForUser("user_file", rollout.id).state, "running");
  assert.equal(second.listRolloutAssignments({ userId: "user_file", rolloutId: rollout.id })[0].reasonCode,
    "connector_update_requires_local_cli");
});

test("an explicit rollback pin can offer an older signed image without reflashing the current image", async (t) => {
  const store = createMemoryStore();
  const created = store.createDevice({ userId: "user_downgrade", label: "Rollback target" });
  store.recordDeviceHeartbeat({ deviceId: created.device.id, status: {
    firmwareVersion: "0.2.0", hardwareModel: "ips28-esp32-s3r8", protocolVersion: 2,
    features: ["ota_confirm"],
  } });
  store.createFirmwareRelease({ version: "0.1.9", channel: "stable", hardwareModel: "ips28-esp32-s3r8",
    url: "https://updates.invalid/0.1.9.bin", sha256: "d".repeat(64), sizeBytes: 1024, mandatory: false });
  store.updateDeviceFirmwarePolicy({ userId: "user_downgrade", deviceId: created.device.id,
    policy: { desiredVersion: "0.1.9" } });
  const config = { ...loadConfig({}), otaSigningKey: "test-signing-key", demoMode: false,
    devTokenCreationEnabled: true };
  const { server } = createApp({ store, config });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = { "x-device-id": created.device.id, "x-device-secret": created.secret };
  const downgrade = await json(baseUrl, "/v1/device/firmware?version=0.2.0&hardware=ips28-esp32-s3r8", { headers });
  assert.equal(downgrade.updateAvailable, true);
  assert.equal(downgrade.installation, "automatic");
  assert.equal(downgrade.manifest.version, "0.1.9");
  const current = await json(baseUrl, "/v1/device/firmware?version=0.1.9&hardware=ips28-esp32-s3r8", { headers });
  assert.equal(current.updateAvailable, false);
  assert.equal(current.reason, "current");
});

async function auth(baseUrl, userId) {
  const result = await json(baseUrl, "/v1/users/dev", { method: "POST", body: { userId, email: `${userId}@example.local` } });
  return { authorization: `Bearer ${result.apiToken.secret}` };
}

async function json(baseUrl, path, input = {}) {
  const response = await fetch(new URL(path, baseUrl), { method: input.method,
    headers: { "content-type": "application/json", ...input.headers },
    body: input.body === undefined ? undefined : JSON.stringify(input.body) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} ${response.status}: ${JSON.stringify(body)}`);
  return body;
}
