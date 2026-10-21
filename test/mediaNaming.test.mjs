import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import {
  buildMediaName,
  lookupThreadTitle,
  markThreadTitlesUnavailable,
  rememberSnapshotThreadTitles,
  resetThreadTitleCache,
  threadTitlesAreStale,
} from "../src/mediaNaming.mjs";

// Every clip a controller records arrives as `controller.wav`. These tests pin the name the gateway
// derives instead, and every way that derivation can come up short: no device label, no bound
// thread, a thread whose title T3 will not give up, a console upload with no device at all, and a
// thread title far longer than a row.

const AUDIO = Buffer.from(
  "524946462400000057415645666d74201000000001000100803e0000007d0000020010006461746100000000",
  "hex",
).toString("base64");
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// A fixed instant so the time segment is an assertion rather than a moving target. Local time,
// because the name is local time: the gateway runs beside the machine it drives.
const CAPTURED_AT = new Date(2026, 7, 24, 19, 32, 5).toISOString();
const LAST_YEAR = new Date(2025, 1, 3, 8, 5, 0).toISOString();
const NOW = new Date(2026, 7, 24, 19, 48, 0);

function mediaRecord(overrides = {}) {
  return {
    id: "media_11111111-2222-3333-4444-555555555555",
    kind: "audio",
    contentType: "audio/wav",
    sizeBytes: 2048,
    originalName: "controller.wav",
    deviceId: "dev_7d2c9f10-aaaa-bbbb-cccc-ddddeeeeffff",
    createdAt: CAPTURED_AT,
    ...overrides,
  };
}

function nameOf(input) {
  return buildMediaName({ now: NOW, ...input }).displayName;
}

test("a controller recording is named by its device, its thread and the minute it was taken", () => {
  const { displayName, origin } = buildMediaName({
    media: mediaRecord(),
    device: { id: mediaRecord().deviceId, label: "Hosyond Touch screen" },
    environmentId: "env_1",
    threadId: "thread_verify",
    threadTitle: "Verify Workspace",
    now: NOW,
  });

  assert.equal(displayName, "Hosyond Touch screen · Verify Workspace · 24 Aug 19:32");
  assert.deepEqual(origin, {
    source: "device",
    deviceId: mediaRecord().deviceId,
    deviceLabel: "Hosyond Touch screen",
    environmentId: "env_1",
    threadId: "thread_verify",
    threadTitle: "Verify Workspace",
    capturedAt: CAPTURED_AT,
  });
});

test("two captures from one microphone on one thread are told apart by the time", () => {
  const common = {
    device: { label: "Hosyond Touch screen" },
    environmentId: "env_1",
    threadId: "thread_verify",
    threadTitle: "Verify Workspace",
  };
  const first = nameOf({ media: mediaRecord({ createdAt: new Date(2026, 7, 24, 19, 32, 0).toISOString() }), ...common });
  const second = nameOf({ media: mediaRecord({ createdAt: new Date(2026, 7, 24, 19, 48, 0).toISOString() }), ...common });

  assert.notEqual(first, second);
  assert.equal(first, "Hosyond Touch screen · Verify Workspace · 24 Aug 19:32");
  assert.equal(second, "Hosyond Touch screen · Verify Workspace · 24 Aug 19:48");
});

test("a clip from an earlier year says which year", () => {
  assert.equal(
    nameOf({ media: mediaRecord({ createdAt: LAST_YEAR }), device: { label: "Bench unit" } }),
    "Bench unit · 3 Feb 2025 08:05",
  );
});

test("an unlabelled device is named by a short form of its id, never a bare uuid", () => {
  const name = nameOf({ media: mediaRecord(), device: { label: "   " }, threadId: "thread_1", threadTitle: "Ship it" });
  assert.equal(name, "Controller 7d2c9f · Ship it · 24 Aug 19:32");

  // A device row that could not be read at all lands in the same place.
  assert.equal(
    nameOf({ media: mediaRecord(), device: null }),
    "Controller 7d2c9f · 24 Aug 19:32",
  );
});

