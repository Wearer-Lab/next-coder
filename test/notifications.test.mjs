import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createConnectorInternalService } from "../src/connectorInternalService.mjs";
import { loadConfig } from "../src/config.mjs";
import { createFileStore } from "../src/fileStore.mjs";
import {
  buildBackgroundLiveness,
  createNotificationPublisher,
  notificationView,
} from "../src/notifications.mjs";
import { createStore } from "../src/store.mjs";
import { createSnapshotPoller } from "../src/snapshotPoller.mjs";

const BASE_TIME = Date.parse("2026-08-27T20:00:00.000Z");

test("meaningful events create one privacy-minimal notification under replay", async () => {
  const store = createStore({}, { now: () => BASE_TIME });
  store.ensureUser({ userId: "user_1" });
  const delivered = [];
  const publisher = createNotificationPublisher({
    store,
    now: () => BASE_TIME,
    events: { broadcastToUser: (userId, type, payload) => delivered.push({ userId, type, payload }) },
  });

  const command = {
    id: "cmd_1",
    userId: "user_1",
    environmentId: "env_1",
    threadId: "thread_1",
    intent: { type: "agent_prompt", text: "private prompt must not survive here" },
    status: "completed",
    updatedAt: "2026-08-27T20:00:00.000Z",
  };
  assert.equal((await publisher.forCommand(command)).created, true);
  assert.equal((await publisher.forCommand(command)).created, false);
  assert.equal((await publisher.forCommand({
    ...command,
    id: "cmd_failed",
    status: "failed",
  })).notification.kind, "turn.failed");
  assert.equal((await publisher.forCommand({
    ...command,
    id: "cmd_approval",
    intent: { type: "shell_input" },
    status: "approval_required",
  })).notification.kind, "gateway.approval_required");
  const gatewayResolved = await publisher.forCommand({
    ...command,
    id: "cmd_approval",
    intent: { type: "shell_input" },
    status: "rejected",
    updatedAt: "2026-08-27T20:00:00.500Z",
  });
  assert.equal(gatewayResolved.duplicate, false);
  assert.equal(gatewayResolved.notification.dismissedAt, "2026-08-27T20:00:00.500Z");

  const privateRequestId = "Which confidential database should I migrate?";
  const activity = {
    id: null,
    kind: "user-input.requested",
    payload: { requestId: privateRequestId, questions: [{ question: privateRequestId }] },
    createdAt: "2026-08-27T20:00:01.000Z",
  };
  assert.equal((await publisher.forThreadActivity({
    userId: "user_1",
    environmentId: "env_1",
    threadId: "thread_1",
    activity,
  })).created, true);
  assert.equal((await publisher.forThreadActivity({
    userId: "user_1",
    environmentId: "env_1",
    threadId: "thread_1",
    activity,
  })).created, false);

  assert.equal((await publisher.forThreadActivity({
    userId: "user_1",
    environmentId: "env_1",
    threadId: "thread_1",
    activity: {
      id: "activity_approval",
      kind: "approval.requested",
      payload: { requestId: "provider-secret-request-id", detail: "/private/path" },
    },
  })).notification.kind, "provider.approval_required");

  assert.equal((await publisher.forConnector({
    userId: "user_1",
    connector: { id: "connector_1", environmentId: "env_1", status: "offline" },
    previousStatus: "online",
    eventKey: "disconnect_1",
  })).notification.kind, "connector.offline");
  assert.equal((await publisher.forConnector({
    userId: "user_1",
    connector: { id: "connector_1", environmentId: "env_1", status: "online" },
    previousStatus: "offline",
    eventKey: "hello_2",
  })).notification.kind, "connector.recovered");
  assert.equal((await publisher.forEnvironmentHealth({
    userId: "user_1",
    environment: { id: "env_1", status: "unreachable", health: { lastCheckedAt: "2026-08-27T20:00:02Z" } },
    previousStatus: "reachable",
  })).notification.kind, "t3.offline");
  assert.equal((await publisher.forEnvironmentHealth({
    userId: "user_1",
    environment: { id: "env_1", status: "reachable", health: { lastCheckedAt: "2026-08-27T20:00:03Z" } },
    previousStatus: "unreachable",
  })).notification.kind, "t3.recovered");

  const listed = store.listNotifications({ userId: "user_1", includeDismissed: true });
  assert.deepEqual(
    new Set(listed.notifications.map((row) => row.kind)),
    new Set([
      "turn.completed", "turn.failed", "gateway.approval_required", "provider.approval_required",
      "user_input.required", "connector.offline", "connector.recovered", "t3.offline", "t3.recovered",
    ]),
  );
  assert.equal(delivered.filter((event) => event.type === "notification.created").length, 9);
  const resolved = await publisher.forThreadActivity({
    userId: "user_1",
    environmentId: "env_1",
    threadId: "thread_1",
    activity: {
      id: "a different activity id",
      kind: "user-input.resolved",
      payload: { requestId: privateRequestId, answers: { private: "must not survive here either" } },
      createdAt: "2026-08-27T20:00:04.000Z",
    },
  });
  assert.equal(resolved.duplicate, false);
  assert.equal(resolved.notification.dismissedAt, "2026-08-27T20:00:04.000Z");
  assert.equal((await publisher.forThreadActivity({
    userId: "user_1",
    environmentId: "env_1",
    threadId: "thread_1",
    activity: {
      kind: "user-input.resolved",
      payload: { requestId: privateRequestId },
    },
  })).duplicate, true);
  assert.equal(delivered.filter((event) => event.type === "notification.updated").length, 2);
  for (const event of delivered) {
    assert.equal(Object.hasOwn(event.payload, "userId"), false);
    assert.equal(Object.hasOwn(event.payload, "dedupeKey"), false);
  }
  const encoded = JSON.stringify(store.exportState().notifications);
  assert.doesNotMatch(encoded, /private prompt|confidential database|private\/path|provider-secret|must not survive/u);
});

