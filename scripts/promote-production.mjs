#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readlink, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readEnv } from "./environment.mjs";

import { runStagingQualification } from "./qualify-staging.mjs";

export const PROMOTION_EVIDENCE_SCHEMA = "next-coder.production-promotion.v1";
export const PROMOTION_MANIFEST_SCHEMA = "next-coder.staging-promotion-manifest.v1";
export const MAX_EVIDENCE_AGE_MS = 72 * 60 * 60 * 1000;
export const REQUIRED_PRODUCTION_QUEUES = Object.freeze([
  "agent-controller-connector-events-production",
  "agent-controller-background-production",
  "agent-controller-dead-letter-production",
]);
export const REQUIRED_CONTROL_PLANE_SECRETS = Object.freeze([
  "PUBLIC_BASE_URL", "CONVEX_URL", "GATEWAY_CONVEX_SECRET", "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY", "T3_TOKEN_ENCRYPTION_KEY", "S3_ENDPOINT", "S3_BUCKET",
  "FIRMWARE_S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "WEB_PUSH_VAPID_KEYS",
  "WEB_PUSH_STORAGE_ENCRYPTION_KEY",
]);

const SHA = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const VERSION = /^[0-9a-f-]{16,64}$/u;
const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;
const EDGE_SERVICE = "agent-controller-cloud-production";
const CONTROL_SERVICE = "agent-controller-control-plane-production";
const CF_SECRETS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];
const CONVEX_SECRETS = ["CONVEX_DEPLOY_KEY"];
const ALLOWED_CHILD_ENV = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "CI", "NO_COLOR"];
const ARTIFACT_SURFACES = Object.freeze({
  console: ["frontend/", "package.json", "package-lock.json"],
  edge: ["cloudflare/", "frontend/", "package.json", "package-lock.json"],
  controlPlane: ["cloudflare-control-plane/src/", "cloudflare-control-plane/package.json", "cloudflare-control-plane/package-lock.json", "cloudflare-control-plane/wrangler.jsonc"],
  container: ["cloudflare-control-plane/Dockerfile", "cloudflare-control-plane/Dockerfile.dockerignore", "cloudflare-control-plane/container-runtime/", "src/"],
  convex: ["convex/", "package.json", "package-lock.json"],
});

export class ProductionPromotionError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProductionPromotionError";
    this.code = code;
  }
}

export function normalizePromotionInput(environment = process.env) {
  const targetCommit = requireMatch(environment.PRODUCTION_PROMOTION_TARGET_COMMIT, SHA, "target_commit_invalid");
  const currentCommit = requireMatch(environment.PRODUCTION_PROMOTION_CURRENT_COMMIT, SHA, "current_commit_invalid");
  const checkedOutCommit = requireMatch(environment.PRODUCTION_PROMOTION_CHECKED_OUT_COMMIT, SHA, "checked_out_commit_invalid");
  const automationCommit = requireMatch(environment.PRODUCTION_PROMOTION_AUTOMATION_COMMIT, SHA, "automation_commit_invalid");
  const manifestHash = requireMatch(environment.PRODUCTION_PROMOTION_MANIFEST_SHA256, HASH, "manifest_hash_invalid");
  const defaultBranch = requireText(environment.PRODUCTION_PROMOTION_DEFAULT_BRANCH, "default_branch_required");
  const dispatchRef = requireText(environment.PRODUCTION_PROMOTION_DISPATCH_REF, "dispatch_ref_required");
  const confirmation = requireText(environment.PRODUCTION_PROMOTION_CONFIRMATION, "confirmation_required");
  if (dispatchRef !== defaultBranch) throw new ProductionPromotionError("workflow_not_dispatched_from_default_branch");
  if (checkedOutCommit !== targetCommit) throw new ProductionPromotionError("checkout_not_target_commit");
  if (targetCommit === currentCommit) throw new ProductionPromotionError("target_must_differ_from_current");
  if (confirmation !== `promote:production:${targetCommit}:${manifestHash}`) {
    throw new ProductionPromotionError("confirmation_mismatch");
  }
  return {
    targetCommit,
    currentCommit,
    checkedOutCommit,
    automationCommit,
    manifestHash,
    defaultBranch,
    dispatchRef,
    currentEdgeVersion: requireMatch(environment.PRODUCTION_PROMOTION_CURRENT_EDGE_VERSION, VERSION, "current_edge_version_invalid"),
    currentControlVersion: requireMatch(environment.PRODUCTION_PROMOTION_CURRENT_CONTROL_PLANE_VERSION, VERSION, "current_control_plane_version_invalid"),
    repositoryRoot: resolve(environment.PRODUCTION_PROMOTION_REPOSITORY_ROOT ?? process.cwd()),
    evidenceRoot: resolve(environment.PRODUCTION_PROMOTION_EVIDENCE_ROOT ?? join(process.cwd(), "promotion-evidence")),
    evidencePath: resolve(environment.PRODUCTION_PROMOTION_OUTPUT_PATH ?? join(process.cwd(), "production-promotion-evidence.json")),
    stagingUrl: requireHttpsUrl(readEnv(environment, "NEXT_CODER_STAGING_URL"), "staging_url_invalid"),
    productionUrl: requireHttpsUrl(readEnv(environment, "NEXT_CODER_PRODUCTION_URL"), "production_url_invalid"),
    mediaBucket: requireText(readEnv(environment, "NEXT_CODER_PRODUCTION_MEDIA_BUCKET"), "production_media_bucket_required"),
    firmwareBucket: requireText(readEnv(environment, "NEXT_CODER_PRODUCTION_FIRMWARE_BUCKET"), "production_firmware_bucket_required"),
  };
}

