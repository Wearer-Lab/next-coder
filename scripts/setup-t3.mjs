#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { basename, resolve } from "node:path";

import {
  T3_HARNESSES,
  addRecommendedProject,
  connectGateway,
  ensureT3Installed,
  prepareTunnel,
  resolveHarness,
  startT3Server,
  verifyHarness,
} from "../src/t3Bootstrap.mjs";

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const terminal = options.nonInteractive ? null : createInterface({ input: stdin, output: stdout });

try {
  const harness = resolveHarness(options.provider ?? await selectHarness(terminal));
  const tunnel = options.tunnel ?? await selectTunnel(terminal);
  const projectPath = await selectOptionalProject(terminal, options);
  const projectTitle = options.title ?? (projectPath ? basename(projectPath) : null);
  const baseDir = resolve(options.baseDir ?? ".data/t3");
  const runtimeDir = resolve(options.runtimeDir ?? ".data/t3-runtime");
  const port = options.port ?? 3773;
  const instanceId = options.instanceId
    ?? (harness.id === "custom" ? await askRequired(terminal, "T3 provider instance id: ") : null);
  const model = options.model
    ?? (harness.id === "custom" ? await askRequired(terminal, "Model id: ") : null);

  console.log("\nChecking T3 Code and provider harness...");
  const t3Executable = await ensureT3Installed({
    installMissing: options.installMissing,
  });
  await verifyHarness(harness, {
    installMissing: options.installMissing,
    nonInteractive: options.nonInteractive,
  });

  const tunnelConfig = await prepareTunnel({
    tunnel,
    port,
    publicUrl: options.publicUrl,
    installMissing: options.installMissing,
    nonInteractive: options.nonInteractive,
    waitForUser: terminal ? () => terminal.question("Press Enter after Tailscale is connected. ") : null,
  });

  await addRecommendedProject({
    t3Executable,
    projectPath,
    projectTitle,
    baseDir,
  });

  console.log("\nLaunching T3 Code...");
  const t3 = await startT3Server({
    t3Executable,
    projectPath,
    baseDir,
    port,
    tunnel,
    host: tunnelConfig.host,
    expectedBaseUrl: tunnelConfig.expectedBaseUrl,
    runtimeDir,
  });

  let gateway = null;
  if (options.gatewayUrl) {
    console.log("\nConnecting T3 Code to Next Coder...");
    gateway = await connectGateway({
      gatewayUrl: options.gatewayUrl,
      gatewayToken: options.gatewayToken,
      gatewayDevUser: options.gatewayDevUser,
      connectCode: options.connectCode,
      label: options.environmentLabel ?? `${projectTitle ?? "Mac"} T3 Code`,
      baseUrl: t3.baseUrl,
      pairingToken: t3.pairingToken,
      projectPath,
      harness,
      instanceId,
      model,
      initialPrompt: options.initialPrompt,
      baseDir,
    });
  }

  console.log("\nSetup complete.");
  console.log(`T3 URL: ${t3.baseUrl}`);
  console.log(`T3 PID: ${t3.pid}`);
  console.log(`T3 log: ${t3.logFile}`);
  if (gateway) {
    console.log(`Gateway environment: ${gateway.environment.id}`);
    if (gateway.thread) console.log(`T3 thread: ${gateway.thread.threadId}`);
  } else {
    console.log(`Pairing URL: ${t3.pairingUrl}`);
  }
} catch (error) {
  console.error(`\nSetup failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  terminal?.close();
}

function parseArgs(args) {
  const result = {
    installMissing: true,
    nonInteractive: false,
    addProject: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--yes" || arg === "--non-interactive") result.nonInteractive = true;
    else if (arg === "--no-install") result.installMissing = false;
    else if (arg === "--skip-project") result.addProject = false;
    else if (arg === "--project") {
      result.project = requireValue(args, ++index, arg);
      result.addProject = true;
    } else if (arg === "--provider") result.provider = requireValue(args, ++index, arg);
    else if (arg === "--instance-id") result.instanceId = requireValue(args, ++index, arg);
    else if (arg === "--model") result.model = requireValue(args, ++index, arg);
    else if (arg === "--tunnel") result.tunnel = requireValue(args, ++index, arg);
    else if (arg === "--public-url") result.publicUrl = requireValue(args, ++index, arg);
    else if (arg === "--port") result.port = parsePort(requireValue(args, ++index, arg));
    else if (arg === "--base-dir") result.baseDir = requireValue(args, ++index, arg);
    else if (arg === "--runtime-dir") result.runtimeDir = requireValue(args, ++index, arg);
    else if (arg === "--title") result.title = requireValue(args, ++index, arg);
    else if (arg === "--gateway-url") result.gatewayUrl = requireValue(args, ++index, arg);
    else if (arg === "--gateway-token") result.gatewayToken = requireValue(args, ++index, arg);
    else if (arg === "--gateway-dev-user") result.gatewayDevUser = requireValue(args, ++index, arg);
    else if (arg === "--connect-code") result.connectCode = requireValue(args, ++index, arg);
    else if (arg === "--environment-label") result.environmentLabel = requireValue(args, ++index, arg);
    else if (arg === "--initial-prompt") result.initialPrompt = requireValue(args, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

async function selectHarness(terminal) {
  if (!terminal) return "auto";
  console.log("\nSelect the provider harness for the initial session:");
  T3_HARNESSES.forEach((harness, index) => {
    console.log(`  ${index + 1}. ${harness.label}`);
  });
  const answer = (await terminal.question("Harness [1]: ")).trim();
  const selected = answer ? Number.parseInt(answer, 10) : 1;
  if (!Number.isInteger(selected) || !T3_HARNESSES[selected - 1]) {
    throw new Error("Invalid harness selection.");
  }
  return T3_HARNESSES[selected - 1].id;
}

async function selectTunnel(terminal) {
  if (!terminal) return "local";
  console.log("\nSelect how this T3 server will be reached:");
  console.log("  1. Local only");
  console.log("  2. Tailscale HTTPS");
  console.log("  3. Local network");
  console.log("  4. Custom tunnel URL");
  const answer = (await terminal.question("Connection [1]: ")).trim();
  return ["local", "tailscale", "lan", "custom"][(answer ? Number.parseInt(answer, 10) : 1) - 1]
    ?? "local";
}

async function selectOptionalProject(terminal, current) {
  if (current.addProject === false) return null;
  if (current.project) return resolve(current.project);
  if (!terminal) return null;
  const shouldAdd = (await terminal.question(
    "\nAdd a project now so the first session is ready to use? [Y/n]: ",
  )).trim().toLowerCase();
  if (shouldAdd === "n" || shouldAdd === "no") return null;
  return resolve(await askRequired(terminal, "Project path: "));
}

async function askRequired(terminal, message) {
  if (!terminal) throw new Error(`${message.trim()} is required in non-interactive mode.`);
  const answer = (await terminal.question(message)).trim();
  if (!answer) throw new Error(`${message.trim()} is required.`);
  return answer;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${value}`);
  return port;
}

function printHelp() {
  console.log(`Next Coder T3 Code setup

Usage:
  npm run setup:t3
  npm run setup:t3 -- --project /path/to/project --provider openai --tunnel tailscale
  npm run setup:t3 -- --gateway-url https://gateway.example --connect-code ABCDE-FGHIJ

Provider choices:
  auto, openai, anthropic, cursor, opencode, grok, custom

Connection choices:
  local, tailscale, lan, custom

Important options:
  --project PATH             Recommend and add an initial project
  --skip-project             Start without adding a project
  --provider ID              Initial provider harness
  --instance-id ID           Custom T3 provider instance id
  --model ID                 Initial model id
  --tunnel TYPE              local, tailscale, lan, or custom
  --public-url URL           Public URL for a custom tunnel
  --gateway-url URL          Next Coder gateway URL
  --gateway-token TOKEN      Existing platform token
  --gateway-dev-user ID      Create a local development token
  --connect-code CODE        Enrollment code copied from the console's Add environment flow
  --initial-prompt TEXT      Launch a first thread after pairing
  --yes                      Non-interactive mode
  --no-install               Do not install missing T3/provider CLIs
`);
}
