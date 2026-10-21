#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

import { readEnv } from "./environment.mjs";

const EVIDENCE_SCHEMA = "next-coder.staging-qualification.v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_STALENESS_MS = 120_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PRIVATE_PROBES = [
  {
    name: "private_ticket_consumer_hidden",
    method: "POST",
    path: "/v1/internal/connectors/tickets/consume",
    body: { ticket: "qualification-probe", audience: "qualification-probe", now: 0 },
  },
  {
    name: "private_connector_events_hidden",
    method: "POST",
    path: "/v1/internal/connector-events",
    body: { events: [] },
  },
  {
    name: "private_background_runner_hidden",
    method: "POST",
    path: "/v1/internal/background/run",
    body: { tasks: [] },
  },
  {
    name: "local_router_hidden",
    method: "GET",
    path: "/internal/environments/qualification-probe/connector/status",
  },
  {
    name: "development_ticket_issuer_hidden",
    method: "POST",
    path: "/__dev/tickets",
    body: { connectorId: "qualification-probe", environmentId: "qualification-probe" },
  },
];

export async function runStagingQualification(input, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const now = dependencies.now ?? (() => Date.now());
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const startedAtMs = now();
  const checks = [];
  let configuration;

  try {
    configuration = normalizeConfiguration(input);
    checks.push(passed("configuration", 0, {
      mode: configuration.exerciseFirstCommand ? "first-command" : configuration.accessToken ? "authenticated-readiness" : "boundary-only",
      expectedEnvironment: configuration.expectedEnvironment,
    }));
  } catch (error) {
    checks.push(failed("configuration", 0, safeErrorCode(error, "invalid_configuration")));
    return finishEvidence({ checks, startedAtMs, now, target: null });
  }

  const request = createRequester({
    baseUrl: configuration.baseUrl,
    fetchImpl,
    requestTimeoutMs: configuration.requestTimeoutMs,
  });

  await runCheck(checks, "public_cloud_health", now, async () => {
    const response = await request("/health");
    requireStatus(response, 200, "health_unavailable");
    const health = requireRecord(response.body, "invalid_health_contract");
    requireCondition(health.ok === true, "health_not_ready");
    requireCondition(health.runtime === "cloudflare-workers", "unexpected_runtime");
    requireCondition(health.environment === configuration.expectedEnvironment, "unexpected_deployment_environment");
    requireCondition(health.connectorAuth === "control-plane", "connector_auth_not_production");
    requireCondition(health.sameOriginControlPlaneBound === true, "control_plane_not_bound");
    requireCondition(health.controlPlaneAdapterIntegrated === true, "control_plane_not_integrated");
    requireCondition(health.eventSinkConfigured === true, "connector_event_sink_not_configured");
    requireCondition(health.backgroundQueueConfigured === true, "background_queue_not_configured");
    requireCondition(health.backgroundQuarantineConfigured === true, "background_quarantine_not_configured");
    requireCondition(health.backgroundDeadLetterPolicy === "redacted-envelope-plus-broker-dlq", "background_dead_letter_policy_not_ready");
    requireCondition(health.backgroundOwnershipHealthy === true, "background_ownership_not_ready");
    requireCondition(health.scheduledOwnership === "cloudflare-queue", "scheduled_ownership_not_cloud");
    return {
      httpStatus: response.status,
      runtime: "cloudflare-workers",
      environment: configuration.expectedEnvironment,
      backgroundOwnership: "cloudflare-queue",
      deadLetterPolicy: "redacted-envelope-plus-broker-dlq",
    };
  });

  await runCheck(checks, "public_control_plane_reachable", now, async () => {
    const response = await request("/v1/auth/config");
    requireStatus(response, 200, "control_plane_unavailable");
    const body = requireRecord(response.body, "invalid_auth_config_contract");
    requireCondition(body.deploymentMode === "cloud", "gateway_not_in_cloud_mode");
    requireCondition(body.developmentTokens?.enabled === false, "development_token_state_unverified");
    return { httpStatus: response.status, deploymentMode: "cloud", developmentTokens: "disabled" };
  });

  for (const probe of PRIVATE_PROBES) {
    await runCheck(checks, probe.name, now, async () => {
      const response = await request(probe.path, { method: probe.method, body: probe.body });
      requireStatus(response, 404, "private_route_publicly_reachable");
      return { httpStatus: response.status };
    });
  }

  const boundaryReady = checks.every((check) => check.status === "passed");
  if (!configuration.accessToken) {
    return finishEvidence({ checks, startedAtMs, now, target: configuration.baseUrl.origin });
  }
  if (!boundaryReady) {
    checks.push(skipped("connector_first_readiness", "boundary_check_failed"));
    checks.push(skipped("environment_snapshot", "boundary_check_failed"));
    if (configuration.exerciseFirstCommand) checks.push(skipped("first_command_completed", "boundary_check_failed"));
    return finishEvidence({ checks, startedAtMs, now, target: configuration.baseUrl.origin });
  }

  const headers = { authorization: `Bearer ${configuration.accessToken}` };
  await runCheck(checks, "connector_first_readiness", now, async () => {
    const [connectorResponse, environmentResponse] = await Promise.all([
      request("/v1/connectors", { headers }),
      request("/v1/t3/environments", { headers }),
    ]);
    requireStatus(connectorResponse, 200, "connector_list_failed");
    requireStatus(environmentResponse, 200, "environment_list_failed");
    const connectors = requireArray(connectorResponse.body?.connectors, "invalid_connector_list_contract");
    const environments = requireArray(environmentResponse.body?.environments, "invalid_environment_list_contract");
    const environment = environments.find((candidate) => candidate?.id === configuration.environmentId);
    requireCondition(Boolean(environment), "test_environment_not_found");
    requireCondition(environment.transportMode === "connector", "environment_not_connector_backed");
    requireCondition(!environment.archivedAt, "test_environment_archived");
    const connector = connectors.find((candidate) => candidate?.environmentId === configuration.environmentId
      && !candidate?.revokedAt
      && (environment.connectorId == null || candidate?.id === environment.connectorId));
    requireCondition(Boolean(connector), "active_connector_not_found");
    requireCondition(connector.status === "online", "connector_not_online");
    requireCondition(connector.protocolVersion === 1, "connector_protocol_incompatible");
    requireCondition(connector.lastT3Health === "ready", "connector_t3_not_ready");
    requireFresh(connector.lastSeenAt, configuration.maxStalenessMs, now(), "connector_presence_stale");
    requireFresh(connector.lastT3HealthAt, configuration.maxStalenessMs, now(), "connector_t3_health_stale");
    return {
      connectorRef: opaqueRef(connector.id),
      environmentRef: opaqueRef(configuration.environmentId),
      connectorStatus: "online",
      t3Status: "ready",
      protocolVersion: 1,
    };
  });

  await runCheck(checks, "environment_snapshot", now, async () => {
    const response = await request(`/v1/t3/environments/${encodeURIComponent(configuration.environmentId)}/snapshot`, { headers });
    requireStatus(response, 200, "environment_snapshot_failed");
    const body = requireRecord(response.body, "invalid_snapshot_contract");
    const snapshot = requireRecord(body.snapshot, "invalid_snapshot_contract");
    const projects = requireArray(snapshot.projects, "invalid_snapshot_contract");
    requireArray(snapshot.threads, "invalid_snapshot_contract");
    requireCondition(body.environment?.transportMode === "connector", "snapshot_not_connector_backed");
    requireCondition(body.environment?.status === "reachable", "environment_not_reachable");
    requireFresh(body.environment?.health?.lastReachableAt, configuration.maxStalenessMs, now(), "environment_reachability_stale");
    if (configuration.projectId) {
      requireCondition(projects.some((project) => project?.id === configuration.projectId), "test_project_not_found");
    }
    return {
      environmentRef: opaqueRef(configuration.environmentId),
      projectCount: projects.length,
      threadCount: snapshot.threads.length,
      transportMode: "connector",
      environmentStatus: "reachable",
    };
  });

  if (configuration.providerInstance && configuration.model) {
    await runCheck(checks, "provider_model_ready", now, async () => {
      const response = await request(`/v1/t3/environments/${encodeURIComponent(configuration.environmentId)}/harnesses`, { headers });
      requireStatus(response, 200, "provider_catalogue_failed");
      const harnesses = requireArray(response.body?.harnesses, "invalid_provider_catalogue_contract");
      const usable = requireArray(response.body?.usable, "invalid_provider_catalogue_contract");
      const harness = harnesses.find((candidate) => candidate?.instanceId === configuration.providerInstance);
      requireCondition(Boolean(harness), "test_provider_not_found");
      requireCondition(usable.includes(configuration.providerInstance), "test_provider_not_ready");
      const models = requireArray(harness.models, "invalid_provider_catalogue_contract");
      requireCondition(models.some((candidate) => (candidate?.slug ?? candidate?.model ?? candidate) === configuration.model), "test_model_not_found");
      return {
        providerRef: opaqueRef(configuration.providerInstance),
        modelRef: opaqueRef(configuration.model),
        providerStatus: "ready",
      };
    });
  }

  const readinessPassed = checks.every((check) => check.status === "passed");
  if (!configuration.exerciseFirstCommand) {
    return finishEvidence({ checks, startedAtMs, now, target: configuration.baseUrl.origin });
  }
  if (!readinessPassed) {
    checks.push(skipped("first_command_completed", "readiness_check_failed"));
    return finishEvidence({ checks, startedAtMs, now, target: configuration.baseUrl.origin });
  }

  await runCheck(checks, "first_command_completed", now, async () => {
    const launch = await request(
      `/v1/t3/environments/${encodeURIComponent(configuration.environmentId)}/threads`,
      {
        method: "POST",
        headers,
        body: {
          projectId: configuration.projectId,
          text: configuration.prompt,
          modelSelection: {
            instanceId: configuration.providerInstance,
            model: configuration.model,
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
      },
    );
    requireStatus(launch, 202, "first_command_launch_failed");
    const commandId = requireIdentifier(launch.body?.command?.id, "invalid_launch_contract");
    const threadId = requireIdentifier(launch.body?.threadId, "invalid_launch_contract");
    requireCondition(launch.body?.command?.status === "dispatched", "launch_not_dispatched");
    const deadline = now() + configuration.commandTimeoutMs;
    let pollCount = 0;
    while (now() <= deadline) {
      pollCount += 1;
      const response = await request("/v1/commands", { headers });
      requireStatus(response, 200, "command_poll_failed");
      const commands = requireArray(response.body?.commands, "invalid_command_list_contract");
      const command = commands.find((candidate) => candidate?.id === commandId);
      requireCondition(Boolean(command), "launched_command_not_found");
      if (command.status === "completed") {
        requireCondition(command.environmentId === configuration.environmentId, "completed_command_target_mismatch");
        requireCondition(command.threadId === threadId, "completed_command_thread_mismatch");
        requireCondition(command.normalized?.type === "thread.launch", "completed_command_type_mismatch");
        requireCondition(command.normalized?.createThread?.projectId === configuration.projectId, "completed_command_project_mismatch");
        requireCondition(command.normalized?.startTurn?.modelSelection?.instanceId === configuration.providerInstance, "completed_command_provider_mismatch");
        requireCondition(command.normalized?.startTurn?.modelSelection?.model === configuration.model, "completed_command_model_mismatch");
        return {
          commandRef: opaqueRef(commandId),
          threadRef: opaqueRef(threadId),
          status: "completed",
          pollCount,
        };
      }
      if (["failed", "rejected", "cancelled", "expired"].includes(command.status)) {
        throw new QualificationError("first_command_terminal_failure");
      }
      await sleep(Math.min(configuration.pollIntervalMs, Math.max(0, deadline - now())));
    }
    throw new QualificationError("first_command_timeout");
  });

  return finishEvidence({ checks, startedAtMs, now, target: configuration.baseUrl.origin });
}

export function normalizeConfiguration(input = {}) {
  const rawBaseUrl = nonEmpty(input.baseUrl);
  if (!rawBaseUrl) throw new QualificationError("base_url_required");
  let baseUrl;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new QualificationError("base_url_invalid");
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || (baseUrl.pathname !== "/" && baseUrl.pathname !== "")) {
    throw new QualificationError("base_url_must_be_origin");
  }
  const loopback = isLoopback(baseUrl.hostname);
  if (baseUrl.protocol !== "https:" && !(input.allowHttpLoopback === true && loopback && baseUrl.protocol === "http:")) {
    throw new QualificationError("https_required");
  }
  if (!loopback && isIP(baseUrl.hostname)) throw new QualificationError("hostname_required");

  const exerciseFirstCommand = input.exerciseFirstCommand === true;
  const accessToken = nonEmpty(input.accessToken);
  const environmentId = nonEmpty(input.environmentId);
  const projectId = nonEmpty(input.projectId);
  const providerInstance = nonEmpty(input.providerInstance);
  const model = nonEmpty(input.model);
  const prompt = nonEmpty(input.prompt);
  if ((accessToken && !environmentId) || (!accessToken && environmentId)) {
    throw new QualificationError("auth_and_environment_required_together");
  }
  if (!accessToken && [projectId, providerInstance, model, prompt].some(Boolean)) {
    throw new QualificationError("test_resources_require_auth");
  }
  if (exerciseFirstCommand && ![accessToken, environmentId, projectId, providerInstance, model, prompt].every(Boolean)) {
    throw new QualificationError("first_command_inputs_required");
  }
  if (prompt && prompt.length > 512) throw new QualificationError("prompt_too_long");
  if ((providerInstance && !model) || (!providerInstance && model)) {
    throw new QualificationError("provider_and_model_required_together");
  }

  return {
    baseUrl,
    expectedEnvironment: oneOf(input.expectedEnvironment ?? "staging", ["staging", "production"], "expected_environment_invalid"),
    accessToken,
    environmentId,
    projectId,
    providerInstance,
    model,
    prompt,
    exerciseFirstCommand,
    requestTimeoutMs: boundedInteger(input.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1_000, 60_000, "request_timeout_invalid"),
    commandTimeoutMs: boundedInteger(input.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 5_000, 600_000, "command_timeout_invalid"),
    pollIntervalMs: boundedInteger(input.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 100, 10_000, "poll_interval_invalid"),
    maxStalenessMs: boundedInteger(input.maxStalenessMs, DEFAULT_MAX_STALENESS_MS, 5_000, 900_000, "max_staleness_invalid"),
  };
}

export function parseArguments(argv, environment = process.env) {
  const parsed = {
    baseUrl: readEnv(environment, "NEXT_CODER_STAGING_URL"),
    accessToken: readEnv(environment, "NEXT_CODER_STAGING_ACCESS_TOKEN"),
    environmentId: readEnv(environment, "NEXT_CODER_STAGING_ENVIRONMENT_ID"),
    projectId: readEnv(environment, "NEXT_CODER_STAGING_PROJECT_ID"),
    providerInstance: readEnv(environment, "NEXT_CODER_STAGING_PROVIDER_INSTANCE"),
    model: readEnv(environment, "NEXT_CODER_STAGING_MODEL"),
    prompt: readEnv(environment, "NEXT_CODER_STAGING_PROMPT"),
    expectedEnvironment: readEnv(environment, "NEXT_CODER_STAGING_EXPECTED_ENVIRONMENT"),
    requestTimeoutMs: readEnv(environment, "NEXT_CODER_STAGING_REQUEST_TIMEOUT_MS"),
    commandTimeoutMs: readEnv(environment, "NEXT_CODER_STAGING_COMMAND_TIMEOUT_MS"),
    pollIntervalMs: readEnv(environment, "NEXT_CODER_STAGING_POLL_INTERVAL_MS"),
    maxStalenessMs: readEnv(environment, "NEXT_CODER_STAGING_MAX_STALENESS_MS"),
    exerciseFirstCommand: false,
    allowHttpLoopback: false,
  };
  const valueOptions = new Map([
    ["--base-url", "baseUrl"],
    ["--environment-id", "environmentId"],
    ["--project-id", "projectId"],
    ["--provider-instance", "providerInstance"],
    ["--model", "model"],
    ["--expected-environment", "expectedEnvironment"],
    ["--request-timeout-ms", "requestTimeoutMs"],
    ["--command-timeout-ms", "commandTimeoutMs"],
    ["--poll-interval-ms", "pollIntervalMs"],
    ["--max-staleness-ms", "maxStalenessMs"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--exercise-first-command") {
      parsed.exerciseFirstCommand = true;
      continue;
    }
    if (argument === "--allow-http-loopback") {
      parsed.allowHttpLoopback = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--access-token-file") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new QualificationError("option_value_required");
      parsed.accessTokenFile = value;
      index += 1;
      continue;
    }
    if (argument === "--prompt-file") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new QualificationError("option_value_required");
      parsed.promptFile = value;
      index += 1;
      continue;
    }
    const key = valueOptions.get(argument);
    if (!key) throw new QualificationError("unknown_option");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new QualificationError("option_value_required");
    parsed[key] = value;
    index += 1;
  }
  if (parsed.accessToken && parsed.accessTokenFile) throw new QualificationError("one_access_token_source_required");
  if (parsed.prompt && parsed.promptFile) throw new QualificationError("one_prompt_source_required");
  return parsed;
}

async function loadAccessTokenFile(path) {
  return await loadPrivateTextFile(path, {
    emptyCode: "access_token_file_empty",
    notFileCode: "access_token_path_not_file",
    permissionsCode: "access_token_file_permissions_unsafe",
    tooLargeCode: "access_token_file_too_large",
    maxBytes: 16 * 1024,
  });
}

async function loadPromptFile(path) {
  return await loadPrivateTextFile(path, {
    emptyCode: "prompt_file_empty",
    notFileCode: "prompt_path_not_file",
    permissionsCode: "prompt_file_permissions_unsafe",
    tooLargeCode: "prompt_file_too_large",
    maxBytes: 4 * 1024,
  });
}

async function loadPrivateTextFile(path, {
  emptyCode,
  notFileCode,
  permissionsCode,
  tooLargeCode,
  maxBytes,
}) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new QualificationError(notFileCode);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new QualificationError(permissionsCode);
  }
  const content = await readFile(path, { encoding: "utf8" });
  if (Buffer.byteLength(content) > maxBytes) throw new QualificationError(tooLargeCode);
  const value = content.trim();
  if (!value) throw new QualificationError(emptyCode);
  return value;
}

