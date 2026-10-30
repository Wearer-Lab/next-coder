// Minimal Effect-RPC-over-WebSocket client for T3 Code.
//
// The orchestration HTTP API exposes only projects and threads. Everything else — including the
// provider/harness catalogue — is served over an authenticated WebSocket speaking Effect's RPC
// protocol (effect/unstable/rpc). Reverse-engineered against T3 Code 0.0.28 and verified live
// through T3 Code 0.0.32; re-read from the shipped 0.1.1 and 0.1.5 server bundles (not observed on
// a running server) for the orchestration-protocol negotiation below. See docs/t3-version-audit.md,
// whose section 5 is the extraction procedure the `bundle-0.1.x.js:N` citations in this file refer to.
//
// Wire protocol (effect RpcMessage):
//   client -> { _tag: "Request", id, tag, payload, headers: [[k,v]...] }
//             { _tag: "Ack", requestId } | { _tag: "Interrupt", requestId } | { _tag: "Eof" } | { _tag: "Ping" }
//   server -> { _tag: "Exit", requestId, exit: { _tag: "Success", value } | { _tag: "Failure", cause: [...] } }
//             { _tag: "Chunk", requestId, values: [...] }   (streaming RPCs)
//             { _tag: "Defect", defect }                    (message-level protocol misuse only)
//
// `tag` values come from T3's own WS_METHODS contract.

export const T3_WS_METHODS = Object.freeze({
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  subscribeServerConfig: "subscribeServerConfig",
  orchestrationDispatchCommand: "orchestration.dispatchCommand",
  orchestrationSubscribeThread: "orchestration.subscribeThread",
  orchestrationSubscribeShell: "orchestration.subscribeShell",
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalAttach: "terminal.attach",
  terminalClose: "terminal.close",
});

const DEFAULT_TIMEOUT_MS = 10_000;
// A subscription can sit silent for a long time while an agent thinks. Tunnels and reverse
// proxies reap quiet sockets, so the client pings; T3 answers Pong (bundle-0.1.5.js:185890).
const DEFAULT_PING_INTERVAL_MS = 30_000;
// Failure detail comes from the server and ends up in logs and owner-visible `lastError` text.
// Bound it, and read only named fields out of it — never a stack.
const MAX_FAILURE_DETAIL_CHARS = 300;

// ---------------------------------------------------------------------------------------------
// ORCHESTRATION PROTOCOL NEGOTIATION
// ---------------------------------------------------------------------------------------------
//
// T3 0.1.0 split the orchestration API in two. The `/ws` upgrade handler answers HTTP 426
// `orchestration_protocol_incompatible` to any client whose URL lacks `orchestrationProtocol=2`,
// and it does so BEFORE it looks at the ticket (`hasCompatibleOrchestrationProtocol`,
// bundle-0.1.5.js:406750; the refusal at :408439-408443; 0.1.1 at bundle-0.1.1.js:394726 and
// :396309-396313). 0.0.x servers never read the parameter, so it is sent only when the server
// says it speaks protocol 2 — it is not a constant of this client.
//
// What the server speaks is advertised, unauthenticated, in `GET /.well-known/t3/environment` as
// `orchestrationProtocolVersion` (the value is the literal `2` at bundle-0.1.5.js:140431; the
// field is `optionalKey(Int)`, schema at :30199, and ABSENT MEANS 1 — T3's own CLI reads
// `descriptor.orchestrationProtocolVersion ?? 1`, :156817). 0.1.1 and 0.1.5 both advertise 2.
//
// The ticket route is not protocol-gated (`webSocketTicket` takes only optional bearer headers,
// bundle-0.1.5.js:42340-42343), so the ticket call is unchanged.
export const T3_ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";
export const T3_ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/t3/environment";
// The protocols whose socket FRAMING this client implements. Which item shapes a caller can
// consume on top of that is the caller's business (`supportedProtocols` narrows it): protocol 2
// replaces the thread snapshot/event items with a different projection (src/t3Protocol2.mjs).
export const T3_SUPPORTED_ORCHESTRATION_PROTOCOLS = Object.freeze([1, 2]);

