import "./support/closeEvent.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createV2StreamProjection, v2Command, v2OfferedDecisions, v2Shell, v2Thread } from "../src/t3v2.mjs";
import { createT3Client, exchangePairingToken } from "../src/t3.mjs";
import {
  PROVIDER_APPROVAL_DECISIONS,
  allowedProviderApprovalDecisions,
  collectProviderApprovals,
} from "../../../src/providerApprovals.mjs";
import { capabilitiesForProfile } from "../../../src/profiles.mjs";
import { collectUserInputRequests } from "../../../src/userInput.mjs";

// Deterministic contract fixtures: public v0.1.1 orchestrationV2.ts wire fields, no live user data.
const date = "2026-10-22T12:00:00.000Z";
const thread = { id: "thread_contract", projectId: "project_contract", title: "Contract thread",
  modelSelection: { instanceId: "codex", model: "model_contract" }, runtimeMode: "approval-required",
  providerInstanceId: "codex", createdAt: date, updatedAt: date };
const message = { id: "message_contract", threadId: thread.id, role: "assistant", text: "hello",
  streaming: true, createdAt: date, updatedAt: date, attachments: [] };
const projection = () => ({ thread, messages: [], runs: [], runtimeRequests: [], turnItems: [] });
const snapshot = (value = projection()) => ({ kind: "snapshot", snapshotSequence: 4, projection: value });
const event = (sequence, type, payload) => ({ kind: "event", sequence,
  event: { id: "event_" + sequence, threadId: thread.id, occurredAt: date, type, payload } });

test("pairing requests the same real T3 scopes on both protocols", async () => {
  for (const orchestrationProtocolVersion of [1, 2]) {
    let scope;
    const result = await exchangePairingToken({ baseUrl: "http://127.0.0.1:3774", pairingToken: "fixture",
      orchestrationProtocolVersion, fetchImpl: async (_url, options) => {
        scope = options.body.get("scope");
        return Response.json({ access_token: "fixture_access" });
      } });
    assert.equal(result.access_token, "fixture_access");
    // `orchestration:write` is not a T3 scope at any version (docs/t3-version-audit.md M7); both protocols ask for operate.
    assert.equal(scope, "orchestration:read orchestration:operate terminal:operate");
  }
});

test("v2 shell remains bodiless and thread projection never treats streaming text as a finished reply", () => {
  const shell = v2Shell({ projects: [], threads: [{ ...thread, status: "running", activeRunId: "run_1" }], snapshotSequence: 4 });
  assert.equal(shell.threads[0].session.activeTurnId, "run_1");
  assert.equal(shell.threads[0].messages, undefined);
  const detail = v2Thread({ ...projection(), messages: [message], runs: [{ id: "run_1", ordinal: 1, status: "running" }] });
  assert.equal(detail.messages[0].streaming, true);
  assert.equal(detail.session.status, "running");
  assert.throws(() => v2Shell({ projects: [], threads: Array(2049).fill(thread) }), { code: "T3_SNAPSHOT_LIMIT" });
});

test("v2 dispatch preserves identities, permission semantics, approvals and user-input answers", () => {
  const id = { commandId: "command_contract", threadId: thread.id };
  assert.deepEqual(v2Command({ ...id, type: "thread.turn.start", message: {
    messageId: "message_user", text: "Read only", attachments: [],
  } }), { ...id, type: "message.dispatch", createdBy: "user", creationSource: "server",
    messageId: "message_user", text: "Read only", attachments: [], dispatchMode: { type: "start_immediately" } });
  assert.equal(v2Command({ ...id, type: "thread.session.stop" }).type, "thread.stop");
  assert.throws(() => v2Command({ ...id, type: "thread.turn.interrupt" }), { code: "T3_NO_ACTIVE_RUN" });
  assert.deepEqual(v2Command({ ...id, type: "thread.turn.interrupt", runId: "run_1" }), { ...id, type: "run.interrupt", runId: "run_1" });
  assert.deepEqual(v2Command({ ...id, type: "thread.approval.respond", requestId: "request_1", decision: "decline" }),
    { ...id, type: "runtime-request.respond", requestId: "request_1", decision: "decline" });
  assert.deepEqual(v2Command({ ...id, type: "thread.user-input.respond", requestId: "request_2", answers: { choice: "A" } }).answers, { choice: "A" });
  assert.throws(() => v2Command({ ...id, type: "invented.command" }), { code: "T3_V2_COMMAND_UNSUPPORTED" });
});

