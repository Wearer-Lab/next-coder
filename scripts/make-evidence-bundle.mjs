#!/usr/bin/env node

// Assembles SKELETON evidence bundles for the two Phase 7 gates and recomputes their hash links.
//
// This script never produces evidence. It produces an obviously-unfilled shape whose every claim
// field carries a `REPLACE_ME:` token that the repository's own verifiers reject:
//
//   - it never writes result "passed", a check result, or an operation value;
//   - it never writes a timestamp for an exercise that did not run;
//   - it never writes a commit id, a staging origin, or a source-artifact digest it was not given.
//
// The only values it computes on its own are the SHA-256 of bytes that actually exist on disk and,
// once every placeholder is gone, the manifest assembly time. `test/evidenceBundle.test.mjs` is the
// standing guard: it generates a bundle, asserts the verifier rejects it, fills the placeholders,
// and only then asserts the verifier accepts it.
//
// Usage:
//   node scripts/make-evidence-bundle.mjs init promotion <directory> [options]
//   node scripts/make-evidence-bundle.mjs init final-qualification <directory> [options]
//   node scripts/make-evidence-bundle.mjs refresh <directory>
//   node scripts/make-evidence-bundle.mjs status <directory>
//
// Options for `init`:
//   --commit <40-hex>        the candidate commit; omitted leaves a placeholder
//   --staging-origin <url>   promotion only: the qualified staging HTTPS origin
//   --artifact-digests       promotion only: compute the five tracked-source identities from THIS
//                            checkout (only correct on a clean checkout of the candidate commit)
//   --force                  overwrite files that already exist in the directory
//
// Exit codes: 0 complete and hash-linked, 1 placeholders remain or the manifest on disk is out
// of date, 2 usage or structural failure.

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  MAX_EVIDENCE_AGE_MS,
  PROMOTION_MANIFEST_SCHEMA,
  readTrackedArtifactDigests,
} from "./promote-production.mjs";
import {
  FINAL_QUALIFICATION_SCHEMA,
  MAX_FINAL_EVIDENCE_AGE_MS,
  REQUIRED_FINAL_EVIDENCE,
} from "./verify-final-qualification.mjs";

export const PLACEHOLDER_PREFIX = "REPLACE_ME:";
export const NOTES_FILE = "REPLACE-THESE.md";

const COMMIT = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;

const HINTS = Object.freeze({
  "result": '"passed" — only after the whole exercise really ran and passed',
  "check-result": '"passed" — this one named check, decided on its own',
  "finished-at": "ISO-8601 UTC instant that exercise actually finished",
  "created-at": "nothing: `refresh` stamps it once no other placeholder is left",
  "target-commit": "the 40-character lowercase candidate commit",
  "artifact-digest": "64-char SHA-256 from `npm run production:artifact-digests`",
  "staging-origin": "the exact qualified staging HTTPS origin",
  "release-operation": '"deploy" — a rollback record is not a promotion input',
});

const PROMOTION_EVIDENCE_SCHEMAS = Object.freeze({
  release: "next-coder.staging-release.v1",
  qualification: "next-coder.staging-qualification.v1",
  capacity: "next-coder.staging-capacity.v1",
  security: "next-coder.staging-security.v1",
});

export class EvidenceBundleError extends Error {
  constructor(code) {
    super(code);
    this.name = "EvidenceBundleError";
    this.code = code;
  }
}

function placeholder(kind) {
  if (!HINTS[kind]) throw new EvidenceBundleError("placeholder_kind_unknown");
  return `${PLACEHOLDER_PREFIX}${kind}`;
}

export function isPlaceholder(value) {
  return typeof value === "string" && value.startsWith(PLACEHOLDER_PREFIX);
}

