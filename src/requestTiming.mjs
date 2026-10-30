// Where does a device request spend its time?
//
// A controller reports 300 ms to 1.1 s per read on a reused connection while `/health` answers in
// 28 ms. The difference is gateway work, but "gateway work" is five different things that need five
// different fixes: authentication, the rate limiter, the store (a Convex round trip per call in
// production), the connector hop to T3, and the gateway's own CPU. This module attributes a
// request's wall time to those buckets so the next optimisation is chosen from evidence.
//
// PRIVACY. The only things that ever leave this module are a fixed vocabulary of phase names, call
// counts, millisecond durations and a route TEMPLATE (`GET /v1/device/approvals/:id/approve`, never
// the concrete path). No identifier, path, prompt, header or error text is recorded anywhere, so
// the `Server-Timing` response header and the optional log line are safe to leave on in production.
//
// HOW IT WORKS. A request installs a timer in AsyncLocalStorage; instrumented seams (the store
// adapter, the T3 transport helpers, the auth and rate-limit calls) record start/end spans into it
// without being passed anything. Outside a request there is no timer and every wrapper is a plain
// passthrough, so background workers (poller, media jobs, thread streams) are untouched.
//
// Buckets (all milliseconds of WALL time, not CPU):
//   auth   the authenticateDevice() call, which contains the store's credential mutation
//   rate   the enforceDevice*() call
//   store  every store.* call; overlapping calls (Promise.all) count their union once
//   t3     every connector/T3 read or dispatch; a cache hit is ~0, a shared flight is the wait
//   app    total minus the time any of store/t3/rate was in flight: the gateway's own JS,
//          JSON projection, and event-loop delay
//   total  from handle() entry to the response headers being written
// `auth` deliberately overlaps `store`: it is the question "how long did authentication take",
// and most of that is one store mutation.

import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

const storage = new AsyncLocalStorage();
const SPAN_CATEGORIES = ["auth", "rate", "store", "t3"];
const TIMED_MARK = Symbol.for("next-coder.store-timing");

// Methods that are subscriptions or state dumps rather than I/O. Timing them would only add noise.
const UNTIMED_STORE_METHODS = new Set(["subscribe", "exportState"]);

export function createRequestTimer({ clock = () => performance.now() } = {}) {
  const startedAt = clock();
  const spans = { auth: [], rate: [], store: [], t3: [] };
  const calls = { auth: 0, rate: 0, store: 0, t3: 0 };
  const cache = { hit: 0, join: 0, miss: 0 };

  function record(category, from, to) {
    spans[category].push([from, to]);
    calls[category] += 1;
  }

  async function span(category, fn) {
    const from = clock();
    try {
      return await fn();
    } finally {
      record(category, from, clock());
    }
  }

  function summary() {
    const finishedAt = clock();
    const wall = (list) => unionLength(list);
    const external = unionLength([...spans.store, ...spans.t3, ...spans.rate]);
    const total = finishedAt - startedAt;
    return {
      totalMs: round(total),
      authMs: round(wall(spans.auth)),
      rateMs: round(wall(spans.rate)),
      storeMs: round(wall(spans.store)),
      storeCalls: calls.store,
      t3Ms: round(wall(spans.t3)),
      t3Calls: calls.t3,
      appMs: round(Math.max(0, total - external)),
      cache: { ...cache },
    };
  }

  return {
    record,
    span,
    summary,
    clock,
    noteCache(source) {
      if (source in cache) cache[source] += 1;
    },
  };
}

export function runWithRequestTimer(timer, fn) {
  return storage.run(timer, fn);
}

export function currentRequestTimer() {
  return storage.getStore() ?? null;
}

/** Time `fn` into the current request's `category`; a plain call when no request is being timed. */
export async function timedSpan(category, fn) {
  const timer = storage.getStore();
  if (!timer || !SPAN_CATEGORIES.includes(category)) return await fn();
  return await timer.span(category, fn);
}

export function noteCacheSource(source) {
  storage.getStore()?.noteCache(source);
}

/**
 * Wrap every function on a store so calls made inside a timed request are attributed to `store`.
 *
 * Wrapped IN PLACE, not through a Proxy: several registries in app.mjs are WeakMaps keyed by the
 * store object, and a second identity would silently miss them. The mark makes this idempotent, so
 * two apps sharing one store (as the tests do) do not stack wrappers. Sync methods stay sync — the
 * memory store's methods return plain values and some callers rely on that.
 */