test("a device with no bound thread simply drops the destination segment", () => {
  assert.equal(
    nameOf({ media: mediaRecord(), device: { label: "Kitchen controller" }, threadId: null }),
    "Kitchen controller · 24 Aug 19:32",
  );
});

test("a thread whose title cannot be resolved still names the thread", () => {
  // T3 is the only publisher of thread titles. When it is unreachable the row must still say which
  // thread the capture belongs to, because that is the fact the owner is actually looking for.
  assert.equal(
    nameOf({
      media: mediaRecord(),
      device: { label: "Kitchen controller" },
      environmentId: "env_1",
      threadId: "thread_4f2a1c99",
      threadTitle: null,
    }),
    "Kitchen controller · Thread 4f2a1c · 24 Aug 19:32",
  );
});

test("a very long thread title is cut to fit a narrow row", () => {
  const name = nameOf({
    media: mediaRecord(),
    device: { label: "Kitchen controller" },
    environmentId: "env_1",
    threadId: "thread_1",
    threadTitle: "Rewrite the provisioning wizard so the captive portal survives a reboot",
  });

  assert.equal(name, "Kitchen controller · Rewrite the provisioning wi… · 24 Aug 19:32");
  const destination = name.split(" · ")[1];
  assert.ok(destination.length <= 28, `destination segment stayed short: ${destination.length}`);
});

test("a console upload has no device, and is named by the file the owner chose", () => {
  const { displayName, origin } = buildMediaName({
    media: mediaRecord({ deviceId: null, kind: "image", contentType: "image/png", originalName: "wiring-diagram.png" }),
    now: NOW,
  });

  assert.equal(displayName, "Console · wiring-diagram.png · 24 Aug 19:32");
  assert.equal(origin.source, "console");
  assert.equal(origin.deviceId, null);
  assert.equal(origin.deviceLabel, null);
  assert.equal(origin.threadId, null);
});

test("a console capture whose filename is only a timestamp does not repeat it", () => {
  // MediaCapture.tsx names its own recordings `recording-<iso>.webm`. That is the same instant the
  // name already ends with, spelled worse, so it is dropped rather than shown twice.
  assert.equal(
    nameOf({ media: mediaRecord({ deviceId: null, originalName: "recording-2026-08-24T19:32:05.104Z.webm" }) }),
    "Console · 24 Aug 19:32",
  );
  assert.equal(
    nameOf({ media: mediaRecord({ deviceId: null, kind: "image", originalName: "snapshot-2026-08-24T19:32:05.104Z.png" }) }),
    "Console · 24 Aug 19:32",
  );
  assert.equal(
    nameOf({ media: mediaRecord({ deviceId: null, originalName: null }) }),
    "Console · 24 Aug 19:32",
  );
});

test("a record with no usable creation time still produces a name", () => {
  assert.equal(
    nameOf({ media: mediaRecord({ createdAt: "not a date" }), device: { label: "Kitchen controller" } }),
    "Kitchen controller",
  );
});

test("the thread title cache remembers snapshots, negatives, and its own staleness", (t) => {
  resetThreadTitleCache();
  t.after(() => resetThreadTitleCache());

  assert.equal(threadTitlesAreStale("env_1"), true);
  rememberSnapshotThreadTitles("env_1", {
    threads: [{ id: "t1", title: "Verify Workspace" }, { id: "t2", title: "  " }, { id: null, title: "x" }],
  }, 1000);
  assert.equal(lookupThreadTitle("env_1", "t1"), "Verify Workspace");
  assert.equal(lookupThreadTitle("env_1", "t2"), null);
  // Environment-scoped: another environment's identically named thread is a different thread.
  assert.equal(lookupThreadTitle("env_2", "t1"), null);
  assert.equal(threadTitlesAreStale("env_1", { now: 1000 }), false);
  assert.equal(threadTitlesAreStale("env_1", { now: 1000 + 60_000 }), true);

  // A failure is cached like a success so an unreachable host costs one attempt per window, and
  // titles learned earlier survive it: a host that went down has not renamed its threads.
  markThreadTitlesUnavailable("env_1", 200_000);
  assert.equal(threadTitlesAreStale("env_1", { now: 200_000 }), false);
  assert.equal(lookupThreadTitle("env_1", "t1"), "Verify Workspace");
});

