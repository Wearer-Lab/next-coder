import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { BETA_TARGETS, buildBetaReadiness } from "../src/betaReadiness.mjs";
import { isLoopback, isSecureTransport } from "../src/transport.mjs";

const DAY_MS = 86_400_000;

test("transport security recognises proxies, direct TLS and loopback", () => {
  const req = (headers = {}, remoteAddress = "203.0.113.5", encrypted = false) => ({
    headers,
    socket: { remoteAddress, encrypted },
  });

  assert.equal(isSecureTransport(req({ "x-forwarded-proto": "https" }), {}), true);
  assert.equal(isSecureTransport(req({ "x-forwarded-proto": "https, http" }), {}), true);
  assert.equal(isSecureTransport(req({ "x-forwarded-proto": "http" }), {}), false);
  assert.equal(isSecureTransport(req({}, "203.0.113.5", true), {}), true);
  assert.equal(isSecureTransport(req({}), { publicBaseUrl: "https://gw.example" }), true);
  assert.equal(isSecureTransport(req({}), {}), false);

  assert.equal(isLoopback(req({}, "127.0.0.1")), true);
  assert.equal(isLoopback(req({}, "::ffff:127.0.0.1")), true);
  assert.equal(isLoopback(req({}, "::1")), true);
  assert.equal(isLoopback(req({}, "10.0.0.4")), false);
});

test("device credentials are refused over plaintext when TLS is required", async (t) => {
  const { server } = createApp({
    config: { demoMode: false, requireTls: true, factoryToken: "factory-secret" },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Loopback is exempt: the simulator and local flashing depend on it.
  const auth = await requestJson(baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_dev", email: "dev@example.local" },
  });
  const headers = { authorization: `Bearer ${auth.apiToken.secret}` };
  const local = await requestJson(baseUrl, "/v1/devices", {
    method: "POST",
    headers,
    body: { label: "Local", profile: "next-coder" },
  });
  assert.ok(local.secret, "loopback still receives the device secret");

  // A forwarded plaintext request is treated as off-host and refused.
  const plaintext = await fetch(new URL("/v1/devices", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-proto": "http", ...headers },
    body: JSON.stringify({ label: "Remote", profile: "next-coder" }),
  });
  const body = await plaintext.json();
  assert.equal(plaintext.status, 403);
  assert.match(body.error.message, /requires HTTPS/u);

  // The same request over HTTPS is allowed.
  const secure = await fetch(new URL("/v1/devices", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-proto": "https", ...headers },
    body: JSON.stringify({ label: "Remote", profile: "next-coder" }),
  });
  await secure.text();
  assert.equal(secure.status, 201);
});

test("device authentication and factory provisioning are both TLS-gated", async (t) => {
  const { server } = createApp({
    config: { demoMode: false, requireTls: true, factoryToken: "factory-secret" },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const factory = await fetch(new URL("/v1/factory/devices", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-proto": "http",
      authorization: "Bearer factory-secret",
    },
    body: JSON.stringify({ label: "F", profile: "next-coder" }),
  });
  await factory.text();
  assert.equal(factory.status, 403, "factory provisioning returns secrets and must require TLS");

  const heartbeat = await fetch(new URL("/v1/device/heartbeat", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-proto": "http",
      "x-device-id": "dev_1",
      "x-device-secret": "secret",
    },
    body: "{}",
  });
  await heartbeat.text();
  assert.equal(heartbeat.status, 403, "a device secret must never travel in cleartext");
});

test("TLS enforcement is off by default so existing deployments keep working", async (t) => {
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const auth = await requestJson(baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_dev", email: "dev@example.local" },
  });
  const response = await fetch(new URL("/v1/devices", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-proto": "http",
      authorization: `Bearer ${auth.apiToken.secret}`,
    },
    body: JSON.stringify({ label: "Plain", profile: "next-coder" }),
  });
  await response.text();
  assert.equal(response.status, 201);
});

test("beta readiness measures paired device-days against the roadmap target", () => {
  const now = Date.parse("2026-08-07T00:00:00.000Z");
  const claimedDaysAgo = (days) => ({
    id: `dev_${days}`,
    claimed: true,
    claimedAt: new Date(now - days * DAY_MS).toISOString(),
  });

  const short = buildBetaReadiness({ devices: [claimedDaysAgo(10)], commands: [], now });
  const deviceDays = short.checks.find((check) => check.id === "paired_device_days");
  assert.equal(deviceDays.status, "fail");
  assert.equal(deviceDays.value, 10);
  assert.equal(deviceDays.target, BETA_TARGETS.minPairedDeviceDays);

  // Three devices paired 20 days each clears 50 device-days.
  const enough = buildBetaReadiness({
    devices: [claimedDaysAgo(20), claimedDaysAgo(20), claimedDaysAgo(20)],
    commands: [],
    now,
  });
  assert.equal(enough.checks.find((check) => check.id === "paired_device_days").status, "pass");

  // Unclaimed devices contribute nothing.
  const unclaimed = buildBetaReadiness({
    devices: [{ id: "d", claimed: false, createdAt: new Date(now - 90 * DAY_MS).toISOString() }],
    commands: [],
    now,
  });
  assert.equal(unclaimed.checks.find((check) => check.id === "paired_device_days").value, 0);

  // A revoked device stops accruing at revocation.
  const revoked = buildBetaReadiness({
    devices: [{
      id: "d",
      claimed: true,
      claimedAt: new Date(now - 30 * DAY_MS).toISOString(),
      revokedAt: new Date(now - 20 * DAY_MS).toISOString(),
    }],
    commands: [],
    now,
  });
  assert.equal(revoked.checks.find((check) => check.id === "paired_device_days").value, 10);
});

