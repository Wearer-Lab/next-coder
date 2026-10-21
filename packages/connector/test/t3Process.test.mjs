import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createLocalT3PairingToken,
  ensureLocalT3,
  findExecutableOnPath,
  inspectOwnedT3,
  inspectProcessCommand,
  killProcessGroup,
  loadT3ProcessMetadata,
  parseWindowsCommandLine,
  resolveNpxLauncher,
  stopOwnedT3,
  t3ProcessPaths,
} from "../src/t3Process.mjs";

test("existing loopback T3 is reused and never spawned or owned", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-reuse-"));
  let spawned = 0;
  const runtime = await ensureLocalT3({
    stateDir,
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
  });
  assert.equal(runtime.started, true);
  assert.equal(runtime.owned, true);
  assert.equal(spawned[0].command, "/usr/local/bin/npx");
  assert.deepEqual(spawned[0].args.slice(0, 5), ["--yes", "t3", "serve", "--port", "3773"]);
  assert.ok(spawned[0].args.includes("127.0.0.1"));
  assert.equal(spawned[0].args.some((arg) => arg === "0.0.0.0" || arg.startsWith("/Users/example/project")), false);
  assert.equal(spawned[0].options.detached, true);
  const metadata = await loadT3ProcessMetadata(stateDir);
  assert.equal(metadata.pid, 4321);
  if (process.platform !== "win32") assert.equal((await stat(join(stateDir, "t3-process.json"))).mode & 0o777, 0o600);
  assert.equal((await runtime.stop()).stopped, true);
  assert.deepEqual(killed, [{ pgid: 4321, signal: "SIGTERM" }]);
});

test("auto-start opt-out fails without spawning", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-optout-"));
  let spawned = false;
  await assert.rejects(ensureLocalT3({ stateDir, autoStart: false, fetchImpl: async () => { throw new TypeError("offline"); }, spawnImpl: () => { spawned = true; } }), { code: "T3_NOT_RUNNING" });
  assert.equal(spawned, false);
});

test("persisted PID mismatch is never killed", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-t3-mismatch-"));
  let fetches = 0;
  await ensureLocalT3({
    stateDir,
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
    run: async (file, args) => { call = { file, args }; return { code: 0, stdout: JSON.stringify({ credential: "pairing-secret" }), stderr: "" }; },
  });
  assert.equal(token, "pairing-secret");
  assert.equal(call.file, "/usr/local/bin/npx");
  assert.deepEqual(call.args.slice(0, 6), ["--yes", "t3", "auth", "pairing", "create", "--base-dir"]);
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
    managed: true, running: true, verified: true, status: "owned_running", pid: 6789,
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

function windowsQuote(value) {
  if (value && !/[\s"]/.test(value)) return value;
  return `"${String(value).replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}
