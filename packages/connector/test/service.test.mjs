import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as realFs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadState, saveState, STATE_VERSION } from "../src/config.mjs";
import { main as realMain } from "../src/cli.mjs";
import {
  installService,
  LEGACY_OWNERSHIP_MARKER,
  OWNERSHIP_MARKER,
  readServiceLogs,
  readServiceRuntimeIdentity,
  restartService,
  serviceActive,
  servicePaths,
  startService,
  stopService,
  uninstallService,
} from "../src/service.mjs";

test("launchd install owns an exact user definition and lifecycle never kills by name", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-launchd-"));
  const stateDir = join(scratch, "state");
  const fs = recordingFs();
  const calls = [];
  let loaded = false;
  const run = async (file, args, options = {}) => {
    calls.push({ file, args, options });
    if (args[0] === "print") return { code: loaded ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "bootout") loaded = false;
    return { code: 0, stdout: "", stderr: "" };
  };
  const options = { stateDir, platform: "darwin", home: scratch, uid: 501, fs, run };
  const installed = await installService(options);
  const definition = await realFs.readFile(installed.paths.definitionPath, "utf8");
  assert.match(definition, new RegExp(OWNERSHIP_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(definition, /gui\/501|ProgramArguments/);
  assert.match(definition, /SuccessfulExit/);
  assert.match(definition, /<key>Umask<\/key><integer>63<\/integer>/);
  assert.ok(calls.some(({ file, args }) => file === "/bin/launchctl" && args[0] === "bootstrap"));
  assert.equal(calls.some(({ file, args }) => file.includes("sudo") || args.some((arg) => /pkill|killall/.test(arg))), false);
  assert.ok(fs.operations.some((operation) => operation.name === "cp"));

  await startService(options);
  await restartService(options);
  await stopService(options);
  assert.ok(calls.some(({ args }) => args[0] === "kickstart" && args.includes("-k")));
  assert.ok(calls.some(({ args }) => args[0] === "bootout" && args.at(-1) === "gui/501/com.agent-controller.connector"));
});

test("systemd-user install is scoped, hardened, idempotent, and removable", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-systemd-"));
  const stateDir = join(scratch, "state with spaces");
  const fs = recordingFs();
  const calls = [];
  const run = async (file, args, options = {}) => { calls.push({ file, args, options }); return { code: 0, stdout: "", stderr: "" }; };
  const options = { stateDir, platform: "linux", home: scratch, env: { XDG_CONFIG_HOME: join(scratch, "config") }, fs, run };
  const installed = await installService(options);
  const definition = await realFs.readFile(installed.paths.definitionPath, "utf8");
  assert.match(definition, /Managed by @wearer-haitch\/connector/);
  assert.match(definition, /NoNewPrivileges=true/);
  assert.match(definition, /UMask=0077/);
  assert.match(definition, /ProtectSystem=strict/);
  assert.match(definition, /ExecStart=.*service-runtime.*connect.*--state-dir/);
  assert.ok(calls.some(({ file, args }) => file === "/usr/bin/systemctl" && args.join(" ") === "--user enable --now agent-controller-connector.service"));
  assert.equal(calls.some(({ args }) => args.includes("--system")), false);
  await installService(options);
  await uninstallService(options);
  await assert.rejects(realFs.readFile(installed.paths.definitionPath, "utf8"), { code: "ENOENT" });
  assert.ok(calls.some(({ args }) => args.join(" ") === "--user disable --now agent-controller-connector.service"));
});

test("legacy launchd/systemd manifests migrate only after exact definition and runtime verification", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-service-migrate-"));
  const stateDir = join(scratch, "state");
  const env = { XDG_CONFIG_HOME: join(scratch, "config") };
  const run = async () => ({ code: 0, stdout: "", stderr: "" });
  const paths = (await installService({ stateDir, platform: "linux", home: scratch, env, run })).paths;
  const manifest = JSON.parse(await realFs.readFile(paths.manifestPath, "utf8"));
  delete manifest.target;
  delete manifest.definitionSha256;
  await realFs.writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await startService({ stateDir, platform: "linux", home: scratch, env, run });
  const migrated = JSON.parse(await realFs.readFile(paths.manifestPath, "utf8"));
  assert.equal(migrated.target, paths.target);
  assert.match(migrated.definitionSha256, /^[a-f0-9]{64}$/);
  assert.ok(Date.parse(migrated.migratedAt));
});

