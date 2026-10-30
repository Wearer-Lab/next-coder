import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildT3ProjectLaunchCommands, dispatchT3Command, fetchT3Snapshot, fetchT3ThreadDetail } from "../src/t3Client.mjs";
import { DirectT3Transport } from "../src/t3Transport.mjs";

const ENVIRONMENT = { baseUrl: "http://127.0.0.1:3773", accessToken: "test-access-token" };

// ---------------------------------------------------------------------------------------------
// Parity with the connector's copy of the protocol-2 projection.
//
// src/t3Protocol2.mjs is a deliberate duplicate of packages/connector/src/t3v2.mjs (they ship in
// different artifacts and cannot import one another). Everything after the marker line must be
// byte-identical, so a fix applied to one and forgotten in the other fails here.
// ---------------------------------------------------------------------------------------------
test("the gateway's protocol-2 projection is the connector's, byte for byte below its marker", async () => {
  const connector = await readFile(new URL("../packages/connector/src/t3v2.mjs", import.meta.url), "utf8");
  const gateway = await readFile(new URL("../src/t3Protocol2.mjs", import.meta.url), "utf8");
  const marker = "// ---- BEGIN COPY of packages/connector/src/t3v2.mjs (byte-identical below this line) ----\n";
  const at = gateway.indexOf(marker);
  assert.ok(at >= 0, "the copy marker line is missing from src/t3Protocol2.mjs");
  assert.ok(
    gateway.slice(at + marker.length) === connector,
    "src/t3Protocol2.mjs must carry the exact contents of packages/connector/src/t3v2.mjs below its marker line; update both together",
  );
});

// ---------------------------------------------------------------------------------------------
// A fake T3 0.1.x: descriptor, ticket, and an Effect-RPC socket that answers by tag. No HTTP
// orchestration route exists, as on the real server (docs/t3-version-audit.md T1): any request to
// /api/orchestration/* is a test failure.
// ---------------------------------------------------------------------------------------------
function fakeT3({ descriptor = { orchestrationProtocolVersion: 2 }, handlers = {} } = {}) {
  const sockets = [];
  const requests = [];
  const calls = [];

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      this.listeners = new Map();
      this.pending = [];
      this.latchOpen = true;
      sockets.push(this);
      queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(type, handler) {
      const existing = this.listeners.get(type) ?? [];
      existing.push(handler);
      this.listeners.set(type, existing);
    }

    emit(type, event) {
      for (const handler of this.listeners.get(type) ?? []) handler(event);
    }

    send(raw) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      if (message._tag === "Request") {
        requests.push(message);
        const handler = handlers[message.tag];
        if (!handler) {
          this.deliver({
            _tag: "Exit",
            requestId: message.id,
            exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: `Unknown request tag: ${message.tag}` }] },
          });
        } else handler(this, message);
      }
      if (message._tag === "Ack") {
        this.latchOpen = true;
        this.drain();
      }
    }

    push(...values) {
      this.pending.push(values);
      this.drain();
    }

    drain() {
      while (this.latchOpen && this.pending.length > 0) {
        this.latchOpen = false;
        this.deliver({ _tag: "Chunk", requestId: "1", values: this.pending.shift() });
      }
    }

    deliver(message) {
      if (!this.closed) this.emit("message", { data: JSON.stringify(message) });
    }

    exit(value) {
      this.deliver({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value } });
    }

    close() {
      this.closed = true;
    }
  }

  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, init });
    assert.ok(!path.startsWith("/api/orchestration/"), `protocol 2 must not touch ${path}`);
    if (path === "/.well-known/t3/environment") return Response.json(descriptor);
    if (path === "/api/auth/websocket-ticket") return Response.json({ ticket: "ticket-abc" });
    return new Response("missing", { status: 404 });
  };

  return {
    sockets,
    requests,
    calls,
    options: { fetchImpl, WebSocketImpl: FakeSocket, pingIntervalMs: 0 },
    dispatches: () => requests.filter((request) => request.tag === "orchestration.dispatchCommand").map((request) => request.payload),
    latest: () => sockets.at(-1),
  };
}

function settle(times = 6) {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index += 1) chain = chain.then(() => {});
  return chain;
}

async function until(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await settle(2);
  }
  assert.fail(`timed out waiting for ${label}`);
}

