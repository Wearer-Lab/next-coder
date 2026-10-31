import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createLocalT3PairingToken,
  DEFAULT_T3_START_TIMEOUT_MS,
  DEFAULT_T3_VERSION,
  ensureLocalT3,
  findExecutableOnPath,
  inspectOwnedT3,
  inspectProcessCommand,
  killProcessGroup,
  loadT3ProcessMetadata,
  parseWindowsCommandLine,
  processGroupAlive,
  resolveNpxLauncher,
  resolveT3Version,
  stopOwnedT3,
  T3_CLI_PLATFORMS,
  T3_FIRST_RUN_ALLOWANCE_MS,
  t3CliPlatformSupport,
  t3ProcessPaths,
  t3RuntimeCached,
} from "../src/t3Process.mjs";

test("existing loopback T3 is reused and never spawned or owned", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-reuse-"));
  let spawned = 0;
  const runtime = await ensureLocalT3({
    stateDir,
    runtimeCached: async () => true,
    fetchImpl: async () => new Response(JSON.stringify({ version: "0.0.32" })),
    spawnImpl: () => { spawned += 1; },
  });
  assert.equal(runtime.started, false);
  assert.equal(runtime.owned, false);
  assert.equal(spawned, 0);
  assert.equal((await runtime.stop()).reason, "not_owned");
});

test("absent T3 starts exact owned npx loopback process and stops only its group", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-start-"));
  let fetches = 0;
  let running = true;
  const spawned = [];
  const killed = [];
  const runtime = await ensureLocalT3({
    stateDir,
    runtimeCached: async () => true,
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) throw new TypeError("not running");
      return new Response(JSON.stringify({ version: "0.0.32" }));
    },
    findExecutable: async () => "/usr/local/bin/npx",
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      return { pid: 4321, exitCode: null, unref() {} };
    },
    inspectProcess: async () => running ? "node\0npm-cli.js\0exec\0t3\0serve" : null,
    killGroup: async (pgid, signal) => { killed.push({ pgid, signal }); running = false; },
    sleep: async () => {},
    platform: "linux",
    arch: "x64",
    env: {},
  });
  assert.equal(runtime.started, true);
  assert.equal(runtime.owned, true);
  assert.equal(spawned[0].command, "/usr/local/bin/npx");
  assert.equal(DEFAULT_T3_VERSION, "0.1.5");
  assert.deepEqual(spawned[0].args.slice(0, 5), ["--yes", "t3@0.1.5", "serve", "--port", "3773"]);
  assert.equal(spawned[0].args.includes("t3"), false, "the bare unpinned package name is never requested");
  assert.equal((await loadT3ProcessMetadata(stateDir)).t3Version, "0.1.5");
  assert.ok(spawned[0].args.includes("127.0.0.1"));
  assert.equal(spawned[0].args.some((arg) => arg === "0.0.0.0" || arg.startsWith("/Users/example/project")), false);
  assert.equal(spawned[0].options.detached, true);
  const metadata = await loadT3ProcessMetadata(stateDir);
  assert.equal(metadata.pid, 4321);
  if (process.platform !== "win32") assert.equal((await stat(join(stateDir, "t3-process.json"))).mode & 0o777, 0o600);
  assert.equal((await runtime.stop()).stopped, true);
  assert.deepEqual(killed, [{ pgid: 4321, signal: "SIGTERM" }]);
});

test("the default T3 pin is exact, and the override must name one exact version", () => {
  assert.equal(resolveT3Version({}), DEFAULT_T3_VERSION);
  assert.equal(resolveT3Version({ NEXT_CODER_T3_VERSION: "   " }), DEFAULT_T3_VERSION);
  assert.equal(resolveT3Version({ NEXT_CODER_T3_VERSION: " 0.1.4 " }), "0.1.4");
  assert.equal(resolveT3Version({ NEXT_CODER_T3_VERSION: "0.1.6-nightly.20261029" }), "0.1.6-nightly.20261029");
  for (const value of ["latest", "^0.1.5", "~0.1.5", "0.1", "0.1.x", "0.1.5 --registry=https://example.invalid", "https://example.invalid/t3.tgz"]) {
    assert.throws(() => resolveT3Version({ NEXT_CODER_T3_VERSION: value }), { code: "T3_VERSION_INVALID" }, value);
  }
});

test("the --t3-version flag outranks NEXT_CODER_T3_VERSION, and a blank flag is refused rather than defaulted", () => {
  assert.equal(resolveT3Version({ NEXT_CODER_T3_VERSION: "0.1.3" }, { explicit: "0.1.4" }), "0.1.4");
  assert.equal(resolveT3Version({ NEXT_CODER_T3_VERSION: "0.1.3" }, { explicit: null }), "0.1.3");
  assert.equal(resolveT3Version({}, { explicit: null }), DEFAULT_T3_VERSION);
  for (const value of ["latest", "   ", "^0.1.5"]) {
    assert.throws(() => resolveT3Version({ NEXT_CODER_T3_VERSION: "0.1.4" }, { explicit: value }), { code: "T3_VERSION_INVALID", message: /--t3-version/u }, value);
  }
});

