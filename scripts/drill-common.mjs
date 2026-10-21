// Shared machinery for the Phase 4 staging drills (scripts/drill-*.mjs).
//
// The conventions here are copied deliberately from scripts/qualify-staging.mjs, because a drill
// record has to be readable next to a qualification record in the same evidence bundle:
//
//   * dependency-free ESM, no build step;
//   * the target origin is an explicit --base-url argument and nothing else;
//   * credentials are read ONLY from the environment or a mode-0600 file, never from argv, so a
//     token never enters shell history, `ps` output, or a CI command line;
//   * every mutating step is behind an explicit opt-in flag and is refused without it;
//   * evidence is redacted JSON on stdout: opaque references, bounded codes, no server bodies;
//   * a check that did not run is emitted as `skipped`, never as a pass.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";

import { readEnv } from "./environment.mjs";

export const DRILL_SCHEMA = "next-coder.staging-drill.v1";
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class DrillError extends Error {
  constructor(code, httpStatus = null) {
    super(code);
    this.name = "DrillError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/* -------------------------------------------------------------------------- configuration --- */

export function normalizeBaseUrl(input = {}) {
  const rawBaseUrl = nonEmpty(input.baseUrl);
  if (!rawBaseUrl) throw new DrillError("base_url_required");
  let baseUrl;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new DrillError("base_url_invalid");
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash
    || (baseUrl.pathname !== "/" && baseUrl.pathname !== "")) {
    throw new DrillError("base_url_must_be_origin");
  }
  const loopback = isLoopback(baseUrl.hostname);
  if (baseUrl.protocol !== "https:"
    && !(input.allowHttpLoopback === true && loopback && baseUrl.protocol === "http:")) {
    throw new DrillError("https_required");
  }
  if (!loopback && isIP(baseUrl.hostname)) throw new DrillError("hostname_required");
  return baseUrl;
}

export function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function oneOf(value, allowed, code) {
  if (!allowed.includes(value)) throw new DrillError(code);
  return value;
}

export function boundedInteger(value, fallback, minimum, maximum, code) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new DrillError(code);
  return parsed;
}

function isLoopback(hostname) {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/* ------------------------------------------------------------------------------- arguments --- */

// A generic option parser shared by every drill. `valueOptions` and `flagOptions` map the literal
// CLI token to a parsed key. There is deliberately no option that accepts a secret as a value.
export function parseDrillArguments(argv, {
  environment = process.env,
  envDefaults = {},
  valueOptions = {},
  flagOptions = {},
  fileOptions = {},
} = {}) {
  const parsed = {};
  for (const [key, variable] of Object.entries(envDefaults)) parsed[key] = readEnv(environment, variable);
  for (const key of Object.values(flagOptions)) parsed[key] = parsed[key] === true;

  const values = new Map(Object.entries(valueOptions));
  const flags = new Map(Object.entries(flagOptions));
  const files = new Map(Object.entries(fileOptions));

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (flags.has(argument)) {
      parsed[flags.get(argument)] = true;
      continue;
    }
    const file = files.get(argument);
    if (file) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new DrillError("option_value_required");
      parsed[file.pathKey] = value;
      index += 1;
      continue;
    }
    const key = values.get(argument);
    if (!key) throw new DrillError("unknown_option");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new DrillError("option_value_required");
    parsed[key] = value;
    index += 1;
  }

  for (const file of files.values()) {
    if (parsed[file.valueKey] && parsed[file.pathKey]) throw new DrillError(file.conflictCode);
  }
  return parsed;
}

export async function loadPrivateTextFile(path, {
  emptyCode,
  notFileCode,
  permissionsCode,
  tooLargeCode,
  maxBytes,
}) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new DrillError(notFileCode);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new DrillError(permissionsCode);
  }
  const content = await readFile(path, { encoding: "utf8" });
  if (Buffer.byteLength(content) > maxBytes) throw new DrillError(tooLargeCode);
  const value = content.trim();
  if (!value) throw new DrillError(emptyCode);
  return value;
}

export async function loadAccessTokenFile(path) {
  return await loadPrivateTextFile(path, {
    emptyCode: "access_token_file_empty",
    notFileCode: "access_token_path_not_file",
    permissionsCode: "access_token_file_permissions_unsafe",
    tooLargeCode: "access_token_file_too_large",
    maxBytes: 16 * 1024,
  });
}

export const ACCESS_TOKEN_FILE_OPTION = {
  "--access-token-file": {
    valueKey: "accessToken",
    pathKey: "accessTokenFile",
    conflictCode: "one_access_token_source_required",
  },
};

/* --------------------------------------------------------------------------------- requests --- */

