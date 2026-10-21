import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FINAL_QUALIFICATION_SCHEMA,
  FinalQualificationError,
  REQUIRED_FINAL_EVIDENCE,
  verifyFinalQualification,
} from "../scripts/verify-final-qualification.mjs";

const NOW = Date.parse("2026-09-02T16:00:00.000Z");
const COMMIT = "a".repeat(40);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "next-coder-final-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = {};
  for (const [surface, contract] of Object.entries(REQUIRED_FINAL_EVIDENCE)) {
    const filename = `${surface}.json`;
    const document = {
      schema: contract.schema,
      result: "passed",
      targetCommit: COMMIT,
      finishedAt: new Date(NOW - 60_000).toISOString(),
      checks: Object.fromEntries(contract.checks.map((check) => [check, "passed"])),
    };
    const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
    await writeFile(join(root, filename), bytes);
    evidence[surface] = { file: filename, sha256: digest(bytes) };
  }
  const manifest = {
    schema: FINAL_QUALIFICATION_SCHEMA,
    targetCommit: COMMIT,
    createdAt: new Date(NOW).toISOString(),
    evidence,
  };
  const manifestPath = join(root, "final-qualification-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  return { root, manifest, manifestPath };
}

test("final qualification binds every product boundary to one commit and exact hash", async (t) => {
  const value = await fixture(t);
  const result = await verifyFinalQualification(value.manifestPath, { now: () => NOW, anchorCommit: async () => {} });
  assert.deepEqual(result, {
    schema: FINAL_QUALIFICATION_SCHEMA,
    result: "passed",
    targetCommit: COMMIT,
    evidenceSurfaces: 9,
  });
});

test("missing, failed, or commit-mismatched evidence cannot close the roadmap", async (t) => {
  const value = await fixture(t);
  delete value.manifest.evidence.productJourney;
  await writeFile(value.manifestPath, `${JSON.stringify(value.manifest)}\n`);
  await assert.rejects(
    verifyFinalQualification(value.manifestPath, { now: () => NOW, anchorCommit: async () => {} }),
    hasCode("manifest_evidence_incomplete"),
  );

  const second = await fixture(t);
  const reference = second.manifest.evidence.resilience;
  const path = join(second.root, reference.file);
  const document = JSON.parse(await readFile(path, "utf8"));
  document.checks.machine_sleep_wake = "failed";
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
  await writeFile(path, bytes);
  second.manifest.evidence.resilience.sha256 = digest(bytes);
  await writeFile(second.manifestPath, `${JSON.stringify(second.manifest)}\n`);
  await assert.rejects(
    verifyFinalQualification(second.manifestPath, { now: () => NOW, anchorCommit: async () => {} }),
    hasCode("evidence_resilience_machine_sleep_wake_not_passed"),
  );

  const third = await fixture(t);
  const npmReference = third.manifest.evidence.npmRelease;
  const npmPath = join(third.root, npmReference.file);
  const npmDocument = JSON.parse(await readFile(npmPath, "utf8"));
  npmDocument.targetCommit = "b".repeat(40);
  const npmBytes = Buffer.from(`${JSON.stringify(npmDocument)}\n`);
  await writeFile(npmPath, npmBytes);
  third.manifest.evidence.npmRelease.sha256 = digest(npmBytes);
  await writeFile(third.manifestPath, `${JSON.stringify(third.manifest)}\n`);
  await assert.rejects(
    verifyFinalQualification(third.manifestPath, { now: () => NOW, anchorCommit: async () => {} }),
    hasCode("evidence_npmRelease_commit_mismatch"),
  );
});

test("evidence references are bounded, flat, regular files with exact hashes", async (t) => {
  const value = await fixture(t);
  value.manifest.evidence.operations.file = "../operations.json";
  await writeFile(value.manifestPath, `${JSON.stringify(value.manifest)}\n`);
  await assert.rejects(
    verifyFinalQualification(value.manifestPath, { now: () => NOW, anchorCommit: async () => {} }),
    hasCode("evidence_operations_filename_invalid"),
  );

  const second = await fixture(t);
  second.manifest.evidence.performance.sha256 = "0".repeat(64);
  await writeFile(second.manifestPath, `${JSON.stringify(second.manifest)}\n`);
  await assert.rejects(
    verifyFinalQualification(second.manifestPath, { now: () => NOW, anchorCommit: async () => {} }),
    hasCode("evidence_performance_hash_mismatch"),
  );

  const third = await fixture(t);
  const target = join(third.root, third.manifest.evidence.rollback.file);
  await rm(target);
  await symlink(join(third.root, third.manifest.evidence.operations.file), target);
  await assert.rejects(
    verifyFinalQualification(third.manifestPath, { now: () => NOW, anchorCommit: async () => {} }),
    hasCode("evidence_rollback_file_type_invalid"),
  );
});

test("stale evidence and unknown fields fail closed", async (t) => {
  const value = await fixture(t);
  const reference = value.manifest.evidence.controllerHardware;
  const path = join(value.root, reference.file);
  const document = JSON.parse(await readFile(path, "utf8"));
  document.finishedAt = "2026-01-01T00:00:00.000Z";
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
  await writeFile(path, bytes);
  value.manifest.evidence.controllerHardware.sha256 = digest(bytes);
  await writeFile(value.manifestPath, `${JSON.stringify(value.manifest)}\n`);
  await assert.rejects(
    verifyFinalQualification(value.manifestPath, { now: () => NOW, anchorCommit: async () => {} }),
    hasCode("evidence_controllerHardware_stale"),
  );

  const second = await fixture(t);
  second.manifest.privateNotes = "must never be accepted";
  await writeFile(second.manifestPath, `${JSON.stringify(second.manifest)}\n`);
  await assert.rejects(
    verifyFinalQualification(second.manifestPath, { now: () => NOW, anchorCommit: async () => {} }),
    hasCode("manifest_shape_invalid"),
  );
});

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasCode(code) {
  return (error) => error instanceof FinalQualificationError && error.code === code;
}
