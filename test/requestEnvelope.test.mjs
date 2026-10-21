import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createFileStore } from "../src/fileStore.mjs";
import {
  COMMAND_REQUEST_OPERATION,
  commandRequestHash,
} from "../src/requestEnvelope.mjs";
import { createMemoryStore, createStore } from "../src/store.mjs";

const requestIdentity = {
  userId: "user_1",
  actorType: "user",
  actorId: "user_1",
  operation: COMMAND_REQUEST_OPERATION,
  clientRequestId: "web:request-0001",
};

test("canonical request hashes ignore object key order but bind destination and content", () => {
  const first = commandRequestHash({
    environmentId: "env_1",
    threadId: "thread_1",
    intent: { type: "agent_prompt", text: "hello", options: { b: 2, a: 1 } },
  });
  const reordered = commandRequestHash({
    environmentId: "env_1",
    threadId: "thread_1",
    intent: { options: { a: 1, b: 2 }, text: "hello", type: "agent_prompt" },
  });
  assert.equal(first, reordered);
  assert.notEqual(first, commandRequestHash({
    environmentId: "env_1",
    threadId: "thread_2",
    intent: { type: "agent_prompt", text: "hello", options: { a: 1, b: 2 } },
  }));
  assert.notEqual(first, commandRequestHash({
    environmentId: "env_1",
    threadId: "thread_1",
    intent: { type: "agent_prompt", text: "hello", options: { a: 1, b: 2 } },
    mediaUploadIds: ["media_1"],
  }));
  assert.match(first, /^[a-f0-9]{64}$/u);
});

test("memory receipts claim once, reject conflicting reuse, and expose no request content", () => {
  const store = createMemoryStore();
  const requestHash = commandRequestHash({
    environmentId: "env_1",
    threadId: "thread_1",
    intent: { type: "agent_prompt", text: "private prompt" },
  });
  const first = store.claimCommandRequest({ ...requestIdentity, requestHash });
  const duplicate = store.claimCommandRequest({ ...requestIdentity, requestHash });
  const conflict = store.claimCommandRequest({ ...requestIdentity, requestHash: "f".repeat(64) });
  assert.equal(first.claimed, true);
  assert.deepEqual(
    { claimed: duplicate.claimed, conflict: duplicate.conflict, status: duplicate.request.status },
    { claimed: false, conflict: false, status: "processing" },
  );
  assert.equal(conflict.conflict, true);
  assert.equal(JSON.stringify(store.exportState().commandRequests).includes("private prompt"), false);

  const settled = store.settleCommandRequest({
    ...requestIdentity,
    requestHash,
    status: "completed",
    commandId: null,
    httpStatus: 202,
  });
  assert.equal(settled.status, "completed");
  assert.equal(store.claimCommandRequest({ ...requestIdentity, requestHash }).request.httpStatus, 202);
});

test("receipt TTL permits safe reuse after expiry and bounded eviction removes oldest terminal rows", () => {
  let now = Date.parse("2026-08-27T12:00:00.000Z");
  const store = createStore({}, { now: () => now });
  const requestHash = "b".repeat(64);
  for (let index = 0; index <= 1000; index += 1) {
    const identity = {
      ...requestIdentity,
      clientRequestId: `web:bounded-${String(index).padStart(4, "0")}`,
      requestHash,
    };
    assert.equal(store.claimCommandRequest(identity).claimed, true);
    store.settleCommandRequest({ ...identity, status: "completed", commandId: null, httpStatus: 200 });
  }
  const bounded = store.exportState().commandRequests;
  assert.equal(bounded.length, 1000);
  assert.equal(bounded.some((request) => request.clientRequestId === "web:bounded-0000"), false);

  const expiring = { ...requestIdentity, clientRequestId: "web:expires-0001", requestHash };
  store.claimCommandRequest(expiring);
  now += 24 * 60 * 60 * 1000 + 1;
  const reused = store.claimCommandRequest({ ...expiring, requestHash: "c".repeat(64) });
  assert.equal(reused.claimed, true);
  assert.equal(reused.conflict, false);
});

test("an owner with 1,000 genuinely in-flight requests fails closed instead of evicting one", () => {
  const store = createMemoryStore();
  for (let index = 0; index < 1000; index += 1) {
    const claimed = store.claimCommandRequest({
      ...requestIdentity,
      clientRequestId: `web:active-${String(index).padStart(4, "0")}`,
      requestHash: "d".repeat(64),
    });
    assert.equal(claimed.claimed, true);
  }
  const capacity = store.claimCommandRequest({
    ...requestIdentity,
    clientRequestId: "web:active-overflow",
    requestHash: "d".repeat(64),
  });
  assert.equal(capacity.capacity, true);
  assert.equal(store.exportState().commandRequests.length, 1000);
});

