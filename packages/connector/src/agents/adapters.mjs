import { AgentRpc, agentError } from "./jsonRpc.mjs";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

async function executableAvailable(command) {
  const candidates = isAbsolute(command) ? [command] : (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, command));
  for (const path of candidates) { try { await access(path, constants.X_OK); return true; } catch {} }
  return false;
}

// Native option ids. They are this adapter's own names for what Codex app-server exposes, and
// they travel back verbatim as `modelSelection.options[].id`. Each maps to exactly one documented
// `turn/start` field: reasoningEffort -> `effort`, serviceTier -> `serviceTierForTurn`.
export const CODEX_OPTION_REASONING = "reasoningEffort";
export const CODEX_OPTION_SERVICE_TIER = "serviceTier";

/**
 * Build option descriptors from what Codex itself reports for one model in `model/list`.
 *
 * Evidence (JSON Schema generated read-only from the installed CLI with
 * `codex app-server generate-json-schema`, identical on 0.151.0 and 0.165.0): `Model` carries
 * `supportedReasoningEfforts[{reasoningEffort, description}]` + `defaultReasoningEffort`, and
 * `serviceTiers[{id, name, description}]` + `defaultServiceTier`; `TurnStartParams` accepts
 * `effort` and `serviceTierForTurn` ('Use "default" for standard speed'). Nothing here is
 * hardcoded: a model that reports no efforts or tiers declares no descriptor, because a guessed
 * value list produces dispatches the native agent rejects.
 */
