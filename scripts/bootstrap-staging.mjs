#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readEnv } from "./environment.mjs";

import {
  REQUIRED_CONTROL_PLANE_SECRETS,
  validateWranglerTopology,
} from "./staging-release.mjs";
import { runStagingQualification } from "./qualify-staging.mjs";

export const BOOTSTRAP_EVIDENCE_SCHEMA = "next-coder.staging-bootstrap.v1";
export const STAGING_QUEUES = Object.freeze([
  "agent-controller-connector-events-staging",
  "agent-controller-background-staging",
  "agent-controller-dead-letter-staging",
]);
export const PRODUCTION_QUEUES = Object.freeze(STAGING_QUEUES.map((name) => name.replace(/-staging$/u, "-production")));
export const STAGING_SERVICES = Object.freeze({
  edge: "agent-controller-cloud-staging",
  controlPlane: "agent-controller-control-plane-staging",
});
export const PRODUCTION_SERVICES = Object.freeze({
  edge: "agent-controller-cloud-production",
  controlPlane: "agent-controller-control-plane-production",
});
export const RUNTIME_SECRET_ENV = Object.freeze(Object.fromEntries(
  REQUIRED_CONTROL_PLANE_SECRETS.map((name) => [name, `STAGING_RUNTIME_SECRET_${name}`]),
));

const SHA = /^[0-9a-f]{40}$/u;
const VERSION = /^[0-9a-f-]{16,64}$/u;
const BOOTSTRAP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/u;
const CLOUDFLARE_AUTH = Object.freeze(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
const CONVEX_AUTH = Object.freeze(["CONVEX_DEPLOY_KEY"]);
const CHILD_ENV_ALLOWLIST = Object.freeze(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "CI", "NO_COLOR"]);
const MAX_OUTPUT = 4 * 1024 * 1024;

export class StagingBootstrapError extends Error {
  constructor(code) {
    super(code);
    this.name = "StagingBootstrapError";
    this.code = code;
  }
}

export function normalizeBootstrapInput(environment = process.env) {
  const operation = oneOf(environment.STAGING_BOOTSTRAP_OPERATION, ["bootstrap", "resume", "abort_cleanup"], "operation_invalid");
  const targetCommit = requirePattern(environment.STAGING_BOOTSTRAP_TARGET_COMMIT, SHA, "target_commit_invalid");
  const bootstrapId = requirePattern(environment.STAGING_BOOTSTRAP_ID, BOOTSTRAP_ID, "bootstrap_id_invalid");
  const confirmation = requireText(environment.STAGING_BOOTSTRAP_CONFIRMATION, "confirmation_required");
  if (confirmation !== `${operation}:staging:${targetCommit}:${bootstrapId}`) {
    throw new StagingBootstrapError("confirmation_mismatch");
  }
  const checkedOutCommit = requirePattern(environment.STAGING_BOOTSTRAP_CHECKED_OUT_COMMIT, SHA, "checked_out_commit_invalid");
  if (checkedOutCommit !== targetCommit) throw new StagingBootstrapError("checkout_not_target_commit");
  const defaultBranch = requireText(environment.STAGING_BOOTSTRAP_DEFAULT_BRANCH, "default_branch_required");
  const dispatchRef = requireText(environment.STAGING_BOOTSTRAP_DISPATCH_REF, "dispatch_ref_required");
  if (dispatchRef !== defaultBranch) throw new StagingBootstrapError("workflow_not_dispatched_from_default_branch");

  const input = {
    operation,
    targetCommit,
    bootstrapId,
    checkedOutCommit,
    automationCommit: requirePattern(environment.STAGING_BOOTSTRAP_AUTOMATION_COMMIT, SHA, "automation_commit_invalid"),
    defaultBranch,
    dispatchRef,
    repositoryRoot: resolve(environment.STAGING_BOOTSTRAP_REPOSITORY_ROOT ?? process.cwd()),
    evidencePath: resolve(environment.STAGING_BOOTSTRAP_EVIDENCE_PATH ?? join(process.cwd(), "staging-bootstrap-evidence.json")),
    stagingUrl: requireHttpsOrigin(readEnv(environment, "NEXT_CODER_STAGING_URL")),
    mediaBucket: requireStagingName(readEnv(environment, "NEXT_CODER_STAGING_MEDIA_BUCKET"), "media_bucket_invalid"),
    firmwareBucket: requireStagingName(readEnv(environment, "NEXT_CODER_STAGING_FIRMWARE_BUCKET"), "firmware_bucket_invalid"),
    expectedEdgeVersion: optionalVersion(environment.STAGING_BOOTSTRAP_CURRENT_EDGE_VERSION),
    expectedControlPlaneVersion: optionalVersion(environment.STAGING_BOOTSTRAP_CURRENT_CONTROL_PLANE_VERSION),
  };
  if (input.mediaBucket === input.firmwareBucket) throw new StagingBootstrapError("staging_bucket_names_must_differ");
  return input;
}