test("a service definition carrying the legacy ownership marker is still ours to operate", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-service-legacy-marker-"));
  const stateDir = join(scratch, "state");
  const env = { XDG_CONFIG_HOME: join(scratch, "config") };
  const run = async () => ({ code: 0, stdout: "", stderr: "" });
  const paths = (await installService({ stateDir, platform: "linux", home: scratch, env, run })).paths;
  const definition = await realFs.readFile(paths.definitionPath, "utf8");
  const legacy = definition.replace(OWNERSHIP_MARKER, LEGACY_OWNERSHIP_MARKER);
  assert.equal(legacy.includes(LEGACY_OWNERSHIP_MARKER), true);
  await realFs.writeFile(paths.definitionPath, legacy, "utf8");
  const manifest = JSON.parse(await realFs.readFile(paths.manifestPath, "utf8"));
  manifest.definitionSha256 = createHash("sha256").update(legacy).digest("hex");
  await realFs.writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await startService({ stateDir, platform: "linux", home: scratch, env, run });
});

test("previous Next Coder scope remains an owned local service and rollback runtime", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-previous-scope-"));
  t.after(() => realFs.rm(scratch, { recursive: true, force: true }));
  const stateDir = join(scratch, "state");
  const env = { XDG_CONFIG_HOME: join(scratch, "config") };
  const run = async () => ({ code: 0, stdout: "", stderr: "" });
  const paths = (await installService({ stateDir, platform: "linux", home: scratch, env, run })).paths;
  const definition = (await realFs.readFile(paths.definitionPath, "utf8"))
    .replace(OWNERSHIP_MARKER, "Managed by @next-coder/connector. Do not edit.");
  await realFs.writeFile(paths.definitionPath, definition, "utf8");
  const manifest = JSON.parse(await realFs.readFile(paths.manifestPath, "utf8"));
  manifest.definitionSha256 = createHash("sha256").update(definition).digest("hex");
  await realFs.writeFile(paths.manifestPath, JSON.stringify(manifest));
  await startService({ stateDir, platform: "linux", home: scratch, env, run });
  const packagePath = join(paths.runtimeRoot, "package.json");
  const previous = JSON.parse(await realFs.readFile(packagePath, "utf8"));
  previous.name = "@next-coder/connector";
  await realFs.writeFile(packagePath, JSON.stringify(previous));
  assert.equal((await readServiceRuntimeIdentity({ runtimeRoot: paths.runtimeRoot })).name, "@next-coder/connector");
  previous.name = "@foreign/connector";
  await realFs.writeFile(packagePath, JSON.stringify(previous));
  await assert.rejects(readServiceRuntimeIdentity({ runtimeRoot: paths.runtimeRoot }), { code: "UPDATE_PACKAGE_INVALID" });
});

test("foreign service definition is never overwritten", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-foreign-"));
  const stateDir = join(scratch, "state");
  const paths = servicePaths({ stateDir, platform: "linux", home: scratch, env: { XDG_CONFIG_HOME: join(scratch, "config") } });
  await realFs.mkdir(join(scratch, "config", "systemd", "user"), { recursive: true });
  await realFs.writeFile(paths.definitionPath, "[Service]\nExecStart=/bin/false\n", "utf8");
  let commands = 0;
  await assert.rejects(installService({ stateDir, platform: "linux", home: scratch, env: { XDG_CONFIG_HOME: join(scratch, "config") }, fs: recordingFs(), run: async () => { commands += 1; } }), { code: "SERVICE_NOT_OWNED" });
  assert.equal(commands, 0);
  assert.equal(await realFs.readFile(paths.definitionPath, "utf8"), "[Service]\nExecStart=/bin/false\n");
});

