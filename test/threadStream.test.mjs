import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createCommandArbiter } from "../src/commandArbiter.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { createThreadStreamHub } from "../src/threadStream.mjs";
import { openT3ThreadStream, T3_THREAD_RESUME_LIMITS } from "../src/t3Ws.mjs";

const ENVIRONMENT = { baseUrl: "http://127.0.0.1:3773", accessToken: "test-access-token" };
const workFixture = JSON.parse(await readFile(
  new URL("./fixtures/t3-work-activities-contract.json", import.meta.url),
  "utf8",
));

// ---------------------------------------------------------------------------------------------
// A stand-in for T3's Effect-RPC WebSocket server.
//
// It reproduces the one behaviour that actually decides whether this works: RpcServer.js:271-291
// creates a latch per streaming request and does `latch.closeUnsafe(); write(Chunk); await latch`,
// so the SECOND chunk never leaves the server until the client Acks the first. This fake enforces
// exactly that — a chunk offered while the latch is closed is queued, not sent — which means a
// missing Ack shows up here as a stalled test rather than as a silent production stall.
// ---------------------------------------------------------------------------------------------
function fakeT3(options = {}) {
  const { refuseTicket = false, autoOpen = true } = options;
  const sockets = [];

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      this.listeners = new Map();
      this.pending = [];
      this.latchOpen = true;
      this.request = null;
      sockets.push(this);
      if (autoOpen) queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(type, handler) {
      const existing = this.listeners.get(type) ?? [];
      existing.push(handler);
      this.listeners.set(type, existing);
    }

    emit(type, event) {
      for (const handler of this.listeners.get(type) ?? []) handler(event);
    }

    send(raw) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      if (message._tag === "Request") this.request = message;
      if (message._tag === "Ack") {
        this.latchOpen = true;
        this.drain();
      }
      if (message._tag === "Ping") this.deliver({ _tag: "Pong" });
    }

    /** Server-side: offer items for delivery, honouring the ack latch. */
    push(...values) {
      this.pending.push(values);
      this.drain();
    }

    drain() {
      while (this.latchOpen && this.pending.length > 0) {
        const values = this.pending.shift();
        this.latchOpen = false;
        this.deliver({ _tag: "Chunk", requestId: "1", values });
      }
    }

    deliver(message) {
      if (this.closed) return;
      this.emit("message", { data: JSON.stringify(message) });
    }

    drop(code = 1006) {
      this.closed = true;
      this.emit("close", { code });
    }

    close() {
      this.closed = true;
    }
  }

  const fetchImpl = async (url) => {
    assert.equal(new URL(String(url)).pathname, "/api/auth/websocket-ticket");
    if (refuseTicket) return new Response("nope", { status: 503 });
    return new Response(JSON.stringify({ ticket: "ticket-abc" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return {
    sockets,
    fetchImpl,
    streamOptions: { fetchImpl, WebSocketImpl: FakeSocket, pingIntervalMs: 0 },
    latest: () => sockets.at(-1),
  };
}

function settle(times = 6) {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index += 1) chain = chain.then(() => {});
  return chain;
}

async function until(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await settle(2);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function recordingEvents() {
  const broadcasts = [];
  return {
    broadcasts,
    typed: (type) => broadcasts.filter((entry) => entry.type === type),
    broadcastToUser: (userId, type, payload) => broadcasts.push({ userId, type, payload }),
  };
}

async function seedEnvironment(store, { userId = "user_1" } = {}) {
  await store.ensureUser({ userId, email: `${userId}@example.local` });
  return await store.upsertEnvironment({
    userId,
    label: "Mac T3",
    baseUrl: ENVIRONMENT.baseUrl,
    accessToken: ENVIRONMENT.accessToken,
  });
}

function snapshotItem(snapshotSequence, thread = {}) {
  return {
    kind: "snapshot",
    snapshot: {
      snapshotSequence,
      thread: { id: "thread_1", title: "Live", messages: [], activities: [], session: null, ...thread },
    },
  };
}

function eventItem(sequence, type, payload, extra = {}) {
  return {
    kind: "event",
    event: {
      sequence,
      eventId: `evt_${sequence}`,
      aggregateKind: "thread",
      aggregateId: "thread_1",
      occurredAt: "2026-08-24T12:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type,
      payload,
      ...extra,
    },
  };
}

function activityAppended(summary) {
  return {
    threadId: "thread_1",
    activity: {
      id: `act_${summary}`,
      tone: "tool",
      kind: "tool.started",
      summary,
      payload: { itemType: "command_execution" },
      turnId: "turn_1",
      createdAt: "2026-08-24T12:00:00.000Z",
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------------------------

test("the subscription sends T3's own subscribeThread request and acknowledges every chunk", async () => {
  const t3 = fakeT3();
  const items = [];
  openT3ThreadStream(
    ENVIRONMENT,
    { threadId: "thread_1", onItem: (item) => items.push(item) },
    t3.streamOptions,
  );

  await until(() => t3.latest()?.request, "the request frame");
  const request = t3.latest().request;
  assert.equal(request._tag, "Request");
  assert.equal(request.tag, "orchestration.subscribeThread");
  assert.deepEqual(request.payload, { threadId: "thread_1", requestCompletionMarker: true });
  assert.equal("afterSequence" in request.payload, false, "no cursor means ask for the snapshot");

  // Three chunks offered at once: the fake only releases the next one when the previous is Acked,
  // exactly as the real server's latch does.
  t3.latest().push(snapshotItem(10));
  t3.latest().push(eventItem(11, "thread.activity-appended", activityAppended("Read file")));
  t3.latest().push({ kind: "synchronized" });

  await until(() => items.length === 3, "all three items to arrive behind the ack latch");
  assert.deepEqual(items.map((item) => item.kind), ["snapshot", "event", "synchronized"]);
  assert.equal(t3.latest().sent.filter((message) => message._tag === "Ack").length, 3);
});

test("a stream that is never acknowledged stalls — which is why the ack is not optional", async () => {
  const t3 = fakeT3();
  const items = [];
  // A hand-rolled reader that forgets to Ack: this is the bug the real client must not have.
  const socketFactory = t3.streamOptions.WebSocketImpl;
  const socket = new socketFactory("ws://127.0.0.1:3773/ws?wsTicket=t");
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message._tag === "Chunk") items.push(...message.values);
  });
  socket.push(snapshotItem(1));
  socket.push(eventItem(2, "thread.activity-appended", activityAppended("Grep")));
  await settle(10);
  assert.equal(items.length, 1, "the second chunk is still parked on the server's latch");
});

test("closing a subscription interrupts the server fiber rather than abandoning it", async () => {
  const t3 = fakeT3();
  const handle = openT3ThreadStream(ENVIRONMENT, { threadId: "thread_1" }, t3.streamOptions);
  await until(() => t3.latest()?.request, "the request frame");
  handle.close();
  const tags = t3.latest().sent.map((message) => message._tag);
  assert.ok(tags.includes("Interrupt"), `expected an Interrupt, got ${tags.join(",")}`);
  assert.equal(t3.latest().closed, true);
});

test("a refused ticket ends the stream instead of leaving a caller waiting", async () => {
  const t3 = fakeT3({ refuseTicket: true });
  const closes = [];
  openT3ThreadStream(
    ENVIRONMENT,
    { threadId: "thread_1", onClose: (info) => closes.push(info) },
    t3.streamOptions,
  );
  await until(() => closes.length === 1, "a close callback");
  assert.equal(closes[0].reason, "ticket");
  assert.match(closes[0].error.message, /HTTP 503/u);
  assert.equal(t3.sockets.length, 0, "no socket is opened when the ticket is refused");
});

// ---------------------------------------------------------------------------------------------
// The hub: lifecycle, resume, dedup, gap, backoff
// ---------------------------------------------------------------------------------------------

async function hubFixture({ now = () => 1_000_000, ...overrides } = {}) {
  const store = createMemoryStore();
  const environment = await seedEnvironment(store);
  const t3 = fakeT3();
  const events = recordingEvents();
  const hub = createThreadStreamHub({
    store,
    events,
    now,
    streamOptions: t3.streamOptions,
    ...overrides,
  });
  return { store, environment, t3, events, hub };
}

test("nothing is subscribed until somebody watches, and the socket goes when the last watcher does", async () => {
  let clock = 1_000_000;
  const { environment, t3, hub, events } = await hubFixture({ now: () => clock, watchTtlMs: 60_000 });

  await hub.runOnce();
  assert.equal(t3.sockets.length, 0, "no watcher, no socket");

  hub.watch({ userId: "user_1", environmentId: environment.id, threadId: "thread_1" });
  await hub.runOnce();
  await until(() => t3.sockets.length === 1, "a socket");
  t3.latest().push(snapshotItem(5));
  t3.latest().push({ kind: "synchronized" });
  await until(() => hub.isStreaming(environment.id, "thread_1"), "the stream to go live");

  // A second tick while the watch is still fresh must not open a second socket.
  await hub.runOnce();
  assert.equal(t3.sockets.length, 1);

  // Let the lease lapse: the watcher never renewed.
  clock += 60_001;
  const result = await hub.runOnce();
  assert.deepEqual(result.closed, [{ environmentId: environment.id, threadId: "thread_1" }]);
  assert.equal(t3.latest().closed, true);
  assert.equal(hub.isStreaming(environment.id, "thread_1"), false);
  assert.equal(events.typed("t3.thread.status").at(-1).payload.reason, "no-watchers");

  // And it stays gone.
  await hub.runOnce();
  assert.equal(t3.sockets.length, 1);
});

test("an explicit unwatch releases the subscription immediately", async () => {
  const { environment, t3, hub } = await hubFixture();
  hub.watch({ userId: "user_1", environmentId: environment.id, threadId: "thread_1" });
  await hub.runOnce();
  await until(() => t3.sockets.length === 1, "a socket");

  assert.equal(hub.unwatch({ userId: "user_1", environmentId: environment.id, threadId: "thread_1" }), true);
  assert.equal(t3.latest().closed, true);
  await hub.runOnce();
  assert.equal(t3.sockets.length, 1, "an unwatched thread is not reopened");
});

test("a snapshot then events reaches subscribers in order, with the cursor advancing", async () => {
  const { environment, t3, hub, events } = await hubFixture();
  hub.watch({ userId: "user_1", environmentId: environment.id, threadId: "thread_1" });
  await hub.runOnce();
  await until(() => t3.sockets.length === 1, "a socket");

  t3.latest().push(snapshotItem(100, { title: "Refactor the poller" }));
  t3.latest().push({ kind: "synchronized" });
  t3.latest().push(eventItem(101, "thread.activity-appended", activityAppended("Read file")));
  t3.latest().push(eventItem(102, "thread.activity-appended", activityAppended("Edit file")));

  await until(() => events.typed("t3.thread.event").length === 2, "two live events");

  const snapshots = events.typed("t3.thread.snapshot");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].userId, "user_1");
  assert.equal(snapshots[0].payload.reset, true);
  assert.equal(snapshots[0].payload.gap, false, "a first connect is not a gap");
  assert.equal(snapshots[0].payload.snapshotSequence, 100);
  assert.equal(snapshots[0].payload.thread.title, "Refactor the poller");

  const statuses = events.typed("t3.thread.status").map((entry) => entry.payload.state);
  assert.deepEqual(statuses, ["connecting", "live"]);

  const delivered = events.typed("t3.thread.event").map((entry) => entry.payload);
  assert.deepEqual(delivered.map((payload) => payload.sequence), [101, 102]);
  assert.equal(delivered[0].event.payload.activity.summary, "Read file");
  assert.equal(hub.describe()[0].sequence, 102);
});

test("preserves T3's verified task linkage fields through snapshot and SSE event delivery", async () => {
  const { environment, t3, hub, events } = await hubFixture();
  const [started, child] = workFixture.activities;
  hub.watch({ userId: "user_1", environmentId: environment.id, threadId: "thread_1" });
  await hub.runOnce();
  await until(() => t3.sockets.length === 1, "a socket");

  t3.latest().push(snapshotItem(500, { activities: [started] }));
  t3.latest().push({ kind: "synchronized" });
  t3.latest().push(eventItem(501, "thread.activity-appended", {
    threadId: "thread_1",
    activity: child,
  }));

  await until(
    () => events.typed("t3.thread.snapshot").length === 1
      && events.typed("t3.thread.event").length === 1,
    "the task snapshot and event",
  );
  const snapshotActivity = events.typed("t3.thread.snapshot")[0].payload.thread.activities[0];
  const eventActivity = events.typed("t3.thread.event")[0].payload.event.payload.activity;
  assert.equal(snapshotActivity.kind, "task.started");
  assert.deepEqual(snapshotActivity.payload, started.payload);
  assert.equal(eventActivity.payload.taskId, "agent_child");
  assert.equal(eventActivity.payload.parentAgentId, "agent_parent");
  assert.equal(eventActivity.payload.agentKind, "agent");
  assert.equal(eventActivity.payload.timelineBypass, undefined);
});

test("a drop resumes from the cursor and replays without duplicating or losing an event", async () => {
  let clock = 1_000_000;
  const { environment, t3, hub, events } = await hubFixture({ now: () => clock, baseBackoffMs: 1000 });
  hub.watch({ userId: "user_1", environmentId: environment.id, threadId: "thread_1" });
  await hub.runOnce();
  await until(() => t3.sockets.length === 1, "the first socket");

  t3.latest().push(snapshotItem(200));
  t3.latest().push({ kind: "synchronized" });
  t3.latest().push(eventItem(201, "thread.activity-appended", activityAppended("Read file")));
  t3.latest().push(eventItem(202, "thread.activity-appended", activityAppended("Grep")));
  await until(() => events.typed("t3.thread.event").length === 2, "two events before the drop");

  const first = t3.latest();
  first.drop();
  await settle(4);
  assert.equal(hub.describe()[0].state, "backoff");

  clock += 1000;
  await hub.runOnce();
  await until(() => t3.sockets.length === 2, "the reconnect");
  assert.deepEqual(t3.latest().request.payload, {
    threadId: "thread_1",
    afterSequence: 202,
    requestCompletionMarker: true,
  });

  // T3 replays from the cursor. The replay window and the live stream overlap by design, so 202
  // comes back — it must be dropped — while 203 and 204 are new.
  t3.latest().push(eventItem(202, "thread.activity-appended", activityAppended("Grep")));
  t3.latest().push(eventItem(203, "thread.activity-appended", activityAppended("Edit file")));
  t3.latest().push({ kind: "synchronized" });
  t3.latest().push(eventItem(204, "thread.activity-appended", activityAppended("Terminal")));

  await until(() => events.typed("t3.thread.event").length === 4, "the resumed events");
  assert.deepEqual(
    events.typed("t3.thread.event").map((entry) => entry.payload.sequence),
    [201, 202, 203, 204],
    "202 is delivered exactly once and nothing between 202 and 204 is missing",
  );
  assert.equal(events.typed("t3.thread.snapshot").length, 1, "a resume does not re-send the snapshot");
  assert.equal(hub.describe()[0].sequence, 204);
});

test("a repeated event id is dropped even when T3 sends no usable sequence", async () => {
  const { environment, t3, hub, events } = await hubFixture();
  hub.watch({ userId: "user_1", environmentId: environment.id, threadId: "thread_1" });
  await hub.runOnce();
  await until(() => t3.sockets.length === 1, "a socket");

  const unsequenced = eventItem(0, "thread.activity-appended", activityAppended("Read file"));
  delete unsequenced.event.sequence;
  t3.latest().push(unsequenced);
  t3.latest().push(unsequenced);
  await settle(10);
  assert.equal(events.typed("t3.thread.event").length, 1);
});

test("a gap T3 cannot fill arrives as a snapshot, and is published as a reset with gap: true", async () => {
  let clock = 1_000_000;
  const { environment, t3, hub, events } = await hubFixture({ now: () => clock });
  hub.watch({ userId: "user_1", environmentId: environment.id, threadId: "thread_1" });
  await hub.runOnce();
  await until(() => t3.sockets.length === 1, "the first socket");

  t3.latest().push(snapshotItem(300));
  t3.latest().push(eventItem(301, "thread.activity-appended", activityAppended("Read file")));
  await until(() => events.typed("t3.thread.event").length === 1, "one event");
  t3.latest().drop();
  await settle(4);

  clock += 1000;
  await hub.runOnce();
  await until(() => t3.sockets.length === 2, "the reconnect");
  assert.equal(t3.latest().request.payload.afterSequence, 301);

  // T3's answer when it will not replay the gap: more than 1000 events on 0.0.x (THREAD_RESUME_MAX_GAP,
  // 0.0.32 src/ws.ts:1349-1352), or more than 128 events / 1 MiB on 0.1.x (T3_THREAD_RESUME_LIMITS). A
  // snapshot instead of the replay. The gateway must say so rather than appending it silently.
  t3.latest().push(snapshotItem(9_999, { title: "Much later" }));
  t3.latest().push({ kind: "synchronized" });
  await until(() => events.typed("t3.thread.snapshot").length === 2, "the fallback snapshot");

  const reset = events.typed("t3.thread.snapshot").at(-1).payload;
  assert.equal(reset.reset, true);
  assert.equal(reset.gap, true, "a snapshot answering a resume means the gap could not be filled");
  assert.equal(reset.snapshotSequence, 9_999);
  assert.equal(hub.describe()[0].sequence, 9_999);

  // The dedup memory was cleared with the reset, so events after the new cursor still flow, and
  // stale ones from before it do not.
  t3.latest().push(eventItem(301, "thread.activity-appended", activityAppended("Stale")));
  t3.latest().push(eventItem(10_000, "thread.activity-appended", activityAppended("Fresh")));
  await until(() => events.typed("t3.thread.event").length === 2, "the post-reset event");
  assert.deepEqual(
    events.typed("t3.thread.event").map((entry) => entry.payload.sequence),
    [301, 10_000],
  );
});

test("a T3 that refuses connections is retried on a widening backoff, never in a loop", async () => {
  let clock = 1_000_000;
  const store = createMemoryStore();
  const environment = await seedEnvironment(store);
  const t3 = fakeT3({ refuseTicket: true });
  const events = recordingEvents();
  const hub = createThreadStreamHub({
    store,
    events,
    now: () => clock,
    baseBackoffMs: 1000,
    maxBackoffMs: 4000,
    streamOptions: t3.streamOptions,
  });

  hub.watch({ userId: "user_1", environmentId: environment.id, threadId: "thread_1" });

  const retries = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await hub.runOnce();
    await until(() => hub.describe()[0].failures === attempt + 1, `failure ${attempt + 1}`);
    // An immediate second tick must do nothing at all: this is the anti-tight-loop guarantee.
    const idle = await hub.runOnce();
    assert.deepEqual(idle.opened, [], "a tick inside the backoff window opens nothing");
    retries.push(events.typed("t3.thread.status").at(-1).payload.retryInMs);
    clock += retries.at(-1);
  }

  assert.deepEqual(retries, [1000, 2000, 4000, 4000, 4000], "exponential, then capped");
  assert.equal(events.typed("t3.thread.status").at(-1).payload.state, "reconnecting");
});