export function validateBootstrapTopology(edge, controlPlane, stub) {
  validateWranglerTopology(edge, controlPlane);
  if (stub?.name !== STAGING_SERVICES.edge) throw new StagingBootstrapError("stub_edge_service_mismatch");
  if (stub?.workers_dev !== false || stub?.preview_urls !== false) throw new StagingBootstrapError("stub_public_surface_enabled");
  if (stub?.routes || stub?.route) throw new StagingBootstrapError("stub_route_forbidden");
  if (stub?.main !== "./staging-edge-stub.ts") throw new StagingBootstrapError("stub_entrypoint_mismatch");
  const source = JSON.stringify(stub);
  if (/production/iu.test(source)) throw new StagingBootstrapError("stub_production_reference_forbidden");
  return true;
}

// The provisioned staging resources keep their pre-rename names, so a stray bucket or Queue can
// still appear under either prefix. Both are reported as unexpected when they are not expected, so
// the rename cannot hide a leftover resource.
const STAGING_RESOURCE_PREFIXES = ["agent-controller-", "next-coder-"];

function isStagingResource(name) {
  return STAGING_RESOURCE_PREFIXES.some((prefix) => name.startsWith(prefix)) && name.endsWith("-staging");
}

export function validateBootstrapState(input, state) {
  const queueSet = new Set(state.queues);
  const bucketSet = new Set(state.buckets);
  const serviceSet = new Set(state.services);
  for (const name of [...PRODUCTION_QUEUES, ...Object.values(PRODUCTION_SERVICES)]) {
    if (queueSet.has(name) || serviceSet.has(name)) throw new StagingBootstrapError("production_resource_present");
  }
  for (const name of [input.mediaBucket.replace(/-staging$/u, "-production"), input.firmwareBucket.replace(/-staging$/u, "-production")]) {
    if (bucketSet.has(name)) throw new StagingBootstrapError("production_resource_present");
  }
  const unexpectedQueues = state.queues.filter((name) => isStagingResource(name) && !STAGING_QUEUES.includes(name));
  const expectedBuckets = [input.mediaBucket, input.firmwareBucket];
  const unexpectedBuckets = state.buckets.filter((name) => isStagingResource(name) && !expectedBuckets.includes(name));
  if (unexpectedQueues.length || unexpectedBuckets.length) throw new StagingBootstrapError("mismatched_staging_resource_present");

  const targetExists = STAGING_QUEUES.some((name) => queueSet.has(name))
    || expectedBuckets.some((name) => bucketSet.has(name))
    || serviceSet.has(STAGING_SERVICES.edge)
    || serviceSet.has(STAGING_SERVICES.controlPlane);
  if (input.operation === "bootstrap" && targetExists) throw new StagingBootstrapError("bootstrap_target_not_empty_use_resume");
  if (input.operation !== "bootstrap" && !targetExists) throw new StagingBootstrapError("resume_target_empty_use_bootstrap");

  const edge = state.edge;
  const control = state.controlPlane;
  if (edge?.exists && !input.expectedEdgeVersion) throw new StagingBootstrapError("expected_edge_version_required");
  if (control?.exists && !input.expectedControlPlaneVersion) throw new StagingBootstrapError("expected_control_plane_version_required");
  if (edge?.exists && edge.version !== input.expectedEdgeVersion) throw new StagingBootstrapError("edge_deployment_changed");
  if (control?.exists && control.version !== input.expectedControlPlaneVersion) throw new StagingBootstrapError("control_plane_deployment_changed");

  const stubMessage = bootstrapMessage("stub", input);
  const finalMessage = releaseMessage(input);
  if (edge?.exists && ![stubMessage, finalMessage].includes(edge.message)) throw new StagingBootstrapError("edge_bootstrap_owner_mismatch");
  if (control?.exists && ![bootstrapMessage("control", input), finalMessage].includes(control.message)) {
    throw new StagingBootstrapError("control_plane_bootstrap_owner_mismatch");
  }
  if (edge?.message === finalMessage && control?.message !== finalMessage) throw new StagingBootstrapError("final_edge_without_final_control_plane");
  if (control?.exists && !edge?.exists) throw new StagingBootstrapError("control_plane_without_edge_stub");
  if (input.operation === "abort_cleanup") {
    if (edge?.message !== stubMessage || control?.exists) throw new StagingBootstrapError("abort_cleanup_requires_stub_only");
  }
  return true;
}

