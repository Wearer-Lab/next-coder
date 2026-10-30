// T3 orchestration protocol 2: the gateway-side projection onto the protocol-1 shapes the rest of
// this repository reads.
//
// THIS IS A DELIBERATE COPY of packages/connector/src/t3v2.mjs. The two ship in different
// artifacts (the Container image copies only `src/`; the connector is a separate npm package), so
// they cannot import one another, and CLAUDE.md makes direct and connector transports parallel
// implementations on purpose. They must agree about the wire, so they MUST MOVE TOGETHER: a fix
// to either projection, command mapping or stream-delta rule belongs in both, and the parity test
// in test/t3Protocol2.test.mjs compares them mechanically so drift fails a test instead of
// production. To re-sync after the connector changes, replace everything below the marker line
// with the connector file's current contents.
//
// Evidence base is the connector's: v0.1.1 contracts and its live 0.1.1 run, plus
// docs/t3-version-audit.md's re-read of the 0.1.5 bundle. Nothing here has been observed against a
// running 0.1.5 server. Whatever the connector's projection does not carry (see that audit:
// A1-A6, U2, W1 — for example tool/task `activities[]`, which protocol 2 does not put on the wire)
// is equally absent here.
// ---- BEGIN COPY of packages/connector/src/t3v2.mjs (byte-identical below this line) ----
// Protocol 2 boundary, verified against pingdotgg/t3code v0.1.1 contracts and a live server.
// T3 owns the projections and command identities. This adapter preserves the gateway's protocol
// 1 projection while its local peer uses protocol 2; it never infers successful agent completion.
const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const MAX_THREADS = 2048;
const MAX_STREAM_TEXT_BYTES = 256 * 1024;

function invalid(code) { return Object.assign(new Error(code), { code }); }

// T3's `ProviderApprovalDecision` (0.1.1 bundle :31403-31409, 0.1.5 :36665-36671): five wire
// literals. This is a CLOSED TABLE, not a pass-through, and it is a copy on purpose — the npm
// package ships `src/` alone and cannot import the gateway's vocabulary. A test pins it to
// `PROVIDER_APPROVAL_DECISIONS` in the gateway so the two cannot drift. The right-hand side is the
// gateway spelling; it is identical today, and stays a table so a future T3 rename lands here, at
// the boundary, instead of in every consumer.
const GATEWAY_DECISION = Object.freeze({
  accept: "accept",
  acceptForSession: "acceptForSession",
  acceptAlways: "acceptAlways",
  decline: "decline",
  cancel: "cancel",
});
// What to offer when T3 states a list we cannot use at all (empty, or only unknown values).
// Offering nothing would strand an agent that is blocked on the owner; falling back to the
// default set would hand out a grant the provider never listed. Refusals are the one answer that
// is safe whatever the list was meant to say — they grant nothing — and T3 accepts either on the
// wire for any request (it does not check a response against `options`; 0.1.5 :366820-366860).
const REFUSAL_ONLY = Object.freeze(["decline", "cancel"]);
// Far above the five that exist; only bounds the scan of an attacker- or bug-shaped array.
const MAX_OPTION_ENTRIES = 16;

/**
 * The decisions an approval request offers, in the gateway's vocabulary.
 *
 * Source: the `approval_request` turn item's `options: [{ decision, label, warning? }]`
 * (`ProviderApprovalOption`, 0.1.5 :36673-36677; item :38519-38527; present since 0.1.1
 * :33949-33955). Providers narrow it deliberately — Claude 0.1.5 offers decline+accept only when
 * its CLI refuses a standing rule (`CLAUDE_NO_STANDING_GRANT_OPTIONS`, :275580), Codex MCP lists
 * the persistence choices it really supports — and T3's server does not enforce it on answer, so
 * this is the only chance to carry it to the gateway's per-request narrowing.
 *
 * Only `decision` is read. `label` and `warning` are provider-authored prose and stay behind, as
 * does anything else on the entry: this field is vocabulary, not content.
 *
 * @returns {string[]|undefined} `undefined` when the request stated nothing (the gateway then
 *   applies T3's own default set); otherwise 1..5 distinct decisions in the order T3 gave them.
 */
