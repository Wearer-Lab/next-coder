import type { RuntimeBindings } from "./env";

export const TELEMETRY_SCHEMA = "next-coder.cloud-telemetry.v1";
const SAFE_DIMENSION = /^[a-z0-9][a-z0-9_.:-]{0,63}$/u;
const DEFAULT_SUCCESS_SAMPLE_RATE = 0.05;
const REJECTION_SAMPLE_RATE = 0.1;
const MAX_NUMBER = 86_400_000;
const FIXED_KINDS = new Set(["container_request"]);
const FIXED_ENVIRONMENTS = new Set(["local", "staging", "production"]);
const FIXED_OPERATIONS = new Set([
  "background", "connector_projection", "health", "internal_api", "public_api", "rejected",
  "rollout_api", "ticket_consume",
]);
const FIXED_BUCKETS = new Set([
  "not_started", "warm_lt_50ms", "candidate_50ms_1s", "candidate_1s_5s", "candidate_gte_5s",
]);
const FIXED_ERROR_CODES = new Set([
  "container_header_timeout",
  "container_startup_timeout",
  "container_startup_unavailable",
  "container_unavailable",
  "request_aborted",
  "route_rejected",
  "runtime_configuration",
  "runtime_failure",
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

export function emitTelemetry(
  env: RuntimeBindings,
  input: PrivacySafeTelemetryEvent,
  options: { random?: () => number; log?: (line: string) => void } = {},
): boolean {
  const sampleRate = input.force || input.outcome === "failure" || input.outcome === "degraded"
    ? 1
    : input.outcome === "rejected"
      ? REJECTION_SAMPLE_RATE
      : successSampleRate(env.TELEMETRY_SUCCESS_SAMPLE_RATE);
  if ((options.random ?? Math.random)() >= sampleRate) return false;
  const event = {
    schema: TELEMETRY_SCHEMA,
    runtime: "control_plane",
    environment: fixedFromSet(env.DEPLOYMENT_ENVIRONMENT, FIXED_ENVIRONMENTS, "unknown"),
    kind: fixedFromSet(input.kind, FIXED_KINDS),
    operation: fixedFromSet(input.operation, FIXED_OPERATIONS),
    outcome: input.outcome,
    statusBucket: statusBucket(input.status),
    errorCode: fixedErrorCode(input.errorCode),
    bucket: fixedFromSet(input.bucket ?? "not_started", FIXED_BUCKETS, "not_started"),
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
      blobs: [event.schema, event.runtime, event.environment, event.kind, event.operation, event.outcome,
        event.statusBucket, event.errorCode, event.bucket],
      doubles: [event.durationMs, event.count, event.bytes, event.limit, event.attempts, event.lagMs, event.sampleRate],
    });
  } catch {}
  if (env.DEPLOYMENT_ENVIRONMENT === "local" || options.log) {
    try { (options.log ?? console.log)(JSON.stringify(event)); } catch {}
  }
  return true;
}

export function controlPlaneOperation(request: Request, target: string): string {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/health") return "health";
  if (pathname.startsWith("/v1/release-rollouts")) return "rollout_api";
  if (pathname === "/v1/internal/background/run") return "background";
  if (pathname === "/v1/internal/connector-events") return "connector_projection";
  if (pathname === "/v1/internal/connectors/tickets/consume") return "ticket_consume";
  return ["public", "internal"].includes(target) ? `${target}_api` : "rejected";
}

export function startupBucket(durationMs: number): string {
  if (durationMs < 50) return "warm_lt_50ms";
  if (durationMs < 1_000) return "candidate_50ms_1s";
  if (durationMs < 5_000) return "candidate_1s_5s";
  return "candidate_gte_5s";
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
  return FIXED_ERROR_CODES.has(value) ? value : "other";
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
