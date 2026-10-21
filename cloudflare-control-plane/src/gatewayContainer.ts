import { Container } from "@cloudflare/containers";

import type { RuntimeBindings } from "./env";
import { handleConnectorRouterOutbound } from "./connectorRouterOutbound";

/** One explicitly bounded instance; all durable records live in Convex. */
export class AgentControllerGatewayContainer extends Container<RuntimeBindings> {
  static outboundByHost = {
    "connector-router.internal": async (request: Request, env: Cloudflare.Env) => {
      return await handleConnectorRouterOutbound(request, env as unknown as RuntimeBindings);
    },
  };
  defaultPort = 3996;
  requiredPorts = [3996, 3998];
  sleepAfter = "30m";
  enableInternet = true;
  pingEndpoint = "http://localhost:3996/health";

  override onError(error: unknown): never {
    // Never stringify error causes: startup environment values may contain secrets.
    throw new Error(error instanceof Error ? `Next Coder container ${error.name}` : "Next Coder container failed");
  }
}
