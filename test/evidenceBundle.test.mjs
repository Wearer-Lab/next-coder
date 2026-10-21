import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PLACEHOLDER_PREFIX,
  initBundle,
  main,
  isPlaceholder,
  refreshBundle,
} from "../scripts/make-evidence-bundle.mjs";
import { validateEvidenceBundle } from "../scripts/promote-production.mjs";
import { verifyFinalQualification } from "../scripts/verify-final-qualification.mjs";

const COMMIT = "b".repeat(40);
const STAGING_ORIGIN = "https://staging.example";

// A well-formed value for every placeholder kind the generator can emit. The generator itself must
// never produce any of these; that is the whole point of this file.
const FILLED = {
  "result": () => "passed",
  "check-result": () => "passed",
  "finished-at": () => new Date(Date.now() - 60_000).toISOString(),
  "target-commit": () => COMMIT,
  "artifact-digest": () => "1".repeat(64),
  "staging-origin": () => STAGING_ORIGIN,
  "release-operation": () => "deploy",
};

// Most assertions here are about bundle shape, staleness and tampering, so they stub the commit
// anchor. `rejects a filled bundle whose target commit is not in this checkout` below drives the
// real one.
const ANCHOR_STUB = { anchorCommit: async () => {} };

test("a generated final-qualification skeleton is rejected until a human fills it in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evidence-bundle-final-"));
  const created = await initBundle({ target: "final-qualification", directory, commit: COMMIT });
  assert.equal(created.complete, false);
  assert.ok(created.placeholders.length >= 60);

  await assertRejects(created.manifestPath, "manifest_stale");
  await assertSkeletonClaimsNothing(directory);

  // Filling every record but leaving one single named check unfilled still fails closed: the
  // manifest keeps its placeholder assembly time, so the bundle never even reaches the records.
  await fillBundle(directory, {
    skip: (file, pointer) => file === "controller-hardware.json" && pointer === "$.checks.ota_rollback",
  });
  const partial = await refreshBundle({ directory });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.placeholders.map((item) => item.pointer),
    ["$.checks.ota_rollback", "$.createdAt"]);
  await assertRejects(partial.manifestPath, "manifest_stale");

  await fillBundle(directory);
  const complete = await refreshBundle({ directory });
  assert.equal(complete.complete, true);
  assert.equal(complete.placeholders.length, 0);
  assert.equal(complete.manifestSha256, sha256(await readFile(complete.manifestPath)));

  const verified = await verifyFinalQualification(complete.manifestPath, ANCHOR_STUB);
  assert.deepEqual(verified, {
    schema: "next-coder.final-qualification-manifest.v1",
    result: "passed",
    targetCommit: COMMIT,
    evidenceSurfaces: 9,
  });

  // Every named check is individually load-bearing once the bundle is otherwise well formed.
  await mutate(join(directory, "controller-hardware.json"), (document) => {
    document.checks.ota_rollback = "failed";
  });
  await refreshBundle({ directory });
  await assertRejects(complete.manifestPath, "evidence_controllerHardware_ota_rollback_not_passed");
  await mutate(join(directory, "controller-hardware.json"), (document) => {
    document.checks.ota_rollback = "passed";
  });
  await refreshBundle({ directory });

  // An edit after the last refresh breaks the hash link rather than passing silently.
  await mutate(join(directory, "operations.json"), (document) => {
    document.finishedAt = new Date(Date.now() - 30_000).toISOString();
  });
  await assertRejects(complete.manifestPath, "evidence_operations_hash_mismatch");
  await refreshBundle({ directory });
  assert.equal((await verifyFinalQualification(complete.manifestPath, ANCHOR_STUB)).result, "passed");
});

test("a final-qualification skeleton without an operator commit cannot name a candidate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evidence-bundle-nocommit-"));
  const created = await initBundle({ target: "final-qualification", directory });
  assert.ok(isPlaceholder(created.manifest.targetCommit));
  await fillBundle(directory, { skip: (_file, _pointer, kind) => kind === "target-commit" });
  const refreshed = await refreshBundle({ directory });
  assert.equal(refreshed.complete, false);
  await assertRejects(refreshed.manifestPath, "manifest_commit_invalid");
});

