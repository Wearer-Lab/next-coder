import { DurableObject } from "cloudflare:workers";

import type { RuntimeBindings } from "./env";
import {
  CONNECTOR_OFFLINE_AFTER_MS,
  CONNECTOR_PROTOCOL_VERSION,
  CONNECTOR_STALE_AFTER_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_CONNECTOR_FRAME_BYTES,
  MAX_IDEMPOTENCY_ENTRIES,
  MAX_LOCAL_EVENT_OUTBOX_BYTES,
  MAX_LOCAL_EVENT_OUTBOX_COUNT,
  MAX_PENDING_REQUESTS,
  MAX_TERMINAL_RESULT_BYTES,
  TERMINAL_RESULT_RETENTION_MS,
  clampDeadlineMs,
  decodeConnectorFrame,
  encodeFrame,
  isRecord,
  jsonByteLength,
  ProtocolError,
  type CloudCancelFrame,
  type CloudRequestFrame,
  type CloudSubscribeFrame,
  type CloudUnsubscribeFrame,
  type CloudShutdownFrame,
  type CloudWelcomeFrame,
  type ConnectorEventFrame,
  type ConnectorFailedFrame,
  type ConnectorHeartbeatFrame,
  type ConnectorHelloFrame,
  type ConnectorHubEvent,
  type ConnectorRequestInput,
  type ConnectorSnapshotFrame,
  type ConnectorTicketClaims,
} from "./protocol";
import { durableOperation, emitTelemetry } from "./telemetry";

interface ConnectionAttachment {
  connectionId: string;
  ticketId: string;
  connectorId: string;
  environmentId: string;
  scopes: string[];
  authorizedAt: number;
  helloReceived: boolean;
  lastHeartbeatAt: number;
  connectorVersion?: string;
  t3Version?: string;
  capabilities?: string[];
}

interface ConnectorPresence {
  connectorId: string;
  environmentId: string;
  connectionId: string;
  status: "online" | "stale" | "offline" | "revoked";
  connectedAt: number;
  lastSeenAt: number;
  connectorVersion?: string;
  t3Version?: string;
  capabilities: string[];
  t3Health?: string;
}

interface PendingRequest {
  connectorId: string;
  requestId: string;
  idempotencyKey: string;
  method: string;
  payload: unknown;
  createdAt: number;
  deadlineAt: number;
  connectionId: string;
  status: "dispatched" | "accepted";
  acceptedAt?: number;
}

export interface ConnectorTerminalResult {
  requestId: string;
  idempotencyKey: string;
  status: "completed" | "failed";
  result?: unknown;
  failure?: { code: string; retryable: boolean; detail?: string };
  completedAt: number;
  expiresAt: number;
}

interface IdempotencyRecord {
  idempotencyKey: string;
  requestId: string;
  expiresAt: number;
  terminal?: {
    status: ConnectorTerminalResult["status"];
    completedAt: number;
  };
}

interface ExpiringKey {
  key: string;
  expiresAt: number;
  bytes?: number;
}

const MAX_SUBSCRIPTIONS = 16;
const MAX_SUBSCRIPTION_ITEMS = 256;
const MAX_SUBSCRIPTION_BYTES = 1024 * 1024;
const MIN_SUBSCRIPTION_LEASE_MS = 10_000;
const MAX_SUBSCRIPTION_LEASE_MS = 5 * 60_000;
const MAX_LONG_POLL_MS = 25_000;
const MAX_ACTIVE_LONG_POLLS = MAX_PENDING_REQUESTS + MAX_SUBSCRIPTIONS;

interface SubscriptionLease {
  connectorId: string;
  leaseId: string;
  threadId: string;
  connectionId: string;
  expiresAt: number;
  cursor?: number;
  turnLimit?: number;
  nextSequence: number;
  items: SubscriptionItem[];
  bytes: number;
}

interface SubscriptionItem {
  sequence: number;
  value: unknown;
  bytes: number;
}

export class EnvironmentConnectorHub extends DurableObject<RuntimeBindings> {
  private readonly changeWaiters = new Map<string, Set<() => void>>();
  private activeLongPolls = 0;
  // ASR text belongs in the media job, never the Durable Object result journal.
  private readonly mediaResults = new Map<string, ConnectorTerminalResult>();
  private readonly runtime: RuntimeBindings;

  constructor(ctx: DurableObjectState, env: RuntimeBindings) {
    super(ctx, env);
    this.runtime = env;
  }

