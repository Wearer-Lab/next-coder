import "./support/closeEvent.mjs";

import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorClient } from "../src/connector.mjs";

const state = { server: "https://cloud.example", connectorId: "con", environmentId: "env", secret: "secret", t3AccessToken: "token" };

test("request lifecycle sends accepted and terminal result and deduplicates effects", async () => {
  let dispatches = 0;
  const t3 = stubT3({ dispatch: async () => ({ sequence: ++dispatches }) });
  const connector = new ConnectorClient({ state, t3, WebSocketImpl: class {}, fetchImpl: async () => {}, logger: quietLogger });
  connector.connectionId = "connection";
  const sent = [];
  const socket = { send: (value) => sent.push(JSON.parse(value)) };
  const request = { protocolVersion: 1, type: "request", connectionId: "connection", body: { requestId: "req1", idempotencyKey: "same", method: "dispatch", deadlineAt: new Date(Date.now() + 30_000).toISOString(), payload: { command: { type: "thread.session.stop" } } } };
  await connector.onMessage(socket, JSON.stringify(request));
  await connector.onMessage(socket, JSON.stringify({ ...request, body: { ...request.body, requestId: "req2" } }));
  assert.equal(dispatches, 1);
  assert.deepEqual(sent.map((frame) => frame.type), ["response.accepted", "response.completed", "response.completed"]);
  assert.equal(sent.at(-1).body.requestId, "req2");
});

test("concurrent duplicate delivery shares one local effect", async () => {
  let release;
  let dispatches = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const t3 = stubT3({ dispatch: async () => { dispatches += 1; await gate; return { sequence: 1 }; } });
  const connector = new ConnectorClient({ state: { ...state }, t3, WebSocketImpl: class {}, fetchImpl: async () => {}, logger: quietLogger });
  connector.connectionId = "connection";
  const sent = [];
  const socket = { send: (value) => sent.push(JSON.parse(value)) };
  const request = { protocolVersion: 1, type: "request", connectionId: "connection", body: { requestId: "req1", idempotencyKey: "same-pending", method: "dispatch", deadlineAt: new Date(Date.now() + 30_000).toISOString(), payload: { command: { type: "thread.session.stop" } } } };
  const first = connector.onMessage(socket, JSON.stringify(request));
  await new Promise((resolve) => setImmediate(resolve));
  const second = connector.onMessage(socket, JSON.stringify({ ...request, body: { ...request.body, requestId: "req2" } }));
  release();
  await Promise.all([first, second]);
  assert.equal(dispatches, 1);
  assert.equal(sent.filter((frame) => frame.type === "response.completed").length, 2);
});

test("terminal response waits for the process-restart idempotency write barrier", async () => {
  let releasePersistence;
  const persistenceGate = new Promise((resolve) => { releasePersistence = resolve; });
  let persistedState = null;
  let effects = 0;
  const connector = new ConnectorClient({
    state: { ...state, completedRequests: [] },
    t3: stubT3({ dispatch: async () => ({ sequence: ++effects }) }),
    WebSocketImpl: class {},
    fetchImpl: async () => {},
    logger: quietLogger,
    persistState: async (nextState) => {
      await persistenceGate;
      persistedState = structuredClone(nextState);
    },
  });
  connector.connectionId = "connection";
  const sent = [];
  const socket = { send: (value) => sent.push(JSON.parse(value)) };
  const request = {
    protocolVersion: 1,
    type: "request",
    connectionId: "connection",
    body: {
      requestId: "req-barrier-1",
      idempotencyKey: "durable-effect",
      method: "dispatch",
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      payload: { command: { type: "thread.session.stop" } },
    },
  };

  const pending = connector.onMessage(socket, JSON.stringify(request));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.map((frame) => frame.type), ["response.accepted"]);
  assert.equal(persistedState, null);

  releasePersistence();
  await pending;
  assert.deepEqual(sent.map((frame) => frame.type), ["response.accepted", "response.completed"]);
  assert.equal(persistedState.completedRequests.length, 1);

  const restarted = new ConnectorClient({
    state: persistedState,
    t3: stubT3({ dispatch: async () => ({ sequence: ++effects }) }),
    WebSocketImpl: class {},
    fetchImpl: async () => {},
    logger: quietLogger,
  });
  restarted.connectionId = "connection-restarted";
  await restarted.onMessage(socket, JSON.stringify({
    ...request,
    connectionId: "connection-restarted",
    body: { ...request.body, requestId: "req-barrier-2" },
  }));
  assert.equal(effects, 1);
  assert.equal(sent.at(-1).type, "response.completed");
  assert.equal(sent.at(-1).body.requestId, "req-barrier-2");
});

