import "./support/closeEvent.mjs";

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConnectorClient } from "../src/connector.mjs";
import { createBoundedFileLogger } from "../src/fileLogger.mjs";
import { MAX_FRAME_BYTES, MAX_IN_FLIGHT } from "../src/protocol.mjs";

const baseState = {
  server: "https://cloud.example",
  connectorId: "connector_resilience",
  environmentId: "environment_resilience",
  secret: "standing-secret",
  t3AccessToken: "t3-secret",
};

test("connector enforces 32 in-flight requests and returns stable backpressure", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let effects = 0;
  const connector = connectorWith({
    snapshot: async () => {
      effects += 1;
      await gate;
      return { ok: true };
    },
  });
  const sent = [];
  const socket = { send: (value) => sent.push(JSON.parse(value)) };
  const active = [];
  for (let index = 0; index < MAX_IN_FLIGHT; index += 1) {
    active.push(connector.onMessage(socket, requestFrame(index)));
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connector.inFlight.size, MAX_IN_FLIGHT);
  assert.equal(effects, MAX_IN_FLIGHT);

  await connector.onMessage(socket, requestFrame(MAX_IN_FLIGHT));
  const rejected = sent.find((frame) => frame.body.requestId === `request_${MAX_IN_FLIGHT}`);
  assert.deepEqual(
    { type: rejected?.type, code: rejected?.body.code, retryable: rejected?.body.retryable },
    { type: "response.failed", code: "connector_backpressure", retryable: true },
  );

  release();
  await Promise.all(active);
  assert.equal(connector.inFlight.size, 0);
  assert.equal(sent.filter((frame) => frame.type === "response.completed").length, MAX_IN_FLIGHT);
});

test("cancellation wins over a late local effect and duplicate delivery reuses the terminal result", async () => {
  let effects = 0;
  let release;
  const lateEffect = new Promise((resolve) => { release = resolve; });
  const connector = connectorWith({
    dispatch: async () => {
      effects += 1;
      return await lateEffect;
    },
  });
  const sent = [];
  const socket = { send: (value) => sent.push(JSON.parse(value)) };
  const originalText = requestFrame(1, { method: "dispatch", idempotencyKey: "cancel-once" });
  const original = JSON.parse(originalText);
  const running = connector.onMessage(socket, originalText);
  await new Promise((resolve) => setImmediate(resolve));
  await connector.onMessage(socket, JSON.stringify({
    protocolVersion: 1,
    type: "cancel",
    connectionId: "connection_resilience",
    body: { requestId: original.body.requestId, reason: "caller_cancelled" },
  }));
  await running;
  const terminal = sent.findLast((frame) => frame.body.requestId === original.body.requestId);
  assert.deepEqual(
    { type: terminal?.type, code: terminal?.body.code, retryable: terminal?.body.retryable },
    { type: "response.failed", code: "request_cancelled", retryable: true },
  );

  await connector.onMessage(socket, JSON.stringify({
    ...original,
    body: { ...original.body, requestId: "request_cancel_replay" },
  }));
  assert.equal(effects, 1);
  assert.equal(sent.findLast((frame) => frame.body.requestId === "request_cancel_replay")?.body.code, "request_cancelled");
  release({ tooLate: true });
});

test("reconnect storm stays serial, obtains fresh tickets, and respects the backoff cap", async () => {
  const failureCount = 20;
  let sockets = 0;
  let tickets = 0;
  const delays = [];
  class StormSocket extends EventTarget {
    constructor() {
      super();
      this.number = ++sockets;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(value) {
      const frame = JSON.parse(value);
      if (frame.type !== "hello") return;
      if (this.number <= failureCount) {
        queueMicrotask(() => this.dispatchEvent(new CloseEvent("close", { code: 1012, reason: "rollover" })));
        return;
      }
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
        protocolVersion: 1,
        type: "welcome",
        connectionId: frame.connectionId,
        body: {
          serverTime: new Date().toISOString(),
          heartbeatIntervalMs: 20_000,
          maxFrameBytes: MAX_FRAME_BYTES,
          maxInFlight: MAX_IN_FLIGHT,
        },
      }) })));
    }
    close(code = 1000, reason = "") {
      queueMicrotask(() => this.dispatchEvent(new CloseEvent("close", { code, reason })));
    }
  }
  const connector = new ConnectorClient({
    state: { ...baseState },
    t3: stubT3(),
    WebSocketImpl: StormSocket,
    fetchImpl: async () => Response.json({ ticket: `ticket_${++tickets}` }, { status: 201 }),
    logger: quietLogger,
    random: () => 1,
    sleep: async (delay) => { delays.push(delay); },
    minReconnectMs: 5,
    maxReconnectMs: 40,
  });
  await connector.run({ once: true });
  assert.equal(sockets, failureCount + 1);
  assert.equal(tickets, failureCount + 1);
  assert.equal(delays.length, failureCount);
  assert.deepEqual(delays.slice(0, 5), [5, 10, 20, 40, 40]);
  assert.ok(delays.every((delay) => delay >= 5 && delay <= 40));
});

test("managed logs are permissioned, line-bounded, rotated, and redact connector credentials", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "next-coder-resilience-log-"));
  t.after(async () => await rm(scratch, { recursive: true, force: true }));
  const path = join(scratch, "connector.log");
  const logger = createBoundedFileLogger(path, {
    maxBytes: 18 * 1024,
    secrets: ["standing-secret", "t3-secret", "one-time-ticket"],
  });
  logger.error({ authorization: "Connector connector_resilience.standing-secret", token: "t3-secret" });
  logger.error(`one-time-ticket Bearer t3-secret ${"x".repeat(32 * 1024)}`);
  logger.log("y".repeat(4 * 1024));
  logger.log("rollover marker");
  await logger.flush();

  const current = await readFile(path, "utf8");
  const rotated = await readFile(`${path}.1`, "utf8");
  const combined = `${current}\n${rotated}`;
  for (const secret of ["standing-secret", "t3-secret", "one-time-ticket"]) {
    assert.equal(combined.includes(secret), false);
  }
  assert.match(combined, /REDACTED/);
  assert.match(combined, /TRUNCATED/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.ok((await stat(path)).size <= 18 * 1024);
  assert.ok((await stat(`${path}.1`)).size <= 18 * 1024);
});

function connectorWith(overrides = {}) {
  const connector = new ConnectorClient({
    state: { ...baseState },
    t3: stubT3(overrides),
    WebSocketImpl: class {},
    fetchImpl: async () => {},
    logger: quietLogger,
  });
  connector.connectionId = "connection_resilience";
  return connector;
}

function requestFrame(index, { method = "snapshot", idempotencyKey = `idempotency_${index}` } = {}) {
  return JSON.stringify({
    protocolVersion: 1,
    type: "request",
    connectionId: "connection_resilience",
    body: {
      requestId: `request_${index}`,
      idempotencyKey,
      method,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      payload: method === "dispatch" ? { command: { type: "thread.session.stop" } } : {},
    },
  });
}

function stubT3(overrides = {}) {
  return {
    environmentInfo: async () => ({ version: "0.0.32" }),
    providerCatalogue: async () => [],
    snapshot: async () => ({}),
    threadDetail: async () => ({}),
    dispatch: async () => ({}),
    callRpc: async () => ({}),
    openThreadStream: () => ({ close() {} }),
    ...overrides,
  };
}

const quietLogger = { log() {}, error() {} };