test("connector and T3 transition adapters generate offline/recovered notifications once", async () => {
  const store = createStore();
  store.ensureUser({ userId: "owner" });
  const environment = store.upsertEnvironment({
    userId: "owner",
    label: "Studio Mac",
    transportMode: "connector",
    scopes: ["orchestration:read", "orchestration:operate"],
    status: "paired",
  });
  const enrolled = store.createConnector({
    userId: "owner",
    environmentId: environment.id,
    scopes: ["connector:connect", "t3:proxy"],
    capabilities: [],
  });
  const publisher = createNotificationPublisher({ store });
  const service = createConnectorInternalService({ store, notifications: publisher });
  const connectorNow = Date.now();
  const base = {
    eventVersion: 1,
    environmentId: environment.id,
    connectorId: enrolled.connector.id,
    connectionId: "connection_1",
  };
  await service.fetch(connectorEvent({ ...base, occurredAt: connectorNow, kind: "connector.hello", body: {} }));
  await service.fetch(connectorEvent({ ...base, occurredAt: connectorNow + 1, kind: "connector.disconnected", body: {} }));
  await service.fetch(connectorEvent({ ...base, occurredAt: connectorNow + 2, kind: "connector.hello", body: {} }));
  // Replay overlap carries the same event key and cannot make a second recovered row.
  await service.fetch(connectorEvent({ ...base, occurredAt: connectorNow + 2, kind: "connector.hello", body: {} }));

  const poller = createSnapshotPoller({
    store,
    notifications: publisher,
    fetchSnapshot: async () => {
      throw Object.assign(new Error("unavailable"), { code: "ECONNREFUSED" });
    },
  });
  await poller.runOnce({ userIds: ["owner"] });
  const recovering = createSnapshotPoller({
    store,
    notifications: publisher,
    fetchSnapshot: async () => ({ projects: [], threads: [] }),
  });
  await recovering.runOnce({ userIds: ["owner"] });

  const kinds = store.listNotifications({ userId: "owner", limit: 20 }).notifications.map((row) => row.kind);
  assert.deepEqual(kinds.sort(), ["connector.offline", "connector.recovered", "t3.offline", "t3.recovered"].sort());
});

test("notification replay, older pagination, read, dismiss and retention are deterministic", () => {
  let now = BASE_TIME;
  const store = createStore({}, { now: () => now });
  store.ensureUser({ userId: "owner" });
  store.ensureUser({ userId: "other" });
  for (let index = 1; index <= 4; index += 1) {
    now += 1;
    store.createNotification(notificationInput("owner", index));
  }

  const first = store.listNotifications({ userId: "owner", limit: 2 });
  assert.deepEqual(first.notifications.map((row) => row.sequence), [4, 3]);
  assert.equal(first.nextCursor, "4");
  assert.equal(first.oldestCursor, "3");
  assert.equal(first.hasMoreBefore, true);

  const older = store.listNotifications({ userId: "owner", beforeCursor: first.oldestCursor, limit: 2 });
  assert.deepEqual(older.notifications.map((row) => row.sequence), [2, 1]);
  assert.equal(older.hasMoreBefore, false);

  now += 1;
  store.createNotification(notificationInput("owner", 5));
  const replay = store.listNotifications({ userId: "owner", afterCursor: first.nextCursor, limit: 2 });
  assert.deepEqual(replay.notifications.map((row) => row.sequence), [5]);
  assert.equal(replay.nextCursor, "5");

  const notificationId = first.notifications[0].id;
  assert.equal(store.markNotificationRead({ userId: "other", notificationId }), null);
  assert.equal(store.markNotificationRead({ userId: "owner", notificationId }).duplicate, false);
  assert.equal(store.markNotificationRead({ userId: "owner", notificationId }).duplicate, true);
  assert.equal(store.dismissNotification({ userId: "owner", notificationId }).duplicate, false);
  assert.equal(store.dismissNotification({ userId: "owner", notificationId }).duplicate, true);
  assert.equal(store.listNotifications({ userId: "owner" }).notifications.length, 4);
  assert.equal(store.listNotifications({ userId: "owner", includeDismissed: true }).notifications.length, 5);

  for (let index = 6; index <= 1010; index += 1) {
    now += 1;
    store.createNotification(notificationInput("owner", index));
  }
  assert.equal(store.listNotifications({ userId: "owner", limit: 100 }).unreadCount, 1000);
  assert.equal(store.exportState().notifications.filter((row) => row.userId === "owner").length, 1000);
});

