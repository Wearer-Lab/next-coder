import { platform } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin as defaultStdin, stdout as defaultStdout, stderr as defaultStderr } from "node:process";
import { createInterface } from "node:readline/promises";
import { beginCredentialRotation, CONNECTOR_VERSION, enrollConnector, revokeCloudConnector } from "./cloud.mjs";
import { ConnectorClient } from "./connector.mjs";
import { defaultStateDir, inspectStatePermissions, loadState, removeState, saveRuntimeState, saveState, STATE_VERSION, validateHttpUrl } from "./config.mjs";
import { diagnose } from "./diagnostics.mjs";
import { createBoundedFileLogger } from "./fileLogger.mjs";
import { safeError } from "./redact.mjs";
import { installService, readServiceLogs, restartService, serviceActive, serviceInstalled, servicePaths, startService, stopService, uninstallService } from "./service.mjs";
import { createT3Client, discoverT3, exchangePairingToken } from "./t3.mjs";
import { consumeT3Handoff, createLocalT3PairingToken, ensureLocalT3, inspectOwnedT3, requestT3Handoff, stopOwnedT3 } from "./t3Process.mjs";
import { applyConnectorUpdate, checkConnectorUpdate } from "./update.mjs";

import { prepareVoiceRuntime, setupVoiceRuntime, inspectVoiceRuntime } from "./voiceRuntime.mjs";

const COMMANDS = new Set(["connect", "rotate", "status", "doctor", "disconnect", "start", "stop", "restart", "logs", "update", "voice"]);
const SERVICE_COMMANDS = new Set(["start", "stop", "restart", "logs"]);
const CONNECTOR_CAPABILITIES = ["environmentInfo", "snapshot", "threadDetail", "dispatch", "callRpc", "threadStream"];

export async function main(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? defaultStdout;
  const stderr = dependencies.stderr ?? defaultStderr;
  let managedLogPath = null;
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      write(stdout, helpText(parsed.command));
      return 0;
    }
    if (!parsed.command) {
      write(stderr, "A command is required. Run next-coder-connect --help.\n");
      return 2;
    }
    if (Number(process.versions.node.split(".")[0]) < 22) throw unsupported("Node 22 or newer is required.");
    const stateDir = parsed.stateDir ?? dependencies.stateDir ?? defaultStateDir(dependencies.env ?? process.env);
    if (parsed.serviceLog) {
      const paths = servicePaths(serviceOptions({ ...dependencies, stateDir }));
      if (resolve(parsed.serviceLog) !== resolve(paths.logPath)) throw usage("--service-log is reserved for the connector-owned managed service.");
      managedLogPath = paths.logPath;
    }
    if (parsed.command === "voice") return await voiceCommand(parsed, { ...dependencies, stateDir, stdout, stderr });
    if (SERVICE_COMMANDS.has(parsed.command)) return await serviceCommand(parsed, { ...dependencies, stateDir, stdout, stderr });
    if (parsed.command === "update") return await updateCommand(parsed, { ...dependencies, stateDir, stdout, stderr });
    if (parsed.command === "rotate") return await rotateCommand(parsed, { ...dependencies, stateDir, stdout });
    if (parsed.command === "connect") return await connectCommand(parsed, { ...dependencies, stateDir, stdout, stderr });
    if (parsed.command === "status" || parsed.command === "doctor") return await diagnosticCommand(parsed, { ...dependencies, stateDir, stdout });
    if (parsed.command === "disconnect") return await disconnectCommand(parsed, { ...dependencies, stateDir, stdout, stderr });
    throw new Error(`Unsupported command: ${parsed.command}`);
  } catch (error) {
    if (managedLogPath) {
      const logger = createBoundedFileLogger(managedLogPath);
      logger.error(`Connector process failed: ${safeError(error).message}`);
      await logger.flush();
    } else write(stderr, `Error: ${safeError(error).message}\n`);
    return error?.code === "USAGE" ? 2 : 1;
  }
}