/**
 * When a thread subscription resumed from `afterSequence` is answered with a fresh snapshot
 * instead of a replay. Either way the gap is "resolved as a snapshot, never an error and never a
 * truncated replay", so a consumer treats a snapshot that answers a resume as a REPLACE.
 *
 * - Protocol 1 (T3 0.0.x): replay is refused past `THREAD_RESUME_MAX_GAP` = 1000 events, or when
 *   the cursor is ahead of the head (0.0.32 src/ws.ts:301-307, :1317-1352).
 * - Protocol 2 (T3 0.1.x): `THREAD_RESUME_MAX_GAP` no longer exists. The snapshot is chosen when
 *   the cursor is ahead of the head (bundle-0.1.5.js:407157), when more than 128 events would be
 *   replayed or the replay exceeds 1 MiB (`THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES = 1048576`,
 *   :370527; `stats.eventCount > 128 || !isThreadReplayRawPayloadSafe(...)`, :407168), or when the
 *   thread was recreated (:407169); a second check on the loaded replay is `decideThreadResume`
 *   (:370513-370518). The same text is at bundle-0.1.1.js:395124-395139 and :378690. Only the
 *   SHELL subscription keeps 1000 (`SHELL_RESUME_MAX_GAP = 1e3`, bundle-0.1.5.js:407045), which
 *   this client does not open.
 *   Replayed `*.updated` events are also coalesced (`coalesceLiveUpdatedEvents`, :407176), so a
 *   replay may omit intermediate states of a message that a live stream would have shown.
 */
export const T3_THREAD_RESUME_LIMITS = Object.freeze({
  1: Object.freeze({ maxReplayEvents: 1000, maxReplayBytes: null }),
  2: Object.freeze({ maxReplayEvents: 128, maxReplayBytes: 1_048_576 }),
});

const DEFAULT_PROTOCOL_CACHE_TTL_MS = 5 * 60_000;

/**
 * A small TTL cache for the advertised protocol, keyed by origin. Deliberately NOT module state:
 * a process-wide cache would leak one environment's answer into another test or another caller
 * on the same address (a T3 upgraded in place from 0.0.32 to 0.1.1 keeps its URL). The direct
 * transport owns one; one-shot callers that pass none simply re-read the descriptor.
 */
export function createOrchestrationProtocolCache({ ttlMs = DEFAULT_PROTOCOL_CACHE_TTL_MS, now = Date.now } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key, value) {
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },
    delete(key) {
      entries.delete(key);
    },
  };
}

