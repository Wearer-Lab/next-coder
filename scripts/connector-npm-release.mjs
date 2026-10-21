import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const CONNECTOR_PACKAGE_NAME = "@next-coder/connector";
export const CONNECTOR_BIN_NAME = "next-coder-connect";
export const CONNECTOR_TAG_PREFIX = "connector-v";
export const RELEASE_EVIDENCE_SCHEMA_VERSION = 1;

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = resolve(dirname(scriptPath), "..");
const repositoryRoot = resolve(process.env.NPM_CONNECTOR_RELEASE_REPOSITORY_ROOT ?? defaultRepositoryRoot);
const packageDir = join(repositoryRoot, "packages", "connector");
const stableVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const forbiddenLifecycleScripts = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepack",
  "postpack",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
]);
const allowedTopLevelFiles = new Set(["LICENSE", "README.md", "package.json"]);
const allowedDirectories = ["bin/", "src/"];

export class ConnectorReleaseError extends Error {
  constructor(message, code = "connector_release_invalid") {
    super(message);
    this.name = "ConnectorReleaseError";
    this.code = code;
  }
}

export function expectedReleaseTag(version) {
  return `${CONNECTOR_TAG_PREFIX}${version}`;
}

export function expectedReleaseConfirmation({ version, tag, commit }) {
  return `publish:${CONNECTOR_PACKAGE_NAME}@${version}:${tag}:${commit}`;
}

export function validateReleaseAuthorization(input) {
  const {
    version,
    tag,
    commit,
    confirmation,
    checkedOutCommit,
    tagCommit,
    automationCommit,
    dispatchRef,
    defaultBranch,
  } = input;

  if (!stableVersionPattern.test(version ?? "")) {
    throw new ConnectorReleaseError("Connector releases require an exact stable semantic version.", "release_version_invalid");
  }
  if (!commitPattern.test(commit ?? "")) {
    throw new ConnectorReleaseError("The target commit must be an exact lowercase 40-character SHA.", "release_commit_invalid");
  }
  if (tag !== expectedReleaseTag(version)) {
    throw new ConnectorReleaseError(`The release tag must be ${expectedReleaseTag(version)}.`, "release_tag_invalid");
  }
  if (confirmation !== expectedReleaseConfirmation({ version, tag, commit })) {
    throw new ConnectorReleaseError("The release confirmation does not bind the exact package, version, tag, and commit.", "release_confirmation_invalid");
  }
  if (checkedOutCommit !== commit || tagCommit !== commit) {
    throw new ConnectorReleaseError("The checkout, annotated tag, and authorized commit must resolve to the same commit.", "release_source_mismatch");
  }
  if (!commitPattern.test(automationCommit ?? "")) {
    throw new ConnectorReleaseError("The protected automation commit is missing or invalid.", "release_automation_invalid");
  }
  if (!defaultBranch || dispatchRef !== defaultBranch) {
    throw new ConnectorReleaseError("Dispatch this workflow from the repository default branch.", "release_dispatch_ref_invalid");
  }
  return {
    version,
    tag,
    commit,
    automationCommit,
    confirmation: "validated",
  };
}

export function validatePackageManifest(manifest, { version, githubRepository, githubServerUrl = "https://github.com" }) {
  if (manifest?.name !== CONNECTOR_PACKAGE_NAME) {
    throw new ConnectorReleaseError(`Package name must remain ${CONNECTOR_PACKAGE_NAME}.`, "package_identity_invalid");
  }
  if (manifest.version !== version) {
    throw new ConnectorReleaseError("The package version does not match the authorized release version.", "package_version_mismatch");
  }
  if (manifest.private === true) {
    throw new ConnectorReleaseError("The connector package is marked private.", "package_private");
  }
  if (manifest.bin?.[CONNECTOR_BIN_NAME] !== "./bin/next-coder-connect.mjs") {
    throw new ConnectorReleaseError("The connector bin identity changed.", "package_bin_invalid");
  }
  if (manifest.engines?.node !== ">=22") {
    throw new ConnectorReleaseError("The connector Node engine contract changed.", "package_engine_invalid");
  }
  if (manifest.publishConfig?.access !== "public" || manifest.publishConfig?.provenance === false) {
    throw new ConnectorReleaseError("The connector must remain a public package with provenance enabled.", "package_publish_config_invalid");
  }
  if (typeof manifest.license !== "string" || manifest.license.trim().length === 0 || manifest.license === "UNLICENSED") {
    throw new ConnectorReleaseError(
      "The connector license is unresolved; a maintainer must select and document the release license.",
      "package_license_unresolved",
    );
  }
  if (!Array.isArray(manifest.files) || manifest.files.join("\0") !== ["bin", "src", "README.md", "LICENSE"].join("\0")) {
    throw new ConnectorReleaseError("The connector publish allowlist changed.", "package_files_invalid");
  }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundledDependencies"]) {
    const value = manifest[field];
    if (Array.isArray(value) ? value.length > 0 : value && Object.keys(value).length > 0) {
      throw new ConnectorReleaseError(`The dependency-free connector unexpectedly declares ${field}.`, "package_dependency_invalid");
    }
  }
  for (const script of Object.keys(manifest.scripts ?? {})) {
    if (forbiddenLifecycleScripts.has(script)) {
      throw new ConnectorReleaseError(`Forbidden publication lifecycle script: ${script}.`, "package_lifecycle_script_invalid");
    }
  }

  if (!githubRepository || !/^[^/\s]+\/[^/\s]+$/u.test(githubRepository)) {
    throw new ConnectorReleaseError("GITHUB_REPOSITORY is missing or invalid.", "package_repository_context_invalid");
  }
  const repository = typeof manifest.repository === "string" ? { url: manifest.repository } : manifest.repository;
  const canonicalRepositoryUrl = `${githubServerUrl}/${githubRepository}.git`;
  if (!repository || ![
    canonicalRepositoryUrl,
    `git+${canonicalRepositoryUrl}`,
  ].includes(repository.url)) {
    throw new ConnectorReleaseError(
      `package.json repository.url must match ${canonicalRepositoryUrl} for npm provenance.`,
      "package_repository_invalid",
    );
  }
  if (repository.type !== "git") {
    throw new ConnectorReleaseError("package.json repository.type must be git.", "package_repository_type_invalid");
  }
  if (repository.directory !== "packages/connector") {
    throw new ConnectorReleaseError("package.json repository.directory must be packages/connector.", "package_repository_directory_invalid");
  }
  return manifest;
}

