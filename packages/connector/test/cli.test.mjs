import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main as realMain, parseArgs } from "../src/cli.mjs";
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
  let prepared = false; let closed = false;
  class MockConnector { constructor(input) { assert.equal(prepared, true); assert.equal(input.state.voice.enabled, true); assert.equal(typeof input.ensureLocalTranscription, "function"); } async run() {} stop() {} }
  const code = await main(["connect", "--server", "http://127.0.0.1:8787", "--code", "enroll-code", "--t3-url", "http://127.0.0.1:3773", "--once"], {
    stateDir, stdout: output, stderr: output, env: { NEXT_CODER_T3_TOKEN: "local-token" }, fetchImpl, WebSocketImpl: class {}, Connector: MockConnector,
    prepareVoiceRuntime: async ({ signal }) => { prepared = true; assert.equal(signal.aborted, false); return { url: "http://127.0.0.1:8977/v1/transcribe", close: async () => { closed = true; }, ensureReady: async () => {} }; },
  });
  assert.equal(code, 0);
  assert.equal(closed, true);
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

function main(args, dependencies = {}) { return realMain(args, { inspectVoiceRuntime: async () => ({ ready: true }), prepareVoiceRuntime: async () => ({ url: "http://127.0.0.1:8977/v1/transcribe", close: async () => {}, ensureReady: async () => {} }), ...dependencies }); }

test("connect takes --t3-version, forwards it to the T3 launch and pairing, and documents it in help", async () => {
  assert.equal(parseArgs(["connect", "--server", "https://cloud.example", "--code", "code", "--t3-version", "0.1.4"]).t3Version, "0.1.4");
  assert.throws(() => parseArgs(["status", "--t3-version", "0.1.4"]), /Unknown option/);
  const stateDir = await mkdtemp(join(tmpdir(), "connector-cli-t3-version-"));
  const output = capture();
  let ensureOptions;
  let pairingOptions;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/oauth/token")) return new Response(JSON.stringify({ access_token: "local-access" }));
    if (String(url).endsWith("/v1/connectors/enroll")) return new Response(JSON.stringify({ connector: { id: "con-flag" }, environment: { id: "env" }, secret: "standing" }), { status: 201 });
    throw new Error(`Unexpected URL: ${url}`);
  };
  class MockConnector { async run() {} stop() {} }
  const result = await main(["connect", "--server", "https://cloud.example", "--code", "code", "--t3-version", "0.1.4", "--once"], {
    stateDir,
    platform: "linux",
    env: {},
    stdout: output,
    stderr: output,
    fetchImpl,
    WebSocketImpl: class {},
    Connector: MockConnector,
    ensureT3: async (options) => {
      ensureOptions = options;
      return { baseUrl: "http://127.0.0.1:3773", info: { version: "0.0.32" }, owned: true, started: true, async stop() {} };
    },
    createT3PairingToken: async (options) => { pairingOptions = options; return "pairing-token"; },
  });
  assert.equal(result, 0);
  assert.equal(ensureOptions.explicitT3Version, "0.1.4");
  assert.equal(pairingOptions.explicitT3Version, "0.1.4");
  const help = capture();
  assert.equal(await main(["connect", "--help"], { stdout: help, stderr: help }), 0);
  assert.match(help.value(), /--t3-version VERSION {4}Exact T3 Code release to auto-start \(default 0\.1\.5\)/u);
});

