import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createMemoryStore } from "../src/store.mjs";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const WEBM_BASE64 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString("base64");

test("device intent endpoint authenticates device and dispatches to T3", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({ projects: [{ id: "p1" }], threads: [{ id: "t1" }] }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Test controller", profile: "next-coder" },
  });

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_1",
      intent: { type: "agent_prompt", text: "Run the tests." },
    },
  });

  assert.equal(dispatched.command.status, "dispatched");
  assert.equal(typeof dispatched.command.metrics.acknowledgementDurationMs, "number");
  assert.equal(typeof dispatched.command.metrics.dispatchDurationMs, "number");
  assert.match(dispatched.command.metrics.completedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(dispatched.command.metrics.failureAt, null);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].type, "thread.turn.start");
  assert.equal(dispatches[0].message.text, "Run the tests.");
});

test("failed T3 dispatches are recorded with command metrics", async (t) => {
  const originalFetch = globalThis.fetch;
  let dispatchCalls = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatchCalls += 1;
      return jsonResponse({ error: "temporary outage" }, 503);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Failing controller", profile: "next-coder" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Failing T3",
      baseUrl: "https://failing-t3.example",
      accessToken: "mock-token",
    },
  });

  const response = await originalFetch(new URL("/v1/device/intents", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: JSON.stringify({
      environmentId: environment.environment.id,
      threadId: "thread_fail",
      intent: { type: "agent_prompt", text: "This dispatch will fail." },
    }),
  });
  const failed = await response.json();

  assert.equal(response.status, 502);
  assert.equal(dispatchCalls, 1);
  assert.equal(failed.error.details.command.status, "failed");
  assert.equal(failed.error.details.command.result.error, "t3_dispatch_failed");
  assert.match(failed.error.details.command.result.message, /HTTP 503/u);
  assert.equal(typeof failed.error.details.command.metrics.acknowledgementDurationMs, "number");
  assert.equal(typeof failed.error.details.command.metrics.dispatchDurationMs, "number");
  assert.equal(failed.error.details.command.metrics.completedAt, null);
  assert.match(failed.error.details.command.metrics.failureAt, /^\d{4}-\d{2}-\d{2}T/u);

  const events = await requestJson(originalFetch, baseUrl, `/v1/commands/${failed.error.details.command.id}/events`, {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0].status, "failed");
  assert.equal(events.events[0].metrics.failureAt, failed.error.details.command.metrics.failureAt);
});

test("dangerous shell input requires user approval before T3 dispatch", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Shell controller", profile: "next-coder" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const pending = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_shell",
      intent: { type: "shell_input", command: "rm -rf build" },
    },
  });

  assert.equal(pending.command.status, "approval_required");
  assert.equal(pending.command.risk, "high");
  assert.equal(pending.policy.requiresApproval, true);
  assert.equal(dispatches.length, 0);

  const pendingEvents = await requestJson(originalFetch, baseUrl, `/v1/commands/${pending.command.id}/events`, {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(pendingEvents.events.length, 1);
  assert.equal(pendingEvents.events[0].status, "approval_required");
  assert.equal(pendingEvents.events[0].previousStatus, null);

  const commands = await requestJson(originalFetch, baseUrl, "/v1/commands", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(commands.commands.length, 1);
  assert.equal(commands.commands[0].id, pending.command.id);

  const approved = await requestJson(originalFetch, baseUrl, `/v1/commands/${pending.command.id}/approve`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(approved.command.status, "dispatched");
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0].message.text, /rm -rf build/u);

  const approvedEvents = await requestJson(originalFetch, baseUrl, `/v1/commands/${pending.command.id}/events`, {
    method: "GET",
    headers: authHeaders,
  });
  assert.deepEqual(approvedEvents.events.map((event) => event.status), ["approval_required", "dispatched"]);
  assert.equal(approvedEvents.events[1].previousStatus, "approval_required");

  const secondPending = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_shell",
      intent: { type: "shell_input", command: "git push origin main" },
    },
  });
  assert.equal(secondPending.command.status, "approval_required");

  const rejected = await requestJson(originalFetch, baseUrl, `/v1/commands/${secondPending.command.id}/reject`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(rejected.command.status, "rejected");
  assert.equal(dispatches.length, 1);

  const rejectedEvents = await requestJson(originalFetch, baseUrl, `/v1/commands/${secondPending.command.id}/events`, {
    method: "GET",
    headers: authHeaders,
  });
  assert.deepEqual(rejectedEvents.events.map((event) => event.status), ["approval_required", "rejected"]);
});

test("claimed devices can list, approve, and reject pending commands", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Approval controller", profile: "next-coder" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });
  const deviceHeaders = {
    "x-device-id": created.device.id,
    "x-device-secret": created.secret,
  };

  const approvePending = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: deviceHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_device_approval",
      intent: { type: "shell_input", command: "rm -rf build" },
    },
  });
  const rejectPending = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: deviceHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_device_approval",
      intent: { type: "shell_input", command: "git push origin main" },
    },
  });

  const approvals = await requestJson(originalFetch, baseUrl, "/v1/device/approvals", {
    method: "GET",
    headers: deviceHeaders,
  });
  assert.equal(approvals.commands.length, 2);
  assert.equal(approvals.commands[0].status, "approval_required");

  const approved = await requestJson(
    originalFetch,
    baseUrl,
    `/v1/device/approvals/${approvePending.command.id}/approve`,
    { method: "POST", headers: deviceHeaders, body: {} },
  );
  assert.equal(approved.command.status, "dispatched");
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0].message.text, /rm -rf build/u);

  const rejected = await requestJson(
    originalFetch,
    baseUrl,
    `/v1/device/approvals/${rejectPending.command.id}/reject`,
    { method: "POST", headers: deviceHeaders, body: {} },
  );
  assert.equal(rejected.command.status, "rejected");
  assert.equal(dispatches.length, 1);
});

test("status intent returns compressed T3 state", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({ projects: [{ id: "p1" }], threads: [{ id: "t1" }, { id: "t2" }] }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Test controller", profile: "next-coder" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const status = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      environmentId: environment.environment.id,
      intent: { type: "status" },
    },
  });

  assert.equal(status.screen.line1, "1 projects");
  assert.equal(status.screen.line2, "2 threads");
});

test("T3 environment health checks record reachable and unreachable status", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot" && parsed.hostname === "healthy-t3.example") {
      return jsonResponse({ projects: [{ id: "p1" }, { id: "p2" }], threads: [{ id: "t1" }] }, 200);
    }
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({ error: "down" }, 503);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const healthy = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Healthy T3",
      baseUrl: "https://healthy-t3.example",
      accessToken: "mock-token",
    },
  });
  const unhealthy = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Unhealthy T3",
      baseUrl: "https://unhealthy-t3.example",
      accessToken: "mock-token",
    },
  });

  const reachable = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${healthy.environment.id}/check`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(reachable.environment.status, "reachable");
  assert.equal(reachable.environment.health.snapshot.line1, "2 projects");
  assert.equal(reachable.environment.health.snapshot.line2, "1 threads");
  assert.equal(reachable.environment.health.lastError, null);
  assert.match(reachable.environment.health.lastCheckedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(reachable.environment.health.lastReachableAt, reachable.environment.health.lastCheckedAt);

  const unreachable = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${unhealthy.environment.id}/check`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(unreachable.environment.status, "unreachable");
  assert.match(unreachable.error, /HTTP 503/u);
  assert.match(unreachable.environment.health.lastError, /HTTP 503/u);
  assert.equal(unreachable.environment.health.lastReachableAt, null);
  // A 503 is the host answering while it cannot serve; nothing about it names a cause.
  assert.equal(unreachable.reason, "unknown");
  assert.equal(unreachable.failure.retryable, true);

  const environments = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "GET",
    headers: authHeaders,
  });
  assert.deepEqual(
    environments.environments.map((environment) => environment.status).sort(),
    ["reachable", "unreachable"],
  );
});

test("T3 environment snapshot exposes projects and threads for session selection", async (t) => {
  const originalFetch = globalThis.fetch;
  const snapshots = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      snapshots.push({
        origin: parsed.origin,
        authorization: init.headers?.authorization,
      });
      return jsonResponse({
        projects: [{ id: "project_1", title: "Next Coder" }],
        threads: [{ id: "thread_1", title: "Implementation", projectId: "project_1" }],
      }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Snapshot T3",
      baseUrl: "https://snapshot-t3.example",
      accessToken: "snapshot-token",
    },
  });

  const snapshot = await requestJson(
    originalFetch,
    baseUrl,
    `/v1/t3/environments/${environment.environment.id}/snapshot`,
    {
      method: "GET",
      headers: authHeaders,
    },
  );

  assert.equal(snapshot.snapshot.projects[0].id, "project_1");
  assert.equal(snapshot.snapshot.threads[0].id, "thread_1");
  assert.equal(snapshot.screen.line1, "1 projects");
  assert.equal(snapshot.screen.line2, "1 threads");
  assert.equal(snapshot.environment.status, "reachable");
  assert.equal(snapshot.environment.health.snapshot.line2, "1 threads");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].origin, "https://snapshot-t3.example");
  assert.equal(snapshots[0].authorization, "Bearer snapshot-token");
});

test("T3 compatibility checks detect version changes and persist breaking-risk alerts", async (t) => {
  const originalFetch = globalThis.fetch;
  let serverVersion = "0.0.33";
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "registry.npmjs.org") {
      return jsonResponse({ version: "0.0.33" }, 200);
    }
    if (parsed.pathname === "/.well-known/t3/environment") {
      return jsonResponse({ serverVersion }, 200);
    }
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({ projects: [], threads: [] }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({
    config: { demoMode: false },
    t3CompatibilityRpc: async () => ({ providers: [] }),
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);
  await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Compatibility T3",
      baseUrl: "https://compatibility-t3.example",
      accessToken: "compatibility-token",
    },
  });

  const first = await requestJson(originalFetch, baseUrl, "/v1/settings/t3-compatibility", {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(first.release.latestVersion, "0.0.33");
  assert.equal(first.release.status, "review_required");
  assert.equal(first.results[0].installedVersion, "0.0.33");
  assert.equal(first.results[0].versionChanged, false);

  serverVersion = "0.0.34";
  const changed = await requestJson(originalFetch, baseUrl, "/v1/settings/t3-compatibility", {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(changed.results[0].previousVersion, "0.0.33");
  assert.equal(changed.results[0].versionChanged, true);
  assert.equal(changed.results[0].breakingRisk, true);

  const saved = await requestJson(originalFetch, baseUrl, "/v1/settings/t3-compatibility", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(saved.results[0].installedVersion, "0.0.34");
  assert.equal(saved.summary.breakingRisks, 1);

  const alerts = await requestJson(originalFetch, baseUrl, "/v1/observability/alerts", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(alerts.alerts.some((alert) => alert.id === "environment.t3_compatibility_breaking"), true);
});

test("web users can launch the first T3 thread with any provider instance", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({
        projects: [{
          id: "project_tacs",
          title: "Tacs",
          workspaceRoot: "/projects/Tacs",
          defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
        }],
        threads: [],
      }, 200);
    }
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ accepted: true }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Launch T3",
      baseUrl: "https://launch-t3.example",
      accessToken: "launch-token",
    },
  });
  const eventResponse = await originalFetch(new URL("/v1/events", baseUrl), { headers: authHeaders });
  assert.equal(eventResponse.status, 200);
  const createdEvent = readStreamUntil(eventResponse.body, '"action":"created"');

  const launched = await requestJson(
    originalFetch,
    baseUrl,
    `/v1/t3/environments/${environment.environment.id}/threads`,
    {
      method: "POST",
      headers: authHeaders,
      body: {
        projectId: "project_tacs",
        text: "Inspect the Tacs project and report that this remote session works.",
        modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5" },
      },
    },
  );

  assert.match(launched.threadId, /^thread_/u);
  assert.equal(launched.command.status, "dispatched");
  assert.deepEqual(launched.modelSelection, {
    instanceId: "claudeAgent",
    model: "claude-sonnet-5",
  });
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[0].type, "thread.create");
  assert.equal(dispatches[0].threadId, launched.threadId);
  assert.equal(dispatches[0].projectId, "project_tacs");
  assert.equal(dispatches[0].modelSelection.instanceId, "claudeAgent");
  assert.equal(dispatches[1].type, "thread.turn.start");
  assert.equal(dispatches[1].threadId, launched.threadId);
  const stream = await createdEvent;
  assert.match(stream, /event: threads\.changed/u);
  assert.match(stream, new RegExp(`"threadId":"${launched.threadId}"`, "u"));
});

test("web users can rename, archive, and delete their T3 threads", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ accepted: true }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Managed T3",
      baseUrl: "https://managed-t3.example",
      accessToken: "managed-token",
    },
  });
  const controllers = await Promise.all(["Desk controller", "Kitchen controller"].map((label) =>
    requestJson(originalFetch, baseUrl, "/v1/devices", {
      method: "POST",
      headers: authHeaders,
      body: { label, profile: "next-coder" },
    })));
  await Promise.all(controllers.map(({ device }) =>
    requestJson(originalFetch, baseUrl, `/v1/devices/${device.id}/config`, {
      method: "PUT",
      headers: authHeaders,
      body: { environmentId: environment.environment.id, threadId: "thread_managed" },
    })));
  const eventResponses = await Promise.all(controllers.map(({ device, secret }) =>
    originalFetch(new URL("/v1/device/events", baseUrl), {
      headers: { "x-device-id": device.id, "x-device-secret": secret },
    })));
  const deviceEvents = eventResponses.map((response) => {
    assert.equal(response.status, 200);
    return readStreamUntil(response.body, '"action":"deleted"');
  });
  const prefix = `/v1/t3/environments/${environment.environment.id}/threads/thread_managed`;

  const renamed = await requestJson(originalFetch, baseUrl, prefix, {
    method: "PATCH",
    headers: authHeaders,
    body: { title: "  Release   checklist  " },
  });
  const archived = await requestJson(originalFetch, baseUrl, `${prefix}/archive`, {
    method: "POST",
    headers: authHeaders,
  });
  const deleted = await requestJson(originalFetch, baseUrl, prefix, {
    method: "DELETE",
    headers: authHeaders,
  });

  assert.equal(renamed.action, "renamed");
  assert.equal(renamed.title, "Release checklist");
  assert.equal(archived.action, "archived");
  assert.equal(deleted.action, "deleted");
  assert.deepEqual(dispatches.map((command) => command.type), [
    "thread.meta.update",
    "thread.archive",
    "thread.delete",
  ]);
  assert.equal(dispatches[0].title, "Release checklist");
  assert.equal(dispatches[0].threadId, "thread_managed");
  assert.match(dispatches[0].commandId, /^t3cmd_/u);

  for (const stream of await Promise.all(deviceEvents)) {
    assert.equal((stream.match(/event: threads\.changed/gu) ?? []).length, 3);
    assert.match(stream, /"action":"renamed","title":"Release checklist"/u);
    assert.match(stream, /"action":"archived","clearedDeviceCount":2/u);
    assert.match(stream, /"action":"deleted"/u);
  }
  for (const { device } of controllers) {
    const config = await requestJson(originalFetch, baseUrl, `/v1/devices/${device.id}/config`, {
      headers: authHeaders,
    });
    assert.equal(config.config.threadId, null);
  }
});