test("an explicit NEXT_CODER_T3_VERSION is the version npx requests and the owned process records", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-override-"));
  const spawned = [];
  const probes = [];
  let fetches = 0;
  let running = true;
  const runtime = await ensureLocalT3({
    stateDir,
    platform: "linux",
    arch: "x64",
    env: { NEXT_CODER_T3_VERSION: "0.1.4" },
    runtimeCached: async (options) => { probes.push(options.version); return true; },
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) throw new TypeError("offline");
      return new Response(JSON.stringify({ version: "0.1.4" }));
    },
    findExecutable: async () => "/usr/local/bin/npx",
    spawnImpl: (command, args) => { spawned.push({ command, args }); return { pid: 4444, exitCode: null, unref() {} }; },
    inspectProcess: async () => running ? "owned-launcher-identity" : null,
    killGroup: async () => { running = false; },
    sleep: async () => {},
  });
  assert.equal(runtime.started, true);
  assert.deepEqual(spawned[0].args.slice(0, 3), ["--yes", "t3@0.1.4", "serve"]);
  assert.deepEqual(probes, ["0.1.4"], "the first-run probe asks about the release being started");
  assert.equal((await loadT3ProcessMetadata(stateDir)).t3Version, "0.1.4");
  assert.equal((await inspectOwnedT3({ stateDir, platform: "linux", env: {}, inspectProcess: async () => "owned-launcher-identity" })).t3Version, "0.1.4");
  assert.equal((await runtime.stop()).stopped, true);
});

test("an invalid override is refused before an owned T3 is stopped or a new one is spawned", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-invalid-pin-"));
  const first = await startOwnedLinuxT3(stateDir, { env: {} });
  assert.equal(first.owned, true);
  let kills = 0;
  let spawned = 0;
  const error = await ensureLocalT3({
    stateDir,
    platform: "linux",
    arch: "x64",
    env: { NEXT_CODER_T3_VERSION: "latest" },
    runtimeCached: async () => true,
    fetchImpl: async () => { throw new TypeError("offline"); },
    inspectProcess: async () => "owned-launcher-identity",
    killGroup: async () => { kills += 1; },
    spawnImpl: () => { spawned += 1; return { pid: 9999, exitCode: null, unref() {} }; },
    sleep: async () => {},
  }).then(() => null, (reason) => reason);
  assert.equal(error?.code, "T3_VERSION_INVALID");
  assert.equal(kills, 0);
  assert.equal(spawned, 0);
  assert.equal((await loadT3ProcessMetadata(stateDir)).pid, 9100, "the existing owned record is left exactly as it was");
});

test("an explicit --t3-version beats NEXT_CODER_T3_VERSION and is the release npx requests", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-flag-pin-"));
  const spawned = [];
  const probes = [];
  let fetches = 0;
  let running = true;
  const runtime = await ensureLocalT3({
    stateDir,
    platform: "linux",
    arch: "x64",
    env: { NEXT_CODER_T3_VERSION: "0.1.3" },
    explicitT3Version: "0.1.4",
    runtimeCached: async (options) => { probes.push(options.version); return true; },
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) throw new TypeError("offline");
      return new Response(JSON.stringify({ version: "0.1.4" }));
    },
    findExecutable: async () => "/usr/local/bin/npx",
    spawnImpl: (command, args) => { spawned.push({ command, args }); return { pid: 4445, exitCode: null, unref() {} }; },
    inspectProcess: async () => running ? "owned-launcher-identity" : null,
    killGroup: async () => { running = false; },
    sleep: async () => {},
  });
  assert.equal(runtime.started, true);
  assert.deepEqual(spawned[0].args.slice(0, 3), ["--yes", "t3@0.1.4", "serve"]);
  assert.deepEqual(probes, ["0.1.4"]);
  assert.equal((await loadT3ProcessMetadata(stateDir)).t3Version, "0.1.4");
  assert.equal((await runtime.stop()).stopped, true);
});

test("an invalid --t3-version is refused before spawning, even when NEXT_CODER_T3_VERSION is valid", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-invalid-flag-"));
  let spawned = 0;
  const error = await ensureLocalT3({
    stateDir,
    platform: "linux",
    arch: "x64",
    env: { NEXT_CODER_T3_VERSION: "0.1.4" },
    explicitT3Version: "latest",
    runtimeCached: async () => true,
    fetchImpl: async () => { throw new TypeError("offline"); },
    spawnImpl: () => { spawned += 1; return { pid: 9999, exitCode: null, unref() {} }; },
    sleep: async () => {},
  }).then(() => null, (reason) => reason);
  assert.equal(error?.code, "T3_VERSION_INVALID");
  assert.match(error.message, /--t3-version/u);
  assert.equal(spawned, 0);
  await assert.rejects(stat(join(stateDir, "t3-process.json")), { code: "ENOENT" });
});

test("reusing an already-running T3 never consults the pin, so even an invalid override is not read", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-reuse-pin-"));
  let probes = 0;
  let spawned = 0;
  const runtime = await ensureLocalT3({
    stateDir,
    platform: "linux",
    arch: "x64",
    env: { NEXT_CODER_T3_VERSION: "latest" },
    runtimeCached: async () => { probes += 1; return true; },
    fetchImpl: async () => new Response(JSON.stringify({ version: "0.1.5" })),
    spawnImpl: () => { spawned += 1; },
  });
  assert.equal(runtime.started, false);
  assert.equal(runtime.owned, false);
  assert.equal(probes, 0);
  assert.equal(spawned, 0);
});

