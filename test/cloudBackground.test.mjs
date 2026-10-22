import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createCloudBackgroundWork } from "../src/cloudBackground.mjs";
import { createContainerServers, validateContainerConfig } from "../src/containerServer.mjs";
import { createStore } from "../src/store.mjs";

test("queue, workflow, and cron adapters share deterministic runOnce domain hooks", async () => {
  const calls = [];
  const work = createCloudBackgroundWork({
    mediaJobRunner: { runOnce: async () => (calls.push("media"), { processed: [] }) },
    mediaRetentionRunner: { runOnce: async (input) => (calls.push(["retention", input]), { count: 0 }) },
    environmentRetentionRunner: { runOnce: async (input) => (calls.push(["environment-retention", input]), { count: 0 }) },
    snapshotPoller: { runOnce: async (input) => (calls.push(["snapshot", input]), { polled: [] }) },
    connectorInternalService: { fetch: async () => Response.json({ accepted: true }, { status: 202 }) },
    logger: { warn() {} },
  });

  const workflow = await work.handleWorkflowEvent({ payload: {
    version: 1, taskId: "workflow_1", kind: "snapshot.reconcile", payload: { userIds: ["u1", "u1", "u2"] },
  } });
  assert.equal(workflow.taskId, "workflow_1");
  assert.deepEqual(calls.at(-1), ["snapshot", { userIds: ["u1", "u2"] }]);

  const acked = [];
  const retried = [];
  const queue = await work.handleQueueBatch({ messages: [{
    id: "queue_1",
    body: { version: 1, kind: "media.retention", payload: { userId: "u1" } },
    ack: () => acked.push("queue_1"),
    retry: () => retried.push("queue_1"),
  }] });
  assert.equal(queue.outcomes[0].status, "acked");
  assert.deepEqual(acked, ["queue_1"]);
  assert.deepEqual(retried, []);

  await work.runOnce({ version: 1, kind: "environment.retention", payload: { userId: "u1" } });
  assert.deepEqual(calls.at(-1), ["environment-retention", { userId: "u1" }]);

  const cron = await work.handleScheduledTick({ tasks: [
    { version: 1, kind: "media.process", payload: {} },
  ] });
  assert.equal(cron.skipped, false);
  assert.deepEqual(calls.at(-1), "media");
});

test("the queued cron heartbeat durably proves scheduler-to-container liveness", async () => {
  const store = createStore();
  const broadcasts = [];
  const work = createCloudBackgroundWork({
    store,
    events: { broadcastToAll: (type, payload) => broadcasts.push({ type, payload }) },
  });
  const result = await work.runOnce({
    version: 1,
    taskId: "cron:1234:heartbeat",
    kind: "scheduler.heartbeat",
    payload: { scheduledAt: 1234 },
  });
  assert.equal(result.result.recorded, true);
  assert.equal(store.getBackgroundLiveness("scheduled-worker").lastSuccessAt, "1970-01-01T00:00:01.234Z");
  assert.equal(broadcasts[0].type, "background.liveness.changed");
  assert.equal(broadcasts[0].payload.scheduledWorker.status, "stale");

  const actions = [];
  const unavailable = createCloudBackgroundWork({
    store: {
      recordBackgroundLiveness: async () => {
        throw Object.assign(new Error("storage unavailable"), { code: "storage_unavailable" });
      },
    },
    logger: { warn() {} },
  });
  const failed = await unavailable.handleQueueBatch({ messages: [{
    id: "heartbeat_failed",
    body: { version: 1, kind: "scheduler.heartbeat", payload: { scheduledAt: 1234 } },
    ack: () => actions.push("ack"),
    retry: () => actions.push("retry"),
  }] });
  assert.deepEqual(actions, ["retry"]);
  assert.equal(failed.outcomes[0].failure.code, "storage_unavailable");
});

