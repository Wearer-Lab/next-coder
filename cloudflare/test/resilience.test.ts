import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBindings } from "../src/env";
import type { ConnectorTerminalResult, EnvironmentConnectorHub } from "../src/hub";
import {
  CONNECTOR_PROTOCOL_VERSION,
  MAX_CONNECTOR_FRAME_BYTES,
  MAX_IDEMPOTENCY_ENTRIES,
  MAX_PENDING_REQUESTS,
  MAX_TERMINAL_RESULT_BYTES,
  TERMINAL_RESULT_RETENTION_MS,
  type ConnectorHubEvent,
  type CloudRequestFrame,
  type CloudWelcomeFrame,
} from "../src/protocol";

const bindings = env as unknown as RuntimeBindings;
const origin = "https://nextcoder-resilience.test";
const MAX_SUBSCRIPTION_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

afterEach(async () => {
  vi.useRealTimers();
  await reset();
});

describe("CG-03 connector recovery resilience", () => {
  it("reconstructs pending state after eviction and accepts out-of-order terminal results", async () => {
    const environmentId = "environment_ordering";
    const { socket, welcome } = await connectSocket("connector_ordering", environmentId);
    const hub = hubFor(environmentId);
    await evictDurableObject(hub);
    const routed: CloudRequestFrame[] = [];
    for (const suffix of ["a", "b"]) {
      const message = nextMessage(socket);
      const response = await submit(environmentId, {
        requestId: `request_order_${suffix}`,
        idempotencyKey: `idempotency_order_${suffix}`,
        method: "snapshot",
        payload: { suffix },
      });
      expect(response.status).toBe(202);
      routed.push((await message) as CloudRequestFrame);
    }
    const duplicate = await submit(environmentId, {
      requestId: "request_order_duplicate",
      idempotencyKey: "idempotency_order_a",
      method: "snapshot",
      payload: { suffix: "must-not-dispatch" },
    });
    expect(duplicate.status).toBe(202);
    await expect(duplicate.json()).resolves.toMatchObject({
      requestId: "request_order_a",
      idempotencyKey: "idempotency_order_a",
    });

    for (const frame of [...routed].reverse()) {
      socket.send(JSON.stringify({
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        type: "response.completed",
        connectionId: welcome.connectionId,
        body: {
          requestId: frame.body.requestId,
          result: { suffix: (frame.body.payload as { suffix: string }).suffix },
          completedAt: new Date().toISOString(),
        },
      }));
    }

    await eventually(async () => {
      const [first, second] = await Promise.all([
        result(environmentId, "request_order_a"),
        result(environmentId, "request_order_b"),
      ]);
      return first.status === "completed" && second.status === "completed";
    });
    await expect(result(environmentId, "request_order_a")).resolves.toMatchObject({ result: { suffix: "a" } });
    await expect(result(environmentId, "request_order_b")).resolves.toMatchObject({ result: { suffix: "b" } });
    socket.close(1000, "test_complete");
  });

  it("rejects a stale connection result, then replays the same request identity to the replacement", async () => {
    const environmentId = "environment_stale_result";
    const first = await connectSocket("connector_stale_result", environmentId, "connection_old");
    const routedPromise = nextMessage(first.socket);
    expect((await submit(environmentId, {
      requestId: "request_stale_result",
      idempotencyKey: "idempotency_stale_result",
      method: "snapshot",
      payload: { privateMarker: "never-log-this" },
    })).status).toBe(202);
    await routedPromise;

    const shutdown = nextMessage(first.socket);
    const replacement = await connectSocketCollecting("connector_stale_result", environmentId, "connection_new");
    await expect(shutdown).resolves.toMatchObject({ type: "shutdown", body: { reason: "superseded" } });
    await eventually(async () => replacement.messages.some((frame) => frame.type === "request"));

    const staleClose = nextClose(replacement.socket);
    replacement.socket.send(JSON.stringify({
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "response.completed",
      connectionId: "connection_old",
      body: { requestId: "request_stale_result", result: { stale: true }, completedAt: new Date().toISOString() },
    }));
    await expect(staleClose).resolves.toMatchObject({ code: 4002, reason: "invalid_frame" });
    await expect(result(environmentId, "request_stale_result")).resolves.toMatchObject({ status: "dispatched" });

    const recovered = await connectSocketCollecting("connector_stale_result", environmentId, "connection_recovered");
    await eventually(async () => recovered.messages.some((frame) => frame.type === "request"));
    const replay = recovered.messages.find((frame) => frame.type === "request") as CloudRequestFrame;
    expect(replay.body).toMatchObject({
      requestId: "request_stale_result",
      idempotencyKey: "idempotency_stale_result",
      payload: { privateMarker: "never-log-this" },
    });
    recovered.socket.send(JSON.stringify({
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "response.completed",
      connectionId: recovered.welcome.connectionId,
      body: { requestId: replay.body.requestId, result: { recovered: true }, completedAt: new Date().toISOString() },
    }));
    await eventually(async () => (await result(environmentId, replay.body.requestId)).status === "completed");
    recovered.socket.close(1000, "test_complete");
  });

  it("keeps cancellation terminal when a late or duplicate result arrives", async () => {
    const environmentId = "environment_cancel_late";
    const { socket, welcome } = await connectSocket("connector_cancel_late", environmentId);
    const routed = nextMessage(socket);
    await submit(environmentId, {
      requestId: "request_cancel_late",
      idempotencyKey: "idempotency_cancel_late",
      method: "dispatch",
      payload: {},
    });
    await routed;
    const cancelFrame = nextMessage(socket);
    const cancelled = await internalFetch(environmentId, "/requests/request_cancel_late/cancel", { method: "POST" });
    expect(cancelled.status).toBe(200);
    await expect(cancelFrame).resolves.toMatchObject({ type: "cancel", body: { requestId: "request_cancel_late" } });

    const late = {
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "response.completed",
      connectionId: welcome.connectionId,
      body: { requestId: "request_cancel_late", result: { shouldBeIgnored: true }, completedAt: new Date().toISOString() },
    };
    socket.send(JSON.stringify(late));
    socket.send(JSON.stringify(late));
    await eventually(async () => (await result(environmentId, "request_cancel_late")).failure?.code === "connector_cancelled");
    await expect(result(environmentId, "request_cancel_late")).resolves.toMatchObject({
      status: "failed",
      failure: { code: "connector_cancelled", retryable: false },
    });
    socket.close(1000, "test_complete");
  });

  it("survives a bounded reconnect storm with one authoritative socket and stable replay identity", async () => {
    const environmentId = "environment_reconnect_storm";
    const connectorId = "connector_reconnect_storm";
    const first = await connectSocket(connectorId, environmentId, "storm_0");
    const request = nextMessage(first.socket);
    await submit(environmentId, {
      requestId: "request_storm",
      idempotencyKey: "idempotency_storm",
      method: "environmentInfo",
      payload: {},
      deadlineMs: 60_000,
    });
    await request;
    const subscribe = nextMessage(first.socket);
    const lease = await internalFetch(environmentId, "/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectorId,
        leaseId: "lease_storm",
        threadId: "thread_storm",
        cursor: 29,
        expiresAt: Date.now() + 60_000,
      }),
    });
    expect(lease.status).toBe(200);
    await subscribe;

    let previous = first.socket;
    let final: Awaited<ReturnType<typeof connectSocketCollecting>> | null = null;
    for (let index = 1; index <= 12; index += 1) {
      const superseded = nextClose(previous);
      final = await connectSocketCollecting(connectorId, environmentId, `storm_${index}`);
      await expect(superseded).resolves.toMatchObject({ code: 4001, reason: "superseded" });
      previous = final.socket;
    }
    if (!final) throw new Error("Reconnect storm did not establish a final connection.");
    await eventually(async () => final!.messages.some((frame) => frame.type === "request") && final!.messages.some((frame) => frame.type === "subscribe"));
    const replays = final.messages.filter((frame) => frame.type === "request") as CloudRequestFrame[];
    expect(replays).toHaveLength(1);
    expect(replays[0]?.body).toMatchObject({ requestId: "request_storm", idempotencyKey: "idempotency_storm" });
    expect(final.messages.filter((frame) => frame.type === "subscribe")).toHaveLength(1);
    expect(final.messages.find((frame) => frame.type === "subscribe")?.body).toMatchObject({
      leaseId: "lease_storm",
      threadId: "thread_storm",
      cursor: 29,
    });
    const status = await (await internalFetch(environmentId, "/status")).json() as { connectionId: string; status: string };
    expect(status).toMatchObject({ connectionId: "storm_12", status: "online" });
    final.socket.close(1000, "test_complete");
  });

  it("expires a thread lease without wall-clock sleeping", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-08-27T12:00:00.000Z");
    vi.setSystemTime(now);
    const environmentId = "environment_lease_expiry";
    const { socket } = await connectSocket("connector_lease_expiry", environmentId);
    const subscribe = nextMessage(socket);
    const opened = await internalFetch(environmentId, "/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectorId: "connector_lease_expiry",
        leaseId: "lease_expiry",
        threadId: "thread_expiry",
        expiresAt: now.getTime() + 10_000,
      }),
    });
    expect(opened.status).toBe(200);
    await subscribe;
    vi.setSystemTime(now.getTime() + 10_001);
    const expired = await internalFetch(environmentId, "/subscriptions/lease_expiry?after=0");
    expect(expired.status).toBe(410);
    await expect(expired.json()).resolves.toMatchObject({ error: "subscription_expired" });
    socket.close(1000, "test_complete");
  });
});

