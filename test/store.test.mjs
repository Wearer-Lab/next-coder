import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildUserDisplayState } from "../src/displayState.mjs";
import { createFileStore } from "../src/fileStore.mjs";
import { buildUserObservabilitySummary } from "../src/observability.mjs";
import {
  createMemoryStore,
  createStore,
  DEVICE_CREDENTIAL_ROTATION_TTL_MS,
} from "../src/store.mjs";

test("platform tokens authenticate users without exposing token hashes", () => {
  const store = createMemoryStore();
  const { token, secret } = store.createUserToken({ userId: "user_1", label: "test" });

  assert.equal(token.tokenHash, undefined);
  assert.equal(store.authenticateUserToken(secret).id, "user_1");
  assert.equal(store.authenticateUserToken("wrong"), null);
});

test("device credential rotation overlaps safely, rejects races, expires, restarts, and revokes", () => {
  let clock = Date.parse("2026-08-28T12:00:00.000Z");
  const store = createStore({}, { now: () => clock });
  const { device, secret: activeSecret } = store.createDevice({
    userId: "user_1",
    label: "Controller",
  });
  const candidate = "candidate_device_secret_0123456789abcdef";
  const conflictingCandidate = "conflicting_device_secret_0123456789abcd";

  const started = store.rotateDeviceSecret({ userId: "user_1", deviceId: device.id });
  assert.equal(started.rotation.state, "pending");
  assert.equal(started.rotation.pendingCredentialVersion, 2);
  assert.equal(started.secret, undefined);
  assert.equal(store.authenticateDevice(device.id, activeSecret).credentialState, "active");

  const staged = store.stageDeviceSecret({
    deviceId: device.id,
    secret: candidate,
    rotationId: started.rotation.id,
    credentialVersion: 2,
    authenticatedCredentialVersion: 1,
  });
  assert.equal(staged.reason, null);
  assert.equal(store.authenticateDevice(device.id, candidate).credentialState, "pending");

  const duplicate = store.stageDeviceSecret({
    deviceId: device.id,
    secret: candidate,
    rotationId: started.rotation.id,
    credentialVersion: 2,
    authenticatedCredentialVersion: 1,
  });
  assert.equal(duplicate.reason, null);
  const conflict = store.stageDeviceSecret({
    deviceId: device.id,
    secret: conflictingCandidate,
    rotationId: started.rotation.id,
    credentialVersion: 2,
    authenticatedCredentialVersion: 1,
  });
  assert.equal(conflict.reason, "candidate_conflict");

  clock += DEVICE_CREDENTIAL_ROTATION_TTL_MS + 1;
  assert.equal(store.authenticateDevice(device.id, candidate), null);
  assert.equal(store.authenticateDevice(device.id, activeSecret).credentialState, "active");
  const expiredAck = store.acknowledgeDeviceSecret({
    deviceId: device.id,
    rotationId: started.rotation.id,
    credentialVersion: 2,
    authenticatedCredentialVersion: 2,
  });
  assert.equal(expiredAck.reason, "expired");

  const restarted = store.rotateDeviceSecret({ userId: "user_1", deviceId: device.id, restart: true });
  assert.notEqual(restarted.rotation.id, started.rotation.id);
  assert.equal(store.authenticateDevice(device.id, candidate), null);
  const replacement = "replacement_device_secret_0123456789abcdef";
  assert.equal(store.stageDeviceSecret({
    deviceId: device.id,
    secret: replacement,
    rotationId: restarted.rotation.id,
    credentialVersion: 2,
    authenticatedCredentialVersion: 1,
  }).reason, null);
  const promoted = store.acknowledgeDeviceSecret({
    deviceId: device.id,
    rotationId: restarted.rotation.id,
    credentialVersion: 2,
    authenticatedCredentialVersion: 2,
  });
  assert.equal(promoted.replayed, false);
  assert.equal(store.authenticateDevice(device.id, activeSecret), null);
  assert.equal(store.authenticateDevice(device.id, replacement).credentialState, "active");
  assert.equal(store.acknowledgeDeviceSecret({
    deviceId: device.id,
    rotationId: restarted.rotation.id,
    credentialVersion: 2,
    authenticatedCredentialVersion: 2,
  }).replayed, true);

  store.rotateDeviceSecret({ userId: "user_1", deviceId: device.id, restart: true });
  store.revokeDevice({ userId: "user_1", deviceId: device.id });
  assert.equal(store.authenticateDevice(device.id, replacement), null);
  const exported = JSON.stringify(store.exportState());
  assert.equal(exported.includes(candidate), false);
  assert.equal(exported.includes(replacement), false);
});