test("the first-run probe checks only the pinned release when a version is given", async () => {
  const accessed = [];
  const fs = {
    async readdir() { throw new Error("a pinned probe must not scan other releases"); },
    async access(path) {
      accessed.push(path);
      if (!/0\.1\.5[\\/]\.install-complete$/u.test(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
  assert.equal(await t3RuntimeCached({ env: { T3CODE_HOME: "/srv/t3home" }, fs, version: "0.1.5" }), true);
  assert.equal(await t3RuntimeCached({ env: { T3CODE_HOME: "/srv/t3home" }, fs, version: "0.1.4" }), false, "another cached release does not count");
  assert.equal(accessed.length, 2);
});

test("pairing uses the same pin and refuses an invalid override before running npx", async () => {
  let ran = 0;
  const error = await createLocalT3PairingToken({
    baseUrl: "http://127.0.0.1:3773",
    baseDir: "/private/connector/t3",
    npxCommand: "/usr/local/bin/npx",
    platform: "linux",
    arch: "x64",
    env: { NEXT_CODER_T3_VERSION: "^0.1.0" },
    run: async () => { ran += 1; return { stdout: "{}" }; },
  }).then(() => null, (reason) => reason);
  assert.equal(error?.code, "T3_VERSION_INVALID");
  assert.equal(ran, 0);
});

test("pairing requests the same explicit release as the launch", async () => {
  let call;
  await createLocalT3PairingToken({
    baseUrl: "http://127.0.0.1:3773",
    baseDir: "/private/connector/t3",
    npxCommand: "/usr/local/bin/npx",
    arch: "arm64",
    env: { NEXT_CODER_T3_VERSION: "0.1.3" },
    explicitT3Version: "0.1.4",
    run: async (file, args) => { call = { file, args }; return { code: 0, stdout: JSON.stringify({ credential: "pairing-secret" }), stderr: "" }; },
  });
  assert.deepEqual(call.args.slice(0, 3), ["--yes", "t3@0.1.4", "auth"]);
});

test("auto-start opt-out fails without spawning", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-optout-"));
  let spawned = false;
  await assert.rejects(ensureLocalT3({ stateDir, autoStart: false, runtimeCached: async () => true, fetchImpl: async () => { throw new TypeError("offline"); }, spawnImpl: () => { spawned = true; } }), { code: "T3_NOT_RUNNING" });
  assert.equal(spawned, false);
});

test("persisted PID mismatch is never killed", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-mismatch-"));
  let fetches = 0;
  await ensureLocalT3({
    stateDir,
    arch: "arm64",
    runtimeCached: async () => true,
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) throw new TypeError("offline");
      return new Response(JSON.stringify({ version: "0.0.32" }));
    },
    findExecutable: async () => "/usr/local/bin/npx",
    spawnImpl: () => ({ pid: 5555, exitCode: null, unref() {} }),
    inspectProcess: async () => "owned-command",
    killGroup: async () => {},
    sleep: async () => {},
  });
  let kills = 0;
  await assert.rejects(stopOwnedT3({
    stateDir,
    inspectProcess: async () => "different-command",
    killGroup: async () => { kills += 1; },
  }), { code: "T3_PROCESS_IDENTITY_MISMATCH" });
  assert.equal(kills, 0);
  assert.match(await readFile(join(stateDir, "t3-process.json"), "utf8"), /5555/);
});

test("local pairing uses the documented npx t3 auth contract", async () => {
  let call;
  const token = await createLocalT3PairingToken({
    baseUrl: "http://127.0.0.1:3773",
    baseDir: "/private/connector/t3",
    npxCommand: "/usr/local/bin/npx",
    arch: "arm64",
    env: {},
    run: async (file, args) => { call = { file, args }; return { code: 0, stdout: JSON.stringify({ credential: "pairing-secret" }), stderr: "" }; },
  });
  assert.equal(token, "pairing-secret");
  assert.equal(call.file, "/usr/local/bin/npx");
  assert.deepEqual(call.args.slice(0, 6), ["--yes", "t3@0.1.5", "auth", "pairing", "create", "--base-dir"]);
  assert.ok(call.args.includes("--json"));
});

test("Windows auto-start uses a verified node+npx-cli argument-array process and owns only its PID tree", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-windows-start-"));
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const npxCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js";
  const spawned = [];
  const killed = [];
  let fetches = 0;
  let running = true;
  let expectedCommandLine = "";
  const runtime = await ensureLocalT3({
    stateDir,
    runtimeCached: async () => true,
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", PATH: "C:\\Program Files\\nodejs" },
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) throw new TypeError("offline");
      return new Response(JSON.stringify({ version: "0.0.32" }));
    },
    findExecutable: async () => "C:\\Program Files\\nodejs\\npx.cmd",
    resolveLauncher: async () => ({ command: node, argsPrefix: [npxCli] }),
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      expectedCommandLine = [command, ...args].map(windowsQuote).join(" ");
      return { pid: 6789, exitCode: null, unref() {} };
    },
    inspectProcess: async () => running ? JSON.stringify({ pid: 6789, executablePath: node, commandLine: expectedCommandLine, creationDate: "20260827120000.000000-240" }) : null,
    killGroup: async (pid, signal, options) => { killed.push({ pid, signal, options }); running = false; },
    sleep: async () => {},
  });

  assert.equal(runtime.started, true);
  assert.equal(runtime.owned, true);
  assert.equal(spawned[0].command, node);
  assert.equal(spawned[0].args[0], npxCli);
  assert.equal(spawned[0].args.includes("C:\\Program Files\\nodejs\\npx.cmd"), false);
  assert.equal(spawned[0].options.shell, false);
  assert.equal(spawned[0].options.windowsHide, true);
  assert.equal(spawned[0].options.detached, true);
  const metadata = await loadT3ProcessMetadata(stateDir);
  assert.equal(metadata.platform, "win32");
  assert.equal(metadata.controlKind, "windows-process-tree");
  assert.equal(metadata.command, node);
  assert.equal(metadata.baseDir, spawned[0].options.cwd);
  assert.deepEqual(await inspectOwnedT3({ stateDir, platform: "win32", inspectProcess: async () => running ? JSON.stringify({ pid: 6789, executablePath: node, commandLine: expectedCommandLine, creationDate: "20260827120000.000000-240" }) : null }), {
    managed: true, running: true, verified: true, status: "owned_running", pid: 6789, t3Version: DEFAULT_T3_VERSION,
  });
  assert.equal((await runtime.stop()).stopped, true);
  assert.equal(killed.length, 1);
  assert.equal(killed[0].pid, 6789);
  assert.equal(killed[0].signal, "SIGTERM");
  assert.equal(killed[0].options.platform, "win32");
});