test("active thread lease reconnects to T3 after a local stream drop and resumes from the latest cursor", async () => {
  const streams = [];
  const connector = new ConnectorClient({
    state: { ...state },
    t3: stubT3({
      openThreadStream: (input, callbacks) => {
        const stream = { input, callbacks, closed: false, close() { this.closed = true; } };
        streams.push(stream);
        return stream;
      },
    }),
    WebSocketImpl: class {},
    fetchImpl: async () => {},
    logger: quietLogger,
    random: () => 1,
    minSubscriptionReconnectMs: 1,
    maxSubscriptionReconnectMs: 1,
  });
  connector.connectionId = "connection";
  const sent = [];
  const socket = { send: (value) => sent.push(JSON.parse(value)) };
  const subscribe = {
    protocolVersion: 1,
    type: "subscribe",
    connectionId: "connection",
    body: {
      leaseId: "lease-restart",
      threadId: "thread-restart",
      cursor: 40,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  };

  await connector.onMessage(socket, JSON.stringify(subscribe));
  assert.equal(streams.length, 1);
  assert.equal(streams[0].input.afterSequence, 40);
  streams[0].callbacks.onItem({ kind: "event", event: { id: "event-41", sequence: 41 } });
  streams[0].callbacks.onClose({ reason: "socket-closed", error: Object.assign(new Error("T3 restarted"), { code: "T3_SOCKET_CLOSED" }) });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(streams.length, 2);
  assert.equal(streams[1].input.afterSequence, 41);
  streams[1].callbacks.onItem({ kind: "snapshot", snapshot: { thread: { id: "thread-restart" } } });
  assert.deepEqual(sent.map((frame) => frame.type), ["event", "snapshot"]);
  assert.equal(sent[1].body.resetReason, "resume-gap");

  connector.unsubscribe("lease-restart");
  assert.equal(streams[1].closed, true);
});

test("closing a thread lease cancels a pending local-stream reconnect", async () => {
  const streams = [];
  const connector = new ConnectorClient({
    state: { ...state },
    t3: stubT3({
      openThreadStream: (input, callbacks) => {
        const stream = { input, callbacks, close() {} };
        streams.push(stream);
        return stream;
      },
    }),
    WebSocketImpl: class {},
    fetchImpl: async () => {},
    logger: quietLogger,
    minSubscriptionReconnectMs: 20,
    maxSubscriptionReconnectMs: 20,
  });
  const socket = { send() {} };
  await connector.onMessage(socket, JSON.stringify({
    protocolVersion: 1,
    type: "subscribe",
    connectionId: "connection",
    body: {
      leaseId: "lease-close",
      threadId: "thread-close",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  }));
  streams[0].callbacks.onClose({ reason: "socket-closed", error: new Error("local restart") });
  connector.unsubscribe("lease-close");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(streams.length, 1);
});

test("cloud welcome produces heartbeat and graceful once shutdown", async () => {
  const sockets = [];
  class MockSocket extends EventTarget {
    constructor() { super(); this.sent = []; sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send(value) {
      this.sent.push(JSON.parse(value));
      if (this.sent.at(-1).type === "hello") queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ protocolVersion: 1, type: "welcome", connectionId: "server-connection", body: { serverTime: new Date().toISOString(), heartbeatIntervalMs: 1000, maxFrameBytes: 1048576, maxInFlight: 32 } }) })));
    }
    close(code = 1000) { queueMicrotask(() => this.dispatchEvent(new CloseEvent("close", { code }))); }
  }
  const fetchImpl = async () => new Response(JSON.stringify({ ticket: "socket-ticket" }), { status: 201 });
  const rotatingState = {
    ...state,
    credentialRotation: {
      id: "rotation-safe-id",
      pendingSecret: "never-in-frame",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      phase: "activated",
    },
  };
  const connector = new ConnectorClient({ state: rotatingState, t3: stubT3(), WebSocketImpl: MockSocket, fetchImpl, logger: quietLogger });
  await connector.run({ once: true });
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].sent[0].type, "hello");
  assert.equal(sockets[0].sent.some((frame) => frame.type === "heartbeat"), true);
  const rotation = sockets[0].sent.find((frame) => frame.type === "credential.rotated");
  assert.equal(rotation.body.challenge, "rotation-safe-id");
  assert.equal(JSON.stringify(rotation).includes("never-in-frame"), false);
  assert.ok(rotatingState.credentialRotation.acknowledgedAt);
});

test("a welcomed cloud socket stays online beyond the handshake deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let socket;
  class MockSocket extends EventTarget {
    constructor() { super(); socket = this; this.sent = []; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send(value) {
      this.sent.push(JSON.parse(value));
      if (this.sent.at(-1).type === "hello") queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ protocolVersion: 1, type: "welcome", connectionId: "healthy", body: { serverTime: new Date().toISOString(), heartbeatIntervalMs: 1000, maxFrameBytes: 1048576, maxInFlight: 32 } }) })));
    }
    close(code = 1000) { queueMicrotask(() => this.dispatchEvent(new CloseEvent("close", { code }))); }
  }
  const connector = new ConnectorClient({ state: { ...state }, t3: stubT3(), WebSocketImpl: MockSocket,
    fetchImpl: async () => Response.json({ ticket: "fixture-ticket" }), logger: quietLogger });
  let welcome;
  const welcomed = new Promise((resolve) => { welcome = resolve; });
  let failure = null;
  const connection = connector.connectOnce({ onWelcome: welcome }).catch((error) => { failure = error; });
  await welcomed;
  t.mock.timers.tick(20_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failure, null);
  assert.equal(connector.socket, socket);
  assert.ok(socket.sent.filter((frame) => frame.type === "heartbeat").length >= 2);
  connector.stop();
  await connection;
});