test("v2 absolute streaming replacements become deltas, replay is deduplicated, and corrections require a fresh snapshot", () => {
  const project = createV2StreamProjection();
  const first = project(snapshot({ ...projection(), messages: [message] }));
  assert.equal(first[0].snapshot.thread.messages[0].text, "hello");
  assert.equal(project(event(5, "message.updated", { ...message, text: "hello there" }))[0].event.payload.text, " there");
  assert.deepEqual(project(event(5, "message.updated", { ...message, text: "hello there" })), []);
  assert.equal(project(event(6, "message.updated", { ...message, text: "hello there", streaming: false }))[0].event.payload.streaming, false);
  project(event(7, "message.updated", message));
  assert.throws(() => project(event(8, "message.updated", { ...message, text: "replaced" })), { code: "T3_STREAM_RESET_REQUIRED" });
  assert.throws(() => project(event(9, "message.updated", { ...message, text: "hello" + "x".repeat(256 * 1024) })), { code: "T3_STREAM_RESET_REQUIRED" });
});

test("v2 provider approval, user input and expired requests retain separate gateway projections", () => {
  const request = (id, kind, status = "pending") => ({ id, kind, status, createdAt: date, resolvedAt: null });
  const p = { ...projection(),
    runtimeRequests: [request("approval_1", "command"), request("input_1", "user_input"), request("expired_1", "user_input", "expired")],
    turnItems: [
      { type: "approval_request", requestId: "approval_1", requestKind: "command", prompt: "Permit command?" },
      { type: "user_input_request", requestId: "input_1", questions: [{ id: "choice", header: "Choice", question: "Choose", options: [] }] },
      { type: "user_input_request", requestId: "expired_1", questions: [] },
    ],
  };
  const result = v2Thread(p);
  assert.equal(collectProviderApprovals(result).filter((v) => v.status === "pending").length, 1);
  assert.equal(collectUserInputRequests(result).filter((v) => v.status === "pending").length, 1);
});

test("v2 client negotiates the socket, cancels snapshot subscriptions and sets permission mode before a turn", async () => {
  const sockets = [];
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; this.sent = []; sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send(raw) {
      const frame = JSON.parse(raw); this.sent.push(frame);
      if (frame._tag !== "Request") return;
      const reply = frame.tag === "orchestration.subscribeShell"
        ? { _tag: "Chunk", requestId: "1", values: [{ kind: "snapshot", snapshot: { snapshotSequence: 1, projects: [], threads: [] } }] }
        : { _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: { accepted: true } } };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(reply) })));
    }
    close() {}
  }
  const client = createT3Client({ baseUrl: "http://127.0.0.1:3774", accessToken: "fixture_token", WebSocketImpl: Socket,
    fetchImpl: async (url) => Response.json(String(url).includes("well-known")
      ? { serverVersion: "0.1.1", orchestrationProtocolVersion: 2 } : { ticket: "fixture_ticket" }) });
  await client.environmentInfo();
  assert.deepEqual((await client.snapshot()).threads, []);
  assert.equal(new URL(sockets[0].url).searchParams.get("orchestrationProtocol"), "2");
  assert.deepEqual(sockets[0].sent.map((f) => f._tag), ["Request", "Ack", "Interrupt"]);
  await client.dispatch({ type: "thread.turn.start", commandId: "cmd_1", threadId: thread.id,
    runtimeMode: "approval-required", message: { messageId: "msg_1", text: "hello" } });
  const commands = sockets.slice(1).flatMap((s) => s.sent.filter((f) => f._tag === "Request").map((f) => f.payload));
  assert.deepEqual(commands.map((c) => c.type), ["thread.runtime-mode.set", "message.dispatch"]);
  assert.equal(commands[0].runtimeMode, "approval-required");
  assert.equal(commands[1].commandId, "cmd_1");
});

