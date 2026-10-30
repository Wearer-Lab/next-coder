// Per-model switches (reasoning effort, service tier, context window) end to end on the connector:
// the hello projection, the direct runtime's validation and the native Codex wire mapping, plus the
// approval-decision narrowing that a direct runtime records on its own activities.
import "./support/closeEvent.mjs";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ConnectorClient } from "../src/connector.mjs";
import { CodexAgent, ClaudeAgent, AcpAgent, codexOptionDescriptors } from "../src/agents/adapters.mjs";
import { DirectAgentRuntime, canonicalDecisions } from "../src/agents/runtime.mjs";
import { createConnectorInternalService } from "../../../src/connectorInternalService.mjs";
import { createMemoryStore } from "../../../src/store.mjs";
import { extractHarnesses, validateModelSelection } from "../../../src/t3Harness.mjs";

// Real provider caches captured from a live T3 install, not an invented shape.
const captured = JSON.parse(await readFile(new URL("../../../test/fixtures/t3-provider-caches.json", import.meta.url), "utf8"));
const quietLogger = { log() {}, error() {} };

async function helloFor(providers, extra = {}) {
  const connector = new ConnectorClient({
    state: { connectorId: "con", environmentId: "env", t3AccessToken: "token", ...extra },
    t3: { environmentInfo: async () => ({ version: "0.0.32" }), providerCatalogue: async () => providers },
    WebSocketImpl: class {}, logger: quietLogger,
  });
  return await connector.buildHello("connection");
}
const descriptorsOf = (hello, providerId, modelId) =>
  hello.body.providerCatalogue.find((p) => p.id === providerId).models.find((m) => m.id === modelId).capabilities?.optionDescriptors;
const ids = (list) => list.map((entry) => entry.id);