test("cloud deployment close reconnects with a new ticket", async () => {
  let created = 0;
  class MockSocket extends EventTarget {
    constructor() {
      super();
      this.number = ++created;
      this.sent = [];
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(value) {
      this.sent.push(JSON.parse(value));
      if (this.sent.at(-1).type !== "hello") return;
      if (this.number === 1) queueMicrotask(() => this.dispatchEvent(new CloseEvent("close", { code: 1012 })));
      else queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ protocolVersion: 1, type: "welcome", connectionId: "second", body: { serverTime: new Date().toISOString(), heartbeatIntervalMs: 1000, maxFrameBytes: 1048576, maxInFlight: 32 } }) })));
    }
    close(code = 1000) { queueMicrotask(() => this.dispatchEvent(new CloseEvent("close", { code }))); }
  }
  let tickets = 0;
  const fetchImpl = async () => new Response(JSON.stringify({ ticket: `ticket-${++tickets}` }), { status: 201 });
  const connector = new ConnectorClient({ state: { ...state }, t3: stubT3(), WebSocketImpl: MockSocket, fetchImpl, logger: quietLogger, sleep: async () => {}, minReconnectMs: 1, maxReconnectMs: 1 });
  await connector.run({ once: true });
  assert.equal(created, 2);
  assert.equal(tickets, 2);
});

test("maintenance reconnects while revocation stops the connector", async () => {
  const connector = new ConnectorClient({ state: { ...state }, t3: stubT3(), WebSocketImpl: class {}, fetchImpl: async () => {}, logger: quietLogger });
  const closes = [];
  const socket = { close: (code, reason) => closes.push({ code, reason }), send() {} };
  await connector.onMessage(socket, JSON.stringify({ protocolVersion: 1, type: "shutdown", connectionId: "connection", body: { reason: "maintenance" } }));
  assert.equal(connector.stopped, false);
  assert.equal(closes[0].code, 1012);
  await connector.onMessage(socket, JSON.stringify({ protocolVersion: 1, type: "shutdown", connectionId: "connection", body: { reason: "revoked" } }));
  assert.equal(connector.stopped, true);
  assert.equal(closes[1].code, 1000);
});

test("hello reports missing local T3 authentication without running authenticated probes", async () => {
  let probes = 0;
  const connector = new ConnectorClient({
    state: { ...state, t3AccessToken: null },
    t3: stubT3({ capabilityProbe: async () => { probes += 1; throw new Error("token required"); } }),
    WebSocketImpl: class {},
    fetchImpl: async () => {},
    logger: quietLogger,
  });
  const hello = await connector.buildHello("connection");
  assert.equal(hello.body.t3Health, "auth_failed");
  assert.equal(probes, 0);
  assert.deepEqual(hello.body.capabilities, ["environmentInfo", "capabilityProbe"]);
});

function stubT3(overrides = {}) {
  return {
    environmentInfo: async () => ({ version: "0.0.32" }), providerCatalogue: async () => [], snapshot: async () => ({}),
    threadDetail: async () => ({}), dispatch: async () => ({ sequence: 1 }), callRpc: async () => ({}),
    openThreadStream: () => ({ close() {} }), ...overrides,
  };
}

const quietLogger = { log() {}, error() {} };

test("local transcription is advertised explicitly and never enters durable completed receipts", async () => {
  let effects = 0; let writes = 0;
  const connector = new ConnectorClient({ state: {...state, completedRequests:[], voice:{enabled:true}}, t3:stubT3(), WebSocketImpl:class {}, logger:quietLogger,
    localTranscriber:{health:async()=>({ready:true}), transcribe:async()=>({text:`private transcript ${++effects}`})},
    persistState:async()=>{writes++;} });
  assert.ok((await connector.buildHello()).body.capabilities.includes('media.transcribe'));
  connector.connectionId='connection';const sent=[];const socket={send:value=>sent.push(JSON.parse(value))};
  const request={protocolVersion:1,type:'request',connectionId:'connection',body:{requestId:'voice1',idempotencyKey:'voice-job',method:'media.transcribe',deadlineAt:new Date(Date.now()+10000).toISOString(),payload:{mediaId:'media1',jobId:'job1'}}};
  await connector.onMessage(socket,JSON.stringify(request));
  assert.equal(sent.at(-1).body.result.text,'private transcript 1');
  assert.equal(writes,0);assert.deepEqual(connector.state.completedRequests??[],[]);
  await connector.onMessage(socket,JSON.stringify({...request,body:{...request.body,requestId:'voice2'}}));
  assert.equal(effects,2,'settled transcript is recomputed, never read from a persisted receipt');
});
