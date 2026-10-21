import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  normalizeConfiguration,
  parseArguments,
  runStagingQualification,
} from "../scripts/qualify-staging.mjs";

const TOKEN = "qualification-platform-token-never-emit";
const ENVIRONMENT_ID = "env_staging_private_id";
const PROJECT_ID = "project_staging_private_id";
const PROVIDER = "codex_private_instance";
const MODEL = "private-model-name";
const PROMPT = "Private qualification prompt that must not enter evidence.";

test("qualification refuses implicit targets and unsafe origins before fetch", async () => {
  let calls = 0;
  const missing = await runStagingQualification({}, { fetchImpl: async () => { calls += 1; } });
  assert.equal(missing.result, "failed");
  assert.equal(missing.checks[0].code, "base_url_required");
  assert.equal(calls, 0);

  assert.throws(
    () => normalizeConfiguration({ baseUrl: "http://staging.example.test" }),
    (error) => error.code === "https_required",
  );
  assert.throws(
    () => normalizeConfiguration({ baseUrl: "https://staging.example.test/path" }),
    (error) => error.code === "base_url_must_be_origin",
  );
  assert.throws(
    () => normalizeConfiguration({ baseUrl: "https://127.0.0.2" }),
    (error) => error.code === "hostname_required",
  );
});

test("credential-free qualification verifies cloud health and every public/private boundary", async (t) => {
  const requests = [];
  const fixture = await startFixture(t, async (request, response) => {
    requests.push({ method: request.method, path: new URL(request.url, "http://fixture").pathname });
    const path = new URL(request.url, "http://fixture").pathname;
    if (path === "/health") return sendJson(response, 200, healthyCloud());
    if (path === "/v1/auth/config") return sendJson(response, 200, cloudAuthConfig());
    if (PRIVATE_PATHS.has(path)) return sendJson(response, 404, { error: "not_found" });
    return sendJson(response, 500, { error: "unexpected_authenticated_request" });
  });

  const evidence = await runStagingQualification({
    baseUrl: fixture.baseUrl,
    allowHttpLoopback: true,
  });

  assert.equal(evidence.result, "passed");
  assert.equal(evidence.summary.passed, 8);
  assert.deepEqual(requests.map((entry) => entry.path), [
    "/health",
    "/v1/auth/config",
    "/v1/internal/connectors/tickets/consume",
    "/v1/internal/connector-events",
    "/v1/internal/background/run",
    "/internal/environments/qualification-probe/connector/status",
    "/__dev/tickets",
  ]);
  assert.equal(requests.some((entry) => entry.path.startsWith("/v1/connectors")), false);
});

test("a reachable private route fails closed before authenticated or mutating work", async (t) => {
  const requests = [];
  const fixture = await startFixture(t, async (request, response) => {
    const path = new URL(request.url, "http://fixture").pathname;
    requests.push(path);
    if (path === "/health") return sendJson(response, 200, healthyCloud());
    if (path === "/v1/auth/config") return sendJson(response, 200, cloudAuthConfig());
    if (path === "/v1/internal/background/run") return sendJson(response, 200, { accepted: true, private: "never expose this" });
    if (PRIVATE_PATHS.has(path)) return sendJson(response, 404, { error: "not_found" });
    return sendJson(response, 500, { error: "authenticated request should not run" });
  });

  const evidence = await runStagingQualification(fullInput(fixture.baseUrl));
  assert.equal(evidence.result, "failed");
  assert.equal(evidence.checks.find((check) => check.name === "private_background_runner_hidden")?.code, "private_route_publicly_reachable");
  assert.equal(evidence.checks.find((check) => check.name === "first_command_completed")?.status, "skipped");
  assert.equal(requests.filter((path) => path === "/v1/auth/config").length, 1);
  assert.equal(requests.some((path) => path.endsWith("/threads")), false);
  assert.equal(JSON.stringify(evidence).includes("never expose this"), false);
});

test("authenticated qualification proves connector-first readiness without creating a thread", async (t) => {
  let launchCalls = 0;
  const fixture = await startFixture(t, fixtureHandler({
    onLaunch() {
      launchCalls += 1;
    },
  }));

  const evidence = await runStagingQualification({
    baseUrl: fixture.baseUrl,
    allowHttpLoopback: true,
    accessToken: TOKEN,
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    providerInstance: PROVIDER,
    model: MODEL,
  });

  assert.equal(evidence.result, "passed");
  assert.equal(launchCalls, 0);
  assert.equal(evidence.checks.find((check) => check.name === "connector_first_readiness")?.connectorStatus, "online");
  assert.equal(evidence.checks.find((check) => check.name === "environment_snapshot")?.environmentStatus, "reachable");
  assert.equal(evidence.checks.find((check) => check.name === "provider_model_ready")?.providerStatus, "ready");
  assertRedacted(evidence);
});

