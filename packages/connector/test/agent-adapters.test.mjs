import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexAgent, AcpAgent, ClaudeAgent } from "../src/agents/adapters.mjs";
import { AgentRpc } from "../src/agents/jsonRpc.mjs";

function mockTransport(mode, initializationDelayMs = 0) {
  return { spawnImpl: (_command, _args, options) => {
    assert.equal(options.shell, false);
    return spawn(process.execPath, [fileURLToPath(new URL("./support/mock-native-agent.mjs", import.meta.url)), mode, String(initializationDelayMs)], options);
  } };
}

test("a native process closing its input fails requests without an unhandled pipe error", async (t) => {
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const rpc = new AgentRpc({ command: process.execPath, args: ["-e", `
    require("node:fs").closeSync(0);
    process.stdout.write(JSON.stringify({method: "fixture/ready"}) + "\\n");
    setTimeout(() => {}, 10000);
  `], onNotification: (method) => { if (method === "fixture/ready") ready(); } });
  t.after(() => rpc.close());
  await started;
  await assert.rejects(rpc.request("fixture/request"), { code: "AGENT_EXITED" });
  // Event emission follows the write callback; let the stream error run as well.
  await new Promise(setImmediate);
  assert.equal(rpc.closed, true);
});

test("Codex adapter drives an isolated JSON-RPC process, resumes history and routes permission requests", async (t) => {
  const adapter = new CodexAgent({}, mockTransport("codex")); t.after(() => adapter.close());
  assert.equal((await adapter.models())[1].id, "fixture-model");
  assert.equal((await adapter.list({ cwd: process.cwd() })).sessions[0].id, "native");
  assert.equal((await adapter.history("native"))[1].text, "Saved output");
  const text = []; let native;
  await adapter.run({ nativeId: "native", cwd: process.cwd(), model: "default", prompt: "Fixture request", onNativeId: async (id) => { native = id; }, onText: (value) => text.push(value), ask: async (request) => {
    assert.equal(request.kind, "approval"); assert.deepEqual(request.decisions, ["accept", "decline", "cancel"]); return "accept";
  } });
  assert.equal(native, "native"); assert.equal(text.join(""), "first\u2028second");
});

test("native adapters await initialization for concurrent discovery and history requests", async (t) => {
  const codex = new CodexAgent({}, mockTransport("codex", 30));
  const acp = new AcpAgent({ id: "mock-acp", command: "explicit-mock" }, mockTransport("acp", 30));
  t.after(() => { codex.close(); acp.close(); });
  const [models, sessions, history] = await Promise.all([
    codex.models(), codex.list({ cwd: process.cwd() }), codex.history("native"),
  ]);
  assert.equal(models[1].id, "fixture-model");
  assert.equal(sessions.sessions[0].id, "native");
  assert.equal(history[1].text, "Saved output");
  const [acpSessions, acpHistory] = await Promise.all([
    acp.list({ cwd: process.cwd() }), acp.history("native", process.cwd()),
  ]);
  assert.equal(acpSessions.sessions[0].id, "native");
  assert.equal(acpHistory[1].text, "ACP saved output");
});

test("ACP adapter negotiates v1, replays saved messages and preserves native permission option ids", async (t) => {
  const adapter = new AcpAgent({ id: "mock-acp", command: "explicit-mock" }, mockTransport("acp")); t.after(() => adapter.close());
  assert.equal((await adapter.list({ cwd: process.cwd() })).sessions[0].attachment, "resume");
  assert.deepEqual(await adapter.history("native", process.cwd()), [{ role: "user", text: "ACP saved input" }, { role: "assistant", text: "ACP saved output" }]);
  const text = [];
  await adapter.run({ nativeId: "native", cwd: process.cwd(), model: "default", prompt: "Fixture request", onNativeId: async () => {}, onText: (value) => text.push(value), ask: async () => "accept" });
  assert.equal(text.join(""), "ACP fixture result");
  const resumedText = [];
  await adapter.run({ nativeId: "native", cwd: process.cwd(), model: "fixture-model", prompt: "Resume with selected model", onNativeId: async () => {}, onText: (value) => resumedText.push(value), ask: async () => "accept" });
  assert.equal(resumedText.join(""), "ACP fixture result");
});

test("Claude adapter uses SDK resume, native question keys and authoritative result events", async () => {
  let observed;
  const sdk = {
    listSessions: async () => [{ sessionId: "saved", summary: "Fixture", lastModified: 1 }],
    getSessionMessages: async () => [{ type: "user", message: { content: "Saved Claude input" } }],
    query: (input) => {
      observed = input;
      return (async function* () {
        for await (const message of input.prompt) assert.equal(message.message.content, "Continue");
        const response = await input.options.canUseTool("AskUserQuestion", { questions: [
          { question: "Which database?", header: "Database", options: [{ label: "SQLite" }, { label: "Postgres" }] },
          { question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "Search" }, { label: "Export" }] },
        ] });
        assert.equal(response.updatedInput.answers["Which database?"], "SQLite");
        assert.equal(response.updatedInput.answers["Which features?"], "Search, Export");
        yield { type: "assistant", session_id: "saved", message: { content: [{ type: "text", text: "Claude fixture result" }] } };
        yield { type: "result", session_id: "saved", subtype: "success" };
      })();
    },
  };
  const adapter = new ClaudeAgent({}, { loadSdk: async () => sdk });
  assert.equal((await adapter.list({ cwd: process.cwd() })).sessions[0].id, "saved");
  assert.equal((await adapter.history("saved"))[0].text, "Saved Claude input");
  const text = [];
  await adapter.run({ nativeId: "saved", cwd: process.cwd(), model: "default", prompt: "Continue", runKey: "thread", onNativeId: async () => {}, onText: (value) => text.push(value), ask: async (request) => {
    assert.equal(request.kind, "question"); assert.equal(request.questions[0].id, "Which database?");
    assert.equal(request.questions[0].isOther, true);
    return { "Which database?": "SQLite", "Which features?": ["Search", "Export"] };
  } });
  assert.equal(observed.options.resume, "saved"); assert.equal(observed.options.permissionMode, "default");
  assert.equal(text.join(""), "Claude fixture result");
});