export function parseArgs(argv) {
  if (!Array.isArray(argv)) throw usage("Arguments must be an array.");
  const parsed = { command: null, help: false, json: false, yes: false, once: false, replace: false };
  let index = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    if (!COMMANDS.has(argv[0])) throw usage(`Unknown command: ${argv[0]}`);
    parsed.command = argv[0];
    index = 1;
  }
  if (parsed.command === "voice") {
    parsed.voiceAction = argv[index] && !argv[index].startsWith("-") ? argv[index++] : "status";
    if (!["setup", "status"].includes(parsed.voiceAction)) throw usage("Voice supports setup or status.");
  }
  const allowed = allowedFlags(parsed.command);
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") { parsed.help = true; continue; }
    if (!arg.startsWith("--")) throw usage("Unexpected positional argument.");
    if (!allowed.has(arg)) throw usage(`Unknown option for ${parsed.command ?? "the command"}.`);
    const key = flagKey(arg);
    if (["--json", "--yes", "--once", "--replace", "--revoke-cloud", "--force-local", "--apply", "--install-service", "--start-t3", "--no-start-t3", "--restart-service", "--check"].includes(arg)) parsed[key] = true;
    else {
      const value = requiredValue(argv, ++index, arg);
      parsed[key] = arg === "--lines" ? parseLines(value)
        : arg === "--t3-port" ? parsePort(value)
          : arg === "--t3-start-timeout-ms" ? parseTimeout(value, arg, 300_000)
            : arg === "--health-timeout-ms" ? parseTimeout(value, arg, 120_000)
            : value;
    }
  }
  return parsed;
}

async function connectCommand(options, dependencies = {}) {
  const { stateDir, stdout, stderr, env = process.env, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, Connector = ConnectorClient, credentialStore = null } = dependencies;
  const hostPlatform = dependencies.platform ?? platform();
  const existing = await loadState(stateDir, { requireSecure: true, credentialStore });
  if (existing && options.code && !options.replace) throw usage("This machine is already enrolled. Use connect without --code, or use --replace to enroll a replacement credential.");
  if (options.startT3 && options.noStartT3) throw usage("--start-t3 and --no-start-t3 are mutually exclusive.");
  let runtime = null;
  let transferRuntime = false;
  let voiceRuntime = null;
  const voiceAbort = new AbortController();
  const stopSetup = () => voiceAbort.abort();
  process.once("SIGINT", stopSetup); process.once("SIGTERM", stopSetup);
  try {
    runtime = await prepareT3Runtime(options, existing, { ...dependencies, stateDir, env, fetchImpl });
    const baseUrl = validateHttpUrl(runtime.baseUrl, "T3 URL", { allowHttpLoopback: true });
    const t3BaseDir = resolve(options.t3BaseDir ?? existing?.t3BaseDir ?? `${stateDir}/t3`);
    let t3AccessToken = await resolveT3Token(options, env, existing);
    let pairingToken = options.t3PairingToken;
    if (!t3AccessToken && !pairingToken) {
      pairingToken = await (dependencies.createT3PairingToken ?? createLocalT3PairingToken)({
        baseUrl, baseDir: t3BaseDir, env, fs: dependencies.fs, findExecutable: dependencies.findExecutable, run: dependencies.runT3Command,
        platform: hostPlatform, nodeExecutable: dependencies.nodeExecutable, resolveLauncher: dependencies.resolveNpxLauncher,
      });
    }
    const metadata = runtime.info ?? await createT3Client({ baseUrl, fetchImpl }).environmentInfo();
    if (!t3AccessToken && pairingToken) t3AccessToken = (await exchangePairingToken({ baseUrl, pairingToken,
      orchestrationProtocolVersion: metadata?.orchestrationProtocolVersion ?? 1, fetchImpl })).access_token;
    const t3 = createT3Client({ baseUrl, accessToken: t3AccessToken, fetchImpl, WebSocketImpl,
      orchestrationProtocolVersion: metadata?.orchestrationProtocolVersion ?? 1 });
    const info = metadata;
    let state = existing;
    if (!state || options.code) {
      if (!options.server || !options.code) throw usage("First-time connect requires --server and --code.");
      const server = validateHttpUrl(options.server, "server", { allowHttpLoopback: true });
      const enrolled = await enrollConnector({ server, code: options.code, label: options.label, capabilities: CONNECTOR_CAPABILITIES, fetchImpl, platform: hostPlatform });
      state = {
        version: STATE_VERSION,
        server,
        connectorId: enrolled.connectorId,
        environmentId: enrolled.environmentId,
        secret: enrolled.secret,
        t3BaseUrl: baseUrl,
        t3BaseDir,
        ...(t3AccessToken ? { t3AccessToken } : {}),
        createdAt: new Date().toISOString(),
        lastT3Version: info?.version ?? info?.serverVersion ?? null,
      };
      await saveState(stateDir, state, { credentialStore });
      write(stdout, `Enrolled connector ${state.connectorId} for environment ${state.environmentId}.\nCredentials stored in the local connector config directory with restricted permissions.\n`);
    } else {
      state = { ...state, t3BaseUrl: baseUrl, t3BaseDir, ...(t3AccessToken ? { t3AccessToken } : {}) };
      await saveState(stateDir, state, { credentialStore });
    }
    if (credentialStore?.native) write(stdout, `Standing connector credential protected by ${credentialStore.backend}.\n`);
    else if (credentialStore) write(stderr, `Warning: native credential storage is unavailable (${credentialStore.fallbackReason}); the standing credential uses the restricted local state file.\n`);
    if (!state.t3AccessToken) write(stderr, "Warning: T3 is reachable but not authenticated; protected requests will fail until a local T3 access token is configured.\n");
    if (options.installService) {
      await installService(serviceOptions({ ...dependencies, stateDir, env }));
      transferRuntime = true;
      write(stdout, "Connector service installed and started for this user.\n");
      return 0;
    }
    const fileLogger = options.serviceLog ? createBoundedFileLogger(options.serviceLog, { secrets: [state.secret, state.credentialRotation?.pendingSecret, state.t3AccessToken] }) : null;
    const logger = fileLogger ?? { log: (...items) => write(stdout, `${items.join(" ")}\n`), error: (...items) => write(stderr, `${items.map(formatItem).join(" ")}\n`) };
    write(stdout, "Preparing built-in voice on this machine. First use downloads the local speech model (about 660 MB) and its runtime. Audio processing stays on this machine.\n");
    voiceRuntime = await (dependencies.prepareVoiceRuntime ?? prepareVoiceRuntime)({ stateDir, fetchImpl, logger, signal: voiceAbort.signal, onProgress: (stage) => logger.log(`Voice setup: ${stage}`) });
    state = { ...state, voice: { enabled: true, url: voiceRuntime.url } };
    await saveState(stateDir, state, { credentialStore });
    // Connection health/cursors live in a separate runtime projection so the
    // long-running service can never overwrite an atomic credential-rotation
    // journal written by a concurrent CLI process.
    const connector = new Connector({ state, t3, fetchImpl, WebSocketImpl, logger, ensureLocalTranscription: (input) => voiceRuntime.ensureReady(input), persistState: async (nextState) => await saveRuntimeState(stateDir, nextState) });
    const stop = () => connector.stop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try { await connector.run({ once: options.once }); }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); await fileLogger?.flush(); }
    return 0;
  } finally {
    process.removeListener("SIGINT", stopSetup); process.removeListener("SIGTERM", stopSetup);
    await voiceRuntime?.close();
    // Consume a handoff marker even when this process reused a user-managed T3.
    // Otherwise a marker written for credential/service handoff can survive and
    // incorrectly affect a later connector-owned runtime.
    const handedOff = await consumeT3Handoff(stateDir, { fs: dependencies.fs });
    if (runtime?.owned && !transferRuntime && !handedOff) await runtime.stop();
  }
}

