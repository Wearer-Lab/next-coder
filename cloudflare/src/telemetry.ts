import type { RuntimeBindings } from "./env";

export const TELEMETRY_SCHEMA = "next-coder.cloud-telemetry.v1";
const DEFAULT_SUCCESS_SAMPLE_RATE = 0.05;
const REJECTION_SAMPLE_RATE = 0.1;
const MAX_NUMBER = 86_400_000;
const SAFE_DIMENSION = /^[a-z0-9][a-z0-9_.:-]{0,63}$/u;
const FIXED_KINDS = new Set([
  "connector_availability", "do_capacity", "do_request", "edge_request", "queue_batch",
  "queue_dlq_risk", "queue_quarantine", "queue_schedule", "rollout_event",
]);
const FIXED_ENVIRONMENTS = new Set(["local", "staging", "production"]);
const FIXED_OPERATIONS = new Set([
  "active_long_polls", "background", "connected", "connector_disconnect", "connector_events",
  "connector_revoke", "connector_router", "connector_socket", "control_plane_api", "cron_fanout",
  "dead_letter", "development_only", "health", "idempotency_receipts", "local_event_outbox",
  "offline", "operator_disconnect", "pending_requests", "reconcile", "request_cancel",
  "request_dispatch", "request_result", "revoked", "rollout_api", "socket", "static_asset",
  "status", "subscription_buffer", "subscription_close", "subscription_open", "subscription_poll",
  "subscriptions", "terminal_results", "unknown",
]);
const FIXED_BUCKETS = new Set([
  "none", "unknown", "lt_1s", "1s_10s", "10s_60s", "1m_5m", "gte_5m", "lt_50pct",
  "50_80pct", "gte_80pct", "saturated", "evicted", "terminal", "retry_exhausted", "malformed",
]);
const FIXED_ERROR_CODES = new Set([
  "background_quarantine_unavailable",
  "background_task_failed",
  "background_task_invalid",
  "connector_backpressure",
  "connector_disconnected",
  "connector_offline",
  "connector_revoked",
  "heartbeat_timeout",
  "operator_disconnect",
  "socket_closed",
  "socket_error",
  "superseded",
]);

export interface PrivacySafeTelemetryEvent {
  kind: string;
  operation: string;
  outcome: "success" | "failure" | "rejected" | "degraded";
  status?: number;
  errorCode?: string;
  bucket?: string;
  durationMs?: number;
  count?: number;
  bytes?: number;
  limit?: number;
  attempts?: number;
  lagMs?: number;
  force?: boolean;
}

interface EmitOptions {
  random?: () => number;
  log?: (line: string) => void;
}

/**
 * Emits one bounded, content-free wide event. Callers may provide only fixed dimensions and
 * aggregate numbers: this contract intentionally has no id/path/user/request/prompt fields.
 */
export function emitTelemetry(
  env: RuntimeBindings,
  input: PrivacySafeTelemetryEvent,
  options: EmitOptions = {},
): boolean {
  const sampleRate = input.force || input.outcome === "failure" || input.outcome === "degraded"
    ? 1
    : input.outcome === "rejected"
      ? REJECTION_SAMPLE_RATE
      : successSampleRate(env.TELEMETRY_SUCCESS_SAMPLE_RATE);
  if ((options.random ?? Math.random)() >= sampleRate) return false;

  const event = {
    schema: TELEMETRY_SCHEMA,
    runtime: "edge",
    environment: fixedFromSet(env.DEPLOYMENT_ENVIRONMENT, FIXED_ENVIRONMENTS, "unknown"),
    kind: fixedFromSet(input.kind, FIXED_KINDS),
    operation: fixedFromSet(input.operation, FIXED_OPERATIONS),
    outcome: input.outcome,
    statusBucket: statusBucket(input.status),
    errorCode: fixedErrorCode(input.errorCode),
    bucket: fixedFromSet(input.bucket ?? "none", FIXED_BUCKETS, "none"),
    durationMs: bounded(input.durationMs),
    count: bounded(input.count),
    bytes: bounded(input.bytes),
    limit: bounded(input.limit),
    attempts: bounded(input.attempts),
    lagMs: bounded(input.lagMs),
    sampleRate,
  } as const;

  try {
    env.TELEMETRY?.writeDataPoint({
      indexes: [event.kind],
      blobs: [
        event.schema,
        event.runtime,
        event.environment,
        event.kind,
        event.operation,
        event.outcome,
        event.statusBucket,
        event.errorCode,
        event.bucket,
      ],
      doubles: [
        event.durationMs,
        event.count,
        event.bytes,
        event.limit,
        event.attempts,
        event.lagMs,
        event.sampleRate,
      ],
    });
  } catch {
    // Telemetry is never allowed to change request, connector, or Queue behavior.
  }
  if (env.DEPLOYMENT_ENVIRONMENT === "local" || options.log) {
    try {
      (options.log ?? console.log)(JSON.stringify(event));
    } catch {
      // Local logging is also best-effort and carries the same already-sanitized event.
    }
  }
  return true;
}

