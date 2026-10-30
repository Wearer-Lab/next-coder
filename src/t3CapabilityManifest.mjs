import {
  ALWAYS_PROVIDER_APPROVAL_DECISIONS,
  DEFAULT_OFFERED_PROVIDER_APPROVAL_DECISIONS,
} from "./providerApprovals.mjs";
import { T3_WS_METHODS } from "./t3Ws.mjs";

export const T3_CAPABILITY_MANIFEST_SCHEMA = "next-coder.t3-capabilities.v1";
export const T3_ADAPTER_CONTRACT_VERSION = "t3-adapter.v1";
export const T3_CAPABILITY_CACHE_TTL_MS = 5 * 60_000;

// The probe schema is a contract with the connector, and a connector installed before the rename
// still answers with the legacy one. The gateway accepts both so an installed connector keeps
// working; the connector only ever emits the current schema.
const T3_PROBE_SCHEMAS = Object.freeze(["next-coder.t3-probe.v1", "agent-controller.t3-probe.v1", "next-coder.runtime-probe.v1"]);

// Two lists, because T3 0.1.x's five-valued decision set is not one capability:
//
//   * `approvalDecisions` is what any approval request may be answered with unless it says
//     otherwise: T3's own web-UI fallback four. This is the list a client may draw buttons from
//     without looking at the request.
//   * `requestScopedApprovalDecisions` is the rest of the vocabulary (`acceptAlways`). It is
//     answerable ONLY when an individual request lists it in its own `options`: on Claude's
//     adapter it is silently turned into a deny, on generic ACP into a rejection. Listing it in
//     `approvalDecisions` would invite exactly that mistake, so the manifest says "exists, but
//     read the request" instead. Neither list is derived from the reported T3 version; a 0.0.x
//     server simply never sends a request that lists the fifth decision.
const APPROVAL_DECISIONS = DEFAULT_OFFERED_PROVIDER_APPROVAL_DECISIONS;
const REQUEST_SCOPED_APPROVAL_DECISIONS = ALWAYS_PROVIDER_APPROVAL_DECISIONS;
const RUNTIME_MODES = Object.freeze(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const INTERACTION_MODES = Object.freeze(["default", "plan"]);

/**
 * One versioned application boundary over either a direct or connector transport.
 * Capability discovery uses read-only responses and the methods the selected adapter actually
 * implements. It never dispatches a probe command and never treats the reported T3 version as a
 * feature flag.
 */
export class T3Adapter {
  constructor(transport, { now = Date.now, cacheTtlMs = T3_CAPABILITY_CACHE_TTL_MS } = {}) {
    if (!transport || typeof transport !== "object") throw new TypeError("T3Adapter requires a transport.");
    this.transport = transport;
    this.now = now;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();
  }

  environmentInfo(environment, options) { return this.#call("environmentInfo", [environment, options]); }
  snapshot(environment, options) { return this.#call("snapshot", [environment, options]); }
  threadDetail(environment, threadId, options) { return this.#call("threadDetail", [environment, threadId, options]); }
  dispatch(environment, command, options) { return this.#call("dispatch", [environment, command, options]); }
  callRpc(environment, tag, payload, options) { return this.#call("callRpc", [environment, tag, payload, options]); }
  openThreadStream(environment, input, options) { return this.#call("openThreadStream", [environment, input, options]); }

  async capabilities(environment, options = {}) {
    const key = environmentCacheKey(environment);
    const current = this.cache.get(key) ?? null;
    const nowMs = this.now();
    if (!options.force && current && Date.parse(current.freshUntil) > nowMs) {
      return { ...current, source: "cache", freshness: "fresh" };
    }
    try {
      const manifest = await this.#probe(environment, options);
      this.cache.set(key, manifest);
      return manifest;
    } catch (error) {
      if (current && options.allowStale !== false) {
        return { ...current, source: "cache", freshness: "stale", recovery: recoveryForProbeError(error) };
      }
      throw error;
    }
  }

  invalidateCapabilities(environment) { this.cache.delete(environmentCacheKey(environment)); }

  async #probe(environment, options) {
    const probedAtMs = this.now();
    const probeOptions = { ...options, timeoutMs: options.timeoutMs ?? 5_000 };
    delete probeOptions.force;
    delete probeOptions.allowStale;
    if (typeof this.transport.capabilityProbe === "function") {
      const probe = await this.transport.capabilityProbe(environment, probeOptions);
      if (!T3_PROBE_SCHEMAS.includes(probe?.schema)) {
        const error = new Error("T3 connector returned an unknown capability probe contract.");
        error.code = "t3_capability_probe_incompatible";
        throw error;
      }
      const manifest = buildT3CapabilityManifest({
        environment,
        metadata: probe.installedVersion ? { serverVersion: probe.installedVersion } : {},
        snapshot: probe.probes?.snapshot === "passed" ? { projects: [], threads: [] } : null,
        serverConfig: probe.probes?.serverConfig === "passed" ? {
          providers: [],
          threadSnapshotPagination: probe.serverCapabilities?.threadSnapshotPagination === true,
          threadResumeCompletionMarker: probe.serverCapabilities?.threadResumeCompletionMarker === true,
        } : null,
        probes: probe.probes ?? {},
        methodAvailability: adapterMethodAvailability(this.transport),
        probedAt: new Date(probedAtMs).toISOString(),
        freshUntil: new Date(probedAtMs + this.cacheTtlMs).toISOString(),
      });
      if (probe.schema === "next-coder.runtime-probe.v1") {
        manifest.runtimeKind = "direct";
        for (const name of ["terminal", "launch", "providerApprovals", "structuredUserInput", "interrupt", "sessionStop", "proposedPlans", "checkpoints", "taskLifecycle"]) {
          manifest.features[name] = { state: probe.features?.[name] === true && manifest.features.dispatch.state === "supported" ? "supported" : "unsupported", evidence: "direct_runtime_contract" };
        }
        manifest.attachments = { image: { state: "unsupported", evidence: "text_only_runtime" }, audio: { state: "unsupported", evidence: "text_only_runtime" }, file: { state: "unsupported", evidence: "text_only_runtime" }, maxCount: 0, maxImageBytes: 0 };
        manifest.runtimeModes = ["approval-required"];
        manifest.interactionModes = ["default"];
        manifest.approvalDecisions = ["accept", "decline", "cancel"];
        // A direct runtime offers only what the native agent exposed; no decision is held back
        // for a request to opt into, and none may be assumed.
        manifest.requestScopedApprovalDecisions = [];
      }
      return manifest;
    }
    const [metadataResult, snapshotResult, configResult] = await Promise.allSettled([
      this.environmentInfo(environment, probeOptions),
      this.snapshot(environment, probeOptions),
      this.callRpc(environment, T3_WS_METHODS.serverGetConfig, {}, probeOptions),
    ]);
    const metadata = fulfilled(metadataResult);
    const snapshot = fulfilled(snapshotResult);
    const serverConfig = fulfilled(configResult);
    const firstThreadId = Array.isArray(snapshot?.threads)
      ? snapshot.threads.find((thread) => typeof thread?.id === "string" && thread.id)?.id ?? null
      : null;
    const threadResult = firstThreadId
      ? await Promise.allSettled([this.threadDetail(environment, firstThreadId, { ...probeOptions, turnLimit: 1 })]).then(([result]) => result)
      : null;
    return buildT3CapabilityManifest({
      environment,
      metadata,
      snapshot,
      serverConfig,
      probes: {
        metadata: probeState(metadataResult),
        snapshot: probeState(snapshotResult),
        serverConfig: probeState(configResult),
        threadDetail: threadResult ? probeState(threadResult) : "not_exercised",
      },
      methodAvailability: adapterMethodAvailability(this.transport),
      probedAt: new Date(probedAtMs).toISOString(),
      freshUntil: new Date(probedAtMs + this.cacheTtlMs).toISOString(),
    });
  }

  #call(method, args) {
    if (typeof this.transport[method] !== "function") {
      const error = new Error(`T3 adapter method ${method} is unavailable.`);
      error.code = "t3_adapter_method_unavailable";
      error.method = method;
      throw error;
    }
    return this.transport[method](...args);
  }
}

export function buildT3CapabilityManifest({
  environment,
  metadata,
  snapshot,
  serverConfig,
  probes,
  methodAvailability,
  probedAt,
  freshUntil,
}) {
  const scopes = new Set(Array.isArray(environment?.scopes) ? environment.scopes : []);
  const snapshotContract = Boolean(snapshot) && Array.isArray(snapshot.projects) && Array.isArray(snapshot.threads);
  const configContract = Boolean(serverConfig) && Array.isArray(serverConfig.providers);
  const readable = scopes.has("orchestration:read") && snapshotContract;
  const operable = scopes.has("orchestration:operate")
    && methodAvailability.dispatch === true;
  const rpcAvailable = methodAvailability.callRpc === true && configContract;
  const pagination = serverConfig?.threadSnapshotPagination === true;
  const resumableStream = serverConfig?.threadResumeCompletionMarker === true
    && methodAvailability.openThreadStream === true;
  const installedVersion = semanticVersion(metadata?.serverVersion ?? metadata?.version);
  const source = environment?.transportMode === "connector" ? "connector_probe" : "direct_probe";
  const support = (value, evidence) => ({ state: value ? "supported" : "unsupported", evidence });
  const unknown = (evidence) => ({ state: "unknown", evidence });
  const threadDetail = probes.threadDetail === "passed"
    ? support(true, "thread_detail_probe")
    : pagination && methodAvailability.threadDetail
      ? support(true, "server_config_and_adapter_method")
      : probes.threadDetail === "not_exercised"
        ? unknown("no_thread_available_for_read_only_probe")
        : support(false, "thread_detail_probe_failed");

  return {
    schema: T3_CAPABILITY_MANIFEST_SCHEMA,
    contractVersion: T3_ADAPTER_CONTRACT_VERSION,
    installedVersion,
    probedAt,
    freshUntil,
    freshness: "fresh",
    source,
    probes,
    features: {
      shellSnapshot: support(readable, snapshotContract ? "snapshot_probe" : "snapshot_contract_failed"),
      threadDetail,
      threadPagination: support(pagination && methodAvailability.threadDetail, "server_config.threadSnapshotPagination"),
      threadSubscription: support(resumableStream, "server_config.threadResumeCompletionMarker"),
      dispatch: support(operable, scopes.has("orchestration:operate") ? "scope_and_adapter_method" : "scope_missing"),
      liveCatalogue: support(rpcAvailable, configContract ? "server_get_config_probe" : "server_config_contract_failed"),
      terminal: support(scopes.has("terminal:operate") && rpcAvailable, scopes.has("terminal:operate") ? "scope_and_rpc_probe" : "scope_missing"),
      launch: support(operable, "dispatch_adapter_contract"),
      providerApprovals: support(operable && readable, "dispatch_and_snapshot_contract"),
      structuredUserInput: support(operable && readable, "dispatch_and_snapshot_contract"),
      interrupt: support(operable, "dispatch_adapter_contract"),
      sessionStop: support(operable, "dispatch_adapter_contract"),
      proposedPlans: support(readable, "snapshot_contract"),
      checkpoints: support(readable, "snapshot_contract"),
      taskLifecycle: support(readable, "snapshot_contract"),
    },
    attachments: {
      image: support(operable, "certified_adapter_contract"),
      audio: support(false, "certified_adapter_contract"),
      file: support(false, "certified_adapter_contract"),
      maxCount: operable ? 8 : 0,
      maxImageBytes: operable ? 10 * 1024 * 1024 : 0,
    },
    runtimeModes: operable ? [...RUNTIME_MODES] : [],
    interactionModes: operable ? [...INTERACTION_MODES] : [],
    approvalDecisions: operable ? [...APPROVAL_DECISIONS] : [],
    requestScopedApprovalDecisions: operable ? [...REQUEST_SCOPED_APPROVAL_DECISIONS] : [],
    recovery: recoveryForManifest({ probes, snapshotContract, configContract, methodAvailability }),
  };
}

export function ownerSafeT3CapabilityProjection(manifest) {
  if (!manifest || manifest.schema !== T3_CAPABILITY_MANIFEST_SCHEMA) return null;
  return JSON.parse(JSON.stringify(manifest));
}

export function capabilitySupported(manifest, name) {
  return manifest?.features?.[name]?.state === "supported";
}

export function attachmentCapabilitySupported(manifest, kind) {
  return manifest?.attachments?.[kind]?.state === "supported";
}

export function capabilityManifestIsFresh(manifest, now = Date.now()) {
  return manifest?.freshness === "fresh"
    && Number.isFinite(Date.parse(manifest?.freshUntil))
    && Date.parse(manifest.freshUntil) > now;
}

function recoveryForManifest({ probes, snapshotContract, methodAvailability }) {
  if (!methodAvailability.snapshot || !methodAvailability.dispatch) {
    return { code: "adapter_incomplete", action: "UPDATE CONNECTOR" };
  }
  if (probes.snapshot !== "passed" || !snapshotContract) return { code: "snapshot_incompatible", action: "UPDATE T3 CODE" };
  return null;
}

function recoveryForProbeError(error) {
  return { code: typeof error?.code === "string" ? error.code : "probe_failed", action: "CHECK T3 CODE" };
}

function environmentCacheKey(environment) {
  return environment?.id ?? environment?.baseUrl ?? "unknown";
}

function adapterMethodAvailability(transport) {
  return Object.fromEntries(
    ["environmentInfo", "snapshot", "threadDetail", "dispatch", "callRpc", "openThreadStream"]
      .map((name) => [name, typeof transport[name] === "function"]),
  );
}

function fulfilled(result) { return result.status === "fulfilled" ? result.value : null; }
function probeState(result) { return result.status === "fulfilled" ? "passed" : "failed"; }
function semanticVersion(value) { return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value) ? value : null; }
