import * as nodeFs from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir, platform as currentPlatform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CONNECTOR_VERSION } from "./cloud.mjs";
import { redact } from "./redact.mjs";

// The service identifiers are the installed registration names on each platform. They are not
// renamed with the product: a launchd label, a systemd user unit, and a scheduled task name are
// what an existing installation is registered under, and changing one would orphan that
// installation instead of renaming it.
export const SERVICE_ID = "com.agent-controller.connector";
export const SYSTEMD_UNIT = "agent-controller-connector.service";
export const WINDOWS_TASK_PREFIX = "AgentControllerConnector-";
// A service definition written before the rename carries the legacy marker. It is still ours, so
// it is still ours to update; only a definition carrying neither marker is refused.
export const OWNERSHIP_MARKER = "Managed by @next-coder/connector. Do not edit.";
export const LEGACY_OWNERSHIP_MARKER = "Managed by @agent-controller/connector. Do not edit.";

// The runtime entry point. A managed service installed before the rename execs the legacy path, so
// the installed runtime keeps a thin alias at that path until the service is reinstalled.
const RUNTIME_BIN = "next-coder-connect.mjs";
const LEGACY_RUNTIME_BIN = "agent-controller-connect.mjs";
const RUNTIME_BIN_ALIAS = `import "./${RUNTIME_BIN}";\n`;
const CONNECTOR_PACKAGE_NAME = "@next-coder/connector";
const LEGACY_CONNECTOR_PACKAGE_NAME = "@agent-controller/connector";
const CONNECTOR_BIN_ENTRY = "next-coder-connect";
const LEGACY_CONNECTOR_BIN_ENTRY = "agent-controller-connect";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

export function servicePaths({ platform = currentPlatform(), stateDir, env = process.env, home = homedir(), uid = process.getuid?.() ?? 0 } = {}) {
  const resolvedStateDir = resolve(stateDir);
  const runtimeRoot = join(resolvedStateDir, "service-runtime");
  const logDir = join(resolvedStateDir, "logs");
  const common = {
    platform,
    stateDir: resolvedStateDir,
    runtimeRoot,
    runtimeBin: join(runtimeRoot, "bin", RUNTIME_BIN),
    manifestPath: join(resolvedStateDir, "service.json"),
    updateJournalPath: join(resolvedStateDir, "service-update.json"),
    logDir,
    logPath: join(logDir, "connector.log"),
  };
  if (platform === "darwin") {
    return { ...common, definitionPath: join(home, "Library", "LaunchAgents", `${SERVICE_ID}.plist`), target: `gui/${uid}/${SERVICE_ID}` };
  }
  if (platform === "linux") {
    const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
    return { ...common, definitionPath: join(configHome, "systemd", "user", SYSTEMD_UNIT), target: SYSTEMD_UNIT };
  }
  if (platform === "win32") {
    const suffix = createHash("sha256").update(resolvedStateDir.toLowerCase()).digest("hex").slice(0, 12);
    return {
      ...common,
      definitionPath: join(resolvedStateDir, "service-task.xml"),
      target: `${WINDOWS_TASK_PREFIX}${suffix}`,
      schedulerPath: windowsSystemTool(env, "schtasks.exe"),
      powershellPath: windowsSystemTool(env, "WindowsPowerShell", "v1.0", "powershell.exe"),
      icaclsPath: windowsSystemTool(env, "icacls.exe"),
      userId: windowsUserId(env),
    };
  }
  throw unsupportedPlatform(platform);
}

