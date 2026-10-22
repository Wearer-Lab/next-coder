import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { createConnectorInternalService } from "./connectorInternalService.mjs";
import { createCloudBackgroundWork } from "./cloudBackground.mjs";
import { createCloudflareConnectorRouter } from "./cloudflareConnectorRouter.mjs";
import { createRateLimiter, createRedisBackend } from "./rateLimit.mjs";
import { createRespClient } from "./resp.mjs";
import { createConfiguredStore } from "./storage.mjs";
import { ConnectorT3Transport, createT3TransportResolver } from "./t3Transport.mjs";

const DEFAULT_INTERNAL_PORT = 3998;

/**
 * Container-only Node adapter. The public gateway and connector capability
 * service share one Store but listen on different ports. The internal service
 * is deliberately never added to createApp's public route chain.
 */
export async function createContainerServers({ env = process.env, logger = console, t3TransportResolver = null } = {}) {
  const config = loadConfig(env);
  const deploymentEnvironment = env.DEPLOYMENT_ENVIRONMENT ?? "local";
  const internalHost = env.INTERNAL_HOST ?? "0.0.0.0";
  const internalPort = parsePort(env.INTERNAL_PORT, DEFAULT_INTERNAL_PORT, "INTERNAL_PORT");
  validateContainerConfig({ config, deploymentEnvironment, internalPort });

  const store = await createConfiguredStore(config);
  if (!store && deploymentEnvironment !== "local") {
    throw new Error("Cloud container startup requires the configured Convex Store.");
  }

  let rateLimiter;
  if (config.rateLimits?.redisUrl) {
    const client = createRespClient({ url: config.rateLimits.redisUrl });
    rateLimiter = createRateLimiter({ backend: createRedisBackend({ connect: async () => client }) });
    logger.info?.("container rate limiting uses the configured shared backend");
  } else {
    rateLimiter = createRateLimiter();
  }

  const cloudflareConnectorRouter = env.CONNECTOR_ROUTER_BASE_URL
    ? createCloudflareConnectorRouter({ baseUrl: env.CONNECTOR_ROUTER_BASE_URL })
    : null;
  const resolvedT3TransportResolver = t3TransportResolver ?? (cloudflareConnectorRouter
    ? createT3TransportResolver({
        connector: new ConnectorT3Transport(cloudflareConnectorRouter),
      })
    : null);
  const app = createApp({
    config,
    rateLimiter,
    ...(store ? { store } : {}),
    ...(resolvedT3TransportResolver ? { t3TransportResolver: resolvedT3TransportResolver } : {}),
    ...(cloudflareConnectorRouter ? { connectorRouter: cloudflareConnectorRouter } : {}),
  });
  const connectorInternal = createConnectorInternalService({
    store: app.store,
    notifications: app.notifications,
    ticketAudience: config.connectorTicketAudience,
  });
  const backgroundWork = createCloudBackgroundWork({
    mediaJobRunner: app.mediaJobRunner,
    mediaRetentionRunner: app.mediaRetentionRunner,
    environmentRetentionRunner: app.environmentRetentionRunner,
    snapshotPoller: app.snapshotPoller,
    connectorInternalService: connectorInternal,
    releaseRolloutRunner: app.releaseRolloutRunner,
    webPushDeliveryRunner: app.webPushDeliveryRunner,
    store: app.store,
    events: app.events,
    logger,
  });
  const internalServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://connector-capability.internal").pathname;
    const service = pathname === "/v1/internal/background/run" ? backgroundWork : connectorInternal;
    void handleInternalRequest(request, response, service, logger);
  });

  let started = false;
  async function start() {
    if (started) return;
    await Promise.all([
      listen(app.server, config.port, config.host),
      listen(internalServer, internalPort, internalHost),
    ]).catch(async (error) => {
      await Promise.allSettled([close(app.server), close(internalServer)]);
      throw error;
    });
    started = true;
    if (config.snapshotPollEnabled) app.snapshotPoller.start();
    if (config.threadStreamEnabled) app.threadStreams.start();
    if (config.transcriptionWorkerEnabled) app.mediaJobRunner.start();
    logger.info?.(`next-coder container ready on public port ${config.port} and private port ${internalPort}`);
  }

  async function stop() {
    if (!started) return;
    started = false;
    app.snapshotPoller.stop();
    app.threadStreams.stop();
    app.mediaJobRunner.stop();
    await Promise.allSettled([close(app.server), close(internalServer)]);
  }

  return {
    ...app,
    config,
    internalHost,
    internalPort,
    internalServer,
    backgroundWork,
    start,
    stop,
  };
}