test("Windows Task Scheduler install is per-user, injection-resistant, and lifecycle-scoped", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-windows-task-"));
  const stateDir = join(scratch, 'state & <private> "quoted"');
  const env = { SystemRoot: "C:\\Windows", USERDOMAIN: "EXAMPLE", USERNAME: "alice" };
  const control = windowsTaskControl();
  const options = { stateDir, platform: "win32", home: scratch, env, run: control.run };
  const installed = await installService(options);
  const definition = await realFs.readFile(installed.paths.definitionPath, "utf8");

  assert.match(installed.paths.target, /^AgentControllerConnector-[a-f0-9]{12}$/);
  assert.match(definition, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(definition, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(definition, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(definition, /state &amp; &lt;private&gt; &quot;quoted&quot;/);
  assert.equal(control.calls.some(({ file }) => /cmd(?:\.exe)?$/i.test(file)), false);
  assert.equal(control.calls.some(({ args }) => args.includes("SYSTEM") || args.includes("/RU")), false);
  assert.ok(control.calls.some(({ args }) => args[0] === "/Create" && args.includes(installed.paths.definitionPath) && !args.includes("/F")));
  assert.ok(control.calls.some(({ args }) => args[0] === "/Run" && args.at(-1) === installed.paths.target));
  assert.ok(control.calls.some(({ file, args }) => /icacls\.exe$/i.test(file) && args.includes("/inheritance:r") && args.includes("EXAMPLE\\alice:(OI)(CI)F")));
  assert.equal(await serviceActive(options), true);

  await installService(options);
  assert.ok(control.calls.some(({ args }) => args[0] === "/Create" && args.includes("/F")));
  assert.ok(control.calls.some(({ args }) => args[0] === "/End" && args.at(-1) === installed.paths.target));

  await stopService(options);
  assert.equal(await serviceActive(options), false);
  await startService(options);
  await restartService(options);
  assert.equal(await serviceActive(options), true);
  await uninstallService(options);
  assert.equal(control.registered, null);
  assert.equal(control.calls.some(({ args }) => args.includes("*")), false);
  await assert.rejects(realFs.readFile(installed.paths.definitionPath, "utf8"), { code: "ENOENT" });
});

test("Windows lifecycle refuses a foreign registered task at the deterministic name", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-windows-foreign-"));
  const stateDir = join(scratch, "state");
  const env = { SystemRoot: "C:\\Windows", USERDOMAIN: "EXAMPLE", USERNAME: "alice" };
  const control = windowsTaskControl({ registered: "<Task><Actions><Exec><Command>malware.exe</Command></Exec></Actions></Task>" });
  await assert.rejects(installService({ stateDir, platform: "win32", env, run: control.run }), { code: "SERVICE_NOT_OWNED" });
  assert.equal(control.calls.some(({ args }) => args[0] === "/Create"), false);
  assert.match(control.registered, /malware\.exe/);
});

test("Windows CLI integrates status, lifecycle, bounded logs, and disconnect with the owned task", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-windows-cli-"));
  const stateDir = join(scratch, "state with spaces");
  const env = { SystemRoot: "C:\\Windows", USERDOMAIN: "EXAMPLE", USERNAME: "alice" };
  const control = windowsTaskControl();
  const options = { stateDir, platform: "win32", env, run: control.run };
  const paths = (await installService(options)).paths;
  await saveState(stateDir, { version: STATE_VERSION, server: "https://cloud.example", connectorId: "con", environmentId: "env", secret: "standing-secret", t3BaseUrl: "http://127.0.0.1:3773", t3AccessToken: "t3-secret" });
  await realFs.writeFile(paths.logPath, "old line\nsecond line\nstanding-secret Bearer t3-secret\n", "utf8");
  const output = capture();
  const dependencies = {
    stdout: output,
    stderr: output,
    platform: "win32",
    env,
    runServiceCommand: control.run,
    exec: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    fetchImpl: async (url) => {
      const value = String(url);
      if (value === "https://cloud.example/health") return new Response("ok");
      if (value.endsWith("/.well-known/t3/environment")) return new Response(JSON.stringify({ version: "0.0.32" }));
      if (value.endsWith("/api/orchestration/snapshot")) return new Response(JSON.stringify({ projects: [], threads: [] }));
      throw new Error(`Unexpected URL ${value}`);
    },
  };

  assert.equal(await main(["status", "--json", "--state-dir", stateDir], dependencies), 0);
  const status = JSON.parse(output.value());
  assert.deepEqual(status.managedService, { installed: true, active: true });
  assert.deepEqual(status.ownedT3, { managed: false, running: false, verified: false, status: "user_managed" });
  output.clear();
  assert.equal(await main(["stop", "--state-dir", stateDir], dependencies), 0);
  assert.equal(await main(["start", "--state-dir", stateDir], dependencies), 0);
  assert.equal(await main(["restart", "--state-dir", stateDir], dependencies), 0);
  assert.equal(await main(["logs", "--lines", "2", "--state-dir", stateDir], dependencies), 0);
  assert.equal(output.value().includes("old line"), false);
  assert.equal(output.value().includes("standing-secret"), false);
  assert.equal(output.value().includes("t3-secret"), false);
  assert.match(output.value(), /REDACTED/);
  assert.equal(await main(["disconnect", "--force-local", "--yes", "--state-dir", stateDir], dependencies), 0);
  assert.equal(await loadState(stateDir), null);
  assert.equal(control.registered, null);
});