// -- T3 0.1.x per-request `options[]` -------------------------------------------------------------
// Shapes below are the ones the 0.1.5 adapters build (docs/t3-version-audit.md section 5):
//   Claude, CLI refuses a standing rule   CLAUDE_NO_STANDING_GRANT_OPTIONS  decline, accept
//   Codex MCP elicitation w/ persistence  describeMcpElicitation            cancel, decline, acceptForSession?, acceptAlways?, accept
//   everything else                       no `options` at all (T3's UI then draws its own four)

const approvalProjection = (item, request = {}) => ({ ...projection(),
  runtimeRequests: [{ id: "approval_1", kind: "command", status: "pending", createdAt: date, resolvedAt: null, ...request }],
  turnItems: [{ type: "approval_request", requestId: "approval_1", requestKind: "command", prompt: "Permit?", ...item }] });
const requested = (result) => result.activities.find((activity) => activity.kind === "approval.requested");

test("a request's own options[] reaches the gateway's offeredDecisions, in the gateway's vocabulary", () => {
  const options = [
    { decision: "cancel", label: "Cancel" }, { decision: "decline", label: "Decline" },
    { decision: "acceptAlways", label: "Always allow", warning: "Writes a permanent rule." }, { decision: "accept", label: "Approve" },
  ];
  const result = v2Thread(approvalProjection({ requestKind: "mcp-elicitation", options }));
  assert.deepEqual(requested(result).payload.decisions, ["cancel", "decline", "acceptAlways", "accept"]);
  // Nothing but vocabulary rode along: no label, no warning, no provider prose.
  assert.deepEqual(Object.keys(requested(result).payload).sort(), ["decisions", "detail", "requestId", "requestKind"]);
  assert.equal(JSON.stringify(requested(result)).includes("permanent rule"), false);

  const [approval] = collectProviderApprovals(result);
  assert.deepEqual(approval.offeredDecisions, ["cancel", "decline", "acceptAlways", "accept"]);
  assert.equal(approval.requestKind, "mcp-elicitation");

  // Narrowing therefore applies to a T3 approval exactly as it does to a native one: the owner
  // (and only the owner) is offered the standing grant, because THIS request lists it.
  const power = capabilitiesForProfile("power-controller");
  assert.deepEqual(allowedProviderApprovalDecisions(power, approval, { realm: "user" }), ["accept", "acceptAlways", "decline", "cancel"]);
  assert.deepEqual(allowedProviderApprovalDecisions(power, approval, { realm: "device" }), ["accept", "decline", "cancel"]);
  assert.deepEqual(allowedProviderApprovalDecisions(power, approval), ["accept", "decline", "cancel"]);
});

test("a Claude request that refuses a standing rule offers only decline and accept, end to end", () => {
  const [approval] = collectProviderApprovals(v2Thread(approvalProjection({
    options: [{ decision: "decline", label: "Decline" }, { decision: "accept", label: "Approve" }],
  })));
  assert.deepEqual(approval.offeredDecisions, ["decline", "accept"]);
  const power = capabilitiesForProfile("power-controller");
  // The console profile could have given acceptForSession; this request does not offer it.
  assert.deepEqual(allowedProviderApprovalDecisions(power, approval, { realm: "user" }), ["accept", "decline"]);
});

test("a request with no options[] states nothing, so the gateway applies T3's default four", () => {
  const result = v2Thread(approvalProjection({}));
  assert.equal("decisions" in requested(result).payload, false);
  const [approval] = collectProviderApprovals(result);
  assert.equal(approval.offeredDecisions, null);
  assert.deepEqual(
    allowedProviderApprovalDecisions(capabilitiesForProfile("power-controller"), approval, { realm: "user" }),
    ["accept", "acceptForSession", "decline", "cancel"],
    "acceptAlways must not appear on a request that never listed it",
  );
  // Not an array is not a statement either.
  for (const options of [null, "accept", { decision: "accept" }, 7]) {
    assert.equal(v2OfferedDecisions(options), undefined, JSON.stringify(options));
  }
});

