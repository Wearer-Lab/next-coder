import { env, exports as workerExports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeBindings } from "../src/env";
import { CONNECTOR_PROTOCOL_VERSION, type CloudRequestFrame, type CloudWelcomeFrame } from "../src/protocol";
import { ServiceBindingTicketVerifier } from "../src/tickets";

const bindings = env as unknown as RuntimeBindings;
const publicOrigin = "https://console.nextcoder.test";
const routerRpc = (workerExports as unknown as { ControlPlaneConnectorRouterEntrypoint: RouterRpcTestClient })
  .ControlPlaneConnectorRouterEntrypoint;

afterEach(async () => {
  await reset();
});

describe("same-origin control-plane edge", () => {
  it("maps the atomic backend ticket-consumption shape without putting the ticket in a URL", async () => {
    const calls: CapturedRequest[] = [];
    const rawTicket = "socket_ticket_private_value";
    const verifier = new ServiceBindingTicketVerifier(recordingControlPlane(calls, async (request) => {
      const body = JSON.parse(await request.text()) as { ticket: string; audience: string; now: number };
      expect(body).toMatchObject({ ticket: rawTicket, audience: "agent-controller-connectors" });
      return Response.json(backendConsumption("connector_backend", "environment_backend", body.now));
    }));

    const now = Date.now();
    const claims = await verifier.consume(rawTicket, "agent-controller-connectors", now);
    expect(claims).toMatchObject({
      ticketId: "ticket_backend",
      connectorId: "connector_backend",
      environmentId: "environment_backend",
      scopes: ["connector:connect", "t3:proxy"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://control-plane.internal/v1/internal/connectors/tickets/consume");
    expect(calls[0]?.url).not.toContain(rawTicket);
  });

  it("forwards enrollment and standing-credential ticket requests over one private binding", async () => {
    const calls: CapturedRequest[] = [];
    const controlPlane = recordingControlPlane(calls, async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/connectors/enroll") {
        return Response.json({ connector: { id: "connector_forwarded" }, secret: "shown_once" }, { status: 201 });
      }
      if (url.pathname === "/v1/connectors/ticket") {
        return Response.json({ ticket: "socket_ticket_response", expiresAt: new Date(Date.now() + 60_000).toISOString() }, { status: 201 });
      }
      return new Response(null, { status: 404 });
    });
    const production = productionBindings(controlPlane);

    const enrollment = await edgeFetch(production, "/v1/connectors/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "single-use-enrollment-code", protocolVersion: 1 }),
    });
    expect(enrollment.status).toBe(201);
    expect(enrollment.headers.get("cache-control")).toBe("no-store");
    expect(enrollment.headers.get("x-content-type-options")).toBe("nosniff");
    expect(enrollment.headers.get("x-frame-options")).toBe("DENY");
    expect(enrollment.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const ticket = await edgeFetch(production, "/v1/connectors/ticket", {
      method: "POST",
      headers: { authorization: "Bearer standing_connector_secret" },
    });
    expect(ticket.status).toBe(201);
    expect(ticket.headers.get("cache-control")).toBe("no-store");
    await expect(ticket.json()).resolves.toMatchObject({ ticket: "socket_ticket_response" });

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v1/connectors/enroll",
      "/v1/connectors/ticket",
    ]);
    expect(calls.every((call) => new URL(call.url).origin === "https://control-plane.internal")).toBe(true);
    expect(calls.every((call) => !call.url.includes("single-use-enrollment-code") && !call.url.includes("standing_connector_secret"))).toBe(true);
    expect(calls[1]?.authorization).toBe("Bearer standing_connector_secret");
    expect(calls[1]?.forwardedHost).toBe("console.nextcoder.test");
  });

  it("consumes a backend-shaped ticket and completes the production socket handshake", async () => {
    const calls: CapturedRequest[] = [];
    const rawTicket = "socket_ticket_for_handshake";
    const controlPlane = recordingControlPlane(calls, async (request) => {
      const body = JSON.parse(await request.text()) as { now: number };
      return Response.json(backendConsumption("connector_production", "environment_production", body.now));
    });

    const upgrade = await edgeFetch(
      productionBindings(controlPlane),
      `/v1/connectors/socket?ticket=${encodeURIComponent(rawTicket)}`,
      { headers: { upgrade: "websocket" } },
    );
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;
    if (!socket) throw new Error("Missing WebSocket on production upgrade.");
    socket.accept();
    socket.send(JSON.stringify({
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "hello",
      connectionId: "production_connection",
      body: {
        connectorId: "connector_production",
        environmentId: "environment_production",
        connectorVersion: "0.1.0",
        platform: "darwin-arm64-node22",
        t3Health: "ready",
        capabilities: ["environmentInfo", "dispatch"],
        providerCatalogue: [{ provider: "codex", models: ["model"] }],
      },
    }));
    const welcome = (await nextMessage(socket)) as CloudWelcomeFrame;
    expect(welcome).toMatchObject({ type: "welcome", connectionId: "production_connection" });

    const routedPromise = nextMessage(socket);
    const receipt = await routerRpc.submitConnectorRequest(
      "environment_production",
      {
        requestId: "production_request_1",
        idempotencyKey: "production_idempotency_1",
        method: "environment.snapshot",
        payload: {},
      },
    );
    expect(receipt).toMatchObject({ status: "dispatched", requestId: "production_request_1" });
    const routed = (await routedPromise) as CloudRequestFrame;
    expect(routed).toMatchObject({ type: "request", body: { requestId: "production_request_1" } });
    socket.send(JSON.stringify({
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "response.completed",
      connectionId: welcome.connectionId,
      body: {
        requestId: routed.body.requestId,
        result: { projects: 3 },
        completedAt: new Date().toISOString(),
      },
    }));
    await eventually(async () => {
      const result = await routerRpc.connectorRequestResult(
        "environment_production",
        routed.body.requestId,
      );
      return isRecord(result) && result.status === "completed";
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).not.toContain(rawTicket);
    expect(calls[0]?.body).toContain(rawTicket);
    socket.close(1000, "test_complete");
  });

  it("fails closed when a cloud environment has no control-plane binding", async () => {
    const production = productionBindings(undefined);
    const health = await edgeFetch(production, "/health");
    expect(health.status).toBe(503);
    await expect(health.json()).resolves.toMatchObject({ ok: false, sameOriginControlPlaneBound: false });

    const api = await edgeFetch(production, "/v1/connectors/enroll", { method: "POST", body: "{}" });
    expect(api.status).toBe(503);
    await expect(api.json()).resolves.toMatchObject({ error: "control_plane_unconfigured" });

    const socket = await edgeFetch(production, "/v1/connectors/socket?ticket=not-forwarded-ticket", {
      headers: { upgrade: "websocket" },
    });
    expect(socket.status).toBe(503);
    await expect(socket.json()).resolves.toMatchObject({ error: "control_plane_unconfigured" });

    const privateRoute = await edgeFetch(productionBindings(recordingControlPlane([], async () => new Response("no"))), "/v1/internal/connectors/tickets/consume", {
      method: "POST",
      body: "{}",
    });
    expect(privateRoute.status).toBe(404);
  });

  it("exposes connector routing only through the named Worker RPC entrypoint", async () => {
    const result = await routerRpc.connectorStatus("environment_rpc");
    expect(result).toMatchObject({ status: "offline", stale: true });
  });
});

