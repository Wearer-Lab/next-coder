import { describe, expect, it } from "vitest";

import { composerAvailability, featureAvailability } from "./t3CapabilityAvailability";
import type { Environment, T3CapabilityManifest } from "./types";

function environment(manifest: T3CapabilityManifest | null): Environment {
  return { id: "env_1", label: "T3", health: { capabilities: manifest } } as Environment;
}

function manifest(overrides: Partial<T3CapabilityManifest> = {}): T3CapabilityManifest {
  return {
    schema: "next-coder.t3-capabilities.v1", contractVersion: "t3-adapter.v1",
    installedVersion: "0.0.32", probedAt: "2099-01-01T00:00:00.000Z",
    freshUntil: "2099-01-01T00:05:00.000Z", freshness: "fresh", source: "direct_probe",
    probes: {}, features: { dispatch: { state: "supported", evidence: "probe" }, launch: { state: "supported", evidence: "probe" } },
    attachments: {
      image: { state: "supported", evidence: "probe" }, audio: { state: "unsupported", evidence: "contract" },
      file: { state: "unsupported", evidence: "contract" }, maxCount: 8, maxImageBytes: 1024,
    }, runtimeModes: [], interactionModes: [], approvalDecisions: [], recovery: null,
    ...overrides,
  };
}

describe("T3 capability availability", () => {
  it("fails closed for unknown and stale manifests", () => {
    expect(featureAvailability(environment(null), "dispatch", Date.parse("2098-01-01"))).toMatchObject({ enabled: false });
    expect(featureAvailability(environment(manifest({ freshness: "stale" })), "dispatch", Date.parse("2098-01-01")))
      .toMatchObject({ enabled: false, reason: expect.stringContaining("stale") });
  });

  it("allows verified images and transcript-only audio but refuses raw audio and files", () => {
    const env = environment(manifest());
    const now = Date.parse("2099-01-01T00:01:00.000Z");
    expect(composerAvailability(env, [{ id: "img", kind: "image", contentType: "image/png" }], false, now).enabled).toBe(true);
    expect(composerAvailability(env, [{ id: "aud", kind: "audio", contentType: "audio/webm" }], false, now).enabled).toBe(false);
    expect(composerAvailability(env, [{ id: "aud", kind: "audio", contentType: "audio/webm", transcript: "Ready" }], false, now).enabled).toBe(true);
    expect(composerAvailability(env, [{ id: "file", kind: "file", contentType: "text/plain" }], false, now).enabled).toBe(false);
  });
});