  async fetch(request: Request): Promise<Response> {
    const startedAt = performance.now();
    let response: Response | undefined;
    try {
      const url = new URL(request.url);
      if (url.pathname === "/socket") response = await this.acceptConnectorSocket(request);
      else if (url.pathname === "/status" && request.method === "GET") response = await this.getStatus();
      else if (url.pathname === "/requests" && request.method === "POST") response = await this.routeRequest(request);
      if (url.pathname.startsWith("/requests/") && url.pathname.endsWith("/cancel") && request.method === "POST") {
        const requestId = decodeURIComponent(url.pathname.slice("/requests/".length, -"/cancel".length));
        response = await this.cancelRequest(requestId);
      } else if (url.pathname.startsWith("/requests/") && request.method === "GET") {
        response = await this.getRequestResult(decodeURIComponent(url.pathname.slice("/requests/".length)), url, request.signal);
      } else if (url.pathname === "/subscriptions" && request.method === "POST") response = await this.openSubscription(request);
      else if (url.pathname.startsWith("/subscriptions/") && request.method === "GET") {
        response = await this.pollSubscription(decodeURIComponent(url.pathname.slice("/subscriptions/".length)), url, request.signal);
      } else if (url.pathname.startsWith("/subscriptions/") && request.method === "DELETE") {
        response = await this.closeSubscription(decodeURIComponent(url.pathname.slice("/subscriptions/".length)));
      } else if (url.pathname === "/revoke" && request.method === "POST") response = await this.revoke(request);
      else if (url.pathname === "/disconnect" && request.method === "POST") response = await this.disconnect(request);
      else if (!response) response = json({ error: "not_found" }, 404);
    } catch (error) {
      response = error instanceof ProtocolError
        ? json({ error: error.code, message: error.message }, error.status)
        : json({ error: "runtime_error", message: error instanceof Error ? error.message : "Unknown runtime error." }, 500);
    }
    const completed = response ?? json({ error: "runtime_error" }, 500);
    emitTelemetry(this.runtime, {
      kind: "do_request",
      operation: durableOperation(request),
      outcome: completed.status >= 500 ? "failure" : completed.status >= 400 ? "rejected" : "success",
      status: completed.status,
      durationMs: performance.now() - startedAt,
    });
    return completed;
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = readAttachment(socket);
    try {
      const frame = decodeConnectorFrame(message);
      if (frame.type !== "hello" && frame.connectionId !== attachment.connectionId) {
        throw new ProtocolError("invalid_frame", "Frame connectionId does not match this connection.");
      }
      if (frame.type !== "hello" && !attachment.helloReceived) {
        throw new ProtocolError("invalid_frame", "A hello frame is required before other frames.");
      }
      if (frame.type !== "hello") {
        const presence = await this.ctx.storage.get<ConnectorPresence>("presence");
        if (
          presence?.connectionId !== attachment.connectionId
          || (presence.status !== "online" && presence.status !== "stale")
        ) {
          throw new ProtocolError("invalid_frame", "Frame belongs to a stale connector connection.");
        }
      }

      switch (frame.type) {
        case "hello":
          await this.handleHello(socket, attachment, frame);
          break;
        case "heartbeat":
          await this.handleHeartbeat(socket, attachment, frame);
          break;
        case "response.accepted":
          await this.handleAccepted(attachment, frame.body.requestId, Date.parse(frame.body.acceptedAt));
          break;
        case "response.completed":
          await this.handleTerminal(attachment, frame.body.requestId, {
            status: "completed",
            result: frame.body.result,
            completedAt: Date.parse(frame.body.completedAt),
          });
          break;
        case "response.failed":
          await this.handleFailure(attachment, frame);
          break;
        case "event":
          await this.handleEvent(attachment, frame);
          break;
        case "snapshot":
          await this.handleSnapshot(attachment, frame);
          break;
        case "credential.rotated":
          await this.publish(attachment, "connector.credential-rotated", {
            challenge: frame.body.challenge,
            rotatedAt: frame.body.rotatedAt,
          });
          break;
      }
    } catch (error) {
      const reason = error instanceof ProtocolError ? error.code : "invalid_frame";
      safeClose(socket, 4002, reason);
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const attachment = readAttachment(socket);
    const replacement = this.getActiveSocket(attachment.connectionId);
    if (!replacement) {
      await this.markOffline(attachment, reason || `closed_${code}`, wasClean);
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    const attachment = readAttachment(socket);
    const replacement = this.getActiveSocket(attachment.connectionId);
    if (!replacement) await this.markOffline(attachment, "socket_error", false);
    safeClose(socket, 1011, "socket_error");
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (now - attachment.lastHeartbeatAt >= CONNECTOR_OFFLINE_AFTER_MS) {
        safeClose(socket, 4000, "heartbeat_timeout");
      } else if (now - attachment.lastHeartbeatAt >= CONNECTOR_STALE_AFTER_MS) {
        const presence = await this.ctx.storage.get<ConnectorPresence>("presence");
        if (presence?.connectionId === attachment.connectionId && presence.status === "online") {
          presence.status = "stale";
          await this.ctx.storage.put("presence", presence);
        }
      }
    }

    const pending = await this.ctx.storage.list<PendingRequest>({ prefix: "pending:" });
    for (const [key, item] of pending) {
      if (item.deadlineAt <= now) {
        await this.ctx.storage.delete(key);
        await this.storeTerminal({
          requestId: item.requestId,
          idempotencyKey: item.idempotencyKey,
          status: "failed",
          failure: { code: "connector_timeout", retryable: true },
          completedAt: now,
          expiresAt: now + TERMINAL_RESULT_RETENTION_MS,
        });
        const socket = this.findSocket(item.connectionId);
        if (socket) {
          const cancel: CloudCancelFrame = {
            protocolVersion: CONNECTOR_PROTOCOL_VERSION,
            type: "cancel",
            connectionId: item.connectionId,
            body: { requestId: item.requestId, reason: "deadline_exceeded" },
          };
          safeSend(socket, cancel);
        }
      }
    }

    for (const [id, result] of this.mediaResults) {
      if (result.expiresAt <= now) this.mediaResults.delete(id);
    }
    await this.pruneExpiringIndex("terminal-index", "terminal:", now);
    await this.pruneExpiringIndex("idempotency-index", "idempotency:", now);
    const subscriptions = await this.ctx.storage.list<SubscriptionLease>({ prefix: "subscription:" });
    for (const [key, lease] of subscriptions) {
      if (lease.expiresAt <= now) {
        const socket = this.findSocket(lease.connectionId);
        if (socket) this.sendUnsubscribe(socket, lease);
        await this.ctx.storage.delete(key);
        this.notifyChange(subscriptionWaitKey(lease.leaseId));
      }
    }
    await this.scheduleNextAlarm();
  }

  private async acceptConnectorSocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426);
    }
    const claims = claimsFromInternalHeaders(request.headers);
    if (!claims) return json({ error: "connector_ticket_required" }, 401);
    if (await this.ctx.storage.get(`revoked:${claims.connectorId}`)) return json({ error: "connector_revoked" }, 403);
    const presence = await this.ctx.storage.get<ConnectorPresence>("presence");
    if (presence?.status === "revoked" && presence.connectorId === claims.connectorId) {
      return json({ error: "connector_revoked" }, 403);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const now = Date.now();
    const attachment: ConnectionAttachment = {
      connectionId: crypto.randomUUID(),
      ticketId: claims.ticketId,
      connectorId: claims.connectorId,
      environmentId: claims.environmentId,
      scopes: claims.scopes,
      authorizedAt: now,
      helloReceived: false,
      lastHeartbeatAt: now,
    };

    // A newly authenticated connector supersedes any prior socket for this
    // environment. The old connector receives a truthful shutdown reason.
    for (const existing of this.ctx.getWebSockets()) {
      const current = readAttachment(existing);
      const shutdown: CloudShutdownFrame = {
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        type: "shutdown",
        connectionId: current.connectionId,
        body: { reason: "superseded" },
      };
      safeSend(existing, shutdown);
      safeClose(existing, 4001, "superseded");
    }

    this.ctx.acceptWebSocket(server, ["connector"]);
    server.serializeAttachment(attachment);
    await this.scheduleNextAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleHello(socket: WebSocket, attachment: ConnectionAttachment, frame: ConnectorHelloFrame): Promise<void> {
    if (await this.ctx.storage.get(`revoked:${attachment.connectorId}`)) {
      throw new ProtocolError("connector_revoked", "Connector credential was revoked.", 403);
    }
    if (
      attachment.helloReceived ||
      frame.body.connectorId !== attachment.connectorId ||
      frame.body.environmentId !== attachment.environmentId
    ) {
      throw new ProtocolError("invalid_frame", "hello does not match the authenticated ticket.");
    }

    attachment.helloReceived = true;
    // The connector proposes the non-empty connection id in hello. Adopting it
    // keeps the canonical CLI and cloud protocol on one id from the first frame.
    attachment.connectionId = frame.connectionId;
    attachment.lastHeartbeatAt = Date.now();
    attachment.connectorVersion = frame.body.connectorVersion;
    if (frame.body.t3Version !== undefined) attachment.t3Version = frame.body.t3Version;
    else delete attachment.t3Version;
    attachment.capabilities = frame.body.capabilities.slice(0, 128);
    socket.serializeAttachment(attachment);

    const presence: ConnectorPresence = {
      connectorId: attachment.connectorId,
      environmentId: attachment.environmentId,
      connectionId: attachment.connectionId,
      status: "online",
      connectedAt: attachment.authorizedAt,
      lastSeenAt: attachment.lastHeartbeatAt,
      connectorVersion: frame.body.connectorVersion,
      capabilities: attachment.capabilities,
      ...(frame.body.t3Version ? { t3Version: frame.body.t3Version } : {}),
    };
    await this.ctx.storage.put("presence", presence);
    emitTelemetry(this.runtime, {
      kind: "connector_availability", operation: "connected", outcome: "success", count: 1, force: true,
    });

    const welcome: CloudWelcomeFrame = {
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "welcome",
      connectionId: attachment.connectionId,
      body: {
        serverTime: new Date().toISOString(),
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        maxFrameBytes: MAX_CONNECTOR_FRAME_BYTES,
        maxInFlight: MAX_PENDING_REQUESTS,
      },
    };
    safeSend(socket, welcome);
    await this.publish(attachment, "connector.hello", {
      connectorVersion: frame.body.connectorVersion,
      platform: frame.body.platform.slice(0, 128),
      t3Version: frame.body.t3Version,
      t3Health: frame.body.t3Health?.slice(0, 64),
      capabilities: attachment.capabilities,
      providerCatalogue: Array.isArray(frame.body.providerCatalogue) ? frame.body.providerCatalogue.slice(0, 128) : [],
      lastEventCursor: frame.body.lastEventCursor,
    });
    await this.recoverConnection(socket, attachment);
    await this.scheduleNextAlarm();
  }

  private async recoverConnection(socket: WebSocket, attachment: ConnectionAttachment): Promise<void> {
    const now = Date.now();
    const pending = await this.ctx.storage.list<PendingRequest>({ prefix: "pending:", limit: MAX_PENDING_REQUESTS + 1 });
    for (const [key, item] of pending) {
      if (item.deadlineAt <= now) {
        await this.ctx.storage.delete(key);
        await this.storeTerminal({
          requestId: item.requestId,
          idempotencyKey: item.idempotencyKey,
          status: "failed",
          failure: { code: "connector_timeout", retryable: true },
          completedAt: now,
          expiresAt: now + TERMINAL_RESULT_RETENTION_MS,
        });
        continue;
      }
      if (item.connectorId !== attachment.connectorId) continue;
      if (item.method === "media.transcribe" && !attachment.capabilities?.includes("media.transcribe")) {
        await this.ctx.storage.delete(key);
        await this.storeTerminal({ requestId: item.requestId, idempotencyKey: item.idempotencyKey,
          status: "failed", failure: { code: "connector_capability_unavailable", retryable: true },
          completedAt: now, expiresAt: now + TERMINAL_RESULT_RETENTION_MS });
        continue;
      }
      item.connectionId = attachment.connectionId;
      item.status = "dispatched";
      delete item.acceptedAt;
      await this.ctx.storage.put(key, item);
      safeSend(socket, {
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        type: "request",
        connectionId: attachment.connectionId,
        body: {
          requestId: item.requestId,
          idempotencyKey: item.idempotencyKey,
          method: item.method,
          deadlineAt: new Date(item.deadlineAt).toISOString(),
          payload: item.payload,
        },
      });
    }

    const subscriptions = await this.ctx.storage.list<SubscriptionLease>({ prefix: "subscription:", limit: MAX_SUBSCRIPTIONS + 1 });
    for (const [key, lease] of subscriptions) {
      if (lease.expiresAt <= now) {
        await this.ctx.storage.delete(key);
        continue;
      }
      if (lease.connectorId !== attachment.connectorId) continue;
      lease.connectionId = attachment.connectionId;
      await this.ctx.storage.put(key, lease);
      safeSend(socket, {
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        type: "subscribe",
        connectionId: attachment.connectionId,
        body: {
          threadId: lease.threadId,
          leaseId: lease.leaseId,
          expiresAt: new Date(lease.expiresAt).toISOString(),
          ...(lease.cursor !== undefined ? { cursor: lease.cursor } : {}),
          ...(lease.turnLimit !== undefined ? { turnLimit: lease.turnLimit } : {}),
        },
      });
    }
  }

  private async handleHeartbeat(socket: WebSocket, attachment: ConnectionAttachment, frame: ConnectorHeartbeatFrame): Promise<void> {
    const now = Date.now();
    attachment.lastHeartbeatAt = now;
    socket.serializeAttachment(attachment);
    const presence = await this.ctx.storage.get<ConnectorPresence>("presence");
    if (presence?.connectionId === attachment.connectionId) {
      presence.status = "online";
      presence.lastSeenAt = now;
      presence.t3Health = frame.body.t3Health ?? "unknown";
      await this.ctx.storage.put("presence", presence);
    }
    await this.publish(attachment, "connector.heartbeat", {
      sequence: frame.body.sequence,
      t3Health: frame.body.t3Health ?? "unknown",
      activeRequests: frame.body.activeRequests,
      queueDepth: frame.body.queueDepth,
      sentAt: frame.body.sentAt,
    });
    await this.scheduleNextAlarm();
  }

  private async handleAccepted(attachment: ConnectionAttachment, requestId: string, acceptedAt: number): Promise<void> {
    const key = pendingKey(requestId);
    const pending = await this.ctx.storage.get<PendingRequest>(key);
    if (!pending || pending.connectionId !== attachment.connectionId) return;
    pending.status = "accepted";
    pending.acceptedAt = acceptedAt;
    await this.ctx.storage.put(key, pending);
    await this.publish(attachment, "connector.response", { requestId, status: "accepted", acceptedAt });
  }

  private async handleFailure(attachment: ConnectionAttachment, frame: ConnectorFailedFrame): Promise<void> {
    await this.handleTerminal(attachment, frame.body.requestId, {
      status: "failed",
      failure: {
        code: frame.body.code,
        retryable: frame.body.retryable,
        ...(frame.body.detail ? { detail: frame.body.detail.slice(0, 512) } : {}),
      },
      completedAt: Date.parse(frame.body.failedAt),
    });
  }

  private async handleTerminal(
    attachment: ConnectionAttachment,
    requestId: string,
    terminal: Pick<ConnectorTerminalResult, "status" | "result" | "failure" | "completedAt">,
  ): Promise<void> {
    const key = pendingKey(requestId);
    const pending = await this.ctx.storage.get<PendingRequest>(key);
    if (!pending || pending.connectionId !== attachment.connectionId) return;
    await this.ctx.storage.delete(key);
    const stored: ConnectorTerminalResult = {
      requestId,
      idempotencyKey: pending.idempotencyKey,
      status: terminal.status,
      completedAt: terminal.completedAt,
      expiresAt: Date.now() + TERMINAL_RESULT_RETENTION_MS,
      ...(terminal.result !== undefined ? { result: terminal.result } : {}),
      ...(terminal.failure ? { failure: terminal.failure } : {}),
    };
    if (pending.method === "media.transcribe") {
      if (stored.failure) {
        const codes = new Set(["transcription_unconfigured", "transcription_unavailable", "transcription_invalid_audio", "transcription_empty", "transcription_timeout", "media_access_denied"]);
        stored.failure = { code: codes.has(stored.failure.code) ? stored.failure.code : "connector_transcription_failed", retryable: stored.failure.retryable };
      }
      if (stored.status === "completed") {
        const result = sanitizeMediaTranscriptionResult(stored.result);
        if (result) {
          for (const [id, item] of this.mediaResults) {
            if (item.expiresAt <= Date.now()) this.mediaResults.delete(id);
          }
          while (this.mediaResults.size >= MAX_PENDING_REQUESTS) {
            this.mediaResults.delete(this.mediaResults.keys().next().value!);
          }
          const transient = { ...stored, result, expiresAt: Date.now() + 60_000 };
          this.mediaResults.set(requestId, transient);
          // A hibernation/restart loses only this transient reply. The caller may
          // safely transcribe again under a new media-job attempt identity.
          delete stored.result;
          stored.status = "failed";
          stored.failure = { code: "connector_transcription_result_unavailable", retryable: true };
        } else {
          delete stored.result;
          stored.status = "failed";
          stored.failure = { code: "connector_transcription_result_invalid", retryable: false };
        }
      }
    }
    await this.storeTerminal(stored);
    // Terminal result bodies and failure details are private T3/user content.
    // The private request waiter reads `stored` directly; Queue/event consumers
    // receive only bounded routing and observability metadata.
    const delivered = this.withMediaResult(stored);
    await this.publish(attachment, "connector.response", {
      requestId,
      status: delivered.status,
      completedAt: stored.completedAt,
      durationMs: Math.max(0, stored.completedAt - pending.createdAt),
      ...(delivered.failure ? {
        failureCode: safeFailureCode(delivered.failure.code),
        retryable: delivered.failure.retryable,
      } : {}),
    });
    await this.scheduleNextAlarm();
  }

  private async handleEvent(attachment: ConnectionAttachment, frame: ConnectorEventFrame): Promise<void> {
    if (frame.body.environmentId !== attachment.environmentId) throw new ProtocolError("invalid_frame", "event environment does not match the connection.");
    if (frame.body.leaseId) await this.appendSubscriptionItem(attachment, frame.body.leaseId, frame.body.payload, frame.body.cursor);
    await this.publish(attachment, "connector.event", {
      eventId: frame.body.eventId,
      cursor: frame.body.cursor,
      threadId: frame.body.threadId,
      payload: frame.body.payload,
      leaseId: frame.body.leaseId,
    });
  }

  private async handleSnapshot(attachment: ConnectionAttachment, frame: ConnectorSnapshotFrame): Promise<void> {
    if (frame.body.environmentId !== attachment.environmentId) throw new ProtocolError("invalid_frame", "snapshot environment does not match the connection.");
    if (frame.body.leaseId) {
      await this.appendSubscriptionItem(attachment, frame.body.leaseId, { kind: "snapshot", snapshot: frame.body.snapshot }, frame.body.cursor);
    }
    await this.publish(attachment, "connector.snapshot", {
      cursor: frame.body.cursor,
      reason: frame.body.resetReason,
      projection: frame.body.snapshot,
      leaseId: frame.body.leaseId,
      threadId: frame.body.threadId,
    });
  }

  private async cancelRequest(requestId: string): Promise<Response> {
    if (!requestId) return json({ error: "invalid_request_id" }, 400);
    const pending = await this.ctx.storage.get<PendingRequest>(pendingKey(requestId));
    if (!pending) return json({ cancelled: false, reason: "not_pending" }, 404);
    await this.ctx.storage.delete(pendingKey(requestId));
    const now = Date.now();
    await this.storeTerminal({
      requestId,
      idempotencyKey: pending.idempotencyKey,
      status: "failed",
      failure: { code: "connector_cancelled", retryable: false },
      completedAt: now,
      expiresAt: now + TERMINAL_RESULT_RETENTION_MS,
    });
    const socket = this.findSocket(pending.connectionId);
    if (socket) {
      safeSend(socket, {
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        type: "cancel",
        connectionId: pending.connectionId,
        body: { requestId, reason: "caller_cancelled" },
      });
    }
    await this.scheduleNextAlarm();
    return json({ cancelled: true });
  }

  private async openSubscription(request: Request): Promise<Response> {
    const value: unknown = await request.json().catch(() => null);
    if (!isRecord(value) || !validIdentifier(value.leaseId) || !validIdentifier(value.threadId)) {
      throw new ProtocolError("invalid_frame", "leaseId and threadId are invalid.");
    }
    const socket = this.getActiveSocket();
    if (!socket) return json({ error: "connector_offline", retryable: true }, 503);
    const attachment = readAttachment(socket);
    if (typeof value.connectorId === "string" && value.connectorId !== attachment.connectorId) return json({ error: "connector_ownership_mismatch" }, 403);
    if (!attachment.scopes.includes("t3:proxy")) return json({ error: "connector_scope_denied" }, 403);
    const current = await this.ctx.storage.list<SubscriptionLease>({ prefix: "subscription:", limit: MAX_SUBSCRIPTIONS + 1 });
    const existing = current.get(subscriptionKey(value.leaseId));
    if (existing && existing.connectorId !== attachment.connectorId) return json({ error: "connector_ownership_mismatch" }, 403);
    if (!existing && current.size >= MAX_SUBSCRIPTIONS) {
      emitTelemetry(this.runtime, {
        kind: "do_capacity", operation: "subscriptions", outcome: "failure",
        bucket: "saturated", count: current.size, limit: MAX_SUBSCRIPTIONS, force: true,
      });
      return json({ error: "connector_backpressure", retryable: true, maxSubscriptions: MAX_SUBSCRIPTIONS }, 429);
    }
    const now = Date.now();
    const requestedExpiresAt = typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? value.expiresAt : now + MAX_SUBSCRIPTION_LEASE_MS;
    const expiresAt = Math.max(now + MIN_SUBSCRIPTION_LEASE_MS, Math.min(requestedExpiresAt, now + MAX_SUBSCRIPTION_LEASE_MS));
    const cursor = Number.isSafeInteger(value.cursor) && (value.cursor as number) >= 0 ? value.cursor as number : undefined;
    const turnLimit = Number.isSafeInteger(value.turnLimit) && (value.turnLimit as number) >= 1 && (value.turnLimit as number) <= 100 ? value.turnLimit as number : undefined;
    const lease: SubscriptionLease = existing ?? {
      connectorId: attachment.connectorId,
      leaseId: value.leaseId,
      threadId: value.threadId,
      connectionId: attachment.connectionId,
      expiresAt,
      nextSequence: 1,
      items: [],
      bytes: 0,
    };
    lease.threadId = value.threadId;
    lease.connectorId = attachment.connectorId;
    lease.connectionId = attachment.connectionId;
    lease.expiresAt = expiresAt;
    if (cursor !== undefined) lease.cursor = cursor;
    if (turnLimit !== undefined) lease.turnLimit = turnLimit;
    await this.ctx.storage.put(subscriptionKey(lease.leaseId), lease);
    emitTelemetry(this.runtime, {
      kind: "do_capacity", operation: "subscriptions", outcome: "success",
      bucket: capacityBucket(current.size + (existing ? 0 : 1), MAX_SUBSCRIPTIONS),
      count: current.size + (existing ? 0 : 1), limit: MAX_SUBSCRIPTIONS,
    });
    const frame: CloudSubscribeFrame = {
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "subscribe",
      connectionId: attachment.connectionId,
      body: {
        threadId: lease.threadId,
        leaseId: lease.leaseId,
        expiresAt: new Date(expiresAt).toISOString(),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(turnLimit !== undefined ? { turnLimit } : {}),
      },
    };
    safeSend(socket, frame);
    await this.scheduleNextAlarm();
    return json({ leaseId: lease.leaseId, expiresAt, cursor: lease.cursor ?? null });
  }

  private async pollSubscription(leaseId: string, url: URL, signal: AbortSignal): Promise<Response> {
    if (!validIdentifier(leaseId)) return json({ error: "invalid_lease_id" }, 400);
    const afterValue = Number(url.searchParams.get("after") ?? 0);
    const after = Number.isSafeInteger(afterValue) && afterValue >= 0 ? afterValue : 0;
    const waitMs = parseWaitMs(url);
    let state = await this.readSubscriptionPage(leaseId, after);
    if (state.response || state.items.length > 0 || waitMs === 0) return state.response ?? json(state.page);

    const waiter = this.registerChangeWaiter(subscriptionWaitKey(leaseId), Math.min(waitMs, state.expiresInMs), signal);
    state = await this.readSubscriptionPage(leaseId, after);
    if (state.response || state.items.length > 0) {
      waiter.cancel();
      return state.response ?? json(state.page);
    }
    await waiter.promise;
    state = await this.readSubscriptionPage(leaseId, after);
    return state.response ?? json(state.page);
  }

  private async readSubscriptionPage(
    leaseId: string,
    after: number,
  ): Promise<{ response?: Response; items: Array<{ sequence: number; value: unknown }>; page: unknown; expiresInMs: number }> {
    const lease = await this.ctx.storage.get<SubscriptionLease>(subscriptionKey(leaseId));
    if (!lease) return { response: json({ error: "subscription_not_found" }, 404), items: [], page: null, expiresInMs: 0 };
    const expiresInMs = lease.expiresAt - Date.now();
    if (expiresInMs <= 0) {
      await this.ctx.storage.delete(subscriptionKey(leaseId));
      this.notifyChange(subscriptionWaitKey(leaseId));
      return { response: json({ error: "subscription_expired" }, 410), items: [], page: null, expiresInMs: 0 };
    }
    const items = lease.items
      .filter((item) => item.sequence > after)
      .map(({ sequence, value }) => ({ sequence, value }));
    return { items, page: { leaseId, expiresAt: lease.expiresAt, items }, expiresInMs };
  }

  private async closeSubscription(leaseId: string): Promise<Response> {
    if (!validIdentifier(leaseId)) return json({ error: "invalid_lease_id" }, 400);
    const key = subscriptionKey(leaseId);
    const lease = await this.ctx.storage.get<SubscriptionLease>(key);
    if (!lease) return json({ closed: false });
    const socket = this.findSocket(lease.connectionId);
    if (socket) this.sendUnsubscribe(socket, lease);
    await this.ctx.storage.delete(key);
    this.notifyChange(subscriptionWaitKey(leaseId));
    await this.scheduleNextAlarm();
    return json({ closed: true });
  }

  private sendUnsubscribe(socket: WebSocket, lease: SubscriptionLease): void {
    const frame: CloudUnsubscribeFrame = {
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "unsubscribe",
      connectionId: lease.connectionId,
      body: { leaseId: lease.leaseId },
    };
    safeSend(socket, frame);
  }

  private async appendSubscriptionItem(attachment: ConnectionAttachment, leaseId: string, value: unknown, cursor?: number | null): Promise<void> {
    const key = subscriptionKey(leaseId);
    const lease = await this.ctx.storage.get<SubscriptionLease>(key);
    if (!lease || lease.connectionId !== attachment.connectionId || lease.expiresAt <= Date.now()) return;
    const bytes = jsonByteLength(value);
    if (bytes > MAX_SUBSCRIPTION_BYTES) return;
    lease.items.push({ sequence: lease.nextSequence++, value, bytes });
    if (Number.isSafeInteger(cursor) && (cursor as number) >= 0) lease.cursor = cursor as number;
    lease.bytes += bytes;
    while (lease.items.length > MAX_SUBSCRIPTION_ITEMS || lease.bytes > MAX_SUBSCRIPTION_BYTES) {
      const removed = lease.items.shift();
      if (!removed) break;
      lease.bytes -= removed.bytes;
    }
    await this.ctx.storage.put(key, lease);
    emitTelemetry(this.runtime, {
      kind: "do_capacity", operation: "subscription_buffer", outcome: "success",
      bucket: capacityBucket(lease.bytes, MAX_SUBSCRIPTION_BYTES),
      count: lease.items.length, bytes: lease.bytes, limit: MAX_SUBSCRIPTION_BYTES,
    });
    this.notifyChange(subscriptionWaitKey(leaseId));
  }

  private async routeRequest(request: Request): Promise<Response> {
    const text = await request.text();
    if (jsonByteLength(text) > MAX_CONNECTOR_FRAME_BYTES) {
      throw new ProtocolError("payload_too_large", "Request exceeds the connector frame limit.", 413);
    }
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      throw new ProtocolError("invalid_frame", "Request body is not valid JSON.");
    }
    const parsed = parseRequestInput(input);

    const routedPresence = await this.ctx.storage.get<ConnectorPresence>("presence");
    if (parsed.connectorId && routedPresence?.connectorId && parsed.connectorId !== routedPresence.connectorId) {
      return json({ error: "connector_ownership_mismatch" }, 403);
    }

    if (parsed.method === "media.transcribe") {
      const mediaSocket = this.getActiveSocket();
      if (!mediaSocket) return json({ error: "connector_offline", retryable: true }, 503);
      const mediaAttachment = readAttachment(mediaSocket);
      if (!mediaAttachment.scopes.includes("t3:proxy")) return json({ error: "connector_scope_denied" }, 403);
      if (!mediaAttachment.capabilities?.includes("media.transcribe")) {
        return json({ error: "connector_capability_unavailable", retryable: true }, 503);
      }
    }
    const existing = await this.resolveIdempotentRequest(parsed.requestId, parsed.idempotencyKey);
    if (existing) return existing;

    const socket = this.getActiveSocket();
    if (!socket) return json({ error: "connector_offline", retryable: true }, 503);
    const attachment = readAttachment(socket);
    if (parsed.connectorId && parsed.connectorId !== attachment.connectorId) return json({ error: "connector_ownership_mismatch" }, 403);
    if (!attachment.scopes.includes("t3:proxy")) return json({ error: "connector_scope_denied" }, 403);

    const pending = await this.ctx.storage.list<PendingRequest>({ prefix: "pending:", limit: MAX_PENDING_REQUESTS + 1 });
    if (pending.size >= MAX_PENDING_REQUESTS) {
      emitTelemetry(this.runtime, {
        kind: "do_capacity", operation: "pending_requests", outcome: "failure",
        bucket: "saturated", count: pending.size, limit: MAX_PENDING_REQUESTS, force: true,
      });
      return json({ error: "connector_backpressure", retryable: true, maxPendingRequests: MAX_PENDING_REQUESTS }, 429);
    }

    const now = Date.now();
    const deadlineAt = now + clampDeadlineMs(parsed.deadlineMs);
    const item: PendingRequest = {
      connectorId: attachment.connectorId,
      requestId: parsed.requestId,
      idempotencyKey: parsed.idempotencyKey,
      method: parsed.method,
      payload: parsed.payload,
      createdAt: now,
      deadlineAt,
      connectionId: attachment.connectionId,
      status: "dispatched",
    };
    const frame: CloudRequestFrame = {
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "request",
      connectionId: attachment.connectionId,
      body: {
        requestId: item.requestId,
        idempotencyKey: item.idempotencyKey,
        method: item.method,
        deadlineAt: new Date(deadlineAt).toISOString(),
        payload: parsed.payload,
      },
    };
    const encoded = encodeFrame(frame);

    await this.ctx.storage.put(pendingKey(item.requestId), item);
    emitTelemetry(this.runtime, {
      kind: "do_capacity", operation: "pending_requests", outcome: "success",
      bucket: capacityBucket(pending.size + 1, MAX_PENDING_REQUESTS),
      count: pending.size + 1, limit: MAX_PENDING_REQUESTS,
    });
    await this.storeIdempotency(item.idempotencyKey, item.requestId, now + TERMINAL_RESULT_RETENTION_MS);
    try {
      socket.send(encoded);
    } catch {
      await this.ctx.storage.delete(pendingKey(item.requestId));
      await this.storeTerminal({
        requestId: item.requestId,
        idempotencyKey: item.idempotencyKey,
        status: "failed",
        failure: { code: "connector_offline", retryable: true },
        completedAt: now,
        expiresAt: now + TERMINAL_RESULT_RETENTION_MS,
      });
      return json({ error: "connector_offline", retryable: true }, 503);
    }
    await this.scheduleNextAlarm();
    return json({ requestId: item.requestId, status: "dispatched", deadlineAt }, 202);
  }

  private async resolveIdempotentRequest(requestId: string, idempotencyKey: string): Promise<Response | null> {
    const directTerminal = await this.ctx.storage.get<ConnectorTerminalResult>(terminalKey(requestId));
    if (directTerminal) return json(this.withMediaResult(directTerminal));
    const directPending = await this.ctx.storage.get<PendingRequest>(pendingKey(requestId));
    if (directPending) return json(directPending, 202);

    const idempotency = await this.ctx.storage.get<IdempotencyRecord>(idempotencyKeyFor(idempotencyKey));
    if (!idempotency || idempotency.expiresAt <= Date.now()) return null;
    const terminal = await this.ctx.storage.get<ConnectorTerminalResult>(terminalKey(idempotency.requestId));
    if (terminal) return json(this.withMediaResult(terminal));
    const pending = await this.ctx.storage.get<PendingRequest>(pendingKey(idempotency.requestId));
    if (pending) return json(pending, 202);
    // A count/byte bound may evict the private result before its 24-hour
    // idempotency receipt expires. Preserve at-most-once behavior without
    // pretending that a missing result body is still available.
    return json({
      requestId: idempotency.requestId,
      idempotencyKey: idempotency.idempotencyKey,
      status: "failed",
      failure: { code: "connector_result_evicted", retryable: false },
      completedAt: idempotency.terminal?.completedAt ?? Date.now(),
      expiresAt: idempotency.expiresAt,
      ...(idempotency.terminal ? { originalStatus: idempotency.terminal.status } : {}),
    });
  }

  private async getRequestResult(requestId: string, url: URL, signal: AbortSignal): Promise<Response> {
    if (!requestId) return json({ error: "invalid_request_id" }, 400);
    const waitMs = parseWaitMs(url);
    let state = await this.readRequestResult(requestId);
    if (!state.pending || waitMs === 0) return state.response;

    const waiter = this.registerChangeWaiter(requestWaitKey(requestId), waitMs, signal);
    state = await this.readRequestResult(requestId);
    if (!state.pending) {
      waiter.cancel();
      return state.response;
    }
    await waiter.promise;
    return (await this.readRequestResult(requestId)).response;
  }

  private async readRequestResult(requestId: string): Promise<{ pending: boolean; response: Response }> {
    const terminal = await this.ctx.storage.get<ConnectorTerminalResult>(terminalKey(requestId));
    if (terminal) return { pending: false, response: json(this.withMediaResult(terminal)) };
    const pending = await this.ctx.storage.get<PendingRequest>(pendingKey(requestId));
    if (pending) return { pending: true, response: json(pending, 202) };
    return { pending: false, response: json({ error: "request_not_found" }, 404) };
  }

  private withMediaResult(terminal: ConnectorTerminalResult): ConnectorTerminalResult {
    const result = this.mediaResults.get(terminal.requestId);
    if (!result) return terminal;
    if (result.expiresAt <= Date.now()) {
      this.mediaResults.delete(terminal.requestId);
      return terminal;
    }
    return result;
  }

  private async getStatus(): Promise<Response> {
    const presence = await this.ctx.storage.get<ConnectorPresence>("presence");
    if (!presence) return json({ status: "offline", stale: true });
    const ageMs = Date.now() - presence.lastSeenAt;
    const status = ageMs >= CONNECTOR_OFFLINE_AFTER_MS ? "offline" : ageMs >= CONNECTOR_STALE_AFTER_MS ? "stale" : presence.status;
    return json({ ...presence, status, stale: status !== "online", ageMs });
  }

  private async revoke(request: Request): Promise<Response> {
    const value: unknown = await request.json().catch(() => null);
    const connectorId = isRecord(value) && typeof value.connectorId === "string" ? value.connectorId : undefined;
    const reason = isRecord(value) && typeof value.reason === "string" ? value.reason.slice(0, 128) : "revoked";
    let revoked = 0;
    if (connectorId) await this.ctx.storage.put(`revoked:${connectorId}`, { revokedAt: Date.now(), reason });
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!connectorId || attachment.connectorId === connectorId) {
        const shutdown: CloudShutdownFrame = {
          protocolVersion: CONNECTOR_PROTOCOL_VERSION,
          type: "shutdown",
          connectionId: attachment.connectionId,
          body: { reason: "revoked" },
        };
        safeSend(socket, shutdown);
        safeClose(socket, 4003, "revoked");
        revoked += 1;
      }
    }
    const presence = await this.ctx.storage.get<ConnectorPresence>("presence");
    const targetPresence = presence && (!connectorId || presence.connectorId === connectorId) ? presence : undefined;
    if (targetPresence) {
      targetPresence.status = "revoked";
      await this.ctx.storage.put("presence", targetPresence);
    }
    await this.failAllPending("connector_revoked", false, connectorId);
    await this.deleteAllSubscriptions(connectorId);
    await this.publishSystemDisconnect(targetPresence, reason, true);
    emitTelemetry(this.runtime, {
      kind: "connector_availability", operation: "revoked", outcome: "failure",
      count: revoked, errorCode: "connector_revoked", force: true,
    });
    return json({ revoked: true, disconnectedSockets: revoked });
  }

  private async disconnect(request: Request): Promise<Response> {
    const value: unknown = await request.json().catch(() => null);
    const reason = isRecord(value) && typeof value.reason === "string" ? value.reason.slice(0, 128) : "operator_disconnect";
    for (const socket of this.ctx.getWebSockets()) safeClose(socket, 1001, reason);
    const presence = await this.ctx.storage.get<ConnectorPresence>("presence");
    await this.failAllPending("connector_offline", true);
    await this.deleteAllSubscriptions();
    await this.publishSystemDisconnect(presence, reason, true);
    emitTelemetry(this.runtime, {
      kind: "connector_availability", operation: "operator_disconnect", outcome: "degraded",
      errorCode: "operator_disconnect", force: true,
    });
    return json({ disconnected: true });
  }

  private async markOffline(attachment: ConnectionAttachment, reason: string, wasClean: boolean): Promise<void> {
    const presence = await this.ctx.storage.get<ConnectorPresence>("presence");
    if (presence?.connectionId === attachment.connectionId && presence.status !== "revoked") {
      presence.status = "offline";
      presence.lastSeenAt = Date.now();
      await this.ctx.storage.put("presence", presence);
      await this.publish(attachment, "connector.disconnected", { reason: reason.slice(0, 128), wasClean });
      emitTelemetry(this.runtime, {
        kind: "connector_availability", operation: "offline", outcome: "failure",
        errorCode: connectorReasonCode(reason), force: true,
      });
    }
    await this.scheduleNextAlarm();
  }

  private async failAllPending(code: string, retryable: boolean, connectorId?: string): Promise<void> {
    const now = Date.now();
    const pending = await this.ctx.storage.list<PendingRequest>({ prefix: "pending:" });
    for (const [key, item] of pending) {
      if (connectorId && item.connectorId !== connectorId) continue;
      await this.ctx.storage.delete(key);
      await this.storeTerminal({
        requestId: item.requestId,
        idempotencyKey: item.idempotencyKey,
        status: "failed",
        failure: { code, retryable },
        completedAt: now,
        expiresAt: now + TERMINAL_RESULT_RETENTION_MS,
      });
    }
  }

  private async deleteAllSubscriptions(connectorId?: string): Promise<void> {
    const subscriptions = await this.ctx.storage.list<SubscriptionLease>({ prefix: "subscription:" });
    const selected = [...subscriptions].filter(([, item]) => !connectorId || item.connectorId === connectorId);
    const keys = selected.map(([key]) => key);
    if (keys.length) await this.ctx.storage.delete(keys);
    for (const [, lease] of selected) this.notifyChange(subscriptionWaitKey(lease.leaseId));
  }

  private async storeTerminal(result: ConnectorTerminalResult): Promise<void> {
    const key = terminalKey(result.requestId);
    await this.ctx.storage.put(key, result);
    await this.appendExpiringIndex(
      "terminal-index",
      { key, expiresAt: result.expiresAt, bytes: jsonByteLength(result) },
      MAX_IDEMPOTENCY_ENTRIES,
      MAX_TERMINAL_RESULT_BYTES,
    );
    const idempotencyStorageKey = idempotencyKeyFor(result.idempotencyKey);
    const idempotency = await this.ctx.storage.get<IdempotencyRecord>(idempotencyStorageKey);
    if (idempotency?.requestId === result.requestId) {
      idempotency.terminal = { status: result.status, completedAt: result.completedAt };
      await this.ctx.storage.put(idempotencyStorageKey, idempotency);
    }
    this.notifyChange(requestWaitKey(result.requestId));
  }

  private registerChangeWaiter(key: string, waitMs: number, signal: AbortSignal): { promise: Promise<void>; cancel: () => void } {
    if (this.activeLongPolls >= MAX_ACTIVE_LONG_POLLS) {
      emitTelemetry(this.runtime, {
        kind: "do_capacity", operation: "active_long_polls", outcome: "failure",
        bucket: "saturated", count: this.activeLongPolls, limit: MAX_ACTIVE_LONG_POLLS, force: true,
      });
      throw new ProtocolError("connector_backpressure", "Too many active connector waits.", 429);
    }
    let finish = () => {};
    const promise = new Promise<void>((resolve) => {
      let settled = false;
      const listeners = this.changeWaiters.get(key) ?? new Set<() => void>();
      const onChange = () => finish();
      const timer = setTimeout(onChange, Math.max(1, Math.min(waitMs, MAX_LONG_POLL_MS)));
      finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onChange);
        listeners.delete(onChange);
        if (listeners.size === 0) this.changeWaiters.delete(key);
        this.activeLongPolls -= 1;
        resolve();
      };
      listeners.add(onChange);
      this.changeWaiters.set(key, listeners);
      this.activeLongPolls += 1;
      emitTelemetry(this.runtime, {
        kind: "do_capacity", operation: "active_long_polls", outcome: "success",
        bucket: capacityBucket(this.activeLongPolls, MAX_ACTIVE_LONG_POLLS),
        count: this.activeLongPolls, limit: MAX_ACTIVE_LONG_POLLS,
      });
      signal.addEventListener("abort", onChange, { once: true });
      if (signal.aborted) finish();
    });
    return { promise, cancel: finish };
  }

  private notifyChange(key: string): void {
    for (const finish of [...(this.changeWaiters.get(key) ?? [])]) finish();
  }

  private async storeIdempotency(idempotencyKey: string, requestId: string, expiresAt: number): Promise<void> {
    const key = idempotencyKeyFor(idempotencyKey);
    await this.ctx.storage.put<IdempotencyRecord>(key, { idempotencyKey, requestId, expiresAt });
    await this.appendExpiringIndex("idempotency-index", { key, expiresAt }, MAX_IDEMPOTENCY_ENTRIES);
  }

  private async appendExpiringIndex(indexKey: string, item: ExpiringKey, limit: number, maxBytes?: number): Promise<void> {
    const index = (await this.ctx.storage.get<ExpiringKey[]>(indexKey)) ?? [];
    const withoutDuplicate = index.filter((entry) => entry.key !== item.key);
    withoutDuplicate.push(item);
    if (maxBytes !== undefined) {
      const missing = withoutDuplicate.filter((entry) => entry.bytes === undefined);
      if (missing.length) {
        const stored = await this.ctx.storage.get<ConnectorTerminalResult>(missing.map((entry) => entry.key));
        for (const entry of missing) {
          const value = stored.get(entry.key);
          entry.bytes = value === undefined ? 0 : jsonByteLength(value);
        }
      }
    }
    let totalBytes = withoutDuplicate.reduce((total, entry) => total + (entry.bytes ?? 0), 0);
    const evicted: ExpiringKey[] = [];
    while (withoutDuplicate.length > limit || (maxBytes !== undefined && totalBytes > maxBytes)) {
      const oldest = withoutDuplicate.shift();
      if (!oldest) break;
      evicted.push(oldest);
      totalBytes -= oldest.bytes ?? 0;
    }
    if (evicted.length) await this.ctx.storage.delete(evicted.map((entry) => entry.key));
    await this.ctx.storage.put(indexKey, withoutDuplicate);
    emitTelemetry(this.runtime, {
      kind: "do_capacity",
      operation: indexKey === "terminal-index" ? "terminal_results" : "idempotency_receipts",
      outcome: evicted.length > 0 ? "degraded" : "success",
      bucket: evicted.length > 0 ? "evicted" : capacityBucket(withoutDuplicate.length, limit),
      count: withoutDuplicate.length,
      bytes: totalBytes,
      limit: maxBytes ?? limit,
      force: evicted.length > 0,
    });
  }

  private async pruneExpiringIndex(indexKey: string, prefix: string, now: number): Promise<void> {
    const index = (await this.ctx.storage.get<ExpiringKey[]>(indexKey)) ?? [];
    const expired = index.filter((entry) => entry.expiresAt <= now && entry.key.startsWith(prefix));
    if (expired.length) await this.ctx.storage.delete(expired.map((entry) => entry.key));
    const retained = index.filter((entry) => entry.expiresAt > now);
    if (retained.length) await this.ctx.storage.put(indexKey, retained);
    else await this.ctx.storage.delete(indexKey);
  }

  private async publish(attachment: ConnectionAttachment, kind: ConnectorHubEvent["kind"], body: unknown): Promise<void> {
    const event: ConnectorHubEvent = {
      eventVersion: 1,
      environmentId: attachment.environmentId,
      connectorId: attachment.connectorId,
      connectionId: attachment.connectionId,
      occurredAt: Date.now(),
      kind,
      body,
    };
    if (this.env.CONNECTOR_EVENTS) {
      await this.env.CONNECTOR_EVENTS.send(event);
      return;
    }
    if (this.env.CONNECTOR_EVENT_SINK) {
      const response = await this.env.CONNECTOR_EVENT_SINK.fetch("https://control-plane.internal/v1/internal/connector-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!response.ok) throw new Error(`Connector event sink failed with status ${response.status}.`);
      return;
    }
    if (this.env.DEPLOYMENT_ENVIRONMENT !== "local") {
      throw new Error("CONNECTOR_EVENTS or CONNECTOR_EVENT_SINK is required outside local development.");
    }
    await this.appendLocalOutbox(event);
  }

  private async appendLocalOutbox(event: ConnectorHubEvent): Promise<void> {
    const bytes = jsonByteLength(event);
    if (bytes > MAX_LOCAL_EVENT_OUTBOX_BYTES) throw new ProtocolError("payload_too_large", "Event exceeds local outbox capacity.", 413);
    const key = `outbox:${event.occurredAt}:${crypto.randomUUID()}`;
    const index = (await this.ctx.storage.get<ExpiringKey[]>("outbox-index")) ?? [];
    index.push({ key, expiresAt: event.occurredAt + TERMINAL_RESULT_RETENTION_MS, bytes });
    let totalBytes = index.reduce((total, item) => total + (item.bytes ?? 0), 0);
    const evicted: ExpiringKey[] = [];
    while (index.length > MAX_LOCAL_EVENT_OUTBOX_COUNT || totalBytes > MAX_LOCAL_EVENT_OUTBOX_BYTES) {
      const item = index.shift();
      if (!item) break;
      evicted.push(item);
      totalBytes -= item.bytes ?? 0;
    }
    if (evicted.length) await this.ctx.storage.delete(evicted.map((item) => item.key));
    await this.ctx.storage.put(key, event);
    await this.ctx.storage.put("outbox-index", index);
    const utilization = Math.max(
      index.length / MAX_LOCAL_EVENT_OUTBOX_COUNT,
      totalBytes / MAX_LOCAL_EVENT_OUTBOX_BYTES,
    );
    emitTelemetry(this.runtime, {
      kind: "do_capacity",
      operation: "local_event_outbox",
      outcome: evicted.length > 0 ? "degraded" : "success",
      bucket: evicted.length > 0 ? "evicted" : capacityBucket(utilization, 1),
      count: index.length,
      bytes: totalBytes,
      limit: MAX_LOCAL_EVENT_OUTBOX_BYTES,
      force: evicted.length > 0,
    });
  }

  private async publishSystemDisconnect(presence: ConnectorPresence | undefined, reason: string, wasClean: boolean): Promise<void> {
    if (!presence) return;
    await this.publish(
      {
        connectionId: presence.connectionId,
        ticketId: "redacted",
        connectorId: presence.connectorId,
        environmentId: presence.environmentId,
        scopes: [],
        authorizedAt: presence.connectedAt,
        helloReceived: true,
        lastHeartbeatAt: presence.lastSeenAt,
      },
      "connector.disconnected",
      { reason, wasClean },
    );
  }

  private getActiveSocket(excludeConnectionId?: string): WebSocket | undefined {
    return this.ctx.getWebSockets("connector").find((socket) => {
      const attachment = readAttachment(socket);
      return attachment.helloReceived && attachment.connectionId !== excludeConnectionId && socket.readyState === WebSocket.OPEN;
    });
  }

  private findSocket(connectionId: string): WebSocket | undefined {
    return this.ctx.getWebSockets("connector").find((socket) => readAttachment(socket).connectionId === connectionId);
  }

  private async scheduleNextAlarm(): Promise<void> {
    const candidates: number[] = [...this.mediaResults.values()].map((result) => result.expiresAt);
    for (const socket of this.ctx.getWebSockets("connector")) {
      const attachment = readAttachment(socket);
      candidates.push(attachment.lastHeartbeatAt + CONNECTOR_STALE_AFTER_MS);
      candidates.push(attachment.lastHeartbeatAt + CONNECTOR_OFFLINE_AFTER_MS);
    }
    const pending = await this.ctx.storage.list<PendingRequest>({ prefix: "pending:" });
    for (const item of pending.values()) candidates.push(item.deadlineAt);
    const subscriptions = await this.ctx.storage.list<SubscriptionLease>({ prefix: "subscription:" });
    for (const item of subscriptions.values()) candidates.push(item.expiresAt);
    for (const indexKey of ["terminal-index", "idempotency-index"] as const) {
      const index = (await this.ctx.storage.get<ExpiringKey[]>(indexKey)) ?? [];
      for (const item of index) candidates.push(item.expiresAt);
    }
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    const next = Math.max(now + 1_000, Math.min(...candidates.filter((candidate) => candidate > now)) || now + 1_000);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || next < current || current <= now) await this.ctx.storage.setAlarm(next);
  }
}