test("hello keeps each provider's own option descriptors, ids and value lists from captured T3 caches", async () => {
  const hello = await helloFor(captured);

  const codex = descriptorsOf(hello, "codex", "gpt-5.6-sol");
  const effort = codex.find((d) => d.id === "reasoningEffort");
  assert.deepEqual(ids(effort.options), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(effort.type, "select");
  assert.equal(effort.currentValue, "low");
  const tier = codex.find((d) => d.id === "serviceTier");
  assert.deepEqual(ids(tier.options), ["default", "priority"]);
  // The provider's own wording is the only thing that explains a value.
  assert.equal(tier.options.find((o) => o.id === "priority").description, "1.5x speed, increased usage");

  const claude = descriptorsOf(hello, "claudeAgent", "claude-fable-5");
  assert.deepEqual(ids(claude.find((d) => d.id === "effort").options), ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"]);
  assert.deepEqual(ids(claude.find((d) => d.id === "contextWindow").options), ["200k", "1m"]);
  assert.equal(claude.find((d) => d.id === "effort").options.find((o) => o.id === "high").isDefault, true);

  // Every descriptor of every captured model survives with its id intact, switches included.
  for (const provider of captured) for (const model of provider.models) {
    const raw = model.capabilities?.optionDescriptors ?? [];
    const sent = hello.body.providerCatalogue.find((p) => p.id === provider.instanceId).models.find((m) => m.id === model.slug)?.capabilities?.optionDescriptors ?? [];
    assert.deepEqual(ids(sent), ids(raw), `${provider.instanceId}/${model.slug}`);
    for (const descriptor of raw) {
      const projected = sent.find((d) => d.id === descriptor.id);
      assert.equal(projected.type, descriptor.type);
      if (descriptor.type === "select") assert.deepEqual(ids(projected.options), ids(descriptor.options));
    }
  }
  assert.ok(captured.some((p) => p.models.some((m) => m.capabilities?.optionDescriptors?.some((d) => d.type === "boolean"))), "fixture exercises a boolean switch");
});

test("hello still carries readiness, install and auth status, and drops credentials and diagnostics", async () => {
  const hello = await helloFor(captured);
  const byId = Object.fromEntries(hello.body.providerCatalogue.map((p) => [p.id, p]));
  for (const provider of captured) {
    const sent = byId[provider.instanceId];
    assert.equal(sent.status, provider.status, provider.instanceId);
    assert.equal(sent.enabled, provider.enabled);
    assert.equal(sent.installed, provider.installed);
    assert.equal(sent.auth.status, provider.auth.status === "authenticated" ? "authenticated" : "unknown");
  }
  assert.equal(byId.codex.auth.status, "authenticated");
  // No login label, plan name, version string or provider error text rides along.
  const wire = JSON.stringify(hello.body.providerCatalogue);
  for (const provider of captured) {
    for (const secret of [provider.auth?.label, provider.auth?.type, provider.version, provider.message]) {
      if (typeof secret === "string" && secret.length > 3) assert.equal(wire.includes(secret), false, `leaked ${secret}`);
    }
  }
  assert.deepEqual(Object.keys(byId.codex).sort(), ["auth", "enabled", "id", "installed", "label", "models", "status"]);
  assert.deepEqual(Object.keys(byId.codex.models[0]).sort(), ["capabilities", "id", "label"]);
  assert.deepEqual(Object.keys(byId.codex.models[0].capabilities), ["optionDescriptors"]);
});

test("a missing or malformed status stays unknown, and a direct runtime keeps its runtimeKind", async () => {
  const hello = await helloFor([
    { id: "silent", enabled: true, installed: true, models: [{ id: "m" }] },
    { id: "odd", status: { nested: true }, auth: { status: "pwned" }, enabled: "yes", models: [] },
    { id: "native", runtimeKind: "direct", status: "ready", enabled: true, installed: true, auth: { status: "unknown" }, models: [{ id: "default" }] },
  ]);
  const [silent, odd, native] = hello.body.providerCatalogue;
  assert.equal(silent.status, "unknown"); assert.equal(silent.auth.status, "unknown");
  assert.equal(odd.status, "unknown"); assert.equal(odd.auth.status, "unknown"); assert.equal(odd.enabled, false);
  assert.equal(native.runtimeKind, "direct");
  assert.equal(native.auth.status, "unknown", "no fabricated authenticated flag");
  assert.equal(silent.models[0].capabilities, undefined, "no descriptors means no capabilities key");
});

test("descriptor projection is bounded, never clips an id, and refuses unusable shapes", async () => {
  const long = "x".repeat(121);
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
  const hello = await helloFor([{ id: "p", status: "ready", enabled: true, installed: true, auth: { status: "authenticated" }, models: [{
    slug: "m", name: "M", capabilities: { optionDescriptors: [
      { id: "ok", label: "L".repeat(500), type: "weird", currentValue: "o1", description: "D".repeat(500), options: many },
      { id: long, label: "dropped: id too long", type: "select", options: [{ id: "a" }] },
      { id: "ok", label: "duplicate id", type: "select", options: [{ id: "a" }] },
      { id: "badchoice", type: "select", options: [{ id: long + long }, { id: "" }, { id: "good", label: "Good" }, { id: "good" }] },
      { id: "empty", type: "select", options: [] },
      { id: "flag", label: "Flag", type: "boolean", currentValue: true },
      { id: "badcurrent", type: "select", currentValue: "not-offered", options: [{ id: "a" }] },
      null, "junk",
      ...Array.from({ length: 30 }, (_, i) => ({ id: `extra${i}`, type: "boolean" })),
    ] },
  }] }]);
  const descriptors = descriptorsOf(hello, "p", "m");
  assert.ok(descriptors.length <= 16);
  const ok = descriptors.find((d) => d.id === "ok");
  assert.equal(ok.type, "select", "an unknown type is treated as select");
  assert.equal(ok.label.length, 120); assert.equal(ok.description.length, 240);
  assert.equal(ok.options.length, 32);
  assert.deepEqual(ok.options.slice(0, 3).map((o) => o.id), ["o0", "o1", "o2"]);
  assert.equal(ok.currentValue, "o1");
  assert.equal(descriptors.some((d) => d.id.startsWith("x")), false, "an over-long id is dropped, not truncated");
  assert.equal(descriptors.filter((d) => d.id === "ok").length, 1);
  assert.deepEqual(ids(descriptors.find((d) => d.id === "badchoice").options), ["good"]);
  assert.equal(descriptors.some((d) => d.id === "empty"), false);
  assert.deepEqual(descriptors.find((d) => d.id === "flag"), { id: "flag", label: "Flag", type: "boolean", currentValue: true });
  assert.equal("currentValue" in descriptors.find((d) => d.id === "badcurrent"), false);
});

test("hello accepts the flattened options spelling the gateway also reads", async () => {
  const hello = await helloFor([{ id: "p", models: [{ slug: "m", options: [{ id: "effort", type: "select", choices: [{ id: "low" }, { id: "high" }] }] }] }]);
  assert.deepEqual(ids(descriptorsOf(hello, "p", "m")[0].options), ["low", "high"]);
});

async function internalFixture() {
  const store = createMemoryStore();
  const environment = await store.upsertEnvironment({ userId: "user_1", label: "Studio Mac", transportMode: "connector", scopes: ["orchestration:read", "orchestration:operate"], status: "paired" });
  const enrolled = await store.createConnector({ userId: "user_1", environmentId: environment.id, scopes: ["connector:connect", "t3:proxy"], capabilities: [] });
  return { store, environment, enrolled };
}

// The second boundary: the gateway's connector hello projection. This is the regression CLAUDE.md
// asks for across BOTH halves, and it is the test that matters most here — the descriptors were
// being discarded twice in series, once by the connector's own projection and again by
// `sanitizeProviderCatalogue` in src/connectorInternalService.mjs, so a one-sided test passed
// while the deployed feature was dead. Both halves now keep them and this runs for real.
test("captured descriptors survive the connector hello AND the gateway's owner projection", async () => {
  const { store, environment, enrolled } = await internalFixture();
  const hello = await helloFor(captured);
  const service = createConnectorInternalService({ store, ticketAudience: "agent-controller-connectors" });
  const response = await service.fetch(new Request("https://connector-auth.internal/v1/internal/connector-events", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventVersion: 1, environmentId: environment.id, connectorId: enrolled.connector.id, connectionId: "c1", occurredAt: Date.now(), kind: "connector.hello", body: hello.body }),
  }));
  assert.equal(response.status, 202);
  const catalogue = store.exportState().environments[0].providerCatalogue;
  const harnesses = extractHarnesses({ projects: [], threads: [] }, { catalogue });
  const codex = harnesses.find((h) => h.instanceId === "codex").models.find((m) => m.slug === "gpt-5.6-sol");
  assert.deepEqual(ids(codex.options.find((o) => o.id === "reasoningEffort").choices), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  const claude = harnesses.find((h) => h.instanceId === "claudeAgent").models.find((m) => m.slug === "claude-fable-5");
  assert.ok(claude.options.some((o) => o.id === "effort"));
  assert.equal(harnesses.find((h) => h.instanceId === "codex").status, "ready");
  assert.equal(validateModelSelection({ instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "ultra" }] }, harnesses), null);
});

