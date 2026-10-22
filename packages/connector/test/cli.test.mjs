import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main, parseArgs } from "../src/cli.mjs";
import { loadState } from "../src/config.mjs";

test("CLI parsing is strict", () => {
  assert.deepEqual(parseArgs(["status", "--json"]), { command: "status", help: false, json: true, yes: false, once: false, replace: false });
  assert.throws(() => parseArgs(["status", "--code", "secret"]), /Unknown option/);
  assert.throws(() => parseArgs(["wat"]), /Unknown command/);
  assert.throws(() => parseArgs(["logs", "--lines", "0"]), /integer from 1 to 1000/);
  assert.equal(parseArgs(["update", "--apply", "--yes", "--version", "0.1.9"]).version, "0.1.9");
});

test("mock enrollment persists local-only T3 token and connects once", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-cli-"));
  const output = capture();
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/.well-known/t3/environment")) return new Response(JSON.stringify({ version: "0.0.32" }));
    if (String(url).endsWith("/v1/connectors/enroll")) return new Response(JSON.stringify({ connector: { id: "con" }, environment: { id: "env" }, secret: "standing" }), { status: 201 });
    throw new Error(`Unexpected URL: ${url}`);
  };
  class MockConnector { constructor() {} async run() {} stop() {} }
  const code = await main(["connect", "--server", "http://127.0.0.1:8787", "--code", "enroll-code", "--t3-url", "http://127.0.0.1:3773", "--once"], {
    stateDir, stdout: output, stderr: output, env: { NEXT_CODER_T3_TOKEN: "local-token" }, fetchImpl, WebSocketImpl: class {}, Connector: MockConnector,
  });
  assert.equal(code, 0);
  const state = await loadState(stateDir);
  assert.equal(state.t3AccessToken, "local-token");
  const enrollBody = requests.find((request) => request.url.endsWith("/v1/connectors/enroll")).options.body;
  assert.equal(enrollBody.includes("local-token"), false);
  assert.equal(enrollBody.includes("3773"), false);
});

test("Windows can enroll against an already-running loopback T3 without claiming process ownership", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-cli-windows-"));
  const output = capture();
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/.well-known/t3/environment")) return new Response(JSON.stringify({ version: "0.0.32" }));
    if (String(url).endsWith("/v1/connectors/enroll")) return new Response(JSON.stringify({ connector: { id: "con-win" }, environment: { id: "env" }, secret: "standing" }), { status: 201 });
    throw new Error(`Unexpected URL: ${url}`);
  };
  class MockConnector { async run() {} stop() {} }
  const code = await main(["connect", "--server", "https://cloud.example", "--code", "enroll-code", "--t3-url", "http://127.0.0.1:3773", "--once"], {
    stateDir,
    platform: "win32",
    stdout: output,
    stderr: output,
    env: { NEXT_CODER_T3_TOKEN: "local-token", USERNAME: "alice", USERDOMAIN: "EXAMPLE" },
    fetchImpl,
    WebSocketImpl: class {},
    Connector: MockConnector,
  });
  assert.equal(code, 0);
  assert.equal((await loadState(stateDir)).connectorId, "con-win");
  const enrollment = JSON.parse(requests.find((request) => request.url.endsWith("/v1/connectors/enroll")).options.body);
  assert.equal(enrollment.platform, "win32");
});

