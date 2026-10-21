import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { closeSync, constants, openSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";

const execFile = promisify(execFileCallback);

export const T3_HARNESSES = [
  {
    id: "auto",
    label: "Automatic detection",
    instanceId: null,
    executable: null,
    model: null,
  },
  {
    id: "openai",
    aliases: ["codex"],
    label: "OpenAI (Codex)",
    instanceId: "codex",
    executable: "codex",
    model: "gpt-5.4",
    install: ["npm", "install", "--global", "@openai/codex"],
    authCheck: ["codex", "login", "status"],
    authLogin: ["codex", "login"],
  },
  {
    id: "anthropic",
    aliases: ["claude", "claude-code"],
    label: "Anthropic (Claude Code)",
    instanceId: "claudeAgent",
    executable: "claude",
    model: "claude-sonnet-5",
    install: ["npm", "install", "--global", "@anthropic-ai/claude-code"],
    authLogin: ["claude", "auth", "login"],
  },
  {
    id: "cursor",
    label: "Cursor",
    instanceId: "cursor",
    executable: "cursor-agent",
    model: "auto",
    authLogin: ["cursor-agent", "login"],
  },
  {
    id: "opencode",
    label: "OpenCode",
    instanceId: "opencode",
    executable: "opencode",
    model: "openai/gpt-5",
    authLogin: ["opencode", "auth", "login"],
  },
  {
    id: "grok",
    label: "Grok",
    instanceId: "grok",
    executable: "grok",
    model: "grok-build",
  },
  {
    id: "custom",
    label: "Custom T3 provider instance",
    instanceId: null,
    executable: null,
    model: null,
  },
];

export function resolveHarness(value = "auto") {
  const normalized = String(value).trim().toLowerCase();
  const harness = T3_HARNESSES.find((candidate) =>
    candidate.id === normalized || candidate.aliases?.includes(normalized));
  if (!harness) {
    throw new Error(`Unknown harness '${value}'. Use auto, openai, anthropic, cursor, opencode, grok, or custom.`);
  }
  return harness;
}

export function selectedModel(harness, project, options = {}) {
  if (harness.id === "auto") return project?.defaultModelSelection ?? null;
  const instanceId = options.instanceId ?? harness.instanceId;
  const model = options.model
    ?? (project?.defaultModelSelection?.instanceId === instanceId
      ? project.defaultModelSelection.model
      : harness.model);
  return instanceId && model ? { instanceId, model } : null;
}

export function buildT3ServeArgs({
  projectPath,
  baseDir,
  port = 3773,
  tunnel = "local",
  host,
}) {
  const args = ["serve", "--port", String(port), "--base-dir", baseDir];
  if (tunnel === "tailscale") {
    args.push("--tailscale-serve");
  } else {
    args.push("--host", host ?? (tunnel === "local" ? "127.0.0.1" : "0.0.0.0"));
  }
  if (projectPath) args.push(projectPath);
  return args;
}

export function parseT3StartupOutput(output) {
  const text = stripAnsi(output);
  const connectionString = text.match(/^Connection string:\s*(\S+)\s*$/mu)?.[1] ?? null;
  const pairingToken = text.match(/^Token:\s*(\S+)\s*$/mu)?.[1] ?? null;
  const pairingUrl = text.match(/^Pairing URL:\s*(\S+)\s*$/mu)?.[1] ?? null;
  const listeningUrl = text.match(/Listening on\s+(https?:\/\/\S+)/u)?.[1] ?? null;
  return {
    connectionString: connectionString ?? listeningUrl,
    pairingToken,
    pairingUrl,
  };
}

export async function ensureT3Installed({ installMissing = true, logger = console } = {}) {
  const existing = await findExecutable("t3");
  if (existing) return existing;
  if (!installMissing) throw new Error("T3 Code is not installed. Run `npm install --global t3@latest`.");
  logger.log("T3 Code is not installed. Installing the current CLI...");
  await run(["npm", "install", "--global", "t3@latest"], { logger });
  const installed = await findExecutable("t3");
  if (!installed) throw new Error("T3 Code installation completed but `t3` is still unavailable on PATH.");
  return installed;
}

export async function verifyHarness(harness, {
  installMissing = false,
  nonInteractive = false,
  logger = console,
} = {}) {
  if (!harness.executable) return { executable: null, authenticated: null };
  let executable = await findExecutable(harness.executable);
  if (!executable && installMissing && harness.install) {
    logger.log(`${harness.label} is not installed. Installing its CLI...`);
    await run(harness.install, { logger });
    executable = await findExecutable(harness.executable);
  }
  if (!executable) {
    throw new Error(
      `${harness.label} CLI '${harness.executable}' was not found. Install and authenticate it, then rerun setup.`,
    );
  }
  await run([executable, "--version"], { logger, allowFailure: true });
  if (!harness.authCheck) return { executable, authenticated: null };
  const status = await run(harness.authCheck, { logger, allowFailure: true });
  if (status.code === 0) return { executable, authenticated: true };
  if (nonInteractive || !harness.authLogin) {
    throw new Error(`${harness.label} is installed but is not authenticated. Run \`${harness.authLogin?.join(" ")}\`.`);
  }
  await run(harness.authLogin, { logger });
  return { executable, authenticated: true };
}

export async function prepareTunnel({
  tunnel = "local",
  port = 3773,
  publicUrl = null,
  installMissing = false,
  nonInteractive = false,
  waitForUser = null,
  logger = console,
} = {}) {
  if (tunnel === "local") {
    return { tunnel, host: "127.0.0.1", expectedBaseUrl: `http://127.0.0.1:${port}` };
  }
  if (tunnel === "lan") {
    const address = localIpv4Address();
    return {
      tunnel,
      host: "0.0.0.0",
      expectedBaseUrl: publicUrl ?? (address ? `http://${address}:${port}` : null),
    };
  }
  if (tunnel === "custom") {
    if (!publicUrl) throw new Error("A custom tunnel requires --public-url.");
    return { tunnel, host: "127.0.0.1", expectedBaseUrl: publicUrl };
  }
  if (tunnel !== "tailscale") {
    throw new Error(`Unsupported tunnel '${tunnel}'. Use local, lan, tailscale, or custom.`);
  }

  let tailscale = await findTailscaleExecutable();
  if (!tailscale && installMissing) {
    const brew = await findExecutable("brew");
    if (!brew) throw new Error("Tailscale is missing and Homebrew is not available for installation.");
    logger.log("Tailscale is not installed. Installing the macOS app...");
    await run([brew, "install", "--cask", "tailscale"], { logger });
    tailscale = await findTailscaleExecutable();
  }
  if (!tailscale) {
    throw new Error("Tailscale is not installed. Install it or rerun setup with --tunnel local.");
  }

  const status = await run([tailscale, "status", "--json"], { logger, allowFailure: true });
  if (status.code !== 0) {
    if (nonInteractive || !waitForUser) {
      throw new Error("Tailscale is installed but not connected. Sign in to Tailscale and rerun setup.");
    }
    logger.log("Open Tailscale and sign in, then return here.");
    await run(["open", "-a", "Tailscale"], { logger, allowFailure: true });
    await waitForUser();
  }
  return { tunnel, host: null, expectedBaseUrl: publicUrl };
}

export async function addRecommendedProject({
  t3Executable,
  projectPath,
  projectTitle,
  baseDir,
  logger = console,
}) {
  if (!projectPath) return { added: false, skipped: true };
  const absolutePath = resolve(projectPath);
  await access(absolutePath, constants.R_OK);
  const result = await run([
    t3Executable,
    "project",
    "add",
    "--base-dir",
    baseDir,
    "--title",
    projectTitle ?? basename(absolutePath),
    absolutePath,
  ], { logger, allowFailure: true });
  if (result.code === 0) return { added: true, skipped: false };
  if (/already exists/iu.test(`${result.stdout}\n${result.stderr}`)) {
    logger.log(`Project is already registered in T3 Code: ${absolutePath}`);
    return { added: false, skipped: false, alreadyExists: true };
  }
  throw new Error(`Could not add the recommended project to T3 Code: ${result.stderr || result.stdout}`);
}

export async function startT3Server({
  t3Executable,
  projectPath = null,
  baseDir,
  port,
  tunnel,
  host,
  expectedBaseUrl,
  runtimeDir,
  logger = console,
  timeoutMs = 90_000,
}) {
  await mkdir(runtimeDir, { recursive: true });
  const logFile = join(runtimeDir, "t3-server.log");
  const stateFile = join(runtimeDir, "t3-server.json");
  if (expectedBaseUrl && await isT3Reachable(expectedBaseUrl)) {
    const pairing = await run([
      t3Executable,
      "auth",
      "pairing",
      "create",
      "--base-dir",
      baseDir,
      "--base-url",
      expectedBaseUrl,
      "--label",
      "Next Coder",
      "--ttl",
      "1h",
      "--json",
    ], { logger, allowFailure: true });
    const parsed = parseJsonOutput(pairing.stdout);
    if (pairing.code !== 0 || !parsed?.credential) {
      throw new Error(`T3 Code is already running, but a new pairing token could not be created: ${pairing.stderr}`);
    }
    logger.log(`Reusing T3 Code at ${expectedBaseUrl}`);
    return {
      connectionString: expectedBaseUrl,
      baseUrl: expectedBaseUrl,
      pairingToken: parsed.credential,
      pairingUrl: parsed.pairUrl ?? null,
      pid: null,
      logFile,
      stateFile,
      reused: true,
    };
  }
  await writeFile(logFile, "", "utf8");
  const logFd = openSync(logFile, "a");
  const args = buildT3ServeArgs({ projectPath, baseDir, port, tunnel, host });
  const child = spawn(t3Executable, args, {
    cwd: projectPath ?? process.cwd(),
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  closeSync(logFd);
  child.unref();
  await writeFile(stateFile, `${JSON.stringify({
    pid: child.pid,
    command: t3Executable,
    args,
    baseDir,
    projectPath,
    startedAt: new Date().toISOString(),
    logFile,
  }, null, 2)}\n`, "utf8");

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const output = await readFile(logFile, "utf8");
    const startup = parseT3StartupOutput(output);
    const baseUrl = startup.connectionString ?? expectedBaseUrl;
    if (baseUrl && startup.pairingToken && await isT3Reachable(baseUrl)) {
      logger.log(`T3 Code is listening at ${baseUrl}`);
      return { ...startup, baseUrl, pid: child.pid, logFile, stateFile };
    }
    if (child.exitCode !== null) {
      throw new Error(`T3 Code exited before it became ready. See ${logFile}.`);
    }
    await delay(250);
  }
  throw new Error(`T3 Code did not become ready within ${timeoutMs}ms. See ${logFile}.`);
}

/**
 * Reads T3's provider status caches from the local T3 base directory.
 *
 * T3 writes one <base-dir>/caches/<instanceId>.json per provider instance, holding the harness's
 * install/auth state and its full model list. The orchestration HTTP API does not expose any of
 * this, so the only way the gateway can list real harnesses and models for a remote environment is
 * for this script — which runs on the T3 host — to collect and register them.
 */
export async function collectProviderCatalogue(baseDir) {
  const cacheDir = join(baseDir, "caches");
  let files;
  try {
    files = await readdir(cacheDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const records = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(cacheDir, file), "utf8"));
      if (!parsed || typeof parsed !== "object") continue;
      // Older caches omit instanceId; the filename is the instance id.
      records.push({ instanceId: parsed.instanceId ?? file.replace(/\.json$/u, ""), ...parsed });
    } catch {
      // A single unreadable cache must not abort pairing.
    }
  }
  return records;
}

