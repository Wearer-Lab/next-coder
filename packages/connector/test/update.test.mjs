import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { beginServiceRuntimeUpdate, installService, servicePaths } from "../src/service.mjs";
import { applyConnectorUpdate, checkConnectorUpdate } from "../src/update.mjs";

test("update check uses an exact npm registry query", async () => {
  let call;
  const result = await checkConnectorUpdate({
    findExecutable: async () => "/usr/local/bin/npm",
    run: async (file, args) => { call = { file, args }; return { stdout: '"0.2.0"\n', stderr: "", code: 0 }; },
  });
  assert.deepEqual(call, { file: "/usr/local/bin/npm", args: ["view", "@next-coder/connector", "version", "--json"] });
  assert.equal(result.updateAvailable, true);
  assert.equal(result.direction, "upgrade");
});

test("an explicit connector rollback resolves exactly the requested published version", async () => {
  let call;
  const result = await checkConnectorUpdate({
    targetVersion: "0.0.9",
    findExecutable: async () => "/usr/local/bin/npm",
    run: async (file, args) => { call = { file, args }; return { stdout: '"0.0.9"\n', stderr: "", code: 0 }; },
  });
  assert.deepEqual(call, { file: "/usr/local/bin/npm",
    args: ["view", "@next-coder/connector@0.0.9", "version", "--json"] });
  assert.equal(result.updateAvailable, true);
  assert.equal(result.direction, "rollback");
  await assert.rejects(checkConnectorUpdate({ targetVersion: "latest", findExecutable: async () => "/npm" }),
    { code: "UPDATE_VERSION_INVALID" });
});

test("apply refuses to replace a running service unless restart is explicit", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-update-running-"));
  const options = await installedLinuxService(scratch, async (file, args) => ({ code: args.includes("is-active") ? 0 : 0, stdout: "", stderr: "" }));
  let npmCalls = 0;
  await assert.rejects(applyConnectorUpdate({ ...options, restartService: false, findExecutable: async () => "/npm", run: async () => { npmCalls += 1; } }), { code: "UPDATE_RESTART_REQUIRED" });
  assert.equal(npmCalls, 0);
});

test("apply verifies and replaces only the owned stopped-service runtime", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-update-apply-"));
  const commands = [];
  const options = await installedLinuxService(scratch, async (file, args) => {
    commands.push({ file, args });
    return { code: args.includes("is-active") ? 3 : 0, stdout: "", stderr: "" };
  });
  const result = await applyConnectorUpdate({
    ...options,
    restartService: false,
    findExecutable: async () => "/usr/local/bin/npm",
    run: async (file, args) => {
      if (args[0] === "view") return { code: 0, stdout: '"0.2.0"', stderr: "" };
      assert.deepEqual(args.slice(0, 2), ["install", "--prefix"]);
      const packageDir = join(args[2], "node_modules", "@next-coder", "connector");
      await fs.mkdir(join(packageDir, "bin"), { recursive: true });
      await fs.mkdir(join(packageDir, "src"), { recursive: true });
      await fs.writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "@next-coder/connector", version: "0.2.0", type: "module", bin: { "next-coder-connect": "./bin/next-coder-connect.mjs" }, engines: { node: ">=22" } }));
      await fs.writeFile(join(packageDir, "README.md"), "updated");
      await fs.writeFile(join(packageDir, "bin", "next-coder-connect.mjs"), "#!/usr/bin/env node\n");
      await fs.writeFile(join(packageDir, "src", "index.mjs"), "export {};\n");
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.applied, true);
  assert.equal(result.restarted, false);
  const paths = servicePaths(options.service);
  assert.equal((JSON.parse(await fs.readFile(paths.manifestPath, "utf8"))).packageVersion, "0.2.0");
  assert.equal(await fs.readFile(join(paths.runtimeRoot, "README.md"), "utf8"), "updated");
  assert.equal(commands.some(({ args }) => args.includes("restart")), false);
  await assert.rejects(fs.access(paths.updateJournalPath), { code: "ENOENT" });
});