test("logs are line-bounded and redact standing and T3 credentials", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-logs-"));
  const stateDir = join(scratch, "state");
  const options = { stateDir, platform: "linux", home: scratch, env: { XDG_CONFIG_HOME: join(scratch, "config") }, run: async (file, args) => ({ code: 0, stdout: file === "/usr/bin/tail" ? "standing-secret Bearer t3-secret\n" : "", stderr: "" }) };
  const paths = (await installService(options)).paths;
  const calls = [];
  const result = await readServiceLogs({ ...options, lines: 25, secrets: ["standing-secret", "t3-secret"], run: async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: "standing-secret Bearer t3-secret\n", stderr: "" };
  } });
  assert.equal(result.output.includes("standing-secret"), false);
  assert.equal(result.output.includes("t3-secret"), false);
  assert.match(result.output, /REDACTED/);
  assert.deepEqual(calls[0], { file: "/usr/bin/tail", args: ["-n", "25", paths.logPath] });
});

test("disconnect confirmation is the only CLI path that removes service and state", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-disconnect-"));
  const stateDir = join(scratch, "state");
  const env = { XDG_CONFIG_HOME: join(scratch, "config") };
  const run = async () => ({ code: 0, stdout: "", stderr: "" });
  await saveState(stateDir, { version: STATE_VERSION, server: "https://cloud.example", connectorId: "con", environmentId: "env", secret: "standing", t3BaseUrl: "http://127.0.0.1:3773" });
  await installService({ stateDir, platform: "linux", home: scratch, env, run });
  const output = capture();
  assert.equal(await main(["disconnect", "--force-local", "--yes", "--state-dir", stateDir], { stdout: output, stderr: output, platform: "linux", home: scratch, env, runServiceCommand: run }), 0);
  assert.equal(await loadState(stateDir), null);
  const paths = servicePaths({ stateDir, platform: "linux", home: scratch, env });
  await assert.rejects(realFs.readFile(paths.definitionPath, "utf8"), { code: "ENOENT" });
});

test("CLI lifecycle commands address only the installed user unit", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-cli-service-"));
  const stateDir = join(scratch, "state");
  const env = { XDG_CONFIG_HOME: join(scratch, "config") };
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: file === "/usr/bin/tail" ? "safe log\n" : "", stderr: "" };
  };
  await installService({ stateDir, platform: "linux", home: scratch, env, run });
  const output = capture();
  const dependencies = { stdout: output, stderr: output, platform: "linux", home: scratch, env, runServiceCommand: run };
  assert.equal(await main(["start", "--state-dir", stateDir], dependencies), 0);
  assert.equal(await main(["stop", "--state-dir", stateDir], dependencies), 0);
  assert.equal(await main(["restart", "--state-dir", stateDir], dependencies), 0);
  assert.equal(await main(["logs", "--lines", "12", "--state-dir", stateDir], dependencies), 0);
  assert.match(output.value(), /safe log/);
  assert.equal(calls.some(({ file }) => !["/usr/bin/systemctl", "/usr/bin/tail"].includes(file)), false);
  assert.equal(calls.some(({ args }) => args.includes("--system")), false);
});

