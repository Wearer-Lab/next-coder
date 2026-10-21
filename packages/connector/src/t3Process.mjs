import * as nodeFs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile, spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { delimiter, dirname, join, resolve, win32 } from "node:path";
import { platform as currentPlatform } from "node:os";
import { promisify } from "node:util";
import { discoverT3 } from "./t3.mjs";

const execFileAsync = promisify(execFile);
const METADATA_VERSION = 1;
const STARTING_VERSION = 1;
const WINDOWS_INSPECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
  "$pidValue=[int]$env:NEXT_CODER_INSPECT_PID\n  if (-not $pidValue) { $pidValue=[int]$env:AGENT_CONTROLLER_INSPECT_PID }",
  "$process=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $pidValue) -ErrorAction SilentlyContinue",
  "if($null -ne $process){[pscustomobject]@{pid=[int]$process.ProcessId;executablePath=[string]$process.ExecutablePath;commandLine=[string]$process.CommandLine;creationDate=$process.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}",
].join(";");
const WINDOWS_INSPECT_ENCODED = Buffer.from(WINDOWS_INSPECT_SCRIPT, "utf16le").toString("base64");

export function t3ProcessPaths(stateDir, baseDir = join(resolve(stateDir), "t3")) {
  return {
    metadataPath: join(resolve(stateDir), "t3-process.json"),
    startingPath: join(resolve(stateDir), "t3-process.starting.json"),
    handoffPath: join(resolve(stateDir), "t3-process.handoff.json"),
    baseDir: resolve(baseDir),
  };
}

