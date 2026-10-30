import { createId, nowIso } from "./ids.mjs";
import { appendDeviceFollowUpInstruction } from "./deviceThreadOutput.mjs";
import { collectProviderApprovals, normalizeProviderApprovalDecision } from "./providerApprovals.mjs";
import { pendingUserInputRequests } from "./userInput.mjs";
import { callT3Rpc, negotiateOrchestrationProtocol, T3_WS_METHODS } from "./t3Ws.mjs";
import { v2Command, v2Shell, v2Thread } from "./t3Protocol2.mjs";

// ---------------------------------------------------------------------------------------------
// TWO ORCHESTRATION PROTOCOLS, SELECTED BY WHAT THE SERVER ADVERTISES
// ---------------------------------------------------------------------------------------------
//
// Protocol 1 (T3 0.0.x) serves the orchestration API over HTTP: GET /api/orchestration/snapshot,
// GET /api/orchestration/threads/:id, POST /api/orchestration/dispatch. Protocol 2 (T3 >= 0.1.0)
// removed all three. The 0.1.5 orchestration HTTP table is exactly `shell`, `threads/:threadId`,
// `threads/:threadId/transcript`, `/bounded` and `/history` (docs/t3-version-audit.md T1, T2;
// bundle-0.1.5.js:42414-42437, 0.1.1 at :37605-37630), and the `threads/:threadId` that survives
// returns a different document. Everything those three calls did is done over the authenticated
// WebSocket on protocol 2, exactly as packages/connector/src/t3.mjs does it:
//
//   snapshot      -> `orchestration.subscribeShell`, first authoritative snapshot, then Interrupt
//   thread detail -> `orchestration.subscribeThread` (acceptBoundedSnapshot), first snapshot, Interrupt
//   dispatch      -> `orchestration.dispatchCommand` with the command mapped by v2Command
//
// The choice is made per call from `/.well-known/t3/environment` (unauthenticated; absent field
// means 1), read through negotiateOrchestrationProtocol with the caller's `protocolCache` so a
// poll does not pay a descriptor round trip every time. A protocol neither path implements fails
// closed with T3_PROTOCOL_UNSUPPORTED before any authenticated request is made.

function selectProtocol(environment, options, timeoutMs) {
  return negotiateOrchestrationProtocol(environment, {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    timeoutMs: Math.min(timeoutMs, 5000),
    orchestrationProtocolVersion: options.orchestrationProtocolVersion,
    protocolCache: options.protocolCache ?? null,
  });
}

// The RPC leg always pins protocol 2: the decision was just made, and callT3Rpc would otherwise
// read the descriptor a second time.
function v2RpcOptions(options, timeoutMs) {
  return {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    WebSocketImpl: options.WebSocketImpl ?? globalThis.WebSocket,
    timeoutMs,
    orchestrationProtocolVersion: 2,
  };
}

// `subscribeShell` opens with the authoritative snapshot, followed (when T3 has resolved
// repository identities) by a SECOND snapshot that carries `resolvedRepositoryIdentityRoots` and
// `threads: []` (bundle-0.1.5.js:389172-389185). The connector takes the first snapshot it sees;
// matching on the marker as well makes this robust to that ordering ever changing, because
// projecting the identity-only snapshot would present an empty thread list as the truth.
const isAuthoritativeShellSnapshot = (item) => item?.kind === "snapshot"
  && item.resolvedRepositoryIdentityRoots === undefined;
const isThreadSnapshot = (item) => item?.kind === "snapshot";

export async function exchangePairingToken({ baseUrl, pairingToken, scopes }) {
  const url = new URL("/oauth/token", baseUrl);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: pairingToken,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: scopes.join(" "),
    client_label: "Next Coder Platform",
    client_device_type: "bot",
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`T3 token exchange failed with HTTP ${response.status}.`);
  }
  return response.json();
}

function taggedError(message, tags) {
  return Object.assign(new Error(message), tags);
}

