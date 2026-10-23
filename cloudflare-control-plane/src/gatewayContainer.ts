import { Container } from "@cloudflare/containers";

import type { RuntimeBindings } from "./env";
import { handleConnectorRouterOutbound } from "./connectorRouterOutbound";
import { handleBackgroundOutbound } from "./backgroundOutbound";

/** One explicitly bounded instance; all durable records live in Convex. */
export class AgentControllerGatewayContainer extends Container<RuntimeBindings> {
  static {
    // The SDK setter registers handlers for ContainerProxy. A static class field shadows that
    // setter and leaves intercepted requests falling through to public DNS for this private host.
    this.outboundByHost = {
      "background.internal": async (request: Request, env: Cloudflare.Env) => {
        return await handleBackgroundOutbound(request, env as unknown as RuntimeBindings);
      },
      "connector-router.internal": async (request: Request, env: Cloudflare.Env) => {
        return await handleConnectorRouterOutbound(request, env as unknown as RuntimeBindings);
      },
    };
  }
  defaultPort = 3996;
  requiredPorts = [3996, 3998];
  sleepAfter = "30m";
  enableInternet = true;
  // The SDK prepends "http://"; this must be a host, not a complete URL.
  pingEndpoint = "containerstarthealthcheck";

  /**
   * Only plain startup values cross RPC. Create cancellation inside the Durable Object and
   * retain the SDK's outbound interception, concurrent-start coalescing and lifecycle alarms.
   * The signal stays local to native port probes; nested signals cannot cross Worker RPC.
   */
  async startGateway(
    envVars: Record<string, string>,
    timeoutMs: number,
  ): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new DOMException("Container startup timed out", "TimeoutError");
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      await Promise.race([
        this.startAndWaitForPorts({
          ports: this.requiredPorts,
          cancellationOptions: {
            abort: controller.signal,
            instanceGetTimeoutMS: timeoutMs,
            portReadyTimeoutMS: timeoutMs,
          },
          startOptions: {
            envVars,
            enableInternet: this.enableInternet,
            labels: { environment: this.env.DEPLOYMENT_ENVIRONMENT, role: "control-plane" },
          },
        }),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  override onError(_error: unknown): never {
    // Names, messages, stacks and causes can all contain startup secrets.
    throw new Error("container_runtime_failure");
  }
}