function capacityBucket(value: number, limit: number): string {
  if (!Number.isFinite(limit) || limit <= 0) return "unknown";
  const utilization = value / limit;
  if (utilization >= 1) return "saturated";
  if (utilization >= 0.8) return "gte_80pct";
  if (utilization >= 0.5) return "50_80pct";
  return "lt_50pct";
}

function connectorReasonCode(reason: string): string {
  const fixedReasons = new Set([
    "heartbeat_timeout",
    "operator_disconnect",
    "revoked",
    "socket_error",
    "superseded",
  ]);
  if (fixedReasons.has(reason)) return reason;
  if (/^closed_[0-9]{3,4}$/u.test(reason)) return "socket_closed";
  return "connector_disconnected";
}

function parseRequestInput(value: unknown): ConnectorRequestInput {
  if (
    !isRecord(value) ||
    typeof value.requestId !== "string" ||
    value.requestId.length < 8 ||
    value.requestId.length > 128 ||
    typeof value.idempotencyKey !== "string" ||
    value.idempotencyKey.length < 8 ||
    value.idempotencyKey.length > 256 ||
    typeof value.method !== "string" ||
    value.method.length < 1 ||
    value.method.length > 128
  ) {
    throw new ProtocolError("invalid_frame", "requestId, idempotencyKey, and method are invalid.");
  }
  if (value.method === "media.transcribe") {
    const payload = value.payload;
    if (!isRecord(payload) || Object.keys(payload).length !== 2 ||
      ![payload.jobId, payload.mediaId].every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(id))) {
      throw new ProtocolError("invalid_frame", "media.transcribe requires only jobId and mediaId.");
    }
    if (typeof value.connectorId !== "string" || !value.connectorId) {
      throw new ProtocolError("invalid_frame", "media.transcribe requires a scoped connector identity.");
    }
  }
  return {
    ...(typeof value.connectorId === "string" ? { connectorId: value.connectorId } : {}),
    requestId: value.requestId,
    idempotencyKey: value.idempotencyKey,
    method: value.method,
    payload: value.payload,
    ...(value.deadlineMs !== undefined ? { deadlineMs: clampDeadlineMs(value.deadlineMs) } : {}),
  };
}

