import { switchPort } from "@cloudflare/containers";

import type { RuntimeBindings } from "./env";
import { AgentControllerGatewayContainer } from "./gatewayContainer";
import { handleControlPlaneRequest } from "./handler";

export { AgentControllerGatewayContainer };
export { ContainerProxy } from "@cloudflare/containers";
export * from "./env";
export * from "./handler";
export * from "./proxy";
export * from "./runtimeConfig";

const SINGLETON_INSTANCE = "agent-controller-control-plane";

export default {
  async fetch(request: Request, env: RuntimeBindings): Promise<Response> {
    return await handleControlPlaneRequest(
      request,
      env,
      () => env.AGENT_CONTROLLER_GATEWAY.getByName(SINGLETON_INSTANCE),
      switchPort,
    );
  },
} satisfies ExportedHandler<RuntimeBindings>;