test("an environment whose token expired is not dialled, and is reported rather than retried hard", async () => {
  const store = createMemoryStore();
  await store.ensureUser({ userId: "user_1", email: "user_1@example.local" });
  const environment = await store.upsertEnvironment({
    userId: "user_1",
    label: "Stale",
    baseUrl: ENVIRONMENT.baseUrl,
    accessToken: "token-abc",
    accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const t3 = fakeT3();
  const events = recordingEvents();
  const hub = createThreadStreamHub({ store, events, streamOptions: t3.streamOptions });

  hub.watch({ userId: "user_1", environmentId: environment.id, threadId: "thread_1" });
  await hub.runOnce();
  assert.equal(t3.sockets.length, 0);
  assert.match(events.typed("t3.thread.status").at(-1).payload.error, /expired/u);
});

// ---------------------------------------------------------------------------------------------
// Reconciliation: the live stream and the poller must not fight
// ---------------------------------------------------------------------------------------------

async function seedDispatchedCommand(store, environmentId, { dispatchedAt } = {}) {
  const command = await store.createCommand({
    userId: "user_1",
    deviceId: null,
    environmentId,
    threadId: "thread_1",
    intent: { type: "agent_prompt", text: "do it" },
    normalized: { type: "thread.turn.start", threadId: "thread_1" },
    status: "dispatched",
  });
  if (dispatchedAt) {
    // The staleness guard reads updatedAt, so a test that needs a known dispatch time sets it.
    const stored = await store.getCommandForUser("user_1", command.id);
    stored.updatedAt = dispatchedAt;
  }
  return command;
}

test("a finished assistant message completes the dispatched command straight off the stream", async () => {
  const { store, environment, t3, hub, events } = await hubFixture();
  const command = await seedDispatchedCommand(store, environment.id);
  hub.watch({ userId: "user_1", environmentId: environment.id, threadId: "thread_1" });
  await hub.runOnce();
  await until(() => t3.sockets.length === 1, "a socket");

  t3.latest().push(snapshotItem(400));
  t3.latest().push({ kind: "synchronized" });

  const repliedAt = new Date(Date.now() + 1000).toISOString();
  // Deltas first: a streaming message is not a reply, and the delta must not be mistaken for the
  // whole text (T3's projector appends it — projector.ts:497-515).
  t3.latest().push(eventItem(401, "thread.message-sent", {
    threadId: "thread_1", messageId: "m1", role: "assistant", text: "Refactored ", streaming: true,
    turnId: "turn_1", createdAt: repliedAt, updatedAt: repliedAt,
  }));
  t3.latest().push(eventItem(402, "thread.message-sent", {
    threadId: "thread_1", messageId: "m1", role: "assistant", text: "the poller.", streaming: true,
    turnId: "turn_1", createdAt: repliedAt, updatedAt: repliedAt,
  }));
  await until(() => events.typed("t3.thread.event").length === 2, "the streamed deltas");
  assert.equal(
    (await store.getCommandForUser("user_1", command.id)).status,
    "dispatched",
    "a streaming message is not yet a reply",
  );

  t3.latest().push(eventItem(403, "thread.message-sent", {
    threadId: "thread_1", messageId: "m1", role: "assistant", text: "", streaming: false,
    turnId: "turn_1", createdAt: repliedAt, updatedAt: repliedAt,
  }));

  await until(
    async () => (await store.getCommandForUser("user_1", command.id))?.status === "completed",
    "the command to complete",
  );
  const settled = await store.getCommandForUser("user_1", command.id);
  assert.equal(settled.status, "completed");
  assert.equal(settled.result.response, "Refactored the poller.", "the assembled text, not the last delta");

  const reconciled = events.typed("command.reconciled");
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].payload.source, "stream");
});

