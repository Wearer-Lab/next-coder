import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectAgentRuntime, validateAgentConfig } from "../src/agents/runtime.mjs";
import { ConnectorClient } from "../src/connector.mjs";

async function fixture(t, adapterOverride) {
  const stateDir = await mkdtemp(join(tmpdir(), "next-coder-agents-test-"));
  const calls = []; let stop;
  const adapter = {
    models: async () => [{ id: "default", label: "Mock default" }],
    list: async () => ({ sessions: [{ id: "saved-session", title: "Saved fixture", cwd: stateDir, attachment: "resume" }], nextCursor: null }),
    history: async () => [{ role: "user", text: "Earlier task" }, { role: "assistant", text: "Earlier result" }],
    async run(input) { calls.push(input); await input.onNativeId(`native-${calls.length}`); input.onText("Fixture response"); },
    interrupt: async () => stop?.(), close: () => stop?.(), ...adapterOverride,
  };
  const config = { agents: [{ id: "codex", kind: "codex" }, { id: "claude", kind: "claude" }], projects: [{ id: "project", cwd: stateDir }] };
  const runtime = await new DirectAgentRuntime({ config, stateDir, adapterFactory: () => adapter }).initialize();
  t.after(async () => { await runtime.close(); await rm(stateDir, { recursive: true, force: true }); });
  const dispatch = (type, extra = {}) => runtime.dispatch({ type, commandId: `cmd-${crypto.randomUUID()}`, threadId: "thread", ...extra });
  await dispatch("thread.create", { projectId: "project", title: "Fixture", modelSelection: { instanceId: "codex", model: "default" } });
  return { runtime, calls, config, stateDir, dispatch, setStop: (fn) => { stop = fn; } };
}
async function settled(runtime) { while (runtime.active.size) await Promise.allSettled([...runtime.active.values()].map((a) => a.done)); }
const prompt = (text) => ({ message: { messageId: crypto.randomUUID(), text } });

test("direct runtime keeps T3 optional, exposes compact shells and sends delta context on provider return", async (t) => {
  const { runtime, calls, dispatch, stateDir } = await fixture(t);
  await dispatch("thread.turn.start", prompt("First request")); await settled(runtime);
  await dispatch("thread.model-selection.set", { modelSelection: { instanceId: "claude", model: "default" } });
  await dispatch("thread.turn.start", prompt("Second request")); await settled(runtime);
  assert.match(calls[1].prompt, /First request/);
  await dispatch("thread.model-selection.set", { modelSelection: { instanceId: "codex", model: "default" } });
  await dispatch("thread.turn.start", prompt("Third request")); await settled(runtime);
  assert.match(calls[2].prompt, /Second request/); assert.doesNotMatch(calls[2].prompt, /First request/);
  assert.equal(calls[2].nativeId, "native-1");
  const shell = await runtime.snapshot(); assert.equal(shell.threads[0].messages, undefined); assert.equal(shell.threads[0].bindings, undefined);
  assert.equal((await runtime.threadDetail("thread")).messages.at(-1).streaming, false);
  const stored = await readFile(join(stateDir, "agent-conversations.json"), "utf8");
  assert.equal(JSON.parse(stored).receipts.some((r) => "prompt" in r), false);
  assert.equal((await stat(join(stateDir, "agent-conversations.json"))).mode & 0o077, 0);
});

test("durable command ids do not replay a turn and reject conflicting payloads", async (t) => {
  const { runtime, calls } = await fixture(t);
  const command = { type: "thread.turn.start", commandId: "stable-command", threadId: "thread", ...prompt("Run once") };
  const result = await runtime.dispatch(command); await settled(runtime);
  assert.deepEqual(await runtime.dispatch(command), result); assert.equal(calls.length, 1);
  await assert.rejects(runtime.dispatch({ ...command, ...prompt("Different") }), { code: "IDEMPOTENCY_CONFLICT" });
});

test("native imports require explicit idle-session confirmation, are project scoped and deterministic", async (t) => {
  const { runtime, dispatch } = await fixture(t);
  const input = { projectId: "project", nativeSessionId: "saved-session", modelSelection: { instanceId: "codex", model: "default" } };
  await assert.rejects(dispatch("runtime.session.import", input), { code: "AGENT_IMPORT_CONFIRMATION" });
  const first = await dispatch("runtime.session.import", { ...input, confirmResume: true });
  const second = await dispatch("runtime.session.import", { ...input, confirmResume: true });
  assert.equal(first.threadId, second.threadId);
  assert.equal((await runtime.threadDetail(first.threadId)).messages[0].text, "Earlier task");
  await assert.rejects(runtime.callRpc("runtime.sessions.list", { runtimeId: "codex", projectId: "unconfigured" }), { code: "AGENT_PROJECT_UNKNOWN" });
});