export function buildBootstrapPlan(input, state) {
  const expectedBuckets = [input.mediaBucket, input.firmwareBucket];
  if (input.operation === "abort_cleanup") {
    return [
      action("delete-edge-stub", "cloudflare"),
      ...STAGING_QUEUES.filter((name) => state.queues.includes(name)).reverse().map((name) => action("delete-queue", "cloudflare", { resource: name })),
      ...expectedBuckets.filter((name) => state.buckets.includes(name)).reverse().map((name) => action("delete-bucket", "cloudflare", { resource: name })),
      action("verify-abort-state", "none"),
    ];
  }

  const plan = [];
  for (const name of STAGING_QUEUES) if (!state.queues.includes(name)) plan.push(action("create-queue", "cloudflare", { resource: name }));
  for (const name of expectedBuckets) if (!state.buckets.includes(name)) plan.push(action("create-bucket", "cloudflare", { resource: name }));

  const finalMessage = releaseMessage(input);
  if (!state.edge?.exists) plan.push(action("deploy-edge-stub", "cloudflare"));
  if (!state.controlPlane?.exists) plan.push(action("deploy-control-bootstrap", "cloudflare"));
  const missingSecrets = REQUIRED_CONTROL_PLANE_SECRETS.filter((name) => !state.controlPlaneSecrets.includes(name));
  if (missingSecrets.length) plan.push(action("put-control-secrets", "cloudflare", { secretNames: missingSecrets }));
  if (!state.convexEnvironmentNames.includes("GATEWAY_CONVEX_SECRET")) {
    plan.push(action("put-convex-secret", "convex", { secretNames: ["GATEWAY_CONVEX_SECRET"] }));
  }
  if (state.controlPlane?.message !== finalMessage) {
    plan.push(action("deploy-convex", "convex"));
    plan.push(action("deploy-control-final", "cloudflare"));
  }
  if (state.edge?.message !== finalMessage) plan.push(action("deploy-edge-final", "cloudflare"));
  plan.push(action("verify-final-state", "none"));
  plan.push(action("qualify-boundary", "none"));
  return plan;
}