const SHELL_THREAD = {
  id: "thread_1",
  projectId: "project_1",
  title: "Fix the build",
  status: "idle",
  runtimeMode: "approval-required",
  modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  createdAt: "2026-10-30T10:00:00.000Z",
  updatedAt: "2026-10-30T10:05:00.000Z",
};

function threadProjection({ status = "running", messages = [{ id: "m1", text: "hello", streaming: false }], runtimeRequests = [], turnItems = [] } = {}) {
  return {
    thread: { ...SHELL_THREAD, status, activeRunId: status === "running" ? "run_7" : null },
    messages,
    runs: [{ id: "run_7", ordinal: 1, status }],
    runtimeRequests,
    turnItems,
  };
}

const shellHandler = (socket) => {
  // The identity-only snapshot (threads: []) is deliberately FIRST here: projecting it would
  // present an empty thread list as the truth.
  socket.push({
    kind: "snapshot",
    snapshot: { schemaVersion: 2, snapshotSequence: 9, projects: [{ id: "project_1" }], threads: [], archivedThreads: [] },
    resolvedRepositoryIdentityRoots: ["/work/app"],
  });
  socket.push({
    kind: "snapshot",
    snapshot: { schemaVersion: 2, snapshotSequence: 9, projects: [{ id: "project_1" }], threads: [SHELL_THREAD], archivedThreads: [] },
  });
};

const threadHandler = (projection) => (socket) => {
  socket.push({ kind: "snapshot", snapshotSequence: 12, projection });
};

// ---------------------------------------------------------------------------------------------
// Snapshot, thread detail
// ---------------------------------------------------------------------------------------------

test("the snapshot comes from subscribeShell on protocol 2 and keeps the {projects, threads} reader shape", async () => {
  const t3 = fakeT3({ handlers: { "orchestration.subscribeShell": shellHandler } });
  const snapshot = await fetchT3Snapshot(ENVIRONMENT, t3.options);

  assert.equal(snapshot.snapshotSequence, 9);
  assert.deepEqual(snapshot.projects, [{ id: "project_1" }]);
  assert.equal(snapshot.threads.length, 1);
  assert.equal(snapshot.threads[0].id, "thread_1");
  // The reader's `session` is derived, not passed through: status "idle" is "ready", no active turn.
  assert.equal(snapshot.threads[0].session.status, "ready");
  assert.equal(snapshot.threads[0].session.activeTurnId, null);
  // Shell threads carry no message bodies on protocol 2, as the protocol-1 snapshot never did.
  assert.equal("messages" in snapshot.threads[0], false);

  assert.equal(new URL(t3.latest().url).searchParams.get("orchestrationProtocol"), "2");
  assert.equal(t3.requests[0].tag, "orchestration.subscribeShell");
  assert.deepEqual(t3.requests[0].payload, {});
  // Ack, then Interrupt: the subscription never completes by itself.
  assert.deepEqual(t3.latest().sent.map((message) => message._tag), ["Request", "Ack", "Ack", "Interrupt"]);
});

test("thread detail is the first bounded subscribeThread snapshot, returned as the thread itself", async () => {
  const t3 = fakeT3({ handlers: { "orchestration.subscribeThread": threadHandler(threadProjection()) } });
  const thread = await fetchT3ThreadDetail(ENVIRONMENT, "thread_1", { ...t3.options, turnLimit: 1 });

  assert.equal(thread.id, "thread_1");
  assert.deepEqual(thread.messages, [{ id: "m1", text: "hello", streaming: false }]);
  assert.equal(thread.session.status, "running");
  assert.equal(thread.session.activeTurnId, "run_7", "run ids replace legacy active-turn ids");
  assert.deepEqual(t3.requests[0].payload, { threadId: "thread_1", acceptBoundedSnapshot: true });
  assert.equal("thread" in thread && thread.thread !== undefined, false, "no {thread} envelope");
  assert.deepEqual(t3.latest().sent.map((message) => message._tag), ["Request", "Ack", "Interrupt"]);
});

test("pending approvals are synthesised from runtime requests for the existing readers", async () => {
  const projection = threadProjection({
    runtimeRequests: [{ id: "req_1", status: "pending", createdAt: "2026-10-30T10:06:00.000Z" }],
    turnItems: [{ type: "approval_request", requestId: "req_1", requestKind: "command", prompt: "Run ls?" }],
  });
  const t3 = fakeT3({ handlers: { "orchestration.subscribeThread": threadHandler(projection) } });
  const thread = await fetchT3ThreadDetail(ENVIRONMENT, "thread_1", t3.options);
  assert.equal(thread.activities.length, 1);
  assert.equal(thread.activities[0].kind, "approval.requested");
  assert.equal(thread.activities[0].payload.requestId, "req_1");
});

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