// ---- Native Codex: descriptors come from model/list, never from a list in this repository ----

const mockCodex = () => ({ spawnImpl: (_command, _args, options) =>
  spawn(process.execPath, [fileURLToPath(new URL("./support/mock-codex-options.mjs", import.meta.url))], options) });

test("Codex declares only what model/list reports and maps chosen values onto turn/start", async (t) => {
  const adapter = new CodexAgent({}, mockCodex()); t.after(() => adapter.close());
  const models = await adapter.models();
  assert.equal(models.find((m) => m.id === "default").capabilities, undefined, "the unspecified default model declares nothing");
  assert.equal(models.find((m) => m.id === "plain-model").capabilities, undefined, "no reported efforts or tiers, no descriptors");
  const descriptors = models.find((m) => m.id === "tiered-model").capabilities.optionDescriptors;
  assert.deepEqual(ids(descriptors), ["reasoningEffort", "serviceTier"]);
  assert.deepEqual(descriptors[0].options.map((o) => [o.id, o.description, o.isDefault ?? false]), [["low", "Fast", false], ["medium", "Balanced", true], ["high", "Deep", false]]);
  assert.equal(descriptors[0].currentValue, "medium");
  assert.deepEqual(descriptors[1].options.map((o) => o.id), ["default", "priority"]);
  assert.equal(descriptors[1].currentValue, "default");

  let sent = "";
  await adapter.run({ cwd: process.cwd(), model: "tiered-model", options: [{ id: "reasoningEffort", value: "high" }, { id: "serviceTier", value: "priority" }, { id: "undeclared", value: "x" }],
    prompt: "go", onNativeId: async () => {}, onText: (value) => { sent += value; }, ask: async () => "accept" });
  const params = JSON.parse(sent);
  assert.equal(params.effort, "high"); assert.equal(params.serviceTierForTurn, "priority");
  assert.equal("undeclared" in params, false);
  sent = "";
  await adapter.run({ cwd: process.cwd(), model: "default", prompt: "go", onNativeId: async () => {}, onText: (value) => { sent += value; }, ask: async () => "accept" });
  assert.equal("effort" in JSON.parse(sent) || "serviceTierForTurn" in JSON.parse(sent), false, "no choice, no override");
});

