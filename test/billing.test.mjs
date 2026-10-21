import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import {
  checkResourceLimit,
  clampRetentionDays,
  defaultSubscription,
  effectiveTier,
  entitlementsFor,
  hasFeature,
  listPlans,
  normalizeSubscription,
} from "../src/billing.mjs";

const WEBHOOK_SECRET = "billing-secret";

test("every plan tier is described exactly once", () => {
  const plans = listPlans();
  const tiers = plans.map((plan) => plan.tier);
  assert.deepEqual(tiers, ["free", "starter", "pro", "team", "enterprise"]);
  assert.equal(new Set(tiers).size, tiers.length);
  for (const plan of plans) {
    assert.ok(plan.label && plan.description);
    assert.ok(plan.limits && plan.features);
  }
});

test("a lapsed paid subscription drops to free entitlements", () => {
  assert.equal(effectiveTier({ tier: "pro", status: "active" }), "pro");
  assert.equal(effectiveTier({ tier: "pro", status: "trialing" }), "pro");
  assert.equal(effectiveTier({ tier: "pro", status: "past_due" }), "free");
  assert.equal(effectiveTier({ tier: "pro", status: "canceled" }), "free");
  assert.equal(effectiveTier(null), "free");
  // An unknown tier must not grant anything.
  assert.equal(effectiveTier({ tier: "platinum", status: "active" }), "free");
});

test("resource limits are enforced per tier and unlimited on enterprise", () => {
  const pro = { tier: "pro", status: "active" };
  assert.equal(checkResourceLimit(pro, "devices", 4).allowed, true);
  assert.equal(checkResourceLimit(pro, "devices", 5).allowed, false);
  assert.match(checkResourceLimit(pro, "devices", 5).reason, /pro plan allows 5 devices/u);

  const enterprise = { tier: "enterprise", status: "active" };
  const unlimited = checkResourceLimit(enterprise, "devices", 10_000);
  assert.equal(unlimited.allowed, true);
  assert.equal(unlimited.limit, null);
});

test("features and retention clamp to the tier", () => {
  assert.equal(hasFeature({ tier: "free", status: "active" }, "shellInput"), false);
  assert.equal(hasFeature({ tier: "starter", status: "active" }, "shellInput"), true);
  assert.equal(hasFeature({ tier: "starter", status: "active" }, "supportBundle"), false);
  assert.equal(hasFeature({ tier: "pro", status: "active" }, "supportBundle"), true);

  assert.equal(clampRetentionDays({ tier: "free", status: "active" }, 365), 7);
  assert.equal(clampRetentionDays({ tier: "pro", status: "active" }, 30), 30);
  // Enterprise tops out at the store's own 1..365 retention ceiling.
  assert.equal(clampRetentionDays({ tier: "enterprise", status: "active" }, 400), 365);
  assert.equal(clampRetentionDays({ tier: "pro", status: "active" }, null), 90);
});

test("subscription normalization rejects unknown values and merges partials", () => {
  const base = defaultSubscription("2026-01-01T00:00:00.000Z");
  assert.equal(base.tier, "free");
  assert.equal(base.status, "active");

  const upgraded = normalizeSubscription({ tier: "PRO ", status: "trialing" }, base);
  assert.equal(upgraded.tier, "pro", "tiers are trimmed and lowercased");
  assert.equal(upgraded.status, "trialing");

  // Unknown values fall back to the previous value rather than corrupting the record.
  const garbage = normalizeSubscription({ tier: "platinum", status: "exploded" }, upgraded);
  assert.equal(garbage.tier, "pro");
  assert.equal(garbage.status, "trialing");

  // Absent keys are preserved; present-but-empty become null.
  const withProvider = normalizeSubscription({ provider: "stripe", externalId: "sub_1" }, upgraded);
  assert.equal(withProvider.provider, "stripe");
  assert.equal(withProvider.tier, "pro");
  assert.equal(normalizeSubscription({ provider: "  " }, withProvider).provider, null);
});

test("the plan catalogue is public and the subscription endpoint reports usage", async (t) => {
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const plans = await requestJson(baseUrl, "/v1/billing/plans", {});
  assert.equal(plans.plans.length, 5);

  const authHeaders = await createAuthHeaders(baseUrl);
  const current = await requestJson(baseUrl, "/v1/billing/subscription", { headers: authHeaders });
  assert.equal(current.subscription.tier, "free");
  assert.equal(current.entitlements.tier, "free");
  assert.deepEqual(current.usage, { devices: 0, environments: 0, macros: 0 });
});

