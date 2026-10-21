import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { createStore } from "../src/store.mjs";

const FACTORY_CONFIG = { factoryToken: "factory-secret", demoMode: false };

test("factory provisioning returns a scannable claim label", async (t) => {
  const { server } = createApp({ config: FACTORY_CONFIG });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const result = await requestJson(baseUrl, "/v1/factory/devices", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: { label: "Factory controller", profile: "next-coder", gatewayBaseUrl: "https://gw.example" },
  });

  assert.ok(result.claimCode);
  assert.equal(
    result.claimUrl,
    `https://gw.example/claim?device=${result.device.id}&code=${result.claimCode}`,
  );
  assert.equal(result.claimLabelFilename, `${result.device.id}.claim-label.svg`);
  // The secret is returned exactly once, so the NVS seed has to be produced here or not at all.
  assert.equal(result.nvsSeedFilename, `${result.device.id}.nvs.csv`);
  assert.match(result.nvsSeed, /^agentctl,namespace,,$/mu);
  assert.match(result.nvsSeed, new RegExp(`^dev_id,data,string,${result.device.id}$`, "mu"));
  assert.ok(result.nvsSeed.includes(result.secret));
  assert.match(result.nvsSeed, /^gw_url,data,string,https:\/\/gw\.example$/mu);
  assert.match(result.claimLabelSvg, /^<svg|<\?xml/u);
  assert.match(result.claimLabelSvg, /<path/u, "the label must contain rendered QR modules");
  assert.ok(result.claimLabelSvg.includes(result.device.id));
});

test("batch provisioning labels every device", async (t) => {
  const { server } = createApp({ config: FACTORY_CONFIG });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const result = await requestJson(baseUrl, "/v1/factory/batches", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: { count: 3, profile: "next-coder", gatewayBaseUrl: "https://gw.example" },
  });

  assert.equal(result.devices.length, 3);
  const urls = new Set();
  for (const device of result.devices) {
    assert.ok(device.claimLabelSvg);
    assert.ok(device.claimUrl.startsWith("https://gw.example/claim?device="));
    assert.ok(device.flashConfig, "the existing flash config must still be produced");
    urls.add(device.claimUrl);
  }
  assert.equal(urls.size, 3, "each device needs a distinct claim URL");
});

test("a device setup code carries a claim URL for the QR on screen", async (t) => {
  const { server } = createApp({ config: { ...FACTORY_CONFIG, publicBaseUrl: "https://gw.example" } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const provisioned = await requestJson(baseUrl, "/v1/factory/devices", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: { label: "Unclaimed", profile: "next-coder" },
  });

  const setup = await requestJson(baseUrl, "/v1/device/setup-code", {
    method: "POST",
    headers: {
      "x-device-id": provisioned.device.id,
      "x-device-secret": provisioned.secret,
    },
    // The factory code is still live, so only an explicit rotate issues a replacement label.
    body: { rotate: true },
  });

  assert.equal(setup.setup.claimed, false);
  assert.equal(setup.setup.rotated, true);
  assert.ok(setup.setup.claimCode);
  assert.notEqual(setup.setup.claimCode, provisioned.claimCode);
  assert.equal(
    setup.setup.claimUrl,
    `https://gw.example/claim?device=${provisioned.device.id}&code=${setup.setup.claimCode}`,
  );
  assert.ok(setup.claimLabelSvg);
});

test("the claim deep link is served by the SPA", async (t) => {
  const { server } = createApp({ config: FACTORY_CONFIG });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(new URL("/claim?device=dev_1&code=ABCD1234", baseUrl));
  const body = await response.text();
  if (response.status === 404) {
    t.skip("dist/web is not built; run npm run build:app");
    return;
  }
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/u);
  assert.match(body, /<div id="root">|<script/u);
});

test("claim URLs and labels are redacted from support diagnostics", async (t) => {
  const { server } = createApp({ config: FACTORY_CONFIG });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const auth = await requestJson(baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_dev", email: "dev@example.local" },
  });
  const authHeaders = { authorization: `Bearer ${auth.apiToken.secret}` };

  const provisioned = await requestJson(baseUrl, "/v1/factory/devices", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: { label: "Factory controller", profile: "next-coder" },
  });
  await requestJson(baseUrl, "/v1/devices/claim", {
    method: "POST",
    headers: authHeaders,
    body: { claimCode: provisioned.claimCode, label: "Mine" },
  });

  const diagnostics = await requestJson(baseUrl, "/v1/support/diagnostics", { headers: authHeaders });
  const serialized = JSON.stringify(diagnostics);
  assert.ok(
    !serialized.includes(provisioned.claimCode),
    "a plaintext claim code must never reach a support bundle",
  );
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

test("a claim code survives boot, expires, and only rotates on request", async (t) => {
  const store = createStore();
  const { server } = createApp({ store, config: FACTORY_CONFIG });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const provisioned = await requestJson(baseUrl, "/v1/factory/devices", {
    method: "POST",
    headers: { authorization: "Bearer factory-secret" },
    body: { label: "Boxed controller", profile: "next-coder" },
  });
  const deviceHeaders = {
    "x-device-id": provisioned.device.id,
    "x-device-secret": provisioned.secret,
  };

  // Break 3: firmware polls this endpoint every 10 minutes while unclaimed. Under the old
  // always-rotate behaviour the code could change while the owner was typing it.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const poll = await requestJson(baseUrl, "/v1/device/setup-code", {
      method: "POST",
      headers: deviceHeaders,
      body: {},
    });
    assert.equal(poll.setup.rotated, false);
    assert.equal(poll.setup.claimCode, null);
  }

  const rotated = await requestJson(baseUrl, "/v1/device/setup-code", {
    method: "POST",
    headers: deviceHeaders,
    body: { rotate: true },
  });
  assert.equal(rotated.setup.rotated, true);
  assert.ok(rotated.setup.claimCode);

  // Rotating retires the printed code, which is the point of making it explicit.
  const state = store.exportState();
  const record = state.devices.find((device) => device.id === provisioned.device.id);
  assert.ok(record.claimCodeExpiresAt);

  // An expired code is refused rather than silently treated as unknown.
  record.claimCodeExpiresAt = new Date(Date.now() - 1000).toISOString();
  const expired = store.claimDevice({
    userId: "user_expired",
    claimCode: rotated.setup.claimCode,
    label: "Too late",
  });
  assert.equal(expired, null);

  // ...and the device can ask for a replacement without an explicit rotate, because the old one
  // is no longer live.
  const refreshed = await requestJson(baseUrl, "/v1/device/setup-code", {
    method: "POST",
    headers: deviceHeaders,
    body: {},
  });
  assert.equal(refreshed.setup.rotated, true);
  assert.ok(refreshed.setup.claimCode);
  assert.notEqual(refreshed.setup.claimCode, rotated.setup.claimCode);

  const claimed = store.claimDevice({
    userId: "user_ok",
    claimCode: refreshed.setup.claimCode,
    label: "Claimed",
  });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.claimCodeExpiresAt, null);
});
