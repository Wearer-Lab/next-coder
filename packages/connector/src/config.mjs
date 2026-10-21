import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { credentialAccounts, CREDENTIAL_STORE_VERSION } from "./credentialStore.mjs";

export const STATE_VERSION = 1;

// The state directory is named after the product. A directory created before the rename still
// holds the enrollment and the credential accounts, so it stays the active one until a new
// directory exists; the credential account names are derived from this path, so moving it would
// orphan the stored credential.
const STATE_DIR_NAMES = Object.freeze({ darwin: "Next Coder", win32: "Next Coder", linux: "next-coder" });
const LEGACY_STATE_DIR_NAMES = Object.freeze({ darwin: "Agent Controller", win32: "Agent Controller", linux: "agent-controller" });

export function defaultStateDir(env = process.env) {
  // NEXT_CODER_CONFIG_DIR is read first; the legacy name stays readable so an installation that
  // exported it before the rename keeps using the same state directory.
  if (env.NEXT_CODER_CONFIG_DIR) return resolve(env.NEXT_CODER_CONFIG_DIR);
  if (env.AGENT_CONTROLLER_CONFIG_DIR) return resolve(env.AGENT_CONTROLLER_CONFIG_DIR);
  const current = stateDirFor(STATE_DIR_NAMES, env);
  const legacy = stateDirFor(LEGACY_STATE_DIR_NAMES, env);
  if (legacy !== current && !existsSync(current) && existsSync(legacy)) return legacy;
  return current;
}

function stateDirFor(names, env) {
  const name = names[platform()] ?? names.linux;
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", name);
  if (platform() === "win32") {
    return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), name);
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), name);
}

export function statePath(stateDir = defaultStateDir()) {
  const directory = resolve(stateDir);
  if (directory === parse(directory).root || directory === resolve(homedir())) {
    throw new Error("The connector state directory must be a dedicated subdirectory, not a filesystem or home-directory root.");
  }
  return join(directory, "connector.json");
}

export function runtimeStatePath(stateDir = defaultStateDir()) {
  return join(dirname(statePath(stateDir)), "connector-runtime.json");
}

export async function loadState(stateDir, { requireSecure = false, credentialStore = null, migrateCredential = true } = {}) {
  const path = statePath(stateDir);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (requireSecure && platform() !== "win32") {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) throw stateError(`Connector state permissions are too broad (${(info.mode & 0o777).toString(8)}); restrict the connector state file to mode 0600.`, "STATE_PERMISSIONS");
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    const error = new Error(`Connector state is not valid JSON: ${path}`);
    error.code = "STATE_CORRUPT";
    throw error;
  }
  validatePersistedState(state);
  if (state.credentialStorage) {
    assertCredentialStore(state.credentialStorage, credentialStore);
    const accounts = credentialAccounts(stateDir, state.connectorId, state.credentialRotation?.id);
    const primaryAccount = state.credentialStorage.primarySlot === "a" ? accounts.primaryA : accounts.primaryB;
    const secret = await credentialStore.read(primaryAccount);
    if (!secret) throw stateError("The connector credential is missing from the native credential store.", "CREDENTIAL_NOT_FOUND");
    let credentialRotation = state.credentialRotation;
    if (credentialRotation) {
      const pendingSecret = await credentialStore.read(accounts.pending);
      if (!pendingSecret) throw stateError("The staged connector credential is missing from the native credential store.", "CREDENTIAL_ROTATION_NOT_FOUND");
      credentialRotation = { ...credentialRotation, pendingSecret };
    }
    const hydrated = { ...state, secret, ...(credentialRotation ? { credentialRotation } : {}) };
    validateState(hydrated);
    return await mergeRuntimeState(stateDir, hydrated);
  }
  validateState(state);
  if (credentialStore?.native && migrateCredential) {
    await saveState(stateDir, state, { credentialStore });
    return await loadState(stateDir, { requireSecure, credentialStore, migrateCredential: false });
  }
  return await mergeRuntimeState(stateDir, state);
}

export async function saveState(stateDir, state, { credentialStore = null } = {}) {
  validateState(state);
  const durableState = stripRuntimeFields(state);
  if (credentialStore?.native) return await saveNativeState(stateDir, durableState, credentialStore);
  if (state.credentialStorage) {
    throw stateError("The connector was enrolled with a native credential store that is not available in this process.", "CREDENTIAL_STORE_UNAVAILABLE");
  }
  return await writeStateFile(stateDir, durableState);
}