test("connect --install-service enrolls then starts a service instead of a foreground client", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-cli-install-"));
  const stateDir = join(scratch, "state");
  const env = { XDG_CONFIG_HOME: join(scratch, "config"), AGENT_CONTROLLER_T3_TOKEN: "local-token" };
  const calls = [];
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/.well-known/t3/environment")) return new Response(JSON.stringify({ version: "0.0.32" }));
    if (String(url).endsWith("/v1/connectors/enroll")) return new Response(JSON.stringify({ connector: { id: "con" }, environment: { id: "env" }, secret: "standing" }), { status: 201 });
    throw new Error(`Unexpected URL ${url}`);
  };
  class MustNotRun { constructor() { throw new Error("foreground connector must not be constructed"); } }
  const output = capture();
  const result = await main(["connect", "--server", "http://127.0.0.1:8787", "--code", "code", "--t3-url", "http://127.0.0.1:3773", "--install-service", "--state-dir", stateDir], {
    stdout: output, stderr: output, platform: "linux", home: scratch, env, fetchImpl, WebSocketImpl: class {}, Connector: MustNotRun,
    runServiceCommand: async (file, args) => { calls.push({ file, args }); return { code: 0, stdout: "", stderr: "" }; },
  });
  assert.equal(result, 0);
  assert.match(output.value(), /installed and started/);
  assert.ok(calls.some(({ args }) => args.join(" ") === "--user enable --now agent-controller-connector.service"));
});

test("rotate stages, activates, and atomically hands off a managed connector credential", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-rotate-"));
  const stateDir = join(scratch, "state");
  const env = { XDG_CONFIG_HOME: join(scratch, "config") };
  const calls = [];
  const credentialStore = memoryCredentialStore();
  const run = async (file, args) => {
    calls.push({ file, args });
    return { code: args.includes("is-active") ? 0 : 0, stdout: "", stderr: "" };
  };
  await saveState(stateDir, { version: STATE_VERSION, server: "https://cloud.example", connectorId: "old-con", environmentId: "env", secret: "old-secret", t3BaseUrl: "http://127.0.0.1:3773" }, { credentialStore });
  await installService({ stateDir, platform: "linux", home: scratch, env, run });
  const output = capture();
  const result = await main(["rotate", "--code", "one-time-code", "--yes", "--state-dir", stateDir], {
    stdout: output,
    stderr: output,
    platform: "linux",
    home: scratch,
    env,
    credentialStore,
    runServiceCommand: run,
    beginCredentialRotation: async (state, { code }) => {
      assert.equal(state.secret, "old-secret");
      assert.equal(code, "one-time-code");
      return { connectorId: "old-con", environmentId: "env", rotationId: "rot-1", expiresAt: new Date(Date.now() + 60_000).toISOString(), secret: "new-secret" };
    },
    activateCredentialRotation: async (state) => {
      assert.equal(state.connectorId, "old-con");
      assert.equal(state.secret, "new-secret");
      assert.equal(state.credentialRotation.phase, "activated");
      return { async waitForHandoff() {}, stop() {} };
    },
  });
  assert.equal(result, 0);
  const state = await loadState(stateDir, { credentialStore });
  assert.equal(state.connectorId, "old-con");
  assert.equal(state.secret, "new-secret");
  assert.equal(JSON.stringify(state).includes("old-secret"), false);
  assert.equal((await realFs.readFile(join(stateDir, "connector.json"), "utf8")).includes("new-secret"), false);
  assert.equal(state.credentialRotation, undefined);
  assert.ok(calls.some(({ args }) => args.join(" ") === "--user restart agent-controller-connector.service"));
  assert.match(output.value(), /atomically/);
});

