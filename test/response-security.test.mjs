import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app.mjs";
import { createMediaAccessToken } from "../src/mediaLinks.mjs";

const WEB_INDEX = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "web", "index.html");
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("static console and JSON API responses carry the browser security policy", async (t) => {
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const api = await fetch(new URL("/health", baseUrl));
  assert.equal(api.status, 200);
  assertSecurityHeaders(api);

  try {
    await access(WEB_INDEX);
  } catch {
    t.diagnostic("dist/web is not built; static assertion runs in the repository gate after build:app");
    return;
  }
  const page = await fetch(new URL("/", baseUrl));
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/u);
  assertSecurityHeaders(page);
});

test("SSE responses carry the same frame, MIME and browser capability boundaries", async (t) => {
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const auth = await createAuthHeaders(baseUrl);
  const abort = new AbortController();
  t.after(() => abort.abort());

  const stream = await fetch(new URL("/v1/events", baseUrl), { headers: auth, signal: abort.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/u);
  assertSecurityHeaders(stream);
  await stream.body?.cancel();
});

test("user-declared media MIME stays non-sniffable at both media read boundaries", async (t) => {
  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-security-media-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));
  const { server } = createApp({
    config: {
      demoMode: false,
      mediaDir,
      maxMediaBytes: 64 * 1024,
      mediaSigningKey: "test-response-security-signing-key",
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const auth = await createAuthHeaders(baseUrl);

  // The storage contract validates declared type, size, digest and container signature. Browser
  // nosniff remains required so a validated media response is never promoted to executable content.
  const uploaded = await requestJson(baseUrl, "/v1/media", {
    method: "POST",
    headers: auth,
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: PNG_BASE64,
    },
  });
  const media = await fetch(new URL(`/v1/media/${uploaded.media.id}`, baseUrl), { headers: auth });
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("content-type"), "image/png");
  assertSecurityHeaders(media);

  const token = createMediaAccessToken({
    mediaId: uploaded.media.id,
    userId: "user_response_security",
    secret: "test-response-security-signing-key",
    expiresAtMs: Date.now() + 60_000,
  });
  const signedUrl = new URL(`/v1/media/${uploaded.media.id}/content`, baseUrl);
  signedUrl.searchParams.set("token", token);
  const signed = await fetch(signedUrl);
  assert.equal(signed.status, 200);
  assert.equal(signed.headers.get("content-type"), "image/png");
  assertSecurityHeaders(signed);
});

function assertSecurityHeaders(response) {
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("permissions-policy") ?? "", /camera=\(self\)/u);
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /frame-ancestors 'none'/u);
  assert.match(csp, /connect-src 'self'/u);
  assert.match(csp, /worker-src 'self' blob:/u);
  assert.match(csp, /https:\/\/\*\.clerk\.accounts\.dev/u);
}

async function createAuthHeaders(baseUrl) {
  const created = await requestJson(baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_response_security", email: "security@example.local" },
  });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}

async function requestJson(baseUrl, path, input) {
  const response = await fetch(new URL(path, baseUrl), {
    method: input.method,
    headers: { "content-type": "application/json", ...input.headers },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
