import { fetchT3EnvironmentInfo, fetchT3Snapshot } from "./t3Client.mjs";
import { callT3Rpc, T3_WS_METHODS } from "./t3Ws.mjs";
import {
  buildT3CapabilityManifest,
  ownerSafeT3CapabilityProjection,
  T3_ADAPTER_CONTRACT_VERSION,
} from "./t3CapabilityManifest.mjs";

// Next Coder's orchestration and websocket contracts were verified live against this
// release. Raise the ceiling only after the contract suite passes against a newer T3 host.
export const T3_COMPATIBILITY_POLICY = Object.freeze({
  minimumVersion: "0.0.28",
  maximumTestedVersion: "0.0.32",
  packageName: "t3",
  registryUrl: "https://registry.npmjs.org/t3/latest",
});

export async function fetchLatestT3Release({
  fetchImpl = globalThis.fetch,
  timeoutMs = 4000,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(T3_COMPATIBILITY_POLICY.registryUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`T3 release lookup failed with HTTP ${response.status}.`);
    const payload = await response.json();
    const version = normalizeVersion(payload?.version);
    if (!version) throw new Error("The T3 package registry response did not include a valid version.");
    return { version, checkedAt: new Date().toISOString() };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`T3 release lookup timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildT3ReleaseStatus(latestVersion, latestError = null) {
  const latest = normalizeVersion(latestVersion);
  const maximum = T3_COMPATIBILITY_POLICY.maximumTestedVersion;
  const comparison = latest ? compareT3Versions(latest, maximum) : null;
  const newerThanTested = comparison !== null && comparison > 0;
  return {
    packageName: T3_COMPATIBILITY_POLICY.packageName,
    latestVersion: latest,
    latestError,
    minimumVersion: T3_COMPATIBILITY_POLICY.minimumVersion,
    maximumTestedVersion: maximum,
    recommendedVersion: newerThanTested || !latest ? maximum : latest,
    status: latestError ? "unavailable" : newerThanTested ? "review_required" : "supported",
    alert: newerThanTested
      ? `T3 Code ${latest} is newer than the latest version Next Coder has verified (${maximum}).`
      : null,
  };
}

export function summarizeT3Compatibility(results, release) {
  const checks = Array.isArray(results) ? results : [];
  const breakingRisks = checks.filter((result) => result.breakingRisk).length;
  const incompatible = checks.filter((result) => result.status === "incompatible").length;
  const reviewRequired = checks.filter((result) => result.status === "review_required").length;
  const updatesRecommended = checks.filter((result) => result.status === "update_recommended").length;
  const unchecked = checks.filter((result) => !result.checkedAt).length;
  return {
    environments: checks.length,
    breakingRisks,
    incompatible,
    reviewRequired,
    updatesRecommended,
    unchecked,
    needsAttention: breakingRisks > 0
      || incompatible > 0
      || reviewRequired > 0
      || release?.status === "review_required"
      || release?.status === "unavailable",
  };
}

export async function runT3CompatibilityCheck({
  environment,
  latestVersion = null,
  previous = null,
  fetchImpl = globalThis.fetch,
  rpcImpl = null,
  WebSocketImpl = globalThis.WebSocket,
  transport = null,
  now = () => new Date(),
}) {
  if (transport?.capabilities && !rpcImpl) {
    const manifestResult = await Promise.allSettled([
      transport.capabilities(environment, { fetchImpl, WebSocketImpl, timeoutMs: 5000, force: true }),
    ]);
    if (manifestResult[0].status === "fulfilled") {
      return evaluateT3Compatibility({
        environment,
        latestVersion,
        previous,
        checkedAt: now().toISOString(),
        capabilityManifest: manifestResult[0].value,
      });
    }
  }
  const [metadataResult, snapshotResult, rpcResult] = await Promise.allSettled([
    transport
      ? transport.environmentInfo(environment, { fetchImpl, timeoutMs: 5000 })
      : fetchT3EnvironmentInfo(environment, { fetchImpl, timeoutMs: 5000 }),
    transport
      ? transport.snapshot(environment, { fetchImpl, timeoutMs: 5000 })
      : fetchT3Snapshot(environment, { fetchImpl, timeoutMs: 5000 }),
    transport
      ? transport.callRpc(environment, T3_WS_METHODS.serverGetConfig, {}, { fetchImpl, WebSocketImpl, timeoutMs: 5000 })
      : (rpcImpl ?? callT3Rpc)(environment, T3_WS_METHODS.serverGetConfig, {}, {
      fetchImpl,
      WebSocketImpl,
      timeoutMs: 5000,
    }),
  ]);

  return evaluateT3Compatibility({
    environment,
    latestVersion,
    previous,
    checkedAt: now().toISOString(),
    metadata: metadataResult.status === "fulfilled" ? metadataResult.value : null,
    metadataError: metadataResult.status === "rejected" ? errorMessage(metadataResult.reason) : null,
    snapshot: snapshotResult.status === "fulfilled" ? snapshotResult.value : null,
    snapshotError: snapshotResult.status === "rejected" ? errorMessage(snapshotResult.reason) : null,
    serverConfig: rpcResult.status === "fulfilled" ? rpcResult.value : null,
    serverConfigError: rpcResult.status === "rejected" ? errorMessage(rpcResult.reason) : null,
  });
}

export function evaluateT3Compatibility({
  environment,
  latestVersion = null,
  previous = null,
  checkedAt = new Date().toISOString(),
  metadata = null,
  metadataError = null,
  snapshot = null,
  snapshotError = null,
  serverConfig = null,
  serverConfigError = null,
  capabilityManifest = null,
}) {
  if (capabilityManifest) {
    return evaluateT3CompatibilityManifest({
      environment,
      latestVersion,
      previous,
      checkedAt,
      capabilityManifest,
    });
  }
  const release = buildT3ReleaseStatus(latestVersion);
  const installedVersion = normalizeVersion(metadata?.serverVersion);
  const previousVersion = normalizeVersion(previous?.installedVersion);
  const versionChanged = Boolean(previousVersion && installedVersion && previousVersion !== installedVersion);
  const snapshotShapeValid = Boolean(snapshot)
    && Array.isArray(snapshot.projects)
    && Array.isArray(snapshot.threads);
  const providerCatalogueValid = Boolean(serverConfig)
    && Array.isArray(serverConfig.providers);
  const checks = [
    {
      id: "environment_metadata",
      label: "Environment metadata",
      passed: Boolean(metadata) && !metadataError,
      detail: metadataError ?? (installedVersion ? `T3 Code ${installedVersion}` : "Version was not reported."),
    },
    {
      id: "orchestration_snapshot",
      label: "Orchestration snapshot",
      passed: Boolean(snapshot) && !snapshotError,
      detail: snapshotError ?? "Snapshot endpoint responded.",
    },
    {
      id: "snapshot_contract",
      label: "Project and thread contract",
      passed: snapshotShapeValid,
      detail: snapshotShapeValid
        ? "Projects and threads use the supported response shape."
        : "Snapshot must expose projects and threads arrays.",
    },
    {
      id: "websocket_rpc",
      label: "Authenticated WebSocket RPC",
      passed: Boolean(serverConfig) && !serverConfigError,
      detail: serverConfigError ?? "The read-only server.getConfig RPC responded.",
    },
    {
      id: "provider_catalogue_contract",
      label: "Provider catalogue contract",
      passed: providerCatalogueValid,
      detail: providerCatalogueValid
        ? "Provider instances use the supported response shape."
        : "server.getConfig must expose a providers array.",
    },
  ];

  const findings = [];
  let status = "compatible";
  if (checks.some((check) => !check.passed)) {
    status = "incompatible";
    findings.push({
      level: "danger",
      code: "contract_failed",
      message: "A read-only T3 API contract used by Next Coder failed its compatibility check.",
    });
  } else if (!installedVersion) {
    status = "unknown";
    findings.push({
      level: "warning",
      code: "version_missing",
      message: "T3 Code responded, but did not report a semantic server version.",
    });
  } else {
    const belowMinimum = compareT3Versions(installedVersion, T3_COMPATIBILITY_POLICY.minimumVersion);
    const aboveTested = compareT3Versions(installedVersion, T3_COMPATIBILITY_POLICY.maximumTestedVersion);
    if (belowMinimum !== null && belowMinimum < 0) {
      status = "incompatible";
      findings.push({
        level: "danger",
        code: "version_too_old",
        message: `T3 Code ${installedVersion} is older than the minimum supported version ${T3_COMPATIBILITY_POLICY.minimumVersion}.`,
      });
    } else if (aboveTested !== null && aboveTested > 0) {
      status = "review_required";
      findings.push({
        level: "warning",
        code: "version_newer_than_tested",
        message: `The read-only checks passed, but T3 Code ${installedVersion} is newer than the certified version ${T3_COMPATIBILITY_POLICY.maximumTestedVersion}.`,
      });
    } else if (
      release.recommendedVersion
      && compareT3Versions(installedVersion, release.recommendedVersion) < 0
    ) {
      status = "update_recommended";
      findings.push({
        level: "info",
        code: "update_available",
        message: `Update to T3 Code ${release.recommendedVersion} for the best supported compatibility.`,
      });
    }
  }

  if (versionChanged) {
    findings.unshift({
      level: status === "compatible" || status === "update_recommended" ? "info" : "warning",
      code: "version_changed",
      message: `T3 Code changed from ${previousVersion} to ${installedVersion} since the previous check.`,
    });
  }

  const breakingRisk = status === "incompatible" || (versionChanged && status === "review_required");
  const recommendation = recommendationFor({ status, installedVersion, release });

  return {
    environmentId: environment.id,
    environmentLabel: environment.label,
    checkedAt,
    installedVersion,
    previousVersion,
    versionChanged,
    status,
    compatible: status === "compatible" || status === "update_recommended",
    breakingRisk,
    latestVersion: release.latestVersion,
    recommendedVersion: release.recommendedVersion,
    minimumVersion: release.minimumVersion,
    maximumTestedVersion: release.maximumTestedVersion,
    recommendation,
    checks,
    findings,
  };
}

function evaluateT3CompatibilityManifest({ environment, latestVersion, previous, checkedAt, capabilityManifest }) {
  const probes = capabilityManifest.probes ?? {};
  const metadata = capabilityManifest.installedVersion
    ? { serverVersion: capabilityManifest.installedVersion }
    : {};
  const base = evaluateT3Compatibility({
    environment,
    latestVersion,
    previous,
    checkedAt,
    metadata,
    metadataError: probes.metadata === "passed" ? null : "Environment metadata probe failed.",
    snapshot: probes.snapshot === "passed" ? { projects: [], threads: [] } : null,
    snapshotError: probes.snapshot === "passed" ? null : "Snapshot probe failed.",
    serverConfig: probes.serverConfig === "passed" ? { providers: [] } : null,
    serverConfigError: probes.serverConfig === "passed" ? null : "WebSocket configuration probe failed.",
  });
  const adapterCurrent = capabilityManifest.contractVersion === T3_ADAPTER_CONTRACT_VERSION;
  if (!adapterCurrent) {
    base.status = "incompatible";
    base.compatible = false;
    base.breakingRisk = true;
    base.findings.unshift({
      level: "danger",
      code: "adapter_contract_unknown",
      message: "The T3 capability manifest uses an adapter contract this gateway does not understand.",
    });
  }
  base.capabilities = ownerSafeT3CapabilityProjection(capabilityManifest);
  return base;
}

export function compareT3Versions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

function recommendationFor({ status, installedVersion, release }) {
  if (status === "incompatible") {
    return `Install T3 Code ${release.recommendedVersion} and run the check again.`;
  }
  if (status === "review_required") {
    return `Use T3 Code ${release.recommendedVersion} for certified compatibility, or keep this version only after reviewing the passed contract checks.`;
  }
  if (status === "update_recommended") {
    return `Update from ${installedVersion} to T3 Code ${release.recommendedVersion}.`;
  }
  if (status === "unknown") {
    return `Use T3 Code ${release.recommendedVersion}, then run the check again.`;
  }
  return `T3 Code ${installedVersion} is on the recommended supported version.`;
}

function normalizeVersion(value) {
  const parsed = parseVersion(value);
  if (!parsed) return null;
  return `${parsed.parts.join(".")}${parsed.prerelease ? `-${parsed.prerelease}` : ""}`;
}

function parseVersion(value) {
  const match = String(value ?? "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u);
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? "",
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "T3 compatibility request failed.";
}
