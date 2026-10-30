import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { loadConfig } from "../src/config.mjs";
import { createT3TransportResolver } from "../src/t3Transport.mjs";
import { DirectAgentRuntime } from "../packages/connector/src/agents/runtime.mjs";
import { ConnectorClient } from "../packages/connector/src/connector.mjs";
import { createConnectorInternalService } from "../src/connectorInternalService.mjs";
import { extractHarnesses } from "../src/t3Harness.mjs";

async function fixture(t, configOverrides = {}, environmentPolicy = null) {
  const stateDir = await mkdtemp(join(tmpdir(), "next-coder-direct-http-"));
  const runtime = await new DirectAgentRuntime({ stateDir,
    config: { agents: [{ id: "codex", kind: "codex" }, { id: "claude", kind: "claude" }], projects: [{ id: "project", title: "Fixture project", cwd: stateDir }] },
    adapterFactory: () => ({ models: async () => [{ id: "default", label: "Default" }],
      list: async ({ cwd }) => ({ sessions: [{ id: "native", title: "Existing fixture session", cwd, attachment: "resume" }], nextCursor: null }),
      history: async () => [{ role: "user", text: "Saved task" }],
      run: async ({ onNativeId, onText }) => { await onNativeId("native"); onText("Actual mock-provider completion"); }, close() {},
    }) }).initialize();
  const store = createMemoryStore();
  const environment = store.upsertEnvironment({ userId: "owner", label: "Direct machine", transportMode: "connector", scopes: ["orchestration:read", "orchestration:operate"] });
  if (environmentPolicy) {
    const getEnvironment = store.getEnvironmentForUser.bind(store);
    store.getEnvironmentForUser = (...args) => {
      const value = getEnvironment(...args);
      return value ? { ...value, policy: environmentPolicy } : null;
    };
  }
  const enrolled = store.createConnector({ userId: "owner", environmentId: environment.id });
  const router = {
    request: async (_env, { method, payload }) => {
      if (method === "callRpc") return await runtime.callRpc(payload.tag, payload.payload);
      if (method === "dispatch") return await runtime.dispatch(payload.command);
      if (method === "threadDetail") return await runtime.threadDetail(payload.threadId);
      return await runtime[method]();
    },
    openThreadStream: (_env, input, callbacks) => runtime.openThreadStream(input, callbacks),
  };
  const dispatchOptions = [];
  const app = createApp({ store, config: { ...loadConfig({ AUTH_PROVIDER: "dev", DEMO_MODE: "1" }), ...configOverrides }, t3TransportResolver: createT3TransportResolver({ connector: { ...router,
    environmentInfo: async () => runtime.environmentInfo(), capabilityProbe: async () => runtime.capabilityProbe(), snapshot: async () => runtime.snapshot(),
    threadDetail: async (_e, id) => runtime.threadDetail(id), dispatch: async (_e, c, options) => { dispatchOptions.push(options); return await runtime.dispatch(c); }, callRpc: async (_e, tag, p) => runtime.callRpc(tag, p),
  } }) });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const ownerToken = store.createUserToken({ userId: "owner" }).secret;
  const ownerHeaders = { authorization: `Bearer ${ownerToken}` };
  const device = store.createDevice({ userId: "owner", label: "Fixture hardware", profile: "next-coder" });
  store.updateDeviceConfig({ userId: "owner", deviceId: device.device.id, config: { environmentId: environment.id, projectId: "project", threadId: "thread" } });
  await runtime.dispatch({ type: "thread.create", commandId: "create", threadId: "thread", projectId: "project", modelSelection: { instanceId: "codex", model: "default" } });
  const deviceHeaders = { "x-device-id": device.device.id, "x-device-secret": device.secret };
  const request = async (path, headers = ownerHeaders, body) => {
    const response = await fetch(base + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); await runtime.close(); await rm(stateDir, { recursive: true, force: true }); });
  return { app, runtime, store, environment, enrolled, request, ownerHeaders, deviceHeaders, device, dispatchOptions };
}