export function findPlaceholders(value, file, pointer = "$") {
  if (isPlaceholder(value)) {
    const kind = value.slice(PLACEHOLDER_PREFIX.length);
    return [{ file, pointer, kind, hint: HINTS[kind] ?? "replace with a reviewed real value" }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findPlaceholders(item, file, `${pointer}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => findPlaceholders(item, file, `${pointer}.${key}`));
  }
  return [];
}

function kebab(name) {
  return name.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`);
}

function promotionSurfaces(context) {
  const commit = context.commit ?? placeholder("target-commit");
  return [
    {
      key: "release",
      file: "staging-release-evidence.json",
      source: "the passing `npm run staging:release` artifact — see docs/staging-release.md",
      document: {
        schema: PROMOTION_EVIDENCE_SCHEMAS.release,
        operation: placeholder("release-operation"),
        result: placeholder("result"),
        targetCommit: commit,
        finishedAt: placeholder("finished-at"),
      },
    },
    {
      key: "qualification",
      file: "staging-qualification-evidence.json",
      source: "the passing `npm run qualify:staging` artifact — see docs/staging-qualification.md",
      document: {
        schema: PROMOTION_EVIDENCE_SCHEMAS.qualification,
        result: placeholder("result"),
        target: { origin: context.stagingOrigin ?? placeholder("staging-origin") },
        finishedAt: placeholder("finished-at"),
      },
    },
    {
      key: "capacity",
      file: "staging-capacity-evidence.json",
      source: "an operator attestation written after the hosted matrix in docs/capacity-slo.md actually ran",
      document: {
        schema: PROMOTION_EVIDENCE_SCHEMAS.capacity,
        result: placeholder("result"),
        targetCommit: commit,
        finishedAt: placeholder("finished-at"),
      },
    },
    {
      key: "security",
      file: "staging-security-evidence.json",
      source: "an operator attestation written after the drills in docs/production-security.md actually ran",
      document: {
        schema: PROMOTION_EVIDENCE_SCHEMAS.security,
        result: placeholder("result"),
        targetCommit: commit,
        finishedAt: placeholder("finished-at"),
      },
    },
  ];
}

function finalQualificationSurfaces(context) {
  const commit = context.commit ?? placeholder("target-commit");
  return Object.entries(REQUIRED_FINAL_EVIDENCE).map(([key, contract]) => ({
    key,
    file: `${kebab(key)}.json`,
    source: `an operator record of the ${kebab(key).replace(/-/gu, " ")} exercises named in the active roadmap`,
    document: {
      schema: contract.schema,
      result: placeholder("result"),
      targetCommit: commit,
      finishedAt: placeholder("finished-at"),
      checks: Object.fromEntries(contract.checks.map((check) => [check, placeholder("check-result")])),
    },
  }));
}

export const TARGETS = Object.freeze({
  promotion: Object.freeze({
    name: "promotion",
    title: "production promotion evidence bundle",
    manifestFile: "promotion-manifest.json",
    maxFileBytes: 1024 * 1024,
    maxAgeMs: MAX_EVIDENCE_AGE_MS,
    filenamePattern: /^[A-Za-z0-9._-]+$/u,
    documentKeys: null,
    verifier: "the protected .github/workflows/production-promotion.yml jobs (scripts/promote-production.mjs)",
    doc: "docs/production-promotion.md",
    surfaces: promotionSurfaces,
    manifest(context, references) {
      return {
        schema: PROMOTION_MANIFEST_SCHEMA,
        targetCommit: context.commit ?? placeholder("target-commit"),
        createdAt: placeholder("created-at"),
        artifacts: Object.fromEntries(["console", "edge", "controlPlane", "container", "convex"]
          .map((surface) => [surface, context.artifacts?.[surface] ?? placeholder("artifact-digest")])),
        evidence: references,
      };
    },
  }),
  "final-qualification": Object.freeze({
    name: "final-qualification",
    title: "final qualification evidence bundle",
    manifestFile: "final-qualification-manifest.json",
    maxFileBytes: 256 * 1024,
    maxAgeMs: MAX_FINAL_EVIDENCE_AGE_MS,
    filenamePattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$/u,
    documentKeys: ["schema", "result", "targetCommit", "finishedAt", "checks"],
    verifier: "npm run verify:final-qualification",
    doc: "docs/final-qualification.md",
    surfaces: finalQualificationSurfaces,
    manifest(context, references) {
      return {
        schema: FINAL_QUALIFICATION_SCHEMA,
        targetCommit: context.commit ?? placeholder("target-commit"),
        createdAt: placeholder("created-at"),
        evidence: references,
      };
    },
  }),
});

function requireTarget(name) {
  const target = TARGETS[name];
  if (!target) throw new EvidenceBundleError("target_invalid");
  return target;
}

function serialize(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readEvidenceFile(target, directory, filename, key) {
  if (basename(filename) !== filename || !target.filenamePattern.test(filename)) {
    throw new EvidenceBundleError(`evidence_${key}_filename_unsafe`);
  }
  const path = join(directory, filename);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new EvidenceBundleError(`evidence_${key}_missing`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new EvidenceBundleError(`evidence_${key}_not_a_flat_file`);
  if (metadata.size > target.maxFileBytes) throw new EvidenceBundleError(`evidence_${key}_too_large`);
  const bytes = await readFile(path);
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new EvidenceBundleError(`evidence_${key}_json_invalid`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new EvidenceBundleError(`evidence_${key}_json_invalid`);
  }
  if (target.documentKeys) {
    const actual = Object.keys(document).sort();
    const wanted = [...target.documentKeys].sort();
    if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
      throw new EvidenceBundleError(`evidence_${key}_shape_invalid`);
    }
  }
  return { bytes, document, sha256: sha256(bytes) };
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function notes(target, placeholders) {
  const lines = [
    `# ${target.title} — replace these before it can pass`,
    "",
    "This directory was generated by `node scripts/make-evidence-bundle.mjs`. It is a SKELETON.",
    `Every value below is a \`${PLACEHOLDER_PREFIX}\` token that ${target.verifier} rejects.`,
    "It is not evidence and must never be presented as evidence.",
    "",
    "This notes file is not referenced by the manifest and is ignored by the verifier; delete it",
    "whenever you like. Re-run `node scripts/make-evidence-bundle.mjs refresh <directory>` after",
    "every edit so the manifest hashes match the exact bytes on disk.",
    "",
  ];
  if (placeholders.length === 0) {
    lines.push("No placeholders remain. The hash links are current as of the last `refresh`.", "");
  } else {
    lines.push(`## ${placeholders.length} placeholder${placeholders.length === 1 ? "" : "s"}`, "");
    lines.push("| File | Field | Replace with |", "| --- | --- | --- |");
    for (const item of placeholders) lines.push(`| \`${item.file}\` | \`${item.pointer}\` | ${item.hint} |`);
    lines.push("");
  }
  lines.push(
    "## Where each record comes from",
    "",
    ...target.surfaces({}).map((surface) => `- \`${surface.file}\` — ${surface.source}`),
    "",
    `See ${target.doc}.`,
    "",
  );
  return Buffer.from(lines.join("\n"), "utf8");
}

export async function initBundle({
  target: targetName,
  directory,
  commit = null,
  stagingOrigin = null,
  artifacts = null,
  force = false,
} = {}) {
  const target = requireTarget(targetName);
  if (typeof directory !== "string" || !directory.trim()) throw new EvidenceBundleError("directory_required");
  if (commit !== null && !COMMIT.test(commit)) throw new EvidenceBundleError("commit_invalid");
  if (stagingOrigin !== null && targetName !== "promotion") throw new EvidenceBundleError("staging_origin_not_supported");
  if (stagingOrigin !== null) requireHttpsOrigin(stagingOrigin);
  if (artifacts) {
    for (const digest of Object.values(artifacts)) {
      if (!HASH.test(String(digest))) throw new EvidenceBundleError("artifact_digest_invalid");
    }
  }
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const context = { commit, stagingOrigin, artifacts };
  const surfaces = target.surfaces(context);
  const paths = [...surfaces.map((surface) => surface.file), target.manifestFile];
  if (!force) {
    for (const name of paths) {
      if (await pathExists(join(root, name))) throw new EvidenceBundleError("bundle_file_exists");
    }
  }
  // A forced re-init starts from the operator's new inputs, not from a manifest left behind.
  await rm(join(root, target.manifestFile), { force: true });
  for (const surface of surfaces) {
    await writeFile(join(root, surface.file), serialize(surface.document), { mode: 0o600 });
  }
  return await refreshBundle({ directory: root, write: true, seed: context, target });
}

export async function refreshBundle({ directory, write = true, seed = null, target: known = null } = {}) {
  if (typeof directory !== "string" || !directory.trim()) throw new EvidenceBundleError("directory_required");
  const root = resolve(directory);
  const target = known ?? await detectTarget(root);
  const context = seed ?? { commit: null, stagingOrigin: null, artifacts: null };
  const surfaces = target.surfaces(context);
  const manifestPath = join(root, target.manifestFile);

  let manifest = null;
  let existingBytes = null;
  if (await pathExists(manifestPath)) {
    existingBytes = await readFile(manifestPath);
    try {
      manifest = JSON.parse(existingBytes.toString("utf8"));
    } catch {
      throw new EvidenceBundleError("manifest_json_invalid");
    }
  }

  const references = {};
  const placeholders = [];
  const used = new Set();
  for (const surface of surfaces) {
    const filename = manifest?.evidence?.[surface.key]?.file ?? surface.file;
    if (typeof filename !== "string") throw new EvidenceBundleError(`evidence_${surface.key}_reference_invalid`);
    if (used.has(filename)) throw new EvidenceBundleError("evidence_file_reused");
    used.add(filename);
    const entry = await readEvidenceFile(target, root, filename, surface.key);
    references[surface.key] = { file: filename, sha256: entry.sha256 };
    placeholders.push(...findPlaceholders(entry.document, filename));
  }

  const next = target.manifest(context, references);
  if (manifest) {
    if (manifest.targetCommit !== undefined) next.targetCommit = manifest.targetCommit;
    if (manifest.createdAt !== undefined) next.createdAt = manifest.createdAt;
    if (next.artifacts && manifest.artifacts && typeof manifest.artifacts === "object") {
      for (const key of Object.keys(next.artifacts)) {
        if (manifest.artifacts[key] !== undefined) next.artifacts[key] = manifest.artifacts[key];
      }
    }
  }

  const manifestPlaceholders = findPlaceholders(
    { ...next, createdAt: undefined },
    target.manifestFile,
  );
  const outstanding = [...placeholders, ...manifestPlaceholders];
  // The assembly time is the one timestamp this script may write, because it describes its own
  // action. It is stamped only when this run actually writes the manifest and nothing else is
  // still a placeholder, so a skeleton never carries a plausible date and a read-only `status`
  // never reports a manifest the disk does not hold.
  if (outstanding.length === 0 && write) next.createdAt = new Date().toISOString();
  if (isPlaceholder(next.createdAt)) {
    outstanding.push(...findPlaceholders(next.createdAt, target.manifestFile, "$.createdAt"));
  }

  const manifestBytes = serialize(next);
  if (manifestBytes.length > target.maxFileBytes) throw new EvidenceBundleError("manifest_too_large");
  // `status` must never hand an operator a hash the manifest on disk does not actually have.
  const stale = !write && (existingBytes === null || !existingBytes.equals(manifestBytes));
  if (write) {
    await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
    await writeFile(join(root, NOTES_FILE), notes(target, outstanding), { mode: 0o600 });
  }

  return {
    target: target.name,
    directory: root,
    manifestFile: target.manifestFile,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    manifest: next,
    files: surfaces.map((surface) => references[surface.key].file),
    placeholders: outstanding,
    stale,
    complete: outstanding.length === 0 && !stale,
    maxAgeHours: Math.round(target.maxAgeMs / 3_600_000),
  };
}

async function detectTarget(root) {
  const found = [];
  for (const target of Object.values(TARGETS)) {
    if (await pathExists(join(root, target.manifestFile))) found.push(target);
  }
  if (found.length === 1) return found[0];
  if (found.length > 1) throw new EvidenceBundleError("bundle_target_ambiguous");
  for (const target of Object.values(TARGETS)) {
    const surfaces = target.surfaces({});
    if (await pathExists(join(root, surfaces[0].file))) return target;
  }
  throw new EvidenceBundleError("bundle_not_found");
}

function requireHttpsOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new EvidenceBundleError("staging_origin_invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.origin !== value) {
    throw new EvidenceBundleError("staging_origin_invalid");
  }
  return url.origin;
}

function report(result, { verb = "Refreshed" } = {}) {
  const lines = [];
  lines.push(`${verb} ${result.target} bundle at ${result.directory}`);
  lines.push(`  manifest: ${result.manifestFile}  ${result.stale ? "recomputed sha256 (NOT the bytes on disk)" : "sha256"} ${result.manifestSha256}`);
  for (const file of result.files) lines.push(`  evidence: ${file}`);
  lines.push("");
  if (result.placeholders.length > 0) {
    lines.push("NOT EVIDENCE YET. A human must replace these before any verifier accepts this bundle:");
    const width = Math.max(...result.placeholders.map((item) => item.pointer.length));
    let current = null;
    for (const item of result.placeholders) {
      if (item.file !== current) {
        current = item.file;
        lines.push("", `  ${current}`);
      }
      lines.push(`    ${item.pointer.padEnd(width)}  ->  ${item.hint}`);
    }
    lines.push("");
    lines.push(`  ${result.placeholders.length} placeholder(s). Re-run \`refresh\` after editing so the hashes match.`);
    lines.push(`  Every record must describe an exercise that actually ran within ${result.maxAgeHours} hours of use.`);
  } else if (result.stale) {
    lines.push("No placeholders remain, but the manifest on disk does not match the evidence files.");
    lines.push("Run `refresh` on this directory before using any hash from it.");
  } else {
    lines.push("No placeholders remain. Hashes and the manifest assembly time are current.");
    if (result.target === "promotion" && COMMIT.test(String(result.manifest.targetCommit))) {
      lines.push("");
      lines.push("  Dispatch confirmation string:");
      lines.push(`  promote:production:${result.manifest.targetCommit}:${result.manifestSha256}`);
    }
    lines.push("");
    lines.push("  Review the manifest bytes and this SHA-256 independently before you use them.");
  }
  lines.push("");
  return lines.join("\n");
}

function parseArguments(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name === "force" || name === "artifact-digests") options[name] = true;
    else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new EvidenceBundleError(`option_${name}_requires_value`);
      options[name] = value;
      index += 1;
    }
  }
  return { positional, options };
}

