import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { createRateLimiter } from "../src/rateLimit.mjs";

// The device realm's snapshot cache and single-flight, and the response bundles that remove
// round trips. Real createApp() on an ephemeral port; globalThis.fetch is the fake T3 and counts
// what actually crosses to it.

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function requestJson(fetchImpl, baseUrl, path, { method = "GET", headers = {}, body } = {}) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function ownerHeaders(fetchImpl, baseUrl, userId) {
  const created = await requestJson(fetchImpl, baseUrl, "/v1/users/dev", {
    method: "POST", body: { userId, email: `${userId}@example.local` },
  });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}

const THREADS = [
  { id: "thread_a", title: "Alpha", projectId: "p1", session: { status: "stopped" } },
  { id: "thread_b", title: "Beta", projectId: "p1", session: { status: "stopped" } },
];

/**
 * A gateway, a fake T3 per host, and counters for what reached it. `hosts` maps a hostname to the
 * threads that T3 currently has, mutable so a test can change T3 behind the gateway's back.
 */
async function setup(t, {
  hosts = { "t3-a.example": { threads: [...THREADS] } },
  configOverrides = {},
  rateLimiter = createRateLimiter(),
  snapshotDelayMs = 0,
  details = {},
  logger = undefined,
} = {}) {
  const originalFetch = globalThis.fetch;
  const calls = { snapshot: {}, detail: {}, dispatch: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const host = parsed.hostname;
    if (!(host in hosts)) return originalFetch(url, init);
    if (parsed.pathname === "/api/orchestration/snapshot") {
      calls.snapshot[host] = (calls.snapshot[host] ?? 0) + 1;
      if (snapshotDelayMs) await new Promise((resolve) => setTimeout(resolve, snapshotDelayMs));
      return jsonResponse({ projects: [{ id: "p1" }], threads: hosts[host].threads }, 200);
    }
    if (parsed.pathname === "/api/orchestration/dispatch") {
      calls.dispatch += 1;
      return jsonResponse({ accepted: true }, 200);
    }
    const detail = parsed.pathname.match(/^\/api\/orchestration\/threads\/([^/]+)$/u);
    if (detail) {
      calls.detail[detail[1]] = (calls.detail[detail[1]] ?? 0) + 1;
      const thread = details[detail[1]] ?? hosts[host].threads.find((candidate) => candidate.id === detail[1]);
      return thread ? jsonResponse({ snapshotSequence: 1, thread }, 200) : jsonResponse({ error: "none" }, 404);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const config = { ...loadConfig(), ...configOverrides };
  const app = createApp({ config, rateLimiter, ...(logger ? { logger } : {}) });
  await listen(app.server);
  t.after(() => app.server.close());
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  async function addOwner(userId, host, label = userId) {
    const owner = await ownerHeaders(originalFetch, baseUrl, userId);
    const device = await requestJson(originalFetch, baseUrl, "/v1/devices", {
      method: "POST", headers: owner, body: { label: `${label} controller`, profile: "next-coder" },
    });
    const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
      method: "POST", headers: owner,
      body: { label: `${label} T3`, baseUrl: `https://${host}`, accessToken: `${userId}-token` },
    });
    await requestJson(originalFetch, baseUrl, `/v1/devices/${device.device.id}/config`, {
      method: "PUT", headers: owner, body: { environmentId: environment.environment.id, threadId: "thread_a" },
    });
    return {
      userId,
      owner,
      deviceId: device.device.id,
      environmentId: environment.environment.id,
      deviceHeaders: { "x-device-id": device.device.id, "x-device-secret": device.secret },
    };
  }

  const get = (who, path) => requestJson(originalFetch, baseUrl, path, { headers: who.deviceHeaders });
  const post = (who, path, body) => requestJson(originalFetch, baseUrl, path, { method: "POST", headers: who.deviceHeaders, body });
  const snapshotCount = (host = "t3-a.example") => calls.snapshot[host] ?? 0;
  return { app, calls, hosts, baseUrl, originalFetch, addOwner, get, post, snapshotCount, config };
}

