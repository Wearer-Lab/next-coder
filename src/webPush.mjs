import webpush from "web-push";

const DEFAULT_ALLOWED_HOSTS = [
  "fcm.googleapis.com",
  ".push.services.mozilla.com",
  ".push.apple.com",
];
const STATIC_TITLES = new Map([
  ["turn.completed", "Agent turn completed"],
  ["turn.failed", "Agent turn failed"],
  ["gateway.approval_required", "Approval required"],
  ["provider.approval_required", "Provider approval required"],
  ["user_input.required", "Input required"],
  ["connector.offline", "Connector offline"],
  ["connector.recovered", "Connector recovered"],
  ["t3.offline", "T3 environment offline"],
  ["t3.recovered", "T3 environment recovered"],
]);

export function loadWebPushConfig(env = process.env) {
  const configured = Boolean(env.WEB_PUSH_VAPID_KEYS
    || env.WEB_PUSH_VAPID_PUBLIC_KEY
    || env.WEB_PUSH_VAPID_PRIVATE_KEY
    || env.WEB_PUSH_VAPID_SUBJECT);
  if (!configured) return unsupported("not_configured");
  try {
    const entries = env.WEB_PUSH_VAPID_KEYS
      ? JSON.parse(env.WEB_PUSH_VAPID_KEYS)
      : [{
        keyId: env.WEB_PUSH_VAPID_KEY_ID ?? "primary",
        publicKey: env.WEB_PUSH_VAPID_PUBLIC_KEY,
        privateKey: env.WEB_PUSH_VAPID_PRIVATE_KEY,
        subject: env.WEB_PUSH_VAPID_SUBJECT,
        active: true,
      }];
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 3) {
      return unsupported("invalid_key_set");
    }
    const keys = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") return unsupported("invalid_key_set");
      const keyId = text(entry.keyId, 64);
      if (!keyId || keys.has(keyId)) return unsupported("invalid_key_id");
      const vapidPublicKey = decodeBase64Url(entry.publicKey);
      if (!validSubject(entry.subject)
        || vapidPublicKey?.byteLength !== 65
        || vapidPublicKey[0] !== 4
        || decodeBase64Url(entry.privateKey)?.byteLength !== 32) {
        return unsupported("invalid_vapid_key");
      }
      // Let the audited RFC 8292 implementation validate and exercise the signing material at
      // startup. This is local computation only; it does not contact the probe origin.
      webpush.getVapidHeaders(
        "https://push-validation.invalid",
        entry.subject,
        entry.publicKey,
        entry.privateKey,
        "aes128gcm",
      );
      keys.set(keyId, {
        keyId,
        publicKey: entry.publicKey,
        privateKey: entry.privateKey,
        subject: entry.subject,
        active: entry.active === true,
      });
    }
    const active = [...keys.values()].filter((entry) => entry.active);
    if (active.length !== 1) return unsupported("active_key_required");
    const configuredHosts = String(env.WEB_PUSH_ALLOWED_HOSTS ?? "")
      .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    const allowedHosts = configuredHosts.length > 0 ? configuredHosts : DEFAULT_ALLOWED_HOSTS;
    if (allowedHosts.some((host) => !validHostRule(host))) return unsupported("invalid_allowed_host");
    return {
      supported: true,
      reason: null,
      activeKeyId: active[0].keyId,
      publicKey: active[0].publicKey,
      keys,
      allowedHosts,
    };
  } catch {
    return unsupported("invalid_key_set");
  }
}

