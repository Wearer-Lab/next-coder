import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createAgentAdapter } from "./adapters.mjs";
import { agentError } from "./jsonRpc.mjs";

const MAX_THREADS = 256, MAX_MESSAGES = 64, MAX_TEXT = 32_000, MAX_RECEIPTS = 1000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();
const fail = (code, message) => { throw agentError(code, message); };
const id = (value) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,180}$/u.test(value) && !["__proto__", "constructor", "prototype"].includes(value);

// The gateway's approval vocabulary (src/providerApprovals.mjs): T3's four decisions, with
// approve/reject accepted there as legacy aliases. A native agent's own words are mapped here, at
// the boundary, because a request whose whole list is unrecognised offers the owner nothing.
const DECISION_ALIASES = { accept: "accept", acceptForSession: "acceptForSession", decline: "decline", cancel: "cancel", approve: "accept", reject: "decline" };
const canonicalDecision = (value) => typeof value === "string" && Object.hasOwn(DECISION_ALIASES, value) ? DECISION_ALIASES[value] : null;
// Bounded, strings only, de-duplicated, null when nothing recognisable remains.
export function canonicalDecisions(values) {
  if (!Array.isArray(values)) return null;
  const out = [];
  for (const value of values.slice(0, 16)) { const decision = canonicalDecision(value); if (decision && !out.includes(decision)) out.push(decision); }
  return out.length ? out : null;
}
// Mirrors the gateway's own cap on a model selection (MAX_MODEL_OPTION_SELECTIONS).
const MAX_OPTIONS = 16;
const MODEL_CACHE_MS = 30_000;

export function validateAgentConfig(config) {
  if (!config || !Array.isArray(config.agents) || config.agents.length < 1 || config.agents.length > 16 || !Array.isArray(config.projects) || config.projects.length < 1 || config.projects.length > 64) fail("AGENT_CONFIG_INVALID", "Configure 1–16 agents and 1–64 local projects.");
  const agentIds = new Set(), projectIds = new Set();
  for (const agent of config.agents) {
    if (!id(agent.id) || agentIds.has(agent.id) || !["codex", "claude", "acp"].includes(agent.kind)) fail("AGENT_CONFIG_INVALID", "Agent ids must be unique and kinds must be codex, claude or acp.");
    if ((agent.kind === "acp" || agent.command !== undefined) && (typeof agent.command !== "string" || !agent.command || agent.command.length > 2048)) fail("AGENT_CONFIG_INVALID", "Agent command must be a literal executable.");
    if (agent.args !== undefined && (!Array.isArray(agent.args) || agent.args.length > 32 || agent.args.some((arg) => typeof arg !== "string" || arg.length > 2048))) fail("AGENT_CONFIG_INVALID", "Agent arguments must be a bounded literal array.");
    if (agent.models !== undefined && (!Array.isArray(agent.models) || !agent.models.length || agent.models.length > 100 || agent.models.some((m) => typeof m !== "string" || !m || m.length > 200))) fail("AGENT_CONFIG_INVALID", "Model ids are invalid.");
    agentIds.add(agent.id);
  }
  for (const project of config.projects) {
    if (!id(project.id) || projectIds.has(project.id) || typeof project.cwd !== "string" || !project.cwd || !agentIds.has(project.defaultAgent ?? config.agents[0].id)) fail("AGENT_CONFIG_INVALID", "Local projects need unique ids, paths and a configured default agent.");
    projectIds.add(project.id);
  }
  return config;
}

