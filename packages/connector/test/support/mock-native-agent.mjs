// Explicit mock protocol process. No credentials, network, tools or real provider calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const contract = JSON.parse(readFileSync(new URL("../fixtures/codex-contract-0.162.1.json", import.meta.url), "utf8"));
let buffer = "", mode = process.argv[2], promptId, initialized = false;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk; let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const frame = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
    assert.equal(frame.jsonrpc, mode === "codex" ? undefined : "2.0");
    if (mode === "codex") {
      const schemaName = { "thread/start": "ThreadStartParams", "thread/resume": "ThreadResumeParams", "thread/turns/list": "ThreadTurnsListParams", "turn/start": "TurnStartParams" }[frame.method];
      if (schemaName) {
        const schema = contract[schemaName];
        for (const key of schema.required) assert.ok(Object.hasOwn(frame.params, key));
        for (const key of Object.keys(frame.params)) assert.ok(schema.fields.includes(key), `Unknown ${schemaName} field ${key}`);
        if (frame.params.sandbox) assert.ok(contract.sandboxModes.includes(frame.params.sandbox));
        if (frame.params.approvalPolicy) assert.ok(contract.approvalPolicies.includes(frame.params.approvalPolicy));
      }
    }
    const reply = (result) => send({ jsonrpc: "2.0", id: frame.id, result });
    if (frame.id === "permission") {
      if (mode === "codex") {
        if (frame.result?.decision !== "accept") process.exit(2);
        notify("item/agentMessage/delta", { threadId: "native", delta: "first\u2028second" });
        notify("turn/completed", { threadId: "native", turn: { id: "turn", status: "completed" } });
      } else {
        if (frame.result?.outcome?.optionId !== "native-allow-once") process.exit(3);
        notify("session/update", { sessionId: "native", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ACP fixture result" } } });
        send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
      }
      continue;
    }
    if (!frame.method || frame.id == null) continue;
    if (!initialized && frame.method !== "initialize") { send({ id: frame.id, error: { code: -32600, message: "Mock initialization is incomplete" } }); continue; }
    if (frame.method === "initialize") setTimeout(() => {
      initialized = true;
      reply(mode === "codex" ? {} : { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } });
    }, Number(process.argv[3] ?? 0));
    else if (frame.method === "model/list") reply({ data: [{ id: "fixture-model", displayName: "Fixture model" }] });
    else if (frame.method === "thread/list") reply({ data: [{ id: "native", cwd: frame.params.cwd, preview: "Existing fixture", updatedAt: 1 }], nextCursor: null });
    else if (frame.method === "thread/read") reply({ thread: { id: "native", turns: [{ items: [{ type: "userMessage", content: [{ type: "text", text: "Saved input" }] }, { type: "agentMessage", text: "Saved output" }] }] } });
    else if (frame.method === "thread/turns/list") reply({ data: [{ items: [{ type: "userMessage", content: [{ type: "text", text: "Saved input" }] }, { type: "agentMessage", text: "Saved output" }] }], nextCursor: null });
    else if (["thread/start", "thread/resume"].includes(frame.method)) reply({ thread: { id: "native" } });
    else if (frame.method === "turn/start") {
      reply({ turn: { id: "turn" } });
      notify("turn/started", { threadId: "native", turn: { id: "turn" } });
      send({ id: "permission", method: "item/commandExecution/requestApproval", params: { threadId: "native", command: "test fixture" } });
    } else if (frame.method === "session/list") reply({ sessions: [{ sessionId: "native", cwd: frame.params.cwd, title: "ACP fixture" }] });
    else if (frame.method === "session/new") reply({ sessionId: "native" });
    else if (frame.method === "session/load") {
      notify("session/update", { sessionId: "native", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "ACP saved input" } } });
      notify("session/update", { sessionId: "native", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ACP saved output" } } });
      reply({ models: { availableModels: [{ modelId: "fixture-model", name: "Fixture model" }] } });
    } else if (frame.method === "session/set_model") {
      assert.equal(frame.params.modelId, "fixture-model");
      reply({});
    } else if (frame.method === "session/prompt") {
      promptId = frame.id;
      send({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: { sessionId: "native", toolCall: { title: "Fixture edit" }, options: [{ optionId: "native-allow-once", kind: "allow_once" }, { optionId: "native-deny-once", kind: "reject_once" }] } });
    } else send({ id: frame.id, error: { code: -32601, message: "Unsupported mock method" } });
  }
});