test("an interrupted rotation keeps the old primary credential and resumes from the private journal", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-rotate-resume-"));
  const stateDir = join(scratch, "state");
  const env = { XDG_CONFIG_HOME: join(scratch, "config") };
  const run = async (_file, args) => ({ code: args.includes("is-active") ? 0 : 0, stdout: "", stderr: "" });
  await saveState(stateDir, { version: STATE_VERSION, server: "https://cloud.example", connectorId: "con", environmentId: "env", secret: "old-secret", t3BaseUrl: "http://127.0.0.1:3773" });
  await installService({ stateDir, platform: "linux", home: scratch, env, run });
  const output = capture();
  const rotation = { connectorId: "con", environmentId: "env", rotationId: "rot-resume", expiresAt: new Date(Date.now() + 60_000).toISOString(), secret: "new-secret" };

  assert.equal(await main(["rotate", "--code", "code", "--yes", "--state-dir", stateDir], {
    stdout: output, stderr: output, platform: "linux", home: scratch, env, runServiceCommand: run,
    beginCredentialRotation: async () => rotation,
    activateCredentialRotation: async () => { throw Object.assign(new Error("interrupted"), { code: "TEST_INTERRUPTION" }); },
  }), 1);
  const staged = await loadState(stateDir);
  assert.equal(staged.secret, "old-secret");
  assert.equal(staged.credentialRotation.pendingSecret, "new-secret");
  assert.equal(staged.credentialRotation.phase, "staged");

  let beganAgain = false;
  assert.equal(await main(["rotate", "--yes", "--state-dir", stateDir], {
    stdout: output, stderr: output, platform: "linux", home: scratch, env, runServiceCommand: run,
    beginCredentialRotation: async () => { beganAgain = true; throw new Error("must not begin again"); },
    activateCredentialRotation: async (state) => {
      assert.equal(state.secret, "new-secret");
      return { async waitForHandoff() {}, stop() {} };
    },
  }), 0);
  const resumed = await loadState(stateDir);
  assert.equal(beganAgain, false);
  assert.equal(resumed.secret, "new-secret");
  assert.equal(resumed.credentialRotation, undefined);
  assert.equal(JSON.stringify(resumed).includes("old-secret"), false);
});

test("launchd writes only the T3 launch options the operator set, one argument each, and replaces on reinstall", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-launchd-t3-"));
  t.after(() => realFs.rm(scratch, { recursive: true, force: true }));
  const stateDir = join(scratch, "state");
  const run = async (_file, args) => ({ code: args[0] === "print" ? 1 : 0, stdout: "", stderr: "" });
  const base = { stateDir, platform: "darwin", home: scratch, uid: 501, fs: recordingFs(), run, env: {} };

  const explicit = await installService({ ...base, t3Launch: { version: "0.1.4", port: 4100, startTimeoutMs: 90_000 } });
  const first = await realFs.readFile(explicit.paths.definitionPath, "utf8");
  assert.match(first, /<string>--t3-version<\/string>\n      <string>0\.1\.4<\/string>\n      <string>--t3-port<\/string>\n      <string>4100<\/string>\n      <string>--t3-start-timeout-ms<\/string>\n      <string>90000<\/string>\n    <\/array>/);

  const replaced = await installService({ ...base, t3Launch: { version: "0.1.6" } });
  const second = await realFs.readFile(replaced.paths.definitionPath, "utf8");
  assert.equal(second.split("--t3-version").length - 1, 1);
  assert.match(second, /<string>--t3-version<\/string>\n      <string>0\.1\.6<\/string>\n    <\/array>/);
  assert.equal(second.includes("0.1.4") || second.includes("--t3-port"), false);

  await installService({ ...base, t3Launch: {} });
  assert.equal((await realFs.readFile(explicit.paths.definitionPath, "utf8")).includes("--t3-"), false);
});

