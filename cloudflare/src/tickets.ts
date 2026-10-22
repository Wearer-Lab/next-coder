import { DurableObject } from "cloudflare:workers";

import type { LocalRuntimeBindings, RuntimeBindings } from "./env";
import { isRecord, type ConnectorTicketClaims } from "./protocol";

interface StoredTicket {
  tokenHash: string;
  claims: ConnectorTicketClaims;
  createdAt: number;
  consumedAt?: number;
  revokedAt?: number;
}

export interface ConnectorTicketVerifier {
  consume(ticket: string, audience: string, now: number): Promise<ConnectorTicketClaims | null>;
}

interface BackendTicketConsumption {
  connector: {
    id: string;
    environmentId: string;
    scopes: string[];
    revokedAt?: string | null;
  } | null;
  ticket?: {
    id: string;
    connectorId: string;
    environmentId: string;
    expiresAt: string;
  } | null;
  reason: string | null;
}

/**
 * Production boundary. The backend service must atomically hash, look up, and
 * consume the ticket. The raw ticket travels in the request body over a
 * Cloudflare Service Binding and is never placed in a backend URL or log field.
 */
export class ServiceBindingTicketVerifier implements ConnectorTicketVerifier {
  constructor(private readonly service: Fetcher) {}

  async consume(ticket: string, audience: string, now: number): Promise<ConnectorTicketClaims | null> {
    const response = await this.service.fetch(
      new Request("https://control-plane.internal/v1/internal/connectors/tickets/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket, audience, now }),
      }),
    );

    if (response.status === 401 || response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error(`Control-plane ticket consumption failed with status ${response.status}.`);
    const value: unknown = await response.json();
    return parseBackendTicketConsumption(value, audience, now);
  }
}

/** Local protocol-development verifier backed by an atomic Durable Object. */
export class DevelopmentDurableObjectTicketVerifier implements ConnectorTicketVerifier {
  constructor(private readonly namespace: DurableObjectNamespace<DevelopmentConnectorTicketStore>) {}

  async consume(ticket: string, audience: string, now: number): Promise<ConnectorTicketClaims | null> {
    const tokenHash = await sha256(ticket);
    const stub = this.namespace.get(this.namespace.idFromName(tokenHash));
    const response = await stub.fetch("https://ticket.internal/consume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenHash, audience, now }),
    });
    if (response.status === 401 || response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error(`Development ticket store failed with status ${response.status}.`);
    const value: unknown = await response.json();
    return parseTicketClaims(value, audience, now);
  }
}

export function createTicketVerifier(env: RuntimeBindings): ConnectorTicketVerifier {
  if (env.CONNECTOR_AUTH_MODE === "control-plane") {
    if (!env.CONTROL_PLANE) throw new Error("CONTROL_PLANE service binding is required in control-plane auth mode.");
    return new ServiceBindingTicketVerifier(env.CONTROL_PLANE);
  }
  if (env.DEPLOYMENT_ENVIRONMENT !== "local") {
    throw new Error("Development ticket auth is forbidden outside the local environment.");
  }
  return new DevelopmentDurableObjectTicketVerifier(env.DEV_CONNECTOR_TICKETS);
}

export function parseBackendTicketConsumption(
  value: unknown,
  audience: string,
  now = Date.now(),
): ConnectorTicketClaims | null {
  // The private Node service projects Store consumption into flat, bounded claims. Retain the
  // older Store-shaped response below for compatible adapters, but validate the deployed shape
  // against its actual audience and expiry rather than consuming a valid ticket and rejecting it.
  if (isRecord(value) && "ticketId" in value) return parseTicketClaims(value, audience, now);
  if (!isRecord(value) || value.reason !== null || !isRecord(value.connector) || !isRecord(value.ticket)) return null;
  const connector = value.connector;
  const ticket = value.ticket;
  const expiresAt = typeof ticket.expiresAt === "string" ? Date.parse(ticket.expiresAt) : Number.NaN;
  if (
    typeof connector.id !== "string" ||
    typeof connector.environmentId !== "string" ||
    !Array.isArray(connector.scopes) ||
    !connector.scopes.every((scope) => typeof scope === "string") ||
    connector.revokedAt != null ||
    typeof ticket.id !== "string" ||
    ticket.connectorId !== connector.id ||
    ticket.environmentId !== connector.environmentId ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now
  ) {
    return null;
  }
  const consumption = value as unknown as BackendTicketConsumption;
  return {
    ticketId: consumption.ticket!.id,
    connectorId: consumption.connector!.id,
    environmentId: consumption.connector!.environmentId,
    audience,
    scopes: [...consumption.connector!.scopes],
    expiresAt,
  };
}