test("expired T3 access tokens are blocked before snapshot or dispatch", async (t) => {
  const originalFetch = globalThis.fetch;
  let t3Calls = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "expired-t3.example") {
      t3Calls += 1;
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Expired token controller", profile: "next-coder" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Expired T3",
      baseUrl: "https://expired-t3.example",
      accessToken: "expired-token",
      accessTokenExpiresAt: "2000-01-01T00:00:00.000Z",
    },
  });
  assert.equal(environment.environment.accessTokenExpiresAt, "2000-01-01T00:00:00.000Z");

  const health = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environment.environment.id}/check`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(health.environment.status, "token_expired");
  assert.match(health.error, /expired/u);
  assert.equal(health.reason, "token_expired");
  assert.equal(health.failure.retryable, false);

  const snapshot = await originalFetch(new URL(`/v1/t3/environments/${environment.environment.id}/snapshot`, baseUrl), {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(snapshot.status, 409);

  const dispatch = await originalFetch(new URL("/v1/device/intents", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: JSON.stringify({
      environmentId: environment.environment.id,
      threadId: "thread_expired",
      intent: { type: "agent_prompt", text: "This should not dispatch." },
    }),
  });
  const dispatchBody = await dispatch.json();
  assert.equal(dispatch.status, 409);
  assert.equal(dispatchBody.error.details.command.status, "blocked");
  assert.equal(t3Calls, 0);
});

test("T3 environments can be updated and removed", async (t) => {
  const originalFetch = globalThis.fetch;
  const snapshots = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      snapshots.push({
        origin: parsed.origin,
        authorization: init.headers?.authorization,
      });
      return jsonResponse({ projects: [{ id: "p1" }], threads: [{ id: "t1" }] }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const device = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Environment controller", profile: "next-coder" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Old T3",
      baseUrl: "https://old-t3.example",
      accessToken: "old-token",
    },
  });
  await requestJson(originalFetch, baseUrl, `/v1/devices/${device.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_env",
    },
  });

  const updated = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environment.environment.id}`, {
    method: "PUT",
    headers: authHeaders,
    body: {
      label: "Updated T3",
      baseUrl: "https://new-t3.example",
      accessToken: "new-token",
    },
  });
  assert.equal(updated.environment.id, environment.environment.id);
  assert.equal(updated.environment.label, "Updated T3");
  assert.equal(updated.environment.baseUrl, "https://new-t3.example");
  assert.equal(updated.environment.accessToken, undefined);

  await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environment.environment.id}/check`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.deepEqual(snapshots.at(-1), {
    origin: "https://new-t3.example",
    authorization: "Bearer new-token",
  });

  const deleted = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environment.environment.id}`, {
    method: "DELETE",
    headers: authHeaders,
    body: { confirmationLabel: "Updated T3" },
  });
  assert.equal(deleted.environment.id, environment.environment.id);

  const environments = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(environments.environments.length, 1);
  assert.match(environments.environments[0].purgeAfter, /^\d{4}-\d{2}-\d{2}T/u);

  const config = await requestJson(originalFetch, baseUrl, `/v1/devices/${device.device.id}/config`, {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(config.config.environmentId, null);
});

test("device can upload image media and reference it in a camera prompt", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-media-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { mediaDir, maxMediaBytes: 1024, demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Camera controller", profile: "next-coder" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const mediaUpload = await requestJson(originalFetch, baseUrl, "/v1/device/media", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: PNG_BASE64,
      originalName: "snapshot.png",
    },
  });

  assert.equal(mediaUpload.media.kind, "image");
  assert.equal(mediaUpload.media.storagePath, undefined);
  assert.equal(mediaUpload.media.sizeBytes, Buffer.from(PNG_BASE64, "base64").length);

  const fetchedMedia = await originalFetch(new URL(`/v1/media/${mediaUpload.media.id}`, baseUrl), {
    headers: authHeaders,
  });
  assert.equal(fetchedMedia.status, 200);
  assert.equal(fetchedMedia.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await fetchedMedia.arrayBuffer()).toString("base64"), PNG_BASE64);

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_1",
      intent: {
        type: "camera_prompt",
        mediaUploadId: mediaUpload.media.id,
        prompt: "Use this snapshot as visual context.",
      },
    },
  });

  assert.equal(dispatched.command.status, "dispatched");
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0].message.text, /Use this snapshot as visual context/u);
  assert.match(dispatches[0].message.text, new RegExp(`id=${mediaUpload.media.id}`, "u"));
  assert.match(dispatches[0].message.text, /contentType=image\/png/u);
});

test("audio media transcripts can be stored, updated, and used by audio prompts", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-audio-media-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { mediaDir, maxMediaBytes: 1024, demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const mediaUpload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "audio",
      contentType: "audio/webm",
      dataBase64: WEBM_BASE64,
      originalName: "prompt.webm",
      transcript: "Initial audio transcript.",
    },
  });
  assert.equal(mediaUpload.media.kind, "audio");
  assert.equal(mediaUpload.media.transcript, "Initial audio transcript.");
  assert.equal(mediaUpload.media.processing.transcriptionStatus, "ready");
  assert.equal(mediaUpload.media.processing.transcriptSource, "upload");

  const updatedTranscript = await requestJson(originalFetch, baseUrl, `/v1/media/${mediaUpload.media.id}/transcript`, {
    method: "PUT",
    headers: authHeaders,
    body: { transcript: "Continue from the current failing test and summarize the fix." },
  });
  assert.equal(updatedTranscript.media.transcript, "Continue from the current failing test and summarize the fix.");
  assert.equal(updatedTranscript.media.processing.transcriptionStatus, "ready");
  assert.equal(updatedTranscript.media.processing.transcriptSource, "manual");

  const listed = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(listed.media[0].transcript, "Continue from the current failing test and summarize the fix.");
  assert.equal(listed.media[0].storagePath, undefined);

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_audio",
      intent: {
        type: "audio_prompt",
        mediaUploadId: mediaUpload.media.id,
      },
    },
  });

  assert.equal(dispatched.command.status, "dispatched");
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0].message.text, /Continue from the current failing test/u);
  assert.match(dispatches[0].message.text, new RegExp(`id=${mediaUpload.media.id}`, "u"));
  assert.match(dispatches[0].message.text, /contentType=audio\/webm/u);
});

test("audio media can be transcribed through the configured provider", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-transcribe-media-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server, mediaJobRunner } = createApp({
    config: {
      mediaDir,
      maxMediaBytes: 1024,
      transcriptionProvider: "mock",
      demoMode: false,
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const mediaUpload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "audio",
      contentType: "audio/webm",
      dataBase64: WEBM_BASE64,
      originalName: "needs-transcript.webm",
    },
  });
  assert.equal(mediaUpload.media.transcript, null);
  assert.equal(mediaUpload.media.processing.transcriptionStatus, "pending");

  // Transcription is a durable job now: the request enqueues, the worker runs it. The route no
  // longer holds the socket open for the length of an ASR call.
  const queued = await requestJson(originalFetch, baseUrl, `/v1/media/${mediaUpload.media.id}/transcribe`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(queued.job.stage, "queued");
  assert.equal(queued.job.provider, "mock");
  assert.equal(queued.media.processing.transcriptionStatus, "processing");

  const { processed } = await mediaJobRunner.runOnce();
  assert.deepEqual(processed.map((entry) => entry.stage), ["dispatched"]);

  const job = await requestJson(originalFetch, baseUrl, `/v1/media/jobs/${queued.job.id}`, {
    headers: authHeaders,
  });
  assert.equal(job.job.stage, "dispatched");
  assert.match(job.job.rawTranscript, /Mock transcript/u);
  assert.match(job.job.normalizedTranscript, /Mock transcript/u);
  assert.equal(job.job.userEditedTranscript, null);

  const listed = await requestJson(originalFetch, baseUrl, "/v1/media", { headers: authHeaders });
  const transcribed = { media: listed.media.find((item) => item.id === mediaUpload.media.id) };
  assert.match(transcribed.media.transcript, /Mock transcript/u);
  assert.equal(transcribed.media.processing.transcriptionStatus, "ready");
  assert.equal(transcribed.media.processing.transcriptSource, "mock");

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_audio",
      intent: {
        type: "audio_prompt",
        mediaUploadId: mediaUpload.media.id,
      },
    },
  });

  assert.equal(dispatched.command.status, "dispatched");
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0].message.text, /Mock transcript for audio needs-transcript\.webm/u);
});

test("deleting equal uploads removes only the selected metadata and stored bytes", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-delete-media-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({ config: { mediaDir, maxMediaBytes: 1024, demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const mediaUpload = await requestJson(fetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: PNG_BASE64,
      originalName: "delete-me.png",
    },
  });
  const duplicateUpload = await requestJson(fetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: PNG_BASE64,
      originalName: "keep-me.png",
    },
  });

  assert.equal(mediaUpload.media.kind, "image");
  assert.equal(mediaUpload.media.sha256, duplicateUpload.media.sha256);
  assert.equal((await readdir(join(mediaDir, "user_dev"))).length, 2);

  const deleted = await requestJson(fetch, baseUrl, `/v1/media/${mediaUpload.media.id}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.equal(deleted.media.id, mediaUpload.media.id);
  assert.equal(deleted.media.storagePath, undefined);

  const mediaList = await requestJson(fetch, baseUrl, "/v1/media", {
    method: "GET",
    headers: authHeaders,
  });
  assert.deepEqual(mediaList.media.map((media) => media.id), [duplicateUpload.media.id]);
  assert.equal((await readdir(join(mediaDir, "user_dev"))).length, 1);

  const fetchedAfterDelete = await fetch(new URL(`/v1/media/${mediaUpload.media.id}`, baseUrl), {
    headers: authHeaders,
  });
  assert.equal(fetchedAfterDelete.status, 404);

  const retainedDuplicate = await fetch(new URL(`/v1/media/${duplicateUpload.media.id}`, baseUrl), {
    headers: authHeaders,
  });
  assert.equal(retainedDuplicate.status, 200);

  await requestJson(fetch, baseUrl, `/v1/media/${duplicateUpload.media.id}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.deepEqual(await readdir(join(mediaDir, "user_dev")), []);
});

test("privacy settings apply media retention and purge expired stored bytes", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-retention-media-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));
  const store = createMemoryStore();
  const { server } = createApp({
    store,
    config: { mediaDir, maxMediaBytes: 1024, defaultMediaRetentionDays: 30, demoMode: false },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const savedPrivacy = await requestJson(fetch, baseUrl, "/v1/settings/privacy", {
    method: "PUT",
    headers: authHeaders,
    body: { mediaRetentionDays: 1 },
  });
  assert.equal(savedPrivacy.privacy.mediaRetentionDays, 1);

  const readPrivacy = await requestJson(fetch, baseUrl, "/v1/settings/privacy", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(readPrivacy.privacy.mediaRetentionDays, 1);

  const freshUpload = await requestJson(fetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: PNG_BASE64,
      originalName: "keep-me.png",
    },
  });
  assert.match(freshUpload.media.expiresAt, /^\d{4}-\d{2}-\d{2}T/u);

  const userMediaDir = join(mediaDir, "user_dev");
  await mkdir(userMediaDir, { recursive: true });
  const expiredPath = join(userMediaDir, "expired.png");
  await writeFile(expiredPath, "expired-by-retention");
  const expired = store.createMediaUpload({
    userId: "user_dev",
    deviceId: null,
    kind: "image",
    contentType: "image/png",
    sizeBytes: 20,
    sha256: "expired-sha",
    storagePath: expiredPath,
    originalName: "expired.png",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });

  const purged = await requestJson(fetch, baseUrl, "/v1/media/purge-expired", {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(purged.count, 1);
  assert.equal(purged.purged[0].id, expired.id);
  assert.equal(purged.purged[0].storagePath, undefined);
  const retainedFiles = await readdir(userMediaDir);
  assert.equal(retainedFiles.length, 1);
  assert.match(retainedFiles[0], new RegExp(`^${freshUpload.media.sha256}-[0-9a-f-]+\\.png$`, "u"));

  const expiredAfterPurge = await fetch(new URL(`/v1/media/${expired.id}`, baseUrl), {
    headers: authHeaders,
  });
  assert.equal(expiredAfterPurge.status, 404);

  const freshAfterPurge = await fetch(new URL(`/v1/media/${freshUpload.media.id}`, baseUrl), {
    headers: authHeaders,
  });
  assert.equal(freshAfterPurge.status, 200);
});

test("remote access settings report machine readiness without exposing command output", async (t) => {
  const { server } = createApp({
    config: {
      host: "0.0.0.0",
      port: 3996,
      publicBaseUrl: "https://gateway.example.test",
      demoMode: false,
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const result = await requestJson(fetch, baseUrl, "/v1/settings/remote-access?refresh=1", {
    method: "GET",
    headers: authHeaders,
  });

  assert.equal(result.remoteAccess.gateway.host, "0.0.0.0");
  assert.equal(result.remoteAccess.gateway.port, 3996);
  assert.equal(result.remoteAccess.gateway.publicBaseUrl, "https://gateway.example.test");
  assert.equal(typeof result.remoteAccess.tailscale.installed, "boolean");
  assert.equal(typeof result.remoteAccess.tailscale.connected, "boolean");
  assert.match(result.remoteAccess.checkedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(Object.hasOwn(result.remoteAccess.tailscale, "rawStatus"), false);
});

test("support diagnostics bundle redacts prompts, shell commands, and secrets", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-diagnostics-media-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({ config: { mediaDir, maxMediaBytes: 1024, demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const created = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Diagnostics controller", profile: "next-coder" },
  });
  const environment = await requestJson(fetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Diagnostics T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });
  await requestJson(fetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: PNG_BASE64,
      originalName: "diagnostics.png",
    },
  });
  await requestJson(fetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "audio",
      contentType: "audio/webm",
      dataBase64: WEBM_BASE64,
      originalName: "diagnostics.webm",
      transcript: "diagnostic transcript secret text",
    },
  });
  await requestJson(fetch, baseUrl, "/v1/macros", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Secret diagnostics macro",
      environmentId: environment.environment.id,
      threadId: "thread_diagnostics",
      intent: { type: "agent_prompt", text: "diagnostic macro secret text" },
    },
  });
  const command = await requestJson(fetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_diagnostics",
      intent: { type: "shell_input", command: "rm -rf very-secret-dir" },
    },
  });
  assert.equal(command.command.status, "approval_required");

  const diagnostics = await requestJson(fetch, baseUrl, "/v1/support/diagnostics", {
    method: "GET",
    headers: authHeaders,
  });
  const serialized = JSON.stringify(diagnostics);

  assert.equal(diagnostics.bundleVersion, 1);
  assert.equal(diagnostics.counts.devices, 1);
  assert.equal(diagnostics.counts.environments, 1);
  assert.equal(diagnostics.counts.media, 2);
  assert.equal(diagnostics.counts.macros, 1);
  assert.equal(diagnostics.observability.devices.total, 1);
  assert.equal(diagnostics.observability.commands.approvalRequired, 1);
  assert.equal(diagnostics.observability.media.failedProcessing, 0);
  assert.equal(diagnostics.macros[0].intent.text.redacted, true);
  assert.equal(diagnostics.recentCommands[0].intent.command.redacted, true);
  assert.equal(diagnostics.recentCommands[0].intent.command.length, "rm -rf very-secret-dir".length);
  assert.match(diagnostics.recentCommands[0].intent.command.sha256, /^[a-f0-9]{64}$/u);
  const audioMedia = diagnostics.media.find((media) => media.kind === "audio");
  assert.equal(audioMedia.transcript.redacted, true);
  assert.equal(audioMedia.transcript.length, "diagnostic transcript secret text".length);
  assert.equal(serialized.includes("rm -rf very-secret-dir"), false);
  assert.equal(serialized.includes("diagnostic macro secret text"), false);
  assert.equal(serialized.includes("diagnostic transcript secret text"), false);
  assert.equal(serialized.includes(created.secret), false);
  assert.equal(serialized.includes("mock-token"), false);
  assert.equal(serialized.includes(mediaDir), false);
});

test("serves the React dashboard and its built assets", async (t) => {
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(new URL("/", baseUrl));
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/u);
  assert.match(html, /Next Coder/u);
  assert.match(html, /id="root"/u);
  assert.doesNotMatch(html, /Remote agent control plane/u);

  const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+)"/u)?.[1];
  assert.ok(assetPath);
  const assetResponse = await fetch(new URL(assetPath, baseUrl));
  assert.equal(assetResponse.status, 200);
  assert.match(assetResponse.headers.get("cache-control"), /immutable/u);
});

test("the pre-React dashboard assets are gone from every route", async (t) => {
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // The legacy dashboard was removed; the React build is the only client. These paths must 404
  // rather than fall through to the SPA and hand back index.html for a .js request.
  for (const path of ["/legacy/", "/legacy/app.js", "/app.js", "/styles.css"]) {
    const response = await fetch(new URL(path, baseUrl));
    assert.equal(response.status, 404, `${path} should be gone`);
  }
});

test("auth config exposes only public Clerk browser settings", async (t) => {
  const { server } = createApp({
    config: {
      authProvider: "clerk",
      clerkPublishableKey: "pk_test_public",
      clerkSecretKey: "sk_test_secret",
      demoMode: false,
    },
    clerkAuth: async () => null,
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const config = await requestJson(fetch, baseUrl, "/v1/auth/config", {
    method: "GET",
    headers: {},
    body: undefined,
  });

  assert.deepEqual(config, {
    authProvider: "clerk",
    demoMode: false,
    deploymentMode: "self-hosted",
    developmentTokens: {
      enabled: false,
    },
    clerk: {
      enabled: true,
      publishableKey: "pk_test_public",
    },
  });
  assert.equal(JSON.stringify(config).includes("sk_test_secret"), false);
});

test("development token creation is disabled when Clerk auth is active", async (t) => {
  const { server } = createApp({
    config: {
      authProvider: "clerk",
      clerkPublishableKey: "pk_test_public",
      clerkSecretKey: "sk_test_secret",
      demoMode: false,
    },
    clerkAuth: async () => null,
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(new URL("/v1/users/dev", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "attacker", email: "attacker@example.local" }),
  });
  const data = await response.json();

  assert.equal(response.status, 403);
  assert.match(data.error.message, /disabled/u);
});

test("development token creation can be explicitly enabled for local Clerk testing", async (t) => {
  const { server } = createApp({
    config: {
      authProvider: "clerk",
      clerkPublishableKey: "pk_test_public",
      clerkSecretKey: "sk_test_secret",
      devTokenCreationEnabled: true,
      demoMode: false,
    },
    clerkAuth: async () => null,
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const created = await requestJson(fetch, baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "local_clerk_dev", email: "local-clerk@example.local" },
  });

  assert.equal(created.user.id, "local_clerk_dev");
  assert.ok(created.apiToken.secret);
});

test("user-authenticated web clients can upload media and dispatch prompts", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-web-media-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { mediaDir, maxMediaBytes: 1024, demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const mediaUpload = await requestJson(originalFetch, baseUrl, "/v1/media", {
    method: "POST",
    headers: authHeaders,
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: PNG_BASE64,
    },
  });

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/intents", {
    method: "POST",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_web",
      intent: {
        type: "camera_prompt",
        mediaUploadId: mediaUpload.media.id,
        prompt: "Inspect this uploaded web image.",
      },
    },
  });

  assert.equal(dispatched.command.status, "dispatched");
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0].message.text, /Inspect this uploaded web image/u);
  assert.match(dispatches[0].message.text, new RegExp(`id=${mediaUpload.media.id}`, "u"));
});

test("user saved macros can be created, run, listed, and deleted", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Macro T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const created = await requestJson(originalFetch, baseUrl, "/v1/macros", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Continue work",
      environmentId: environment.environment.id,
      threadId: "thread_macro",
      intent: { type: "agent_prompt", text: "Continue from the saved macro." },
    },
  });
  assert.equal(created.macro.label, "Continue work");
  assert.equal(created.macro.intent.text, "Continue from the saved macro.");

  const listed = await requestJson(originalFetch, baseUrl, "/v1/macros", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(listed.macros.length, 1);
  assert.equal(listed.macros[0].id, created.macro.id);

  const run = await requestJson(originalFetch, baseUrl, `/v1/macros/${created.macro.id}/run`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(run.command.status, "dispatched");
  assert.equal(run.macro.id, created.macro.id);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].threadId, "thread_macro");
  assert.equal(dispatches[0].message.text, "Continue from the saved macro.");

  const deleted = await requestJson(originalFetch, baseUrl, `/v1/macros/${created.macro.id}`, {
    method: "DELETE",
    headers: authHeaders,
    body: undefined,
  });
  assert.equal(deleted.macro.id, created.macro.id);

  const listedAfterDelete = await requestJson(originalFetch, baseUrl, "/v1/macros", {
    method: "GET",
    headers: authHeaders,
  });
  assert.deepEqual(listedAfterDelete.macros, []);
});

test("claimed devices can list and run saved macros", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const device = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Macro controller", profile: "next-coder" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Device Macro T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });
  const macro = await requestJson(originalFetch, baseUrl, "/v1/macros", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Device macro",
      environmentId: environment.environment.id,
      threadId: "thread_device_macro",
      intent: { type: "agent_prompt", text: "Device macro prompt." },
    },
  });

  const deviceHeaders = {
    "x-device-id": device.device.id,
    "x-device-secret": device.secret,
  };
  const listed = await requestJson(originalFetch, baseUrl, "/v1/device/macros", {
    method: "GET",
    headers: deviceHeaders,
  });
  assert.equal(listed.macros.length, 1);
  assert.equal(listed.macros[0].id, macro.macro.id);

  const run = await requestJson(originalFetch, baseUrl, `/v1/device/macros/${macro.macro.id}/run`, {
    method: "POST",
    headers: deviceHeaders,
    body: {},
  });
  assert.equal(run.command.status, "dispatched");
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].threadId, "thread_device_macro");
  assert.equal(dispatches[0].message.text, "Device macro prompt.");
});

test("display endpoints expose compact user and device state", async (t) => {
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const created = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Display controller", profile: "next-coder" },
  });

  const userDisplay = await requestJson(fetch, baseUrl, "/v1/display", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(userDisplay.display.counts.devices, 1);
  assert.equal(userDisplay.display.title, "Next Coder");

  const deviceDisplay = await requestJson(fetch, baseUrl, "/v1/device/display", {
    method: "GET",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
  });
  assert.equal(deviceDisplay.display.title, "Display controller");
  assert.equal(deviceDisplay.display.device.id, created.device.id);

  const observability = await requestJson(fetch, baseUrl, "/v1/observability/summary", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(observability.summary.devices.total, 1);
  assert.equal(observability.summary.devices.online, 1);
  assert.equal(observability.summary.environments.total, 0);
  assert.equal(observability.summary.commands.total, 0);
});

test("device config is user-managed and used as device intent defaults", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Configurable controller", profile: "next-coder" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const invalidConfig = await originalFetch(new URL(`/v1/devices/${created.device.id}/config`, baseUrl), {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ environmentId: "env_missing" }),
  });
  assert.equal(invalidConfig.status, 404);

  const insecureRemoteConfig = await originalFetch(new URL(`/v1/devices/${created.device.id}/config`, baseUrl), {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ gatewayAccessMode: "online", gatewayUrl: "http://gateway.example.com" }),
  });
  assert.equal(insecureRemoteConfig.status, 400);

  const saved = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: {
      label: "Editing bay controller",
      environmentId: environment.environment.id,
      threadId: "thread_configured",
      gatewayAccessMode: "online",
      gatewayUrl: "https://gateway.example.com/",
      defaultPrompt: "Configured prompt from gateway.",
      shellCommand: "npm test -- --watch=false",
      menu: ["status", "prompt", "shell"],
    },
  });
  assert.equal(saved.config.environmentId, environment.environment.id);
  assert.equal(saved.device.label, "Editing bay controller");
  assert.equal(saved.config.threadId, "thread_configured");
  assert.equal(saved.config.gatewayAccessMode, "online");
  assert.equal(saved.config.gatewayUrl, "https://gateway.example.com");
  assert.equal(saved.config.shellCommand, "npm test -- --watch=false");
  assert.deepEqual(saved.config.menu, ["status", "prompt", "shell"]);

  const listed = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(listed.devices[0].label, "Editing bay controller");

  const deviceConfig = await requestJson(originalFetch, baseUrl, "/v1/device/config", {
    method: "GET",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
  });
  assert.equal(deviceConfig.config.defaultPrompt, "Configured prompt from gateway.");
  assert.equal(deviceConfig.config.shellCommand, "npm test -- --watch=false");
  assert.equal(deviceConfig.config.gatewayAccessMode, "online");
  assert.equal(deviceConfig.config.gatewayUrl, "https://gateway.example.com");

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      intent: { type: "agent_prompt", text: "Use configured environment and thread." },
    },
  });
  assert.equal(dispatched.command.environmentId, environment.environment.id);
  assert.equal(dispatched.command.threadId, "thread_configured");
  assert.equal(dispatches[0].threadId, "thread_configured");

  const shell = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      intent: { type: "shell_input", command: deviceConfig.config.shellCommand },
    },
  });
  assert.equal(shell.command.status, "dispatched");
  assert.match(dispatches.at(-1).message.text, /npm test -- --watch=false/u);
});

test("device profiles are discoverable, validated, and enforced", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({ projects: [{ id: "p1" }], threads: [{ id: "t1" }] }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const catalog = await requestJson(originalFetch, baseUrl, "/v1/device-profiles", {
    method: "GET",
    headers: {},
  });
  assert.ok(catalog.profiles.find((profile) => profile.id === "next-coder").capabilities.includes("shell_input"));
  assert.deepEqual(catalog.profiles.find((profile) => profile.id === "read-only").capabilities, ["status"]);

  const invalidCreate = await originalFetch(new URL("/v1/devices", baseUrl), {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ label: "Invalid controller", profile: "unknown-profile" }),
  });
  assert.equal(invalidCreate.status, 400);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Profile controller", profile: "read-only" },
  });
  assert.equal(created.device.profile, "read-only");

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Mock T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  const blockedPrompt = await originalFetch(new URL("/v1/device/intents", baseUrl), {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      environmentId: environment.environment.id,
      threadId: "thread_profile",
      intent: { type: "agent_prompt", text: "Run tests." },
    }),
  });
  const blockedBody = await blockedPrompt.json();
  assert.equal(blockedPrompt.status, 403);
  assert.equal(blockedBody.error.details.command.status, "blocked");
  assert.equal(blockedBody.error.details.policy.risk, "blocked");
  assert.equal(dispatches.length, 0);

  const updated = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/profile`, {
    method: "PUT",
    headers: authHeaders,
    body: { profile: "next-coder" },
  });
  assert.equal(updated.device.profile, "next-coder");

  const dispatched = await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_profile",
      intent: { type: "agent_prompt", text: "Run tests." },
    },
  });
  assert.equal(dispatched.command.status, "dispatched");
  assert.equal(dispatches.length, 1);
});