test("a session failure on the stream fails the command with T3's own error text", async () => {
  const { store, environment, t3, hub } = await hubFixture();
  const command = await seedDispatchedCommand(store, environment.id);
  hub.watch({ userId: "user_1", environmentId: environment.id, threadId: "thread_1" });
  await hub.runOnce();
  await until(() => t3.sockets.length === 1, "a socket");

  t3.latest().push(snapshotItem(500));
  const failedAt = new Date(Date.now() + 1000).toISOString();
  t3.latest().push(eventItem(501, "thread.session-set", {
    threadId: "thread_1",
    session: {
      threadId: "thread_1",
      status: "stopped",
      activeTurnId: null,
      updatedAt: failedAt,
      lastError: JSON.stringify({ error: { message: "model not found", type: "invalid_request_error" } }),
    },
  }));

  await until(
    async () => (await store.getCommandForUser("user_1", command.id))?.status === "failed",
    "the command to fail",
  );
  const settled = await store.getCommandForUser("user_1", command.id);
  assert.equal(settled.result.reason, "model not found");
  assert.equal(settled.result.code, "invalid_request_error");
});

test("the stream and the poller share one arbiter, so a command is decided exactly once", async () => {
  const { store, environment, t3, hub, events } = await hubFixture();
  const command = await seedDispatchedCommand(store, environment.id);
  hub.watch({ userId: "user_1", environmentId: environment.id, threadId: "thread_1" });
  await hub.runOnce();
  await until(() => t3.sockets.length === 1, "a socket");

  t3.latest().push(snapshotItem(600));
  const repliedAt = new Date(Date.now() + 1000).toISOString();
  t3.latest().push(eventItem(601, "thread.message-sent", {
    threadId: "thread_1", messageId: "m1", role: "assistant", text: "done", streaming: false,
    turnId: "turn_1", createdAt: repliedAt, updatedAt: repliedAt,
  }));
  await until(
    async () => (await store.getCommandForUser("user_1", command.id))?.status === "completed",
    "the stream decision",
  );

  // The very same evidence arriving again — a later poll, or a replayed event — must be a no-op.
  t3.latest().push(eventItem(602, "thread.message-sent", {
    threadId: "thread_1", messageId: "m2", role: "assistant", text: "done again", streaming: false,
    turnId: "turn_2", createdAt: repliedAt, updatedAt: repliedAt,
  }));
  await until(() => events.typed("t3.thread.event").length === 2, "the second reply event");
  assert.equal(events.typed("command.reconciled").length, 1, "one decision, one notification");
});

