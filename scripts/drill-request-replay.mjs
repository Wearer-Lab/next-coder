#!/usr/bin/env node

// Phase 4.3 — durable agent-request replay drill.
//
// WHAT THIS EXERCISES
// One `status` intent is submitted with a generated `clientRequestId`. The same id with the same
// content is replayed and must return the *same* command rather than dispatching a second one; the
// same id with different content must be refused with `idempotency_conflict`; and the privacy
// minimal receipt at `GET /v1/requests/:clientRequestId` must survive both, unchanged by the
// refused retry. A final scan of `/v1/commands` proves exactly one command was created.
//
// Why `status`: it is the only mutating intent that costs no provider turn. It still travels the
// whole envelope path (claim -> policy -> connector -> T3 snapshot -> settle), so the replay
// contract is exercised against the real transport rather than a stub.
//
// WHAT THIS DOES NOT EXERCISE — see docs/staging-drills.md
// It does not evict a Durable Object, roll a deployment over mid-request, kill a client between
// dispatch and response, or exercise the device-realm or media-upload envelopes. It proves the
// server side of the contract from a cooperating client; it does not prove a client journal
// surviving a browser or firmware restart.

import { pathToFileURL } from "node:url";

import {
  ACCESS_TOKEN_FILE_OPTION,
  DrillError,
  boundedInteger,
  configurationFailureEvidence,
  createRequester,
  drillId,
  emitEvidence,
  errorDetailCode,
  finishEvidence,
  loadAccessTokenFile,
  nonEmpty,
  normalizeBaseUrl,
  oneOf,
  opaqueRef,
  parseDrillArguments,
  requireArray,
  requireCondition,
  requireIdentifier,
  requireRecord,
  requireStatus,
  runCheck,
  skipped,
} from "./drill-common.mjs";

const DRILL = "request-replay";

const MUTATING_CHECKS = [
  "first_request_accepted",
  "identical_replay_returns_same_command",
  "receipt_persisted",
  "conflicting_fingerprint_refused",
  "receipt_unchanged_by_conflict",
  "exactly_one_command_created",
];

