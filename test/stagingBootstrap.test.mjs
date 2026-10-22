import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BOOTSTRAP_EVIDENCE_SCHEMA,
  buildBootstrapPlan,
  buildEvidence,
  commandForAction,
  normalizeBootstrapInput,
  PRODUCTION_QUEUES,
  PRODUCTION_SERVICES,
  RUNTIME_SECRET_ENV,
  STAGING_QUEUES,
  STAGING_SERVICES,
  StagingBootstrapError,
  validateBootstrapState,
  validateBootstrapTopology,
} from "../scripts/bootstrap-staging.mjs";
import { REQUIRED_CONTROL_PLANE_SECRETS } from "../scripts/staging-release.mjs";

const TARGET = "b".repeat(40);
const AUTOMATION = "c".repeat(40);
const EDGE_VERSION = "11111111-1111-1111-1111-111111111111";
const CONTROL_VERSION = "22222222-2222-2222-2222-222222222222";
const BOOTSTRAP_ID = "bootstrap_ticket_01";

test("bootstrap topology uses one non-public fail-closed edge stub with the production RPC entrypoint name", async () => {
  const [edge, control, stub, source] = await Promise.all([
    readJsonc("cloudflare/wrangler.jsonc"),
    readJsonc("cloudflare-control-plane/wrangler.jsonc"),
    readJsonc("cloudflare/bootstrap/wrangler.staging.jsonc"),
    readFile("cloudflare/bootstrap/staging-edge-stub.ts", "utf8"),
  ]);
  assert.equal(validateBootstrapTopology(edge, control, stub), true);
  assert.equal(stub.name, STAGING_SERVICES.edge);
  assert.equal(stub.workers_dev, false);
  assert.equal(stub.preview_urls, false);
  assert.equal(stub.routes, undefined);
  assert.match(source, /class ControlPlaneConnectorRouterEntrypoint/u);
  assert.match(source, /staging_bootstrap_incomplete/u);
  assert.doesNotMatch(source, /CONTROL_PLANE|ENVIRONMENT_CONNECTOR_HUB|ASSETS/u);
});

test("the production bootstrap template remains private, fail-closed and separate from promotion", async () => {
  const [config, source, promotion] = await Promise.all([
    readJsonc("cloudflare/bootstrap/wrangler.production.jsonc"),
    readFile("cloudflare/bootstrap/production-edge-stub.ts", "utf8"),
    readFile(".github/workflows/production-promotion.yml", "utf8"),
  ]);
  assert.equal(config.name, PRODUCTION_SERVICES.edge);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.routes, undefined);
  assert.equal(config.services, undefined);
  assert.match(source, /class ControlPlaneConnectorRouterEntrypoint/u);
  assert.match(source, /production_bootstrap_incomplete/u);
  assert.match(source, /status: 503/u);
  assert.doesNotMatch(source, /CONTROL_PLANE|ENVIRONMENT_CONNECTOR_HUB|ASSETS/u);
  assert.doesNotMatch(promotion, /wrangler\.production\.jsonc|production-edge-stub/u);
});

test("fresh bootstrap plan is exact, dependency-safe, and ends with inventory plus public-boundary verification", () => {
  const input = normalized();
  const state = emptyState();
  assert.equal(validateBootstrapState(input, state), true);
  const plan = buildBootstrapPlan(input, state);
  assert.deepEqual(plan.map((item) => item.kind), [
    "create-queue", "create-queue", "create-queue",
    "create-bucket", "create-bucket",
    "deploy-edge-stub",
    "deploy-control-bootstrap",
    "put-control-secrets",
    "put-convex-secret",
    "deploy-convex",
    "deploy-control-final",
    "deploy-edge-final",
    "verify-final-state",
    "qualify-boundary",
  ]);
  assert.deepEqual(plan.filter((item) => item.kind === "create-queue").map((item) => item.resource), STAGING_QUEUES);
  assert.deepEqual(plan.find((item) => item.kind === "put-control-secrets").secretNames, REQUIRED_CONTROL_PLANE_SECRETS);
  assert.ok(plan.indexOf(plan.find((item) => item.kind === "deploy-convex"))
    < plan.indexOf(plan.find((item) => item.kind === "deploy-control-final")));
});

test("bootstrap refuses ambiguous existing, mismatched staging, and production resources", () => {
  const input = normalized();
  assert.throws(() => validateBootstrapState(input, { ...emptyState(), queues: [STAGING_QUEUES[0]] }), code("bootstrap_target_not_empty_use_resume"));
  assert.throws(() => validateBootstrapState(input, { ...emptyState(), queues: ["next-coder-other-staging"] }), code("mismatched_staging_resource_present"));
  assert.throws(() => validateBootstrapState(input, { ...emptyState(), queues: [PRODUCTION_QUEUES[0]], services: [PRODUCTION_SERVICES.edge] }), code("production_resource_present"));
});

