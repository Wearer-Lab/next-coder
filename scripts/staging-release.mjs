#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readEnv } from "./environment.mjs";

import { runStagingQualification } from "./qualify-staging.mjs";

export const RELEASE_EVIDENCE_SCHEMA = "next-coder.staging-release.v1";
export const REQUIRED_CONTROL_PLANE_SECRETS = Object.freeze([
  "PUBLIC_BASE_URL",
  "CONVEX_URL",
  "GATEWAY_CONVEX_SECRET",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "T3_TOKEN_ENCRYPTION_KEY",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "FIRMWARE_S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "WEB_PUSH_VAPID_KEYS",
  "WEB_PUSH_STORAGE_ENCRYPTION_KEY",
]);
export const REQUIRED_CONVEX_ENVIRONMENT_NAMES = Object.freeze(["GATEWAY_CONVEX_SECRET"]);
export const REQUIRED_STAGING_QUEUES = Object.freeze([
  "agent-controller-connector-events-staging",
  "agent-controller-background-staging",
  "agent-controller-dead-letter-staging",
]);

const EDGE_SERVICE = "agent-controller-cloud-staging";
const CONTROL_PLANE_SERVICE = "agent-controller-control-plane-staging";
const EDGE_TELEMETRY_DATASET = "agent_controller_edge_staging";
const CONTROL_PLANE_TELEMETRY_DATASET = "agent_controller_control_plane_staging";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^[0-9a-f-]{16,64}$/u;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const CLOUDFLARE_COMMAND_SECRETS = Object.freeze(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
const CONVEX_COMMAND_SECRETS = Object.freeze(["CONVEX_DEPLOY_KEY"]);
const CHILD_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "CI",
  "NO_COLOR",
]);

export class StagingReleaseError extends Error {
  constructor(code) {
    super(code);
    this.name = "StagingReleaseError";
    this.code = code;
  }
}

export function normalizeReleaseInput(environment = process.env) {
  const operation = oneOf(environment.STAGING_RELEASE_OPERATION, ["deploy", "rollback"], "operation_invalid");
  const targetCommit = requireSha(environment.STAGING_RELEASE_TARGET_COMMIT, "target_commit_invalid");
  const currentCommit = requireSha(environment.STAGING_RELEASE_CURRENT_COMMIT, "current_commit_invalid");
  const headCommit = requireSha(environment.STAGING_RELEASE_CHECKED_OUT_COMMIT, "checked_out_commit_invalid");
  const automationCommit = requireSha(environment.STAGING_RELEASE_AUTOMATION_COMMIT, "automation_commit_invalid");
  const defaultBranch = requireText(environment.STAGING_RELEASE_DEFAULT_BRANCH, "default_branch_required");
  const dispatchRef = requireText(environment.STAGING_RELEASE_DISPATCH_REF, "dispatch_ref_required");
  const confirmation = requireText(environment.STAGING_RELEASE_CONFIRMATION, "confirmation_required");
  if (confirmation !== `${operation}:staging:${targetCommit}`) throw new StagingReleaseError("confirmation_mismatch");
  if (targetCommit !== headCommit) throw new StagingReleaseError("checkout_not_target_commit");
  if (dispatchRef !== defaultBranch) throw new StagingReleaseError("workflow_not_dispatched_from_default_branch");
  if (targetCommit === currentCommit) throw new StagingReleaseError("target_must_differ_from_current");

  return {
    operation,
    targetCommit,
    currentCommit,
    headCommit,
    automationCommit,
    defaultBranch,
    dispatchRef,
    expectedEdgeVersion: requireVersion(environment.STAGING_RELEASE_CURRENT_EDGE_VERSION, "current_edge_version_invalid"),
    expectedControlPlaneVersion: requireVersion(environment.STAGING_RELEASE_CURRENT_CONTROL_PLANE_VERSION, "current_control_plane_version_invalid"),
    repositoryRoot: resolve(environment.STAGING_RELEASE_REPOSITORY_ROOT ?? process.cwd()),
    evidencePath: resolve(environment.STAGING_RELEASE_EVIDENCE_PATH ?? join(process.cwd(), "staging-release-evidence.json")),
    stagingUrl: readEnv(environment, "NEXT_CODER_STAGING_URL")?.trim() || null,
    mediaBucket: readEnv(environment, "NEXT_CODER_STAGING_MEDIA_BUCKET")?.trim() || null,
    firmwareBucket: readEnv(environment, "NEXT_CODER_STAGING_FIRMWARE_BUCKET")?.trim() || null,
  };
}

