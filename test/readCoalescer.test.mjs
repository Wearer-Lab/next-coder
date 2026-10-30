import assert from "node:assert/strict";
import test from "node:test";

import { createReadCoalescer } from "../src/readCoalescer.mjs";
import {
  createRequestTimer,
  deviceRouteTemplate,
  formatServerTiming,
  instrumentStoreTiming,
  isTimedDeviceRoute,
  runWithRequestTimer,
  timedSpan,
} from "../src/requestTiming.mjs";

function clockAt(start = 1_000_000) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => { current += ms; };
  return now;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("a stored answer within the reader's bound is served without loading", async () => {
  const now = clockAt();
  const cache = createReadCoalescer({ now });
  let loads = 0;
  const load = async () => { loads += 1; return { n: loads }; };
  const first = await cache.read({ scope: "u\0e", key: "k", maxAgeMs: 1000, load });
  const second = await cache.read({ scope: "u\0e", key: "k", maxAgeMs: 1000, load });
  assert.deepEqual([first.source, second.source], ["miss", "hit"]);
  assert.equal(loads, 1);
  assert.deepEqual(second.value, { n: 1 });
});

test("an expired answer is fetched again", async () => {
  const now = clockAt();
  const cache = createReadCoalescer({ now });
  let loads = 0;
  const load = async () => ({ n: ++loads });
  await cache.read({ scope: "s", key: "k", maxAgeMs: 1000, load });
  now.advance(1001);
  const again = await cache.read({ scope: "s", key: "k", maxAgeMs: 1000, load });
  assert.equal(again.source, "miss");
  assert.equal(loads, 2);
  assert.deepEqual(again.value, { n: 2 });
});

test("freshness is the reader's choice: maxAge 0 never serves stored data", async () => {
  const now = clockAt();
  const cache = createReadCoalescer({ now });
  let loads = 0;
  const load = async () => ({ n: ++loads });
  await cache.read({ scope: "s", key: "k", maxAgeMs: 5000, load });
  const live = await cache.read({ scope: "s", key: "k", maxAgeMs: 0, load });
  assert.equal(live.source, "miss");
  assert.equal(loads, 2);
});

test("concurrent readers share one flight", async () => {
  const cache = createReadCoalescer();
  const gate = deferred();
  let loads = 0;
  const load = async () => { loads += 1; return await gate.promise; };
  const readers = [1, 2, 3, 4].map(() => cache.read({ scope: "s", key: "k", maxAgeMs: 0, load }));
  gate.resolve({ ok: true });
  const results = await Promise.all(readers);
  assert.equal(loads, 1);
  assert.deepEqual(results.map((result) => result.source).sort(), ["join", "join", "join", "miss"]);
  for (const result of results) assert.deepEqual(result.value, { ok: true });
});

test("callers get copies, so one caller's mutation is not another's data", async () => {
  const cache = createReadCoalescer();
  const first = await cache.read({ scope: "s", key: "k", maxAgeMs: 1000, load: async () => ({ list: [1] }) });
  first.value.list.push(2);
  const second = await cache.read({ scope: "s", key: "k", maxAgeMs: 1000, load: async () => assert.fail("hit expected") });
  assert.deepEqual(second.value, { list: [1] });
});

test("scopes never cross: the same key under another scope loads again", async () => {
  const cache = createReadCoalescer();
  const loadFor = (owner) => async () => ({ owner });
  const a = await cache.read({ scope: "userA\0env", key: "snapshot", maxAgeMs: 5000, load: loadFor("A") });
  const b = await cache.read({ scope: "userB\0env", key: "snapshot", maxAgeMs: 5000, load: loadFor("B") });
  const aAgain = await cache.read({ scope: "userA\0env", key: "snapshot", maxAgeMs: 5000, load: loadFor("A2") });
  assert.deepEqual([a.value, b.value, aAgain.value], [{ owner: "A" }, { owner: "B" }, { owner: "A" }]);
  assert.deepEqual([a.source, b.source, aAgain.source], ["miss", "miss", "hit"]);
});

