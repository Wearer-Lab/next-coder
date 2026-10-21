import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { createRateLimiter, createRedisBackend } from "./rateLimit.mjs";
import { createRespClient } from "./resp.mjs";
import { createDiscoveryResponder } from "./discovery.mjs";
import { createConfiguredStore } from "./storage.mjs";

const config = loadConfig();
const store = await createConfiguredStore(config);

// Without a shared backend each process enforces its own window, so N instances allow N times
// the configured limit.
let rateLimiter;
if (config.rateLimits?.redisUrl) {
  const client = createRespClient({ url: config.rateLimits.redisUrl });
  rateLimiter = createRateLimiter({
    backend: createRedisBackend({ connect: async () => client }),
  });
  console.log(`rate limiting shared via ${config.rateLimits.redisUrl}`);
} else {
  rateLimiter = createRateLimiter();
}

const { server, snapshotPoller, threadStreams, mediaJobRunner, releaseRolloutRunner, webPushDeliveryRunner } = createApp({
  config,
  rateLimiter,
  ...(store ? { store } : {}),
});

server.listen(config.port, config.host, async () => {
  console.log(`next-coder listening on http://${config.host}:${config.port}`);

  // Started here rather than in createApp() so tests stay hermetic: binding a fixed UDP port in
  // every test process would collide, and discovery is a deployment concern, not an app one.
  if (config.discoveryEnabled) {
    const responder = createDiscoveryResponder({ config });
    await responder.start();
    process.on("SIGTERM", () => responder.stop());
    process.on("SIGINT", () => responder.stop());
  }
  if (config.snapshotPollEnabled) {
    snapshotPoller.start();
    console.log(`T3 snapshot poller running every ${config.snapshotPollIntervalMs}ms`);
  }
  // Same reasoning as the poller: started here, not in createApp(), so no test opens a socket to
  // T3 it did not ask for.
  if (config.threadStreamEnabled) {
    threadStreams.start();
    console.log(
      `T3 live thread streams scheduling every ${config.threadStreamIntervalMs}ms`
      + ` (watch lease ${config.threadStreamWatchTtlMs}ms)`,
    );
  }
  // Same reasoning as the poller: started here, not in createApp(), so tests never race a timer.
  if (config.transcriptionWorkerEnabled) {
    mediaJobRunner.start();
    console.log(
      `media job worker ${mediaJobRunner.workerId} running every ${config.transcriptionWorkerIntervalMs}ms`
      + ` (transcription provider: ${config.transcriptionProvider})`,
    );
  }
  // Rollout reconciliation is idempotent and only observes cohorts explicitly started by an
  // owner. The local adapter uses a timer; Cloudflare invokes the same runner from Queue/Cron.
  releaseRolloutRunner.start();
  console.log("release rollout reconciler running every 30000ms");
  if (config.webPushWorkerEnabled && config.webPush.supported) {
    webPushDeliveryRunner.start();
    console.log(`Web Push delivery worker running every ${config.webPushWorkerIntervalMs}ms`);
  }
});
