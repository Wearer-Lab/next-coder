import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.mjs";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const WEBM_BASE64 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString("base64");

const BASE_CONFIG = {
  maxMediaBytes: 64 * 1024,
  mediaSigningKey: "test-media-signing-key",
  mediaLinkTtlSeconds: 900,
  mediaInlineMaxBytes: 256 * 1024,
  defaultMediaRetentionDays: 30,
  demoMode: false,
};

async function bootstrap(t, config) {
  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-vision-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const { server } = createApp({ config: { ...BASE_CONFIG, mediaDir, ...config } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = await createAuthHeaders(baseUrl);
  return { baseUrl, headers };
}

test("describing an image persists the description through the real store", async (t) => {
  const { baseUrl, headers } = await bootstrap(t, { visionProvider: "mock" });

  const upload = await requestJson(baseUrl, "/v1/media", {
    method: "POST",
    headers,
    body: { kind: "image", contentType: "image/png", dataBase64: PNG_BASE64, originalName: "shot.png" },
  });
  assert.equal(upload.media.processing.visionStatus, "pending");

  const described = await requestJson(baseUrl, `/v1/media/${upload.media.id}/describe`, {
    method: "POST",
    headers,
  });
  assert.equal(described.provider, "mock");
  assert.ok(described.description.length > 0);

  // Persisted, not just returned.
  const listed = await requestJson(baseUrl, "/v1/media", { headers });
  const stored = listed.media.find((item) => item.id === upload.media.id);
  assert.equal(stored.description, described.description);
  assert.equal(stored.processing.visionStatus, "ready");
  assert.equal(stored.processing.descriptionSource, "mock");
});

test("a described image carries its description to the agent as attachment context", async (t) => {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-vision-dispatch-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));
  const { server } = createApp({ config: { ...BASE_CONFIG, mediaDir, visionProvider: "mock" } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = await createAuthHeaders(baseUrl, originalFetch);

  const environment = await requestJson(baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "token" },
  }, originalFetch);
  const upload = await requestJson(baseUrl, "/v1/media", {
    method: "POST",
    headers,
    body: { kind: "image", contentType: "image/png", dataBase64: PNG_BASE64 },
  }, originalFetch);
  const described = await requestJson(baseUrl, `/v1/media/${upload.media.id}/describe`, {
    method: "POST",
    headers,
  }, originalFetch);

  await requestJson(baseUrl, "/v1/intents", {
    method: "POST",
    headers,
    body: {
      environmentId: environment.environment.id,
      threadId: "thread_1",
      intent: { type: "camera_prompt", mediaUploadId: upload.media.id },
    },
  }, originalFetch);

  const [attachment] = dispatches[0].message.attachments;
  assert.equal(attachment.type, "image");
  assert.equal(attachment.description, described.description);
});

test("vision is off by default and refuses with 409", async (t) => {
  const { baseUrl, headers } = await bootstrap(t, {});

  const upload = await requestJson(baseUrl, "/v1/media", {
    method: "POST",
    headers,
    body: { kind: "image", contentType: "image/png", dataBase64: PNG_BASE64 },
  });

  const response = await fetch(new URL(`/v1/media/${upload.media.id}/describe`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
  });
  await response.text();
  assert.equal(response.status, 409);

  const listed = await requestJson(baseUrl, "/v1/media", { headers });
  assert.equal(listed.media[0].processing.visionStatus, "unavailable");
});

test("audio cannot be described and images cannot be transcribed", async (t) => {
  const { baseUrl, headers } = await bootstrap(t, { visionProvider: "mock", transcriptionProvider: "mock" });

  const audio = await requestJson(baseUrl, "/v1/media", {
    method: "POST",
    headers,
    body: { kind: "audio", contentType: "audio/webm", dataBase64: WEBM_BASE64 },
  });
  const image = await requestJson(baseUrl, "/v1/media", {
    method: "POST",
    headers,
    body: { kind: "image", contentType: "image/png", dataBase64: PNG_BASE64 },
  });

  const describeAudio = await fetch(new URL(`/v1/media/${audio.media.id}/describe`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
  });
  await describeAudio.text();
  assert.equal(describeAudio.status, 400);

  const transcribeImage = await fetch(new URL(`/v1/media/${image.media.id}/transcribe`, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
  });
  await transcribeImage.text();
  assert.equal(transcribeImage.status, 400);
});

test("image descriptions are redacted from support diagnostics", async (t) => {
  const { baseUrl, headers } = await bootstrap(t, { visionProvider: "mock" });

  const upload = await requestJson(baseUrl, "/v1/media", {
    method: "POST",
    headers,
    body: { kind: "image", contentType: "image/png", dataBase64: PNG_BASE64 },
  });
  const described = await requestJson(baseUrl, `/v1/media/${upload.media.id}/describe`, {
    method: "POST",
    headers,
  });

  const diagnostics = await requestJson(baseUrl, "/v1/support/diagnostics", { headers });
  assert.ok(
    !JSON.stringify(diagnostics).includes(described.description),
    "a vision description is user content and must not appear verbatim in a support bundle",
  );
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