test("systemd ExecStart quotes explicit T3 options, freezes no default, and restarts on replacement", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-systemd-t3-"));
  t.after(() => realFs.rm(scratch, { recursive: true, force: true }));
  const stateDir = join(scratch, "state with spaces");
  const calls = [];
  const run = async (file, args) => { calls.push({ file, args }); return { code: 0, stdout: "", stderr: "" }; };
  const base = { stateDir, platform: "linux", home: scratch, env: { XDG_CONFIG_HOME: join(scratch, "config") }, run };

  const explicit = await installService({ ...base, t3Launch: { version: "0.1.4", port: 4100, startTimeoutMs: 90_000 } });
  const first = await realFs.readFile(explicit.paths.definitionPath, "utf8");
  assert.match(first, /^ExecStart=.*"--service-log" "[^"]*" "--t3-version" "0\.1\.4" "--t3-port" "4100" "--t3-start-timeout-ms" "90000"$/m);
  assert.equal(calls.some(({ args }) => args.join(" ") === "--user restart agent-controller-connector.service"), false);

  const replaced = await installService({ ...base, t3Launch: { version: "0.1.6" } });
  const second = await realFs.readFile(replaced.paths.definitionPath, "utf8");
  assert.match(second, /^ExecStart=.*"--t3-version" "0\.1\.6"$/m);
  assert.equal(second.includes("0.1.4") || second.includes("--t3-port"), false);
  assert.equal(calls.filter(({ args }) => args.join(" ") === "--user restart agent-controller-connector.service").length, 1);

  await installService({ ...base, t3Launch: {} });
  assert.equal((await realFs.readFile(explicit.paths.definitionPath, "utf8")).includes("--t3-"), false);
});

test("Windows task arguments quote explicit T3 options, freezes no default, and replaces on reinstall", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-windows-t3-"));
  t.after(() => realFs.rm(scratch, { recursive: true, force: true }));
  const stateDir = join(scratch, 'state & "quoted"');
  const env = { SystemRoot: "C:\\Windows", USERDOMAIN: "EXAMPLE", USERNAME: "alice" };
  const control = windowsTaskControl();
  const base = { stateDir, platform: "win32", home: scratch, env, run: control.run };

  const explicit = await installService({ ...base, t3Launch: { version: "0.1.4", port: 4100, startTimeoutMs: 90_000 } });
  const first = await realFs.readFile(explicit.paths.definitionPath, "utf8");
  assert.match(first, /<Arguments>[^<]*&quot;--t3-version&quot; &quot;0\.1\.4&quot; &quot;--t3-port&quot; &quot;4100&quot; &quot;--t3-start-timeout-ms&quot; &quot;90000&quot;<\/Arguments>/);

  const replaced = await installService({ ...base, t3Launch: { version: "0.1.6" } });
  const second = await realFs.readFile(replaced.paths.definitionPath, "utf8");
  assert.match(second, /<Arguments>[^<]*&quot;--t3-version&quot; &quot;0\.1\.6&quot;<\/Arguments>/);
  assert.equal(second.includes("0.1.4") || second.includes("--t3-port"), false);
  assert.ok(control.calls.some(({ args }) => args[0] === "/Create" && args.includes("/F")));

  await installService({ ...base, t3Launch: {} });
  assert.equal((await realFs.readFile(explicit.paths.definitionPath, "utf8")).includes("--t3-"), false);
});

test("NEXT_CODER_T3_VERSION is captured at install as an explicit choice, and the flag overrides it", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-systemd-t3-env-"));
  t.after(() => realFs.rm(scratch, { recursive: true, force: true }));
  const stateDir = join(scratch, "state");
  const run = async () => ({ code: 0, stdout: "", stderr: "" });
  const env = { XDG_CONFIG_HOME: join(scratch, "config"), NEXT_CODER_T3_VERSION: "0.1.4" };
  const base = { stateDir, platform: "linux", home: scratch, env, run };

  const fromEnv = await installService({ ...base, t3Launch: {} });
  assert.match(await realFs.readFile(fromEnv.paths.definitionPath, "utf8"), /^ExecStart=.*"--t3-version" "0\.1\.4"$/m);

  const fromFlag = await installService({ ...base, t3Launch: { version: "0.1.6" } });
  const definition = await realFs.readFile(fromFlag.paths.definitionPath, "utf8");
  assert.match(definition, /^ExecStart=.*"--t3-version" "0\.1\.6"$/m);
  assert.equal(definition.includes("0.1.4"), false);
});