function t3Error(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * The refusal for a protocol this caller cannot handle. `status: 426` is the HTTP status T3
 * itself uses for the same condition, and src/environmentFailure.mjs maps it to
 * `contract_incompatible` — the owner-actionable class — instead of an anonymous "unknown".
 */
function unsupportedProtocolError(version, supported) {
  const shown = typeof version === "number" || typeof version === "string"
    ? String(version).slice(0, 32)
    : "an unreadable value";
  return t3Error(
    `T3 advertises orchestration protocol ${shown}, but this client handles only protocol ${supported.join(", ")}. `
      + "Upgrade Next Coder or pair this environment through a connector.",
    "T3_PROTOCOL_UNSUPPORTED",
    { status: 426, advertisedProtocol: version ?? null },
  );
}

function checkProtocol(version, supported) {
  if (!Number.isInteger(version) || !T3_SUPPORTED_ORCHESTRATION_PROTOCOLS.includes(version) || !supported.includes(version)) {
    throw unsupportedProtocolError(version, supported);
  }
  return version;
}

function normalizeSupported(supportedProtocols) {
  const list = Array.isArray(supportedProtocols)
    ? supportedProtocols.filter((version) => T3_SUPPORTED_ORCHESTRATION_PROTOCOLS.includes(version))
    : [...T3_SUPPORTED_ORCHESTRATION_PROTOCOLS];
  return list;
}

/**
 * Decides which orchestration protocol to speak to this environment.
 *
 * Order of authority: an explicit pin (`options.orchestrationProtocolVersion`, then
 * `environment.orchestrationProtocolVersion`), then what the server advertises, then an assumption
 * of protocol 1. The assumption exists only because the descriptor is a separate unauthenticated
 * GET that can fail on its own (a proxy that blocks `/.well-known`, a transient error) and a T3
 * old enough to predate the field is exactly the one that never needed the parameter. It is
 * reported as `source: "assumed"` so a socket that then fails to open can say so (see callT3Rpc).
 *
 * Fails closed — BEFORE a ticket is minted — on a protocol outside `supportedProtocols`: a future
 * protocol 3 must not be connected to and half-understood.
 *
 * @returns {{version: number, source: "pinned"|"advertised"|"cached"|"assumed", invalidate: () => void}}
 */
export async function negotiateOrchestrationProtocol(environment, {
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  orchestrationProtocolVersion,
  supportedProtocols,
  protocolCache = null,
} = {}) {
  const supported = normalizeSupported(supportedProtocols);
  const pinned = orchestrationProtocolVersion ?? environment?.orchestrationProtocolVersion;
  if (pinned !== undefined && pinned !== null) {
    return { version: checkProtocol(pinned, supported), source: "pinned", invalidate() {} };
  }

  const cacheKey = originOf(environment.baseUrl);
  const invalidate = () => protocolCache?.delete(cacheKey);
  const cached = protocolCache?.get(cacheKey);
  if (cached !== null && cached !== undefined) {
    return { version: checkProtocol(cached, supported), source: "cached", invalidate };
  }

  let advertised;
  try {
    advertised = await fetchAdvertisedProtocol(environment, { fetchImpl, timeoutMs });
  } catch {
    // Descriptor unreachable: fall back rather than fail, because the ticket call that follows
    // is the real reachability test and will say so with its own error.
    return { version: checkProtocol(1, supported), source: "assumed", invalidate };
  }
  const version = checkProtocol(advertised, supported);
  protocolCache?.set(cacheKey, version);
  return { version, source: "advertised", invalidate };
}

async function fetchAdvertisedProtocol(environment, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Unauthenticated on purpose: the descriptor is public (`EnvironmentMetadataHttpApi`,
    // bundle-0.1.5.js:42326) and sending the bearer token to it would gain nothing.
    const response = await fetchImpl(new URL(T3_ENVIRONMENT_DESCRIPTOR_PATH, environment.baseUrl), {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`T3 environment descriptor failed with HTTP ${response.status}.`);
    const descriptor = await response.json();
    if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      throw new Error("T3 environment descriptor was not an object.");
    }
    // ABSENT MEANS 1. A present-but-garbage value is returned as-is so checkProtocol refuses it
    // by name rather than quietly demoting it to 1.
    return descriptor.orchestrationProtocolVersion ?? 1;
  } finally {
    clearTimeout(timer);
  }
}

function originOf(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return String(baseUrl);
  }
}

export async function requestWebSocketTicket(environment, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = new URL("/api/auth/websocket-ticket", environment.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${environment.accessToken}` },
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`T3 websocket ticket timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`T3 websocket ticket failed with HTTP ${response.status}.`);
  const payload = await response.json();
  if (!payload?.ticket) throw new Error("T3 did not return a websocket ticket.");
  return payload.ticket;
}

/**
 * `protocol` 1 (the default) produces the historical URL with no parameter; 2 adds
 * `orchestrationProtocol=2`, without which T3 >= 0.1.0 refuses the upgrade with HTTP 426.
 */
export function webSocketUrlFor(baseUrl, ticket, protocol = 1) {
  checkProtocol(protocol, T3_SUPPORTED_ORCHESTRATION_PROTOCOLS);
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket);
  if (protocol === 2) url.searchParams.set(T3_ORCHESTRATION_PROTOCOL_QUERY_PARAM, "2");
  return url.toString();
}

/**
 * Performs a single request/response RPC and closes the socket.
 *
 * Kept deliberately one-shot: the gateway polls, so a persistent socket per environment would be
 * a connection-lifecycle problem without a matching benefit.
 *
 * Options beyond the transport doubles: `orchestrationProtocolVersion` pins the protocol instead
 * of reading it from the server, `protocolCache` (see createOrchestrationProtocolCache) spares a
 * descriptor round trip per call, and `supportedProtocols` narrows what the caller can consume.
 *
 * `settleOn(value)` is for reading ONE item out of a subscription that never completes (protocol
 * 2 has no unary snapshot for the shell; `subscribeShell` and `subscribeThread` are streams). The
 * first streamed value it accepts is Acked like any chunk, the request is Interrupted so the
 * server fiber is not left parked on its latch, and that value is the result. Mirrors the
 * `firstSnapshot` option of packages/connector/src/t3.mjs callRpc; keep the two in step.
 */
