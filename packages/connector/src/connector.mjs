import { randomUUID } from "node:crypto";
import { arch, platform, release } from "node:os";
import { cloudSocketUrl, CONNECTOR_VERSION, PROTOCOL_VERSION, requestSocketTicket } from "./cloud.mjs";
import { CompletedRequestCache, decodeCloudFrame, encodeFrame, MAX_IN_FLIGHT, responseFailureFrame } from "./protocol.mjs";
import { createLocalTranscriber } from "./localTranscription.mjs";
import { safeError } from "./redact.mjs";

const MAX_SUBSCRIPTIONS = 32;

export class ConnectorClient {
  constructor({
    state,
    t3,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    logger = console,
    random = Math.random,
    sleep = null,
    minReconnectMs = 500,
    maxReconnectMs = 30_000,
    minSubscriptionReconnectMs = 250,
    maxSubscriptionReconnectMs = 5_000,
    persistState = null,
    localTranscriber = null,
    ensureLocalTranscription = null,
  }) {
    if (typeof WebSocketImpl !== "function") throw new Error("Node WebSocket support is required (Node 22+).");
    this.state = state;
    this.t3 = t3;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.logger = logger;
    this.random = random;
    this.sleep = sleep;
    this.minReconnectMs = minReconnectMs;
    this.maxReconnectMs = maxReconnectMs;
    this.minSubscriptionReconnectMs = minSubscriptionReconnectMs;
    this.maxSubscriptionReconnectMs = maxSubscriptionReconnectMs;
    this.persistState = persistState;
    this.localTranscriber = localTranscriber ?? createLocalTranscriber({ state, fetchImpl, ensureReady: ensureLocalTranscription });
    this.completed = new CompletedRequestCache({ entries: state.completedRequests });
    this.inFlight = new Map();
    this.inFlightByKey = new Map();
    this.subscriptions = new Map();
    this.stopped = false;
    this.socket = null;
    this.connectionId = randomUUID();
    this.heartbeatSequence = 0;
    this.heartbeatInProgress = false;
    this.reconnectWake = null;
  }

  async run({ once = false } = {}) {
    let attempts = 0;
    while (!this.stopped) {
      try {
        await this.connectOnce({ once });
        attempts = 0;
        if (once || this.stopped) return;
      } catch (error) {
        if (this.stopped) return;
        this.state.lastConnectionError = safeError(error);
        this.state.lastConnectionAttemptAt = new Date().toISOString();
        void Promise.resolve(this.persistState?.(this.state)).catch(() => {});
        this.logger.error?.("Connector connection failed.", safeError(error));
        attempts += 1;
      }
      const cap = Math.min(this.maxReconnectMs, this.minReconnectMs * 2 ** Math.min(Math.max(0, attempts - 1), 10));
      const delay = Math.max(this.minReconnectMs, Math.floor(cap * (0.5 + this.random() * 0.5)));
      await this.waitForReconnect(delay);
      this.reconnectWake = null;
    }
  }