export async function ensureLocalT3({
  stateDir,
  baseUrl = "http://127.0.0.1:3773",
  baseDir,
  autoStart = true,
  timeoutMs = 60_000,
  fetchImpl = globalThis.fetch,
  fs = nodeFs,
  spawnImpl = nodeSpawn,
  findExecutable = findExecutableOnPath,
  inspectProcess = inspectProcessCommand,
  killGroup = killProcessGroup,
  resolveLauncher = resolveNpxLauncher,
  sleep = delay,
  platform = currentPlatform(),
  env = process.env,
  nodeExecutable = process.execPath,
} = {}) {
  const url = validateOwnedLoopbackUrl(baseUrl);
  const paths = t3ProcessPaths(stateDir, baseDir);
  const recovered = await recoverInterruptedT3Start({ stateDir, fs, inspectProcess, platform, env });
  const metadata = recovered.metadata ?? await loadT3ProcessMetadata(stateDir, { fs });
  try {
    const discovered = await discoverT3({ candidates: [url.toString()], fetchImpl, timeoutMs: 1_500 });
    const owned = metadata && metadata.baseUrl === trimSlash(url.toString()) && await metadataStillMatches(metadata, inspectProcess, { platform, env, fs });
    return runtimeResult({
      baseUrl: discovered.baseUrl,
      info: discovered.info,
      metadata: owned ? metadata : null,
      owned: Boolean(owned),
      started: false,
      dependencies: { stateDir, fs, inspectProcess, killGroup, sleep, platform, env },
    });
  } catch (error) {
    if (error?.code !== "T3_NOT_FOUND") throw error;
    if (recovered.unverified) {
      throw Object.assign(new Error("A previous T3 launch was interrupted before ownership could be verified. The connector will not start or stop another process until that PID exits or is reviewed."), { code: "T3_PROCESS_RECOVERY_UNVERIFIED" });
    }
    if (!autoStart) throw Object.assign(new Error("No loopback T3 server is running. Start T3 Code or omit --no-start-t3."), { code: "T3_NOT_RUNNING" });
  }

  if (metadata && await metadataStillMatches(metadata, inspectProcess, { platform, env, fs })) {
    await stopOwnedT3({ stateDir, fs, inspectProcess, killGroup, sleep, platform, env });
  } else if (metadata) await fs.rm(paths.metadataPath, { force: true });

  const npx = await findExecutable("npx", { env, fs, platform });
  if (!npx) throw Object.assign(new Error("npx was not found on PATH. Install Node 22 with npm, or start T3 manually and use --no-start-t3."), { code: "NPX_NOT_FOUND" });
  const launcher = await resolveLauncher(npx, { platform, fs, nodeExecutable });
  await fs.mkdir(paths.baseDir, { recursive: true, mode: 0o700 });
  const port = Number(url.port || 80);
  const t3Args = ["--yes", "t3", "serve", "--port", String(port), "--base-dir", paths.baseDir, "--host", "127.0.0.1"];
  const args = [...launcher.argsPrefix, ...t3Args];
  const launchIntent = {
    version: STARTING_VERSION,
    connectorOwned: true,
    phase: "launching",
    pid: null,
    processGroupId: null,
    platform,
    controlKind: platform === "win32" ? "windows-process-tree" : "posix-process-group",
    command: launcher.command,
    args,
    npxCommand: npx,
    baseUrl: trimSlash(url.toString()),
    baseDir: paths.baseDir,
    startedAt: new Date().toISOString(),
    observedCommandHash: null,
  };
  await savePrivateJson(paths.startingPath, launchIntent, { fs });
  let child;
  try {
    child = spawnImpl(launcher.command, args, {
      cwd: paths.baseDir,
      detached: true,
      stdio: "ignore",
      env,
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    await fs.rm(paths.startingPath, { force: true });
    throw processError("The documented `npx t3 serve` process could not be launched.", "T3_START_FAILED", error);
  }
  let spawnError = null;
  child?.once?.("error", (error) => { spawnError = error; });
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 1) throw Object.assign(new Error("npx did not return a valid T3 process id."), { code: "T3_START_FAILED" });

  const starting = {
    ...launchIntent,
    phase: "spawned",
    pid: child.pid,
    processGroupId: child.pid,
  };
  await savePrivateJson(paths.startingPath, starting, { fs });

  let observedCommand = null;
  const inspectDeadline = Date.now() + Math.min(timeoutMs, 5_000);
  while (!observedCommand && Date.now() < inspectDeadline) {
    if (spawnError) throw processError("The documented `npx t3 serve` process could not be launched.", "T3_START_FAILED", spawnError);
    observedCommand = await inspectProcess(child.pid, { platform, fs, env });
    if (!observedCommand) await sleep(50);
  }
  if (!observedCommand) {
    throw Object.assign(new Error("Could not verify ownership of the launched T3 process."), { code: "T3_PROCESS_UNVERIFIED" });
  }
  assertObservedLaunchIdentity(observedCommand, starting);

  const ownedMetadata = {
    ...starting,
    observedCommandHash: hash(observedCommand),
  };
  await savePrivateJson(paths.startingPath, ownedMetadata, { fs });
  await saveT3ProcessMetadata(stateDir, ownedMetadata, { fs });
  await fs.rm(paths.startingPath, { force: true });
  child.unref?.();

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (spawnError) {
      await fs.rm(paths.metadataPath, { force: true });
      throw processError("The documented `npx t3 serve` process failed after launch.", "T3_START_FAILED", spawnError);
    }
    if (child.exitCode !== null) {
      await fs.rm(paths.metadataPath, { force: true });
      throw Object.assign(new Error("The documented `npx t3 serve` process exited before becoming ready."), { code: "T3_START_FAILED" });
    }
    try {
      const discovered = await discoverT3({ candidates: [url.toString()], fetchImpl, timeoutMs: 1_000 });
      return runtimeResult({ baseUrl: discovered.baseUrl, info: discovered.info, metadata: ownedMetadata, owned: true, started: true, dependencies: { stateDir, fs, inspectProcess, killGroup, sleep, platform, env } });
    } catch (error) {
      if (error?.code !== "T3_NOT_FOUND") {
        await stopOwnedT3({ stateDir, fs, inspectProcess, killGroup, sleep, platform, env, expectedMetadata: ownedMetadata });
        throw error;
      }
    }
    await sleep(250);
  }
  await stopOwnedT3({ stateDir, fs, inspectProcess, killGroup, sleep, platform, env, expectedMetadata: ownedMetadata });
  throw Object.assign(new Error(`T3 did not become ready within ${timeoutMs}ms.`), { code: "T3_START_TIMEOUT" });
}

