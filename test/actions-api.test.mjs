import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createFileStore } from "../src/fileStore.mjs";
import { normalizeDeviceControlItems } from "../src/actions.mjs";

test("projected system action aliases round-trip as system controls rather than saved-action IDs", () => {
  assert.deepEqual(normalizeDeviceControlItems([
    { id: "system_status", actionId: "system_status", kind: "status", label: "Status", enabled: true },
    { id: "system_stop", actionId: "system_stop", kind: "stop", label: "Stop run" },
  ]), [
    { id: "system_status", kind: "status", label: "Status" },
    { id: "system_stop", kind: "stop", label: "Stop run" },
  ]);
});

test("saved actions and ordered device controls execute through the normal policy pipeline", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ accepted: true }, 200);
    }
    if (pathname === "/api/orchestration/snapshot") {
      return jsonResponse({
        projects: [],
        threads: [{
          id: "thread_actions",
          title: "Device session control task",
          latestTurn: { state: "running" },
          session: { status: "running", runtimeMode: "approval-required" },
          activities: [],
        }],
      }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { server, store } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const auth = await createAuthHeaders(originalFetch, baseUrl);
  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST", headers: auth, body: { label: "Actions controller", profile: "next-coder" },
  });
  const deviceAuth = { "x-device-id": created.device.id, "x-device-secret": created.secret };
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: auth,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
      scopes: ["orchestration:read", "orchestration:operate", "terminal:operate"],
    },
  });
  await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environment.environment.id}/capabilities`, {
    method: "GET", headers: auth,
  });
  await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: auth,
    body: { environmentId: environment.environment.id, threadId: "thread_actions" },
  });
  await requestJson(originalFetch, baseUrl, "/v1/device/heartbeat", {
    method: "POST",
    headers: deviceAuth,
    body: {
      protocolVersion: 2,
      firmwareVersion: "0.2.0",
      hardwareModel: "test-v2",
      features: ["display", "camera", "microphone", "ota"],
      limits: { menuItems: 8, labelCharacters: 18 },
    },
  });

  const prompt = await createAction(originalFetch, baseUrl, auth, {
    type: "prompt", label: "Continue task", payload: { text: "Continue and run tests." },
  });
  const shell = await createAction(originalFetch, baseUrl, auth, {
    type: "shell", label: "Run tests", payload: { command: "npm test" },
  });
  const photo = await createAction(originalFetch, baseUrl, auth, {
    type: "media", label: "Take photo", payload: { mediaKind: "image", prompt: "Inspect this image." },
  });
  const macro = await createAction(originalFetch, baseUrl, auth, {
    type: "macro",
    label: "Continue and test",
    steps: [{ actionId: prompt.id }, { actionId: shell.id }],
  });
  const dangerous = await createAction(originalFetch, baseUrl, auth, {
    type: "shell", label: "Dangerous cleanup", payload: { command: "rm -rf tmp/build" },
  });
  const pausingMacro = await createAction(originalFetch, baseUrl, auth, {
    type: "macro",
    label: "Pause for approval",
    steps: [{ actionId: dangerous.id }, { actionId: prompt.id }],
  });

  const actions = await requestJson(originalFetch, baseUrl, "/v1/actions", {
    method: "GET", headers: auth,
  });
  assert.equal(actions.actions.length, 6);

  const edited = await requestJson(originalFetch, baseUrl, `/v1/actions/${prompt.id}`, {
    method: "PUT", headers: auth, body: { label: "Continue safely" },
  });
  assert.equal(edited.action.label, "Continue safely");

  const ownerControls = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/controls`, {
    method: "PUT",
    headers: auth,
    body: {
      controls: [
        { kind: "status" },
        { id: shell.id, actionId: prompt.id, label: "Continue task with a deliberately long label" },
        { actionId: photo.id },
        { actionId: macro.id },
        { kind: "stop" },
      ],
    },
  });
  assert.equal(ownerControls.layout.revision, 2);
  assert.deepEqual(ownerControls.controls.map((control) => control.kind), [
    "status", "remote_action", "capture_image", "remote_action", "stop",
  ]);
  assert.equal(ownerControls.controls.every((control) => control.enabled), true);
  assert.deepEqual(ownerControls.controls.map((control) => control.requiresThread), [
    false, true, true, true, true,
  ]);
  assert.deepEqual(ownerControls.controls.map((control) => control.requiresConfirmation), [
    false, true, true, true, true,
  ]);
  assert.equal(ownerControls.controls[1].label, "Continue task with a deliberately long label");

  const beforeExpiry = await store.getEnvironmentForUser("user_dev", environment.environment.id);
  await store.updateEnvironmentHealth({ userId: "user_dev", environmentId: environment.environment.id,
    health: { capabilities: { ...beforeExpiry.health.capabilities, freshUntil: new Date(0).toISOString() } },
  });
  const deviceControls = await requestJson(originalFetch, baseUrl, "/v1/device/controls", {
    method: "GET", headers: deviceAuth,
  });
  assert.deepEqual(Object.keys(deviceControls).sort(), ["controls", "revision"]);
  assert.equal(deviceControls.revision, 2);
  assert.equal(deviceControls.controls[0].actionId, "system_status");
  assert.equal(deviceControls.controls[1].actionId, prompt.id);
  assert.equal(deviceControls.controls[1].label.length, 18);
  assert.equal(deviceControls.controls.every((control) => control.enabled), true);
  const renewed = await store.getEnvironmentForUser("user_dev", environment.environment.id);
  assert.ok(Date.parse(renewed.health.capabilities.freshUntil) > Date.now());

  await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT", headers: auth, body: { threadId: null },
  });
  const controlsWithoutThread = await requestJson(originalFetch, baseUrl, "/v1/device/controls", {
    method: "GET", headers: deviceAuth,
  });
  assert.equal(controlsWithoutThread.controls[0].enabled, true);
  assert.equal(controlsWithoutThread.controls[1].enabled, false);
  assert.equal(controlsWithoutThread.controls[1].requiresThread, true);
  assert.match(controlsWithoutThread.controls[1].reason, /No T3 task is selected/u);
  assert.equal(controlsWithoutThread.controls.at(-1).enabled, false);
  await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT", headers: auth, body: { threadId: "thread_actions" },
  });

  const usedActions = await requestJson(originalFetch, baseUrl, "/v1/actions", {
    method: "GET", headers: auth,
  });
  assert.deepEqual(usedActions.actions.find((action) => action.id === prompt.id).deviceIds, [created.device.id]);

  // Status is independent of Action Library enrichment. A broken unrelated action lookup must not
  // turn the built-in read-only status control into HTTP 500.
  const getActionForUser = store.getActionForUser;
  store.getActionForUser = async () => { throw new Error("unrelated action catalogue unavailable"); };
  const status = await requestJson(originalFetch, baseUrl, "/v1/device/actions/system_status/run", {
    method: "POST", headers: deviceAuth, body: {},
  });
  store.getActionForUser = getActionForUser;
  assert.equal(status.command.status, "completed");
  assert.equal(status.screen.state, "running");
  assert.equal(status.screen.thread.id, "thread_actions");

  const deviceActionPath = `/v1/device/actions/${prompt.id}/run`;
  const deviceActionBody = { clientRequestId: "dev:action-request-0001" };
  const dispatchCountBeforeDeviceAction = dispatches.length;
  const capabilityHealthUpdates = [];
  const updateEnvironmentHealth = store.updateEnvironmentHealth;
  store.updateEnvironmentHealth = async (input) => {
    capabilityHealthUpdates.push(input);
    return await updateEnvironmentHealth(input);
  };
  const ran = await requestJson(originalFetch, baseUrl, deviceActionPath, {
    method: "POST", headers: deviceAuth, body: deviceActionBody,
  });
  store.updateEnvironmentHealth = updateEnvironmentHealth;
  assert.equal(ran.command.status, "dispatched");
  const persistedCapabilities = capabilityHealthUpdates.find((input) => input.health?.capabilities);
  assert.ok(persistedCapabilities);
  assert.equal(Object.hasOwn(persistedCapabilities, "capabilities"), false);
  assert.equal(persistedCapabilities.health.capabilities.schema, "next-coder.t3-capabilities.v1");
  assert.equal(ran.responseAfter, ran.command.metrics.dispatchStartedAt);
  assert.ok(Date.parse(ran.responseAfter) <= Date.parse(ran.command.createdAt));
  assert.match(dispatches.at(-1).message.text, /^Continue and run tests\.\n\n<!--AC_DEVICE_FOLLOWUP_REQUEST/u);
  assert.match(dispatches.at(-1).message.text, new RegExp(photo.id, "u"));
  assert.doesNotMatch(dispatches.at(-1).message.text, new RegExp(`\"${prompt.id}\"`, "u"));
  const replayedDeviceAction = await requestJson(originalFetch, baseUrl, deviceActionPath, {
    method: "POST", headers: deviceAuth, body: deviceActionBody,
  });
  assert.equal(replayedDeviceAction.duplicate, true);
  assert.equal(replayedDeviceAction.command.id, ran.command.id);
  assert.equal(dispatches.length, dispatchCountBeforeDeviceAction + 1);

  const macroRun = await requestJson(originalFetch, baseUrl, `/v1/actions/${macro.id}/run`, {
    method: "POST",
    headers: auth,
    body: { environmentId: environment.environment.id, threadId: "thread_actions" },
  });
  assert.equal(macroRun.macro.executions.length, 2);
  assert.equal(macroRun.macro.executions[0].command.status, "dispatched");
  assert.equal(macroRun.macro.executions[1].command.status, "dispatched");
  assert.equal(macroRun.macro.status, "dispatched");

  const paused = await requestJson(originalFetch, baseUrl, `/v1/actions/${pausingMacro.id}/run`, {
    method: "POST",
    headers: auth,
    body: { environmentId: environment.environment.id, threadId: "thread_actions" },
  });
  assert.equal(paused.macro.status, "approval_required");
  assert.equal(paused.macro.executions.length, 1);
  assert.equal(paused.macro.nextStepIndex, 1);
  assert.deepEqual(paused.macro.remainingActionIds, [prompt.id]);
  assert.equal(paused.macro.resumeSupported, true);
  assert.match(paused.macro.runId, /^macrorun_/u);
  const pendingMacroCommandId = paused.macro.executions[0].command.id;
  const dispatchCountBeforeApproval = dispatches.length;
  const approvedMacro = await requestJson(originalFetch, baseUrl, `/v1/commands/${pendingMacroCommandId}/approve`, {
    method: "POST", headers: auth, body: {},
  });
  assert.equal(approvedMacro.command.status, "dispatched");
  assert.equal(approvedMacro.macroResume.resumed, true);
  assert.equal(approvedMacro.macroResume.macro.status, "dispatched");
  assert.equal(approvedMacro.macroResume.macro.executions.length, 2);
  assert.equal(dispatches.length, dispatchCountBeforeApproval + 2);
  const retriedApproval = await requestJson(originalFetch, baseUrl, `/v1/commands/${pendingMacroCommandId}/approve`, {
    method: "POST", headers: auth, body: {},
  });
  assert.equal(retriedApproval.macroResume.resumed, false);
  assert.equal(dispatches.length, dispatchCountBeforeApproval + 2);

  await requestJson(originalFetch, baseUrl, "/v1/device/controls/ack", {
    method: "POST", headers: deviceAuth, body: { revision: 2 },
  });
  const acknowledged = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/controls`, {
    method: "GET", headers: auth,
  });
  assert.equal(acknowledged.layout.appliedRevision, 2);

  const denied = await originalFetch(new URL(`/v1/device/actions/${shell.id}/run`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...deviceAuth },
    body: "{}",
  });
  assert.equal(denied.status, 403);
  await denied.arrayBuffer();

  const mediaMacro = await originalFetch(new URL("/v1/actions", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ type: "macro", label: "Invalid media macro", steps: [{ actionId: photo.id }] }),
  });
  assert.equal(mediaMacro.status, 409);
  await mediaMacro.arrayBuffer();
  const nestedMacro = await originalFetch(new URL("/v1/actions", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ type: "macro", label: "Invalid nested macro", steps: [{ actionId: macro.id }] }),
  });
  assert.equal(nestedMacro.status, 409);
  await nestedMacro.arrayBuffer();

  const deleteReferenced = await originalFetch(new URL(`/v1/actions/${prompt.id}`, baseUrl), {
    method: "DELETE", headers: auth,
  });
  assert.equal(deleteReferenced.status, 409);
  assert.deepEqual((await deleteReferenced.json()).error.details.referencingMacroIds.sort(), [macro.id, pausingMacro.id].sort());

  const convertReferenced = await originalFetch(new URL(`/v1/actions/${prompt.id}`, baseUrl), {
    method: "PUT",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ type: "media", payload: { mediaKind: "image", prompt: "Inspect" } }),
  });
  assert.equal(convertReferenced.status, 409);
  await convertReferenced.arrayBuffer();

  const userMedia = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: auth,
    body: { kind: "image", contentType: "image/jpeg", dataBase64: validJpeg().toString("base64") },
  });
  const crossDeviceMedia = await originalFetch(new URL(`/v1/device/actions/${photo.id}/run`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...deviceAuth },
    body: JSON.stringify({ mediaUploadId: userMedia.media.id }),
  });
  assert.equal(crossDeviceMedia.status, 403);
  await crossDeviceMedia.arrayBuffer();
  const deviceAudio = await requestJson(originalFetch, baseUrl, "/v1/device/media", {
    method: "POST",
    headers: deviceAuth,
    body: { kind: "audio", contentType: "audio/wav", dataBase64: validWav().toString("base64") },
  });
  const wrongKind = await originalFetch(new URL(`/v1/device/actions/${photo.id}/run`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...deviceAuth },
    body: JSON.stringify({ mediaUploadId: deviceAudio.media.id }),
  });
  assert.equal(wrongKind.status, 409);
  await wrongKind.arrayBuffer();

  const removed = await requestJson(originalFetch, baseUrl, `/v1/actions/${photo.id}`, {
    method: "DELETE", headers: auth,
  });
  assert.deepEqual(removed.unassignedDeviceIds, [created.device.id]);
  const afterDelete = await requestJson(originalFetch, baseUrl, "/v1/device/controls", {
    method: "GET", headers: deviceAuth,
  });
  assert.equal(afterDelete.revision, 3);
  assert.equal(afterDelete.controls.some((control) => control.actionId === photo.id), false);

  const staleAck = await originalFetch(new URL("/v1/device/controls/ack", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...deviceAuth },
    body: JSON.stringify({ revision: 2, appliedCount: 4 }),
  });
  assert.equal(staleAck.status, 409);
  await staleAck.arrayBuffer();
  const mismatchedAck = await originalFetch(new URL("/v1/device/controls/ack", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...deviceAuth },
    body: JSON.stringify({ revision: 3, appliedCount: 99 }),
  });
  assert.equal(mismatchedAck.status, 409);
  await mismatchedAck.arrayBuffer();
  const afterBadAcks = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/controls`, {
    method: "GET", headers: auth,
  });
  assert.equal(afterBadAcks.layout.appliedRevision, 2);
  assert.equal(afterBadAcks.layout.lastAckStatus, "rejected");

  await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/profile`, {
    method: "PUT", headers: auth, body: { profile: "read-only" },
  });
  const blockedRun = await originalFetch(new URL(`/v1/device/actions/${prompt.id}/run`, baseUrl), {
    method: "POST", headers: { "content-type": "application/json", ...deviceAuth }, body: "{}",
  });
  assert.equal(blockedRun.status, 403);
  await blockedRun.arrayBuffer();
  const audit = await requestJson(originalFetch, baseUrl, "/v1/audit", { method: "GET", headers: auth });
  const blockedAudit = audit.events.findLast((event) => event.action === "action.run_blocked" && event.targetId === prompt.id);
  assert.equal(blockedAudit.metadata.intentType, "agent_prompt");
});

test("protocol-v2 controls remain opt-in so legacy devices fall back to config", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const auth = await createAuthHeaders(originalFetch, baseUrl);
  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST", headers: auth, body: { label: "Legacy controller", profile: "next-coder" },
  });
  const deviceAuth = { "x-device-id": created.device.id, "x-device-secret": created.secret };
  const controls = await originalFetch(new URL("/v1/device/controls", baseUrl), { headers: deviceAuth });
  assert.equal(controls.status, 404);
  const legacy = await requestJson(originalFetch, baseUrl, "/v1/device/config", { method: "GET", headers: deviceAuth });
  assert.ok(legacy.config.menu.includes("prompt"));
});

test("the system stop action is idempotent when T3 reports no active session", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/orchestration/dispatch") {
      return jsonResponse({ error: "no active session" }, 409);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const auth = await createAuthHeaders(originalFetch, baseUrl);
  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST", headers: auth, body: { label: "Stop controller", profile: "next-coder" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: auth,
    body: { label: "T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });
  await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT", headers: auth, body: { environmentId: environment.environment.id, threadId: "thread_stop" },
  });
  await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/controls`, {
    method: "PUT", headers: auth, body: { items: [{ kind: "stop" }] },
  });
  const stopped = await requestJson(originalFetch, baseUrl, "/v1/device/actions/system_stop/run", {
    method: "POST",
    headers: { "x-device-id": created.device.id, "x-device-secret": created.secret },
    body: {},
  });
  assert.equal(stopped.command.status, "completed");
  assert.equal(stopped.command.result.alreadyStopped, true);
  assert.equal(stopped.alreadyStopped, true);
});

