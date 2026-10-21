#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  buildTailscaleTunnelArgs,
  findTailscaleExecutable,
  publicTunnelAllowed,
  TAILSCALE_TUNNEL_MODES,
  tailscaleConnection,
  tailscaleHttpsUrl,
  updateRemoteAccessEnvFile,
} from "../src/remoteAccess.mjs";

const execFile = promisify(execFileCallback);
let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`Tunnel setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (options.help) {
  printHelp();
  process.exit(0);
}

try {
  const envFile = resolve(options.envFile ?? ".env");
  const gatewayPort = options.gatewayPort ?? parseEnvPort(process.env.PORT) ?? 3996;
  const httpsPort = options.httpsPort ?? 443;
  const isPublic = options.mode === "funnel";

  if (isPublic) {
    const access = publicTunnelAllowed(process.env, { allowPublic: options.allowPublic });
    if (!access.allowed) {
      throw new Error(
        `Tailscale Funnel is public, but the gateway auth provider is '${access.authProvider}'. `
        + "Configure Clerk first, or pass --allow-public only if another production authentication layer protects the gateway.",
      );
    }
  }

  const tailscale = await findTailscaleExecutable();
  if (!tailscale) {
    throw new Error(
      "Tailscale CLI was not found. Install Tailscale from https://tailscale.com/download, sign in, and rerun this command.",
    );
  }

  const status = await readTailscaleStatus(tailscale);
  const connection = tailscaleConnection(status);
  if (!connection.connected) {
    throw new Error(
      `Tailscale is installed but not connected (state: ${connection.backendState}). Open Tailscale, sign in, and rerun this command.`,
    );
  }

  const args = buildTailscaleTunnelArgs({
    mode: options.mode,
    gatewayPort,
    httpsPort,
  });

  console.log(`\nConfiguring Tailscale ${options.mode.startsWith("funnel") ? "Funnel" : "Serve"}...`);
  console.log(`Gateway target: http://127.0.0.1:${gatewayPort}`);
  await runInteractive(tailscale, args);

  if (options.mode.endsWith("-off")) {
    console.log("\nRemote access mapping disabled.");
    process.exit(0);
  }

  const publicBaseUrl = tailscaleHttpsUrl(status, httpsPort);
  if (!publicBaseUrl) {
    throw new Error("Tailscale did not report a MagicDNS name for this device.");
  }

  let envChanged = false;
  if (options.writeEnv) {
    const result = await updateRemoteAccessEnvFile(envFile, {
      publicBaseUrl,
      appendAuthorizedParty: true,
    });
    envChanged = result.changed;
  }

  console.log("\nRemote access is ready.");
  console.log(`URL: ${publicBaseUrl}`);
  console.log(`Visibility: ${isPublic ? "public internet (gateway authentication still required)" : "private tailnet only"}`);
  if (options.writeEnv) {
    console.log(envChanged
      ? `Updated ${envFile}; restart Next Coder to load PUBLIC_BASE_URL and Clerk's authorized party.`
      : `${envFile} already contains the remote URL.`);
  } else {
    console.log(`Set PUBLIC_BASE_URL=${publicBaseUrl} and add the same origin to CLERK_AUTHORIZED_PARTIES.`);
  }
} catch (error) {
  console.error(`\nTunnel setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function parseArgs(args) {
  const result = {
    mode: "serve",
    writeEnv: false,
    allowPublic: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--mode") result.mode = requireValue(args, ++index, arg);
    else if (arg === "--gateway-port") result.gatewayPort = parsePort(requireValue(args, ++index, arg), arg);
    else if (arg === "--https-port") result.httpsPort = parsePort(requireValue(args, ++index, arg), arg);
    else if (arg === "--env-file") result.envFile = requireValue(args, ++index, arg);
    else if (arg === "--write-env") result.writeEnv = true;
    else if (arg === "--allow-public") result.allowPublic = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!TAILSCALE_TUNNEL_MODES.has(result.mode)) {
    throw new Error(`--mode must be one of: ${[...TAILSCALE_TUNNEL_MODES].join(", ")}.`);
  }
  return result;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parsePort(value, flag) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${flag} requires a port from 1 to 65535.`);
  }
  return port;
}

function parseEnvPort(value) {
  if (!value) return null;
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

async function readTailscaleStatus(tailscale) {
  try {
    const { stdout } = await execFile(tailscale, ["status", "--json"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Could not read Tailscale status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runInteractive(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(
        signal ? `Tailscale stopped with signal ${signal}.` : `Tailscale exited with status ${code}.`,
      ));
    });
  });
}

function printHelp() {
  console.log(`Next Coder remote access setup

Usage:
  npm run setup:tunnel -- --mode serve --write-env
  npm run setup:tunnel -- --mode funnel --write-env
  npm run setup:tunnel -- --mode serve-off
  npm run setup:tunnel -- --mode funnel-off

Modes:
  serve        Private HTTPS access for devices in your Tailnet (recommended)
  funnel       Public HTTPS access from the internet; Clerk or equivalent auth required
  serve-off    Disable the private HTTPS mapping on the selected HTTPS port
  funnel-off   Disable the public HTTPS mapping on the selected HTTPS port

Options:
  --gateway-port PORT   Local Next Coder port (default: PORT or 3996)
  --https-port PORT     Tailscale HTTPS port (default: 443)
  --write-env           Set PUBLIC_BASE_URL and append CLERK_AUTHORIZED_PARTIES
  --env-file PATH       Environment file to update (default: .env)
  --allow-public        Allow Funnel with non-Clerk auth after your own security review
`);
}
