import * as nodeFs from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { CONNECTOR_VERSION } from "./cloud.mjs";
import { loadState } from "./config.mjs";
import { discoverT3 } from "./t3.mjs";
import { findExecutableOnPath, inspectOwnedT3, requestT3Handoff, t3ProcessPaths } from "./t3Process.mjs";
import {
  beginServiceRuntimeUpdate,
  commitServiceRuntimeUpdate,
  readServiceRuntimeIdentity,
  recoverInterruptedServiceUpdate,
  restartService as restartManagedService,
  rollbackServiceRuntimeUpdate,
  serviceActive,
  serviceInstalled,
  servicePaths,
  startService,
  stopService,
} from "./service.mjs";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "@wearer-haitch/connector";
const PACKAGE_SCOPE_DIRECTORY = "@wearer-haitch";
const PACKAGE_BIN_ENTRY = "next-coder-connect";
const PACKAGE_BIN_PATH = "./bin/next-coder-connect.mjs";

export async function checkConnectorUpdate({ targetVersion = null, fs = nodeFs, env = process.env, findExecutable = findExecutableOnPath, run = runNpm } = {}) {
  const npm = await findExecutable("npm", { fs, env });
  if (!npm) throw updateError("npm was not found on PATH.", "NPM_NOT_FOUND");
  if (targetVersion !== null && !validVersion(targetVersion)) {
    throw updateError("The requested connector version is invalid.", "UPDATE_VERSION_INVALID");
  }
  const packageSpec = targetVersion ? `${PACKAGE_NAME}@${targetVersion}` : PACKAGE_NAME;
  const result = await run(npm, ["view", packageSpec, "version", "--json"], { env });
  let latest;
  try { latest = JSON.parse(result.stdout); } catch { throw updateError("npm returned an invalid package version response.", "UPDATE_CHECK_INVALID"); }
  if (!validVersion(latest)) throw updateError("npm returned an invalid connector version.", "UPDATE_CHECK_INVALID");
  if (targetVersion && latest !== targetVersion) {
    throw updateError("npm did not resolve the exact requested connector version.", "UPDATE_VERSION_NOT_FOUND");
  }
  const comparison = compareVersions(latest, CONNECTOR_VERSION);
  return { current: CONNECTOR_VERSION, latest, targetVersion: targetVersion ?? null,
    direction: comparison > 0 ? "upgrade" : comparison < 0 ? "rollback" : "current",
    updateAvailable: comparison !== 0, npm };
}