test("SSE user event stream emits state changes", async (t) => {
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const auth = await requestJson(fetch, baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_dev", email: "dev@example.local" },
  });
  const controller = new AbortController();
  t.after(() => controller.abort());

  const streamResponse = await fetch(
    new URL(`/v1/events?token=${encodeURIComponent(auth.apiToken.secret)}`, baseUrl),
    { signal: controller.signal },
  );
  assert.equal(streamResponse.status, 200);

  await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: { authorization: `Bearer ${auth.apiToken.secret}` },
    body: { label: "SSE controller", profile: "next-coder" },
  });

  const text = await readStreamUntil(streamResponse.body, "state.changed");
  assert.match(text, /event: connected/u);
  assert.match(text, /event: state.changed/u);
  assert.match(text, /"devices":1/u);
});

test("factory preprovisioned devices must be claimed before control and support rotation/revocation", async (t) => {
  const { server } = createApp({ config: { factoryToken: "factory-secret", demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const preprovisioned = await requestJson(fetch, baseUrl, "/v1/factory/devices", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: { label: "Factory controller", profile: "next-coder" },
  });
  assert.equal(preprovisioned.device.claimed, false);
  assert.ok(preprovisioned.claimCode);
  assert.ok(preprovisioned.secret);

  const unclaimedHeartbeat = await requestJson(fetch, baseUrl, "/v1/device/heartbeat", {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
    },
    body: {},
  });
  assert.equal(unclaimedHeartbeat.device.claimed, false);

  const unclaimedDisplay = await fetch(new URL("/v1/device/display", baseUrl), {
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
    },
  });
  assert.equal(unclaimedDisplay.status, 403);

  // Firmware asks for a setup code on its first 403, seconds after boot. That must not invalidate
  // the code printed on the box at manufacture, so the request reports the existing code as still
  // valid and mints nothing.
  const setupCode = await requestJson(fetch, baseUrl, "/v1/device/setup-code", {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
    },
    body: {},
  });
  assert.equal(setupCode.device.id, preprovisioned.device.id);
  assert.equal(setupCode.device.claimed, false);
  assert.equal(setupCode.setup.claimed, false);
  assert.equal(setupCode.setup.rotated, false);
  assert.equal(setupCode.setup.claimCode, null);
  assert.ok(Date.parse(setupCode.setup.claimCodeExpiresAt) > Date.now());

  // Repeating it — the device polls — still does not move the code.
  await requestJson(fetch, baseUrl, "/v1/device/setup-code", {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
    },
    body: {},
  });

  const claimed = await requestJson(fetch, baseUrl, "/v1/devices/claim", {
    method: "POST",
    headers: authHeaders,
    body: { claimCode: preprovisioned.claimCode, label: "Claimed controller" },
  });
  assert.equal(claimed.device.claimed, true);
  assert.equal(claimed.device.label, "Claimed controller");

  const claimedSetupCode = await requestJson(fetch, baseUrl, "/v1/device/setup-code", {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
    },
    body: {},
  });
  assert.equal(claimedSetupCode.setup.claimed, true);
  assert.equal(claimedSetupCode.setup.claimCode, null);

  const heartbeat = await requestJson(fetch, baseUrl, "/v1/device/heartbeat", {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
    },
    body: {
      firmwareVersion: "0.1.7",
      hardwareModel: "e213-esp32-s3r8",
      ipAddress: "192.168.4.20",
      wifiRssi: -61,
      freeHeap: 184320,
      uptimeMs: 120000,
      batteryPercent: 87,
    },
  });
  assert.equal(heartbeat.device.status.firmwareVersion, "0.1.7");
  assert.equal(heartbeat.device.status.hardwareModel, "e213-esp32-s3r8");
  assert.equal(heartbeat.device.status.ipAddress, "192.168.4.20");
  assert.equal(heartbeat.device.status.wifiRssi, -61);
  assert.equal(heartbeat.device.status.freeHeap, 184320);
  assert.equal(heartbeat.device.status.uptimeMs, 120000);
  assert.equal(heartbeat.device.status.batteryPercent, 87);
  assert.match(heartbeat.device.status.lastHeartbeatAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(heartbeat.device.presence.state, "online");
  assert.equal(heartbeat.device.presence.online, true);
  assert.equal(heartbeat.device.presence.lastHeartbeatAt, heartbeat.device.status.lastHeartbeatAt);

  const devices = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(devices.devices[0].status.firmwareVersion, "0.1.7");
  assert.equal(devices.devices[0].presence.state, "online");

  const deviceDisplay = await requestJson(fetch, baseUrl, "/v1/device/display", {
    method: "GET",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
    },
  });
  assert.equal(deviceDisplay.display.device.id, preprovisioned.device.id);
  assert.equal(deviceDisplay.display.device.status.firmwareVersion, "0.1.7");
  assert.equal(deviceDisplay.display.device.presence.state, "online");

  const rotated = await requestJson(fetch, baseUrl, `/v1/devices/${preprovisioned.device.id}/rotate-secret`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(rotated.secret, undefined);
  assert.equal(rotated.rotation.state, "pending");
  assert.equal(rotated.rotation.pendingCredentialVersion, 2);

  const oldSecretHeartbeat = await requestJson(fetch, baseUrl, "/v1/device/heartbeat", {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
    },
    body: {},
  });
  assert.equal(oldSecretHeartbeat.device.credentialRotation.state, "pending");

  const replacementSecret = "replacement_device_secret_0123456789abcdef";
  const staged = await requestJson(fetch, baseUrl, "/v1/device/credentials/stage", {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
    },
    body: {
      rotationId: rotated.rotation.id,
      credentialVersion: rotated.rotation.pendingCredentialVersion,
      secret: replacementSecret,
    },
  });
  assert.equal(staged.staged, true);
  assert.equal(JSON.stringify(staged).includes(replacementSecret), false);

  const pendingCannotHeartbeat = await fetch(new URL("/v1/device/heartbeat", baseUrl), {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": replacementSecret,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(pendingCannotHeartbeat.status, 401);

  const acknowledged = await requestJson(fetch, baseUrl, "/v1/device/credentials/ack", {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": replacementSecret,
    },
    body: {
      rotationId: rotated.rotation.id,
      credentialVersion: rotated.rotation.pendingCredentialVersion,
    },
  });
  assert.equal(acknowledged.promoted, true);
  assert.equal(acknowledged.replayed, false);

  const replayed = await requestJson(fetch, baseUrl, "/v1/device/credentials/ack", {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": replacementSecret,
    },
    body: {
      rotationId: rotated.rotation.id,
      credentialVersion: rotated.rotation.pendingCredentialVersion,
    },
  });
  assert.equal(replayed.replayed, true);

  const supersededHeartbeat = await fetch(new URL("/v1/device/heartbeat", baseUrl), {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": preprovisioned.secret,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(supersededHeartbeat.status, 401);

  await requestJson(fetch, baseUrl, `/v1/devices/${preprovisioned.device.id}/revoke`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });

  const revokedHeartbeat = await fetch(new URL("/v1/device/heartbeat", baseUrl), {
    method: "POST",
    headers: {
      "x-device-id": preprovisioned.device.id,
      "x-device-secret": replacementSecret,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(revokedHeartbeat.status, 401);
});

test("owners can reset claimed devices for transfer to a new account", async (t) => {
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const ownerHeaders = await createAuthHeaders(fetch, baseUrl);

  const created = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: ownerHeaders,
    body: { label: "Transfer controller", profile: "next-coder" },
  });

  const reset = await requestJson(fetch, baseUrl, `/v1/devices/${created.device.id}/transfer-reset`, {
    method: "POST",
    headers: ownerHeaders,
    body: {},
  });
  assert.equal(reset.device.id, created.device.id);
  assert.equal(reset.device.claimed, false);
  assert.equal(reset.device.userId, null);
  assert.equal(reset.claimCode, undefined);
  assert.equal(reset.secret, undefined);
  assert.equal(reset.rotation.purpose, "transfer");
  assert.equal(reset.rotation.state, "pending");

  const oldSecretHeartbeat = await requestJson(fetch, baseUrl, "/v1/device/heartbeat", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {},
  });
  assert.equal(oldSecretHeartbeat.device.credentialRotation.purpose, "transfer");

  const blockedConfig = await fetch(new URL("/v1/device/config", baseUrl), {
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
  });
  assert.equal(blockedConfig.status, 409);

  const ownerDevices = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "GET",
    headers: ownerHeaders,
  });
  assert.deepEqual(ownerDevices.devices, []);

  const transferSecret = "transfer_device_secret_0123456789abcdef";
  await requestJson(fetch, baseUrl, "/v1/device/credentials/stage", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {
      rotationId: reset.rotation.id,
      credentialVersion: reset.rotation.pendingCredentialVersion,
      secret: transferSecret,
    },
  });
  const transferAck = await requestJson(fetch, baseUrl, "/v1/device/credentials/ack", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": transferSecret,
    },
    body: {
      rotationId: reset.rotation.id,
      credentialVersion: reset.rotation.pendingCredentialVersion,
    },
  });
  assert.equal(transferAck.resetForTransfer, true);

  const setup = await requestJson(fetch, baseUrl, "/v1/device/setup-code", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": transferSecret,
    },
    body: { rotate: true },
  });
  assert.ok(setup.claimCode);

  const newOwner = await requestJson(fetch, baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_new_owner", email: "new-owner@example.local" },
  });
  const newOwnerHeaders = { authorization: `Bearer ${newOwner.apiToken.secret}` };
  const claimed = await requestJson(fetch, baseUrl, "/v1/devices/claim", {
    method: "POST",
    headers: newOwnerHeaders,
    body: { claimCode: setup.claimCode, label: "New owner controller" },
  });
  assert.equal(claimed.device.id, created.device.id);
  assert.equal(claimed.device.claimed, true);
  assert.equal(claimed.device.userId, "user_new_owner");
  assert.equal(claimed.device.label, "New owner controller");

  const newOwnerHeartbeat = await requestJson(fetch, baseUrl, "/v1/device/heartbeat", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": transferSecret,
    },
    body: { firmwareVersion: "0.1.8" },
  });
  assert.equal(newOwnerHeartbeat.device.userId, "user_new_owner");
  assert.equal(newOwnerHeartbeat.device.status.firmwareVersion, "0.1.8");
});

