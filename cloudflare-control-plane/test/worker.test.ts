import { describe, expect, it } from "vitest";

import type { RuntimeBindings } from "../src/env";
import { handleControlPlaneRequest, type ContainerStubBoundary } from "../src/handler";
import { withResponseHeaderTimeout } from "../src/proxy";
import { resolveRuntimeConfig, RuntimeConfigurationError } from "../src/runtimeConfig";
import { handleConnectorRouterOutbound } from "../src/connectorRouterOutbound";

describe("control-plane Worker boundary", () => {
  it("streams public /v1 bodies and response bodies through the public container port", async () => {
    const seen: Request[] = [];
    const stub = fakeContainer(async (request) => {
      seen.push(request);
      expect(await request.text()).toBe("streamed-enrollment-body");
      return new Response(stream("streamed-response"), {
        status: 201,
        headers: {
          "content-type": "application/json",
          server: "must-not-leak",
          "x-powered-by": "must-not-leak",
        },
      });
    });
    const request = new Request("https://console.example/v1/connectors/enroll", {
      method: "POST",
      headers: {
        authorization: "Bearer platform-token",
        connection: "keep-alive",
        "x-next-coder-internal-capability": "spoofed",
      },
      body: "streamed-enrollment-body",
    });

    const response = await handle(request, localBindings(), stub);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("streamed-response");
    expect(response.headers.get("server")).toBeNull();
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer platform-token");
    expect(seen[0]?.headers.get("connection")).toBeNull();
    expect(seen[0]?.headers.get("x-next-coder-internal-capability")).toBeNull();
    expect(seen[0]?.headers.get("cf-container-target-port")).toBeNull();
  });

  it("routes only named capability paths to the private container port without URL credentials", async () => {
    const ticket = "one-time-ticket-private-body-only";
    let seen: Request | undefined;
    const stub = fakeContainer(async (request) => {
      seen = request;
      return Response.json({ ticketId: "ticket_1" });
    });
    const response = await handle(new Request(
      "https://control-plane.internal/v1/internal/connectors/tickets/consume",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket, audience: "agent-controller-connectors", now: Date.now() }),
      },
    ), localBindings(), stub);

    expect(response.status).toBe(200);
    expect(seen?.headers.get("cf-container-target-port")).toBe("3998");
    expect(seen?.headers.get("x-next-coder-internal-capability")).toBe("1");
    expect(seen?.url).not.toContain(ticket);
    expect(await seen?.text()).toContain(ticket);

    let backgroundRequest: Request | undefined;
    const background = await handle(
      new Request("https://control-plane.internal/v1/internal/background/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, taskId: "task_1", kind: "media.process", payload: {} }),
      }),
      localBindings(),
      fakeContainer(async (request) => {
        backgroundRequest = request;
        return Response.json({ version: 1, taskId: "task_1", kind: "media.process", result: {} });
      }),
    );
    expect(background.status).toBe(200);
    expect(backgroundRequest?.headers.get("cf-container-target-port")).toBe("3998");
    expect(backgroundRequest?.headers.get("x-next-coder-internal-capability")).toBe("1");

    let selected = false;
    const rejected = await handle(
      new Request("https://control-plane.internal/v1/internal/not-a-capability", { method: "POST" }),
      localBindings(),
      fakeContainer(async () => {
        selected = true;
        return new Response();
      }),
    );
    expect(rejected.status).toBe(404);
    expect(selected).toBe(false);
  });

  it("fails closed before selecting a container when production secrets are incomplete", async () => {
    let selected = false;
    const response = await handle(
      new Request("https://control-plane.internal/v1/connectors/enroll", { method: "POST" }),
      { ...localBindings(), DEPLOYMENT_ENVIRONMENT: "production" },
      fakeContainer(async () => {
        selected = true;
        return new Response();
      }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "control_plane_runtime_unconfigured" });
    expect(selected).toBe(false);
  });

  it("passes strict Convex, Clerk, encryption, R2, and disabled-runner settings at startup", async () => {
    const env = productionBindings();
    const resolved = resolveRuntimeConfig(env);
    expect(resolved.containerEnv).toMatchObject({
      DEPLOYMENT_ENVIRONMENT: "production",
      STORAGE_PROVIDER: "convex",
      AUTH_PROVIDER: "clerk",
      MEDIA_STORAGE_PROVIDER: "s3",
      FIRMWARE_STORAGE_PROVIDER: "s3",
      DEPLOYMENT_MODE: "cloud",
      REQUIRE_TLS: "1",
      ENABLE_DEV_TOKENS: "0",
      DISCOVERY_ENABLED: "0",
      SNAPSHOT_POLL_ENABLED: "0",
      THREAD_STREAM_ENABLED: "0",
      TRANSCRIPTION_WORKER_ENABLED: "0",
      WEB_PUSH_WORKER_ENABLED: "0",
      CLOUD_SNAPSHOT_CONSUMER_ENABLED: "1",
      CLOUD_THREAD_STREAM_CONSUMER_ENABLED: "1",
      CLOUD_MEDIA_CONSUMER_ENABLED: "1",
      CONNECTOR_ROUTER_BASE_URL: "http://connector-router.internal",
      GATEWAY_TLS_ROOT_CA_PEM: "-----BEGIN CERTIFICATE-----\ncurrent\n-----END CERTIFICATE-----",
      GATEWAY_TLS_NEXT_ROOT_CA_PEM: "-----BEGIN CERTIFICATE-----\nnext\n-----END CERTIFICATE-----",
      WEB_PUSH_VAPID_KEYS: "private-vapid-key-set",
      WEB_PUSH_STORAGE_ENCRYPTION_KEY: "private-push-storage-key",
    });
    expect(resolved.containerEnv).not.toHaveProperty("DATA_FILE");

    const missingUrl = { ...env, PUBLIC_BASE_URL: "http://insecure.example" };
    expect(() => resolveRuntimeConfig(missingUrl)).toThrow(RuntimeConfigurationError);
    expect(() => resolveRuntimeConfig({ ...env, CONNECTOR_ROUTER: undefined as never })).toThrow(RuntimeConfigurationError);
    expect(() => resolveRuntimeConfig({ ...env, WEB_PUSH_VAPID_KEYS: undefined })).toThrowError(
      expect.objectContaining({ missing: ["WEB_PUSH_VAPID_KEYS"] }),
    );
    expect(() => resolveRuntimeConfig({ ...env, WEB_PUSH_STORAGE_ENCRYPTION_KEY: undefined })).toThrowError(
      expect.objectContaining({ missing: ["WEB_PUSH_STORAGE_ENCRYPTION_KEY"] }),
    );
  });

  it("passes Web Push secrets through private Container startup without projecting them publicly", async () => {
    const env = productionBindings();
    let startupEnvironment: Record<string, string> | undefined;
    const response = await handle(
      new Request("https://console.example/v1/push/config"),
      env,
      fakeContainer(
        async () => Response.json({ supported: true, keyId: "primary", publicKey: "public-vapid-key" }),
        (options) => { startupEnvironment = options.startOptions.envVars; },
      ),
    );

    expect(startupEnvironment).toMatchObject({
      WEB_PUSH_VAPID_KEYS: env.WEB_PUSH_VAPID_KEYS,
      WEB_PUSH_STORAGE_ENCRYPTION_KEY: env.WEB_PUSH_STORAGE_ENCRYPTION_KEY,
      WEB_PUSH_ALLOWED_HOSTS: env.WEB_PUSH_ALLOWED_HOSTS,
      WEB_PUSH_WORKER_ENABLED: "0",
    });
    const publicProjection = await response.text();
    expect(publicProjection).toContain("public-vapid-key");
    expect(publicProjection).not.toContain(String(env.WEB_PUSH_VAPID_KEYS));
    expect(publicProjection).not.toContain(String(env.WEB_PUSH_STORAGE_ENCRYPTION_KEY));
  });

  it("translates the private virtual host to named-entrypoint RPC without forwarding credentials", async () => {
    let seen: unknown;
    const env = {
      ...localBindings(),
      CONNECTOR_ROUTER: {
        async routeConnectorRequest(environmentId: string, request: unknown) {
          seen = { environmentId, request };
          return { ok: true, value: { requestId: "request_contract", status: "dispatched" } };
        },
      } as RuntimeBindings["CONNECTOR_ROUTER"],
    };
    const response = await handleConnectorRouterOutbound(new Request("http://connector-router.internal/v1/requests", {
      method: "POST",
      headers: { authorization: "Bearer must-not-cross", "content-type": "application/json" },
      body: JSON.stringify({ environmentId: "environment_contract", request: { method: "snapshot" } }),
    }), env);
    expect(response.status).toBe(200);
    expect(seen).toEqual({ environmentId: "environment_contract", request: { method: "snapshot" } });
  });

  it("forwards bounded result and subscription waits through the private Service Binding", async () => {
    const seen: unknown[] = [];
    const env = {
      ...localBindings(),
      CONNECTOR_ROUTER: {
        async pollConnectorRequest(environmentId: string, requestId: string, waitMs: number) {
          seen.push({ kind: "request", environmentId, requestId, waitMs });
          return { ok: true, value: { status: "completed" } };
        },
        async pollConnectorSubscription(environmentId: string, leaseId: string, after: number, waitMs: number) {
          seen.push({ kind: "subscription", environmentId, leaseId, after, waitMs });
          return { ok: true, value: { items: [] } };
        },
      } as RuntimeBindings["CONNECTOR_ROUTER"],
    };
    const result = await handleConnectorRouterOutbound(new Request(
      "http://connector-router.internal/v1/requests/request_wait?environmentId=environment_wait&waitMs=25000",
    ), env);
    const page = await handleConnectorRouterOutbound(new Request(
      "http://connector-router.internal/v1/subscriptions/lease_wait?environmentId=environment_wait&after=42&waitMs=999999",
    ), env);
    expect(result.status).toBe(200);
    expect(page.status).toBe(200);
    expect(seen).toEqual([
      { kind: "request", environmentId: "environment_wait", requestId: "request_wait", waitMs: 25_000 },
      { kind: "subscription", environmentId: "environment_wait", leaseId: "lease_wait", after: 42, waitMs: 25_000 },
    ]);
  });

  it("translates private connector revocation and returns the edge result", async () => {
    let seen: unknown;
    const env = {
      ...localBindings(),
      CONNECTOR_ROUTER: {
        async routeConnectorRevocation(environmentId: string, connectorId: string, reason: string) {
          seen = { environmentId, connectorId, reason };
          return { ok: true, value: { revoked: true } };
        },
      } as RuntimeBindings["CONNECTOR_ROUTER"],
    };
    const response = await handleConnectorRouterOutbound(new Request("http://connector-router.internal/v1/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentId: "environment_contract", connectorId: "connector_contract", reason: "owner_revoked" }),
    }), env);
    expect(response.status).toBe(200);
    expect(seen).toEqual({ environmentId: "environment_contract", connectorId: "connector_contract", reason: "owner_revoked" });
  });

  it("bounds response-header waits without buffering a successful stream", async () => {
    await expect(withResponseHeaderTimeout(
      async (signal) => await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      5,
    )).rejects.toThrow("container_response_header_timeout");

    const response = await withResponseHeaderTimeout(async () => new Response(stream("still-streamed")), 50);
    expect(await response.text()).toBe("still-streamed");
  });

  it("records bounded Container startup and header-timeout telemetry without request data", async () => {
    const points: Array<{ blobs: string[]; doubles: number[] }> = [];
    const privateValue = "private-ticket-value";
    const response = await handle(
      new Request(`https://console.example/v1/connectors/enroll?ticket=${privateValue}`),
      {
        ...localBindings(),
        CONTAINER_RESPONSE_HEADER_TIMEOUT_MS: "5",
        TELEMETRY_SUCCESS_SAMPLE_RATE: "1",
        TELEMETRY: analytics(points),
      },
      fakeContainer(async () => {
        const error = new Error("container_response_header_timeout");
        error.name = "TimeoutError";
        throw error;
      }),
    );

    expect(response.status).toBe(504);
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs).toEqual(expect.arrayContaining([
      "next-coder.cloud-telemetry.v1", "control_plane", "container_request",
      "public_api", "failure", "5xx", "container_header_timeout",
    ]));
    expect(points[0]?.doubles[0]).toBeGreaterThanOrEqual(0);
    expect(points[0]?.doubles[5]).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(points)).not.toContain(privateValue);
  });
});