export async function issueDevelopmentTicket(
  env: RuntimeBindings,
  ticket: string,
  claims: ConnectorTicketClaims,
  now = Date.now(),
): Promise<void> {
  if (env.DEPLOYMENT_ENVIRONMENT !== "local" || env.CONNECTOR_AUTH_MODE !== "dev-do") {
    throw new Error("Development ticket issuance is available only in local dev-do mode.");
  }
  const tokenHash = await sha256(ticket);
  const stub = env.DEV_CONNECTOR_TICKETS.get(env.DEV_CONNECTOR_TICKETS.idFromName(tokenHash));
  const response = await stub.fetch("https://ticket.internal/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenHash, claims, now }),
  });
  if (!response.ok) throw new Error(`Development ticket issuance failed with status ${response.status}.`);
}

export class DevelopmentConnectorTicketStore extends DurableObject<LocalRuntimeBindings> {
  constructor(ctx: DurableObjectState, env: LocalRuntimeBindings) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    const input: unknown = await request.json().catch(() => null);
    if (!isRecord(input) || typeof input.tokenHash !== "string") return json({ error: "invalid_request" }, 400);

    if (url.pathname === "/issue") {
      const now = typeof input.now === "number" ? input.now : Date.now();
      const claims = parseTicketClaims(input.claims, undefined, now, true);
      if (!claims) return json({ error: "invalid_ticket_claims" }, 400);
      const existing = await this.ctx.storage.get<StoredTicket>("ticket");
      if (existing) return json({ error: "ticket_already_exists" }, 409);
      await this.ctx.storage.put<StoredTicket>("ticket", { tokenHash: input.tokenHash, claims, createdAt: now });
      return json({ issued: true }, 201);
    }

    if (url.pathname === "/consume") {
      const audience = typeof input.audience === "string" ? input.audience : "";
      const now = typeof input.now === "number" ? input.now : Date.now();
      const result = await this.ctx.storage.transaction(async (txn) => {
        const stored = await txn.get<StoredTicket>("ticket");
        if (!stored || stored.tokenHash !== input.tokenHash) return { status: 404, claims: null };
        if (stored.revokedAt || stored.consumedAt || stored.claims.expiresAt <= now || stored.claims.audience !== audience) {
          return { status: 410, claims: null };
        }
        stored.consumedAt = now;
        await txn.put("ticket", stored);
        return { status: 200, claims: stored.claims };
      });
      return result.claims ? json(result.claims, result.status) : json({ error: "ticket_unavailable" }, result.status);
    }

    if (url.pathname === "/revoke") {
      await this.ctx.storage.transaction(async (txn) => {
        const stored = await txn.get<StoredTicket>("ticket");
        if (stored) {
          stored.revokedAt = Date.now();
          await txn.put("ticket", stored);
        }
      });
      return json({ revoked: true });
    }

    return json({ error: "not_found" }, 404);
  }
}

export function parseTicketClaims(
  value: unknown,
  expectedAudience?: string,
  now = Date.now(),
  allowExpired = false,
): ConnectorTicketClaims | null {
  if (
    !isRecord(value) ||
    typeof value.ticketId !== "string" ||
    typeof value.connectorId !== "string" ||
    typeof value.environmentId !== "string" ||
    typeof value.audience !== "string" ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every((scope) => typeof scope === "string") ||
    typeof value.expiresAt !== "number" ||
    (!allowExpired && value.expiresAt <= now) ||
    (expectedAudience !== undefined && value.audience !== expectedAudience)
  ) {
    return null;
  }
  return value as unknown as ConnectorTicketClaims;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