interface CapturedRequest {
  url: string;
  method: string;
  authorization: string | null;
  forwardedHost: string | null;
  body: string;
}

interface RouterRpcTestClient {
  connectorStatus(environmentId: string): Promise<unknown>;
  submitConnectorRequest(environmentId: string, request: {
    requestId: string;
    idempotencyKey: string;
    method: string;
    payload: unknown;
  }): Promise<unknown>;
  connectorRequestResult(environmentId: string, requestId: string): Promise<unknown>;
}

function recordingControlPlane(
  calls: CapturedRequest[],
  respond: (request: Request) => Promise<Response>,
): Fetcher {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init);
      const clone = request.clone();
      calls.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        forwardedHost: request.headers.get("x-forwarded-host"),
        body: request.method === "GET" || request.method === "HEAD" ? "" : await clone.text(),
      });
      return await respond(request);
    },
    connect(): Socket {
      throw new Error("connect is not supported by this test binding.");
    },
  };
}

function productionBindings(controlPlane: Fetcher | undefined): RuntimeBindings {
  const { CONTROL_PLANE: _localControlPlane, ...withoutControlPlane } = bindings;
  return {
    ...withoutControlPlane,
    DEPLOYMENT_ENVIRONMENT: "production",
    CONNECTOR_AUTH_MODE: "control-plane",
    ...(controlPlane ? { CONTROL_PLANE: controlPlane } : {}),
  } as unknown as RuntimeBindings;
}

function backendConsumption(connectorId: string, environmentId: string, now: number): unknown {
  return {
    connector: {
      id: connectorId,
      environmentId,
      scopes: ["connector:connect", "t3:proxy"],
      revokedAt: null,
    },
    ticket: {
      id: "ticket_backend",
      connectorId,
      environmentId,
      expiresAt: new Date(now + 60_000).toISOString(),
    },
    reason: null,
  };
}

async function edgeFetch(runtime: RuntimeBindings, path: string, init?: RequestInit): Promise<Response> {
  const module = await import("../src/index");
  return await module.default.fetch(new Request(`${publicOrigin}${path}`, init), runtime);
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

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