test("owner and device discover saved sessions, import and switch through the same policy boundary", async (t) => {
  const { request, environment, deviceHeaders, runtime } = await fixture(t);
  const ownerList = await request(`/v1/t3/environments/${environment.id}/sessions?runtimeId=codex&projectId=project`);
  assert.equal(ownerList.status, 200); assert.equal(ownerList.data.sessions[0].id, "native"); assert.equal(ownerList.data.sessions[0].cwd, undefined);
  const deviceList = await request("/v1/device/sessions?runtimeId=codex", deviceHeaders);
  assert.equal(deviceList.status, 200); assert.equal(deviceList.data.sessions[0].title, "Existing fixture session");
  const catalog = await request("/v1/device/runtimes", deviceHeaders);
  assert.equal(catalog.status, 200); assert.equal(catalog.data.runtimes.length, 2);
  const switched = await request("/v1/device/intents", deviceHeaders, { clientRequestId: "device-switch-once", threadId: "thread", intent: { type: "runtime_switch", runtimeId: "claude", model: "default" } });
  assert.equal(switched.status, 200, JSON.stringify(switched.data)); assert.equal(switched.data.command.status, "completed");
  assert.equal((await runtime.threadDetail("thread")).modelSelection.instanceId, "claude");
  const imported = await request("/v1/device/intents", deviceHeaders, { clientRequestId: "device-import-once", threadId: "thread", intent: { type: "runtime_import", projectId: "project", runtimeId: "codex", model: "default", nativeSessionId: "native", confirmResume: true } });
  assert.equal(imported.status, 200, JSON.stringify(imported.data)); assert.match(imported.data.command.result.threadId, /^native_/);
});

test("owner/device credentials never cross realms and viewers cannot import or switch", async (t) => {
  const { request, environment, ownerHeaders, deviceHeaders, store, device } = await fixture(t);
  assert.ok([400, 401].includes((await request("/v1/device/sessions?runtimeId=codex", ownerHeaders)).status));
  assert.ok([400, 401].includes((await request(`/v1/t3/environments/${environment.id}/sessions?runtimeId=codex&projectId=project`, deviceHeaders)).status));
  const otherOwner = { authorization: `Bearer ${store.createUserToken({ userId: "other-owner" }).secret}` };
  assert.equal((await request(`/v1/t3/environments/${environment.id}/sessions?runtimeId=codex&projectId=project`, otherOwner)).status, 404);
  store.updateDeviceProfile({ userId: "owner", deviceId: device.device.id, profile: "read-only" });
  const result = await request("/v1/device/intents", deviceHeaders, { clientRequestId: "readonly-switch-once", threadId: "thread", intent: { type: "runtime_switch", runtimeId: "claude", model: "default" } });
  assert.equal(result.status, 403);
  const stale = await request("/v1/device/intents", deviceHeaders, { clientRequestId: "stale-context-switch", expectedEnvironmentId: "old", threadId: "thread", intent: { type: "runtime_switch", runtimeId: "claude", model: "default" } });
  assert.equal(stale.status, 409);
});

