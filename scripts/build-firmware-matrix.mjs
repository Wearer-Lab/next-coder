#!/usr/bin/env node

import { spawn } from "node:child_process";
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIRMWARE = join(ROOT, "firmware");
const MATRIX_PATH = join(FIRMWARE, "build-matrix.json");
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const LIVE_CONFIG_FILENAMES = new Set([
  "controller_config.h",
  "controller_config.old.h",
]);
const BUILD_DIRECTORIES = ["src", "lib", "scripts"];
const BUILD_FILES = ["partitions_ota.csv"];

function usage() {
  return `Usage: node scripts/build-firmware-matrix.mjs [--all | --release | --environment NAME ...] [--check]

Builds from placeholder controller_config.example.h files in an isolated temporary directory.
The default selection is --release. Set FIRMWARE_BUILD_TIMEOUT_MS to change the ten-minute
per-environment timeout or FIRMWARE_PIO_BIN to select a PlatformIO executable.`;
}

function parseArguments(argv) {
  const options = { selection: "release", environments: [], checkOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--all") options.selection = "all";
    else if (argument === "--release") options.selection = "release";
    else if (argument === "--check") options.checkOnly = true;
    else if (argument === "--environment") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--environment requires a name");
      options.selection = "environment";
      options.environments.push(value);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      return null;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("FIRMWARE_BUILD_TIMEOUT_MS must be a positive integer");
  }
  return parsed;
}

async function loadAndValidateMatrix() {
  const matrix = JSON.parse(await readFile(MATRIX_PATH, "utf8"));
  if (matrix?.schemaVersion !== 1 || typeof matrix.platform !== "string") {
    throw new Error("firmware/build-matrix.json has an unsupported schema");
  }
  if (!Array.isArray(matrix.environments) || matrix.environments.length === 0) {
    throw new Error("firmware/build-matrix.json has no environments");
  }

  const names = new Set();
  for (const entry of matrix.environments) {
    for (const field of ["hardwareModel", "directory", "environment", "role"]) {
      if (typeof entry?.[field] !== "string" || entry[field].length === 0) {
        throw new Error(`matrix entry is missing ${field}`);
      }
    }
    if (entry.directory.includes("..") || entry.directory.includes("/") || entry.directory.includes("\\")) {
      throw new Error(`invalid firmware directory: ${entry.directory}`);
    }
    if (names.has(entry.environment)) throw new Error(`duplicate environment: ${entry.environment}`);
    names.add(entry.environment);

    const ini = await readFile(join(FIRMWARE, entry.directory, "platformio.ini"), "utf8");
    if (!ini.includes(`platform = ${matrix.platform}`)) {
      throw new Error(`${entry.directory} does not use the pinned firmware platform`);
    }
    if (!ini.includes(`[env:${entry.environment}]`)) {
      throw new Error(`${entry.environment} is absent from ${entry.directory}/platformio.ini`);
    }
  }
  return matrix;
}

function selectedEntries(matrix, options) {
  if (options.selection === "all") return matrix.environments;
  if (options.selection === "release") return matrix.environments.filter((entry) => entry.role === "release");
  const selected = new Set(options.environments);
  for (const environment of selected) {
    if (!matrix.environments.some((candidate) => candidate.environment === environment)) {
      throw new Error(`unknown firmware environment: ${environment}`);
    }
  }
  return matrix.environments.filter((candidate) => selected.has(candidate.environment));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function stageFirmwareSources(entries) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "next-coder-firmware-matrix-"));
  await mkdir(join(temporaryRoot, "shared"), { recursive: true });
  await cp(
    join(FIRMWARE, "shared", "NextCoderCore"),
    join(temporaryRoot, "shared", "NextCoderCore"),
    { recursive: true },
  );

  for (const directory of new Set(entries.map((entry) => entry.directory))) {
    const source = join(FIRMWARE, directory);
    const destination = join(temporaryRoot, directory);
    await mkdir(join(destination, "include"), { recursive: true });
    await copyFile(join(source, "platformio.ini"), join(destination, "platformio.ini"));
    for (const name of BUILD_DIRECTORIES) {
      const from = join(source, name);
      if (await exists(from)) await cp(from, join(destination, name), { recursive: true });
    }
    for (const name of BUILD_FILES) {
      const from = join(source, name);
      if (await exists(from)) await copyFile(from, join(destination, name));
    }
    // The allowlist above intentionally contains neither live configuration filename.
    for (const name of LIVE_CONFIG_FILENAMES) {
      if (BUILD_FILES.includes(name) || BUILD_DIRECTORIES.includes(name)) {
        throw new Error(`unsafe firmware build-copy allowlist entry: ${name}`);
      }
    }
    await copyFile(
      join(source, "include", "controller_config.example.h"),
      join(destination, "include", "controller_config.h"),
    );
    // Explicit placeholder environments include this filename directly. Both copies originate
    // from the checked-in example; neither may read the ignored live controller configuration.
    await copyFile(
      join(source, "include", "controller_config.example.h"),
      join(destination, "include", "controller_config.example.h"),
    );
  }
  return temporaryRoot;
}