test("FileStore persists notification acknowledgement and scheduler evidence atomically", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "next-coder-notifications-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "state.json");
  const store = await createFileStore(file, { now: () => BASE_TIME });
  store.ensureUser({ userId: "owner" });
  const created = await store.createNotification(notificationInput("owner", 1));
  await store.markNotificationRead({ userId: "owner", notificationId: created.notification.id });
  await store.dismissNotificationByDedupe({
    userId: "owner",
    dedupeKey: "dedupe-1",
    resolvedAt: "2026-08-27T20:00:01.000Z",
  });
  await store.recordBackgroundLiveness({
    scope: "scheduled-worker",
    attemptedAt: "2026-08-27T20:00:00.000Z",
    succeeded: true,
  });

  const reloaded = await createFileStore(file, { now: () => BASE_TIME });
  const listed = reloaded.listNotifications({ userId: "owner", includeDismissed: true });
  assert.equal(listed.notifications[0].readAt, "2026-08-27T20:00:00.000Z");
  assert.equal(listed.notifications[0].dismissedAt, "2026-08-27T20:00:01.000Z");
  assert.equal(reloaded.getBackgroundLiveness("scheduled-worker").lastSuccessAt, "2026-08-27T20:00:00.000Z");
  const text = await readFile(file, "utf8");
  assert.doesNotMatch(text, /private prompt|question|answer/u);
});