test("factory batch provisioning returns flash configs and firmware manifests are device-polled", async (t) => {
  const { server } = createApp({
    config: {
      factoryToken: "factory-secret",
      otaSigningKey: "test-ota-signing-key",
      defaultHardwareModel: "e213-esp32-s3r8",
      demoMode: false,
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const batch = await requestJson(fetch, baseUrl, "/v1/factory/batches", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: {
      count: 2,
      labelPrefix: "Batch controller",
      gatewayBaseUrl: "https://gateway.example.com",
      firmwareVersion: "0.1.0",
      shellCommand: "npm test -- --runInBand",
      enableOtaApply: true,
      requireOtaSignature: true,
      otaManifestVerifyKey: "test-ota-signing-key",
    },
  });

  assert.equal(batch.batch.count, 2);
  assert.equal(batch.devices.length, 2);
  assert.match(batch.devices[0].claimCode, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/u);
  assert.match(batch.devices[0].flashConfig, /#define GATEWAY_BASE_URL "https:\/\/gateway\.example\.com"/u);
  assert.match(batch.devices[0].flashConfig, new RegExp(`#define DEVICE_ID "${batch.devices[0].device.id}"`, "u"));
  // Break 1: the factory cannot know the customer's network, so a baked-in SSID guaranteed that
  // no shipped unit could connect. Wi-Fi now comes from the owner via the on-device portal.
  // The generated header still names them in a comment explaining where they went, so this
  // asserts on the definition rather than the substring.
  assert.doesNotMatch(batch.devices[0].flashConfig, /#define\s+WIFI_SSID/u);
  assert.doesNotMatch(batch.devices[0].flashConfig, /#define\s+WIFI_PASSWORD/u);

  // The NVS seed is what lets one signed image serve a whole batch.
  assert.equal(batch.devices[0].nvsSeedFilename, `${batch.devices[0].device.id}.nvs.csv`);
  assert.match(batch.devices[0].nvsSeed, /^key,type,encoding,value$/mu);
  assert.match(batch.devices[0].nvsSeed, /^agentctl,namespace,,$/mu);
  assert.match(batch.devices[0].nvsSeed, new RegExp(`^dev_id,data,string,${batch.devices[0].device.id}$`, "mu"));
  assert.match(batch.devices[0].nvsSeed, /^gw_url,data,string,https:\/\/gateway\.example\.com$/mu);
  assert.ok(batch.devices[0].nvsSeed.includes(batch.devices[0].secret));
  // The claim code ships in the seed so the on-screen code matches the printed label from first
  // boot; the gateway will not reissue a still-live code's plaintext later.
  assert.ok(batch.devices[0].nvsSeed.includes(`claim_code,data,string,${batch.devices[0].claimCode}`));
  assert.ok(batch.devices[0].nvsSeed.includes("claim_exp,data,string,"));
  // Wi-Fi stays absent: the factory cannot know the customer's network.
  assert.ok(!batch.devices[0].nvsSeed.includes("wifi_ssid"));
  assert.match(batch.devices[0].flashConfig, /#define DEFAULT_SHELL_COMMAND "npm test -- --runInBand"/u);
  assert.match(batch.devices[0].flashConfig, /#define ENABLE_OTA_APPLY 1/u);
  assert.match(batch.devices[0].flashConfig, /#define REQUIRE_OTA_SIGNATURE 1/u);
  assert.match(batch.devices[0].flashConfig, /#define OTA_MANIFEST_VERIFY_KEY "test-ota-signing-key"/u);

  await requestJson(fetch, baseUrl, "/v1/devices/claim", {
    method: "POST",
    headers: authHeaders,
    body: { claimCode: batch.devices[0].claimCode, label: "Claimed batch controller" },
  });

  const firmwareStream = await fetch(new URL("/v1/device/events", baseUrl), {
    headers: {
      "x-device-id": batch.devices[0].device.id,
      "x-device-secret": batch.devices[0].secret,
    },
  });
  assert.equal(firmwareStream.status, 200);
  const firmwareChanged = readStreamUntil(firmwareStream.body, "firmware.changed");

  const release = await requestJson(fetch, baseUrl, "/v1/factory/firmware/releases", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: {
      version: "0.2.0",
      hardwareModel: "e213-esp32-s3r8",
      url: "https://cdn.example.com/firmware/next-coder-0.2.0.bin",
      sha256: "a".repeat(64),
      sizeBytes: 901385,
      mandatory: false,
      releaseNotes: "Config polling firmware.",
    },
  });

  assert.equal(release.release.version, "0.2.0");
  assert.equal(release.manifest.version, "0.2.0");
  assert.equal(release.manifest.channel, "stable");
  assert.match(release.manifest.signature, /^[a-f0-9]{64}$/u);
  const firmwareEventText = await firmwareChanged;
  assert.match(firmwareEventText, /event: firmware\.changed/u);
  assert.match(firmwareEventText, /"hardwareModel":"e213-esp32-s3r8"/u);

  await requestJson(fetch, baseUrl, "/v1/factory/firmware/releases", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: {
      version: "0.3.0-beta.1",
      channel: "beta",
      hardwareModel: "e213-esp32-s3r8",
      url: "https://cdn.example.com/firmware/next-coder-0.3.0-beta.1.bin",
      sha256: "b".repeat(64),
      sizeBytes: 905000,
      mandatory: false,
      releaseNotes: "Beta controls firmware.",
    },
  });

  await requestJson(fetch, baseUrl, `/v1/devices/${batch.devices[0].device.id}/firmware-policy`, {
    method: "PUT",
    headers: authHeaders,
    body: { updateMode: "automatic" },
  });

  const update = await requestJson(fetch, baseUrl, "/v1/device/firmware?version=0.1.0&hardware=e213-esp32-s3r8", {
    method: "GET",
    headers: {
      "x-device-id": batch.devices[0].device.id,
      "x-device-secret": batch.devices[0].secret,
    },
  });
  assert.equal(update.updateAvailable, true);
  assert.equal(update.installation, "automatic");
  assert.equal(update.manifest.version, "0.2.0");
  assert.equal(update.manifest.sha256, "a".repeat(64));

  const current = await requestJson(fetch, baseUrl, "/v1/device/firmware?version=0.2.0&hardware=e213-esp32-s3r8", {
    method: "GET",
    headers: {
      "x-device-id": batch.devices[0].device.id,
      "x-device-secret": batch.devices[0].secret,
    },
  });
  assert.equal(current.updateAvailable, false);
  assert.equal(current.reason, "current");

  const manualBetaPolicy = await requestJson(fetch, baseUrl, `/v1/devices/${batch.devices[0].device.id}/firmware-policy`, {
    method: "PUT",
    headers: authHeaders,
    body: { channel: "beta", updateMode: "manual" },
  });
  assert.equal(manualBetaPolicy.latestVersion, "0.3.0-beta.1");
  assert.deepEqual(manualBetaPolicy.availableVersions, ["0.3.0-beta.1"]);

  const legacyManualBeta = await requestJson(fetch, baseUrl, "/v1/device/firmware?version=0.1.0&hardware=e213-esp32-s3r8", {
    method: "GET",
    headers: {
      "x-device-id": batch.devices[0].device.id,
      "x-device-secret": batch.devices[0].secret,
    },
  });
  assert.equal(legacyManualBeta.updateAvailable, false);
  assert.equal(legacyManualBeta.reason, "manual_or_notify");

  await requestJson(fetch, baseUrl, "/v1/device/heartbeat", {
    method: "POST",
    headers: {
      "x-device-id": batch.devices[0].device.id,
      "x-device-secret": batch.devices[0].secret,
    },
    body: {
      protocolVersion: 2,
      firmwareVersion: "0.1.0",
      hardwareModel: "e213-esp32-s3r8",
      features: ["ota", "ota_confirm"],
    },
  });

  const manualBeta = await requestJson(fetch, baseUrl, "/v1/device/firmware?version=0.1.0&hardware=e213-esp32-s3r8", {
    method: "GET",
    headers: {
      "x-device-id": batch.devices[0].device.id,
      "x-device-secret": batch.devices[0].secret,
    },
  });
  assert.equal(manualBeta.updateAvailable, true);
  assert.equal(manualBeta.installation, "confirm");
  assert.equal(manualBeta.manifest.version, "0.3.0-beta.1");

  await requestJson(fetch, baseUrl, `/v1/devices/${batch.devices[0].device.id}/firmware-policy`, {
    method: "PUT",
    headers: authHeaders,
    body: { desiredVersion: "0.3.0-beta.1" },
  });
  const requestedBeta = await requestJson(fetch, baseUrl, "/v1/device/firmware?version=0.1.0&hardware=e213-esp32-s3r8", {
    method: "GET",
    headers: {
      "x-device-id": batch.devices[0].device.id,
      "x-device-secret": batch.devices[0].secret,
    },
  });
  assert.equal(requestedBeta.updateAvailable, true);
  assert.equal(requestedBeta.installation, "automatic");
  assert.equal(requestedBeta.manifest.version, "0.3.0-beta.1");
  assert.equal(requestedBeta.manifest.channel, "beta");
});

test("rate limits protect user and device write paths", async (t) => {
  const { server } = createApp({
    config: {
      demoMode: false,
      rateLimits: {
        windowMs: 60_000,
        auth: 100,
        factoryWrite: 100,
        userRead: 100,
        userWrite: 1,
        deviceHeartbeat: 1,
        deviceRead: 100,
        deviceWrite: 1,
      },
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const created = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Limited controller", profile: "next-coder" },
  });

  const secondDevice = await fetch(new URL("/v1/devices", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ label: "Blocked controller", profile: "next-coder" }),
  });
  assert.equal(secondDevice.status, 429);
  assert.equal(secondDevice.headers.get("x-ratelimit-limit"), "1");
  assert.equal(secondDevice.headers.get("x-ratelimit-remaining"), "0");
  assert.ok(secondDevice.headers.get("retry-after"));

  const heartbeat = await requestJson(fetch, baseUrl, "/v1/device/heartbeat", {
    method: "POST",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: {},
  });
  assert.equal(heartbeat.ok, true);

  const secondHeartbeat = await fetch(new URL("/v1/device/heartbeat", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
    body: "{}",
  });
  assert.equal(secondHeartbeat.status, 429);
});

test("Clerk auth mode maps bearer sessions to platform users", async (t) => {
  const { server } = createApp({
    config: {
      authProvider: "clerk",
      demoMode: false,
      rateLimits: {
        windowMs: 60_000,
        auth: 100,
        factoryWrite: 100,
        userRead: 100,
        userWrite: 100,
        deviceHeartbeat: 100,
        deviceRead: 100,
        deviceWrite: 100,
      },
    },
    clerkAuth: async (req) => {
      assert.equal(req.headers.authorization, "Bearer clerk-session");
      return { id: "user_clerk_123" };
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const created = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: { authorization: "Bearer clerk-session" },
    body: { label: "Clerk controller", profile: "next-coder" },
  });
  assert.equal(created.device.userId, "user_clerk_123");

  const devices = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "GET",
    headers: { authorization: "Bearer clerk-session" },
    body: undefined,
  });
  assert.equal(devices.devices.length, 1);
  assert.equal(devices.devices[0].id, created.device.id);
});

test("Clerk cookie sessions synchronize the real user profile", async (t) => {
  const { server, store } = createApp({
    config: {
      authProvider: "clerk",
      demoMode: false,
    },
    clerkAuth: async (req) => {
      assert.equal(req.headers.cookie, "__session=clerk-cookie-session");
      return {
        id: "user_clerk_cookie",
        email: "operator@example.com",
        name: "Gateway Operator",
      };
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const devices = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "GET",
    headers: { cookie: "__session=clerk-cookie-session" },
    body: undefined,
  });

  assert.deepEqual(devices.devices, []);
  assert.deepEqual(
    store.exportState().users.map(({ id, email, name }) => ({ id, email, name })),
    [{
      id: "user_clerk_cookie",
      email: "operator@example.com",
      name: "Gateway Operator",
    }],
  );
});

test("gateway routes support async Store API implementations", async (t) => {
  const store = createAsyncStore(createMemoryStore());
  const { server } = createApp({ store });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(fetch, baseUrl);

  const created = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Async controller", profile: "next-coder" },
  });
  const environment = await requestJson(fetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: {
      label: "Async T3",
      baseUrl: "https://mock-t3.example",
      accessToken: "mock-token",
    },
  });

  await requestJson(fetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_async",
      menu: ["status", "prompt"],
    },
  });

  const devices = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(devices.devices.length, 1);

  const userDisplay = await requestJson(fetch, baseUrl, "/v1/display", {
    method: "GET",
    headers: authHeaders,
  });
  assert.equal(userDisplay.display.counts.devices, 1);
  assert.equal(userDisplay.display.counts.environments, 1);

  const deviceDisplay = await requestJson(fetch, baseUrl, "/v1/device/display", {
    method: "GET",
    headers: {
      "x-device-id": created.device.id,
      "x-device-secret": created.secret,
    },
  });
  assert.equal(deviceDisplay.display.selectedEnvironmentId, environment.environment.id);
});

test("removing a T3 environment previews, repairs, and reports every dependency", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({ projects: [{ id: "p1" }], threads: [{ id: "thread_env" }] }, 200);
    }
    if (parsed.pathname === "/api/orchestration/dispatch") return jsonResponse({ accepted: true }, 200);
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = await createAuthHeaders(originalFetch, baseUrl);

  const device = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers,
    body: { label: "Dependency controller", profile: "next-coder" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers,
    body: { label: "Doomed T3", baseUrl: "https://doomed-t3.example", accessToken: "doomed-token" },
  });
  const environmentId = environment.environment.id;
  await requestJson(originalFetch, baseUrl, `/v1/devices/${device.device.id}/config`, {
    method: "PUT",
    headers,
    body: { environmentId, threadId: "thread_env" },
  });
  const action = await requestJson(originalFetch, baseUrl, "/v1/actions", {
    method: "POST",
    headers,
    body: {
      type: "prompt",
      label: "Ship it",
      payload: { text: "Continue the task." },
      targetMode: "fixed",
      environmentId,
      threadId: "thread_env",
    },
  });
  assert.equal(action.action.disabled, false);
  const macro = await requestJson(originalFetch, baseUrl, "/v1/macros", {
    method: "POST",
    headers,
    body: {
      label: "Nightly sweep",
      environmentId,
      threadId: "thread_env",
      intent: { type: "agent_prompt", text: "Sweep the repo." },
    },
  });
  await requestJson(originalFetch, baseUrl, "/v1/onboarding", {
    method: "PUT",
    headers,
    body: { status: "in_progress", currentStep: "workspace", environmentId, firstThreadId: "thread_env" },
  });

  const preview = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}/dependencies`, {
    method: "GET",
    headers,
  });
  assert.deepEqual(preview.counts, { devices: 1, actions: 1, macros: 1, onboarding: 1 });
  assert.deepEqual(preview.dependencies.actions, [{ id: action.action.id, label: "Ship it" }]);
  assert.deepEqual(preview.dependencies.macros, [{ id: macro.macro.id, label: "Nightly sweep" }]);
  assert.deepEqual(preview.dependencies.devices, [{ id: device.device.id, label: "Dependency controller" }]);
  assert.equal(preview.dependencies.onboarding, true);

  const mismatchedConfirmation = await originalFetch(new URL(`/v1/t3/environments/${environmentId}`, baseUrl), {
    method: "DELETE",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ confirmationLabel: "Doomed t3" }),
  });
  assert.equal(mismatchedConfirmation.status, 409);
  assert.equal((await mismatchedConfirmation.json()).error.details.reason, "environment_label_confirmation_required");

  const removed = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}`, {
    method: "DELETE",
    headers,
    body: { confirmationLabel: "Doomed T3" },
  });
  assert.equal(removed.environment.id, environmentId);
  assert.equal(removed.alreadyRemoved, false);
  assert.deepEqual(removed.removed, {
    devices: [device.device.id],
    actions: [action.action.id],
    macros: [macro.macro.id],
    onboarding: true,
  });

  const config = await requestJson(originalFetch, baseUrl, `/v1/devices/${device.device.id}/config`, {
    method: "GET",
    headers,
  });
  assert.equal(config.config.environmentId, null);
  assert.equal(config.config.projectId, null);
  assert.equal(config.config.threadId, null);

  const orphanedAction = await requestJson(originalFetch, baseUrl, `/v1/actions/${action.action.id}`, {
    method: "GET",
    headers,
  });
  assert.equal(orphanedAction.action.disabled, true);
  assert.equal(orphanedAction.action.disabledReason, "environment_removed");
  assert.equal(orphanedAction.action.environmentId, null);
  assert.equal(orphanedAction.action.targetMode, "device-current");

  const macros = await requestJson(originalFetch, baseUrl, "/v1/macros", { method: "GET", headers });
  assert.equal(macros.macros[0].disabled, true);
  assert.equal(macros.macros[0].disabledReason, "environment_removed");
  assert.equal(macros.macros[0].environmentId, null);

  const onboarding = await requestJson(originalFetch, baseUrl, "/v1/onboarding", { method: "GET", headers });
  assert.equal(onboarding.onboarding.environmentId, null);
  assert.equal(onboarding.onboarding.firstThreadId, null);

  // A disabled record is refused before anything tries to resolve the environment that is gone.
  const actionRun = await originalFetch(new URL(`/v1/actions/${action.action.id}/run`, baseUrl), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const actionRunBody = await actionRun.json();
  assert.equal(actionRun.status, 409);
  assert.match(actionRunBody.error.message, /environment was removed/u);

  const macroRun = await originalFetch(new URL(`/v1/macros/${macro.macro.id}/run`, baseUrl), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(macroRun.status, 409);

  const repeated = await requestJson(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}`, {
    method: "DELETE",
    headers,
  });
  assert.equal(repeated.environment.id, environmentId);
  assert.equal(repeated.alreadyRemoved, true);
  assert.deepEqual(repeated.removed, { devices: [], actions: [], macros: [], onboarding: false });

  // Saving the action again is the only thing that re-enables it.
  const rescued = await requestJson(originalFetch, baseUrl, `/v1/actions/${action.action.id}`, {
    method: "PUT",
    headers,
    body: { label: "Ship it later" },
  });
  assert.equal(rescued.action.disabled, false);
  assert.equal(rescued.action.disabledReason, null);
});

test("archiving a T3 environment fully disconnects it, keeps it listed, and allows permanent deletion", async (t) => {
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = await createAuthHeaders(fetch, baseUrl);

  const device = await requestJson(fetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers,
    body: { label: "Archive controller", profile: "next-coder" },
  });
  const created = await requestJson(fetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers,
    body: { label: "Archive T3", baseUrl: "https://archive-t3.example", accessToken: "archive-token" },
  });
  const environmentId = created.environment.id;
  await requestJson(fetch, baseUrl, `/v1/devices/${device.device.id}/config`, {
    method: "PUT",
    headers,
    body: { environmentId, threadId: "thread_archive" },
  });

  const archived = await requestJson(fetch, baseUrl, `/v1/t3/environments/${environmentId}/archive`, {
    method: "POST",
    headers,
    body: {},
  });
  assert.equal(archived.environment.status, "archived");
  assert.match(archived.environment.archivedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(archived.alreadyArchived, false);
  assert.deepEqual(archived.removed.devices, [device.device.id]);

  const listed = await requestJson(fetch, baseUrl, "/v1/t3/environments", { method: "GET", headers });
  assert.equal(listed.environments.length, 1);
  assert.equal(listed.environments[0].archivedAt, archived.environment.archivedAt);
  const config = await requestJson(fetch, baseUrl, `/v1/devices/${device.device.id}/config`, { method: "GET", headers });
  assert.equal(config.config.environmentId, null);
  assert.equal(config.config.projectId, null);
  assert.equal(config.config.threadId, null);
  const deviceEnvironments = await requestJson(fetch, baseUrl, "/v1/device/environments", {
    method: "GET",
    headers: {
      "x-device-id": device.device.id,
      "x-device-secret": device.secret,
    },
  });
  assert.deepEqual(deviceEnvironments.environments, []);

  const repeated = await requestJson(fetch, baseUrl, `/v1/t3/environments/${environmentId}/archive`, {
    method: "POST",
    headers,
    body: {},
  });
  assert.equal(repeated.alreadyArchived, true);

  const snapshotResponse = await fetch(new URL(`/v1/t3/environments/${environmentId}/snapshot`, baseUrl), {
    method: "GET",
    headers,
  });
  assert.equal(snapshotResponse.status, 404);
  assert.match((await snapshotResponse.json()).error.message, /not found/u);

  const restored = await requestJson(fetch, baseUrl, `/v1/t3/environments/${environmentId}/restore`, {
    method: "POST", headers, body: {},
  });
  assert.equal(restored.environment.status, "needs_repair");
  assert.equal(restored.environment.archivedAt, undefined);
  const activeAgain = await requestJson(fetch, baseUrl, "/v1/t3/environments", { method: "GET", headers });
  assert.equal(activeAgain.environments.length, 1);
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function requestJson(fetchImpl, baseUrl, path, input) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: input.method,
    headers: {
      "content-type": "application/json",
      ...input.headers,
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function createAuthHeaders(fetchImpl, baseUrl) {
  const created = await requestJson(fetchImpl, baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_dev", email: "dev@example.local" },
  });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createAsyncStore(store) {
  const syncMethods = new Set(["subscribe", "exportState", "flush"]);
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || syncMethods.has(property)) return value;
      return async (...args) => value.apply(target, args);
    },
  });
}

async function readStreamUntil(body, pattern) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    if (includesCompletedEvent(output, pattern)) {
      await reader.cancel();
      return output;
    }
  }
  await reader.cancel();
  throw new Error(`Timed out waiting for ${pattern}. Received: ${output}`);
}

// SSE events are terminated by a blank line. Only treat the pattern as found once
// its whole event has arrived; matching mid-event returns while the `event:` line
// has been read but the `data:` payload is still in flight.
function includesCompletedEvent(output, pattern) {
  const boundary = output.lastIndexOf("\n\n");
  return boundary !== -1 && output.slice(0, boundary).includes(pattern);
}

// --- device-scoped thread selection ---------------------------------------
//
// A device may change which thread it drives, but only within the environment its
// owner bound. The owner keeps the boundary that matters; the hardware gets the
// autonomy that is actually useful at a five-key bezel.

async function threadSelectionFixture(t, { threads, snapshotError = null, detailThread = null } = {}) {
  const originalFetch = globalThis.fetch;
  const detailReads = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (detailThread && parsed.pathname === `/api/orchestration/threads/${detailThread.id}`) {
      detailReads.push(parsed);
      return jsonResponse({ snapshotSequence: 1, thread: detailThread }, 200);
    }
    if (parsed.pathname === "/api/orchestration/snapshot") {
      if (snapshotError) throw snapshotError;
      return jsonResponse({
        projects: [{ id: "p1" }],
        threads: threads ?? [
          { id: "thread_a", title: "Alpha", session: { status: "stopped" } },
          {
            id: "thread_b",
            title: "Beta",
            session: { status: "stopped" },
            latestTurn: { state: "running" },
          },
        ],
      }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Bezel controller", profile: "next-coder" },
  });
  const deviceHeaders = {
    "x-device-id": created.device.id,
    "x-device-secret": created.secret,
  };

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Bound T3", baseUrl: "https://bound-t3.example", accessToken: "tok" },
  });

  return { originalFetch, baseUrl, authHeaders, created, deviceHeaders, environment, detailReads };
}

test("a device hydrates only its selected protocol-2 thread when reading the response", async (t) => {
  const shellThread = { id: "thread_v2_output", title: "Protocol 2 reply", session: { status: "ready" } };
  const f = await threadSelectionFixture(t, { threads: [shellThread], detailThread: {
    ...shellThread, messages: [{ id: "reply_v2", role: "assistant", text: "Device reply OK", createdAt: new Date().toISOString() }],
  } });
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT", headers: f.authHeaders, body: { environmentId: f.environment.environment.id, threadId: shellThread.id },
  });
  await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", { headers: f.deviceHeaders });
  assert.equal(f.detailReads.length, 0, "thread lists must not hydrate messages");
  const output = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/thread-output", { headers: f.deviceHeaders });
  assert.equal(output.response.state, "complete");
  assert.match(output.response.lines.join(" "), /Device reply OK/u);
  assert.equal(f.detailReads.length, 1);
  assert.equal(f.detailReads[0].searchParams.get("turnLimit"), "8");
});

test("a device lists titled thread status and the current selection from its bound environment", async (t) => {
  const f = await threadSelectionFixture(t);
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.environment.environment.id, threadId: "thread_a" },
  });

  const listed = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    headers: f.deviceHeaders,
  });
  assert.equal(listed.environmentId, f.environment.environment.id);
  assert.deepEqual(listed.threads, [
    { id: "thread_a", title: "Alpha", status: "stopped", selected: true },
    { id: "thread_b", title: "Beta", status: "running", selected: false },
  ]);
  assert.equal(listed.threadId, "thread_a");
});

test("device thread listing supplies safe title and status fallbacks", async (t) => {
  const f = await threadSelectionFixture(t, {
    threads: [
      { id: "thread_named", name: "Named by provider" },
      { id: "thread_untitled" },
      { title: "Missing identity", session: { status: "running" } },
    ],
  });
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.environment.environment.id },
  });

  const listed = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    headers: f.deviceHeaders,
  });
  assert.deepEqual(listed.threads, [
    { id: "thread_named", title: "Named by provider", status: "idle", selected: false },
    { id: "thread_untitled", title: "Untitled thread", status: "idle", selected: false },
  ]);
});

test("a device reads only its selected thread response through bounded pages", async (t) => {
  const f = await threadSelectionFixture(t, {
    threads: [{
      id: "thread_output",
      title: "Response task",
      session: { status: "stopped" },
      activities: [{
        id: "task_output",
        kind: "task.started",
        tone: "info",
        summary: "Private device task",
        payload: { taskId: "agent_output", agentKind: "agent", title: "Private device task" },
        createdAt: "2026-08-08T20:00:01.000Z",
      }],
      messages: [{
        id: "message_output",
        role: "assistant",
        createdAt: "2026-08-08T20:00:00.000Z",
        text: "Implemented the hardware response display with paging and safe action validation. <!--AC_FOLLOWUPS:[\"invented_action\"]-->",
      }],
    }],
  });
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.environment.environment.id, threadId: "thread_output" },
  });

  const output = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/thread-output?page=0", {
    headers: f.deviceHeaders,
  });
  assert.equal(output.thread.id, "thread_output");
  assert.equal(output.response.messageId, "message_output");
  assert.equal(output.response.state, "complete");
  assert.equal(output.work.active, 1);
  assert.equal(output.work.backgroundLiveness, "working");
  assert.doesNotMatch(JSON.stringify(output.work), /agent_output|Private device task/u);
  assert.ok(output.response.lines.every((line) => line.length <= 31));
  assert.doesNotMatch(output.response.lines.join(" "), /AC_FOLLOWUPS/u);
  assert.deepEqual(output.suggestions, [], "unassigned model output never becomes a device action");

  const waiting = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/thread-output?page=0&after=2026-08-08T21%3A00%3A00.000Z", {
    headers: f.deviceHeaders,
  });
  assert.equal(waiting.response.state, "waiting");
  assert.equal(waiting.response.messageId, null);
  assert.deepEqual(waiting.response.lines, ["1 active task", "0 done · 0 failed", "EXIT returns to actions"]);

  const invalid = await f.originalFetch(new URL("/v1/device/thread-output?page=-1", f.baseUrl), {
    headers: f.deviceHeaders,
  });
  assert.equal(invalid.status, 400);
});

test("device thread listing reports a bound T3 host outage as an actionable gateway error", async (t) => {
  const f = await threadSelectionFixture(t, { snapshotError: new Error("connect ECONNREFUSED") });
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.environment.environment.id },
  });

  const response = await f.originalFetch(new URL("/v1/device/threads", f.baseUrl), {
    headers: f.deviceHeaders,
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.message, "T3 environment is unavailable.");
  assert.equal(body.error.details.code, "t3_unreachable");
  assert.equal(body.error.details.environmentId, f.environment.environment.id);
});

test("a device can select a thread inside its bound environment", async (t) => {
  const f = await threadSelectionFixture(t);
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.environment.environment.id },
  });

  const updated = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config/thread", {
    method: "POST",
    headers: f.deviceHeaders,
    body: { threadId: "thread_b" },
  });
  assert.equal(updated.config.threadId, "thread_b");
  // The bound environment must survive a thread change.
  assert.equal(updated.config.environmentId, f.environment.environment.id);

  const reread = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config", {
    headers: f.deviceHeaders,
  });
  assert.equal(reread.config.threadId, "thread_b", "the choice is durable");

  const relisted = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    headers: f.deviceHeaders,
  });
  assert.equal(relisted.threadId, "thread_b");
  assert.equal(relisted.threads.find((thread) => thread.id === "thread_b")?.selected, true);

  const audit = await requestJson(f.originalFetch, f.baseUrl, "/v1/audit", { headers: f.authHeaders });
  const event = audit.events.findLast((entry) => (
    entry.action === "device.config_updated" && entry.metadata?.threadId === "thread_b"
  ));
  assert.equal(event?.actorType, "device");
  assert.equal(event?.actorId, f.created.device.id);
  assert.equal(event?.targetId, f.created.device.id);
});

test("a device cannot select a thread that is not in its bound environment", async (t) => {
  const f = await threadSelectionFixture(t);
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.environment.environment.id, threadId: "thread_a" },
  });

  const response = await f.originalFetch(new URL("/v1/device/config/thread", f.baseUrl), {
    method: "POST",
    headers: { ...f.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({ threadId: "thread_from_another_environment" }),
  });
  assert.equal(response.status, 404);

  const reread = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config", {
    headers: f.deviceHeaders,
  });
  assert.equal(reread.config.threadId, "thread_a", "the rejected write changed nothing");
});

test("device thread selection rejects missing or blank thread ids", async (t) => {
  const f = await threadSelectionFixture(t);
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.environment.environment.id },
  });

  for (const body of [{}, { threadId: "   " }]) {
    const response = await f.originalFetch(new URL("/v1/device/config/thread", f.baseUrl), {
      method: "POST",
      headers: { ...f.deviceHeaders, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
});

test("thread selection is refused when the owner bound no environment", async (t) => {
  const f = await threadSelectionFixture(t);

  const listed = await f.originalFetch(new URL("/v1/device/threads", f.baseUrl), {
    headers: f.deviceHeaders,
  });
  assert.equal(listed.status, 409);

  const wrote = await f.originalFetch(new URL("/v1/device/config/thread", f.baseUrl), {
    method: "POST",
    headers: { ...f.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({ threadId: "thread_a" }),
  });
  assert.equal(wrote.status, 409);
});

test("a device may only write threadId, never widen its own scope", async (t) => {
  const f = await threadSelectionFixture(t);
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${f.created.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.environment.environment.id, shellCommand: "npm test" },
  });

  // Everything except threadId must be ignored, including an attempt to repoint the
  // device at another environment or hand itself a more permissive shell command.
  await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config/thread", {
    method: "POST",
    headers: f.deviceHeaders,
    body: {
      threadId: "thread_a",
      environmentId: "env_somewhere_else",
      shellCommand: "sudo rm -rf /",
      menu: ["status", "prompt", "shell", "macro", "media", "stop", "approve"],
    },
  });

  const reread = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config", {
    headers: f.deviceHeaders,
  });
  assert.equal(reread.config.threadId, "thread_a");
  assert.equal(reread.config.environmentId, f.environment.environment.id, "environment is owner-only");
  assert.equal(reread.config.shellCommand, "npm test", "shell command is owner-only");
});

test("an unclaimed device cannot list or select threads", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp({ config: { factoryToken: "factory-secret", demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const provisioned = await requestJson(originalFetch, baseUrl, "/v1/factory/devices", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: { label: "Unclaimed", profile: "next-coder" },
  });
  const headers = {
    "x-device-id": provisioned.device.id,
    "x-device-secret": provisioned.secret,
  };

  const listed = await originalFetch(new URL("/v1/device/threads", baseUrl), { headers });
  assert.equal(listed.status, 403);
  const wrote = await originalFetch(new URL("/v1/device/config/thread", baseUrl), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ threadId: "thread_a" }),
  });
  assert.equal(wrote.status, 403);
});

test("invalid device credentials cannot read or change thread selection", async (t) => {
  const f = await threadSelectionFixture(t);
  const badHeaders = {
    "x-device-id": f.created.device.id,
    "x-device-secret": "wrong-secret",
  };

  const listed = await f.originalFetch(new URL("/v1/device/threads", f.baseUrl), { headers: badHeaders });
  assert.equal(listed.status, 401);
  const wrote = await f.originalFetch(new URL("/v1/device/config/thread", f.baseUrl), {
    method: "POST",
    headers: { ...badHeaders, "content-type": "application/json" },
    body: JSON.stringify({ threadId: "thread_a" }),
  });
  assert.equal(wrote.status, 401);
});

// --- Device environment and project selection -------------------------------
//
// Threads were the whole picker a controller could offer, and the environment was a
// choice only the console could make. These give the hardware the two levels above a
// thread — which machine, which folder — without loosening the boundary that matters:
// every id is resolved through the claiming owner's own scope, or validated against
// the live snapshot of the environment already bound.

const ENVIRONMENT_FIXTURE_SNAPSHOTS = {
  "bound-t3.example": {
    projects: [
      {
        id: "proj_alpha",
        title: "Alpha folder",
        defaultModelSelection: { instanceId: "codex", model: "gpt-5.6" },
      },
      { id: "proj_beta", name: "Beta folder" },
      // No default model selection, and no thread of its own to derive one from: the folder a
      // controller is most likely to be pointed at, and the one that used to be a dead end.
      { id: "proj_empty", title: "Empty folder" },
    ],
    threads: [
      { id: "thread_a", title: "Alpha one", projectId: "proj_alpha", session: { status: "stopped" } },
      {
        id: "thread_b",
        title: "Alpha two",
        projectId: "proj_alpha",
        session: { status: "stopped" },
        latestTurn: { state: "running" },
      },
      { id: "thread_c", title: "Beta one", projectId: "proj_beta", session: { status: "stopped" } },
      { id: "thread_orphan", title: "No folder", session: { status: "stopped" } },
    ],
  },
  "spare-t3.example": {
    projects: [{ id: "proj_spare", title: "Spare folder" }],
    threads: [{ id: "thread_spare", title: "Spare one", projectId: "proj_spare", session: { status: "stopped" } }],
  },
  "intruder-t3.example": {
    projects: [{ id: "proj_intruder", title: "Not yours" }],
    threads: [{ id: "thread_intruder", title: "Not yours either", projectId: "proj_intruder" }],
  },
};

async function environmentSelectionFixture(t, { snapshotError = null, dispatchError = null } = {}) {
  const originalFetch = globalThis.fetch;
  // A per-fixture copy, so a test that creates a thread sees it in the next snapshot the way a
  // real T3 would, without leaking the new thread into every other test in this file.
  const snapshots = structuredClone(ENVIRONMENT_FIXTURE_SNAPSHOTS);
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      if (snapshotError) throw snapshotError;
      const snapshot = snapshots[parsed.hostname];
      if (!snapshot) return jsonResponse({ error: "unknown host" }, 404);
      return jsonResponse(snapshot, 200);
    }
    if (parsed.pathname === "/api/orchestration/dispatch") {
      const command = JSON.parse(init.body);
      dispatches.push(command);
      if (dispatchError) return jsonResponse({ error: dispatchError }, 503);
      const snapshot = snapshots[parsed.hostname];
      if (snapshot && command.type === "thread.create") {
        snapshot.threads.push({
          id: command.threadId,
          title: command.title,
          projectId: command.projectId,
          session: { status: "stopped" },
        });
      }
      return jsonResponse({ sequence: dispatches.length }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const runtime = createApp();
  const { server } = runtime;
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Bezel controller", profile: "next-coder" },
  });
  const deviceHeaders = {
    "x-device-id": created.device.id,
    "x-device-secret": created.secret,
  };

  const bound = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Bound T3", baseUrl: "https://bound-t3.example", accessToken: "tok" },
  });
  const spare = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Spare T3", baseUrl: "https://spare-t3.example", accessToken: "tok" },
  });

  // A second account, so "not yours" can be tested against a real environment rather
  // than an invented id that any lookup would miss anyway.
  const intruderToken = await requestJson(originalFetch, baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_intruder", email: "intruder@example.local" },
  });
  const intruderHeaders = { authorization: `Bearer ${intruderToken.apiToken.secret}` };
  const foreign = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: intruderHeaders,
    body: { label: "Intruder T3", baseUrl: "https://intruder-t3.example", accessToken: "tok" },
  });

  const bind = async (body) => requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body,
  });
  const deviceConfig = async () => (await requestJson(originalFetch, baseUrl, "/v1/device/config", {
    headers: deviceHeaders,
  })).config;

  return {
    originalFetch,
    baseUrl,
    authHeaders,
    created,
    deviceHeaders,
    dispatches,
    snapshots,
    store: runtime.store,
    bound: bound.environment,
    spare: spare.environment,
    foreign: foreign.environment,
    bind,
    deviceConfig,
  };
}

test("a device lists its owner's environments and flags the bound one", async (t) => {
  const f = await environmentSelectionFixture(t);

  // Answered before anything is bound: a controller with no environment is exactly the
  // one that needs the list.
  const unbound = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/environments", {
    headers: f.deviceHeaders,
  });
  assert.equal(unbound.environmentId, null);
  assert.equal(unbound.environmentsTruncated, false);
  assert.deepEqual(unbound.environments.map((environment) => environment.id), [f.bound.id, f.spare.id]);
  assert.equal(unbound.environments.every((environment) => environment.selected === false), true);

  const observedAt = new Date().toISOString();
  await f.store.updateEnvironmentHealth({
    userId: "user_dev",
    environmentId: f.bound.id,
    status: "reachable",
    health: { lastCheckedAt: observedAt, lastReachableAt: observedAt, lastError: null, failureReason: null },
  });
  await f.store.updateEnvironmentCatalogue({
    userId: "user_dev",
    environmentId: f.bound.id,
    catalogue: {
      updatedAt: observedAt,
      instances: [{ status: "ready", auth: { status: "authenticated" }, models: [{ slug: "gpt-5" }] }],
    },
  });
  await f.bind({ environmentId: f.bound.id });
  const listed = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/environments", {
    headers: f.deviceHeaders,
  });
  assert.equal(listed.environmentId, f.bound.id);
  assert.deepEqual(listed.environments[0].health, {
    transport: "direct",
    freshness: "live",
    connector: "not_applicable",
    t3: "ready",
      provider: "ready",
      capability: "unknown",
    observedAt,
    action: "READY",
  });
  assert.deepEqual(
    listed.environments.map((environment) => ({
      id: environment.id,
      label: environment.label,
      selected: environment.selected,
      tokenExpired: environment.tokenExpired,
    })),
    [
      { id: f.bound.id, label: "Bound T3", selected: true, tokenExpired: false },
      { id: f.spare.id, label: "Spare T3", selected: false, tokenExpired: false },
    ],
  );

  // Another account's environment is not in the listing, and nothing token-bearing is.
  assert.equal(listed.environments.some((environment) => environment.id === f.foreign.id), false);
  assert.equal(JSON.stringify(listed).includes("accessToken"), false);
  assert.equal(JSON.stringify(listed).includes("intruder-t3.example"), false);
});

test("device environment health separates connector, T3, and provider action layers", async (t) => {
  const f = await environmentSelectionFixture(t);
  const enrolled = await f.store.createConnector({
    userId: "user_dev",
    environmentId: f.spare.id,
    scopes: ["connector:connect", "t3:proxy"],
  });
  await f.store.recordConnectorPresence({
    connectorId: enrolled.connector.id,
    environmentId: f.spare.id,
    connected: true,
    t3Health: "ready",
    providerCatalogue: {
      updatedAt: new Date().toISOString(),
      instances: [{ status: "auth_required", auth: { status: "required" }, models: [] }],
    },
  });

  let listed = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/environments", {
    headers: f.deviceHeaders,
  });
  let connectorRow = listed.environments.find((environment) => environment.id === f.spare.id);
  assert.equal(connectorRow.health.transport, "connector");
  assert.equal(connectorRow.health.freshness, "live");
  assert.equal(connectorRow.health.connector, "online");
  assert.equal(connectorRow.health.t3, "ready");
  assert.equal(connectorRow.health.provider, "auth_required");
  assert.equal(connectorRow.health.action, "AUTH PROVIDER");
  assert.match(connectorRow.health.observedAt, /^\d{4}-\d{2}-\d{2}T/u);

  await f.store.recordConnectorPresence({
    connectorId: enrolled.connector.id,
    environmentId: f.spare.id,
    connected: true,
    t3Health: "auth_failed",
    providerCatalogue: {
      updatedAt: new Date().toISOString(),
      instances: [{ status: "ready", auth: { status: "authenticated" }, models: [{ slug: "gpt-5" }] }],
    },
  });
  listed = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/environments", {
    headers: f.deviceHeaders,
  });
  connectorRow = listed.environments.find((environment) => environment.id === f.spare.id);
  assert.equal(connectorRow.health.t3, "auth_failed");
  assert.equal(connectorRow.health.provider, "ready");
  assert.equal(connectorRow.health.action, "FIX T3 AUTH");

  await f.store.recordConnectorPresence({
    connectorId: enrolled.connector.id,
    environmentId: f.spare.id,
    connected: false,
    t3Health: "ready",
  });
  listed = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/environments", {
    headers: f.deviceHeaders,
  });
  connectorRow = listed.environments.find((environment) => environment.id === f.spare.id);
  assert.equal(connectorRow.health.connector, "offline");
  assert.equal(connectorRow.health.freshness, "stale");
  assert.equal(connectorRow.health.action, "START CONNECTOR");
});

test("device environment projection is bounded and redacts health and provider details", async (t) => {
  const f = await environmentSelectionFixture(t);
  const secret = "device-projection-must-not-leak-this-value";
  await f.store.updateEnvironmentHealth({
    userId: "user_dev",
    environmentId: f.bound.id,
    status: "unreachable",
    health: { lastCheckedAt: new Date().toISOString(), failureReason: "unknown", lastError: secret },
  });
  await f.store.updateEnvironmentCatalogue({
    userId: "user_dev",
    environmentId: f.bound.id,
    catalogue: {
      updatedAt: new Date().toISOString(),
      instances: [{ instanceId: secret, status: "error", auth: { status: "unknown" }, models: [{ slug: secret }] }],
    },
  });
  for (let index = 0; index < 10; index += 1) {
    await f.store.upsertEnvironment({
      userId: "user_dev",
      label: `Environment ${index} ${"x".repeat(100)}`,
      baseUrl: `https://host-${index}.example/${secret}`,
      accessToken: secret,
      scopes: ["orchestration:read"],
      status: "unchecked",
    });
  }

  const listed = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/environments", {
    headers: f.deviceHeaders,
  });
  const serialized = JSON.stringify(listed);
  assert.equal(listed.environmentsTruncated, true);
  assert.equal(listed.environments.length, 8);
  assert.equal(listed.environments.every((environment) => environment.label.length <= 64), true);
  assert.equal(serialized.length < 5_000, true, `device projection was ${serialized.length} bytes`);
  assert.equal(serialized.includes(secret), false);
  for (const forbidden of ["baseUrl", "accessToken", "lastError", "providerCatalogue", "models", "scopes"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} crossed the device boundary`);
  }
});

test("a device can bind itself to one of its owner's environments", async (t) => {
  const f = await environmentSelectionFixture(t);
  await f.bind({ environmentId: f.bound.id, threadId: "thread_a" });

  const updated = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config/environment", {
    method: "POST",
    headers: f.deviceHeaders,
    body: { environmentId: f.spare.id },
  });
  assert.equal(updated.config.environmentId, f.spare.id);
  // A thread id from the environment that was just left behind means nothing here.
  assert.equal(updated.config.threadId, null);
  assert.equal(updated.config.projectId, null);

  assert.equal((await f.deviceConfig()).environmentId, f.spare.id, "the choice is durable");

  const audit = await requestJson(f.originalFetch, f.baseUrl, "/v1/audit", { headers: f.authHeaders });
  const event = audit.events.findLast((entry) => (
    entry.action === "device.config_updated" && entry.metadata?.environmentId === f.spare.id
  ));
  assert.equal(event?.actorType, "device", "the hardware is credited, not the owner");
  assert.equal(event?.actorId, f.created.device.id);
});

test("re-binding the environment a device already has keeps its project and thread", async (t) => {
  const f = await environmentSelectionFixture(t);
  await f.bind({ environmentId: f.bound.id, projectId: "proj_alpha", threadId: "thread_a" });

  const updated = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config/environment", {
    method: "POST",
    headers: f.deviceHeaders,
    body: { environmentId: f.bound.id },
  });
  assert.equal(updated.config.environmentId, f.bound.id);
  assert.equal(updated.config.projectId, "proj_alpha");
  assert.equal(updated.config.threadId, "thread_a");
});

test("a device cannot bind an environment belonging to another owner", async (t) => {
  const f = await environmentSelectionFixture(t);
  await f.bind({ environmentId: f.bound.id });

  const response = await f.originalFetch(new URL("/v1/device/config/environment", f.baseUrl), {
    method: "POST",
    headers: { ...f.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({ environmentId: f.foreign.id }),
  });
  assert.equal(response.status, 404);
  assert.equal((await f.deviceConfig()).environmentId, f.bound.id, "the rejected write changed nothing");
});

test("environment selection rejects unknown, missing or blank ids", async (t) => {
  const f = await environmentSelectionFixture(t);
  await f.bind({ environmentId: f.bound.id });

  const unknown = await f.originalFetch(new URL("/v1/device/config/environment", f.baseUrl), {
    method: "POST",
    headers: { ...f.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({ environmentId: "env_does_not_exist" }),
  });
  assert.equal(unknown.status, 404);

  for (const body of [{}, { environmentId: "   " }]) {
    const response = await f.originalFetch(new URL("/v1/device/config/environment", f.baseUrl), {
      method: "POST",
      headers: { ...f.deviceHeaders, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
  assert.equal((await f.deviceConfig()).environmentId, f.bound.id);
});

test("a device lists the projects in its bound environment with thread counts", async (t) => {
  const f = await environmentSelectionFixture(t);
  await f.bind({ environmentId: f.bound.id, projectId: "proj_beta" });

  const listed = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/projects", {
    headers: f.deviceHeaders,
  });
  assert.equal(listed.environmentId, f.bound.id);
  assert.equal(listed.projectId, "proj_beta");
  assert.deepEqual(listed.projects, [
    { id: "proj_alpha", title: "Alpha folder", threadCount: 2, selected: false },
    { id: "proj_beta", title: "Beta folder", threadCount: 1, selected: true },
    { id: "proj_empty", title: "Empty folder", threadCount: 0, selected: false },
  ]);
});

test("a device can select a project and its thread list narrows to that folder", async (t) => {
  const f = await environmentSelectionFixture(t);
  await f.bind({ environmentId: f.bound.id });

  // With no project bound the whole environment stays visible, orphan thread included.
  const everything = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    headers: f.deviceHeaders,
  });
  assert.deepEqual(everything.threads.map((thread) => thread.id), [
    "thread_a",
    "thread_b",
    "thread_c",
    "thread_orphan",
  ]);
  assert.equal(everything.projectId, null);

  const updated = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config/project", {
    method: "POST",
    headers: f.deviceHeaders,
    body: { projectId: "proj_alpha" },
  });
  assert.equal(updated.config.projectId, "proj_alpha");
  assert.equal(updated.config.environmentId, f.bound.id, "the bound environment survives a project change");

  const narrowed = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    headers: f.deviceHeaders,
  });
  assert.equal(narrowed.projectId, "proj_alpha");
  assert.deepEqual(narrowed.threads, [
    { id: "thread_a", title: "Alpha one", status: "stopped", selected: false },
    { id: "thread_b", title: "Alpha two", status: "running", selected: false },
  ]);

  // A thread outside the folder is no longer selectable, and one inside it is.
  const outside = await f.originalFetch(new URL("/v1/device/config/thread", f.baseUrl), {
    method: "POST",
    headers: { ...f.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({ threadId: "thread_c" }),
  });
  assert.equal(outside.status, 404);
  const inside = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config/thread", {
    method: "POST",
    headers: f.deviceHeaders,
    body: { threadId: "thread_b" },
  });
  assert.equal(inside.config.threadId, "thread_b");
});

test("selecting a project drops a thread from outside it but keeps one inside", async (t) => {
  const f = await environmentSelectionFixture(t);
  await f.bind({ environmentId: f.bound.id, threadId: "thread_c" });

  const moved = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config/project", {
    method: "POST",
    headers: f.deviceHeaders,
    body: { projectId: "proj_alpha" },
  });
  assert.equal(moved.config.threadId, null, "a thread the list no longer offers must not keep driving dispatch");

  await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config/thread", {
    method: "POST",
    headers: f.deviceHeaders,
    body: { threadId: "thread_a" },
  });
  const stayed = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/config/project", {
    method: "POST",
    headers: f.deviceHeaders,
    body: { projectId: "proj_alpha" },
  });
  assert.equal(stayed.config.threadId, "thread_a", "a thread inside the chosen folder is untouched");
});

test("a device cannot select a project that is not in its bound environment", async (t) => {
  const f = await environmentSelectionFixture(t);
  await f.bind({ environmentId: f.bound.id, projectId: "proj_alpha" });

  for (const projectId of ["proj_spare", "proj_intruder", "proj_invented"]) {
    const response = await f.originalFetch(new URL("/v1/device/config/project", f.baseUrl), {
      method: "POST",
      headers: { ...f.deviceHeaders, "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    assert.equal(response.status, 404, `${projectId} must not be reachable`);
  }
  assert.equal((await f.deviceConfig()).projectId, "proj_alpha", "the rejected writes changed nothing");

  for (const body of [{}, { projectId: "  " }]) {
    const response = await f.originalFetch(new URL("/v1/device/config/project", f.baseUrl), {
      method: "POST",
      headers: { ...f.deviceHeaders, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
});

test("project listing and selection are refused when the owner bound no environment", async (t) => {
  const f = await environmentSelectionFixture(t);

  const listed = await f.originalFetch(new URL("/v1/device/projects", f.baseUrl), {
    headers: f.deviceHeaders,
  });
  assert.equal(listed.status, 409);

  const wrote = await f.originalFetch(new URL("/v1/device/config/project", f.baseUrl), {
    method: "POST",
    headers: { ...f.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({ projectId: "proj_alpha" }),
  });
  assert.equal(wrote.status, 409);
});

test("project listing reports a bound T3 host outage as an actionable gateway error", async (t) => {
  const f = await environmentSelectionFixture(t, { snapshotError: new Error("connect ECONNREFUSED") });
  await f.bind({ environmentId: f.bound.id });

  const response = await f.originalFetch(new URL("/v1/device/projects", f.baseUrl), {
    headers: f.deviceHeaders,
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.details.code, "t3_unreachable");
  assert.equal(body.error.details.environmentId, f.bound.id);
});

test("invalid credentials and unclaimed devices cannot browse environments or projects", async (t) => {
  const f = await environmentSelectionFixture(t);
  await f.bind({ environmentId: f.bound.id });
  const badHeaders = {
    "x-device-id": f.created.device.id,
    "x-device-secret": "wrong-secret",
  };

  for (const path of ["/v1/device/environments", "/v1/device/projects"]) {
    const response = await f.originalFetch(new URL(path, f.baseUrl), { headers: badHeaders });
    assert.equal(response.status, 401, path);
  }
  for (const [path, body] of [
    ["/v1/device/config/environment", { environmentId: f.bound.id }],
    ["/v1/device/config/project", { projectId: "proj_alpha" }],
  ]) {
    const response = await f.originalFetch(new URL(path, f.baseUrl), {
      method: "POST",
      headers: { ...badHeaders, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 401, path);
  }

  const { server } = createApp({ config: { factoryToken: "factory-secret", demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const factoryBaseUrl = `http://127.0.0.1:${server.address().port}`;
  const provisioned = await requestJson(f.originalFetch, factoryBaseUrl, "/v1/factory/devices", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: { label: "Unclaimed", profile: "next-coder" },
  });
  const unclaimedHeaders = {
    "x-device-id": provisioned.device.id,
    "x-device-secret": provisioned.secret,
  };
  for (const path of ["/v1/device/environments", "/v1/device/projects"]) {
    const response = await f.originalFetch(new URL(path, factoryBaseUrl), { headers: unclaimedHeaders });
    assert.equal(response.status, 403, path);
  }
  const wrote = await f.originalFetch(new URL("/v1/device/config/environment", factoryBaseUrl), {
    method: "POST",
    headers: { ...unclaimedHeaders, "content-type": "application/json" },
    body: JSON.stringify({ environmentId: f.bound.id }),
  });
  assert.equal(wrote.status, 403);
});

