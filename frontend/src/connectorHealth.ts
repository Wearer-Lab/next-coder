import type { ConnectionState, Connector, Environment, EnvironmentFailure, JsonRecord } from "./types";
import type { StatusTone } from "./ui";

export type HealthLayerKey = "cloud" | "connector" | "t3" | "provider" | "proof";

export interface HealthLayer {
  key: HealthLayerKey;
  label: string;
  state: string;
  detail: string;
  tone: StatusTone;
  observedAt: string | null;
  stale: boolean;
}

const CONNECTOR_STALE_MS = 60_000;
const CONNECTOR_OFFLINE_MS = 90_000;

/**
 * Refines a generic snapshot failure only when public connector metadata is conclusive. T3-local
 * failures remain the server's classification; a missing or merely enrolled connector is still a
 * waiting state, not proof that a previously-live process went offline.
 */
export function connectorFailureFromMetadata(
  environment: Environment | null | undefined,
  connector: Connector | null | undefined,
  now = Date.now(),
): EnvironmentFailure | null {
  if (!environment || (environment.transportMode ?? "direct") !== "connector" || !connector) return null;
  if (connector.revokedAt || connector.status === "revoked") {
    return {
      reason: "connector_revoked",
      message: "The connector credential for this workspace computer was revoked.",
      retryable: false,
    };
  }
  if (connector.status === "incompatible" || (connector.protocolVersion != null && connector.protocolVersion !== 1)) {
    return {
      reason: "connector_incompatible",
      message: "The workspace connector is incompatible with the cloud protocol.",
      retryable: false,
      installedVersion: connector.connectorVersion ?? null,
    };
  }
  const observedAt = connector.lastSeenAt ?? connector.lastConnectedAt ?? connector.updatedAt ?? null;
  const observedTime = observedAt ? Date.parse(observedAt) : Number.NaN;
  const heartbeatExpired = Number.isFinite(observedTime) && now - observedTime > CONNECTOR_OFFLINE_MS;
  if (connector.status === "offline" || connector.status === "sleeping" || heartbeatExpired) {
    return {
      reason: "connector_offline",
      message: connector.status === "sleeping"
        ? "The workspace computer appears asleep and its connector is unavailable."
        : "No current connector heartbeat is available for this workspace computer.",
      retryable: true,
    };
  }
  return null;
}

export function connectorForEnvironment(
  connectors: Connector[] | null | undefined,
  environment: Environment | null | undefined,
): Connector | null {
  if (!environment) return null;
  return connectors?.find((connector) => connector.id === environment.connectorId)
    ?? connectors?.find((connector) => connector.environmentId === environment.id && !connector.revokedAt)
    ?? connectors?.find((connector) => connector.environmentId === environment.id)
    ?? null;
}

export function environmentHealthLayers({
  environment,
  connector,
  cloudConnection,
  proofReady = false,
  now = Date.now(),
}: {
  environment: Environment;
  connector: Connector | null;
  cloudConnection: ConnectionState;
  proofReady?: boolean;
  now?: number;
}): HealthLayer[] {
  const cloud = cloudLayer(cloudConnection);
  if ((environment.transportMode ?? "direct") !== "connector") {
    return [
      cloud,
      directLayer(environment),
      t3Layer(environment, null, false),
      providerLayer(environment, false),
      proofLayer(proofReady),
    ];
  }

  const connectorLayer = connectorStateLayer(connector, now);
  const projectionStale = environment.freshness === "stale" || connectorLayer.state !== "online";
  return [
    cloud,
    connectorLayer,
    t3Layer(environment, connector, projectionStale),
    providerLayer(environment, projectionStale),
    proofLayer(proofReady),
  ];
}

function cloudLayer(connection: ConnectionState): HealthLayer {
  if (connection === "connected" || connection === "live") {
    return layer("cloud", "Cloud", "operational", "Console is synchronized with Next Coder.", "success", null, false);
  }
  if (connection === "connecting" || connection === "reconnecting") {
    return layer("cloud", "Cloud", "degraded", "The console is reconnecting; cached state may be older than shown.", "warning", null, true);
  }
  return layer("cloud", "Cloud", "unavailable", "The console cannot currently verify the cloud service.", "danger", null, true);
}

function directLayer(environment: Environment): HealthLayer {
  const reachable = environment.status === "reachable";
  return layer(
    "connector",
    "Transport",
    "direct",
    reachable ? "Self-hosted gateway is reaching T3 directly." : "Advanced direct mode; no outbound connector is enrolled.",
    reachable ? "success" : "neutral",
    environment.health?.lastCheckedAt ?? null,
    !reachable,
  );
}

function connectorStateLayer(connector: Connector | null, now: number): HealthLayer {
  if (!connector) return layer("connector", "Connector", "waiting", "Run the enrollment command on the T3 computer.", "warning", null, true);
  const observedAt = connector.lastSeenAt ?? connector.lastConnectedAt ?? connector.updatedAt ?? null;
  const age = observedAt ? now - Date.parse(observedAt) : Number.POSITIVE_INFINITY;
  if (connector.revokedAt || connector.status === "revoked") {
    return layer("connector", "Connector", "revoked", "This credential was revoked. Create a new enrollment; the old secret cannot be reused.", "danger", connector.revokedAt ?? observedAt, true);
  }
  if (connector.status === "incompatible" || (connector.protocolVersion != null && connector.protocolVersion !== 1)) {
    return layer("connector", "Connector", "incompatible", "Update the local connector to protocol v1, then reconnect.", "danger", observedAt, true);
  }
  if (connector.status === "sleeping") {
    return layer("connector", "Connector", "sleeping", "The computer appears asleep; wake it to resume agent control.", "warning", observedAt, true);
  }
  if (connector.status === "online" && age <= CONNECTOR_STALE_MS) {
    return layer("connector", "Connector", "online", connectorVersionDetail(connector), "success", observedAt, false);
  }
  if ((connector.status === "online" && age <= CONNECTOR_OFFLINE_MS) || connector.status === "reconnecting") {
    return layer("connector", "Connector", "reconnecting", "Heartbeats are late; the connector may be changing networks or waking up.", "warning", observedAt, true);
  }
  if (connector.status === "enrolled" || connector.status === "waiting") {
    return layer("connector", "Connector", "waiting", "Enrollment is stored, but no live connector heartbeat has arrived yet.", "warning", observedAt, true);
  }
  return layer("connector", "Connector", "offline", "No current heartbeat. Wake the computer and run connector status or doctor locally.", "danger", observedAt, true);
}

