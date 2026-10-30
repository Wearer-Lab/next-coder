import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createConnectorInternalService } from "../src/connectorInternalService.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { ConnectorClient } from "../packages/connector/src/connector.mjs";
import { extractHarnesses, resolveLatestModelSelection, validateModelSelection } from "../src/t3Harness.mjs";

const AUDIENCE = "agent-controller-connectors";

// Real provider caches captured from a live T3 install, not an invented shape.
const captured = JSON.parse(await readFile(new URL("./fixtures/t3-provider-caches.json", import.meta.url), "utf8"));

test("service binding atomically consumes a ticket into Cloudflare's flat claims shape", async () => {
  const { store, environment, enrolled } = await fixture();
  const minted = await store.createConnectorTicket({ connectorId: enrolled.connector.id, audience: AUDIENCE });
  const service = createConnectorInternalService({ store, ticketAudience: AUDIENCE });
  const now = Date.now();

  const response = await service.fetch(request("/v1/internal/connectors/tickets/consume", {
    ticket: minted.ticket,
    audience: AUDIENCE,
    now,
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ticketId: store.exportState().connectorTickets[0].id,
    connectorId: enrolled.connector.id,
    environmentId: environment.id,
    audience: AUDIENCE,
    scopes: ["connector:connect", "t3:proxy"],
    expiresAt: Date.parse(minted.expiresAt),
  });

  const replay = await service.fetch(request("/v1/internal/connectors/tickets/consume", {
    ticket: minted.ticket,
    audience: AUDIENCE,
    now,
  }));
  assert.equal(replay.status, 410);
});

test("wrong service audience is rejected without consuming the ticket", async () => {
  const { store, enrolled } = await fixture();
  const minted = await store.createConnectorTicket({ connectorId: enrolled.connector.id, audience: AUDIENCE });
  const service = createConnectorInternalService({ store, ticketAudience: AUDIENCE });

  const wrong = await service.fetch(request("/v1/internal/connectors/tickets/consume", {
    ticket: minted.ticket,
    audience: "another-service",
    now: Date.now(),
  }));
  assert.equal(wrong.status, 401);

  const valid = await service.fetch(request("/v1/internal/connectors/tickets/consume", {
    ticket: minted.ticket,
    audience: AUDIENCE,
    now: Date.now(),
  }));
  assert.equal(valid.status, 200);
});

test("the private edge consume path commits a staged credential before returning socket claims", async () => {
  const { store, enrolled } = await fixture();
  const rotation = await store.beginConnectorCredentialRotation({ userId: "user_1", connectorId: enrolled.connector.id });
  const pending = await store.authenticateConnector(enrolled.connector.id, rotation.secret);
  const minted = await store.createConnectorTicket({
    connectorId: enrolled.connector.id,
    audience: AUDIENCE,
    credentialVersion: pending.authenticatedCredentialVersion,
    rotationId: pending.authenticatedRotationId,
  });
  const service = createConnectorInternalService({ store, ticketAudience: AUDIENCE });
  const response = await service.fetch(request("/v1/internal/connectors/tickets/consume", {
    ticket: minted.ticket,
    audience: AUDIENCE,
    now: Date.now(),
  }));
  assert.equal(response.status, 200);
  assert.equal(await store.authenticateConnector(enrolled.connector.id, enrolled.secret), null);
  const current = await store.authenticateConnector(enrolled.connector.id, rotation.secret);
  assert.equal(current.credentialState, "active");
  assert.equal(current.credentialVersion, 2);
  assert.equal(JSON.stringify(await response.json()).includes(rotation.secret), false);
});

test("service binding projects bounded hello, catalogue, heartbeat, and disconnect state", async () => {
  const { store, environment, enrolled } = await fixture();
  const service = createConnectorInternalService({ store, ticketAudience: AUDIENCE });
  const occurredAt = Date.now();
  const secretMarker = "do-not-persist-this-provider-secret";
  const hello = await service.fetch(request("/v1/internal/connector-events", {
    eventVersion: 1,
    environmentId: environment.id,
    connectorId: enrolled.connector.id,
    connectionId: "connection_1",
    occurredAt,
    kind: "connector.hello",
    body: {
      connectorVersion: "1.2.3",
      t3Version: "0.0.32",
      platform: "darwin-arm64",
      t3Health: "ready",
      capabilities: [...Array.from({ length: 140 }, (_, index) => `cap-${index}`), "cap-1"],
      providerCatalogue: [{
        id: "codex",
        label: "Codex",
        token: secretMarker,
        models: [{ id: "gpt-5", label: "GPT-5", credential: secretMarker }],
      }],
    },
  }));
  assert.equal(hello.status, 202);

  let state = store.exportState();
  assert.equal(state.connectors[0].connectorVersion, "1.2.3");
  assert.equal(state.connectors[0].t3Version, "0.0.32");
  assert.equal(state.connectors[0].capabilities.length, 128);
  assert.equal(state.environments[0].providerCatalogue.source, "connector-hello");
  assert.equal(state.environments[0].providerCatalogue.instances[0].instanceId, "codex");
  assert.equal(state.environments[0].providerCatalogue.instances[0].models[0].slug, "gpt-5");
  assert.equal(JSON.stringify(state).includes(secretMarker), false);

  const heartbeat = await service.fetch(request("/v1/internal/connector-events", {
    eventVersion: 1,
    environmentId: environment.id,
    connectorId: enrolled.connector.id,
    connectionId: "connection_1",
    occurredAt: occurredAt + 1,
    kind: "connector.heartbeat",
    body: { t3Health: "ready", activeRequests: 4, queueDepth: 2 },
  }));
  assert.equal(heartbeat.status, 202);
  state = store.exportState();
  assert.equal(state.connectors[0].activeRequests, 4);
  assert.equal(state.connectors[0].queueDepth, 2);

  const disconnected = await service.fetch(request("/v1/internal/connector-events", {
    eventVersion: 1,
    environmentId: environment.id,
    connectorId: enrolled.connector.id,
    connectionId: "connection_1",
    occurredAt: occurredAt + 2,
    kind: "connector.disconnected",
    body: { reason: "heartbeat_timeout", accessToken: secretMarker },
  }));
  assert.equal(disconnected.status, 202);
  state = store.exportState();
  assert.equal(state.connectors[0].status, "offline");
  assert.equal(state.connectors[0].lastDisconnectReason, "heartbeat_timeout");
  assert.equal(JSON.stringify(state).includes(secretMarker), false);
});

test("T3 provider readiness survives connector hello and cloud projection without disclosing authentication data", async () => {
  const { store, environment, enrolled } = await fixture();
  const privateMarker = "private-provider-diagnostic-or-credential";
  const providers = [
    { instanceId: "codex", displayName: "Codex", status: "ready", enabled: true, installed: true,
      auth: { status: "authenticated", email: privateMarker, token: privateMarker, label: privateMarker },
      models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", credential: privateMarker }],
      message: privateMarker, accessToken: privateMarker },
    { instanceId: "disabled", status: "ready", enabled: false, installed: true,
      auth: { status: "authenticated" }, models: [{ slug: "disabled-model" }] },
    { instanceId: "unauthenticated", status: "ready", enabled: true, installed: true,
      auth: { status: "unauthenticated", message: privateMarker }, models: [{ slug: "login-required-model" }] },
    { instanceId: "unknown", enabled: true, installed: true, models: [{ slug: "unknown-model" }] },
    { instanceId: "malformed", status: privateMarker, enabled: "true", installed: "true",
      auth: { status: privateMarker }, models: [{ slug: "malformed-model" }] },
  ];
  const connector = new ConnectorClient({
    state: { connectorId: enrolled.connector.id, environmentId: environment.id, t3AccessToken: "test-local-token" },
    t3: { environmentInfo: async () => ({ serverVersion: "0.1.1" }), providerCatalogue: async () => providers },
    WebSocketImpl: class {}, logger: { log() {}, error() {} },
  });
  const hello = await connector.buildHello("catalogue_connection");
  assert.equal(hello.body.providerCatalogue[0].status, "ready");
  assert.equal(hello.body.providerCatalogue[0].auth.status, "authenticated");
  assert.equal(hello.body.providerCatalogue[0].label, "Codex");
  assert.equal(JSON.stringify(hello.body.providerCatalogue).includes(privateMarker), false,
    "the local connector must discard raw login details and diagnostic messages");
  // Independently test the cloud boundary against a connector sending additional private fields.
  hello.body.providerCatalogue[0].auth.token = privateMarker;
  hello.body.providerCatalogue[0].auth.email = privateMarker;
  hello.body.providerCatalogue[0].message = privateMarker;
  const service = createConnectorInternalService({ store, ticketAudience: AUDIENCE });
  const response = await service.fetch(request("/v1/internal/connector-events", {
    eventVersion: 1, environmentId: environment.id, connectorId: enrolled.connector.id,
    connectionId: "catalogue_connection", occurredAt: Date.now(), kind: "connector.hello", body: hello.body,
  }));
  assert.equal(response.status, 202);
  const catalogue = store.exportState().environments[0].providerCatalogue;
  const harnesses = extractHarnesses({ projects: [], threads: [] }, { catalogue });
  const codex = harnesses.find((entry) => entry.instanceId === "codex");
  assert.equal(codex.available, true);
  assert.equal(codex.status, "ready");
  assert.equal(codex.models[0].slug, "gpt-6.1-sol");
  assert.deepEqual(resolveLatestModelSelection({ harnesses }), {
    instanceId: "codex", model: "gpt-6.1-sol", options: [],
  });
  for (const instanceId of ["disabled", "unauthenticated", "unknown", "malformed"]) {
    assert.equal(harnesses.find((entry) => entry.instanceId === instanceId).available, false);
  }
  assert.equal(harnesses.find((entry) => entry.instanceId === "unknown").status, "unknown");
  assert.equal(harnesses.find((entry) => entry.instanceId === "unknown").auth.status, "unknown");
  assert.equal(JSON.stringify(catalogue).includes(privateMarker), false);
});

// Two projections in series each dropped `capabilities.optionDescriptors` silently: the connector's
// hello, then this sanitizer, which rebuilt every model as {id, name}. The connector half is covered
// in packages/connector/test/model-options.test.mjs; this is the gateway half, and the two must both
// exist or the deployed managed-cloud feature is dead while every local test stays green.
async function sendHello(body) {
  const { store, environment, enrolled } = await fixture();
  const service = createConnectorInternalService({ store, ticketAudience: AUDIENCE });
  const response = await service.fetch(request("/v1/internal/connector-events", {
    eventVersion: 1, environmentId: environment.id, connectorId: enrolled.connector.id,
    connectionId: "descriptor_connection", occurredAt: Date.now(), kind: "connector.hello", body,
  }));
  assert.equal(response.status, 202);
  return store.exportState().environments[0].providerCatalogue;
}

// The persisted catalogue is the gateway's normalised form: a model's `options` are descriptors and
// each descriptor's value list is `choices`.
const choiceIds = (descriptor) => descriptor.choices.map((choice) => choice.id);

test("captured Codex and Claude option descriptors survive the hello, with readiness and no credentials", async () => {
  const connector = new ConnectorClient({
    state: { connectorId: "con", environmentId: "env", t3AccessToken: "token" },
    t3: { environmentInfo: async () => ({ version: "0.0.32" }), providerCatalogue: async () => captured },
    WebSocketImpl: class {}, logger: { log() {}, error() {} },
  });
  const hello = await connector.buildHello("connection");
  const catalogue = await sendHello(hello.body);

  const codexModel = catalogue.instances.find((i) => i.instanceId === "codex").models.find((m) => m.slug === "gpt-5.6-sol");
  const reasoning = codexModel.options.find((o) => o.id === "reasoningEffort");
  assert.deepEqual(choiceIds(reasoning), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(reasoning.currentValue, "low");
  assert.equal(codexModel.options.find((o) => o.id === "serviceTier").choices.find((o) => o.id === "priority").description, "1.5x speed, increased usage");
  const claudeModel = catalogue.instances.find((i) => i.instanceId === "claudeAgent").models.find((m) => m.slug === "claude-fable-5");
  assert.deepEqual(choiceIds(claudeModel.options.find((o) => o.id === "effort")), ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"]);
  assert.equal(claudeModel.options.find((o) => o.id === "effort").choices.find((o) => o.id === "high").isDefault, true);

  // Every captured descriptor of every model, value lists included, not just the two spot checks.
  for (const provider of captured) for (const model of provider.models) {
    const sent = catalogue.instances.find((i) => i.instanceId === provider.instanceId).models.find((m) => m.slug === model.slug);
    const raw = model.capabilities?.optionDescriptors ?? [];
    assert.deepEqual(sent.options.map((o) => o.id), raw.map((o) => o.id), `${provider.instanceId}/${model.slug}`);
    for (const descriptor of raw.filter((o) => o.type === "select")) {
      assert.deepEqual(choiceIds(sent.options.find((o) => o.id === descriptor.id)), descriptor.options.map((o) => o.id));
    }
  }

  // The readiness/auth/runtimeKind contract is unchanged, and nothing private rides along.
  const harnesses = extractHarnesses({ projects: [], threads: [] }, { catalogue });
  for (const provider of captured) {
    const harness = harnesses.find((h) => h.instanceId === provider.instanceId);
    const instance = catalogue.instances.find((i) => i.instanceId === provider.instanceId);
    assert.equal(instance.status, provider.status);
    assert.equal(instance.enabled, provider.enabled);
    assert.equal(instance.installed, provider.installed);
    assert.equal(instance.auth.status, provider.auth.status === "authenticated" ? "authenticated" : "unknown");
    assert.equal(harness.status, provider.status);
  }
  const wire = JSON.stringify(catalogue);
  for (const provider of captured) {
    for (const secret of [provider.auth?.label, provider.auth?.type, provider.version, provider.message]) {
      if (typeof secret === "string" && secret.length > 3) assert.equal(wire.includes(secret), false, `leaked ${secret}`);
    }
  }
  // The selection path the owner uses: ultra is offered by the catalogue, so it validates.
  assert.equal(validateModelSelection({ instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "ultra" }] }, harnesses), null);
  assert.ok(validateModelSelection({ instanceId: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "not-a-level" }] }, harnesses));
});