test("invalidation drops stored answers", async () => {
  const cache = createReadCoalescer();
  let loads = 0;
  const load = async () => ({ n: ++loads });
  await cache.read({ scope: "s", key: "k", maxAgeMs: 5000, load });
  cache.invalidate("s");
  const after = await cache.read({ scope: "s", key: "k", maxAgeMs: 5000, load });
  assert.equal(after.source, "miss");
  assert.deepEqual(after.value, { n: 2 });
});

test("a read in flight when the scope is invalidated can neither be joined nor stored", async () => {
  const cache = createReadCoalescer();
  const gate = deferred();
  const stale = cache.read({ scope: "s", key: "k", maxAgeMs: 5000, load: async () => await gate.promise });
  // The write lands while the read is in the air.
  cache.invalidate("s");
  const after = await cache.read({ scope: "s", key: "k", maxAgeMs: 5000, load: async () => ({ v: "after-write" }) });
  assert.equal(after.source, "miss", "did not join the pre-write flight");
  gate.resolve({ v: "before-write" });
  await stale;
  const later = await cache.read({ scope: "s", key: "k", maxAgeMs: 5000, load: async () => assert.fail("stored") });
  assert.deepEqual(later.value, { v: "after-write" }, "the pre-write answer was not stored over the newer one");
});

test("fresh skips both the stored answer and other readers' flights", async () => {
  const cache = createReadCoalescer();
  const gate = deferred();
  const inFlight = cache.read({ scope: "s", key: "k", maxAgeMs: 0, load: async () => await gate.promise });
  const fresh = await cache.read({ scope: "s", key: "k", fresh: true, load: async () => ({ v: "new" }) });
  assert.equal(fresh.source, "miss");
  gate.resolve({ v: "old" });
  await inFlight;
});

test("failures are shared by the flight and never stored", async () => {
  const cache = createReadCoalescer();
  const gate = deferred();
  let loads = 0;
  const load = async () => { loads += 1; return await gate.promise; };
  const a = cache.read({ scope: "s", key: "k", maxAgeMs: 5000, load });
  const b = cache.read({ scope: "s", key: "k", maxAgeMs: 5000, load });
  gate.reject(new Error("connector offline"));
  await assert.rejects(a, /connector offline/u);
  await assert.rejects(b, /connector offline/u);
  assert.equal(loads, 1);
  const recovered = await cache.read({ scope: "s", key: "k", maxAgeMs: 5000, load: async () => ({ ok: true }) });
  assert.equal(recovered.source, "miss");
});

test("retain:false coalesces but stores nothing", async () => {
  const cache = createReadCoalescer();
  let loads = 0;
  const load = async () => ({ n: ++loads });
  await cache.read({ scope: "s", key: "k", maxAgeMs: 5000, retain: false, load });
  const second = await cache.read({ scope: "s", key: "k", maxAgeMs: 5000, retain: false, load });
  assert.equal(second.source, "miss");
  assert.equal(loads, 2);
});

test("invalidatePrefix drops every scope that starts with it", async () => {
  const cache = createReadCoalescer();
  const load = async () => ({});
  await cache.read({ scope: "u1\0e1", key: "k", maxAgeMs: 5000, load });
  await cache.read({ scope: "u1\0e2", key: "k", maxAgeMs: 5000, load });
  await cache.read({ scope: "u2\0e1", key: "k", maxAgeMs: 5000, load });
  cache.invalidatePrefix("u1\0");
  const sources = [];
  for (const scope of ["u1\0e1", "u1\0e2", "u2\0e1"]) {
    sources.push((await cache.read({ scope, key: "k", maxAgeMs: 5000, load })).source);
  }
  assert.deepEqual(sources, ["miss", "miss", "hit"]);
});

test("the number of scopes is bounded", async () => {
  const now = clockAt();
  const cache = createReadCoalescer({ now, maxScopes: 4 });
  for (let index = 0; index < 20; index += 1) {
    await cache.read({ scope: `u${index}\0e`, key: "k", maxAgeMs: 1000, load: async () => ({}) });
    now.advance(100_000);
  }
  assert.ok(cache.size() <= 5, `scope count stayed bounded (${cache.size()})`);
});

// ---------------------------------------------------------------------------------------------
// Request timing
// ---------------------------------------------------------------------------------------------