export function validateProductionTopology(edge, controlPlane) {
  const stagingEdge = record(edge?.env?.staging, "edge_staging_environment_missing");
  const productionEdge = record(edge?.env?.production, "edge_production_environment_missing");
  const stagingControl = record(controlPlane?.env?.staging, "control_staging_environment_missing");
  const productionControl = record(controlPlane?.env?.production, "control_production_environment_missing");
  requireEqual(productionEdge.name, EDGE_SERVICE, "edge_service_mismatch");
  requireEqual(productionControl.name, CONTROL_SERVICE, "control_plane_service_mismatch");
  requireEqual(productionEdge.vars?.DEPLOYMENT_ENVIRONMENT, "production", "edge_environment_marker_mismatch");
  requireEqual(productionEdge.vars?.CONNECTOR_AUTH_MODE, "control-plane", "edge_connector_auth_not_cloud");
  requireEqual(productionControl.vars?.DEPLOYMENT_ENVIRONMENT, "production", "control_environment_marker_mismatch");
  requireEqual(productionEdge.services?.find((item) => item?.binding === "CONTROL_PLANE")?.service,
    CONTROL_SERVICE, "control_plane_binding_mismatch");
  const router = productionControl.services?.find((item) => item?.binding === "CONNECTOR_ROUTER");
  requireEqual(router?.service, EDGE_SERVICE, "connector_router_binding_mismatch");
  requireEqual(router?.entrypoint, "ControlPlaneConnectorRouterEntrypoint", "connector_router_entrypoint_mismatch");
  requireEqual(bindingNames(productionEdge.durable_objects), bindingNames(stagingEdge.durable_objects), "edge_do_topology_drift");
  requireEqual(bindingNames(productionControl.durable_objects), bindingNames(stagingControl.durable_objects), "control_do_topology_drift");
  const managedEdgeBindings = [...bindingNames(stagingEdge.durable_objects), ...bindingNames(productionEdge.durable_objects)];
  if (managedEdgeBindings.some((binding) => binding.startsWith("DEV_CONNECTOR_TICKETS:") || binding.endsWith(":DevelopmentConnectorTicketStore"))) {
    throw new ProductionPromotionError("development_ticket_binding_in_managed_topology");
  }
  if (!(edge.migrations ?? []).some((migration) => migration?.new_sqlite_classes?.includes("DevelopmentConnectorTicketStore"))) {
    throw new ProductionPromotionError("development_ticket_migration_history_missing");
  }
  if ((edge.migrations ?? []).some((migration) => migration?.deleted_classes?.includes("DevelopmentConnectorTicketStore"))) {
    throw new ProductionPromotionError("development_ticket_migration_deleted_unsafely");
  }
  const queueNames = new Set([
    ...(productionEdge.queues?.producers ?? []).map((item) => item?.queue),
    ...(productionEdge.queues?.consumers ?? []).map((item) => item?.queue),
  ]);
  for (const name of REQUIRED_PRODUCTION_QUEUES) if (!queueNames.has(name)) throw new ProductionPromotionError("production_queue_binding_missing");
  for (const consumer of productionEdge.queues?.consumers ?? []) {
    requireEqual(consumer.max_retries, 5, "queue_retry_policy_mismatch");
    requireEqual(consumer.dead_letter_queue, "agent-controller-dead-letter-production", "queue_dead_letter_mismatch");
  }
  requireEqual(productionEdge.triggers?.crons?.[0], "*/5 * * * *", "production_cron_missing");
  const container = productionControl.containers?.find((item) => item?.class_name === "AgentControllerGatewayContainer");
  if (!container) throw new ProductionPromotionError("production_container_missing");
  requireEqual(container.image, "./Dockerfile", "container_image_contract_mismatch");
  requireEqual(container.image_build_context, "..", "container_context_mismatch");
  requireEqual(container.instance_type, "standard-1", "container_instance_type_mismatch");
  requireEqual(container.max_instances, 1, "container_instance_count_mismatch");
  // Current config cannot truthfully canary the Container. The workflow therefore uses separate
  // protected jobs/operator approvals around the immediate private and edge mutations.
  requireEqual(container.rollout_step_percentage, 100, "unsupported_container_rollout_configuration");
  return { rolloutMode: "operator-checkpoints", containerRolloutPercentage: 100 };
}

