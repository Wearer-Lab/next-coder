import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  normalizeConfiguration,
  parseArguments,
  runRequestReplayDrill,
} from "../scripts/drill-request-replay.mjs";

const TOKEN = "drill-platform-token-never-emit";
const ENVIRONMENT_ID = "env_drill_private_id";
const CLIENT_REQUEST_ID = "drill-replay-private-request-id";

test("the replay drill refuses an unsafe target, a missing token, or a missing environment", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; };

  const missing = await runRequestReplayDrill({}, { fetchImpl });
  assert.equal(missing.checks[0].code, "base_url_required");
  assert.equal(missing.drill, "request-replay");

  const noToken = await runRequestReplayDrill({ baseUrl: "https://staging.example.test" }, { fetchImpl });
  assert.equal(noToken.checks[0].code, "access_token_required");

  const noEnvironment = await runRequestReplayDrill(
    { baseUrl: "https://staging.example.test", accessToken: TOKEN },
    { fetchImpl },
  );
  assert.equal(noEnvironment.checks[0].code, "environment_id_required");
  assert.equal(calls, 0);

  assert.throws(
    () => normalizeConfiguration({ baseUrl: "http://staging.example.test", accessToken: TOKEN, environmentId: ENVIRONMENT_ID }),
    (error) => error.code === "https_required",
  );
});

test("a preflight run submits no intent and reports every replay check as skipped", async (t) => {
  const gateway = createGateway();
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runRequestReplayDrill(baseInput(fixture.baseUrl));

  assert.equal(evidence.mode, "preflight");
  assert.equal(evidence.result, "failed");
  assert.equal(evidence.summary.failed, 0);
  assert.equal(evidence.summary.skipped, 6);
  assert.equal(gateway.commands.length, 0);
  assert.equal(gateway.calls.some((call) => call.path === "/v1/intents"), false);
});

test("the full drill dispatches once, replays the same command, and forces one idempotency conflict", async (t) => {
  const gateway = createGateway();
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runRequestReplayDrill(
    { ...baseInput(fixture.baseUrl), exerciseReplay: true },
    { newId: () => CLIENT_REQUEST_ID },
  );

  assert.equal(evidence.mode, "exercise");
  assert.equal(evidence.result, "passed");
  assert.equal(evidence.summary.skipped, 0);
  assert.deepEqual(evidence.checks.map((check) => check.name), [
    "configuration",
    "deployment_mode",
    "environment_ready",
    "first_request_accepted",
    "identical_replay_returns_same_command",
    "receipt_persisted",
    "conflicting_fingerprint_refused",
    "receipt_unchanged_by_conflict",
    "exactly_one_command_created",
  ]);

  // The whole point: three POSTs to /v1/intents, one command.
  assert.equal(gateway.calls.filter((call) => call.path === "/v1/intents").length, 3);
  assert.equal(gateway.commands.length, 1);
  const conflict = evidence.checks.find((check) => check.name === "conflicting_fingerprint_refused");
  assert.equal(conflict.status, "passed");
  assert.equal(conflict.httpStatus, 409);
  assert.equal(conflict.conflictCode, "idempotency_conflict");
  assert.equal(evidence.checks.find((check) => check.name === "exactly_one_command_created").commandCount, 1);
  assertRedacted(evidence, gateway);
});

test("a gateway that dispatches a second command for the same id fails the replay check", async (t) => {
  const gateway = createGateway({ replayDispatchesAgain: true });
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runRequestReplayDrill(
    { ...baseInput(fixture.baseUrl), exerciseReplay: true },
    { newId: () => CLIENT_REQUEST_ID },
  );

  assert.equal(evidence.result, "failed");
  assert.equal(
    evidence.checks.find((check) => check.name === "identical_replay_returns_same_command").code,
    "replay_not_marked_duplicate",
  );
  assert.equal(
    evidence.checks.find((check) => check.name === "exactly_one_command_created").code,
    "unexpected_command_count",
  );
  assert.equal(gateway.commands.length, 2);
});

test("a gateway that accepts a conflicting fingerprint under the same id fails closed", async (t) => {
  const gateway = createGateway({ acceptConflictingFingerprint: true });
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runRequestReplayDrill(
    { ...baseInput(fixture.baseUrl), exerciseReplay: true },
    { newId: () => CLIENT_REQUEST_ID },
  );

  assert.equal(evidence.result, "failed");
  const conflict = evidence.checks.find((check) => check.name === "conflicting_fingerprint_refused");
  assert.equal(conflict.code, "conflicting_fingerprint_accepted");
  assert.equal(conflict.httpStatus, 202);
});

test("a 409 without the idempotency_conflict code is not accepted as proof", async (t) => {
  const gateway = createGateway({ conflictWithoutCode: true });
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runRequestReplayDrill(
    { ...baseInput(fixture.baseUrl), exerciseReplay: true },
    { newId: () => CLIENT_REQUEST_ID },
  );

  assert.equal(evidence.result, "failed");
  assert.equal(
    evidence.checks.find((check) => check.name === "conflicting_fingerprint_refused").code,
    "conflict_code_missing",
  );
});

test("a receipt rewritten by the refused retry fails the drill", async (t) => {
  const gateway = createGateway({ conflictRewritesReceipt: true });
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runRequestReplayDrill(
    { ...baseInput(fixture.baseUrl), exerciseReplay: true },
    { newId: () => CLIENT_REQUEST_ID },
  );

  assert.equal(evidence.result, "failed");
  assert.equal(
    evidence.checks.find((check) => check.name === "receipt_unchanged_by_conflict").code,
    "receipt_command_changed",
  );
});