export async function installService({ stateDir, platform, env, home, uid, fs = nodeFs, run = runCommand, packageDir = packageRoot } = {}) {
  const paths = servicePaths({ stateDir, platform, env, home, uid });
  const previousDefinition = await readOptionalFile(paths.definitionPath, fs);
  if (previousDefinition !== null) await assertExistingLocalService(paths, fs);
  const replaceWindowsTask = paths.platform === "win32" ? await assertWindowsRegistrationBeforeInstall(paths, run, previousDefinition) : false;
  if (replaceWindowsTask) await run(paths.schedulerPath, ["/End", "/TN", paths.target], { allowFailure: true });
  await fs.rm(paths.runtimeRoot, { recursive: true, force: true });
  await fs.mkdir(paths.runtimeRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.logDir, { recursive: true, mode: 0o700 });
  await copyRuntime(packageDir, paths.runtimeRoot, fs);
  await fs.chmod(paths.runtimeBin, 0o755);
  const definition = renderServiceDefinition(paths, { stateDir });
  await fs.mkdir(dirname(paths.definitionPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(paths.definitionPath, definition, { encoding: "utf8", mode: 0o600 });
  const manifest = { version: 1, serviceId: SERVICE_ID, packageVersion: CONNECTOR_VERSION, platform: paths.platform, definitionPath: paths.definitionPath, runtimeRoot: paths.runtimeRoot, logPath: paths.logPath, target: paths.target, definitionSha256: hash(definition), installedAt: new Date().toISOString() };
  await fs.writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(paths.manifestPath, 0o600);

  if (paths.platform === "darwin") {
    const loaded = await launchdLoaded(paths, run);
    if (loaded) await run("/bin/launchctl", ["bootout", paths.target]);
    await run("/bin/launchctl", ["bootstrap", paths.target.split(`/${SERVICE_ID}`)[0], paths.definitionPath]);
  } else if (paths.platform === "linux") {
    await run("/usr/bin/systemctl", ["--user", "daemon-reload"]);
    await run("/usr/bin/systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
  } else {
    await restrictWindowsStateDirectory(paths, env, run);
    await run(paths.schedulerPath, ["/Create", "/TN", paths.target, "/XML", paths.definitionPath, ...(replaceWindowsTask ? ["/F"] : [])]);
    await run(paths.schedulerPath, ["/Run", "/TN", paths.target]);
  }
  return { installed: true, paths };
}

export async function startService(options = {}) {
  const context = await serviceContext(options);
  if (context.paths.platform === "darwin") {
    if (await launchdLoaded(context.paths, context.run)) await context.run("/bin/launchctl", ["kickstart", context.paths.target]);
    else await context.run("/bin/launchctl", ["bootstrap", context.paths.target.split(`/${SERVICE_ID}`)[0], context.paths.definitionPath]);
  } else if (context.paths.platform === "linux") await context.run("/usr/bin/systemctl", ["--user", "start", SYSTEMD_UNIT]);
  else await context.run(context.paths.schedulerPath, ["/Run", "/TN", context.paths.target]);
  return { started: true, paths: context.paths };
}

export async function stopService(options = {}) {
  const context = await serviceContext(options);
  if (context.paths.platform === "darwin") {
    if (await launchdLoaded(context.paths, context.run)) await context.run("/bin/launchctl", ["bootout", context.paths.target]);
  } else if (context.paths.platform === "linux") await context.run("/usr/bin/systemctl", ["--user", "stop", SYSTEMD_UNIT]);
  else await context.run(context.paths.schedulerPath, ["/End", "/TN", context.paths.target], { allowFailure: true });
  return { stopped: true, paths: context.paths };
}

export async function restartService(options = {}) {
  const context = await serviceContext(options);
  if (context.paths.platform === "darwin") {
    if (await launchdLoaded(context.paths, context.run)) await context.run("/bin/launchctl", ["kickstart", "-k", context.paths.target]);
    else await context.run("/bin/launchctl", ["bootstrap", context.paths.target.split(`/${SERVICE_ID}`)[0], context.paths.definitionPath]);
  } else if (context.paths.platform === "linux") await context.run("/usr/bin/systemctl", ["--user", "restart", SYSTEMD_UNIT]);
  else {
    await context.run(context.paths.schedulerPath, ["/End", "/TN", context.paths.target], { allowFailure: true });
    await context.run(context.paths.schedulerPath, ["/Run", "/TN", context.paths.target]);
  }
  return { restarted: true, paths: context.paths };
}

export async function readServiceLogs({ lines = 100, secrets = [], ...options } = {}) {
  const context = await serviceContext(options);
  let raw = "";
  if (context.paths.platform === "win32") {
    try {
      const contents = await context.fs.readFile(context.paths.logPath, "utf8");
      raw = contents.split(/\r?\n/).slice(-lines - 1).join("\n");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  } else {
    const result = await context.run("/usr/bin/tail", ["-n", String(lines), context.paths.logPath], { allowFailure: true });
    raw = String(result.stdout ?? result.stderr ?? "");
  }
  const output = redactSecrets(raw, secrets);
  return { output: String(redact(output)), paths: context.paths };
}

export async function uninstallService({ stateDir, platform, env, home, uid, fs = nodeFs, run = runCommand } = {}) {
  const paths = servicePaths({ stateDir, platform, env, home, uid });
  const exists = await definitionExists(paths.definitionPath, fs);
  const local = exists ? await assertExistingLocalService(paths, fs) : null;
  if (exists && paths.platform === "darwin") {
    if (await launchdLoaded(paths, run)) await run("/bin/launchctl", ["bootout", paths.target]);
  } else if (exists && paths.platform === "linux") {
    await run("/usr/bin/systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], { allowFailure: true });
  } else if (paths.platform === "win32") {
    const registered = await queryWindowsTask(paths, run);
    if (registered) {
      if (!exists) throw serviceOwnershipError("Refusing to remove a registered Windows task without its connector-owned local definition.");
      assertWindowsTaskXml(paths, registered, local.contents);
      await run(paths.schedulerPath, ["/End", "/TN", paths.target], { allowFailure: true });
      await run(paths.schedulerPath, ["/Delete", "/TN", paths.target, "/F"]);
    }
  }
  if (exists) await fs.rm(paths.definitionPath, { force: true });
  await fs.rm(paths.runtimeRoot, { recursive: true, force: true });
  await fs.rm(paths.logDir, { recursive: true, force: true });
  await fs.rm(paths.manifestPath, { force: true });
  if (paths.platform === "linux" && exists) await run("/usr/bin/systemctl", ["--user", "daemon-reload"]);
  return { removed: exists, paths };
}

export async function serviceInstalled({ stateDir, platform, env, home, uid, fs = nodeFs } = {}) {
  const paths = servicePaths({ stateDir, platform, env, home, uid });
  return await definitionExists(paths.definitionPath, fs);
}

export async function serviceActive(options = {}) {
  const context = await serviceContext(options);
  if (context.paths.platform === "darwin") return await launchdLoaded(context.paths, context.run);
  if (context.paths.platform === "linux") return (await context.run("/usr/bin/systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT], { allowFailure: true })).code === 0;
  const encoded = Buffer.from(windowsActivePowerShell(context.paths.target), "utf16le").toString("base64");
  return (await context.run(context.paths.powershellPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { allowFailure: true })).code === 0;
}

export async function beginServiceRuntimeUpdate({ packageDir, packageVersion, wasActive = false, ...options } = {}) {
  const context = await serviceContext(options);
  if (!packageDir || !packageVersion) throw new Error("A verified connector package is required for a runtime update.");
  const staged = `${context.paths.runtimeRoot}.next-${randomUUID()}`;
  const backup = `${context.paths.runtimeRoot}.previous-${randomUUID()}`;
  await context.fs.mkdir(staged, { recursive: true, mode: 0o700 });
  try {
    await copyRuntime(resolve(packageDir), staged, context.fs);
    await context.fs.chmod(join(staged, "bin", RUNTIME_BIN), 0o755);
    await readServiceRuntimeIdentity({ runtimeRoot: staged, expectedVersion: packageVersion, fs: context.fs });
    const previousManifest = await readOwnedServiceManifest(context.paths, context.fs);
    const transaction = {
      version: 1,
      serviceId: SERVICE_ID,
      runtimeRoot: context.paths.runtimeRoot,
      backupRoot: backup,
      stagedRoot: staged,
      previousManifest,
      packageVersion,
      wasActive: Boolean(wasActive),
      createdAt: new Date().toISOString(),
    };
    await writePrivateJson(context.paths.updateJournalPath, transaction, context.fs);
    await context.fs.rename(context.paths.runtimeRoot, backup);
    try { await context.fs.rename(staged, context.paths.runtimeRoot); }
    catch (error) {
      await context.fs.rename(backup, context.paths.runtimeRoot);
      await context.fs.rm(context.paths.updateJournalPath, { force: true });
      throw error;
    }
    await writePrivateJson(context.paths.manifestPath, { ...previousManifest, packageVersion, updatedAt: new Date().toISOString() }, context.fs);
    await readServiceRuntimeIdentity({ runtimeRoot: context.paths.runtimeRoot, expectedVersion: packageVersion, fs: context.fs });
    return { paths: context.paths, packageVersion, transaction };
  } catch (error) {
    if (await pathExists(context.paths.updateJournalPath, context.fs)) {
      try { await rollbackServiceRuntimeUpdate(options); }
      catch (rollbackError) { throw rollbackFailure(error, rollbackError); }
    }
    throw error;
  } finally {
    await context.fs.rm(staged, { recursive: true, force: true }).catch(() => {});
  }
}

export async function commitServiceRuntimeUpdate(options = {}) {
  const context = await serviceContext(options);
  const transaction = await readUpdateTransaction(context.paths, context.fs);
  if (!transaction) return { committed: false };
  await context.fs.rm(context.paths.updateJournalPath, { force: true });
  await context.fs.rm(transaction.backupRoot, { recursive: true, force: true }).catch(() => {});
  await context.fs.rm(transaction.stagedRoot, { recursive: true, force: true }).catch(() => {});
  return { committed: true };
}

export async function rollbackServiceRuntimeUpdate(options = {}) {
  const context = await serviceContext(options);
  const transaction = await readUpdateTransaction(context.paths, context.fs);
  if (!transaction) return { rolledBack: false };
  const backupExists = await pathExists(transaction.backupRoot, context.fs);
  const runtimeExists = await pathExists(context.paths.runtimeRoot, context.fs);
  if (!backupExists) {
    if (!runtimeExists) throw updateServiceError("The interrupted update has neither the previous nor current runtime.", "UPDATE_ROLLBACK_FAILED");
    const identity = await readServiceRuntimeIdentity({ runtimeRoot: context.paths.runtimeRoot, expectedVersion: transaction.previousManifest.packageVersion, fs: context.fs }).catch(() => null);
    if (!identity) throw updateServiceError("The previous runtime backup is missing and the active runtime does not match it.", "UPDATE_ROLLBACK_FAILED");
  } else {
    const failedRoot = `${context.paths.runtimeRoot}.failed-${randomUUID()}`;
    if (runtimeExists) await context.fs.rename(context.paths.runtimeRoot, failedRoot);
    try { await context.fs.rename(transaction.backupRoot, context.paths.runtimeRoot); }
    catch (error) {
      if (runtimeExists) await context.fs.rename(failedRoot, context.paths.runtimeRoot).catch(() => {});
      throw updateServiceError("Could not restore the previous connector runtime.", "UPDATE_ROLLBACK_FAILED", error);
    }
    await context.fs.rm(failedRoot, { recursive: true, force: true });
  }
  await writePrivateJson(context.paths.manifestPath, transaction.previousManifest, context.fs);
  await readServiceRuntimeIdentity({ runtimeRoot: context.paths.runtimeRoot, expectedVersion: transaction.previousManifest.packageVersion, fs: context.fs });
  await context.fs.rm(transaction.stagedRoot, { recursive: true, force: true });
  await context.fs.rm(context.paths.updateJournalPath, { force: true });
  return { rolledBack: true, packageVersion: transaction.previousManifest.packageVersion, wasActive: transaction.wasActive === true };
}

export async function recoverInterruptedServiceUpdate(options = {}) {
  const context = await serviceContext(options);
  if (!(await pathExists(context.paths.updateJournalPath, context.fs))) return { recovered: false };
  const result = await rollbackServiceRuntimeUpdate(options);
  return { recovered: result.rolledBack, packageVersion: result.packageVersion, wasActive: result.wasActive };
}

export async function readServiceRuntimeIdentity({ runtimeRoot, expectedVersion, fs = nodeFs } = {}) {
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(join(resolve(runtimeRoot), "package.json"), "utf8")); }
  catch { throw updateServiceError("The managed connector runtime package is missing or invalid.", "UPDATE_PACKAGE_INVALID"); }
  // A runtime installed before the rename is still a valid previous runtime to roll back to, so
  // both package identities are accepted here. A freshly downloaded package is checked strictly
  // against the current identity in update.mjs.
  const binEntry = manifest.bin?.[CONNECTOR_BIN_ENTRY] === `./bin/${RUNTIME_BIN}`
    ? `./bin/${RUNTIME_BIN}`
    : manifest.bin?.[LEGACY_CONNECTOR_BIN_ENTRY] === `./bin/${LEGACY_RUNTIME_BIN}`
      ? `./bin/${LEGACY_RUNTIME_BIN}`
      : null;
  if (![CONNECTOR_PACKAGE_NAME, LEGACY_CONNECTOR_PACKAGE_NAME].includes(manifest.name)
    || (expectedVersion && manifest.version !== expectedVersion)
    || !binEntry
    || manifest.engines?.node !== ">=22") {
    throw updateServiceError("The managed connector runtime failed identity checks.", "UPDATE_PACKAGE_INVALID");
  }
  await fs.access(join(resolve(runtimeRoot), binEntry));
  return { name: manifest.name, version: manifest.version };
}

export function renderServiceDefinition(paths, { stateDir }) {
  const args = [process.execPath, paths.runtimeBin, "connect", "--state-dir", resolve(stateDir), "--service-log", paths.logPath];
  if (paths.platform === "darwin") {
    const argumentsXml = args.map((value) => `      <string>${xmlEscape(value)}</string>`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${OWNERSHIP_MARKER} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${SERVICE_ID}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>ThrottleInterval</key><integer>5</integer>
    <key>Umask</key><integer>63</integer>
    <key>StandardOutPath</key><string>/dev/null</string>
    <key>StandardErrorPath</key><string>/dev/null</string>
  </dict>
</plist>
`;
  }
  if (paths.platform === "win32") {
    const actionArguments = args.slice(1).map(windowsArgQuote).join(" ");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${OWNERSHIP_MARKER} -->
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${OWNERSHIP_MARKER}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(paths.userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(paths.userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT5S</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(process.execPath)}</Command>
      <Arguments>${xmlEscape(actionArguments)}</Arguments>
      <WorkingDirectory>${xmlEscape(paths.runtimeRoot)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
  }
  const execStart = args.map(systemdQuote).join(" ");
  return `# ${OWNERSHIP_MARKER}
[Unit]
Description=Next Coder local T3 connector
After=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${systemdQuote(resolve(stateDir))}
StandardOutput=null
StandardError=null

[Install]
WantedBy=default.target
`;
}

export async function runCommand(file, args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync(file, args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!allowFailure) throw Object.assign(new Error(`${file} exited with code ${error?.code ?? "unknown"}.`), { code: "SERVICE_COMMAND_FAILED" });
    return { code: Number.isInteger(error?.code) ? error.code : 1, stdout: error?.stdout ?? "", stderr: error?.stderr ?? "" };
  }
}

async function serviceContext({ stateDir, platform, env, home, uid, fs = nodeFs, run = runCommand } = {}) {
  const paths = servicePaths({ stateDir, platform, env, home, uid });
  if (!(await definitionExists(paths.definitionPath, fs))) throw Object.assign(new Error("The connector service is not installed. Run connect --install-service first."), { code: "SERVICE_NOT_INSTALLED" });
  const local = await assertExistingLocalService(paths, fs);
  if (paths.platform === "win32") {
    const registered = await queryWindowsTask(paths, run);
    if (!registered) throw Object.assign(new Error("The connector Windows task is not registered. Run connect --install-service to repair it."), { code: "SERVICE_NOT_INSTALLED" });
    assertWindowsTaskXml(paths, registered, local.contents);
  }
  return { paths, fs, run };
}

async function copyRuntime(source, target, fs) {
  for (const name of ["package.json", "README.md", "bin", "src"]) {
    await fs.cp(join(source, name), join(target, name), { recursive: true, force: true });
  }
  // A managed service installed before the rename execs the legacy entry-point path. The runtime
  // keeps a thin alias there so an in-place runtime update does not leave that service unable to
  // start. The alias is generated, not published: the package itself only ships the current name.
  const alias = join(target, "bin", LEGACY_RUNTIME_BIN);
  await fs.writeFile(alias, RUNTIME_BIN_ALIAS, { encoding: "utf8", mode: 0o755 });
  await fs.chmod(alias, 0o755);
}

async function launchdLoaded(paths, run) {
  return (await run("/bin/launchctl", ["print", paths.target], { allowFailure: true })).code === 0;
}

async function assertExistingLocalService(paths, fs) {
  const info = await fs.lstat?.(paths.definitionPath);
  if (info?.isSymbolicLink?.()) throw serviceOwnershipError("Refusing to modify a symlinked connector service definition.");
  const contents = await fs.readFile(paths.definitionPath, "utf8");
  if (!isOwnedDefinition(contents)) throw serviceOwnershipError("Refusing to modify a service definition not owned by Next Coder.");
  let manifest = await readOwnedServiceManifest(paths, fs);
  if (manifest.legacyFingerprint) {
    const expected = renderServiceDefinition(paths, { stateDir: paths.stateDir });
    if (contents !== expected) throw serviceOwnershipError("Refusing to migrate a legacy service definition whose exact command fingerprint cannot be verified.");
    await readServiceRuntimeIdentity({ runtimeRoot: paths.runtimeRoot, expectedVersion: manifest.packageVersion, fs }).catch((error) => {
      throw serviceOwnershipError("Refusing to migrate a legacy service whose pinned runtime identity cannot be verified.", error);
    });
    const { legacyFingerprint: _legacy, ...previous } = manifest;
    manifest = { ...previous, target: paths.target, definitionSha256: hash(contents), migratedAt: new Date().toISOString() };
    await writePrivateJson(paths.manifestPath, manifest, fs);
  }
  if (manifest.definitionSha256 !== hash(contents)) throw serviceOwnershipError("Refusing to modify a connector service whose definition fingerprint does not match its manifest.");
  return { contents, manifest };
}

async function definitionExists(path, fs) {
  try { await fs.readFile(path, "utf8"); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function readOwnedServiceManifest(paths, fs) {
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(paths.manifestPath, "utf8")); }
  catch { throw updateServiceError("The managed service manifest is missing or invalid.", "SERVICE_MANIFEST_INVALID"); }
  const baseValid = manifest.version === 1 && manifest.serviceId === SERVICE_ID && manifest.platform === paths.platform && resolve(manifest.runtimeRoot) === paths.runtimeRoot && manifest.definitionPath === paths.definitionPath && manifest.logPath === paths.logPath && typeof manifest.packageVersion === "string";
  const currentFingerprint = manifest.target === paths.target && typeof manifest.definitionSha256 === "string";
  const legacyFingerprint = manifest.target === undefined && manifest.definitionSha256 === undefined;
  if (!baseValid || (!currentFingerprint && !legacyFingerprint)) {
    throw updateServiceError("The managed service manifest failed ownership checks.", "SERVICE_MANIFEST_INVALID");
  }
  return legacyFingerprint ? { ...manifest, legacyFingerprint: true } : manifest;
}

async function readUpdateTransaction(paths, fs) {
  let transaction;
  try { transaction = JSON.parse(await fs.readFile(paths.updateJournalPath, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw updateServiceError("The service update journal is invalid.", "UPDATE_JOURNAL_INVALID"); }
  const validRoots = transaction?.runtimeRoot === paths.runtimeRoot
    && typeof transaction.backupRoot === "string" && transaction.backupRoot.startsWith(`${paths.runtimeRoot}.previous-`)
    && typeof transaction.stagedRoot === "string" && transaction.stagedRoot.startsWith(`${paths.runtimeRoot}.next-`);
  const validPrevious = transaction?.previousManifest?.version === 1
    && transaction.previousManifest.serviceId === SERVICE_ID
    && transaction.previousManifest.platform === paths.platform
    && transaction.previousManifest.runtimeRoot === paths.runtimeRoot
    && transaction.previousManifest.definitionPath === paths.definitionPath
    && transaction.previousManifest.logPath === paths.logPath
    && transaction.previousManifest.target === paths.target
    && typeof transaction.previousManifest.definitionSha256 === "string"
    && typeof transaction.previousManifest.packageVersion === "string";
  if (transaction?.version !== 1 || transaction.serviceId !== SERVICE_ID || !validRoots || !validPrevious) {
    throw updateServiceError("The service update journal failed ownership checks.", "UPDATE_JOURNAL_INVALID");
  }
  return transaction;
}

async function writePrivateJson(path, value, fs) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, path);
  await fs.chmod(path, 0o600);
}

async function pathExists(path, fs) {
  try { await fs.access(path); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function readOptionalFile(path, fs) {
  try { return await fs.readFile(path, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function queryWindowsTask(paths, run) {
  const encoded = Buffer.from(windowsExportPowerShell(paths.target), "utf16le").toString("base64");
  const result = await run(paths.powershellPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { allowFailure: true });
  return result?.code === 0 ? String(result.stdout ?? "") : null;
}

async function assertWindowsRegistrationBeforeInstall(paths, run, previousDefinition) {
  const registered = await queryWindowsTask(paths, run);
  if (!registered) return false;
  if (previousDefinition === null) throw serviceOwnershipError("Refusing to replace an existing Windows task without its connector-owned local definition.");
  assertWindowsTaskXml(paths, registered, previousDefinition);
  return true;
}

function assertWindowsTaskXml(paths, xml, expectedDefinition) {
  const expectedCommand = xmlTag(expectedDefinition, "Command");
  const expectedArguments = xmlTag(expectedDefinition, "Arguments");
  const expectedWorkingDirectory = xmlTag(expectedDefinition, "WorkingDirectory");
  const description = xmlTag(xml, "Description");
  const command = xmlTag(xml, "Command");
  const args = xmlTag(xml, "Arguments");
  const workingDirectory = xmlTag(xml, "WorkingDirectory");
  const principal = xmlTags(xml, "UserId").at(-1);
  const logonType = xmlTag(xml, "LogonType");
  const runLevel = xmlTag(xml, "RunLevel");
  const samePath = (left, right) => String(left ?? "").replaceAll("/", "\\").toLowerCase() === String(right ?? "").replaceAll("/", "\\").toLowerCase();
  const principalName = String(principal ?? "").toLowerCase();
  if (!isOwnedDefinition(description) || !samePath(command, expectedCommand) || args !== expectedArguments || !samePath(workingDirectory, expectedWorkingDirectory) || !samePath(workingDirectory, paths.runtimeRoot) || !principalName || principalName === "system" || principalName.endsWith("\\system") || logonType !== "InteractiveToken" || runLevel !== "LeastPrivilege") {
    throw serviceOwnershipError("Refusing to control a Windows task whose registered command fingerprint is not owned by this connector installation.");
  }
}

async function restrictWindowsStateDirectory(paths, env, run) {
  const result = await run(paths.icaclsPath, [paths.stateDir, "/inheritance:r", "/grant:r", `${paths.userId}:(OI)(CI)F`], { allowFailure: true });
  return result?.code === 0;
}

function windowsActivePowerShell(target) {
  if (!new RegExp(`^${WINDOWS_TASK_PREFIX}[a-f0-9]{12}$`).test(target)) throw serviceOwnershipError("The Windows task name failed validation.");
  return `$task = Get-ScheduledTask -TaskName '${target}' -ErrorAction Stop; if ($task.State -eq 'Running') { exit 0 } else { exit 3 }`;
}

function windowsExportPowerShell(target) {
  if (!new RegExp(`^${WINDOWS_TASK_PREFIX}[a-f0-9]{12}$`).test(target)) throw serviceOwnershipError("The Windows task name failed validation.");
  return `$encoding = New-Object System.Text.UTF8Encoding $false; [Console]::OutputEncoding = $encoding; $OutputEncoding = $encoding; Export-ScheduledTask -TaskName '${target}' -ErrorAction Stop`;
}

function windowsSystemTool(env, ...parts) {
  return join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", ...parts);
}

function windowsUserId(env) {
  const username = String(env.USERNAME ?? "").trim();
  const domain = String(env.USERDOMAIN ?? "").trim();
  const userId = domain ? `${domain}\\${username}` : username;
  if (!username || userId.length > 256 || /[\u0000-\u001f]/.test(userId)) throw Object.assign(new Error("Windows managed service installation requires USERNAME and an optional USERDOMAIN in the process environment."), { code: "SERVICE_USER_UNKNOWN" });
  return userId;
}

function xmlTags(xml, name) {
  const expression = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${name}>`, "gi");
  return [...String(xml).matchAll(expression)].map((match) => xmlUnescape(match[1].trim()));
}

function xmlTag(xml, name) { return xmlTags(xml, name)[0] ?? null; }
function xmlUnescape(value) { return String(value).replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&"); }

function windowsArgQuote(value) {
  const input = String(value);
  return `"${input.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

function isOwnedDefinition(contents) {
  return String(contents).includes(OWNERSHIP_MARKER) || String(contents).includes(LEGACY_OWNERSHIP_MARKER);
}

function serviceOwnershipError(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code: "SERVICE_NOT_OWNED" });
}

function rollbackFailure(original, rollback) {
  return updateServiceError(`The connector update failed and the previous runtime could not be restored (${original?.code ?? "update error"}).`, "UPDATE_ROLLBACK_FAILED", rollback);
}

function updateServiceError(message, code, cause) { return Object.assign(new Error(message, cause ? { cause } : undefined), { code }); }

function xmlEscape(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function systemdQuote(value) { return `"${String(value).replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`; }
function redactSecrets(value, secrets) { let output = value; for (const secret of secrets) if (secret) output = output.split(secret).join("[REDACTED]"); return output; }
function unsupportedPlatform(platform) { return Object.assign(new Error(`Managed connector services are not supported on ${platform}. Use macOS, Linux, or Windows.`), { code: "SERVICE_PLATFORM_UNSUPPORTED" }); }
