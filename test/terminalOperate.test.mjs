import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { evaluateIntentPolicy } from "../src/policy.mjs";
import { DEVICE_CAPABILITIES, listDeviceProfiles } from "../src/profiles.mjs";
import { TERMINAL_SCOPE, environmentHasTerminalScope } from "../src/t3Ws.mjs";

const TERMINAL_PROFILE = {
  profileId: "terminal-operator",
  label: "Terminal operator",
  description: "Direct terminal write, always confirmed.",
  capabilities: ["status", "agent_prompt", "terminal_input"],
};

test("terminal_input is a real capability that no built-in profile grants", () => {
  assert.ok(DEVICE_CAPABILITIES.includes("terminal_input"));
  for (const profile of listDeviceProfiles()) {
    assert.equal(
      profile.capabilities.includes("terminal_input"),
      false,
      `${profile.id} must not grant terminal_input; the roadmap keeps it separate and opt-in`,
    );
  }
});

test("a profile without terminal_input blocks it outright", () => {
  const result = evaluateIntentPolicy({
    device: { profile: "next-coder" },
    intent: { type: "terminal_input", terminalId: "t1", data: "ls\n" },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.risk, "blocked");
  assert.equal(result.dimension, "device");
});

test("even a granting profile always requires confirmation", () => {
  const result = evaluateIntentPolicy({
    device: { profile: { id: "terminal-operator", capabilities: TERMINAL_PROFILE.capabilities } },
    intent: { type: "terminal_input", terminalId: "t1", data: "ls\n" },
  });
  assert.equal(result.allowed, false, "terminal input is never auto-dispatched");
  assert.equal(result.requiresApproval, true);
  assert.equal(result.risk, "high");
  assert.equal(result.matchedRule, "baseline.terminal-input");

  // A prompt on the same profile still dispatches normally.
  const prompt = evaluateIntentPolicy({
    device: { profile: { id: "terminal-operator", capabilities: TERMINAL_PROFILE.capabilities } },
    intent: { type: "agent_prompt", text: "hi" },
  });
  assert.equal(prompt.allowed, true);
});

test("the terminal scope is opt-in and not part of the standard pairing scopes", async (t) => {
  assert.equal(environmentHasTerminalScope({ scopes: ["orchestration:read"] }), false);
  assert.equal(environmentHasTerminalScope({ scopes: ["orchestration:read", TERMINAL_SCOPE] }), true);
  assert.equal(environmentHasTerminalScope({}), false);

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = await createAuthHeaders(baseUrl);

  const environment = await requestJson(baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers,
    body: { label: "Default scopes", baseUrl: "https://mock-t3.example", accessToken: "token" },
  });
  assert.equal(
    environment.environment.scopes.includes(TERMINAL_SCOPE),
    false,
    "pairing must not silently grant terminal:operate",
  );
});

test("terminal input is held for approval, then refused when the scope is missing", async (t) => {
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = await createAuthHeaders(baseUrl);

  await requestJson(baseUrl, "/v1/device-profiles", { method: "POST", headers, body: TERMINAL_PROFILE });
  const environment = await requestJson(baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers,
    body: { label: "No terminal scope", baseUrl: "https://mock-t3.example", accessToken: "token" },
  });
  const device = await requestJson(baseUrl, "/v1/devices", {
    method: "POST",
    headers,
    body: { label: "Terminal controller", profile: "terminal-operator" },
  });

  const response = await fetch(new URL("/v1/device/intents", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-id": device.device.id,
      "x-device-secret": device.secret,
    },
    body: JSON.stringify({
      environmentId: environment.environment.id,
      threadId: "thread_1",
      intent: { type: "terminal_input", terminalId: "term_1", data: "ls\n" },
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.command.status, "approval_required");
  assert.equal(payload.policy.requiresApproval, true);

  // Approving it must still fail: the environment never got terminal:operate.
  const approve = await fetch(new URL(`/v1/commands/${payload.command.id}/approve`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
  });
  const approveBody = await approve.json();
  assert.equal(approve.status, 403);
  assert.match(approveBody.error.message, /terminal:operate/u);
});

test("oversized or malformed terminal input is rejected before policy", async (t) => {
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = await createAuthHeaders(baseUrl);

  const environment = await requestJson(baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers,
    body: { label: "T3", baseUrl: "https://mock-t3.example", accessToken: "token" },
  });

  const cases = [
    { type: "terminal_input", data: "ls\n" },                                  // no terminalId
    { type: "terminal_input", terminalId: "t1" },                              // no data
    { type: "terminal_input", terminalId: "t1", data: "x".repeat(65_537) },    // over T3's cap
  ];
  for (const intent of cases) {
    const response = await fetch(new URL("/v1/intents", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ environmentId: environment.environment.id, threadId: "t", intent }),
    });
    await response.text();
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(intent).slice(0, 50)}`);
  }
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

async function createAuthHeaders(baseUrl) {
  const auth = await requestJson(baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_dev", email: "dev@example.local" },
  });
  return { authorization: `Bearer ${auth.apiToken.secret}` };
}