test("the arbiter refuses a second decision even when two sources race the same command", async () => {
  const arbiter = createCommandArbiter();
  const command = {
    id: "cmd_1",
    status: "dispatched",
    updatedAt: "2026-08-24T12:00:00.000Z",
    metrics: {},
  };
  const applied = [];
  // Both sources see evidence at the same instant, before either write lands.
  const outcome = {
    failure: null,
    lastAssistantAt: "2026-08-24T12:00:05.000Z",
    lastAssistantText: "done",
  };
  const slowApply = async (decision) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    applied.push(decision.status);
  };
  const [left, right] = await Promise.all([
    arbiter.reconcile({ command, outcome, apply: slowApply, source: "stream" }),
    arbiter.reconcile({ command, outcome, apply: slowApply, source: "snapshot" }),
  ]);
  assert.equal(applied.length, 1, "the write happens once");
  assert.equal(Boolean(left) !== Boolean(right), true, "exactly one caller is told it decided");
  assert.equal(arbiter.decisionFor("cmd_1").status, "completed");

  // A terminal command is never re-decided, whatever later evidence says.
  const done = { ...command, status: "completed" };
  assert.equal(await arbiter.reconcile({ command: done, outcome, apply: slowApply }), null);
  assert.equal(applied.length, 1);
});