test("Windows connect wires owned T3 auto-start and local pairing through platform-safe launch dependencies", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-cli-windows-autostart-"));
  const output = capture();
  let ensureOptions;
  let pairingOptions;
  let stopped = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/oauth/token")) return new Response(JSON.stringify({ access_token: "local-access" }));
    if (String(url).endsWith("/v1/connectors/enroll")) return new Response(JSON.stringify({ connector: { id: "con-win-owned" }, environment: { id: "env" }, secret: "standing" }), { status: 201 });
    throw new Error(`Unexpected URL: ${url}`);
  };
  class MockConnector { async run() {} stop() {} }
  const result = await main(["connect", "--server", "https://cloud.example", "--code", "code", "--once"], {
    stateDir,
    platform: "win32",
    nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    resolveNpxLauncher: async () => ({ command: "node", argsPrefix: [] }),
    env: { USERNAME: "alice", USERDOMAIN: "EXAMPLE" },
    stdout: output,
    stderr: output,
    fetchImpl,
    WebSocketImpl: class {},
    Connector: MockConnector,
    ensureT3: async (options) => {
      ensureOptions = options;
      return { baseUrl: "http://127.0.0.1:3773", info: { version: "0.0.32" }, owned: true, started: true, async stop() { stopped += 1; } };
    },
    createT3PairingToken: async (options) => { pairingOptions = options; return "pairing-token"; },
  });
  assert.equal(result, 0);
  assert.equal(ensureOptions.platform, "win32");
  assert.equal(ensureOptions.nodeExecutable, "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(typeof ensureOptions.resolveLauncher, "function");
  assert.equal(pairingOptions.platform, "win32");
  assert.equal(pairingOptions.nodeExecutable, "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(stopped, 1);
  assert.equal((await loadState(stateDir)).t3AccessToken, "local-access");
});

test("doctor makes an owned T3 process identity mismatch explicit and unhealthy", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-cli-owned-doctor-"));
  const output = capture();
  const result = await main(["doctor", "--json", "--state-dir", stateDir], {
    stateDir,
    home: stateDir,
    stdout: output,
    stderr: output,
    inspectOwnedT3: async () => ({ managed: true, running: true, verified: false, status: "identity_mismatch", pid: 9191 }),
    exec: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  });
  assert.equal(result, 1);
  const report = JSON.parse(output.value());
  assert.deepEqual(report.checks.find((check) => check.id === "t3_process"), { id: "t3_process", ok: false, detail: "identity_mismatch" });
  assert.deepEqual(report.tailscale, {
    installed: false,
    connected: false,
    state: "not_installed",
    optional: true,
    managedByConnector: false,
    serveManagedByConnector: false,
    guidance: [{
      id: "install",
      operatorRequired: true,
      message: "If this machine needs Tailnet access to T3, install Tailscale from its official distribution and sign in yourself.",
    }],
  });
});

test("the legacy T3 token environment variable is still read", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-cli-legacy-token-"));
  const output = capture();
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/.well-known/t3/environment")) return new Response(JSON.stringify({ version: "0.0.32" }));
    if (String(url).endsWith("/v1/connectors/enroll")) return new Response(JSON.stringify({ connector: { id: "con" }, environment: { id: "env" }, secret: "standing" }), { status: 201 });
    throw new Error(`Unexpected URL: ${url}`);
  };
  class MockConnector { constructor() {} async run() {} stop() {} }
  const code = await main(["connect", "--server", "http://127.0.0.1:8787", "--code", "enroll-code", "--t3-url", "http://127.0.0.1:3773", "--once"], {
    stateDir, stdout: output, stderr: output, env: { AGENT_CONTROLLER_T3_TOKEN: "legacy-token" }, fetchImpl, WebSocketImpl: class {}, Connector: MockConnector,
  });
  assert.equal(code, 0);
  assert.equal((await loadState(stateDir)).t3AccessToken, "legacy-token");
});

test("service commands refuse to operate before connector-owned installation", async () => {
  const output = capture();
  let commands = 0;
  assert.equal(await main(["start", "--state-dir", "/tmp/missing-next-coder-test"], {
    stdout: output, stderr: output, platform: "linux", home: "/tmp", runServiceCommand: async () => { commands += 1; return { code: 0, stdout: "", stderr: "" }; },
  }), 1);
  assert.match(output.value(), /not installed/);
  assert.equal(commands, 0);
});

function capture() { let text = ""; return { write(value) { text += value; }, value() { return text; } }; }