async function rotateCommand(options, dependencies = {}) {
  const { stateDir, stdout, fetchImpl = globalThis.fetch, credentialStore = null } = dependencies;
  if (!options.yes) throw usage("Credential rotation requires --yes.");
  const state = await loadState(stateDir, { requireSecure: true, credentialStore });
  if (!state) throw usage("This machine is not enrolled. Run connect first.");
  const server = validateHttpUrl(options.server ?? state.server, "server", { allowHttpLoopback: true });
  if (server !== state.server) throw usage("Credential rotation must use the currently enrolled cloud server.");
  const managed = await serviceInstalled(serviceOptions({ ...dependencies, stateDir }));
  if (!managed) {
    throw Object.assign(new Error("Atomic credential rotation requires the connector-owned managed service so a bridge can keep the environment online during handoff."), { code: "ROTATION_SERVICE_REQUIRED" });
  }

  let stagedState = state;
  if (options.code) {
    const rotated = await (dependencies.beginCredentialRotation ?? beginCredentialRotation)(state, { code: options.code, fetchImpl });
    stagedState = {
      ...state,
      credentialRotation: {
        id: rotated.rotationId,
        pendingSecret: rotated.secret,
        expiresAt: rotated.expiresAt,
        phase: "staged",
        stagedAt: new Date().toISOString(),
      },
    };
    // Preserve the active secret as the primary value until the staged
    // credential proves a live socket. This atomic write is also the recovery
    // journal if the command is interrupted.
    await saveState(stateDir, stagedState, { credentialStore });
  } else if (!state.credentialRotation) {
    throw usage("Credential rotation requires --code, unless an interrupted local rotation is being resumed.");
  }

  const rotation = stagedState.credentialRotation;
  // Do not reject solely from the journal clock: the staged ticket may already
  // have committed in the cloud immediately before a local interruption. The
  // server remains authoritative and will either accept the new active secret
  // or reject an actually expired staged secret.
  const nextState = {
    ...stagedState,
    secret: rotation.pendingSecret,
    credentialRotation: { ...rotation, phase: "activated" },
    rotatedAt: new Date().toISOString(),
    lastConnectionError: null,
  };
  // Write the T3 handoff marker before the bridge supersedes the old service;
  // the old process may otherwise exit and stop its connector-owned T3 before
  // this command has a chance to request transfer.
  await requestT3Handoff(stateDir, { fs: dependencies.fs });
  let activation;
  try {
    activation = await (dependencies.activateCredentialRotation ?? activateCredentialRotation)(nextState, {
      fetchImpl,
      WebSocketImpl: dependencies.WebSocketImpl ?? globalThis.WebSocket,
      timeoutMs: dependencies.rotationTimeoutMs ?? 30_000,
    });
  } catch (error) {
    await consumeT3Handoff(stateDir, { fs: dependencies.fs });
    throw error;
  }
  // Ticket consumption by this bridge is the server-side commit point. Only
  // after welcome do we atomically promote the local credential.
  await saveState(stateDir, nextState, { credentialStore });
  try {
    await restartService(serviceOptions({ ...dependencies, stateDir }));
    await activation.waitForHandoff();
    await consumeT3Handoff(stateDir, { fs: dependencies.fs });
  } catch (error) {
    activation.stop();
    throw error;
  }
  await saveState(stateDir, { ...nextState, credentialRotation: undefined }, { credentialStore });
  write(stdout, `Rotated connector ${state.connectorId} atomically; the bridge stayed online until the managed service authenticated with the new credential.\n`);
  return 0;
}

