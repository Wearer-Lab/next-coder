import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_EVIDENCE_AGE_MS,
  PROMOTION_MANIFEST_SCHEMA,
  ProductionPromotionError,
  buildMutationPlan,
  buildReadOnlyPlan,
  computeArtifactDigests,
  normalizePromotionInput,
  validateEvidenceBundle,
  validateProductionTopology,
} from "../scripts/promote-production.mjs";

const TARGET = "b".repeat(40);
const CURRENT = "a".repeat(40);
const AUTOMATION = "c".repeat(40);
const NOW = Date.parse("2026-08-27T20:00:00.000Z");

test("production topology keeps reciprocal bindings, named queues, and truthful checkpoint rollout", async () => {
  const [edge, control] = await Promise.all([
    readJsonc("cloudflare/wrangler.jsonc"),
    readJsonc("cloudflare-control-plane/wrangler.jsonc"),
  ]);
  assert.deepEqual(validateProductionTopology(edge, control), {
    rolloutMode: "operator-checkpoints",
    containerRolloutPercentage: 100,
  });
  assert.deepEqual(edge.env.production.durable_objects.bindings.map((item) => item.name), ["ENVIRONMENT_CONNECTOR_HUB"]);
  assert.ok(edge.migrations[0].new_sqlite_classes.includes("DevelopmentConnectorTicketStore"));
  const canaryClaim = structuredClone(control);
  canaryClaim.env.production.containers[0].rollout_step_percentage = 10;
  assert.throws(() => validateProductionTopology(edge, canaryClaim), code("unsupported_container_rollout_configuration"));
  const leakedDevelopmentIssuer = structuredClone(edge);
  for (const environment of ["staging", "production"]) {
    leakedDevelopmentIssuer.env[environment].durable_objects.bindings.push({ name: "DEV_CONNECTOR_TICKETS", class_name: "DevelopmentConnectorTicketStore" });
  }
  assert.throws(() => validateProductionTopology(leakedDevelopmentIssuer, control), code("development_ticket_binding_in_managed_topology"));
});

test("artifact identities deterministically cover the tracked deploy inputs for every runtime surface", async () => {
  const tracked = [
    "frontend/src/main.tsx", "package.json", "package-lock.json", "cloudflare/src/index.ts",
    "cloudflare-control-plane/src/index.ts", "cloudflare-control-plane/package.json",
    "cloudflare-control-plane/package-lock.json", "cloudflare-control-plane/wrangler.jsonc",
    "cloudflare-control-plane/Dockerfile", "cloudflare-control-plane/Dockerfile.dockerignore",
    "cloudflare-control-plane/container-runtime/package.json", "src/app.mjs", "convex/schema.ts",
  ];
  const first = await computeArtifactDigests(process.cwd(), tracked);
  const second = await computeArtifactDigests(process.cwd(), [...tracked].reverse());
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first), ["console", "edge", "controlPlane", "container", "convex"]);
  for (const digest of Object.values(first)) assert.match(digest, /^[0-9a-f]{64}$/u);
});

test("promotion evidence binds four fresh passing records and immutable artifact digests to one commit", async () => {
  const fixture = await evidenceFixture();
  const result = await validateEvidenceBundle(fixture.input, { now: () => NOW });
  assert.equal(result.manifest.targetCommit, TARGET);
  assert.equal(result.evidence.release.operation, "deploy");

  const stale = await evidenceFixture({
    manifestCreatedAt: new Date(NOW - 60_000).toISOString(),
    releaseFinishedAt: new Date(NOW - MAX_EVIDENCE_AGE_MS - 1).toISOString(),
  });
  await assert.rejects(validateEvidenceBundle(stale.input, { now: () => NOW }), code("evidence_release_stale"));

  const mismatched = { ...fixture.input, manifestHash: "f".repeat(64) };
  await assert.rejects(validateEvidenceBundle(mismatched, { now: () => NOW }), code("manifest_hash_mismatch"));
});

