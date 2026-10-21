import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  buildMutationPlan,
  buildReadOnlyPlan,
  createCommandRunner,
  deploymentRefs,
  executeStagingRelease,
  normalizeReleaseInput,
  requireDeploymentCommit,
  RELEASE_EVIDENCE_SCHEMA,
  REQUIRED_CONTROL_PLANE_SECRETS,
  StagingReleaseError,
  validateMigrationCompatibility,
  validateWranglerTopology,
} from "../scripts/staging-release.mjs";

const TARGET = "b".repeat(40);
const CURRENT = "a".repeat(40);
const AUTOMATION = "c".repeat(40);

function workflowJobBlocks(workflow) {
  const jobsOffset = workflow.indexOf("\njobs:\n");
  assert.notEqual(jobsOffset, -1, "workflow must define jobs");
  const source = workflow.slice(jobsOffset + 1);
  const matches = [...source.matchAll(/^  ([a-z0-9-]+):\n/gmu)];
  return new Map(matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? source.length;
    return [match[1], source.slice(match.index, end)];
  }));
}

function workflowDispatchInputBlocks(workflow) {
  const start = workflow.indexOf("    inputs:\n");
  const end = workflow.indexOf("\npermissions:\n", start);
  assert.notEqual(start, -1, "workflow_dispatch must define inputs");
  assert.notEqual(end, -1, "workflow permissions must follow dispatch inputs");
  const source = workflow.slice(start, end);
  const matches = [...source.matchAll(/^      ([a-z][a-z0-9_]+):\n/gmu)];
  return new Map(matches.map((match, index) => {
    const blockEnd = matches[index + 1]?.index ?? source.length;
    return [match[1], source.slice(match.index, blockEnd)];
  }));
}

function namedStep(job, name) {
  const marker = `      - name: ${name}\n`;
  const start = job.indexOf(marker);
  assert.notEqual(start, -1, `missing step: ${name}`);
  const next = job.indexOf("\n      - name: ", start + marker.length);
  return job.slice(start, next === -1 ? job.length : next);
}

test("staging topology names every required private boundary, queue, cron, migration, and Container budget", async () => {
  const [edge, controlPlane] = await Promise.all([
    readJsonc("cloudflare/wrangler.jsonc"),
    readJsonc("cloudflare-control-plane/wrangler.jsonc"),
  ]);
  assert.equal(validateWranglerTopology(edge, controlPlane), true);
  assert.deepEqual(edge.env.staging.durable_objects.bindings.map((item) => item.name), ["ENVIRONMENT_CONNECTOR_HUB"]);
  assert.ok(edge.migrations[0].new_sqlite_classes.includes("DevelopmentConnectorTicketStore"), "historical migration must remain append-only");
  assert.equal(edge.migrations.some((migration) => migration.deleted_classes?.includes("DevelopmentConnectorTicketStore")), false);
});

test("staging topology fails closed on telemetry binding or privacy-sampling drift", async () => {
  const [edge, controlPlane] = await Promise.all([
    readJsonc("cloudflare/wrangler.jsonc"),
    readJsonc("cloudflare-control-plane/wrangler.jsonc"),
  ]);
  const missingDataset = structuredClone(edge);
  missingDataset.env.staging.analytics_engine_datasets = [];
  assert.throws(() => validateWranglerTopology(missingDataset, controlPlane), code("edge_telemetry_binding_mismatch"));

  const invocationLeak = structuredClone(controlPlane);
  invocationLeak.env.staging.observability = structuredClone(invocationLeak.observability);
  invocationLeak.env.staging.observability.logs.invocation_logs = true;
  assert.throws(() => validateWranglerTopology(edge, invocationLeak), code("control_plane_invocation_logs_not_disabled"));

  const persistentLogs = structuredClone(edge);
  persistentLogs.observability.logs.head_sampling_rate = 0.01;
  assert.throws(() => validateWranglerTopology(persistentLogs, controlPlane), code("edge_log_sampling_unsafe"));

  const excessiveTraces = structuredClone(edge);
  excessiveTraces.observability.traces.head_sampling_rate = 0.01;
  assert.throws(() => validateWranglerTopology(excessiveTraces, controlPlane), code("edge_trace_sampling_unsafe"));

  const leakedDevelopmentIssuer = structuredClone(edge);
  leakedDevelopmentIssuer.env.staging.durable_objects.bindings.push({ name: "DEV_CONNECTOR_TICKETS", class_name: "DevelopmentConnectorTicketStore" });
  assert.throws(() => validateWranglerTopology(leakedDevelopmentIssuer, controlPlane), code("development_ticket_binding_in_staging"));
});