test("an invalid T3 launch option is refused before an installed service is touched", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-systemd-t3-invalid-"));
  t.after(() => realFs.rm(scratch, { recursive: true, force: true }));
  const stateDir = join(scratch, "state");
  const env = { XDG_CONFIG_HOME: join(scratch, "config") };
  const run = async () => ({ code: 0, stdout: "", stderr: "" });
  const { paths } = await installService({ stateDir, platform: "linux", home: scratch, env, run });
  const before = await realFs.readFile(paths.definitionPath, "utf8");
  let commands = 0;
  const countingRun = async () => { commands += 1; return { code: 0, stdout: "", stderr: "" }; };
  await assert.rejects(installService({ stateDir, platform: "linux", home: scratch, env, run: countingRun, t3Launch: { version: "latest" } }), { code: "T3_VERSION_INVALID" });
  await assert.rejects(installService({ stateDir, platform: "linux", home: scratch, env, run: countingRun, t3Launch: { port: 70_000 } }), { code: "T3_OPTION_INVALID" });
  assert.equal(commands, 0);
  assert.equal(await realFs.readFile(paths.definitionPath, "utf8"), before);
});

function recordingFs() {
  const operations = [];
  return new Proxy({ operations }, {
    get(target, property) {
      if (property === "operations") return operations;
      const value = realFs[property];
      if (typeof value !== "function") return value;
      return async (...args) => { operations.push({ name: property, args }); return await value(...args); };
    },
  });
}

function windowsTaskControl({ registered = null, active = false } = {}) {
  const control = {
    registered,
    active,
    calls: [],
    async run(file, args, options = {}) {
      control.calls.push({ file, args, options });
      if (/powershell\.exe$/i.test(file)) {
        const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
        if (script.includes("Export-ScheduledTask")) return control.registered === null ? { code: 1, stdout: "", stderr: "not found" } : { code: 0, stdout: control.registered, stderr: "" };
        return { code: control.active ? 0 : 3, stdout: "", stderr: "" };
      }
      if (/icacls\.exe$/i.test(file)) return { code: 0, stdout: "", stderr: "" };
      if (!/schtasks\.exe$/i.test(file)) throw new Error(`Unexpected Windows service command: ${file}`);
      if (args[0] === "/Create") {
        if (control.registered !== null && !args.includes("/F")) throw new Error("task already exists");
        control.registered = await realFs.readFile(args[args.indexOf("/XML") + 1], "utf8");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "/Run") { control.active = true; return { code: 0, stdout: "", stderr: "" }; }
      if (args[0] === "/End") { control.active = false; return { code: 0, stdout: "", stderr: "" }; }
      if (args[0] === "/Delete") { control.registered = null; control.active = false; return { code: 0, stdout: "", stderr: "" }; }
      throw new Error(`Unexpected schtasks arguments: ${args.join(" ")}`);
    },
  };
  return control;
}

function capture() { let value = ""; return { write(chunk) { value += chunk; }, value() { return value; }, clear() { value = ""; } }; }

function memoryCredentialStore() {
  const values = new Map();
  return {
    backend: "test-native-store", native: true, fallbackReason: null,
    async write(account, secret) { values.set(account, secret); },
    async read(account) { return values.get(account) ?? null; },
    async delete(account) { values.delete(account); },
  };
}

function main(args, dependencies = {}) { return realMain(args, { inspectVoiceRuntime: async () => ({ ready: true }), prepareVoiceRuntime: async () => ({ url: "http://127.0.0.1:8977/v1/transcribe", close: async () => {}, ensureReady: async () => {} }), ...dependencies }); }