test("pairing an existing T3 URL updates the original environment and hides legacy duplicates", () => {
  const store = createMemoryStore({
    environments: [
      {
        id: "env_original",
        userId: "user_1",
        label: "Original T3",
        baseUrl: "http://127.0.0.1:3773",
        accessToken: "old-token",
        scopes: ["orchestration:read"],
        status: "reachable",
        health: { lastReachableAt: "2026-08-08T12:00:00.000Z" },
        createdAt: "2026-07-24T12:00:00.000Z",
        updatedAt: "2026-07-24T12:00:00.000Z",
      },
      {
        id: "env_duplicate",
        userId: "user_1",
        label: "Duplicate T3",
        baseUrl: "http://127.0.0.1:3773",
        accessToken: "duplicate-token",
        scopes: ["orchestration:read"],
        status: "paired",
        createdAt: "2026-08-08T12:00:00.000Z",
        updatedAt: "2026-08-08T12:00:00.000Z",
      },
    ],
  });

  assert.deepEqual(store.listEnvironments("user_1").map((environment) => environment.id), ["env_original"]);

  const repaired = store.upsertEnvironment({
    userId: "user_1",
    label: "Macbook Air T3 Code",
    baseUrl: "http://127.0.0.1:3773/",
    accessToken: "fresh-token",
    scopes: ["orchestration:read", "orchestration:operate"],
    status: "paired",
  });

  assert.equal(repaired.id, "env_original");
  assert.equal(store.getEnvironmentForUser("user_1", "env_original").accessToken, "fresh-token");
  assert.equal(store.listEnvironments("user_1").length, 1);
});

test("device presence is computed from recent activity", async () => {
  const recent = new Date().toISOString();
  const store = createMemoryStore({
    devices: [
      {
        id: "dev_online",
        userId: "user_1",
        label: "Online controller",
        profile: "next-coder",
        claimedAt: recent,
        lastSeenAt: recent,
        status: { lastHeartbeatAt: recent, firmwareVersion: "0.1.7" },
        config: {},
        createdAt: recent,
      },
      {
        id: "dev_offline",
        userId: "user_1",
        label: "Offline controller",
        profile: "next-coder",
        claimedAt: "2000-01-01T00:00:00.000Z",
        lastSeenAt: "2000-01-01T00:00:00.000Z",
        status: { lastHeartbeatAt: "2000-01-01T00:00:00.000Z" },
        config: {},
        createdAt: "2000-01-01T00:00:00.000Z",
      },
    ],
  });

  const devices = store.listDevices("user_1");
  assert.equal(devices[0].presence.state, "online");
  assert.equal(devices[0].presence.online, true);
  assert.equal(devices[0].presence.staleAfterMs, 90_000);
  assert.equal(devices[1].presence.state, "offline");
  assert.equal(devices[1].presence.online, false);

  const display = await buildUserDisplayState(store, "user_1");
  assert.equal(display.counts.onlineDevices, 1);
  assert.equal(display.counts.offlineDevices, 1);
});

test("device inventory exposes the confirmed gateway profile selection", () => {
  const store = createMemoryStore({
    devices: [{
      id: "dev_gateway",
      userId: "user_1",
      label: "Desk controller",
      profile: "next-coder",
      claimedAt: "2026-08-08T12:00:00.000Z",
      config: { environmentId: "env_studio" },
      gatewaySelection: {
        revision: 4,
        state: "stable",
        activeProfileId: "gateway_tailnet",
        appliedAt: "2026-08-08T12:05:00.000Z",
      },
      createdAt: "2026-08-08T12:00:00.000Z",
    }],
  });

  const [device] = store.listDevices("user_1");
  assert.equal(device.gatewaySelection.activeProfileId, "gateway_tailnet");
  assert.equal(device.gatewaySelection.state, "stable");
  assert.equal(device.gatewaySelection.revision, 4);
});