test("explicit first-command qualification waits for completed reply evidence and emits only opaque references", async (t) => {
  let launchBody = null;
  let pollCount = 0;
  const fixture = await startFixture(t, fixtureHandler({
    onLaunch(body) {
      launchBody = body;
    },
    commandStatus() {
      pollCount += 1;
      return pollCount === 1 ? "dispatched" : "completed";
    },
  }));

  const evidence = await runStagingQualification(fullInput(fixture.baseUrl), {
    sleep: async () => {},
  });

  assert.equal(evidence.result, "passed");
  assert.deepEqual(launchBody, {
    projectId: PROJECT_ID,
    text: PROMPT,
    modelSelection: { instanceId: PROVIDER, model: MODEL },
    runtimeMode: "approval-required",
    interactionMode: "default",
  });
  const proof = evidence.checks.find((check) => check.name === "first_command_completed");
  assert.equal(proof?.status, "completed");
  assert.equal(proof?.pollCount, 2);
  assert.match(proof?.commandRef, /^sha256:[0-9a-f]{16}$/u);
  assert.match(proof?.threadRef, /^sha256:[0-9a-f]{16}$/u);
  assertRedacted(evidence);
});

test("an unavailable provider fails readiness and prevents the opt-in mutation", async (t) => {
  let launchCalls = 0;
  const fixture = await startFixture(t, fixtureHandler({
    providerUsable: false,
    onLaunch() {
      launchCalls += 1;
    },
  }));

  const evidence = await runStagingQualification(fullInput(fixture.baseUrl));
  assert.equal(evidence.result, "failed");
  assert.equal(evidence.checks.find((check) => check.name === "provider_model_ready")?.code, "test_provider_not_ready");
  assert.equal(evidence.checks.find((check) => check.name === "first_command_completed")?.status, "skipped");
  assert.equal(launchCalls, 0);
  assertRedacted(evidence);
});

test("terminal command failure is reported with a bounded code and no provider detail", async (t) => {
  const fixture = await startFixture(t, fixtureHandler({
    commandStatus: () => "failed",
    commandResult: { message: "provider output and stack must never enter evidence" },
  }));

  const evidence = await runStagingQualification(fullInput(fixture.baseUrl), { sleep: async () => {} });
  assert.equal(evidence.result, "failed");
  assert.equal(evidence.checks.find((check) => check.name === "first_command_completed")?.code, "first_command_terminal_failure");
  assert.equal(JSON.stringify(evidence).includes("provider output"), false);
  assertRedacted(evidence);
});

test("CLI argument parsing keeps bearer tokens and prompts out of argv", () => {
  const parsed = parseArguments([
    "--base-url", "https://staging.example.test",
    "--environment-id", "env_test",
  ], {
    NEXT_CODER_STAGING_ACCESS_TOKEN: TOKEN,
  });
  assert.equal(parsed.accessToken, TOKEN);
  assert.equal(parsed.baseUrl, "https://staging.example.test");
  assert.equal(parsed.environmentId, "env_test");
  assert.throws(
    () => parseArguments(["--access-token-file", "/tmp/token"], { NEXT_CODER_STAGING_ACCESS_TOKEN: TOKEN }),
    (error) => error.code === "one_access_token_source_required",
  );
  assert.throws(
    () => parseArguments(["--access-token", TOKEN], {}),
    (error) => error.code === "unknown_option",
  );
  assert.throws(
    () => parseArguments(["--prompt", PROMPT], {}),
    (error) => error.code === "unknown_option",
  );
  assert.throws(
    () => parseArguments(["--prompt-file", "/tmp/prompt"], { NEXT_CODER_STAGING_PROMPT: PROMPT }),
    (error) => error.code === "one_prompt_source_required",
  );
});

function fullInput(baseUrl) {
  return {
    baseUrl,
    allowHttpLoopback: true,
    accessToken: TOKEN,
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    providerInstance: PROVIDER,
    model: MODEL,
    prompt: PROMPT,
    exerciseFirstCommand: true,
    pollIntervalMs: 100,
    commandTimeoutMs: 5_000,
  };
}