test("resume accepts only the same stub/version marker and does not recreate existing resources", () => {
  const input = normalized("resume", { edge: EDGE_VERSION });
  const state = {
    ...emptyState(),
    queues: [...STAGING_QUEUES],
    buckets: [input.mediaBucket, input.firmwareBucket],
    services: [STAGING_SERVICES.edge],
    edge: {
      exists: true,
      version: EDGE_VERSION,
      message: `next-coder staging bootstrap-stub ${TARGET} ${BOOTSTRAP_ID}`,
    },
  };
  assert.equal(validateBootstrapState(input, state), true);
  const plan = buildBootstrapPlan(input, state);
  assert.equal(plan.some((item) => item.kind.startsWith("create-")), false);
  assert.equal(plan[0].kind, "deploy-control-bootstrap");
  assert.throws(() => validateBootstrapState(input, {
    ...state,
    edge: { ...state.edge, message: "next-coder staging bootstrap-stub deadbeef wrong" },
  }), code("edge_bootstrap_owner_mismatch"));
});

test("abort cleanup is explicit and limited to a matching stub with no private control plane", () => {
  const input = normalized("abort_cleanup", { edge: EDGE_VERSION });
  const state = {
    ...emptyState(),
    queues: [...STAGING_QUEUES],
    buckets: [input.mediaBucket, input.firmwareBucket],
    services: [STAGING_SERVICES.edge],
    edge: {
      exists: true,
      version: EDGE_VERSION,
      message: `next-coder staging bootstrap-stub ${TARGET} ${BOOTSTRAP_ID}`,
    },
  };
  assert.equal(validateBootstrapState(input, state), true);
  const plan = buildBootstrapPlan(input, state);
  assert.equal(plan[0].kind, "delete-edge-stub");
  assert.equal(plan.filter((item) => item.kind === "delete-queue").length, 3);
  assert.equal(plan.filter((item) => item.kind === "delete-bucket").length, 2);
  assert.equal(plan.some((item) => /control|convex/u.test(item.kind)), false);
  assert.equal(plan.at(-1).kind, "verify-abort-state");
  assert.throws(() => validateBootstrapState(input, {
    ...state,
    services: [...state.services, STAGING_SERVICES.controlPlane],
    controlPlane: { exists: true, version: CONTROL_VERSION, message: `next-coder staging bootstrap-control ${TARGET} ${BOOTSTRAP_ID}` },
  }), code("expected_control_plane_version_required"));
});