export function validatePackMetadata(packed, { version }) {
  if (!packed || packed.name !== CONNECTOR_PACKAGE_NAME || packed.version !== version) {
    throw new ConnectorReleaseError("npm pack returned an unexpected package identity or version.", "pack_identity_invalid");
  }
  if (packed.filename !== `next-coder-connector-${version}.tgz`) {
    throw new ConnectorReleaseError("npm pack returned an unexpected tarball name.", "pack_filename_invalid");
  }
  if (!Number.isSafeInteger(packed.size) || packed.size <= 0 || packed.size > 1024 * 1024) {
    throw new ConnectorReleaseError("The packed connector exceeds the 1 MiB compressed release bound.", "pack_size_invalid");
  }
  if (!Number.isSafeInteger(packed.unpackedSize) || packed.unpackedSize <= 0 || packed.unpackedSize > 2 * 1024 * 1024) {
    throw new ConnectorReleaseError("The connector exceeds the 2 MiB unpacked release bound.", "pack_unpacked_size_invalid");
  }
  if (!Array.isArray(packed.files) || packed.files.length === 0 || packed.files.length > 64) {
    throw new ConnectorReleaseError("The connector file count is empty or exceeds the release bound.", "pack_file_count_invalid");
  }
  const paths = packed.files.map((file) => file.path);
  for (const required of ["LICENSE", "README.md", "package.json", "bin/next-coder-connect.mjs", "src/index.mjs"]) {
    if (!paths.includes(required)) throw new ConnectorReleaseError(`Packed connector is missing ${required}.`, "pack_required_file_missing");
  }
  for (const path of paths) {
    if (!allowedTopLevelFiles.has(path) && !allowedDirectories.some((prefix) => path.startsWith(prefix))) {
      throw new ConnectorReleaseError(`Unexpected packed path: ${path}.`, "pack_path_invalid");
    }
    if (/(?:^|\/)(?:test|scripts|node_modules|\.data)(?:\/|$)|(?:^|\/)\.env|\.(?:key|p12|pfx)$/iu.test(path)) {
      throw new ConnectorReleaseError(`Sensitive or development-only packed path: ${path}.`, "pack_sensitive_path");
    }
  }
  const bin = packed.files.find((file) => file.path === "bin/next-coder-connect.mjs");
  if ((bin.mode & 0o111) === 0) {
    throw new ConnectorReleaseError("The packed connector bin is not executable.", "pack_bin_not_executable");
  }
  return packed;
}

export function sanitizeRegistryMetadata(metadata, { version, integrity, shasum }) {
  if (metadata?.name !== CONNECTOR_PACKAGE_NAME || metadata.version !== version) {
    throw new ConnectorReleaseError("The registry returned a different package identity or version.", "registry_identity_invalid");
  }
  if (metadata.dist?.integrity !== integrity || metadata.dist?.shasum !== shasum) {
    throw new ConnectorReleaseError("The registry digest does not match the tested tarball.", "registry_digest_mismatch");
  }
  return {
    name: metadata.name,
    version: metadata.version,
    integrity: metadata.dist.integrity,
    shasum: metadata.dist.shasum,
  };
}