test("a signed billing webhook updates the subscription", async (t) => {
  const { server } = createApp({
    config: { demoMode: false, billingWebhookSecret: WEBHOOK_SECRET },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(baseUrl);

  const result = await postWebhook(baseUrl, {
    userId: "user_dev",
    subscription: { tier: "pro", status: "active", provider: "stripe", externalId: "sub_123" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.subscription.tier, "pro");
  assert.equal(result.body.subscription.provider, "stripe");

  const current = await requestJson(baseUrl, "/v1/billing/subscription", { headers: authHeaders });
  assert.equal(current.subscription.tier, "pro");
  assert.equal(current.entitlements.limits.devices, 5);
  assert.equal(current.entitlements.features.shellInput, true);
});

test("billing webhooks reject bad signatures, stale timestamps and unknown users", async (t) => {
  const { server } = createApp({
    config: { demoMode: false, billingWebhookSecret: WEBHOOK_SECRET },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await createAuthHeaders(baseUrl);

  const payload = { userId: "user_dev", subscription: { tier: "pro" } };

  const wrongSecret = await postWebhook(baseUrl, payload, { secret: "not-the-secret" });
  assert.equal(wrongSecret.status, 401);

  const stale = await postWebhook(baseUrl, payload, { timestamp: Date.now() - 10 * 60 * 1000 });
  assert.equal(stale.status, 401);

  const unsigned = await fetch(new URL("/v1/billing/webhook", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  await unsigned.text();
  assert.equal(unsigned.status, 401);

  const unknown = await postWebhook(baseUrl, { userId: "user_nope", subscription: { tier: "pro" } });
  assert.equal(unknown.status, 404);

  // Tampering with the body after signing must fail.
  const timestamp = String(Date.now());
  const signature = signBody(timestamp, JSON.stringify(payload), WEBHOOK_SECRET);
  const tampered = await fetch(new URL("/v1/billing/webhook", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-billing-timestamp": timestamp,
      "x-billing-signature": signature,
    },
    body: JSON.stringify({ ...payload, subscription: { tier: "enterprise" } }),
  });
  await tampered.text();
  assert.equal(tampered.status, 401);
});

test("webhooks are refused outright when no secret is configured", async (t) => {
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const result = await postWebhook(baseUrl, { userId: "user_dev" });
  assert.equal(result.status, 503, "an unconfigured webhook must not accept plan changes");
});

test("plan limits are inert unless billing is explicitly enforced", async (t) => {
  // Default config: the free tier allows 0 devices, but nothing should break.
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(baseUrl);

  const created = await requestJson(baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Controller", profile: "next-coder" },
  });
  assert.ok(created.device.id, "device creation must work with billing disabled");
});

test("with billing enforced the free tier cannot register a device", async (t) => {
  const { server } = createApp({ config: { demoMode: false, billingEnforced: true } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(baseUrl);

  const response = await fetch(new URL("/v1/devices", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ label: "Controller", profile: "next-coder" }),
  });
  const body = await response.json();
  assert.equal(response.status, 402);
  assert.equal(body.error.details.tier, "free");
  assert.equal(body.error.details.limit, 0);
});

test("with billing enforced an upgraded plan unlocks devices and shell", async (t) => {
  const { server } = createApp({
    config: { demoMode: false, billingEnforced: true, billingWebhookSecret: WEBHOOK_SECRET },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(baseUrl);

  const upgrade = await postWebhook(baseUrl, {
    userId: "user_dev",
    subscription: { tier: "pro", status: "active" },
  });
  assert.equal(upgrade.status, 200);

  const created = await requestJson(baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Controller", profile: "next-coder" },
  });
  assert.ok(created.device.id);

  const entitlements = entitlementsFor({ tier: "pro", status: "active" });
  assert.equal(entitlements.features.shellInput, true);
});

function signBody(timestamp, body, secret) {
  return createHmac("sha256", secret).update(`${timestamp}.`, "utf8").update(body, "utf8").digest("hex");
}

async function postWebhook(baseUrl, payload, { secret = WEBHOOK_SECRET, timestamp = Date.now() } = {}) {
  const body = JSON.stringify(payload);
  const stamp = String(timestamp);
  const response = await fetch(new URL("/v1/billing/webhook", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-billing-timestamp": stamp,
      "x-billing-signature": signBody(stamp, body, secret),
    },
    body,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function requestJson(baseUrl, path, input) {
  const response = await fetch(new URL(path, baseUrl), {
    method: input.method ?? "GET",
    headers: { "content-type": "application/json", ...(input.headers ?? {}) },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}: ${text}`);
  return JSON.parse(text);
}

async function createAuthHeaders(baseUrl) {
  const auth = await requestJson(baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_dev", email: "dev@example.local" },
  });
  return { authorization: `Bearer ${auth.apiToken.secret}` };
}
