import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import {
  buildConnectorRotateCommand,
  buildConnectCommand,
  buildLegacyDirectConnectCommand,
  normalizeConnectAccessMode,
} from "../src/connectSession.mjs";
import { createMemoryStore } from "../src/store.mjs";

test("the console mints a connect code and the T3 host redeems it into an environment", async (t) => {
  const originalFetch = globalThis.fetch;
  const exchanges = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/oauth/token") {
      exchanges.push(Object.fromEntries(new URLSearchParams(String(init.body))));
      return jsonResponse({ access_token: "t3-access", expires_in: 3600 }, 200);
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

  const minted = await requestJson(originalFetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Studio Mac", accessMode: "tailscale" },
  });
  assert.equal(minted.session.status, "pending");
  assert.equal(minted.session.accessMode, "tailscale");
  assert.equal(minted.session.environmentId, null);
  assert.match(minted.code, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/u);
  // The one-liner is what the user copies; it has to name this gateway and carry the code.
  assert.equal(
    minted.command,
    `npx @next-coder/connector connect --server '${baseUrl}' --code '${minted.code}'`,
  );
  assert.equal(minted.command.includes("tailscale"), false, "access mode is not a connector CLI credential");
  assert.equal(minted.command.includes("token"), false, "the copyable command never carries a T3 token");

  // The console polls this while the user is still in a terminal on the other machine.
  const pending = await requestJson(originalFetch, baseUrl, `/v1/t3/connect-sessions/${minted.session.id}`, {
    headers: authHeaders,
  });
  assert.equal(pending.session.status, "pending");
  assert.equal(pending.environment, null);
  assert.equal(pending.session.codeHash, undefined, "the hash must never leave the gateway");

  // The host redeems with no platform credential of its own.
  const redeemed = await requestJson(originalFetch, baseUrl, "/v1/t3/connect-sessions/redeem", {
    method: "POST",
    body: {
      code: minted.code,
      baseUrl: "https://mac.tailnet.ts.net",
      pairingToken: "pair_once",
      instances: [{
        instanceId: "anthropic",
        status: "ready",
        models: [{ id: "claude-opus-5", displayName: "Opus" }],
      }],
    },
  });
  assert.equal(redeemed.session.status, "completed");
  assert.equal(redeemed.environment.label, "Studio Mac", "the console's label wins over the script's");
  assert.equal(redeemed.environment.baseUrl, "https://mac.tailnet.ts.net");
  assert.equal(redeemed.environment.status, "reachable", "redeeming health-checks the host it just paired");
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].subject_token, "pair_once");
  assert.equal(redeemed.catalogue.instances.length, 1, "the host registers its provider caches inline");

  const completed = await requestJson(originalFetch, baseUrl, `/v1/t3/connect-sessions/${minted.session.id}`, {
    headers: authHeaders,
  });
  assert.equal(completed.session.status, "completed");
  assert.equal(completed.session.environmentId, redeemed.environment.id);
  assert.equal(completed.environment.id, redeemed.environment.id);
  assert.equal(completed.environment.accessToken, undefined, "polling must not hand the browser a token");

  const environments = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", { headers: authHeaders });
  assert.equal(environments.environments.length, 1);
});

test("a connect code is single use and an expired one is refused as expired", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/oauth/token") return jsonResponse({ access_token: "t3-access", expires_in: 3600 }, 200);
    if (parsed.pathname === "/api/orchestration/snapshot") return jsonResponse({ projects: [], threads: [] }, 200);
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const store = createMemoryStore();
  const { server } = createApp({ store });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const minted = await requestJson(originalFetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Replayed Mac" },
  });
  await requestJson(originalFetch, baseUrl, "/v1/t3/connect-sessions/redeem", {
    method: "POST",
    body: { code: minted.code, baseUrl: "https://replay.example", pairingToken: "pair_once" },
  });

  const replay = await originalFetch(new URL("/v1/t3/connect-sessions/redeem", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: minted.code, baseUrl: "https://replay.example", pairingToken: "pair_twice" }),
  });
  assert.equal(replay.status, 404, "a redeemed code is indistinguishable from one that never existed");

  // Expiry is refused as expired rather than swallowed as unknown, so the host can tell the user
  // to mint a fresh code instead of hunting for a typo.
  const expiring = await requestJson(originalFetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Stale Mac" },
  });
  const state = store.exportState();
  const stored = state.connectSessions.find((session) => session.id === expiring.session.id);
  stored.expiresAt = new Date(Date.now() - 1000).toISOString();

  const expired = await originalFetch(new URL("/v1/t3/connect-sessions/redeem", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: expiring.code, baseUrl: "https://stale.example", pairingToken: "pair_once" }),
  });
  assert.equal(expired.status, 410);

  const polled = await requestJson(originalFetch, baseUrl, `/v1/t3/connect-sessions/${expiring.session.id}`, {
    headers: authHeaders,
  });
  assert.equal(polled.session.status, "expired");
});