test("options are sanitised at the boundary: strings only, bounded, de-duplicated, closed table", () => {
  const entry = (decision) => ({ decision, label: "x" });
  assert.deepEqual(v2OfferedDecisions([entry("accept"), entry("accept"), entry("decline"), entry("accept")]), ["accept", "decline"]);
  // Unknown spellings, non-strings, junk entries and inherited property names are dropped.
  assert.deepEqual(
    v2OfferedDecisions([entry("approve"), entry("ACCEPT"), entry(" accept"), entry(7), entry(null), entry({}), entry("constructor"),
      entry("__proto__"), entry("toString"), null, "accept", 3, [], { label: "no decision" }, entry("cancel")]),
    ["cancel"],
  );
  // The scan is bounded: a recognised value beyond the cap is not read.
  assert.deepEqual(v2OfferedDecisions([...Array(16).fill(entry("nope")), entry("accept")]), ["decline", "cancel"]);
  // An over-long value is not looked up at all.
  assert.deepEqual(v2OfferedDecisions([entry("accept".padEnd(10_000, "x"))]), ["decline", "cancel"]);
  // Source order is preserved (the gateway re-sorts by catalogue order when it builds buttons).
  assert.deepEqual(v2OfferedDecisions([entry("cancel"), entry("accept")]), ["cancel", "accept"]);
});

test("a list with nothing usable offers refusals only, never nothing and never a grant", () => {
  // Offering nothing would strand an agent blocked on the owner; falling back to the default set
  // would hand out a grant the provider never listed. Refusals grant nothing whatever the list meant.
  for (const options of [[], [{ decision: "somethingNew" }], [null, 3, "accept"]]) {
    assert.deepEqual(v2OfferedDecisions(options), ["decline", "cancel"], JSON.stringify(options));
  }
  const [approval] = collectProviderApprovals(v2Thread(approvalProjection({ options: [{ decision: "somethingNew" }] })));
  assert.deepEqual(approval.offeredDecisions, ["decline", "cancel"]);
  assert.deepEqual(
    allowedProviderApprovalDecisions(capabilitiesForProfile("power-controller"), approval, { realm: "user" }),
    ["decline", "cancel"],
  );
});

test("the connector's decision table is pinned to the gateway's vocabulary", () => {
  // The npm package cannot import the gateway, so it carries a copy; this is what keeps the copy honest.
  assert.deepEqual(
    v2OfferedDecisions(PROVIDER_APPROVAL_DECISIONS.map((decision) => ({ decision, label: decision }))),
    [...PROVIDER_APPROVAL_DECISIONS],
  );
  // And a decision answered with acceptAlways is passed to T3 unchanged (it is a valid wire value).
  assert.equal(v2Command({ commandId: "c", threadId: "t", type: "thread.approval.respond", requestId: "r", decision: "acceptAlways" }).decision, "acceptAlways");
});

test("options on a streamed turn item update the approval, and a resolved one carries the new decision", () => {
  const project = createV2StreamProjection();
  project(snapshot());
  const pending = { id: "approval_1", kind: "command", status: "pending", createdAt: date, resolvedAt: null };
  // The request alone has no item to pair with yet, so there is nothing to publish.
  assert.deepEqual(project(event(5, "runtime-request.updated", pending)), []);
  const out = project(event(6, "turn-item.updated", { type: "approval_request", requestId: "approval_1", requestKind: "command",
    prompt: "Permit?", options: [{ decision: "accept", label: "Approve" }, { decision: "acceptAlways", label: "Always" }] }));
  assert.equal(out.length, 1);
  assert.equal(out[0].event.type, "thread.activity-appended");
  assert.deepEqual(out[0].event.payload.activity.payload.decisions, ["accept", "acceptAlways"]);

  const resolved = project(event(7, "runtime-request.updated", { ...pending, status: "resolved", resolvedAt: date, decision: "acceptAlways" }));
  assert.equal(resolved[0].event.payload.activity.kind, "approval.resolved");
  assert.equal(resolved[0].event.payload.activity.payload.decision, "acceptAlways");
});

test("an expired approval is stale whatever options it carried; questions never grow a decisions field", () => {
  const expired = collectProviderApprovals(v2Thread(approvalProjection(
    { options: [{ decision: "accept", label: "Approve" }] }, { status: "expired", resolvedAt: date })));
  assert.equal(expired[0].status, "stale");
  const question = v2Thread({ ...projection(),
    runtimeRequests: [{ id: "input_1", kind: "user_input", status: "pending", createdAt: date, resolvedAt: null }],
    turnItems: [{ type: "user_input_request", requestId: "input_1", questions: [], options: [{ decision: "accept" }] }] });
  assert.equal("decisions" in question.activities[0].payload, false);
});