export function validateWranglerTopology(edge, controlPlane) {
  const edgeStaging = requireRecord(edge?.env?.staging, "edge_staging_environment_missing");
  const controlStaging = requireRecord(controlPlane?.env?.staging, "control_plane_staging_environment_missing");
  requireEqual(edgeStaging.name, EDGE_SERVICE, "edge_staging_service_mismatch");
  requireEqual(controlStaging.name, CONTROL_PLANE_SERVICE, "control_plane_staging_service_mismatch");
  requireEqual(edgeStaging.vars?.DEPLOYMENT_ENVIRONMENT, "staging", "edge_environment_marker_mismatch");
  requireEqual(edgeStaging.vars?.CONNECTOR_AUTH_MODE, "control-plane", "edge_connector_auth_not_cloud");
  requireEqual(controlStaging.vars?.DEPLOYMENT_ENVIRONMENT, "staging", "control_plane_environment_marker_mismatch");
  requireEqual(edgeStaging.vars?.TELEMETRY_SUCCESS_SAMPLE_RATE, "0.05", "edge_telemetry_sampling_mismatch");
  requireEqual(controlStaging.vars?.TELEMETRY_SUCCESS_SAMPLE_RATE, "0.05", "control_plane_telemetry_sampling_mismatch");
  validateObservability(edgeStaging.observability ?? edge?.observability, "edge");
  validateObservability(controlStaging.observability ?? controlPlane?.observability, "control_plane");
  requireEqual(
    edgeStaging.analytics_engine_datasets?.find((item) => item?.binding === "TELEMETRY")?.dataset,
    EDGE_TELEMETRY_DATASET,
    "edge_telemetry_binding_mismatch",
  );
  requireEqual(
    controlStaging.analytics_engine_datasets?.find((item) => item?.binding === "TELEMETRY")?.dataset,
    CONTROL_PLANE_TELEMETRY_DATASET,
    "control_plane_telemetry_binding_mismatch",
  );
  requireEqual(edgeStaging.services?.find((item) => item?.binding === "CONTROL_PLANE")?.service,
    CONTROL_PLANE_SERVICE, "control_plane_service_binding_mismatch");
  const router = controlStaging.services?.find((item) => item?.binding === "CONNECTOR_ROUTER");
  requireEqual(router?.service, EDGE_SERVICE, "connector_router_service_binding_mismatch");
  requireEqual(router?.entrypoint, "ControlPlaneConnectorRouterEntrypoint", "connector_router_entrypoint_mismatch");
  const edgeDurableObjects = edgeStaging.durable_objects?.bindings ?? [];
  if (!edgeDurableObjects.some((item) => item?.name === "ENVIRONMENT_CONNECTOR_HUB" && item?.class_name === "EnvironmentConnectorHub")) {
    throw new StagingReleaseError("edge_connector_hub_binding_missing");
  }
  if (edgeDurableObjects.some((item) => item?.name === "DEV_CONNECTOR_TICKETS" || item?.class_name === "DevelopmentConnectorTicketStore")) {
    throw new StagingReleaseError("development_ticket_binding_in_staging");
  }

  const queueNames = new Set([
    ...(edgeStaging.queues?.producers ?? []).map((item) => item?.queue),
    ...(edgeStaging.queues?.consumers ?? []).map((item) => item?.queue),
  ]);
  for (const queue of REQUIRED_STAGING_QUEUES) {
    if (!queueNames.has(queue)) throw new StagingReleaseError("required_queue_binding_missing");
  }
  const deadLetter = "agent-controller-dead-letter-staging";
  for (const consumer of edgeStaging.queues?.consumers ?? []) {
    requireEqual(consumer.max_retries, 5, "queue_retry_policy_mismatch");
    requireEqual(consumer.dead_letter_queue, deadLetter, "queue_dead_letter_binding_mismatch");
  }
  requireEqual(edgeStaging.triggers?.crons?.[0], "*/5 * * * *", "staging_cron_missing");
  validateMigrationChain(edge.migrations, "edge_migrations_invalid");
  // The v1 class migration may already exist remotely. Keep it as append-only
  // history, but never bind or delete that local-only class in managed topology.
  if (!(edge.migrations ?? []).some((migration) => migration?.new_sqlite_classes?.includes("DevelopmentConnectorTicketStore"))) {
    throw new StagingReleaseError("development_ticket_migration_history_missing");
  }
  if ((edge.migrations ?? []).some((migration) => migration?.deleted_classes?.includes("DevelopmentConnectorTicketStore"))) {
    throw new StagingReleaseError("development_ticket_migration_deleted_unsafely");
  }
  validateMigrationChain(controlPlane.migrations, "control_plane_migrations_invalid");
  const container = controlStaging.containers?.find((item) => item?.class_name === "AgentControllerGatewayContainer");
  if (!container) throw new StagingReleaseError("control_plane_container_missing");
  requireEqual(container.image, "./Dockerfile", "control_plane_container_image_unpinned");
  requireEqual(container.image_build_context, "..", "control_plane_container_context_mismatch");
  requireEqual(container.instance_type, "standard-1", "control_plane_instance_type_mismatch");
  requireEqual(container.max_instances, 1, "control_plane_instance_count_mismatch");
  requireEqual(container.rollout_step_percentage, 100, "control_plane_rollout_not_immediate");
  return true;
}

