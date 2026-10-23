import { loadAlertThresholds } from "./alerts.mjs";
import { loadRateLimitConfig } from "./rateLimit.mjs";
import { loadWebPushConfig } from "./webPush.mjs";
import {
  PARAKEET_ACCEPTED_CONTENT_TYPES,
  PARAKEET_DEFAULT_CONCURRENCY,
  PARAKEET_DEFAULT_MAX_CLIP_SECONDS,
  PARAKEET_DEFAULT_MODEL,
  PARAKEET_DEFAULT_TIMEOUT_MS,
  PARAKEET_DEFAULT_URL,
  TRANSCRIPTION_PROVIDERS,
} from "./transcription.mjs";

export function loadConfig(env = process.env) {
  const authProvider = env.AUTH_PROVIDER ?? (env.CLERK_SECRET_KEY ? "clerk" : "dev");
  const demoMode = env.DEMO_MODE === "1";
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number.parseInt(env.PORT ?? "3996", 10),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? null,
    deploymentMode: env.DEPLOYMENT_MODE === "cloud" ? "cloud" : "self-hosted",
    dataFile: env.DATA_FILE ?? null,
    mediaDir: env.MEDIA_DIR ?? ".data/media",
    maxMediaBytes: Number.parseInt(env.MAX_MEDIA_BYTES ?? String(2 * 1024 * 1024), 10),
    maxOwnerMediaBytes: normalizePositiveInt(env.MAX_OWNER_MEDIA_BYTES, 64 * 1024 * 1024),
    maxImageDimension: normalizePositiveInt(env.MAX_IMAGE_DIMENSION, 8192),
    maxImagePixels: normalizePositiveInt(env.MAX_IMAGE_PIXELS, 40_000_000),
    maxAudioDurationSeconds: normalizePositiveInt(env.MAX_AUDIO_DURATION_SECONDS, 300),
    maxAudioSampleRate: normalizePositiveInt(env.MAX_AUDIO_SAMPLE_RATE, 96_000),
    maxAudioChannels: normalizePositiveInt(env.MAX_AUDIO_CHANNELS, 2),
    mediaUploadSessionTtlMs: normalizePositiveInt(env.MEDIA_UPLOAD_SESSION_TTL_MS, 15 * 60 * 1000),
    defaultMediaRetentionDays: normalizeRetentionDays(env.DEFAULT_MEDIA_RETENTION_DAYS, 30),
    environmentRetentionDays: normalizeRetentionDays(env.ENVIRONMENT_RETENTION_DAYS, 30) ?? 30,
    mediaSigningKey: env.MEDIA_SIGNING_KEY
      ?? env.T3_TOKEN_ENCRYPTION_KEY
      ?? env.GATEWAY_TOKEN_ENCRYPTION_KEY
      ?? env.GATEWAY_CONVEX_SECRET
      ?? null,
    mediaLinkTtlSeconds: normalizePositiveInt(env.MEDIA_LINK_TTL_SECONDS, 900),
    mediaStorageProvider: env.MEDIA_STORAGE_PROVIDER === "s3" ? "s3" : "disk",
    s3Endpoint: env.S3_ENDPOINT ?? null,
    s3Region: env.S3_REGION ?? "us-east-1",
    s3Bucket: env.S3_BUCKET ?? null,
    s3AccessKeyId: env.S3_ACCESS_KEY_ID ?? null,
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY ?? null,
    s3SessionToken: env.S3_SESSION_TOKEN ?? null,
    // Tri-state on purpose: unset lets the client auto-detect (MinIO/R2 need path style,
    // AWS does not). Coercing this to false would break non-AWS endpoints.
    s3ForcePathStyle: normalizeOptionalBoolean(env.S3_FORCE_PATH_STYLE),
    s3TimeoutMs: normalizePositiveInt(env.S3_TIMEOUT_MS, 15_000),
    firmwareStorageProvider: env.FIRMWARE_STORAGE_PROVIDER === "s3" ? "s3" : "disk",
    firmwareDir: env.FIRMWARE_DIR ?? ".data/firmware",
    firmwareS3Bucket: env.FIRMWARE_S3_BUCKET ?? env.S3_BUCKET ?? null,
    firmwareS3Prefix: (env.FIRMWARE_S3_PREFIX ?? "firmware").replace(/^\/+|\/+$/gu, "") || "firmware",
    maxFirmwareBytes: normalizePositiveInt(env.MAX_FIRMWARE_BYTES, 16 * 1024 * 1024),
    firmwareDownloadSigningKey: env.FIRMWARE_DOWNLOAD_SIGNING_KEY ?? null,
    firmwareDownloadTtlSeconds: normalizePositiveInt(env.FIRMWARE_DOWNLOAD_TTL_SECONDS, 600),
    mediaInlineMaxBytes: normalizePositiveInt(env.MEDIA_INLINE_MAX_BYTES, 256 * 1024),
    transcriptionProvider: normalizeTranscriptionProvider(env.TRANSCRIPTION_PROVIDER),
    transcriptionUrl: env.TRANSCRIPTION_URL ?? null,
    transcriptionApiKey: env.TRANSCRIPTION_API_KEY ?? null,
    transcriptionModel: env.TRANSCRIPTION_MODEL ?? "whisper-1",
    transcriptionTimeoutMs: normalizePositiveInt(env.TRANSCRIPTION_TIMEOUT_MS, 30_000),
    transcriptionLanguage: env.TRANSCRIPTION_LANGUAGE ?? null,
    // Transcription runs as a durable job, not inside the request. These govern the worker.
    transcriptionWorkerEnabled: normalizeBoolean(env.TRANSCRIPTION_WORKER_ENABLED, true),
    transcriptionWorkerIntervalMs: normalizePositiveInt(env.TRANSCRIPTION_WORKER_INTERVAL_MS, 2000),
    transcriptionBatchSize: normalizePositiveInt(env.TRANSCRIPTION_BATCH_SIZE, 4),
    // The lease has to outlast one provider call, or a slow transcription gets picked up a second
    // time while the first is still running.
    transcriptionLeaseMs: normalizePositiveInt(env.TRANSCRIPTION_LEASE_MS, 60_000),
    transcriptionMaxAttempts: normalizePositiveInt(env.TRANSCRIPTION_MAX_ATTEMPTS, 3),
    // When set, a finished transcript parks at `review_required` until a person accepts or edits
    // it, instead of being written straight onto the media record.
    transcriptionReviewRequired: normalizeBoolean(env.TRANSCRIPTION_REVIEW_REQUIRED, false),
    // Cloud consumers replace process timers one-for-one. Keeping these separate makes a partial
    // rollout fail closed instead of disabling every local runner because one Queue exists.
    cloudMediaQueueUrl: env.CLOUD_MEDIA_QUEUE_URL ?? null,
    cloudMediaConsumerEnabled: normalizeBoolean(env.CLOUD_MEDIA_CONSUMER_ENABLED, false),
    cloudSnapshotConsumerEnabled: normalizeBoolean(env.CLOUD_SNAPSHOT_CONSUMER_ENABLED, false),
    cloudThreadStreamConsumerEnabled: normalizeBoolean(env.CLOUD_THREAD_STREAM_CONSUMER_ENABLED, false),
    cloudConnectorEventConsumerEnabled: normalizeBoolean(env.CLOUD_CONNECTOR_EVENT_CONSUMER_ENABLED, false),
    cloudRetentionConsumerEnabled: normalizeBoolean(env.CLOUD_RETENTION_CONSUMER_ENABLED, false),
    webPush: loadWebPushConfig(env),
    webPushEncryptionKey: env.WEB_PUSH_STORAGE_ENCRYPTION_KEY
      ?? env.T3_TOKEN_ENCRYPTION_KEY
      ?? env.GATEWAY_TOKEN_ENCRYPTION_KEY
      ?? env.GATEWAY_CONVEX_SECRET
      ?? null,
    webPushStorageEncryptionKeyConfigured: typeof env.WEB_PUSH_STORAGE_ENCRYPTION_KEY === "string"
      && env.WEB_PUSH_STORAGE_ENCRYPTION_KEY.length > 0,
    webPushWorkerEnabled: normalizeBoolean(env.WEB_PUSH_WORKER_ENABLED, true),
    webPushWorkerIntervalMs: normalizePositiveInt(env.WEB_PUSH_WORKER_INTERVAL_MS, 2_000),
    // Parakeet is a local ASR sidecar, not a hosted API, so it gets its own settings rather than
    // borrowing the TRANSCRIPTION_* ones: the defaults differ in kind. A CPU box is slow, so the
    // timeout is minutes rather than seconds, the model is a checkpoint name rather than a whisper
    // id, and there is a clip ceiling because inference cost scales with audio length.
    parakeetUrl: env.PARAKEET_URL ?? PARAKEET_DEFAULT_URL,
    parakeetModel: env.PARAKEET_MODEL ?? PARAKEET_DEFAULT_MODEL,
    // Optional: only needed when the sidecar sits behind an authenticated hop.
    parakeetApiKey: env.PARAKEET_API_KEY ?? null,
    parakeetTimeoutMs: normalizePositiveInt(env.PARAKEET_TIMEOUT_MS, PARAKEET_DEFAULT_TIMEOUT_MS),
    parakeetMaxClipSeconds: normalizePositiveInt(
      env.PARAKEET_MAX_CLIP_SECONDS,
      PARAKEET_DEFAULT_MAX_CLIP_SECONDS,
    ),
    // v2 is an English model. A different language means a different checkpoint, not this one
    // trying harder — the adapter refuses the mismatch rather than returning poor English.
    parakeetLanguage: env.PARAKEET_LANGUAGE ?? env.TRANSCRIPTION_LANGUAGE ?? "en",
    // How many clips may be inside the sidecar at once. One model in memory on a CPU is one clip;
    // a GPU box can raise it.
    parakeetConcurrency: normalizePositiveInt(env.PARAKEET_CONCURRENCY, PARAKEET_DEFAULT_CONCURRENCY),
    parakeetAcceptedContentTypes: parseCsv(env.PARAKEET_ACCEPTED_CONTENT_TYPES)
      ?? PARAKEET_ACCEPTED_CONTENT_TYPES,
    visionProvider: normalizeVisionProvider(env.VISION_PROVIDER),
    visionUrl: env.VISION_URL ?? null,
    visionApiKey: env.VISION_API_KEY ?? null,
    visionModel: env.VISION_MODEL ?? "gpt-4o-mini",
    visionTimeoutMs: normalizePositiveInt(env.VISION_TIMEOUT_MS, 30_000),
    visionMaxTokens: normalizePositiveInt(env.VISION_MAX_TOKENS, 600),
    visionPrompt: env.VISION_PROMPT ?? null,
    factoryToken: env.FACTORY_TOKEN ?? null,
    // Phase 4 "TLS only": refuse to issue or accept device credentials in cleartext.
    // Loopback is always exempt so local development and the simulator still work.
    requireTls: normalizeBoolean(env.REQUIRE_TLS, false),
    gatewayTlsRootCaPem: normalizePem(env.GATEWAY_TLS_ROOT_CA_PEM),
    gatewayTlsNextRootCaPem: normalizePem(env.GATEWAY_TLS_NEXT_ROOT_CA_PEM),
    billingWebhookSecret: env.BILLING_WEBHOOK_SECRET ?? null,
    // Plan limits and tier-based policy are inert until an operator turns billing on. Otherwise
    // every existing deployment would silently drop to the free tier's 0-device, no-shell limits.
    billingEnforced: normalizeBoolean(env.BILLING_ENFORCED, false),
    otaSigningKey: env.OTA_SIGNING_KEY ?? null,
    // Shown to a controller during LAN discovery so two gateways on one network are tellable
    // apart. Defaults to the machine's hostname, which is what a person already calls it.
    discoveryName: env.DISCOVERY_NAME ?? null,
    // Discovery answers a broadcast from anything on the LAN, so it is opt-out for anyone who
    // does not want that on their network. On by default: the whole point is that setup works
    // without configuration.
    discoveryEnabled: env.DISCOVERY_ENABLED !== "0",
    defaultHardwareModel: env.DEFAULT_HARDWARE_MODEL ?? "e213-esp32-s3r8",
    authProvider,
    devTokenCreationEnabled: normalizeBoolean(env.ENABLE_DEV_TOKENS, authProvider === "dev" || demoMode),
    clerkSecretKey: env.CLERK_SECRET_KEY ?? null,
    clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY ?? env.VITE_CLERK_PUBLISHABLE_KEY ?? null,
    clerkAuthorizedParties: parseCsv(env.CLERK_AUTHORIZED_PARTIES),
    storageProvider: env.STORAGE_PROVIDER ?? "file",
    convexUrl: env.CONVEX_URL ?? null,
    convexDeployment: env.CONVEX_DEPLOYMENT ?? null,
    convexGatewaySecret: env.GATEWAY_CONVEX_SECRET ?? null,
    connectorTicketAudience: env.CONNECTOR_TICKET_AUDIENCE ?? "agent-controller-connectors",
    t3TokenEncryptionKey: env.T3_TOKEN_ENCRYPTION_KEY ?? env.GATEWAY_TOKEN_ENCRYPTION_KEY ?? null,
    clerkJwtIssuerDomain: env.CLERK_JWT_ISSUER_DOMAIN ?? null,
    // Only classify request origin when the operator has actually declared trusted ranges.
    // An unconfigured list stays undefined so the network_location policy dimension is inert.
    trustedNetworks: parseCsv(env.TRUSTED_NETWORKS),
    policyAllowedHours: parseAllowedHours(env.POLICY_ALLOWED_HOURS),
    snapshotPollEnabled: normalizeBoolean(env.SNAPSHOT_POLL_ENABLED, true),
    snapshotPollIntervalMs: normalizePositiveInt(env.SNAPSHOT_POLL_INTERVAL_MS, 5000),
    // The live thread stream (src/threadStream.mjs). The tick is only a scheduler: it opens,
    // closes and reconnects subscriptions, it never fetches, so a short interval is cheap and
    // is what makes a watch feel immediate.
    threadStreamEnabled: normalizeBoolean(env.THREAD_STREAM_ENABLED, true),
    threadStreamIntervalMs: normalizePositiveInt(env.THREAD_STREAM_INTERVAL_MS, 1000),
    // A watch is a lease. Long enough that a console renewing every 30s never flaps, short
    // enough that a browser that simply vanished stops costing a socket within the minute.
    threadStreamWatchTtlMs: normalizePositiveInt(env.THREAD_STREAM_WATCH_TTL_MS, 90_000),
    alertThresholds: loadAlertThresholds(env),
    rateLimits: loadRateLimitConfig(env),
    demoMode,
  };
}

