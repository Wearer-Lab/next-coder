import { createCommandArbiter } from "./commandArbiter.mjs";
import { isEnvironmentTokenExpired } from "./t3Client.mjs";
import { parseProviderError } from "./t3Harness.mjs";
import { createT3TransportResolver } from "./t3Transport.mjs";

// The live thread stream: T3's `orchestration.subscribeThread` in, the existing SSE broker out.
//
// Until this existed the console and the controller learned what an agent had done by refetching a
// snapshot every five seconds. `orchestration.subscribeThread` had been named in T3_WS_METHODS
// since the socket client was written and was never called once.
//
// ---------------------------------------------------------------------------------------------
// WHAT THIS SUBSCRIBES TO, AND WHEN
// ---------------------------------------------------------------------------------------------
//
// Same discipline as src/snapshotPoller.mjs, one level finer. The poller refuses to poll every
// environment on the platform and tracks the users who are actually present instead; a socket per
// thread is far more expensive than an HTTP GET, so this tracks the *threads* somebody is actually
// looking at. A watch is a lease with a TTL, not a registration: a console that closes its tab, a
// controller that is unplugged, or a process that dies all stop renewing, and the subscription is
// dropped on the next tick. Nothing has to remember to unsubscribe for the socket to go away.
//
// Watches are in memory on purpose. They are a statement about who is looking *right now* at this
// gateway process — the same category of fact as the poller's active-user set and the SSE client
// list, neither of which is persisted either. Writing them to the store would mean a schema
// migration across all three store implementations to hold state that is wrong the moment the
// process restarts.
//
// ---------------------------------------------------------------------------------------------
// RESUME, DEDUPLICATION, AND THE GAP THAT CANNOT BE FILLED
// ---------------------------------------------------------------------------------------------
//
// Every T3 orchestration event carries a global, monotonically increasing `sequence`
// (packages/contracts/src/orchestration.ts:1257-1267, `EventBaseFields`). That — NOT the optional
// per-activity `sequence` at :323, which only orders activities inside a turn — is the ordering
// and resume key.
//
//   RESUME:  the highest sequence delivered is kept per watch and survives the socket. A reconnect
//            passes it as `afterSequence`, and T3 replays the persisted events after it before
//            going live (src/ws.ts:1317-1348).
//   DEDUP:   an event whose sequence is not strictly greater than the cursor is dropped. The
//            replay window and the live subscription deliberately overlap — T3 attaches the live
//            subscription before draining the replay so nothing published mid-replay is lost
//            (src/ws.ts:1300-1306) — so overlap is the normal case, not an error. Event ids are
//            also remembered in a bounded ring to catch anything arriving without a usable
//            sequence.
//   THE GAP: T3 refuses to replay more than THREAD_RESUME_MAX_GAP = 1000 events, and refuses a
//            cursor ahead of its own head (src/ws.ts:1317-1352 and :301-307). It does not error
//            and it does not truncate — it sends a full `snapshot` frame instead, because a
//            truncated replay would drop events silently.
//
//            So the gateway never has to invent a story about a gap it cannot fill: it asked to
//            resume and got a snapshot, which is T3 saying "start over from this". The gateway
//            treats that as a reset — clears its dedup memory, re-bases the cursor on the
//            snapshot's sequence — and publishes it as `t3.thread.snapshot` with `reset: true` and
//            `gap: true`. Nothing is lost: the snapshot is the thread's current state in full.
//            What is lost is the *intermediate history* between the old cursor and now — the
//            individual events are gone, only their result is visible — and `gap: true` is how a
//            client is told that, instead of quietly appending a snapshot onto a stale transcript.
//
// ---------------------------------------------------------------------------------------------
// RECONNECTION
// ---------------------------------------------------------------------------------------------
//
// A drop schedules the next attempt with exponential backoff (1s, 2s, 4s … capped), and the
// attempt only happens on a later tick. There is no retry loop anywhere in this file, so a T3 that
// is down or refusing connections is retried on a schedule rather than hammered — and because
// reconnects are driven by the same `runOnce()` the tests call, backoff is directly observable
// rather than a timing accident.

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_WATCH_TTL_MS = 60_000;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
// Enough to cover any plausible replay/live overlap without growing without bound.
const SEEN_EVENT_LIMIT = 512;
// A reply is kept only to reconcile a command and to name it in an SSE payload; a runaway
// assistant message must not become a runaway gateway allocation.
const MAX_TRACKED_REPLY_CHARS = 32_000;