test("package install failure leaves the prior stopped runtime untouched", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-update-install-fail-"));
  const control = serviceControl(false);
  const options = await installedLinuxService(scratch, control.run);
  const paths = servicePaths(options.service);
  const before = await fs.readFile(join(paths.runtimeRoot, "package.json"), "utf8");
  await assert.rejects(applyConnectorUpdate({
    ...options,
    findExecutable: async () => "/npm",
    run: async (_file, args) => {
      if (args[0] === "view") return { code: 0, stdout: '"0.2.0"', stderr: "" };
      throw Object.assign(new Error("install failed"), { code: "INSTALL_FAILED" });
    },
  }), { code: "INSTALL_FAILED" });
  assert.equal(await fs.readFile(join(paths.runtimeRoot, "package.json"), "utf8"), before);
  await assert.rejects(fs.access(paths.updateJournalPath), { code: "ENOENT" });
  assert.equal(control.active, false);
});

test("restart failure rolls back the prior runtime and restores running state", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-update-restart-fail-"));
  const control = serviceControl(true, { failRestartOnce: true });
  const options = await installedLinuxService(scratch, control.run);
  const paths = servicePaths(options.service);
  await assert.rejects(applyConnectorUpdate({
    ...options,
    restartService: true,
    findExecutable: async () => "/npm",
    run: packageRunner("0.2.0"),
  }), (error) => error.rolledBack === true && /restart failed/.test(error.message));
  assert.equal((JSON.parse(await fs.readFile(join(paths.runtimeRoot, "package.json"), "utf8"))).version, "0.1.0");
  assert.equal((JSON.parse(await fs.readFile(paths.manifestPath, "utf8"))).packageVersion, "0.1.0");
  assert.equal(control.active, true);
  assert.ok(control.calls.some(({ args }) => args.includes("stop")));
  assert.ok(control.calls.some(({ args }) => args.includes("start")));
});

test("health timeout rolls back after checking service, T3, and fresh cloud evidence", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-update-health-timeout-"));
  const control = serviceControl(true);
  const options = await installedLinuxService(scratch, control.run);
  const paths = servicePaths(options.service);
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  let t3Checks = 0;
  await assert.rejects(applyConnectorUpdate({
    ...options,
    restartService: true,
    healthTimeoutMs: 1_000,
    pollIntervalMs: 250,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    loadConnectorState: async () => ({ t3BaseUrl: "http://127.0.0.1:3773", lastConnectedAt: "2025-12-31T23:59:00.000Z", lastConnectionError: null }),
    checkT3: async () => { t3Checks += 1; return true; },
    findExecutable: async () => "/npm",
    run: packageRunner("0.2.0"),
  }), (error) => error.code === "UPDATE_HEALTH_TIMEOUT" && error.rolledBack === true);
  assert.ok(t3Checks > 0);
  assert.equal((JSON.parse(await fs.readFile(join(paths.runtimeRoot, "package.json"), "utf8"))).version, "0.1.0");
  assert.equal(control.active, true);
});

test("running update rejects healthy HTTP when owned T3 process identity is not verified", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-update-owned-t3-mismatch-"));
  const control = serviceControl(true);
  const options = await installedLinuxService(scratch, control.run);
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  let ownershipChecks = 0;
  await assert.rejects(applyConnectorUpdate({
    ...options,
    restartService: true,
    healthTimeoutMs: 1_000,
    pollIntervalMs: 250,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    loadConnectorState: async () => ({ t3BaseUrl: "http://127.0.0.1:3773", lastConnectedAt: "2026-01-01T00:00:00.001Z", lastConnectionError: null }),
    checkT3: async () => true,
    checkOwnedT3: async () => { ownershipChecks += 1; return { managed: true, running: true, verified: false, status: "identity_mismatch" }; },
    findExecutable: async () => "/npm",
    run: packageRunner("0.2.0"),
  }), (error) => error.code === "UPDATE_HEALTH_TIMEOUT" && error.rolledBack === true);
  assert.ok(ownershipChecks > 0);
  assert.equal(control.active, true);
});