export function v2OfferedDecisions(options) {
  if (!Array.isArray(options)) return undefined;
  const offered = [];
  for (const option of options.slice(0, MAX_OPTION_ENTRIES)) {
    const raw = option && typeof option === "object" ? option.decision : null;
    // `hasOwn` so "constructor" / "__proto__" cannot look up a function off the prototype.
    const decision = typeof raw === "string" && raw.length <= 32 && Object.hasOwn(GATEWAY_DECISION, raw)
      ? GATEWAY_DECISION[raw] : null;
    if (decision && !offered.includes(decision)) offered.push(decision);
  }
  return offered.length > 0 ? offered : [...REFUSAL_ONLY];
}

export function v2Session(thread, run = null) {
  const status = run?.status ?? thread.status ?? "idle";
  return {
    threadId: thread.id,
    providerInstanceId: run?.providerInstanceId ?? thread.providerInstanceId ?? thread.modelSelection?.instanceId,
    runtimeMode: thread.runtimeMode,
    status: status === "failed" ? "error" : status === "waiting" ? "waiting"
      : ACTIVE.has(status) ? (status === "running" ? "running" : "starting") : "ready",
    activeTurnId: ACTIVE.has(status) ? (run?.id ?? thread.activeRunId ?? thread.latestRunId ?? null) : null,
    lastError: thread.lastError ?? (status === "failed" ? "T3 run failed." : null),
    updatedAt: run?.completedAt ?? thread.updatedAt ?? run?.startedAt ?? run?.requestedAt ?? thread.createdAt,
  };
}

export function v2Shell(snapshot) {
  if (!Array.isArray(snapshot?.projects) || !Array.isArray(snapshot?.threads)) throw invalid("T3_V2_SNAPSHOT_INVALID");
  if (snapshot.threads.length > MAX_THREADS || snapshot.projects.length > 512) throw invalid("T3_SNAPSHOT_LIMIT");
  return {
    snapshotSequence: snapshot.snapshotSequence,
    projects: snapshot.projects,
    threads: snapshot.threads.map((thread) => ({ ...thread, session: v2Session(thread) })),
  };
}

export function v2RequestActivities(request, item, threadId) {
  if (!request || !item) return [];
  const question = item.type === "user_input_request";
  if (!question && item.type !== "approval_request") return [];
  const prefix = question ? "user-input" : "approval";
  const base = { threadId, createdAt: request.createdAt, tone: question ? "info" : "approval" };
  // `decisions` is the field the gateway's collectProviderApprovals() already reads for native
  // runtimes (`offeredDecisions`); T3 0.1.x states the same fact as `options[]` on the item.
  const decisions = question ? undefined : v2OfferedDecisions(item.options);
  const payload = {
    requestId: request.id,
    ...(question ? { questions: item.questions }
      : { requestKind: item.requestKind, detail: item.prompt, ...(decisions ? { decisions } : {}) }),
  };
  const activities = [{ ...base, id: request.id + ":requested", kind: prefix + ".requested",
    summary: question ? "User input requested" : "Provider approval requested", payload }];
  if (request.status === "resolved") activities.push({
    ...base, id: request.id + ":resolved", createdAt: request.resolvedAt ?? request.createdAt,
    kind: prefix + ".resolved", summary: "T3 request resolved",
    payload: { requestId: request.id, decision: request.decision, answers: request.answers },
  });
  else if (request.status !== "pending") activities.push({
    ...base, id: request.id + ":stale", createdAt: request.resolvedAt ?? request.createdAt,
    kind: "provider." + prefix + ".respond.failed", summary: "T3 request is no longer answerable",
    payload: { requestId: request.id, detail: `Stale pending ${question ? "user-input" : "approval"} request: ${request.id}. T3 request ${request.status}.` },
  });
  return activities;
}

export function v2Thread(projection) {
  if (!projection?.thread?.id || !Array.isArray(projection.messages)) throw invalid("T3_V2_THREAD_INVALID");
  const thread = projection.thread;
  const latest = (projection.runs ?? []).reduce((chosen, run) => !chosen || run.ordinal > chosen.ordinal ? run : chosen, null);
  const items = new Map((projection.turnItems ?? []).filter((item) => item.requestId).map((item) => [item.requestId, item]));
  return {
    ...thread,
    session: v2Session(thread, latest),
    // Protocol 2 messages are absolute replacements, with an explicit streaming flag.
    messages: projection.messages,
    activities: (projection.runtimeRequests ?? []).flatMap((request) => v2RequestActivities(request, items.get(request.id), thread.id)),
  };
}

