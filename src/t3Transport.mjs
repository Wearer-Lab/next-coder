import {
  dispatchT3Command,
  fetchT3EnvironmentInfo,
  fetchT3Snapshot,
  fetchT3ThreadDetail,
} from "./t3Client.mjs";
import { callT3Rpc, createOrchestrationProtocolCache, openT3ThreadStream } from "./t3Ws.mjs";
import { createV2StreamProjection } from "./t3Protocol2.mjs";
import { T3Adapter } from "./t3CapabilityManifest.mjs";

// Self-hosted transport: this process talks to T3 directly. Which orchestration protocol it speaks
// is decided per call from what the environment advertises (t3Ws negotiateOrchestrationProtocol):
// protocol 1 (T3 0.0.x) keeps its HTTP routes, protocol 2 (T3 >= 0.1.0) goes over the WebSocket.
// The advertised value is cached per instance for a few minutes so a poller does not pay a
// descriptor round trip on every tick. The cache is per instance on purpose, not module state: see
// createOrchestrationProtocolCache.
export class DirectT3Transport {
  #protocolCache;

  constructor({ protocolCache = createOrchestrationProtocolCache() } = {}) {
    this.#protocolCache = protocolCache;
  }

  #withCache(options) {
    return { ...options, protocolCache: options?.protocolCache ?? this.#protocolCache };
  }

  environmentInfo(environment, options) {
    return fetchT3EnvironmentInfo(environment, options);
  }

  snapshot(environment, options) {
    return fetchT3Snapshot(environment, this.#withCache(options));
  }

  threadDetail(environment, threadId, options) {
    return fetchT3ThreadDetail(environment, threadId, this.#withCache(options));
  }

  dispatch(environment, command, options = {}) {
    return dispatchT3Command(environment, command, this.#withCache(options));
  }

  callRpc(environment, tag, payload, options) {
    return callT3Rpc(environment, tag, payload, this.#withCache(options));
  }

  openThreadStream(environment, input = {}, options) {
    // Protocol 1 items already have the shape src/threadStream.mjs reads and pass straight
    // through. Protocol 2 items are a different projection, so they are mapped to the legacy
    // shapes here, exactly as the connector's openThreadStream does (packages/connector/src/t3.mjs;
    // the projection is the copy in src/t3Protocol2.mjs — they must move together).
    //
    // Two consequences are inherited from that design rather than chosen here:
    //  - protocol 2 is never RESUMED (`resumeProtocol2: false`). A replay is coalesced by T3
    //    (bundle-0.1.5.js:407176) and starts without a snapshot, which the projection cannot
    //    reconstruct a thread from, so every (re)connect asks for a fresh snapshot. The hub
    //    already treats "asked to resume, got a snapshot" as a reset with `gap: true`, so the
    //    consumer is told the intermediate history is gone instead of being shown a seamless lie.
    //  - a message update that does not extend the text the projection already holds cannot be
    //    expressed as a suffix delta, so the stream is closed with reason "protocol-reset" and the
    //    hub reconnects into a fresh snapshot.
    let project = null;
    let resetError = null;
    let handle = null;
    handle = openT3ThreadStream(environment, {
      ...input,
      resumeProtocol2: false,
      onOpen: (info) => {
        if (info?.orchestrationProtocolVersion === 2) project = createV2StreamProjection();
        input.onOpen?.(info);
      },
      onItem: (item) => {
        if (!project) {
          input.onItem?.(item);
          return;
        }
        try {
          for (const projected of project(item)) input.onItem?.(projected);
        } catch (error) {
          resetError = error;
          handle?.close();
        }
      },
      onClose: (detail) => {
        input.onClose?.(resetError ? { reason: "protocol-reset", error: resetError } : detail);
      },
    }, this.#withCache(options));
    return handle;
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