test("a second device read inside the window is served without another trip to T3", async (t) => {
  const s = await setup(t);
  const device = await s.addOwner("user_a", "t3-a.example");
  const baseline = s.snapshotCount();
  const first = await s.get(device, "/v1/device/threads");
  const second = await s.get(device, "/v1/device/threads");
  assert.equal(s.snapshotCount() - baseline, 1, "one upstream fetch served both reads");
  assert.deepEqual(second.threads, first.threads);
});

test("concurrent reads from the same environment share one upstream fetch", async (t) => {
  const s = await setup(t, { snapshotDelayMs: 40 });
  const device = await s.addOwner("user_a", "t3-a.example");
  const baseline = s.snapshotCount();
  const results = await Promise.all([
    s.get(device, "/v1/device/threads"),
    s.get(device, "/v1/device/threads"),
    s.get(device, "/v1/device/projects"),
    s.get(device, "/v1/device/threads"),
  ]);
  assert.equal(s.snapshotCount() - baseline, 1);
  assert.equal(results[0].threads.length, 2);
  assert.equal(results[2].projects[0].id, "p1");
});

test("an expired entry is fetched again", async (t) => {
  const s = await setup(t, { configOverrides: { deviceReadCache: { listTtlMs: 40, validateTtlMs: 40 } } });
  const device = await s.addOwner("user_a", "t3-a.example");
  const baseline = s.snapshotCount();
  await s.get(device, "/v1/device/threads");
  await new Promise((resolve) => setTimeout(resolve, 80));
  await s.get(device, "/v1/device/threads");
  assert.equal(s.snapshotCount() - baseline, 2);
});

test("a TTL of zero keeps single-flight but stores nothing", async (t) => {
  const s = await setup(t, { configOverrides: { deviceReadCache: { listTtlMs: 0, validateTtlMs: 0 } } });
  const device = await s.addOwner("user_a", "t3-a.example");
  const baseline = s.snapshotCount();
  await s.get(device, "/v1/device/threads");
  await s.get(device, "/v1/device/threads");
  assert.equal(s.snapshotCount() - baseline, 2);
});

test("a dispatch to T3 invalidates: the next read sees what the write changed", async (t) => {
  const s = await setup(t);
  const device = await s.addOwner("user_a", "t3-a.example");
  await s.get(device, "/v1/device/threads");
  // T3 gains a thread as a result of something the gateway does (a console dispatch here).
  s.hosts["t3-a.example"].threads.push({ id: "thread_c", title: "Gamma", projectId: "p1", session: { status: "stopped" } });
  await requestJson(s.originalFetch, s.baseUrl, "/v1/intents", {
    method: "POST",
    headers: device.owner,
    body: {
      environmentId: device.environmentId,
      threadId: "thread_a",
      intent: { type: "agent_prompt", text: "make a thread" },
    },
  });
  assert.equal(s.calls.dispatch, 1);
  const afterWrite = s.snapshotCount();
  const listed = await s.get(device, "/v1/device/threads");
  assert.equal(s.snapshotCount() - afterWrite, 1, "the dispatch dropped the stored snapshot");
  assert.ok(listed.threads.some((thread) => thread.id === "thread_c"));
  await s.get(device, "/v1/device/threads");
  assert.equal(s.snapshotCount() - afterWrite, 1, "and the fresh answer is then reused");
});

test("selecting a thread is never answered with the old binding", async (t) => {
  const s = await setup(t);
  const device = await s.addOwner("user_a", "t3-a.example");
  const before = await s.get(device, "/v1/device/threads");
  assert.equal(before.threads.find((thread) => thread.selected).id, "thread_a");
  const baseline = s.snapshotCount();

  await s.post(device, "/v1/device/config/thread", { threadId: "thread_b" });
  const config = await s.get(device, "/v1/device/config");
  assert.equal(config.config.threadId, "thread_b", "config is never cached");

  const after = await s.get(device, "/v1/device/threads");
  assert.equal(after.threadId, "thread_b");
  assert.equal(after.threads.find((thread) => thread.selected).id, "thread_b",
    "the cached snapshot is projected through the CURRENT binding");
  assert.equal(s.snapshotCount() - baseline <= 1, true, "selection used the stored snapshot, not a trip per read");
});

