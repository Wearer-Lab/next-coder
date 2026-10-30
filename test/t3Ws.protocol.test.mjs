import assert from "node:assert/strict";
import test from "node:test";

import {
  T3_THREAD_RESUME_LIMITS,
  T3_WS_METHODS,
  callT3Rpc,
  createOrchestrationProtocolCache,
  negotiateOrchestrationProtocol,
  openT3ThreadStream,
  webSocketUrlFor,
} from "../src/t3Ws.mjs";

const ENVIRONMENT = { baseUrl: "http://127.0.0.1:3773", accessToken: "test-access-token" };

// ---------------------------------------------------------------------------------------------
// A stand-in for T3's HTTP front door and Effect-RPC socket, covering the two things protocol
// negotiation touches: the unauthenticated descriptor and the `/ws` upgrade URL. Like the fake in
// threadStream.test.mjs it enforces the server's Ack latch (bundle-0.1.5.js:185697-185706), so a
// missing Ack is a stalled test rather than a silent production stall.
// ---------------------------------------------------------------------------------------------
function fakeT3({ descriptor = { orchestrationProtocolVersion: 2 }, descriptorFails = false, onRequest = () => {}, autoOpen = true } = {}) {
  const sockets = [];
  const calls = [];

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      this.listeners = new Map();
      this.pending = [];
      this.latchOpen = true;
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
      if (message._tag === "Request") onRequest(this, message);
      if (message._tag === "Ack") {
        this.latchOpen = true;
        this.drain();
      }
      if (message._tag === "Ping") this.deliver({ _tag: "Pong" });
    }

    push(...values) {
      this.pending.push(values);
      this.drain();
    }

    drain() {
      while (this.latchOpen && this.pending.length > 0) {
        this.latchOpen = false;
        this.deliver({ _tag: "Chunk", requestId: "1", values: this.pending.shift() });
      }
    }

    deliver(message) {
      if (!this.closed) this.emit("message", { data: JSON.stringify(message) });
    }

    exit(value) {
      this.deliver({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value } });
    }

    fail(cause) {
      this.deliver({ _tag: "Exit", requestId: "1", exit: { _tag: "Failure", cause } });
    }

    close() {
      this.closed = true;
    }
  }

  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, init });
    if (path === "/.well-known/t3/environment") {
      if (descriptorFails) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify(descriptor), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path === "/api/auth/websocket-ticket") {
      return new Response(JSON.stringify({ ticket: "ticket-abc" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("missing", { status: 404 });
  };

  return {
    sockets,
    calls,
    fetchImpl,
    options: { fetchImpl, WebSocketImpl: FakeSocket, pingIntervalMs: 0 },
    descriptorCalls: () => calls.filter((call) => call.path === "/.well-known/t3/environment"),
    ticketCalls: () => calls.filter((call) => call.path === "/api/auth/websocket-ticket"),
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

const urlOf = (socket) => new URL(socket.url);

// ---------------------------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------------------------

test("the socket URL adds orchestrationProtocol=2 only for protocol 2", () => {
  assert.equal(webSocketUrlFor("http://127.0.0.1:3773", "abc"), "ws://127.0.0.1:3773/ws?wsTicket=abc");
  assert.equal(webSocketUrlFor("http://127.0.0.1:3773", "abc", 1), "ws://127.0.0.1:3773/ws?wsTicket=abc");
  assert.equal(
    webSocketUrlFor("https://mac.tailnet.ts.net", "abc", 2),
    "wss://mac.tailnet.ts.net/ws?wsTicket=abc&orchestrationProtocol=2",
  );
  assert.throws(() => webSocketUrlFor("http://127.0.0.1:3773", "abc", 3), (error) => error.code === "T3_PROTOCOL_UNSUPPORTED");
});

test("a server that advertises protocol 2 is dialled with orchestrationProtocol=2 (T3 0.1.x answers 426 otherwise)", async () => {
  const t3 = fakeT3({
    descriptor: { orchestrationProtocolVersion: 2, serverVersion: "0.1.5" },
    onRequest: (socket) => socket.exit({ providers: [] }),
  });
  await callT3Rpc(ENVIRONMENT, T3_WS_METHODS.serverGetConfig, {}, t3.options);

  assert.equal(urlOf(t3.latest()).searchParams.get("orchestrationProtocol"), "2");
  assert.equal(urlOf(t3.latest()).searchParams.get("wsTicket"), "ticket-abc");
  // The descriptor is public: the bearer token has no business being sent to it.
  assert.equal(t3.descriptorCalls()[0].init.headers, undefined);
  // Negotiation happens before the ticket is minted.
  assert.deepEqual(t3.calls.map((call) => call.path), ["/.well-known/t3/environment", "/api/auth/websocket-ticket"]);
});

test("an absent orchestrationProtocolVersion means protocol 1 and the URL keeps its historical form", async () => {
  const t3 = fakeT3({ descriptor: { serverVersion: "0.0.32" }, onRequest: (socket) => socket.exit({ providers: [] }) });
  await callT3Rpc(ENVIRONMENT, T3_WS_METHODS.serverGetConfig, {}, t3.options);
  assert.equal(urlOf(t3.latest()).searchParams.has("orchestrationProtocol"), false);
});

test("a future protocol fails closed before a ticket is minted or a socket opened", async () => {
  const t3 = fakeT3({ descriptor: { orchestrationProtocolVersion: 3 } });
  await assert.rejects(
    () => callT3Rpc(ENVIRONMENT, T3_WS_METHODS.serverGetConfig, {}, t3.options),
    (error) => {
      assert.equal(error.code, "T3_PROTOCOL_UNSUPPORTED");
      // 426 is T3's own status for this condition; src/environmentFailure.mjs maps it to
      // `contract_incompatible`, the owner-actionable class.
      assert.equal(error.status, 426);
      assert.match(error.message, /protocol 3/u);
      return true;
    },
  );
  assert.equal(t3.ticketCalls().length, 0);
  assert.equal(t3.sockets.length, 0);
});

test("a present-but-malformed protocol is refused by name, not quietly demoted to 1", async () => {
  for (const advertised of ["2", 0, 1.5, -1, null, {}]) {
    const t3 = fakeT3({ descriptor: { orchestrationProtocolVersion: advertised } });
    const expectation = advertised === null
      ? null // null is JSON for "no value": ?? 1 treats it like an absent field
      : "T3_PROTOCOL_UNSUPPORTED";
    if (expectation === null) {
      const result = await negotiateOrchestrationProtocol(ENVIRONMENT, { fetchImpl: t3.fetchImpl });
      assert.equal(result.version, 1);
      continue;
    }
    await assert.rejects(
      () => negotiateOrchestrationProtocol(ENVIRONMENT, { fetchImpl: t3.fetchImpl }),
      (error) => error.code === expectation,
      `advertised ${JSON.stringify(advertised)}`,
    );
  }
});

test("a caller can narrow the protocols it consumes", async () => {
  const t3 = fakeT3({ descriptor: { orchestrationProtocolVersion: 2 } });
  await assert.rejects(
    () => negotiateOrchestrationProtocol(ENVIRONMENT, { fetchImpl: t3.fetchImpl, supportedProtocols: [1] }),
    (error) => error.code === "T3_PROTOCOL_UNSUPPORTED" && /only protocol 1/u.test(error.message),
  );
});

test("an unreadable descriptor falls back to protocol 1, and a socket that never opens says why", async () => {
  const t3 = fakeT3({
    descriptorFails: true,
    autoOpen: false,
  });
  const pending = callT3Rpc(ENVIRONMENT, T3_WS_METHODS.serverGetConfig, {}, t3.options);
  await until(() => t3.latest(), "the socket");
  assert.equal(urlOf(t3.latest()).searchParams.has("orchestrationProtocol"), false);
  // A refused upgrade is invisible to a WebSocket client: error, then close, before open.
  t3.latest().emit("error", {});
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "T3_SOCKET_ERROR");
    assert.match(error.message, /did not advertise an orchestration protocol/u);
    assert.match(error.message, /orchestrationProtocol=2 \(HTTP 426\)/u);
    return true;
  });
});

test("an explicit pin skips the descriptor", async () => {
  const t3 = fakeT3({ onRequest: (socket) => socket.exit({}) });
  await callT3Rpc(ENVIRONMENT, "x", {}, { ...t3.options, orchestrationProtocolVersion: 2 });
  await callT3Rpc({ ...ENVIRONMENT, orchestrationProtocolVersion: 2 }, "x", {}, t3.options);
  assert.equal(t3.descriptorCalls().length, 0);
  assert.equal(urlOf(t3.sockets[0]).searchParams.get("orchestrationProtocol"), "2");
  assert.equal(urlOf(t3.sockets[1]).searchParams.get("orchestrationProtocol"), "2");
  await assert.rejects(
    () => callT3Rpc(ENVIRONMENT, "x", {}, { ...t3.options, orchestrationProtocolVersion: 3 }),
    (error) => error.code === "T3_PROTOCOL_UNSUPPORTED",
  );
});

test("the advertised protocol is cached per cache instance and forgotten when a socket fails", async () => {
  const t3 = fakeT3({ onRequest: (socket) => socket.exit({}) });
  const protocolCache = createOrchestrationProtocolCache();
  await callT3Rpc(ENVIRONMENT, "x", {}, { ...t3.options, protocolCache });
  await callT3Rpc(ENVIRONMENT, "x", {}, { ...t3.options, protocolCache });
  assert.equal(t3.descriptorCalls().length, 1, "second call reads the cache");

  // Without a cache nothing is remembered: no state leaks between callers on the same address.
  await callT3Rpc(ENVIRONMENT, "x", {}, t3.options);
  assert.equal(t3.descriptorCalls().length, 2);

  // A T3 upgraded in place keeps its URL; a failed connect must not pin the old answer.
  const failing = fakeT3({ onRequest: (socket) => socket.emit("close", { code: 1006 }) });
  const cache = createOrchestrationProtocolCache();
  await assert.rejects(() => callT3Rpc(ENVIRONMENT, "x", {}, { ...failing.options, protocolCache: cache }), /closed before/u);
  await assert.rejects(() => callT3Rpc(ENVIRONMENT, "x", {}, { ...failing.options, protocolCache: cache }), /closed before/u);
  assert.equal(failing.descriptorCalls().length, 2);
});

test("the cache honours its TTL", async () => {
  let clock = 1000;
  const cache = createOrchestrationProtocolCache({ ttlMs: 100, now: () => clock });
  cache.set("k", 2);
  assert.equal(cache.get("k"), 2);
  clock += 101;
  assert.equal(cache.get("k"), null);
});

test("thread-resume limits record the 0.1.x thresholds and the 0.0.x one", () => {
  assert.deepEqual(T3_THREAD_RESUME_LIMITS[1], { maxReplayEvents: 1000, maxReplayBytes: null });
  assert.deepEqual(T3_THREAD_RESUME_LIMITS[2], { maxReplayEvents: 128, maxReplayBytes: 1_048_576 });
});

// ---------------------------------------------------------------------------------------------
// RPC envelope: failures are attributable, and nothing tears down
// ---------------------------------------------------------------------------------------------

test("an unknown tag arrives as a per-request Exit(Die) and is reported as that request's error", async () => {
  // The real wire form: bundle-0.1.5.js:185881 sendRequestDefect -> Exit with a Die cause array.
  const t3 = fakeT3({
    onRequest: (socket) => socket.fail([{ _tag: "Die", defect: "Unknown request tag: server.getSettings" }]),
  });
  await assert.rejects(
    () => callT3Rpc(ENVIRONMENT, "server.getSettings", {}, t3.options),
    (error) => {
      assert.equal(error.code, "T3_RPC_UNKNOWN_TAG");
      assert.equal(error.tag, "server.getSettings");
      assert.match(error.message, /server\.getSettings is not served by this T3 server/u);
      return true;
    },
  );
  assert.equal(t3.latest().closed, true);
});

test("failure causes read named fields, never a stack, and stay bounded", async () => {
  const cases = [
    {
      cause: [{ _tag: "Fail", error: { _tag: "EnvironmentAuthorizationError", message: "scope_not_granted" } }],
      match: /EnvironmentAuthorizationError: scope_not_granted/u,
    },
    {
      cause: [{ _tag: "Die", defect: { name: "Error", message: "boom", stack: "SECRET-STACK at /Users/someone/x.js" } }],
      match: /Error: boom/u,
    },
    { cause: [{ _tag: "Die", defect: "x".repeat(5000) }], match: /x{300}\.\.\./u },
  ];
  for (const { cause, match } of cases) {
    const t3 = fakeT3({ onRequest: (socket) => socket.fail(cause) });
    await assert.rejects(
      () => callT3Rpc(ENVIRONMENT, "x", {}, t3.options),
      (error) => {
        assert.equal(error.code, "T3_RPC_FAILED");
        assert.match(error.message, match);
        assert.doesNotMatch(error.message, /SECRET-STACK/u);
        assert.ok(error.message.length < 400);
        return true;
      },
    );
  }
});

test("an interrupted exit and a top-level Defect are distinguishable from a failure", async () => {
  const interrupted = fakeT3({ onRequest: (socket) => socket.fail([{ _tag: "Interrupt" }]) });
  await assert.rejects(
    () => callT3Rpc(ENVIRONMENT, "x", {}, interrupted.options),
    (error) => error.code === "T3_RPC_INTERRUPTED",
  );
  const defect = fakeT3({ onRequest: (socket) => socket.deliver({ _tag: "Defect", defect: "Invalid request id: undefined" }) });
  await assert.rejects(
    () => callT3Rpc(ENVIRONMENT, "x", {}, defect.options),
    (error) => error.code === "T3_RPC_REJECTED" && /Invalid request id/u.test(error.message),
  );
});

test("an exit for some other request id is ignored rather than settling this one", async () => {
  const t3 = fakeT3({
    onRequest: (socket) => {
      socket.deliver({ _tag: "Exit", requestId: "99", exit: { _tag: "Success", value: "wrong" } });
      socket.exit("right");
    },
  });
  assert.equal(await callT3Rpc(ENVIRONMENT, "x", {}, t3.options), "right");
});

test("a timed-out request that is still outstanding is Interrupted before the socket closes", async () => {
  const t3 = fakeT3({ onRequest: () => {} });
  await assert.rejects(
    () => callT3Rpc(ENVIRONMENT, "subscribeServerConfig", {}, { ...t3.options, timeoutMs: 40 }),
    (error) => error.code === "ETIMEDOUT" && /timed out after 40ms/u.test(error.message),
  );
  const tags = t3.latest().sent.map((message) => message._tag);
  assert.deepEqual(tags, ["Request", "Interrupt"]);
  assert.equal(t3.latest().closed, true);
});

test("settleOn reads one item from a stream that never completes, Acks it, then Interrupts", async () => {
  const t3 = fakeT3({
    onRequest: (socket) => {
      socket.push({ kind: "snapshot", snapshot: { threads: [] }, resolvedRepositoryIdentityRoots: ["/x"] });
      socket.push({ kind: "snapshot", snapshot: { threads: [{ id: "t1" }] } });
      socket.push({ kind: "synchronized" });
    },
  });
  const value = await callT3Rpc(ENVIRONMENT, T3_WS_METHODS.orchestrationSubscribeShell, {}, {
    ...t3.options,
    settleOn: (item) => item?.kind === "snapshot" && item.resolvedRepositoryIdentityRoots === undefined,
  });
  assert.deepEqual(value, { kind: "snapshot", snapshot: { threads: [{ id: "t1" }] } });
  const tags = t3.latest().sent.map((message) => message._tag);
  // Request, Ack for the identity-only snapshot, Ack for the authoritative one, then Interrupt.
  assert.deepEqual(tags, ["Request", "Ack", "Ack", "Interrupt"]);
  assert.equal(t3.latest().closed, true);
});

// ---------------------------------------------------------------------------------------------
// Thread stream on both protocols
// ---------------------------------------------------------------------------------------------

test("a protocol-2 thread stream negotiates, sends the 0.1.x payload, and Acks every chunk", async () => {
  const t3 = fakeT3();
  const items = [];
  const opens = [];
  openT3ThreadStream(ENVIRONMENT, {
    threadId: "thread_1",
    turnLimit: 8,
    afterSequence: 41,
    onItem: (item) => items.push(item),
    onOpen: (info) => opens.push(info),
  }, t3.options);
  await until(() => t3.latest()?.sent.length > 0, "the request frame");

  assert.equal(urlOf(t3.latest()).searchParams.get("orchestrationProtocol"), "2");
  const request = t3.latest().sent[0];
  assert.equal(request.tag, "orchestration.subscribeThread");
  // No `turnLimit` exists on OrchestrationV2SubscribeThreadInput (bundle-0.1.5.js:40285); the
  // snapshot is bounded by acceptBoundedSnapshot. The resume cursor is forwarded as-is.
  assert.deepEqual(request.payload, {
    threadId: "thread_1",
    afterSequence: 41,
    requestCompletionMarker: true,
    acceptBoundedSnapshot: true,
  });
  assert.deepEqual(opens, [{ orchestrationProtocolVersion: 2, protocolSource: "advertised" }]);

  t3.latest().push({ kind: "snapshot", snapshotSequence: 50, projection: {} });
  t3.latest().push({ kind: "event", sequence: 51, event: {} });
  t3.latest().push({ kind: "synchronized" });
  await until(() => items.length === 3, "all three items behind the ack latch");
  assert.equal(t3.latest().sent.filter((message) => message._tag === "Ack").length, 3);
});

test("a consumer that cannot replay may refuse to resume protocol 2, and protocol 1 is untouched", async () => {
  const v2 = fakeT3();
  openT3ThreadStream(ENVIRONMENT, { threadId: "t", afterSequence: 41, resumeProtocol2: false }, v2.options);
  await until(() => v2.latest()?.sent.length > 0, "the request frame");
  assert.equal("afterSequence" in v2.latest().sent[0].payload, false);

  const v1 = fakeT3({ descriptor: {} });
  openT3ThreadStream(ENVIRONMENT, { threadId: "t", afterSequence: 41, turnLimit: 8, resumeProtocol2: false }, v1.options);
  await until(() => v1.latest()?.sent.length > 0, "the request frame");
  assert.deepEqual(v1.latest().sent[0].payload, {
    threadId: "t",
    afterSequence: 41,
    requestCompletionMarker: true,
    turnLimit: 8,
  });
  assert.equal(urlOf(v1.latest()).searchParams.has("orchestrationProtocol"), false);
});

test("closing a protocol-2 subscription still Interrupts the server fiber first", async () => {
  const t3 = fakeT3();
  const handle = openT3ThreadStream(ENVIRONMENT, { threadId: "t" }, t3.options);
  await until(() => t3.latest()?.sent.length > 0, "the request frame");
  handle.close();
  assert.deepEqual(t3.latest().sent.map((message) => message._tag), ["Request", "Interrupt"]);
  assert.equal(t3.latest().closed, true);
});

test("a stream whose protocol the caller cannot consume ends with reason 'protocol' and opens nothing", async () => {
  const t3 = fakeT3({ descriptor: { orchestrationProtocolVersion: 3 } });
  const closes = [];
  openT3ThreadStream(ENVIRONMENT, { threadId: "t", onClose: (info) => closes.push(info) }, t3.options);
  await until(() => closes.length === 1, "a close callback");
  assert.equal(closes[0].reason, "protocol");
  assert.equal(closes[0].error.code, "T3_PROTOCOL_UNSUPPORTED");
  assert.equal(t3.ticketCalls().length, 0);
  assert.equal(t3.sockets.length, 0);
});

test("a stream on a server that dropped the method ends only itself, with an attributable error", async () => {
  const t3 = fakeT3({
    onRequest: (socket) => socket.fail([{ _tag: "Die", defect: "Unknown request tag: orchestration.subscribeThread" }]),
  });
  const closes = [];
  openT3ThreadStream(ENVIRONMENT, { threadId: "t", onClose: (info) => closes.push(info) }, t3.options);
  await until(() => closes.length === 1, "a close callback");
  assert.equal(closes[0].reason, "failure");
  assert.equal(closes[0].error.code, "T3_RPC_UNKNOWN_TAG");
  assert.equal(closes[0].error.tag, "orchestration.subscribeThread");
});