export function commandForAction(actionValue, input, environment) {
  const message = releaseMessage(input);
  const tag = `ac-stg-bootstrap-${input.targetCommit.slice(0, 12)}`;
  const root = input.repositoryRoot;
  switch (actionValue.kind) {
    case "create-queue": return wranglerCommand(actionValue.kind, "cloudflare", ["queues", "create", actionValue.resource], root);
    case "delete-queue": return wranglerCommand(actionValue.kind, "cloudflare", ["queues", "delete", actionValue.resource], root);
    case "create-bucket": return wranglerCommand(actionValue.kind, "cloudflare", ["r2", "bucket", "create", actionValue.resource], root);
    case "delete-bucket": return wranglerCommand(actionValue.kind, "cloudflare", ["r2", "bucket", "delete", actionValue.resource], root);
    case "deploy-edge-stub": return wranglerCommand(actionValue.kind, "cloudflare", ["deploy", "--config", "bootstrap/wrangler.staging.jsonc", "--strict", "--tag", tag, "--message", bootstrapMessage("stub", input)], root);
    case "delete-edge-stub": return wranglerCommand(actionValue.kind, "cloudflare", ["delete", STAGING_SERVICES.edge, "--config", "bootstrap/wrangler.staging.jsonc", "--force"], root);
    case "deploy-control-bootstrap": return wranglerCommand(actionValue.kind, "cloudflare-control-plane", ["deploy", "--env", "staging", "--containers-rollout", "none", "--strict", "--tag", tag, "--message", bootstrapMessage("control", input)], root);
    case "put-control-secrets": {
      const bundle = runtimeSecretBundle(environment, actionValue.secretNames);
      return { ...wranglerCommand(actionValue.kind, "cloudflare-control-plane", ["secret", "bulk", "--env", "staging"], root), stdin: JSON.stringify(bundle) };
    }
    case "put-convex-secret": return { ...command(actionValue.kind, "npm", ["exec", "convex", "--", "env", "set", "GATEWAY_CONVEX_SECRET"], root, CONVEX_AUTH), stdin: runtimeSecret(environment, "GATEWAY_CONVEX_SECRET") };
    case "deploy-convex": return command(actionValue.kind, "npm", ["exec", "convex", "--", "deploy", "--typecheck", "enable", "--codegen", "disable", "--message", message], root, CONVEX_AUTH);
    case "deploy-control-final": return wranglerCommand(actionValue.kind, "cloudflare-control-plane", ["deploy", "--env", "staging", "--containers-rollout", "immediate", "--strict", "--tag", tag, "--message", message], root);
    case "deploy-edge-final": return wranglerCommand(actionValue.kind, "cloudflare", ["deploy", "--env", "staging", "--strict", "--tag", tag, "--message", message], root);
    default: throw new StagingBootstrapError("bootstrap_action_unsupported");
  }
}

export async function validateLocalBootstrap(input, dependencies = {}) {
  const runner = dependencies.runner ?? createCommandRunner();
  const head = (await runner(command("git-head", "git", ["rev-parse", "HEAD"], input.repositoryRoot))).trim();
  if (head !== input.targetCommit) throw new StagingBootstrapError("checkout_not_target_commit");
  const status = await runner(command("git-status", "git", ["status", "--porcelain=v1", "--untracked-files=no"], input.repositoryRoot));
  if (status.trim()) throw new StagingBootstrapError("tracked_worktree_not_clean");
  await runner(command("target-on-default-branch", "git", ["merge-base", "--is-ancestor", input.targetCommit, `origin/${input.defaultBranch}`], input.repositoryRoot));
  const [edge, control, stub] = await Promise.all([
    readJsonc(join(input.repositoryRoot, "cloudflare/wrangler.jsonc")),
    readJsonc(join(input.repositoryRoot, "cloudflare-control-plane/wrangler.jsonc")),
    readJsonc(join(input.repositoryRoot, "cloudflare/bootstrap/wrangler.staging.jsonc")),
  ]);
  return validateBootstrapTopology(edge, control, stub);
}

export async function inspectBootstrapState(input, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const runner = dependencies.runner ?? createCommandRunner();
  const environment = dependencies.environment ?? process.env;
  const [queues, buckets, services, convexNames] = await Promise.all([
    listQueues(fetchImpl, environment),
    listBuckets(fetchImpl, environment),
    listServices(fetchImpl, environment),
    runner(command("convex-environment-list", "npm", ["exec", "convex", "--", "env", "list", "--names-only"], input.repositoryRoot, CONVEX_AUTH)).then(splitLines),
  ]);
  const edgeExists = services.includes(STAGING_SERVICES.edge);
  const controlExists = services.includes(STAGING_SERVICES.controlPlane);
  const [edge, controlPlane, controlPlaneSecrets] = await Promise.all([
    edgeExists ? inspectDeployment(runner, input, "cloudflare", input.expectedEdgeVersion) : null,
    controlExists ? inspectDeployment(runner, input, "cloudflare-control-plane", input.expectedControlPlaneVersion) : null,
    controlExists
      ? runner(wranglerCommand("control-plane-secret-list", "cloudflare-control-plane", ["secret", "list", "--env", "staging", "--format", "json"], input.repositoryRoot)).then(parseSecretNames)
      : [],
  ]);
  return { queues, buckets, services, edge, controlPlane, controlPlaneSecrets, convexEnvironmentNames: convexNames };
}