test("direct runtime capability manifest and catalogue survive hello-to-store projection honestly", async (t) => {
  const { request, environment, runtime, store, enrolled } = await fixture(t);
  const result = await request(`/v1/t3/environments/${environment.id}/capabilities`);
  assert.equal(result.status, 200); assert.equal(result.data.manifest.runtimeKind, "direct");
  assert.equal(result.data.manifest.features.terminal.state, "unsupported"); assert.equal(result.data.manifest.attachments.image.state, "unsupported");
  const client = new ConnectorClient({ state: { connectorId: enrolled.connector.id, environmentId: environment.id, agentConfig: runtime.config }, t3: runtime, WebSocketImpl: class {} });
  const hello = await client.buildHello("test-connection");
  const service = createConnectorInternalService({ store });
  const response = await service.fetch(new Request("https://internal/v1/internal/connector-events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventVersion: 1, kind: "connector.hello", environmentId: environment.id, connectorId: enrolled.connector.id, connectionId: "test-connection", occurredAt: Date.now(), body: hello.body }) }));
  assert.equal(response.status, 202);
  const updated = store.getEnvironmentForUser("owner", environment.id);
  assert.equal(extractHarnesses(await runtime.snapshot(), { catalogue: updated.providerCatalogue })[0].available, true);
  assert.equal(updated.providerCatalogue.instances[0].auth.status, "unknown");
});

test("an unwatched direct turn reconciles through compact snapshot evidence and is readable on the device", async (t) => {
  const { app, runtime, store, environment, request, deviceHeaders } = await fixture(t);
  const dispatched = await request("/v1/device/intents", deviceHeaders, { clientRequestId: "native-device-prompt", threadId: "thread", intent: { type: "agent_prompt", text: "Run the isolated fixture" } });
  assert.equal(dispatched.status, 202, JSON.stringify(dispatched.data));
  while (runtime.active.size) await Promise.allSettled([...runtime.active.values()].map((a) => a.done));
  const snapshot = await runtime.snapshot();
  assert.equal(snapshot.threads[0].messages, undefined);
  await app.snapshotPoller.runOnce({ userIds: ["owner"] });
  const command = store.getCommandForUser("owner", dispatched.data.command.id);
  assert.equal(command.status, "completed"); assert.match(command.result.response, /Actual mock-provider completion/);
  const detail = await request("/v1/device/thread-output", deviceHeaders);
  assert.equal(detail.status, 200); assert.match(JSON.stringify(detail.data), /Actual mock-provider completion/);
});

test("device and dashboard requests use separate connector receipts when their client ids match", async (t) => {
  const { request, environment, deviceHeaders, runtime, dispatchOptions } = await fixture(t);
  const common = { clientRequestId: "same-id-across-actors", threadId: "thread" };
  const device = await request("/v1/device/intents", deviceHeaders, { ...common, intent: { type: "runtime_switch", runtimeId: "claude", model: "default" } });
  const owner = await request("/v1/intents", undefined, { ...common, environmentId: environment.id, intent: { type: "runtime_switch", runtimeId: "codex", model: "default" } });
  assert.equal(device.status, 200, JSON.stringify(device.data));
  assert.equal(owner.status, 200, JSON.stringify(owner.data));
  assert.equal(dispatchOptions.length, 2);
  assert.notEqual(dispatchOptions[0].idempotencyKey, dispatchOptions[1].idempotencyKey);
  assert.equal((await runtime.threadDetail("thread")).modelSelection.instanceId, "codex");
});

test("held direct actions recheck device authorization and bindings before approval", async (t) => {
  for (const type of ["runtime_switch", "runtime_import"]) {
    for (const change of ["none", "revoked", "profile", "policy", "environmentId", "projectId", "threadId"]) {
      await t.test(`${type}: ${change}`, async (t) => {
        const policy = { approval: ["session_control", "thread_create"] };
        const { request, deviceHeaders, store, device, runtime, dispatchOptions } = await fixture(t, {}, policy);
        const intent = { type, runtimeId: "claude", model: "default", ...(type === "runtime_import" ? { projectId: "project", nativeSessionId: "native", confirmResume: true } : {}) };
        const held = await request("/v1/device/intents", deviceHeaders, { clientRequestId: `held-${type}-${change}`, threadId: "thread", intent });
        assert.equal(held.status, 200, JSON.stringify(held.data));
        assert.equal(held.data.command.status, "approval_required");
        assert.deepEqual(held.data.command.result.deviceContext.projectId, "project");
        if (change === "revoked") store.revokeDevice({ userId: "owner", deviceId: device.device.id });
        else if (change === "profile") store.updateDeviceProfile({ userId: "owner", deviceId: device.device.id, profile: "read-only" });
        else if (change === "policy") policy.deny = ["session_control", "thread_create"];
        else if (change !== "none") store.updateDeviceConfig({ userId: "owner", deviceId: device.device.id, config: { [change]: "changed" } });
        const approved = await request(`/v1/commands/${held.data.command.id}/approve`, undefined, {});
        if (change === "none") {
          assert.equal(approved.status, 202, JSON.stringify(approved.data));
          assert.equal(approved.data.command.status, "completed");
        } else {
          assert.equal(approved.status, ["revoked", "profile", "policy"].includes(change) ? 403 : 409, JSON.stringify(approved.data));
          assert.equal(dispatchOptions.length, 0);
          assert.equal((await runtime.threadDetail("thread")).modelSelection.instanceId, "codex");
        }
      });
    }
  }
});

test("a read-only second controller cannot approve an owner's held direct action", async (t) => {
  const { request, store, environment, dispatchOptions } = await fixture(t, {}, { approval: ["session_control"] });
  const held = await request("/v1/intents", undefined, { environmentId: environment.id, clientRequestId: "owner-held-runtime", threadId: "thread", intent: { type: "runtime_switch", runtimeId: "claude", model: "default" } });
  assert.equal(held.data.command.status, "approval_required");
  const viewer = store.createDevice({ userId: "owner", label: "Read only", profile: "read-only" });
  const approved = await request(`/v1/device/approvals/${held.data.command.id}/approve`, { "x-device-id": viewer.device.id, "x-device-secret": viewer.secret }, {});
  assert.equal(approved.status, 403, JSON.stringify(approved.data));
  assert.equal(dispatchOptions.length, 0);
});