export function validateMigrationCompatibility(previous, candidate, { rollback = false } = {}) {
  const previousMigrations = Array.isArray(previous?.migrations) ? previous.migrations : [];
  const candidateMigrations = Array.isArray(candidate?.migrations) ? candidate.migrations : [];
  if (rollback && JSON.stringify(previousMigrations) !== JSON.stringify(candidateMigrations)) {
    throw new StagingReleaseError("rollback_crosses_durable_object_migration");
  }
  if (!rollback) {
    const prefix = candidateMigrations.slice(0, previousMigrations.length);
    if (JSON.stringify(prefix) !== JSON.stringify(previousMigrations)) {
      throw new StagingReleaseError("durable_object_migrations_not_append_only");
    }
  }
  return true;
}

export function buildMutationPlan(input) {
  const short = input.targetCommit.slice(0, 12);
  const tag = input.operation === "rollback" ? `ac-stg-rollback-${short}` : `ac-stg-${short}`;
  const message = `next-coder staging ${input.operation} ${input.targetCommit}`;
  const edge = wranglerCommand("edge", "cloudflare", [
    "deploy", "--env", "staging", "--strict", "--tag", tag, "--message", message,
  ], process.cwd());
  const controlPlane = wranglerCommand("control-plane", "cloudflare-control-plane", [
    "deploy", "--env", "staging", "--containers-rollout", "immediate",
    "--strict", "--tag", tag, "--message", message,
  ], process.cwd());
  if (input.operation === "rollback") return [edge, controlPlane];
  return [
    command("convex", "npm", [
      "exec", "convex", "--", "deploy", "--typecheck", "enable", "--codegen", "disable", "--message", message,
    ], process.cwd(), CONVEX_COMMAND_SECRETS),
    controlPlane,
    edge,
  ];
}

export function buildReadOnlyPlan(repositoryRoot, tempRoot) {
  return [
    command("convex-dry-run", "npm", [
      "exec", "convex", "--", "deploy", "--dry-run", "--typecheck", "enable", "--codegen", "disable",
    ], repositoryRoot, CONVEX_COMMAND_SECRETS),
    wranglerCommand("control-plane-dry-run", "cloudflare-control-plane", [
      "deploy", "--dry-run", "--containers-rollout", "none", "--env", "staging",
      "--outdir", join(tempRoot, "control-plane"),
    ], repositoryRoot, []),
    wranglerCommand("edge-dry-run", "cloudflare", [
      "deploy", "--dry-run", "--env", "staging", "--outdir", join(tempRoot, "edge"),
    ], repositoryRoot, []),
  ];
}

export async function validateLocalRelease(input, dependencies = {}) {
  const runner = dependencies.runner ?? createCommandRunner();
  await verifyGitContext(input, runner);
  const [edge, controlPlane] = await Promise.all([
    readJsonc(join(input.repositoryRoot, "cloudflare/wrangler.jsonc")),
    readJsonc(join(input.repositoryRoot, "cloudflare-control-plane/wrangler.jsonc")),
  ]);
  validateWranglerTopology(edge, controlPlane);

  const previousEdge = parseJsonc(await gitShow(runner, input.repositoryRoot, input.currentCommit, "cloudflare/wrangler.jsonc"));
  const previousControl = parseJsonc(await gitShow(runner, input.repositoryRoot, input.currentCommit, "cloudflare-control-plane/wrangler.jsonc"));
  validateMigrationCompatibility(previousEdge, edge, { rollback: input.operation === "rollback" });
  validateMigrationCompatibility(previousControl, controlPlane, { rollback: input.operation === "rollback" });
  if (input.operation === "rollback") {
    await requireSameGitTree(runner, input, "convex", "rollback_crosses_convex_change");
    requireEqual(stableTopology(previousEdge), stableTopology(edge), "rollback_crosses_edge_binding_change");
    requireEqual(stableTopology(previousControl), stableTopology(controlPlane), "rollback_crosses_control_plane_binding_change");
  }
  return { edge, controlPlane };
}