test("notification API enforces owner scope and exposes replay-safe routes and scheduler truth", async (t) => {
  const store = createStore({}, { now: () => BASE_TIME });
  const ownerToken = store.createUserToken({ userId: "owner" }).secret;
  const otherToken = store.createUserToken({ userId: "other" }).secret;
  const config = loadConfig({
    AUTH_PROVIDER: "dev",
    ENABLE_DEV_TOKENS: "1",
    CLOUD_MEDIA_CONSUMER_ENABLED: "1",
    DISCOVERY_ENABLED: "0",
  });
  const app = createApp({ store, config });
  await listen(app.server);
  t.after(() => app.server.close());
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const ownerHeaders = { authorization: `Bearer ${ownerToken}` };
  const otherHeaders = { authorization: `Bearer ${otherToken}` };

  const abort = new AbortController();
  t.after(() => abort.abort());
  const stream = await fetch(`${baseUrl}/v1/events`, { headers: ownerHeaders, signal: abort.signal });
  assert.equal(stream.status, 200);
  const notificationEvent = readStreamUntil(stream.body, "event: notification.created");

  await app.notifications.forCommand({
    id: "cmd_api",
    userId: "owner",
    environmentId: "env_api",
    threadId: "thread_api",
    intent: { type: "agent_prompt" },
    status: "failed",
    updatedAt: "2026-08-27T20:00:00.000Z",
  });
  const eventText = await notificationEvent;
  assert.match(eventText, /event: notification\.created/u);
  const notificationFrame = eventText.slice(eventText.indexOf("event: notification.created"));
  assert.doesNotMatch(notificationFrame, /dedupeKey|userId|prompt/u);
  const inbox = await jsonRequest(baseUrl, "/v1/notifications?limit=10", { headers: ownerHeaders });
  assert.equal(inbox.notifications.length, 1);
  assert.equal(Object.hasOwn(inbox.notifications[0], "userId"), false);
  assert.equal(Object.hasOwn(inbox.notifications[0], "dedupeKey"), false);

  const notificationId = inbox.notifications[0].id;
  const crossOwner = await fetch(`${baseUrl}/v1/notifications/${notificationId}/read`, {
    method: "POST",
    headers: otherHeaders,
  });
  assert.equal(crossOwner.status, 404);
  await crossOwner.arrayBuffer();

  const read = await jsonRequest(baseUrl, `/v1/notifications/${notificationId}/read`, {
    method: "POST",
    headers: ownerHeaders,
  });
  assert.equal(read.duplicate, false);
  const duplicate = await jsonRequest(baseUrl, `/v1/notifications/${notificationId}/read`, {
    method: "POST",
    headers: ownerHeaders,
  });
  assert.equal(duplicate.duplicate, true);

  await app.notifications.forCommand({
    id: "cmd_api_2",
    userId: "owner",
    environmentId: "env_api",
    threadId: "thread_api",
    intent: { type: "agent_prompt" },
    status: "completed",
    updatedAt: "2026-08-27T20:00:01.000Z",
  });
  const newestPage = await jsonRequest(baseUrl, "/v1/notifications?limit=1", { headers: ownerHeaders });
  assert.equal(newestPage.notifications[0].commandId, "cmd_api_2");
  assert.equal(newestPage.hasMoreBefore, true);
  const olderPage = await jsonRequest(
    baseUrl,
    `/v1/notifications?before=${newestPage.oldestCursor}&limit=1`,
    { headers: ownerHeaders },
  );
  assert.equal(olderPage.notifications[0].id, notificationId);
  const readAll = await jsonRequest(baseUrl, "/v1/notifications/read-all", {
    method: "POST",
    headers: ownerHeaders,
  });
  assert.equal(readAll.count, 1);
  const dismissed = await jsonRequest(baseUrl, `/v1/notifications/${notificationId}`, {
    method: "DELETE",
    headers: ownerHeaders,
  });
  assert.equal(dismissed.duplicate, false);
  assert.equal(typeof dismissed.notification.dismissedAt, "string");
  const duplicateDismiss = await jsonRequest(baseUrl, `/v1/notifications/${notificationId}`, {
    method: "DELETE",
    headers: ownerHeaders,
  });
  assert.equal(duplicateDismiss.duplicate, true);

  const noDeviceInbox = await fetch(`${baseUrl}/v1/device/notifications`);
  assert.equal(noDeviceInbox.status, 404);
  await noDeviceInbox.arrayBuffer();

  store.recordBackgroundLiveness({
    scope: "scheduled-worker",
    attemptedAt: "2026-08-27T20:00:00.000Z",
    succeeded: true,
  });
  const liveness = await jsonRequest(baseUrl, "/v1/background/liveness", { headers: ownerHeaders });
  assert.equal(liveness.scheduledWorker.status, "stale");
  assert.equal(Object.hasOwn(liveness, "connector"), false);
  assert.equal(Object.hasOwn(liveness, "t3"), false);
  assert.equal(Object.hasOwn(liveness, "provider"), false);
});

test("background liveness distinguishes healthy, degraded, stale and configuration states", () => {
  const record = {
    lastAttemptAt: "2026-08-27T20:00:00.000Z",
    lastSuccessAt: "2026-08-27T20:00:00.000Z",
    lastFailureAt: null,
    failureCode: null,
  };
  assert.equal(buildBackgroundLiveness({ record, configured: false, now: BASE_TIME }).status, "not_configured");
  assert.equal(buildBackgroundLiveness({ record: null, configured: true, now: BASE_TIME }).status, "unknown");
  assert.equal(buildBackgroundLiveness({ record, configured: true, now: BASE_TIME }).status, "healthy");
  assert.equal(buildBackgroundLiveness({ record, configured: true, now: BASE_TIME + 11 * 60_000 }).status, "stale");
  assert.equal(buildBackgroundLiveness({
    record: { ...record, lastFailureAt: record.lastAttemptAt, failureCode: "queue_failed" },
    configured: true,
    now: BASE_TIME,
  }).status, "degraded");
});

function notificationInput(userId, index) {
  return {
    userId,
    dedupeKey: `dedupe-${index}`,
    kind: index % 2 === 0 ? "turn.completed" : "turn.failed",
    severity: index % 2 === 0 ? "info" : "error",
    title: index % 2 === 0 ? "Agent turn completed" : "Agent turn failed",
    environmentId: "env_1",
    threadId: "thread_1",
    commandId: `cmd_${index}`,
    occurredAt: new Date(BASE_TIME + index).toISOString(),
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function connectorEvent(body) {
  return new Request("https://connector.internal/v1/internal/connector-events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readStreamUntil(body, pattern) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.indexOf(pattern) < 0 || text.indexOf("\n\n", text.indexOf(pattern)) < 0) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function jsonRequest(baseUrl, path, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.ok, true, `${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
