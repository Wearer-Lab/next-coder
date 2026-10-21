import assert from "node:assert/strict";
import test from "node:test";

import webpush from "web-push";

import { createNotificationPublisher } from "../src/notifications.mjs";
import { createStore } from "../src/store.mjs";
import {
  classifyPushFailure,
  createWebPushDeliveryRunner,
  loadWebPushConfig,
  privacyMinimalPayload,
  publicWebPushConfig,
  validatePushSubscription,
} from "../src/webPush.mjs";

const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/mock-capability",
  keys: {
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url"),
    auth: Buffer.alloc(16, 9).toString("base64url"),
  },
};

function config() {
  const first = webpush.generateVAPIDKeys();
  const second = webpush.generateVAPIDKeys();
  return loadWebPushConfig({
    WEB_PUSH_VAPID_KEYS: JSON.stringify([
      { keyId: "old", ...first, subject: "mailto:ops@example.com", active: false },
      { keyId: "current", ...second, subject: "https://example.com/push-contact", active: true },
    ]),
  });
}

test("VAPID rotation exposes only the active public key and rejects endpoint SSRF", () => {
  const loaded = config();
  assert.equal(loaded.supported, true);
  assert.equal(loaded.activeKeyId, "current");
  assert.equal(loaded.keys.size, 2);
  const publicConfig = publicWebPushConfig(loaded);
  assert.deepEqual(publicConfig, {
    supported: true,
    reason: null,
    keyId: "current",
    publicKey: loaded.keys.get("current").publicKey,
  });
  const serializedPublicConfig = JSON.stringify(publicConfig);
  for (const entry of loaded.keys.values()) {
    assert.equal(serializedPublicConfig.includes(entry.privateKey), false);
    assert.equal(serializedPublicConfig.includes(entry.subject), false);
  }
  assert.deepEqual(validatePushSubscription(subscription, loaded), subscription);
  assert.throws(() => validatePushSubscription({
    ...subscription,
    endpoint: "https://127.0.0.1/internal",
  }, loaded), /not allowed/u);
  assert.equal(loadWebPushConfig({}).reason, "not_configured");
});

test("a local mock endpoint receives one content-free payload and duplicate events do not requeue", async () => {
  let currentTime = Date.parse("2026-08-27T20:00:00Z");
  const store = createStore({}, { now: () => currentTime });
  store.ensureUser({ userId: "owner" });
  store.upsertPushSubscription({ userId: "owner", ...subscription, vapidKeyId: "current" });
  const publisher = createNotificationPublisher({ store, now: () => currentTime });
  const command = {
    id: "cmd_private", userId: "owner", environmentId: "/private/workspace", threadId: "secret-thread",
    intent: { type: "agent_prompt", text: "private prompt" }, status: "completed",
  };
  await publisher.forCommand(command);
  await publisher.forCommand(command);

  const received = [];
  const runner = createWebPushDeliveryRunner({
    store,
    config: config(),
    now: () => currentTime,
    sendNotification: async (request) => { received.push(request); return true; },
  });
  const result = await runner.runOnce();
  assert.deepEqual({ claimed: result.claimed, accepted: result.accepted }, { claimed: 1, accepted: 1 });
  assert.equal(received.length, 1);
  const encoded = JSON.stringify(received[0].payload);
  assert.doesNotMatch(encoded, /private|workspace|secret-thread|prompt/u);
  assert.match(encoded, /notification_/u);
  assert.equal(store.exportState().pushDeliveries[0].status, "accepted");
});

test("retryable mock failures back off and terminal gone responses revoke the subscription", async () => {
  let currentTime = Date.parse("2026-08-27T20:00:00Z");
  const store = createStore({}, { now: () => currentTime });
  store.ensureUser({ userId: "owner" });
  store.upsertPushSubscription({ userId: "owner", ...subscription, vapidKeyId: "current" });
  const publisher = createNotificationPublisher({ store, now: () => currentTime });
  await publisher.forCommand({ id: "cmd_retry", userId: "owner", status: "failed", intent: { type: "agent_prompt" } });
  let attempts = 0;
  const runner = createWebPushDeliveryRunner({
    store, config: config(), now: () => currentTime, logger: null,
    sendNotification: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("busy"), { statusCode: 429, retryAfterMs: 5_000 });
      return false;
    },
  });
  assert.equal((await runner.runOnce()).retried, 1);
  assert.equal((await runner.runOnce()).claimed, 0);
  currentTime += 5_000;
  assert.equal((await runner.runOnce()).gone, 1);
  assert.equal(store.listPushSubscriptions({ userId: "owner" }).length, 0);
  assert.equal(store.exportState().pushDeliveries[0].status, "gone");
});

test("payload and failure classification never claim browser display", () => {
  const payload = privacyMinimalPayload({ id: "notification_1", kind: "user_input.required" });
  assert.equal(payload.body, "Open Next Coder to review this update.");
  assert.deepEqual(classifyPushFailure({ statusCode: 410 }), {
    outcome: "gone", code: "subscription_gone", retryAt: null,
  });
  assert.equal(classifyPushFailure({ statusCode: 400 }).outcome, "failed");
  assert.equal(classifyPushFailure(new TypeError("offline"), 100).outcome, "retry");
});