export async function runReadOnlyPreflight(input, dependencies = {}) {
  const runner = dependencies.runner ?? createCommandRunner();
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const environment = dependencies.environment ?? process.env;
  await validateLocalRelease(input, { runner });
  requireLiveEnvironment(input, environment);

  const tempRoot = join(tmpdir(), `next-coder-staging-preflight-${process.pid}`);
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  for (const step of buildReadOnlyPlan(input.repositoryRoot, tempRoot)) await runner(step);

  const controlSecrets = parseSecretNames(await runner(wranglerCommand("control-plane-secret-list", "cloudflare-control-plane", [
    "secret", "list", "--env", "staging", "--format", "json",
  ], input.repositoryRoot)));
  requireNames(controlSecrets, REQUIRED_CONTROL_PLANE_SECRETS, "control_plane_secret_missing");
  const convexNames = new Set(splitLines(await runner(command("convex-environment-list", "npm", [
    "exec", "convex", "--", "env", "list", "--names-only",
  ], input.repositoryRoot, CONVEX_COMMAND_SECRETS))));
  requireNames(convexNames, REQUIRED_CONVEX_ENVIRONMENT_NAMES, "convex_environment_secret_missing");

  const [queues, buckets, edgeStatus, controlStatus] = await Promise.all([
    listCloudflareQueues(fetchImpl, environment),
    listR2Buckets(fetchImpl, environment),
    readDeploymentStatus(runner, input.repositoryRoot, "cloudflare"),
    readDeploymentStatus(runner, input.repositoryRoot, "cloudflare-control-plane"),
  ]);
  requireNames(new Set(queues.map((item) => item.queue_name)), REQUIRED_STAGING_QUEUES, "staging_queue_missing");
  requireNames(new Set(buckets), [input.mediaBucket, input.firmwareBucket], "staging_r2_bucket_missing");
  requireActiveVersion(edgeStatus, input.expectedEdgeVersion, "edge_deployment_changed");
  requireActiveVersion(controlStatus, input.expectedControlPlaneVersion, "control_plane_deployment_changed");
  requireDeploymentCommit(edgeStatus, input.currentCommit, "edge_source_commit_mismatch");
  requireDeploymentCommit(controlStatus, input.currentCommit, "control_plane_source_commit_mismatch");
  return { edgeStatus, controlStatus };
}