test("Windows process inspection and termination use fixed system tools with PID-only argument arrays", async () => {
  const calls = [];
  const env = { SystemRoot: "C:\\Windows", NEXT_CODER_T3_TOKEN: "must-not-reach-tools" };
  const identity = await inspectProcessCommand(4242, {
    platform: "win32",
    env,
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      return { code: 0, stdout: JSON.stringify({ pid: 4242, executablePath: "C:\\node.exe", commandLine: "C:\\node.exe server.js", creationDate: "stamp" }), stderr: "" };
    },
  });
  assert.deepEqual(JSON.parse(identity), { pid: 4242, executablePath: "C:\\node.exe", commandLine: "C:\\node.exe server.js", creationDate: "stamp" });
  await killProcessGroup(4242, "SIGTERM", { platform: "win32", env, run: async (file, args, options) => { calls.push({ file, args, options }); } });
  await killProcessGroup(4242, "SIGKILL", { platform: "win32", env, run: async (file, args, options) => { calls.push({ file, args, options }); } });
  assert.match(calls[0].file, /WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.equal(calls[0].args.includes("-EncodedCommand"), true);
  assert.equal(calls[0].args.some((arg) => /4242/.test(arg)), false);
  assert.equal(calls[0].options.env.NEXT_CODER_INSPECT_PID, "4242");
  assert.equal("NEXT_CODER_T3_TOKEN" in calls[0].options.env, false);
  assert.deepEqual(calls[1].args, ["/PID", "4242", "/T"]);
  assert.deepEqual(calls[2].args, ["/PID", "4242", "/T", "/F"]);
  assert.equal(calls.some(({ file }) => /cmd(?:\.exe)?$/i.test(file)), false);
});

test("Windows PATH discovery resolves PATHEXT and npx.cmd through a verified JS launcher", async () => {
  const accesses = [];
  const fs = {
    async access(path) {
      accesses.push(path);
      if (!/npx\.cmd$|npx-cli\.js$/i.test(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
  const npx = await findExecutableOnPath("npx", { platform: "win32", env: { PATH: "C:\\Tools;C:\\Program Files\\nodejs", PATHEXT: ".EXE;.CMD" }, fs });
  assert.equal(npx, "C:\\Tools\\npx.cmd");
  const launcher = await resolveNpxLauncher(npx, { platform: "win32", nodeExecutable: "C:\\Program Files\\nodejs\\node.exe", fs });
  assert.equal(launcher.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(launcher.argsPrefix, ["C:\\Tools\\node_modules\\npm\\bin\\npx-cli.js"]);
  assert.equal(accesses.some((path) => /npx\.exe$/i.test(path)), true);
});

test("interrupted Windows launch journal is adopted only with the exact observed fingerprint", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-windows-recover-"));
  let fetches = 0;
  const observed = JSON.stringify({ pid: 7001, executablePath: "C:\\node.exe", commandLine: "C:\\node.exe npx-cli.js --yes t3 serve", creationDate: "stamp" });
  await ensureLocalT3({
    stateDir,
    runtimeCached: async () => true,
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) throw new TypeError("offline");
      return new Response(JSON.stringify({ version: "0.0.32" }));
    },
    findExecutable: async () => "/usr/local/bin/npx",
    spawnImpl: () => ({ pid: 7001, exitCode: null, unref() {} }),
    inspectProcess: async () => observed,
    killGroup: async () => {},
    sleep: async () => {},
    platform: "linux",
  });
  const paths = t3ProcessPaths(stateDir);
  await rename(paths.metadataPath, paths.startingPath);
  let spawned = false;
  const recovered = await ensureLocalT3({
    stateDir,
    runtimeCached: async () => true,
    platform: "win32",
    fetchImpl: async () => new Response(JSON.stringify({ version: "0.0.32" })),
    inspectProcess: async () => observed,
    spawnImpl: () => { spawned = true; },
  });
  assert.equal(recovered.owned, true);
  assert.equal(recovered.started, false);
  assert.equal(spawned, false);
  await stat(paths.metadataPath);
  await assert.rejects(stat(paths.startingPath), { code: "ENOENT" });
});

test("unverified interrupted Windows launch blocks duplicate spawn and never kills by PID", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-windows-unverified-"));
  const paths = t3ProcessPaths(stateDir);
  const starting = {
    version: 1, connectorOwned: true, pid: 8123, processGroupId: 8123, platform: "win32", controlKind: "windows-process-tree",
    command: "C:\\node.exe", args: ["npx-cli.js", "--yes", "t3", "serve", "--base-dir", paths.baseDir], npxCommand: "C:\\npx.cmd",
    baseUrl: "http://127.0.0.1:3773", baseDir: paths.baseDir, startedAt: new Date().toISOString(), observedCommandHash: null,
  };
  await writeFile(paths.startingPath, JSON.stringify(starting), { mode: 0o600 });
  let spawned = 0;
  let killed = 0;
  await assert.rejects(ensureLocalT3({
    stateDir,
    runtimeCached: async () => true,
    platform: "win32",
    fetchImpl: async () => { throw new TypeError("offline"); },
    inspectProcess: async () => JSON.stringify({ pid: 8123, executablePath: "C:\\node.exe", commandLine: "C:\\node.exe npx-cli.js", creationDate: "stamp" }),
    spawnImpl: () => { spawned += 1; },
    killGroup: async () => { killed += 1; },
  }), { code: "T3_PROCESS_RECOVERY_UNVERIFIED" });
  assert.equal(spawned, 0);
  assert.equal(killed, 0);
  assert.equal((await inspectOwnedT3({ stateDir, platform: "win32", inspectProcess: async () => "different" })).status, "interrupted_start_unverified");
  await rm(paths.startingPath, { force: true });
});

test("Windows launch without inspectable identity leaves recovery evidence and never guesses at termination", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-windows-no-identity-"));
  let childKills = 0;
  let treeKills = 0;
  await assert.rejects(ensureLocalT3({
    stateDir,
    runtimeCached: async () => true,
    platform: "win32",
    timeoutMs: 1,
    fetchImpl: async () => { throw new TypeError("offline"); },
    findExecutable: async () => "C:\\nodejs\\npx.exe",
    spawnImpl: () => ({ pid: 8222, exitCode: null, unref() {}, kill() { childKills += 1; } }),
    inspectProcess: async () => null,
    killGroup: async () => { treeKills += 1; },
    sleep: async () => {},
  }), { code: "T3_PROCESS_UNVERIFIED" });
  assert.equal(childKills, 0);
  assert.equal(treeKills, 0);
  const journal = JSON.parse(await readFile(t3ProcessPaths(stateDir).startingPath, "utf8"));
  assert.equal(journal.pid, 8222);
  assert.equal(journal.observedCommandHash, null);
});