export function edgeOperation(request: Request): string {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") return "health";
  if (pathname === "/v1/connectors/socket") return "connector_socket";
  if (pathname.startsWith("/v1/release-rollouts")) return "rollout_api";
  if (pathname.startsWith("/v1/")) return "control_plane_api";
  if (pathname.startsWith("/internal/environments/")) return "connector_router";
  if (pathname.startsWith("/__dev/")) return "development_only";
  return "static_asset";
}

export function durableOperation(request: Request): string {
  const { pathname } = new URL(request.url);
  if (pathname === "/socket") return "socket";
  if (pathname === "/status") return "status";
  if (pathname === "/requests") return "request_dispatch";
  if (pathname.endsWith("/cancel")) return "request_cancel";
  if (pathname.startsWith("/requests/")) return "request_result";
  if (pathname === "/subscriptions") return "subscription_open";
  if (pathname.startsWith("/subscriptions/")) return request.method === "DELETE" ? "subscription_close" : "subscription_poll";
  if (pathname === "/revoke") return "connector_revoke";
  if (pathname === "/disconnect") return "connector_disconnect";
  return "unknown";
}

export function queueBucket(queueName: string): string {
  if (queueName.includes("connector-events")) return "connector_events";
  if (queueName.includes("dead-letter")) return "dead_letter";
  if (queueName.includes("background")) return "background";
  return "unknown";
}

export function lagBucket(lagMs: number): string {
  if (lagMs < 1_000) return "lt_1s";
  if (lagMs < 10_000) return "1s_10s";
  if (lagMs < 60_000) return "10s_60s";
  if (lagMs < 300_000) return "1m_5m";
  return "gte_5m";
}

function successSampleRate(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0.001, Math.min(1, parsed)) : DEFAULT_SUCCESS_SAMPLE_RATE;
}

function fixedFromSet(value: string, allowed: ReadonlySet<string>, fallback = "invalid"): string {
  return SAFE_DIMENSION.test(value) && allowed.has(value) ? value : fallback;
}

function fixedErrorCode(value: string | undefined): string {
  if (value === undefined) return "none";
  if (FIXED_ERROR_CODES.has(value)) return value;
  for (const [prefix, bucket] of [
    ["background_", "background_error"],
    ["connector_", "connector_error"],
    ["control_plane_", "control_plane_error"],
    ["rollout_", "rollout_error"],
  ] as const) {
    if (value.startsWith(prefix)) return bucket;
  }
  return "other";
}

function statusBucket(status: number | undefined): string {
  if (!Number.isInteger(status)) return "none";
  if (status! >= 500) return "5xx";
  if (status! >= 400) return "4xx";
  if (status! >= 300) return "3xx";
  if (status! >= 200) return "2xx";
  return "other";
}

function bounded(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(MAX_NUMBER, value!)) : 0;
}