test("phase time is a union, so overlapping store calls are counted once", () => {
  let now = 0;
  const timer = createRequestTimer({ clock: () => now });
  timer.record("store", 10, 60);
  timer.record("store", 30, 80); // overlaps: union is 10..80 = 70
  timer.record("t3", 100, 150);
  timer.record("auth", 5, 65);
  now = 200;
  const summary = timer.summary();
  assert.equal(summary.storeMs, 70);
  assert.equal(summary.storeCalls, 2);
  assert.equal(summary.t3Ms, 50);
  assert.equal(summary.authMs, 60);
  assert.equal(summary.totalMs, 200);
  assert.equal(summary.appMs, 200 - (70 + 50), "app is the time nothing external was in flight");
});

test("the Server-Timing header is a fixed vocabulary of names and numbers", () => {
  let now = 0;
  const timer = createRequestTimer({ clock: () => now });
  timer.noteCache("hit");
  timer.record("t3", 0, 0);
  now = 12.34;
  const header = formatServerTiming(timer.summary());
  assert.match(header, /^auth;dur=[\d.]+, rate;dur=[\d.]+, store;dur=[\d.]+;desc="n=\d+", t3;dur=[\d.]+;desc="n=1 hit=1 join=0 miss=0", app;dur=[\d.]+, total;dur=12\.3$/u);
});

test("route templates drop every identifier", () => {
  assert.equal(deviceRouteTemplate("POST", "/v1/device/approvals/cmd_0123456789/approve"), "POST /v1/device/approvals/:id/approve");
  assert.equal(deviceRouteTemplate("POST", "/v1/device/provider-approvals/req-secret-1"), "POST /v1/device/provider-approvals/:id");
  assert.equal(deviceRouteTemplate("POST", "/v1/device/actions/act_1/run"), "POST /v1/device/actions/:id/run");
  assert.equal(deviceRouteTemplate("GET", "/v1/device/media/jobs/job_9"), "GET /v1/device/media/jobs/:id");
  assert.equal(deviceRouteTemplate("GET", "/v1/device/display"), "GET /v1/device/display");
  assert.ok(deviceRouteTemplate("GET", `/v1/device/${"x".repeat(200)}`).length < 90);
});

test("only ordinary device routes are timed; streams and downloads are not", () => {
  assert.equal(isTimedDeviceRoute("/v1/device/display"), true);
  assert.equal(isTimedDeviceRoute("/v1/device/events"), false);
  assert.equal(isTimedDeviceRoute(`/v1/device/firmware/artifacts/${"a".repeat(64)}`), false);
  assert.equal(isTimedDeviceRoute("/v1/devices"), false);
  assert.equal(isTimedDeviceRoute("/health"), false);
});

test("the store wrapper times async and sync methods, preserves sync-ness, and is idempotent", async () => {
  const store = {
    syncRead: () => "sync-value",
    asyncRead: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return "async-value"; },
    failing: async () => { throw new Error("boom"); },
    subscribe: () => () => {},
    notAFunction: 42,
  };
  const originalSubscribe = store.subscribe;
  instrumentStoreTiming(store);
  const wrappedOnce = store.syncRead;
  instrumentStoreTiming(store);
  assert.equal(store.syncRead, wrappedOnce, "a second pass does not stack wrappers");
  assert.equal(store.subscribe, originalSubscribe, "subscriptions are not I/O and stay untimed");

  // Outside a request: a plain passthrough.
  assert.equal(store.syncRead(), "sync-value");

  const timer = createRequestTimer();
  await runWithRequestTimer(timer, async () => {
    assert.equal(store.syncRead(), "sync-value", "sync stays sync (not a promise)");
    assert.equal(await store.asyncRead(), "async-value");
    await assert.rejects(store.failing(), /boom/u);
  });
  const summary = timer.summary();
  assert.equal(summary.storeCalls, 3);
  assert.ok(summary.storeMs >= 4, "the async call's wait was attributed to the store");
});

test("timedSpan is a passthrough outside a timed request", async () => {
  assert.equal(await timedSpan("t3", async () => "value"), "value");
});