test("a device creates a thread in its bound project and is left pointing at it", async (t) => {
  const f = await environmentSelectionFixture(t);
  await f.bind({ environmentId: f.bound.id, projectId: "proj_empty" });
  const stale = await f.originalFetch(new URL("/v1/device/threads", f.baseUrl), {
    method: "POST", headers: { ...f.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: "dev:stale-create-0001", expectedEnvironmentId: f.bound.id, expectedProjectId: "old_project" }),
  });
  assert.equal(stale.status, 409);
  const staleDetails = (await stale.json()).error.details;
  assert.equal(staleDetails.code, "device_context_changed");
  assert.equal(staleDetails.request.status, "failed");

  const response = await f.originalFetch(new URL("/v1/device/threads", f.baseUrl), {
    method: "POST",
    headers: { ...f.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: "dev:thread-create-0001" }),
  });
  assert.equal(response.status, 201, "a create answers 201, not 200");
  const created = await response.json();

  assert.equal(created.environmentId, f.bound.id);
  assert.equal(created.projectId, "proj_empty");
  assert.match(created.threadId, /^thread_/u);
  assert.equal(created.thread.id, created.threadId);
  assert.equal(created.thread.selected, true);
  assert.equal(created.command.status, "completed");

  const duplicateResponse = await f.originalFetch(new URL("/v1/device/threads", f.baseUrl), {
    method: "POST",
    headers: { ...f.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: "dev:thread-create-0001" }),
  });
  assert.equal(duplicateResponse.status, 200);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.threadId, created.threadId);
  assert.equal(duplicate.command.id, created.command.id);

  // The wire command is T3's own `thread.create`, with every field its schema requires.
  assert.equal(f.dispatches.length, 1);
  const dispatched = f.dispatches[0];
  assert.equal(dispatched.type, "thread.create");
  assert.equal(dispatched.threadId, created.threadId);
  assert.equal(dispatched.projectId, "proj_empty");
  assert.equal(dispatched.title, created.thread.title);
  assert.equal(dispatched.runtimeMode, "approval-required");
  assert.equal(dispatched.interactionMode, "default");
  // `NullOr`, not optional: both keys have to be on the wire.
  assert.equal(Object.hasOwn(dispatched, "branch"), true);
  assert.equal(Object.hasOwn(dispatched, "worktreePath"), true);
  assert.equal(dispatched.branch, null);
  assert.equal(dispatched.worktreePath, null);
  // The folder has no default of its own, so the environment's snapshot-derived harness answers.
  assert.deepEqual(dispatched.modelSelection, { instanceId: "codex", model: "gpt-5.6", options: [] });
  assert.match(dispatched.createdAt, /^\d{4}-\d{2}-\d{2}T/u);

  // Selection is durable, and the thread the device just made is the one it is on.
  assert.equal((await f.deviceConfig()).threadId, created.threadId);
  const listed = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    headers: f.deviceHeaders,
  });
  assert.equal(listed.projectId, "proj_empty");
  assert.deepEqual(listed.threads, [
    { id: created.threadId, title: created.thread.title, status: "stopped", selected: true },
  ]);
});