export async function callT3Rpc(environment, tag, payload = {}, {
  fetchImpl = fetch,
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  orchestrationProtocolVersion,
  supportedProtocols,
  protocolCache = null,
  settleOn = null,
} = {}) {
  if (typeof WebSocketImpl !== "function") {
    throw new Error("A WebSocket implementation is required to reach T3 over the socket API.");
  }

  const protocol = await negotiateOrchestrationProtocol(environment, {
    fetchImpl,
    timeoutMs,
    orchestrationProtocolVersion,
    supportedProtocols,
    protocolCache,
  });
  const ticket = await requestWebSocketTicket(environment, { fetchImpl, timeoutMs });
  const socket = new WebSocketImpl(webSocketUrlFor(environment.baseUrl, ticket, protocol.version));
  const requestId = "1";

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let opened = false;
    // True from the Request until the server's Exit. A streaming RPC that we abandon (timeout)
    // while still outstanding needs the same Interrupt a caller-initiated stream close sends.
    let outstanding = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error && outstanding) {
        try {
          socket.send(JSON.stringify({ _tag: "Interrupt", requestId }));
        } catch {
          // The socket may already be gone; the rejection is what matters.
        }
      }
      try {
        socket.close();
      } catch {
        // The socket may already be closing; the result is what matters.
      }
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(t3Error(`T3 RPC ${tag} timed out after ${timeoutMs}ms.`, "ETIMEDOUT")),
      timeoutMs,
    );

    socket.addEventListener("open", () => {
      opened = true;
      outstanding = true;
      socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      switch (message._tag) {
        case "Chunk":
          if (message.requestId !== requestId) return;
          chunks.push(...(message.values ?? []));
          // Streaming RPCs stall until the client acknowledges each chunk.
          socket.send(JSON.stringify({ _tag: "Ack", requestId }));
          if (typeof settleOn === "function") {
            const wanted = (message.values ?? []).find((value) => settleOn(value));
            if (wanted !== undefined) {
              outstanding = false;
              try {
                socket.send(JSON.stringify({ _tag: "Interrupt", requestId }));
              } catch {
                // The socket is already gone; the value we hold is still the answer.
              }
              finish(null, wanted);
            }
          }
          return;
        case "Exit": {
          if (message.requestId !== requestId) return;
          outstanding = false;
          const exit = message.exit ?? {};
          if (exit._tag === "Success") {
            finish(null, chunks.length > 0 ? chunks : exit.value);
            return;
          }
          finish(exitFailureError(tag, exit));
          return;
        }
        case "Defect":
          finish(t3Error(`T3 RPC ${tag} was rejected: ${stringify(message.defect)}`, "T3_RPC_REJECTED"));
          return;
        default:
      }
    });

    // A refused upgrade (T3 >= 0.1.0 answering HTTP 426 to a client that did not negotiate
    // protocol 2) is invisible to a WebSocket client: no status, no body, just error/close
    // before open. When the protocol was ASSUMED rather than read, that is the likely reason.
    const connectFailure = (fallback) => {
      if (protocol.source === "cached" || protocol.source === "advertised") protocol.invalidate();
      if (!opened && protocol.source === "assumed") {
        return t3Error(
          `${fallback} T3 did not advertise an orchestration protocol and the socket never opened; `
            + "T3 0.1.x refuses a socket that does not negotiate orchestrationProtocol=2 (HTTP 426).",
          "T3_SOCKET_ERROR",
        );
      }
      return t3Error(fallback, opened ? "T3_SOCKET_CLOSED" : "T3_SOCKET_ERROR");
    };
    socket.addEventListener("error", () => finish(connectFailure(`T3 websocket error during ${tag}.`)));
    socket.addEventListener("close", (event) => {
      finish(connectFailure(`T3 websocket closed before ${tag} completed (code ${event?.code ?? "unknown"}).`));
    });
  });
}

/**
 * The authoritative harness catalogue, read live from T3.
 *
 * `server.getConfig` returns the same provider records T3 writes to <base-dir>/caches/<id>.json,
 * so the result feeds straight into buildProviderCatalogue/mergeHostCatalogue.
 */
export async function fetchProviderCatalogue(environment, options = {}) {
  const config = await callT3Rpc(environment, T3_WS_METHODS.serverGetConfig, {}, options);
  const providers = config?.providers;
  if (!Array.isArray(providers)) {
    throw new Error("T3 server.getConfig did not return a providers array.");
  }
  return providers;
}