export async function validateEvidenceBundle(input, { now = () => Date.now() } = {}) {
  const manifestPath = join(input.evidenceRoot, "promotion-manifest.json");
  const manifestBytes = await readBoundedEvidence(manifestPath, "manifest_too_large");
  if (sha256(manifestBytes) !== input.manifestHash) throw new ProductionPromotionError("manifest_hash_mismatch");
  const manifest = parseJson(manifestBytes, "manifest_json_invalid");
  requireEqual(manifest.schema, PROMOTION_MANIFEST_SCHEMA, "manifest_schema_invalid");
  requireEqual(manifest.targetCommit, input.targetCommit, "manifest_commit_mismatch");
  requireFresh(manifest.createdAt, now(), MAX_EVIDENCE_AGE_MS, "manifest_stale");
  const artifactDigests = record(manifest.artifacts, "artifact_manifest_missing");
  for (const name of ["console", "edge", "controlPlane", "container", "convex"]) {
    requireMatch(artifactDigests[name], HASH, `artifact_${name}_digest_invalid`);
  }
  const expected = {
    release: "next-coder.staging-release.v1",
    qualification: "next-coder.staging-qualification.v1",
    capacity: "next-coder.staging-capacity.v1",
    security: "next-coder.staging-security.v1",
  };
  const evidence = {};
  for (const [name, schema] of Object.entries(expected)) {
    const reference = record(manifest.evidence?.[name], `evidence_${name}_reference_missing`);
    const filename = requireSafeFilename(reference.file, `evidence_${name}_filename_invalid`);
    const expectedHash = requireMatch(reference.sha256, HASH, `evidence_${name}_hash_invalid`);
    const bytes = await readBoundedEvidence(join(input.evidenceRoot, filename), `evidence_${name}_too_large`);
    if (sha256(bytes) !== expectedHash) throw new ProductionPromotionError(`evidence_${name}_hash_mismatch`);
    const document = parseJson(bytes, `evidence_${name}_json_invalid`);
    requireEqual(document.schema, schema, `evidence_${name}_schema_invalid`);
    requireEqual(document.result, "passed", `evidence_${name}_not_passed`);
    requireFresh(document.finishedAt, now(), MAX_EVIDENCE_AGE_MS, `evidence_${name}_stale`);
    if (name !== "qualification") requireEqual(document.targetCommit, input.targetCommit, `evidence_${name}_commit_mismatch`);
    evidence[name] = document;
  }
  requireEqual(evidence.release.operation, "deploy", "staging_release_not_forward_deploy");
  requireEqual(evidence.qualification.target?.origin, input.stagingUrl, "qualification_origin_mismatch");
  return { manifest, evidence };
}