// ---------------------------------------------------------------------------------------------
// The HTTP surface
// ---------------------------------------------------------------------------------------------

async function startApp(t) {
  const app = createApp();
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.server.close());
  return { ...app, baseUrl: `http://127.0.0.1:${app.server.address().port}` };
}

test("watch and unwatch are owner-scoped routes that drive the hub", async (t) => {
  const app = await startApp(t);

  const created = await (await fetch(new URL("/v1/users/dev", app.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "user_watch", email: "watch@example.local" }),
  })).json();
  const headers = {
    authorization: `Bearer ${created.apiToken.secret}`,
    "content-type": "application/json",
  };

  const environment = (await (await fetch(new URL("/v1/t3/environments", app.baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      label: "Mock T3",
      baseUrl: ENVIRONMENT.baseUrl,
      accessToken: "mock-token",
    }),
  })).json()).environment;

  const watchUrl = `${app.baseUrl}/v1/t3/environments/${environment.id}/threads/thread_1/watch`;

  const watched = await fetch(watchUrl, { method: "POST", headers });
  assert.equal(watched.status, 200);
  const body = await watched.json();
  assert.equal(body.watch.threadId, "thread_1");
  assert.equal(body.watch.environmentId, environment.id);
  assert.equal(body.watch.state, "idle", "createApp() must not have opened a socket");
  assert.equal(app.threadStreams.describe().length, 1);

  // Renewing is idempotent: one watch, not two.
  await fetch(watchUrl, { method: "POST", headers });
  assert.equal(app.threadStreams.describe().length, 1);

  const missing = await fetch(
    `${app.baseUrl}/v1/t3/environments/env_nope/threads/thread_1/watch`,
    { method: "POST", headers },
  );
  assert.equal(missing.status, 404);

  const released = await fetch(watchUrl, { method: "DELETE", headers });
  assert.equal(released.status, 200);
  assert.deepEqual(await released.json(), { released: true });
  assert.equal(app.threadStreams.describe().length, 0);

  const anonymous = await fetch(watchUrl, { method: "POST" });
  assert.equal(anonymous.status, 401);
});