export function v2Command(command) {
  const identity = { commandId: command.commandId, threadId: command.threadId };
  switch (command.type) {
    case "thread.create":
      return { ...command, createdBy: "user", creationSource: "server" };
    case "thread.turn.start":
      return {
        ...identity, type: "message.dispatch", createdBy: "user", creationSource: "server",
        messageId: command.message.messageId, text: command.message.text,
        attachments: command.message.attachments ?? [], dispatchMode: { type: "start_immediately" },
        ...(command.modelSelection ? { modelSelection: command.modelSelection } : {}),
      };
    case "thread.turn.interrupt":
      if (!command.runId) throw invalid("T3_NO_ACTIVE_RUN");
      return { ...identity, type: "run.interrupt", runId: command.runId };
    case "thread.session.stop":
      return { ...identity, type: "thread.stop" };
    case "thread.approval.respond": case "thread.user-input.respond":
      return { ...identity, type: "runtime-request.respond", requestId: command.requestId,
        ...(command.decision ? { decision: command.decision } : {}),
        ...(command.answers ? { answers: command.answers } : {}) };
    case "thread.metadata.update":
    case "thread.runtime-mode.set": case "thread.interaction-mode.set":
    case "thread.user-input.dismiss": case "thread.model-selection.set":
    case "thread.archive": case "thread.unarchive": case "thread.delete":
      return command;
    default: throw invalid("T3_V2_COMMAND_UNSUPPORTED");
  }
}

export function createV2StreamProjection() {
  const text = new Map();
  const requests = new Map();
  const items = new Map();
  let lastSequence = null;
  let thread = null;
  function rememberText(id, value) {
    text.set(id, value);
    let bytes = 0;
    for (const value of text.values()) bytes += Buffer.byteLength(value);
    if (bytes > MAX_STREAM_TEXT_BYTES || text.size > 64) throw invalid("T3_STREAM_RESET_REQUIRED");
  }
  function legacyEvent(item, type, payload) {
    return { kind: "event", event: { sequence: item.sequence, eventId: item.event.id,
      threadId: item.event.threadId, occurredAt: item.event.occurredAt, type, payload } };
  }
  return (item) => {
    if (item?.kind === "synchronized") return [item];
    if (item?.kind === "snapshot") {
      thread = v2Thread(item.projection);
      text.clear(); requests.clear(); items.clear();
      for (const message of thread.messages) if (message.streaming) rememberText(message.id, message.text);
      for (const request of item.projection.runtimeRequests ?? []) requests.set(request.id, request);
      for (const row of item.projection.turnItems ?? []) if (row.requestId) items.set(row.requestId, row);
      if (requests.size > 512 || items.size > 512) throw invalid("T3_STREAM_RESET_REQUIRED");
      lastSequence = item.snapshotSequence;
      return [{ kind: "snapshot", snapshot: { snapshotSequence: item.snapshotSequence, thread,
        page: { hasMoreHistory: item.hasMoreHistory === true, historyCursor: item.historyCursor ?? null } } }];
    }
    if (item?.kind !== "event" || !item.event) return [];
    if (!thread) throw invalid("T3_STREAM_RESET_REQUIRED");
    if (lastSequence !== null && item.sequence <= lastSequence) return [];
    lastSequence = item.sequence;
    const event = item.event;
    if (event.type === "message.updated") {
      const message = event.payload;
      const previous = text.get(message.id) ?? "";
      if (message.streaming && !message.text.startsWith(previous)) throw invalid("T3_STREAM_RESET_REQUIRED");
      if (message.streaming) rememberText(message.id, message.text); else text.delete(message.id);
      return [legacyEvent(item, "thread.message-sent", { ...message, messageId: message.id,
        text: message.streaming ? message.text.slice(previous.length) : message.text })];
    }
    if (event.type === "run.updated" || event.type === "run.created") {
      return [legacyEvent(item, "thread.session-set", { session: v2Session(thread, event.payload) })];
    }
    if (event.type === "runtime-request.updated") requests.set(event.payload.id, event.payload);
    else if (event.type === "turn-item.updated" && event.payload.requestId) items.set(event.payload.requestId, event.payload);
    else return [legacyEvent(item, event.type, event.payload)];
    if (requests.size > 512 || items.size > 512) throw invalid("T3_STREAM_RESET_REQUIRED");
    const requestId = event.type === "runtime-request.updated" ? event.payload.id : event.payload.requestId;
    const activities = v2RequestActivities(requests.get(requestId), items.get(requestId), thread.id);
    // One native sequence must yield one gateway event; a non-pending row resolves the already
    // projected request rather than replaying the requested activity at the same sequence.
    const activity = activities.at(-1);
    return activity ? [legacyEvent(item, "thread.activity-appended", { activity })] : [];
  };
}