export async function computeArtifactDigests(repositoryRoot, trackedPaths) {
  const paths = [...new Set(trackedPaths)].filter((path) => path && !path.startsWith("/") && !path.includes(".."));
  const result = {};
  for (const [surface, selectors] of Object.entries(ARTIFACT_SURFACES)) {
    const selected = paths.filter((path) => selectors.some((selector) => selector.endsWith("/")
      ? path.startsWith(selector)
      : path === selector)).sort();
    if (selected.length === 0) throw new ProductionPromotionError(`artifact_${surface}_source_missing`);
    const hash = createHash("sha256");
    hash.update(`next-coder-source-artifact-v1\0${surface}\0`);
    for (const path of selected) {
      const absolute = join(repositoryRoot, path);
      const metadata = await lstat(absolute);
      const bytes = metadata.isSymbolicLink()
        ? Buffer.from(`symlink:${await readlink(absolute)}`)
        : metadata.isFile()
          ? await readFile(absolute)
          : null;
      if (!bytes) throw new ProductionPromotionError(`artifact_${surface}_source_type_invalid`);
      hash.update(`${Buffer.byteLength(path)}:${path}:${bytes.length}:`);
      hash.update(bytes);
    }
    result[surface] = hash.digest("hex");
  }
  return result;
}

export async function readTrackedArtifactDigests(repositoryRoot, runner = createCommandRunner()) {
  const tracked = String(await runner(command("tracked-source-files", "git", ["ls-files", "-z"], repositoryRoot)))
    .split("\0").filter(Boolean);
  return await computeArtifactDigests(repositoryRoot, tracked);
}

export function buildReadOnlyPlan(input, tempRoot) {
  return [
    command("convex-dry-run", "npm", ["exec", "convex", "--", "deploy", "--dry-run", "--typecheck", "enable", "--codegen", "disable"], input.repositoryRoot, CONVEX_SECRETS),
    wranglerCommand("control-plane-dry-run", "cloudflare-control-plane", ["deploy", "--dry-run", "--containers-rollout", "none", "--env", "production", "--outdir", join(tempRoot, "control-plane")], input.repositoryRoot, []),
    wranglerCommand("edge-dry-run", "cloudflare", ["deploy", "--dry-run", "--env", "production", "--outdir", join(tempRoot, "edge")], input.repositoryRoot, []),
    wranglerCommand("control-plane-secrets", "cloudflare-control-plane", ["secret", "list", "--env", "production", "--format", "json"], input.repositoryRoot),
    command("convex-secrets", "npm", ["exec", "convex", "--", "env", "list", "--names-only"], input.repositoryRoot, CONVEX_SECRETS),
    deploymentCommand("edge-status", input.repositoryRoot, "cloudflare"),
    deploymentCommand("control-status", input.repositoryRoot, "cloudflare-control-plane"),
  ];
}

export function buildMutationPlan(input, phase) {
  const message = `next-coder production promote ${input.targetCommit}`;
  const tag = `ac-prod-${input.targetCommit.slice(0, 12)}`;
  if (phase === "private") return [
    command("convex", "npm", ["exec", "convex", "--", "deploy", "--typecheck", "enable", "--codegen", "disable", "--message", message], input.repositoryRoot, CONVEX_SECRETS),
    wranglerCommand("control-plane", "cloudflare-control-plane", ["deploy", "--env", "production", "--containers-rollout", "immediate", "--strict", "--tag", tag, "--message", message], input.repositoryRoot),
  ];
  if (phase === "edge") return [
    wranglerCommand("edge", "cloudflare", ["deploy", "--env", "production", "--strict", "--tag", tag, "--message", message], input.repositoryRoot),
  ];
  throw new ProductionPromotionError("phase_invalid");
}