export function validateContainerConfig({ config, deploymentEnvironment, internalPort }) {
  if (internalPort === config.port) throw new Error("INTERNAL_PORT must differ from PORT.");
  if (!['staging', 'production'].includes(deploymentEnvironment)) return;

  const missing = [];
  if (config.storageProvider !== "convex") missing.push("STORAGE_PROVIDER=convex");
  if (!config.convexUrl) missing.push("CONVEX_URL");
  if (!config.convexGatewaySecret) missing.push("GATEWAY_CONVEX_SECRET");
  if (config.dataFile) missing.push("DATA_FILE must be unset");
  if (config.authProvider !== "clerk") missing.push("AUTH_PROVIDER=clerk");
  if (!config.clerkSecretKey) missing.push("CLERK_SECRET_KEY");
  if (!config.clerkPublishableKey) missing.push("CLERK_PUBLISHABLE_KEY");
  if (!config.publicBaseUrl?.startsWith("https://")) missing.push("PUBLIC_BASE_URL=https://...");
  if (config.mediaStorageProvider !== "s3") missing.push("MEDIA_STORAGE_PROVIDER=s3");
  if (config.firmwareStorageProvider !== "s3") missing.push("FIRMWARE_STORAGE_PROVIDER=s3");
  if (!config.s3Endpoint) missing.push("S3_ENDPOINT");
  if (!config.s3Bucket) missing.push("S3_BUCKET");
  if (!config.firmwareS3Bucket) missing.push("FIRMWARE_S3_BUCKET");
  if (!config.s3AccessKeyId) missing.push("S3_ACCESS_KEY_ID");
  if (!config.s3SecretAccessKey) missing.push("S3_SECRET_ACCESS_KEY");
  if (!config.t3TokenEncryptionKey) missing.push("T3_TOKEN_ENCRYPTION_KEY");
  if (config.webPush?.supported !== true) missing.push("WEB_PUSH_VAPID_KEYS=valid");
  if (!config.webPushStorageEncryptionKeyConfigured) missing.push("WEB_PUSH_STORAGE_ENCRYPTION_KEY");
  if (!config.requireTls) missing.push("REQUIRE_TLS=1");
  if (config.devTokenCreationEnabled) missing.push("ENABLE_DEV_TOKENS=0");
  if (config.discoveryEnabled) missing.push("DISCOVERY_ENABLED=0");
  validateTimerReplacement(missing, {
    timerEnabled: config.snapshotPollEnabled,
    consumerEnabled: config.cloudSnapshotConsumerEnabled,
    timerName: "SNAPSHOT_POLL_ENABLED",
    consumerName: "CLOUD_SNAPSHOT_CONSUMER_ENABLED",
  });
  validateTimerReplacement(missing, {
    timerEnabled: config.threadStreamEnabled,
    consumerEnabled: config.cloudThreadStreamConsumerEnabled,
    timerName: "THREAD_STREAM_ENABLED",
    consumerName: "CLOUD_THREAD_STREAM_CONSUMER_ENABLED",
  });
  validateTimerReplacement(missing, {
    timerEnabled: config.transcriptionWorkerEnabled,
    consumerEnabled: config.cloudMediaConsumerEnabled,
    timerName: "TRANSCRIPTION_WORKER_ENABLED",
    consumerName: "CLOUD_MEDIA_CONSUMER_ENABLED",
  });
  if (missing.length > 0) {
    throw new Error(`Invalid ${deploymentEnvironment} container configuration: ${missing.join(", ")}.`);
  }
}

function validateTimerReplacement(missing, { timerEnabled, consumerEnabled, timerName, consumerName }) {
  if (timerEnabled && consumerEnabled) missing.push(`${timerName}=0 when ${consumerName}=1`);
  if (!timerEnabled && !consumerEnabled) missing.push(`${consumerName}=1 or ${timerName}=1`);
}

async function handleInternalRequest(nodeRequest, nodeResponse, service, logger) {
  try {
    const request = toWebRequest(nodeRequest);
    const response = await service.fetch(request);
    await writeWebResponse(nodeResponse, response);
  } catch (error) {
    logger.error?.("connector capability service request failed", safeError(error));
    if (!nodeResponse.headersSent) {
      nodeResponse.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
    }
    nodeResponse.end(JSON.stringify({ error: "internal_service_failure" }));
  }
}

function toWebRequest(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method ?? "GET";
  return new Request(`http://connector-capability.internal${request.url ?? "/"}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: Readable.toWeb(request), duplex: "half" }),
  });
}

async function writeWebResponse(response, webResponse) {
  const headers = {};
  for (const [name, value] of webResponse.headers) headers[name] = value;
  response.writeHead(webResponse.status, headers);
  if (!webResponse.body) {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const readable = Readable.fromWeb(webResponse.body);
    readable.once("error", reject);
    response.once("error", reject);
    response.once("finish", resolve);
    readable.pipe(response);
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    // SSE responses have no natural end. Drain the listeners, then close their sockets so a
    // deployment SIGTERM cannot leave a live process with both gateway ports already closed.
    server.closeAllConnections();
  });
}

function parsePort(value, fallback, name) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${name} must be a valid TCP port.`);
  return parsed;
}

function safeError(error) {
  return { name: error instanceof Error ? error.name : "Error", message: "internal service failure" };
}

async function main() {
  const runtime = await createContainerServers();
  await runtime.start();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.stop();
    process.exitCode = 0;
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