test("approvals and questions remain distinct, resolve once, and close with the turn", async (t) => {
  const { runtime, dispatch } = await fixture(t, { async run(input) {
    await input.onNativeId("native");
    assert.equal(await input.ask({ kind: "approval", title: "Edit fixture?", decisions: ["accept", "decline", "cancel"] }), "accept");
    const answers = await input.ask({ kind: "question", questions: [{ id: "database", question: "Which database?", header: "Database", options: [] }] });
    assert.equal(answers.database, "SQLite"); input.onText("Done");
  } });
  await dispatch("thread.turn.start", prompt("Ask first"));
  while (!runtime.requests.size) await new Promise(setImmediate);
  const approval = [...runtime.requests.keys()][0];
  await assert.rejects(dispatch("thread.user-input.respond", { requestId: approval, answers: { database: "SQLite" } }), { code: "AGENT_REQUEST_INVALID" });
  await dispatch("thread.approval.respond", { requestId: approval, decision: "accept" });
  while (![...runtime.requests.values()].some((r) => r.request.kind === "question")) await new Promise(setImmediate);
  const question = [...runtime.requests.keys()][0];
  await dispatch("thread.user-input.respond", { requestId: question, answers: { database: "SQLite" } }); await settled(runtime);
  await assert.rejects(dispatch("thread.approval.respond", { requestId: approval, decision: "accept" }), { code: "AGENT_REQUEST_STALE" });
  assert.equal(runtime.requests.size, 0);
});

test("second writers are refused and restart marks interrupted work failed without rerunning it", async (t) => {
  const { runtime, config, stateDir, dispatch } = await fixture(t);
  const other = new DirectAgentRuntime({ config, stateDir });
  await assert.rejects(other.initialize(), { code: "AGENT_RUNTIME_LOCKED" });
  runtime.data.threads[0].bindings.codex = { nativeId: "possibly-running", seen: 0, signature: runtime.signature("codex") };
  runtime.data.threads[0].session.activeTurnId = "interrupted"; runtime.data.threads[0].session.status = "running";
  await runtime.persist(); await runtime.close();
  const restarted = await new DirectAgentRuntime({ config, stateDir }).initialize();
  try {
    assert.equal((await restarted.threadDetail("thread")).session.status, "error"); assert.equal(restarted.active.size, 0);
    assert.equal(restarted.thread("thread").bindings.codex, undefined);
    assert.match(restarted.thread("thread").session.lastError, /fresh native session/);
  }
  finally { await restarted.close(); }
});

test("a lost native result clears first-turn continuity before explicit continuation", async (t) => {
  for (const code of ["AGENT_REQUEST_UNCERTAIN", "AGENT_EXITED", "AGENT_PROTOCOL_INVALID", "AGENT_FRAME_LIMIT", "AGENT_RESULT_MISSING"]) {
    await t.test(code, async (t) => {
      let calls = 0;
      const { runtime, dispatch } = await fixture(t, { async run(input) {
        if (++calls === 1) {
          await input.onNativeId("possibly-running");
          throw Object.assign(new Error("Explicit mock transport failure"), { code });
        }
        assert.equal(input.nativeId, undefined);
        assert.match(input.prompt, /First request/);
        assert.match(input.prompt, /Follow-up request/);
        await input.onNativeId("fresh-native-session");
        input.onText("Recovered in a new native session");
      } });
      await dispatch("thread.turn.start", prompt("First request")); await settled(runtime);
      assert.equal(runtime.thread("thread").bindings.codex, undefined);
      assert.equal(runtime.thread("thread").session.status, "error");
      assert.match(runtime.thread("thread").session.lastError, /fresh native session/);
      await dispatch("thread.turn.start", prompt("Follow-up request")); await settled(runtime);
      assert.equal(runtime.thread("thread").session.status, "ready");
      assert.equal(runtime.thread("thread").bindings.codex.nativeId, "fresh-native-session");
    });
  }
});

test("native questions allow free-form answers only when their contract offers Other", async (t) => {
  const { runtime, dispatch } = await fixture(t);
  const thread = runtime.thread("thread");
  const offered = { id: "database", question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] };
  const strict = runtime.ask(thread, { kind: "question", questions: [offered] });
  let requestId = [...runtime.requests.keys()][0];
  await assert.rejects(dispatch("thread.user-input.respond", { requestId, answers: { database: "MySQL" } }), { code: "AGENT_ANSWER_INVALID" });
  await dispatch("thread.user-input.respond", { requestId, answers: { database: "SQLite" } });
  assert.deepEqual(await strict, { database: "SQLite" });
  const flexible = runtime.ask(thread, { kind: "question", questions: [{ ...offered, isOther: true }] });
  requestId = [...runtime.requests.keys()][0];
  await dispatch("thread.user-input.respond", { requestId, answers: { database: "MySQL" } });
  assert.deepEqual(await flexible, { database: "MySQL" });
});

test("direct connector hello advertises real runtime contract without a T3 token", async (t) => {
  const { runtime } = await fixture(t);
  const connector = new ConnectorClient({ state: { connectorId: "con", environmentId: "env", agentConfig: runtime.config }, t3: runtime, WebSocketImpl: class {} });
  const hello = await connector.buildHello("connection");
  assert.equal(hello.body.t3Health, "ready"); assert.equal(hello.body.t3Version, undefined);
  assert.ok(hello.body.capabilities.includes("runtime.direct")); assert.ok(hello.body.capabilities.includes("dispatch"));
  assert.equal(hello.body.providerCatalogue[0].runtimeKind, "direct");
});

