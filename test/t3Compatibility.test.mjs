import assert from "node:assert/strict";
import test from "node:test";

import {
  T3_COMPATIBILITY_POLICY,
  buildT3ReleaseStatus,
  compareT3Versions,
  evaluateT3Compatibility,
} from "../src/t3Compatibility.mjs";

const environment = { id: "env_1", label: "Studio Mac" };
const snapshot = { projects: [], threads: [] };

test("T3 semantic versions compare stable and prerelease builds", () => {
  assert.equal(compareT3Versions("0.0.28", "0.0.28"), 0);
  assert.equal(compareT3Versions("0.0.29", "0.0.28"), 1);
  assert.equal(compareT3Versions("0.0.28-nightly.1", "0.0.28"), -1);
  assert.equal(compareT3Versions("not-a-version", "0.0.28"), null);
});

test("the tested ceiling is not above the audited ceiling, and neither is a guess", () => {
  const { maximumTestedVersion: tested, maximumAuditedVersion: audited, minimumVersion } = T3_COMPATIBILITY_POLICY;
  assert.ok(compareT3Versions(minimumVersion, tested) < 0);
  assert.ok(compareT3Versions(tested, audited) <= 0, "audited (read) can only be at or above tested (run)");
  // 0.1.1 is the owner's production T3 and the newest release exercised live; 0.1.5 has only been
  // read (docs/t3-version-audit.md). Moving either needs new evidence, not a convenience edit.
  assert.equal(tested, "0.1.1");
  assert.equal(audited, "0.1.5");
});

test("a T3 release beyond everything verified raises a review warning", () => {
  const release = buildT3ReleaseStatus("0.1.6");
  assert.equal(release.status, "review_required");
  assert.equal(release.recommendedVersion, "0.1.1");
  assert.equal(release.maximumAuditedVersion, "0.1.5");
  assert.match(release.alert, /newer than the latest version Next Coder has verified \(0\.1\.1\)/u);
});

test("an audited-only release is flagged as read, never run, and does not become the recommendation", () => {
  const release = buildT3ReleaseStatus("0.1.5");
  assert.equal(release.status, "review_required");
  assert.equal(release.recommendedVersion, "0.1.1");
  assert.match(release.alert, /read by Next Coder but never run/u);
  assert.doesNotMatch(release.alert, /newer than the latest version Next Coder has verified/u);

  const result = evaluateT3Compatibility({
    environment,
    latestVersion: "0.1.5",
    metadata: { serverVersion: "0.1.5" },
    snapshot,
    serverConfig: { providers: [] },
  });
  assert.equal(result.status, "review_required");
  assert.equal(result.maximumTestedVersion, "0.1.1");
  assert.equal(result.maximumAuditedVersion, "0.1.5");
  assert.match(result.findings[0].message, /read statically, never run/u);
});

test("the version the owner runs in production is within the tested range", () => {
  for (const version of ["0.0.32", "0.1.1"]) {
    const result = evaluateT3Compatibility({
      environment,
      latestVersion: "0.1.1",
      metadata: { serverVersion: version },
      snapshot,
      serverConfig: { providers: [] },
    });
    assert.notEqual(result.status, "review_required", version);
    assert.equal(result.breakingRisk, false, version);
  }
});

test("a version change beyond the tested release is marked as a breaking risk", () => {
  const result = evaluateT3Compatibility({
    environment,
    latestVersion: "0.1.6",
    previous: { installedVersion: "0.1.1" },
    checkedAt: "2026-10-30T12:00:00.000Z",
    metadata: { serverVersion: "0.1.6" },
    snapshot,
    serverConfig: { providers: [] },
  });

  assert.equal(result.status, "review_required");
  assert.equal(result.versionChanged, true);
  assert.equal(result.breakingRisk, true);
  assert.equal(result.previousVersion, "0.1.1");
  assert.equal(result.checks.every((check) => check.passed), true);
  assert.match(result.recommendation, /0\.1\.1/u);
  assert.match(result.findings.find((finding) => finding.code === "version_newer_than_tested").message, /newer than the certified version 0\.1\.1/u);
});

test("a broken orchestration response is incompatible even on a supported version", () => {
  const result = evaluateT3Compatibility({
    environment,
    latestVersion: "0.0.28",
    metadata: { serverVersion: "0.0.28" },
    snapshot: { projects: [] },
    serverConfig: { providers: [] },
  });

  assert.equal(result.status, "incompatible");
  assert.equal(result.breakingRisk, true);
  assert.equal(result.checks.find((check) => check.id === "snapshot_contract").passed, false);
});

test("a broken websocket provider contract is incompatible", () => {
  const result = evaluateT3Compatibility({
    environment,
    latestVersion: "0.0.32",
    metadata: { serverVersion: "0.0.32" },
    snapshot,
    serverConfig: { environment: {} },
  });

  assert.equal(result.status, "incompatible");
  assert.equal(result.breakingRisk, true);
  assert.equal(result.checks.find((check) => check.id === "websocket_rpc").passed, true);
  assert.equal(result.checks.find((check) => check.id === "provider_catalogue_contract").passed, false);
});