export async function validateLocalPromotion(input, { runner = createCommandRunner(), now } = {}) {
  await runner(command("git-head", "git", ["rev-parse", "HEAD"], input.repositoryRoot));
  await runner(command("target-on-default", "git", ["merge-base", "--is-ancestor", input.targetCommit, `origin/${input.defaultBranch}`], input.repositoryRoot));
  await runner(command("current-on-default", "git", ["merge-base", "--is-ancestor", input.currentCommit, `origin/${input.defaultBranch}`], input.repositoryRoot));
  await runner(command("forward-only", "git", ["merge-base", "--is-ancestor", input.currentCommit, input.targetCommit], input.repositoryRoot));
  // Automatic rollback cannot rewind Convex schema/functions or Durable Object migrations. Fail
  // closed unless this promotion leaves those durable contracts identical to current production.
  await runner(command("rollback-convex-compatible", "git", ["diff", "--quiet", input.currentCommit, input.targetCommit, "--", "convex"], input.repositoryRoot));
  const [edge, control] = await Promise.all([
    readJsonc(join(input.repositoryRoot, "cloudflare/wrangler.jsonc")),
    readJsonc(join(input.repositoryRoot, "cloudflare-control-plane/wrangler.jsonc")),
  ]);
  const topology = validateProductionTopology(edge, control);
  const previousEdge = parseJsonc(await runner(command("previous-edge", "git", ["show", `${input.currentCommit}:cloudflare/wrangler.jsonc`], input.repositoryRoot)));
  const previousControl = parseJsonc(await runner(command("previous-control", "git", ["show", `${input.currentCommit}:cloudflare-control-plane/wrangler.jsonc`], input.repositoryRoot)));
  requireEqual(previousEdge.migrations ?? [], edge.migrations ?? [], "rollback_crosses_edge_migration");
  requireEqual(previousControl.migrations ?? [], control.migrations ?? [], "rollback_crosses_control_migration");
  const bundle = await validateEvidenceBundle(input, { now });
  requireEqual(await readTrackedArtifactDigests(input.repositoryRoot, runner), bundle.manifest.artifacts,
    "artifact_source_digest_mismatch");
  return { topology, bundle };
}

export async function runProductionPreflight(input, dependencies = {}) {
  const runner = dependencies.runner ?? createCommandRunner();
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const environment = dependencies.environment ?? process.env;
  await validateLocalPromotion(input, { runner, now: dependencies.now });
  const tempRoot = resolve(dependencies.tempRoot ?? join(input.repositoryRoot, ".production-preflight"));
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const outputs = new Map();
  for (const step of buildReadOnlyPlan(input, tempRoot)) outputs.set(step.name, await runner(step));
  requireNames(parseSecretNames(outputs.get("control-plane-secrets")), REQUIRED_CONTROL_PLANE_SECRETS, "control_plane_secret_missing");
  requireNames(new Set(String(outputs.get("convex-secrets") ?? "").split(/\r?\n/u).filter(Boolean)), ["GATEWAY_CONVEX_SECRET"], "convex_secret_missing");
  const [queues, buckets] = await Promise.all([
    listCloudflareQueues(fetchImpl, environment),
    listR2Buckets(fetchImpl, environment),
  ]);
  requireNames(queues, REQUIRED_PRODUCTION_QUEUES, "production_queue_missing");
  requireNames(buckets, [input.mediaBucket, input.firmwareBucket], "production_bucket_missing");
  requireDeployment(outputs.get("edge-status"), input.currentEdgeVersion, input.currentCommit, "edge");
  requireDeployment(outputs.get("control-status"), input.currentControlVersion, input.currentCommit, "control_plane");
  return { result: "passed" };
}