// This local domain projects into the existing gateway conversation contract. It does not
// impersonate a T3 server. No credentials, native protocol logs or raw tool output are stored.
export class DirectAgentRuntime {
  constructor({ config, stateDir, adapterFactory = createAgentAdapter }) {
    this.config = validateAgentConfig(config); this.path = join(stateDir, "agent-conversations.json");
    this.adapters = new Map(config.agents.map((a) => [a.id, adapterFactory(a)]));
    this.discovered = new Map();
    this.authenticated = new Set();
    this.modelCache = new Map();
    this.data = { version: 1, threads: [], receipts: [], sequence: 0 }; this.active = new Map(); this.requests = new Map(); this.listeners = new Map(); this.tail = Promise.resolve(); this.writes = Promise.resolve();
  }
  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // A second service must not become another writer to managed native sessions.
    try { this.lock = await open(this.path + ".lock", "wx", 0o600); await this.lock.writeFile(String(process.pid)); }
    catch {
      let recovery;
      try { recovery = await open(this.path + ".recovery", "wx", 0o600); }
      catch { fail("AGENT_RUNTIME_LOCKED", "Another process is recovering local state. Verify it has stopped before repairing a stale recovery lock."); }
      try {
        const owner = await readFile(this.path + ".lock", "utf8").catch(() => "");
        const pid = Number(owner);
        let dead = false;
        if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 0); } catch (error) { dead = error.code === "ESRCH"; } }
        if (!dead) fail("AGENT_RUNTIME_LOCKED", "Another direct runtime owns this state directory. Stop it before starting another connector.");
        await unlink(this.path + ".lock"); this.lock = await open(this.path + ".lock", "wx", 0o600); await this.lock.writeFile(String(process.pid));
      } finally { await recovery.close(); await unlink(this.path + ".recovery").catch(() => {}); }
    }
    try {
      const info = await stat(this.path).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (info && (info.size > 32 * 1024 * 1024 || (process.platform !== "win32" && (info.mode & 0o077) !== 0))) fail("AGENT_STATE_INVALID", "Local conversation state is too large or its permissions are not private.");
      const raw = await readFile(this.path, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (raw) {
        if (Buffer.byteLength(raw) > 32 * 1024 * 1024) fail("AGENT_STATE_LIMIT", "Local conversation state exceeded its limit.");
        const data = JSON.parse(raw);
        if (data.version !== 1 || !Array.isArray(data.threads) || data.threads.length > MAX_THREADS || !Array.isArray(data.receipts)) fail("AGENT_STATE_INVALID", "Local conversation state is incompatible.");
        this.data = data;
        for (const thread of data.threads) {
          for (const handoff of thread.handoffs ?? []) if (handoff.status === "pending") {
            handoff.status = "uncertain";
            delete thread.bindings[handoff.targetAgentId];
          }
          if (thread.session?.activeTurnId) {
            const interruptedAgentId = thread.session.providerInstanceId ?? thread.modelSelection?.instanceId;
            if (interruptedAgentId) delete thread.bindings[interruptedAgentId];
            thread.session = { ...thread.session, activeTurnId: null, status: "error", lastError: "Connector restarted during an agent turn. Inspect native history before continuing; the next request starts a fresh native session with retained context.", updatedAt: now() };
            thread.updatedAt = now();
            for (const message of thread.messages) message.streaming = false;
            thread.activities = (thread.activities ?? []).filter((a) => !["approval.requested", "user-input.requested"].includes(a.kind));
          }
        }
      }
      for (const project of this.config.projects) project.cwd = await realpath(resolve(project.cwd));
      await this.persist(); return this;
    } catch (error) { await this.close(); throw error; }
  }
  async persist() {
    const serialized = JSON.stringify(this.data);
    if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) { this.persistenceFailed = true; fail("AGENT_STATE_LIMIT", "Local conversation storage is full. Restart and remove older conversations before continuing."); }
    this.writes = this.writes.catch(() => {}).then(async () => {
      const temp = this.path + "." + randomUUID() + ".tmp";
      try {
        const file = await open(temp, "wx", 0o600);
        try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
        await rename(temp, this.path);
      } finally { await unlink(temp).catch(() => {}); }
    });
    try { return await this.writes; }
    catch { this.persistenceFailed = true; fail("AGENT_STATE_WRITE_FAILED", "Local conversation persistence failed. Repair storage and restart before continuing."); }
  }
  project(projectId) { return this.config.projects.find((p) => p.id === projectId) ?? fail("AGENT_PROJECT_UNKNOWN", "Local project is not configured."); }
  thread(threadId) { return this.data.threads.find((t) => t.id === threadId) ?? fail("AGENT_THREAD_UNKNOWN", "Conversation was not found."); }
  selection(selection) {
    const config = this.config.agents.find((a) => a.id === selection?.instanceId);
    if (!config || typeof selection.model !== "string" || !selection.model || selection.model.length > 200) fail("AGENT_SELECTION_INVALID", "Choose a configured agent and model.");
    return config;
  }
  signature(agentId) { const agent = this.config.agents.find((a) => a.id === agentId); return hash(JSON.stringify([agent.kind, agent.command ?? null, agent.args ?? []])); }
  async environmentInfo() { this.assertWritable(); return { runtimeKind: "direct", protocolVersion: 1 }; }
  assertWritable() { if (this.persistenceFailed) fail("AGENT_STATE_WRITE_FAILED", "Local persistence is unavailable. Repair storage and restart the connector."); }
  // A short cache keeps selection validation from asking a native agent for its model list on every
  // command; the hello path always refreshes it.
  async catalogueModels(agentId, { fresh = false } = {}) {
    const cached = this.modelCache.get(agentId);
    if (!fresh && cached && cached.at > Date.now() - MODEL_CACHE_MS) return cached.models;
    const models = await this.adapters.get(agentId).models();
    this.modelCache.set(agentId, { at: Date.now(), models });
    return models;
  }
  /**
   * Validate a selection's `options` against the descriptors the agent declared for that model, and
   * return the selection to store. The gateway validates too, but this connector is the last gate
   * before a native agent: an option it never declared would otherwise be remembered and later
   * forwarded as a rejected request. Values are never echoed into errors.
   */
  async checkedSelection(selection) {
    this.selection(selection);
    const stored = clone(selection);
    const options = selection.options;
    if (options === undefined || options === null || (Array.isArray(options) && options.length === 0)) { delete stored.options; return stored; }
    if (!Array.isArray(options) || options.length > MAX_OPTIONS) fail("AGENT_OPTION_INVALID", `Model options must be an array of at most ${MAX_OPTIONS} {id, value} entries.`);
    let models;
    try { models = await this.catalogueModels(selection.instanceId); } catch { fail("AGENT_UNAVAILABLE", "The agent's model options could not be read."); }
    const descriptors = models.find((m) => m.id === selection.model)?.capabilities?.optionDescriptors ?? [];
    const seen = new Set(), checked = [];
    for (const entry of options) {
      const optionId = entry?.id;
      if (typeof optionId !== "string" || !optionId || seen.has(optionId)) fail("AGENT_OPTION_INVALID", "Every model option needs a unique id.");
      seen.add(optionId);
      const descriptor = descriptors.find((d) => d.id === optionId);
      if (!descriptor) fail("AGENT_OPTION_UNSUPPORTED", "The agent does not offer this option for the selected model.");
      if (descriptor.type === "boolean" ? typeof entry.value !== "boolean" : typeof entry.value !== "string" || !(descriptor.options ?? []).some((c) => c.id === entry.value)) fail("AGENT_OPTION_UNSUPPORTED", "The agent does not offer this value for that option.");
      checked.push({ id: optionId, value: entry.value });
    }
    stored.options = checked;
    return stored;
  }
  async providerCatalogue() {
    return await Promise.all(this.config.agents.map(async (a) => {
      let models = [], error = false;
      try { models = await this.catalogueModels(a.id, { fresh: true }); } catch { error = true; }
      return { runtimeKind: "direct", providerInstanceId: a.id, id: a.id, provider: a.kind, displayName: a.label ?? a.id, label: a.label ?? a.id,
        available: !error, enabled: true, installed: !error, auth: { status: this.authenticated.has(a.id) ? "authenticated" : "unknown" }, status: error ? "unavailable" : "ready", models: models.slice(0, 100) };
    }));
  }
  async capabilityProbe() {
    return { schema: "next-coder.runtime-probe.v1", runtimeKind: "direct", probes: { metadata: "passed", snapshot: "passed", serverConfig: "passed", threadDetail: "passed" },
      serverCapabilities: { threadSnapshotPagination: false, threadResumeCompletionMarker: true },
      features: { launch: true, providerApprovals: true, structuredUserInput: true, interrupt: true, sessionStop: true, proposedPlans: false, checkpoints: false, taskLifecycle: false, terminal: false },
    };
  }
  async snapshot() {
    return { snapshotSequence: this.data.sequence, updatedAt: now(),
      projects: this.config.projects.map((p) => ({ id: p.id, title: p.title ?? p.id, workspaceRoot: p.cwd, createdAt: p.createdAt ?? null,
        defaultModelSelection: { instanceId: p.defaultAgent ?? this.config.agents[0].id, model: p.defaultModel ?? "default" } })),
      threads: this.data.threads.filter((t) => !t.deletedAt).map((t) => this.shell(t)) };
  }
  shell(thread) { const { messages, activities, bindings, handoffs, ...shell } = thread; return clone(shell); }
  detail(threadId) {
    const thread = this.thread(threadId), messages = [], activities = [];
    let bytes = 0;
    for (const message of [...thread.messages].reverse()) {
      const size = Buffer.byteLength(JSON.stringify(message));
      if (bytes + size > 384 * 1024) break;
      messages.unshift(message); bytes += size;
    }
    bytes = 0;
    const pendingIds = new Set([...this.requests].filter(([, r]) => r.threadId === threadId).map(([id]) => id));
    const required = thread.activities.filter((a) => pendingIds.has(a.payload?.requestId) && ["approval.requested", "user-input.requested"].includes(a.kind));
    for (const activity of [...thread.activities].reverse()) {
      const size = Buffer.byteLength(JSON.stringify(activity));
      if (required.includes(activity) || (bytes + size <= 128 * 1024 && activities.length < 32)) { activities.unshift(activity); bytes += size; }
    }
    return { ...this.shell(thread), historyTruncated: thread.historyTruncated || messages.length < thread.messages.length,
      messages: clone(messages), activities: clone(activities) };
  }
  async threadDetail(threadId) { return this.detail(threadId); }
  async callRpc(tag, payload = {}) {
    if (tag === "server.getConfig") return { providers: await this.providerCatalogue(), threadResumeCompletionMarker: true, runtimeKind: "direct" };
    if (tag === "runtime.sessions.list") {
      this.selection({ instanceId: payload.runtimeId, model: "default" }); const project = this.project(payload.projectId);
      const result = await this.adapters.get(payload.runtimeId).list({ cwd: project.cwd, cursor: payload.cursor });
      const scoped = [];
      for (const session of result.sessions) {
        if (session.cwd && await realpath(session.cwd).catch(() => null) !== project.cwd) continue;
        scoped.push(session);
        this.discovered.set(`${project.id}:${payload.runtimeId}:${session.id}`, { ...session, expiresAt: Date.now() + 600_000 });
      }
      for (const [key, value] of this.discovered) if (value.expiresAt < Date.now()) this.discovered.delete(key);
      while (this.discovered.size > 256) this.discovered.delete(this.discovered.keys().next().value);
      return { ...result, sessions: scoped.map((s) => ({
        id: String(s.id).slice(0, 180), title: String(s.title ?? "Conversation").slice(0, 160), updatedAt: s.updatedAt ?? null, attachment: s.attachment,
      })) };
    }
    fail("AGENT_METHOD_UNSUPPORTED", "This direct runtime does not support that operation.");
  }
  async dispatch(command, options = {}) {
    this.assertWritable();
    // Answering a live request must not wait behind a long-running turn.
    if (["thread.approval.respond", "thread.user-input.respond"].includes(command.type)) return await this.answer(command);
    const task = this.tail.then(() => this.apply(command, options)); this.tail = task.catch(() => {}); return await task;
  }
  async apply(command, { signal } = {}) {
    this.assertWritable();
    if (signal?.aborted) fail("REQUEST_CANCELLED", "Request was cancelled before local dispatch.");
    if (!id(command.commandId)) fail("AGENT_COMMAND_INVALID", "A bounded command id is required.");
    const fingerprint = hash(JSON.stringify(command));
    const receipt = this.data.receipts.find((r) => r.id === command.commandId);
    if (receipt) { if (receipt.hash !== fingerprint) fail("IDEMPOTENCY_CONFLICT", "Command id was reused with different content."); return receipt.result; }
    let thread;
    if (["thread.create", "runtime.session.import"].includes(command.type)) {
      const project = this.project(command.projectId); const selection = await this.checkedSelection(command.modelSelection);
      if (command.type === "runtime.session.import" && (command.confirmResume !== true || !id(command.nativeSessionId))) fail("AGENT_IMPORT_CONFIRMATION", "Confirm the native session is idle and may be resumed by this connector.");
      const threadId = command.type === "runtime.session.import" ? "native_" + hash(`${command.projectId}:${command.modelSelection.instanceId}:${command.nativeSessionId}`).slice(0, 32) : command.threadId;
      if (!id(threadId)) fail("AGENT_THREAD_INVALID", "Conversation id is invalid.");
      thread = this.data.threads.find((t) => t.id === threadId);
      if (command.type === "runtime.session.import") {
        const linked = this.data.threads.find((t) => t.bindings[command.modelSelection.instanceId]?.nativeId === command.nativeSessionId);
        if (linked && linked.projectId !== project.id) fail("AGENT_SESSION_PROJECT_CONFLICT", "This native session is linked to a different project.");
        if (linked) thread = linked;
        if (thread) {
          if (this.active.has(thread.id) && JSON.stringify(thread.modelSelection) !== JSON.stringify(selection)) fail("AGENT_TURN_ACTIVE", "The linked conversation is active with another agent. Stop it before changing agents.");
          thread.modelSelection = selection; thread.archivedAt = null;
        }
      }
      if (!thread) {
        if (this.data.threads.length >= MAX_THREADS) fail("AGENT_THREAD_LIMIT", "Remove older local conversations before creating another.");
        const time = now(); let history = [], importedTitle = null;
        if (command.type === "runtime.session.import") {
          if (command.confirmResume !== true || !id(command.nativeSessionId)) fail("AGENT_IMPORT_CONFIRMATION", "Confirm the native session is idle and may be resumed by this connector.");
          const adapter = this.adapters.get(command.modelSelection.instanceId);
          const discoveryKey = `${project.id}:${command.modelSelection.instanceId}:${command.nativeSessionId}`;
          if (!this.discovered.has(discoveryKey) || this.discovered.get(discoveryKey).expiresAt < Date.now()) await this.callRpc("runtime.sessions.list", { runtimeId: command.modelSelection.instanceId, projectId: project.id });
          const native = this.discovered.get(discoveryKey);
          if (native?.attachment !== "resume") fail("AGENT_SESSION_UNKNOWN", "Choose a resumable native session from the current project listing.");
          importedTitle = native.title;
          history = adapter.history ? await adapter.history(native.id, project.cwd) : [];
        }
        if (signal?.aborted) fail("REQUEST_CANCELLED", "Import was cancelled before local commit.");
        thread = { id: threadId, projectId: project.id, title: String(command.title ?? importedTitle ?? "Agent conversation").slice(0, 160), modelSelection: selection,
          runtimeKind: "direct", runtimeMode: "approval-required", interactionMode: "default", createdAt: time, updatedAt: time,
          messages: history.slice(-MAX_MESSAGES).map((m) => ({ id: randomUUID(), role: m.role, text: String(m.text).slice(0, MAX_TEXT), streaming: false, createdAt: time })),
          activities: [], bindings: command.nativeSessionId ? { [command.modelSelection.instanceId]: { nativeId: command.nativeSessionId, seen: 0, signature: this.signature(command.modelSelection.instanceId) } } : {}, handoffs: [],
          session: { status: "ready", activeTurnId: null, lastError: null, providerInstanceId: command.modelSelection.instanceId, updatedAt: time } };
        if (command.nativeSessionId) thread.bindings[command.modelSelection.instanceId].seen = thread.messages.length;
        this.data.threads.push(thread);
      }
    } else {
      thread = this.thread(command.threadId);
      if (["thread.turn.interrupt", "thread.session.stop"].includes(command.type)) {
        const active = this.active.get(thread.id);
        if (active) { active.stopping = true; this.cancelRequests(thread.id); await active.adapter.interrupt(thread.bindings[active.agentId]?.nativeId, thread.id); }
      } else {
        if (this.active.has(thread.id)) fail("AGENT_TURN_ACTIVE", "Wait for the active turn or stop it before changing this conversation.");
        switch (command.type) {
          case "thread.model-selection.set": thread.modelSelection = await this.checkedSelection(command.modelSelection); break;
          case "thread.meta.update": case "thread.metadata.update": thread.title = String(command.title).slice(0, 160); break;
          case "thread.archive": thread.archivedAt = now(); break;
          case "thread.unarchive": thread.archivedAt = null; break;
          case "thread.delete": this.data.threads = this.data.threads.filter((t) => t.id !== thread.id); break;
          case "thread.turn.start": {
            if (this.active.size >= 8) fail("AGENT_BACKPRESSURE", "Eight agent turns are already active. Wait before starting another.");
            if (command.message?.attachments?.length) fail("AGENT_ATTACHMENT_UNSUPPORTED", "Direct runtimes currently accept text only.");
            if (typeof command.message?.text !== "string" || !command.message.text.trim() || command.message.text.length > MAX_TEXT) fail("AGENT_PROMPT_INVALID", "Prompt must contain 1–32000 characters.");
            if (command.modelSelection) thread.modelSelection = await this.checkedSelection(command.modelSelection);
            this.selection(thread.modelSelection);
            const turnId = randomUUID(), time = now();
            thread.session = { ...thread.session, status: "starting", activeTurnId: turnId, lastTurnId: turnId, lastError: null, providerInstanceId: thread.modelSelection.instanceId, updatedAt: time };
            const message = { id: command.message.messageId ?? randomUUID(), role: "user", text: command.message.text, createdAt: time, streaming: false };
            thread.messages.push(message); thread.updatedAt = time;
            // Persist the run claim before execution. A restart never blindly replays a prompt.
            const result = { accepted: true, threadId: thread.id, turnId };
            this.remember(command.commandId, fingerprint, result); await this.persist();
            const active = { adapter: this.adapters.get(thread.modelSelection.instanceId), agentId: thread.modelSelection.instanceId, stopping: false };
            this.active.set(thread.id, active);
            active.done = this.run(thread, message, active).catch(() => {});
            return result;
          }
          default: fail("AGENT_COMMAND_UNSUPPORTED", "This operation is not supported by direct runtimes.");
        }
      }
    }
    const result = { accepted: true, threadId: thread.id };
    this.remember(command.commandId, fingerprint, result); await this.persist(); this.publish(thread); return result;
  }
  remember(commandId, fingerprint, result) {
    this.data.receipts.push({ id: commandId, hash: fingerprint, result, at: Date.now() });
    this.data.receipts = this.data.receipts.filter((r) => r.at > Date.now() - 86_400_000).slice(-MAX_RECEIPTS);
  }
  async run(thread, message, active) {
    const agentId = active.agentId;
    const binding = thread.bindings[agentId]?.signature === this.signature(agentId) ? thread.bindings[agentId] : undefined;
    const missed = thread.messages.slice(binding?.seen ?? 0, -1);
    const handoff = missed.length ? `Historical conversation context (may omit older details; re-check current workspace files):\n${missed.map((m) => `${m.role}: ${m.text}`).join("\n").slice(-12_000)}\n\nCurrent user request:\n` : "";
    const assistant = { id: randomUUID(), role: "assistant", text: "", createdAt: now(), streaming: true };
    thread.messages.push(assistant);
    if (handoff) thread.handoffs.push({ id: randomUUID(), targetAgentId: agentId, status: "pending", createdAt: now(), messageIds: missed.map((m) => m.id).slice(-MAX_MESSAGES) });
    thread.handoffs = thread.handoffs.slice(-32);
    thread.session.status = "running"; this.publish(thread);
    try {
      // The uncertainty marker must reach disk before a resumed native session can read context.
      await this.persist();
      if (active.stopping) fail("AGENT_INTERRUPTED", "Agent turn interrupted before start.");
      await active.adapter.run({ nativeId: binding?.nativeId, cwd: this.project(thread.projectId).cwd, model: thread.modelSelection.model, options: thread.modelSelection.options ?? [],
        shouldStop: () => active.stopping,
        prompt: handoff + message.text, runKey: thread.id,
        onNativeId: async (nativeId) => {
          if (thread.bindings[agentId]?.nativeId !== nativeId || thread.bindings[agentId]?.signature !== this.signature(agentId)) {
            thread.bindings[agentId] = { nativeId, seen: binding?.seen ?? 0, signature: this.signature(agentId) }; await this.persist();
          }
          if (active.stopping) await active.adapter.interrupt(nativeId, thread.id);
        },
        onText: (delta) => {
          if (assistant.text.length >= MAX_TEXT) return;
          const appended = String(delta).slice(0, MAX_TEXT - assistant.text.length);
          assistant.text += appended; this.publish(thread, { messageId: assistant.id, text: appended, createdAt: assistant.createdAt });
        },
        ask: (request, signal) => this.ask(thread, request, signal),
      });
      if (active.stopping) fail("AGENT_INTERRUPTED", "Agent turn interrupted.");
      thread.session.status = "ready"; thread.session.lastError = null;
      this.authenticated.add(agentId);
      if (thread.bindings[agentId]) thread.bindings[agentId].seen = thread.messages.length;
      if (handoff) thread.handoffs.at(-1).status = "delivered";
    } catch (error) {
      this.authenticated.delete(agentId);
      thread.session.status = "error";
      const code = typeof error?.code === "string" && /^[A-Z0-9_]{2,64}$/u.test(error.code) ? error.code : "AGENT_TURN_FAILED";
      const messages = { AGENT_INTERRUPTED: "Agent turn interrupted.", AGENT_UNAVAILABLE: "The local agent could not start. Check its installation and configured executable.",
        AGENT_REQUEST_REJECTED: "The native agent refused this operation. Check its local login, selected model and saved session.",
        AGENT_REQUEST_UNCERTAIN: "The native request timed out. Inspect its saved history before continuing.", AGENT_RESULT_MISSING: "The agent closed without a terminal result.",
        AGENT_FRAME_LIMIT: "The native response exceeded the transport limit. Inspect it locally or start a fresh conversation." };
      thread.session.lastError = JSON.stringify({ type: code.toLowerCase(), message: messages[code] ?? "Agent turn failed. Inspect the local agent and its session before continuing." });
      // A lost transport/result may leave an unobserved native turn running, even on the
      // first request where no handoff was necessary. Never resume that uncertain session.
      const uncertain = ["AGENT_REQUEST_UNCERTAIN", "AGENT_EXITED", "AGENT_PROTOCOL_INVALID", "AGENT_FRAME_LIMIT", "AGENT_RESULT_MISSING"].includes(code);
      if (handoff) thread.handoffs.at(-1).status = "uncertain";
      if (handoff || uncertain) {
        delete thread.bindings[agentId];
        thread.session.lastError = JSON.stringify({ type: code.toLowerCase(), message: (messages[code] ?? "The native session could not be observed reliably.") + " Inspect native history before continuing; the next request starts a fresh native session with retained context." });
      }
    } finally {
      assistant.streaming = false; thread.updatedAt = now(); assistant.createdAt = thread.updatedAt; thread.session.updatedAt = thread.updatedAt; thread.session.activeTurnId = null;
      thread.lastOutcome = { turnId: thread.session.lastTurnId, completedAt: thread.updatedAt,
        status: thread.session.status === "ready" ? "completed" : "failed",
        preview: thread.session.status === "ready" ? assistant.text.slice(0, 240) + (assistant.text.length > 240 ? "… [open thread for full reply]" : "") : null };
      if (assistant.text.length >= MAX_TEXT) assistant.text = assistant.text.slice(0, MAX_TEXT - 90) + "\n[Output shortened. Read the native agent session for the complete response.]";
      this.cancelRequests(thread.id); this.active.delete(thread.id);
      let dropped = Math.max(0, thread.messages.length - MAX_MESSAGES);
      let bytes = thread.messages.slice(dropped).reduce((n, m) => n + Buffer.byteLength(m.text), 0);
      while (bytes > 64 * 1024 && dropped < thread.messages.length - 2) { bytes -= Buffer.byteLength(thread.messages[dropped].text); dropped++; }
      thread.historyTruncated = thread.historyTruncated || dropped > 0;
      thread.messages = thread.messages.slice(dropped);
      for (const value of Object.values(thread.bindings)) value.seen = Math.max(0, value.seen - dropped);
      try { await this.persist(); } catch { thread.session.status = "error"; thread.session.lastError = "Local persistence failed; stop and repair the connector before continuing."; }
      this.publish(thread);
    }
  }
  ask(thread, request, signal) {
    if (this.requests.size >= 64 || [...this.requests.values()].filter((r) => r.threadId === thread.id).length >= 4 || signal?.aborted) return Promise.reject(agentError("AGENT_REQUEST_STALE", "Agent request is no longer available."));
    const requestId = randomUUID(), question = request.kind === "question";
    if (question && (!Array.isArray(request.questions) || request.questions.length < 1 || request.questions.length > 16 || Buffer.byteLength(JSON.stringify(request.questions)) > 32 * 1024)) return Promise.reject(agentError("AGENT_QUESTION_LIMIT", "Provider questions exceeded the supported bounds."));
    if (!question) {
      // The decisions the native agent offered for THIS request, in the gateway's vocabulary.
      // An unrecognisable list would strand the approval, so the request fails closed instead.
      const decisions = canonicalDecisions(request.decisions);
      if (!decisions) return Promise.reject(agentError("AGENT_REQUEST_INVALID", "The agent offered no recognisable approval decision."));
      request = { ...request, title: String(request.title ?? "Permission requested").slice(0, 1500), decisions };
    }
    thread.session.status = "waiting";
    thread.activities.push({ id: requestId, createdAt: now(), kind: question ? "user-input.requested" : "approval.requested", summary: question ? "User input requested" : "Provider approval requested", tone: question ? "info" : "approval",
      payload: { requestId, ...(question ? { questions: request.questions } : { requestKind: "tool", detail: request.title, decisions: request.decisions }) } });
    thread.activities = thread.activities.slice(-128); this.publish(thread);
    return new Promise((resolve, reject) => {
      const expire = () => {
        const pending = this.requests.get(requestId); if (!pending) return;
        this.requests.delete(requestId); pending.cleanup();
        thread.activities.push({ id: randomUUID(), kind: question ? "user-input.resolved" : "approval.resolved", createdAt: now(), payload: { requestId } });
        this.publish(thread); reject(agentError("AGENT_REQUEST_STALE", "Agent request expired."));
      };
      const timer = setTimeout(expire, 15 * 60_000);
      signal?.addEventListener("abort", expire, { once: true });
      this.requests.set(requestId, { threadId: thread.id, request, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", expire); } });
    });
  }
  async answer(command) {
    const pending = this.requests.get(command.requestId);
    if (!pending || pending.threadId !== command.threadId) fail("AGENT_REQUEST_STALE", "The agent is no longer waiting for this request.");
    const question = pending.request.kind === "question";
    if (question !== (command.type === "thread.user-input.respond")) fail("AGENT_REQUEST_INVALID", "Approval and question answers use separate contracts.");
    const decision = question ? null : canonicalDecision(command.decision);
    if (!question && !(decision && pending.request.decisions.includes(decision))) fail("AGENT_DECISION_UNSUPPORTED", "The agent does not offer this decision.");
    if (question) {
      const answers = command.answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) fail("AGENT_ANSWER_INVALID", "Question answers must be keyed by native question id.");
      const questions = pending.request.questions;
      if (Object.keys(answers).some((key) => !questions.some((q) => q.id === key))) fail("AGENT_ANSWER_INVALID", "An answer targets an unknown question.");
      for (const q of questions) {
        const value = answers[q.id], values = Array.isArray(value) ? value : [value];
        if (!values.length || (!q.multiSelect && values.length !== 1) || values.some((v) => typeof v !== "string" || !v.trim() || v.length > 4096)) fail("AGENT_ANSWER_INVALID", "Every question needs a bounded answer.");
        if (q.options?.length && q.isOther !== true && values.some((v) => !q.options.some((option) => option.label === v))) fail("AGENT_ANSWER_INVALID", "Choose a native question option.");
      }
    }
    this.requests.delete(command.requestId); pending.cleanup();
    const thread = this.thread(command.threadId);
    thread.activities.push({ id: randomUUID(), kind: question ? "user-input.resolved" : "approval.resolved", createdAt: now(), payload: { requestId: command.requestId } });
    thread.session.status = "running";
    // Do not persist provider answers or tool inputs in command receipts.
    pending.resolve(question ? command.answers : decision); this.publish(thread);
    return { accepted: true, threadId: thread.id };
  }
  cancelRequests(threadId) {
    for (const [key, request] of this.requests) if (request.threadId === threadId) {
      this.requests.delete(key); request.cleanup(); request.reject(agentError("AGENT_REQUEST_STALE", "Agent request is no longer active."));
      this.thread(threadId).activities.push({ id: randomUUID(), kind: request.request.kind === "question" ? "user-input.resolved" : "approval.resolved", createdAt: now(), payload: { requestId: key } });
    }
  }
  publish(thread, delta = null) {
    this.data.sequence += 1;
    // Demand-driven, coalesced authoritative snapshots bound traffic to ten updates/second.
    for (const listener of this.listeners.get(thread.id) ?? []) listener.schedule(delta);
  }
  openThreadStream({ threadId }, { onItem, onClose }) {
    this.thread(threadId); const listeners = this.listeners.get(threadId) ?? new Set(); this.listeners.set(threadId, listeners);
    let timer = null, closed = false, reset = true, pendingDelta = null;
    const send = () => {
      timer = null; if (closed) return;
      try {
        if (reset) {
          onItem({ kind: "snapshot", snapshot: { snapshotSequence: this.data.sequence, thread: this.detail(threadId) } });
          onItem({ kind: "synchronized", sequence: this.data.sequence });
        } else if (pendingDelta) {
          onItem({ kind: "event", event: { id: randomUUID(), sequence: ++this.data.sequence, threadId, type: "thread.message-sent", occurredAt: now(), payload: { ...pendingDelta, role: "assistant", streaming: true } } });
        }
        reset = false; pendingDelta = null;
      }
      catch (error) { onClose?.({ error, reason: "snapshot_failed" }); }
    };
    const listener = { schedule: (delta) => {
      if (!delta) { reset = true; pendingDelta = null; }
      else if (!reset) pendingDelta = pendingDelta ? { ...delta, text: (pendingDelta.text + delta.text).slice(0, MAX_TEXT) } : delta;
      if (!closed && !timer) timer = setTimeout(send, 100);
    } };
    listeners.add(listener); void send();
    return { close: () => { closed = true; clearTimeout(timer); listeners.delete(listener); if (!listeners.size) this.listeners.delete(threadId); } };
  }
  async close() {
    for (const threadId of this.active.keys()) this.cancelRequests(threadId);
    for (const adapter of this.adapters.values()) adapter.close();
    await Promise.allSettled([...this.active.values()].map((run) => run.done));
    await this.writes.catch(() => {});
    if (this.lock) { await this.lock.close(); this.lock = null; await unlink(this.path + ".lock").catch(() => {}); }
  }
}