describe("CG-12 bounds and local performance budgets", () => {
  it("enforces the exact 32-request cloud backpressure limit and measures local acknowledgement latency", async () => {
    const environmentId = "environment_backpressure";
    const { socket } = await connectSocket("connector_backpressure", environmentId);
    const latencies: number[] = [];
    for (let index = 0; index < MAX_PENDING_REQUESTS; index += 1) {
      const startedAt = performance.now();
      const response = await submit(environmentId, {
        requestId: `request_pressure_${index}`,
        idempotencyKey: `idempotency_pressure_${index}`,
        method: "snapshot",
        payload: { index },
        deadlineMs: 60_000,
      });
      latencies.push(performance.now() - startedAt);
      expect(response.status).toBe(202);
    }
    const rejected = await submit(environmentId, {
      requestId: "request_pressure_rejected",
      idempotencyKey: "idempotency_pressure_rejected",
      method: "snapshot",
      payload: {},
    });
    expect(rejected.status).toBe(429);
    await expect(rejected.json()).resolves.toMatchObject({
      error: "connector_backpressure",
      retryable: true,
      maxPendingRequests: MAX_PENDING_REQUESTS,
    });
    expect(percentile(latencies, 0.95)).toBeLessThanOrEqual(2_000);
    socket.close(1000, "test_complete");
  });

  it("rejects oversize HTTP and WebSocket frames at the shared 1 MiB boundary", async () => {
    const environmentId = "environment_oversize";
    const { socket, welcome } = await connectSocket("connector_oversize", environmentId);
    const oversizedBody = JSON.stringify({
      requestId: "request_oversize",
      idempotencyKey: "idempotency_oversize",
      method: "dispatch",
      payload: { prompt: "x".repeat(MAX_CONNECTOR_FRAME_BYTES) },
    });
    expect(encoder.encode(oversizedBody).byteLength).toBeGreaterThan(MAX_CONNECTOR_FRAME_BYTES);
    const rejected = await internalFetch(environmentId, "/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversizedBody,
    });
    expect(rejected.status).toBe(413);
    await expect(rejected.json()).resolves.toMatchObject({ error: "payload_too_large" });

    const close = nextClose(socket);
    socket.send(JSON.stringify({
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "event",
      connectionId: welcome.connectionId,
      body: {
        eventId: "event_oversize",
        environmentId,
        payload: "x".repeat(MAX_CONNECTOR_FRAME_BYTES),
      },
    }));
    await expect(close).resolves.toMatchObject({ code: 4002, reason: "payload_too_large" });
  });

  it("evicts subscription items by byte budget as well as item count", async () => {
    const environmentId = "environment_buffer_bytes";
    const { socket, welcome } = await connectSocket("connector_buffer_bytes", environmentId);
    const subscribe = nextMessage(socket);
    await internalFetch(environmentId, "/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectorId: "connector_buffer_bytes",
        leaseId: "lease_buffer_bytes",
        threadId: "thread_buffer_bytes",
        expiresAt: Date.now() + 60_000,
      }),
    });
    await subscribe;
    const payload = "x".repeat(180 * 1024);
    for (let index = 1; index <= 8; index += 1) {
      socket.send(JSON.stringify({
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        type: "event",
        connectionId: welcome.connectionId,
        body: {
          eventId: `event_bytes_${index}`,
          environmentId,
          threadId: "thread_buffer_bytes",
          leaseId: "lease_buffer_bytes",
          cursor: index,
          payload: { index, payload },
        },
      }));
    }
    await eventually(async () => {
      const page = await (await internalFetch(environmentId, "/subscriptions/lease_buffer_bytes?after=0")).json() as SubscriptionPage;
      return page.items?.at(-1)?.value?.index === 8;
    });
    const page = await (await internalFetch(environmentId, "/subscriptions/lease_buffer_bytes?after=0")).json() as SubscriptionPage;
    const retainedBytes = page.items.reduce((total, item) => total + encoder.encode(JSON.stringify(item.value)).byteLength, 0);
    expect(retainedBytes).toBeLessThanOrEqual(MAX_SUBSCRIPTION_BYTES);
    expect(page.items.length).toBeLessThan(8);
    expect(page.items.at(-1)?.value.index).toBe(8);
    socket.close(1000, "test_complete");
  });

  it("keeps a terminal result for its private waiter while projecting metadata without user content", async () => {
    const environmentId = "environment_private_terminal";
    const privateMarker = "private-t3-result-never-queue-this";
    const failureDetailMarker = "private-provider-detail-never-queue-this";
    const { socket, welcome } = await connectSocket("connector_private_terminal", environmentId);
    const routed = nextMessage(socket);
    await submit(environmentId, {
      requestId: "request_private_terminal",
      idempotencyKey: "idempotency_private_terminal",
      method: "snapshot",
      payload: {},
    });
    await routed;

    const waiting = internalFetch(environmentId, "/requests/request_private_terminal?waitMs=1000");
    await new Promise((resolve) => setTimeout(resolve, 10));
    socket.send(JSON.stringify({
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "response.completed",
      connectionId: welcome.connectionId,
      body: {
        requestId: "request_private_terminal",
        result: { privateMarker, nested: { failureDetailMarker } },
        completedAt: new Date().toISOString(),
      },
    }));

    const direct = await waiting;
    expect(direct.status).toBe(200);
    await expect(direct.json()).resolves.toMatchObject({
      status: "completed",
      result: { privateMarker, nested: { failureDetailMarker } },
    });

    const failureRouted = nextMessage(socket);
    await submit(environmentId, {
      requestId: "request_private_failure",
      idempotencyKey: "idempotency_private_failure",
      method: "snapshot",
      payload: {},
    });
    await failureRouted;
    const failureWaiting = internalFetch(environmentId, "/requests/request_private_failure?waitMs=1000");
    await new Promise((resolve) => setTimeout(resolve, 10));
    socket.send(JSON.stringify({
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "response.failed",
      connectionId: welcome.connectionId,
      body: {
        requestId: "request_private_failure",
        code: "provider_error",
        retryable: false,
        detail: failureDetailMarker,
        failedAt: new Date().toISOString(),
      },
    }));
    const directFailure = await failureWaiting;
    await expect(directFailure.json()).resolves.toMatchObject({
      status: "failed",
      failure: { code: "provider_error", retryable: false, detail: failureDetailMarker },
    });

    const projected = await runInDurableObject(hubFor(environmentId), async (_instance, state) => {
      const events = await state.storage.list<ConnectorHubEvent>({ prefix: "outbox:" });
      return [...events.values()].filter((event) => event.kind === "connector.response"
        && isRecord(event.body)
        && (event.body.status === "completed" || event.body.status === "failed"));
    });
    const completedProjection = projected.find((event) => isRecord(event.body) && event.body.status === "completed");
    const failureProjection = projected.find((event) => isRecord(event.body) && event.body.status === "failed");
    expect(completedProjection?.body).toMatchObject({
      requestId: "request_private_terminal",
      status: "completed",
    });
    expect(completedProjection?.body).toHaveProperty("completedAt");
    expect(completedProjection?.body).toHaveProperty("durationMs");
    expect(completedProjection?.body).not.toHaveProperty("result");
    expect(completedProjection?.body).not.toHaveProperty("failure");
    expect(completedProjection?.body).not.toHaveProperty("idempotencyKey");
    expect(failureProjection?.body).toMatchObject({
      requestId: "request_private_failure",
      status: "failed",
      failureCode: "provider_error",
      retryable: false,
    });
    expect(failureProjection?.body).not.toHaveProperty("failure");
    expect(failureProjection?.body).not.toHaveProperty("result");
    expect(failureProjection?.body).not.toHaveProperty("idempotencyKey");
    expect(JSON.stringify(projected)).not.toContain(privateMarker);
    expect(JSON.stringify(projected)).not.toContain(failureDetailMarker);
    socket.close(1000, "test_complete");
  });

  it("evicts the oldest terminal result after the 1,000-entry retention bound", async () => {
    const hub = hubFor("environment_terminal_count");
    const state = await runInDurableObject(hub, async (instance, durableState) => {
      const now = Date.now();
      const index: Array<{ key: string; expiresAt: number }> = [];
      for (let start = 0; start < MAX_IDEMPOTENCY_ENTRIES; start += 100) {
        const values: Record<string, ConnectorTerminalResult> = {};
        for (let offset = start; offset < Math.min(start + 100, MAX_IDEMPOTENCY_ENTRIES); offset += 1) {
          const requestId = `request_count_${String(offset).padStart(4, "0")}`;
          const key = `terminal:${requestId}`;
          values[key] = terminalResult(requestId, now, { offset });
          index.push({ key, expiresAt: now + TERMINAL_RESULT_RETENTION_MS });
        }
        await durableState.storage.put(values);
      }
      await durableState.storage.put("terminal-index", index);
      await privateHub(instance).storeTerminal(terminalResult("request_count_newest", now, { newest: true }));
      const retained = await durableState.storage.get<Array<{ key: string; bytes?: number }>>("terminal-index");
      const oldest = await durableState.storage.get("terminal:request_count_0000");
      const second = await durableState.storage.get("terminal:request_count_0001");
      const newest = await durableState.storage.get("terminal:request_count_newest");
      return { retained, oldest, second, newest };
    });

    expect(state.retained).toHaveLength(MAX_IDEMPOTENCY_ENTRIES);
    expect(state.retained?.every((entry) => Number.isSafeInteger(entry.bytes))).toBe(true);
    expect(state.oldest).toBeUndefined();
    expect(state.second).toBeDefined();
    expect(state.newest).toBeDefined();
  });

  it("evicts terminal bodies by aggregate bytes without re-running an idempotent request", async () => {
    const environmentId = "environment_terminal_bytes";
    const connection = await connectSocketCollecting(
      "connector_terminal_bytes",
      environmentId,
      "connection_terminal_bytes",
    );
    const resultPayload = "x".repeat(925 * 1024);
    for (let index = 0; index < 9; index += 1) {
      const requestId = `request_terminal_bytes_${index}`;
      const idempotencyKey = `idempotency_terminal_bytes_${index}`;
      const dispatched = await submit(environmentId, {
        requestId,
        idempotencyKey,
        method: "snapshot",
        payload: { index },
      });
      expect(dispatched.status).toBe(202);
      await eventually(async () => connection.messages.filter((frame) => frame.type === "request").length === index + 1);
      connection.socket.send(JSON.stringify({
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        type: "response.completed",
        connectionId: connection.welcome.connectionId,
        body: { requestId, result: { index, resultPayload }, completedAt: new Date().toISOString() },
      }));
      await eventually(async () => (await result(environmentId, requestId)).status === "completed");
    }

    const retained = await runInDurableObject(hubFor(environmentId), async (_instance, state) => {
      const index = (await state.storage.get<Array<{ key: string; bytes?: number }>>("terminal-index")) ?? [];
      return {
        index,
        bytes: index.reduce((total, entry) => total + (entry.bytes ?? 0), 0),
        oldest: await state.storage.get("terminal:request_terminal_bytes_0"),
      };
    });
    expect(retained.bytes).toBeLessThanOrEqual(MAX_TERMINAL_RESULT_BYTES);
    expect(retained.index.length).toBeLessThan(9);
    expect(retained.oldest).toBeUndefined();

    const routedBeforeReplay = connection.messages.filter((frame) => frame.type === "request").length;
    const replay = await submit(environmentId, {
      requestId: "request_terminal_bytes_replay",
      idempotencyKey: "idempotency_terminal_bytes_0",
      method: "snapshot",
      payload: { mustNotRun: true },
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      requestId: "request_terminal_bytes_0",
      status: "failed",
      originalStatus: "completed",
      failure: { code: "connector_result_evicted", retryable: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connection.messages.filter((frame) => frame.type === "request")).toHaveLength(routedBeforeReplay);
    connection.socket.close(1000, "test_complete");
  });

  it("removes expired terminal bodies and idempotency receipts through the Durable Object alarm", async () => {
    const hub = hubFor("environment_terminal_ttl");
    await runInDurableObject(hub, async (instance, state) => {
      const expiredAt = Date.now() - 1;
      await privateHub(instance).storeIdempotency(
        "idempotency_terminal_expired",
        "request_terminal_expired",
        expiredAt,
      );
      await privateHub(instance).storeTerminal({
        ...terminalResult("request_terminal_expired", expiredAt - TERMINAL_RESULT_RETENTION_MS, { expired: true }),
        expiresAt: expiredAt,
      });
      // Keep the test alarm in the future so Miniflare cannot race and deliver
      // it before runDurableObjectAlarm explicitly exercises the callback.
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(hub)).toBe(true);
    const retained = await runInDurableObject(hub, async (_instance, state) => ({
      terminal: await state.storage.get("terminal:request_terminal_expired"),
      idempotency: await state.storage.get("idempotency:idempotency_terminal_expired"),
      terminalIndex: await state.storage.get("terminal-index"),
      idempotencyIndex: await state.storage.get("idempotency-index"),
    }));
    expect(retained).toEqual({
      terminal: undefined,
      idempotency: undefined,
      terminalIndex: undefined,
      idempotencyIndex: undefined,
    });
  });

  it("keeps warm local control-plane p95 below the documented 500 ms cloud API budget", async () => {
    const environmentId = "environment_latency";
    const { socket } = await connectSocket("connector_latency", environmentId);
    const durations: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const startedAt = performance.now();
      const response = await internalFetch(environmentId, "/status");
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      durations.push(performance.now() - startedAt);
    }
    expect(percentile(durations, 0.95)).toBeLessThanOrEqual(500);
    socket.close(1000, "test_complete");
  });
});