export function codexOptionDescriptors(model) {
  const descriptors = [];
  const efforts = (Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
    .filter((entry) => typeof entry?.reasoningEffort === "string" && entry.reasoningEffort)
    .slice(0, 32);
  if (efforts.length) {
    const fallback = typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : null;
    const known = efforts.some((entry) => entry.reasoningEffort === fallback);
    descriptors.push({
      id: CODEX_OPTION_REASONING, label: "Reasoning effort", type: "select", ...(known ? { currentValue: fallback } : {}),
      options: efforts.map((entry) => ({ id: entry.reasoningEffort, label: entry.reasoningEffort,
        ...(entry.reasoningEffort === fallback ? { isDefault: true } : {}),
        ...(typeof entry.description === "string" && entry.description ? { description: entry.description } : {}) })),
    });
  }
  const tiers = (Array.isArray(model?.serviceTiers) ? model.serviceTiers : [])
    .filter((tier) => typeof tier?.id === "string" && tier.id && tier.id !== "default").slice(0, 31);
  if (tiers.length) {
    const fallback = typeof model.defaultServiceTier === "string" && model.defaultServiceTier ? model.defaultServiceTier : "default";
    const known = fallback === "default" || tiers.some((tier) => tier.id === fallback);
    const current = known ? fallback : "default";
    descriptors.push({
      id: CODEX_OPTION_SERVICE_TIER, label: "Service tier", type: "select", currentValue: current,
      options: [{ id: "default", label: "Standard", ...(current === "default" ? { isDefault: true } : {}) },
        ...tiers.map((tier) => ({ id: tier.id, label: tier.name ?? tier.id,
          ...(tier.id === current ? { isDefault: true } : {}),
          ...(typeof tier.description === "string" && tier.description ? { description: tier.description } : {}) }))],
    });
  }
  return descriptors;
}

// Only ids this adapter declared reach the wire; the runtime has already validated the values
// against the declared descriptors, so an unknown id here is ignored rather than forwarded.
function codexTurnOptions(options) {
  const out = {};
  for (const option of Array.isArray(options) ? options : []) {
    if (option?.id === CODEX_OPTION_REASONING && typeof option.value === "string") out.effort = option.value;
    if (option?.id === CODEX_OPTION_SERVICE_TIER && typeof option.value === "string") out.serviceTierForTurn = option.value;
  }
  return out;
}

const textOf = (content) => (content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");

export class CodexAgent {
  constructor(config, dependencies = {}) { this.config = config; this.dependencies = dependencies; this.runs = new Map(); }
  async connect() {
    if (this.connecting) return await this.connecting;
    if (this.rpc && !this.rpc.closed) return this.rpc;
    this.connecting = this.initializeConnection();
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  async initializeConnection() {
    const rpc = new AgentRpc({ command: this.config.command ?? "codex", args: ["app-server"], includeJsonRpc: false, ...this.dependencies,
      onNotification: (method, params) => this.notification(method, params),
      onRequest: async (method, params) => {
        const run = this.runs.get(params.threadId);
        if (!run) throw agentError("AGENT_REQUEST_STALE", "No managed turn owns this request.");
        if (method === "item/tool/requestUserInput") {
          const answers = await run.ask({ kind: "question", questions: params.questions });
          return { answers: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, { answers: Array.isArray(value) ? value : [value] }])) };
        }
        if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) throw agentError("AGENT_METHOD_UNSUPPORTED", "Agent request type is unsupported.");
        const decision = await run.ask({ kind: "approval", title: params.reason ?? params.command ?? "Agent requests permission", decisions: ["accept", "decline", "cancel"] });
        return { decision };
      } });
    rpc.onExit = (error) => { for (const run of this.runs.values()) run.reject(error); this.runs.clear(); };
    this.rpc = rpc;
    try {
      await rpc.request("initialize", { clientInfo: { name: "next_coder_connector", title: "Next Coder", version: "0.1.0" } });
      rpc.notify("initialized"); return rpc;
    } catch (error) { rpc.close(); throw error; }
  }
  async models() {
    const rpc = await this.connect();
    return [{ id: "default", label: "Codex default" }, ...(await rpc.request("model/list", {})).data.map((m) => {
      const optionDescriptors = codexOptionDescriptors(m);
      return { id: m.id, label: m.displayName ?? m.id, ...(optionDescriptors.length ? { capabilities: { optionDescriptors } } : {}) };
    })];
  }
  async list({ cwd, cursor }) {
    const rpc = await this.connect();
    const result = await rpc.request("thread/list", { cwd, limit: 30, ...(cursor ? { cursor } : {}), sourceKinds: ["cli", "vscode", "appServer"] });
    return { sessions: result.data.map((t) => ({ id: t.id, title: t.name ?? t.preview ?? "Codex conversation", updatedAt: new Date(t.updatedAt * 1000).toISOString(), cwd: t.cwd, attachment: "resume" })), nextCursor: result.nextCursor ?? null };
  }
  async history(id) {
    const rpc = await this.connect(); let turns;
    try { turns = [...(await rpc.request("thread/turns/list", { threadId: id, limit: 8, sortDirection: "desc", itemsView: "summary" })).data].reverse(); }
    catch (error) {
      if (error.rpcCode !== -32601) throw error;
      turns = (await rpc.request("thread/read", { threadId: id, includeTurns: true })).thread?.turns ?? [];
    }
    return turns.flatMap((turn) => (turn.items ?? []).flatMap((item) => {
      if (item.type === "userMessage") return [{ role: "user", text: textOf(item.content) }];
      if (item.type === "agentMessage") return [{ role: "assistant", text: item.text ?? "" }];
      return [];
    }));
  }
  async run({ nativeId, cwd, model, options, prompt, onNativeId, onText, ask, shouldStop = () => false }) {
    const rpc = await this.connect();
    const response = await rpc.request(nativeId ? "thread/resume" : "thread/start", {
      ...(nativeId ? { threadId: nativeId, excludeTurns: true } : {}), cwd, model: model === "default" ? undefined : model,
      approvalPolicy: "untrusted", sandbox: "workspace-write",
    });
    const id = response.thread.id; await onNativeId(id);
    let resolve, reject;
    const done = new Promise((a, b) => { resolve = a; reject = b; });
    // Attach the completion handler before dispatch; terminal events can beat the RPC response.
    const run = { onText, ask, resolve, reject, text: "", turnId: null, shouldStop };
    this.runs.set(id, run);
    void done.catch(() => {});
    try {
      if (shouldStop()) throw agentError("AGENT_INTERRUPTED", "Turn cancelled before dispatch.");
      const result = await rpc.request("turn/start", { threadId: id, input: [{ type: "text", text: prompt }], model: model === "default" ? undefined : model, ...codexTurnOptions(options) });
      run.turnId = result.turn.id;
      await done;
    } finally { this.runs.delete(id); }
  }
  notification(method, params) {
    const run = this.runs.get(params.threadId); if (!run) return;
    if (method === "turn/started") {
      run.turnId = params.turn.id;
      if (run.shouldStop()) void this.interrupt(params.threadId).catch(run.reject);
    }
    if (method === "item/agentMessage/delta") { run.text += params.delta; run.onText(params.delta); }
    if (method === "item/completed" && params.item?.type === "agentMessage" && !run.text) { run.onText(params.item.text ?? ""); }
    if (method === "turn/completed") {
      const status = params.turn.status;
      status === "completed" ? run.resolve() : run.reject(agentError(status === "interrupted" ? "AGENT_INTERRUPTED" : "AGENT_TURN_FAILED", status === "interrupted" ? "Agent turn interrupted." : "Agent turn failed."));
    }
  }
  async interrupt(nativeId) { const run = this.runs.get(nativeId); if (run?.turnId) await this.rpc.request("turn/interrupt", { threadId: nativeId, turnId: run.turnId }); }
  close() { this.rpc?.close(); }
}