test("observability summary rolls up reliability signals", async () => {
  const now = Date.parse("2026-06-16T14:00:00.000Z");
  const recent = "2026-06-16T13:59:30.000Z";
  const old = "2000-01-01T00:00:00.000Z";
  const store = createMemoryStore({
    devices: [
      {
        id: "dev_online",
        userId: "user_1",
        label: "Online controller",
        profile: "next-coder",
        claimedAt: recent,
        lastSeenAt: recent,
        status: { lastHeartbeatAt: recent, firmwareVersion: "0.2.0", batteryPercent: 18 },
        config: {},
        createdAt: recent,
      },
      {
        id: "dev_offline",
        userId: "user_1",
        label: "Offline controller",
        profile: "next-coder",
        claimedAt: old,
        lastSeenAt: old,
        status: { lastHeartbeatAt: old, firmwareVersion: "0.1.0", batteryPercent: 91 },
        config: {},
        createdAt: old,
      },
    ],
    environments: [
      {
        id: "env_reachable",
        userId: "user_1",
        label: "Reachable T3",
        baseUrl: "https://reachable.example",
        accessToken: "token",
        accessTokenExpiresAt: "2026-06-18T14:00:00.000Z",
        scopes: [],
        status: "reachable",
        health: { lastCheckedAt: "2026-06-16T13:58:00.000Z" },
        createdAt: recent,
        updatedAt: recent,
      },
      {
        id: "env_expired",
        userId: "user_1",
        label: "Expired T3",
        baseUrl: "https://expired.example",
        accessToken: "token",
        accessTokenExpiresAt: "2026-06-15T14:00:00.000Z",
        scopes: [],
        status: "token_expired",
        health: { lastCheckedAt: "2026-06-16T13:59:00.000Z" },
        createdAt: recent,
        updatedAt: recent,
      },
    ],
    mediaUploads: [
      {
        id: "media_failed",
        userId: "user_1",
        kind: "audio",
        contentType: "audio/webm",
        sizeBytes: 10,
        sha256: "a".repeat(64),
        storagePath: "/tmp/failed.webm",
        processing: { transcriptionStatus: "failed", lastError: "provider unavailable" },
        expiresAt: "2026-06-17T14:00:00.000Z",
        createdAt: recent,
      },
      {
        id: "media_image",
        userId: "user_1",
        kind: "image",
        contentType: "image/png",
        sizeBytes: 20,
        sha256: "b".repeat(64),
        storagePath: "/tmp/image.png",
        expiresAt: null,
        createdAt: recent,
      },
    ],
    commands: [
      {
        id: "cmd_dispatched",
        userId: "user_1",
        deviceId: "dev_online",
        environmentId: "env_reachable",
        threadId: "thread_1",
        intent: { type: "agent_prompt", text: "test" },
        normalized: null,
        status: "dispatched",
        risk: "low",
        result: {},
        metrics: { acknowledgementDurationMs: 100, dispatchDurationMs: 50 },
        createdAt: recent,
        updatedAt: recent,
      },
      {
        id: "cmd_failed",
        userId: "user_1",
        deviceId: "dev_online",
        environmentId: "env_reachable",
        threadId: "thread_1",
        intent: { type: "agent_prompt", text: "test" },
        normalized: null,
        status: "failed",
        risk: "low",
        result: {},
        metrics: { acknowledgementDurationMs: 300, dispatchDurationMs: 150 },
        createdAt: recent,
        updatedAt: recent,
      },
    ],
  });

  const summary = await buildUserObservabilitySummary(store, "user_1", now);
  assert.equal(summary.devices.total, 2);
  assert.equal(summary.devices.online, 1);
  assert.equal(summary.devices.offline, 1);
  assert.equal(summary.devices.lowBatteryDevices, 1);
  assert.equal(summary.devices.lowestBatteryPercent, 18);
  assert.deepEqual(summary.devices.firmwareVersions, { "0.2.0": 1, "0.1.0": 1 });
  assert.equal(summary.environments.reachable, 1);
  assert.equal(summary.environments.tokenExpired, 1);
  assert.equal(summary.environments.tokenExpiringSoon, 1);
  assert.equal(summary.commands.failed, 1);
  assert.equal(summary.commands.acknowledgement.medianMs, 100);
  assert.equal(summary.commands.acknowledgement.p95Ms, 300);
  assert.equal(summary.commands.dispatch.p95Ms, 150);
  assert.equal(summary.media.failedProcessing, 1);
  assert.equal(summary.media.expiringSoon, 1);
  assert.deepEqual(summary.media.byKind, { audio: 1, image: 1 });
});