test("--install-service carries the T3 launch options the operator set into the installed service", async () => {
  // The whole cli -> serviceOptions -> installService path had no coverage, which is exactly how
  // the options came to be dropped: `serviceOptions` discards unknown keys, so an operator running
  // `connect --t3-version X --install-service` got a service that silently started the pinned
  // version instead. An unset option must still write nothing, or a plain install would freeze
  // today's pin into the service definition and survive a later connector upgrade.
  const output = capture();
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/oauth/token")) return new Response(JSON.stringify({ access_token: "local-access" }));
    if (String(url).endsWith("/v1/connectors/enroll")) return new Response(JSON.stringify({ connector: { id: "con-svc" }, environment: { id: "env" }, secret: "standing" }), { status: 201 });
    throw new Error(`Unexpected URL: ${url}`);
  };
  class MockConnector { async run() {} stop() {} }
  const run = async (argv) => {
    let installed;
    // A fresh state directory per run: a second `connect --code` against an already-enrolled
    // state is a usage error, not the path under test.
    const stateDir = await mkdtemp(join(tmpdir(), "connector-cli-service-t3-"));
    const code = await main(argv, {
      stateDir,
      platform: "linux",
      env: {},
      stdout: output,
      stderr: output,
      fetchImpl,
      WebSocketImpl: class {},
      Connector: MockConnector,
      installService: async (options) => { installed = options; },
      ensureT3: async () => ({ baseUrl: "http://127.0.0.1:3773", info: { version: "0.0.32" }, owned: true, started: true, async stop() {} }),
      createT3PairingToken: async () => "pairing-token",
    });
    assert.equal(code, 0);
    return installed;
  };

  const withOptions = await run(["connect", "--server", "https://cloud.example", "--code", "code",
    "--t3-version", "0.1.4", "--t3-port", "4100", "--t3-start-timeout-ms", "90000", "--install-service"]);
  assert.equal(withOptions.t3Launch.version, "0.1.4");
  assert.equal(withOptions.t3Launch.port, 4100);
  assert.equal(withOptions.t3Launch.startTimeoutMs, 90000);

  const bare = await run(["connect", "--server", "https://cloud.example", "--code", "code", "--install-service"]);
  assert.equal(bare.t3Launch.version, undefined, "an unset version must not be frozen into the service");
  assert.equal(bare.t3Launch.port, undefined);
  assert.equal(bare.t3Launch.startTimeoutMs, undefined);
});

test("voice setup and status use managed runtime without connector enrollment", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-voice-cli-")); const output = capture();
  let installed = 0;
  assert.equal(await main(["voice", "setup"], {stateDir,stdout:output,stderr:output,setupVoiceRuntime:async()=>{installed++;}}),0);
  assert.equal(installed,1);
  assert.equal(await main(["voice", "status", "--json"], {stateDir,stdout:output,stderr:output,inspectVoiceRuntime:async()=>({ready:false})}),1);
  assert.equal(installed,1,"status must not install or start runtime");
  assert.equal(parseArgs(["voice","setup"]).voiceAction,"setup");
  assert.throws(()=>parseArgs(["voice","unknown"]),/Voice supports/);
});

// Built-in voice is optional, so it must not be able to take the connector offline. A loaded
// Windows host failed here *after* enrolment and T3 pairing had already succeeded, which left a
// correctly enrolled machine reporting nothing at all to its owner.
test("a voice failure leaves the connector running with voice disabled", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-cli-voice-fail-"));
  const output = capture();
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/.well-known/t3/environment")) return new Response(JSON.stringify({ version: "0.0.32" }));
    if (String(url).endsWith("/v1/connectors/enroll")) return new Response(JSON.stringify({ connector: { id: "con" }, environment: { id: "env" }, secret: "standing" }), { status: 201 });
    throw new Error(`Unexpected URL: ${url}`);
  };
  let constructed = false;
  let transcription = null;
  class MockConnector {
    constructor(input) {
      constructed = true;
      assert.equal(input.state.voice.enabled, false, "voice is recorded as unavailable, not absent");
      transcription = input.ensureLocalTranscription;
    }
    async run() {} stop() {}
  }
  const code = await main(["connect", "--server", "http://127.0.0.1:8787", "--code", "enroll-code", "--t3-url", "http://127.0.0.1:3773", "--once"], {
    stateDir, stdout: output, stderr: output, env: { NEXT_CODER_T3_TOKEN: "local-token" }, fetchImpl, WebSocketImpl: class {}, Connector: MockConnector,
    prepareVoiceRuntime: async () => { throw Object.assign(new Error("Local speech recognition did not become ready."), { code: "TRANSCRIPTION_UNAVAILABLE" }); },
  });
  assert.equal(code, 0, "connect still succeeds");
  assert.equal(constructed, true, "the connector is still constructed and runs");
  // The failure is reported rather than swallowed, and asking for transcription still refuses.
  assert.match(output.value(), /continuing without built-in voice/u);
  await assert.rejects(() => transcription({}), /did not become ready/u);
});
