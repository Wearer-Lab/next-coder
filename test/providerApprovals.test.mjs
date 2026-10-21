import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { buildT3Command } from "../src/t3Client.mjs";
import {
  PROVIDER_APPROVAL_DECISIONS,
  allowedProviderApprovalDecisions,
  collectProviderApprovals,
  isStaleProviderRequestDetail,
  normalizeProviderApprovalDecision,
} from "../src/providerApprovals.mjs";
import { capabilitiesForProfile } from "../src/profiles.mjs";
import { evaluateIntentPolicy } from "../src/policy.mjs";

// ---------------------------------------------------------------------------------------------
// The contract, as a test rather than a comment.
// ---------------------------------------------------------------------------------------------

test("the decision set is T3's four, not a binary approve/reject", () => {
  assert.deepEqual(PROVIDER_APPROVAL_DECISIONS, ["accept", "acceptForSession", "decline", "cancel"]);
  for (const decision of PROVIDER_APPROVAL_DECISIONS) {
    assert.equal(normalizeProviderApprovalDecision(decision), decision);
  }
  // Firmware in the field posts the old spelling; it folds onto the canonical values rather than
  // living on as a second vocabulary.
  assert.equal(normalizeProviderApprovalDecision("approve"), "accept");
  assert.equal(normalizeProviderApprovalDecision("reject"), "decline");
  assert.equal(normalizeProviderApprovalDecision("allow-always"), null);
  assert.equal(normalizeProviderApprovalDecision(""), null);
});

test("every decision reaches T3 as itself", () => {
  for (const decision of [...PROVIDER_APPROVAL_DECISIONS, "approve", "reject"]) {
    const command = buildT3Command({
      intent: { type: "approval_response", requestId: "req_1", decision },
      threadId: "thread_1",
    });
    assert.equal(command.type, "thread.approval.respond");
    assert.equal(command.requestId, "req_1");
    assert.equal(command.decision, normalizeProviderApprovalDecision(decision));
  }
});

function approvalRequested(requestId, overrides = {}) {
  return {
    id: `act_${requestId}_req`,
    tone: "approval",
    kind: "approval.requested",
    summary: "Command approval requested",
    payload: {
      requestId,
      requestKind: "command",
      requestType: "command_execution_approval",
      detail: "npm test",
    },
    turnId: "turn_1",
    sequence: 1,
    createdAt: "2026-08-24T10:00:00.000Z",
    ...overrides,
  };
}

test("a pending approval is derived from the thread's activity log", () => {
  const [approval] = collectProviderApprovals({
    id: "thread_1",
    activities: [approvalRequested("req_1")],
  });
  assert.equal(approval.kind, "provider");
  assert.equal(approval.status, "pending");
  assert.equal(approval.requestId, "req_1");
  assert.equal(approval.threadId, "thread_1");
  assert.equal(approval.requestKind, "command");
  assert.equal(approval.detail, "npm test");
});

test("a resolution closes the request, and ordering is by sequence not array order", () => {
  const approvals = collectProviderApprovals({
    id: "thread_1",
    activities: [
      {
        id: "act_2",
        kind: "approval.resolved",
        summary: "Approval resolved",
        payload: { requestId: "req_1", decision: "acceptForSession" },
        sequence: 2,
        createdAt: "2026-08-24T10:00:01.000Z",
      },
      approvalRequested("req_1"),
    ],
  });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "resolved");
  assert.equal(approvals[0].decision, "acceptForSession");
});

test("a stale respond-failure closes the request; any other failure leaves it open", () => {
  // T3's own wording, from ProviderCommandReactor.ts:281-287.
  const stale = "Stale pending approval request: req_1. Provider callback state does not survive "
    + "app restarts or recovered sessions. Restart the turn to continue.";
  assert.equal(isStaleProviderRequestDetail(stale), true);
  assert.equal(isStaleProviderRequestDetail("Connection reset by peer"), false);

  const failed = (detail) => collectProviderApprovals({
    id: "thread_1",
    activities: [
      approvalRequested("req_1"),
      {
        id: "act_fail",
        tone: "error",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        payload: { requestId: "req_1", detail },
        sequence: 2,
        createdAt: "2026-08-24T10:00:02.000Z",
      },
    ],
  })[0];

  assert.equal(failed(stale).status, "stale");
  // Still blocked on an answer: the provider never heard one.
  assert.equal(failed("Connection reset by peer").status, "pending");
  assert.equal(failed("Connection reset by peer").failure, "Connection reset by peer");
});

test("a bodiless snapshot thread yields no approvals rather than an error", () => {
  assert.deepEqual(collectProviderApprovals({ id: "thread_1" }), []);
  assert.deepEqual(collectProviderApprovals(null), []);
});

