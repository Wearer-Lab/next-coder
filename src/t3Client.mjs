import { createId, nowIso } from "./ids.mjs";
import { appendDeviceFollowUpInstruction } from "./deviceThreadOutput.mjs";
import { collectProviderApprovals, normalizeProviderApprovalDecision } from "./providerApprovals.mjs";
import { pendingUserInputRequests } from "./userInput.mjs";

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
  return response.json();
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

export function buildT3Command({ intent, threadId, attachments = [] }) {
  const commandId = createId("t3cmd");
  const createdAt = nowIso();

  switch (intent.type) {
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