const ack = (socket) => socket.exit({ sequence: 100 });

test("a turn start is three dispatches: thread modes first, then message.dispatch carrying modelSelection.options", async () => {
  const t3 = fakeT3({ handlers: { "orchestration.dispatchCommand": ack } });
  const options = [{ id: "reasoningEffort", value: "high" }];
  const result = await dispatchT3Command(ENVIRONMENT, {
    type: "thread.turn.start",
    commandId: "cmd_1",
    threadId: "thread_1",
    message: { messageId: "msg_1", role: "user", text: "Run the tests.", attachments: [] },
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol", options },
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: "2026-10-30T10:00:00.000Z",
  }, t3.options);

  assert.deepEqual(result, { sequence: 100 });
  const [runtime, interaction, message] = t3.dispatches();
  assert.deepEqual(runtime, {
    type: "thread.runtime-mode.set", commandId: "cmd_1:runtime-mode", threadId: "thread_1", runtimeMode: "approval-required",
  });
  assert.deepEqual(interaction, {
    type: "thread.interaction-mode.set", commandId: "cmd_1:interaction-mode", threadId: "thread_1", interactionMode: "default",
  });
  assert.equal(message.type, "message.dispatch");
  assert.equal(message.commandId, "cmd_1");
  assert.equal(message.messageId, "msg_1");
  assert.equal(message.text, "Run the tests.");
  assert.deepEqual(message.dispatchMode, { type: "start_immediately" });
  // Per-model provider switches (reasoning effort) must survive the move off the HTTP route.
  assert.deepEqual(message.modelSelection, { instanceId: "codex", model: "gpt-5.6-sol", options });
  // The legacy command's own fields are not smuggled onto the v2 command.
  assert.equal("runtimeMode" in message, false);
  assert.equal("message" in message, false);
});

test("a project launch dispatches thread.create then the first turn, options intact", async () => {
  const t3 = fakeT3({ handlers: { "orchestration.dispatchCommand": ack } });
  const modelSelection = { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "max" }] };
  const launch = buildT3ProjectLaunchCommands({
    project: { id: "project_1", defaultModelSelection: modelSelection },
    text: "Start here",
    threadId: "thread_new",
  });
  await dispatchT3Command(ENVIRONMENT, launch.createThread, t3.options);
  await dispatchT3Command(ENVIRONMENT, launch.startTurn, t3.options);

  const dispatches = t3.dispatches();
  assert.equal(dispatches[0].type, "thread.create");
  assert.equal(dispatches[0].createdBy, "user");
  assert.equal(dispatches[0].creationSource, "server");
  assert.equal(dispatches[0].threadId, "thread_new");
  assert.deepEqual(dispatches[0].modelSelection, modelSelection);
  assert.equal(dispatches.at(-1).type, "message.dispatch");
  assert.deepEqual(dispatches.at(-1).modelSelection, modelSelection);
});

test("an interrupt reads the thread for its active run id, and refuses when nothing is running", async () => {
  const running = fakeT3({
    handlers: {
      "orchestration.subscribeThread": threadHandler(threadProjection({ status: "running" })),
      "orchestration.dispatchCommand": ack,
    },
  });
  await dispatchT3Command(ENVIRONMENT, { type: "thread.turn.interrupt", commandId: "cmd_i", threadId: "thread_1" }, running.options);
  assert.deepEqual(running.dispatches(), [{ commandId: "cmd_i", threadId: "thread_1", type: "run.interrupt", runId: "run_7" }]);
  assert.equal(running.calls.filter((call) => call.path === "/.well-known/t3/environment").length, 1, "the pinned protocol is not re-read");

  const idle = fakeT3({
    handlers: {
      "orchestration.subscribeThread": threadHandler(threadProjection({ status: "idle" })),
      "orchestration.dispatchCommand": ack,
    },
  });
  await assert.rejects(
    () => dispatchT3Command(ENVIRONMENT, { type: "thread.turn.interrupt", commandId: "cmd_i", threadId: "thread_1" }, idle.options),
    (error) => error.code === "T3_NO_ACTIVE_RUN",
  );
  assert.deepEqual(idle.dispatches(), [], "nothing is dispatched on a guess");
});