export async function executeStagingRelease(input, dependencies = {}) {
  const runner = dependencies.runner ?? createCommandRunner();
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  const environment = dependencies.environment ?? process.env;
  const startedAt = now();
  const checks = [];
  let before;
  let after;
  let qualification = null;
  let result = "failed";
  const snapshot = async (snapshotResult) => {
    const evidence = buildReleaseEvidence({ input, startedAt, finishedAt: now(), result: snapshotResult, checks, before, after, qualification });
    await writeEvidence(input.evidencePath, evidence);
    return evidence;
  };

  try {
    before = await runStage(checks, "preflight", now, async () => await runReadOnlyPreflight(input, { runner, fetchImpl, environment }));
    after = before;
    await snapshot("in_progress");
    for (const step of buildMutationPlan(input)) {
      await runStage(checks, `deploy_${step.name.replaceAll("-", "_")}`, now, async () => {
        if (step.name === "edge") {
          const current = await readDeploymentStatus(runner, input.repositoryRoot, "cloudflare");
          requireActiveVersion(current, input.expectedEdgeVersion, "edge_deployment_changed");
        }
        if (step.name === "control-plane") {
          const current = await readDeploymentStatus(runner, input.repositoryRoot, "cloudflare-control-plane");
          requireActiveVersion(current, input.expectedControlPlaneVersion, "control_plane_deployment_changed");
        }
        await runner({ ...step, cwd: input.repositoryRoot, capture: false });
        if (step.name === "edge") {
          after = { ...after, edgeStatus: await readDeploymentStatus(runner, input.repositoryRoot, "cloudflare") };
          requireVersionChanged(before.edgeStatus, after.edgeStatus, "edge_version_not_advanced");
          requireDeploymentCommit(after.edgeStatus, input.targetCommit, "edge_source_commit_mismatch");
        }
        if (step.name === "control-plane") {
          after = { ...after, controlStatus: await readDeploymentStatus(runner, input.repositoryRoot, "cloudflare-control-plane") };
          requireVersionChanged(before.controlStatus, after.controlStatus, "control_plane_version_not_advanced");
          requireDeploymentCommit(after.controlStatus, input.targetCommit, "control_plane_source_commit_mismatch");
        }
        return true;
      });
      if (step.name === "control-plane") {
        await runStage(checks, "control_plane_rollout_boundary", now, async () => {
          return await waitForCredentialFreeBoundary(input.stagingUrl, fetchImpl, sleep);
        });
      }
      await snapshot("in_progress");
    }
    qualification = await runStage(checks, "credential_free_boundary", now, async () => {
      return await waitForCredentialFreeBoundary(input.stagingUrl, fetchImpl, sleep);
    });
    result = "passed";
  } catch (error) {
    checks.push({ name: "release", status: "failed", code: safeCode(error), durationMs: 0 });
  }

  return await snapshot(result);
}

function buildReleaseEvidence({ input, startedAt, finishedAt, result, checks, before, after, qualification }) {
  return {
    schema: RELEASE_EVIDENCE_SCHEMA,
    operation: input.operation,
    result,
    targetCommit: input.targetCommit,
    currentCommit: input.currentCommit,
    automationCommit: input.automationCommit,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    dependencyOrder: buildMutationPlan(input).map((step) => step.name),
    deployments: {
      before: deploymentRefs(before),
      after: deploymentRefs(after),
    },
    checks,
    qualification,
  };
}

async function waitForCredentialFreeBoundary(stagingUrl, fetchImpl, sleep) {
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    const evidence = await runStagingQualification({ baseUrl: stagingUrl, expectedEnvironment: "staging" }, { fetchImpl });
    if (evidence.result === "passed") return evidence;
    if (attempt < 24) await sleep(5_000);
  }
  throw new StagingReleaseError("credential_free_qualification_failed");
}

async function verifyGitContext(input, runner) {
  const head = (await runner(command("git-head", "git", ["rev-parse", "HEAD"], input.repositoryRoot))).trim();
  if (head !== input.targetCommit) throw new StagingReleaseError("checkout_not_target_commit");
  const status = await runner(command("git-status", "git", ["status", "--porcelain=v1", "--untracked-files=no"], input.repositoryRoot));
  if (status.trim()) throw new StagingReleaseError("tracked_worktree_not_clean");
  await runner(command("target-on-default-branch", "git", ["merge-base", "--is-ancestor", input.targetCommit, `origin/${input.defaultBranch}`], input.repositoryRoot));
  await runner(command("current-on-default-branch", "git", ["merge-base", "--is-ancestor", input.currentCommit, `origin/${input.defaultBranch}`], input.repositoryRoot));
  const ancestry = input.operation === "deploy"
    ? [input.currentCommit, input.targetCommit]
    : [input.targetCommit, input.currentCommit];
  await runner(command("release-direction", "git", ["merge-base", "--is-ancestor", ...ancestry], input.repositoryRoot));
}

async function requireSameGitTree(runner, input, path, code) {
  const [current, target] = await Promise.all([
    runner(command("git-current-tree", "git", ["rev-parse", `${input.currentCommit}:${path}`], input.repositoryRoot)),
    runner(command("git-target-tree", "git", ["rev-parse", `${input.targetCommit}:${path}`], input.repositoryRoot)),
  ]);
  if (current.trim() !== target.trim()) throw new StagingReleaseError(code);
}

async function gitShow(runner, repositoryRoot, commit, path) {
  return await runner(command("git-show", "git", ["show", `${commit}:${path}`], repositoryRoot));
}

function stableTopology(config) {
  const staging = config?.env?.staging ?? {};
  return JSON.stringify({
    name: staging.name,
    observability: staging.observability ?? config?.observability,
    analytics_engine_datasets: staging.analytics_engine_datasets,
    durable_objects: staging.durable_objects,
    services: staging.services,
    queues: staging.queues,
    triggers: staging.triggers,
    containers: staging.containers,
    migrations: config?.migrations,
  });
}

