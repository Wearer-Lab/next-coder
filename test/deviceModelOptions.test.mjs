import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { createT3TransportResolver } from "../src/t3Transport.mjs";
import { extractHarnesses, buildProviderCatalogue } from "../src/t3Harness.mjs";
import { DEVICE_MODEL_OPTION_LIMITS, projectDeviceModelOptions } from "../src/deviceModelOptions.mjs";
import { DirectAgentRuntime } from "../packages/connector/src/agents/runtime.mjs";

// Real provider caches captured from a live T3 host: genuine `reasoningEffort` / `effort`
// descriptors, so no option id in this file is invented.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const CACHES = JSON.parse(readFileSync(join(FIXTURES, "t3-provider-caches.json"), "utf8"));
const CODEX = CACHES.find((entry) => entry.instanceId === "codex");

// ---------------------------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------------------------

test("the projection carries the provider's own ids and bounds them for a small screen", () => {
  const harnesses = extractHarnesses({ projects: [] }, { catalogue: CACHES });
  const view = projectDeviceModelOptions({
    harnesses,
    selection: { instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "high" }] },
  });

  assert.equal(view.known, true);
  assert.equal(view.instanceId, "codex");
  assert.equal(view.model, "gpt-5.6-sol");
  const effort = view.descriptors.find((descriptor) => descriptor.id === "reasoningEffort");
  assert.ok(effort, "the id comes from the catalogue, not from this module");
  // The thread's own selection wins over the descriptor's declared default ("low").
  assert.equal(effort.current, "high");
  assert.deepEqual(effort.choices.map((choice) => choice.id), ["low", "medium", "high", "xhigh", "max", "ultra"]);

  // The unselected option reports the provider's declared default rather than "unset".
  assert.equal(view.descriptors.find((descriptor) => descriptor.id === "serviceTier").current, "default");

  // Provider prose and the auth block never cross: only id, label, type, current, choices.
  const wire = JSON.stringify(view);
  assert.doesNotMatch(wire, /1\.5x speed|ChatGPT|authenticated|description/u);
  assert.deepEqual(Object.keys(effort).sort(), ["choices", "choicesTruncated", "current", "id", "label", "type"]);
});

test("descriptors, choices and labels are capped, and the value in force survives the cut", () => {
  const long = (id, count) => ({
    id,
    label: "A very long descriptor label that overflows",
    type: "select",
    currentValue: `v${count - 1}`,
    choices: Array.from({ length: count }, (_, index) => ({ id: `v${index}`, label: `Choice number ${index} is long` })),
  });
  const harnesses = [{
    instanceId: "p",
    label: "Provider",
    models: [{ slug: "m", name: "Model", options: [long("a", 12), long("b", 2), long("c", 2), long("d", 2)] }],
  }];
  const view = projectDeviceModelOptions({ harnesses, selection: { instanceId: "p", model: "m" } });

  assert.equal(view.descriptors.length, DEVICE_MODEL_OPTION_LIMITS.descriptors);
  assert.equal(view.truncated, true);
  const first = view.descriptors[0];
  assert.equal(first.choices.length, DEVICE_MODEL_OPTION_LIMITS.choices);
  assert.equal(first.choicesTruncated, true);
  // v11 is the current value and sat past the cut: it replaces the last slot.
  assert.equal(first.choices.at(-1).id, "v11");
  assert.equal(first.current, "v11");
  for (const choice of first.choices) assert.ok(choice.label.length <= DEVICE_MODEL_OPTION_LIMITS.label);
  assert.ok(first.label.length <= DEVICE_MODEL_OPTION_LIMITS.label);
});