export async function executeBootstrap(input, dependencies = {}) {
  const runner = dependencies.runner ?? createCommandRunner();
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const environment = dependencies.environment ?? process.env;
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const checks = [];
  let state = null;
  let result = "failed";
  let qualification = null;
  const checkpoint = async () => {
    const evidence = buildEvidence({ input, startedAt, finishedAt: now(), result, checks, state, qualification });
    await writeEvidence(input.evidencePath, evidence);
    return evidence;
  };
  try {
    await validateLocalBootstrap(input, { runner });
    validateRuntimeSecretInputs(input, environment);
    state = await inspectBootstrapState(input, { runner, fetchImpl, environment });
    validateBootstrapState(input, state);
    const plan = buildBootstrapPlan(input, state);
    for (const item of plan) {
      const began = now();
      if (item.kind === "qualify-boundary") {
        qualification = await runStagingQualification({ baseUrl: input.stagingUrl, expectedEnvironment: "staging" }, { fetchImpl });
        if (qualification.result !== "passed") throw new StagingBootstrapError("credential_free_qualification_failed");
      } else if (item.kind === "verify-final-state") {
        state = await verifyFinalState(input, { runner, fetchImpl, environment });
      } else if (item.kind === "verify-abort-state") {
        state = await verifyAbortState(input, { fetchImpl, environment });
      } else {
        await runner(commandForAction(item, input, environment));
      }
      checks.push({ name: item.kind, status: "passed", durationMs: Math.max(0, now() - began) });
      await checkpoint();
    }
    result = input.operation === "abort_cleanup" ? "aborted_clean" : "passed";
  } catch (error) {
    checks.push({ name: "bootstrap", status: "failed", code: safeCode(error), durationMs: 0 });
  }
  return await checkpoint();
}

