// Minimal Codex app-server stand-in for option plumbing: model/list reports reasoning efforts and
// service tiers exactly as the generated v2 `Model` schema defines them, and turn/start echoes the
// params it received back as the assistant text so a test can assert what reached the wire.
// No credentials, network, tools or real provider calls.
let buffer = "";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk; let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const frame = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
    if (!frame.method || frame.id == null) continue;
    const reply = (result) => send({ jsonrpc: "2.0", id: frame.id, result });
    if (frame.method === "initialize") reply({});
    else if (frame.method === "model/list") reply({ data: [
      { id: "tiered-model", displayName: "Tiered model", defaultReasoningEffort: "medium", defaultServiceTier: null,
        supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deep" }],
        serviceTiers: [{ id: "priority", name: "Fast", description: "Priority processing" }] },
      { id: "plain-model", displayName: "Plain model", supportedReasoningEfforts: [], serviceTiers: [] },
    ] });
    else if (frame.method === "thread/start") reply({ thread: { id: "native" } });
    else if (frame.method === "turn/start") {
      reply({ turn: { id: "turn" } });
      notify("turn/started", { threadId: "native", turn: { id: "turn" } });
      notify("item/agentMessage/delta", { threadId: "native", delta: JSON.stringify(frame.params) });
      notify("turn/completed", { threadId: "native", turn: { id: "turn", status: "completed" } });
    }
  }
});