export async function createLocalT3PairingToken({
  baseUrl,
  baseDir,
  npxCommand,
  run = runFile,
  findExecutable = findExecutableOnPath,
  resolveLauncher = resolveNpxLauncher,
  platform = currentPlatform(),
  nodeExecutable = process.execPath,
  env = process.env,
  fs = nodeFs,
} = {}) {
  const npx = npxCommand ?? await findExecutable("npx", { env, fs, platform });
  if (!npx) throw Object.assign(new Error("npx was not found, so the connector could not create a local T3 pairing token."), { code: "NPX_NOT_FOUND" });
  const launcher = await resolveLauncher(npx, { platform, fs, nodeExecutable });
  const result = await run(launcher.command, [...launcher.argsPrefix, "--yes", "t3", "auth", "pairing", "create", "--base-dir", resolve(baseDir), "--base-url", trimSlash(baseUrl), "--label", "Next Coder Connector", "--ttl", "1h", "--json"]);
  let payload;
  try { payload = JSON.parse(result.stdout); } catch { throw Object.assign(new Error("T3 pairing command did not return JSON."), { code: "T3_PAIRING_INVALID" }); }
  if (!payload?.credential) throw Object.assign(new Error("T3 pairing command did not return a credential."), { code: "T3_PAIRING_INVALID" });
  return payload.credential;
}

export async function stopOwnedT3({
  stateDir,
  fs = nodeFs,
  inspectProcess = inspectProcessCommand,
  killGroup = killProcessGroup,
  sleep = delay,
  expectedMetadata = null,
  platform = currentPlatform(),
  env = process.env,
} = {}) {
  const metadata = expectedMetadata ?? await loadT3ProcessMetadata(stateDir, { fs });
  if (!metadata?.connectorOwned) return { stopped: false, reason: "not_owned" };
  const paths = t3ProcessPaths(stateDir);
  const ownedPlatform = metadata.platform ?? platform;
  const current = await inspectProcess(metadata.pid, { fs, platform: ownedPlatform, env });
  if (!current) {
    await fs.rm(paths.metadataPath, { force: true });
    await fs.rm(paths.startingPath, { force: true });
    await fs.rm(paths.handoffPath, { force: true });
    return { stopped: false, reason: "not_running" };
  }
  if (hash(current) !== metadata.observedCommandHash) {
    throw Object.assign(new Error("Refusing to stop T3 because the persisted PID now belongs to a different process."), { code: "T3_PROCESS_IDENTITY_MISMATCH" });
  }
  await killGroup(metadata.processGroupId, "SIGTERM", { platform: ownedPlatform, env });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await inspectProcess(metadata.pid, { fs, platform: ownedPlatform, env }))) break;
    await sleep(100);
  }
  const remaining = await inspectProcess(metadata.pid, { fs, platform: ownedPlatform, env });
  if (remaining) {
    if (hash(remaining) !== metadata.observedCommandHash) {
      throw Object.assign(new Error("Refusing to force-stop T3 because the persisted PID changed identity during shutdown."), { code: "T3_PROCESS_IDENTITY_MISMATCH" });
    }
    await killGroup(metadata.processGroupId, "SIGKILL", { platform: ownedPlatform, env });
  }
  await fs.rm(paths.metadataPath, { force: true });
  await fs.rm(paths.startingPath, { force: true });
  await fs.rm(paths.handoffPath, { force: true });
  return { stopped: true };
}