export function normalizeNpmPublishResult(result) {
  if (Array.isArray(result)) return result[0];
  if (result?.name) return result;
  return result?.[CONNECTOR_PACKAGE_NAME];
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function releaseEnvironment(env = process.env) {
  return {
    version: env.NPM_CONNECTOR_RELEASE_VERSION,
    tag: env.NPM_CONNECTOR_RELEASE_TAG,
    commit: env.NPM_CONNECTOR_RELEASE_COMMIT,
    confirmation: env.NPM_CONNECTOR_RELEASE_CONFIRMATION,
    checkedOutCommit: env.NPM_CONNECTOR_RELEASE_CHECKED_OUT_COMMIT,
    tagCommit: env.NPM_CONNECTOR_RELEASE_TAG_COMMIT,
    automationCommit: env.NPM_CONNECTOR_RELEASE_AUTOMATION_COMMIT,
    dispatchRef: env.NPM_CONNECTOR_RELEASE_DISPATCH_REF,
    defaultBranch: env.NPM_CONNECTOR_RELEASE_DEFAULT_BRANCH,
    githubRepository: env.GITHUB_REPOSITORY,
    githubServerUrl: env.GITHUB_SERVER_URL ?? "https://github.com",
  };
}

async function validatedContext(env = process.env) {
  const context = releaseEnvironment(env);
  validateReleaseAuthorization(context);
  const manifest = await readJson(join(packageDir, "package.json"));
  validatePackageManifest(manifest, context);
  return { context, manifest };
}

async function prepare() {
  const { context } = await validatedContext();
  const outputDir = resolve(process.env.NPM_CONNECTOR_RELEASE_OUTPUT_DIR ?? join(repositoryRoot, "connector-release-artifacts"));
  const evidencePath = resolve(process.env.NPM_CONNECTOR_RELEASE_EVIDENCE_PATH ?? join(outputDir, "connector-release-evidence.json"));
  await mkdir(outputDir, { recursive: true });

  await exec("npm", ["test"], { cwd: packageDir, maxBuffer: 16 * 1024 * 1024 });
  const { stdout } = await exec("npm", ["pack", "--json", "--pack-destination", outputDir], {
    cwd: packageDir,
    maxBuffer: 16 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || result.length !== 1) {
    throw new ConnectorReleaseError("npm pack must produce exactly one connector artifact.", "pack_result_invalid");
  }
  const packed = validatePackMetadata(result[0], context);
  const tarballPath = join(outputDir, packed.filename);

  const scratch = await mkdtemp(join(tmpdir(), "next-coder-connector-release-"));
  try {
    const installDir = join(scratch, "install");
    await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDir, tarballPath], {
      cwd: scratch,
      maxBuffer: 16 * 1024 * 1024,
    });
    const bin = join(installDir, "node_modules", ".bin", CONNECTOR_BIN_NAME);
    const help = await exec(bin, ["--help"], { cwd: scratch });
    if (!help.stdout.includes("Next Coder connector")) {
      throw new ConnectorReleaseError("The clean-installed connector help smoke failed.", "pack_help_smoke_failed");
    }
    const versionOutput = await exec(bin, ["update"], { cwd: scratch });
    if (!versionOutput.stdout.includes(context.version)) {
      throw new ConnectorReleaseError("The clean-installed connector version smoke failed.", "pack_version_smoke_failed");
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const dryRun = await exec("npm", [
    "publish",
    tarballPath,
    "--dry-run",
    "--json",
    "--ignore-scripts",
    "--access",
    "public",
  ], { cwd: packageDir, maxBuffer: 16 * 1024 * 1024 });
  const dryRunResult = JSON.parse(dryRun.stdout);
  const dryRunPackage = normalizeNpmPublishResult(dryRunResult);
  if (dryRunPackage?.name !== CONNECTOR_PACKAGE_NAME || dryRunPackage.version !== context.version) {
    throw new ConnectorReleaseError("npm publish --dry-run returned an unexpected package.", "publish_dry_run_invalid");
  }

  const evidence = {
    schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
    status: "prepared",
    package: CONNECTOR_PACKAGE_NAME,
    version: context.version,
    releaseTag: context.tag,
    sourceCommit: context.commit,
    automationCommit: context.automationCommit,
    tarball: {
      filename: packed.filename,
      sha256: await sha256(tarballPath),
      npmIntegrity: packed.integrity,
      npmShasum: packed.shasum,
      packedBytes: packed.size,
      unpackedBytes: packed.unpackedSize,
      fileCount: packed.files.length,
    },
    checks: {
      dependencyFree: true,
      connectorTests: "passed",
      cleanInstall: "passed",
      packageIdentity: "passed",
      npmPublishDryRun: "passed",
      externalNpmExec: "pending",
    },
  };
  await writeEvidence(evidencePath, evidence);
  console.log(JSON.stringify({ tarballPath, evidencePath, sha256: evidence.tarball.sha256 }));
}

async function recordPublish() {
  const { context } = await validatedContext();
  const evidencePath = resolve(requiredEnv("NPM_CONNECTOR_RELEASE_EVIDENCE_PATH"));
  const publishResultPath = resolve(requiredEnv("NPM_CONNECTOR_RELEASE_PUBLISH_RESULT_PATH"));
  const evidence = await readJson(evidencePath);
  const parsed = await readJson(publishResultPath);
  const published = normalizeNpmPublishResult(parsed);
  if (published?.name !== CONNECTOR_PACKAGE_NAME || published.version !== context.version) {
    throw new ConnectorReleaseError("npm publish returned an unexpected package.", "publish_result_invalid");
  }
  evidence.status = "published-awaiting-external-verification";
  evidence.publish = { name: published.name, version: published.version, provenanceRequested: true };
  await writeEvidence(evidencePath, evidence);
}

async function verifyArtifact() {
  const { context } = await validatedContext();
  const evidencePath = resolve(requiredEnv("NPM_CONNECTOR_RELEASE_EVIDENCE_PATH"));
  const evidence = await readJson(evidencePath);
  if (
    evidence.schemaVersion !== RELEASE_EVIDENCE_SCHEMA_VERSION
    || evidence.status !== "prepared"
    || evidence.package !== CONNECTOR_PACKAGE_NAME
    || evidence.version !== context.version
    || evidence.releaseTag !== context.tag
    || evidence.sourceCommit !== context.commit
    || evidence.automationCommit !== context.automationCommit
  ) {
    throw new ConnectorReleaseError("The downloaded candidate evidence does not match this authorization.", "release_evidence_mismatch");
  }
  const expectedChecks = ["dependencyFree", "connectorTests", "cleanInstall", "packageIdentity", "npmPublishDryRun"];
  if (expectedChecks.some((check) => evidence.checks?.[check] !== (check === "dependencyFree" ? true : "passed"))) {
    throw new ConnectorReleaseError("The downloaded candidate did not pass every publication prerequisite.", "release_evidence_incomplete");
  }
  if (!evidence.tarball?.filename || basename(evidence.tarball.filename) !== evidence.tarball.filename) {
    throw new ConnectorReleaseError("The candidate evidence contains an invalid tarball name.", "release_tarball_invalid");
  }
  const tarballPath = resolve(dirname(evidencePath), evidence.tarball.filename);
  if (await sha256(tarballPath) !== evidence.tarball.sha256) {
    throw new ConnectorReleaseError("The downloaded tarball hash does not match the verified candidate evidence.", "release_tarball_hash_mismatch");
  }
  console.log(JSON.stringify({ tarballPath, sha256: evidence.tarball.sha256 }));
}

async function finalize() {
  const { context } = await validatedContext();
  const evidencePath = resolve(requiredEnv("NPM_CONNECTOR_RELEASE_EVIDENCE_PATH"));
  const registryResultPath = resolve(requiredEnv("NPM_CONNECTOR_RELEASE_REGISTRY_RESULT_PATH"));
  const execResultPath = resolve(requiredEnv("NPM_CONNECTOR_RELEASE_EXEC_RESULT_PATH"));
  const evidence = await readJson(evidencePath);
  const registry = sanitizeRegistryMetadata(await readJson(registryResultPath), {
    version: context.version,
    integrity: evidence.tarball.npmIntegrity,
    shasum: evidence.tarball.npmShasum,
  });
  const execOutput = await readFile(execResultPath, "utf8");
  if (!execOutput.includes(context.version)) {
    throw new ConnectorReleaseError("Clean external npm exec did not report the released version.", "external_exec_invalid");
  }
  evidence.status = "verified";
  evidence.publish ??= { name: registry.name, version: registry.version, provenanceRequested: true };
  evidence.registry = registry;
  evidence.checks.externalNpmExec = "passed";
  await writeEvidence(evidencePath, evidence);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new ConnectorReleaseError(`${name} is required.`, "release_environment_missing");
  return value;
}

async function main() {
  const command = process.argv[2];
  if (command === "validate-local") {
    await validatedContext();
    console.log("Connector npm release authorization is valid.");
    return;
  }
  if (command === "prepare") return await prepare();
  if (command === "verify-artifact") return await verifyArtifact();
  if (command === "record-publish") return await recordPublish();
  if (command === "finalize") return await finalize();
  throw new ConnectorReleaseError("Usage: connector-npm-release.mjs validate-local|prepare|verify-artifact|record-publish|finalize");
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof ConnectorReleaseError ? error.code : "connector_release_failed";
    console.error(JSON.stringify({ error: code, message: error instanceof Error ? error.message : "Connector release failed." }));
    process.exitCode = 1;
  }
}
