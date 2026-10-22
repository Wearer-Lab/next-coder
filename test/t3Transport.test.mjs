import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectorOfflineError,
  ConnectorT3Transport,
  DirectT3Transport,
  createT3TransportResolver,
} from "../src/t3Transport.mjs";

test("direct transport preserves the existing HTTP contract", async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/api/orchestration/snapshot")) {
      return new Response(JSON.stringify({ projects: [], threads: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "accepted" }), { status: 200 });
  };
  const environment = { baseUrl: "https://t3.example", accessToken: "local-only" };
  const transport = new DirectT3Transport();
  assert.deepEqual(await transport.snapshot(environment, { fetchImpl }), { projects: [], threads: [] });
  assert.deepEqual(await transport.dispatch(environment, { type: "thread.session.stop" }, { fetchImpl }), { status: "accepted" });
  assert.equal(requests[0].init.headers.authorization, "Bearer local-only");
  assert.equal(requests[1].init.method, "POST");
});

test("transport resolver keeps direct mode as migration default", () => {
  const direct = {};
  const resolver = createT3TransportResolver({ direct });
  assert.equal(resolver.forEnvironment({ id: "env_1" }).transport, direct);
  assert.throws(
    () => resolver.forEnvironment({ id: "env_2", transportMode: "connector" }),
    (error) => error instanceof ConnectorOfflineError && error.retryable === true,
  );
});

test("connector transport sends runtime-neutral request envelopes", async () => {
  const calls = [];
  const transport = new ConnectorT3Transport({
    request: async (...args) => { calls.push(args); return { ok: true }; },
    openThreadStream() { return { close() {} }; },
  });
  const environment = { id: "env_1", connectorId: "ctr_1", transportMode: "connector" };
  assert.deepEqual(await transport.capabilityProbe(environment, { timeoutMs: 50 }), { ok: true });
  assert.deepEqual(await transport.threadDetail(environment, "thread_1", { timeoutMs: 50 }), { ok: true });
  assert.deepEqual(calls[0], [environment, {
    method: "capabilityProbe",
    payload: {},
  }, { timeoutMs: 50 }]);
  assert.deepEqual(calls[1], [environment, {
    method: "threadDetail",
    payload: { threadId: "thread_1" },
  }, { timeoutMs: 50 }]);
  await transport.threadDetail(environment, "thread_1", { turnLimit: 8 });
  assert.deepEqual(calls[2][1].payload, { threadId: "thread_1", turnLimit: 8 });
});