test("firmware policy, telemetry, and derived T3 capabilities are owner scoped", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const auth = await createAuthHeaders(originalFetch, baseUrl);
  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST", headers: auth, body: { label: "OTA controller", profile: "next-coder" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: auth,
    body: {
      label: "Scoped T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
      scopes: ["orchestration:read", "orchestration:operate", "terminal:operate"],
    },
  });

  const capabilities = await requestJson(
    originalFetch,
    baseUrl,
    `/v1/t3/environments/${environment.environment.id}/capabilities`,
    { method: "GET", headers: auth },
  );
  assert.equal(capabilities.capabilities.orchestrationOperate, true);
  assert.equal(capabilities.capabilities.terminalDirect, false);
  assert.equal(capabilities.capabilities.savedActions, "gateway");
  assert.equal(capabilities.manifest.schema, "next-coder.t3-capabilities.v1");
  assert.equal(capabilities.manifest.recovery.action, "UPDATE T3 CODE");

  const updated = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/firmware-policy`, {
    method: "PUT",
    headers: auth,
    body: { channel: "beta", updateMode: "automatic" },
  });
  assert.equal(updated.policy.channel, "beta");
  assert.equal(updated.policy.updateMode, "automatic");
  assert.deepEqual(updated.availableVersions, []);

  const deviceAuth = { "x-device-id": created.device.id, "x-device-secret": created.secret };
  const report = await requestJson(originalFetch, baseUrl, "/v1/device/firmware/status", {
    method: "POST",
    headers: deviceAuth,
    body: { state: "downloading", version: "0.2.0", targetVersion: "0.3.0", progress: 42 },
  });
  assert.equal(report.policy.lastUpdateStatus, "downloading");
  assert.equal(report.policy.updateProgress, 42);

  const policy = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/firmware-policy`, {
    method: "GET", headers: auth,
  });
  assert.equal(policy.policy.targetVersion, "0.3.0");
  assert.match(policy.policy.lastUpdateAt, /^\d{4}-\d{2}-\d{2}T/u);
});