test("file store persists users, tokens, devices, and audit logs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "next-coder-store-"));
  const dataFile = join(dir, "store.json");
  try {
    const first = await createFileStore(dataFile);
    const { secret: platformSecret } = first.createUserToken({ userId: "user_1", label: "test" });
    const { device, secret: deviceSecret } = first.createDevice({
      userId: "user_1",
      label: "Controller",
    });
    const environment = first.upsertEnvironment({
      userId: "user_1",
      label: "T3",
      baseUrl: "https://healthy-t3.example",
      accessToken: "mock-token",
      accessTokenExpiresAt: "2026-06-15T00:00:00.000Z",
      scopes: ["orchestration:read", "orchestration:operate"],
      status: "paired",
    });
    first.updateEnvironmentHealth({
      userId: "user_1",
      environmentId: environment.id,
      status: "reachable",
      health: {
        lastCheckedAt: "2026-06-14T23:20:00.000Z",
        lastReachableAt: "2026-06-14T23:20:00.000Z",
        lastError: null,
        snapshot: { line1: "2 projects", line2: "1 threads" },
      },
    });
    first.updateDeviceConfig({
      userId: "user_1",
      deviceId: device.id,
      config: {
        environmentId: "env_1",
        threadId: "thread_1",
        defaultPrompt: "Persisted prompt.",
        shellCommand: "npm test",
        menu: ["status", "prompt", "shell"],
      },
    });
    first.recordDeviceHeartbeat({
      deviceId: device.id,
      status: {
        firmwareVersion: "0.1.7",
        hardwareModel: "e213-esp32-s3r8",
        ipAddress: "192.168.4.20",
        wifiRssi: -61,
        freeHeap: 184320,
        uptimeMs: 120000,
      },
    });
    first.createFirmwareRelease({
      version: "0.2.0",
      hardwareModel: "e213-esp32-s3r8",
      url: "https://cdn.example.com/fw.bin",
      sha256: "b".repeat(64),
      sizeBytes: 1234,
      mandatory: false,
      releaseNotes: "Test release.",
    });
    const media = first.createMediaUpload({
      userId: "user_1",
      deviceId: device.id,
      kind: "audio",
      contentType: "audio/wav",
      sizeBytes: 4,
      sha256: "abcd",
      storagePath: "/tmp/audio.wav",
      transcript: "Persisted audio transcript.",
    });
    first.updateMediaTranscript({
      userId: "user_1",
      mediaId: media.id,
      transcript: "Updated persisted audio transcript.",
    });
    const macro = first.createMacro({
      userId: "user_1",
      label: "Run tests",
      environmentId: environment.id,
      threadId: "thread_1",
      intent: { type: "shell_input", command: "npm test" },
    });
    const command = first.createCommand({
      userId: "user_1",
      deviceId: device.id,
      environmentId: "env_1",
      threadId: "thread_1",
      intent: { type: "shell_input", command: "rm -rf build" },
      normalized: null,
      status: "approval_required",
      risk: "high",
      result: { reason: "Needs approval." },
      metrics: {
        acknowledgementDurationMs: 42,
        dispatchDurationMs: null,
        completedAt: null,
        failureAt: null,
      },
    });
    first.updateCommand({
      userId: "user_1",
      commandId: command.id,
      status: "rejected",
      result: { reason: "Rejected by user." },
      metrics: {
        acknowledgementDurationMs: 84,
        dispatchDurationMs: null,
        completedAt: null,
        failureAt: "2026-06-14T23:25:00.000Z",
      },
    });

    await first.flush();

    const persisted = JSON.parse(await readFile(dataFile, "utf8"));
    assert.equal(persisted.users.length, 1);
    assert.equal(persisted.apiTokens.length, 1);
    assert.equal(persisted.apiTokens[0].tokenHash.length, 64);
    assert.equal(persisted.devices[0].secretHash.length, 64);
    assert.equal(persisted.devices[0].config.environmentId, "env_1");
    assert.equal(persisted.devices[0].config.shellCommand, "npm test");
    assert.equal(persisted.devices[0].status.firmwareVersion, "0.1.7");
    assert.equal(persisted.devices[0].status.wifiRssi, -61);
    assert.equal(persisted.environments[0].status, "reachable");
    assert.equal(persisted.environments[0].accessTokenExpiresAt, "2026-06-15T00:00:00.000Z");
    assert.equal(persisted.environments[0].health.snapshot.line1, "2 projects");
    assert.equal(persisted.firmwareReleases[0].version, "0.2.0");
    assert.equal(persisted.mediaUploads.length, 1);
    assert.equal(persisted.mediaUploads[0].transcript, "Updated persisted audio transcript.");
    assert.equal(persisted.mediaUploads[0].processing.transcriptionStatus, "ready");
    assert.equal(persisted.mediaUploads[0].processing.transcriptSource, "manual");
    assert.equal(persisted.macros[0].label, "Run tests");
    assert.equal(persisted.commands[0].status, "rejected");
    assert.equal(persisted.commands[0].metrics.acknowledgementDurationMs, 84);
    assert.equal(persisted.commands[0].metrics.failureAt, "2026-06-14T23:25:00.000Z");
    assert.equal(persisted.commandEvents.length, 2);
    assert.deepEqual(persisted.commandEvents.map((event) => event.status), ["approval_required", "rejected"]);
    assert.equal(persisted.commandEvents[0].metrics.acknowledgementDurationMs, 42);
    assert.equal(persisted.commandEvents[1].metrics.acknowledgementDurationMs, 84);
    assert.notEqual(persisted.apiTokens[0].tokenHash, platformSecret);
    assert.notEqual(persisted.devices[0].secretHash, deviceSecret);

    const second = await createFileStore(dataFile);
    assert.equal(second.authenticateUserToken(platformSecret).id, "user_1");
    assert.equal(second.authenticateDevice(device.id, deviceSecret).id, device.id);
    assert.equal(second.getDeviceForUser("user_1", device.id).config.defaultPrompt, "Persisted prompt.");
    assert.equal(second.getDeviceForUser("user_1", device.id).config.shellCommand, "npm test");
    assert.equal(second.getDeviceForUser("user_1", device.id).status.ipAddress, "192.168.4.20");
    assert.equal(second.listEnvironments("user_1")[0].health.lastReachableAt, "2026-06-14T23:20:00.000Z");
    assert.equal(second.listEnvironments("user_1")[0].accessTokenExpiresAt, "2026-06-15T00:00:00.000Z");
    assert.equal(second.getLatestFirmwareRelease({ hardwareModel: "e213-esp32-s3r8" }).version, "0.2.0");
    assert.equal(second.getMediaForUser("user_1", media.id).id, media.id);
    assert.equal(second.getMediaForUser("user_1", media.id).transcript, "Updated persisted audio transcript.");
    assert.equal(second.getMediaForUser("user_1", media.id).processing.transcriptionStatus, "ready");
    assert.equal(second.getMacroForUser("user_1", macro.id).intent.command, "npm test");
    assert.equal(second.getCommandForUser("user_1", command.id).status, "rejected");
    assert.equal(second.getCommandForUser("user_1", command.id).metrics.failureAt, "2026-06-14T23:25:00.000Z");
    assert.deepEqual(
      second.listCommandEvents({ userId: "user_1", commandId: command.id }).map((event) => event.status),
      ["approval_required", "rejected"],
    );
    assert.equal(
      second.listCommandEvents({ userId: "user_1", commandId: command.id })[1].metrics.failureAt,
      "2026-06-14T23:25:00.000Z",
    );
    assert.ok(second.listAuditLogs("user_1").length >= 2);
    await second.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file store durably preserves pending device credentials and their promotion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "next-coder-device-rotation-"));
  const dataFile = join(dir, "store.json");
  try {
    const first = await createFileStore(dataFile);
    const { device, secret: activeSecret } = first.createDevice({
      userId: "user_1",
      label: "Durable controller",
    });
    const rotation = await first.rotateDeviceSecret({ userId: "user_1", deviceId: device.id });
    const candidate = "durable_device_secret_0123456789abcdef";
    await first.stageDeviceSecret({
      deviceId: device.id,
      secret: candidate,
      rotationId: rotation.rotation.id,
      credentialVersion: rotation.rotation.pendingCredentialVersion,
      authenticatedCredentialVersion: 1,
    });
    await first.flush();

    const stagedState = JSON.parse(await readFile(dataFile, "utf8"));
    assert.equal(stagedState.devices[0].pendingSecretHash.length, 64);
    assert.equal(JSON.stringify(stagedState).includes(candidate), false);

    const second = await createFileStore(dataFile);
    assert.equal(second.authenticateDevice(device.id, activeSecret).credentialState, "active");
    assert.equal(second.authenticateDevice(device.id, candidate).credentialState, "pending");
    await second.acknowledgeDeviceSecret({
      deviceId: device.id,
      rotationId: rotation.rotation.id,
      credentialVersion: rotation.rotation.pendingCredentialVersion,
      authenticatedCredentialVersion: rotation.rotation.pendingCredentialVersion,
    });
    await second.flush();

    const third = await createFileStore(dataFile);
    assert.equal(third.authenticateDevice(device.id, activeSecret), null);
    assert.equal(third.authenticateDevice(device.id, candidate).credentialState, "active");
    assert.equal(third.getDeviceForUser("user_1", device.id).credentialVersion, 2);
    assert.equal(third.getDeviceForUser("user_1", device.id).credentialRotation.state, "completed");
    await third.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file store encrypts T3 access tokens when a token key is configured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "next-coder-encrypted-store-"));
  const dataFile = join(dir, "store.json");
  try {
    const first = await createFileStore(dataFile, {
      t3TokenEncryptionKey: "test-token-encryption-key",
    });
    const environment = first.upsertEnvironment({
      userId: "user_1",
      label: "Encrypted T3",
      baseUrl: "https://encrypted-t3.example",
      accessToken: "raw-t3-access-token",
      scopes: ["orchestration:read", "orchestration:operate"],
      status: "paired",
    });
    assert.equal(environment.accessToken, undefined);
    await first.flush();

    const persisted = JSON.parse(await readFile(dataFile, "utf8"));
    assert.equal(persisted.environments[0].accessToken, undefined);
    assert.match(persisted.environments[0].accessTokenCiphertext, /^v1:/u);
    assert.notEqual(persisted.environments[0].accessTokenCiphertext, "raw-t3-access-token");

    const second = await createFileStore(dataFile, {
      t3TokenEncryptionKey: "test-token-encryption-key",
    });
    const internalEnvironment = second.getEnvironmentForUser("user_1", environment.id);
    assert.equal(internalEnvironment.accessToken, "raw-t3-access-token");
    assert.equal(second.listEnvironments("user_1")[0].accessToken, undefined);
    assert.equal(second.listEnvironments("user_1")[0].accessTokenCiphertext, undefined);
    await second.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting an environment repairs every record that pointed at it", () => {
  const store = createMemoryStore();
  store.ensureUser({ userId: "user_1", email: "owner@example.local" });
  const environment = store.upsertEnvironment({
    userId: "user_1",
    label: "Doomed T3",
    baseUrl: "https://doomed.example",
    accessToken: "doomed-token",
    scopes: ["orchestration:read"],
    status: "paired",
  });
  const other = store.upsertEnvironment({
    userId: "user_1",
    label: "Kept T3",
    baseUrl: "https://kept.example",
    accessToken: "kept-token",
    scopes: ["orchestration:read"],
    status: "paired",
  });
  const { device } = store.createDevice({ userId: "user_1", label: "Desk", profile: "next-coder" });
  store.updateDeviceConfig({
    userId: "user_1",
    deviceId: device.id,
    config: { environmentId: environment.id, projectId: "project_1", threadId: "thread_1" },
  });
  const doomedAction = store.createAction({
    userId: "user_1",
    type: "prompt",
    label: "Fixed prompt",
    payload: { text: "Continue." },
    targetMode: "fixed",
    environmentId: environment.id,
    threadId: "thread_1",
  });
  const keptAction = store.createAction({
    userId: "user_1",
    type: "prompt",
    label: "Other prompt",
    payload: { text: "Continue." },
    targetMode: "fixed",
    environmentId: other.id,
    threadId: "thread_2",
  });
  const doomedMacro = store.createMacro({
    userId: "user_1",
    label: "Doomed macro",
    environmentId: environment.id,
    threadId: "thread_1",
    intent: { type: "agent_prompt", text: "Sweep." },
  });
  store.updateUserOnboarding({
    userId: "user_1",
    onboarding: { status: "in_progress", environmentId: environment.id, firstThreadId: "thread_1" },
  });

  const result = store.deleteEnvironment({ userId: "user_1", environmentId: environment.id });

  assert.equal(result.environment.id, environment.id);
  assert.deepEqual(result.removed, {
    devices: [device.id],
    actions: [doomedAction.id],
    macros: [doomedMacro.id],
    onboarding: true,
  });
  assert.equal(store.getDeviceForUser("user_1", device.id).config.environmentId, null);
  assert.equal(store.getDeviceForUser("user_1", device.id).config.projectId, null);
  assert.equal(store.getDeviceForUser("user_1", device.id).config.threadId, null);

  const repaired = store.getActionForUser("user_1", doomedAction.id);
  assert.equal(repaired.disabled, true);
  assert.equal(repaired.disabledReason, "environment_removed");
  assert.equal(repaired.environmentId, null);
  assert.equal(repaired.threadId, null);
  assert.equal(repaired.targetMode, "device-current");

  const untouched = store.getActionForUser("user_1", keptAction.id);
  assert.equal(untouched.disabled, false);
  assert.equal(untouched.environmentId, other.id);

  assert.equal(store.listMacros("user_1")[0].disabled, true);
  assert.equal(store.getUserOnboarding("user_1").environmentId, null);
  assert.equal(store.getUserOnboarding("user_1").firstThreadId, null);

  // Removal is idempotent: the second call has nothing left to repair.
  assert.equal(store.deleteEnvironment({ userId: "user_1", environmentId: environment.id }), null);
});