export class ClaudeAgent {
  constructor(config, { loadSdk = () => import("@anthropic-ai/claude-agent-sdk") } = {}) { this.config = config; this.loadSdk = loadSdk; this.runs = new Map(); }
  // Declares no option descriptors, deliberately. The SDK does take `options.effort`
  // (low|medium|high|xhigh|max), but which levels a model accepts is only reported per model by
  // `Query.supportedModels()[].supportedEffortLevels`, which needs a live query (a spawned CLI).
  // This catalogue is built without one, and a fixed list would offer levels some models reject.
  async models() {
    await this.loadSdk();
    if (this.config.command && !await executableAvailable(this.config.command)) throw agentError("AGENT_UNAVAILABLE", "Claude executable is unavailable.");
    return (this.config.models ?? ["default"]).map((id) => ({ id, label: id === "default" ? "Claude default" : id }));
  }
  async list({ cwd, cursor }) {
    if (cursor && !/^claude:\d{1,7}$/u.test(cursor)) throw agentError("AGENT_CURSOR_INVALID", "Claude session cursor is invalid.");
    const offset = cursor ? Number(cursor.slice(7)) : 0;
    const sdk = await this.loadSdk(); const rows = await sdk.listSessions({ dir: cwd, limit: 31, offset, includeWorktrees: false });
    return { sessions: rows.slice(0, 30).map((s) => ({ id: s.sessionId, title: s.customTitle ?? s.summary, updatedAt: new Date(s.lastModified).toISOString(), cwd: s.cwd, attachment: "resume" })), nextCursor: rows.length > 30 ? `claude:${offset + 30}` : null };
  }
  async history(id, cwd) {
    const sdk = await this.loadSdk(); const rows = await sdk.getSessionMessages(id, { dir: cwd, limit: 64 });
    return rows.map((m) => ({ role: m.type, text: typeof m.message?.content === "string" ? m.message.content : textOf(m.message?.content) }));
  }
  async run({ nativeId, cwd, model, prompt, onNativeId, onText, ask, runKey, shouldStop = () => false }) {
    const sdk = await this.loadSdk(); let terminal = false;
    async function* input() { if (!shouldStop()) yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: nativeId ?? "" }; }
    const query = sdk.query({ prompt: input(), options: {
      cwd, ...(nativeId ? { resume: nativeId } : {}), ...(model === "default" ? {} : { model }),
      ...(this.config.command ? { pathToClaudeCodeExecutable: this.config.command } : {}),
      permissionMode: "default", settingSources: ["user", "project", "local"], includePartialMessages: false,
      canUseTool: async (toolName, input, options) => {
        if (toolName === "AskUserQuestion") {
          // Claude always offers a free-form Other response, even when options exist.
          const questions = (input.questions ?? []).map((q) => ({ ...q, id: q.question, isOther: true }));
          const answers = await ask({ kind: "question", questions }, options?.signal);
          const nativeAnswers = Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value]));
          return { behavior: "allow", updatedInput: { ...input, answers: nativeAnswers } };
        }
        const decision = await ask({ kind: "approval", title: `${toolName}: ${String(input.description ?? input.command ?? input.file_path ?? "Permission requested").slice(0, 1500)}`, decisions: ["accept", "decline", "cancel"] }, options?.signal);
        return decision === "accept" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Declined by the user." };
      },
    } });
    this.runs.set(runKey, query);
    try {
      for await (const message of query) {
        if (message.session_id) await onNativeId(message.session_id);
        if (message.type === "assistant") onText(textOf(message.message?.content));
        if (message.type === "result") {
          terminal = true;
          if (message.subtype !== "success" || message.is_error) throw agentError("AGENT_TURN_FAILED", "Claude did not complete this turn successfully.");
        }
      }
      if (!terminal) throw agentError("AGENT_RESULT_MISSING", "Claude closed without a terminal result.");
    } finally { this.runs.delete(runKey); query.close?.(); }
  }
  async interrupt(_nativeId, runKey) { await this.runs.get(runKey)?.interrupt(); }
  close() { for (const query of this.runs.values()) query.close?.(); }
}