function validateObservability(value, runtime) {
  const observability = requireRecord(value, `${runtime}_observability_missing`);
  requireEqual(observability.enabled, true, `${runtime}_observability_disabled`);
  requireEqual(observability.head_sampling_rate, 0, `${runtime}_observability_sampling_unsafe`);
  requireEqual(observability.logs?.enabled, true, `${runtime}_logs_disabled`);
  requireEqual(observability.logs?.invocation_logs, false, `${runtime}_invocation_logs_not_disabled`);
  const logRate = Number(observability.logs?.head_sampling_rate);
  if (!Number.isFinite(logRate) || logRate !== 0) {
    throw new StagingReleaseError(`${runtime}_log_sampling_unsafe`);
  }
  requireEqual(observability.traces?.enabled, true, `${runtime}_traces_disabled`);
  const traceRate = Number(observability.traces?.head_sampling_rate);
  if (!Number.isFinite(traceRate) || traceRate !== 0) {
    throw new StagingReleaseError(`${runtime}_trace_sampling_unsafe`);
  }
}

async function readDeploymentStatus(runner, repositoryRoot, packageDirectory) {
  const [deploymentOutput, versionsOutput] = await Promise.all([
    runner(wranglerCommand(`${packageDirectory}-deployment-status`, packageDirectory, [
      "deployments", "status", "--env", "staging", "--json",
    ], repositoryRoot)),
    runner(wranglerCommand(`${packageDirectory}-version-list`, packageDirectory, [
      "versions", "list", "--env", "staging", "--json",
    ], repositoryRoot)),
  ]);
  try {
    const deployment = JSON.parse(deploymentOutput);
    const versionMetadata = JSON.parse(versionsOutput);
    if (!Array.isArray(versionMetadata)) throw new Error("shape");
    return { deployment, versionMetadata };
  } catch {
    throw new StagingReleaseError("invalid_deployment_status");
  }
}

function activeVersions(status) {
  const versions = Array.isArray(status?.versions) ? status.versions
    : Array.isArray(status?.deployment?.versions) ? status.deployment.versions
      : [];
  return versions.map((item) => ({
    id: item?.version_id ?? item?.versionId ?? item?.id,
    percentage: Number(item?.percentage ?? item?.traffic ?? 0),
  })).filter((item) => typeof item.id === "string");
}

function requireActiveVersion(status, expected, code) {
  const versions = activeVersions(status);
  if (versions.length !== 1 || versions[0].id !== expected || versions[0].percentage !== 100) {
    throw new StagingReleaseError(code);
  }
}

function requireVersionChanged(before, after, code) {
  const previous = activeVersions(before);
  const current = activeVersions(after);
  if (current.length !== 1 || current[0].percentage !== 100 || previous[0]?.id === current[0].id) {
    throw new StagingReleaseError(code);
  }
}

export function requireDeploymentCommit(status, commit, code = "deployment_source_commit_mismatch") {
  const deployment = status?.deployment ?? status;
  const active = activeVersions(status);
  const version = status?.versionMetadata?.find((item) => (item?.id ?? item?.version_id) === active[0]?.id);
  const message = version?.annotations?.["workers/message"]
    ?? version?.annotations?.workers_message
    ?? deployment?.annotations?.["workers/message"]
    ?? deployment?.annotations?.workers_message;
  if (message !== `next-coder staging deploy ${commit}`
    && message !== `next-coder staging rollback ${commit}`) {
    throw new StagingReleaseError(code);
  }
}

async function listCloudflareQueues(fetchImpl, environment) {
  const result = [];
  let page = 1;
  while (page <= 100) {
    const body = await cloudflareApi(fetchImpl, environment, `/queues?page=${page}&per_page=100`);
    if (!Array.isArray(body.result)) throw new StagingReleaseError("invalid_queue_list_contract");
    result.push(...body.result);
    const totalPages = Number(body.result_info?.total_pages ?? 1);
    if (page >= totalPages) return result;
    page += 1;
  }
  throw new StagingReleaseError("queue_pagination_limit_exceeded");
}

