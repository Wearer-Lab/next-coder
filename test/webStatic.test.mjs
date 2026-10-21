import assert from "node:assert/strict";
import { access, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app.mjs";

const WEB_DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "web");

async function distBuilt() {
  try {
    await access(join(WEB_DIST_DIR, "index.html"));
    return true;
  } catch {
    return false;
  }
}

// These routes are what make the PWA installable. They are served from dist/web, so the
// assertions only run against a real build.
test("the gateway serves the PWA manifest, service worker and icons", async (t) => {
  if (!(await distBuilt())) {
    t.skip("dist/web is not built; run npm run build:app");
    return;
  }

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const manifest = await fetch(new URL("/manifest.webmanifest", baseUrl));
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get("content-type"), "application/manifest+json");
  const parsed = JSON.parse(await manifest.text());
  assert.ok(Array.isArray(parsed.icons) && parsed.icons.length > 0);

  const worker = await fetch(new URL("/sw.js", baseUrl));
  const workerBody = await worker.text();
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get("content-type"), /javascript/u);
  // A worker served with a long immutable cache can never be updated.
  assert.equal(worker.headers.get("cache-control"), "no-cache");
  assert.ok(workerBody.length > 0);

  const icon = await fetch(new URL("/icons/icon-192.png", baseUrl));
  const iconBody = Buffer.from(await icon.arrayBuffer());
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/png");
  // PNG magic number, so a placeholder or an error page would fail here.
  assert.deepEqual([...iconBody.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test("the public production bundle does not contain source maps", async (t) => {
  if (!(await distBuilt())) {
    t.skip("dist/web is not built; run npm run build:app");
    return;
  }

  const files = await readdir(WEB_DIST_DIR, { recursive: true });
  assert.deepEqual(
    files.filter((file) => file.endsWith(".map")),
    [],
    "source maps must be uploaded out-of-band, never served with the console",
  );
});

test("static serving does not escape the web dist directory", async (t) => {
  if (!(await distBuilt())) {
    t.skip("dist/web is not built; run npm run build:app");
    return;
  }

  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Encoded traversal survives URL normalization, so it reaches the handler intact.
  const escaped = await fetch(`${baseUrl}/icons/..%2f..%2f..%2fpackage.json`);
  const body = await escaped.text();
  assert.notEqual(escaped.status, 200);
  assert.ok(!body.includes("\"next-coder\""), "must not leak package.json");
});

// Regression: a missing static file used to reject outside the request try/catch, surfacing as
// an unhandled rejection that terminated the gateway. An unauthenticated GET must never do that.
test("a missing static asset returns 404 and leaves the server running", async (t) => {
  const { server } = createApp({ config: { demoMode: false } });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const path of [
    "/assets/does-not-exist.js",
    "/icons/does-not-exist.png",
    "/legacy/does-not-exist.css",
  ]) {
    const response = await fetch(new URL(path, baseUrl));
    await response.text();
    assert.equal(response.status, 404, `${path} should 404`);
  }

  // The process survived every miss, so health still answers.
  const health = await fetch(new URL("/health", baseUrl));
  const body = await health.json();
  assert.equal(health.status, 200);
  assert.equal(body.ok, true);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