function fakeContainer(
  fetchImpl: (request: Request) => Promise<Response>,
  onStart?: (options: Parameters<ContainerStubBoundary["startAndWaitForPorts"]>[0]) => void,
): ContainerStubBoundary {
  return {
    async startAndWaitForPorts(options) {
      expect(options.ports).toEqual([3996, 3998]);
      onStart?.(options);
    },
    fetch: fetchImpl,
  };
}

async function handle(request: Request, env: RuntimeBindings, stub: ContainerStubBoundary): Promise<Response> {
  return await handleControlPlaneRequest(
    request,
    env,
    () => stub,
    (input, port) => {
      const headers = new Headers(input.headers);
      headers.set("cf-container-target-port", String(port));
      return new Request(input, { headers });
    },
  );
}

function localBindings(): RuntimeBindings {
  return {
    AGENT_CONTROLLER_GATEWAY: {} as RuntimeBindings["AGENT_CONTROLLER_GATEWAY"],
    CONNECTOR_ROUTER: {} as RuntimeBindings["CONNECTOR_ROUTER"],
    DEPLOYMENT_ENVIRONMENT: "local",
  };
}

function productionBindings(): RuntimeBindings {
  return {
    ...localBindings(),
    DEPLOYMENT_ENVIRONMENT: "production",
    PUBLIC_BASE_URL: "https://console.example",
    CONVEX_URL: "https://convex.example",
    GATEWAY_CONVEX_SECRET: "convex-secret",
    CLERK_SECRET_KEY: "clerk-secret",
    CLERK_PUBLISHABLE_KEY: "pk_live_example",
    T3_TOKEN_ENCRYPTION_KEY: "encryption-secret",
    S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    S3_BUCKET: "next-coder-media",
    FIRMWARE_S3_BUCKET: "next-coder-firmware",
    S3_ACCESS_KEY_ID: "r2-access-id",
    S3_SECRET_ACCESS_KEY: "r2-secret",
    GATEWAY_TLS_ROOT_CA_PEM: "-----BEGIN CERTIFICATE-----\ncurrent\n-----END CERTIFICATE-----",
    GATEWAY_TLS_NEXT_ROOT_CA_PEM: "-----BEGIN CERTIFICATE-----\nnext\n-----END CERTIFICATE-----",
    WEB_PUSH_VAPID_KEYS: "private-vapid-key-set",
    WEB_PUSH_ALLOWED_HOSTS: "fcm.googleapis.com,.push.services.mozilla.com",
    WEB_PUSH_STORAGE_ENCRYPTION_KEY: "private-push-storage-key",
  };
}

function stream(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

function analytics(points: unknown[]): AnalyticsEngineDataset {
  return { writeDataPoint(point: unknown) { points.push(point); } } as AnalyticsEngineDataset;
}