test("manual confirmation binds production, target commit, and the entire reviewed manifest hash", () => {
  const environment = promotionEnvironment();
  const input = normalizePromotionInput(environment);
  assert.equal(input.targetCommit, TARGET);
  assert.throws(() => normalizePromotionInput({ ...environment, PRODUCTION_PROMOTION_DISPATCH_REF: "feature" }), code("workflow_not_dispatched_from_default_branch"));
  assert.throws(() => normalizePromotionInput({ ...environment, PRODUCTION_PROMOTION_CHECKED_OUT_COMMIT: CURRENT }), code("checkout_not_target_commit"));
  assert.throws(() => normalizePromotionInput({ ...environment, PRODUCTION_PROMOTION_CONFIRMATION: `promote:production:${TARGET}` }), code("confirmation_mismatch"));
});

test("plans are production-only, provider-scoped, checkpointed, and contain no bootstrap or secret mutation", async () => {
  const fixture = await evidenceFixture();
  const input = fixture.input;
  const reads = buildReadOnlyPlan(input, "/tmp/promotion-readonly");
  for (const name of ["control-plane-dry-run", "edge-dry-run", "control-plane-secrets", "edge-status", "control-status"]) {
    assert.ok(reads.find((step) => step.name === name)?.args.includes("production"));
  }
  const privatePlan = buildMutationPlan(input, "private");
  const edgePlan = buildMutationPlan(input, "edge");
  assert.deepEqual(privatePlan.map((step) => step.name), ["convex", "control-plane"]);
  assert.deepEqual(edgePlan.map((step) => step.name), ["edge"]);
  assert.ok(privatePlan[1].args.includes("immediate"));
  assert.deepEqual(privatePlan[0].secretNames, ["CONVEX_DEPLOY_KEY"]);
  assert.deepEqual(privatePlan[1].secretNames, ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
  const serialized = JSON.stringify([...reads, ...privatePlan, ...edgePlan]);
  for (const forbidden of ["bootstrap", "secret put", "queues create", "r2 bucket create", "--env\",\"staging"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("production workflow is manual, pinned, protected, evidence-bound, and split by operator checkpoints", async () => {
  const workflow = await readFile(".github/workflows/production-promotion.yml", "utf8");
  assert.match(workflow, /^on:\n  workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|pull_request_target|schedule|workflow_run):/mu);
  assert.match(workflow, /^permissions:\n  contents: read\n  actions: read$/mu);
  assert.doesNotMatch(workflow, /^\s+(?:id-token|packages|pull-requests|statuses):\s*write$/mu);
  for (const action of workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gmu)) {
    assert.match(action[1], /^[^@\s]+@[0-9a-f]{40}$/u);
  }
  assert.equal((workflow.match(/^    environment:\n      name: production$/gmu) ?? []).length, 4);
  assert.match(workflow, /^  verify-evidence:/mu);
  assert.match(workflow, /^  production-preflight:/mu);
  assert.match(workflow, /^  promote-private-plane:/mu);
  assert.match(workflow, /^  promote-edge:/mu);
  assert.match(workflow, /^  production-postflight:/mu);
  assert.match(workflow, /node \.\.\/automation\/scripts\/promote-production\.mjs validate-local/u);
  assert.match(workflow, /npm run security:repo/u);
  assert.match(workflow, /npm run check:docs/u);
  assert.match(workflow, /promote:production:TARGET_SHA:MANIFEST_SHA256/u);
  assert.match(workflow, /node \.\.\/automation\/scripts\/promote-production\.mjs preflight-edge/u);
  assert.match(workflow, /node \.\.\/automation\/scripts\/promote-production\.mjs postflight/u);
  assert.equal((workflow.match(/name: Check out protected automation source/gmu) ?? []).length, 5);
  assert.equal((workflow.match(/working-directory: release\n\s+env: \*promotion-protected-environment\n\s+run: node \.\.\/automation\/scripts\/promote-production\.mjs/gmu) ?? []).length, 2);
  assert.equal((workflow.match(/working-directory: release\n\s+env: \*promotion-cloudflare-environment\n\s+run: node \.\.\/automation\/scripts\/promote-production\.mjs/gmu) ?? []).length, 2);
  const edgeJobs = workflow.slice(workflow.indexOf("  promote-edge:"));
  assert.doesNotMatch(edgeJobs, /CONVEX_PRODUCTION_DEPLOY_KEY/u);
  assert.doesNotMatch(workflow, /staging-bootstrap|bootstrap-staging|CLOUDFLARE_BOOTSTRAP|RUNTIME_SECRET_/u);
  const allowed = ["CLOUDFLARE_PRODUCTION_API_TOKEN", "CLOUDFLARE_PRODUCTION_ACCOUNT_ID", "CONVEX_PRODUCTION_DEPLOY_KEY"];
  const secrets = [...workflow.matchAll(/\$\{\{ secrets\.([A-Z0-9_]+) \}\}/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(secrets)].sort(), allowed.sort());
});

async function evidenceFixture({
  manifestCreatedAt = new Date(NOW - 60_000).toISOString(),
  releaseFinishedAt = manifestCreatedAt,
} = {}) {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "production-promotion-evidence-"));
  const documents = {
    release: { schema: "next-coder.staging-release.v1", result: "passed", operation: "deploy", targetCommit: TARGET, finishedAt: releaseFinishedAt },
    qualification: { schema: "next-coder.staging-qualification.v1", result: "passed", target: { origin: "https://staging.example" }, finishedAt: manifestCreatedAt },
    capacity: { schema: "next-coder.staging-capacity.v1", result: "passed", targetCommit: TARGET, finishedAt: manifestCreatedAt },
    security: { schema: "next-coder.staging-security.v1", result: "passed", targetCommit: TARGET, finishedAt: manifestCreatedAt },
  };
  const references = {};
  for (const [name, document] of Object.entries(documents)) {
    const file = `${name}.json`;
    const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
    await writeFile(join(evidenceRoot, file), bytes);
    references[name] = { file, sha256: digest(bytes) };
  }
  const manifest = {
    schema: PROMOTION_MANIFEST_SCHEMA,
    targetCommit: TARGET,
    createdAt: manifestCreatedAt,
    artifacts: {
      console: "1".repeat(64), edge: "2".repeat(64), controlPlane: "3".repeat(64),
      container: "4".repeat(64), convex: "5".repeat(64),
    },
    evidence: references,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await writeFile(join(evidenceRoot, "promotion-manifest.json"), manifestBytes);
  return {
    input: {
      ...baseInput(), evidenceRoot, manifestHash: digest(manifestBytes),
    },
  };
}

function baseInput() {
  return {
    targetCommit: TARGET,
    currentCommit: CURRENT,
    automationCommit: AUTOMATION,
    repositoryRoot: process.cwd(),
    stagingUrl: "https://staging.example",
    productionUrl: "https://production.example",
    mediaBucket: "agent-controller-media-production",
    firmwareBucket: "agent-controller-firmware-production",
  };
}

function promotionEnvironment() {
  const manifestHash = "d".repeat(64);
  return {
    PRODUCTION_PROMOTION_TARGET_COMMIT: TARGET,
    PRODUCTION_PROMOTION_CURRENT_COMMIT: CURRENT,
    PRODUCTION_PROMOTION_CHECKED_OUT_COMMIT: TARGET,
    PRODUCTION_PROMOTION_AUTOMATION_COMMIT: AUTOMATION,
    PRODUCTION_PROMOTION_CURRENT_EDGE_VERSION: "11111111-1111-1111-1111-111111111111",
    PRODUCTION_PROMOTION_CURRENT_CONTROL_PLANE_VERSION: "22222222-2222-2222-2222-222222222222",
    PRODUCTION_PROMOTION_MANIFEST_SHA256: manifestHash,
    PRODUCTION_PROMOTION_CONFIRMATION: `promote:production:${TARGET}:${manifestHash}`,
    PRODUCTION_PROMOTION_DEFAULT_BRANCH: "main",
    PRODUCTION_PROMOTION_DISPATCH_REF: "main",
    NEXT_CODER_STAGING_URL: "https://staging.example",
    NEXT_CODER_PRODUCTION_URL: "https://production.example",
    NEXT_CODER_PRODUCTION_MEDIA_BUCKET: "agent-controller-media-production",
    NEXT_CODER_PRODUCTION_FIRMWARE_BUCKET: "agent-controller-firmware-production",
  };
}

async function readJsonc(path) {
  const value = await readFile(path, "utf8");
  return JSON.parse(value);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function code(expected) {
  return (error) => error instanceof ProductionPromotionError && error.code === expected;
}