async function listR2Buckets(fetchImpl, environment) {
  const names = [];
  let cursor = null;
  for (let page = 0; page < 100; page += 1) {
    const suffix = cursor ? `?per_page=1000&cursor=${encodeURIComponent(cursor)}` : "?per_page=1000";
    const body = await cloudflareApi(fetchImpl, environment, `/r2/buckets${suffix}`);
    const buckets = body.result?.buckets;
    if (!Array.isArray(buckets)) throw new StagingReleaseError("invalid_r2_bucket_list_contract");
    names.push(...buckets.map((item) => item?.name).filter((name) => typeof name === "string"));
    cursor = body.result_info?.cursor;
    if (!cursor) return names;
  }
  throw new StagingReleaseError("r2_pagination_limit_exceeded");
}

async function cloudflareApi(fetchImpl, environment, path) {
  const account = requireText(environment.CLOUDFLARE_ACCOUNT_ID, "cloudflare_account_required");
  const token = requireText(environment.CLOUDFLARE_API_TOKEN, "cloudflare_token_required");
  if (!/^[0-9a-f]{32}$/u.test(account)) throw new StagingReleaseError("cloudflare_account_invalid");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new StagingReleaseError("cloudflare_preflight_failed");
    const body = await response.json();
    if (body?.success !== true) throw new StagingReleaseError("cloudflare_preflight_failed");
    return body;
  } catch (error) {
    if (error instanceof StagingReleaseError) throw error;
    throw new StagingReleaseError("cloudflare_preflight_failed");
  } finally {
    clearTimeout(timeout);
  }
}

function requireLiveEnvironment(input, environment) {
  requireText(environment.CLOUDFLARE_API_TOKEN, "cloudflare_token_required");
  requireText(environment.CLOUDFLARE_ACCOUNT_ID, "cloudflare_account_required");
  requireText(environment.CONVEX_DEPLOY_KEY, "convex_deploy_key_required");
  if (!input.stagingUrl) throw new StagingReleaseError("staging_url_required");
  const url = new URL(input.stagingUrl);
  if (url.protocol !== "https:" || url.origin !== input.stagingUrl || url.hostname === "localhost") {
    throw new StagingReleaseError("staging_url_invalid");
  }
  if (!input.mediaBucket || !input.firmwareBucket) throw new StagingReleaseError("staging_r2_bucket_names_required");
}

export function createCommandRunner({ spawnImpl = spawn } = {}) {
  return async function run(specification) {
    return await new Promise((resolvePromise, rejectPromise) => {
      const child = spawnImpl(specification.executable, specification.args, {
        cwd: specification.cwd,
        env: childEnvironment(specification.secretNames),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = Buffer.alloc(0);
      let outputBytes = 0;
      const consume = (chunk, capture) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          child.kill("SIGTERM");
          return;
        }
        if (capture) stdout = Buffer.concat([stdout, chunk]);
      };
      child.stdout.on("data", (chunk) => consume(chunk, specification.capture !== false));
      child.stderr.on("data", (chunk) => consume(chunk, false));
      child.once("error", () => rejectPromise(new StagingReleaseError(`${specification.name}_failed`)));
      child.once("close", (code) => {
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) return rejectPromise(new StagingReleaseError(`${specification.name}_output_limit`));
        if (code !== 0) return rejectPromise(new StagingReleaseError(`${specification.name}_failed`));
        resolvePromise(stdout.toString("utf8"));
      });
    });
  };
}

function parseSecretNames(output) {
  try {
    const parsed = JSON.parse(output);
    const items = Array.isArray(parsed) ? parsed : parsed?.secrets;
    if (!Array.isArray(items)) throw new Error("shape");
    return new Set(items.map((item) => item?.name).filter((name) => typeof name === "string"));
  } catch {
    throw new StagingReleaseError("invalid_secret_list_contract");
  }
}

export function deploymentRefs(statuses) {
  if (!statuses) return null;
  return {
    edge: activeVersions(statuses.edgeStatus).map((item) => opaqueRef(item.id)),
    controlPlane: activeVersions(statuses.controlStatus).map((item) => opaqueRef(item.id)),
  };
}