// ---------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------

test("allow-always is a separate capability from allow-once", () => {
  assert.deepEqual(
    allowedProviderApprovalDecisions(capabilitiesForProfile("next-coder")),
    ["accept", "decline", "cancel"],
  );
  assert.deepEqual(
    allowedProviderApprovalDecisions(capabilitiesForProfile("power-controller")),
    ["accept", "acceptForSession", "decline", "cancel"],
  );
  // Read-only may see an approval — listing is a read — and is offered nothing.
  assert.deepEqual(allowedProviderApprovalDecisions(capabilitiesForProfile("read-only")), []);
});

test("the policy engine gates acceptForSession apart from the other three", () => {
  const decide = (profile, decision) => evaluateIntentPolicy({
    device: { profile },
    intent: { type: "approval_response", requestId: "req_1", decision },
  });

  assert.equal(decide("next-coder", "accept").allowed, true);
  assert.equal(decide("next-coder", "decline").allowed, true);
  assert.equal(decide("next-coder", "cancel").allowed, true);
  const persistent = decide("next-coder", "acceptForSession");
  assert.equal(persistent.allowed, false);
  assert.equal(persistent.risk, "blocked");
  assert.equal(persistent.dimension, "device");

  assert.equal(decide("power-controller", "acceptForSession").allowed, true);
  assert.equal(decide("read-only", "accept").allowed, false);
});

test("a standing grant escalates to owner confirmation under a medium risk ceiling", () => {
  // An untrusted network caps automatic dispatch at low risk. Allow-once still lands; granting a
  // permission that outlives the question does not.
  const fromUntrusted = (decision) => evaluateIntentPolicy({
    device: { profile: "power-controller" },
    intent: { type: "approval_response", requestId: "req_1", decision },
    networkLocation: "untrusted",
  });
  assert.equal(fromUntrusted("decline").allowed, true);
  const escalated = fromUntrusted("acceptForSession");
  assert.equal(escalated.allowed, false);
  assert.equal(escalated.requiresApproval, true);
  assert.equal(escalated.risk, "high");
});

// ---------------------------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------------------------

const THREAD_ID = "thread_live";

/**
 * A fake T3 whose thread work log the test controls.
 *
 * `activities` is read on every thread-detail request, so a test can resolve or abandon an
 * approval between two gateway calls the way T3 would.
 */
function stubT3({ activities }) {
  const dispatches = [];
  const state = { activities, dispatchStatus: 200 };
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse(
        state.dispatchStatus === 200 ? { sequence: 42 } : { error: "unavailable" },
        state.dispatchStatus,
      );
    }
    if (parsed.pathname === `/api/orchestration/threads/${THREAD_ID}`) {
      return jsonResponse({
        snapshotSequence: 7,
        thread: { id: THREAD_ID, activities: state.activities, messages: [], session: null },
      }, 200);
    }
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({
        snapshotSequence: 7,
        projects: [{ id: "project_1", title: "app" }],
        threads: [{ id: THREAD_ID, projectId: "project_1", title: "Live", session: null }],
        updatedAt: "2026-08-24T10:00:00.000Z",
      }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  return { dispatches, state };
}

async function harness(t, { activities = [approvalRequested("req_1")], profile = "next-coder" } = {}) {
  const originalFetch = globalThis.fetch;
  const stub = stubT3({ activities });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });
  const environmentId = environment.environment.id;

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Controller", profile },
  });
  await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: { environmentId, threadId: THREAD_ID, projectId: "project_1" },
  });

  const deviceHeaders = {
    "x-device-id": created.device.id,
    "x-device-secret": created.secret,
  };

  const call = (path, input) => requestJson(originalFetch, baseUrl, path, input);
  const raw = (path, input = {}) => originalFetch(new URL(path, baseUrl), {
    method: input.method ?? "GET",
    headers: { "content-type": "application/json", ...input.headers },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });

  return {
    ...stub,
    baseUrl,
    authHeaders,
    deviceHeaders,
    deviceId: created.device.id,
    environmentId,
    call,
    raw,
    approvalsPath: `/v1/t3/environments/${environmentId}/threads/${THREAD_ID}/approvals`,
  };
}