export async function executePromotionPhase(input, phase, dependencies = {}) {
  const runner = dependencies.runner ?? createCommandRunner();
  const now = dependencies.now ?? (() => Date.now());
  const startedAt = now();
  const checks = [];
  try {
    if (phase === "private") {
      await runProductionPreflight(input, {
        runner,
        now,
        tempRoot: dependencies.tempRoot,
        fetchImpl: dependencies.fetchImpl,
        environment: dependencies.environment,
      });
    } else {
      await runEdgeCheckpoint(input, { runner, now });
    }
    for (const step of buildMutationPlan(input, phase)) {
      await runner(step);
      checks.push({ name: `deploy_${step.name}`, status: "passed" });
    }
    const evidence = redactedEvidence(input, phase, "passed", startedAt, now(), checks);
    await writeEvidence(input.evidencePath, evidence);
    return evidence;
  } catch (error) {
    const evidence = redactedEvidence(input, phase, "failed", startedAt, now(), [
      { name: phase, status: "failed", code: safeCode(error) },
    ]);
    await writeEvidence(input.evidencePath, evidence);
    return evidence;
  }
}

export async function runEdgeCheckpoint(input, dependencies = {}) {
  const runner = dependencies.runner ?? createCommandRunner();
  await validateLocalPromotion(input, { runner, now: dependencies.now });
  const edge = await runner(deploymentCommand("edge-status", input.repositoryRoot, "cloudflare"));
  const control = await runner(deploymentCommand("control-status", input.repositoryRoot, "cloudflare-control-plane"));
  requireDeployment(edge, input.currentEdgeVersion, input.currentCommit, "edge");
  requireDeploymentCommit(control, input.targetCommit, "control_plane");
  return { result: "passed" };
}

export async function runProductionPostflight(input, dependencies = {}) {
  const runner = dependencies.runner ?? createCommandRunner();
  const now = dependencies.now ?? (() => Date.now());
  const startedAt = now();
  try {
    const edge = await runner(deploymentCommand("edge-status", input.repositoryRoot, "cloudflare"));
    const control = await runner(deploymentCommand("control-status", input.repositoryRoot, "cloudflare-control-plane"));
    requireDeploymentCommit(edge, input.targetCommit, "edge");
    requireDeploymentCommit(control, input.targetCommit, "control_plane");
    const qualification = await runStagingQualification({
      baseUrl: input.productionUrl,
      expectedEnvironment: "production",
    }, { fetchImpl: dependencies.fetchImpl ?? globalThis.fetch, now });
    if (qualification.result !== "passed") throw new ProductionPromotionError("production_boundary_qualification_failed");
    const evidence = redactedEvidence(input, "postflight", "passed", startedAt, now(), [
      { name: "production_versions", status: "passed" },
      { name: "credential_free_boundary", status: "passed", summary: qualification.summary },
    ]);
    await writeEvidence(input.evidencePath, evidence);
    return evidence;
  } catch (error) {
    const evidence = redactedEvidence(input, "postflight", "failed", startedAt, now(), [
      { name: "postflight", status: "failed", code: safeCode(error) },
    ]);
    await writeEvidence(input.evidencePath, evidence);
    throw error;
  }
}

export function createCommandRunner({ spawnImpl = spawn } = {}) {
  return async (step) => await new Promise((resolvePromise, rejectPromise) => {
    const env = {};
    for (const name of ALLOWED_CHILD_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
    for (const name of step.secretNames ?? []) if (process.env[name] !== undefined) env[name] = process.env[name];
    const child = spawnImpl(step.executable, step.args, { cwd: step.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk).slice(0, 4 * 1024 * 1024 - stdout.length); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk).slice(0, 4 * 1024 * 1024 - stderr.length); });
    child.once("error", () => rejectPromise(new ProductionPromotionError(`${step.name}_spawn_failed`)));
    child.once("close", (code) => code === 0
      ? resolvePromise(stdout)
      : rejectPromise(new ProductionPromotionError(`${step.name}_failed`)));
  });
}

function redactedEvidence(input, phase, result, startedAt, finishedAt, checks) {
  return {
    schema: PROMOTION_EVIDENCE_SCHEMA,
    result,
    phase,
    targetCommit: input.targetCommit,
    currentCommit: input.currentCommit,
    automationCommit: input.automationCommit,
    manifest: `sha256:${input.manifestHash}`,
    rolloutMode: "operator-checkpoints",
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    checks,
  };
}