test("file receipts survive a gateway restart with their command reference", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "next-coder-request-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const requestHash = "a".repeat(64);
  const first = await createFileStore(path);
  await first.claimCommandRequest({ ...requestIdentity, requestHash });

  // The claim await is the before-effect durability boundary used by app.mjs. A restarted process
  // must see it without needing a test-only flush, even if the command has not been dispatched yet.
  const restartedWhileProcessing = await createFileStore(path);
  const inFlightReplay = await restartedWhileProcessing.claimCommandRequest({ ...requestIdentity, requestHash });
  assert.equal(inFlightReplay.claimed, false);
  assert.equal(inFlightReplay.request.status, "processing");

  await first.settleCommandRequest({
    ...requestIdentity,
    requestHash,
    status: "completed",
    commandId: "cmd_original",
    httpStatus: 202,
  });
  const restarted = await createFileStore(path);
  const replay = await restarted.claimCommandRequest({ ...requestIdentity, requestHash });
  assert.equal(replay.claimed, false);
  assert.equal(replay.conflict, false);
  assert.equal(replay.request.commandId, "cmd_original");
  assert.equal(replay.request.status, "completed");
});

test("concurrent browser retries dispatch once and recover through the durable request route", async (t) => {
  const originalFetch = globalThis.fetch;
  let dispatches = 0;
  let releaseDispatch;
  const dispatchGate = new Promise((resolve) => { releaseDispatch = resolve; });
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches += 1;
      await dispatchGate;
      return jsonResponse({ status: "accepted" }, 200);
    }
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({
        projects: [{
          id: "project_1",
          title: "Project",
          defaultModelSelection: { instanceId: "codex", model: "gpt-test" },
        }],
        threads: [],
      }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = await createAuthHeaders(originalFetch, baseUrl);
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers,
    body: { label: "T3", baseUrl: "https://t3.example", accessToken: "token" },
  });
  const body = {
    clientRequestId: "web:concurrent-request",
    environmentId: environment.environment.id,
    threadId: "thread_1",
    intent: { type: "agent_prompt", text: "run exactly once" },
  };

  const firstPromise = fetchJson(originalFetch, baseUrl, "/v1/intents", { method: "POST", headers, body });
  while (dispatches === 0) await new Promise((resolve) => setImmediate(resolve));
  const racing = await fetchJson(originalFetch, baseUrl, "/v1/intents", { method: "POST", headers, body });
  assert.equal(racing.response.status, 202);
  assert.equal(racing.data.duplicate, true);
  assert.equal(racing.data.recovery, "processing");
  assert.equal(dispatches, 1);

  releaseDispatch();
  const first = await firstPromise;
  assert.equal(first.response.status, 202);
  const replay = await fetchJson(originalFetch, baseUrl, "/v1/intents", { method: "POST", headers, body });
  assert.equal(replay.data.duplicate, true);
  assert.equal(replay.data.command.id, first.data.command.id);
  assert.equal(dispatches, 1);

  const recovered = await fetchJson(
    originalFetch,
    baseUrl,
    `/v1/requests/${encodeURIComponent(body.clientRequestId)}`,
    { method: "GET", headers },
  );
  assert.equal(recovered.data.request.commandId, first.data.command.id);
  assert.equal(recovered.data.command.id, first.data.command.id);

  const conflict = await fetchJson(originalFetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers,
    body: { ...body, intent: { type: "agent_prompt", text: "different" } },
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.data.error.details.code, "idempotency_conflict");
  assert.equal(dispatches, 1);

  const createdAction = await requestJson(originalFetch, baseUrl, "/v1/actions", {
    method: "POST",
    headers,
    body: { type: "prompt", label: "Review", payload: { text: "review once" } },
  });
  const actionBody = {
    clientRequestId: "web:action-request-0001",
    environmentId: environment.environment.id,
    threadId: "thread_1",
  };
  const actionPath = `/v1/actions/${createdAction.action.id}/run`;
  const actionFirst = await fetchJson(originalFetch, baseUrl, actionPath, {
    method: "POST", headers, body: actionBody,
  });
  const actionReplay = await fetchJson(originalFetch, baseUrl, actionPath, {
    method: "POST", headers, body: actionBody,
  });
  assert.equal(actionFirst.response.status, 202);
  assert.equal(actionReplay.data.duplicate, true);
  assert.equal(actionReplay.data.command.id, actionFirst.data.command.id);
  assert.equal(dispatches, 2, "the action replay must reuse its original command");

  const launchBody = {
    clientRequestId: "web:launch-request-0001",
    projectId: "project_1",
    text: "launch exactly once",
  };
  const launchPath = `/v1/t3/environments/${environment.environment.id}/threads`;
  const launchFirst = await fetchJson(originalFetch, baseUrl, launchPath, {
    method: "POST", headers, body: launchBody,
  });
  const launchReplay = await fetchJson(originalFetch, baseUrl, launchPath, {
    method: "POST", headers, body: launchBody,
  });
  assert.equal(launchFirst.response.status, 202);
  assert.equal(launchReplay.data.duplicate, true);
  assert.equal(launchReplay.data.threadId, launchFirst.data.threadId);
  assert.equal(launchReplay.data.command.id, launchFirst.data.command.id);
  assert.equal(dispatches, 4, "thread create and first turn must each run once across launch replay");
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function fetchJson(fetchImpl, baseUrl, path, input) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: input.method,
    headers: { "content-type": "application/json", ...input.headers },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  return { response, data: await response.json() };
}

async function requestJson(fetchImpl, baseUrl, path, input) {
  const result = await fetchJson(fetchImpl, baseUrl, path, input);
  assert.equal(result.response.ok, true, JSON.stringify(result.data));
  return result.data;
}

async function createAuthHeaders(fetchImpl, baseUrl) {
  const created = await requestJson(fetchImpl, baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_request_test", email: "request@example.local" },
  });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
