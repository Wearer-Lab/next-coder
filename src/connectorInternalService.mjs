import {
  CONNECTOR_MAX_IN_FLIGHT,
  CONNECTOR_TICKET_AUDIENCE,
} from "./connectorProtocol.mjs";
import { buildProviderCatalogue } from "./t3Harness.mjs";

const MAX_INTERNAL_BODY_BYTES = 256 * 1024;
const MAX_CAPABILITIES = 128;
const MAX_PROVIDERS = 50;
const MAX_MODELS_PER_PROVIDER = 50;
const MAX_TEXT_LENGTH = 120;
const T3_HEALTH_VALUES = new Set([
  "unknown", "starting", "ready", "stopped", "auth_failed", "incompatible", "error",
]);
const CONNECTOR_EVENT_KINDS = new Set([
  "connector.hello",
  "connector.heartbeat",
  "connector.response",
  "connector.event",
  "connector.snapshot",
  "connector.disconnected",
  "connector.credential-rotated",
]);

/**
 * Cloudflare Service Binding target for connector authentication and event projections.
 *
 * This object is intentionally not mounted in the public Node route chain. Possession of the
 * Fetcher binding is the authentication realm; platform, connector, and device bearer tokens are
 * never accepted as substitutes for that capability.
 */
export function createConnectorInternalService({
  store,
  notifications = null,
  ticketAudience = CONNECTOR_TICKET_AUDIENCE,
} = {}) {
  if (!store) throw new Error("A Store is required for the connector internal service.");
  if (typeof ticketAudience !== "string" || !ticketAudience.trim()) {
    throw new Error("A connector ticket audience is required.");
  }

  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      if (url.pathname === "/v1/internal/connectors/tickets/consume") {
        return await consumeTicket(request, store, ticketAudience);
      }
      if (url.pathname === "/v1/internal/connector-events") {
        return await projectConnectorEvent(request, store, notifications);
      }
      return json({ error: "not_found" }, 404);
    },
  };
}

async function consumeTicket(request, store, configuredAudience) {
  const input = await readBoundedJson(request);
  if (!isRecord(input)
    || typeof input.ticket !== "string"
    || input.ticket.length < 16
    || input.ticket.length > 512
    || typeof input.audience !== "string"
    || !Number.isFinite(input.now)) {
    return json({ error: "invalid_request" }, 400);
  }
  if (input.audience !== configuredAudience) return json({ error: "invalid_ticket_audience" }, 401);

  const result = await store.consumeConnectorTicket({
    ticket: input.ticket,
    audience: configuredAudience,
    now: input.now,
  });
  if (!result?.connector) {
    const status = result?.reason === "unknown" ? 404 : 410;
    return json({ error: "ticket_unavailable" }, status);
  }
  const expiresAt = Date.parse(result.ticket?.expiresAt ?? "");
  if (!Number.isFinite(expiresAt) || expiresAt <= input.now) return json({ error: "ticket_unavailable" }, 410);
  return json({
    ticketId: result.ticket.id,
    connectorId: result.connector.id,
    environmentId: result.connector.environmentId,
    audience: result.ticket.audience,
    scopes: boundedStrings(result.connector.scopes, 32),
    expiresAt,
  });
}