test("deploy order is Convex then private Container then edge; rollback reverses the Worker pair and never rewinds Convex", () => {
  const deploy = buildMutationPlan({ operation: "deploy", targetCommit: TARGET });
  assert.deepEqual(deploy.map((step) => step.name), ["convex", "control-plane", "edge"]);
  assert.ok(deploy[1].args.includes("immediate"));
  assert.ok(deploy.slice(1).every((step) => step.args.includes("--strict")));

  const rollback = buildMutationPlan({ operation: "rollback", targetCommit: CURRENT });
  assert.deepEqual(rollback.map((step) => step.name), ["edge", "control-plane"]);
  assert.equal(rollback.some((step) => step.name === "convex"), false);

  const serialized = JSON.stringify([...deploy, ...rollback]);
  assert.equal(serialized.includes("production"), false);
  assert.equal(serialized.includes("secret put"), false);
  assert.equal(serialized.includes("queues create"), false);
  assert.equal(serialized.includes("r2 bucket create"), false);
});

test("preflight command construction is dry-run/read-only and does not provision resources", () => {
  assert.ok(REQUIRED_CONTROL_PLANE_SECRETS.includes("WEB_PUSH_VAPID_KEYS"));
  assert.ok(REQUIRED_CONTROL_PLANE_SECRETS.includes("WEB_PUSH_STORAGE_ENCRYPTION_KEY"));
  const plan = buildReadOnlyPlan("/workspace/release", "/private/tmp/preflight");
  assert.deepEqual(plan.map((step) => step.name), ["convex-dry-run", "control-plane-dry-run", "edge-dry-run"]);
  assert.ok(plan.every((step) => step.args.includes("--dry-run")));
  const serialized = JSON.stringify(plan);
  for (const forbidden of ["secret put", "queues create", "r2 bucket create", "--env\",\"production"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("command execution exposes each provider only to the credential it needs", async () => {
  const previous = {
    cloudflareToken: process.env.CLOUDFLARE_API_TOKEN,
    cloudflareAccount: process.env.CLOUDFLARE_ACCOUNT_ID,
    convexKey: process.env.CONVEX_DEPLOY_KEY,
    unrelated: process.env.UNRELATED_RELEASE_SECRET,
  };
  process.env.CLOUDFLARE_API_TOKEN = "cloudflare-token-fixture";
  process.env.CLOUDFLARE_ACCOUNT_ID = "a".repeat(32);
  process.env.CONVEX_DEPLOY_KEY = "convex-key-fixture";
  process.env.UNRELATED_RELEASE_SECRET = "must-not-be-inherited";
  const spawnedEnvironments = [];
  const runner = createCommandRunner({
    spawnImpl(_executable, _args, options) {
      spawnedEnvironments.push(options.env);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  });

  try {
    const [convex, controlPlane] = buildMutationPlan({ operation: "deploy", targetCommit: TARGET });
    await runner(convex);
    await runner(controlPlane);
    await runner({ name: "git", executable: "git", args: ["status"], cwd: process.cwd(), secretNames: [] });
  } finally {
    restoreEnvironment("CLOUDFLARE_API_TOKEN", previous.cloudflareToken);
    restoreEnvironment("CLOUDFLARE_ACCOUNT_ID", previous.cloudflareAccount);
    restoreEnvironment("CONVEX_DEPLOY_KEY", previous.convexKey);
    restoreEnvironment("UNRELATED_RELEASE_SECRET", previous.unrelated);
  }

  assert.equal(spawnedEnvironments[0].CONVEX_DEPLOY_KEY, "convex-key-fixture");
  assert.equal(spawnedEnvironments[0].CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(spawnedEnvironments[1].CLOUDFLARE_API_TOKEN, "cloudflare-token-fixture");
  assert.equal(spawnedEnvironments[1].CLOUDFLARE_ACCOUNT_ID, "a".repeat(32));
  assert.equal(spawnedEnvironments[1].CONVEX_DEPLOY_KEY, undefined);
  assert.equal(spawnedEnvironments[2].CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(spawnedEnvironments[2].CONVEX_DEPLOY_KEY, undefined);
  assert.ok(spawnedEnvironments.every((environment) => environment.UNRELATED_RELEASE_SECRET === undefined));
});

test("release input fails closed on branch, checkout, confirmation, and direction ambiguity", () => {
  const base = releaseEnvironment();
  const normalized = normalizeReleaseInput(base);
  assert.equal(normalized.operation, "deploy");
  assert.equal(normalized.targetCommit, TARGET);

  assert.throws(() => normalizeReleaseInput({ ...base, STAGING_RELEASE_DISPATCH_REF: "feature" }), code("workflow_not_dispatched_from_default_branch"));
  assert.throws(() => normalizeReleaseInput({ ...base, STAGING_RELEASE_CHECKED_OUT_COMMIT: CURRENT }), code("checkout_not_target_commit"));
  assert.throws(() => normalizeReleaseInput({ ...base, STAGING_RELEASE_CONFIRMATION: "deploy:staging:wrong" }), code("confirmation_mismatch"));
  assert.throws(() => normalizeReleaseInput({ ...base, STAGING_RELEASE_CURRENT_COMMIT: TARGET }), code("target_must_differ_from_current"));
});

test("Durable Object migrations are append-only forward and identical across rollback", () => {
  const oldConfig = { migrations: [{ tag: "v1", new_sqlite_classes: ["A"] }] };
  const forward = { migrations: [...oldConfig.migrations, { tag: "v2", new_sqlite_classes: ["B"] }] };
  assert.equal(validateMigrationCompatibility(oldConfig, forward), true);
  assert.throws(
    () => validateMigrationCompatibility(forward, oldConfig),
    code("durable_object_migrations_not_append_only"),
  );
  assert.throws(
    () => validateMigrationCompatibility(forward, oldConfig, { rollback: true }),
    code("rollback_crosses_durable_object_migration"),
  );
});

test("deployment evidence hashes platform version IDs instead of recording raw IDs", () => {
  const rawEdge = "11111111-1111-1111-1111-111111111111";
  const rawControl = "22222222-2222-2222-2222-222222222222";
  const evidence = {
    schema: RELEASE_EVIDENCE_SCHEMA,
    deployments: deploymentRefs({
      edgeStatus: { versions: [{ version_id: rawEdge, percentage: 100 }] },
      controlStatus: { versions: [{ version_id: rawControl, percentage: 100 }] },
    }),
  };
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(rawEdge), false);
  assert.equal(serialized.includes(rawControl), false);
  assert.match(evidence.deployments.edge[0], /^sha256:[0-9a-f]{16}$/u);
  assert.match(evidence.deployments.controlPlane[0], /^sha256:[0-9a-f]{16}$/u);
});

test("active deployment annotations bind operator-supplied versions to the claimed source commit", () => {
  assert.equal(requireDeploymentCommit({
    deployment: { versions: [{ version_id: "11111111-1111-1111-1111-111111111111", percentage: 100 }] },
    versionMetadata: [{
      id: "11111111-1111-1111-1111-111111111111",
      annotations: { "workers/message": `next-coder staging deploy ${CURRENT}` },
    }],
  }, CURRENT), undefined);
  assert.throws(() => requireDeploymentCommit({
    annotations: { "workers/message": `next-coder staging deploy ${TARGET}` },
  }, CURRENT), code("deployment_source_commit_mismatch"));
  assert.throws(() => requireDeploymentCommit({ annotations: {} }, CURRENT), code("deployment_source_commit_mismatch"));
});

test("staging workflow is manual, environment-protected, pinned, race-checked, and keeps secrets provider-scoped", async () => {
  const workflow = await readFile(".github/workflows/staging-release.yml", "utf8");
  const jobs = workflowJobBlocks(workflow);
  const inputs = workflowDispatchInputBlocks(workflow);
  const verify = jobs.get("verify-commit");
  const release = jobs.get("release");

  assert.match(workflow, /^on:\n  workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|pull_request_target|schedule|workflow_call|workflow_run):/mu);
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.doesNotMatch(workflow, /^\s+(?:actions|checks|deployments|id-token|packages|pull-requests|statuses):\s*write$/mu);
  assert.deepEqual([...inputs.keys()], [
    "operation",
    "target_commit_sha",
    "current_commit_sha",
    "current_edge_version",
    "current_control_plane_version",
    "confirmation",
  ]);
  for (const [name, input] of inputs) {
    assert.match(input, /^        required: true$/mu, `${name} must be required`);
    assert.match(input, new RegExp(`^        type: ${name === "operation" ? "choice" : "string"}$`, "mu"));
  }
  assert.match(inputs.get("operation"), /^        options:\n          - deploy\n          - rollback$/mu);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.deepEqual([...jobs.keys()], ["verify-commit", "release"]);
  assert.ok(verify);
  assert.ok(release);
  assert.doesNotMatch(verify, /^    environment:/mu);
  assert.doesNotMatch(verify, /\$\{\{\s*secrets\./u);
  assert.match(release, /^    needs: verify-commit$/mu);
  assert.match(release, /^    environment:\n      name: staging\n      url: \$\{\{ vars\.NEXT_CODER_STAGING_URL \|\| vars\.AGENT_CONTROLLER_STAGING_URL \}\}$/mu);

  for (const command of [
    "node ../automation/scripts/staging-release.mjs validate-local",
    "npm ci --no-audit --no-fund",
    "npm ci --prefix cloudflare --no-audit --no-fund",
    "npm ci --prefix cloudflare-control-plane --no-audit --no-fund",
    "npm run security:repo",
    "npm run check:docs",
    "npm test",
    "npm run pack:connector",
    "npm run test:container",
    "npm run test:workflow",
  ]) {
    assert.ok(verify.includes(`run: ${command}`), `verify-commit is missing ${command}`);
  }
  assert.match(verify, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(verify, /ref: \$\{\{ inputs\.target_commit_sha \}\}/u);
  assert.match(verify, /STAGING_RELEASE_CURRENT_EDGE_VERSION: \$\{\{ inputs\.current_edge_version \}\}/u);
  assert.match(verify, /STAGING_RELEASE_CURRENT_CONTROL_PLANE_VERSION: \$\{\{ inputs\.current_control_plane_version \}\}/u);
  assert.match(verify, /STAGING_RELEASE_CONFIRMATION: \$\{\{ inputs\.confirmation \}\}/u);

  const preflight = namedStep(release, "Read-only account and binding preflight");
  const mutation = namedStep(release, "Deploy or roll back in dependency-safe order");
  const evidence = namedStep(release, "Upload redacted deployment evidence");
  const allowedSecrets = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CONVEX_DEPLOY_KEY"];
  const referencedSecrets = [...workflow.matchAll(/\$\{\{ secrets\.([A-Z0-9_]+) \}\}/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(referencedSecrets)].sort(), [...allowedSecrets].sort());
  assert.deepEqual(referencedSecrets.sort(), [...allowedSecrets].sort());
  for (const secret of allowedSecrets) {
    assert.match(preflight, new RegExp(`^          ${secret}: \\$\\{\\{ secrets\\.${secret} \\}\\}$`, "mu"));
  }
  assert.match(mutation, /^        env: \*staging-release-environment$/mu);
  assert.match(preflight, /run: node \.\.\/automation\/scripts\/staging-release\.mjs preflight/u);
  assert.match(mutation, /run: node \.\.\/automation\/scripts\/staging-release\.mjs execute/u);
  assert.match(evidence, /if: always\(\)\n        uses: actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.doesNotMatch(workflow, /if: (?:failure|cancelled)\(\)/u, "failure must not trigger an automatic rollback");
  assert.doesNotMatch(workflow, /run:.*\$\{\{ secrets\./u);
  assert.doesNotMatch(workflow, /wrangler (deploy|rollback|secret put|queues create|r2 bucket create)/u);
  const actionRefs = [...workflow.matchAll(/uses: ([^\s#]+)/gu)].map((match) => match[1]);
  for (const action of actionRefs) {
    assert.match(action, /@[0-9a-f]{40}$/u, `action is not commit-pinned: ${action}`);
  }
  const checkoutCount = actionRefs.filter((action) => action.startsWith("actions/checkout@")).length;
  assert.equal([...workflow.matchAll(/^          persist-credentials: false$/gmu)].length, checkoutCount);
});

test("hermetic release executes only the planned staging mutations and writes redacted checkpoint evidence", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "next-coder-staging-release-test-"));
  const evidencePath = join(temporary, "evidence.json");
  const edgeSource = await readFile("cloudflare/wrangler.jsonc", "utf8");
  const controlSource = await readFile("cloudflare-control-plane/wrangler.jsonc", "utf8");
  const currentEdge = "11111111-1111-1111-1111-111111111111";
  const currentControl = "22222222-2222-2222-2222-222222222222";
  const nextEdge = "33333333-3333-3333-3333-333333333333";
  const nextControl = "44444444-4444-4444-4444-444444444444";
  const commands = [];
  const state = { edge: currentEdge, control: currentControl };
  const runner = async (specification) => {
    commands.push(specification.name);
    if (specification.name === "git-head") return TARGET;
    if (specification.name === "git-status") return "";
    if (specification.name === "git-show") {
      return specification.args.at(-1).endsWith("cloudflare/wrangler.jsonc") ? edgeSource : controlSource;
    }
    if (specification.name === "control-plane-secret-list") {
      return JSON.stringify(REQUIRED_CONTROL_PLANE_SECRETS.map((name) => ({ name, type: "secret_text" })));
    }
    if (specification.name === "convex-environment-list") return "GATEWAY_CONVEX_SECRET\n";
    if (specification.name === "cloudflare-deployment-status") return deployment(state.edge, CURRENT);
    if (specification.name === "cloudflare-version-list") return versions(state.edge, state.edge === currentEdge ? CURRENT : TARGET);
    if (specification.name === "cloudflare-control-plane-deployment-status") return deployment(state.control, CURRENT);
    if (specification.name === "cloudflare-control-plane-version-list") return versions(state.control, state.control === currentControl ? CURRENT : TARGET);
    if (specification.name === "control-plane") {
      state.control = nextControl;
      return "";
    }
    if (specification.name === "edge") {
      state.edge = nextEdge;
      return "";
    }
    return "";
  };
  const environment = {
    CLOUDFLARE_ACCOUNT_ID: "5".repeat(32),
    CLOUDFLARE_API_TOKEN: "cloudflare-token-must-never-appear",
    CONVEX_DEPLOY_KEY: "convex-key-must-never-appear",
  };
  const input = {
    operation: "deploy",
    targetCommit: TARGET,
    currentCommit: CURRENT,
    headCommit: TARGET,
    automationCommit: AUTOMATION,
    defaultBranch: "main",
    dispatchRef: "main",
    expectedEdgeVersion: currentEdge,
    expectedControlPlaneVersion: currentControl,
    repositoryRoot: process.cwd(),
    evidencePath,
    stagingUrl: "https://staging.example.test",
    mediaBucket: "private-media-bucket",
    firmwareBucket: "private-firmware-bucket",
  };
  const evidence = await executeStagingRelease(input, {
    runner,
    environment,
    sleep: async () => {},
    fetchImpl: releaseFetchFixture(input, environment),
  });

  assert.equal(evidence.result, "passed");
  assert.deepEqual(commands.filter((name) => ["convex", "control-plane", "edge"].includes(name)), ["convex", "control-plane", "edge"]);
  const persisted = await readFile(evidencePath, "utf8");
  for (const forbidden of [
    environment.CLOUDFLARE_API_TOKEN,
    environment.CONVEX_DEPLOY_KEY,
    environment.CLOUDFLARE_ACCOUNT_ID,
    input.mediaBucket,
    input.firmwareBucket,
    currentEdge,
    currentControl,
    nextEdge,
    nextControl,
  ]) assert.equal(persisted.includes(forbidden), false);
  assert.match(persisted, /"result": "passed"/u);
  assert.match(persisted, /"control_plane_rollout_boundary"/u);
});

function releaseEnvironment() {
  return {
    STAGING_RELEASE_OPERATION: "deploy",
    STAGING_RELEASE_TARGET_COMMIT: TARGET,
    STAGING_RELEASE_CURRENT_COMMIT: CURRENT,
    STAGING_RELEASE_CHECKED_OUT_COMMIT: TARGET,
    STAGING_RELEASE_AUTOMATION_COMMIT: AUTOMATION,
    STAGING_RELEASE_DEFAULT_BRANCH: "main",
    STAGING_RELEASE_DISPATCH_REF: "main",
    STAGING_RELEASE_CONFIRMATION: `deploy:staging:${TARGET}`,
    STAGING_RELEASE_CURRENT_EDGE_VERSION: "11111111-1111-1111-1111-111111111111",
    STAGING_RELEASE_CURRENT_CONTROL_PLANE_VERSION: "22222222-2222-2222-2222-222222222222",
  };
}

function code(expected) {
  return (error) => error instanceof StagingReleaseError && error.code === expected;
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function readJsonc(path) {
  const source = await readFile(path, "utf8");
  return JSON.parse(source.replace(/,\s*([}\]])/gu, "$1"));
}

function deployment(versionId, commit) {
  return JSON.stringify({
    versions: [{ version_id: versionId, percentage: 100 }],
    annotations: { "workers/message": `next-coder staging deploy ${commit}` },
  });
}

function versions(versionId, commit) {
  return JSON.stringify([{
    id: versionId,
    annotations: { "workers/message": `next-coder staging deploy ${commit}` },
  }]);
}

function releaseFetchFixture(input, environment) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.cloudflare.com" && parsed.pathname.endsWith("/queues")) {
      return Response.json({
        success: true,
        result: [
          { queue_name: "agent-controller-connector-events-staging" },
          { queue_name: "agent-controller-background-staging" },
          { queue_name: "agent-controller-dead-letter-staging" },
        ],
        result_info: { total_pages: 1 },
      });
    }
    if (parsed.hostname === "api.cloudflare.com" && parsed.pathname.endsWith("/r2/buckets")) {
      return Response.json({
        success: true,
        result: { buckets: [{ name: input.mediaBucket }, { name: input.firmwareBucket }] },
        result_info: {},
      });
    }
    assert.equal(parsed.origin, input.stagingUrl);
    assert.equal(environment.CLOUDFLARE_API_TOKEN.includes(parsed.href), false);
    if (parsed.pathname === "/health") return Response.json(healthyStagingHealth());
    if (parsed.pathname === "/v1/auth/config") {
      return Response.json({ deploymentMode: "cloud", developmentTokens: { enabled: false } });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
}

function healthyStagingHealth() {
  return {
    ok: true,
    runtime: "cloudflare-workers",
    environment: "staging",
    connectorAuth: "control-plane",
    sameOriginControlPlaneBound: true,
    controlPlaneAdapterIntegrated: true,
    eventSinkConfigured: true,
    backgroundQueueConfigured: true,
    backgroundQuarantineConfigured: true,
    backgroundDeadLetterPolicy: "redacted-envelope-plus-broker-dlq",
    backgroundOwnershipHealthy: true,
    scheduledOwnership: "cloudflare-queue",
  };
}