async function activateCredentialRotation(state, { fetchImpl, WebSocketImpl, timeoutMs }) {
  const t3 = createT3Client({ baseUrl: state.t3BaseUrl, accessToken: state.t3AccessToken, fetchImpl, WebSocketImpl });
  const bridge = new ConnectorClient({
    state,
    t3,
    fetchImpl,
    WebSocketImpl,
    logger: { log() {}, error() {} },
    persistState: async () => {},
  });
  let welcomeResolve;
  let welcomeReject;
  const welcomed = new Promise((resolve, reject) => { welcomeResolve = resolve; welcomeReject = reject; });
  const closed = bridge.connectOnce({ onWelcome: welcomeResolve });
  void closed.catch(welcomeReject);
  await boundedWait(welcomed, timeoutMs, "The staged connector credential did not establish a live socket before the rotation deadline.", "ROTATION_ACTIVATION_TIMEOUT");
  return {
    async waitForHandoff() {
      const outcome = await boundedWait(closed, timeoutMs, "The managed connector did not take over the rotation bridge before the handoff deadline.", "ROTATION_HANDOFF_TIMEOUT");
      if (outcome?.shutdownReason !== "superseded") {
        throw Object.assign(new Error("The rotation bridge closed without proof that the managed connector took over."), { code: "ROTATION_HANDOFF_UNPROVEN" });
      }
    },
    stop() { bridge.stop(); },
  };
}

async function boundedWait(promise, timeoutMs, message, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(message), { code })), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function voiceCommand(options, dependencies) {
  const { stateDir, stdout, fetchImpl = globalThis.fetch } = dependencies;
  if (options.voiceAction === "setup") {
    write(stdout, "Preparing built-in local voice; first use downloads about 660 MB of model data plus runtime dependencies.\n");
    await (dependencies.setupVoiceRuntime ?? setupVoiceRuntime)({ stateDir, fetchImpl, onProgress: (stage) => write(stdout, `Voice setup: ${stage}\n`) });
    write(stdout, "Local speech runtime installed. Connect starts and maintains it automatically.\n");
    return 0;
  }
  const state = await loadState(stateDir, { credentialStore: dependencies.credentialStore });
  const result = await (dependencies.inspectVoiceRuntime ?? inspectVoiceRuntime)({ fetchImpl, ...(state?.voice?.url ? { url: state.voice.url } : {}) });
  write(stdout, options.json ? `${JSON.stringify(result)}\n` : result.ready ? "Built-in voice is ready.\n" : "Built-in voice is unavailable. Connect prepares it automatically; run voice setup to repair installation.\n");
  return result.ready ? 0 : 1;
}