export function createRequester({ baseUrl, fetchImpl, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  const impl = fetchImpl ?? globalThis.fetch;

  async function send(path, { method = "GET", headers = {}, body, rawBody, contentType } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const hasRaw = rawBody !== undefined && rawBody !== null;
      const payloadType = hasRaw ? contentType : (body === undefined ? null : "application/json");
      return await impl(new URL(path, baseUrl), {
        method,
        headers: {
          accept: "application/json",
          ...(payloadType ? { "content-type": payloadType } : {}),
          ...headers,
        },
        body: hasRaw ? rawBody : (body === undefined ? undefined : JSON.stringify(body)),
        redirect: "error",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function request(path, options = {}) {
    try {
      const response = await send(path, options);
      return { status: response.status, body: await readJsonBounded(response) };
    } catch (error) {
      if (error instanceof DrillError) throw error;
      if (error?.name === "AbortError") throw new DrillError("request_timeout");
      throw new DrillError("request_failed");
    }
  }

  // Reads bytes rather than JSON, and keeps only their length and digest. Used to prove a media
  // round trip without ever putting user content in evidence.
  async function requestBinary(path, options = {}) {
    try {
      const response = await send(path, options);
      const bytes = await readBytesBounded(response);
      return {
        status: response.status,
        length: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        contentType: String(response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase(),
        declaredSha256: response.headers.get("x-media-sha256"),
      };
    } catch (error) {
      if (error instanceof DrillError) throw error;
      if (error?.name === "AbortError") throw new DrillError("request_timeout");
      throw new DrillError("request_failed");
    }
  }

  return { request, requestBinary };
}

async function readBytesBounded(response) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new DrillError("response_too_large");
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new DrillError("response_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJsonBounded(response) {
  const bytes = await readBytesBounded(response);
  if (bytes.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DrillError("invalid_json_response");
  }
}

/* ------------------------------------------------------------------------------ assertions --- */

export function requireStatus(response, status, code) {
  const expected = Array.isArray(status) ? status : [status];
  if (!expected.includes(response.status)) throw new DrillError(code, response.status);
}

export function requireCondition(condition, code) {
  if (!condition) throw new DrillError(code);
}

export function requireRecord(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DrillError(code);
  return value;
}

export function requireArray(value, code) {
  if (!Array.isArray(value)) throw new DrillError(code);
  return value;
}

export function requireIdentifier(value, code) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new DrillError(code);
  return value;
}

export function requireSecret(value, code) {
  if (typeof value !== "string" || value.trim().length < 16) throw new DrillError(code);
  return value;
}

export function requireFresh(value, maxAgeMs, currentTime, code) {
  const observedAt = Date.parse(value ?? "");
  if (!Number.isFinite(observedAt) || observedAt > currentTime + 30_000 || currentTime - observedAt > maxAgeMs) {
    throw new DrillError(code);
  }
}

// The details the gateway attaches to an HttpError are a bounded contract (src/http.mjs); the
// message is not, so only the machine-readable code is ever read out of a failure body.
export function errorDetailCode(body) {
  const code = body?.error?.details?.code;
  return typeof code === "string" ? code : null;
}

export function opaqueRef(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex").slice(0, 16)}`;
}

export function safeErrorCode(error, fallback) {
  return error instanceof DrillError ? error.code : fallback;
}

export function safeHttpStatus(error) {
  return error instanceof DrillError && Number.isInteger(error.httpStatus) ? error.httpStatus : null;
}

/* --------------------------------------------------------------------------------- evidence --- */

export async function runCheck(checks, name, now, operation) {
  const started = now();
  try {
    const detail = await operation();
    checks.push(passed(name, Math.max(0, now() - started), detail));
    return true;
  } catch (error) {
    checks.push(failed(name, Math.max(0, now() - started), safeErrorCode(error, "check_failed"), safeHttpStatus(error)));
    return false;
  }
}

// The envelope wins. A check detail is drill-authored data and must never be able to overwrite the
// check's own name, outcome, duration or failure code by choosing a colliding key: an evidence
// record whose `status` came from a payload would be exactly the kind of quiet lie this repository
// refuses to file.
// `httpStatus` is deliberately not reserved: it is a legitimate detail on a passing check and is
// only ever set from the envelope on a failing one, where the detail is empty.
const RESERVED_CHECK_FIELDS = ["name", "status", "durationMs", "code"];

function withEnvelope(detail, envelope) {
  const body = {};
  for (const [key, value] of Object.entries(detail ?? {})) {
    if (!RESERVED_CHECK_FIELDS.includes(key)) body[key] = value;
  }
  return { ...envelope, ...body, ...envelope };
}

export function passed(name, durationMs, detail = {}) {
  return withEnvelope(detail, { name, status: "passed", durationMs });
}

export function failed(name, durationMs, code, httpStatus) {
  return withEnvelope({}, { name, status: "failed", durationMs, code, ...(httpStatus ? { httpStatus } : {}) });
}

export function skipped(name, code) {
  return withEnvelope({}, { name, status: "skipped", durationMs: 0, code });
}

// `result` is "passed" only when every declared check ran and passed. A skipped check — including
// every mutating check of a preflight run — makes the record non-passing on purpose, so a
// half-executed drill can never be filed as proof.
export function finishEvidence({ drill, mode, checks, startedAtMs, now, target }) {
  const finishedAtMs = now();
  const passedCount = checks.filter((check) => check.status === "passed").length;
  const failedCount = checks.filter((check) => check.status === "failed").length;
  const skippedCount = checks.filter((check) => check.status === "skipped").length;
  return {
    schema: DRILL_SCHEMA,
    drill,
    mode,
    result: failedCount === 0 && skippedCount === 0 ? "passed" : "failed",
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    target: target ? { origin: target } : null,
    summary: { passed: passedCount, failed: failedCount, skipped: skippedCount },
    checks,
  };
}

export function configurationFailureEvidence({ drill, code }) {
  const now = Date.now();
  return finishEvidence({
    drill,
    mode: "preflight",
    checks: [failed("configuration", 0, code)],
    startedAtMs: now,
    now: () => now,
    target: null,
  });
}

/* ---------------------------------------------------------------------------------- helpers --- */

// Every drill identifier is generated, never operator-supplied, so a repeated run can never
// collide with an earlier run's durable request envelope.
export function drillId(prefix) {
  return `${prefix}-${createHash("sha256")
    .update(`${Date.now()}:${Math.random()}:${process.pid}`)
    .digest("hex")
    .slice(0, 24)}`;
}

export async function emitEvidence(evidence, write = (text) => process.stdout.write(text)) {
  write(`${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}