export async function registerProviderCatalogue({ origin, headers, environmentId, baseDir, logger = console }) {
  const instances = await collectProviderCatalogue(baseDir);
  if (instances.length === 0) {
    logger?.warn?.("No T3 provider caches found; harness and model lists will be limited to what is already in use.");
    return null;
  }

  const response = await requestJson(new URL(`/v1/t3/environments/${environmentId}/catalogue`, origin), {
    method: "PUT",
    headers,
    body: { source: "setup-script", instances },
  });

  const registered = response.catalogue?.instances ?? [];
  const ready = registered.filter((instance) => instance.status === "ready");
  logger?.log?.(
    `Registered ${registered.length} agent harness(es) with the gateway; ${ready.length} ready: `
    + ready.map((instance) => `${instance.instanceId} (${instance.models.length} models)`).join(", "),
  );
  return response.catalogue;
}

async function redeemConnectCode({
  origin,
  connectCode,
  label,
  baseUrl,
  pairingToken,
  baseDir,
  initialPrompt,
  logger,
}) {
  // The provider caches only exist on this machine and the redeem route is the only authenticated
  // moment this script gets, so the catalogue rides along with the redemption instead of needing a
  // separate PUT with a platform token.
  const instances = baseDir ? await collectProviderCatalogue(baseDir) : [];
  if (instances.length === 0) {
    logger?.warn?.("No T3 provider caches found; harness and model lists will be limited to what is already in use.");
  }
  const redeemed = await requestJson(new URL("/v1/t3/connect-sessions/redeem", origin), {
    method: "POST",
    body: {
      code: connectCode,
      label,
      baseUrl,
      pairingToken,
      ...(instances.length > 0 ? { instances, catalogueSource: "setup-script" } : {}),
    },
  });
  const registered = redeemed.catalogue?.instances ?? [];
  if (registered.length > 0) {
    const ready = registered.filter((instance) => instance.status === "ready");
    logger?.log?.(
      `Registered ${registered.length} agent harness(es) with the gateway; ${ready.length} ready: `
      + ready.map((instance) => `${instance.instanceId} (${instance.models.length} models)`).join(", "),
    );
  }
  if (redeemed.failure) {
    logger?.warn?.(`The gateway paired this host but could not reach it: ${redeemed.failure.message ?? redeemed.failure.reason}`);
  }
  // Launching a first thread needs the platform realm, which a connect code deliberately does not
  // grant. The console does it instead, on a connection it can already see.
  if (initialPrompt) {
    logger?.warn?.("--initial-prompt needs --gateway-token; start the first session from the console instead.");
  }
  return {
    gatewayToken: null,
    environment: redeemed.environment,
    snapshot: null,
    screen: redeemed.screen ?? null,
    catalogue: redeemed.catalogue ?? null,
    thread: null,
  };
}

