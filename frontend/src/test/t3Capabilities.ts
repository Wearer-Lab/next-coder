import type { Environment, T3CapabilityManifest } from "../types";

/**
 * Deterministic manifest for component tests whose subject is an available composer.
 *
 * This deliberately models a capable adapter rather than pretending to be a live probe. Tests
 * that exercise unsupported, missing, or stale capability evidence build those states explicitly
 * in `t3CapabilityAvailability.test.ts`.
 */
export function capableT3Environment(
  properties: Partial<Environment> = {},
): Environment {
  return {
    id: "env_1",
    label: "Test T3",
    health: { capabilities: capableT3Manifest() },
    ...properties,
  } as Environment;
}

function capableT3Manifest(): T3CapabilityManifest {
  return {
    schema: "next-coder.t3-capabilities.v1",
    contractVersion: "t3-adapter.v1",
    installedVersion: null,
    probedAt: "2099-01-01T00:00:00.000Z",
    freshUntil: "2099-01-01T00:05:00.000Z",
    freshness: "fresh",
    source: "connector_probe",
    probes: {},
    features: {
      dispatch: { state: "supported", evidence: "deterministic component fixture" },
      launch: { state: "supported", evidence: "deterministic component fixture" },
    },
    attachments: {
      image: { state: "supported", evidence: "deterministic component fixture" },
      audio: { state: "supported", evidence: "deterministic component fixture" },
      file: { state: "unsupported", evidence: "deterministic component fixture" },
      maxCount: 8,
      maxImageBytes: 10 * 1024 * 1024,
    },
    runtimeModes: [],
    interactionModes: [],
    approvalDecisions: [],
    recovery: null,
  };
}
