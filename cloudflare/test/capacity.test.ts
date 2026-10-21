import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeBindings } from "../src/env";
import {
  CONNECTOR_PROTOCOL_VERSION,
  MAX_PENDING_REQUESTS,
  type CloudWelcomeFrame,
} from "../src/protocol";

const bindings = env as unknown as RuntimeBindings;
const origin = "https://nextcoder-capacity.test";
const QUALIFICATION_ENVIRONMENTS = 16;
const MAX_SUBSCRIPTIONS = 16;
const MAX_ACTIVE_WAITERS = MAX_PENDING_REQUESTS + MAX_SUBSCRIPTIONS;

afterEach(async () => {
  await reset();
});

describe("CG-08 per-environment Durable Object capacity", () => {
  it("qualifies sixteen concurrently connected environments and records local per-hop percentiles", async () => {
    const handshakeMs: number[] = [];
    const connected = await Promise.all(Array.from({ length: QUALIFICATION_ENVIRONMENTS }, async (_, index) => {
      const startedAt = performance.now();
      const connection = await connectSocket(`connector_capacity_${index}`, `environment_capacity_${index}`);
      handshakeMs.push(performance.now() - startedAt);
      return connection;
    }));

    const statusMs = await Promise.all(connected.map(async (_, index) => {
      const startedAt = performance.now();
      const response = await internalFetch(`environment_capacity_${index}`, "/status");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "online" });
      return performance.now() - startedAt;
    }));

    expect(handshakeMs).toHaveLength(QUALIFICATION_ENVIRONMENTS);
    expect(percentile(handshakeMs, 0.95)).toBeLessThanOrEqual(2_000);
    expect(percentile(statusMs, 0.95)).toBeLessThanOrEqual(500);
    report("concurrent-environments", {
      environments: QUALIFICATION_ENVIRONMENTS,
      connectorHandshakeMs: distribution(handshakeMs),
      workerToDurableObjectStatusMs: distribution(statusMs),
    });
    for (const { socket } of connected) socket.close(1000, "capacity_test_complete");
  });

  it("saturates 32 requests, 16 subscriptions, and the derived 48-waiter cap", async () => {
    const environmentId = "environment_capacity_bounds";
    const connectorId = "connector_capacity_bounds";
    const { socket, messages } = await connectSocketCollecting(connectorId, environmentId);
    const dispatchMs = await Promise.all(Array.from({ length: MAX_PENDING_REQUESTS }, async (_, index) => {
      const startedAt = performance.now();
      const response = await submit(environmentId, {
        requestId: `request_capacity_${index}`,
        idempotencyKey: `idempotency_capacity_${index}`,
        method: "snapshot",
        payload: { index },
        deadlineMs: 60_000,
      });
      expect(response.status).toBe(202);
      await response.arrayBuffer();
      return performance.now() - startedAt;
    }));
    await eventually(() => messages.filter((frame) => frame.type === "request").length === MAX_PENDING_REQUESTS);

    const requestOverflow = await submit(environmentId, {
      requestId: "request_capacity_overflow",
      idempotencyKey: "idempotency_capacity_overflow",
      method: "snapshot",
      payload: {},
    });
    expect(requestOverflow.status).toBe(429);
    await expect(requestOverflow.json()).resolves.toMatchObject({
      error: "connector_backpressure",
      maxPendingRequests: MAX_PENDING_REQUESTS,
    });

    const leaseMs = await Promise.all(Array.from({ length: MAX_SUBSCRIPTIONS }, async (_, index) => {
      const startedAt = performance.now();
      const response = await internalFetch(environmentId, "/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectorId,
          leaseId: `lease_capacity_${index}`,
          threadId: `thread_capacity_${index}`,
          expiresAt: Date.now() + 60_000,
        }),
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      return performance.now() - startedAt;
    }));
    await eventually(() => messages.filter((frame) => frame.type === "subscribe").length === MAX_SUBSCRIPTIONS);

    const leaseOverflow = await internalFetch(environmentId, "/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectorId,
        leaseId: "lease_capacity_overflow",
        threadId: "thread_capacity_overflow",
        expiresAt: Date.now() + 60_000,
      }),
    });
    expect(leaseOverflow.status).toBe(429);
    await expect(leaseOverflow.json()).resolves.toMatchObject({
      error: "connector_backpressure",
      maxSubscriptions: MAX_SUBSCRIPTIONS,
    });

    const controllers = Array.from({ length: MAX_ACTIVE_WAITERS }, () => new AbortController());
    const waiterRequests = [
      ...Array.from({ length: MAX_PENDING_REQUESTS }, (_, index) =>
        internalFetch(environmentId, `/requests/request_capacity_${index}?waitMs=2000`, {
          signal: controllers[index]!.signal,
        })),
      ...Array.from({ length: MAX_SUBSCRIPTIONS }, (_, index) =>
        internalFetch(environmentId, `/subscriptions/lease_capacity_${index}?after=0&waitMs=2000`, {
          signal: controllers[MAX_PENDING_REQUESTS + index]!.signal,
        })),
    ];
    await new Promise((resolve) => setTimeout(resolve, 150));

    const overflowStartedAt = performance.now();
    const waiterOverflow = await internalFetch(environmentId, "/requests/request_capacity_0?waitMs=2000");
    const overflowMs = performance.now() - overflowStartedAt;
    expect(waiterOverflow.status).toBe(429);
    await expect(waiterOverflow.json()).resolves.toMatchObject({ error: "connector_backpressure" });
    for (const controller of controllers) controller.abort("capacity_test_complete");
    await Promise.allSettled(waiterRequests);

    expect(percentile(dispatchMs, 0.95)).toBeLessThanOrEqual(2_000);
    report("environment-saturation", {
      pendingRequestsAccepted: MAX_PENDING_REQUESTS,
      pendingRequestOverflowStatus: requestOverflow.status,
      subscriptionLeasesAccepted: MAX_SUBSCRIPTIONS,
      subscriptionOverflowStatus: leaseOverflow.status,
      activeWaitersAccepted: MAX_ACTIVE_WAITERS,
      waiterOverflowStatus: waiterOverflow.status,
      waiterOverflowResponseMs: round(overflowMs),
      workerToDurableObjectDispatchReceiptMs: distribution(dispatchMs),
      workerToDurableObjectLeaseOpenMs: distribution(leaseMs),
    });
    socket.close(1000, "capacity_test_complete");
  });
});

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
  if (!socket) throw new Error("Missing WebSocket on capacity-test upgrade.");
  socket.accept();
  socket.send(JSON.stringify({
    protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    type: "hello",
    connectionId,
    body: {
      connectorId,
      environmentId,
      connectorVersion: "0.1.0",
      platform: "capacity-test",
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
): Promise<{ socket: WebSocket; welcome: CloudWelcomeFrame; messages: Array<Record<string, unknown>> }> {
  const { ticket } = await issueTicket(connectorId, environmentId);
  const upgrade = await workerFetch(`/v1/connectors/socket?ticket=${encodeURIComponent(ticket)}`, {
    headers: { upgrade: "websocket" },
  });
  const socket = upgrade.webSocket;
  if (!socket) throw new Error("Missing WebSocket on capacity-test upgrade.");
  socket.accept();
  const messages: Array<Record<string, unknown>> = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  });
  socket.send(JSON.stringify({
    protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    type: "hello",
    connectionId: `connection_${connectorId}`,
    body: {
      connectorId,
      environmentId,
      connectorVersion: "0.1.0",
      platform: "capacity-test",
      capabilities: ["t3:proxy"],
    },
  }));
  await eventually(() => messages.some((frame) => frame.type === "welcome"));
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

async function internalFetch(environmentId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bindings.ROUTER_SHARED_SECRET}`);
  return await workerFetch(`/internal/environments/${encodeURIComponent(environmentId)}/connector${path}`, {
    ...init,
    headers,
  });
}

async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  const module = await import("../src/index");
  return await module.default.fetch(new Request(`${origin}${path}`, init), bindings);
}

async function nextMessage(socket: WebSocket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for capacity-test WebSocket message.")), 2_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(event.data)) as unknown);
    }, { once: true });
  });
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Capacity-test condition was not met.");
}

function distribution(values: number[]) {
  return {
    count: values.length,
    min: round(Math.min(...values)),
    p50: round(percentile(values, 0.50)),
    p95: round(percentile(values, 0.95)),
    p99: round(percentile(values, 0.99)),
    max: round(Math.max(...values)),
  };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? Number.POSITIVE_INFINITY;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function report(name: string, value: Record<string, unknown>): void {
  console.info(`CAPACITY_WORKER_RESULT ${JSON.stringify({ name, ...value })}`);
}