test("invalid configs never become arbitrary remote shell commands", () => {
  assert.throws(() => validateAgentConfig({ agents: [{ id: "bad", kind: "shell" }], projects: [{ id: "p", cwd: "/tmp" }] }), { code: "AGENT_CONFIG_INVALID" });
});

test("uncertain persisted handoffs discard their native binding on restart", async (t) => {
  const { runtime, config, stateDir } = await fixture(t);
  const thread = runtime.data.threads[0];
  thread.bindings.codex = { nativeId: "uncertain-native", seen: 0 };
  thread.handoffs.push({ id: "handoff", targetAgentId: "codex", status: "pending" });
  await runtime.persist(); await runtime.close();
  const restarted = await new DirectAgentRuntime({ config, stateDir }).initialize();
  try { assert.equal(restarted.data.threads[0].bindings.codex, undefined); assert.equal(restarted.data.threads[0].handoffs[0].status, "uncertain"); }
  finally { await restarted.close(); }
});

test("failed local persistence refuses execution and subsequent receipt replays", async (t) => {
  const { runtime, dispatch, calls, stateDir } = await fixture(t);
  const originalPath = runtime.path; runtime.path = join(stateDir, "missing-directory", "journal.json");
  try {
    await assert.rejects(dispatch("thread.turn.start", prompt("Do not run without a durable claim")), { code: "AGENT_STATE_WRITE_FAILED" });
    assert.equal(calls.length, 0);
    await assert.rejects(dispatch("thread.session.stop"), { code: "AGENT_STATE_WRITE_FAILED" });
    await assert.rejects(runtime.environmentInfo(), { code: "AGENT_STATE_WRITE_FAILED" });
  } finally { runtime.path = originalPath; }
});

test("read-only connector results never enter durable completed receipts", async (t) => {
  const { runtime, dispatch } = await fixture(t);
  await dispatch("thread.turn.start", prompt("Private fixture input")); await settled(runtime);
  const state = { connectorId: "con", environmentId: "env", agentConfig: runtime.config };
  const client = new ConnectorClient({ state, t3: runtime, WebSocketImpl: class {} });
  const frames = [];
  await client.onMessage({ send: (raw) => frames.push(JSON.parse(raw)) }, JSON.stringify({ protocolVersion: 1, connectionId: "connection", type: "request", body: {
    requestId: "detail", idempotencyKey: "private-detail", method: "threadDetail", payload: { threadId: "thread" }, deadlineAt: new Date(Date.now() + 5000).toISOString(),
  } }));
  assert.match(JSON.stringify(frames), /Private fixture input/); assert.equal(state.completedRequests, undefined);
});

test("streaming coalesces deltas instead of repeatedly sending conversation bodies", async (t) => {
  let start, finish;
  const begin = new Promise((resolve) => { start = resolve; });
  const end = new Promise((resolve) => { finish = resolve; });
  const { runtime, dispatch } = await fixture(t, { async run(input) {
    await input.onNativeId("stream-native"); start(input); await end;
  } });
  const frames = [];
  const stream = runtime.openThreadStream({ threadId: "thread" }, { onItem: (frame) => frames.push(frame) });
  t.after(() => stream.close());
  await dispatch("thread.turn.start", prompt("Stream fixture"));
  const input = await begin;
  await new Promise((resolve) => setTimeout(resolve, 120));
  let unbatchedSnapshotBytes = 0;
  for (let wave = 0; wave < 4; wave++) {
    for (let index = 0; index < 500; index++) {
      input.onText("fixture text");
      unbatchedSnapshotBytes += Buffer.byteLength(JSON.stringify(runtime.detail("thread")));
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  finish(); await settled(runtime); await new Promise((resolve) => setTimeout(resolve, 120));
  const bytes = frames.reduce((sum, f) => sum + Buffer.byteLength(JSON.stringify(f)), 0);
  const deltas = frames.filter((f) => f.kind === "event");
  assert.ok(deltas.length <= 4 && deltas.length > 0);
  assert.ok(frames.every((f) => Buffer.byteLength(JSON.stringify(f)) < 256 * 1024));
  assert.ok(bytes < unbatchedSnapshotBytes / 100);
  t.diagnostic(`2000 x 12-character deltas: ${deltas.length} delta frames; ${bytes} total bytes versus ${unbatchedSnapshotBytes} bytes for full snapshots per delta.`);
  const reconnect = [];
  const resumed = runtime.openThreadStream({ threadId: "thread", afterSequence: -1 }, { onItem: (frame) => reconnect.push(frame) }); resumed.close();
  assert.equal(reconnect[0].kind, "snapshot"); assert.equal(reconnect[0].snapshot.thread.messages.at(-1).streaming, false);
});