test("pre-spawn interruption intent fails closed before any duplicate Windows launch", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-windows-launch-intent-"));
  const paths = t3ProcessPaths(stateDir);
  await writeFile(paths.startingPath, JSON.stringify({
    version: 1, connectorOwned: true, phase: "launching", pid: null, processGroupId: null, platform: "win32", controlKind: "windows-process-tree",
    command: "C:\\node.exe", args: ["npx-cli.js", "--yes", "t3", "serve", "--base-dir", paths.baseDir], npxCommand: "C:\\npx.cmd",
    baseUrl: "http://127.0.0.1:3773", baseDir: paths.baseDir, startedAt: new Date().toISOString(), observedCommandHash: null,
  }), { mode: 0o600 });
  let inspected = 0;
  let spawned = 0;
  await assert.rejects(ensureLocalT3({
    stateDir,
    runtimeCached: async () => true,
    platform: "win32",
    fetchImpl: async () => { throw new TypeError("offline"); },
    inspectProcess: async () => { inspected += 1; return null; },
    spawnImpl: () => { spawned += 1; },
  }), { code: "T3_PROCESS_RECOVERY_UNVERIFIED" });
  assert.equal(inspected, 0);
  assert.equal(spawned, 0);
  assert.deepEqual(await inspectOwnedT3({ stateDir, platform: "win32" }), { managed: true, running: false, verified: false, status: "interrupted_launch_unknown" });
});