export async function applyConnectorUpdate({
  stateDir,
  targetVersion = null,
  service,
  restartService = false,
  healthTimeoutMs = 30_000,
  pollIntervalMs = 500,
  fs = nodeFs,
  env = process.env,
  fetchImpl = globalThis.fetch,
  findExecutable,
  run,
  sleep = delay,
  now = Date.now,
  loadConnectorState = loadState,
  checkT3 = checkLocalT3,
  checkOwnedT3 = inspectOwnedT3,
  serviceIsActive = serviceActive,
} = {}) {
  const serviceOptions = { ...service, stateDir, fs };
  if (!(await serviceInstalled(serviceOptions))) throw updateError("Automatic update is limited to an installed connector-owned user service.", "SERVICE_NOT_INSTALLED");
  const recovered = await recoverInterruptedServiceUpdate(serviceOptions);
  if (recovered.recovered) await restoreServiceState(recovered.wasActive, serviceOptions, serviceIsActive);
  const active = await serviceIsActive(serviceOptions);
  if (active && !restartService) throw updateError("The managed connector is running. Re-run with --restart-service to permit an explicit restart, or stop it first.", "UPDATE_RESTART_REQUIRED");
  const check = await checkConnectorUpdate({ targetVersion, fs, env, findExecutable, run });
  if (!check.updateAvailable) return { ...check, applied: false, restarted: false };
  const staging = await fs.mkdtemp(join(tmpdir(), "next-coder-connector-update-"));
  try {
    await (run ?? runNpm)(check.npm, ["install", "--prefix", staging, "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", `${PACKAGE_NAME}@${check.latest}`], { env });
    const packageDir = join(staging, "node_modules", PACKAGE_SCOPE_DIRECTORY, "connector");
    const manifest = await readVerifiedPackage(packageDir, check.latest, fs);
    const previousState = await loadConnectorState(stateDir);
    await beginServiceRuntimeUpdate({ ...serviceOptions, packageDir, packageVersion: manifest.version, wasActive: active });
    try {
      await readServiceRuntimeIdentity({ runtimeRoot: servicePaths(serviceOptions).runtimeRoot, expectedVersion: manifest.version, fs });
      if (active) {
        const verificationStartedAt = now();
        await requestT3Handoff(stateDir, { fs });
        await restartManagedService(serviceOptions);
        await waitForManagedHealth({
          stateDir,
          serviceOptions,
          previousLastConnectedAt: previousState?.lastConnectedAt ?? null,
          verificationStartedAt,
          healthTimeoutMs,
          pollIntervalMs,
          fs,
          fetchImpl,
          sleep,
          now,
          loadConnectorState,
          checkT3,
          checkOwnedT3,
          serviceIsActive,
        });
      }
      await commitServiceRuntimeUpdate(serviceOptions);
      return { ...check, applied: true, restarted: active, verified: active ? "service+t3+cloud" : "installed-package" };
    } catch (error) {
      await rollbackAfterFailure({ error, active, serviceOptions, serviceIsActive, fs, stateDir });
      throw Object.assign(error, { rolledBack: true });
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function waitForManagedHealth({ stateDir, serviceOptions, previousLastConnectedAt, verificationStartedAt, healthTimeoutMs, pollIntervalMs, fetchImpl, sleep, now, loadConnectorState, checkT3, checkOwnedT3, serviceIsActive }) {
  if (!Number.isSafeInteger(healthTimeoutMs) || healthTimeoutMs < 1_000 || healthTimeoutMs > 120_000) throw updateError("Update health timeout must be between 1000 and 120000ms.", "UPDATE_HEALTH_TIMEOUT_INVALID");
  const interval = Math.max(50, Math.min(Number(pollIntervalMs) || 500, healthTimeoutMs));
  const deadline = now() + healthTimeoutMs;
  const maxAttempts = Math.ceil(healthTimeoutMs / interval) + 1;
  for (let attempt = 0; attempt < maxAttempts && now() <= deadline; attempt += 1) {
    const active = await serviceIsActive(serviceOptions).catch(() => false);
    const state = await loadConnectorState(stateDir).catch(() => null);
    const t3Healthy = state?.t3BaseUrl ? await checkT3(state.t3BaseUrl, { fetchImpl }).catch(() => false) : false;
    const ownership = await checkOwnedT3({ ...serviceOptions, stateDir }).catch(() => ({ managed: true, running: false, verified: false }));
    const t3ProcessHealthy = !ownership.managed || (ownership.running && ownership.verified);
    const connectedAt = Date.parse(state?.lastConnectedAt ?? "");
    const cloudHealthy = Number.isFinite(connectedAt)
      && state.lastConnectedAt !== previousLastConnectedAt
      && connectedAt >= verificationStartedAt
      && !state.lastConnectionError;
    if (active && t3Healthy && t3ProcessHealthy && cloudHealthy) return { active, t3Healthy, t3ProcessHealthy, cloudHealthy };
    if (attempt + 1 < maxAttempts && now() < deadline) await sleep(interval);
  }
  throw updateError("The updated connector did not produce fresh service, local T3, and cloud connection health evidence before the deadline.", "UPDATE_HEALTH_TIMEOUT");
}

async function rollbackAfterFailure({ error, active, serviceOptions, serviceIsActive, fs, stateDir }) {
  const failures = [];
  if (active) {
    try { await stopService(serviceOptions); } catch (stopError) { failures.push(stopError); }
  }
  try { await rollbackServiceRuntimeUpdate(serviceOptions); } catch (rollbackError) { failures.push(rollbackError); }
  await fs.rm(t3ProcessPaths(stateDir).handoffPath, { force: true }).catch((handoffError) => failures.push(handoffError));
  try { await restoreServiceState(active, serviceOptions, serviceIsActive); } catch (restoreError) { failures.push(restoreError); }
  if (failures.length) throw updateError(`The update failed and automatic rollback could not restore the previous managed runtime (${error?.code ?? "update error"}).`, "UPDATE_ROLLBACK_FAILED", failures[0]);
}

async function restoreServiceState(wasActive, serviceOptions, serviceIsActive) {
  const activeNow = await serviceIsActive(serviceOptions).catch(() => false);
  if (wasActive && !activeNow) await startService(serviceOptions);
  else if (!wasActive && activeNow) await stopService(serviceOptions);
}

async function checkLocalT3(baseUrl, { fetchImpl } = {}) {
  await discoverT3({ candidates: [baseUrl], fetchImpl, timeoutMs: 1_000 });
  return true;
}

async function readVerifiedPackage(packageDir, expectedVersion, fs) {
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(join(packageDir, "package.json"), "utf8")); }
  catch { throw updateError("The downloaded connector package is missing or invalid.", "UPDATE_PACKAGE_INVALID"); }
  // A downloaded package must carry the current identity exactly. The legacy identity is only
  // tolerated for a runtime that is already installed and has to be verifiable for rollback.
  if (manifest.name !== PACKAGE_NAME || manifest.version !== expectedVersion || manifest.bin?.[PACKAGE_BIN_ENTRY] !== PACKAGE_BIN_PATH || manifest.engines?.node !== ">=22") {
    throw updateError("The downloaded connector package failed identity checks.", "UPDATE_PACKAGE_INVALID");
  }
  await fs.access(join(packageDir, "bin", "next-coder-connect.mjs"));
  return manifest;
}

async function runNpm(file, args, { env = process.env } = {}) {
  try {
    const result = await execFileAsync(file, args, { encoding: "utf8", maxBuffer: 1024 * 1024, env });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    throw updateError(`npm update command failed with code ${error?.code ?? "unknown"}.`, "UPDATE_COMMAND_FAILED");
  }
}

function validVersion(value) { return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value); }
function compareVersions(left, right) {
  const a = left.split("-")[0].split(".").map(Number);
  const b = right.split("-")[0].split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return left === right ? 0 : left.includes("-") ? -1 : 1;
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function updateError(message, code, cause) { return Object.assign(new Error(message, cause ? { cause } : undefined), { code }); }