test("an unknown model yields an honest empty answer, and boolean switches stay switches", () => {
  const harnesses = [{
    instanceId: "p",
    label: "Provider",
    models: [{ slug: "m", name: "M", options: [
      { id: "fastMode", label: "Fast", type: "boolean", currentValue: false, choices: [] },
      { id: "undeclared", label: "No values", type: "select", currentValue: null, choices: [] },
      { id: "x".repeat(DEVICE_MODEL_OPTION_LIMITS.id + 1), label: "Too long", type: "boolean", choices: [] },
    ] }],
  }];
  const known = projectDeviceModelOptions({ harnesses, selection: { instanceId: "p", model: "m", options: [{ id: "fastMode", value: true }] } });
  assert.deepEqual(known.descriptors.map((descriptor) => [descriptor.id, descriptor.type, descriptor.current]), [["fastMode", "boolean", true]]);

  const unknown = projectDeviceModelOptions({ harnesses, selection: { instanceId: "p", model: "gone" } });
  assert.equal(unknown.known, false);
  assert.deepEqual(unknown.descriptors, []);
  assert.deepEqual(projectDeviceModelOptions({ harnesses: [], selection: null }).descriptors, []);
});

// ---------------------------------------------------------------------------------------------
// The route, against a stubbed T3 host
// ---------------------------------------------------------------------------------------------

const THREAD_ID = "thread_opts";

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function call(baseUrl, path, { method = "GET", headers = {}, body } = {}, fetchImpl = fetch) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