/**
 * Opens a long-lived `orchestration.subscribeThread` subscription.
 *
 * Deliberately NOT built on `callT3Rpc`. That helper collects every chunk and resolves once, which
 * is the right shape for `server.getConfig` and exactly the wrong shape here: a thread
 * subscription never completes on its own, its whole value is each item arriving as it happens,
 * and it has to survive being closed and reopened.
 *
 * ---------------------------------------------------------------------------------------------
 * THE CONTRACT, READ FROM T3 RATHER THAN GUESSED
 * ---------------------------------------------------------------------------------------------
 *
 * Protocol 1 (T3 0.0.x), from the installed 0.0.32 source map (`sourcesContent`) plus the real
 * Effect runtime it bundles at node_modules/effect/dist/unstable/rpc/:
 *
 *   packages/contracts/src/rpc.ts:747-754  WsOrchestrationSubscribeThreadRpc, `stream: true`.
 *   packages/contracts/src/orchestration.ts:528-552  the input:
 *       { threadId, afterSequence?, requestCompletionMarker?, turnLimit? }
 *   packages/contracts/src/orchestration.ts:1413-1426  the output item, a THREE-way union:
 *       { kind: "synchronized" }
 *     | { kind: "snapshot",  snapshot: OrchestrationThreadDetailSnapshot }
 *     | { kind: "event",     event: OrchestrationEvent }
 *   src/auth/RpcAuthorization.ts:31  requires the `orchestration:read` scope, which standard
 *     pairing already requests (STANDARD_T3_SCOPES in src/app.mjs) — no new scope, no re-pairing.
 *
 * Protocol 2 (T3 0.1.x), from the 0.1.5 server bundle (docs/t3-version-audit.md section 5):
 *
 *   bundle-0.1.5.js:40285  OrchestrationV2SubscribeThreadInput:
 *       { threadId, afterSequence?, requestCompletionMarker?, acceptBoundedSnapshot?,
 *         acceptDeferredWork?, acceptCompactTurnItems?, acceptDedupedBodies?, acceptCompactIds? }
 *     There is NO `turnLimit`; it is not sent on protocol 2. Each `accept*` flag is opt-in and a
 *     server applies it only when sent. This client sends exactly one, `acceptBoundedSnapshot`,
 *     which is the payload the connector's protocol-2 path already runs on a live 0.1.1; the
 *     others change the snapshot encoding and would need a decoder on the consuming side.
 *   bundle-0.1.5.js:407124-407183  items are the same three kinds, but a snapshot is
 *       { kind: "snapshot", snapshotSequence, projection, ... } — NOT `snapshot.thread` — and an
 *       event is { kind: "event", sequence, event: { id, threadId, type, payload, ... } }.
 *     Those items are delivered here RAW. Turning them into what src/threadStream.mjs reads is the
 *     projection in src/t3Protocol2.mjs (a copy of packages/connector/src/t3v2.mjs), applied by
 *     DirectT3Transport.openThreadStream.
 *   bundle-0.1.5.js:185450+  the RPC server is Effect 4.0.5 (`effect/dist/rpc/RpcServer.js`); the
 *     0.0.32 path `effect/unstable/rpc/RpcServer.js:N` cited below is the same code in
 *     `effect@4.0.0-beta.103`. Envelope, one-JSON-per-frame (`layerJson`, :408460), Ack, Interrupt
 *     and Ping/Pong are unchanged.
 *   RPC_REQUIRED_SCOPES (bundle-0.1.5.js:401644) maps subscribeThread to `read`.
 *
 * `afterSequence` is the resume cursor, and it is the GLOBAL event-log sequence, not the
 * per-activity `sequence` field (protocol 1: src/ws.ts:1317-1350; protocol 2: `latestAgentSequence`
 * is MAX(sequence) over the thread's event stream, bundle-0.1.5.js:64620-64627). When the server
 * cannot fill the gap it silently abandons the replay and sends a fresh `snapshot` frame instead,
 * because a truncated replay would drop events without saying so. The thresholds differ by
 * protocol — see T3_THREAD_RESUME_LIMITS (1000 events on 0.0.x; 128 events or 1 MiB on 0.1.x).
 * That behaviour is the gateway's answer to an unfillable gap; see src/threadStream.mjs.
 *
 * `requestCompletionMarker: true` asks for the `{kind:"synchronized"}` frame that separates the
 * initial snapshot/replay from live events (0.0.32 src/ws.ts:1339-1345, :1380-1387; protocol 2
 * `completionMarker`, bundle-0.1.5.js:407124, appended at :407149 and :407183). Without it a client cannot tell "still
 * catching up" from "live".
 *
 * ---------------------------------------------------------------------------------------------
 * WHY EVERY CHUNK MUST BE ACKNOWLEDGED
 * ---------------------------------------------------------------------------------------------
 *
 * Not folklore — it is the server loop. RpcServer creates a latch per streaming request, then for
 * every chunk does `latch.closeUnsafe(); write(Chunk); await latch` (0.0.32
 * effect/unstable/rpc/RpcServer.js:271-291; 0.1.5 bundle-0.1.5.js:185685-185706, identical in
 * 0.1.1 at bundle-0.1.1.js:177382-177391). Only an inbound `{_tag:"Ack", requestId}` opens it
 * (bundle-0.1.5.js:185532-185535). So the first chunk arrives unprompted and every subsequent one
 * is blocked until we answer. Miss one Ack and the subscription goes quiet forever while looking
 * perfectly healthy.
 *
 * `{_tag:"Interrupt", requestId}` is the polite end (bundle-0.1.5.js:185536-185546): it interrupts
 * the server-side fiber instead of leaving it parked on a latch nobody will ever open.
 * `{_tag:"Ping"}` is answered with `Pong` (bundle-0.1.5.js:185890), which is what keeps an idle
 * subscription alive through a tunnel that reaps quiet sockets.
 */