test("runtime secret values travel only over stdin and never appear in command arguments", () => {
  const input = normalized();
  const environment = runtimeEnvironment(input);
  const action = { kind: "put-control-secrets", provider: "cloudflare", secretNames: REQUIRED_CONTROL_PLANE_SECRETS };
  const specification = commandForAction(action, input, environment);
  const serializedArgs = JSON.stringify(specification.args);
  for (const name of REQUIRED_CONTROL_PLANE_SECRETS) {
    assert.equal(serializedArgs.includes(environment[RUNTIME_SECRET_ENV[name]]), false);
  }
  assert.deepEqual(specification.secretNames, ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
  assert.deepEqual(Object.keys(JSON.parse(specification.stdin)).sort(), [...REQUIRED_CONTROL_PLANE_SECRETS].sort());

  const convex = commandForAction({ kind: "put-convex-secret", provider: "convex", secretNames: ["GATEWAY_CONVEX_SECRET"] }, input, environment);
  assert.deepEqual(convex.secretNames, ["CONVEX_DEPLOY_KEY"]);
  assert.equal(JSON.stringify(convex.args).includes(convex.stdin), false);
});

test("redacted evidence contains hashes and state only, never resource names, versions, bootstrap id, or secrets", () => {
  const input = normalized();
  const state = {
    ...emptyState(),
    queues: [...STAGING_QUEUES],
    buckets: [input.mediaBucket, input.firmwareBucket],
    edge: { exists: true, version: EDGE_VERSION, message: `next-coder staging deploy ${TARGET}` },
    controlPlane: { exists: true, version: CONTROL_VERSION, message: `next-coder staging deploy ${TARGET}` },
  };
  const evidence = buildEvidence({
    input,
    startedAt: 0,
    finishedAt: 1,
    result: "passed",
    checks: [{ name: "verify-final-state", status: "passed", durationMs: 1 }],
    state,
    qualification: { schema: "qualification.v1", result: "passed" },
  });
  assert.equal(evidence.schema, BOOTSTRAP_EVIDENCE_SCHEMA);
  const serialized = JSON.stringify(evidence);
  for (const privateValue of [BOOTSTRAP_ID, EDGE_VERSION, CONTROL_VERSION, ...STAGING_QUEUES, input.mediaBucket, input.firmwareBucket, "fixture-secret"]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  assert.match(serialized, /sha256:[0-9a-f]{16}/u);
});

test("bootstrap workflow is manual-only, separately protected, action-pinned, and keeps mutation secrets step-scoped", async () => {
  const workflow = await readFile(".github/workflows/staging-bootstrap.yml", "utf8");
  assert.match(workflow, /^on:\n  workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|pull_request_target|schedule|workflow_call|workflow_run):/mu);
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.match(workflow, /^    environment:\n      name: staging-bootstrap$/mu);
  assert.match(workflow, /run: node \.\.\/automation\/scripts\/bootstrap-staging\.mjs execute/u);
  assert.match(workflow, /npm run check:docs/u);
  assert.doesNotMatch(workflow, /run:.*\$\{\{ secrets\./u);
  assert.doesNotMatch(workflow, /wrangler (?:deploy|delete|secret|queues|r2)|convex deploy/u);
  const actionRefs = [...workflow.matchAll(/uses: ([^\s#]+)/gu)].map((match) => match[1]);
  for (const action of actionRefs) assert.match(action, /@[0-9a-f]{40}$/u);
  const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
  const bootstrapOffset = jobs.indexOf("\n  bootstrap:\n");
  const verify = jobs.slice(0, bootstrapOffset);
  const mutation = jobs.slice(bootstrapOffset);
  assert.doesNotMatch(verify, /\$\{\{ secrets\./u);
  assert.match(mutation, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_BOOTSTRAP_API_TOKEN \}\}/u);
  assert.match(mutation, /CONVEX_DEPLOY_KEY: \$\{\{ secrets\.CONVEX_STAGING_DEPLOY_KEY \}\}/u);
  for (const name of REQUIRED_CONTROL_PLANE_SECRETS) {
    assert.match(mutation, new RegExp(`STAGING_RUNTIME_SECRET_${name}: \\$\\{\\{ secrets\\.STAGING_RUNTIME_${name} \\}\\}`));
  }
  assert.match(mutation, /if: always\(\)\n        uses: actions\/upload-artifact@[0-9a-f]{40}/u);
});

function normalized(operation = "bootstrap", versions = {}) {
  return normalizeBootstrapInput(environment(operation, versions));
}

function environment(operation, versions) {
  return {
    STAGING_BOOTSTRAP_OPERATION: operation,
    STAGING_BOOTSTRAP_TARGET_COMMIT: TARGET,
    STAGING_BOOTSTRAP_ID: BOOTSTRAP_ID,
    STAGING_BOOTSTRAP_CURRENT_EDGE_VERSION: versions.edge ?? "",
    STAGING_BOOTSTRAP_CURRENT_CONTROL_PLANE_VERSION: versions.control ?? "",
    STAGING_BOOTSTRAP_CONFIRMATION: `${operation}:staging:${TARGET}:${BOOTSTRAP_ID}`,
    STAGING_BOOTSTRAP_CHECKED_OUT_COMMIT: TARGET,
    STAGING_BOOTSTRAP_AUTOMATION_COMMIT: AUTOMATION,
    STAGING_BOOTSTRAP_DEFAULT_BRANCH: "main",
    STAGING_BOOTSTRAP_DISPATCH_REF: "main",
    STAGING_BOOTSTRAP_REPOSITORY_ROOT: process.cwd(),
    NEXT_CODER_STAGING_URL: "https://staging.example.test",
    NEXT_CODER_STAGING_MEDIA_BUCKET: "agent-controller-media-staging",
    NEXT_CODER_STAGING_FIRMWARE_BUCKET: "agent-controller-firmware-staging",
  };
}

function runtimeEnvironment(input) {
  const output = {};
  for (const name of REQUIRED_CONTROL_PLANE_SECRETS) output[RUNTIME_SECRET_ENV[name]] = `${name.toLowerCase()}-fixture-secret`;
  output[RUNTIME_SECRET_ENV.PUBLIC_BASE_URL] = input.stagingUrl;
  output[RUNTIME_SECRET_ENV.CONVEX_URL] = "https://convex.example.test";
  output[RUNTIME_SECRET_ENV.S3_ENDPOINT] = "https://account.r2.cloudflarestorage.com";
  output[RUNTIME_SECRET_ENV.S3_BUCKET] = input.mediaBucket;
  output[RUNTIME_SECRET_ENV.FIRMWARE_S3_BUCKET] = input.firmwareBucket;
  return output;
}

function emptyState() {
  return {
    queues: [],
    buckets: [],
    services: [],
    edge: null,
    controlPlane: null,
    controlPlaneSecrets: [],
    convexEnvironmentNames: [],
  };
}

function code(expected) {
  return (error) => error instanceof StagingBootstrapError && error.code === expected;
}

async function readJsonc(path) {
  const source = await readFile(path, "utf8");
  return JSON.parse(stripJsonComments(source).replace(/,\s*([}\]])/gu, "$1"));
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
    if (lineComment) { if (character === "\n") { lineComment = false; result += character; } continue; }
    if (blockComment) { if (character === "*" && next === "/") { blockComment = false; index += 1; } else if (character === "\n") result += character; continue; }
    if (inString) { result += character; if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') inString = false; continue; }
    if (character === '"') { inString = true; result += character; continue; }
    if (character === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (character === "/" && next === "*") { blockComment = true; index += 1; continue; }
    result += character;
  }
  return result;
}