// ---------------------------------------------------------------------------
// Over the real HTTP surface
// ---------------------------------------------------------------------------

async function setupGateway(t, { snapshotThreads = [{ id: "thread_voice", title: "Verify Workspace" }] } = {}) {
  resetThreadTitleCache();
  t.after(() => resetThreadTitleCache());

  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-media-naming-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  const snapshotReads = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      snapshotReads.push(parsed.host);
      if (snapshotThreads === null) return jsonResponse({ error: "down" }, 503);
      return jsonResponse({ projects: [], threads: snapshotThreads }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({
    config: { mediaDir, maxMediaBytes: 8192, transcriptionProvider: "mock", demoMode: false },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = (path, input = {}) => requestJson(originalFetch, baseUrl, path, input);

  const auth = await call("/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: `user_${Math.random().toString(36).slice(2)}`, email: "dev@example.local" },
  });
  const authHeaders = { authorization: `Bearer ${auth.apiToken.secret}` };

  const environment = await call("/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });

  async function claimDevice({ label, threadId = "thread_voice" }) {
    const created = await call("/v1/devices", {
      method: "POST",
      headers: authHeaders,
      body: { label, profile: "next-coder" },
    });
    await call(`/v1/devices/${created.device.id}/config`, {
      method: "PUT",
      headers: authHeaders,
      body: { environmentId: environment.environment.id, ...(threadId ? { threadId } : {}) },
    });
    return {
      device: created.device,
      headers: { "x-device-id": created.device.id, "x-device-secret": created.secret },
    };
  }

  const listMedia = async () => (await call("/v1/media", { headers: authHeaders })).media;

  return { call, authHeaders, environment: environment.environment, claimDevice, listMedia, snapshotReads };
}

test("the media library names device recordings by device, thread and time", async (t) => {
  const gateway = await setupGateway(t);
  const controller = await gateway.claimDevice({ label: "Hosyond Touch screen" });

  // Two recordings, both called controller.wav, exactly as firmware sends them.
  const first = await gateway.call("/v1/device/media", {
    method: "POST",
    headers: controller.headers,
    body: { kind: "audio", contentType: "audio/wav", dataBase64: AUDIO, originalName: "controller.wav" },
  });
  const second = await gateway.call("/v1/device/media", {
    method: "POST",
    headers: controller.headers,
    body: { kind: "audio", contentType: "audio/wav", dataBase64: AUDIO, originalName: "controller.wav" },
  });

  const media = await gateway.listMedia();
  const named = new Map(media.map((item) => [item.id, item]));
  const one = named.get(first.media.id);
  const two = named.get(second.media.id);

  for (const item of [one, two]) {
    assert.match(item.displayName, /^Hosyond Touch screen · Verify Workspace · /u);
    assert.equal(item.origin.source, "device");
    assert.equal(item.origin.deviceLabel, "Hosyond Touch screen");
    assert.equal(item.origin.threadId, "thread_voice");
    assert.equal(item.origin.threadTitle, "Verify Workspace");
    assert.equal(item.origin.environmentId, gateway.environment.id);
    // The uploaded name is preserved, not replaced.
    assert.equal(item.originalName, "controller.wav");
  }
  assert.notEqual(one.id, two.id);
});

test("the name a user sees when attaching media is the name in the library", async (t) => {
  const gateway = await setupGateway(t);
  const controller = await gateway.claimDevice({ label: "Hosyond Touch screen" });

  const uploaded = await gateway.call("/v1/device/media", {
    method: "POST",
    headers: controller.headers,
    body: { kind: "audio", contentType: "audio/wav", dataBase64: AUDIO, originalName: "controller.wav" },
  });

  // The library listing, the single-record reads the console gets back from a write, and the
  // record returned on delete all have to agree — the composer's picker is fed by the listing and
  // its chips by whatever the last write returned.
  const listed = (await gateway.listMedia()).find((item) => item.id === uploaded.media.id);
  const transcribed = await gateway.call(`/v1/media/${uploaded.media.id}/transcript`, {
    method: "PUT",
    headers: gateway.authHeaders,
    body: { transcript: "run the tests" },
  });
  const deleted = await gateway.call(`/v1/media/${uploaded.media.id}`, {
    method: "DELETE",
    headers: gateway.authHeaders,
  });

  assert.equal(transcribed.media.displayName, listed.displayName);
  assert.equal(deleted.media.displayName, listed.displayName);
});

test("a console upload is named without a device, and keeps its filename", async (t) => {
  const gateway = await setupGateway(t);

  const created = await gateway.call("/v1/media", {
    method: "POST",
    headers: gateway.authHeaders,
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: PNG_BASE64,
      originalName: "wiring-diagram.png",
    },
  });

  assert.match(created.media.displayName, /^Console · wiring-diagram\.png · /u);
  assert.equal(created.media.origin.source, "console");
  assert.equal(created.media.origin.deviceId, null);
  assert.equal(created.media.origin.threadId, null);

  const listed = (await gateway.listMedia()).find((item) => item.id === created.media.id);
  assert.equal(listed.displayName, created.media.displayName);
  assert.equal(listed.originalName, "wiring-diagram.png");
});

test("a device with no thread bound is named without a destination", async (t) => {
  const gateway = await setupGateway(t);
  const controller = await gateway.claimDevice({ label: "Bench unit", threadId: null });

  await gateway.call("/v1/device/media", {
    method: "POST",
    headers: controller.headers,
    body: { kind: "image", contentType: "image/png", dataBase64: PNG_BASE64, originalName: "controller.png" },
  });

  const [item] = await gateway.listMedia();
  assert.match(item.displayName, /^Bench unit · \d+ [A-Z][a-z]{2} \d{2}:\d{2}$/u);
  assert.equal(item.origin.threadId, null);
  assert.equal(item.origin.threadTitle, null);
});

test("an unreachable T3 still yields a name, and is asked about once", async (t) => {
  const gateway = await setupGateway(t, { snapshotThreads: null });
  const controller = await gateway.claimDevice({ label: "Hosyond Touch screen" });

  await gateway.call("/v1/device/media", {
    method: "POST",
    headers: controller.headers,
    body: { kind: "audio", contentType: "audio/wav", dataBase64: AUDIO, originalName: "controller.wav" },
  });

  const first = await gateway.listMedia();
  const attempts = gateway.snapshotReads.length;
  const second = await gateway.listMedia();

  assert.match(first[0].displayName, /^Hosyond Touch screen · Thread voice · /u);
  assert.equal(first[0].origin.threadTitle, null);
  assert.equal(first[0].origin.threadId, "thread_voice");
  assert.equal(second[0].displayName, first[0].displayName);
  // The failure is remembered, so a dead host is not re-dialled on every page load.
  assert.equal(gateway.snapshotReads.length, attempts, "no second snapshot attempt inside the window");
});

test("a console-only library never reads devices, jobs or T3 to name itself", async (t) => {
  const gateway = await setupGateway(t);

  await gateway.call("/v1/media", {
    method: "POST",
    headers: gateway.authHeaders,
    body: { kind: "image", contentType: "image/png", dataBase64: PNG_BASE64, originalName: "diagram.png" },
  });
  await gateway.listMedia();

  assert.equal(gateway.snapshotReads.length, 0, "naming a console upload cost no T3 round trip");
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function requestJson(fetchImpl, baseUrl, path, input = {}) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: input.method,
    headers: { "content-type": "application/json", ...input.headers },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