export async function saveRuntimeState(stateDir, state) {
  if (!state || typeof state.connectorId !== "string" || !state.connectorId || typeof state.environmentId !== "string" || !state.environmentId) {
    throw stateError("Connector runtime state is missing its enrollment identity.", "RUNTIME_STATE_INVALID");
  }
  const runtimeError = sanitizeRuntimeError(state.lastConnectionError);
  const runtime = {
    version: 1,
    connectorId: state.connectorId,
    environmentId: state.environmentId,
    ...(validTimestamp(state.lastConnectedAt) ? { lastConnectedAt: state.lastConnectedAt } : {}),
    ...(validTimestamp(state.lastConnectionAttemptAt) ? { lastConnectionAttemptAt: state.lastConnectionAttemptAt } : {}),
    ...(state.lastConnectionError == null || runtimeError ? { lastConnectionError: runtimeError } : {}),
    ...(typeof state.lastEventCursor === "string" || Number.isSafeInteger(state.lastEventCursor) ? { lastEventCursor: state.lastEventCursor } : {}),
    ...(Array.isArray(state.completedRequests) ? { completedRequests: state.completedRequests.slice(0, 1_000) } : {}),
    ...(state.credentialRotation?.id && validTimestamp(state.credentialRotation.acknowledgedAt)
      ? { credentialRotationAcknowledgement: { id: state.credentialRotation.id, acknowledgedAt: state.credentialRotation.acknowledgedAt } }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  return await writePrivateJson(runtimeStatePath(stateDir), runtime);
}

async function writeStateFile(stateDir, state) {
  const path = statePath(stateDir);
  await writePrivateJson(path, state);
  return path;
}

async function writePrivateJson(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => {});
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
  return path;
}

export async function removeState(stateDir, { credentialStore = null } = {}) {
  const persisted = await readPersistedState(stateDir);
  if (persisted?.credentialStorage) {
    assertCredentialStore(persisted.credentialStorage, credentialStore);
    const accounts = credentialAccounts(stateDir, persisted.connectorId, persisted.credentialRotation?.id);
    // Delete the non-authoritative values first. If a native operation fails,
    // the JSON pointer and active credential remain intact for a safe retry.
    if (accounts.pending) await credentialStore.delete(accounts.pending);
    const active = persisted.credentialStorage.primarySlot === "a" ? accounts.primaryA : accounts.primaryB;
    const inactive = persisted.credentialStorage.primarySlot === "a" ? accounts.primaryB : accounts.primaryA;
    await credentialStore.delete(inactive);
    await credentialStore.delete(active);
  }
  await rm(statePath(stateDir), { force: true });
  await rm(runtimeStatePath(stateDir), { force: true });
}

export async function inspectStatePermissions(stateDir) {
  const path = statePath(stateDir);
  try {
    const info = await stat(path);
    return { path, exists: true, mode: info.mode & 0o777, secure: platform() === "win32" || (info.mode & 0o077) === 0 };
  } catch (error) {
    if (error?.code === "ENOENT") return { path, exists: false, mode: null, secure: true };
    throw error;
  }
}

export function validateState(state) {
  if (!state || state.version !== STATE_VERSION) throw stateError("Unsupported connector state version.");
  for (const key of ["server", "connectorId", "environmentId", "secret", "t3BaseUrl"]) {
    if (typeof state[key] !== "string" || state[key].length === 0) throw stateError(`Connector state is missing ${key}.`);
  }
  validateHttpUrl(state.server, "server", { allowHttpLoopback: true });
  validateHttpUrl(state.t3BaseUrl, "T3 URL", { allowHttpLoopback: true });
  if (state.credentialRotation != null) {
    const rotation = state.credentialRotation;
    if (!rotation || typeof rotation !== "object"
      || typeof rotation.id !== "string" || !rotation.id
      || typeof rotation.pendingSecret !== "string" || !rotation.pendingSecret
      || !["staged", "activated"].includes(rotation.phase)
      || !Number.isFinite(Date.parse(rotation.expiresAt ?? ""))) {
      throw stateError("Connector state contains an invalid credential rotation journal.");
    }
  }
  return state;
}

function validatePersistedState(state) {
  if (!state || state.version !== STATE_VERSION) throw stateError("Unsupported connector state version.");
  for (const key of ["server", "connectorId", "environmentId", "t3BaseUrl"]) {
    if (typeof state[key] !== "string" || state[key].length === 0) throw stateError(`Connector state is missing ${key}.`);
  }
  const storage = state.credentialStorage;
  const hasPlaintext = typeof state.secret === "string" && state.secret.length > 0;
  if (!hasPlaintext && !storage) throw stateError("Connector state is missing secret.");
  if (storage) {
    if (storage.version !== CREDENTIAL_STORE_VERSION || typeof storage.backend !== "string" || !storage.backend || !["a", "b"].includes(storage.primarySlot) || Object.hasOwn(state, "secret")) {
      throw stateError("Connector state contains invalid native credential metadata.", "CREDENTIAL_METADATA_INVALID");
    }
  }
  validateHttpUrl(state.server, "server", { allowHttpLoopback: true });
  validateHttpUrl(state.t3BaseUrl, "T3 URL", { allowHttpLoopback: true });
  if (state.credentialRotation != null) {
    const rotation = state.credentialRotation;
    const pendingStored = storage && !Object.hasOwn(rotation, "pendingSecret");
    if (storage && Object.hasOwn(rotation, "pendingSecret")) throw stateError("Native connector state must not contain a plaintext staged credential.", "CREDENTIAL_METADATA_INVALID");
    if (!rotation || typeof rotation !== "object"
      || typeof rotation.id !== "string" || !rotation.id
      || (!pendingStored && (typeof rotation.pendingSecret !== "string" || !rotation.pendingSecret))
      || !["staged", "activated"].includes(rotation.phase)
      || !Number.isFinite(Date.parse(rotation.expiresAt ?? ""))) {
      throw stateError("Connector state contains an invalid credential rotation journal.");
    }
  }
  return state;
}

async function saveNativeState(stateDir, state, credentialStore) {
  const existing = await readPersistedState(stateDir);
  if (existing?.credentialStorage) assertCredentialStore(existing.credentialStorage, credentialStore);
  const existingStorage = existing?.credentialStorage ?? null;
  const accounts = credentialAccounts(stateDir, state.connectorId, state.credentialRotation?.id);
  let primarySlot = existingStorage?.primarySlot ?? "a";
  let activeAccount = primarySlot === "a" ? accounts.primaryA : accounts.primaryB;
  const existingSecret = existingStorage && existing.connectorId === state.connectorId ? await credentialStore.read(activeAccount) : null;
  const primaryChanged = !sameSecret(existingSecret, state.secret);
  if (primaryChanged) {
    primarySlot = existingStorage?.primarySlot === "a" ? "b" : "a";
    activeAccount = primarySlot === "a" ? accounts.primaryA : accounts.primaryB;
    await writeAndVerify(credentialStore, activeAccount, state.secret);
  }
  let pendingWritten = false;
  if (state.credentialRotation) {
    const oldPending = existing?.credentialRotation?.id === state.credentialRotation.id && existingStorage ? await credentialStore.read(accounts.pending) : null;
    if (!sameSecret(oldPending, state.credentialRotation.pendingSecret)) {
      await writeAndVerify(credentialStore, accounts.pending, state.credentialRotation.pendingSecret);
      pendingWritten = true;
    }
  }
  const sanitized = {
    ...state,
    credentialStorage: { version: CREDENTIAL_STORE_VERSION, backend: credentialStore.backend, primarySlot },
  };
  delete sanitized.secret;
  if (sanitized.credentialRotation) {
    sanitized.credentialRotation = { ...sanitized.credentialRotation };
    delete sanitized.credentialRotation.pendingSecret;
  }
  let path;
  try {
    path = await writeStateFile(stateDir, sanitized);
  } catch (error) {
    if (primaryChanged) await credentialStore.delete(activeAccount).catch(() => {});
    if (pendingWritten) await credentialStore.delete(accounts.pending).catch(() => {});
    throw error;
  }
  // Cleanup occurs only after the atomic pointer commit. Cleanup failures are
  // surfaced, but the new active entry is never rolled back after JSON points
  // at it; a retry can safely remove the bounded inactive slot.
  if (existingStorage && existing.connectorId === state.connectorId) {
    const inactiveAccount = primarySlot === "a" ? accounts.primaryB : accounts.primaryA;
    await credentialStore.delete(inactiveAccount);
  } else if (existingStorage && existing.connectorId !== state.connectorId) {
    const oldAccounts = credentialAccounts(stateDir, existing.connectorId, existing.credentialRotation?.id);
    if (oldAccounts.pending) await credentialStore.delete(oldAccounts.pending);
    await credentialStore.delete(oldAccounts.primaryA);
    await credentialStore.delete(oldAccounts.primaryB);
  }
  const previousRotationId = existing?.credentialRotation?.id;
  if (previousRotationId && previousRotationId !== state.credentialRotation?.id) {
    await credentialStore.delete(credentialAccounts(stateDir, existing.connectorId, previousRotationId).pending);
  }
  return path;
}

async function writeAndVerify(store, account, secret) {
  await store.write(account, secret);
  const observed = await store.read(account);
  if (!sameSecret(observed, secret)) {
    await store.delete(account).catch(() => {});
    throw stateError("Native credential store verification failed.", "CREDENTIAL_STORE_VERIFY");
  }
}

async function readPersistedState(stateDir) {
  try {
    const state = JSON.parse(await readFile(statePath(stateDir), "utf8"));
    validatePersistedState(state);
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw stateError("Connector state is not valid JSON.", "STATE_CORRUPT");
    throw error;
  }
}

function assertCredentialStore(metadata, credentialStore) {
  if (!credentialStore?.native || credentialStore.backend !== metadata.backend) {
    throw stateError(`Connector credential requires ${metadata.backend}, but that native store is unavailable. Restore that user session or credential store; plaintext fallback is intentionally disabled for enrolled native credentials.`, "CREDENTIAL_STORE_UNAVAILABLE");
  }
}

function sameSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function mergeRuntimeState(stateDir, state) {
  let runtime;
  try { runtime = JSON.parse(await readFile(runtimeStatePath(stateDir), "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return state;
    if (error instanceof SyntaxError) throw stateError("Connector runtime state is not valid JSON.", "RUNTIME_STATE_CORRUPT");
    throw error;
  }
  if (!runtime || runtime.version !== 1 || runtime.connectorId !== state.connectorId || runtime.environmentId !== state.environmentId) return state;
  const merged = { ...state };
  if (validTimestamp(runtime.lastConnectedAt)) merged.lastConnectedAt = runtime.lastConnectedAt;
  if (validTimestamp(runtime.lastConnectionAttemptAt)) merged.lastConnectionAttemptAt = runtime.lastConnectionAttemptAt;
  const runtimeError = sanitizeRuntimeError(runtime.lastConnectionError);
  if (runtimeError !== undefined) merged.lastConnectionError = runtimeError;
  if (typeof runtime.lastEventCursor === "string" || Number.isSafeInteger(runtime.lastEventCursor)) merged.lastEventCursor = runtime.lastEventCursor;
  if (Array.isArray(runtime.completedRequests)) merged.completedRequests = runtime.completedRequests.slice(0, 1_000);
  if (merged.credentialRotation?.id && merged.credentialRotation.id === runtime.credentialRotationAcknowledgement?.id && validTimestamp(runtime.credentialRotationAcknowledgement?.acknowledgedAt)) {
    merged.credentialRotation = { ...merged.credentialRotation, acknowledgedAt: runtime.credentialRotationAcknowledgement.acknowledgedAt };
  }
  return merged;
}

function stripRuntimeFields(state) {
  const durable = { ...state };
  for (const key of ["lastConnectedAt", "lastConnectionAttemptAt", "lastConnectionError", "lastEventCursor", "completedRequests"]) delete durable[key];
  if (durable.credentialRotation?.acknowledgedAt) {
    durable.credentialRotation = { ...durable.credentialRotation };
    delete durable.credentialRotation.acknowledgedAt;
  }
  return durable;
}

function validTimestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function sanitizeRuntimeError(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.message !== "string" || value.message.length > 1_024 || (value.code != null && (typeof value.code !== "string" || value.code.length > 128))) return undefined;
  return {
    name: typeof value.name === "string" && value.name.length <= 128 ? value.name : "Error",
    ...(value.code ? { code: value.code } : {}),
    message: value.message,
  };
}

export function validateHttpUrl(value, label, { allowHttpLoopback = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  if (url.username || url.password) throw new Error(`${label} must not contain embedded credentials.`);
  if (url.protocol === "https:") return url.toString().replace(/\/$/, "");
  if (allowHttpLoopback && url.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    return url.toString().replace(/\/$/, "");
  }
  throw new Error(`${label} must use HTTPS${allowHttpLoopback ? " (HTTP is allowed only for loopback)" : ""}.`);
}

function stateError(message, code = "STATE_INVALID") {
  const error = new Error(message);
  error.code = code;
  return error;
}