export async function runRequestReplayDrill(input, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const now = dependencies.now ?? (() => Date.now());
  const newId = dependencies.newId ?? (() => drillId("drill-replay"));
  const startedAtMs = now();
  const checks = [];
  let configuration;

  try {
    configuration = normalizeConfiguration(input);
    checks.push({
      name: "configuration",
      status: "passed",
      durationMs: 0,
      mode: configuration.exercise ? "exercise" : "preflight",
      environmentRef: opaqueRef(configuration.environmentId),
    });
  } catch (error) {
    return finishEvidence({
      drill: DRILL,
      mode: "preflight",
      checks: [{ name: "configuration", status: "failed", durationMs: 0, code: error instanceof DrillError ? error.code : "invalid_configuration" }],
      startedAtMs,
      now,
      target: null,
    });
  }

  const mode = configuration.exercise ? "exercise" : "preflight";
  const { request } = createRequester({
    baseUrl: configuration.baseUrl,
    fetchImpl,
    requestTimeoutMs: configuration.requestTimeoutMs,
  });
  const owner = { authorization: `Bearer ${configuration.accessToken}` };
  const finish = () => finishEvidence({ drill: DRILL, mode, checks, startedAtMs, now, target: configuration.baseUrl.origin });

  const deploymentReady = await runCheck(checks, "deployment_mode", now, async () => {
    const response = await request("/v1/auth/config");
    requireStatus(response, 200, "auth_config_unavailable");
    const body = requireRecord(response.body, "invalid_auth_config_contract");
    requireCondition(body.deploymentMode === configuration.expectedDeploymentMode, "unexpected_deployment_mode");
    return { httpStatus: response.status, deploymentMode: configuration.expectedDeploymentMode };
  });

  const environmentReady = await runCheck(checks, "environment_ready", now, async () => {
    const response = await request("/v1/t3/environments", { headers: owner });
    requireStatus(response, 200, "environment_list_failed");
    const environments = requireArray(response.body?.environments, "invalid_environment_list_contract");
    const environment = environments.find((candidate) => candidate?.id === configuration.environmentId);
    requireCondition(Boolean(environment), "drill_environment_not_found");
    requireCondition(!environment.archivedAt, "drill_environment_archived");
    return {
      environmentRef: opaqueRef(configuration.environmentId),
      transportMode: typeof environment.transportMode === "string" ? environment.transportMode : null,
    };
  });

  if (!configuration.exercise) {
    for (const name of MUTATING_CHECKS) checks.push(skipped(name, "exercise_flag_required"));
    return finish();
  }
  if (!deploymentReady || !environmentReady) {
    for (const name of MUTATING_CHECKS) checks.push(skipped(name, "preflight_check_failed"));
    return finish();
  }

  // Generated, never operator-supplied: a re-run must never inherit an earlier run's envelope.
  const clientRequestId = requireIdentifier(newId(), "invalid_client_request_id");
  const submittedAt = new Date(now()).toISOString();
  const payload = {
    environmentId: configuration.environmentId,
    clientRequestId,
    intent: { type: "status" },
  };
  const state = { commandId: null, commandStatus: null, receipt: null };

  const submit = async (body) => await request("/v1/intents", { method: "POST", headers: owner, body });
  const readReceipt = async () => await request(`/v1/requests/${encodeURIComponent(clientRequestId)}`, { headers: owner });

  const accepted = await runCheck(checks, "first_request_accepted", now, async () => {
    const response = await submit(payload);
    requireStatus(response, [200, 202], "initial_request_rejected");
    const command = requireRecord(response.body?.command, "invalid_intent_contract");
    state.commandId = requireIdentifier(command.id, "invalid_intent_contract");
    state.commandStatus = typeof command.status === "string" ? command.status : null;
    requireCondition(response.body?.duplicate !== true, "initial_request_reported_as_duplicate");
    requireCondition(command.environmentId === configuration.environmentId, "command_environment_mismatch");
    requireCondition(command.intent?.type === "status", "command_intent_mismatch");
    return {
      httpStatus: response.status,
      commandRef: opaqueRef(state.commandId),
      requestRef: opaqueRef(clientRequestId),
      commandStatus: state.commandStatus,
    };
  });

  if (!accepted) {
    for (const name of MUTATING_CHECKS.slice(1)) checks.push(skipped(name, "initial_request_unavailable"));
    return finish();
  }

  await runCheck(checks, "identical_replay_returns_same_command", now, async () => {
    const response = await submit(payload);
    requireStatus(response, [200, 202], "replay_rejected");
    requireCondition(response.body?.duplicate === true, "replay_not_marked_duplicate");
    const command = requireRecord(response.body?.command, "replay_returned_no_command");
    requireCondition(command.id === state.commandId, "replay_created_second_command");
    return { httpStatus: response.status, duplicate: true, commandRef: opaqueRef(state.commandId) };
  });

  await runCheck(checks, "receipt_persisted", now, async () => {
    const response = await readReceipt();
    requireStatus(response, 200, "receipt_unavailable");
    const receipt = requireRecord(response.body?.request, "invalid_receipt_contract");
    requireCondition(receipt.clientRequestId === clientRequestId, "receipt_request_mismatch");
    requireCondition(receipt.commandId === state.commandId, "receipt_command_mismatch");
    requireCondition(Number.isInteger(receipt.httpStatus), "receipt_http_status_missing");
    // The receipt is deliberately privacy-minimal: it must never carry the request body back.
    requireCondition(receipt.intent === undefined && receipt.requestHash === undefined, "receipt_leaks_request_content");
    state.receipt = { status: receipt.status ?? null, httpStatus: receipt.httpStatus, commandId: receipt.commandId };
    return {
      httpStatus: response.status,
      requestRef: opaqueRef(clientRequestId),
      commandRef: opaqueRef(state.commandId),
      receiptStatus: state.receipt.status,
      receiptHttpStatus: state.receipt.httpStatus,
    };
  });

  await runCheck(checks, "conflicting_fingerprint_refused", now, async () => {
    // Same id, different content. The fingerprint covers the thread binding, so changing only
    // `threadId` is enough and reaches the claim before any dispatch could occur.
    const response = await submit({ ...payload, threadId: `${clientRequestId}-conflict-probe` });
    requireStatus(response, 409, "conflicting_fingerprint_accepted");
    requireCondition(errorDetailCode(response.body) === "idempotency_conflict", "conflict_code_missing");
    return { httpStatus: response.status, conflictCode: "idempotency_conflict" };
  });

  await runCheck(checks, "receipt_unchanged_by_conflict", now, async () => {
    requireCondition(Boolean(state.receipt), "receipt_baseline_missing");
    const response = await readReceipt();
    requireStatus(response, 200, "receipt_unavailable");
    const receipt = requireRecord(response.body?.request, "invalid_receipt_contract");
    requireCondition(receipt.commandId === state.receipt.commandId, "receipt_command_changed");
    requireCondition((receipt.status ?? null) === state.receipt.status, "receipt_status_changed");
    requireCondition(receipt.httpStatus === state.receipt.httpStatus, "receipt_http_status_changed");
    return { httpStatus: response.status, receiptStable: true };
  });

  await runCheck(checks, "exactly_one_command_created", now, async () => {
    const response = await request("/v1/commands", { headers: owner });
    requireStatus(response, 200, "command_list_failed");
    const commands = requireArray(response.body?.commands, "invalid_command_list_contract");
    const drillCommands = commands.filter((command) => command?.environmentId === configuration.environmentId
      && command?.intent?.type === "status"
      && typeof command?.createdAt === "string"
      && command.createdAt >= submittedAt);
    requireCondition(drillCommands.length === 1, "unexpected_command_count");
    requireCondition(drillCommands[0]?.id === state.commandId, "unexpected_command_identity");
    return { httpStatus: response.status, commandCount: 1, commandRef: opaqueRef(state.commandId) };
  });

  return finish();
}