test("Windows pairing invocation also bypasses command shims and preserves argument boundaries", async () => {
  let call;
  const credential = await createLocalT3PairingToken({
    baseUrl: "http://127.0.0.1:3773",
    baseDir: "C:\\Users\\Alice Example\\T3",
    npxCommand: "C:\\Program Files\\nodejs\\npx.cmd",
    platform: "win32",
    resolveLauncher: async () => ({ command: "C:\\Program Files\\nodejs\\node.exe", argsPrefix: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js"] }),
    run: async (file, args) => { call = { file, args }; return { stdout: JSON.stringify({ credential: "pairing-secret" }), stderr: "", code: 0 }; },
  });
  assert.equal(credential, "pairing-secret");
  assert.equal(call.file, "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(call.args[0], "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js");
  assert.equal(call.args.includes("C:\\Program Files\\nodejs\\npx.cmd"), false);
  assert.equal(call.args[call.args.indexOf("--base-dir") + 1].includes("Alice Example"), true);
});

test("Windows command-line parser preserves quoted paths and escaped quotes", () => {
  assert.deepEqual(parseWindowsCommandLine('"C:\\Program Files\\node.exe" "C:\\path with spaces\\npx-cli.js" "quoted\\\"value" plain'), [
    "C:\\Program Files\\node.exe", "C:\\path with spaces\\npx-cli.js", 'quoted"value', "plain",
  ]);
});

// --- T3 now ships as an npm launcher that downloads a platform archive and spawns the real binary.

async function startOwnedLinuxT3(stateDir, overrides = {}) {
  let fetches = 0;
  return await ensureLocalT3({
    stateDir,
    platform: "linux",
    arch: "x64",
    runtimeCached: async () => true,
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) throw new TypeError("offline");
      return new Response(JSON.stringify({ version: "0.1.5" }));
    },
    findExecutable: async () => "/usr/local/bin/npx",
    spawnImpl: () => ({ pid: 9100, exitCode: null, unref() {} }),
    inspectProcess: async () => "owned-launcher-identity",
    killGroup: async () => {},
    sleep: async () => {},
    ...overrides,
  });
}

test("platform support table matches the launcher's published builds exactly", () => {
  assert.deepEqual([...T3_CLI_PLATFORMS], ["darwin-arm64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
  for (const key of T3_CLI_PLATFORMS) {
    const [platform, arch] = key.split("-");
    assert.equal(t3CliPlatformSupport({ platform, arch }).supported, true, key);
  }
  for (const [platform, arch] of [["darwin", "x64"], ["win32", "ia32"], ["linux", "ia32"], ["linux", "arm"], ["freebsd", "x64"]]) {
    const support = t3CliPlatformSupport({ platform, arch });
    assert.equal(support.supported, false, `${platform}-${arch}`);
    assert.deepEqual(support.supportedKeys, [...T3_CLI_PLATFORMS]);
  }
});

test("an Intel Mac is refused before any ownership state, PATH lookup, or spawn, and the refusal is not retryable", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-intel-"));
  let spawned = 0;
  let looked = 0;
  let inspected = 0;
  const error = await ensureLocalT3({
    stateDir,
    platform: "darwin",
    arch: "x64",
    fetchImpl: async () => { throw new TypeError("offline"); },
    findExecutable: async () => { looked += 1; return "/usr/local/bin/npx"; },
    spawnImpl: () => { spawned += 1; },
    inspectProcess: async () => { inspected += 1; return null; },
  }).then(() => null, (reason) => reason);
  assert.equal(error?.code, "T3_PLATFORM_UNSUPPORTED");
  assert.equal(error.retryable, false);
  assert.match(error.message, /darwin-x64/u);
  for (const key of T3_CLI_PLATFORMS) assert.match(error.message, new RegExp(key, "u"));
  assert.match(error.message, /--agents-file/u);
  assert.equal(spawned, 0);
  assert.equal(looked, 0);
  assert.equal(inspected, 0);
  await assert.rejects(stat(join(stateDir, "t3-process.starting.json")), { code: "ENOENT" });
  await assert.rejects(stat(join(stateDir, "t3-process.json")), { code: "ENOENT" });
});

test("an unsupported platform may still reuse a T3 someone else runs, and --no-start-t3 keeps its own error", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-intel-reuse-"));
  const reused = await ensureLocalT3({ stateDir, platform: "darwin", arch: "x64", fetchImpl: async () => new Response(JSON.stringify({ version: "0.1.5" })) });
  assert.equal(reused.owned, false);
  await assert.rejects(ensureLocalT3({ stateDir, platform: "darwin", arch: "x64", autoStart: false, fetchImpl: async () => { throw new TypeError("offline"); } }), { code: "T3_NOT_RUNNING" });
});

test("pairing through npx is refused with the platform error instead of an opaque pairing failure", async () => {
  let ran = 0;
  const error = await createLocalT3PairingToken({
    baseUrl: "http://127.0.0.1:3773", baseDir: "/private/connector/t3", npxCommand: "/usr/local/bin/npx",
    platform: "darwin", arch: "x64", run: async () => { ran += 1; return { stdout: "{}" }; },
  }).then(() => null, (reason) => reason);
  assert.equal(error?.code, "T3_PLATFORM_UNSUPPORTED");
  assert.match(error.message, /--t3-token-file|--t3-pairing-token/u);
  assert.equal(ran, 0);
});

test("a launcher that dies is reported with a first-run download hint, not a bare exit", async () => {
  for (const [cached, pattern] of [[false, /downloads its runtime on the first launch.*github\.com/u], [true, /npx --yes t3@0\.1\.5 serve.*terminal/u]]) {
    const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-launcher-exit-"));
    const error = await startOwnedLinuxT3(stateDir, {
      runtimeCached: async () => cached,
      spawnImpl: () => ({ pid: 9101, exitCode: 1, unref() {} }),
      fetchImpl: async () => { throw new TypeError("offline"); },
    }).then(() => null, (reason) => reason);
    assert.equal(error?.code, "T3_START_FAILED");
    assert.match(error.message, pattern);
    await assert.rejects(stat(join(stateDir, "t3-process.json")), { code: "ENOENT" });
  }
});

test("the launch-failure hint names the requested release rather than the unpinned command", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-hint-pin-"));
  const error = await startOwnedLinuxT3(stateDir, {
    env: {},
    explicitT3Version: "0.1.4",
    spawnImpl: () => ({ pid: 9102, exitCode: 1, unref() {} }),
    fetchImpl: async () => { throw new TypeError("offline"); },
  }).then(() => null, (reason) => reason);
  assert.equal(error?.code, "T3_START_FAILED");
  assert.match(error.message, /`npx --yes t3@0\.1\.4 serve` in a terminal/u);
  assert.doesNotMatch(error.message, /npx t3 serve/u);
});

test("a cold runtime cache earns a bounded additive readiness allowance; a warm one keeps the caller's bound", async () => {
  for (const [cached, expected] of [[false, 1_000 + T3_FIRST_RUN_ALLOWANCE_MS], [true, 1_000]]) {
    const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-first-run-"));
    let clock = 0;
    const kills = [];
    let running = true;
    const error = await startOwnedLinuxT3(stateDir, {
      timeoutMs: 1_000,
      runtimeCached: async () => cached,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      fetchImpl: async () => { throw new TypeError("not listening yet"); },
      inspectProcess: async () => running ? "owned-launcher-identity" : null,
      killGroup: async (pgid, signal) => { kills.push({ pgid, signal }); running = false; },
    }).then(() => null, (reason) => reason);
    assert.equal(error?.code, "T3_START_TIMEOUT");
    assert.match(error.message, new RegExp(`within ${expected}ms`, "u"));
    // The hint has to reproduce the launch, so it names the release requested, never `t3@undefined`.
    assert.match(error.message, new RegExp(`\`npx --yes t3@${DEFAULT_T3_VERSION.replace(/\./gu, "\\.")} serve\``, "u"));
    assert.doesNotMatch(error.message, /t3@undefined/u);
    assert.ok(clock >= expected && clock < expected + 1_000, `virtual clock ${clock} should stop right after ${expected}`);
    assert.deepEqual(kills, [{ pgid: 9100, signal: "SIGTERM" }]);
  }
  assert.ok(T3_FIRST_RUN_ALLOWANCE_MS > 0 && Number.isFinite(T3_FIRST_RUN_ALLOWANCE_MS), "the allowance is finite, never an unbounded wait");
});