test("a thread created since the snapshot was stored is found, not 404ed", async (t) => {
  const s = await setup(t);
  const device = await s.addOwner("user_a", "t3-a.example");
  await s.get(device, "/v1/device/threads"); // stores a snapshot without thread_new
  s.hosts["t3-a.example"].threads.push({ id: "thread_new", title: "New", projectId: "p1", session: { status: "stopped" } });
  const selected = await s.post(device, "/v1/device/config/thread", { threadId: "thread_new" });
  assert.equal(selected.config.threadId, "thread_new");
});

test("a thread that does not exist is still refused", async (t) => {
  const s = await setup(t);
  const device = await s.addOwner("user_a", "t3-a.example");
  await s.get(device, "/v1/device/threads");
  const response = await s.originalFetch(new URL("/v1/device/config/thread", s.baseUrl), {
    method: "POST",
    headers: { ...device.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({ threadId: "thread_invented" }),
  });
  assert.equal(response.status, 404);
});

test("two owners never see each other's data, even interleaved against one cache", async (t) => {
  const s = await setup(t, {
    hosts: {
      "t3-a.example": { threads: [{ id: "thread_a", title: "Owner A secret", projectId: "p1" }] },
      "t3-b.example": { threads: [{ id: "thread_a", title: "Owner B secret", projectId: "p1" }] },
    },
    snapshotDelayMs: 15,
  });
  const a = await s.addOwner("user_a", "t3-a.example");
  const b = await s.addOwner("user_b", "t3-b.example");
  const baseA = s.snapshotCount("t3-a.example");
  const baseB = s.snapshotCount("t3-b.example");
  const results = await Promise.all([
    s.get(a, "/v1/device/threads"),
    s.get(b, "/v1/device/threads"),
    s.get(a, "/v1/device/threads"),
    s.get(b, "/v1/device/threads"),
  ]);
  assert.deepEqual(results.map((result) => result.threads[0].title),
    ["Owner A secret", "Owner B secret", "Owner A secret", "Owner B secret"]);
  assert.equal(s.snapshotCount("t3-a.example") - baseA, 1);
  assert.equal(s.snapshotCount("t3-b.example") - baseB, 1);
  const text = JSON.stringify(results);
  assert.equal(text.includes("Owner B secret") && results[0].threads[0].title === "Owner B secret", false);
});

test("a device cannot read through an environment that is not its owner's", async (t) => {
  const s = await setup(t, {
    hosts: {
      "t3-a.example": { threads: [{ id: "thread_a", title: "A", projectId: "p1" }] },
      "t3-b.example": { threads: [{ id: "thread_a", title: "B", projectId: "p1" }] },
    },
  });
  const a = await s.addOwner("user_a", "t3-a.example");
  const b = await s.addOwner("user_b", "t3-b.example");
  await s.get(b, "/v1/device/threads"); // B's snapshot is now warm
  const response = await s.originalFetch(new URL(`/v1/device/threads?environmentId=${b.environmentId}`, s.baseUrl), {
    headers: a.deviceHeaders,
  });
  assert.equal(response.status, 404, "A asking for B's environment id is refused before any cache is consulted");
});

test("authentication and rate limiting still run on a cached read", async (t) => {
  const checks = [];
  const inner = createRateLimiter();
  const rateLimiter = { check: async (input) => { checks.push(input.key); return await inner.check(input); } };
  const s = await setup(t, { rateLimiter });
  const device = await s.addOwner("user_a", "t3-a.example");
  await s.get(device, "/v1/device/threads");
  const baseline = s.snapshotCount();
  const readChecksBefore = checks.filter((key) => key.startsWith("device:read:")).length;

  await s.get(device, "/v1/device/threads"); // a cache hit
  assert.equal(s.snapshotCount() - baseline, 0, "this one was served from the cache");
  assert.equal(checks.filter((key) => key.startsWith("device:read:")).length - readChecksBefore, 1,
    "the device read limit was still charged");

  const wrongSecret = await s.originalFetch(new URL("/v1/device/threads", s.baseUrl), {
    headers: { "x-device-id": device.deviceId, "x-device-secret": "not-the-secret" },
  });
  assert.equal(wrongSecret.status, 401, "a warm cache does not stand in for credentials");
  const noCredentials = await s.originalFetch(new URL("/v1/device/threads", s.baseUrl));
  assert.ok([400, 401].includes(noCredentials.status));
});

test("a rate-limited device is refused even when its answer is cached", async (t) => {
  const s = await setup(t, { configOverrides: { rateLimits: { ...loadConfig().rateLimits, deviceRead: 3 } } });
  const device = await s.addOwner("user_a", "t3-a.example");
  const statuses = [];
  for (let index = 0; index < 6; index += 1) {
    const response = await s.originalFetch(new URL("/v1/device/threads", s.baseUrl), { headers: device.deviceHeaders });
    statuses.push(response.status);
  }
  assert.equal(statuses[0], 200);
  assert.ok(statuses.includes(429), `limit enforced on cached reads: ${statuses.join(",")}`);
});

test("revoking a device is immediate even with a warm cache", async (t) => {
  const s = await setup(t);
  const device = await s.addOwner("user_a", "t3-a.example");
  await s.get(device, "/v1/device/threads");
  await requestJson(s.originalFetch, s.baseUrl, `/v1/devices/${device.deviceId}/revoke`, {
    method: "POST", headers: device.owner, body: {},
  });
  const baseline = s.snapshotCount();
  const response = await s.originalFetch(new URL("/v1/device/threads", s.baseUrl), { headers: device.deviceHeaders });
  assert.equal(response.status, 401);
  assert.equal(s.snapshotCount(), baseline);
});

test("changing an environment or its connector drops what was stored for it", async (t) => {
  const s = await setup(t);
  const device = await s.addOwner("user_a", "t3-a.example");
  await s.get(device, "/v1/device/threads");
  const warm = s.snapshotCount();
  await s.get(device, "/v1/device/threads");
  assert.equal(s.snapshotCount(), warm, "warm: the second read was a hit");

  // Archive then restore: the environment is back, the stored answer must not be.
  await s.app.store.archiveEnvironment({ userId: device.userId, environmentId: device.environmentId });
  await s.app.store.restoreEnvironment({ userId: device.userId, environmentId: device.environmentId });
  await requestJson(s.originalFetch, s.baseUrl, `/v1/devices/${device.deviceId}/config`, {
    method: "PUT", headers: device.owner, body: { environmentId: device.environmentId, threadId: "thread_a" },
  });
  const afterRestore = s.snapshotCount();
  await s.get(device, "/v1/device/threads");
  assert.equal(s.snapshotCount() - afterRestore, 1, "the write dropped the cache even though the TTL had not run out");

  // A connector revocation is the same kind of write.
  await s.get(device, "/v1/device/threads");
  assert.equal(s.snapshotCount() - afterRestore, 1, "warm again");
  await s.app.store.revokeConnector({ userId: device.userId, connectorId: "conn_does_not_matter" });
  await s.get(device, "/v1/device/threads");
  assert.equal(s.snapshotCount() - afterRestore, 2, "revocation attempts drop the cache too");
});

test("approvals ask T3 for a thread's detail once, not once per kind of request", async (t) => {
  const s = await setup(t, { snapshotDelayMs: 0 });
  const device = await s.addOwner("user_a", "t3-a.example");
  const before = s.calls.detail.thread_a ?? 0;
  const approvals = await s.get(device, "/v1/device/approvals");
  assert.equal((s.calls.detail.thread_a ?? 0) - before, 1, "provider approvals and agent questions share one detail read");
  assert.deepEqual(approvals.providerApprovals, []);
  assert.deepEqual(approvals.userInputRequests, []);
  assert.ok(Array.isArray(approvals.commands));
});

test("the reply path never serves a stored snapshot", async (t) => {
  const s = await setup(t);
  const device = await s.addOwner("user_a", "t3-a.example");
  await s.get(device, "/v1/device/threads"); // stores a snapshot
  const baseline = s.snapshotCount();
  await s.get(device, "/v1/device/thread-output");
  await s.get(device, "/v1/device/thread-output");
  assert.equal(s.snapshotCount() - baseline, 2, "each reply read asked T3 itself");
});

test("a failing snapshot on the reply path does not leave an unhandled rejection behind", async (t) => {
  const s = await setup(t, { hosts: { "t3-a.example": { threads: [] } } });
  const device = await s.addOwner("user_a", "t3-a.example");
  await requestJson(s.originalFetch, s.baseUrl, `/v1/devices/${device.deviceId}/controls`, {
    method: "PUT", headers: device.owner, body: { controls: [{ kind: "status" }, { kind: "stop" }] },
  });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const response = await s.originalFetch(new URL("/v1/device/thread-output", s.baseUrl), { headers: device.deviceHeaders });
  assert.equal(response.status, 404);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(unhandled, []);
});

// ---------------------------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------------------------

test("a selection can carry the config, controls and approvals the device would ask for next", async (t) => {
  const s = await setup(t);
  const device = await s.addOwner("user_a", "t3-a.example");
  await requestJson(s.originalFetch, s.baseUrl, `/v1/devices/${device.deviceId}/controls`, {
    method: "PUT", headers: device.owner, body: { controls: [{ kind: "status" }, { kind: "stop" }] },
  });

  const plain = await s.post(device, "/v1/device/config/thread", { threadId: "thread_b" });
  assert.deepEqual(Object.keys(plain).sort(), ["config", "deviceId"], "no include, no change in shape");

  const bundled = await s.post(device, "/v1/device/config/thread", {
    threadId: "thread_a", include: ["config", "controls", "approvals"],
  });
  assert.equal(bundled.config.threadId, "thread_a");
  const [config, controls, approvals] = await Promise.all([
    s.get(device, "/v1/device/config"),
    s.get(device, "/v1/device/controls"),
    s.get(device, "/v1/device/approvals"),
  ]);
  assert.deepEqual(bundled.bundle.config, config, "the bundled section IS the config route's body");
  assert.deepEqual(bundled.bundle.controls, controls, "and the controls route's");
  assert.deepEqual(bundled.bundle.approvals, approvals, "and the approvals route's");
  assert.equal(bundled.bundleErrors, undefined);
});

test("a bundled section reflects the NEW binding, not the one the request arrived with", async (t) => {
  const s = await setup(t);
  const device = await s.addOwner("user_a", "t3-a.example"); // bound to thread_a
  const bundled = await s.post(device, "/v1/device/config/thread", { threadId: "thread_b", include: ["config"] });
  assert.equal(bundled.bundle.config.config.threadId, "thread_b");
});

test("a device without a controls layout gets an explicit null, and unknown sections are ignored", async (t) => {
  const s = await setup(t);
  const device = await s.addOwner("user_a", "t3-a.example");
  const bundled = await s.post(device, "/v1/device/config/thread", {
    threadId: "thread_b", include: ["controls", "owner-secrets", "__proto__"],
  });
  assert.deepEqual(Object.keys(bundled.bundle), ["controls"]);
  assert.equal(bundled.bundle.controls, null);
});

test("a bundle never asks for more than the device's own authority", async (t) => {
  const s = await setup(t);
  const device = await s.addOwner("user_a", "t3-a.example");
  const readOnly = await requestJson(s.originalFetch, s.baseUrl, "/v1/devices", {
    method: "POST", headers: device.owner, body: { label: "Viewer", profile: "read-only" },
  });
  await requestJson(s.originalFetch, s.baseUrl, `/v1/devices/${readOnly.device.id}/config`, {
    method: "PUT", headers: device.owner, body: { environmentId: device.environmentId, threadId: "thread_a" },
  });
  const viewer = { deviceHeaders: { "x-device-id": readOnly.device.id, "x-device-secret": readOnly.secret } };
  const bundled = await s.post(viewer, "/v1/device/config/thread", { threadId: "thread_b", include: ["approvals"] });
  const standalone = await s.get(viewer, "/v1/device/approvals");
  assert.deepEqual(bundled.bundle.approvals, standalone);
  assert.equal(bundled.bundle.approvals.canAnswerUserInput, false);
});

test("the Threads screen can ask for the environments and projects in the same response", async (t) => {
  const s = await setup(t);
  const device = await s.addOwner("user_a", "t3-a.example");
  const plain = await s.get(device, "/v1/device/threads");
  assert.equal("bundle" in plain, false);

  const baseline = s.snapshotCount();
  const bundled = await s.get(device, "/v1/device/threads?include=environments,projects,bogus");
  assert.equal(s.snapshotCount() - baseline <= 1, true, "projects came from the snapshot already in hand");
  const [environments, projects] = await Promise.all([
    s.get(device, "/v1/device/environments"),
    s.get(device, "/v1/device/projects"),
  ]);
  assert.deepEqual(bundled.bundle.environments, environments);
  assert.deepEqual(bundled.bundle.projects, projects);
  assert.deepEqual(Object.keys(bundled.bundle).sort(), ["environments", "projects"]);
  assert.deepEqual(bundled.threads, plain.threads);
});

// ---------------------------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------------------------

test("device responses carry a Server-Timing header with no identifiers in it", async (t) => {
  const s = await setup(t);
  const device = await s.addOwner("user_a", "t3-a.example");
  const response = await s.originalFetch(new URL("/v1/device/threads", s.baseUrl), { headers: device.deviceHeaders });
  assert.equal(response.status, 200);
  const header = response.headers.get("server-timing");
  assert.match(header, /auth;dur=[\d.]+/u);
  assert.match(header, /store;dur=[\d.]+;desc="n=\d+"/u);
  assert.match(header, /t3;dur=[\d.]+;desc="n=\d+ hit=\d+ join=\d+ miss=\d+"/u);
  assert.match(header, /total;dur=[\d.]+/u);
  for (const secret of [device.deviceId, device.environmentId, device.userId, "thread_a", "t3-a.example"]) {
    assert.equal(header.includes(secret), false, `header must not contain ${secret}`);
  }
  assert.match(header, /miss=1|hit=1|join=1/u, "it says whether the T3 read was cached");
});

test("the header says hit on a cached read and counts store calls", async (t) => {
  const s = await setup(t);
  const device = await s.addOwner("user_a", "t3-a.example");
  await s.originalFetch(new URL("/v1/device/threads", s.baseUrl), { headers: device.deviceHeaders });
  const second = await s.originalFetch(new URL("/v1/device/threads", s.baseUrl), { headers: device.deviceHeaders });
  assert.match(second.headers.get("server-timing"), /hit=1 join=0 miss=0/u);
  const display = await s.originalFetch(new URL("/v1/device/display", s.baseUrl), { headers: device.deviceHeaders });
  assert.match(display.headers.get("server-timing"), /t3;dur=0;desc="n=0 /u, "display never touches T3");
});

test("non-device routes and refused requests carry no per-phase leakage", async (t) => {
  const s = await setup(t);
  const health = await s.originalFetch(new URL("/health", s.baseUrl));
  assert.equal(health.headers.get("server-timing"), null);
  const refused = await s.originalFetch(new URL("/v1/device/threads", s.baseUrl), {
    headers: { "x-device-id": "dev_x", "x-device-secret": "nope" },
  });
  assert.equal(refused.status, 401);
  assert.ok(refused.headers.get("server-timing"), "even a refusal says where its time went");
});

test("the optional timing log names a route template and never an identifier", async (t) => {
  const lines = [];
  const s = await setup(t, {
    configOverrides: { deviceTimingLog: "all" },
    logger: { info: (line) => lines.push(String(line)), warn() {}, error() {}, log: (line) => lines.push(String(line)) },
  });
  const device = await s.addOwner("user_a", "t3-a.example");
  await s.get(device, "/v1/device/threads");
  await s.originalFetch(new URL("/v1/device/approvals/cmd_secret_123/approve", s.baseUrl), {
    method: "POST", headers: { ...device.deviceHeaders, "content-type": "application/json" }, body: "{}",
  });
  const timingLines = lines.filter((line) => line.startsWith("[device-timing]"));
  assert.ok(timingLines.some((line) => line.includes("GET /v1/device/threads 200")));
  assert.ok(timingLines.some((line) => line.includes("/v1/device/approvals/:id/approve")));
  for (const line of timingLines) {
    for (const secret of [device.deviceId, device.environmentId, "cmd_secret_123", "thread_a"]) {
      assert.equal(line.includes(secret), false, `log line must not contain ${secret}`);
    }
  }
});