async function diagnosticCommand(options, dependencies = {}) {
  const { stateDir, stdout, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, exec, credentialStore = null } = dependencies;
  const state = await loadState(stateDir, { credentialStore });
  const t3 = state ? createT3Client({ baseUrl: state.t3BaseUrl, accessToken: state.t3AccessToken, fetchImpl, WebSocketImpl }) : null;
  let ownedT3;
  try {
    ownedT3 = await (dependencies.inspectOwnedT3 ?? inspectOwnedT3)({
      stateDir, fs: dependencies.fs, inspectProcess: dependencies.inspectProcess, platform: dependencies.platform, env: dependencies.env,
    });
  } catch (error) {
    ownedT3 = { managed: true, running: false, verified: false, status: error?.code ?? "inspection_failed" };
  }
  const result = await diagnose({
    stateDir,
    state,
    t3,
    fetchImpl,
    exec,
    platform: dependencies.platform ?? platform(),
    credentialStore,
    ownedT3,
  });
  const voice = await (dependencies.inspectVoiceRuntime ?? inspectVoiceRuntime)({ fetchImpl, ...(state?.voice?.url ? { url: state.voice.url } : {}) });
  result.checks.push({ id: "voice", ok: voice.ready, detail: voice.ready ? "Built-in local speech runtime is ready." : "Local speech runtime is unavailable; connect prepares it automatically, or run voice setup to repair installation." });
  result.healthy = result.healthy && voice.ready;
  const service = serviceOptions({ ...dependencies, stateDir });
  const managedServiceInstalled = await serviceInstalled(service);
  const managedServiceActive = managedServiceInstalled ? await serviceActive(service) : false;
  const output = options.command === "status" ? {
    enrolled: Boolean(state), connectorId: state?.connectorId ?? null, environmentId: state?.environmentId ?? null,
    server: state?.server ?? null, t3Configured: Boolean(state?.t3BaseUrl),
    lastConnectedAt: state?.lastConnectedAt ?? null, lastConnectionError: state?.lastConnectionError ?? null,
    credentialStorage: credentialStore ? { backend: credentialStore.backend, native: credentialStore.native, fallbackReason: credentialStore.fallbackReason } : null,
    managedService: { installed: managedServiceInstalled, active: managedServiceActive },
    ownedT3,
    healthy: result.healthy, checks: result.checks, tailscale: result.tailscale,
  } : result;
  if (options.json) write(stdout, `${JSON.stringify(output, null, 2)}\n`);
  else {
    if (state) write(stdout, `Connector ${state.connectorId} -> environment ${state.environmentId}\n`);
    if (options.command === "status") write(stdout, `Managed service: ${managedServiceInstalled ? (managedServiceActive ? "running" : "stopped") : "not installed"}\n`);
    for (const check of result.checks) write(stdout, `${check.ok ? "OK" : "FAIL"}  ${check.id}: ${check.detail}\n`);
    for (const guidance of result.tailscale.guidance) write(stdout, `ACTION tailscale: ${guidance.message}\n`);
  }
  return result.healthy ? 0 : 1;
}