export class AcpAgent {
  constructor(config, dependencies = {}) { this.config = config; this.dependencies = dependencies; this.sessions = new Map(); }
  async connect() {
    if (this.connecting) return await this.connecting;
    if (this.rpc && !this.rpc.closed) return this.rpc;
    this.connecting = this.initializeConnection();
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  async initializeConnection() {
    const rpc = new AgentRpc({ command: this.config.command, args: this.config.args ?? [], ...this.dependencies,
      onNotification: (method, params) => {
        const run = this.sessions.get(params.sessionId);
        if (method === "session/update" && ["agent_message_chunk", "user_message_chunk"].includes(params.update?.sessionUpdate) && params.update.content?.type === "text") {
          run?.onHistory?.({ role: params.update.sessionUpdate === "user_message_chunk" ? "user" : "assistant", text: params.update.content.text });
        }
        if (method === "session/update" && params.update?.sessionUpdate === "agent_message_chunk" && params.update.content?.type === "text") run?.onText?.(params.update.content.text);
      },
      onRequest: async (method, params) => {
        if (method !== "session/request_permission") throw agentError("AGENT_METHOD_UNSUPPORTED", "This client does not expose filesystem or terminal methods.");
        const run = this.sessions.get(params.sessionId); if (!run) return { outcome: { outcome: "cancelled" } };
        const mapping = { allow_once: "accept", reject_once: "decline" };
        const choices = (params.options ?? []).filter((o) => mapping[o.kind]);
        const decisions = choices.map((o) => mapping[o.kind]);
        const decision = await run.ask({ kind: "approval", title: params.toolCall?.title ?? "Agent requests permission", decisions: [...new Set([...decisions, "cancel"])] });
        const selected = choices.find((o) => mapping[o.kind] === decision);
        return { outcome: selected ? { outcome: "selected", optionId: selected.optionId } : { outcome: "cancelled" } };
      } });
    this.rpc = rpc;
    // v1 is stable. Negotiate it explicitly; v2 is still draft and has different lifecycle semantics.
    try {
      const initialized = await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "next-coder", version: "0.1.0" } });
      if (initialized.protocolVersion !== 1) throw agentError("ACP_VERSION_UNSUPPORTED", "This connector requires ACP protocol 1.");
      this.capabilities = initialized.agentCapabilities ?? {}; return rpc;
    } catch (error) { rpc.close(); throw error; }
  }
  // Declares no option descriptors, deliberately. ACP publishes reasoning and similar switches as
  // `configOptions` (category `thought_level`, set with `session/set_config_option`), but only in
  // the `session/new` and `session/load` responses: they are per-session and unknowable here
  // without creating a session on an arbitrary configured agent just to build a catalogue.
  async models() {
    if (!this.dependencies.spawnImpl && !await executableAvailable(this.config.command)) throw agentError("AGENT_UNAVAILABLE", "ACP executable is unavailable.");
    return (this.config.models ?? ["default"]).map((id) => ({ id, label: id === "default" ? `${this.config.label ?? this.config.id} default` : id }));
  }
  async list({ cwd, cursor }) {
    const rpc = await this.connect();
    if (!this.capabilities.sessionCapabilities?.list) throw agentError("AGENT_DISCOVERY_UNSUPPORTED", "This ACP agent does not advertise session listing.");
    const result = await rpc.request("session/list", { cwd, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result.sessions) || result.sessions.length > 100) throw agentError("AGENT_SESSION_LIMIT", "Agent session listing exceeded its limit.");
    return { sessions: result.sessions.map((s) => ({ id: s.sessionId, title: s.title ?? "Agent conversation", updatedAt: s.updatedAt, cwd: s.cwd, attachment: this.capabilities.loadSession ? "resume" : "view" })), nextCursor: result.nextCursor ?? null };
  }
  async history(nativeId, cwd) {
    const rpc = await this.connect();
    if (!this.capabilities.loadSession) throw agentError("AGENT_RESUME_UNSUPPORTED", "ACP session loading is unsupported.");
    const history = []; let chars = 0;
    this.sessions.set(nativeId, { onHistory: (message) => {
      if (chars >= 64_000 || history.length >= 64) return;
      const text = message.text.slice(0, 64_000 - chars); chars += text.length;
      const last = history.at(-1);
      if (last?.role === message.role) last.text += text; else history.push({ ...message, text });
    } });
    try { await rpc.request("session/load", { sessionId: nativeId, cwd, mcpServers: [] }); return history; }
    finally { this.sessions.delete(nativeId); }
  }
  async run({ nativeId, cwd, model, prompt, onNativeId, onText, ask, shouldStop = () => false }) {
    const rpc = await this.connect(); let result;
    if (nativeId && !this.capabilities.loadSession) throw agentError("AGENT_RESUME_UNSUPPORTED", "This ACP agent does not advertise session loading.");
    if (nativeId) {
      const loaded = await rpc.request("session/load", { sessionId: nativeId, cwd, mcpServers: [] });
      result = { ...loaded, sessionId: nativeId };
    } else result = await rpc.request("session/new", { cwd, mcpServers: [] });
    const id = result.sessionId; await onNativeId(id);
    if (model !== "default") {
      if (!result.models?.availableModels?.some((m) => m.modelId === model)) throw agentError("AGENT_MODEL_UNSUPPORTED", "The ACP session does not advertise this model.");
      await rpc.request("session/set_model", { sessionId: id, modelId: model });
    }
    this.sessions.set(id, { onText, ask });
    try {
      if (shouldStop()) throw agentError("AGENT_INTERRUPTED", "Turn cancelled before dispatch.");
      const answer = await rpc.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: prompt }] }, 30 * 60_000);
      if (answer.stopReason !== "end_turn") throw agentError(answer.stopReason === "cancelled" ? "AGENT_INTERRUPTED" : "AGENT_TURN_FAILED", "ACP turn ended without successful completion.");
    } finally { this.sessions.delete(id); }
  }
  async interrupt(nativeId) { if (this.sessions.has(nativeId)) this.rpc.notify("session/cancel", { sessionId: nativeId }); }
  close() { this.rpc?.close(); }
}

export function createAgentAdapter(config, dependencies) {
  if (config.kind === "codex") return new CodexAgent(config, dependencies);
  if (config.kind === "claude") return new ClaudeAgent(config, dependencies);
  if (config.kind === "acp") return new AcpAgent(config, dependencies);
  throw agentError("AGENT_KIND_UNSUPPORTED", "Unsupported agent kind.");
}