test("session stop and the two request answers map onto the protocol-2 command names", async () => {
  const t3 = fakeT3({ handlers: { "orchestration.dispatchCommand": ack } });
  await dispatchT3Command(ENVIRONMENT, { type: "thread.session.stop", commandId: "c1", threadId: "thread_1" }, t3.options);
  await dispatchT3Command(ENVIRONMENT, {
    type: "thread.approval.respond", commandId: "c2", threadId: "thread_1", requestId: "req_1", decision: "accept",
  }, t3.options);
  await dispatchT3Command(ENVIRONMENT, {
    type: "thread.user-input.respond", commandId: "c3", threadId: "thread_1", requestId: "req_2", answers: { q: "a" },
  }, t3.options);
  assert.deepEqual(t3.dispatches(), [
    { commandId: "c1", threadId: "thread_1", type: "thread.stop" },
    { commandId: "c2", threadId: "thread_1", type: "runtime-request.respond", requestId: "req_1", decision: "accept" },
    { commandId: "c3", threadId: "thread_1", type: "runtime-request.respond", requestId: "req_2", answers: { q: "a" } },
  ]);
});

test("a command protocol 2 has no mapping for is refused, not sent", async () => {
  const t3 = fakeT3({ handlers: { "orchestration.dispatchCommand": ack } });
  await assert.rejects(
    () => dispatchT3Command(ENVIRONMENT, { type: "runtime.session.import", commandId: "c", threadId: "t" }, t3.options),
    (error) => error.code === "T3_V2_COMMAND_UNSUPPORTED",
  );
  assert.deepEqual(t3.dispatches(), []);
});

// ---------------------------------------------------------------------------------------------
// Protocol selection
// ---------------------------------------------------------------------------------------------

test("protocol 1 keeps the HTTP routes and never opens a socket", async () => {
  const urls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    urls.push(`${init.method ?? "GET"} ${path}`);
    if (path === "/.well-known/t3/environment") return Response.json({ serverVersion: "0.0.32" });
    if (path === "/api/orchestration/snapshot") return Response.json({ snapshotSequence: 3, projects: [], threads: [] });
    if (path === "/api/orchestration/threads/thread_1") return Response.json({ thread: { id: "thread_1" } });
    if (path === "/api/orchestration/dispatch") return Response.json({ sequence: 4 });
    return new Response("missing", { status: 404 });
  };
  const WebSocketImpl = class { constructor() { throw new Error("protocol 1 must not open a socket"); } };
  const options = { fetchImpl, WebSocketImpl };

  assert.deepEqual(await fetchT3Snapshot(ENVIRONMENT, options), { snapshotSequence: 3, projects: [], threads: [] });
  assert.deepEqual(await fetchT3ThreadDetail(ENVIRONMENT, "thread_1", options), { id: "thread_1" });
  assert.deepEqual(await dispatchT3Command(ENVIRONMENT, { type: "thread.session.stop", commandId: "c" }, options), { sequence: 4 });
  assert.ok(urls.includes("GET /api/orchestration/snapshot"));
  assert.ok(urls.includes("POST /api/orchestration/dispatch"));
});

test("a protocol neither path implements fails closed before any authenticated request", async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ path: new URL(String(url)).pathname, headers: init.headers });
    return Response.json({ orchestrationProtocolVersion: 3 });
  };
  const options = { fetchImpl, WebSocketImpl: class { constructor() { throw new Error("must not open"); } } };
  for (const call of [
    () => fetchT3Snapshot(ENVIRONMENT, options),
    () => fetchT3ThreadDetail(ENVIRONMENT, "thread_1", options),
    () => dispatchT3Command(ENVIRONMENT, { type: "thread.session.stop", commandId: "c" }, options),
  ]) {
    await assert.rejects(call, (error) => error.code === "T3_PROTOCOL_UNSUPPORTED" && error.status === 426);
  }
  assert.ok(seen.every((request) => request.path === "/.well-known/t3/environment" && !request.headers));
});

test("the direct transport reads the descriptor once for a run of protocol-2 calls", async () => {
  const t3 = fakeT3({ handlers: { "orchestration.subscribeShell": shellHandler, "orchestration.dispatchCommand": ack } });
  const transport = new DirectT3Transport();
  await transport.snapshot(ENVIRONMENT, t3.options);
  await transport.snapshot(ENVIRONMENT, t3.options);
  await transport.dispatch(ENVIRONMENT, { type: "thread.session.stop", commandId: "c", threadId: "t" }, t3.options);
  assert.equal(t3.calls.filter((call) => call.path === "/.well-known/t3/environment").length, 1);
});