export function openT3ThreadStream(environment, {
  threadId,
  afterSequence = null,
  requestCompletionMarker = true,
  turnLimit = null,
  // Whether protocol 2 may be resumed from `afterSequence`. T3 allows it (bounds: T3_THREAD_RESUME_LIMITS),
  // but a consumer that rebuilds state from a snapshot cannot apply a replay that has no snapshot
  // in front of it; it sets this false and always gets a snapshot. Protocol 1 is unaffected.
  resumeProtocol2 = true,
  onItem = () => {},
  onOpen = () => {},
  onClose = () => {},
} = {}, {
  fetchImpl = fetch,
  WebSocketImpl = globalThis.WebSocket,
  ticketTimeoutMs = DEFAULT_TIMEOUT_MS,
  pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
  orchestrationProtocolVersion,
  supportedProtocols,
  protocolCache = null,
} = {}) {
  const requestId = "1";
  let socket = null;
  let protocol = null;
  let opened = false;
  let closedByCaller = false;
  let settled = false;
  let pingTimer = null;

  const finish = (reason, error = null) => {
    if (settled) return;
    settled = true;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    if (socket) {
      // Only a caller-initiated teardown needs the Interrupt: it is the case where the server
      // fiber is alive and parked on the chunk latch, and closing the socket underneath it is
      // exactly what leaves it there. When T3 has already ended the stream (exit/defect) or the
      // socket is gone (error/close), there is nothing left to interrupt.
      if (reason === "closed") {
        try {
          socket.send(JSON.stringify({ _tag: "Interrupt", requestId }));
        } catch {
          // The socket is already gone; closing is still worth attempting.
        }
      }
      try {
        socket.close();
      } catch {
        // Same.
      }
    }
    try {
      onClose({ reason, error });
    } catch {
      // A caller that throws while being told the stream ended must not resurrect it.
    }
  };

  const start = async () => {
    let ticket;
    try {
      // Before the ticket: a protocol this caller cannot consume must not cost a minted ticket
      // or a subscribed server fiber. The stream ends with reason "protocol" and a coded error.
      try {
        protocol = await negotiateOrchestrationProtocol(environment, {
          fetchImpl,
          timeoutMs: ticketTimeoutMs,
          orchestrationProtocolVersion,
          supportedProtocols,
          protocolCache,
        });
      } catch (error) {
        finish("protocol", error);
        return;
      }
      ticket = await requestWebSocketTicket(environment, { fetchImpl, timeoutMs: ticketTimeoutMs });
    } catch (error) {
      finish("ticket", error);
      return;
    }
    if (closedByCaller) {
      finish("closed");
      return;
    }
    if (typeof WebSocketImpl !== "function") {
      finish("unsupported", new Error("A WebSocket implementation is required to stream from T3."));
      return;
    }

    try {
      socket = new WebSocketImpl(webSocketUrlFor(environment.baseUrl, ticket, protocol.version));
    } catch (error) {
      finish("connect", error);
      return;
    }

    socket.addEventListener("open", () => {
      opened = true;
      if (closedByCaller) {
        finish("closed");
        return;
      }
      const payload = { threadId };
      // Only send the cursor when we actually have one: an absent afterSequence is what asks
      // for the initial snapshot, and `0` is a legitimate cursor rather than "no cursor".
      if (Number.isFinite(afterSequence) && (protocol.version !== 2 || resumeProtocol2)) {
        payload.afterSequence = afterSequence;
      }
      if (requestCompletionMarker) payload.requestCompletionMarker = true;
      if (protocol.version === 2) {
        // Protocol 2's input has no `turnLimit` (bundle-0.1.5.js:40285); the snapshot is bounded
        // by `acceptBoundedSnapshot`, the one opt-in the connector already runs on a live 0.1.1.
        payload.acceptBoundedSnapshot = true;
      } else if (Number.isFinite(turnLimit) && turnLimit > 0) {
        payload.turnLimit = turnLimit;
      }
      socket.send(JSON.stringify({
        _tag: "Request",
        id: requestId,
        tag: T3_WS_METHODS.orchestrationSubscribeThread,
        payload,
        headers: [],
      }));
      if (pingIntervalMs > 0) {
        pingTimer = setInterval(() => {
          try {
            socket.send(JSON.stringify({ _tag: "Ping" }));
          } catch {
            // A dead socket will surface through close/error; the keepalive stays quiet.
          }
        }, pingIntervalMs);
        pingTimer.unref?.();
      }
      try {
        // The argument is additive: existing callers pass `() => {}` and ignore it. It tells a
        // consumer which item shapes are about to arrive.
        onOpen({ orchestrationProtocolVersion: protocol.version, protocolSource: protocol.source });
      } catch {
        // Same reasoning as onClose: a throwing observer must not take the stream down.
      }
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      switch (message._tag) {
        case "Chunk": {
          if (message.requestId !== requestId) return;
          for (const value of message.values ?? []) {
            try {
              onItem(value);
            } catch {
              // Delivering item N+1 matters more than item N's handler throwing, and the Ack
              // below has to be sent either way or the stream stalls permanently.
            }
          }
          try {
            socket.send(JSON.stringify({ _tag: "Ack", requestId }));
          } catch (error) {
            finish("ack", error);
          }
          return;
        }
        case "Exit": {
          if (message.requestId !== requestId) return;
          const exit = message.exit ?? {};
          if (exit._tag === "Success") {
            finish("exit");
            return;
          }
          // Includes an unknown/removed tag, which arrives as a per-request Exit rather than a
          // top-level Defect (see exitFailureError), so it is attributable and ends only this stream.
          finish("failure", exitFailureError(T3_WS_METHODS.orchestrationSubscribeThread, exit));
          return;
        }
        case "Defect":
          finish("defect", t3Error(`T3 rejected subscribeThread: ${stringify(message.defect)}`, "T3_RPC_REJECTED"));
          return;
        default:
          // Pong and anything newer T3 grows are ignored on purpose.
      }
    });

    // A refused upgrade (HTTP 426 from a T3 >= 0.1.0 that was not sent orchestrationProtocol=2)
    // is invisible to a WebSocket client. Forget the cached protocol so the next attempt re-reads
    // the descriptor, and say so when the protocol had only been assumed.
    const hintFor = () => (!opened && protocol?.source === "assumed"
      ? " T3 did not advertise an orchestration protocol and the socket never opened; T3 0.1.x refuses a socket that does not negotiate orchestrationProtocol=2 (HTTP 426)."
      : "");
    socket.addEventListener("error", () => {
      if (!closedByCaller && protocol?.source !== "pinned") protocol?.invalidate();
      finish("error", t3Error(`T3 websocket error while streaming a thread.${hintFor()}`, "T3_SOCKET_ERROR"));
    });
    socket.addEventListener("close", (event) => {
      if (!closedByCaller && protocol?.source !== "pinned") protocol?.invalidate();
      finish(closedByCaller ? "closed" : "socket-closed", closedByCaller
        ? null
        : t3Error(`T3 websocket closed while streaming (code ${event?.code ?? "unknown"}).${hintFor()}`, "T3_SOCKET_CLOSED"));
    });
  };

  void start();

  return {
    close() {
      closedByCaller = true;
      finish("closed");
    },
  };
}