function createRequester({ baseUrl, fetchImpl, requestTimeoutMs }) {
  return async (path, { method = "GET", headers = {}, body } = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(new URL(path, baseUrl), {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      });
      return { status: response.status, body: await readJsonBounded(response) };
    } catch (error) {
      if (error instanceof QualificationError) throw error;
      if (controller.signal.aborted) throw new QualificationError("request_timeout");
      throw new QualificationError("request_failed");
    } finally {
      clearTimeout(timeout);
    }
  };
}

async function readJsonBounded(response) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new QualificationError("response_too_large");
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new QualificationError("response_too_large");
    }
    chunks.push(value);
  }
  if (size === 0) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new QualificationError("invalid_json_response");
  }
}

async function runCheck(checks, name, now, operation) {
  const started = now();
  try {
    const detail = await operation();
    checks.push(passed(name, Math.max(0, now() - started), detail));
  } catch (error) {
    checks.push(failed(name, Math.max(0, now() - started), safeErrorCode(error, "check_failed"), safeHttpStatus(error)));
  }
}

function finishEvidence({ checks, startedAtMs, now, target }) {
  const finishedAtMs = now();
  const passedCount = checks.filter((check) => check.status === "passed").length;
  const failedCount = checks.filter((check) => check.status === "failed").length;
  const skippedCount = checks.filter((check) => check.status === "skipped").length;
  return {
    schema: EVIDENCE_SCHEMA,
    result: failedCount === 0 && skippedCount === 0 ? "passed" : "failed",
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    target: target ? { origin: target } : null,
    summary: { passed: passedCount, failed: failedCount, skipped: skippedCount },
    checks,
  };
}