export function createCommandRunner({ spawnImpl = spawn, environment = process.env } = {}) {
  return async function run(specification) {
    return await new Promise((resolvePromise, rejectPromise) => {
      const child = spawnImpl(specification.executable, specification.args, {
        cwd: specification.cwd,
        env: childEnvironment(environment, specification.secretNames),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      let bytes = 0;
      const collect = (target) => (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) {
          child.kill("SIGTERM");
          rejectPromise(new StagingBootstrapError("bootstrap_command_output_limit"));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.once("error", () => rejectPromise(new StagingBootstrapError(`${specification.name}_failed`)));
      child.once("close", (code) => {
        if (code === 0) resolvePromise(Buffer.concat(stdout).toString("utf8"));
        else rejectPromise(new StagingBootstrapError(`${specification.name}_failed`));
      });
      child.stdin.end(specification.stdin ?? "");
    });
  };
}

function validateRuntimeSecretInputs(input, environment) {
  if (input.operation === "abort_cleanup") return;
  const values = runtimeSecretBundle(environment, REQUIRED_CONTROL_PLANE_SECRETS);
  if (values.PUBLIC_BASE_URL !== input.stagingUrl) throw new StagingBootstrapError("public_base_url_secret_mismatch");
  if (values.S3_BUCKET !== input.mediaBucket || values.FIRMWARE_S3_BUCKET !== input.firmwareBucket) {
    throw new StagingBootstrapError("bucket_secret_mismatch");
  }
  if (!values.CONVEX_URL.startsWith("https://")) throw new StagingBootstrapError("convex_url_secret_invalid");
  if (!values.S3_ENDPOINT.startsWith("https://")) throw new StagingBootstrapError("s3_endpoint_secret_invalid");
}

function runtimeSecretBundle(environment, names) {
  return Object.fromEntries(names.map((name) => [name, runtimeSecret(environment, name)]));
}

function runtimeSecret(environment, name) {
  const value = environment[RUNTIME_SECRET_ENV[name]];
  if (typeof value !== "string" || value.length === 0) throw new StagingBootstrapError(`runtime_secret_missing_${name.toLowerCase()}`);
  return value;
}

async function inspectDeployment(runner, input, packageDirectory, expectedVersion) {
  if (!expectedVersion) throw new StagingBootstrapError(packageDirectory === "cloudflare" ? "expected_edge_version_required" : "expected_control_plane_version_required");
  const current = await inspectCurrentDeployment(runner, input, packageDirectory);
  if (current.version !== expectedVersion) throw new StagingBootstrapError("active_deployment_mismatch");
  return current;
}

async function inspectCurrentDeployment(runner, input, packageDirectory) {
  const [deploymentOutput, versionsOutput] = await Promise.all([
    runner(wranglerCommand(`${packageDirectory}-deployment-status`, packageDirectory, ["deployments", "status", "--env", "staging", "--json"], input.repositoryRoot)),
    runner(wranglerCommand(`${packageDirectory}-version-list`, packageDirectory, ["versions", "list", "--env", "staging", "--json"], input.repositoryRoot)),
  ]);
  let deployment;
  let versions;
  try { deployment = JSON.parse(deploymentOutput); versions = JSON.parse(versionsOutput); }
  catch { throw new StagingBootstrapError("invalid_deployment_status"); }
  const active = activeVersions(deployment);
  if (active.length !== 1 || active[0].percentage !== 100) {
    throw new StagingBootstrapError("active_deployment_mismatch");
  }
  const activeVersion = active[0].version;
  const version = Array.isArray(versions) ? versions.find((item) => (item?.id ?? item?.version_id) === activeVersion) : null;
  const message = version?.annotations?.["workers/message"] ?? version?.annotations?.workers_message ?? null;
  if (typeof message !== "string") throw new StagingBootstrapError("active_deployment_annotation_missing");
  return { exists: true, version: activeVersion, message };
}

function activeVersions(value) {
  const rows = Array.isArray(value?.versions) ? value.versions : Array.isArray(value?.deployment?.versions) ? value.deployment.versions : [];
  return rows.map((item) => ({
    version: item?.version_id ?? item?.versionId ?? item?.id,
    percentage: Number(item?.percentage ?? item?.traffic ?? 0),
  })).filter((item) => typeof item.version === "string");
}

async function listQueues(fetchImpl, environment) {
  const body = await cloudflareApi(fetchImpl, environment, "/queues?page=1&per_page=100");
  if (!Array.isArray(body.result) || Number(body.result_info?.total_pages ?? 1) !== 1) throw new StagingBootstrapError("queue_inventory_too_large");
  return body.result.map((item) => item?.queue_name).filter((name) => typeof name === "string");
}

async function listBuckets(fetchImpl, environment) {
  const body = await cloudflareApi(fetchImpl, environment, "/r2/buckets?per_page=1000");
  const buckets = body.result?.buckets;
  if (!Array.isArray(buckets) || body.result_info?.cursor) throw new StagingBootstrapError("bucket_inventory_too_large");
  return buckets.map((item) => item?.name).filter((name) => typeof name === "string");
}

async function listServices(fetchImpl, environment) {
  // The documented account-level Worker collection is /workers/scripts, whose items key the Worker
  // name as `id`. Wrangler only ever calls the singular /workers/services/<name> form, so neither a
  // /workers/services collection nor its response shape can be relied on here.
  const body = await cloudflareApi(fetchImpl, environment, "/workers/scripts");
  if (!Array.isArray(body.result)) throw new StagingBootstrapError("invalid_service_inventory");
  return body.result.map((item) => item?.id ?? item?.name ?? item?.service).filter((name) => typeof name === "string");
}

async function cloudflareApi(fetchImpl, environment, path) {
  const account = requirePattern(environment.CLOUDFLARE_ACCOUNT_ID, /^[0-9a-f]{32}$/u, "cloudflare_account_invalid");
  const token = requireText(environment.CLOUDFLARE_API_TOKEN, "cloudflare_token_required");
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new StagingBootstrapError("cloudflare_inventory_failed");
  const body = await response.json();
  if (body?.success !== true) throw new StagingBootstrapError("cloudflare_inventory_failed");
  return body;
}

export function buildEvidence({ input, startedAt, finishedAt, result, checks, state, qualification }) {
  return {
    schema: BOOTSTRAP_EVIDENCE_SCHEMA,
    operation: input.operation,
    result,
    targetCommit: input.targetCommit,
    bootstrapRef: hashRef(input.bootstrapId),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    resources: state ? {
      queues: STAGING_QUEUES.filter((name) => state.queues.includes(name)).map(hashRef),
      buckets: [input.mediaBucket, input.firmwareBucket].filter((name) => state.buckets.includes(name)).map(hashRef),
      edge: state.edge?.exists ? "present" : "absent",
      controlPlane: state.controlPlane?.exists ? "present" : "absent",
    } : null,
    cleanup: input.operation === "abort_cleanup"
      ? "reversible_stub_resources_only"
      : result === "failed" ? "preserved_for_explicit_resume_or_abort" : "not_required",
    checks,
    qualification: qualification ? { result: qualification.result, schema: qualification.schema } : null,
  };
}

async function verifyFinalState(input, { runner, fetchImpl, environment }) {
  const [queues, buckets, services, secretOutput, convexOutput, edge, controlPlane] = await Promise.all([
    listQueues(fetchImpl, environment),
    listBuckets(fetchImpl, environment),
    listServices(fetchImpl, environment),
    runner(wranglerCommand("control-plane-secret-list", "cloudflare-control-plane", ["secret", "list", "--env", "staging", "--format", "json"], input.repositoryRoot)),
    runner(command("convex-environment-list", "npm", ["exec", "convex", "--", "env", "list", "--names-only"], input.repositoryRoot, CONVEX_AUTH)),
    inspectCurrentDeployment(runner, input, "cloudflare"),
    inspectCurrentDeployment(runner, input, "cloudflare-control-plane"),
  ]);
  requireExactTargetInventory(queues, STAGING_QUEUES, "queue");
  requireExactTargetInventory(buckets, [input.mediaBucket, input.firmwareBucket], "bucket");
  for (const service of Object.values(STAGING_SERVICES)) if (!services.includes(service)) throw new StagingBootstrapError("staging_service_missing");
  const secretNames = parseSecretNames(secretOutput);
  for (const name of REQUIRED_CONTROL_PLANE_SECRETS) if (!secretNames.includes(name)) throw new StagingBootstrapError("control_plane_secret_missing");
  const convexEnvironmentNames = splitLines(convexOutput);
  if (!convexEnvironmentNames.includes("GATEWAY_CONVEX_SECRET")) throw new StagingBootstrapError("convex_environment_secret_missing");
  const expectedMessage = releaseMessage(input);
  if (edge.message !== expectedMessage || controlPlane.message !== expectedMessage) {
    throw new StagingBootstrapError("final_deployment_annotation_mismatch");
  }
  return { queues, buckets, services, edge, controlPlane, controlPlaneSecrets: secretNames, convexEnvironmentNames };
}

async function verifyAbortState(input, { fetchImpl, environment }) {
  const [queues, buckets, services] = await Promise.all([
    listQueues(fetchImpl, environment),
    listBuckets(fetchImpl, environment),
    listServices(fetchImpl, environment),
  ]);
  const expectedBuckets = [input.mediaBucket, input.firmwareBucket];
  if (STAGING_QUEUES.some((name) => queues.includes(name))
    || expectedBuckets.some((name) => buckets.includes(name))
    || Object.values(STAGING_SERVICES).some((name) => services.includes(name))) {
    throw new StagingBootstrapError("abort_cleanup_incomplete");
  }
  return { queues, buckets, services, edge: null, controlPlane: null, controlPlaneSecrets: [], convexEnvironmentNames: [] };
}

function requireExactTargetInventory(actual, expected, kind) {
  for (const name of expected) if (!actual.includes(name)) throw new StagingBootstrapError(`staging_${kind}_missing`);
  const extras = actual.filter((name) => isStagingResource(name) && !expected.includes(name));
  if (extras.length) throw new StagingBootstrapError(`mismatched_staging_${kind}_present`);
}

async function writeEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function command(name, executable, args, cwd, secretNames = []) {
  return { name, executable, args, cwd, secretNames };
}

// `npm exec` resolves the binary from --prefix but always runs it in the caller's cwd
// (libnpmexec run-script.js: "we always run in cwd, not --prefix"). Wrangler discovers its
// configuration, and resolves a relative --config, from that cwd, so the child must start inside
// the package directory rather than at the repository root.
function wranglerCommand(name, packageDirectory, args, root) {
  return command(name, "npm", ["exec", "wrangler", "--", ...args], join(root, packageDirectory), CLOUDFLARE_AUTH);
}

function action(kind, provider, extra = {}) { return { kind, provider, ...extra }; }
function bootstrapMessage(stage, input) { return `next-coder staging bootstrap-${stage} ${input.targetCommit} ${input.bootstrapId}`; }
function releaseMessage(input) { return `next-coder staging deploy ${input.targetCommit}`; }
function hashRef(value) { return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`; }
function parseSecretNames(value) { try { return JSON.parse(value).map((item) => item?.name).filter((name) => typeof name === "string"); } catch { throw new StagingBootstrapError("invalid_secret_inventory"); } }
function splitLines(value) { return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean); }

function childEnvironment(environment, secretNames) {
  const output = {};
  for (const name of [...CHILD_ENV_ALLOWLIST, ...secretNames]) if (typeof environment[name] === "string") output[name] = environment[name];
  return output;
}

async function readJsonc(path) {
  const source = await readFile(path, "utf8");
  try { return JSON.parse(stripJsonComments(source).replace(/,\s*([}\]])/gu, "$1")); }
  catch { throw new StagingBootstrapError("invalid_wrangler_configuration"); }
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
    if (character === '"') { inString = true; result += character; continue; }
    if (character === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (character === "/" && next === "*") { blockComment = true; index += 1; continue; }
    result += character;
  }
  return result;
}

function optionalVersion(value) { if (!value) return null; return requirePattern(value, VERSION, "worker_version_invalid"); }
function requirePattern(value, pattern, code) { const text = requireText(value, code); if (!pattern.test(text)) throw new StagingBootstrapError(code); return text; }
function requireText(value, code) { if (typeof value !== "string" || value.trim().length === 0) throw new StagingBootstrapError(code); return value.trim(); }
function oneOf(value, allowed, code) { const text = requireText(value, code); if (!allowed.includes(text)) throw new StagingBootstrapError(code); return text; }
function requireStagingName(value, code) { const text = requireText(value, code); if (!/^[a-z0-9][a-z0-9-]{2,62}-staging$/u.test(text) || text.includes("production")) throw new StagingBootstrapError(code); return text; }
function requireHttpsOrigin(value) { const text = requireText(value, "staging_url_required"); const url = new URL(text); if (url.protocol !== "https:" || url.origin !== text || url.hostname === "localhost") throw new StagingBootstrapError("staging_url_invalid"); return text; }
function safeCode(error) { return error instanceof StagingBootstrapError ? error.code : "bootstrap_failed"; }

async function main() {
  const input = normalizeBootstrapInput();
  const commandName = process.argv[2];
  if (commandName === "validate-local") await validateLocalBootstrap(input);
  else if (commandName === "execute") {
    const evidence = await executeBootstrap(input);
    if (!['passed', 'aborted_clean'].includes(evidence.result)) process.exitCode = 1;
  } else throw new StagingBootstrapError("bootstrap_command_invalid");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main().catch((error) => {
    console.error(error instanceof StagingBootstrapError ? error.code : "staging_bootstrap_failed");
    process.exitCode = 1;
  });
}