test("archiving an environment destroys its credential, disconnects dependencies, and retains an archive row", () => {
  const store = createMemoryStore();
  store.ensureUser({ userId: "user_1", email: "owner@example.local" });
  const environment = store.upsertEnvironment({
    userId: "user_1",
    label: "Archived T3",
    baseUrl: "https://archive.example",
    accessToken: "secret-token",
    scopes: ["orchestration:read"],
    status: "reachable",
  });
  const enrolled = store.createConnector({ userId: "user_1", environmentId: environment.id, scopes: ["connector:connect"] });
  const { device } = store.createDevice({ userId: "user_1", label: "Desk", profile: "next-coder" });
  store.updateDeviceConfig({
    userId: "user_1",
    deviceId: device.id,
    config: { environmentId: environment.id, projectId: "project_1", threadId: "thread_1" },
  });

  const result = store.archiveEnvironment({ userId: "user_1", environmentId: environment.id });

  assert.equal(result.alreadyArchived, false);
  assert.deepEqual(result.removed.devices, [device.id]);
  assert.equal(store.getDeviceForUser("user_1", device.id).config.environmentId, null);
  assert.equal(store.getDeviceForUser("user_1", device.id).config.projectId, null);
  assert.equal(store.getDeviceForUser("user_1", device.id).config.threadId, null);
  const archived = store.listArchivedEnvironments("user_1")[0];
  assert.equal(archived.status, "archived");
  assert.match(archived.archivedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(archived.accessToken, undefined);
  assert.equal(store.getEnvironmentForUser("user_1", environment.id), null);
  assert.equal(store.listEnvironments("user_1").length, 0);
  assert.equal(store.getDisplaySummary("user_1").counts.environments, 0);
  assert.equal(store.getConnectorForUser("user_1", enrolled.connector.id).status, "revoked");

  const repeated = store.archiveEnvironment({ userId: "user_1", environmentId: environment.id });
  assert.equal(repeated.alreadyArchived, true);
  assert.deepEqual(repeated.removed, { devices: [], actions: [], macros: [], onboarding: false });

  const deleted = store.deleteEnvironment({ userId: "user_1", environmentId: environment.id });
  assert.equal(deleted.environment.id, environment.id);
  assert.equal(store.listArchivedEnvironments("user_1").length, 0);
});

// getDisplaySummary() exists so the five-second display poll stops fetching whole collections.
// These tests pin it to the list methods it replaced: if the two ever disagree, the console and
// the controller are showing different numbers for the same account.

/** A populated two-user account. `now` keeps the online/offline split deterministic. */
function displayFixtureStore(now = Date.now()) {
  const fresh = new Date(now - 1_000).toISOString();
  const stale = new Date(now - 10 * 60_000).toISOString();
  return createMemoryStore({
    devices: [
      {
        id: "dev_online",
        userId: "user_1",
        label: "Desk controller",
        profile: "next-coder",
        claimedAt: stale,
        lastSeenAt: fresh,
        status: { lastHeartbeatAt: fresh },
        config: {},
        createdAt: stale,
      },
      {
        id: "dev_offline",
        userId: "user_1",
        label: "Shelf controller",
        profile: "read-only",
        claimedAt: stale,
        lastSeenAt: stale,
        status: { lastHeartbeatAt: stale },
        config: {},
        createdAt: stale,
      },
      {
        id: "dev_other_user",
        userId: "user_2",
        label: "Someone else's controller",
        profile: "next-coder",
        claimedAt: stale,
        lastSeenAt: fresh,
        status: { lastHeartbeatAt: fresh },
        config: {},
        createdAt: stale,
      },
    ],
    environments: [
      {
        id: "env_a",
        userId: "user_1",
        label: "Studio",
        baseUrl: "http://127.0.0.1:3773",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      // Same baseUrl: listEnvironments() collapses these into one, so the count has to as well.
      {
        id: "env_a_duplicate",
        userId: "user_1",
        label: "Studio (legacy)",
        baseUrl: "http://127.0.0.1:3773",
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
      },
      {
        id: "env_b",
        userId: "user_1",
        label: "Laptop",
        baseUrl: "http://127.0.0.1:3774",
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
      {
        id: "env_other_user",
        userId: "user_2",
        label: "Not mine",
        baseUrl: "http://127.0.0.1:3775",
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
    ],
    mediaUploads: [
      { id: "media_1", userId: "user_1", kind: "audio", createdAt: "2026-08-04T00:00:00.000Z" },
      { id: "media_2", userId: "user_1", kind: "image", createdAt: "2026-08-05T00:00:00.000Z" },
      { id: "media_other", userId: "user_2", kind: "audio", createdAt: "2026-08-05T00:00:00.000Z" },
    ],
    macros: [
      { id: "macro_1", userId: "user_1", label: "Ship it", steps: [], createdAt: "2026-08-04T00:00:00.000Z" },
      { id: "macro_other", userId: "user_2", label: "Not mine", steps: [], createdAt: "2026-08-04T00:00:00.000Z" },
    ],
    commands: [
      {
        id: "cmd_old",
        userId: "user_1",
        environmentId: "env_a",
        intent: { type: "agent_prompt" },
        status: "completed",
        risk: "low",
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:00:00.000Z",
      },
      {
        id: "cmd_other_user",
        userId: "user_2",
        environmentId: "env_other_user",
        intent: { type: "shell_input" },
        status: "failed",
        risk: "high",
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z",
      },
      {
        id: "cmd_newest",
        userId: "user_1",
        environmentId: "env_b",
        intent: { type: "session_control" },
        status: "dispatched",
        risk: "low",
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
      },
    ],
    auditLogs: [
      { id: "audit_old", userId: "user_1", actorType: "user", action: "device.claimed", metadata: {}, createdAt: "2026-08-06T00:00:00.000Z" },
      { id: "audit_other", userId: "user_2", actorType: "user", action: "environment.paired", metadata: {}, createdAt: "2026-08-07T00:00:00.000Z" },
      { id: "audit_newest", userId: "user_1", actorType: "device", action: "command.dispatched", metadata: {}, createdAt: "2026-08-08T00:00:00.000Z" },
    ],
  });
}

test("getDisplaySummary counts match what the list methods would have returned", () => {
  const store = displayFixtureStore();

  // The comparison is the point: these are the exact expressions buildUserDisplayState() used to
  // evaluate, so a divergence here is a number the device would now render wrongly.
  const devices = store.listDevices("user_1");
  const expected = {
    environments: store.listEnvironments("user_1").length,
    devices: devices.length,
    media: store.listMediaUploads("user_1").length,
    macros: store.listMacros("user_1").length,
    commands: store.listCommands("user_1").length,
    audit: store.listAuditLogs("user_1").length,
    onlineDevices: devices.filter((device) => device.presence?.online).length,
    offlineDevices: devices.length - devices.filter((device) => device.presence?.online).length,
  };

  const summary = store.getDisplaySummary("user_1");
  assert.deepEqual(summary.counts, expected);
  // Pinned literally as well, so a bug that breaks both the list methods and the counts in the
  // same direction still fails.
  assert.deepEqual(summary.counts, {
    environments: 2,
    devices: 2,
    media: 2,
    macros: 1,
    commands: 2,
    audit: 2,
    onlineDevices: 1,
    offlineDevices: 1,
  });
});

test("getDisplaySummary reports zero for an account that has nothing", () => {
  const store = createMemoryStore();

  const summary = store.getDisplaySummary("user_nobody");
  assert.deepEqual(summary.counts, {
    environments: 0,
    devices: 0,
    media: 0,
    macros: 0,
    commands: 0,
    audit: 0,
    onlineDevices: 0,
    offlineDevices: 0,
  });
  assert.equal(summary.latestCommand, null);
  assert.equal(summary.latestAudit, null);
});

test("getDisplaySummary returns the newest command and audit entry, not the first", () => {
  const store = displayFixtureStore();

  const commands = store.listCommands("user_1");
  const audit = store.listAuditLogs("user_1");
  assert.equal(summaryLatestId(store, "latestCommand"), commands.at(-1).id);
  assert.equal(summaryLatestId(store, "latestAudit"), audit.at(-1).id);

  const summary = store.getDisplaySummary("user_1");
  assert.deepEqual(summary.latestCommand, {
    id: "cmd_newest",
    status: "dispatched",
    intentType: "session_control",
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  assert.deepEqual(summary.latestAudit, {
    id: "audit_newest",
    action: "command.dispatched",
    createdAt: "2026-08-08T00:00:00.000Z",
  });

  // A command written after the summary was taken becomes the new latest.
  const later = store.createCommand({
    userId: "user_1",
    environmentId: "env_b",
    intent: { type: "status" },
    normalized: { type: "status" },
    status: "queued",
    risk: "low",
  });
  assert.equal(store.getDisplaySummary("user_1").latestCommand.id, later.id);
  assert.equal(store.getDisplaySummary("user_1").counts.commands, 3);
});

function summaryLatestId(store, key) {
  return store.getDisplaySummary("user_1")[key].id;
}

test("getDisplaySummary never leaks one account's rows into another's counts", () => {
  const store = displayFixtureStore();

  const second = store.getDisplaySummary("user_2");
  assert.deepEqual(second.counts, {
    environments: 1,
    devices: 1,
    media: 1,
    macros: 1,
    commands: 1,
    audit: 1,
    onlineDevices: 1,
    offlineDevices: 0,
  });
  assert.equal(second.latestCommand.id, "cmd_other_user");
  assert.equal(second.latestAudit.id, "audit_other");

  // And an id that owns nothing sees nothing, even though the store is full.
  assert.equal(store.getDisplaySummary("user_3").counts.commands, 0);
  assert.equal(store.getDisplaySummary("user_3").latestAudit, null);
});

test("the display payload keeps the exact shape firmware parses", async () => {
  const store = displayFixtureStore();

  const display = await buildUserDisplayState(store, "user_1");

  // applyDisplayJson() in the firmware reads these names positionally out of the JSON, so key
  // order and spelling are the contract, not an implementation detail.
  assert.deepEqual(Object.keys(display), [
    "title",
    "state",
    "line1",
    "line2",
    "counts",
    "latestAction",
    "menu",
  ]);
  assert.deepEqual(Object.keys(display.counts), [
    "environments",
    "devices",
    "media",
    "macros",
    "commands",
    "audit",
    "onlineDevices",
    "offlineDevices",
  ]);
  assert.deepEqual(display, {
    title: "Next Coder",
    state: "ready",
    line1: "2 env / 2 devices",
    line2: "dispatched: session_control",
    counts: {
      environments: 2,
      devices: 2,
      media: 2,
      macros: 1,
      commands: 2,
      audit: 2,
      onlineDevices: 1,
      offlineDevices: 1,
    },
    latestAction: "command.dispatched",
    menu: ["status", "prompt", "shell", "macro", "media", "stop"],
  });

  // The two states the line1/state pair can take, both preserved from the old implementation.
  const empty = await buildUserDisplayState(createMemoryStore(), "user_nobody");
  assert.equal(empty.state, "setup");
  assert.equal(empty.line1, "0 env / 0 devices");
  assert.equal(empty.line2, "No commands yet");
  assert.equal(empty.latestAction, null);
});

test("file persistence retains dispatch start while completion metrics change", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "next-coder-dispatch-metrics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "store.json");
  const store = await createFileStore(path);
  await store.ensureUser({ userId: "fixture_user", email: "fixture@example.test" });
  const environment = await store.upsertEnvironment({ userId: "fixture_user", label: "Fixture", baseUrl: "https://fixture.invalid", accessToken: "fixture-token" });
  const dispatchStartedAt = "2026-10-22T12:00:00.000Z";
  const command = await store.createCommand({ userId: "fixture_user", environmentId: environment.id, threadId: "fixture_thread", intent: { type: "agent_prompt", text: "fixture" }, normalized: {}, status: "dispatched", risk: "low", metrics: { dispatchStartedAt, dispatchDurationMs: 23000, completedAt: "2026-10-22T12:00:23.000Z" } });
  await store.updateCommand({ userId: "fixture_user", commandId: command.id, status: "completed", metrics: { ...command.metrics, completedAt: "2026-10-22T12:01:00.000Z" } });
  await store.flush();
  const restored = await createFileStore(path);
  assert.equal((await restored.getCommandForUser("fixture_user", command.id)).metrics.dispatchStartedAt, dispatchStartedAt);
});