  async connectOnce({ once = false, onWelcome = null } = {}) {
    const { ticket } = await requestSocketTicket(this.state, { fetchImpl: this.fetchImpl });
    if (this.stopped) return { shutdownReason: "stopped" };
    const socket = new this.WebSocketImpl(cloudSocketUrl(this.state.server, ticket));
    this.socket = socket;
    const sessionId = randomUUID();
    this.connectionId = sessionId;
    return await new Promise((resolve, reject) => {
      let welcomed = false;
      let heartbeatTimer = null;
      let settled = false;
      let shutdownReason = null;
      const welcomeTimer = setTimeout(() => settle(Object.assign(new Error("Cloud websocket welcome timed out."), { code: "CLOUD_WELCOME_TIMEOUT" })), 15_000);
      // This is a managed service lifecycle deadline, not optional housekeeping. Keep the
      // process alive even if the transport has temporarily released its native handles.
      const settle = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(welcomeTimer);
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        this.closeSubscriptions();
        if (this.socket === socket) this.socket = null;
        if (error) {
          try { socket.close(1011, "connection failed"); } catch {}
        }
        if (error) reject(error); else resolve({ shutdownReason });
      };
      socket.addEventListener("open", () => {
        if (settled || this.stopped) return;
        void this.buildHello(sessionId).then((hello) => this.send(socket, hello)).catch((error) => {
          try { socket.close(1011, "hello failed"); } catch {}
          settle(error);
        });
      });
      socket.addEventListener("message", (event) => {
        if (settled || this.stopped) return;
        void this.onMessage(socket, event.data).then((result) => {
          if (result?.shutdown) shutdownReason = result.shutdown;
          // stop/close may win while frame handling awaited local work. A late welcome must
          // never recreate a referenced heartbeat timer after settle has already cleaned up.
          if (settled || this.stopped) return;
          if (result?.welcome && !welcomed) {
            welcomed = true;
            clearTimeout(welcomeTimer);
            this.connectionId = result.frame.connectionId || sessionId;
            this.state.lastConnectedAt = new Date().toISOString();
            this.state.lastConnectionError = null;
            const interval = clampInteger(result.frame.body.heartbeatIntervalMs, 1_000, 60_000, 20_000);
            const heartbeat = () => { void this.sendHeartbeat(socket).catch(settle); };
            heartbeatTimer = setInterval(heartbeat, interval);
            heartbeat();
            if (this.state.credentialRotation?.id && !this.state.credentialRotation.acknowledgedAt) {
              const rotatedAt = new Date().toISOString();
              this.send(socket, {
                protocolVersion: 1,
                type: "credential.rotated",
                connectionId: this.connectionId,
                body: { challenge: this.state.credentialRotation.id, rotatedAt },
              });
              // This timestamp is non-secret and prevents the managed service
              // from publishing a duplicate after it takes over the bridge.
              this.state.credentialRotation.acknowledgedAt = rotatedAt;
            }
            void Promise.resolve(this.persistState?.(this.state)).catch((error) => this.logger.error?.("Could not persist connector connection state.", safeError(error)));
            this.logger.log?.(`Connector online for environment ${this.state.environmentId}.`);
            onWelcome?.({ connectionId: this.connectionId, connectedAt: this.state.lastConnectedAt });
            if (once) {
              try { socket.close(1000, "once complete"); } catch {}
            }
          }
        }).catch((error) => {
          this.logger.error?.("Rejected cloud frame.", safeError(error));
          try { socket.close(1008, "invalid frame"); } catch {}
        });
      });
      socket.addEventListener("error", () => settle(Object.assign(new Error("Cloud websocket failed."), { code: "CLOUD_SOCKET_ERROR" })));
      socket.addEventListener("close", (event) => {
        if (this.stopped || (once && welcomed) || event?.code === 1000) settle();
        else settle(Object.assign(new Error(`Cloud websocket closed (${event?.code ?? "unknown"}).`), { code: "CLOUD_SOCKET_CLOSED" }));
      });
    });
  }

  async buildHello(connectionId) {
    let info = null;
    let capabilityProbe = null;
    let providers = [];
    let t3Health = "ready";
    try {
      info = await this.t3.environmentInfo();
      if (this.state.t3AccessToken) {
        capabilityProbe = typeof this.t3.capabilityProbe === "function" ? await this.t3.capabilityProbe() : null;
        providers = sanitizeProviders(await this.t3.providerCatalogue());
      } else {
        t3Health = "auth_failed";
      }
    } catch (error) {
      t3Health = error?.code === "T3_AUTH_FAILED" ? "auth_failed" : "error";
    }
    const localVoice = this.state.voice?.enabled === true ? await this.localTranscriber.health() : { ready: false };
    return {
      protocolVersion: PROTOCOL_VERSION,
      type: "hello",
      connectionId,
      body: {
        connectorId: this.state.connectorId,
        connectorVersion: CONNECTOR_VERSION,
        platform: `${platform()}-${arch()}-node${process.versions.node}`,
        environmentId: this.state.environmentId,
        ...(info?.version || info?.serverVersion ? { t3Version: info.version ?? info.serverVersion } : {}),
        t3Health,
        capabilities: [...connectorCapabilities(
          capabilityProbe,
          Boolean(this.state.t3AccessToken),
          typeof this.t3.capabilityProbe === "function",
          info != null,
        ), ...(localVoice.ready ? ["media.transcribe"] : [])],
        providerCatalogue: providers,
        ...(this.state.lastEventCursor != null ? { lastEventCursor: String(this.state.lastEventCursor) } : {}),
      },
    };
  }

  async onMessage(socket, data) {
    const frame = decodeCloudFrame(data);
    if (frame.type === "welcome") return { welcome: true, frame };
    if (frame.type === "request") return await this.handleRequest(socket, frame);
    if (frame.type === "cancel") return void this.cancelRequest(frame.body.requestId);
    if (frame.type === "subscribe") return void this.subscribe(socket, frame);
    if (frame.type === "unsubscribe") return void this.unsubscribe(frame.body.leaseId);
    if (frame.type === "shutdown") {
      const reason = frame.body.reason;
      if (reason === "maintenance") {
        try { socket.close(1012, "server maintenance"); } catch {}
      } else {
        this.stopped = true;
        try { socket.close(1000, `server ${reason}`); } catch {}
      }
      return { shutdown: reason };
    }
    if (frame.type === "rotate") {
      this.logger.error?.("Cloud requested credential rotation, which requires a new enrollment in this connector version.");
      try { socket.close(1008, "rotation unsupported"); } catch {}
    }
    return null;
  }

  async handleRequest(socket, frame) {
    const body = frame.body;
    const cached = this.completed.get(body.idempotencyKey);
    if (cached) return this.send(socket, { ...cached, connectionId: this.connectionId, body: { ...cached.body, requestId: body.requestId } });
    const duplicate = this.inFlightByKey.get(body.idempotencyKey);
    if (duplicate) {
      this.send(socket, { protocolVersion: 1, type: "response.accepted", connectionId: this.connectionId, body: { requestId: body.requestId, acceptedAt: duplicate.acceptedAt } });
      const terminal = await duplicate.promise;
      return this.send(socket, { ...terminal, connectionId: this.connectionId, body: { ...terminal.body, requestId: body.requestId } });
    }
    if (this.inFlight.size >= MAX_IN_FLIGHT) {
      return this.send(socket, responseFailureFrame({ connectionId: this.connectionId, requestId: body.requestId, error: Object.assign(new Error("Connector is at its in-flight request limit."), { code: "CONNECTOR_BACKPRESSURE" }) }));
    }
    const deadline = parseDeadline(body.deadlineAt);
    if (deadline !== null && deadline <= Date.now()) {
      return this.send(socket, responseFailureFrame({ connectionId: this.connectionId, requestId: body.requestId, error: Object.assign(new Error("Request deadline elapsed before dispatch."), { code: "REQUEST_DEADLINE", retryable: false }) }));
    }
    const controller = new AbortController();
    this.inFlight.set(body.requestId, controller);
    const acceptedAt = new Date().toISOString();
    this.send(socket, { protocolVersion: 1, type: "response.accepted", connectionId: this.connectionId, body: { requestId: body.requestId, acceptedAt } });
    // The completed-idempotency cache is the connector's process-restart guard. Keep the
    // persistence attempt inside the promise shared by duplicate deliveries so neither the
    // original request nor a concurrent duplicate can observe a terminal result before a
    // healthy runtime-state backend has durably recorded it.
    const terminalPromise = this.runRequest(frame, deadline, controller).then(async (terminal) => {
      // A transcript is private job output, not a durable connector receipt. Overlapping
      // deliveries still share this in-flight promise; the cloud owns durable completion.
      if (body.method !== "media.transcribe") await this.rememberTerminal(body.idempotencyKey, terminal);
      return terminal;
    });
    this.inFlightByKey.set(body.idempotencyKey, { acceptedAt, promise: terminalPromise });
    try {
      const terminal = await terminalPromise;
      this.send(socket, terminal);
    } finally {
      this.inFlight.delete(body.requestId);
      this.inFlightByKey.delete(body.idempotencyKey);
    }
  }

  async runRequest(frame, deadline, controller) {
    try {
      const result = await withDeadline(this.dispatchLocal(frame.body.method, frame.body.payload ?? {}, { signal: controller.signal }), deadline, controller);
      const terminal = { protocolVersion: 1, type: "response.completed", connectionId: this.connectionId, body: { requestId: frame.body.requestId, result, completedAt: new Date().toISOString() } };
      encodeFrame(terminal);
      return terminal;
    } catch (error) {
      return responseFailureFrame({ connectionId: this.connectionId, requestId: frame.body.requestId, error });
    }
  }

  async dispatchLocal(method, payload, options = {}) {
    switch (method) {
      case "capabilityProbe": case "capabilities.probe": return await this.t3.capabilityProbe();
      case "environmentInfo": case "environment.info": return await this.t3.environmentInfo();
      case "snapshot": return await this.t3.snapshot();
      case "threadDetail": case "thread.detail": return await this.t3.threadDetail(payload.threadId, { turnLimit: payload.turnLimit });
      case "dispatch": return await this.t3.dispatch(payload.command ?? payload, options);
      case "media.transcribe": return await this.localTranscriber.transcribe(payload, options);
      case "callRpc": case "rpc.call": return await this.t3.callRpc(payload.tag, payload.payload ?? {}, options);
      default: throw Object.assign(new Error(`Unsupported connector method: ${method}`), { code: "UNSUPPORTED_METHOD", retryable: false });
    }
  }

  subscribe(socket, frame) {
    const body = frame.body;
    if (typeof body.leaseId !== "string" || typeof body.threadId !== "string") throw Object.assign(new Error("Invalid subscribe frame."), { code: "PROTOCOL_INVALID_REQUEST" });
    this.unsubscribe(body.leaseId);
    if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) throw Object.assign(new Error("Connector is at its thread subscription limit."), { code: "CONNECTOR_BACKPRESSURE" });
    const expiresAt = Date.parse(body.expiresAt);
    const leaseMs = Number.isFinite(expiresAt) ? Math.max(0, Math.min(expiresAt - Date.now(), 24 * 60 * 60 * 1000)) : 90_000;
    const timer = setTimeout(() => this.unsubscribe(body.leaseId), leaseMs);
    timer.unref?.();
    const subscription = {
      body: { ...body },
      socket,
      cursor: Number.isFinite(body.cursor) ? body.cursor : null,
      expiresAt: Date.now() + leaseMs,
      timer,
      retryTimer: null,
      retryAttempt: 0,
      activeAttempt: null,
      closed: false,
    };
    this.subscriptions.set(body.leaseId, subscription);
    this.openSubscription(subscription);
  }

  unsubscribe(leaseId) {
    const subscription = this.subscriptions.get(leaseId);
    if (subscription) {
      subscription.closed = true;
      clearTimeout(subscription.timer);
      clearTimeout(subscription.retryTimer);
      subscription.retryTimer = null;
      subscription.activeAttempt?.handle?.close();
      subscription.activeAttempt = null;
    }
    this.subscriptions.delete(leaseId);
  }

  openSubscription(subscription) {
    if (subscription.closed || this.stopped || subscription.expiresAt <= Date.now()) {
      this.unsubscribe(subscription.body.leaseId);
      return;
    }
    const attempt = { handle: null };
    subscription.activeAttempt = attempt;
    try {
      const handle = this.t3.openThreadStream({
        threadId: subscription.body.threadId,
        afterSequence: subscription.cursor,
        requestCompletionMarker: true,
        turnLimit: subscription.body.turnLimit,
      }, {
        onItem: (item) => {
          if (subscription.closed || subscription.activeAttempt !== attempt) return;
          subscription.retryAttempt = 0;
          if (item?.kind === "event" && Number.isFinite(item.event?.sequence)) subscription.cursor = item.event.sequence;
          if (Number.isFinite(subscription.cursor)) {
            this.state.lastEventCursor = subscription.cursor;
            void Promise.resolve(this.persistState?.(this.state)).catch((error) => this.logger.error?.("Could not persist connector cursor.", safeError(error)));
          }
          try {
            this.send(subscription.socket, {
              protocolVersion: 1, type: item?.kind === "snapshot" ? "snapshot" : "event", connectionId: this.connectionId,
              body: item?.kind === "snapshot"
                ? { environmentId: this.state.environmentId, threadId: subscription.body.threadId, leaseId: subscription.body.leaseId, cursor: subscription.cursor, resetReason: subscription.cursor === null ? "initial" : "resume-gap", snapshot: item.snapshot }
                : { environmentId: this.state.environmentId, threadId: subscription.body.threadId, leaseId: subscription.body.leaseId, eventId: item?.event?.id ?? randomUUID(), cursor: subscription.cursor, payload: item },
            });
          } catch (error) {
            this.logger.error?.(`Thread subscription ${subscription.body.leaseId} produced an unsendable frame.`, safeError(error));
          }
        },
        onClose: ({ reason, error } = {}) => {
          if (subscription.closed || subscription.activeAttempt !== attempt) return;
          subscription.activeAttempt = null;
          if (error) this.logger.error?.(`Thread subscription ${subscription.body.leaseId} closed (${reason}).`, safeError(error));
          this.scheduleSubscriptionReconnect(subscription);
        },
      });
      if (subscription.activeAttempt === attempt && !subscription.closed) attempt.handle = handle;
      else handle?.close?.();
    } catch (error) {
      if (subscription.activeAttempt === attempt) subscription.activeAttempt = null;
      this.logger.error?.(`Thread subscription ${subscription.body.leaseId} could not open.`, safeError(error));
      this.scheduleSubscriptionReconnect(subscription);
    }
  }

  scheduleSubscriptionReconnect(subscription) {
    if (subscription.closed || this.stopped || subscription.retryTimer || subscription.expiresAt <= Date.now()) return;
    const cap = Math.min(
      this.maxSubscriptionReconnectMs,
      this.minSubscriptionReconnectMs * 2 ** Math.min(subscription.retryAttempt, 10),
    );
    const delay = Math.max(this.minSubscriptionReconnectMs, Math.floor(cap * (0.5 + this.random() * 0.5)));
    subscription.retryAttempt += 1;
    subscription.retryTimer = setTimeout(() => {
      subscription.retryTimer = null;
      this.openSubscription(subscription);
    }, Math.min(delay, Math.max(0, subscription.expiresAt - Date.now())));
    subscription.retryTimer.unref?.();
  }

  cancelRequest(requestId) {
    const controller = this.inFlight.get(requestId);
    controller?.abort();
  }

  async sendHeartbeat(socket) {
    if (this.heartbeatInProgress) return;
    this.heartbeatInProgress = true;
    try {
      let t3Health = this.state.t3AccessToken ? "ready" : "auth_failed";
      try { await this.t3.environmentInfo(); } catch { t3Health = "error"; }
      this.send(socket, {
        protocolVersion: 1, type: "heartbeat", connectionId: this.connectionId,
        body: { sequence: ++this.heartbeatSequence, t3Health, activeRequests: this.inFlight.size,
          queueDepth: 0, sentAt: new Date().toISOString() },
      });
    } finally {
      this.heartbeatInProgress = false;
    }
  }

  send(socket, frame) { socket.send(encodeFrame(frame)); }

  closeSubscriptions() {
    for (const leaseId of [...this.subscriptions.keys()]) this.unsubscribe(leaseId);
  }

  stop() {
    this.stopped = true;
    for (const controller of this.inFlight.values()) controller.abort();
    this.closeSubscriptions();
    this.reconnectWake?.();
    try { this.socket?.close(1000, "connector shutdown"); } catch {}
  }

  async waitForReconnect(delay) {
    if (this.sleep) {
      await this.sleep(delay);
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, delay);
      this.reconnectWake = () => { clearTimeout(timer); resolve(); };
    });
  }


  async rememberTerminal(key, terminal) {
    this.completed.set(key, terminal);
    this.state.completedRequests = this.completed.entries();
    try {
      await this.persistState?.(this.state);
    } catch (error) {
      // Preserve the existing availability behavior when a local disk/backend fails. The cache
      // remains authoritative for this process and the operator gets a redacted diagnostic; on a
      // healthy backend, awaiting above closes the ordinary response-before-rename crash window.
      this.logger.error?.("Could not persist connector idempotency state.", safeError(error));
    }
  }
}

