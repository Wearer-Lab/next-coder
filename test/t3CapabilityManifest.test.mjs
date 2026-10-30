import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildT3CapabilityManifest,
  capabilitySupported,
  T3Adapter,
  T3_ADAPTER_CONTRACT_VERSION,
  T3_CAPABILITY_MANIFEST_SCHEMA,
} from "../src/t3CapabilityManifest.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/t3-capability-probe-0.0.32.json", import.meta.url), "utf8"));
const environment = {
  id: "env_fixture",
  transportMode: "direct",
  scopes: ["orchestration:read", "orchestration:operate", "terminal:operate"],
};
const methods = Object.freeze({
  environmentInfo: true,
  snapshot: true,
  threadDetail: true,
  dispatch: true,
  callRpc: true,
  openThreadStream: true,
});

test("captured T3 0.0.32 probes produce the versioned certified manifest without audio/file or per-task controls", () => {
  const manifest = build(fixture);
  assert.equal(manifest.schema, T3_CAPABILITY_MANIFEST_SCHEMA);
  assert.equal(manifest.contractVersion, T3_ADAPTER_CONTRACT_VERSION);
  assert.equal(manifest.installedVersion, "0.0.32");
  assert.equal(capabilitySupported(manifest, "threadPagination"), true);
  assert.equal(capabilitySupported(manifest, "threadSubscription"), true);
  // Four are answerable on any request; the fifth exists but only a request that lists it may be
  // answered with it (it is a silent deny on Claude otherwise), so it is not in the first list.
  assert.deepEqual(manifest.approvalDecisions, ["accept", "acceptForSession", "decline", "cancel"]);
  assert.deepEqual(manifest.requestScopedApprovalDecisions, ["acceptAlways"]);
  assert.equal(manifest.approvalDecisions.includes("acceptAlways"), false);
  assert.equal(manifest.attachments.image.state, "supported");
  assert.equal(manifest.attachments.audio.state, "unsupported");
  assert.equal(manifest.attachments.file.state, "unsupported");
  assert.equal(Object.hasOwn(manifest.features, "taskStop"), false);
  assert.equal(Object.hasOwn(manifest.features, "taskResume"), false);
  assert.equal(Object.hasOwn(manifest.features, "taskInput"), false);
});

test("missing and unknown capabilities fail closed while newer versions do not invent features", () => {
  const missing = build({ metadata: {}, snapshot: { projects: [] }, serverConfig: { environment: {} } });
  assert.equal(missing.installedVersion, null);
  assert.equal(capabilitySupported(missing, "shellSnapshot"), false);
  assert.equal(capabilitySupported(missing, "liveCatalogue"), false);
  assert.equal(missing.recovery.action, "UPDATE T3 CODE");

  const newer = build({ ...fixture, metadata: { serverVersion: "0.0.99" }, serverConfig: { ...fixture.serverConfig, futureCapability: true } });
  assert.equal(newer.installedVersion, "0.0.99");
  assert.deepEqual(newer.features, build(fixture).features);
  assert.equal(Object.hasOwn(newer.features, "futureCapability"), false);
});

test("adapter caches a fresh owner-safe manifest and refreshes only when requested", async () => {
  let calls = 0;
  let now = Date.parse("2026-08-27T12:00:00.000Z");
  const transport = {
    async environmentInfo() { calls += 1; return fixture.metadata; },
    async snapshot() { calls += 1; return fixture.snapshot; },
    async threadDetail() { calls += 1; return null; },
    async dispatch() {},
    async callRpc() { calls += 1; return fixture.serverConfig; },
    openThreadStream() { return { close() {} }; },
  };
  const adapter = new T3Adapter(transport, { now: () => now, cacheTtlMs: 60_000 });
  const first = await adapter.capabilities(environment);
  assert.equal(first.source, "direct_probe");
  assert.equal(calls, 3);
  const cached = await adapter.capabilities(environment);
  assert.equal(cached.source, "cache");
  assert.equal(calls, 3);
  now += 61_000;
  const refreshed = await adapter.capabilities(environment);
  assert.equal(refreshed.source, "direct_probe");
  assert.equal(calls, 6);
});