export const TERMINAL_SCOPE = "terminal:operate";

export function environmentHasTerminalScope(environment) {
  return Array.isArray(environment?.scopes) && environment.scopes.includes(TERMINAL_SCOPE);
}

/**
 * Writes directly into a T3 terminal (roadmap Phase 9 stage 3).
 *
 * `terminal.open` is idempotent enough to call first: terminal ids are client-chosen, so opening an
 * existing id attaches to it rather than creating a duplicate. `cwd` is required by the open
 * schema, so callers must supply one when the terminal may not exist yet.
 */
export async function writeTerminalInput(environment, { threadId, terminalId, data, cwd }, options = {}) {
  if (!environmentHasTerminalScope(environment)) {
    throw new Error(`This environment was not paired with the ${TERMINAL_SCOPE} scope.`);
  }
  if (cwd) {
    await callT3Rpc(environment, T3_WS_METHODS.terminalOpen, { threadId, terminalId, cwd }, options);
  }
  return await callT3Rpc(
    environment,
    T3_WS_METHODS.terminalWrite,
    { threadId, terminalId, data },
    options,
  );
}

/**
 * Turns a failed `Exit` into an Error that names the request it belongs to.
 *
 * Wire shape (Effect 4.0.5, bundle-0.1.5.js:23281 `Exit`, :23216 `Cause`, :23135 `CauseReason`):
 * `exit: { _tag: "Failure", cause: [ { _tag: "Fail", error } | { _tag: "Die", defect } |
 * { _tag: "Interrupt" } ] }` — `cause` is an ARRAY of reasons. The older flat shape
 * (`cause: { error }`) is still read, because it is what earlier fakes and 0.0.x tooling produced.
 *
 * An unknown request tag is not a top-level `Defect`. The server answers it per request:
 * `if (!rpc) return sendRequestDefect(client, requestId, encodeUnknownRequestExit,
 * "Unknown request tag: " + tag)` (bundle-0.1.5.js:185881, helper :185844), i.e. an `Exit` whose
 * cause is a `Die` carrying that string. 0.0.32 does the same
 * (effect/unstable/rpc/RpcServer.js:469). Only an unknown MESSAGE `_tag` produces the top-level
 * `Defect` (bundle-0.1.5.js:185553). So a removed or renamed method (`server.getSettings`,
 * dropped in 0.1.5) reaches us as this error, with `code: "T3_RPC_UNKNOWN_TAG"`, the one request
 * it belongs to, and nothing torn down.
 */