test("a direct runtime keeps runtimeKind without a fabricated authentication flag, and unknown health stays unknown", async () => {
  const catalogue = await sendHello({ providerCatalogue: [
    { id: "native", runtimeKind: "direct", status: "ready", enabled: true, installed: true, auth: { status: "unknown" },
      models: [{ id: "default", label: "Default", capabilities: { optionDescriptors: [{ id: "effort", type: "select", options: [{ id: "low" }] }] } }] },
    { id: "silent", enabled: true, installed: true, models: [{ id: "m" }] },
    { id: "odd", status: { nested: true }, auth: { status: "pwned" }, enabled: "yes", models: [] },
  ] });
  const [native, silent, odd] = catalogue.instances;
  assert.equal(native.runtimeKind, "direct");
  assert.equal(native.auth.status, "unknown");
  assert.deepEqual(choiceIds(native.models[0].options[0]), ["low"]);
  assert.equal(silent.status, "unknown"); assert.equal(silent.auth.status, "unknown");
  assert.deepEqual(silent.models[0].options, [], "no descriptors means no options, not an invented control");
  assert.equal(odd.status, "unknown"); assert.equal(odd.enabled, false);
});

test("hello descriptors are rebuilt field by field: bounded, ids never clipped, private fields dropped", async () => {
  const long = "x".repeat(121);
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
  const marker = "private-descriptor-credential";
  const catalogue = await sendHello({ providerCatalogue: [{ id: "p", status: "ready", enabled: true, installed: true, auth: { status: "authenticated" }, models: [{
    id: "m", name: "M", capabilities: { optionDescriptors: [
      { id: "ok", label: "L".repeat(500), type: "weird", currentValue: "o1", description: "D".repeat(500), token: marker, status: marker, options: many.map((o) => ({ ...o, apiKey: marker })) },
      { id: long, label: "dropped: id too long", type: "select", options: [{ id: "a" }] },
      { id: "ok", label: "duplicate id", type: "select", options: [{ id: "a" }] },
      { id: "badchoice", type: "select", options: [{ id: "c".repeat(201) }, { id: "" }, { id: "good", label: "Good", isDefault: true }, { id: "good" }, { id: "y".repeat(200) }] },
      { id: "empty", type: "select", options: [] },
      { id: "flag", label: "Flag", type: "boolean", currentValue: true },
      { id: "badcurrent", type: "select", currentValue: "not-offered", options: [{ id: "a" }] },
      { id: "alias", type: "select", choices: [{ id: "one" }, { id: "two" }] },
      null, "junk",
      ...Array.from({ length: 30 }, (_, i) => ({ id: `extra${i}`, type: "boolean" })),
    ] },
  }] }] });
  const options = catalogue.instances[0].models[0].options;
  assert.ok(options.length <= 16);
  const ok = options.find((o) => o.id === "ok");
  assert.equal(ok.type, "select", "an unknown type is treated as select");
  assert.equal(ok.label.length, 120); assert.equal(ok.description.length, 240);
  assert.equal(ok.choices.length, 32);
  assert.equal(ok.currentValue, "o1");
  assert.equal(options.some((o) => o.id.startsWith("x")), false, "an over-long descriptor id is dropped, not clipped");
  assert.equal(options.filter((o) => o.id === "ok").length, 1);
  const badchoice = options.find((o) => o.id === "badchoice");
  assert.deepEqual(choiceIds(badchoice), ["good", "y".repeat(200)], "an over-long choice id is dropped, not clipped");
  assert.equal(badchoice.choices[0].isDefault, true);
  assert.equal(options.some((o) => o.id === "empty"), false);
  assert.equal(options.find((o) => o.id === "flag").type, "boolean");
  assert.equal(options.find((o) => o.id === "flag").currentValue, true);
  assert.equal(options.find((o) => o.id === "badcurrent").currentValue, null);
  assert.deepEqual(options.find((o) => o.id === "alias").choices.map((c) => c.id), ["one", "two"], "`choices` is accepted as an alias for `options`");
  assert.equal(JSON.stringify(catalogue).includes(marker), false);
});