const USAGE = `usage:
  node scripts/make-evidence-bundle.mjs init <promotion|final-qualification> <directory> [--commit <40-hex>] [--staging-origin <https-origin>] [--artifact-digests] [--force]
  node scripts/make-evidence-bundle.mjs refresh <directory>
  node scripts/make-evidence-bundle.mjs status <directory>`;

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    stderr.write(`${error.code}\n${USAGE}\n`);
    return 2;
  }
  const [verb, ...rest] = parsed.positional;
  try {
    if (verb === "init") {
      const [targetName, directory] = rest;
      if (!targetName || !directory || rest.length !== 2) throw new EvidenceBundleError("init_arguments_invalid");
      const artifacts = parsed.options["artifact-digests"]
        ? await readTrackedArtifactDigests(process.cwd())
        : null;
      if (artifacts) {
        stdout.write("Source-artifact identities were computed from THIS checkout. They are correct only\n");
        stdout.write("if this is a clean checkout of the exact candidate commit.\n\n");
      }
      const result = await initBundle({
        target: targetName,
        directory,
        commit: parsed.options.commit ?? null,
        stagingOrigin: parsed.options["staging-origin"] ?? null,
        artifacts,
        force: Boolean(parsed.options.force),
      });
      stdout.write(report(result, { verb: "Created" }));
      return result.complete ? 0 : 1;
    }
    if (verb === "refresh" || verb === "status") {
      const [directory] = rest;
      if (!directory || rest.length !== 1) throw new EvidenceBundleError(`${verb}_arguments_invalid`);
      const result = await refreshBundle({ directory, write: verb === "refresh" });
      stdout.write(report(result, { verb: verb === "refresh" ? "Refreshed" : "Checked" }));
      return result.complete ? 0 : 1;
    }
    throw new EvidenceBundleError("verb_invalid");
  } catch (error) {
    stderr.write(`${error?.code ?? "evidence_bundle_failed"}\n${USAGE}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