// ---------------------------------------------------------------------------------------------
// Live stream through the direct transport
// ---------------------------------------------------------------------------------------------

function streamEvent(sequence, type, payload) {
  return { kind: "event", sequence, event: { id: `evt_${sequence}`, threadId: "thread_1", occurredAt: "2026-10-30T10:10:00.000Z", type, payload } };
}

test("a protocol-2 stream reaches the hub as protocol-1 items: absolute text becomes a suffix delta", async () => {
  const t3 = fakeT3({ handlers: { "orchestration.subscribeThread": () => {} } });
  const transport = new DirectT3Transport();
  const items = [];
  const closes = [];
  transport.openThreadStream(ENVIRONMENT, {
    threadId: "thread_1",
    afterSequence: 99,
    onItem: (item) => items.push(item),
    onClose: (info) => closes.push(info),
  }, t3.options);
  await until(() => t3.requests.length === 1, "the request frame");
  // Never resumed: a coalesced replay has no snapshot to rebuild a thread from.
  assert.equal("afterSequence" in t3.requests[0].payload, false);

  const socket = t3.latest();
  socket.push({ kind: "snapshot", snapshotSequence: 12, projection: threadProjection({ messages: [{ id: "m2", text: "Hel", streaming: true }] }) });
  socket.push({ kind: "synchronized" });
  socket.push(streamEvent(13, "message.updated", { id: "m2", text: "Hello", streaming: true }));
  socket.push(streamEvent(14, "message.updated", { id: "m2", text: "Hello world", streaming: false }));
  await until(() => items.length === 4, "projected items");

  assert.equal(items[0].kind, "snapshot");
  assert.equal(items[0].snapshot.thread.id, "thread_1", "protocol-1 snapshot shape");
  assert.equal(items[1].kind, "synchronized");
  assert.equal(items[2].event.type, "thread.message-sent");
  assert.equal(items[2].event.payload.text, "lo", "only the streaming suffix is a delta");
  assert.equal(items[3].event.payload.text, "Hello world", "a terminal frame carries the whole body");
  assert.equal(items[3].event.sequence, 14);
  assert.deepEqual(closes, []);
});

test("text that does not extend what was shown resets the stream instead of corrupting it", async () => {
  const t3 = fakeT3({ handlers: { "orchestration.subscribeThread": () => {} } });
  const items = [];
  const closes = [];
  new DirectT3Transport().openThreadStream(ENVIRONMENT, {
    threadId: "thread_1",
    onItem: (item) => items.push(item),
    onClose: (info) => closes.push(info),
  }, t3.options);
  await until(() => t3.requests.length === 1, "the request frame");
  const socket = t3.latest();
  socket.push({ kind: "snapshot", snapshotSequence: 12, projection: threadProjection({ messages: [{ id: "m2", text: "Hello", streaming: true }] }) });
  socket.push(streamEvent(13, "message.updated", { id: "m2", text: "Goodbye", streaming: true }));
  await until(() => closes.length === 1, "a reset");

  assert.equal(closes[0].reason, "protocol-reset");
  assert.equal(closes[0].error.code, "T3_STREAM_RESET_REQUIRED");
  assert.equal(items.length, 1, "the divergent update is never delivered as a fake delta");
  assert.ok(socket.sent.some((message) => message._tag === "Interrupt"), "the server fiber is interrupted");
});

test("protocol-1 stream items pass through the direct transport untouched", async () => {
  const t3 = fakeT3({ descriptor: {}, handlers: { "orchestration.subscribeThread": () => {} } });
  const items = [];
  new DirectT3Transport().openThreadStream(ENVIRONMENT, {
    threadId: "thread_1",
    afterSequence: 5,
    onItem: (item) => items.push(item),
  }, t3.options);
  await until(() => t3.requests.length === 1, "the request frame");
  assert.equal(t3.requests[0].payload.afterSequence, 5, "protocol 1 still resumes");
  const legacy = { kind: "event", event: { sequence: 6, type: "thread.message-sent", payload: { text: "x" } } };
  t3.latest().push(legacy);
  await until(() => items.length === 1, "the item");
  assert.deepEqual(items[0], legacy);
});