function requireDeployment(raw, version, commit, boundary) {
  const value = parseJson(Buffer.from(String(raw ?? "")), `${boundary}_deployment_json_invalid`);
  const versions = Array.isArray(value?.versions) ? value.versions : [];
  const active = versions.find((item) => item?.version_id === version && Number(item?.percentage) === 100);
  if (!active) throw new ProductionPromotionError(`${boundary}_deployment_changed`);
  const message = active.annotations?.["workers/message"] ?? value.annotations?.["workers/message"];
  if (message !== `next-coder production promote ${commit}`) {
    throw new ProductionPromotionError(`${boundary}_source_commit_mismatch`);
  }
}

function requireDeploymentCommit(raw, commit, boundary) {
  const value = parseJson(Buffer.from(String(raw ?? "")), `${boundary}_deployment_json_invalid`);
  const versions = Array.isArray(value?.versions) ? value.versions : [];
  const active = versions.find((item) => Number(item?.percentage) === 100);
  const message = active?.annotations?.["workers/message"] ?? value.annotations?.["workers/message"];
  if (!active || message !== `next-coder production promote ${commit}`) {
    throw new ProductionPromotionError(`${boundary}_source_commit_mismatch`);
  }
}

function deploymentCommand(name, root, packageDirectory) {
  return wranglerCommand(name, packageDirectory, ["deployments", "status", "--env", "production", "--json"], root);
}

function command(name, executable, args, cwd, secretNames = []) {
  return { name, executable, args, cwd, secretNames };
}

// `npm exec` resolves the binary from --prefix but always runs it in the caller's cwd
// (libnpmexec run-script.js: "we always run in cwd, not --prefix"). Wrangler discovers its
// configuration from that cwd, so the child must start inside the package directory rather than at
// the repository root.
function wranglerCommand(name, packageDirectory, args, root, secretNames = CF_SECRETS) {
  return command(name, "npm", ["exec", "wrangler", "--", ...args], join(root, packageDirectory), secretNames);
}

function parseSecretNames(raw) {
  const value = parseJson(Buffer.from(String(raw ?? "")), "secret_list_json_invalid");
  return new Set((Array.isArray(value) ? value : []).map((item) => item?.name).filter(Boolean));
}

// Wrangler 4.127.0 has no --json on `queues list` or `r2 bucket list`; both reject the flag with
// "Unknown argument: json" before any network call. Read the same inventory over the documented
// account API instead, exactly as the staging release preflight already does.
async function listCloudflareQueues(fetchImpl, environment) {
  const names = new Set();
  for (let page = 1; page <= 100; page += 1) {
    const body = await cloudflareApi(fetchImpl, environment, `/queues?page=${page}&per_page=100`);
    if (!Array.isArray(body.result)) throw new ProductionPromotionError("invalid_queue_list_contract");
    for (const item of body.result) if (typeof item?.queue_name === "string") names.add(item.queue_name);
    if (page >= Number(body.result_info?.total_pages ?? 1)) return names;
  }
  throw new ProductionPromotionError("queue_pagination_limit_exceeded");
}

async function listR2Buckets(fetchImpl, environment) {
  const names = new Set();
  let cursor = null;
  for (let page = 0; page < 100; page += 1) {
    const suffix = cursor ? `?per_page=1000&cursor=${encodeURIComponent(cursor)}` : "?per_page=1000";
    const body = await cloudflareApi(fetchImpl, environment, `/r2/buckets${suffix}`);
    const buckets = body.result?.buckets;
    if (!Array.isArray(buckets)) throw new ProductionPromotionError("invalid_r2_bucket_list_contract");
    for (const item of buckets) if (typeof item?.name === "string") names.add(item.name);
    cursor = body.result_info?.cursor;
    if (!cursor) return names;
  }
  throw new ProductionPromotionError("r2_pagination_limit_exceeded");
}