async function disconnectCommand(options, dependencies = {}) {
  const { stateDir, stdout, stderr, stdin = defaultStdin, credentialStore = null } = dependencies;
  let state;
  let stateExists = false;
  try {
    state = await loadState(stateDir, { credentialStore });
    stateExists = Boolean(state);
  } catch (error) {
    if (!["CREDENTIAL_NOT_FOUND", "CREDENTIAL_ROTATION_NOT_FOUND"].includes(error?.code)) throw error;
    stateExists = (await inspectStatePermissions(stateDir)).exists;
  }
  const installed = await serviceInstalled(serviceOptions({ ...dependencies, stateDir }));
  if (!stateExists && !installed) { write(stdout, "No local connector enrollment or managed service exists.\n"); return 0; }
  if (!options.revokeCloud && !options.forceLocal) {
    throw usage("Choose --revoke-cloud to revoke the connector before cleanup, or --force-local to remove only local state.");
  }
  if (options.revokeCloud && !state && !options.forceLocal) {
    throw usage("Cloud revocation requires a readable connector credential. Retry with the credential store available, or use --force-local to remove only local state.");
  }
  let confirmed = options.yes;
  if (!confirmed && stdin.isTTY) {
    const terminal = createInterface({ input: stdin, output: stderr });
    const cloudAction = options.revokeCloud ? "Revoke the cloud connector, then remove" : "Remove only";
    try { confirmed = /^y(?:es)?$/i.test((await terminal.question(`${cloudAction} the local connector service, logs, and credentials${state ? ` for ${state.connectorId}` : ""}? [y/N] `)).trim()); }
    finally { terminal.close(); }
  }
  if (!confirmed) throw usage("Disconnect cancelled. Pass --yes to remove local connector credentials non-interactively.");
  if (options.revokeCloud && state) {
    try {
      await (dependencies.revokeCloudConnector ?? revokeCloudConnector)(state, { fetchImpl: dependencies.fetchImpl });
      write(stdout, "Cloud connector revoked.\n");
    } catch (error) {
      if (!options.forceLocal) throw error;
      write(stderr, `Warning: cloud revocation did not complete (${safeError(error).message}); --force-local permits local cleanup. The cloud connector must be revoked separately.\n`);
    }
  }
  if (installed) await uninstallService(serviceOptions({ ...dependencies, stateDir }));
  await (dependencies.stopOwnedT3 ?? stopOwnedT3)({ stateDir, fs: dependencies.fs, inspectProcess: dependencies.inspectProcess, killGroup: dependencies.killGroup, sleep: dependencies.sleep, platform: dependencies.platform, env: dependencies.env });
  await removeState(stateDir, { credentialStore });
  write(stdout, options.revokeCloud
    ? "Local connector service, logs, and credentials removed.\n"
    : "Local connector service, logs, and credentials removed. The cloud connector was not revoked.\n");
  return 0;
}

async function serviceCommand(options, dependencies) {
  const service = serviceOptions(dependencies);
  if (options.command === "start") await startService(service);
  else if (options.command === "stop") {
    await stopService(service);
    await (dependencies.stopOwnedT3 ?? stopOwnedT3)({ stateDir: dependencies.stateDir, fs: dependencies.fs, inspectProcess: dependencies.inspectProcess, killGroup: dependencies.killGroup, sleep: dependencies.sleep, platform: dependencies.platform, env: dependencies.env });
  }
  else if (options.command === "restart") {
    await requestT3Handoff(dependencies.stateDir, { fs: dependencies.fs });
    await restartService(service);
  }
  else {
    const state = await loadState(dependencies.stateDir, { credentialStore: dependencies.credentialStore });
    const result = await readServiceLogs({ ...service, lines: options.lines ?? 100, secrets: [state?.secret, state?.credentialRotation?.pendingSecret, state?.t3AccessToken] });
    write(dependencies.stdout, result.output || "No connector service logs are available.\n");
    if (result.output && !result.output.endsWith("\n")) write(dependencies.stdout, "\n");
    return 0;
  }
  write(dependencies.stdout, `Connector service ${options.command} completed.\n`);
  return 0;
}

async function updateCommand(options, dependencies) {
  const { stdout, stateDir } = dependencies;
  write(stdout, `@wearer-haitch/connector ${CONNECTOR_VERSION}\n`);
  if (!options.check && !options.apply) {
    write(stdout, "Use update --check for an explicit registry check, or update --apply --yes for the owned managed-service runtime.\n");
    return 0;
  }
  if (options.check && options.apply) throw usage("Choose either --check or --apply.");
  const updateOptions = {
    stateDir,
    service: serviceOptions({ ...dependencies, stateDir }),
    fs: dependencies.fs,
    env: dependencies.env,
    findExecutable: dependencies.findExecutable,
    run: dependencies.runNpmCommand,
    fetchImpl: dependencies.fetchImpl,
    sleep: dependencies.sleep,
    now: dependencies.now,
    loadConnectorState: dependencies.loadConnectorState ?? (async (directory) => await loadState(directory, { credentialStore: dependencies.credentialStore })),
    checkT3: dependencies.checkT3,
    checkOwnedT3: dependencies.checkOwnedT3,
    serviceIsActive: dependencies.serviceIsActive,
    targetVersion: options.version ?? null,
  };
  if (options.check) {
    const result = await checkConnectorUpdate(updateOptions);
    write(stdout, result.updateAvailable ? `${result.direction === "rollback" ? "Rollback" : "Update"} available: ${result.current} -> ${result.latest}\n` : `Up to date: ${result.current}\n`);
    return 0;
  }
  if (!options.yes) throw usage("update --apply requires --yes.");
  const result = await applyConnectorUpdate({ ...updateOptions, restartService: options.restartService, healthTimeoutMs: options.healthTimeoutMs ?? 30_000 });
  if (!result.applied) write(stdout, `Up to date: ${result.current}. No service files were changed.\n`);
  else write(stdout, `Updated the connector-owned service runtime from ${result.current} to ${result.latest}. ${result.restarted ? "The service was explicitly restarted." : "The service remains stopped."}\n`);
  return 0;
}