test("re-pairing through a connect session updates the environment in place", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/oauth/token") return jsonResponse({ access_token: "rotated", expires_in: 3600 }, 200);
    if (parsed.pathname === "/api/orchestration/snapshot") return jsonResponse({ projects: [], threads: [] }, 200);
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

  const first = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Studio Mac", baseUrl: "https://studio.tailnet.ts.net", accessToken: "stale-token" },
  });

  const minted = await requestJson(originalFetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Studio Mac", accessMode: "tailscale", environmentId: first.environment.id },
  });
  assert.equal(minted.session.environmentId, first.environment.id);

  // A re-pair that moved the host to a new URL is the hard case: matching on base URL alone would
  // add a second row for the same machine.
  const redeemed = await requestJson(originalFetch, baseUrl, "/v1/t3/connect-sessions/redeem", {
    method: "POST",
    body: { code: minted.code, baseUrl: "https://studio-2.tailnet.ts.net", pairingToken: "pair_again" },
  });
  assert.equal(redeemed.environment.id, first.environment.id);
  assert.equal(redeemed.environment.baseUrl, "https://studio-2.tailnet.ts.net");

  const environments = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", { headers: authHeaders });
  assert.equal(environments.environments.length, 1, "re-pairing must never create a second row for the same host");
  assert.equal(environments.environments[0].id, first.environment.id);
});

test("a failed exchange records the failure on the session instead of only in the terminal", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/oauth/token") return jsonResponse({ error: "invalid_grant" }, 400);
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

  const minted = await requestJson(originalFetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Broken Mac" },
  });
  const failed = await originalFetch(new URL("/v1/t3/connect-sessions/redeem", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: minted.code, baseUrl: "https://broken.example", pairingToken: "bad" }),
  });
  assert.ok(!failed.ok);

  const polled = await requestJson(originalFetch, baseUrl, `/v1/t3/connect-sessions/${minted.session.id}`, {
    headers: authHeaders,
  });
  assert.equal(polled.session.status, "failed");
  assert.ok(polled.session.error, "the console shows why, rather than spinning forever");

  const environments = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", { headers: authHeaders });
  assert.equal(environments.environments.length, 0);
});

test("a malformed redeem body is refused before the code is consumed", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/oauth/token") return jsonResponse({ access_token: "t3-access", expires_in: 3600 }, 200);
    if (parsed.pathname === "/api/orchestration/snapshot") return jsonResponse({ projects: [], threads: [] }, 200);
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

  const minted = await requestJson(originalFetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Careful Mac" },
  });

  const missingUrl = await originalFetch(new URL("/v1/t3/connect-sessions/redeem", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: minted.code, pairingToken: "pair_once" }),
  });
  assert.equal(missingUrl.status, 400);

  // Still usable: a typo in the command must not force the user back to the console for a new code.
  const redeemed = await requestJson(originalFetch, baseUrl, "/v1/t3/connect-sessions/redeem", {
    method: "POST",
    body: { code: minted.code, baseUrl: "https://careful.example", pairingToken: "pair_once" },
  });
  assert.equal(redeemed.session.status, "completed");
});

test("another user cannot poll someone else's connect session", async (t) => {
  const originalFetch = globalThis.fetch;
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const ownerHeaders = await createAuthHeaders(originalFetch, baseUrl, "user_owner");
  const strangerHeaders = await createAuthHeaders(originalFetch, baseUrl, "user_stranger");

  const minted = await requestJson(originalFetch, baseUrl, "/v1/t3/connect-sessions", {
    method: "POST",
    headers: ownerHeaders,
    body: { label: "Private Mac" },
  });
  const denied = await originalFetch(new URL(`/v1/t3/connect-sessions/${minted.session.id}`, baseUrl), {
    headers: strangerHeaders,
  });
  assert.equal(denied.status, 404);
});

test("the default connect command launches the published connector CLI with shell-safe arguments", () => {
  assert.equal(
    buildConnectCommand({ gatewayUrl: "https://gateway.example/", code: "ABCDE-FGHIJ", accessMode: "local" }),
    "npx @next-coder/connector connect --server 'https://gateway.example' --code 'ABCDE-FGHIJ'",
  );
  assert.equal(
    buildConnectCommand({ gatewayUrl: "https://gateway.example/path'o/", code: "CODE'VALUE", accessMode: "tailscale" }),
    `npx @next-coder/connector connect --server 'https://gateway.example/path'"'"'o' --code 'CODE'"'"'VALUE'`,
  );
  assert.equal(buildConnectCommand({ gatewayUrl: "https://gateway.example", code: "ABCDE-FGHIJ", accessMode: "online" }).includes("online"), false);
});

test("the rotation command is shell-safe and explicitly confirmed", () => {
  const command = buildConnectorRotateCommand({
    gatewayUrl: "https://controller.example/path'with-quote/",
    code: "ABCDE-'FGHIJ",
  });
  assert.match(command, /^npx @next-coder\/connector rotate /u);
  assert.match(command, /--server 'https:\/\/controller\.example\/path'"'"'with-quote'/u);
  assert.match(command, /--code 'ABCDE-'"'"'FGHIJ'/u);
  assert.match(command, / --yes$/u);
});

test("legacy direct setup is available only through its explicitly named builder", () => {
  assert.equal(
    buildLegacyDirectConnectCommand({ gatewayUrl: "https://gateway.example/", code: "ABCDE-FGHIJ", accessMode: "tailscale" }),
    "npm run setup:t3 -- --gateway-url 'https://gateway.example' --connect-code 'ABCDE-FGHIJ' --tunnel 'tailscale'",
  );
  assert.equal(normalizeConnectAccessMode("TAILSCALE"), "tailscale");
  assert.equal(normalizeConnectAccessMode("nonsense"), "local");
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function requestJson(fetchImpl, baseUrl, path, input = {}) {
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

async function createAuthHeaders(fetchImpl, baseUrl, userId = "user_dev") {
  const created = await requestJson(fetchImpl, baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId, email: `${userId}@example.local` },
  });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}