function connectorCapabilities(probe, authenticated, probeAvailable, metadataAvailable) {
  if (!probeAvailable) {
    return ["environmentInfo", "snapshot", "threadDetail", "dispatch", "callRpc", "threadStream"];
  }
  const output = [];
  if (metadataAvailable || probe?.probes?.metadata === "passed") output.push("environmentInfo");
  if (probe?.probes?.snapshot === "passed") output.push("snapshot");
  if (probe?.probes?.threadDetail === "passed" || probe?.serverCapabilities?.threadSnapshotPagination) output.push("threadDetail");
  if (authenticated && probe?.probes?.snapshot === "passed") output.push("dispatch");
  if (probe?.probes?.serverConfig === "passed") output.push("callRpc");
  if (probe?.serverCapabilities?.threadResumeCompletionMarker) output.push("threadStream");
  output.push("capabilityProbe");
  return output;
}

function sanitizeProviders(providers) {
  if (!Array.isArray(providers)) return [];
  const statuses = new Set(["ready", "error", "disabled", "unknown", "starting", "stopped", "unavailable"]);
  const authStatuses = new Set(["authenticated", "unauthenticated", "unknown", "error"]);
  const text = (value) => typeof value === "string" ? value.slice(0, 120) : "";
  return providers.slice(0, 50).map((provider) => ({
    id: text(provider?.id ?? provider?.instanceId),
    label: text(provider?.displayName ?? provider?.label ?? provider?.name),
    // Readiness is independent from the existence of model slugs. Preserve only explicit
    // structured evidence; never send provider error messages, login labels, or credentials.
    status: statuses.has(provider?.status) ? provider.status : "unknown",
    enabled: provider?.enabled === true,
    installed: provider?.installed === true,
    auth: { status: authStatuses.has(provider?.auth?.status) ? provider.auth.status : "unknown" },
    models: Array.isArray(provider?.models) ? provider.models.slice(0, 50).map((model) => ({
      id: text(typeof model === "string" ? model : model?.id ?? model?.slug),
      label: text(typeof model === "string" ? model : model?.label ?? model?.name ?? model?.id ?? model?.slug),
    })).filter((model) => model.id) : [],
  })).filter((provider) => provider.id);
}

function parseDeadline(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value === "string") { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
  return Date.now() + 30_000;
}

async function withDeadline(promise, deadline, controller) {
  const remaining = deadline === null ? 30_000 : Math.max(0, Math.min(deadline - Date.now(), 5 * 60_000));
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error("Connector request deadline elapsed."), { code: "REQUEST_DEADLINE" }));
      controller.abort();
    }, remaining);
    timer.unref?.();
    const abort = () => reject(Object.assign(new Error("Connector request was cancelled."), { code: "REQUEST_CANCELLED" }));
    controller.signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); });
  });
}

function clampInteger(value, min, max, fallback) { return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback; }
