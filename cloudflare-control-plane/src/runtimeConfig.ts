import type { RuntimeBindings } from "./env";

const REQUIRED_CLOUD_VALUES = [
  "PUBLIC_BASE_URL",
  "CONVEX_URL",
  "GATEWAY_CONVEX_SECRET",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
  "T3_TOKEN_ENCRYPTION_KEY",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "FIRMWARE_S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "WEB_PUSH_VAPID_KEYS",
  "WEB_PUSH_STORAGE_ENCRYPTION_KEY",
] as const;

export interface ResolvedRuntimeConfig {
  startupTimeoutMs: number;
  responseHeaderTimeoutMs: number;
  containerEnv: Record<string, string>;
}

export class RuntimeConfigurationError extends Error {
  readonly code = "control_plane_runtime_unconfigured";

  constructor(readonly missing: string[]) {
    super(missing.length > 0
      ? `Required control-plane bindings are missing: ${missing.join(", ")}.`
      : "Control-plane runtime configuration is invalid.");
    this.name = "RuntimeConfigurationError";
  }
}

export function resolveRuntimeConfig(env: RuntimeBindings): ResolvedRuntimeConfig {
  const cloud = env.DEPLOYMENT_ENVIRONMENT === "staging" || env.DEPLOYMENT_ENVIRONMENT === "production";
  const missing: string[] = cloud
    ? REQUIRED_CLOUD_VALUES.filter((name) => !nonEmpty(env[name]))
    : [];
  if (cloud && !env.CONNECTOR_ROUTER) missing.push("CONNECTOR_ROUTER");
  if (missing.length > 0) throw new RuntimeConfigurationError([...missing]);
  if (cloud && !env.PUBLIC_BASE_URL?.startsWith("https://")) {
    throw new RuntimeConfigurationError(["PUBLIC_BASE_URL=https://..."]);
  }

  const containerEnv: Record<string, string> = {
    NODE_ENV: cloud ? "production" : "development",
    DEPLOYMENT_ENVIRONMENT: env.DEPLOYMENT_ENVIRONMENT,
    HOST: "0.0.0.0",
    PORT: "3996",
    INTERNAL_HOST: "0.0.0.0",
    INTERNAL_PORT: "3998",
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8787",
    CONNECTOR_TICKET_AUDIENCE: env.CONNECTOR_TICKET_AUDIENCE ?? "agent-controller-connectors",
    STORAGE_PROVIDER: cloud ? "convex" : "memory",
    AUTH_PROVIDER: cloud ? "clerk" : "dev",
    MEDIA_STORAGE_PROVIDER: cloud ? "s3" : "disk",
    FIRMWARE_STORAGE_PROVIDER: cloud ? "s3" : "disk",
    S3_REGION: "auto",
    REQUIRE_TLS: cloud ? "1" : "0",
    ENABLE_DEV_TOKENS: cloud ? "0" : "1",
    DEMO_MODE: "0",
    DEPLOYMENT_MODE: cloud ? "cloud" : "self-hosted",
    DISCOVERY_ENABLED: "0",
    CONNECTOR_ROUTER_BASE_URL: "http://connector-router.internal",
    SNAPSHOT_POLL_ENABLED: "0",
    // This explicit Node Container adapter owns the leased stream hub and its cleanup tick.
    // There is no platform thread-stream consumer yet: claiming one leaves watches idle forever.
    THREAD_STREAM_ENABLED: "1",
    TRANSCRIPTION_WORKER_ENABLED: "0",
    WEB_PUSH_WORKER_ENABLED: "0",
    CLOUD_SNAPSHOT_CONSUMER_ENABLED: "1",
    CLOUD_THREAD_STREAM_CONSUMER_ENABLED: "0",
    CLOUD_MEDIA_CONSUMER_ENABLED: "1",
  };

  copyDefined(containerEnv, env, [
    "CONVEX_URL",
    "GATEWAY_CONVEX_SECRET",
    "CLERK_SECRET_KEY",
    "CLERK_PUBLISHABLE_KEY",
    "CLERK_AUTHORIZED_PARTIES",
    "CLERK_JWT_ISSUER_DOMAIN",
    "T3_TOKEN_ENCRYPTION_KEY",
    "MEDIA_SIGNING_KEY",
    "FIRMWARE_DOWNLOAD_SIGNING_KEY",
    "BILLING_WEBHOOK_SECRET",
    "FACTORY_TOKEN",
    "OTA_SIGNING_KEY",
    "RATE_LIMIT_REDIS_URL",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "FIRMWARE_S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_SESSION_TOKEN",
    "GATEWAY_TLS_ROOT_CA_PEM",
    "GATEWAY_TLS_NEXT_ROOT_CA_PEM",
    "WEB_PUSH_VAPID_KEYS",
    "WEB_PUSH_VAPID_KEY_ID",
    "WEB_PUSH_VAPID_PUBLIC_KEY",
    "WEB_PUSH_VAPID_PRIVATE_KEY",
    "WEB_PUSH_VAPID_SUBJECT",
    "WEB_PUSH_ALLOWED_HOSTS",
    "WEB_PUSH_STORAGE_ENCRYPTION_KEY",
  ]);

  return {
    containerEnv,
    startupTimeoutMs: boundedMs(env.CONTAINER_STARTUP_TIMEOUT_MS, 20_000, 1_000, 60_000),
    responseHeaderTimeoutMs: boundedMs(env.CONTAINER_RESPONSE_HEADER_TIMEOUT_MS, 30_000, 1_000, 120_000),
  };
}

function copyDefined(
  target: Record<string, string>,
  source: RuntimeBindings,
  names: Array<keyof RuntimeBindings>,
): void {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) target[String(name)] = value;
  }
}

function boundedMs(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