function claimsFromInternalHeaders(headers: Headers): ConnectorTicketClaims | null {
  if (headers.get("x-ac-ticket-verified") !== "1") return null;
  const ticketId = headers.get("x-ac-ticket-id");
  const connectorId = headers.get("x-ac-connector-id");
  const environmentId = headers.get("x-ac-environment-id");
  const audience = headers.get("x-ac-ticket-audience");
  const expiresAt = Number(headers.get("x-ac-ticket-expires-at"));
  const scopes = (headers.get("x-ac-ticket-scopes") ?? "").split(",").filter(Boolean);
  if (!ticketId || !connectorId || !environmentId || !audience || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return { ticketId, connectorId, environmentId, audience, expiresAt, scopes };
}

function readAttachment(socket: WebSocket): ConnectionAttachment {
  const value: unknown = socket.deserializeAttachment();
  if (!isRecord(value) || typeof value.connectionId !== "string" || typeof value.connectorId !== "string" || typeof value.environmentId !== "string") {
    throw new ProtocolError("invalid_frame", "Connector socket attachment is invalid.");
  }
  return value as unknown as ConnectionAttachment;
}

function safeSend(socket: WebSocket, frame: CloudWelcomeFrame | CloudShutdownFrame | CloudCancelFrame | CloudRequestFrame | CloudSubscribeFrame | CloudUnsubscribeFrame): void {
  try {
    socket.send(encodeFrame(frame));
  } catch {
    safeClose(socket, 1011, "send_failed");
  }
}

function safeClose(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason.slice(0, 123));
  } catch {
    // The runtime may already have closed this hibernated socket.
  }
}