test("codexOptionDescriptors never invents values for a model that reports none", () => {
  assert.deepEqual(codexOptionDescriptors({}), []);
  assert.deepEqual(codexOptionDescriptors({ supportedReasoningEfforts: [{}, { reasoningEffort: "" }, null] }), []);
  // A default the model does not list is not offered as the current value.
  const [effort] = codexOptionDescriptors({ defaultReasoningEffort: "ultra", supportedReasoningEfforts: [{ reasoningEffort: "low" }] });
  assert.equal("currentValue" in effort, false);
});

test("Claude and ACP adapters declare no option descriptors rather than guess", async () => {
  const claude = new ClaudeAgent({ models: ["default", "claude-x"] }, { loadSdk: async () => ({}) });
  assert.ok((await claude.models()).every((m) => m.capabilities === undefined));
  const acp = new AcpAgent({ id: "acp", command: "mock", models: ["default"] }, { spawnImpl: () => { throw new Error("must not spawn"); } });
  assert.ok((await acp.models()).every((m) => m.capabilities === undefined));
});

// ---- Direct runtime: a chosen option is validated against the declared descriptors ----

async function runtimeFixture(t, adapter) {
  const stateDir = await mkdtemp(join(tmpdir(), "next-coder-options-test-"));
  const calls = [];
  const base = {
    models: async () => [{ id: "default", label: "Default" }, { id: "tiered", label: "Tiered", capabilities: { optionDescriptors: [
      { id: "reasoningEffort", label: "Reasoning", type: "select", currentValue: "low", options: [{ id: "low" }, { id: "high" }] },
      { id: "fast", label: "Fast", type: "boolean" },
    ] } }],
    list: async () => ({ sessions: [], nextCursor: null }), history: async () => [],
    async run(input) { calls.push(input); await input.onNativeId("native"); input.onText("ok"); },
    interrupt: async () => {}, close: () => {}, ...adapter,
  };
  const config = { agents: [{ id: "codex", kind: "codex" }], projects: [{ id: "project", cwd: stateDir }] };
  const runtime = await new DirectAgentRuntime({ config, stateDir, adapterFactory: () => base }).initialize();
  t.after(async () => { await runtime.close(); await rm(stateDir, { recursive: true, force: true }); });
  const dispatch = (type, extra = {}) => runtime.dispatch({ type, commandId: `cmd-${crypto.randomUUID()}`, threadId: "thread", ...extra });
  return { runtime, calls, dispatch, stateDir };
}
const settled = async (runtime) => { while (runtime.active.size) await Promise.allSettled([...runtime.active.values()].map((a) => a.done)); };
const prompt = (text) => ({ message: { messageId: crypto.randomUUID(), text } });