test("a pending provider approval surfaces to the owner with the full decision set", async (t) => {
  const h = await harness(t);
  const listed = await h.call(h.approvalsPath, { method: "GET", headers: h.authHeaders });

  assert.equal(listed.approvals.length, 1);
  assert.equal(listed.approvals[0].kind, "provider");
  assert.equal(listed.approvals[0].status, "pending");
  assert.equal(listed.approvals[0].detail, "npm test");
  assert.equal(listed.approvals[0].localDecision, null);
  assert.deepEqual(
    listed.decisions.map((entry) => entry.decision),
    ["accept", "acceptForSession", "decline", "cancel"],
  );
  // Exactly one decision is a standing grant, and the catalogue says which.
  assert.deepEqual(
    listed.decisions.filter((entry) => entry.persistent).map((entry) => entry.decision),
    ["acceptForSession"],
  );
  assert.deepEqual(listed.allowedDecisions, ["accept", "acceptForSession", "decline", "cancel"]);
});

test("each decision in the full set round-trips to T3 as itself", async (t) => {
  for (const decision of PROVIDER_APPROVAL_DECISIONS) {
    await t.test(decision, async (subtest) => {
      const requestId = `req_${decision}`;
      const h = await harness(subtest, { activities: [approvalRequested(requestId)] });
      const answered = await h.call(`${h.approvalsPath}/${requestId}`, {
        method: "POST",
        headers: h.authHeaders,
        body: { decision },
      });

      assert.equal(answered.duplicate, false);
      assert.equal(answered.decision.decision, decision);
      assert.equal(answered.decision.status, "dispatched");
      assert.equal(answered.command.status, "dispatched");
      assert.equal(h.dispatches.length, 1);
      assert.equal(h.dispatches[0].type, "thread.approval.respond");
      assert.equal(h.dispatches[0].requestId, requestId);
      assert.equal(h.dispatches[0].decision, decision);
    });
  }
});

test("answering twice with the same decision is idempotent and dispatches once", async (t) => {
  const h = await harness(t);
  const first = await h.call(`${h.approvalsPath}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { decision: "accept" },
  });
  const second = await h.call(`${h.approvalsPath}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { decision: "accept" },
  });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.decision.decision, "accept");
  assert.equal(second.command.id, first.command.id);
  assert.equal(h.dispatches.length, 1, "the provider must not be answered twice");
});

test("a second client answering differently is refused rather than overriding the first", async (t) => {
  const h = await harness(t);
  await h.call(`${h.approvalsPath}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { decision: "accept" },
  });
  const response = await h.raw(`${h.approvalsPath}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { decision: "decline" },
  });

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error.message, /already answered with a different decision/u);
  assert.equal(body.error.details.decision.decision, "accept");
  assert.equal(h.dispatches.length, 1);
});

test("an approval T3 has already resolved cannot be answered", async (t) => {
  const h = await harness(t, {
    activities: [
      approvalRequested("req_1"),
      {
        id: "act_resolved",
        kind: "approval.resolved",
        summary: "Approval resolved",
        payload: { requestId: "req_1", decision: "accept" },
        sequence: 2,
        createdAt: "2026-08-24T10:00:05.000Z",
      },
    ],
  });
  const response = await h.raw(`${h.approvalsPath}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { decision: "decline" },
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /already resolved/u);
  assert.equal(h.dispatches.length, 0);
});

test("an approval T3 abandoned is refused before any dispatch", async (t) => {
  const h = await harness(t, {
    activities: [
      approvalRequested("req_1"),
      {
        id: "act_stale",
        tone: "error",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        payload: {
          requestId: "req_1",
          detail: "Stale pending approval request: req_1. Provider callback state does not "
            + "survive app restarts or recovered sessions. Restart the turn to continue.",
        },
        sequence: 2,
        createdAt: "2026-08-24T10:00:06.000Z",
      },
    ],
  });

  // It is also not listed as something waiting on the owner.
  const listed = await h.call(h.approvalsPath, { method: "GET", headers: h.authHeaders });
  assert.equal(listed.approvals[0].status, "stale");

  const response = await h.raw(`${h.approvalsPath}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { decision: "accept" },
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /abandoned/u);
  // T3 would have accepted this dispatch and only failed later, asynchronously. It is never sent.
  assert.equal(h.dispatches.length, 0);
});

test("a failed dispatch releases the claim so the owner can retry", async (t) => {
  const h = await harness(t);
  h.state.dispatchStatus = 503;
  const failed = await h.raw(`${h.approvalsPath}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { decision: "accept" },
  });
  assert.equal(failed.status, 502);

  h.state.dispatchStatus = 200;
  const retried = await h.call(`${h.approvalsPath}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { decision: "accept" },
  });
  assert.equal(retried.duplicate, false, "a transient outage must not lock the approval forever");
  assert.equal(retried.decision.status, "dispatched");
});

