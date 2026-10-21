const DEFAULT_TIMEOUT_MS = 10_000;

export const T3_WS_METHODS = Object.freeze({
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverGetSettings: "server.getSettings",
  orchestrationDispatchCommand: "orchestration.dispatchCommand",
  orchestrationSubscribeThread: "orchestration.subscribeThread",
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalAttach: "terminal.attach",
  terminalClose: "terminal.close",
});

export function createT3Client({
  baseUrl,
  accessToken = null,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!baseUrl) throw new Error("A local T3 URL is required.");
  const environment = { baseUrl, accessToken };
  return {
    environmentInfo: (options = {}) => fetchEnvironmentInfo(environment, { fetchImpl, timeoutMs, ...options }),
    snapshot: (options = {}) => fetchSnapshot(environment, { fetchImpl, timeoutMs, ...options }),
    threadDetail: (threadId, options = {}) => fetchThreadDetail(environment, threadId, { fetchImpl, timeoutMs, ...options }),
    dispatch: (command, options = {}) => dispatchCommand(environment, command, { fetchImpl, timeoutMs, ...options }),
    callRpc: (tag, payload = {}, options = {}) => callRpc(environment, tag, payload, { fetchImpl, WebSocketImpl, timeoutMs, ...options }),
    providerCatalogue: async () => {
      const config = await callRpc(environment, T3_WS_METHODS.serverGetConfig, {}, { fetchImpl, WebSocketImpl, timeoutMs });
      if (!Array.isArray(config?.providers)) throw new Error("T3 server.getConfig did not return a providers array.");
      return config.providers;
    },
    capabilityProbe: () => probeT3Capabilities(environment, { fetchImpl, WebSocketImpl, timeoutMs }),
    openThreadStream: (input, callbacks = {}) => openThreadStream(environment, input, callbacks, { fetchImpl, WebSocketImpl, timeoutMs }),
  };
}

export async function probeT3Capabilities(environment, options = {}) {
  const [metadataResult, snapshotResult, configResult] = await Promise.allSettled([
    fetchEnvironmentInfo(environment, options),
    fetchSnapshot(environment, options),
    callRpc(environment, T3_WS_METHODS.serverGetConfig, {}, options),
  ]);
  const metadata = metadataResult.status === "fulfilled" ? metadataResult.value : null;
  const snapshot = snapshotResult.status === "fulfilled" ? snapshotResult.value : null;
  const config = configResult.status === "fulfilled" ? configResult.value : null;
  const firstThreadId = Array.isArray(snapshot?.threads)
    ? snapshot.threads.find((thread) => typeof thread?.id === "string" && thread.id)?.id ?? null
    : null;
  let threadDetail = "not_exercised";
  if (firstThreadId) {
    try {
      await fetchThreadDetail(environment, firstThreadId, { ...options, turnLimit: 1 });
      threadDetail = "passed";
    } catch {
      threadDetail = "failed";
    }
  }
  const snapshotContract = Array.isArray(snapshot?.projects) && Array.isArray(snapshot?.threads);
  const configContract = Array.isArray(config?.providers);
  return {
    schema: "next-coder.t3-probe.v1",
    installedVersion: semanticVersion(metadata?.serverVersion ?? metadata?.version),
    probes: {
      metadata: metadataResult.status === "fulfilled" ? "passed" : "failed",
      snapshot: snapshotContract ? "passed" : "failed",
      serverConfig: configContract ? "passed" : "failed",
      threadDetail,
    },
    serverCapabilities: {
      threadSnapshotPagination: config?.threadSnapshotPagination === true,
      threadResumeCompletionMarker: config?.threadResumeCompletionMarker === true,
    },
  };
}

export async function discoverT3({ candidates = ["http://127.0.0.1:3773"], fetchImpl, timeoutMs = 1_500 } = {}) {
  const failures = [];
  for (const baseUrl of candidates) {
    try {
      const info = await fetchEnvironmentInfo({ baseUrl }, { fetchImpl, timeoutMs });
      return { baseUrl, info };
    } catch (error) {
      failures.push({ baseUrl, error });
    }
  }
  const error = new Error(`No local T3 server answered at ${candidates.join(", ")}. Start T3 Code and retry.`);
  error.code = "T3_NOT_FOUND";
  error.failures = failures;
  throw error;
}