export async function connectGateway({
  gatewayUrl,
  gatewayToken,
  gatewayDevUser = null,
  connectCode = null,
  label,
  baseUrl,
  pairingToken,
  projectPath = null,
  harness,
  instanceId = null,
  model = null,
  initialPrompt = null,
  baseDir = null,
  logger = console,
}) {
  const origin = new URL(gatewayUrl).origin;

  // Console-first pairing. The code was minted in the browser by a signed-in user, so this path
  // needs no platform token at all — which is the whole point, since `POST /v1/users/dev` is
  // hard-disabled in Clerk mode and a copyable one-liner cannot carry a Bearer credential.
  if (connectCode) {
    return await redeemConnectCode({
      origin,
      connectCode,
      label,
      baseUrl,
      pairingToken,
      baseDir,
      initialPrompt,
      logger,
    });
  }

  let token = gatewayToken;
  if (!token && gatewayDevUser) {
    const created = await requestJson(new URL("/v1/users/dev", origin), {
      method: "POST",
      body: {
        userId: gatewayDevUser,
        email: `${gatewayDevUser}@example.local`,
        tokenLabel: "T3 bootstrap",
      },
    });
    token = created.apiToken.secret;
  }
  if (!token) throw new Error("Gateway authentication is required. Pass --connect-code, --gateway-token, or --gateway-dev-user.");
  const headers = { authorization: `Bearer ${token}` };
  const registered = await requestJson(new URL("/v1/t3/environments", origin), {
    method: "POST",
    headers,
    body: { label, baseUrl, pairingToken },
  });
  const environmentId = registered.environment.id;
  await requestJson(new URL(`/v1/t3/environments/${environmentId}/check`, origin), {
    method: "POST",
    headers,
    body: {},
  });
  // Register the harness catalogue before launching anything, so the gateway can validate the
  // model selection against real models instead of accepting whatever string it is given.
  let catalogue = null;
  if (baseDir) {
    try {
      catalogue = await registerProviderCatalogue({ origin, headers, environmentId, baseDir, logger });
    } catch (error) {
      logger?.warn?.(`Could not register the harness catalogue: ${error.message}`);
    }
  }

  const snapshotResult = await requestJson(
    new URL(`/v1/t3/environments/${environmentId}/snapshot`, origin),
    { headers },
  );

  let thread = null;
  if (projectPath && initialPrompt) {
    const absoluteProjectPath = resolve(projectPath);
    const project = snapshotResult.snapshot.projects?.find((candidate) =>
      candidate.workspaceRoot && resolve(candidate.workspaceRoot) === absoluteProjectPath);
    if (!project) throw new Error(`T3 snapshot does not contain project ${absoluteProjectPath}.`);
    const modelSelection = selectedModel(harness, project, { instanceId, model });
    if (!modelSelection) throw new Error("The selected provider harness requires an instance id and model.");
    thread = await requestJson(new URL(`/v1/t3/environments/${environmentId}/threads`, origin), {
      method: "POST",
      headers,
      body: {
        projectId: project.id,
        text: initialPrompt,
        modelSelection,
      },
    });
  }

  return {
    gatewayToken: token,
    environment: registered.environment,
    snapshot: snapshotResult.snapshot,
    catalogue,
    thread,
  };
}

