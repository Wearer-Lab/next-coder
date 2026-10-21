import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";

const CUSTOM = {
  profileId: "prompt-only",
  label: "Prompt only",
  description: "Text prompts and status, nothing else.",
  capabilities: ["status", "agent_prompt"],
};

async function bootstrap(t) {
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = await createAuthHeaders(baseUrl);
  return { baseUrl, headers };
}

test("built-in profiles stay public and are flagged as built-in", async (t) => {
  const { baseUrl } = await bootstrap(t);
  const body = await requestJson(baseUrl, "/v1/device-profiles", {});
  assert.deepEqual(body.profiles.map((profile) => profile.id), [
    "next-coder", "read-only", "power-controller",
  ]);
  assert.equal(body.profiles.every((profile) => profile.builtin === true), true);
});

test("a custom profile is created, listed only for its owner, updated and deleted", async (t) => {
  const { baseUrl, headers } = await bootstrap(t);

  const created = await requestJson(baseUrl, "/v1/device-profiles", {
    method: "POST",
    headers,
    body: CUSTOM,
  });
  assert.equal(created.profile.id, "prompt-only");
  assert.equal(created.profile.builtin, false);
  assert.deepEqual(created.profile.capabilities, ["status", "agent_prompt"]);

  // Visible to the owner...
  const mine = await requestJson(baseUrl, "/v1/device-profiles", { headers });
  assert.ok(mine.profiles.some((profile) => profile.id === "prompt-only"));

  // ...but not to an anonymous caller.
  const anonymous = await requestJson(baseUrl, "/v1/device-profiles", {});
  assert.equal(anonymous.profiles.some((profile) => profile.id === "prompt-only"), false);

  const updated = await requestJson(baseUrl, "/v1/device-profiles/prompt-only", {
    method: "PUT",
    headers,
    body: { label: "Prompts only", capabilities: ["status", "agent_prompt", "media_prompt"] },
  });
  assert.equal(updated.profile.label, "Prompts only");
  assert.deepEqual(updated.profile.capabilities, ["status", "agent_prompt", "media_prompt"]);

  const deleted = await requestJson(baseUrl, "/v1/device-profiles/prompt-only", {
    method: "DELETE",
    headers,
  });
  assert.equal(deleted.profile.id, "prompt-only");

  const after = await requestJson(baseUrl, "/v1/device-profiles", { headers });
  assert.equal(after.profiles.some((profile) => profile.id === "prompt-only"), false);
});

test("custom profiles are validated and cannot shadow or edit built-ins", async (t) => {
  const { baseUrl, headers } = await bootstrap(t);

  const badCases = [
    [{ ...CUSTOM, capabilities: ["status", "not_a_capability"] }, 400],
    [{ ...CUSTOM, capabilities: "nope" }, 400],
    [{ ...CUSTOM, profileId: "" }, 400],
    [{ ...CUSTOM, profileId: "read-only" }, 409],
  ];
  for (const [body, expected] of badCases) {
    const response = await post(baseUrl, "/v1/device-profiles", headers, body);
    assert.equal(response.status, expected, `expected ${expected} for ${JSON.stringify(body).slice(0, 60)}`);
  }

  await requestJson(baseUrl, "/v1/device-profiles", { method: "POST", headers, body: CUSTOM });
  const duplicate = await post(baseUrl, "/v1/device-profiles", headers, CUSTOM);
  assert.equal(duplicate.status, 409, "a duplicate slug is a conflict");

  for (const method of ["PUT", "DELETE"]) {
    const response = await fetch(new URL("/v1/device-profiles/read-only", baseUrl), {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: method === "PUT" ? JSON.stringify({ label: "hacked" }) : undefined,
    });
    await response.text();
    assert.equal(response.status, 403, `built-ins must not be ${method}-able`);
  }
});

test("a custom profile actually gates what a device may do", async (t) => {
  const originalFetch = globalThis.fetch;
  let dispatched = 0;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/orchestration/dispatch") {
      dispatched += 1;
      return jsonResponse({ status: "accepted" }, 200);
    }
    if (path === "/api/orchestration/snapshot") return jsonResponse({ projects: [], threads: [] }, 200);
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = await createAuthHeaders(baseUrl, originalFetch);

  await requestJson(baseUrl, "/v1/device-profiles", { method: "POST", headers, body: CUSTOM }, originalFetch);
  const environment = await requestJson(baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "token" },
  }, originalFetch);

  const device = await requestJson(baseUrl, "/v1/devices", {
    method: "POST",
    headers,
    body: { label: "Restricted controller", profile: "prompt-only" },
  }, originalFetch);
  assert.equal(device.device.profile, "prompt-only");

  const deviceHeaders = {
    "content-type": "application/json",
    "x-device-id": device.device.id,
    "x-device-secret": device.secret,
  };
  const body = (intent) => JSON.stringify({
    environmentId: environment.environment.id,
    threadId: "thread_1",
    intent,
  });

  // agent_prompt is granted by the custom profile.
  const allowed = await originalFetch(new URL("/v1/device/intents", baseUrl), {
    method: "POST",
    headers: deviceHeaders,
    body: body({ type: "agent_prompt", text: "hello" }),
  });
  await allowed.text();
  assert.equal(allowed.status, 202, "a dispatched agent turn is accepted for asynchronous completion");
  assert.equal(dispatched, 1);

  // shell_input is NOT, so the custom capability list is genuinely enforced.
  const blocked = await originalFetch(new URL("/v1/device/intents", baseUrl), {
    method: "POST",
    headers: deviceHeaders,
    body: body({ type: "shell_input", command: "npm test" }),
  });
  const blockedBody = await blocked.json();
  assert.equal(blocked.status, 403);
  assert.equal(blockedBody.error.details.command.result.dimension, "device");
  assert.match(blockedBody.error.details.command.result.reason, /prompt-only/u);
  assert.equal(dispatched, 1, "a blocked intent must not reach T3");
});

test("a profile still assigned to a device cannot be deleted", async (t) => {
  const { baseUrl, headers } = await bootstrap(t);
  await requestJson(baseUrl, "/v1/device-profiles", { method: "POST", headers, body: CUSTOM });
  const device = await requestJson(baseUrl, "/v1/devices", {
    method: "POST",
    headers,
    body: { label: "Restricted", profile: "prompt-only" },
  });

  const response = await fetch(new URL("/v1/device-profiles/prompt-only", baseUrl), {
    method: "DELETE",
    headers: { "content-type": "application/json", ...headers },
  });
  const payload = await response.json();
  assert.equal(response.status, 409);
  assert.deepEqual(payload.error.details.deviceIds, [device.device.id]);
});

test("assigning an unknown or another user's profile is refused", async (t) => {
  const { baseUrl, headers } = await bootstrap(t);
  const response = await post(baseUrl, "/v1/devices", headers, { label: "X", profile: "does-not-exist" });
  assert.equal(response.status, 400);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function post(baseUrl, path, headers, body) {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  await response.text();
  return response;
}

async function requestJson(baseUrl, path, input, fetchImpl = fetch) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: input.method ?? "GET",
    headers: { "content-type": "application/json", ...(input.headers ?? {}) },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}: ${text}`);
  return JSON.parse(text);
}

async function createAuthHeaders(baseUrl, fetchImpl = fetch) {
  const auth = await requestJson(baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_dev", email: "dev@example.local" },
  }, fetchImpl);
  return { authorization: `Bearer ${auth.apiToken.secret}` };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