async function resolveT3Token(options, env, existing) {
  if (options.t3TokenFile) {
    const info = await stat(options.t3TokenFile);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw Object.assign(new Error("T3 token file permissions are too broad; restrict it to mode 0600."), { code: "TOKEN_PERMISSIONS" });
    return (await readFile(options.t3TokenFile, "utf8")).trim();
  }
  // NEXT_CODER_T3_TOKEN is read first; the legacy name stays readable so a connector installed
  // before the rename keeps picking up the token an operator exported.
  return env.NEXT_CODER_T3_TOKEN || env.AGENT_CONTROLLER_T3_TOKEN || existing?.t3AccessToken || null;
}

async function prepareT3Runtime(options, existing, dependencies) {
  const port = options.t3Port ?? 3773;
  const requested = options.t3Url ?? existing?.t3BaseUrl ?? `http://127.0.0.1:${port}`;
  const url = new URL(requested);
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  if (!loopback) {
    if (options.startT3) throw usage("--start-t3 can only launch a loopback T3 origin.");
    const discovered = await discoverT3({ candidates: [requested], fetchImpl: dependencies.fetchImpl, timeoutMs: 5_000 });
    return { baseUrl: discovered.baseUrl, info: discovered.info, owned: false, started: false, async stop() { return { stopped: false, reason: "not_owned" }; } };
  }
  const ensure = dependencies.ensureT3 ?? ensureLocalT3;
  return await ensure({
    stateDir: dependencies.stateDir,
    baseUrl: requested,
    baseDir: options.t3BaseDir ?? existing?.t3BaseDir,
    autoStart: !options.noStartT3,
    timeoutMs: options.t3StartTimeoutMs ?? 60_000,
    fetchImpl: dependencies.fetchImpl,
    fs: dependencies.fs,
    spawnImpl: dependencies.spawnT3,
    findExecutable: dependencies.findExecutable,
    resolveLauncher: dependencies.resolveNpxLauncher,
    inspectProcess: dependencies.inspectProcess,
    killGroup: dependencies.killGroup,
    sleep: dependencies.sleep,
    platform: dependencies.platform,
    env: dependencies.env,
    nodeExecutable: dependencies.nodeExecutable,
  });
}

function allowedFlags(command) {
  const common = ["--state-dir"];
  const map = {
    connect: [...common, "--server", "--code", "--label", "--t3-url", "--t3-token-file", "--t3-pairing-token", "--t3-base-dir", "--t3-port", "--t3-start-timeout-ms", "--start-t3", "--no-start-t3", "--once", "--replace", "--install-service", "--service-log"],
    voice: [...common, "--json"],
    status: [...common, "--json"], doctor: [...common, "--json"], disconnect: [...common, "--yes", "--revoke-cloud", "--force-local"],
    rotate: [...common, "--server", "--code", "--yes"],
    start: common, stop: common, restart: common, logs: [...common, "--lines"], update: [...common, "--check", "--apply", "--yes", "--restart-service", "--health-timeout-ms", "--version"],
  };
  return new Set(map[command] ?? []);
}

function flagKey(flag) { return flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); }
function requiredValue(argv, index, flag) { const value = argv[index]; if (!value || value.startsWith("-")) throw usage(`${flag} requires a value.`); return value; }
function parseLines(value) { const lines = Number(value); if (!Number.isSafeInteger(lines) || lines < 1 || lines > 1000) throw usage("--lines must be an integer from 1 to 1000."); return lines; }
function parsePort(value) { const port = Number(value); if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw usage("--t3-port must be an integer from 1 to 65535."); return port; }
function parseTimeout(value, flag, maximum) { const timeout = Number(value); if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > maximum) throw usage(`${flag} must be from 1000 to ${maximum}.`); return timeout; }
function usage(message) { return Object.assign(new Error(message), { code: "USAGE" }); }
function unsupported(message) { return Object.assign(new Error(message), { code: "UNSUPPORTED" }); }
function write(stream, value) { stream.write(value); }
function formatItem(value) { return typeof value === "string" ? value : JSON.stringify(value); }
function serviceOptions({ stateDir, platform: platformOverride, env = process.env, home, uid, fs, runServiceCommand, packageDir } = {}) {
  return { stateDir, platform: platformOverride, env, home, uid, fs, run: runServiceCommand, packageDir };
}

