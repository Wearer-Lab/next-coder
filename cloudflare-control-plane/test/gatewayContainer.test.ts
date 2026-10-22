import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBindings } from "../src/env";
import { AgentControllerGatewayContainer } from "../src/gatewayContainer";
import worker from "../src/index";

const { start, outboundRegistry } = vi.hoisted(() => ({ start: vi.fn(), outboundRegistry: new Map() }));

// Exercise our RPC method without a live platform instance. The SDK owns platform startup,
// outbound interception and alarms; replacing those internals is deliberately outside this test.
vi.mock("@cloudflare/containers", () => ({
  ContainerProxy: class {},
  switchPort: (request: Request) => request,
  Container: class {
    static get outboundByHost() { return outboundRegistry.get(this.name); }
    static set outboundByHost(handlers) { outboundRegistry.set(this.name, handlers); }
    constructor(_ctx: unknown, protected env: RuntimeBindings) {}
    startAndWaitForPorts = start;
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  start.mockReset();
});

afterEach(() => vi.useRealTimers());

function gateway() {
  return new AgentControllerGatewayContainer(
    {} as DurableObjectState<{}>,
    { DEPLOYMENT_ENVIRONMENT: "local" } as RuntimeBindings,
  );
}

describe("container startup RPC", () => {
  it("registers private outbound traffic with the SDK proxy instead of falling through to DNS", async () => {
    const routeConnectorRevocation = vi.fn(async () => ({ ok: true, value: { revoked: true } }));
    const handler = outboundRegistry.get("AgentControllerGatewayContainer")?.["connector-router.internal"];
    expect(handler).toBeTypeOf("function");
    const response = await handler(new Request("http://connector-router.internal/v1/revoke", {
      method: "POST",
      body: JSON.stringify({ environmentId: "env_fixture", connectorId: "connector_fixture", reason: "superseded_by_reenrollment" }),
    }), { CONNECTOR_ROUTER: { routeConnectorRevocation } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    expect(routeConnectorRevocation).toHaveBeenCalledExactlyOnceWith("env_fixture", "connector_fixture", "superseded_by_reenrollment");
  });

  it("selects the existing singleton through the typed namespace and sends only startup values", async () => {
    const startGateway = vi.fn(async (_envVars: Record<string, string>, _timeoutMs: number) => {});
    const getByName = vi.fn(() => ({
      startGateway,
      fetch: async () => Response.json({ ok: true }),
    }));
    const response = await worker.fetch(new Request("https://console.example/health"), {
      DEPLOYMENT_ENVIRONMENT: "local",
      AGENT_CONTROLLER_GATEWAY: { getByName },
    } as unknown as RuntimeBindings);
    expect(response.status).toBe(200);
    expect(getByName).toHaveBeenCalledExactlyOnceWith("agent-controller-control-plane");
    expect(startGateway).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ DEPLOYMENT_ENVIRONMENT: "local", PORT: "3996", INTERNAL_PORT: "3998" }),
      20_000,
    );
    expect(startGateway.mock.calls[0]?.[0]).not.toHaveProperty("AGENT_CONTROLLER_GATEWAY");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains SDK lifecycle management and checks both ports with a locally created signal", async () => {
    start.mockResolvedValue(undefined);
    const instance = gateway();
    const envVars = { NODE_ENV: "development", PRIVATE_FIXTURE: "fixture-secret" };

    await instance.startGateway(envVars, 1_000);

    expect(instance.pingEndpoint).toBe("containerstarthealthcheck");
    expect(start).toHaveBeenCalledExactlyOnceWith({
      ports: [3996, 3998],
      cancellationOptions: {
        abort: expect.any(AbortSignal),
        instanceGetTimeoutMS: 1_000,
        portReadyTimeoutMS: 1_000,
      },
      startOptions: {
        envVars,
        enableInternet: true,
        labels: { environment: "local", role: "control-plane" },
      },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the whole startup even if a platform probe never settles", async () => {
    start.mockImplementation(async () => await new Promise(() => {}));
    const pending = gateway().startGateway({}, 1_000);
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;

    const signal = start.mock.calls[0]?.[0].cancellationOptions.abort as AbortSignal;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline on startup rejection and withholds platform error content", async () => {
    const privateError = new Error("fixture-secret");
    start.mockRejectedValue(privateError);
    const instance = gateway();
    await expect(instance.startGateway({}, 1_000)).rejects.toBe(privateError);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => instance.onError(privateError)).toThrow("container_runtime_failure");
  });
});