function exitFailureError(tag, exit) {
  const reasons = Array.isArray(exit.cause) ? exit.cause : [exit.cause ?? exit.error ?? exit];
  const die = reasons.find((reason) => reason?._tag === "Die");
  const defect = typeof die?.defect === "string" ? die.defect : null;
  if (defect !== null && /^Unknown request tag:/u.test(defect)) {
    return t3Error(
      `T3 RPC ${tag} is not served by this T3 server (${boundedDetail(defect)}).`,
      "T3_RPC_UNKNOWN_TAG",
      { tag },
    );
  }
  if (reasons.length > 0 && reasons.every((reason) => reason?._tag === "Interrupt")) {
    return t3Error(`T3 RPC ${tag} was interrupted by the server.`, "T3_RPC_INTERRUPTED", { tag });
  }
  const reason = reasons.find((candidate) => candidate?._tag === "Fail") ?? die ?? reasons[0];
  return t3Error(`T3 RPC ${tag} failed: ${describeReason(reason)}`, "T3_RPC_FAILED", { tag });
}

// Names fields rather than serialising the whole cause: a Die defect is an encoded Error and may
// carry a stack, and this text reaches logs and owner-visible `lastError`.
function describeReason(reason) {
  const value = reason?._tag === "Die" ? reason.defect : reason?._tag === "Fail" ? reason.error : reason?.error ?? reason;
  if (typeof value === "string") return boundedDetail(value);
  if (value !== null && typeof value === "object") {
    const name = typeof value._tag === "string" ? value._tag : typeof value.name === "string" ? value.name : null;
    const text = typeof value.message === "string" ? value.message : null;
    if (name && text) return boundedDetail(`${name}: ${text}`);
    if (name || text) return boundedDetail(name ?? text);
  }
  return boundedDetail(stringify(value));
}

function boundedDetail(text) {
  return text.length > MAX_FAILURE_DETAIL_CHARS ? `${text.slice(0, MAX_FAILURE_DETAIL_CHARS)}...` : text;
}

function stringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