export async function exchangePairingToken({ baseUrl, pairingToken, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!pairingToken) throw new Error("A T3 pairing token is required.");
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: pairingToken,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: "orchestration:read orchestration:write terminal:operate",
    client_label: "Next Coder Connector",
    client_device_type: "bot",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(new URL("/oauth/token", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw Object.assign(new Error(`T3 pairing failed with HTTP ${response.status}.`), { code: "T3_PAIRING_FAILED", status: response.status });
  const payload = await response.json();
  if (!payload?.access_token) throw Object.assign(new Error("T3 pairing response did not contain an access token."), { code: "T3_PAIRING_INVALID" });
  return payload;
}

export async function fetchEnvironmentInfo(environment, options = {}) {
  return await t3Json(environment, "/.well-known/t3/environment", { ...options, authenticated: false });
}

export async function fetchSnapshot(environment, options = {}) {
  requireAccessToken(environment);
  return await t3Json(environment, "/api/orchestration/snapshot", options);
}

export async function fetchThreadDetail(environment, threadId, options = {}) {
  requireAccessToken(environment);
  if (typeof threadId !== "string" || !threadId) throw new Error("threadId is required.");
  const url = new URL(`/api/orchestration/threads/${encodeURIComponent(threadId)}`, environment.baseUrl);
  if (Number.isInteger(options.turnLimit) && options.turnLimit > 0) url.searchParams.set("turnLimit", String(options.turnLimit));
  const payload = await t3Json(environment, url, options);
  return payload?.thread ?? null;
}

export async function dispatchCommand(environment, command, options = {}) {
  requireAccessToken(environment);
  if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error("A T3 command object is required.");
  return await t3Json(environment, "/api/orchestration/dispatch", { ...options, method: "POST", body: command });
}

export async function requestT3SocketTicket(environment, options = {}) {
  requireAccessToken(environment);
  const payload = await t3Json(environment, "/api/auth/websocket-ticket", { ...options, method: "POST" });
  if (!payload?.ticket) throw new Error("T3 did not return a websocket ticket.");
  return payload.ticket;
}

export function t3SocketUrl(baseUrl, ticket) {
  const url = new URL("/ws", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
}

export async function callRpc(environment, tag, payload = {}, options = {}) {
  if (typeof options.WebSocketImpl !== "function") throw new Error("This Node runtime does not provide WebSocket support.");
  const ticket = await requestT3SocketTicket(environment, options);
  const socket = new options.WebSocketImpl(t3SocketUrl(environment.baseUrl, ticket));
  const requestId = "1";
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(taggedError(`T3 RPC ${tag} timed out.`, "T3_TIMEOUT")), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();
    const abort = () => finish(taggedError(`T3 RPC ${tag} was cancelled.`, "REQUEST_CANCELLED"));
    options.signal?.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", () => socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] })));
    socket.addEventListener("message", (event) => {
      const message = parseJson(event.data);
      if (!message) return;
      if (message._tag === "Chunk" && message.requestId === requestId) {
        try {
          chunks.push(...(Array.isArray(message.values) ? message.values : []));
        } finally {
          socket.send(JSON.stringify({ _tag: "Ack", requestId }));
        }
      } else if (message._tag === "Exit" && message.requestId === requestId) {
        if (message.exit?._tag === "Success") finish(null, chunks.length ? chunks : message.exit.value);
        else finish(taggedError(`T3 RPC ${tag} failed.`, "T3_RPC_FAILED"));
      } else if (message._tag === "Defect") {
        finish(taggedError(`T3 rejected RPC ${tag}.`, "T3_RPC_REJECTED"));
      }
    });
    socket.addEventListener("error", () => finish(taggedError(`T3 websocket failed during ${tag}.`, "T3_SOCKET_ERROR")));
    socket.addEventListener("close", (event) => finish(taggedError(`T3 websocket closed during ${tag} (${event?.code ?? "unknown"}).`, "T3_SOCKET_CLOSED")));
  });
}

export function openThreadStream(environment, input = {}, callbacks = {}, options = {}) {
  const requestId = "1";
  let socket = null;
  let stopped = false;
  let finished = false;
  let pingTimer = null;
  const finish = (reason, error = null) => {
    if (finished) return;
    finished = true;
    clearInterval(pingTimer);
    if (socket) {
      if (stopped) {
        try { socket.send(JSON.stringify({ _tag: "Interrupt", requestId })); } catch {}
      }
      try { socket.close(); } catch {}
    }
    try { callbacks.onClose?.({ reason, error }); } catch {}
  };
  void (async () => {
    try {
      const ticket = await requestT3SocketTicket(environment, options);
      if (stopped) return finish("closed");
      if (typeof options.WebSocketImpl !== "function") throw taggedError("WebSocket support is unavailable.", "WEBSOCKET_UNAVAILABLE");
      socket = new options.WebSocketImpl(t3SocketUrl(environment.baseUrl, ticket));
      socket.addEventListener("open", () => {
        if (stopped) return finish("closed");
        const payload = { threadId: input.threadId, requestCompletionMarker: input.requestCompletionMarker !== false };
        if (Number.isFinite(input.afterSequence)) payload.afterSequence = input.afterSequence;
        if (Number.isInteger(input.turnLimit) && input.turnLimit > 0) payload.turnLimit = input.turnLimit;
        socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag: T3_WS_METHODS.orchestrationSubscribeThread, payload, headers: [] }));
        const interval = options.pingIntervalMs ?? 30_000;
        if (interval > 0) {
          pingTimer = setInterval(() => {
            try { socket.send(JSON.stringify({ _tag: "Ping" })); } catch {}
          }, interval);
          pingTimer.unref?.();
        }
        try { callbacks.onOpen?.(); } catch {}
      });
      socket.addEventListener("message", (event) => {
        const message = parseJson(event.data);
        if (!message) return;
        if (message._tag === "Chunk" && message.requestId === requestId) {
          try {
            for (const value of Array.isArray(message.values) ? message.values : []) {
              try { callbacks.onItem?.(value); } catch {}
            }
          } finally {
            try { socket.send(JSON.stringify({ _tag: "Ack", requestId })); } catch (error) { finish("ack", error); }
          }
        } else if (message._tag === "Exit" && message.requestId === requestId) {
          finish(message.exit?._tag === "Success" ? "exit" : "failure", message.exit?._tag === "Success" ? null : taggedError("T3 thread subscription failed.", "T3_RPC_FAILED"));
        } else if (message._tag === "Defect") finish("defect", taggedError("T3 rejected thread subscription.", "T3_RPC_REJECTED"));
      });
      socket.addEventListener("error", () => finish("error", taggedError("T3 thread websocket failed.", "T3_SOCKET_ERROR")));
      socket.addEventListener("close", (event) => finish(stopped ? "closed" : "socket-closed", stopped ? null : taggedError(`T3 thread websocket closed (${event?.code ?? "unknown"}).`, "T3_SOCKET_CLOSED")));
    } catch (error) {
      finish("connect", error);
    }
  })();
  return { close() { stopped = true; finish("closed"); } };
}