test("macro continuation checkpoints survive a file-store restart and are claimed once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "next-coder-macro-run-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "state.json");
  const first = await createFileStore(filePath);
  first.ensureUser({ userId: "user_resume" });
  const run = first.createMacroRun({
    userId: "user_resume",
    actionId: "action_root",
    approvalCommandId: "command_waiting",
    nextStepIndex: 1,
    runtime: { environmentId: "env_1", threadId: "thread_1" },
    actor: { type: "user", id: "user_resume", userId: "user_resume", profile: "power-controller" },
    policyContext: { networkLocation: "trusted" },
    executions: [{ actionId: "action_step_1" }],
  });
  await first.flush();

  const second = await createFileStore(filePath);
  const restored = second.getMacroRunForApproval({ userId: "user_resume", commandId: "command_waiting" });
  assert.equal(restored.id, run.id);
  assert.equal(restored.status, "waiting_approval");
  assert.equal(second.claimMacroRunForResume({ userId: "user_resume", runId: run.id }).status, "resuming");
  assert.equal(second.claimMacroRunForResume({ userId: "user_resume", runId: run.id }), null);
  await second.flush();
});

test("a fixed action survives its environment being removed as a disabled control", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/orchestration/dispatch") return jsonResponse({ accepted: true }, 200);
    if (pathname === "/api/orchestration/snapshot") return jsonResponse({ projects: [], threads: [] }, 200);
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const auth = await createAuthHeaders(originalFetch, baseUrl);
  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST", headers: auth, body: { label: "Orphan controller", profile: "next-coder" },
  });
  const deviceAuth = { "x-device-id": created.device.id, "x-device-secret": created.secret };
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: auth,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });
  await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environment.environment.id}/capabilities`, {
    method: "GET", headers: auth,
  });
  await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: auth,
    body: { environmentId: environment.environment.id, threadId: "thread_actions" },
  });
  const fixed = await createAction(originalFetch, baseUrl, auth, {
    type: "prompt",
    label: "Fixed prompt",
    payload: { text: "Continue and run tests." },
    targetMode: "fixed",
    environmentId: environment.environment.id,
    threadId: "thread_actions",
  });
  await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/controls`, {
    method: "PUT", headers: auth, body: { controls: [{ actionId: fixed.id }] },
  });
  const before = await requestJson(originalFetch, baseUrl, "/v1/device/controls", {
    method: "GET", headers: deviceAuth,
  });
  assert.equal(before.controls[0].enabled, true);

  await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environment.environment.id}`, {
    method: "DELETE", headers: auth, body: { confirmationLabel: environment.environment.label },
  });

  const after = await requestJson(originalFetch, baseUrl, "/v1/device/controls", {
    method: "GET", headers: deviceAuth,
  });
  assert.equal(after.controls[0].enabled, false);
  assert.match(after.controls[0].reason, /environment was removed/u);

  // The record is still editable: normalizeActionInput would reject a fixed action with no
  // environmentId, so the repair had to drop the fixed target as well as disable it.
  const rescued = await requestJson(originalFetch, baseUrl, `/v1/actions/${fixed.id}`, {
    method: "PUT", headers: auth, body: { label: "Repaired prompt" },
  });
  assert.equal(rescued.action.label, "Repaired prompt");
  assert.equal(rescued.action.disabled, false);
});

async function createAction(fetchImpl, baseUrl, auth, body) {
  const response = await requestJson(fetchImpl, baseUrl, "/v1/actions", {
    method: "POST", headers: auth, body,
  });
  return response.action;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function requestJson(fetchImpl, baseUrl, path, input) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: input.method,
    headers: { "content-type": "application/json", ...input.headers },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function createAuthHeaders(fetchImpl, baseUrl) {
  const created = await requestJson(fetchImpl, baseUrl, "/v1/users/dev", {
    method: "POST", headers: {}, body: { userId: "user_dev", email: "dev@example.local" },
  });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function validJpeg() {
  return Buffer.from("ffd8ffc00008080001000100", "hex");
}

function validWav() {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(0, 40);
  return buffer;
}