function helpText(command) {
  if (command === "voice") return "Usage: next-coder-connect voice setup [--state-dir PATH]\n       next-coder-connect voice status [--json]\n\nConnect prepares and maintains built-in voice automatically. Setup downloads the local model (about 660 MB), Python and inference dependencies in the per-user state directory. Status checks readiness without installing anything.\n";
  if (command === "connect") return `Usage: next-coder-connect connect --server URL --code CODE [options]\n\nOptions:\n  --t3-url URL            T3 URL (default discovery: http://127.0.0.1:3773)\n  --start-t3              Explicitly allow starting loopback T3 when absent (default behavior)\n  --no-start-t3           Never start T3; fail if the configured server is absent\n  --t3-port PORT          Loopback auto-start port (default 3773)\n  --t3-base-dir PATH      T3 state directory; never treated as a project\n  --t3-start-timeout-ms N Bounded readiness timeout (1000-300000)\n  --t3-token-file PATH    Read the T3 access token from a local file\n  --t3-pairing-token TOKEN Exchange a one-time local T3 pairing token\n  --label LABEL           Connector label\n  --once                  Connect through welcome once, then exit (diagnostics/tests)\n  --replace               Rotate by re-enrolling an existing environment\n  --install-service       Install and start an owned per-user launchd/systemd service\n  --state-dir PATH        Override the local config directory\n`;
  if (command === "update") return `Usage: next-coder-connect update --check [--version VERSION]\n       next-coder-connect update --apply --yes [--restart-service] [--version VERSION]\n\nOptions:\n  --check                 Query npm without changing local files\n  --apply                 Update only the connector-owned managed runtime\n  --version VERSION       Resolve and install this exact published version (upgrade or rollback)\n  --yes                   Confirm a managed runtime replacement\n  --restart-service       Explicitly permit restarting a running service\n  --health-timeout-ms N   Bounded service/T3/cloud verification timeout (default 30000)\n  --state-dir PATH        Override the local config directory\n`;
  if (command === "rotate") return `Usage: next-coder-connect rotate --code CODE --yes\n       next-coder-connect rotate --yes\n\nOptions:\n  --code CODE             Start a bounded rotation with a user-minted code\n  --yes                   Confirm credential rotation\n  --server URL            Must match the enrolled cloud server\n  --state-dir PATH        Override the local config directory\n\nThe no-code form resumes an interrupted local rotation journal. Atomic handoff requires an installed connector-owned managed service.\n`;
  if (command === "disconnect") return `Usage: next-coder-connect disconnect --revoke-cloud --yes\n       next-coder-connect disconnect --force-local --yes\n\nOptions:\n  --revoke-cloud          Revoke this connector with its own credential before local cleanup\n  --force-local           Permit local-only cleanup, including fallback after a revoke failure\n  --yes                   Confirm revocation and/or local credential removal\n  --state-dir PATH        Override the local config directory\n\nWithout --force-local, a failed cloud revocation leaves the service and all local credentials intact for a safe retry.\n`;
  return `Next Coder connector ${CONNECTOR_VERSION}\n\nUsage:\n  next-coder-connect <command> [options]\n\nCommands:\n  connect       Enroll and run the outbound connector in the foreground\n  rotate        Atomically rotate the managed-service credential\n  status        Show cloud, local T3, authentication, and Tailscale status\n  doctor        Run actionable diagnostics without printing secrets\n  disconnect    Remove local service, logs, and credentials after confirmation\n  start         Start the installed per-user connector service\n  stop          Stop the exact installed per-user connector service\n  restart       Restart the exact installed per-user connector service\n  logs          Read bounded, redacted managed-service logs\n  update        Explicitly check or update the owned service runtime\n  voice         Prepare or inspect built-in local speech processing\n\nRun <command> --help for command options. Node 22+ is required.\n`;
}