export async function requestT3Handoff(stateDir, { fs = nodeFs, ttlMs = 30_000 } = {}) {
  const path = t3ProcessPaths(stateDir).handoffPath;
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, `${JSON.stringify({ version: 1, expiresAt: Date.now() + ttlMs })}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(path, 0o600);
}

export async function consumeT3Handoff(stateDir, { fs = nodeFs } = {}) {
  const path = t3ProcessPaths(stateDir).handoffPath;
  try {
    const value = JSON.parse(await fs.readFile(path, "utf8"));
    await fs.rm(path, { force: true });
    return value?.version === 1 && Number.isFinite(value.expiresAt) && value.expiresAt >= Date.now();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    await fs.rm(path, { force: true });
    return false;
  }
}

export async function loadT3ProcessMetadata(stateDir, { fs = nodeFs } = {}) {
  try {
    const value = JSON.parse(await fs.readFile(t3ProcessPaths(stateDir).metadataPath, "utf8"));
    if (!validProcessRecord(value, { requireFingerprint: true })) return null;
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw Object.assign(new Error("Owned T3 process metadata is corrupt; refusing automatic process control."), { code: "T3_PROCESS_METADATA_CORRUPT" });
    throw error;
  }
}

async function saveT3ProcessMetadata(stateDir, metadata, { fs }) {
  await savePrivateJson(t3ProcessPaths(stateDir).metadataPath, metadata, { fs });
}

export async function inspectOwnedT3({ stateDir, fs = nodeFs, inspectProcess = inspectProcessCommand, platform = currentPlatform(), env = process.env } = {}) {
  const metadata = await loadT3ProcessMetadata(stateDir, { fs });
  if (!metadata) {
    const starting = await loadStartingRecord(stateDir, { fs });
    if (!starting) return { managed: false, running: false, verified: false, status: "user_managed" };
    if (!Number.isSafeInteger(starting.pid)) return { managed: true, running: false, verified: false, status: "interrupted_launch_unknown" };
    const observed = await inspectProcess(starting.pid, { platform: starting.platform ?? platform, env, fs });
    if (!observed) return { managed: true, running: false, verified: false, status: "interrupted_start_not_running", pid: starting.pid };
    const verified = typeof starting.observedCommandHash === "string" && hash(observed) === starting.observedCommandHash;
    return { managed: true, running: true, verified, status: verified ? "interrupted_start_recoverable" : "interrupted_start_unverified", pid: starting.pid };
  }
  const observed = await inspectProcess(metadata.pid, { platform: metadata.platform ?? platform, env, fs });
  if (!observed) return { managed: true, running: false, verified: false, status: "not_running", pid: metadata.pid };
  const verified = hash(observed) === metadata.observedCommandHash;
  return { managed: true, running: true, verified, status: verified ? "owned_running" : "identity_mismatch", pid: metadata.pid };
}

export async function findExecutableOnPath(name, { env = process.env, fs = nodeFs, platform = currentPlatform() } = {}) {
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const pathApi = platform === "win32" ? win32 : { join };
  const extensions = platform === "win32" && !win32.extname(name)
    ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((value) => value.toLowerCase())
    : [""];
  for (const directory of String(env.PATH ?? "").split(pathDelimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `${name}${extension}`);
      try { await fs.access(candidate, fsConstants.X_OK); return candidate; } catch {}
    }
  }
  return null;
}

export async function resolveNpxLauncher(npxCommand, { platform = currentPlatform(), fs = nodeFs, nodeExecutable = process.execPath } = {}) {
  if (platform !== "win32" || ![".cmd", ".bat"].includes(win32.extname(npxCommand).toLowerCase())) {
    return { command: npxCommand, argsPrefix: [] };
  }
  const candidates = [...new Set([
    win32.join(win32.dirname(npxCommand), "node_modules", "npm", "bin", "npx-cli.js"),
    win32.join(win32.dirname(nodeExecutable), "node_modules", "npm", "bin", "npx-cli.js"),
  ])];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.R_OK);
      return { command: nodeExecutable, argsPrefix: [candidate] };
    } catch {}
  }
  throw Object.assign(new Error("The Windows npx.cmd shim was found, but npm's npx-cli.js launcher could not be verified. Repair Node/npm or start T3 manually with --no-start-t3."), { code: "NPX_LAUNCHER_UNVERIFIED" });
}

export async function inspectProcessCommand(pid, { platform = currentPlatform(), fs = nodeFs, env = process.env, run = runInspectionCommand } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  if (platform === "linux") {
    try { return (await fs.readFile(`/proc/${pid}/cmdline`)).toString("utf8").split("\0").filter(Boolean).join("\0"); }
    catch (error) { if (error?.code === "ENOENT" || error?.code === "ESRCH") return null; throw error; }
  }
  if (platform === "darwin") {
    try { return (await execFileAsync("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="])).stdout.trim() || null; }
    catch (error) { if (error?.code === 1) return null; throw error; }
  }
  if (platform === "win32") {
    const powershell = windowsSystemTool(env, "WindowsPowerShell", "v1.0", "powershell.exe");
    const inspectionEnv = windowsToolEnvironment(env, { NEXT_CODER_INSPECT_PID: String(pid) });
    const result = await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_INSPECT_ENCODED], { env: inspectionEnv });
    if (!result.stdout?.trim()) return null;
    let value;
    try { value = JSON.parse(result.stdout); } catch { throw processError("Windows returned invalid process identity data.", "T3_PROCESS_INSPECTION_INVALID"); }
    if (value?.pid !== pid || typeof value.executablePath !== "string" || !value.executablePath || typeof value.commandLine !== "string" || !value.commandLine) {
      throw processError("Windows returned incomplete process identity data.", "T3_PROCESS_INSPECTION_INVALID");
    }
    return JSON.stringify({ pid, executablePath: value.executablePath, commandLine: value.commandLine, creationDate: String(value.creationDate ?? "") });
  }
  throw unsupported(platform);
}

export async function killProcessGroup(processGroupId, signal, { platform = currentPlatform(), env = process.env, run = runControlCommand } = {}) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) throw new Error("Invalid owned T3 process group id.");
  if (platform === "win32") {
    if (!["SIGTERM", "SIGKILL"].includes(signal)) throw new Error("Invalid Windows owned T3 termination signal.");
    const taskkill = windowsSystemTool(env, "taskkill.exe");
    await run(taskkill, ["/PID", String(processGroupId), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { env: windowsToolEnvironment(env), allowNotFound: true });
    return;
  }
  if (platform !== "linux" && platform !== "darwin") throw unsupported(platform);
  try { process.kill(-processGroupId, signal); } catch (error) { if (error?.code !== "ESRCH") throw error; }
}

async function metadataStillMatches(metadata, inspectProcess, { platform, env, fs }) {
  const command = await inspectProcess(metadata.pid, { platform: metadata.platform ?? platform, env, fs });
  return Boolean(command) && hash(command) === metadata.observedCommandHash;
}

function runtimeResult({ baseUrl, info, metadata, owned, started, dependencies }) {
  return {
    baseUrl: trimSlash(baseUrl), info, metadata, owned, started,
    async stop() { return owned ? await stopOwnedT3({ ...dependencies, expectedMetadata: metadata }) : { stopped: false, reason: "not_owned" }; },
  };
}

async function recoverInterruptedT3Start({ stateDir, fs, inspectProcess, platform, env }) {
  const starting = await loadStartingRecord(stateDir, { fs });
  if (!starting) return { metadata: null, unverified: false };
  if (!Number.isSafeInteger(starting.pid)) return { metadata: null, unverified: true };
  const paths = t3ProcessPaths(stateDir);
  const observed = await inspectProcess(starting.pid, { platform: starting.platform ?? platform, env, fs });
  if (!observed) {
    await fs.rm(paths.startingPath, { force: true });
    return { metadata: null, unverified: false };
  }
  if (typeof starting.observedCommandHash !== "string" || hash(observed) !== starting.observedCommandHash) {
    return { metadata: null, unverified: true };
  }
  const metadata = { ...starting, version: METADATA_VERSION };
  await saveT3ProcessMetadata(stateDir, metadata, { fs });
  await fs.rm(paths.startingPath, { force: true });
  return { metadata, unverified: false };
}

async function loadStartingRecord(stateDir, { fs }) {
  try {
    const value = JSON.parse(await fs.readFile(t3ProcessPaths(stateDir).startingPath, "utf8"));
    if (!validStartingRecord(value)) {
      throw processError("The interrupted T3 launch journal failed ownership checks; refusing automatic process control.", "T3_PROCESS_START_JOURNAL_INVALID");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw processError("The interrupted T3 launch journal is corrupt; refusing automatic process control.", "T3_PROCESS_START_JOURNAL_INVALID");
    throw error;
  }
}

function validStartingRecord(value) {
  const common = value?.version === STARTING_VERSION
    && value.connectorOwned === true
    && typeof value.command === "string"
    && value.command.length > 0
    && Array.isArray(value.args)
    && value.args.every((arg) => typeof arg === "string")
    && typeof value.baseUrl === "string"
    && typeof value.baseDir === "string"
    && (!value.platform || ["darwin", "linux", "win32"].includes(value.platform));
  if (!common) return false;
  if (value.phase === "launching") return value.pid === null && value.processGroupId === null && value.observedCommandHash === null;
  return (!value.phase || value.phase === "spawned") && validProcessRecord(value, { requireFingerprint: false });
}

function validProcessRecord(value, { requireFingerprint }) {
  return value?.version === METADATA_VERSION
    && value.connectorOwned === true
    && Number.isSafeInteger(value.pid)
    && value.pid > 1
    && value.processGroupId === value.pid
    && typeof value.command === "string"
    && value.command.length > 0
    && Array.isArray(value.args)
    && value.args.every((arg) => typeof arg === "string")
    && typeof value.baseUrl === "string"
    && typeof value.baseDir === "string"
    && (!value.platform || ["darwin", "linux", "win32"].includes(value.platform))
    && (!requireFingerprint || /^[a-f0-9]{64}$/.test(value.observedCommandHash));
}

async function savePrivateJson(path, value, { fs }) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.chmod(temporary, 0o600);
  try { await fs.rename(temporary, path); }
  catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
  await fs.chmod(path, 0o600);
}

function assertObservedLaunchIdentity(observed, expected) {
  if (expected.platform !== "win32") return;
  let identity;
  try { identity = JSON.parse(observed); } catch { throw processError("Windows process identity could not be verified.", "T3_PROCESS_UNVERIFIED"); }
  const argv = parseWindowsCommandLine(identity.commandLine);
  const expectedArgv = [expected.command, ...expected.args];
  if (!sameWindowsPath(identity.executablePath, expected.command)
    || argv.length !== expectedArgv.length
    || !argv.every((value, index) => index === 0 ? sameWindowsPath(value, expectedArgv[index]) : value === expectedArgv[index])) {
    throw processError("The launched Windows process did not match the exact connector-owned command.", "T3_PROCESS_UNVERIFIED");
  }
  const baseDirectoryIndex = expected.args.indexOf("--base-dir");
  if (baseDirectoryIndex < 0 || expected.args[baseDirectoryIndex + 1] !== expected.baseDir) {
    throw processError("The launched Windows process did not retain the connector-owned working directory contract.", "T3_PROCESS_UNVERIFIED");
  }
}

export function parseWindowsCommandLine(commandLine) {
  const values = [];
  let index = 0;
  while (index < commandLine.length) {
    while (/\s/.test(commandLine[index] ?? "")) index += 1;
    if (index >= commandLine.length) break;
    let value = "";
    let quoted = false;
    while (index < commandLine.length) {
      let slashes = 0;
      while (commandLine[index] === "\\") { slashes += 1; index += 1; }
      if (commandLine[index] === '"') {
        value += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) { value += '"'; index += 1; continue; }
        if (quoted && commandLine[index + 1] === '"') { value += '"'; index += 2; continue; }
        quoted = !quoted;
        index += 1;
        continue;
      }
      value += "\\".repeat(slashes);
      if (index >= commandLine.length || (!quoted && /\s/.test(commandLine[index]))) break;
      value += commandLine[index];
      index += 1;
    }
    values.push(value);
    while (/\s/.test(commandLine[index] ?? "")) index += 1;
  }
  return values;
}

function sameWindowsPath(left, right) {
  return win32.normalize(String(left)).toLowerCase() === win32.normalize(String(right)).toLowerCase();
}

async function runInspectionCommand(file, args, { env } = {}) {
  try {
    const result = await execFileAsync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 5_000, windowsHide: true, shell: false, env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    throw processError("Windows process ownership inspection failed.", "T3_PROCESS_INSPECTION_FAILED", error);
  }
}

async function runControlCommand(file, args, { env, allowNotFound = false } = {}) {
  try {
    const result = await execFileAsync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 10_000, windowsHide: true, shell: false, env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (allowNotFound && [1, 128].includes(Number(error?.code))) return { code: Number(error.code), stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    throw processError("Windows could not stop the exact connector-owned T3 process tree.", "T3_PROCESS_STOP_FAILED", error);
  }
}

async function runFile(file, args) {
  try {
    const result = await execFileAsync(file, args, { encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true, shell: false });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    throw Object.assign(new Error("The local T3 pairing command failed."), { code: "T3_PAIRING_FAILED", status: error?.code });
  }
}

function windowsSystemTool(env, ...parts) {
  return win32.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", ...parts);
}

function windowsToolEnvironment(env, additions = {}) {
  const result = {};
  for (const key of [
    "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "PATH", "Path", "PATHEXT", "PSModulePath",
    "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "APPDATA", "USERPROFILE",
    "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN",
  ]) {
    if (typeof env[key] === "string") result[key] = env[key];
  }
  return { ...result, ...additions };
}

function validateOwnedLoopbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw Object.assign(new Error("Automatic T3 launch is restricted to an HTTP loopback address."), { code: "T3_AUTOSTART_NOT_LOOPBACK" });
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw Object.assign(new Error("Automatic T3 launch requires a plain loopback origin."), { code: "T3_AUTOSTART_INVALID_URL" });
  return url;
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function trimSlash(value) { return String(value).replace(/\/$/, ""); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function processError(message, code, cause) { return Object.assign(new Error(message, cause ? { cause } : undefined), { code }); }
function unsupported(platform) { return Object.assign(new Error(`Automatic T3 process control is not supported on ${platform}.`), { code: "T3_PROCESS_PLATFORM_UNSUPPORTED" }); }
