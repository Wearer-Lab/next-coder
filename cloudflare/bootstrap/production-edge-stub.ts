import { WorkerEntrypoint } from "cloudflare:workers";

type RpcFailure = {
  ok: false;
  status: 503;
  error: { error: "production_bootstrap_incomplete"; retryable: true };
};

const FAILURE: RpcFailure = {
  ok: false,
  status: 503,
  error: { error: "production_bootstrap_incomplete", retryable: true },
};

/**
 * Temporary private RPC shape used only to break the reciprocal Service Binding cycle.
 * Every method fails closed and the Worker has no workers.dev URL or route.
 */
export class ControlPlaneConnectorRouterEntrypoint extends WorkerEntrypoint<Record<string, never>> {
  async routeConnectorRequest(): Promise<RpcFailure> { return FAILURE; }
  async pollConnectorRequest(): Promise<RpcFailure> { return FAILURE; }
  async cancelConnectorRequest(): Promise<RpcFailure> { return FAILURE; }
  async openConnectorSubscription(): Promise<RpcFailure> { return FAILURE; }
  async pollConnectorSubscription(): Promise<RpcFailure> { return FAILURE; }
  async closeConnectorSubscription(): Promise<RpcFailure> { return FAILURE; }
  async routeConnectorRevocation(): Promise<RpcFailure> { return FAILURE; }
}

export default {
  async fetch(): Promise<Response> {
    return Response.json(
      { error: "production_bootstrap_incomplete" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  },
} satisfies ExportedHandler<Record<string, never>>;
