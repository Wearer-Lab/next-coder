import {
  dispatchT3Command,
  fetchT3EnvironmentInfo,
  fetchT3Snapshot,
  fetchT3ThreadDetail,
} from "./t3Client.mjs";
import { callT3Rpc, openT3ThreadStream } from "./t3Ws.mjs";
import { T3Adapter } from "./t3CapabilityManifest.mjs";

export class DirectT3Transport {
  environmentInfo(environment, options) {
    return fetchT3EnvironmentInfo(environment, options);
  }

  snapshot(environment, options) {
    return fetchT3Snapshot(environment, options);
  }

  threadDetail(environment, threadId, options) {
    return fetchT3ThreadDetail(environment, threadId, options);
  }

  dispatch(environment, command, options = {}) {
    return dispatchT3Command(environment, command, options);
  }

  callRpc(environment, tag, payload, options) {
    return callT3Rpc(environment, tag, payload, options);
  }

  openThreadStream(environment, input, options) {
    return openT3ThreadStream(environment, input, options);
  }
}

export class ConnectorOfflineError extends Error {
  constructor(environmentId) {
    super(`Connector for environment ${environmentId} is offline.`);
    this.name = "ConnectorOfflineError";
    this.code = "connector_offline";
    this.retryable = true;
    this.environmentId = environmentId;
  }
}

// Runtime-neutral request boundary. Node tests may provide a router; the Cloudflare adapter can
// implement the same two methods with a Durable Object without leaking that runtime into domain code.
export class ConnectorT3Transport {
  constructor(router) {
    if (!router || typeof router.request !== "function" || typeof router.openThreadStream !== "function") {
      throw new TypeError("ConnectorT3Transport requires request() and openThreadStream() router methods.");
    }
    this.router = router;
  }

  environmentInfo(environment, options) {
    return this.#request(environment, "environmentInfo", {}, options);
  }

  capabilityProbe(environment, options) {
    return this.#request(environment, "capabilityProbe", {}, options);
  }

  snapshot(environment, options) {
    return this.#request(environment, "snapshot", {}, options);
  }

  threadDetail(environment, threadId, options = {}) {
    return this.#request(environment, "threadDetail", {
      threadId,
      ...(Number.isSafeInteger(options.turnLimit) ? { turnLimit: options.turnLimit } : {}),
    }, options);
  }

  dispatch(environment, command, options) {
    return this.#request(environment, "dispatch", { command }, options);
  }

  callRpc(environment, tag, payload, options) {
    return this.#request(environment, "callRpc", { tag, payload }, options);
  }

  openThreadStream(environment, input, options) {
    return this.router.openThreadStream(requireConnectorEnvironment(environment), input, options);
  }

  async #request(environment, method, payload, options) {
    return await this.router.request(requireConnectorEnvironment(environment), { method, payload }, options);
  }
}

export function createT3TransportResolver({ direct = new DirectT3Transport(), connector = null } = {}) {
  const directAdapter = new T3Adapter(direct);
  const connectorAdapter = connector ? new T3Adapter(connector) : null;
  return {
    forEnvironment(environment) {
      if (environment?.transportMode === "connector") {
        if (!connectorAdapter) throw new ConnectorOfflineError(environment?.id ?? "unknown");
        return connectorAdapter;
      }
      return directAdapter;
    },
  };
}

function requireConnectorEnvironment(environment) {
  if (!environment?.id || !environment?.connectorId) {
    throw new TypeError("Connector-backed environments require id and connectorId.");
  }
  return environment;
}