interface SubscriptionPage {
  items: Array<{ sequence: number; value: { index: number; payload?: string } }>;
}

interface PrivateHubTestSurface {
  storeTerminal(result: ConnectorTerminalResult): Promise<void>;
  storeIdempotency(idempotencyKey: string, requestId: string, expiresAt: number): Promise<void>;
}

function privateHub(instance: EnvironmentConnectorHub): PrivateHubTestSurface {
  return instance as unknown as PrivateHubTestSurface;
}

function terminalResult(requestId: string, now: number, resultValue: unknown): ConnectorTerminalResult {
  return {
    requestId,
    idempotencyKey: `idempotency_${requestId}`,
    status: "completed",
    result: resultValue,
    completedAt: now,
    expiresAt: now + TERMINAL_RESULT_RETENTION_MS,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function connectSocket(
  connectorId: string,
  environmentId: string,
  connectionId = `connection_${connectorId}`,
): Promise<{ socket: WebSocket; welcome: CloudWelcomeFrame }> {
  const { ticket } = await issueTicket(connectorId, environmentId);
  const upgrade = await workerFetch(`/v1/connectors/socket?ticket=${encodeURIComponent(ticket)}`, {
    headers: { upgrade: "websocket" },
  });
  expect(upgrade.status).toBe(101);
  const socket = upgrade.webSocket;
  if (!socket) throw new Error("Missing WebSocket on upgrade response.");
  socket.accept();
  socket.send(JSON.stringify({
    protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    type: "hello",
    connectionId,
    body: {
      connectorId,
      environmentId,
      connectorVersion: "0.1.0",
      platform: "resilience-test",
      capabilities: ["t3:proxy"],
    },
  }));
  const welcome = await nextMessage(socket) as CloudWelcomeFrame;
  expect(welcome).toMatchObject({ type: "welcome", connectionId });
  return { socket, welcome };
}

async function connectSocketCollecting(
  connectorId: string,
  environmentId: string,
  connectionId: string,
): Promise<{ socket: WebSocket; welcome: CloudWelcomeFrame; messages: Array<Record<string, any>> }> {
  const { ticket } = await issueTicket(connectorId, environmentId);
  const upgrade = await workerFetch(`/v1/connectors/socket?ticket=${encodeURIComponent(ticket)}`, {
    headers: { upgrade: "websocket" },
  });
  const socket = upgrade.webSocket;
  if (!socket) throw new Error("Missing WebSocket on upgrade response.");
  socket.accept();
  const messages: Array<Record<string, any>> = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as Record<string, any>);
  });
  socket.send(JSON.stringify({
    protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    type: "hello",
    connectionId,
    body: {
      connectorId,
      environmentId,
      connectorVersion: "0.1.0",
      platform: "resilience-test",
      capabilities: ["t3:proxy"],
    },
  }));
  await eventually(async () => messages.some((frame) => frame.type === "welcome"));
  const welcome = messages.find((frame) => frame.type === "welcome") as unknown as CloudWelcomeFrame;
  return { socket, welcome, messages };
}