test("queue adapter retries transient failures and acknowledges terminal malformed work", async () => {
  const actions = [];
  const work = createCloudBackgroundWork({
    mediaJobRunner: { runOnce: async () => { throw Object.assign(new Error("provider outage"), { code: "provider_outage" }); } },
    logger: { warn() {} },
  });
  const result = await work.handleQueueBatch({ messages: [
    {
      id: "transient",
      body: { version: 1, kind: "media.process", payload: {} },
      ack: () => actions.push("ack-transient"),
      retry: () => actions.push("retry-transient"),
    },
    {
      id: "invalid",
      body: { version: 99, kind: "unknown", payload: {} },
      ack: () => actions.push("ack-invalid"),
      retry: () => actions.push("retry-invalid"),
    },
  ] });
  assert.deepEqual(actions, ["retry-transient", "ack-invalid"]);
  assert.deepEqual(result.outcomes.map((entry) => entry.status), ["retried", "rejected"]);
  assert.equal(result.outcomes[0].failure.retryable, true);
  assert.equal(result.outcomes[1].failure.terminal, true);
});

test("maintenance targeting pages durable users in stable bounded order", async () => {
  const store = createStore();
  for (let index = 100; index >= 0; index -= 1) {
    store.ensureUser({ userId: `user_${String(index).padStart(3, "0")}` });
  }
  const work = createCloudBackgroundWork({ store });
  const first = await work.runOnce({
    version: 1,
    taskId: "targets_1",
    kind: "maintenance.targets",
    payload: { cursor: null },
  });
  assert.equal(first.result.userIds.length, 100);
  assert.equal(first.result.userIds[0], "user_000");
  assert.equal(first.result.nextCursor, "user_099");

  const second = await work.runOnce({
    version: 1,
    taskId: "targets_2",
    kind: "maintenance.targets",
    payload: { cursor: first.result.nextCursor },
  });
  assert.deepEqual(second.result, { userIds: ["user_100"], nextCursor: null });
});

test("private background Fetcher exposes bounded service-binding work without a bearer fallback", async () => {
  const work = createCloudBackgroundWork({
    mediaJobRunner: { runOnce: async () => ({ processed: [{ jobId: "job_1", stage: "dispatched" }] }) },
  });
  const response = await work.fetch(new Request("https://background.internal/v1/internal/background/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, taskId: "task_1", kind: "media.process", payload: {} }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    version: 1,
    taskId: "task_1",
    kind: "media.process",
    result: { processed: [{ jobId: "job_1", stage: "dispatched" }] },
  });
});

