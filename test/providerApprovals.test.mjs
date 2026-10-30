import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { buildT3Command } from "../src/t3Client.mjs";
import {
  ALWAYS_PROVIDER_APPROVAL_DECISIONS,
  DEFAULT_OFFERED_PROVIDER_APPROVAL_DECISIONS,
  DEVICE_APPROVAL_DETAIL_LIMIT,
  PERSISTENT_PROVIDER_APPROVAL_DECISIONS,
  PROVIDER_APPROVAL_DECISIONS,
  PROVIDER_APPROVAL_DECISION_CATALOGUE,
  PROVIDER_REQUEST_KINDS,
  allowedProviderApprovalDecisions,
  capabilityForProviderApprovalDecision,
  collectProviderApprovals,
  deviceProviderApprovalView,
  isStaleProviderRequestDetail,
  normalizeProviderApprovalDecision,
  offeredProviderApprovalDecisions,
  providerApprovalOffers,
} from "../src/providerApprovals.mjs";
import { DEVICE_CAPABILITIES, capabilitiesForProfile } from "../src/profiles.mjs";
import { evaluateIntentPolicy } from "../src/policy.mjs";

// ---------------------------------------------------------------------------------------------
// The contract, as a test rather than a comment.
// ---------------------------------------------------------------------------------------------

test("the decision set is T3's five, in T3's declaration order, not a binary approve/reject", () => {
  // `ProviderApprovalDecision` in the 0.1.1 and 0.1.5 bundles (docs/t3-version-audit.md section 5):
  // the same five literals in the same order. Four in 0.0.32; acceptAlways arrived in 0.1.1.
  assert.deepEqual(PROVIDER_APPROVAL_DECISIONS, ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]);
  for (const decision of PROVIDER_APPROVAL_DECISIONS) {
    assert.equal(normalizeProviderApprovalDecision(decision), decision);
  }
  // Firmware in the field posts the old spelling; it folds onto the canonical values rather than
  // living on as a second vocabulary.
  assert.equal(normalizeProviderApprovalDecision("approve"), "accept");
  assert.equal(normalizeProviderApprovalDecision("reject"), "decline");
  assert.equal(normalizeProviderApprovalDecision("allow-always"), null);
  assert.equal(normalizeProviderApprovalDecision(""), null);
  // Properties every object has are not decisions. A bare index into the alias table used to
  // hand back `Object` for "constructor".
  for (const inherited of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(normalizeProviderApprovalDecision(inherited), null, inherited);
  }
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

test("a request's own decision list narrows what is offered; unstated keeps T3's default four", () => {
  const power = capabilitiesForProfile("power-controller");
  const stated = collectProviderApprovals({
    id: THREAD_ID,
    activities: [approvalRequested("req_direct", { payload: {
      requestId: "req_direct",
      requestKind: "command",
      decisions: ["accept", "decline", "bogus", "accept"],
    } })],
  })[0];
  // Unrecognised entries are dropped and duplicates collapse; the list is the request's, in
  // catalogue order once intersected.
  assert.deepEqual(stated.offeredDecisions, ["accept", "decline"]);
  assert.deepEqual(allowedProviderApprovalDecisions(power, stated), ["accept", "decline"]);

  // T3 itself never states one: null means "unstated", not "nothing".
  const unstated = collectProviderApprovals({ id: THREAD_ID, activities: [approvalRequested("req_t3")] })[0];
  assert.equal(unstated.offeredDecisions, null);
  assert.deepEqual(
    allowedProviderApprovalDecisions(power, unstated),
    ["accept", "acceptForSession", "decline", "cancel"],
  );

  // A list that named only unrecognised decisions must not widen back to all four.
  const garbled = collectProviderApprovals({
    id: THREAD_ID,
    activities: [approvalRequested("req_x", { payload: { requestId: "req_x", decisions: ["nope"] } })],
  })[0];
  assert.deepEqual(garbled.offeredDecisions, []);
  assert.deepEqual(allowedProviderApprovalDecisions(power, garbled), []);

  // Capability still wins: offering a decision never grants it.
  const hardware = capabilitiesForProfile("next-coder");
  const offeredAll = { offeredDecisions: ["accept", "acceptForSession"] };
  assert.deepEqual(allowedProviderApprovalDecisions(hardware, offeredAll), ["accept"]);
  assert.deepEqual(allowedProviderApprovalDecisions(capabilitiesForProfile("read-only"), offeredAll), []);
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
    ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"],
  );
  // Two decisions are standing grants, and the catalogue says which.
  assert.deepEqual(
    listed.decisions.filter((entry) => entry.persistent).map((entry) => entry.decision),
    ["acceptForSession", "acceptAlways"],
  );
  // The top-level list is capability-only and unchanged for deployed clients: a request that
  // states nothing is read as T3's default four, which never includes acceptAlways.
  assert.deepEqual(listed.allowedDecisions, ["accept", "acceptForSession", "decline", "cancel"]);
});