test("a created thread's name identifies the controller and the moment, and never repeats", async (t) => {
  const f = await environmentSelectionFixture(t);
  await f.bind({ environmentId: f.bound.id, projectId: "proj_empty" });

  const first = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    method: "POST",
    headers: f.deviceHeaders,
    body: {},
  });
  const second = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    method: "POST",
    headers: f.deviceHeaders,
    body: {},
  });
  const third = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    method: "POST",
    headers: f.deviceHeaders,
    body: {},
  });

  // The device that made it is named, so a two-controller account can tell them apart.
  assert.match(first.thread.title, /Bezel controller$/u);
  // Two creates in the same minute — and possibly the same second — still list as two rows.
  const titles = [first.thread.title, second.thread.title, third.thread.title];
  assert.equal(new Set(titles).size, 3, titles.join(" | "));
  assert.equal(second.thread.title, `${first.thread.title} (2)`);
  assert.equal(third.thread.title, `${first.thread.title} (3)`);

  const listed = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    headers: f.deviceHeaders,
  });
  assert.deepEqual(listed.threads.map((thread) => thread.title), titles);
});

test("a firmware-supplied thread title wins, and an unusable one falls back", async (t) => {
  const f = await environmentSelectionFixture(t);
  await f.bind({ environmentId: f.bound.id, projectId: "proj_empty" });

  const named = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    method: "POST",
    headers: f.deviceHeaders,
    body: { title: "  Fix   the   build\n " },
  });
  assert.equal(named.thread.title, "Fix the build");

  // Blank, whitespace-only and non-string titles are not errors: the gateway always has a name.
  for (const title of ["   ", "", 42, null]) {
    const fallback = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
      method: "POST",
      headers: f.deviceHeaders,
      body: { title },
    });
    assert.match(fallback.thread.title, /Bezel controller/u);
  }

  // Even a title the device chose cannot duplicate one already in the environment.
  const repeated = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    method: "POST",
    headers: f.deviceHeaders,
    body: { title: "Fix the build" },
  });
  assert.equal(repeated.thread.title, "Fix the build (2)");
});