export function validatePushSubscription(input, config) {
  if (!config?.supported) throw terminal("Web Push is not configured.", "web_push_unavailable");
  if (!input || typeof input !== "object") throw terminal("A push subscription is required.", "push_subscription_invalid");
  let endpoint;
  try { endpoint = new URL(input.endpoint); }
  catch { throw terminal("Push endpoint is invalid.", "push_subscription_invalid"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
    throw terminal("Push endpoint must be an HTTPS capability URL.", "push_subscription_invalid");
  }
  if (!hostAllowed(endpoint.hostname, config.allowedHosts)) {
    throw terminal("Push endpoint host is not allowed.", "push_endpoint_not_allowed");
  }
  const p256dh = text(input.keys?.p256dh, 256);
  const auth = text(input.keys?.auth, 128);
  const p256dhBytes = decodeBase64Url(p256dh);
  if (!p256dh || !auth || p256dhBytes?.byteLength !== 65 || p256dhBytes[0] !== 4 || decodeBase64Url(auth)?.byteLength !== 16) {
    throw terminal("Push subscription keys are invalid.", "push_subscription_invalid");
  }
  return { endpoint: endpoint.toString(), keys: { p256dh, auth } };
}

export function publicWebPushConfig(config) {
  return config?.supported
    ? { supported: true, reason: null, keyId: config.activeKeyId, publicKey: config.publicKey }
    : { supported: false, reason: config?.reason ?? "not_configured", keyId: null, publicKey: null };
}

export function createWebPushDeliveryRunner({
  store,
  config,
  sendNotification = sendWithWebPush,
  now = Date.now,
  batchSize = 10,
  leaseMs = 30_000,
  logger = console,
  intervalMs = 2_000,
} = {}) {
  if (!store) throw new Error("A Store is required for Web Push delivery.");
  let timer = null;
  let running = false;

  async function runOnce() {
    if (running) return { skipped: true, reason: "already_running", claimed: 0, accepted: 0 };
    running = true;
    try {
    if (!config?.supported) return { skipped: true, reason: config?.reason ?? "not_configured", claimed: 0, accepted: 0 };
    const claims = await store.claimPushDeliveries({ limit: batchSize, leaseMs, now: now() });
    const summary = { skipped: false, claimed: claims.length, accepted: 0, retried: 0, failed: 0, gone: 0 };
    for (const claim of claims) {
      const vapid = config.keys.get(claim.subscription.vapidKeyId);
      if (!vapid) {
        await store.settlePushDelivery({ deliveryId: claim.delivery.id, outcome: "failed", failureCode: "vapid_key_retired" });
        summary.failed += 1;
        continue;
      }
      try {
        const accepted = await sendNotification({
          subscription: { endpoint: claim.subscription.endpoint, keys: claim.subscription.keys },
          payload: privacyMinimalPayload(claim.notification),
          vapid,
        });
        if (accepted === false) {
          await store.settlePushDelivery({ deliveryId: claim.delivery.id, outcome: "gone", failureCode: "subscription_gone" });
          summary.gone += 1;
        } else {
          await store.settlePushDelivery({ deliveryId: claim.delivery.id, outcome: "accepted" });
          summary.accepted += 1;
        }
      } catch (error) {
        const failure = classifyPushFailure(error, now());
        await store.settlePushDelivery({
          deliveryId: claim.delivery.id,
          outcome: failure.outcome,
          failureCode: failure.code,
          retryAt: failure.retryAt,
        });
        summary[failure.outcome === "retry" ? "retried" : failure.outcome === "gone" ? "gone" : "failed"] += 1;
        logger?.warn?.(`web push delivery ${claim.delivery.id} ${failure.code}`);
      }
    }
    return summary;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer || !config?.supported) return;
    timer = setInterval(() => void runOnce(), intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop };
}

export function privacyMinimalPayload(notification) {
  return {
    title: STATIC_TITLES.get(notification?.kind) ?? "Next Coder update",
    body: "Open Next Coder to review this update.",
    tag: `next-coder-${notification?.id ?? "update"}`,
    url: `/#activity?view=notifications${notification?.id ? `&notification=${encodeURIComponent(notification.id)}` : ""}`,
  };
}

export function classifyPushFailure(error, currentTime = Date.now()) {
  const status = Number(error?.statusCode ?? error?.status);
  if (status === 404 || status === 410) return { outcome: "gone", code: "subscription_gone", retryAt: null };
  if (status === 408 || status === 425 || status === 429 || status >= 500 || error instanceof TypeError) {
    const retryAfterMs = Number(error?.retryAfterMs);
    return {
      outcome: "retry",
      code: status ? `push_http_${status}` : "push_transport_failed",
      retryAt: currentTime + (Number.isFinite(retryAfterMs) ? Math.min(Math.max(retryAfterMs, 1_000), 60_000) : 2_000),
    };
  }
  return { outcome: "failed", code: status ? `push_http_${status}` : "push_delivery_invalid", retryAt: null };
}

async function sendWithWebPush({ subscription, payload, vapid }) {
  const response = await webpush.sendNotification(subscription, JSON.stringify(payload), {
    TTL: 300,
    urgency: "high",
    topic: "next-coder-attention",
    timeout: 10_000,
    vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
  });
  return response?.statusCode >= 200 && response?.statusCode < 300;
}

function hostAllowed(hostname, rules) {
  const host = hostname.toLowerCase();
  return rules.some((rule) => rule.startsWith(".") ? host.endsWith(rule) && host.length > rule.length : host === rule);
}

function validHostRule(value) {
  return /^\.?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(value) && !value.includes("..");
}

function validSubject(value) {
  if (typeof value !== "string" || value.length > 256) return false;
  if (value.startsWith("mailto:")) return /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value.slice(7));
  try { return new URL(value).protocol === "https:"; }
  catch { return false; }
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try { return Buffer.from(value.replace(/-/gu, "+").replace(/_/gu, "/"), "base64"); }
  catch { return null; }
}

function text(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function unsupported(reason) {
  return { supported: false, reason, activeKeyId: null, publicKey: null, keys: new Map(), allowedHosts: DEFAULT_ALLOWED_HOSTS };
}

function terminal(message, code) {
  return Object.assign(new Error(message), { code, retryable: false });
}