test("successful running update commits only after fresh local and cloud health", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-update-health-ok-"));
  const control = serviceControl(true);
  const options = await installedLinuxService(scratch, control.run);
  let loads = 0;
  const result = await applyConnectorUpdate({
    ...options,
    restartService: true,
    healthTimeoutMs: 1_000,
    now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    sleep: async () => {},
    loadConnectorState: async () => {
      loads += 1;
      return { t3BaseUrl: "http://127.0.0.1:3773", lastConnectedAt: loads === 1 ? "2025-12-31T23:59:00.000Z" : "2026-01-01T00:00:00.001Z", lastConnectionError: null };
    },
    checkT3: async () => true,
    findExecutable: async () => "/npm",
    run: packageRunner("0.2.0"),
  });
  assert.equal(result.verified, "service+t3+cloud");
  assert.equal(control.active, true);
  const paths = servicePaths(options.service);
  assert.equal((JSON.parse(await fs.readFile(join(paths.runtimeRoot, "package.json"), "utf8"))).version, "0.2.0");
  await assert.rejects(fs.access(paths.updateJournalPath), { code: "ENOENT" });
});

test("Windows scheduled-task runtime participates in verified restart and transactional update", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-update-windows-"));
  const stateDir = join(scratch, "state with spaces");
  const env = { SystemRoot: "C:\\Windows", USERDOMAIN: "EXAMPLE", USERNAME: "alice" };
  const control = windowsUpdateControl();
  const service = { stateDir, platform: "win32", env, run: control.run };
  await installService(service);
  let loads = 0;
  const result = await applyConnectorUpdate({
    stateDir,
    service,
    restartService: true,
    healthTimeoutMs: 1_000,
    now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    sleep: async () => {},
    loadConnectorState: async () => {
      loads += 1;
      return { t3BaseUrl: "http://127.0.0.1:3773", lastConnectedAt: loads === 1 ? "2025-12-31T23:59:00.000Z" : "2026-01-01T00:00:00.001Z", lastConnectionError: null };
    },
    checkT3: async () => true,
    findExecutable: async () => "C:\\Program Files\\nodejs\\npm.cmd",
    run: packageRunner("0.2.0"),
  });
  assert.equal(result.verified, "service+t3+cloud");
  assert.equal(control.active, true);
  assert.ok(control.calls.some(({ args }) => args[0] === "/End"));
  assert.ok(control.calls.some(({ args }) => args[0] === "/Run"));
  assert.ok(control.calls.some(({ file, args }) => /powershell\.exe$/i.test(file) && args.includes("-EncodedCommand")));
  assert.equal((JSON.parse(await fs.readFile(join(servicePaths(service).runtimeRoot, "package.json"), "utf8"))).version, "0.2.0");
});

