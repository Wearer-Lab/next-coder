import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ConnectorClient } from "../src/connector.mjs";

const connectorUrl = new URL("../src/connector.mjs", import.meta.url).href;
const closeEventUrl = new URL("./support/closeEvent.mjs", import.meta.url).href;

for (const mode of ["welcomed", "awaiting_welcome", "reconnecting", "stop_during_welcome", "revoked"]) {
  test(`managed connector owns process liveness while ${mode} and releases it on intentional stop`, () => {
    // No IPC channel, mock timer, listening server, or parent keep-alive handle may conceal a
    // missing service timer. The only external stopper is deliberately unreferenced.
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import ${JSON.stringify(closeEventUrl)};
      import { ConnectorClient } from ${JSON.stringify(connectorUrl)};
      const mode = ${JSON.stringify(mode)};
      let connector;
      class Socket extends EventTarget {
        constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
        send(value) {
          const frame = JSON.parse(value);
          if (frame.type !== "hello") return;
          if (mode === "awaiting_welcome") return;
          if (mode === "reconnecting") { this.close(1012); return; }
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
            protocolVersion: 1, type: "welcome", connectionId: "liveness-connection",
            body: { serverTime: new Date().toISOString(), heartbeatIntervalMs: 1000,
              maxFrameBytes: 1048576, maxInFlight: 32 },
          }) })));
        }
        close(code=1000) { queueMicrotask(() => this.dispatchEvent(new CloseEvent("close", { code }))); }
      }
      connector = new ConnectorClient({
        state: { server: "https://example.invalid", connectorId: "connector", environmentId: "environment",
          secret: "fixture", t3AccessToken: "fixture" },
        t3: { environmentInfo: async () => ({}), capabilityProbe: async () => ({}), providerCatalogue: async () => [] },
        WebSocketImpl: Socket, fetchImpl: async () => Response.json({ ticket: "fixture-ticket" }),
        logger: { log() {}, error() {} }, minReconnectMs: 30000, maxReconnectMs: 30000,
      });
      if (mode === "stop_during_welcome") {
        const original = connector.onMessage.bind(connector);
        connector.onMessage = async (...args) => { const result = await original(...args); connector.stop(); return result; };
      }
      if (mode === "revoked") {
        const original = connector.onMessage.bind(connector);
        connector.onMessage = async (...args) => {
          const result = await original(...args);
          if (result?.welcome) await original(args[0], JSON.stringify({ protocolVersion: 1,
            type: "shutdown", connectionId: "liveness-connection", body: { reason: "revoked" } }));
          return result;
        };
      }
      if (!["stop_during_welcome", "revoked"].includes(mode)) {
        const stop = setTimeout(() => connector.stop(), 100);
        stop.unref();
      }
      connector.run().then(() => process.stdout.write("STOPPED\\n"), (error) => {
        process.stderr.write(error.stack); process.exitCode = 1;
      });
    `], { encoding: "utf8", timeout: 5000 });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /^STOPPED\n$/u, `Service exited before its lifecycle completed: ${child.stderr}`);
  });
}

test("stopping while the socket ticket is pending never opens a new connection", async () => {
  let ticket;
  const pending = new Promise((resolve) => { ticket = resolve; });
  let sockets = 0;
  const connector = new ConnectorClient({
    state: { server: "https://example.invalid", connectorId: "connector", environmentId: "environment", secret: "fixture" },
    t3: {}, WebSocketImpl: class { constructor() { ++sockets; } }, fetchImpl: async () => await pending,
    logger: { log() {}, error() {} },
  });
  const running = connector.run();
  connector.stop();
  ticket(Response.json({ ticket: "fixture-ticket" }));
  await running;
  assert.equal(sockets, 0);
  assert.equal(connector.socket, null);
});

test("queued cloud requests cannot start a local effect after intentional stop", async () => {
  let connector;
  let effects = 0;
  let socket;
  class Socket extends EventTarget {
    constructor() { super(); socket = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send(value) {
      const frame = JSON.parse(value);
      if (frame.type === "hello") queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
        protocolVersion: 1, type: "welcome", connectionId: "test-connection", body: {
          serverTime: new Date().toISOString(), heartbeatIntervalMs: 1000, maxFrameBytes: 1048576, maxInFlight: 32,
        },
      }) })));
    }
    close(code = 1000) { queueMicrotask(() => this.dispatchEvent(new CloseEvent("close", { code }))); }
  }
  connector = new ConnectorClient({
    state: { server: "https://example.invalid", connectorId: "connector", environmentId: "environment", secret: "fixture", t3AccessToken: "fixture" },
    t3: { environmentInfo: async () => ({}), providerCatalogue: async () => [], dispatch: async () => { ++effects; return {}; } },
    WebSocketImpl: Socket, fetchImpl: async () => Response.json({ ticket: "fixture-ticket" }), logger: { log() {}, error() {} },
  });
  await connector.connectOnce({ onWelcome() {
    connector.stop();
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      protocolVersion: 1, type: "request", connectionId: "test-connection", body: {
        requestId: "late-request", idempotencyKey: "late-effect", method: "dispatch",
        deadlineAt: new Date(Date.now() + 30000).toISOString(), payload: { command: { type: "thread.session.stop" } },
      },
    }) }));
  } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(effects, 0);
});