test("the runtime stores only declared options, refuses the rest, and hands them to the native adapter", async (t) => {
  const { runtime, calls, dispatch } = await runtimeFixture(t, {});
  const create = (options) => dispatch("thread.create", { projectId: "project", title: "T", modelSelection: { instanceId: "codex", model: "tiered", options } });
  for (const bad of [
    [{ id: "unknown", value: "x" }], [{ id: "reasoningEffort", value: "ultra" }], [{ id: "reasoningEffort", value: 3 }],
    [{ id: "fast", value: "yes" }], [{ id: "reasoningEffort", value: "low" }, { id: "reasoningEffort", value: "high" }], "low", Array.from({ length: 17 }, () => ({ id: "fast", value: true })),
  ]) await assert.rejects(create(bad), (error) => /^AGENT_OPTION_/u.test(error.code), JSON.stringify(bad));
  await assert.rejects(dispatch("thread.create", { projectId: "project", modelSelection: { instanceId: "codex", model: "default", options: [{ id: "reasoningEffort", value: "low" }] } }), { code: "AGENT_OPTION_UNSUPPORTED" });
  assert.equal((await runtime.snapshot()).threads.length, 0, "a refused selection creates nothing");

  await create([{ id: "reasoningEffort", value: "high", extra: "dropped" }, { id: "fast", value: true }]);
  assert.deepEqual((await runtime.snapshot()).threads[0].modelSelection.options, [{ id: "reasoningEffort", value: "high" }, { id: "fast", value: true }]);
  await dispatch("thread.turn.start", prompt("go")); await settled(runtime);
  assert.deepEqual(calls[0].options, [{ id: "reasoningEffort", value: "high" }, { id: "fast", value: true }]);

  // A turn may carry its own selection; it is validated like any other, and no options means none.
  await assert.rejects(dispatch("thread.turn.start", { ...prompt("again"), modelSelection: { instanceId: "codex", model: "tiered", options: [{ id: "reasoningEffort", value: "nope" }] } }), { code: "AGENT_OPTION_UNSUPPORTED" });
  await dispatch("thread.model-selection.set", { modelSelection: { instanceId: "codex", model: "default" } });
  await dispatch("thread.turn.start", prompt("plain")); await settled(runtime);
  assert.deepEqual(calls[1].options, []);
});

test("a native agent that cannot list models cannot validate options, so they are refused", async (t) => {
  const { dispatch } = await runtimeFixture(t, { models: async () => { throw new Error("down"); } });
  await assert.rejects(dispatch("thread.create", { projectId: "project", modelSelection: { instanceId: "codex", model: "tiered", options: [{ id: "fast", value: true }] } }), { code: "AGENT_UNAVAILABLE" });
});

test("the direct runtime's descriptors reach the hello unchanged", async (t) => {
  const { runtime } = await runtimeFixture(t, {});
  const connector = new ConnectorClient({ state: { connectorId: "con", environmentId: "env", agentConfig: runtime.config }, t3: runtime, WebSocketImpl: class {}, logger: quietLogger });
  const hello = await connector.buildHello("connection");
  const provider = hello.body.providerCatalogue[0];
  assert.equal(provider.runtimeKind, "direct");
  assert.deepEqual(ids(provider.models.find((m) => m.id === "tiered").capabilities.optionDescriptors), ["reasoningEffort", "fast"]);
});

// ---- Approval decision narrowing: payload.decisions must survive the connector's projection ----

async function approvalFixture(t, offered) {
  let answered; let release; const pending = new Promise((resolve) => { release = resolve; });
  const fixture = await runtimeFixture(t, { async run(input) {
    await input.onNativeId("native");
    try { answered = await input.ask({ kind: "approval", title: "Edit file?", decisions: offered }); } catch (error) { answered = error.code; }
    release(); input.onText("done");
  } });
  const frames = []; const socket = { send: (value) => frames.push(JSON.parse(value)) };
  const connector = new ConnectorClient({ state: { connectorId: "con", environmentId: "env", agentConfig: fixture.runtime.config }, t3: fixture.runtime, WebSocketImpl: class {}, logger: quietLogger });
  connector.connectionId = "connection";
  t.after(() => connector.stop());
  const subscribe = (leaseId) => connector.subscribe(socket, { body: { leaseId, threadId: "thread", expiresAt: new Date(Date.now() + 60_000).toISOString() } });
  await fixture.dispatch("thread.create", { projectId: "project", title: "T", modelSelection: { instanceId: "codex", model: "default" } });
  return { ...fixture, frames, subscribe, result: () => answered, finished: pending, connector };
}
const approvalsIn = (frame) => (frame.body.snapshot?.thread?.activities ?? []).filter((a) => a.kind === "approval.requested");
const waitFor = async (predicate) => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(predicate(), "timed out"); };