test("each decision in the full set round-trips to T3 as itself", async (t) => {
  for (const decision of PROVIDER_APPROVAL_DECISIONS) {
    // acceptAlways is only ever offered by a request that LISTS it (see the default set), so its
    // request below does; the route passes the console's realm to the policy engine.
    await t.test(decision, async (subtest) => {
      const requestId = `req_${decision}`;
      const h = await harness(subtest, {
        activities: [decision === "acceptAlways"
          ? directApproval(requestId, ["accept", "acceptAlways", "decline", "cancel"])
          : approvalRequested(requestId)],
      });
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
  assert.match((await response.json()).error.message, /accept, acceptForSession, acceptAlways, decline, cancel/u);
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
    // acceptAlways is not part of T3's default four, so this request never offered it and the
    // answer route refuses it first (422) — before the capability check that would give a 403.
    // Either way nothing is claimed or dispatched.
    const expected = decision === "acceptAlways" ? 422 : 403;
    assert.equal(response.status, expected, `read-only must not be able to answer with ${decision}`);
  }
  assert.equal(h.dispatches.length, 0);
});

// A direct runtime offers only what the native agent exposed. These run the whole path: the
// decision list recorded on the activity, the per-entry lists on both read routes, and the refusal
// of an unoffered answer before anything is claimed or dispatched.
function directApproval(requestId, decisions) {
  return approvalRequested(requestId, { payload: {
    requestId,
    requestKind: "command",
    requestType: "command_execution_approval",
    detail: "npm test",
    decisions,
  } });
}

test("per-approval allowedDecisions narrow the console list; the top-level list is unchanged", async (t) => {
  const h = await harness(t, { activities: [directApproval("req_direct", ["accept", "decline"]), approvalRequested("req_t3", { sequence: 2 })] });
  const listed = await h.call(h.approvalsPath, { method: "GET", headers: h.authHeaders });

  const byId = Object.fromEntries(listed.approvals.map((approval) => [approval.requestId, approval]));
  assert.deepEqual(byId.req_direct.allowedDecisions, ["accept", "decline"]);
  assert.deepEqual(byId.req_t3.allowedDecisions, ["accept", "acceptForSession", "decline", "cancel"]);
  // Backward compatibility: already-deployed clients read only this and must see exactly what they
  // always saw (capability-only).
  assert.deepEqual(listed.allowedDecisions, ["accept", "acceptForSession", "decline", "cancel"]);
});

test("per-approval allowedDecisions narrow the device list by request and by capability", async (t) => {
  const h = await harness(t, { activities: [directApproval("req_direct", ["accept", "acceptForSession", "cancel"]), approvalRequested("req_t3", { sequence: 2 })] });
  const listed = await h.call("/v1/device/approvals", { method: "GET", headers: h.deviceHeaders });

  const byId = Object.fromEntries(listed.providerApprovals.map((approval) => [approval.requestId, approval]));
  // The hardware profile holds no standing-grant capability, so offered-but-not-permitted drops.
  assert.deepEqual(byId.req_direct.allowedDecisions, ["accept", "cancel"]);
  assert.deepEqual(byId.req_t3.allowedDecisions, ["accept", "decline", "cancel"]);
  assert.deepEqual(listed.allowedDecisions, ["accept", "decline", "cancel"]);
  // The device view stays small: the raw offered list is not part of it.
  assert.equal(byId.req_direct.offeredDecisions, undefined);
});

test("a decision the request never offered is refused before any claim or dispatch", async (t) => {
  const h = await harness(t, { activities: [directApproval("req_direct", ["accept", "decline"])] });

  const refused = await h.raw(`${h.approvalsPath}/req_direct`, {
    method: "POST",
    headers: h.authHeaders,
    body: { decision: "cancel" },
  });
  assert.equal(refused.status, 422);
  const body = await refused.json();
  assert.match(body.error.message, /does not offer/u);
  assert.deepEqual(body.error.details.offeredDecisions, ["accept", "decline"]);
  assert.equal(h.dispatches.length, 0);

  // The device route shares the check.
  const deviceRefused = await h.raw("/v1/device/provider-approvals/req_direct", {
    method: "POST",
    headers: h.deviceHeaders,
    body: { decision: "cancel" },
  });
  assert.equal(deviceRefused.status, 422);
  assert.equal(h.dispatches.length, 0);

  // Nothing was claimed, so an offered answer still goes through, and its duplicate is a 200.
  const answered = await h.call(`${h.approvalsPath}/req_direct`, {
    method: "POST",
    headers: h.authHeaders,
    body: { decision: "decline" },
  });
  assert.equal(answered.decision.decision, "decline");
  const duplicate = await h.raw(`${h.approvalsPath}/req_direct`, {
    method: "POST",
    headers: h.authHeaders,
    body: { decision: "decline" },
  });
  assert.equal(duplicate.status, 200);
  assert.equal(h.dispatches.length, 1);

  // And a different decision after the claim is still the 409 it always was.
  const conflict = await h.raw(`${h.approvalsPath}/req_direct`, {
    method: "POST",
    headers: h.authHeaders,
    body: { decision: "accept" },
  });
  assert.equal(conflict.status, 409);
});

test("a device poll still answers gateway approvals when T3 is unreachable", async (t) => {
  const h = await harness(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/api/orchestration/threads/")) throw new Error("T3 host asleep");
    return originalFetch(url, init);
  };
  // No restore here: the harness's own after-hook puts the real fetch back, and a second restore
  // from this test would run after it and leave the stub installed for every later test.

  const listed = await h.call("/v1/device/approvals", { method: "GET", headers: h.deviceHeaders });
  assert.deepEqual(listed.providerApprovals, []);
  assert.match(listed.providerApprovalsError, /asleep/u);
  assert.ok(Array.isArray(listed.commands));
});

// ---------------------------------------------------------------------------------------------
// acceptAlways — the fifth decision (T3 0.1.1+). Unit level first, then the routes.
// ---------------------------------------------------------------------------------------------

test("acceptAlways is a standing grant, one tier above acceptForSession, and not offered by default", () => {
  assert.deepEqual(PERSISTENT_PROVIDER_APPROVAL_DECISIONS, ["acceptForSession", "acceptAlways"]);
  assert.deepEqual(ALWAYS_PROVIDER_APPROVAL_DECISIONS, ["acceptAlways"]);
  // T3's own web UI fallback when a request lists no options: cancel, decline, "Always allow this
  // session", approve. acceptAlways is not in it, because Claude turns it into a deny and ACP into
  // a rejection — offering it speculatively would silently refuse what the owner meant to allow.
  assert.deepEqual(DEFAULT_OFFERED_PROVIDER_APPROVAL_DECISIONS, ["accept", "acceptForSession", "decline", "cancel"]);

  assert.equal(capabilityForProviderApprovalDecision("accept"), "approval_response");
  assert.equal(capabilityForProviderApprovalDecision("decline"), "approval_response");
  assert.equal(capabilityForProviderApprovalDecision("cancel"), "approval_response");
  assert.equal(capabilityForProviderApprovalDecision("acceptForSession"), "approval_response_persistent");
  assert.equal(capabilityForProviderApprovalDecision("acceptAlways"), "approval_response_always");

  // Every capability the mapping can name exists, so the policy engine's derived deny-by-default
  // list covers it (it is built from DEVICE_CAPABILITIES, never a hand-kept copy).
  for (const decision of PROVIDER_APPROVAL_DECISIONS) {
    assert.ok(DEVICE_CAPABILITIES.includes(capabilityForProviderApprovalDecision(decision)), decision);
  }
});

test("the catalogue describes all five in vocabulary order and says what is offered by default", () => {
  assert.deepEqual(
    PROVIDER_APPROVAL_DECISION_CATALOGUE.map((entry) => entry.decision),
    [...PROVIDER_APPROVAL_DECISIONS],
  );
  assert.deepEqual(
    PROVIDER_APPROVAL_DECISION_CATALOGUE.filter((entry) => entry.offeredByDefault).map((entry) => entry.decision),
    [...DEFAULT_OFFERED_PROVIDER_APPROVAL_DECISIONS],
  );
  assert.deepEqual(
    PROVIDER_APPROVAL_DECISION_CATALOGUE.filter((entry) => entry.persistent).map((entry) => entry.decision),
    [...PERSISTENT_PROVIDER_APPROVAL_DECISIONS],
  );
  // The description must not promise "forever": on Codex it is session-scoped and on Claude it is
  // not supported at all.
  const always = PROVIDER_APPROVAL_DECISION_CATALOGUE.find((entry) => entry.decision === "acceptAlways");
  assert.match(always.description, /where the provider supports/u);
});

test("acceptAlways reaches a button only when capability, request and realm all agree", () => {
  const power = capabilitiesForProfile("power-controller");
  const offersAlways = { offeredDecisions: ["accept", "acceptAlways", "decline", "cancel"] };
  const everything = { offeredDecisions: [...PROVIDER_APPROVAL_DECISIONS] };

  // The owner, the request offering it, the capability held: listed, in vocabulary order.
  assert.deepEqual(
    allowedProviderApprovalDecisions(power, offersAlways, { realm: "user" }),
    ["accept", "acceptAlways", "decline", "cancel"],
  );
  assert.deepEqual(
    allowedProviderApprovalDecisions(power, everything, { realm: "user" }),
    [...PROVIDER_APPROVAL_DECISIONS],
  );

  // A request that never listed it: not offered, whoever asks and whatever they hold.
  assert.equal(allowedProviderApprovalDecisions(power, null, { realm: "user" }).includes("acceptAlways"), false);
  assert.equal(
    allowedProviderApprovalDecisions(power, { offeredDecisions: null }, { realm: "user" }).includes("acceptAlways"),
    false,
  );

  // The realm argument fails closed: omitted, unknown, or "device" all withhold it.
  for (const realm of [undefined, null, "device", "admin", ""]) {
    assert.equal(
      allowedProviderApprovalDecisions(power, everything, realm === undefined ? {} : { realm }).includes("acceptAlways"),
      false,
      `realm ${JSON.stringify(realm)}`,
    );
  }

  // Capability: a profile with the session grant but not the standing one gets the former only.
  const sessionOnly = new Set(["approval_response", "approval_response_persistent"]);
  assert.deepEqual(
    allowedProviderApprovalDecisions(sessionOnly, everything, { realm: "user" }),
    ["accept", "acceptForSession", "decline", "cancel"],
  );
  // And the built-in hardware profile holds neither.
  assert.deepEqual(
    allowedProviderApprovalDecisions(capabilitiesForProfile("next-coder"), everything, { realm: "user" }),
    ["accept", "decline", "cancel"],
  );
  assert.deepEqual(allowedProviderApprovalDecisions(capabilitiesForProfile("read-only"), everything, { realm: "user" }), []);
});

test("a controller is never offered a durable grant for a request it cannot display in full", () => {
  const power = capabilitiesForProfile("power-controller");
  const offered = ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"];
  const approval = (detail) => ({ offeredDecisions: offered, detail });
  const shown = "npm test";
  const clipped = "x".repeat(DEVICE_APPROVAL_DETAIL_LIMIT + 1);
  const exact = "y".repeat(DEVICE_APPROVAL_DETAIL_LIMIT);

  // Fits the panel: the session grant the profile carries is offered; the standing one never is.
  assert.deepEqual(
    allowedProviderApprovalDecisions(power, approval(shown), { realm: "device" }),
    ["accept", "acceptForSession", "decline", "cancel"],
  );
  assert.deepEqual(
    allowedProviderApprovalDecisions(power, approval(exact), { realm: "device" }),
    ["accept", "acceptForSession", "decline", "cancel"],
  );
  // Clipped, or nothing to read: the one-off answers and the refusals remain, the grants go.
  for (const detail of [clipped, null, "   "]) {
    assert.deepEqual(
      allowedProviderApprovalDecisions(power, approval(detail), { realm: "device" }),
      ["accept", "decline", "cancel"],
      JSON.stringify(detail?.slice(0, 8)),
    );
  }
  // The same request is unaffected for the owner, who has the whole detail.
  assert.deepEqual(
    allowedProviderApprovalDecisions(power, approval(clipped), { realm: "user" }),
    [...PROVIDER_APPROVAL_DECISIONS],
  );

  // The rule and the clip share one number, so they cannot disagree.
  assert.equal(deviceProviderApprovalView(approval(exact)).detail.length, DEVICE_APPROVAL_DETAIL_LIMIT);
  assert.equal(deviceProviderApprovalView(approval(clipped)).detail.endsWith("…"), true);
});

test("the device projection did not grow when the vocabulary did", () => {
  const view = deviceProviderApprovalView({
    requestId: "req_1", threadId: "thread_1", requestKind: "command", requestType: "command_execution_approval",
    detail: "npm test", summary: "Approval requested", requestedAt: "2026-10-30T10:00:00.000Z",
    activityId: "act_1", failure: "private", offeredDecisions: [...PROVIDER_APPROVAL_DECISIONS],
  });
  assert.deepEqual(
    Object.keys(view).sort(),
    ["detail", "kind", "requestId", "requestKind", "requestedAt", "threadId", "title"],
  );
});

test("providerApprovalOffers is the one check for 'is this decision open on this request'", () => {
  const stated = { offeredDecisions: ["accept", "acceptAlways"] };
  assert.equal(providerApprovalOffers(stated, "acceptAlways"), true);
  assert.equal(providerApprovalOffers(stated, "decline"), false);
  // Legacy firmware spelling folds first, so approve is asked as accept.
  assert.equal(providerApprovalOffers(stated, "approve"), true);
  // Unstated is T3's default four, which excludes the standing grant.
  assert.deepEqual(offeredProviderApprovalDecisions({ offeredDecisions: null }), [...DEFAULT_OFFERED_PROVIDER_APPROVAL_DECISIONS]);
  assert.equal(providerApprovalOffers({ offeredDecisions: null }, "acceptAlways"), false);
  assert.equal(providerApprovalOffers({ offeredDecisions: null }, "acceptForSession"), true);
  assert.equal(providerApprovalOffers({}, "acceptAlways"), false);
  // Garbage in, no decision out.
  assert.equal(providerApprovalOffers(stated, "constructor"), false);
  assert.equal(providerApprovalOffers(stated, 7), false);
  // A statement that named only unknown decisions still offers nothing; it never widens.
  assert.equal(providerApprovalOffers({ offeredDecisions: ["nope"] }, "accept"), false);
});

test("a request's decisions list and a resolution can both carry acceptAlways", () => {
  const [approval] = collectProviderApprovals({
    id: THREAD_ID,
    activities: [
      directApproval("req_always", ["cancel", "decline", "acceptAlways", "accept"]),
      {
        id: "act_resolved", kind: "approval.resolved", payload: { requestId: "req_always", decision: "acceptAlways" },
        sequence: 2, createdAt: "2026-08-24T10:00:05.000Z",
      },
    ],
  });
  assert.deepEqual(approval.offeredDecisions, ["cancel", "decline", "acceptAlways", "accept"]);
  assert.equal(approval.status, "resolved");
  assert.equal(approval.decision, "acceptAlways");
});

test("all five request kinds are recognised and titled; anything else is dropped to null", () => {
  assert.deepEqual(PROVIDER_REQUEST_KINDS, ["command", "file-read", "file-change", "mcp-elicitation", "permission"]);
  const kindOf = (requestKind) => collectProviderApprovals({
    id: THREAD_ID,
    activities: [approvalRequested("req_k", { payload: { requestId: "req_k", requestKind, detail: "d" } })],
  })[0];
  for (const kind of PROVIDER_REQUEST_KINDS) {
    const approval = kindOf(kind);
    assert.equal(approval.requestKind, kind);
    // A recognised kind is titled from the table, never from the provider's own summary.
    const title = deviceProviderApprovalView(approval).title;
    assert.notEqual(title, approval.summary, kind);
    assert.ok(title.length > 0 && title.length < 40, kind);
  }
  assert.equal(kindOf("mcp-elicitation").requestKind, "mcp-elicitation");
  assert.equal(kindOf("a-sixth-kind").requestKind, null);
  // An unrecognised kind has no title of its own, so it falls back to what T3 called the activity.
  assert.equal(deviceProviderApprovalView(kindOf("a-sixth-kind")).title, kindOf("a-sixth-kind").summary);
});

// -- policy ------------------------------------------------------------------

test("the policy engine gates acceptAlways as its own capability and only for the owner", () => {
  const decide = (profile, decision, extra = {}) => evaluateIntentPolicy({
    device: { profile },
    intent: { type: "approval_response", requestId: "req_1", decision },
    ...extra,
  });

  // The hardware profile holds neither grant: refused at the device dimension, as before.
  const hardware = decide("next-coder", "acceptAlways", { actorType: "user" });
  assert.equal(hardware.allowed, false);
  assert.equal(hardware.risk, "blocked");
  assert.equal(hardware.dimension, "device");

  // A profile with the SESSION grant alone cannot give the standing one: separate capabilities.
  const sessionOnly = { id: "session-only", capabilities: ["status", "approval_response", "approval_response_persistent"] };
  assert.equal(decide(sessionOnly, "acceptForSession", { actorType: "user" }).allowed, true);
  const refused = decide(sessionOnly, "acceptAlways", { actorType: "user" });
  assert.equal(refused.allowed, false);
  assert.equal(refused.dimension, "device");
  assert.match(refused.reason, /approval_response_always/u);

  // The owner on the console profile may.
  const granted = decide("power-controller", "acceptAlways", { actorType: "user" });
  assert.equal(granted.allowed, true);
  assert.equal(granted.risk, "high");
  assert.equal(granted.matchedRule, "baseline.approval-accept-always");
  // The session grant keeps its stored rule id.
  assert.equal(decide("power-controller", "acceptForSession", { actorType: "user" }).matchedRule, "baseline.approval-accept-for-session");
});

test("acceptAlways fails closed: a controller is refused whatever its profile says, and so is an unlabelled caller", () => {
  const power = { profile: "power-controller" };
  const intent = { type: "approval_response", requestId: "req_1", decision: "acceptAlways" };

  // `power-controller` is the console's profile AND an "advanced device" one. Holding the
  // capability is therefore not enough; the realm decides.
  for (const actorType of ["device", "admin", "", null, undefined]) {
    const result = evaluateIntentPolicy({ device: power, intent, ...(actorType === undefined ? {} : { actorType }) });
    assert.equal(result.allowed, false, `actorType ${JSON.stringify(actorType)}`);
    assert.equal(result.requiresApproval, undefined, "not a confirmation: nobody can approve a controller into it");
    assert.equal(result.risk, "blocked");
    assert.equal(result.matchedRule, "realm.standing-grant-owner-only");
  }
  // Nothing else reads actorType: the rest of the approval vocabulary is untouched by it.
  for (const decision of ["accept", "acceptForSession", "decline", "cancel"]) {
    assert.equal(evaluateIntentPolicy({ device: power, intent: { ...intent, decision }, actorType: "device" }).allowed, true, decision);
  }
});

test("acceptAlways escalates to owner confirmation under a medium ceiling, like the session grant", () => {
  const fromUntrusted = (decision) => evaluateIntentPolicy({
    device: { profile: "power-controller" },
    intent: { type: "approval_response", requestId: "req_1", decision },
    networkLocation: "untrusted",
    actorType: "user",
  });
  // An untrusted network caps automatic dispatch at low risk: refusing still lands.
  assert.equal(fromUntrusted("decline").allowed, true);
  for (const decision of ["acceptForSession", "acceptAlways"]) {
    const escalated = fromUntrusted(decision);
    assert.equal(escalated.allowed, false, decision);
    assert.equal(escalated.requiresApproval, true, decision);
    assert.equal(escalated.risk, "high", decision);
  }
  // Same on the free tier (medium ceiling).
  const free = evaluateIntentPolicy({
    device: { profile: "power-controller" },
    intent: { type: "approval_response", requestId: "req_1", decision: "acceptAlways" },
    subscriptionTier: "free",
    actorType: "user",
  });
  assert.equal(free.requiresApproval, true);
});

test("a viewer role cannot give either standing grant", () => {
  for (const decision of ["acceptForSession", "acceptAlways"]) {
    const result = evaluateIntentPolicy({
      device: { profile: "power-controller" },
      user: { role: "viewer" },
      intent: { type: "approval_response", requestId: "req_1", decision },
      actorType: "user",
    });
    assert.equal(result.allowed, false, decision);
    assert.equal(result.dimension, "user", decision);
  }
});

test("only power-controller carries the standing-grant capabilities", () => {
  for (const profile of ["next-coder", "read-only"]) {
    const capabilities = capabilitiesForProfile(profile);
    assert.equal(capabilities.has("approval_response_persistent"), false, profile);
    assert.equal(capabilities.has("approval_response_always"), false, profile);
  }
  const power = capabilitiesForProfile("power-controller");
  assert.equal(power.has("approval_response_persistent"), true);
  assert.equal(power.has("approval_response_always"), true);
});

// -- the routes ----------------------------------------------------------------

test("a controller is never listed, or able to give, acceptAlways, even on the console's own profile", async (t) => {
  // The request offers it, the device holds the broadest profile, and the detail is short.
  const h = await harness(t, {
    profile: "power-controller",
    activities: [directApproval("req_always", ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"])],
  });

  const listed = await h.call("/v1/device/approvals", { method: "GET", headers: h.deviceHeaders });
  assert.equal(listed.providerApprovals.length, 1);
  assert.equal(listed.providerApprovals[0].allowedDecisions.includes("acceptAlways"), false);
  assert.equal(listed.allowedDecisions.includes("acceptAlways"), false);
  // The view that reaches the panel carries no decision list of its own.
  assert.equal(listed.providerApprovals[0].offeredDecisions, undefined);

  const refused = await h.raw("/v1/device/provider-approvals/req_always", {
    method: "POST",
    headers: h.deviceHeaders,
    body: { decision: "acceptAlways" },
  });
  assert.equal(refused.status, 403);
  assert.equal(h.dispatches.length, 0, "nothing may reach the provider");

  // Refusal released the claim: an offered, permitted answer still goes through.
  const answered = await h.call("/v1/device/provider-approvals/req_always", {
    method: "POST",
    headers: h.deviceHeaders,
    body: { decision: "decline" },
  });
  assert.equal(answered.decision.decision, "decline");
  assert.equal(h.dispatches.length, 1);
});

test("a read-only or hardware profile cannot reach acceptAlways by any route", async (t) => {
  for (const profile of ["next-coder", "read-only"]) {
    await t.test(profile, async (subtest) => {
      const h = await harness(subtest, {
        profile,
        activities: [directApproval("req_always", ["accept", "acceptAlways", "decline", "cancel"])],
      });
      const refused = await h.raw("/v1/device/provider-approvals/req_always", {
        method: "POST",
        headers: h.deviceHeaders,
        body: { decision: "acceptAlways" },
      });
      assert.equal(refused.status, 403);
      assert.equal(h.dispatches.length, 0);
    });
  }
});

test("the console cannot send acceptAlways to a request that never offered it", async (t) => {
  // Default request: no `options`, so T3's own four. On Claude's adapter an unlisted acceptAlways
  // falls through to behavior "deny" while T3 itself accepts the dispatch — the owner's "allow"
  // would silently become a refusal. It must be refused here, before any claim or dispatch.
  const h = await harness(t, { profile: "power-controller" });

  const refused = await h.raw(`${h.approvalsPath}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { decision: "acceptAlways" },
  });
  assert.equal(refused.status, 422);
  const body = await refused.json();
  assert.match(body.error.message, /does not offer/u);
  assert.deepEqual(body.error.details.offeredDecisions, ["accept", "acceptForSession", "decline", "cancel"]);
  assert.equal(h.dispatches.length, 0);

  // Nothing was claimed: an offered answer still goes through.
  const answered = await h.call(`${h.approvalsPath}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { decision: "accept" },
  });
  assert.equal(answered.decision.decision, "accept");
  assert.equal(h.dispatches.length, 1);
});

test("the console list offers acceptAlways only on a request that lists it; a controller never sees it", async (t) => {
  const h = await harness(t, {
    profile: "power-controller",
    activities: [
      directApproval("req_always", ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]),
      approvalRequested("req_default", { id: "act_default", sequence: 2 }),
    ],
  });

  const listed = await h.call(h.approvalsPath, { method: "GET", headers: h.authHeaders });
  const byId = new Map(listed.approvals.map((approval) => [approval.requestId, approval]));
  assert.deepEqual(byId.get("req_always").allowedDecisions, PROVIDER_APPROVAL_DECISIONS);
  assert.deepEqual(byId.get("req_default").allowedDecisions, ["accept", "acceptForSession", "decline", "cancel"]);

  // The same request, same profile, through the device realm: realm is what withholds it.
  const device = await h.call("/v1/device/approvals", { method: "GET", headers: h.deviceHeaders });
  const deviceEntry = device.providerApprovals.find((entry) => entry.requestId === "req_always");
  assert.equal(deviceEntry.allowedDecisions.includes("acceptAlways"), false);
});

test("a controller cannot give acceptAlways through the generic device intent route either", async (t) => {
  // The generic route runs the same policy engine; the realm gate reads the actor, not the body.
  const h = await harness(t, {
    profile: "power-controller",
    activities: [directApproval("req_always", ["accept", "acceptAlways", "decline", "cancel"])],
  });
  const viaDeviceIntent = await h.raw("/v1/device/intents", {
    method: "POST",
    headers: h.deviceHeaders,
    body: {
      threadId: THREAD_ID,
      clientRequestId: "req_always_device_1",
      intent: { type: "approval_response", requestId: "req_always", decision: "acceptAlways" },
    },
  });
  assert.equal(viaDeviceIntent.status, 403);
  assert.equal(h.dispatches.length, 0, "a controller's intent must not reach the provider");
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
