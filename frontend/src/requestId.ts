import type { JsonRecord } from "./types";

const PENDING_REQUEST_PREFIX = "next-coder.pending-request.v1.";
const PENDING_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

// A browser restart may happen after the gateway accepted a write but before its response arrived.
// Persist only a digest-to-id journal: the draft itself never enters browser storage.
export async function durableMutationRequest(input: JsonRecord): Promise<{ clientRequestId: string; storageKey: string }> {
  const digest = await browserSha256(stableJson(input));
  const storageKey = `${PENDING_REQUEST_PREFIX}${digest}`;
  const now = Date.now();
  try {
    const existing = JSON.parse(localStorage.getItem(storageKey) ?? "null") as {
      clientRequestId?: unknown;
      expiresAt?: unknown;
    } | null;
    if (typeof existing?.clientRequestId === "string"
      && typeof existing.expiresAt === "number"
      && existing.expiresAt > now) {
      return { clientRequestId: existing.clientRequestId, storageKey };
    }
  } catch {
    // A corrupt or unavailable cache is not permission to retain request content elsewhere.
  }
  const random = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${now.toString(36)}-${Math.random().toString(36).slice(2)}`;
  const clientRequestId = `web:${random}`;
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      clientRequestId,
      expiresAt: now + PENDING_REQUEST_TTL_MS,
    }));
  } catch {
    // The request remains idempotent for this attempt even when private browsing denies storage.
  }
  return { clientRequestId, storageKey };
}

export function clearDurableMutationRequest(storageKey: string): void {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // Best effort only; an expired receipt cannot cause a duplicate effect on the server.
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function browserSha256(value: string): Promise<string> {
  if (crypto.subtle) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