test("an unrecognised decision is refused with the real vocabulary", async (t) => {
  const h = await harness(t);
  const response = await h.raw(`${h.approvalsPath}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { decision: "allow-always" },
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /accept, acceptForSession, decline, cancel/u);
});

test("the device approval poll keeps the two kinds of approval apart", async (t) => {
  const h = await harness(t);

  // A gateway policy hold: dangerous shell input the gateway refused to dispatch.
  const held = await h.call("/v1/device/intents", {
    method: "POST",
    headers: h.deviceHeaders,
    body: {
      environmentId: h.environmentId,
      threadId: THREAD_ID,
      intent: { type: "shell_input", command: "sudo rm -rf /" },
    },
  });
  assert.equal(held.command.status, "approval_required");

  const listed = await h.call("/v1/device/approvals", { method: "GET", headers: h.deviceHeaders });

  // Two questions, two keys, two id spaces, two answer routes. Never one list.
  assert.equal(listed.commands.length, 1);
  assert.equal(listed.commands[0].kind, "gateway");
  assert.equal(listed.commands[0].id, held.command.id);
  assert.equal(listed.providerApprovals.length, 1);
  assert.equal(listed.providerApprovals[0].kind, "provider");
  assert.equal(listed.providerApprovals[0].requestId, "req_1");
  assert.equal(listed.providerApprovals[0].title, "Run a command");
  // The hardware profile is offered three of the four; the standing grant is not one of them.
  assert.deepEqual(listed.allowedDecisions, ["accept", "decline", "cancel"]);
});

test("a device answers a provider approval on its own route, in T3's vocabulary", async (t) => {
  const h = await harness(t);
  const answered = await h.call("/v1/device/provider-approvals/req_1", {
    method: "POST",
    headers: h.deviceHeaders,
    body: { decision: "decline" },
  });
  assert.equal(answered.decision.decision, "decline");
  assert.equal(answered.decision.actorType ?? "device", "device");
  assert.equal(h.dispatches.length, 1);
  assert.equal(h.dispatches[0].decision, "decline");

  // And it disappears from the device's own poll, without waiting for T3 to echo a resolution.
  const listed = await h.call("/v1/device/approvals", { method: "GET", headers: h.deviceHeaders });
  assert.deepEqual(listed.providerApprovals, []);
});

test("the legacy approve/reject spelling still works from firmware", async (t) => {
  const h = await harness(t);
  await h.call("/v1/device/provider-approvals/req_1", {
    method: "POST",
    headers: h.deviceHeaders,
    body: { decision: "approve" },
  });
  assert.equal(h.dispatches[0].decision, "accept");
});

test("a controller cannot grant a standing permission; the console can", async (t) => {
  const h = await harness(t);
  const refused = await h.raw("/v1/device/provider-approvals/req_1", {
    method: "POST",
    headers: h.deviceHeaders,
    body: { decision: "acceptForSession" },
  });
  assert.equal(refused.status, 403);
  assert.equal(h.dispatches.length, 0);

  // The claim was released, so the same request is still answerable from the console.
  const answered = await h.call(`${h.approvalsPath}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { decision: "acceptForSession" },
  });
  assert.equal(answered.decision.decision, "acceptForSession");
  assert.equal(h.dispatches.length, 1);
  assert.equal(h.dispatches[0].decision, "acceptForSession");
});

test("a read-only controller sees a pending approval and is offered nothing", async (t) => {
  const h = await harness(t, { profile: "read-only" });
  const listed = await h.call("/v1/device/approvals", { method: "GET", headers: h.deviceHeaders });

  // Hiding it would be worse: the owner walking past would have no idea the agent was blocked.
  assert.equal(listed.providerApprovals.length, 1);
  assert.deepEqual(listed.allowedDecisions, []);

  for (const decision of PROVIDER_APPROVAL_DECISIONS) {
    const response = await h.raw("/v1/device/provider-approvals/req_1", {
      method: "POST",
      headers: h.deviceHeaders,
      body: { decision },
    });
    assert.equal(response.status, 403, `read-only must not be able to answer with ${decision}`);
  }
  assert.equal(h.dispatches.length, 0);
});

test("a device poll still answers gateway approvals when T3 is unreachable", async (t) => {
  const h = await harness(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/api/orchestration/threads/")) throw new Error("T3 host asleep");
    return originalFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const listed = await h.call("/v1/device/approvals", { method: "GET", headers: h.deviceHeaders });
  assert.deepEqual(listed.providerApprovals, []);
  assert.match(listed.providerApprovalsError, /asleep/u);
  assert.ok(Array.isArray(listed.commands));
});

// ---------------------------------------------------------------------------------------------

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function requestJson(fetchImpl, baseUrl, path, input) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: input.method,
    headers: { "content-type": "application/json", ...input.headers },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function createAuthHeaders(fetchImpl, baseUrl) {
  const created = await requestJson(fetchImpl, baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_dev", email: "dev@example.local" },
  });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