test("a two-decision subset reaches the gateway through a live refresh, a fresh subscription and a thread read", async (t) => {
  const { runtime, dispatch, frames, subscribe, result, finished } = await approvalFixture(t, ["accept", "decline"]);
  subscribe("lease-live");
  await dispatch("thread.turn.start", prompt("do it"));
  // Live path: the request is published to a subscription that was already open.
  await waitFor(() => frames.some((f) => f.type === "snapshot" && approvalsIn(f).length));
  const live = frames.filter((f) => f.type === "snapshot").flatMap(approvalsIn).at(-1);
  assert.deepEqual(live.payload.decisions, ["accept", "decline"]);
  // Initial-snapshot path: a subscription opened while the request is pending.
  const before = frames.length; subscribe("lease-late");
  await waitFor(() => frames.slice(before).some((f) => f.body.leaseId === "lease-late" && approvalsIn(f).length));
  const late = frames.slice(before).filter((f) => f.body.leaseId === "lease-late").flatMap(approvalsIn).at(-1);
  assert.deepEqual(late.payload.decisions, ["accept", "decline"]);
  assert.deepEqual((await runtime.threadDetail("thread")).activities.find((a) => a.kind === "approval.requested").payload.decisions, ["accept", "decline"]);
  // Nothing but vocabulary rides along.
  assert.deepEqual(Object.keys(live.payload).sort(), ["decisions", "detail", "requestId", "requestKind"]);

  const requestId = live.payload.requestId;
  await assert.rejects(dispatch("thread.approval.respond", { requestId, decision: "cancel" }), { code: "AGENT_DECISION_UNSUPPORTED" });
  await dispatch("thread.approval.respond", { requestId, decision: "accept" });
  await finished; assert.equal(result(), "accept"); await settled(runtime);
});

test("native decision wording is mapped into the gateway vocabulary, and an unmappable list fails closed", async (t) => {
  assert.deepEqual(canonicalDecisions(["approve", "reject", "bogus", "accept", 7, null, "acceptForSession", "cancel"]), ["accept", "decline", "acceptForSession", "cancel"]);
  assert.equal(canonicalDecisions(["bogus", "__proto__", "toString"]), null);
  assert.equal(canonicalDecisions("accept"), null);

  const mapped = await approvalFixture(t, ["approve", "reject"]);
  await mapped.dispatch("thread.turn.start", prompt("go"));
  await waitFor(() => mapped.runtime.requests.size);
  const [requestId] = [...mapped.runtime.requests.keys()];
  assert.deepEqual((await mapped.runtime.threadDetail("thread")).activities.find((a) => a.kind === "approval.requested").payload.decisions, ["accept", "decline"]);
  await mapped.dispatch("thread.approval.respond", { requestId, decision: "reject" });
  await mapped.finished; assert.equal(mapped.result(), "decline", "the native agent receives canonical wording");
  await settled(mapped.runtime);

  const stranded = await approvalFixture(t, ["maybe", "later"]);
  await stranded.dispatch("thread.turn.start", prompt("go"));
  await stranded.finished;
  assert.equal(stranded.result(), "AGENT_REQUEST_INVALID");
  assert.equal(stranded.runtime.requests.size, 0);
  assert.equal((await stranded.runtime.threadDetail("thread")).activities.some((a) => a.kind === "approval.requested"), false, "no approval card is shown for a request nothing can answer");
});