function classifyFailure({ output, timedOut, exitCode, signal }) {
  if (timedOut) return "timeout";
  if (/Temporary failure|Could not resolve|Connection (?:reset|refused)|HTTPClientError|Network is unreachable/iu.test(output)) {
    return "network-or-dependency";
  }
  if (/Compiling |Linking |Building .*\.bin/iu.test(output)) return "compile-or-link";
  if (/Library Manager: Installing|Platform Manager: Installing|Tool Manager: Installing/iu.test(output)) {
    return "dependency-resolution";
  }
  if (signal) return `toolchain-signal-${signal}`;
  return exitCode === null ? "toolchain-start" : "configuration-or-toolchain";
}

async function runBuild({ directory, environment }, temporaryRoot, timeoutMs) {
  const pio = process.env.FIRMWARE_PIO_BIN || "pio";
  const args = ["run", "--project-dir", join(temporaryRoot, directory), "-e", environment];
  process.stdout.write(`\n[firmware] ${environment}\n`);

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pio, args, {
      env: {
        ...process.env,
        PLATFORMIO_BUILD_CACHE_DIR: join(temporaryRoot, ".platformio-build-cache"),
        PLATFORMIO_SETTING_ENABLE_TELEMETRY: "no",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const remember = (chunk, target) => {
      target.write(chunk);
      output += chunk.toString("utf8");
      if (output.length > 2 * 1024 * 1024) output = output.slice(-2 * 1024 * 1024);
    };
    child.stdout.on("data", (chunk) => remember(chunk, process.stdout));
    child.stderr.on("data", (chunk) => remember(chunk, process.stderr));
    child.once("error", rejectPromise);

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    timeout.unref();

    child.once("exit", (exitCode, signal) => {
      clearTimeout(timeout);
      if (exitCode === 0 && !timedOut) {
        resolvePromise({ ok: true, environment });
        return;
      }
      resolvePromise({
        ok: false,
        environment,
        exitCode,
        signal,
        classification: classifyFailure({ output, timedOut, exitCode, signal }),
      });
    });
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) return;
  const matrix = await loadAndValidateMatrix();
  const entries = selectedEntries(matrix, options);
  process.stdout.write(`[firmware] matrix valid: ${matrix.environments.length} environments, ${entries.length} selected\n`);
  if (options.checkOnly) return;

  const timeoutMs = positiveInteger(process.env.FIRMWARE_BUILD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const temporaryRoot = await stageFirmwareSources(entries);
  const results = [];
  try {
    for (const entry of entries) results.push(await runBuild(entry, temporaryRoot, timeoutMs));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const failures = results.filter((result) => !result.ok);
  process.stdout.write("\n[firmware] build summary\n");
  for (const result of results) {
    process.stdout.write(
      result.ok
        ? `  PASS ${result.environment}\n`
        : `  FAIL ${result.environment} (${result.classification}, exit=${result.exitCode ?? "none"}, signal=${result.signal ?? "none"})\n`,
    );
  }
  if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[firmware] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