async function requestJson(url, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message ?? `Request to ${url.pathname} failed with HTTP ${response.status}.`;
    const cause = payload?.error?.details?.cause;
    throw new Error(cause ? `${message}: ${cause}` : message);
  }
  return payload;
}

async function run(command, { logger = console, allowFailure = false } = {}) {
  const [file, ...args] = command;
  try {
    const result = await execFile(file, args, { maxBuffer: 10 * 1024 * 1024 });
    if (result.stdout.trim()) logger.log(result.stdout.trim());
    if (result.stderr.trim()) logger.error(result.stderr.trim());
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = {
      code: Number.isInteger(error?.code) ? error.code : 1,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? error?.message ?? "",
    };
    if (!allowFailure) throw error;
    return result;
  }
}

async function findExecutable(name) {
  if (!name) return null;
  if (name.includes("/")) {
    try {
      await access(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  for (const directory of String(process.env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

async function findTailscaleExecutable() {
  return await findExecutable("tailscale")
    ?? await findExecutable("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
}

function localIpv4Address() {
  for (const addresses of Object.values(networkInterfaces())) {
    const match = addresses?.find((address) =>
      address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254."));
    if (match) return match.address;
  }
  return null;
}

async function isT3Reachable(baseUrl) {
  try {
    const response = await fetch(new URL("/.well-known/t3/environment", baseUrl), {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

function parseJsonOutput(value) {
  const text = stripAnsi(value);
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