function passed(name, durationMs, detail = {}) {
  return { name, status: "passed", durationMs, ...detail };
}

function failed(name, durationMs, code, httpStatus) {
  return { name, status: "failed", durationMs, code, ...(httpStatus ? { httpStatus } : {}) };
}

function skipped(name, code) {
  return { name, status: "skipped", durationMs: 0, code };
}

function requireStatus(response, status, code) {
  if (response.status !== status) throw new QualificationError(code, response.status);
}

function requireCondition(condition, code) {
  if (!condition) throw new QualificationError(code);
}

function requireRecord(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new QualificationError(code);
  return value;
}

function requireArray(value, code) {
  if (!Array.isArray(value)) throw new QualificationError(code);
  return value;
}

function requireIdentifier(value, code) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new QualificationError(code);
  return value;
}

function requireFresh(value, maxAgeMs, currentTime, code) {
  const observedAt = Date.parse(value ?? "");
  if (!Number.isFinite(observedAt) || observedAt > currentTime + 30_000 || currentTime - observedAt > maxAgeMs) {
    throw new QualificationError(code);
  }
}

function opaqueRef(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex").slice(0, 16)}`;
}

function safeErrorCode(error, fallback) {
  return error instanceof QualificationError ? error.code : fallback;
}

function safeHttpStatus(error) {
  return error instanceof QualificationError && Number.isInteger(error.httpStatus) ? error.httpStatus : null;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function oneOf(value, allowed, code) {
  if (!allowed.includes(value)) throw new QualificationError(code);
  return value;
}

function boundedInteger(value, fallback, minimum, maximum, code) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new QualificationError(code);
  return parsed;
}