function t3Layer(environment: Environment, connector: Connector | null, stale: boolean): HealthLayer {
  const observedAt = connector?.lastT3HealthAt ?? environment.health?.lastCheckedAt ?? null;
  const capabilityManifest = environment.health?.capabilities;
  const capabilityFailure = capabilityManifest?.recovery;
  const raw = connector?.lastT3Health
    ?? (environment.status === "reachable" ? "ready" : environment.health?.failureReason ?? "unknown");
  const state = capabilityFailure ? "incompatible" : typeof raw === "string" ? raw : "unknown";
  if (capabilityManifest?.runtimeKind === "direct" || connector?.capabilities?.includes("runtime.direct")) {
    const ready = state === "ready";
    return layer("t3", "Agent bridge", state,
      ready ? "The local direct-agent bridge is reachable. Native authentication is checked separately."
        : "The local direct-agent bridge is unavailable. Check the connector and configured agents.",
      stale ? "warning" : ready ? "success" : "warning", observedAt, stale);
  }
  const map: Record<string, [string, StatusTone]> = {
    ready: ["T3 is reachable and authenticated on the local computer.", "success"],
    starting: ["T3 is starting on the local computer.", "warning"],
    stopped: ["T3 is stopped. Start it locally, then keep the connector running.", "danger"],
    auth_failed: ["The local connector cannot authenticate to T3. Run doctor and refresh the local T3 credential.", "danger"],
    incompatible: [capabilityFailure
      ? `The probed T3 contract is incomplete. ${capabilityFailure.action}.`
      : "The installed T3 version is not compatible with this connector.", "danger"],
    error: [environment.health?.lastError ?? "The connector reported a local T3 error.", "danger"],
    unknown: ["No T3 health report has arrived yet.", "neutral"],
  };
  const [detail, tone] = map[state] ?? map.unknown;
  return layer("t3", "T3", state, detail, stale ? "warning" : tone, observedAt, stale);
}

function providerLayer(environment: Environment, stale: boolean): HealthLayer {
  const catalogue = environment.providerCatalogue as JsonRecord | null | undefined;
  const instances = Array.isArray(catalogue?.instances) ? catalogue.instances : [];
  const records = instances.filter((entry): entry is JsonRecord => Boolean(entry && typeof entry === "object"));
  const ready = records.some((entry) => {
    const auth = entry.auth && typeof entry.auth === "object" ? entry.auth as JsonRecord : null;
    const hasModels = Array.isArray(entry.models) && entry.models.length > 0;
    return hasModels && entry.status === "ready" && auth?.status === "authenticated";
  });
  const authRequired = records.some((entry) => {
    const auth = entry.auth && typeof entry.auth === "object" ? entry.auth as JsonRecord : null;
    return entry.status === "auth_required" || entry.status === "unauthenticated" || auth?.status === "unauthenticated" || auth?.status === "required";
  });
  const providerError = records.some((entry) => entry.status === "error" || entry.status === "failed");
  const modelUnavailable = records.length > 0 && records.every((entry) => Array.isArray(entry.models) && entry.models.length === 0);
  if (ready) return layer("provider", "Provider", "ready", "A registered provider catalogue is ready for model selection.", stale ? "warning" : "success", environment.lastProjectionAt ?? environment.updatedAt ?? null, stale);
  if (authRequired) return layer("provider", "Provider", "auth_required", "Authenticate the provider on the T3 computer.", "danger", environment.updatedAt ?? null, stale);
  if (providerError) return layer("provider", "Provider", "error", "The connector reported a local provider error.", "danger", environment.updatedAt ?? null, stale);
  if (modelUnavailable) return layer("provider", "Provider", "model_unavailable", "The registered providers do not currently expose a model.", "danger", environment.updatedAt ?? null, stale);
  return layer("provider", "Provider", "unknown", "Waiting for the connector to register the local provider catalogue.", "neutral", environment.updatedAt ?? null, true);
}

function proofLayer(ready: boolean): HealthLayer {
  return ready
    ? layer("proof", "Proof", "complete", "The first agent action produced a completed reply for this environment.", "success", null, false)
    : layer("proof", "Proof", "required", "Launch a first thread and wait for its agent reply before setup is complete.", "warning", null, true);
}

function connectorVersionDetail(connector: Connector): string {
  const detail = [connector.connectorVersion ? `v${connector.connectorVersion}` : null, connector.platform]
    .filter(Boolean)
    .join(" · ");
  return detail ? `Outbound connector ${detail} is online.` : "Outbound connector is online.";
}

function layer(
  key: HealthLayerKey,
  label: string,
  state: string,
  detail: string,
  tone: StatusTone,
  observedAt: string | null,
  stale: boolean,
): HealthLayer {
  return { key, label, state, detail, tone, observedAt, stale };
}