async function t3Json(environment, pathOrUrl, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  method = "GET",
  body,
  authenticated = true,
  signal,
} = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const headers = {};
  if (authenticated) headers.authorization = `Bearer ${environment.accessToken}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let response;
  try {
    response = await fetchImpl(pathOrUrl instanceof URL ? pathOrUrl : new URL(pathOrUrl, environment.baseUrl), {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw signal?.aborted
        ? taggedError("T3 request was cancelled.", "REQUEST_CANCELLED")
        : taggedError(`T3 request timed out after ${timeoutMs}ms.`, "T3_TIMEOUT");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
  if (!response.ok) {
    const error = taggedError(`T3 request failed with HTTP ${response.status}.`, response.status === 401 || response.status === 403 ? "T3_AUTH_FAILED" : "T3_HTTP_ERROR");
    error.status = response.status;
    throw error;
  }
  return await response.json();
}

function requireAccessToken(environment) {
  if (!environment?.accessToken) throw taggedError("A local T3 access token is required for this operation.", "T3_TOKEN_REQUIRED");
}

function parseJson(value) {
  try { return JSON.parse(typeof value === "string" ? value : String(value)); } catch { return null; }
}

function taggedError(message, code) {
  return Object.assign(new Error(message), { code });
}

function semanticVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value) ? value : null;
}