function normalizeTranscriptionProvider(value) {
  if (!value) return "disabled";
  const provider = String(value).trim().toLowerCase();
  // An unrecognised name degrades to "disabled" rather than throwing, so the list is read from
  // the adapters themselves: a provider that exists but is missing here is a silent 409 later.
  return TRANSCRIPTION_PROVIDERS.includes(provider) ? provider : "disabled";
}

function normalizeOptionalBoolean(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function normalizeVisionProvider(value) {
  if (!value) return "disabled";
  const provider = String(value).trim().toLowerCase();
  return ["disabled", "mock", "openai"].includes(provider) ? provider : "disabled";
}

function normalizePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizePem(value) {
  if (!value) return "";
  // `.env` files commonly carry a PEM on one line with escaped newlines. Convert those before
  // manufacturing's C-string encoder escapes the real line breaks for controller_config.h.
  return String(value).replaceAll("\\n", "\n");
}

function normalizeRetentionDays(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (String(value).toLowerCase() === "never") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : fallback;
}

// Accepts "9-18" or a JSON window object/array understood by the policy engine.
function parseAllowedHours(value) {
  if (!value) return null;
  const text = String(value).trim();
  const range = text.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/u);
  if (range) {
    const start = Number.parseInt(range[1], 10);
    const end = Number.parseInt(range[2], 10);
    if (start >= 0 && start <= 24 && end >= 0 && end <= 24) return [start, end];
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parseCsv(value) {
  if (!value) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
