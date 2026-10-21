#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const FINAL_QUALIFICATION_SCHEMA = "next-coder.final-qualification-manifest.v1";
export const MAX_FINAL_EVIDENCE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export const REQUIRED_FINAL_EVIDENCE = Object.freeze({
  repositorySecurity: Object.freeze({
    schema: "next-coder.final.repository-security.v1",
    checks: Object.freeze([
      "tracked_live_configs_absent",
      "history_reviewed",
      "credentials_rotated",
      "release_identity_approved",
      "repository_scan_passed",
    ]),
  }),
  npmRelease: Object.freeze({
    schema: "next-coder.final.npm-release.v1",
    checks: Object.freeze([
      "published_with_provenance",
      "registry_digest_verified",
      "macos_clean_exec",
      "linux_clean_exec",
      "windows_clean_exec",
      "managed_service_lifecycle",
      "native_credential_lifecycle",
    ]),
  }),
  cloudPromotion: Object.freeze({
    schema: "next-coder.final.cloud-promotion.v1",
    checks: Object.freeze([
      "staging_bootstrap",
      "staging_qualification",
      "production_promotion",
      "queue_cron_r2_convex",
      "service_bindings",
      "deployment_versions_bound",
    ]),
  }),
  productJourney: Object.freeze({
    schema: "next-coder.final.product-journey.v1",
    checks: Object.freeze([
      "fresh_account_enrollment",
      "connector_to_live_t3",
      "completed_streamed_reply",
      "gateway_approval",
      "provider_approval",
      "structured_user_input",
      "media_round_trip",
      "stop_cancel",
      "resume_reset",
      "immediate_revocation",
    ]),
  }),
  resilience: Object.freeze({
    schema: "next-coder.final.resilience.v1",
    checks: Object.freeze([
      "machine_sleep_wake",
      "wan_transition",
      "connector_restart",
      "durable_object_eviction",
      "deployment_rollover",
      "deduplicated_replay",
      "bounded_backpressure",
    ]),
  }),
  controllerHardware: Object.freeze({
    schema: "next-coder.final.controller-hardware.v1",
    checks: Object.freeze([
      "production_roots_installed",
      "expired_certificate_refused",
      "untrusted_certificate_refused",
      "claimed_device_cloud_operation",
      "blocking_interactions",
      "ota_rollback",
      "credential_revocation",
    ]),
  }),
  operations: Object.freeze({
    schema: "next-coder.final.operations.v1",
    checks: Object.freeze([
      "telemetry_privacy_review",
      "dashboard_ingestion",
      "alert_delivery",
      "queue_dlq_correlation",
      "retention_cleanup",
      "incident_runbook",
    ]),
  }),
  performance: Object.freeze({
    schema: "next-coder.final.performance.v1",
    checks: Object.freeze([
      "hosted_capacity_decision",
      "cloud_cost_observed",
      "wan_latency_budget",
      "connector_soak",
      "browser_cpu_gpu_heap",
      "firmware_responsiveness",
    ]),
  }),
  rollback: Object.freeze({
    schema: "next-coder.final.rollback.v1",
    checks: Object.freeze([
      "edge_rollback",
      "control_plane_rollback",
      "connector_rollback",
      "firmware_rollback",
      "durable_state_preserved",
    ]),
  }),
});

const SHA = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$/u;
const MAX_FILE_BYTES = 256 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export class FinalQualificationError extends Error {
  constructor(code) {
    super(code);
    this.name = "FinalQualificationError";
    this.code = code;
  }
}

const execFileAsync = promisify(execFile);