export function instrumentStoreTiming(store) {
  if (!store || typeof store !== "object" || store[TIMED_MARK]) return store;
  for (const name of Object.keys(store)) {
    const original = store[name];
    if (typeof original !== "function" || UNTIMED_STORE_METHODS.has(name)) continue;
    try {
      store[name] = function timedStoreCall(...args) {
        const timer = storage.getStore();
        if (!timer) return original.apply(this, args);
        const from = timer.clock();
        let result;
        try {
          result = original.apply(this, args);
        } catch (error) {
          timer.record("store", from, timer.clock());
          throw error;
        }
        if (result && typeof result.then === "function") {
          return result.then(
            (value) => { timer.record("store", from, timer.clock()); return value; },
            (error) => { timer.record("store", from, timer.clock()); throw error; },
          );
        }
        timer.record("store", from, timer.clock());
        return result;
      };
    } catch {
      // A frozen property cannot be wrapped; it simply goes untimed.
    }
  }
  try {
    Object.defineProperty(store, TIMED_MARK, { value: true, enumerable: false });
  } catch {
    // Unmarkable stores are re-wrapped at worst, which only double-counts durations.
  }
  return store;
}

/** The standard `Server-Timing` header value: `name;dur=ms;desc="detail"`, comma separated. */
export function formatServerTiming(summary) {
  const cache = summary.cache ?? {};
  const t3Detail = `n=${summary.t3Calls} hit=${cache.hit ?? 0} join=${cache.join ?? 0} miss=${cache.miss ?? 0}`;
  return [
    `auth;dur=${summary.authMs}`,
    `rate;dur=${summary.rateMs}`,
    `store;dur=${summary.storeMs};desc="n=${summary.storeCalls}"`,
    `t3;dur=${summary.t3Ms};desc="${t3Detail}"`,
    `app;dur=${summary.appMs}`,
    `total;dur=${summary.totalMs}`,
  ].join(", ");
}

// Dynamic path segments on the device realm: a command id, a provider request id, an action id, a
// media job id, a firmware digest. They are replaced so a log line identifies a route, not a thing.
const DEVICE_ROUTE_PARAMS = [
  [/^\/v1\/device\/approvals\/[^/]+\/(approve|reject)$/u, "/v1/device/approvals/:id/$1"],
  [/^\/v1\/device\/provider-approvals\/[^/]+$/u, "/v1/device/provider-approvals/:id"],
  [/^\/v1\/device\/user-input\/[^/]+$/u, "/v1/device/user-input/:id"],
  [/^\/v1\/device\/actions\/[^/]+\/run$/u, "/v1/device/actions/:id/run"],
  [/^\/v1\/device\/media\/jobs\/[^/]+$/u, "/v1/device/media/jobs/:id"],
  [/^\/v1\/device\/media\/uploads\/[^/]+\/(content|finalize|abort)$/u, "/v1/device/media/uploads/:id/$1"],
  [/^\/v1\/device\/firmware\/artifacts\/[^/]+$/u, "/v1/device/firmware/artifacts/:digest"],
  [/^\/v1\/device\/requests\/[^/]+$/u, "/v1/device/requests/:id"],
];

export function deviceRouteTemplate(method, pathname) {
  let template = pathname;
  for (const [pattern, replacement] of DEVICE_ROUTE_PARAMS) {
    if (pattern.test(pathname)) {
      template = pathname.replace(pattern, replacement);
      break;
    }
  }
  // Anything unrecognised is clipped rather than echoed, so an unexpected path can never smuggle an
  // identifier into a log.
  return `${method} ${template.length > 64 ? `${template.slice(0, 64)}...` : template}`;
}

/** Routes whose response is a stream or a download: a time-to-first-byte header would mislead. */
export function isTimedDeviceRoute(pathname) {
  return pathname.startsWith("/v1/device/")
    && pathname !== "/v1/device/events"
    && !pathname.startsWith("/v1/device/firmware/artifacts/");
}

function unionLength(intervals) {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  let total = 0;
  let [start, end] = sorted[0];
  for (let index = 1; index < sorted.length; index += 1) {
    const [from, to] = sorted[index];
    if (from <= end) {
      if (to > end) end = to;
    } else {
      total += end - start;
      start = from;
      end = to;
    }
  }
  return total + (end - start);
}

function round(value) {
  return Math.round(value * 10) / 10;
}