test("the public app does not expose the background capability endpoint", async (t) => {
  const { server } = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/internal/background/run`, {
    method: "POST",
    headers: { authorization: "Bearer public-token", "content-type": "application/json" },
    body: JSON.stringify({ version: 1, kind: "media.process", payload: {} }),
  });
  assert.equal(response.status, 404);
  await response.arrayBuffer();
});

test("container starts process runners when no cloud replacement owns them", async (t) => {
  const internalPort = await freePort();
  const runtime = await createContainerServers({
    env: {
      DEPLOYMENT_ENVIRONMENT: "local",
      HOST: "127.0.0.1",
      PORT: "0",
      INTERNAL_HOST: "127.0.0.1",
      INTERNAL_PORT: String(internalPort),
      STORAGE_PROVIDER: "memory",
      AUTH_PROVIDER: "dev",
      ENABLE_DEV_TOKENS: "1",
      DISCOVERY_ENABLED: "0",
      SNAPSHOT_POLL_ENABLED: "1",
      THREAD_STREAM_ENABLED: "1",
      TRANSCRIPTION_WORKER_ENABLED: "1",
    },
    logger: { info() {}, error() {} },
  });
  t.after(() => runtime.stop());
  const lifecycle = [];
  runtime.snapshotPoller.start = () => lifecycle.push("snapshot.start");
  runtime.snapshotPoller.stop = () => lifecycle.push("snapshot.stop");
  runtime.threadStreams.start = () => lifecycle.push("streams.start");
  runtime.threadStreams.stop = () => lifecycle.push("streams.stop");
  runtime.mediaJobRunner.start = () => lifecycle.push("media.start");
  runtime.mediaJobRunner.stop = () => lifecycle.push("media.stop");
  await runtime.start();
  assert.deepEqual(lifecycle, ["snapshot.start", "streams.start", "media.start"]);
  await runtime.stop();
  assert.deepEqual(lifecycle, [
    "snapshot.start", "streams.start", "media.start",
    "snapshot.stop", "streams.stop", "media.stop",
  ]);
});

test("production container timers require exactly one process or cloud consumer owner", () => {
  const base = productionConfig();
  assert.doesNotThrow(() => validateContainerConfig({
    config: {
      ...base,
      snapshotPollEnabled: true,
      threadStreamEnabled: true,
      transcriptionWorkerEnabled: true,
    },
    deploymentEnvironment: "production",
    internalPort: 3998,
  }));
  assert.doesNotThrow(() => validateContainerConfig({
    config: {
      ...base,
      snapshotPollEnabled: false,
      threadStreamEnabled: false,
      transcriptionWorkerEnabled: false,
      cloudSnapshotConsumerEnabled: true,
      cloudThreadStreamConsumerEnabled: true,
      cloudMediaConsumerEnabled: true,
    },
    deploymentEnvironment: "production",
    internalPort: 3998,
  }));
  assert.throws(() => validateContainerConfig({
    config: {
      ...base,
      snapshotPollEnabled: false,
      threadStreamEnabled: false,
      transcriptionWorkerEnabled: false,
    },
    deploymentEnvironment: "production",
    internalPort: 3998,
  }), /CLOUD_SNAPSHOT_CONSUMER_ENABLED=1 or SNAPSHOT_POLL_ENABLED=1/u);
  assert.throws(() => validateContainerConfig({
    config: { ...base, webPush: { supported: false }, webPushStorageEncryptionKeyConfigured: false },
    deploymentEnvironment: "production",
    internalPort: 3998,
  }), /WEB_PUSH_VAPID_KEYS=valid, WEB_PUSH_STORAGE_ENCRYPTION_KEY/u);
});

function productionConfig() {
  return {
    port: 3996,
    storageProvider: "convex",
    convexUrl: "https://convex.example",
    convexGatewaySecret: "secret",
    dataFile: null,
    authProvider: "clerk",
    clerkSecretKey: "secret",
    clerkPublishableKey: "pk_live",
    publicBaseUrl: "https://controller.example",
    mediaStorageProvider: "s3",
    firmwareStorageProvider: "s3",
    s3Endpoint: "https://account.r2.cloudflarestorage.com",
    s3Bucket: "media",
    firmwareS3Bucket: "firmware",
    s3AccessKeyId: "key",
    s3SecretAccessKey: "secret",
    t3TokenEncryptionKey: "secret",
    webPush: { supported: true },
    webPushEncryptionKey: "push-secret",
    webPushStorageEncryptionKeyConfigured: true,
    requireTls: true,
    devTokenCreationEnabled: false,
    discoveryEnabled: false,
    cloudSnapshotConsumerEnabled: false,
    cloudThreadStreamConsumerEnabled: false,
    cloudMediaConsumerEnabled: false,
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("Container shutdown closes an open SSE response before finishing", { timeout: 5000 }, async (t) => {
  const runtime = await createContainerServers({
    env: { DEPLOYMENT_ENVIRONMENT: "local", HOST: "127.0.0.1", PORT: "0", INTERNAL_HOST: "127.0.0.1", INTERNAL_PORT: String(await freePort()), STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "dev", ENABLE_DEV_TOKENS: "1", DISCOVERY_ENABLED: "0", SNAPSHOT_POLL_ENABLED: "0", THREAD_STREAM_ENABLED: "0", TRANSCRIPTION_WORKER_ENABLED: "0" },
    logger: { info() {}, error() {} },
  });
  const abort = new AbortController();
  t.after(async () => { abort.abort(); await runtime.stop(); });
  await runtime.start();
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  const created = await (await fetch(origin + "/v1/users/dev", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: "shutdown_fixture", email: "fixture@example.test" }) })).json();
  const response = await fetch(origin + "/v1/events", { headers: { authorization: `Bearer ${created.apiToken.secret}` }, signal: abort.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/u);
  assert.ok((await response.body.getReader().read()).value.length > 0);
  await runtime.stop();
  assert.equal(runtime.server.listening, false);
  assert.equal(runtime.internalServer.listening, false);
});