function fixtureHandler({
  onLaunch = () => {},
  commandStatus = () => "completed",
  commandResult = null,
  providerUsable = true,
} = {}) {
  return async (request, response) => {
    const path = new URL(request.url, "http://fixture").pathname;
    if (path === "/health") return sendJson(response, 200, healthyCloud());
    if (path === "/v1/auth/config") return sendJson(response, 200, cloudAuthConfig());
    if (PRIVATE_PATHS.has(path)) return sendJson(response, 404, { error: "not_found" });
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      return sendJson(response, 401, { error: "private token detail must not enter evidence" });
    }
    if (path === "/v1/connectors") {
      return sendJson(response, 200, {
        connectors: [{
          id: "connector_private_id",
          environmentId: ENVIRONMENT_ID,
          status: "online",
          protocolVersion: 1,
          lastT3Health: "ready",
          lastSeenAt: new Date().toISOString(),
          lastT3HealthAt: new Date().toISOString(),
          revokedAt: null,
        }],
      });
    }
    if (path === "/v1/t3/environments") {
      return sendJson(response, 200, {
        environments: [{
          id: ENVIRONMENT_ID,
          connectorId: "connector_private_id",
          transportMode: "connector",
          status: "reachable",
          archivedAt: null,
        }],
      });
    }
    if (path === `/v1/t3/environments/${ENVIRONMENT_ID}/snapshot`) {
      return sendJson(response, 200, {
        environment: {
          id: ENVIRONMENT_ID,
          transportMode: "connector",
          status: "reachable",
          health: { lastReachableAt: new Date().toISOString() },
        },
        snapshot: {
          projects: [{ id: PROJECT_ID, defaultModelSelection: { instanceId: PROVIDER, model: MODEL } }],
          threads: [],
        },
      });
    }
    if (path === `/v1/t3/environments/${ENVIRONMENT_ID}/harnesses`) {
      return sendJson(response, 200, {
        usable: providerUsable ? [PROVIDER] : [],
        harnesses: [{ instanceId: PROVIDER, available: true, models: [{ slug: MODEL }] }],
      });
    }
    if (path === `/v1/t3/environments/${ENVIRONMENT_ID}/threads` && request.method === "POST") {
      const body = await readJson(request);
      onLaunch(body);
      return sendJson(response, 202, {
        threadId: "thread_private_id",
        command: { id: "command_private_id", status: "dispatched" },
        privateProviderOutput: "never emit this",
      });
    }
    if (path === "/v1/commands") {
      return sendJson(response, 200, {
        commands: [{
          id: "command_private_id",
          environmentId: ENVIRONMENT_ID,
          threadId: "thread_private_id",
          status: commandStatus(),
          normalized: {
            type: "thread.launch",
            createThread: { projectId: PROJECT_ID },
            startTurn: { modelSelection: { instanceId: PROVIDER, model: MODEL } },
          },
          result: commandResult,
        }],
      });
    }
    return sendJson(response, 404, { error: "not_found", detail: "private missing route detail" });
  };
}

function cloudAuthConfig() {
  return {
    authProvider: "clerk",
    deploymentMode: "cloud",
    developmentTokens: { enabled: false },
  };
}

function healthyCloud() {
  return {
    ok: true,
    runtime: "cloudflare-workers",
    environment: "staging",
    connectorAuth: "control-plane",
    eventSinkConfigured: true,
    backgroundQueueConfigured: true,
    backgroundQuarantineConfigured: true,
    backgroundDeadLetterPolicy: "redacted-envelope-plus-broker-dlq",
    backgroundOwnershipHealthy: true,
    scheduledOwnership: "cloudflare-queue",
    sameOriginControlPlaneBound: true,
    controlPlaneAdapterIntegrated: true,
  };
}

const PRIVATE_PATHS = new Set([
  "/v1/internal/connectors/tickets/consume",
  "/v1/internal/connector-events",
  "/v1/internal/background/run",
  "/internal/environments/qualification-probe/connector/status",
  "/__dev/tickets",
]);

async function startFixture(t, handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "fixture_failed" });
      else response.destroy();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function assertRedacted(evidence) {
  const serialized = JSON.stringify(evidence);
  for (const privateValue of [TOKEN, ENVIRONMENT_ID, PROJECT_ID, PROVIDER, MODEL, PROMPT, "never emit this"]) {
    assert.equal(serialized.includes(privateValue), false, `evidence leaked ${privateValue}`);
  }
}