// A space cannot appear in an id, and joining on one keeps a watch key readable in a log line.
const KEY_SEPARATOR = " ";

export function createThreadStreamHub({
  store,
  events = null,
  notifications = null,
  intervalMs = DEFAULT_INTERVAL_MS,
  watchTtlMs = DEFAULT_WATCH_TTL_MS,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  openStream = null,
  transportResolver = createT3TransportResolver(),
  streamOptions = {},
  // Shared with the snapshot poller by createApp(): see src/commandArbiter.mjs.
  arbiter = createCommandArbiter(),
  now = () => Date.now(),
  logger = console,
} = {}) {
  const openEnvironmentStream = openStream ?? ((environment, input, options) => (
    transportResolver.forEnvironment(environment).openThreadStream(environment, input, options)
  ));
  /** @type {Map<string, object>} one entry per watched thread; the subscription lives on it. */
  const entries = new Map();
  let timer = null;
  let inFlight = false;

  function keyFor(userId, environmentId, threadId) {
    return [userId, environmentId, threadId].join(KEY_SEPARATOR);
  }

  /**
   * Registers or renews interest in a thread. Idempotent, and cheap enough to call on every poll
   * a device makes.
   */
  function watch({ userId, environmentId, threadId, ttlMs = watchTtlMs }) {
    if (!userId || !environmentId || !threadId) return null;
    const key = keyFor(userId, environmentId, threadId);
    const at = now();
    const existing = entries.get(key);
    if (existing) {
      existing.expiresAt = at + ttlMs;
      return describeEntry(existing);
    }
    const entry = {
      key,
      userId,
      environmentId,
      threadId,
      expiresAt: at + ttlMs,
      state: "idle",
      handle: null,
      // null means "no cursor yet" — which is what asks T3 for the initial snapshot. 0 is a
      // legitimate cursor and must not be confused with it.
      sequence: null,
      resumeRequested: false,
      seenEventIds: [],
      seenEventIdSet: new Set(),
      failures: 0,
      nextAttemptAt: 0,
      lastItemAt: null,
      lastError: null,
      // Live reconciliation evidence, accumulated from events on this thread only.
      outcome: {
        threadId,
        sessionStatus: "unknown",
        activeTurnId: null,
        failure: null,
        assistantMessageCount: 0,
        lastAssistantAt: null,
        lastAssistantText: null,
      },
      streamingReply: { messageId: null, text: "" },
    };
    entries.set(key, entry);
    return describeEntry(entry);
  }

  function unwatch({ userId, environmentId, threadId }) {
    const key = keyFor(userId, environmentId, threadId);
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    closeEntry(entry, "unwatched");
    return true;
  }

  /** True while a live subscription is actually delivering for this thread. */
  function isStreaming(environmentId, threadId) {
    for (const entry of entries.values()) {
      if (entry.environmentId !== environmentId) continue;
      if (entry.threadId !== threadId) continue;
      if (entry.state === "live" || entry.state === "catching-up") return true;
    }
    return false;
  }

  function describe() {
    return [...entries.values()].map(describeEntry);
  }

  function describeEntry(entry) {
    return {
      userId: entry.userId,
      environmentId: entry.environmentId,
      threadId: entry.threadId,
      state: entry.state,
      sequence: entry.sequence,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      failures: entry.failures,
      lastError: entry.lastError,
    };
  }

  function closeEntry(entry, reason) {
    const handle = entry.handle;
    entry.handle = null;
    if (handle) {
      try {
        handle.close();
      } catch {
        // Closing a socket that is already gone is not a failure worth reporting.
      }
    }
    if (entry.state !== "idle") publishStatus(entry, "stopped", { reason });
    entry.state = "idle";
  }

  // -------------------------------------------------------------------------------------------
  // The tick. Everything that starts, stops or reconnects a socket happens here, so a test that
  // never calls runOnce() never opens one.
  // -------------------------------------------------------------------------------------------
  async function runOnce() {
    if (inFlight) return { skipped: true, opened: [], closed: [], watching: entries.size };
    inFlight = true;
    try {
      const at = now();
      const closed = [];
      const opened = [];

      for (const [key, entry] of entries) {
        if (entry.expiresAt > at) continue;
        // Nobody is watching any more. Drop the subscription and forget the cursor with it: a
        // later watcher is a new reader and gets a fresh snapshot rather than a replay from a
        // cursor whose age nobody can vouch for.
        entries.delete(key);
        closeEntry(entry, "no-watchers");
        closed.push({ environmentId: entry.environmentId, threadId: entry.threadId });
      }

      for (const entry of entries.values()) {
        if (entry.handle) continue;
        if (entry.state === "connecting") continue;
        if (entry.nextAttemptAt > at) continue;
        const started = await openFor(entry);
        if (started) opened.push({ environmentId: entry.environmentId, threadId: entry.threadId });
      }

      return { skipped: false, opened, closed, watching: entries.size };
    } finally {
      inFlight = false;
    }
  }

  async function openFor(entry) {
    let environment;
    try {
      environment = await store.getEnvironmentForUser(entry.userId, entry.environmentId);
    } catch (error) {
      scheduleRetry(entry, message(error));
      return false;
    }
    if (!environment) {
      // The environment is gone, so the watch is meaningless. Drop it rather than retrying an
      // address that will never resolve.
      entries.delete(entry.key);
      publishStatus(entry, "stopped", { reason: "environment-missing" });
      return false;
    }
    if (isEnvironmentTokenExpired(environment, now())) {
      scheduleRetry(entry, "T3 access token has expired. Re-pair this environment.");
      return false;
    }

    entry.state = "connecting";
    entry.resumeRequested = Number.isFinite(entry.sequence);
    publishStatus(entry, entry.resumeRequested ? "resuming" : "connecting", {});

    try {
      entry.handle = openEnvironmentStream(
        environment,
        {
          threadId: entry.threadId,
          ...(entry.resumeRequested ? { afterSequence: entry.sequence } : {}),
          requestCompletionMarker: true,
          onItem: (item) => { void handleItem(entry, item); },
          onClose: ({ reason, error }) => handleClose(entry, reason, error),
        },
        streamOptions,
      );
    } catch (error) {
      entry.handle = null;
      scheduleRetry(entry, message(error));
      return false;
    }
    return true;
  }

  function scheduleRetry(entry, errorMessage) {
    entry.failures += 1;
    entry.lastError = errorMessage ?? null;
    entry.state = "backoff";
    const delay = Math.min(maxBackoffMs, baseBackoffMs * 2 ** (entry.failures - 1));
    entry.nextAttemptAt = now() + delay;
    publishStatus(entry, "reconnecting", {
      attempt: entry.failures,
      retryInMs: delay,
      error: entry.lastError,
    });
  }

  function handleClose(entry, reason, error) {
    entry.handle = null;
    if (!entries.has(entry.key)) return;
    if (reason === "closed" || reason === "unwatched") {
      entry.state = "idle";
      return;
    }
    scheduleRetry(entry, error ? message(error) : `T3 thread stream ended (${reason}).`);
  }

  async function handleItem(entry, item) {
    if (!entries.has(entry.key)) return;
    entry.lastItemAt = now();
    // Anything arriving is proof the connection works; a later drop starts its backoff from
    // scratch rather than from the depth of an old outage.
    entry.failures = 0;
    entry.lastError = null;

    const kind = item?.kind;
    if (kind === "snapshot") return await handleSnapshot(entry, item.snapshot);
    if (kind === "event") return await handleEvent(entry, item.event);
    if (kind === "synchronized") {
      entry.state = "live";
      publishStatus(entry, "live", {});
    }
  }

  async function handleSnapshot(entry, snapshot) {
    // Asked to resume and handed a snapshot: T3 could not fill the gap (src/ws.ts:1349-1352).
    const gap = entry.resumeRequested === true;
    entry.resumeRequested = false;
    entry.state = "catching-up";

    const sequence = numberOrNull(snapshot?.snapshotSequence);
    entry.sequence = sequence;
    entry.seenEventIds = [];
    entry.seenEventIdSet = new Set();
    entry.streamingReply = { messageId: null, text: "" };

    const thread = snapshot?.thread ?? null;
    seedOutcomeFromThread(entry, thread);
    for (const activity of (Array.isArray(thread?.activities) ? thread.activities : []).slice(-200)) {
      await projectInteractionNotification(entry, activity);
    }

    publish(entry, "t3.thread.snapshot", {
      reset: true,
      gap,
      snapshotSequence: sequence,
      page: snapshot?.page ?? null,
      thread,
    });

    await reconcile(entry);
  }

  async function handleEvent(entry, event) {
    const sequence = numberOrNull(event?.sequence);
    const eventId = typeof event?.eventId === "string" ? event.eventId : null;

    // Primary dedup: the cursor. The replay window and the live stream overlap by design.
    if (sequence !== null && entry.sequence !== null && sequence <= entry.sequence) return;
    // Secondary: an event without a usable sequence still must not be delivered twice.
    if (eventId && entry.seenEventIdSet.has(eventId)) return;

    if (eventId) rememberEventId(entry, eventId);
    if (sequence !== null) {
      entry.sequence = entry.sequence === null ? sequence : Math.max(entry.sequence, sequence);
    }

    const decisive = applyEventToOutcome(entry, event);

    publish(entry, "t3.thread.event", {
      sequence,
      eventId,
      type: event?.type ?? null,
      occurredAt: event?.occurredAt ?? null,
      commandId: event?.commandId ?? null,
      event,
    });
    if (event?.type === "thread.activity-appended") {
      await projectInteractionNotification(entry, event?.payload?.activity);
    }

    // Reconciliation costs a listCommands, so it is only attempted on the events that can
    // actually end a turn: a session error, or a finished (non-streaming) assistant message.
    if (decisive) await reconcile(entry);
  }

  function rememberEventId(entry, eventId) {
    entry.seenEventIds.push(eventId);
    entry.seenEventIdSet.add(eventId);
    while (entry.seenEventIds.length > SEEN_EVENT_LIMIT) {
      entry.seenEventIdSet.delete(entry.seenEventIds.shift());
    }
  }

  /**
   * Folds one event into the same outcome shape `extractThreadOutcomes()` builds from a snapshot,
   * so `reconcileCommandStatus()` is reached with live evidence in exactly the form it already
   * understands — including its "evidence must be newer than the dispatch" guard.
   *
   * Returns true when the event is capable of ending a turn.
   */
  function applyEventToOutcome(entry, event) {
    const type = event?.type;
    const payload = event?.payload ?? {};

    if (type === "thread.session-set") {
      const session = payload.session ?? {};
      entry.outcome.sessionStatus = stringOrNull(session.status) ?? "unknown";
      entry.outcome.activeTurnId = stringOrNull(session.activeTurnId);
      const failure = parseProviderError(session.lastError);
      if (failure) {
        entry.outcome.failure = {
          message: failure.message,
          code: failure.code,
          // `session.updatedAt` is T3's own timestamp for the failure; the event's occurredAt is
          // the fallback, and both postdate a dispatch that is still awaiting its answer.
          at: stringOrNull(session.updatedAt) ?? stringOrNull(event?.occurredAt),
        };
        return true;
      }
      entry.outcome.failure = null;
      return false;
    }

    if (type === "thread.message-sent") {
      if (stringOrNull(payload.role) !== "assistant") return false;
      const messageId = stringOrNull(payload.messageId);
      const text = typeof payload.text === "string" ? payload.text : "";

      // A streaming message-sent carries a DELTA, not the whole message: T3's own projector
      // appends it (src/orchestration/projector.ts:497-515). A terminal frame carries the full
      // text, or empty text meaning "keep what you have".
      if (payload.streaming === true) {
        if (entry.streamingReply.messageId !== messageId) {
          entry.streamingReply = { messageId, text: "" };
        }
        entry.streamingReply.text = clip(entry.streamingReply.text + text);
        // A streaming message is not a reply yet — CLAUDE.md's rule, and the same rule the
        // snapshot path applies by filtering out `message.streaming`.
        return false;
      }

      const finalText = text.length > 0
        ? text
        : (entry.streamingReply.messageId === messageId ? entry.streamingReply.text : "");
      entry.streamingReply = { messageId: null, text: "" };
      entry.outcome.assistantMessageCount += 1;
      entry.outcome.lastAssistantText = clip(finalText);
      entry.outcome.lastAssistantAt = stringOrNull(payload.updatedAt)
        ?? stringOrNull(payload.createdAt)
        ?? stringOrNull(event?.occurredAt);
      return true;
    }

    return false;
  }

  function seedOutcomeFromThread(entry, thread) {
    const session = thread?.session ?? {};
    entry.outcome.sessionStatus = stringOrNull(session.status) ?? "unknown";
    entry.outcome.activeTurnId = stringOrNull(session.activeTurnId);
    const failure = parseProviderError(session.lastError);
    entry.outcome.failure = failure
      ? { message: failure.message, code: failure.code, at: stringOrNull(session.updatedAt) }
      : null;
    const assistantMessages = (Array.isArray(thread?.messages) ? thread.messages : [])
      .filter((row) => stringOrNull(row?.role) === "assistant" && row?.streaming !== true);
    entry.outcome.assistantMessageCount = assistantMessages.length;
    const last = assistantMessages.at(-1) ?? null;
    entry.outcome.lastAssistantText = last ? clip(typeof last.text === "string" ? last.text : "") : null;
    entry.outcome.lastAssistantAt = last
      ? (stringOrNull(last.updatedAt) ?? stringOrNull(last.createdAt))
      : null;
  }

  async function reconcile(entry) {
    let commands;
    try {
      commands = await store.listCommands(entry.userId);
    } catch (error) {
      logger?.warn?.(`thread stream: listing commands failed for ${entry.userId}: ${message(error)}`);
      return [];
    }

    const applied = [];
    for (const command of commands ?? []) {
      if (command.status !== "dispatched") continue;
      if (command.environmentId !== entry.environmentId) continue;
      if (command.threadId !== entry.threadId) continue;

      try {
        const update = await arbiter.reconcile({
          command,
          outcome: entry.outcome,
          source: "stream",
          apply: async (decision) => {
            const updated = await store.updateCommand({
              userId: entry.userId,
              commandId: command.id,
              status: decision.status,
              result: decision.result,
              metrics: {
                ...(command.metrics ?? {}),
                ...(decision.status === "failed"
                  ? { failureAt: new Date(now()).toISOString() }
                  : { completedAt: new Date(now()).toISOString() }),
              },
            });
            events?.broadcastToUser?.(entry.userId, "command.reconciled", {
              commandId: command.id,
              threadId: command.threadId,
              environmentId: entry.environmentId,
              status: decision.status,
              reason: decision.result.reason,
              observedAt: new Date(now()).toISOString(),
              source: "stream",
            });
            if (notifications?.forCommand) {
              try {
                await notifications.forCommand(updated);
              } catch (error) {
                logger?.warn?.(`thread stream: command notification failed for ${command.id}: ${message(error)}`);
              }
            }
          },
        });
        if (update) applied.push({ commandId: command.id, status: update.status });
      } catch (error) {
        logger?.warn?.(`thread stream: reconciling ${command.id} failed: ${message(error)}`);
      }
    }
    return applied;
  }

  function publish(entry, type, payload) {
    events?.broadcastToUser?.(entry.userId, type, {
      environmentId: entry.environmentId,
      threadId: entry.threadId,
      ...payload,
      observedAt: new Date(now()).toISOString(),
    });
  }

  async function projectInteractionNotification(entry, activity) {
    try {
      await notifications?.forThreadActivity?.({
        userId: entry.userId,
        environmentId: entry.environmentId,
        threadId: entry.threadId,
        activity,
      });
    } catch (error) {
      logger?.warn?.(`thread stream: notification projection failed for ${entry.threadId}: ${message(error)}`);
    }
  }

  function publishStatus(entry, state, extra) {
    publish(entry, "t3.thread.status", { state, sequence: entry.sequence, ...extra });
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      runOnce().catch((error) => logger?.warn?.(`thread stream tick failed: ${message(error)}`));
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    for (const [key, entry] of entries) {
      entries.delete(key);
      closeEntry(entry, "shutdown");
    }
  }

  async function reconcileCommand(command) {
    const entry = entries.get(keyFor(command.userId, command.environmentId, command.threadId));
    return entry ? await reconcile(entry) : [];
  }

  return { watch, unwatch, isStreaming, describe, runOnce, reconcileCommand, start, stop };
}

function clip(text) {
  if (typeof text !== "string") return "";
  return text.length > MAX_TRACKED_REPLY_CHARS ? text.slice(-MAX_TRACKED_REPLY_CHARS) : text;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