test("a generated promotion skeleton is rejected until a human fills it in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evidence-bundle-promotion-"));
  const created = await initBundle({
    target: "promotion",
    directory,
    commit: COMMIT,
    stagingOrigin: STAGING_ORIGIN,
  });
  assert.equal(created.complete, false);
  await assertSkeletonClaimsNothing(directory);

  const skeletonInput = promotionInput(directory, created.manifestSha256);
  await assert.rejects(
    validateEvidenceBundle(skeletonInput, { now: () => Date.now() }),
    (error) => error.code === "manifest_stale",
  );

  await fillBundle(directory);
  const complete = await refreshBundle({ directory });
  assert.equal(complete.complete, true);
  const result = await validateEvidenceBundle(
    promotionInput(directory, complete.manifestSha256),
    { now: () => Date.now() },
  );
  assert.equal(result.manifest.targetCommit, COMMIT);
  assert.equal(result.evidence.release.operation, "deploy");
  assert.equal(result.evidence.qualification.target.origin, STAGING_ORIGIN);

  // The manifest hash the operator confirms is the hash of the bytes on disk.
  assert.equal(complete.manifestSha256, sha256(await readFile(complete.manifestPath)));
  await assert.rejects(
    validateEvidenceBundle(promotionInput(directory, "f".repeat(64)), { now: () => Date.now() }),
    (error) => error.code === "manifest_hash_mismatch",
  );
});

test("refresh never invents a timestamp while any other placeholder is left", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evidence-bundle-clock-"));
  await initBundle({ target: "final-qualification", directory, commit: COMMIT });
  await fillBundle(directory, { skip: (file) => file === "performance.json" });
  const partial = await refreshBundle({ directory });
  assert.ok(isPlaceholder(partial.manifest.createdAt));
  assert.ok(Number.isNaN(Date.parse(partial.manifest.createdAt)));

  await fillBundle(directory);
  const complete = await refreshBundle({ directory });
  assert.ok(Math.abs(Date.parse(complete.manifest.createdAt) - Date.now()) < 60_000);
});

test("the command line reports the unfilled bundle as not ready and refuses unknown work", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-bundle-cli-"));
  const directory = join(root, "bundle");
  const out = capture();
  assert.equal(await main(["init", "promotion", directory, "--commit", COMMIT], out.streams), 1);
  assert.match(out.stdout(), /NOT EVIDENCE YET/u);
  assert.match(out.stdout(), /\$\.artifacts\.console/u);

  assert.equal(await main(["init", "promotion", directory], capture().streams), 2, "must not clobber");
  assert.equal(await main(["init", "promotion", directory, "--commit", "nope"], capture().streams), 2);
  assert.equal(await main(["refresh"], capture().streams), 2);
  assert.equal(await main(["publish", directory], capture().streams), 2);

  // Records filled but not refreshed: read-only status still owes the operator no hash.
  await fillBundle(directory);
  const unrefreshed = capture();
  assert.equal(await main(["status", directory], unrefreshed.streams), 1);
  assert.doesNotMatch(unrefreshed.stdout(), /promote:production:/u);

  assert.equal(await main(["refresh", directory], capture().streams), 0);
  const ready = capture();
  assert.equal(await main(["status", directory], ready.streams), 0);
  assert.match(ready.stdout(), /No placeholders remain/u);
  assert.match(ready.stdout(), new RegExp(`promote:production:${COMMIT}:[0-9a-f]{64}`, "u"));

  // An edit after that refresh makes the manifest on disk wrong, and status says so instead of
  // reprinting a hash those bytes no longer have.
  await mutate(join(directory, "staging-capacity-evidence.json"), (document) => {
    document.finishedAt = new Date().toISOString();
  });
  const drifted = capture();
  assert.equal(await main(["status", directory], drifted.streams), 1);
  assert.match(drifted.stdout(), /does not match the evidence files/u);
  assert.doesNotMatch(drifted.stdout(), /promote:production:/u);
});