function isLoopback(hostname) {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

class QualificationError extends Error {
  constructor(code, httpStatus = null) {
    super(code);
    this.name = "QualificationError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function helpText() {
  return `Next Coder staging qualification

Credential-free boundary check:
  npm run qualify:staging -- --base-url https://staging.example.com

Authenticated connector-first readiness (token via environment):
  NEXT_CODER_STAGING_ACCESS_TOKEN=... NEXT_CODER_STAGING_PROMPT=... npm run qualify:staging -- \\
    --base-url https://staging.example.com --environment-id env_test

Opt-in first-command proof (creates one test thread):
  NEXT_CODER_STAGING_ACCESS_TOKEN=... npm run qualify:staging -- \\
    --base-url https://staging.example.com --environment-id env_test \\
    --project-id project_test --provider-instance codex --model model_test \\
    --exercise-first-command

The token and prompt may instead be supplied from mode-0600 files with --access-token-file PATH and
--prompt-file PATH. Neither has a command-line value option. Tokens, prompts, resource IDs,
provider output, and server error bodies are never emitted. HTTPS is mandatory; the
--allow-http-loopback option exists only for hermetic local qualification tests.`;
}

async function main() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${helpText()}\n`);
      return;
    }
    if (parsed.accessTokenFile) parsed.accessToken = await loadAccessTokenFile(parsed.accessTokenFile);
    if (parsed.promptFile) parsed.prompt = await loadPromptFile(parsed.promptFile);
  } catch (error) {
    const now = Date.now();
    const evidence = finishEvidence({
      checks: [failed("configuration", 0, safeErrorCode(error, "invalid_configuration"))],
      startedAtMs: now,
      now: () => now,
      target: null,
    });
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  const evidence = await runStagingQualification(parsed);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (evidence.result !== "passed") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