async function gitSucceeds(args) {
  try {
    await execFileAsync("git", args, { cwd: process.cwd(), timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

// The manifest's target commit is the only field tying nine self-attested records to real code, and
// a 40-character hex string is trivially invented. The promotion path already anchors its commit to
// the repository (`git merge-base --is-ancestor`, scripts/promote-production.mjs); this verifier
// checked the format alone, so a bundle naming a commit that had never existed passed. Run it from
// the exact release checkout: the candidate must be a commit this checkout actually contains.
export async function anchorCommitInCheckout(targetCommit) {
  if (!(await gitSucceeds(["rev-parse", "--verify", "--quiet", `${targetCommit}^{commit}`]))) {
    throw new FinalQualificationError("manifest_commit_unknown");
  }
  if (!(await gitSucceeds(["merge-base", "--is-ancestor", targetCommit, "HEAD"]))) {
    throw new FinalQualificationError("manifest_commit_not_in_checkout");
  }
}

export async function verifyFinalQualification(
  manifestPath,
  { now = () => Date.now(), anchorCommit = anchorCommitInCheckout } = {},
) {
  const absoluteManifest = resolve(manifestPath);
  const manifest = parseJson(
    await readRegularFile(absoluteManifest, "manifest"),
    "manifest_json_invalid",
  );
  requireExactKeys(manifest, ["schema", "targetCommit", "createdAt", "evidence"], "manifest_shape_invalid");
  requireEqual(manifest.schema, FINAL_QUALIFICATION_SCHEMA, "manifest_schema_invalid");
  requireMatch(manifest.targetCommit, SHA, "manifest_commit_invalid");
  await anchorCommit(manifest.targetCommit);
  requireFresh(manifest.createdAt, now(), "manifest_stale");

  const evidence = requireRecord(manifest.evidence, "manifest_evidence_invalid");
  const surfaces = Object.keys(REQUIRED_FINAL_EVIDENCE);
  requireExactKeys(evidence, surfaces, "manifest_evidence_incomplete");
  const root = dirname(absoluteManifest);
  const usedFiles = new Set();

  for (const surface of surfaces) {
    const contract = REQUIRED_FINAL_EVIDENCE[surface];
    const reference = requireRecord(evidence[surface], `evidence_${surface}_reference_invalid`);
    requireExactKeys(reference, ["file", "sha256"], `evidence_${surface}_reference_invalid`);
    const filename = requireSafeFilename(reference.file, `evidence_${surface}_filename_invalid`);
    if (usedFiles.has(filename)) throw new FinalQualificationError("evidence_file_reused");
    usedFiles.add(filename);
    const expectedHash = requireMatch(reference.sha256, HASH, `evidence_${surface}_hash_invalid`);
    const bytes = await readRegularFile(join(root, filename), `evidence_${surface}`);
    if (sha256(bytes) !== expectedHash) {
      throw new FinalQualificationError(`evidence_${surface}_hash_mismatch`);
    }
    const document = parseJson(bytes, `evidence_${surface}_json_invalid`);
    requireExactKeys(
      document,
      ["schema", "result", "targetCommit", "finishedAt", "checks"],
      `evidence_${surface}_shape_invalid`,
    );
    requireEqual(document.schema, contract.schema, `evidence_${surface}_schema_invalid`);
    requireEqual(document.result, "passed", `evidence_${surface}_not_passed`);
    requireEqual(document.targetCommit, manifest.targetCommit, `evidence_${surface}_commit_mismatch`);
    requireFresh(document.finishedAt, now(), `evidence_${surface}_stale`);
    const checks = requireRecord(document.checks, `evidence_${surface}_checks_invalid`);
    requireExactKeys(checks, contract.checks, `evidence_${surface}_checks_incomplete`);
    for (const check of contract.checks) {
      requireEqual(checks[check], "passed", `evidence_${surface}_${check}_not_passed`);
    }
  }

  return Object.freeze({
    schema: FINAL_QUALIFICATION_SCHEMA,
    result: "passed",
    targetCommit: manifest.targetCommit,
    evidenceSurfaces: surfaces.length,
  });
}

async function readRegularFile(path, boundary) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new FinalQualificationError(`${boundary}_missing`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new FinalQualificationError(`${boundary}_file_type_invalid`);
  }
  if (metadata.size > MAX_FILE_BYTES) throw new FinalQualificationError(`${boundary}_too_large`);
  return await readFile(path);
}

function parseJson(bytes, code) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new FinalQualificationError(code);
  }
}

function requireRecord(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FinalQualificationError(code);
  return value;
}

function requireExactKeys(value, expected, code) {
  const record = requireRecord(value, code);
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new FinalQualificationError(code);
  }
  return record;
}

function requireSafeFilename(value, code) {
  if (typeof value !== "string" || basename(value) !== value || !SAFE_FILE.test(value)) {
    throw new FinalQualificationError(code);
  }
  return value;
}

function requireMatch(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) throw new FinalQualificationError(code);
  return value;
}

function requireEqual(actual, expected, code) {
  if (actual !== expected) throw new FinalQualificationError(code);
}

function requireFresh(value, now, code) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)
    || timestamp > now + CLOCK_SKEW_MS
    || timestamp < now - MAX_FINAL_EVIDENCE_AGE_MS) {
    throw new FinalQualificationError(code);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath || process.argv.length !== 3) {
    throw new FinalQualificationError("usage: node scripts/verify-final-qualification.mjs <manifest.json>");
  }
  const result = await verifyFinalQualification(manifestPath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "final_qualification_failed"}\n`);
    process.exitCode = 1;
  });
}