test("a rejected first request skips the replay checks rather than inventing them", async (t) => {
  const gateway = createGateway({ rejectFirstRequest: true });
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runRequestReplayDrill(
    { ...baseInput(fixture.baseUrl), exerciseReplay: true },
    { newId: () => CLIENT_REQUEST_ID },
  );

  assert.equal(evidence.result, "failed");
  assert.equal(evidence.checks.find((check) => check.name === "first_request_accepted").code, "initial_request_rejected");
  const skipped = evidence.checks.filter((check) => check.status === "skipped");
  assert.equal(skipped.length, 5);
  for (const check of skipped) assert.equal(check.code, "initial_request_unavailable");
});

test("replay drill arguments never accept a token or a client request id as a value", () => {
  const parsed = parseArguments([
    "--base-url", "https://staging.example.test",
    "--environment-id", ENVIRONMENT_ID,
    "--exercise-replay",
  ], { NEXT_CODER_DRILL_ACCESS_TOKEN: TOKEN });
  assert.equal(parsed.accessToken, TOKEN);
  assert.equal(parsed.environmentId, ENVIRONMENT_ID);
  assert.equal(parsed.exerciseReplay, true);

  assert.throws(() => parseArguments(["--access-token", TOKEN], {}), (error) => error.code === "unknown_option");
  assert.throws(() => parseArguments(["--client-request-id", "x"], {}), (error) => error.code === "unknown_option");
});

function baseInput(baseUrl) {
  return { baseUrl, allowHttpLoopback: true, accessToken: TOKEN, environmentId: ENVIRONMENT_ID };
}

function createGateway({
  replayDispatchesAgain = false,
  acceptConflictingFingerprint = false,
  conflictWithoutCode = false,
  conflictRewritesReceipt = false,
  rejectFirstRequest = false,
} = {}) {
  const commands = [];
  const receipts = new Map();
  const calls = [];
  let counter = 0;

  const fingerprint = (body) => JSON.stringify({
    environmentId: body.environmentId,
    threadId: body.threadId ?? null,
    intent: body.intent,
  });

  const dispatch = (body) => {
    counter += 1;
    const command = {
      id: `cmd_private_${counter}`,
      environmentId: body.environmentId,
      threadId: body.threadId ?? null,
      intent: body.intent,
      status: "completed",
      createdAt: new Date().toISOString(),
      result: { privateScreen: "compressed snapshot detail that must not enter evidence" },
    };
    commands.push(command);
    return command;
  };

  const handler = async (request, response) => {
    const url = new URL(request.url, "http://fixture");
    const path = url.pathname;
    calls.push({ method: request.method, path });

    if (path === "/v1/auth/config") {
      return sendJson(response, 200, { deploymentMode: "cloud", developmentTokens: { enabled: false } });
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      return sendJson(response, 401, { error: { message: "private token detail must not enter evidence" } });
    }
    if (path === "/v1/t3/environments") {
      return sendJson(response, 200, {
        environments: [{ id: ENVIRONMENT_ID, transportMode: "connector", status: "reachable", archivedAt: null }],
      });
    }
    if (path === "/v1/commands") {
      return sendJson(response, 200, { commands });
    }

    if (path === "/v1/intents" && request.method === "POST") {
      const body = await readJson(request);
      if (rejectFirstRequest && receipts.size === 0) {
        return sendJson(response, 502, { error: { message: "private upstream failure detail" } });
      }
      const existing = receipts.get(body.clientRequestId);
      if (!existing) {
        const command = dispatch(body);
        receipts.set(body.clientRequestId, {
          clientRequestId: body.clientRequestId,
          hash: fingerprint(body),
          commandId: command.id,
          status: command.status,
          httpStatus: 202,
        });
        return sendJson(response, 202, { command });
      }
      if (existing.hash !== fingerprint(body)) {
        if (acceptConflictingFingerprint) {
          const command = dispatch(body);
          return sendJson(response, 202, { command });
        }
        if (conflictRewritesReceipt) {
          const command = dispatch(body);
          existing.commandId = command.id;
        }
        return sendJson(response, 409, {
          error: {
            message: "clientRequestId was already used for a different agent request.",
            details: conflictWithoutCode ? { request: publicReceipt(existing) } : {
              code: "idempotency_conflict",
              request: publicReceipt(existing),
            },
          },
        });
      }
      if (replayDispatchesAgain) {
        const command = dispatch(body);
        return sendJson(response, 202, { command });
      }
      return sendJson(response, 202, {
        command: commands.find((entry) => entry.id === existing.commandId),
        request: publicReceipt(existing),
        duplicate: true,
      });
    }

    const receiptMatch = path.match(/^\/v1\/requests\/([^/]+)$/u);
    if (receiptMatch && request.method === "GET") {
      const receipt = receipts.get(decodeURIComponent(receiptMatch[1]));
      if (!receipt) return sendJson(response, 404, { error: { message: "not found" } });
      return sendJson(response, 200, {
        request: publicReceipt(receipt),
        command: commands.find((entry) => entry.id === receipt.commandId),
      });
    }

    return sendJson(response, 404, { error: { message: "private missing route detail" } });
  };

  return { handler, calls, commands, receipts };
}

function publicReceipt(receipt) {
  const { hash, ...rest } = receipt;
  return rest;
}

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
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function assertRedacted(evidence, gateway) {
  const serialized = JSON.stringify(evidence);
  const secrets = [TOKEN, ENVIRONMENT_ID, CLIENT_REQUEST_ID, "compressed snapshot detail", "private missing route detail"];
  for (const command of gateway.commands) secrets.push(command.id);
  for (const value of secrets) {
    assert.equal(serialized.includes(value), false, `drill evidence leaked ${value}`);
  }
}
