import "./support/closeEvent.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createV2StreamProjection, v2Command, v2Shell, v2Thread } from "../src/t3v2.mjs";
import { createT3Client, exchangePairingToken } from "../src/t3.mjs";
import { collectProviderApprovals } from "../../../src/providerApprovals.mjs";
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

test("pairing requests the permission vocabulary of the advertised T3 protocol", async () => {
  for (const orchestrationProtocolVersion of [1, 2]) {
    let scope;
    const result = await exchangePairingToken({ baseUrl: "http://127.0.0.1:3774", pairingToken: "fixture",
      orchestrationProtocolVersion, fetchImpl: async (_url, options) => {
        scope = options.body.get("scope");
        return Response.json({ access_token: "fixture_access" });
      } });
    assert.equal(result.access_token, "fixture_access");
    assert.equal(scope, `orchestration:read orchestration:${orchestrationProtocolVersion === 2 ? "operate" : "write"} terminal:operate`);
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