function pendingKey(requestId: string): string {
  return `pending:${requestId}`;
}

function terminalKey(requestId: string): string {
  return `terminal:${requestId}`;
}

function idempotencyKeyFor(value: string): string {
  return `idempotency:${value}`;
}

function subscriptionKey(value: string): string {
  return `subscription:${value}`;
}

function requestWaitKey(value: string): string {
  return `request:${value}`;
}

function subscriptionWaitKey(value: string): string {
  return `subscription:${value}`;
}

function parseWaitMs(url: URL): number {
  const raw = url.searchParams.get("waitMs");
  if (raw === null) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new ProtocolError("invalid_frame", "waitMs must be a non-negative integer.");
  return Math.min(value, MAX_LONG_POLL_MS);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function safeFailureCode(value: string): string {
  return /^[a-z][a-z0-9_.:-]{0,63}$/.test(value) ? value : "request_failed";
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

// Allowlist bounded ASR metadata; arbitrary provider diagnostics may contain user content.
function sanitizeMediaTranscriptionResult(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.text !== "string" || !value.text.trim() || value.text.length > 32_000) return null;
  const result: Record<string, unknown> = { text: value.text };
  for (const field of ["model", "language", "provider"] as const) {
    const item = value[field];
    if (typeof item === "string" && /^[A-Za-z0-9_.:/-]{1,128}$/u.test(item)) result[field] = item;
  }
  if (typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 300_000) {
    result.durationMs = value.durationMs;
  }
  return result;
}