test("service event sink enforces connector-to-environment binding", async () => {
  const { store, enrolled } = await fixture();
  const service = createConnectorInternalService({ store, ticketAudience: AUDIENCE });
  const response = await service.fetch(request("/v1/internal/connector-events", {
    eventVersion: 1,
    environmentId: "env_wrong",
    connectorId: enrolled.connector.id,
    connectionId: "connection_1",
    occurredAt: Date.now(),
    kind: "connector.heartbeat",
    body: { activeRequests: 0, queueDepth: 0 },
  }));
  assert.equal(response.status, 404);
});

test("stale and duplicate connector presence events cannot overwrite newer truth", async () => {
  const { store, environment, enrolled } = await fixture();
  const service = createConnectorInternalService({ store, ticketAudience: AUDIENCE });
  const base = {
    eventVersion: 1,
    environmentId: environment.id,
    connectorId: enrolled.connector.id,
    connectionId: "connection_new",
  };
  const heartbeat = request("/v1/internal/connector-events", {
    ...base,
    occurredAt: 200,
    kind: "connector.heartbeat",
    body: { t3Health: "ready", activeRequests: 3, queueDepth: 1 },
  });
  assert.equal((await service.fetch(heartbeat)).status, 202);

  const duplicate = request("/v1/internal/connector-events", {
    ...base,
    occurredAt: 200,
    kind: "connector.heartbeat",
    body: { t3Health: "error", activeRequests: 9, queueDepth: 9 },
  });
  assert.equal((await service.fetch(duplicate)).status, 202);
  const staleDisconnect = request("/v1/internal/connector-events", {
    ...base,
    connectionId: "connection_old",
    occurredAt: 100,
    kind: "connector.disconnected",
    body: { reason: "old_socket_closed" },
  });
  assert.equal((await service.fetch(staleDisconnect)).status, 202);

  const connector = store.exportState().connectors[0];
  assert.equal(connector.status, "online");
  assert.equal(connector.lastT3Health, "ready");
  assert.equal(connector.activeRequests, 3);
  assert.equal(connector.lastConnectionId, "connection_new");
});

test("the internal service is not mounted on the public Node bearer-auth route chain", async (t) => {
  const { server } = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/internal/connectors/tickets/consume`, {
    method: "POST",
    headers: {
      authorization: "Bearer public-platform-token-cannot-cross-realms",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ticket: "x".repeat(32), audience: AUDIENCE, now: Date.now() }),
  });
  assert.equal(response.status, 404);
  await response.arrayBuffer();
});

async function fixture() {
  const store = createMemoryStore();
  const environment = await store.upsertEnvironment({
    userId: "user_1",
    label: "Studio Mac",
    transportMode: "connector",
    scopes: ["orchestration:read", "orchestration:operate"],
    status: "paired",
  });
  const enrolled = await store.createConnector({
    userId: "user_1",
    environmentId: environment.id,
    scopes: ["connector:connect", "t3:proxy"],
    capabilities: [],
  });
  return { store, environment, enrolled };
}

function request(path, body) {
  return new Request(`https://connector-auth.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