async function routeHarness(t, { profile = "next-coder", catalogue = CACHES, threadSelection } = {}) {
  const originalFetch = globalThis.fetch;
  const selection = threadSelection === undefined
    ? { instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "xhigh" }] }
    : threadSelection;
  globalThis.fetch = async (url) => {
    if (new URL(String(url)).pathname === "/api/orchestration/snapshot") {
      return jsonResponse({
        snapshotSequence: 1,
        projects: [{ id: "project_1", title: "app", defaultModelSelection: { instanceId: "claudeAgent", model: "claude-fable-5" } }],
        threads: [{ id: THREAD_ID, projectId: "project_1", title: "t", session: null, ...(selection ? { modelSelection: selection } : {}) }],
        updatedAt: "2026-10-30T10:00:00.000Z",
      }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { server } = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const user = await call(baseUrl, "/v1/users/dev", { method: "POST", body: { userId: "user_dev", email: "dev@example.local" } }, originalFetch);
  const authHeaders = { authorization: `Bearer ${user.data.apiToken.secret}` };
  const environment = await call(baseUrl, "/v1/t3/environments", {
    method: "POST", headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  }, originalFetch);
  const environmentId = environment.data.environment.id;
  if (catalogue) {
    const put = await call(baseUrl, `/v1/t3/environments/${environmentId}/catalogue`, {
      method: "PUT", headers: authHeaders, body: { source: "setup-script", instances: catalogue },
    }, originalFetch);
    assert.equal(put.status, 200);
  }
  const device = await call(baseUrl, "/v1/devices", { method: "POST", headers: authHeaders, body: { label: "Controller", profile } }, originalFetch);
  await call(baseUrl, `/v1/devices/${device.data.device.id}/config`, {
    method: "PUT", headers: authHeaders,
    body: { environmentId, threadId: THREAD_ID, projectId: "project_1" },
  }, originalFetch);
  const deviceHeaders = { "x-device-id": device.data.device.id, "x-device-secret": device.data.secret };
  return { baseUrl, deviceHeaders, authHeaders, environmentId, get: (path, headers = deviceHeaders) => call(baseUrl, path, { headers }, originalFetch) };
}

test("GET /v1/device/model-options returns the thread's model and its declared switches", async (t) => {
  const h = await routeHarness(t);
  const { status, data } = await h.get("/v1/device/model-options");

  assert.equal(status, 200);
  assert.equal(data.environmentId, h.environmentId);
  assert.equal(data.threadId, THREAD_ID);
  assert.equal(data.instanceId, "codex");
  assert.equal(data.model, "gpt-5.6-sol");
  assert.equal(data.known, true);
  assert.ok(data.descriptors.length >= 1 && data.descriptors.length <= 3);
  const effort = data.descriptors.find((descriptor) => descriptor.id === "reasoningEffort");
  assert.equal(effort.current, "xhigh");
  assert.ok(effort.choices.length <= 8);
  // A T3-hosted catalogue is not a direct runtime: runtime_switch would 409, so no picker is offered.
  assert.equal(data.settable, false);
  assert.doesNotMatch(JSON.stringify(data), /authenticated|ChatGPT|mock-token/u);
});

test("a thread with no recorded selection falls back to the project default", async (t) => {
  const h = await routeHarness(t, { threadSelection: null });
  const { data } = await h.get("/v1/device/model-options");
  assert.equal(data.instanceId, "claudeAgent");
  assert.deepEqual(data.descriptors.map((descriptor) => descriptor.id), ["effort", "contextWindow"]);
  assert.equal(data.descriptors[0].current, "high");
});

test("with no catalogue the route says it does not know instead of failing", async (t) => {
  const h = await routeHarness(t, { catalogue: null });
  const { status, data } = await h.get("/v1/device/model-options");
  assert.equal(status, 200);
  assert.equal(data.known, false);
  assert.deepEqual(data.descriptors, []);
  assert.equal(data.settable, false);
});

test("the route is device-realm only", async (t) => {
  const h = await routeHarness(t);
  assert.ok([400, 401].includes((await h.get("/v1/device/model-options", h.authHeaders)).status));
  assert.ok([400, 401].includes((await h.get("/v1/device/model-options", {})).status));
});

// ---------------------------------------------------------------------------------------------
// Setting a value: the ordinary device intent path, end to end against a real direct runtime
// ---------------------------------------------------------------------------------------------

async function directFixture(t, profile) {
  const stateDir = await mkdtemp(join(tmpdir(), "next-coder-model-options-"));
  const runtime = await new DirectAgentRuntime({
    stateDir,
    config: { agents: [{ id: "codex", kind: "codex" }], projects: [{ id: "project", title: "Fixture", cwd: stateDir }] },
    // The adapter must declare the same descriptors the catalogue carries. In production the two
    // agree by construction — the catalogue is built FROM the adapter's own `model/list` through
    // the connector hello — so a fixture where only the catalogue has them is testing a state that
    // cannot occur, and the runtime rightly refuses the dispatch (AGENT_OPTION_UNSUPPORTED).
    adapterFactory: () => ({
      models: async () => [{
        id: "gpt-5.6-sol",
        label: "Sol",
        capabilities: { optionDescriptors: CODEX.models.find((model) => model.slug === "gpt-5.6-sol").capabilities.optionDescriptors },
      }],
      list: async () => ({ sessions: [], nextCursor: null }),
      history: async () => [],
      run: async () => {},
      close() {},
    }),
  }).initialize();
  const store = createMemoryStore();
  const environment = store.upsertEnvironment({ userId: "owner", label: "Direct", transportMode: "connector", scopes: ["orchestration:read", "orchestration:operate"] });
  store.createConnector({ userId: "owner", environmentId: environment.id });
  // The same entry the runtime's hello would register, plus the real Codex descriptors. The
  // fixture's own adapter declares none, and the descriptors are the thing under test.
  store.updateEnvironmentCatalogue({
    userId: "owner",
    environmentId: environment.id,
    catalogue: buildProviderCatalogue([{ ...CODEX, runtimeKind: "direct", auth: { status: "unknown" }, status: "ready" }], { source: "direct-agent" }),
  });
  const dispatched = [];
  const router = {
    request: async (_env, { method, payload }) => {
      if (method === "callRpc") return await runtime.callRpc(payload.tag, payload.payload);
      if (method === "dispatch") return await runtime.dispatch(payload.command);
      if (method === "threadDetail") return await runtime.threadDetail(payload.threadId);
      return await runtime[method]();
    },
  };
  const app = createApp({
    store,
    config: { ...loadConfig({ AUTH_PROVIDER: "dev", DEMO_MODE: "1" }) },
    t3TransportResolver: createT3TransportResolver({ connector: { ...router,
      environmentInfo: async () => runtime.environmentInfo(), capabilityProbe: async () => runtime.capabilityProbe(), snapshot: async () => runtime.snapshot(),
      threadDetail: async (_e, id) => runtime.threadDetail(id),
      dispatch: async (_e, command) => { dispatched.push(command); return await runtime.dispatch(command); },
      callRpc: async (_e, tag, payload) => runtime.callRpc(tag, payload),
    } }),
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const device = store.createDevice({ userId: "owner", label: "Hardware", profile });
  store.updateDeviceConfig({ userId: "owner", deviceId: device.device.id, config: { environmentId: environment.id, projectId: "project", threadId: "thread" } });
  await runtime.dispatch({ type: "thread.create", commandId: "create", threadId: "thread", projectId: "project", modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" } });
  t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); await runtime.close(); await rm(stateDir, { recursive: true, force: true }); });
  const deviceHeaders = { "x-device-id": device.device.id, "x-device-secret": device.secret };
  const request = (path, body) => call(baseUrl, path, { method: body ? "POST" : "GET", headers: deviceHeaders, body });
  return { request, runtime, dispatched };
}

test("a device reads the switches and sets one through the ordinary runtime_switch intent", async (t) => {
  const { request, runtime, dispatched } = await directFixture(t, "next-coder");

  const read = await request("/v1/device/model-options");
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.equal(read.data.settable, true);
  const effort = read.data.descriptors.find((descriptor) => descriptor.id === "reasoningEffort");
  assert.ok(effort);

  // Pick a value the controller was actually shown.
  const chosen = effort.choices.find((choice) => choice.id !== effort.current);
  const switched = await request("/v1/device/intents", {
    clientRequestId: "device-effort-once",
    threadId: "thread",
    intent: { type: "runtime_switch", runtimeId: "codex", model: "gpt-5.6-sol", options: [{ id: effort.id, value: chosen.id }] },
  });
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  assert.equal(switched.data.command.status, "completed");
  assert.deepEqual(dispatched.at(-1).modelSelection.options, [{ id: "reasoningEffort", value: chosen.id }]);
  assert.deepEqual((await runtime.threadDetail("thread")).modelSelection.options, [{ id: "reasoningEffort", value: chosen.id }]);

  // And the read now reports the new value.
  const after = await request("/v1/device/model-options");
  assert.equal(after.data.descriptors.find((descriptor) => descriptor.id === "reasoningEffort").current, chosen.id);
});

test("a value or option the model never declared is refused before dispatch", async (t) => {
  const { request, dispatched } = await directFixture(t, "next-coder");
  for (const options of [
    [{ id: "reasoningEffort", value: "ultrathink" }], // Claude's word, not Codex's
    [{ id: "effort", value: "high" }], // Claude's id, not Codex's
  ]) {
    const refused = await request("/v1/device/intents", {
      clientRequestId: `bad-${options[0].id}-${options[0].value}`,
      threadId: "thread",
      intent: { type: "runtime_switch", runtimeId: "codex", model: "gpt-5.6-sol", options },
    });
    assert.equal(refused.status, 422, JSON.stringify(refused.data));
  }
  assert.equal(dispatched.length, 0);
});

test("a read-only controller can read the switches but is offered no way to set them", async (t) => {
  const { request } = await directFixture(t, "read-only");
  const read = await request("/v1/device/model-options");
  assert.equal(read.status, 200);
  assert.equal(read.data.settable, false);
  const refused = await request("/v1/device/intents", {
    clientRequestId: "readonly-effort",
    threadId: "thread",
    intent: { type: "runtime_switch", runtimeId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "high" }] },
  });
  assert.equal(refused.status, 403);
});