export function normalizeConfiguration(input = {}) {
  const baseUrl = normalizeBaseUrl(input);
  const accessToken = nonEmpty(input.accessToken);
  if (!accessToken) throw new DrillError("access_token_required");
  const environmentId = nonEmpty(input.environmentId);
  if (!environmentId) throw new DrillError("environment_id_required");
  return {
    baseUrl,
    accessToken,
    environmentId,
    exercise: input.exerciseReplay === true,
    expectedDeploymentMode: oneOf(nonEmpty(input.expectedDeploymentMode) ?? "cloud", ["cloud", "self-hosted"], "expected_deployment_mode_invalid"),
    requestTimeoutMs: boundedInteger(input.requestTimeoutMs, 20_000, 1_000, 60_000, "request_timeout_invalid"),
  };
}

export function parseArguments(argv, environment = process.env) {
  return parseDrillArguments(argv, {
    environment,
    envDefaults: {
      baseUrl: "NEXT_CODER_DRILL_URL",
      accessToken: "NEXT_CODER_DRILL_ACCESS_TOKEN",
      environmentId: "NEXT_CODER_DRILL_ENVIRONMENT_ID",
      expectedDeploymentMode: "NEXT_CODER_DRILL_DEPLOYMENT_MODE",
      requestTimeoutMs: "NEXT_CODER_DRILL_REQUEST_TIMEOUT_MS",
    },
    valueOptions: {
      "--base-url": "baseUrl",
      "--environment-id": "environmentId",
      "--expected-deployment-mode": "expectedDeploymentMode",
      "--request-timeout-ms": "requestTimeoutMs",
    },
    flagOptions: {
      "--exercise-replay": "exerciseReplay",
      "--allow-http-loopback": "allowHttpLoopback",
    },
    fileOptions: ACCESS_TOKEN_FILE_OPTION,
  });
}

export function helpText() {
  return `Next Coder staging drill: durable request replay (completion plan 4.3)

Preflight (no mutation; every replay check is reported as skipped):
  NEXT_CODER_DRILL_ACCESS_TOKEN=... npm run drill:request-replay -- \\
    --base-url https://staging.example.com --environment-id env_test

Full drill (submits one status intent, replays it, and forces one idempotency conflict):
  NEXT_CODER_DRILL_ACCESS_TOKEN=... npm run drill:request-replay -- \\
    --base-url https://staging.example.com --environment-id env_test --exercise-replay

The clientRequestId is generated per run and never accepted from the command line. The platform
token comes from NEXT_CODER_DRILL_ACCESS_TOKEN or a mode-0600 --access-token-file PATH.

A status intent reaches T3 through the connector, so the environment must be reachable; the drill
spends no provider turn. See docs/staging-drills.md for what this does not prove.`;
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
  } catch (error) {
    await emitEvidence(configurationFailureEvidence({
      drill: DRILL,
      code: error instanceof DrillError ? error.code : "invalid_configuration",
    }));
    process.exitCode = 2;
    return;
  }
  const evidence = await emitEvidence(await runRequestReplayDrill(parsed));
  if (evidence.result !== "passed") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