test("thread creation is refused without a bound project or a bound environment", async (t) => {
  const f = await environmentSelectionFixture(t);

  // No environment at all.
  const unbound = await f.originalFetch(new URL("/v1/device/threads", f.baseUrl), {
    method: "POST",
    headers: { ...f.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(unbound.status, 409);
  assert.match((await unbound.json()).error.message, /environment/iu);

  // An environment, but no folder to create in.
  await f.bind({ environmentId: f.bound.id });
  const noProject = await f.originalFetch(new URL("/v1/device/threads", f.baseUrl), {
    method: "POST",
    headers: { ...f.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(noProject.status, 409);
  assert.match((await noProject.json()).error.message, /project/iu);
  assert.equal(f.dispatches.length, 0, "a refused create must not reach T3");
});

test("thread creation reports a bound T3 host outage as an actionable gateway error", async (t) => {
  const unreadable = await environmentSelectionFixture(t, { snapshotError: new Error("connect ECONNREFUSED") });
  await unreadable.bind({ environmentId: unreadable.bound.id, projectId: "proj_empty" });
  const response = await unreadable.originalFetch(new URL("/v1/device/threads", unreadable.baseUrl), {
    method: "POST",
    headers: { ...unreadable.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.details.code, "t3_unreachable");
  assert.equal(body.error.details.environmentId, unreadable.bound.id);
});

test("a T3 that reads but refuses the dispatch fails the create without binding the device", async (t) => {
  const f = await environmentSelectionFixture(t, { dispatchError: "temporary outage" });
  await f.bind({ environmentId: f.bound.id, projectId: "proj_alpha", threadId: "thread_a" });

  const response = await f.originalFetch(new URL("/v1/device/threads", f.baseUrl), {
    method: "POST",
    headers: { ...f.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.details.code, "t3_unreachable");
  assert.equal(body.error.details.command.status, "failed");
  assert.equal(typeof body.error.details.command.metrics.dispatchDurationMs, "number");

  // The thread the device was already on is untouched: a failed create moves nothing.
  assert.equal((await f.deviceConfig()).threadId, "thread_a");
});

test("a read-only device may browse threads but may not create one", async (t) => {
  const f = await environmentSelectionFixture(t);

  const observer = await requestJson(f.originalFetch, f.baseUrl, "/v1/devices", {
    method: "POST",
    headers: f.authHeaders,
    body: { label: "Wall display", profile: "read-only" },
  });
  const observerHeaders = {
    "x-device-id": observer.device.id,
    "x-device-secret": observer.secret,
  };
  await requestJson(f.originalFetch, f.baseUrl, `/v1/devices/${observer.device.id}/config`, {
    method: "PUT",
    headers: f.authHeaders,
    body: { environmentId: f.bound.id, projectId: "proj_alpha" },
  });

  // Reading is untouched — this profile has always been allowed to look.
  const listed = await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    headers: observerHeaders,
  });
  assert.equal(listed.threads.length, 2);

  const response = await f.originalFetch(new URL("/v1/device/threads", f.baseUrl), {
    method: "POST",
    headers: { ...observerHeaders, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.details.policy.dimension, "device");
  assert.equal(f.dispatches.length, 0, "a blocked profile must not reach T3");

  // The next-coder device on the same account is unaffected.
  await f.bind({ environmentId: f.bound.id, projectId: "proj_alpha" });
  await requestJson(f.originalFetch, f.baseUrl, "/v1/device/threads", {
    method: "POST",
    headers: f.deviceHeaders,
    body: {},
  });
  assert.equal(f.dispatches.length, 1);
});

test("thread creation refuses bad credentials and unclaimed hardware", async (t) => {
  const f = await environmentSelectionFixture(t);
  await f.bind({ environmentId: f.bound.id, projectId: "proj_alpha" });

  const badCredentials = await f.originalFetch(new URL("/v1/device/threads", f.baseUrl), {
    method: "POST",
    headers: {
      "x-device-id": f.created.device.id,
      "x-device-secret": "wrong-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  assert.equal(badCredentials.status, 401);

  const { server } = createApp({ config: { factoryToken: "factory-secret", demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const factoryBaseUrl = `http://127.0.0.1:${server.address().port}`;
  const provisioned = await requestJson(f.originalFetch, factoryBaseUrl, "/v1/factory/devices", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: { label: "Unclaimed", profile: "next-coder" },
  });
  const unclaimed = await f.originalFetch(new URL("/v1/device/threads", factoryBaseUrl), {
    method: "POST",
    headers: {
      "x-device-id": provisioned.device.id,
      "x-device-secret": provisioned.secret,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  assert.equal(unclaimed.status, 403);
  assert.equal(f.dispatches.length, 0);
});

test("the device display payload carries the owner's configured menu, not a generic one", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Menu controller", profile: "next-coder" },
  });
  const deviceHeaders = {
    "x-device-id": created.device.id,
    "x-device-secret": created.secret,
  };

  await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: { menu: ["status", "thread", "stop"] },
  });

  // Firmware applies the display menu every few seconds and the config menu once a
  // minute, so a generic menu here would quietly undo the owner's choice.
  const display = await requestJson(originalFetch, baseUrl, "/v1/device/display", {
    headers: deviceHeaders,
  });
  assert.deepEqual(display.display.menu, ["status", "thread", "stop"]);
});

test("a full device menu round-trips without silently dropping entries", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Full menu controller", profile: "next-coder" },
  });

  // Seven entries: previously capped at six, which dropped "stop" off the end with
  // no error, quietly removing the ability to halt a session from the hardware.
  const menu = ["status", "prompt", "shell", "macro", "thread", "media", "stop"];
  const updated = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: { menu },
  });
  assert.deepEqual(updated.config.menu, menu);

  // And the device must be served the same list it was configured with.
  const display = await requestJson(originalFetch, baseUrl, "/v1/device/display", {
    headers: { "x-device-id": created.device.id, "x-device-secret": created.secret },
  });
  assert.deepEqual(display.display.menu, menu);
});

test("the destructive reset entry is assignable to a device menu", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Resettable controller", profile: "next-coder" },
  });

  // "reset" opens an on-device confirmation screen that wipes Wi-Fi, the config cache, the cached
  // claim code and any gateway override. It is owner-assigned rather than always present, so an
  // accidental dial press cannot reach a factory wipe on a device that was never given the entry.
  const menu = ["status", "prompt", "thread", "reset"];
  const updated = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: { menu },
  });
  assert.deepEqual(updated.config.menu, menu);

  const display = await requestJson(originalFetch, baseUrl, "/v1/device/display", {
    headers: { "x-device-id": created.device.id, "x-device-secret": created.secret },
  });
  assert.deepEqual(display.display.menu, menu);
});

test("devices declare which owner operations the gateway will accept", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Actionable controller", profile: "next-coder" },
  });
  assert.deepEqual(created.device.actions, {
    rotateSecret: true,
    transferReset: true,
    updateConfig: true,
    updateProfile: true,
    revoke: true,
    // Deleting is the inverse: unavailable until the credential is dead.
    delete: false,
  });

  const revoked = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/revoke`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  // Every one of these is refused once revoked, so a client that trusts this field cannot render a
  // control that returns 404 — which is the whole point of the server declaring it.
  assert.deepEqual(revoked.device.actions, {
    rotateSecret: false,
    transferReset: false,
    updateConfig: false,
    updateProfile: false,
    revoke: false,
    delete: true,
  });

  // The declaration has to match what the routes actually do, or it is just a second thing to
  // keep in sync. These are the guards it stands in for.
  for (const [path, body] of [
    [`/v1/devices/${created.device.id}/rotate-secret`, {}],
    [`/v1/devices/${created.device.id}/transfer-reset`, {}],
  ]) {
    const response = await originalFetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 404, `${path} must refuse a revoked device`);
  }
  const config = await originalFetch(new URL(`/v1/devices/${created.device.id}/config`, baseUrl), {
    method: "PUT",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ threadId: "thread_x" }),
  });
  assert.equal(config.status, 404, "config updates must refuse a revoked device");
});

test("a revoked device can be deleted, and an active one cannot", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Retired controller", profile: "next-coder" },
  });
  const deviceHeaders = {
    "x-device-id": created.device.id,
    "x-device-secret": created.secret,
  };
  assert.equal(created.device.actions.delete, false, "an active device is not deletable");

  // Deleting before revoking would drop the record while the credential still authenticates,
  // leaving hardware in the field the owner can no longer see or revoke.
  const premature = await originalFetch(new URL(`/v1/devices/${created.device.id}`, baseUrl), {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.equal(premature.status, 409);

  const revoked = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/revoke`, {
    method: "POST",
    headers: authHeaders,
    body: {},
  });
  assert.equal(revoked.device.actions.delete, true, "revoking is what unlocks deletion");

  const deleted = await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.device.id, created.device.id);

  const listed = await requestJson(originalFetch, baseUrl, "/v1/devices", { headers: authHeaders });
  assert.equal(listed.devices.length, 0, "the device is gone from the inventory");

  // The credential dies with the record rather than falling back to unclaimed-but-valid.
  const orphaned = await originalFetch(new URL("/v1/device/heartbeat", baseUrl), {
    method: "POST",
    headers: { ...deviceHeaders, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(orphaned.status, 401);

  const again = await originalFetch(new URL(`/v1/devices/${created.device.id}`, baseUrl), {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.equal(again.status, 404, "deleting twice is a 404, not a second success");

  // Deleting the controller must not erase the record of what it did.
  const audit = await requestJson(originalFetch, baseUrl, "/v1/audit", { headers: authHeaders });
  const actions = audit.events.map((event) => event.action);
  assert.ok(actions.includes("device.deleted"), "the deletion itself is audited");
  assert.ok(actions.includes("device.revoked"), "earlier history survives the delete");
});

test("one owner cannot delete another owner's revoked device", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tokenFor = async (userId) => {
    const created = await requestJson(originalFetch, baseUrl, "/v1/users/dev", {
      method: "POST",
      headers: {},
      body: { userId, email: `${userId}@example.local` },
    });
    return { authorization: `Bearer ${created.apiToken.secret}` };
  };
  const owner = await tokenFor("user_owner");
  const stranger = await tokenFor("user_stranger");

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: owner,
    body: { label: "Owned controller", profile: "next-coder" },
  });
  await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/revoke`, {
    method: "POST",
    headers: owner,
    body: {},
  });

  const attempt = await originalFetch(new URL(`/v1/devices/${created.device.id}`, baseUrl), {
    method: "DELETE",
    headers: stranger,
  });
  assert.equal(attempt.status, 404);

  const stillThere = await requestJson(originalFetch, baseUrl, "/v1/devices", { headers: owner });
  assert.equal(stillThere.devices.length, 1, "the owner's device survives a stranger's delete");
});

test("the display route answers from bounded reads and one owner never sees another's counts", async (t) => {
  // The display route is what a controller polls every five seconds. It used to fetch the whole
  // command list and the whole audit log to read `.length` and `.at(-1)` off them, which grew
  // without bound and timed out on the firmware side; it now goes through getDisplaySummary().
  // This drives the real write path rather than a seeded store, so the projection is exercised
  // against rows the gateway actually produced.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") return jsonResponse({ status: "accepted" }, 200);
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({ projects: [{ id: "p1" }], threads: [{ id: "t1" }] }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server, store } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const tokenFor = async (userId) => {
    const created = await requestJson(originalFetch, baseUrl, "/v1/users/dev", {
      method: "POST",
      headers: {},
      body: { userId, email: `${userId}@example.local` },
    });
    return { authorization: `Bearer ${created.apiToken.secret}` };
  };
  const owner = await tokenFor("user_display_owner");
  const stranger = await tokenFor("user_display_stranger");

  const device = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: owner,
    body: { label: "Polling controller", profile: "next-coder" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: owner,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });
  await requestJson(originalFetch, baseUrl, "/v1/device/intents", {
    method: "POST",
    headers: { "x-device-id": device.device.id, "x-device-secret": device.secret },
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_1",
      intent: { type: "agent_prompt", text: "Run the tests." },
    },
  });

  const display = await requestJson(originalFetch, baseUrl, "/v1/display", {
    method: "GET",
    headers: owner,
  });
  assert.deepEqual(Object.keys(display.display.counts), [
    "environments",
    "devices",
    "media",
    "macros",
    "commands",
    "audit",
    "onlineDevices",
    "offlineDevices",
  ]);
  assert.equal(display.display.counts.environments, 1);
  assert.equal(display.display.counts.devices, 1);
  assert.equal(display.display.counts.commands, 1);
  assert.equal(display.display.line1, "1 env / 1 devices");
  assert.equal(display.display.line2, "dispatched: agent_prompt");
  assert.ok(display.display.counts.audit > 0, "the intent left an audit trail");

  // The summary agrees with the collections it replaced, on data the gateway wrote itself.
  const summary = store.getDisplaySummary("user_display_owner");
  assert.equal(summary.counts.commands, store.listCommands("user_display_owner").length);
  assert.equal(summary.counts.audit, store.listAuditLogs("user_display_owner").length);
  assert.equal(summary.latestCommand.id, store.listCommands("user_display_owner").at(-1).id);
  assert.equal(summary.latestAudit.action, store.listAuditLogs("user_display_owner").at(-1).action);

  // A second account on the same gateway sees none of it.
  const other = await requestJson(originalFetch, baseUrl, "/v1/display", {
    method: "GET",
    headers: stranger,
  });
  assert.equal(other.display.counts.commands, 0);
  assert.equal(other.display.counts.devices, 0);
  assert.equal(other.display.counts.environments, 0);
  assert.equal(other.display.state, "setup");
  assert.equal(other.display.line2, "No commands yet");
  // Their own account creation is the only thing they have ever done, so that is the latest
  // action they see — not the owner's dispatch, which is newer.
  assert.equal(other.display.latestAction, "user_token.created");

  // The device-realm payload is the same base plus the device block firmware expects.
  const deviceDisplay = await requestJson(originalFetch, baseUrl, "/v1/device/display", {
    method: "GET",
    headers: { "x-device-id": device.device.id, "x-device-secret": device.secret },
  });
  assert.deepEqual(deviceDisplay.display.counts, display.display.counts);
  assert.equal(deviceDisplay.display.title, "Polling controller");
  assert.equal(deviceDisplay.display.device.id, device.device.id);
});

test("the discovery endpoint identifies the gateway without authentication", async (t) => {
  // A controller has no credentials at the moment it needs this: it is deciding whether a
  // candidate address, from a UDP reply or a typed URL, is a gateway at all.
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/v1/discovery`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.service, "next-coder");
  assert.equal(body.claimRequired, true);
  assert.equal(typeof body.name, "string");
});