test("connector probe cache becomes explicitly stale and an unknown probe contract fails closed", async () => {
  let now = Date.parse("2026-08-27T12:00:00.000Z");
  let response = fixture.connectorProbe;
  const transport = {
    capabilityProbe: async () => {
      if (response instanceof Error) throw response;
      return response;
    },
    environmentInfo: async () => fixture.metadata,
    snapshot: async () => fixture.snapshot,
    threadDetail: async () => null,
    dispatch: async () => ({ sequence: 1 }),
    callRpc: async () => fixture.serverConfig,
    openThreadStream: () => ({ close() {} }),
  };
  const connectorEnvironment = { ...environment, transportMode: "connector" };
  const adapter = new T3Adapter(transport, { now: () => now, cacheTtlMs: 60_000 });
  const fresh = await adapter.capabilities(connectorEnvironment);
  assert.equal(fresh.source, "connector_probe");
  assert.equal(fresh.freshness, "fresh");

  now += 61_000;
  response = Object.assign(new Error("connector unavailable"), { code: "connector_offline" });
  const stale = await adapter.capabilities(connectorEnvironment);
  assert.equal(stale.source, "cache");
  assert.equal(stale.freshness, "stale");
  assert.deepEqual(stale.recovery, { code: "connector_offline", action: "CHECK T3 CODE" });

  adapter.invalidateCapabilities(connectorEnvironment);
  response = { schema: "next-coder.t3-probe.v999" };
  await assert.rejects(
    adapter.capabilities(connectorEnvironment),
    (error) => error?.code === "t3_capability_probe_incompatible",
  );
});

test("connector and direct transports use the same adapter surface", async () => {
  const calls = [];
  const transport = {
    environmentInfo: async () => fixture.metadata,
    snapshot: async () => fixture.snapshot,
    threadDetail: async () => null,
    dispatch: async (...args) => { calls.push(["dispatch", ...args]); return { sequence: 1 }; },
    callRpc: async () => fixture.serverConfig,
    openThreadStream: (...args) => { calls.push(["stream", ...args]); return { close() {} }; },
  };
  const adapter = new T3Adapter(transport);
  assert.deepEqual(await adapter.dispatch(environment, { type: "thread.session.stop" }), { sequence: 1 });
  assert.equal(typeof adapter.openThreadStream(environment, { threadId: "thread_1" }).close, "function");
  assert.deepEqual(calls.map(([name]) => name), ["dispatch", "stream"]);
});

function build(value) {
  return buildT3CapabilityManifest({
    environment,
    metadata: value.metadata,
    snapshot: value.snapshot,
    serverConfig: value.serverConfig,
    probes: {
      metadata: value.metadata ? "passed" : "failed",
      snapshot: Array.isArray(value.snapshot?.projects) && Array.isArray(value.snapshot?.threads) ? "passed" : "failed",
      serverConfig: Array.isArray(value.serverConfig?.providers) ? "passed" : "failed",
      threadDetail: "not_exercised",
    },
    methodAvailability: methods,
    probedAt: "2026-08-27T12:00:00.000Z",
    freshUntil: "2026-08-27T12:05:00.000Z",
  });
}

test("a direct runtime reserves no request-scoped decision and the manifest never lists acceptAlways by default", async () => {
  const transport = {
    async capabilityProbe() {
      return {
        schema: "next-coder.runtime-probe.v1",
        installedVersion: "1.0.0",
        probes: { snapshot: "passed", serverConfig: "passed" },
        features: { providerApprovals: true },
      };
    },
    async snapshot() { return { projects: [], threads: [] }; },
    async dispatch() {},
  };
  const manifest = await new T3Adapter(transport).capabilities(environment);
  assert.equal(manifest.runtimeKind, "direct");
  assert.deepEqual(manifest.approvalDecisions, ["accept", "decline", "cancel"]);
  assert.deepEqual(manifest.requestScopedApprovalDecisions, []);
});

test("an environment that cannot dispatch advertises no approval decisions at all", () => {
  const readOnly = buildT3CapabilityManifest({
    environment: { ...environment, scopes: ["orchestration:read"] },
    metadata: fixture.metadata,
    snapshot: fixture.snapshot,
    serverConfig: fixture.serverConfig,
    probes: { metadata: "passed", snapshot: "passed", serverConfig: "passed", threadDetail: "not_exercised" },
    methodAvailability: methods,
    probedAt: "2026-08-27T12:00:00.000Z",
    freshUntil: "2026-08-27T12:05:00.000Z",
  });
  assert.deepEqual(readOnly.approvalDecisions, []);
  assert.deepEqual(readOnly.requestScopedApprovalDecisions, []);
});