async function cloudflareApi(fetchImpl, environment, path) {
  const account = requireMatch(environment.CLOUDFLARE_ACCOUNT_ID, /^[0-9a-f]{32}$/u, "cloudflare_account_invalid");
  const token = requireText(environment.CLOUDFLARE_API_TOKEN, "cloudflare_token_required");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new ProductionPromotionError("cloudflare_preflight_failed");
    const body = await response.json();
    if (body?.success !== true) throw new ProductionPromotionError("cloudflare_preflight_failed");
    return body;
  } catch (error) {
    if (error instanceof ProductionPromotionError) throw error;
    throw new ProductionPromotionError("cloudflare_preflight_failed");
  } finally {
    clearTimeout(timeout);
  }
}

function requireNames(actual, required, code) {
  for (const name of required) if (!actual.has(name)) throw new ProductionPromotionError(code);
}

function requireFresh(value, now, maxAge, code) {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp) || timestamp > now + 5 * 60_000 || now - timestamp > maxAge) {
    throw new ProductionPromotionError(code);
  }
}

function bindingNames(value) {
  return (value?.bindings ?? []).map((item) => `${item?.name}:${item?.class_name}`).sort();
}

function requireSafeFilename(value, code) {
  const text = requireText(value, code);
  if (!/^[A-Za-z0-9._-]+$/u.test(text) || text === "." || text === "..") throw new ProductionPromotionError(code);
  return text;
}

function requireHttpsUrl(value, code) {
  try {
    const url = new URL(requireText(value, code));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new ProductionPromotionError(code);
  }
}

function requireText(value, code) {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) throw new ProductionPromotionError(code);
  return value.trim();
}

function requireMatch(value, pattern, code) {
  const text = requireText(value, code);
  if (!pattern.test(text)) throw new ProductionPromotionError(code);
  return text;
}

function record(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProductionPromotionError(code);
  return value;
}

function requireEqual(actual, expected, code) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new ProductionPromotionError(code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readBoundedEvidence(path, code) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_EVIDENCE_FILE_BYTES) throw new ProductionPromotionError(code);
  return await readFile(path);
}

function parseJson(value, code) {
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : String(value));
  } catch {
    throw new ProductionPromotionError(code);
  }
}

async function readJsonc(path) {
  return parseJsonc(await readFile(path, "utf8"));
}

function parseJsonc(value) {
  return JSON.parse(stripJsonComments(value));
}

function stripJsonComments(value) {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];
    if (lineComment) {
      if (character === "\n") { lineComment = false; result += character; }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") { blockComment = false; index += 1; }
      else if (character === "\n") result += character;
      continue;
    }
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; result += character; }
    else if (character === "/" && next === "/") { lineComment = true; index += 1; }
    else if (character === "/" && next === "*") { blockComment = true; index += 1; }
    else result += character;
  }
  return result;
}

function safeCode(error) {
  return typeof error?.code === "string" && /^[a-z0-9_]+$/u.test(error.code) ? error.code : "promotion_failed";
}

async function writeEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function main() {
  let input;
  const mode = process.argv[2];
  try {
    if (mode === "source-artifact-digests") {
      const artifacts = await readTrackedArtifactDigests(process.cwd());
      process.stdout.write(`${JSON.stringify({ schema: "next-coder.source-artifacts.v1", artifacts }, null, 2)}\n`);
      return;
    }
    input = normalizePromotionInput();
    if (mode === "validate-local") await validateLocalPromotion(input);
    else if (mode === "preflight") await runProductionPreflight(input);
    else if (mode === "preflight-edge") await runEdgeCheckpoint(input);
    else if (mode === "execute-private") {
      const evidence = await executePromotionPhase(input, "private");
      if (evidence.result !== "passed") process.exitCode = 1;
    } else if (mode === "execute-edge") {
      const evidence = await executePromotionPhase(input, "edge");
      if (evidence.result !== "passed") process.exitCode = 1;
    } else if (mode === "postflight") {
      await runProductionPostflight(input);
    } else throw new ProductionPromotionError("mode_invalid");
    if (!process.exitCode) process.stdout.write(`${JSON.stringify({ schema: PROMOTION_EVIDENCE_SCHEMA, result: "passed", mode })}\n`);
  } catch (error) {
    process.stderr.write(`production promotion failed: ${safeCode(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