export async function fetchT3EnvironmentInfo(environment, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(new URL("/.well-known/t3/environment", environment.baseUrl), {
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw taggedError(`T3 environment metadata timed out after ${timeoutMs}ms.`, { code: "ETIMEDOUT" });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw taggedError(`T3 environment metadata failed with HTTP ${response.status}.`, { status: response.status });
  }
  return response.json();
}

export async function fetchT3Snapshot(environment, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : Number.isFinite(environment?.timeoutMs) ? environment.timeoutMs : 8000;
  const protocol = await selectProtocol(environment, options, timeoutMs);
  if (protocol.version === 2) {
    const item = await callT3Rpc(
      environment,
      T3_WS_METHODS.orchestrationSubscribeShell,
      {},
      { ...v2RpcOptions(options, timeoutMs), settleOn: isAuthoritativeShellSnapshot },
    );
    // Protocol-2 shell threads carry no message bodies; thread detail is a separate read
    // (fetchT3ThreadDetail), exactly as the snapshot was bodiless on protocol 1.
    return v2Shell(item.snapshot);
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(new URL("/api/orchestration/snapshot", environment.baseUrl), {
      headers: authorizationHeaders(environment.accessToken),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      // The abort erases the original code, so re-stamp one; failure classification reads it.
      throw taggedError(`T3 snapshot timed out after ${timeoutMs}ms.`, { code: "ETIMEDOUT" });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw taggedError(`T3 snapshot failed with HTTP ${response.status}.`, { status: response.status });
  }
  return await readOrchestrationJson(response, "snapshot");
}

/**
 * Parse an orchestration response, refusing the single-page application.
 *
 * Verified against the running T3 0.1.1 on 2026-10-30: `GET /api/orchestration/snapshot` answers
 * **200 with `text/html`** — the SPA catch-all — because the API route was removed, while
 * `POST /api/orchestration/dispatch` answers a plain 404. So `response.ok` is true and the body is
 * a web page, and the only symptom was a `SyntaxError: Unexpected token '<'` from `json()` that
 * named neither the version nor the protocol.
 *
 * This path is only reachable now when protocol 1 was selected — by a genuine 0.0.x server, or by
 * the fallback taken when the environment descriptor could not be read. A 0.1.x server reached
 * that way is a protocol mismatch, and saying so is the difference between a one-line diagnosis
 * and an afternoon.
 */
async function readOrchestrationJson(response, what) {
  // Narrow to HTML on purpose, rather than "anything that is not JSON". The observed failure is
  // the SPA catch-all, and a stricter rule would reject a server or proxy that returns JSON under
  // an unusual or missing content type — breaking a working 0.0.x deployment to catch a case that
  // cannot occur there.
  const contentType = String(response.headers?.get?.("content-type") ?? "").toLowerCase();
  if (contentType.includes("html")) {
    throw taggedError(
      `T3 returned a web page instead of a ${what}, which means this server does not serve the protocol 1 orchestration HTTP API. It is most likely T3 0.1.0 or newer, which requires the orchestration protocol 2 WebSocket.`,
      { status: response.status, code: "T3_PROTOCOL_MISMATCH" },
    );
  }
  return await response.json();
}

/**
 * One thread, hydrated — messages, activities, checkpoints.
 *
 * `GET /api/orchestration/snapshot` is deliberately bodiless on the T3 side ("thread bodies
 * empty", src/orchestration/http.ts), which is why test/fixtures/t3-snapshot.json has no
 * `messages` and no `activities` on any thread. The work log lives here instead:
 * `GET /api/orchestration/threads/:threadId` (contract endpoint "threadSnapshot", success
 * `OrchestrationThreadDetailSnapshot` = {snapshotSequence, thread, page?}).
 *
 * `turnLimit` is the contract's own query-string window. Passing 1 bounds the response to the
 * most recent turn, which is all a "what is the agent doing right now" read ever needs, and
 * keeps a thread with thousands of activity rows from being pulled across the wire on a poll.
 */
export async function fetchT3ThreadDetail(environment, threadId, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : Number.isFinite(environment?.timeoutMs) ? environment.timeoutMs : 8000;
  const protocol = await selectProtocol(environment, options, timeoutMs);
  if (protocol.version === 2) {
    // `turnLimit` has no protocol-2 meaning (OrchestrationV2SubscribeThreadInput has no such
    // field); `acceptBoundedSnapshot` is what bounds the projection. Returns the thread itself,
    // with `messages` and the synthesised approval/user-input `activities`, not a `{thread}` envelope.
    const item = await callT3Rpc(
      environment,
      T3_WS_METHODS.orchestrationSubscribeThread,
      { threadId, acceptBoundedSnapshot: true },
      { ...v2RpcOptions(options, timeoutMs), settleOn: isThreadSnapshot },
    );
    return v2Thread(item.projection);
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = new URL(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, environment.baseUrl);
  if (Number.isFinite(options.turnLimit)) url.searchParams.set("turnLimit", String(options.turnLimit));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: authorizationHeaders(environment.accessToken),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw taggedError(`T3 thread snapshot timed out after ${timeoutMs}ms.`, { code: "ETIMEDOUT" });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw taggedError(`T3 thread snapshot failed with HTTP ${response.status}.`, { status: response.status });
  }
  const payload = await response.json();
  return payload?.thread ?? null;
}

export async function dispatchT3Command(environment, command, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : Number.isFinite(environment?.timeoutMs) ? environment.timeoutMs : 8000;
  const protocol = await selectProtocol(environment, options, timeoutMs);
  if (protocol.version === 2) return await dispatchT3CommandV2(environment, command, options, timeoutMs);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(new URL("/api/orchestration/dispatch", environment.baseUrl), {
    method: "POST",
    headers: {
      ...authorizationHeaders(environment.accessToken),
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    const error = new Error(`T3 dispatch failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.responseBody = responseBody;
    throw error;
  }
  return response.json();
}

/**
 * Protocol-2 dispatch. Mirrors packages/connector/src/t3.mjs dispatchCommand — keep the two in
 * step (see src/t3Protocol2.mjs).
 *
 * Two commands do not map one-to-one:
 *  - `thread.turn.interrupt` has no active-turn id on the legacy command. Protocol 2 interrupts a
 *    RUN, so the thread is read first and its `session.activeTurnId` (a run id there) is used.
 *    v2Command refuses with T3_NO_ACTIVE_RUN when nothing is running rather than guessing.
 *  - `thread.turn.start` carries `runtimeMode` / `interactionMode`, which protocol 2 stores on the
 *    THREAD rather than on the dispatched message. They are set first, as their own commands, with
 *    ids derived from the turn's commandId so a retry replays the same identities. The
 *    `modelSelection` on the turn (including its `options`, e.g. a reasoning-effort switch) is
 *    carried by v2Command untouched.
 *
 * Attachments are forwarded as the legacy shape the gateway builds, as the connector does; that
 * the protocol-2 attachment decoder accepts it has not been observed.
 */
async function dispatchT3CommandV2(environment, input, options, timeoutMs) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A T3 command object is required.");
  const rpc = v2RpcOptions(options, timeoutMs);
  let command = input;
  if (command.type === "thread.turn.interrupt") {
    const thread = await fetchT3ThreadDetail(environment, command.threadId, { ...options, orchestrationProtocolVersion: 2 });
    command = { ...command, runId: thread?.session?.activeTurnId };
  }
  if (command.type === "thread.turn.start") {
    if (command.runtimeMode) {
      await callT3Rpc(environment, T3_WS_METHODS.orchestrationDispatchCommand, {
        type: "thread.runtime-mode.set", commandId: `${command.commandId}:runtime-mode`,
        threadId: command.threadId, runtimeMode: command.runtimeMode,
      }, rpc);
    }
    if (command.interactionMode) {
      await callT3Rpc(environment, T3_WS_METHODS.orchestrationDispatchCommand, {
        type: "thread.interaction-mode.set", commandId: `${command.commandId}:interaction-mode`,
        threadId: command.threadId, interactionMode: command.interactionMode,
      }, rpc);
    }
  }
  return await callT3Rpc(environment, T3_WS_METHODS.orchestrationDispatchCommand, v2Command(command), rpc);
}

/**
 * The `{instanceId, model, options?}` T3 takes on the wire (`ModelSelectionWire`).
 *
 * `options` was previously dropped here, which is why no reasoning-effort choice could reach a
 * provider however it was selected upstream: T3 reads the per-model switches from this field and
 * from nowhere else. Omitted entirely when empty rather than sent as `[]`, so a selection that
 * sets nothing keeps whatever the thread already had instead of clearing it.
 */
function modelSelectionFor(intent) {
  return {
    instanceId: intent.runtimeId,
    model: intent.model,
    ...(Array.isArray(intent.options) && intent.options.length > 0 ? { options: intent.options } : {}),
  };
}

export function buildT3Command({ intent, threadId, attachments = [] }) {
  const commandId = createId("t3cmd");
  const createdAt = nowIso();

  switch (intent.type) {
    case "runtime_switch":
      return { type: "thread.model-selection.set", commandId, threadId, modelSelection: modelSelectionFor(intent), createdAt };
    case "runtime_import":
      return { type: "runtime.session.import", commandId, threadId, projectId: intent.projectId, nativeSessionId: intent.nativeSessionId,
        confirmResume: intent.confirmResume, modelSelection: modelSelectionFor(intent), createdAt };
    case "agent_prompt":
    case "media_prompt":
      return {
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId: createId("msg"),
          role: "user",
          text: appendDeviceFollowUpInstruction(intent.text, intent.deviceFollowUpInstruction),
          attachments,
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt,
      };
    case "shell_input":
      return {
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId: createId("msg"),
          role: "user",
          text: appendDeviceFollowUpInstruction(
            `Run this shell command if it is appropriate, explain the result, and stop if it is unsafe:\n\n${intent.command}`,
            intent.deviceFollowUpInstruction,
          ),
          attachments,
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt,
      };
    case "session_control":
      if (intent.action === "stop") {
        return { type: "thread.session.stop", commandId, threadId, createdAt };
      }
      if (intent.action === "interrupt") {
        return { type: "thread.turn.interrupt", commandId, threadId, createdAt };
      }
      return {
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId: createId("msg"),
          role: "user",
          text: appendDeviceFollowUpInstruction(
            intent.action === "continue" ? "Continue." : `Perform controller action: ${intent.action}`,
            intent.deviceFollowUpInstruction,
          ),
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt,
      };
    // `decision` is already canonical: normalizeIntent() folds the legacy approve/reject spelling
    // onto T3's own four-value ProviderApprovalDecision before it gets here. Translating again —
    // which is what this did while the vocabulary was binary — is how `acceptForSession` and
    // `cancel` became unreachable.
    case "approval_response": {
      const decision = normalizeProviderApprovalDecision(intent.decision);
      if (!decision) throw new Error(`Unsupported provider approval decision: ${intent.decision}`);
      return {
        type: "thread.approval.respond",
        commandId,
        threadId,
        requestId: intent.requestId,
        decision,
        createdAt,
      };
    }
    // A QUESTION being answered, not a permission being granted. Separate T3 command, separate
    // reactor path (src/orchestration/decider.ts:1027-1050), and the answers are already validated
    // against the request's own questions by the time they reach here — see src/userInput.mjs.
    case "user_input_response":
      return {
        type: "thread.user-input.respond",
        commandId,
        threadId,
        requestId: intent.requestId,
        answers: intent.answers,
        createdAt,
      };
    default:
      throw new Error(`Unsupported T3 command intent: ${intent.type}`);
  }
}

/**
 * The `thread.create` orchestration command.
 *
 * Verified against the installed T3 Code contract, not guessed. The source map at
 * `/opt/homebrew/lib/node_modules/t3/dist/bin.mjs.map` ships `sourcesContent` for T3's own
 * packages, and there:
 *
 *   - `packages/contracts/src/orchestration.ts:630` — `ThreadCreateCommand`, the field list below.
 *   - `packages/contracts/src/orchestration.ts:858` / `:885` — it is a member of both
 *     `DispatchableClientOrchestrationCommand` and `ClientOrchestrationCommand`.
 *   - `packages/contracts/src/environmentHttp.ts:495` — `POST /api/orchestration/dispatch` takes
 *     `ClientOrchestrationCommand` as its payload and answers `DispatchResult` (`{sequence}`).
 *
 * So creating a thread needs no WebSocket and no new transport: it is the ordinary dispatch the
 * gateway already speaks, on the same route as `thread.turn.start`.
 *
 * Three details the schema settles and the caller must respect:
 *
 *   - **`threadId` is chosen by the client.** The decider only asserts the id is *absent*
 *     (`requireThreadAbsent`, `src/orchestration/decider.ts:353`), so the new thread's id is known
 *     before the dispatch returns and there is no projection to poll for it.
 *   - **`modelSelection` and `runtimeMode` are required**, not optional. A thread cannot be created
 *     without naming a provider instance and model.
 *   - **`branch` and `worktreePath` are `NullOr`, which is nullable but not optional.** Both keys
 *     are always written, `null` when unknown.
 */
export function buildT3ThreadCreateCommand({
  project,
  title,
  modelSelection = project?.defaultModelSelection,
  runtimeMode = "approval-required",
  interactionMode = "default",
  threadId = createId("thread"),
  createdAt = nowIso(),
}) {
  if (!project?.id) throw new Error("T3 project id is required.");
  if (!modelSelection?.instanceId || !modelSelection?.model) {
    throw new Error("T3 project does not have a usable model selection.");
  }
  return {
    type: "thread.create",
    commandId: createId("t3cmd"),
    threadId,
    projectId: project.id,
    title,
    modelSelection,
    runtimeMode,
    interactionMode,
    branch: project.branch ?? null,
    worktreePath: null,
    createdAt,
  };
}

export function buildT3ProjectLaunchCommands({
  project,
  text,
  modelSelection = project?.defaultModelSelection,
  runtimeMode = "approval-required",
  interactionMode = "default",
  threadId = createId("thread"),
  attachments = [],
}) {
  const createdAt = nowIso();
  const title = deriveThreadTitle(text);
  return {
    threadId,
    createThread: buildT3ThreadCreateCommand({
      project,
      title,
      modelSelection,
      runtimeMode,
      interactionMode,
      threadId,
      createdAt,
    }),
    startTurn: {
      type: "thread.turn.start",
      commandId: createId("t3cmd"),
      threadId,
      message: {
        messageId: createId("msg"),
        role: "user",
        text,
        attachments,
      },
      modelSelection,
      titleSeed: title,
      runtimeMode,
      interactionMode,
      createdAt,
    },
  };
}

export function compressSnapshot(snapshot, threadId = null) {
  const projects = Array.isArray(snapshot?.projects) ? snapshot.projects.length : 0;
  const threadList = Array.isArray(snapshot?.threads) ? snapshot.threads : [];
  const threads = threadList.length;
  const selected = threadId ? threadList.find((thread) => thread?.id === threadId) ?? null : null;
  if (selected) {
    const sessionState = selected.session?.status ?? null;
    const turnState = selected.latestTurn?.state ?? null;
    const state = sessionState === "running" || turnState === "running"
      ? "running"
      : sessionState === "starting"
        ? "starting"
        : turnState ?? sessionState ?? "idle";
    const pending = pendingThreadInteractions(selected);
    return {
      title: "T3 Code",
      state,
      line1: compactDisplayText(selected.title ?? "Selected task", 28),
      line2: pending.approvals > 0
        ? `${pending.approvals} approval${pending.approvals === 1 ? "" : "s"} waiting`
        : pending.userInput > 0
          ? `${pending.userInput} answer${pending.userInput === 1 ? "" : "s"} waiting`
          : sessionState === "error"
            ? "Session error"
            : `Session ${state}`,
      thread: {
        id: selected.id,
        title: selected.title ?? "Selected task",
        sessionStatus: sessionState,
        latestTurnState: turnState,
        runtimeMode: selected.session?.runtimeMode ?? selected.runtimeMode ?? null,
        interactionMode: selected.interactionMode ?? null,
        pendingApprovals: pending.approvals,
        pendingUserInput: pending.userInput,
      },
    };
  }
  return {
    title: "T3 Code",
    state: "reachable",
    line1: `${projects} projects`,
    line2: `${threads} threads`,
  };
}

/**
 * How many questions this thread is blocked on, split by who is asking.
 *
 * Approvals are delegated to `collectProviderApprovals()` so this and the approval routes cannot
 * disagree about what is still open — in particular about a request T3 abandoned, which the
 * previous local copy of this loop counted as pending forever.
 */
export function pendingThreadInteractions(thread) {
  const approvals = collectProviderApprovals(thread)
    .filter((approval) => approval.status === "pending").length;

  // User-input requests are the third thing that can block a turn (src/userInput.mjs). Delegated
  // for the same reason approvals are: the local copy of this loop knew nothing about
  // `provider.user-input.respond.failed`, so a question T3 had abandoned was counted as waiting
  // forever and the screen said "1 answer waiting" for the rest of the session.
  const userInput = pendingUserInputRequests(thread).length;

  return { approvals, userInput };
}

function compactDisplayText(value, maximum) {
  const text = String(value ?? "").trim().replace(/\s+/gu, " ");
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

export function isEnvironmentTokenExpired(environment, now = Date.now()) {
  if (!environment?.accessTokenExpiresAt) return false;
  const expiresAt = Date.parse(environment.accessTokenExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function deriveThreadTitle(text) {
  const compact = String(text ?? "").trim().replace(/\s+/gu, " ");
  if (!compact) return "Next Coder session";
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
}

function authorizationHeaders(accessToken) {
  return { authorization: `Bearer ${accessToken}` };
}