async function issueTicket(connectorId: string, environmentId: string): Promise<{ ticket: string }> {
  const response = await workerFetch("/__dev/tickets", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bindings.DEV_TICKET_ISSUER_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ connectorId, environmentId }),
  });
  expect(response.status).toBe(201);
  return await response.json() as { ticket: string };
}

async function submit(environmentId: string, body: Record<string, unknown>): Promise<Response> {
  return await internalFetch(environmentId, "/requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function result(environmentId: string, requestId: string): Promise<Record<string, any>> {
  return await (await internalFetch(environmentId, `/requests/${encodeURIComponent(requestId)}`)).json() as Record<string, any>;
}

function hubFor(environmentId: string) {
  return bindings.ENVIRONMENT_CONNECTOR_HUB.get(bindings.ENVIRONMENT_CONNECTOR_HUB.idFromName(environmentId));
}

async function internalFetch(environmentId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bindings.ROUTER_SHARED_SECRET}`);
  return await workerFetch(`/internal/environments/${encodeURIComponent(environmentId)}/connector${path}`, { ...init, headers });
}

async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  const module = await import("../src/index");
  return await module.default.fetch(new Request(`${origin}${path}`, init), bindings);
}

async function nextMessage(socket: WebSocket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message.")), 2_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(event.data)) as unknown);
    }, { once: true });
  });
}

async function nextClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket close.")), 2_000);
    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      resolve({ code: event.code, reason: event.reason });
    }, { once: true });
  });
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition was not met.");
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? Number.POSITIVE_INFINITY;
}