test("a failing runtime-cache probe widens the bound instead of failing the launch", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-probe-error-"));
  const runtime = await startOwnedLinuxT3(stateDir, { runtimeCached: async () => { throw new Error("EACCES"); } });
  assert.equal(runtime.started, true);
});

test("runtime cache probe mirrors the launcher: T3CODE_HOME, completion marker, ignoring staging folders", async () => {
  const accessed = [];
  const fs = {
    async readdir(path) { accessed.push(["readdir", path]); return ["0.1.5.staging-abc123", "0.1.1"]; },
    async access(path) { accessed.push(["access", path]); if (!/0\.1\.1[\\/]\.install-complete$/u.test(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  };
  assert.equal(await t3RuntimeCached({ env: { T3CODE_HOME: "/srv/t3home" }, fs }), true);
  assert.equal(accessed[0][1], join("/srv/t3home", "runtime", "versions"));
  assert.equal(accessed.some(([, path]) => /staging/u.test(path) && /install-complete/u.test(path)), false, "a half-extracted staging folder never counts");
  const stagingOnly = { async readdir() { return ["0.1.5.staging-abc123"]; }, async access() { throw new Error("must not be consulted"); } };
  assert.equal(await t3RuntimeCached({ env: { T3CODE_HOME: "/srv/t3home" }, fs: stagingOnly }), false);
  await assert.rejects(t3RuntimeCached({ env: { T3CODE_HOME: "/srv/t3home" }, fs: { async readdir() { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } } }), { code: "ENOENT" });
});

test("POSIX identity is pid plus start time and survives npx rewriting its own process title", async () => {
  const stat = (comm, state, start) => `4321 (${comm}) ${state} 1 4321 4321 0 -1 4194560 0 0 0 0 1 2 0 0 20 0 9 0 ${start} 1000 100 18446744073709551615`;
  const procFs = (statText) => ({
    async readFile(path) {
      if (path === "/proc/4321/stat") return statText;
      if (path === "/proc/sys/kernel/random/boot_id") return "boot-1\n";
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  // The same process observed under the three titles npx really cycles through (env node npx -> npm -> npm exec).
  const identities = await Promise.all(["env", "npm", "npm exec (x y) z"].map((comm) => inspectProcessCommand(4321, { platform: "linux", fs: procFs(stat(comm, "S", 987654)) })));
  assert.equal(new Set(identities).size, 1);
  assert.deepEqual(JSON.parse(identities[0]), { pid: 4321, startTicks: "987654", bootId: "boot-1" });
  assert.notEqual(await inspectProcessCommand(4321, { platform: "linux", fs: procFs(stat("npm", "S", 987655)) }), identities[0], "a recycled pid has a different start time");
  assert.equal(await inspectProcessCommand(4321, { platform: "linux", fs: procFs(stat("npm", "Z", 987654)) }), null, "a zombie is not a running process");
  assert.equal(await inspectProcessCommand(4322, { platform: "linux", fs: procFs("") }), null);
  await assert.rejects(inspectProcessCommand(4321, { platform: "linux", fs: procFs("garbage") }), { code: "T3_PROCESS_INSPECTION_INVALID" });
});

test("macOS identity asks ps for start time and state only, never the mutable command line", async () => {
  const calls = [];
  const exec = (output) => async (file, args, options) => { calls.push({ file, args, options }); if (output instanceof Error) throw output; return { stdout: output }; };
  const first = await inspectProcessCommand(4321, { platform: "darwin", exec: exec("Fri Oct 30 15:47:41 2026 Ss\n") });
  const second = await inspectProcessCommand(4321, { platform: "darwin", exec: exec("Fri Oct 30 15:47:41 2026 S+\n") });
  assert.equal(first, second, "state flags may change between observations; identity must not");
  assert.deepEqual(JSON.parse(first), { pid: 4321, startTime: "Fri Oct 30 15:47:41 2026" });
  assert.equal(calls[0].file, "/bin/ps");
  assert.equal(calls[0].args.includes("command="), false);
  assert.equal(calls[0].options.env.LC_ALL, "C");
  assert.equal(await inspectProcessCommand(4321, { platform: "darwin", exec: exec("Fri Oct 30 15:47:41 2026 Z\n") }), null);
  assert.equal(await inspectProcessCommand(4321, { platform: "darwin", exec: exec(Object.assign(new Error("none"), { code: 1 })) }), null);
});

test("process group probe sends no signal, treats ESRCH as gone, and is inert on Windows", async () => {
  const sent = [];
  assert.equal(await processGroupAlive(4321, { platform: "linux", kill: (target, signal) => { sent.push([target, signal]); } }), true);
  assert.deepEqual(sent, [[-4321, 0]]);
  assert.equal(await processGroupAlive(4321, { platform: "linux", kill: () => { throw Object.assign(new Error("none"), { code: "ESRCH" }); } }), false);
  await assert.rejects(processGroupAlive(4321, { platform: "linux", kill: () => { throw Object.assign(new Error("foreign"), { code: "EPERM" }); } }), { code: "EPERM" });
  assert.equal(await processGroupAlive(4321, { platform: "win32", kill: () => { throw new Error("must not be called"); } }), false);
  assert.equal(await processGroupAlive(1, { platform: "linux", kill: () => { throw new Error("must not be called"); } }), false);
});

async function ownedStopFixture(overrides = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-group-stop-"));
  const runtime = await startOwnedLinuxT3(stateDir);
  assert.equal(runtime.owned, true);
  return { stateDir, runtime, paths: t3ProcessPaths(stateDir), ...overrides };
}

test("stop escalates to SIGKILL when the npx launcher exits but the real T3 in its group is still alive", async () => {
  const { stateDir, paths } = await ownedStopFixture();
  let leaderAlive = true;
  let memberAlive = true;
  const signals = [];
  const result = await stopOwnedT3({
    stateDir,
    platform: "linux",
    inspectProcess: async () => leaderAlive ? "owned-launcher-identity" : null,
    groupAlive: async () => leaderAlive || memberAlive,
    killGroup: async (pgid, signal) => {
      signals.push(`${pgid}:${signal}`);
      if (signal === "SIGTERM") leaderAlive = false; // launcher quits, the T3 grandchild lingers
      else memberAlive = false;
    },
    sleep: async () => {},
  });
  assert.equal(result.stopped, true);
  assert.deepEqual(signals, ["9100:SIGTERM", "9100:SIGKILL"]);
  await assert.rejects(stat(paths.metadataPath), { code: "ENOENT" });
});

test("stop still reaches an orphaned T3 whose launcher is already gone, using only the exact recorded group", async () => {
  const { stateDir, paths } = await ownedStopFixture();
  let memberAlive = true;
  const signals = [];
  const result = await stopOwnedT3({
    stateDir,
    platform: "linux",
    inspectProcess: async () => null,
    groupAlive: async (pgid) => { assert.equal(pgid, 9100); return memberAlive; },
    killGroup: async (pgid, signal) => { signals.push(`${pgid}:${signal}`); if (signal === "SIGKILL") memberAlive = false; },
    sleep: async () => {},
  });
  assert.equal(result.stopped, true);
  assert.deepEqual(signals, ["9100:SIGTERM", "9100:SIGKILL"]);
  await assert.rejects(stat(paths.metadataPath), { code: "ENOENT" });
});

test("stop with neither launcher nor group alive only clears the record and sends no signal", async () => {
  const { stateDir, paths } = await ownedStopFixture();
  let signals = 0;
  const result = await stopOwnedT3({ stateDir, platform: "linux", inspectProcess: async () => null, groupAlive: async () => false, killGroup: async () => { signals += 1; }, sleep: async () => {} });
  assert.deepEqual(result, { stopped: false, reason: "not_running" });
  assert.equal(signals, 0);
  await assert.rejects(stat(paths.metadataPath), { code: "ENOENT" });
});

test("a recycled PID is still never signalled even when a group probe says something is alive", async () => {
  const { stateDir, paths } = await ownedStopFixture();
  let signals = 0;
  await assert.rejects(stopOwnedT3({
    stateDir, platform: "linux",
    inspectProcess: async () => "an-unrelated-process",
    groupAlive: async () => true,
    killGroup: async () => { signals += 1; },
    sleep: async () => {},
  }), { code: "T3_PROCESS_IDENTITY_MISMATCH" });
  assert.equal(signals, 0);
  await stat(paths.metadataPath);
});

test("stop keeps the ownership record and fails loudly if the group survives SIGKILL", async () => {
  const { stateDir, paths } = await ownedStopFixture();
  await assert.rejects(stopOwnedT3({
    stateDir, platform: "linux",
    inspectProcess: async () => null,
    groupAlive: async () => true,
    killGroup: async () => {},
    sleep: async () => {},
    forceExitGraceMs: 5,
  }), { code: "T3_PROCESS_STOP_FAILED" });
  await stat(paths.metadataPath);
});

test("Windows stop does not consult a group probe and keeps the leader-only PID-tree contract", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-windows-stop-"));
  const paths = t3ProcessPaths(stateDir);
  const identity = JSON.stringify({ pid: 6789, executablePath: "C:\\node.exe", commandLine: "C:\\node.exe npx-cli.js", creationDate: "stamp" });
  const { createHash } = await import("node:crypto");
  await writeFile(paths.metadataPath, JSON.stringify({
    version: 1, connectorOwned: true, pid: 6789, processGroupId: 6789, platform: "win32", controlKind: "windows-process-tree",
    command: "C:\\node.exe", args: ["npx-cli.js"], baseUrl: "http://127.0.0.1:3773", baseDir: paths.baseDir,
    observedCommandHash: createHash("sha256").update(identity).digest("hex"),
  }), { mode: 0o600 });
  let running = true;
  const calls = [];
  const result = await stopOwnedT3({
    stateDir, platform: "win32",
    inspectProcess: async () => running ? identity : null,
    killGroup: async (pid, signal) => { calls.push([pid, signal]); running = false; },
    sleep: async () => {},
  });
  assert.equal(result.stopped, true);
  assert.deepEqual(calls, [[6789, "SIGTERM"]]);
});

function windowsQuote(value) {
  if (value && !/[\s"]/.test(value)) return value;
  return `"${String(value).replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

// The CLI used to carry its own `?? 60_000`, so the documented default and the module default were
// two numbers that could disagree. They are now one constant; this fails if either drifts.
test("the start-timeout default is one shared, bounded constant the CLI does not restate", async () => {
  const cli = await readFile(new URL("../src/cli.mjs", import.meta.url), "utf8");
  assert.match(cli, /timeoutMs: options\.t3StartTimeoutMs \?\? DEFAULT_T3_START_TIMEOUT_MS,/u);
  assert.doesNotMatch(cli, /timeoutMs: options\.t3StartTimeoutMs \?\? \d/u);
  // Measured on a loaded Windows host: a healthy cached T3 bound at 15s, 18s, 31s and 93s.
  assert.ok(DEFAULT_T3_START_TIMEOUT_MS > 93_000, "must clear the slowest observed healthy bind");
  assert.ok(Number.isFinite(DEFAULT_T3_START_TIMEOUT_MS) && DEFAULT_T3_START_TIMEOUT_MS <= 300_000,
    "stays bounded and within the --t3-start-timeout-ms ceiling");
});