async function projectConnectorEvent(request, store, notifications) {
  const event = await readBoundedJson(request);
  if (!validEventEnvelope(event)) return json({ error: "invalid_connector_event" }, 400);

  let connector = true;
  if (event.kind === "connector.hello") {
    if (!isRecord(event.body)) return json({ error: "invalid_connector_event" }, 400);
    const providerCatalogue = sanitizeProviderCatalogue(event.body.providerCatalogue, event.occurredAt);
    connector = await store.recordConnectorPresence({
      connectorId: event.connectorId,
      environmentId: event.environmentId,
      connectionId: event.connectionId,
      occurredAt: event.occurredAt,
      eventKey: eventKey(event),
      connectorVersion: boundedText(event.body.connectorVersion),
      t3Version: boundedText(event.body.t3Version),
      platform: boundedText(event.body.platform),
      capabilities: boundedStrings(event.body.capabilities, MAX_CAPABILITIES),
      t3Health: normalizeT3Health(event.body.t3Health),
      providerCatalogue,
      connected: true,
    });
  } else if (event.kind === "connector.heartbeat") {
    if (!isRecord(event.body)) return json({ error: "invalid_connector_event" }, 400);
    connector = await store.recordConnectorPresence({
      connectorId: event.connectorId,
      environmentId: event.environmentId,
      connectionId: event.connectionId,
      occurredAt: event.occurredAt,
      eventKey: eventKey(event),
      t3Health: normalizeT3Health(event.body.t3Health),
      activeRequests: boundedInteger(event.body.activeRequests, 0, CONNECTOR_MAX_IN_FLIGHT),
      queueDepth: boundedInteger(event.body.queueDepth, 0, 10_000),
      connected: true,
    });
  } else if (event.kind === "connector.disconnected") {
    connector = await store.recordConnectorPresence({
      connectorId: event.connectorId,
      environmentId: event.environmentId,
      connectionId: event.connectionId,
      occurredAt: event.occurredAt,
      eventKey: eventKey(event),
      connected: false,
      disconnectReason: isRecord(event.body) ? boundedText(event.body.reason) : null,
    });
  }

  if (!connector) return json({ error: "connector_unavailable" }, 404);
  if (connector !== true) {
    await notifications?.forConnector?.({
      userId: connector.userId,
      connector,
      previousStatus: connector._previousStatus,
      eventKey: eventKey(event),
      occurredAt: event.occurredAt,
    });
  }
  return json({ accepted: true }, 202);
}

function sanitizeProviderCatalogue(value, occurredAt) {
  if (!Array.isArray(value)) return null;
  const statuses = new Set(["ready", "error", "disabled", "unknown", "starting", "stopped", "unavailable"]);
  const authStatuses = new Set(["authenticated", "unauthenticated", "unknown", "error"]);
  const providers = value.slice(0, MAX_PROVIDERS).map((provider) => {
    if (!isRecord(provider)) return null;
    const id = boundedText(provider.id ?? provider.instanceId);
    if (!id) return null;
    return {
      id,
      label: boundedText(provider.label ?? provider.displayName ?? provider.name) ?? id,
      status: statuses.has(provider.status) ? provider.status : "unknown",
      enabled: provider.enabled === true,
      installed: provider.installed === true,
      auth: { status: authStatuses.has(provider.auth?.status) ? provider.auth.status : "unknown" },
      models: Array.isArray(provider.models)
        ? provider.models.slice(0, MAX_MODELS_PER_PROVIDER).map((model) => {
          if (typeof model === "string") return { id: boundedText(model), name: boundedText(model) };
          if (!isRecord(model)) return null;
          const modelId = boundedText(model.id ?? model.slug);
          return modelId ? { id: modelId, name: boundedText(model.label ?? model.name) ?? modelId } : null;
        }).filter(Boolean)
        : [],
    };
  }).filter(Boolean);
  return buildProviderCatalogue(providers, {
    source: "connector-hello",
    updatedAt: new Date(occurredAt).toISOString(),
  });
}

function eventKey(event) {
  return `${event.connectionId}:${event.occurredAt}:${event.kind}`;
}

function validEventEnvelope(value) {
  return isRecord(value)
    && value.eventVersion === 1
    && nonEmpty(value.environmentId)
    && nonEmpty(value.connectorId)
    && nonEmpty(value.connectionId)
    && Number.isFinite(value.occurredAt)
    && CONNECTOR_EVENT_KINDS.has(value.kind);
}

async function readBoundedJson(request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_INTERNAL_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_INTERNAL_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function boundedStrings(value, limit) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(boundedText).filter(Boolean))].slice(0, limit);
}

function boundedText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, MAX_TEXT_LENGTH) : null;
}

function boundedInteger(value, min, max) {
  return Number.isSafeInteger(value) ? Math.min(max, Math.max(min, value)) : null;
}

function normalizeT3Health(value) {
  return T3_HEALTH_VALUES.has(value) ? value : "unknown";
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_LENGTH;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function json(value, status = 200) {
  return Response.json(value, { status });
}