test("latency and failure criteria come from real command metrics", () => {
  const commands = [
    { userId: "u", status: "completed", metrics: { acknowledgementDurationMs: 300 } },
    { userId: "u", status: "completed", metrics: { acknowledgementDurationMs: 900 } },
    { userId: "u", status: "completed", metrics: { acknowledgementDurationMs: 1200 } },
  ];
  const readiness = buildBetaReadiness({ devices: [], commands });
  const ack = readiness.checks.find((check) => check.id === "command_acknowledgement");
  assert.equal(ack.status, "pass");
  assert.equal(ack.value, 900);

  const slow = buildBetaReadiness({
    devices: [],
    commands: commands.map((command) => ({ ...command, metrics: { acknowledgementDurationMs: 4000 } })),
  });
  assert.equal(slow.checks.find((check) => check.id === "command_acknowledgement").status, "fail");

  const failing = buildBetaReadiness({
    devices: [],
    commands: [...commands, { userId: "u", status: "failed" }, { userId: "u", status: "failed" }],
  });
  assert.equal(failing.checks.find((check) => check.id === "command_failure_ratio").status, "fail");
});

test("criteria with no data are unmeasured, never a pass", () => {
  const readiness = buildBetaReadiness({ devices: [], commands: [] });
  const unmeasured = new Set(readiness.unmeasured);

  assert.ok(unmeasured.has("audio_to_prompt_dispatch"), "no media commands yet");
  assert.ok(unmeasured.has("device_reconnect"), "no heartbeats yet");
  assert.equal(readiness.ready, false, "readiness must not claim true while criteria are unmeasured");

  for (const check of readiness.checks) {
    assert.ok(["pass", "fail", "unmeasured"].includes(check.status));
    if (check.status === "unmeasured") assert.equal(check.value, null);
  }
});

test("audio-to-prompt dispatch is measured from the recorded upload timestamp", () => {
  const fast = buildBetaReadiness({
    devices: [],
    commands: [
      { userId: "u", status: "completed", metrics: { mediaDispatchDurationMs: 3000 } },
      { userId: "u", status: "completed", metrics: { mediaDispatchDurationMs: 5000 } },
    ],
  });
  const check = fast.checks.find((entry) => entry.id === "audio_to_prompt_dispatch");
  assert.equal(check.status, "pass");
  // Even-sized sets take the lower median, matching percentile() in observability.mjs.
  assert.equal(check.value, 3000);
  assert.equal(check.target, 10_000);

  const slow = buildBetaReadiness({
    devices: [],
    commands: [{ userId: "u", status: "completed", metrics: { mediaDispatchDurationMs: 25_000 } }],
  });
  assert.equal(slow.checks.find((entry) => entry.id === "audio_to_prompt_dispatch").status, "fail");
});

test("device reconnects are measured from observed heartbeats", () => {
  const now = Date.parse("2026-08-07T00:00:00.000Z");
  const online = {
    id: "d1",
    claimed: true,
    claimedAt: new Date(now - 86_400_000).toISOString(),
    lastSeenAt: new Date(now - 5_000).toISOString(),
    status: { lastHeartbeatAt: new Date(now - 5_000).toISOString() },
    connectivity: { heartbeatCount: 40, reconnectCount: 3 },
  };

  const recovered = buildBetaReadiness({ devices: [online], commands: [], now });
  const check = recovered.checks.find((entry) => entry.id === "device_reconnect");
  assert.equal(check.status, "pass", "reconnects followed by a live device is the success case");
  assert.equal(check.value, 3);

  // Reconnects recorded but nothing reporting now is a failure, not a pass.
  const stale = buildBetaReadiness({
    devices: [{ ...online, lastSeenAt: new Date(now - 600_000).toISOString(), status: { lastHeartbeatAt: new Date(now - 600_000).toISOString() } }],
    commands: [],
    now,
  });
  assert.equal(stale.checks.find((entry) => entry.id === "device_reconnect").status, "fail");
});

test("an unattributed command fails the zero-unauthenticated-execution criterion", () => {
  const clean = buildBetaReadiness({ devices: [], commands: [{ userId: "u", status: "completed" }] });
  assert.equal(clean.checks.find((check) => check.id === "zero_unauthenticated_execution").status, "pass");

  const dirty = buildBetaReadiness({ devices: [], commands: [{ status: "completed" }] });
  assert.equal(dirty.checks.find((check) => check.id === "zero_unauthenticated_execution").status, "fail");
});

test("the beta readiness endpoint reports live store state", async (t) => {
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const auth = await requestJson(baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_dev", email: "dev@example.local" },
  });
  const readiness = await requestJson(baseUrl, "/v1/observability/beta-readiness", {
    headers: { authorization: `Bearer ${auth.apiToken.secret}` },
  });

  assert.equal(readiness.ready, false);
  assert.ok(readiness.checks.length >= 6);
  assert.ok(readiness.blockers.includes("paired_device_days"));
});

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