test("rollback failure is explicit and retains its recovery journal", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-update-rollback-fail-"));
  const control = serviceControl(true);
  const options = await installedLinuxService(scratch, control.run);
  const paths = servicePaths(options.service);
  const failingFs = new Proxy(fs, {
    get(target, property) {
      const value = target[property];
      if (property === "rename") return async (source, destination) => {
        if (String(source).includes(".previous-") && destination === paths.runtimeRoot) throw Object.assign(new Error("injected rollback rename failure"), { code: "EIO" });
        return await fs.rename(source, destination);
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let clock = 0;
  await assert.rejects(applyConnectorUpdate({
    ...options,
    fs: failingFs,
    restartService: true,
    healthTimeoutMs: 1_000,
    pollIntervalMs: 500,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    loadConnectorState: async () => ({ t3BaseUrl: "http://127.0.0.1:3773", lastConnectedAt: null }),
    checkT3: async () => true,
    findExecutable: async () => "/npm",
    run: packageRunner("0.2.0"),
  }), { code: "UPDATE_ROLLBACK_FAILED" });
  await fs.access(paths.updateJournalPath);
});

test("an interrupted swap is conservatively rolled back before another update", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "connector-update-interrupted-"));
  const control = serviceControl(true);
  const options = await installedLinuxService(scratch, control.run);
  const packageDir = join(scratch, "replacement");
  await writePackage(packageDir, "0.2.0");
  await beginServiceRuntimeUpdate({ ...options.service, packageDir, packageVersion: "0.2.0", wasActive: true });
  control.active = false;
  await assert.rejects(applyConnectorUpdate({ ...options, restartService: false, findExecutable: async () => "/npm", run: packageRunner("0.2.0") }), { code: "UPDATE_RESTART_REQUIRED" });
  const paths = servicePaths(options.service);
  assert.equal((JSON.parse(await fs.readFile(join(paths.runtimeRoot, "package.json"), "utf8"))).version, "0.1.0");
  assert.equal(control.active, true);
  await assert.rejects(fs.access(paths.updateJournalPath), { code: "ENOENT" });
});

async function installedLinuxService(scratch, run) {
  const stateDir = join(scratch, "state");
  const service = { stateDir, platform: "linux", home: scratch, env: { XDG_CONFIG_HOME: join(scratch, "config") }, run };
  await installService(service);
  return { stateDir, service };
}

function serviceControl(initialActive, { failRestartOnce = false } = {}) {
  const control = {
    active: initialActive,
    calls: [],
    failedRestart: false,
    async run(file, args) {
      control.calls.push({ file, args });
      if (args.includes("is-active")) return { code: control.active ? 0 : 3, stdout: "", stderr: "" };
      if (args.includes("enable") && args.includes("--now")) control.active = initialActive;
      if (args.includes("restart")) {
        if (failRestartOnce && !control.failedRestart) { control.failedRestart = true; throw new Error("restart failed"); }
        control.active = true;
      }
      if (args.includes("stop")) control.active = false;
      if (args.includes("start")) control.active = true;
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return control;
}

function windowsUpdateControl() {
  const control = {
    registered: null,
    active: false,
    calls: [],
    async run(file, args) {
      control.calls.push({ file, args });
      if (/powershell\.exe$/i.test(file)) {
        const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
        if (script.includes("Export-ScheduledTask")) return control.registered === null ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: control.registered, stderr: "" };
        return { code: control.active ? 0 : 3, stdout: "", stderr: "" };
      }
      if (/icacls\.exe$/i.test(file)) return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "/Create") {
        control.registered = await fs.readFile(args[args.indexOf("/XML") + 1], "utf8");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "/Run") control.active = true;
      if (args[0] === "/End") control.active = false;
      if (args[0] === "/Delete") { control.registered = null; control.active = false; }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return control;
}

function packageRunner(version) {
  return async (_file, args) => {
    if (args[0] === "view") return { code: 0, stdout: JSON.stringify(version), stderr: "" };
    await writePackage(join(args[2], "node_modules", "@next-coder", "connector"), version);
    return { code: 0, stdout: "", stderr: "" };
  };
}

async function writePackage(packageDir, version) {
  await fs.mkdir(join(packageDir, "bin"), { recursive: true });
  await fs.mkdir(join(packageDir, "src"), { recursive: true });
  await fs.writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "@next-coder/connector", version, type: "module", bin: { "next-coder-connect": "./bin/next-coder-connect.mjs" }, engines: { node: ">=22" } }));
  await fs.writeFile(join(packageDir, "README.md"), `connector ${version}`);
  await fs.writeFile(join(packageDir, "bin", "next-coder-connect.mjs"), "#!/usr/bin/env node\n");
  await fs.writeFile(join(packageDir, "src", "index.mjs"), "export {};\n");
}