function opaqueRef(value) {
  if (typeof value !== "string" || !value) return null;
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

async function runStage(checks, name, now, operation) {
  const started = now();
  try {
    const value = await operation();
    checks.push({ name, status: "passed", durationMs: Math.max(0, now() - started) });
    return value;
  } catch (error) {
    checks.push({ name, status: "failed", code: safeCode(error), durationMs: Math.max(0, now() - started) });
    throw error;
  }
}

async function writeEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function command(name, executable, args, cwd = process.cwd(), secretNames = []) {
  return { name, executable, args, cwd, capture: true, secretNames };
}

// `npm exec` resolves the binary from --prefix but always runs it in the caller's cwd
// (libnpmexec run-script.js: "we always run in cwd, not --prefix"). Wrangler discovers its
// configuration from that cwd, so the child must start inside the package directory rather than at
// the repository root.
function wranglerCommand(name, packageDirectory, args, root, secretNames = CLOUDFLARE_COMMAND_SECRETS) {
  return command(name, "npm", ["exec", "wrangler", "--", ...args], join(root, packageDirectory), secretNames);
}

function childEnvironment(secretNames = []) {
  const environment = {};
  for (const name of CHILD_ENVIRONMENT_ALLOWLIST) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  for (const name of secretNames) environment[name] = process.env[name];
  return environment;
}

function validateMigrationChain(migrations, code) {
  if (!Array.isArray(migrations) || migrations.length === 0) throw new StagingReleaseError(code);
  const tags = migrations.map((item) => item?.tag);
  if (tags.some((tag) => typeof tag !== "string") || new Set(tags).size !== tags.length) throw new StagingReleaseError(code);
}

function requireNames(actual, required, code) {
  for (const name of required) if (!name || !actual.has(name)) throw new StagingReleaseError(code);
}

function splitLines(value) {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function requireRecord(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StagingReleaseError(code);
  return value;
}

function requireEqual(actual, expected, code) {
  if (actual !== expected) throw new StagingReleaseError(code);
}

function requireText(value, code) {
  if (typeof value !== "string" || !value.trim()) throw new StagingReleaseError(code);
  return value.trim();
}

function oneOf(value, allowed, code) {
  const normalized = requireText(value, code);
  if (!allowed.includes(normalized)) throw new StagingReleaseError(code);
  return normalized;
}

function requireSha(value, code) {
  const normalized = requireText(value, code).toLowerCase();
  if (!SHA_PATTERN.test(normalized)) throw new StagingReleaseError(code);
  return normalized;
}

function requireVersion(value, code) {
  const normalized = requireText(value, code).toLowerCase();
  if (!VERSION_PATTERN.test(normalized)) throw new StagingReleaseError(code);
  return normalized;
}

function safeCode(error) {
  return typeof error?.code === "string" && /^[a-z0-9_]+$/u.test(error.code) ? error.code : "release_failed";
}

async function readJsonc(path) {
  return parseJsonc(await readFile(path, "utf8"));
}

function parseJsonc(source) {
  try {
    return JSON.parse(stripJsonComments(source).replace(/,\s*([}\]])/gu, "$1"));
  } catch {
    throw new StagingReleaseError("invalid_wrangler_configuration");
  }
}

function stripJsonComments(source) {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        result += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (character === "\n") {
        result += character;
      }
      continue;
    }
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      result += character;
    }
  }
  return result;
}

async function main() {
  const mode = process.argv[2];
  let input;
  try {
    input = normalizeReleaseInput();
    if (mode === "validate-local") {
      await validateLocalRelease(input);
      process.stdout.write(`${JSON.stringify({ schema: RELEASE_EVIDENCE_SCHEMA, result: "passed", mode })}\n`);
      return;
    }
    if (mode === "preflight") {
      await runReadOnlyPreflight(input);
      process.stdout.write(`${JSON.stringify({ schema: RELEASE_EVIDENCE_SCHEMA, result: "passed", mode })}\n`);
      return;
    }
    if (mode === "execute") {
      const evidence = await executeStagingRelease(input);
      process.stdout.write(`${JSON.stringify({ schema: evidence.schema, result: evidence.result, evidencePath: input.evidencePath })}\n`);
      if (evidence.result !== "passed") process.exitCode = 1;
      return;
    }
    throw new StagingReleaseError("mode_invalid");
  } catch (error) {
    const code = safeCode(error);
    if (input?.evidencePath) {
      await writeEvidence(input.evidencePath, {
        schema: RELEASE_EVIDENCE_SCHEMA,
        operation: input.operation,
        result: "failed",
        targetCommit: input.targetCommit,
        automationCommit: input.automationCommit,
        checks: [{ name: mode || "configuration", status: "failed", code, durationMs: 0 }],
      });
    }
    process.stderr.write(`staging release failed: ${code}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