test("a reply collected before its command acknowledgement is reconciled after recording dispatch", async () => {
  const { store, environment, t3, hub, events } = await hubFixture();
  hub.watch({ userId: "user_1", environmentId: environment.id, threadId: "thread_1" });
  await hub.runOnce();
  await until(() => t3.sockets.length === 1, "a socket");
  t3.latest().push(snapshotItem(800));
  const repliedAt = new Date(Date.now() - 500).toISOString();
  t3.latest().push(eventItem(801, "thread.message-sent", { threadId: "thread_1", messageId: "fast_reply", role: "assistant", text: "Early real reply", streaming: false, createdAt: repliedAt, updatedAt: repliedAt }));
  await until(() => events.typed("t3.thread.event").length === 1, "the reply before acknowledgement");
  const command = await store.createCommand({ userId: "user_1", environmentId: environment.id, threadId: "thread_1", intent: { type: "agent_prompt", text: "reply" }, normalized: {}, status: "dispatched", metrics: { completedAt: new Date().toISOString(), dispatchDurationMs: 2000 } });
  await hub.reconcileCommand(command);
  const settled = await store.getCommandForUser("user_1", command.id);
  assert.equal(settled.status, "completed");
  assert.equal(settled.result.response, "Early real reply");
  hub.stop();
});

test("the resume limits the stream comments describe are the ones the socket client exports", () => {
  // Evidence: 0.0.32 src/ws.ts:301-307; bundle-0.1.5.js:407168 and :370527 (docs/t3-version-audit.md S2).
  // THREAD_RESUME_MAX_GAP does not exist at 0.1.x; only the shell stream keeps 1000.
  assert.deepEqual(T3_THREAD_RESUME_LIMITS[1], { maxReplayEvents: 1000, maxReplayBytes: null });
  assert.deepEqual(T3_THREAD_RESUME_LIMITS[2], { maxReplayEvents: 128, maxReplayBytes: 1_048_576 });
});
