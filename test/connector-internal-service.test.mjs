import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createConnectorInternalService } from "../src/connectorInternalService.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { ConnectorClient } from "../packages/connector/src/connector.mjs";
import { extractHarnesses, resolveLatestModelSelection } from "../src/t3Harness.mjs";

const AUDIENCE = "agent-controller-connectors";

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