function capture() {
  const chunks = { out: [], err: [] };
  return {
    streams: {
      stdout: { write: (value) => chunks.out.push(value) },
      stderr: { write: (value) => chunks.err.push(value) },
    },
    stdout: () => chunks.out.join(""),
    stderr: () => chunks.err.join(""),
  };
}

async function assertSkeletonClaimsNothing(directory) {
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const text = await readFile(join(directory, name), "utf8");
    assert.equal(text.includes('"passed"'), false, `${name} must not claim a passing result`);
    const document = JSON.parse(text);
    for (const field of ["finishedAt", "createdAt"]) {
      if (document[field] === undefined) continue;
      assert.ok(isPlaceholder(document[field]), `${name}.${field} must stay a placeholder`);
      assert.ok(Number.isNaN(Date.parse(document[field])), `${name}.${field} must not parse as a date`);
    }
  }
}

async function mutate(path, change) {
  const document = JSON.parse(await readFile(path, "utf8"));
  change(document);
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
}

async function assertRejects(manifestPath, code) {
  await assert.rejects(verifyFinalQualification(manifestPath, ANCHOR_STUB), (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function fillBundle(directory, { skip = () => false } = {}) {
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json") || name.endsWith("-manifest.json")) continue;
    const path = join(directory, name);
    const document = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, `${JSON.stringify(fill(document, name, "$", skip), null, 2)}\n`);
  }
  const manifestName = (await readdir(directory)).find((name) => name.endsWith("-manifest.json"));
  if (!manifestName) return;
  const path = join(directory, manifestName);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (manifest.artifacts) {
    manifest.artifacts = fill(manifest.artifacts, manifestName, "$.artifacts", skip);
  }
  if (isPlaceholder(manifest.targetCommit) && !skip(manifestName, "$.targetCommit", "target-commit")) {
    manifest.targetCommit = COMMIT;
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function fill(value, file, pointer, skip) {
  if (isPlaceholder(value)) {
    const kind = value.slice(PLACEHOLDER_PREFIX.length);
    if (skip(file, pointer, kind) || !FILLED[kind]) return value;
    return FILLED[kind]();
  }
  if (Array.isArray(value)) return value.map((item, index) => fill(item, file, `${pointer}[${index}]`, skip));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, fill(item, file, `${pointer}.${key}`, skip)]));
  }
  return value;
}

function promotionInput(evidenceRoot, manifestHash) {
  return { evidenceRoot, manifestHash, targetCommit: COMMIT, stagingUrl: STAGING_ORIGIN };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Regression guard for the hole an adversarial review of this generator found on 2026-09-09: the
// skeleton is correctly rejected, but filling every placeholder mechanically produced a bundle the
// verifier ACCEPTED while naming a commit that had never existed. The generator being unable to
// fabricate proof was never the same as the pipeline being unable to. The verifier now anchors the
// target commit to the release checkout, and this test is what keeps that true.
test("rejects a filled bundle whose target commit is not in this checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evidence-bundle-fakecommit-"));
  await initBundle({ target: "final-qualification", directory, commit: "0".repeat(39) + "1" });
  await fillBundle(directory);
  const complete = await refreshBundle({ directory });
  assert.equal(complete.complete, true, "every placeholder replaced; only the commit is fictional");

  await assert.rejects(verifyFinalQualification(complete.manifestPath), (error) => {
    assert.equal(error.code, "manifest_commit_unknown");
    return true;
  });
});

test("accepts a filled bundle bound to a commit this checkout contains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evidence-bundle-realcommit-"));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await initBundle({ target: "final-qualification", directory, commit: head });
  await fillBundle(directory);
  const complete = await refreshBundle({ directory });

  const verified = await verifyFinalQualification(complete.manifestPath);
  assert.equal(verified.result, "passed");
  assert.equal(verified.targetCommit, head);
});
