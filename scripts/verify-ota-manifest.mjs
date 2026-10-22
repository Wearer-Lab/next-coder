#!/usr/bin/env node
// Check that a gateway's firmware manifest is one the device will accept.
//
// Why this exists: the device verifies an OTA manifest with an HMAC over a canonical JSON string
// that it rebuilds in C++ (firmware/shared/NextCoderCore/src/GatewayOta.cpp, canonicalManifest()).
// The gateway signs a canonical JSON string built by a different implementation
// (src/manufacturing.mjs, stableJson()). Two implementations of "the same" canonical form is a
// contract, and a contract that is only checked on the device is a contract that fails in the field
// as "manifest signature invalid" — with a 200 on the status report and nothing else to go on.
//
// This script answers, on a workstation, in seconds:
//   1. do the two canonical forms produce the same bytes?
//   2. does the device's HMAC over its own canonical form equal the signature the gateway shipped?
//   3. which key must the image carry (and is the key the one the gateway signs with)?
//
// It never prints a key, a token, or a device secret. The artifact capability in the manifest URL
// is redacted.
//
// Usage:
//   NEXT_CODER_URL=https://192.168.4.23:4443 \
//   FACTORY_TOKEN=... OTA_SIGNING_KEY=... \
//   node scripts/verify-ota-manifest.mjs --hardware-model ips28-esp32-s3r8 [--version 0.2.4]
//
// The gateway URL must be one the device itself can reach: the manifest URL is signed over the
// absolute artifact URL, and a different origin produces a different (also valid) signature.

import { createHmac } from "node:crypto";

import { readEnv } from "./environment.mjs";
import { buildFirmwareManifest } from "../src/manufacturing.mjs";
import { buildFirmwareArtifactUrl } from "../src/firmwareLinks.mjs";

const gatewayUrl = (readEnv(process.env, "NEXT_CODER_URL") ?? "").replace(/\/+$/u, "");
const factoryToken = readEnv(process.env, "FACTORY_TOKEN");
const signingKey = readEnv(process.env, "OTA_SIGNING_KEY");
const hardwareModel = argument("--hardware-model") ?? readEnv(process.env, "HARDWARE_MODEL") ?? "ips28-esp32-s3r8";
const wantedVersion = argument("--version") ?? null;

if (!gatewayUrl) throw new Error("NEXT_CODER_URL is required.");
if (!factoryToken) throw new Error("FACTORY_TOKEN is required.");
if (!signingKey) throw new Error("OTA_SIGNING_KEY is required.");

const response = await fetch(new URL(`/v1/factory/firmware/releases?hardwareModel=${encodeURIComponent(hardwareModel)}`, gatewayUrl), {
  headers: { authorization: `Bearer ${factoryToken}`, accept: "application/json" },
});
if (!response.ok) throw new Error(`Release list failed with HTTP ${response.status}.`);
const { releases } = await response.json();
const release = pick(releases, wantedVersion);
if (!release) {
  throw new Error(`No ${hardwareModel} release found${wantedVersion ? ` for version ${wantedVersion}` : ""}.`);
}

// The manifest the DEVICE receives is the one GET /v1/device/firmware builds: the release with its
// artifact URL rewritten to an absolute, signed-capability URL, signed over that rewritten URL.
const manifest = buildFirmwareManifest({
  ...release,
  url: buildFirmwareArtifactUrl({ release, baseUrl: gatewayUrl, signingKey, ttlSeconds: 600 }),
}, signingKey);

// 1. The gateway's canonical form (src/manufacturing.mjs, stableJson).
const gatewayCanonical = stableJson({
  version: manifest.version,
  channel: manifest.channel,
  hardwareModel: manifest.hardwareModel,
  url: manifest.url,
  sha256: manifest.sha256,
  sizeBytes: manifest.sizeBytes,
  mandatory: manifest.mandatory,
  releaseNotes: manifest.releaseNotes,
  createdAt: manifest.createdAt,
});

// 2. The device's canonical form (firmware/shared/NextCoderCore/src/GatewayOta.cpp, canonicalManifest).
const deviceCanonical = canonicalManifest(manifest);

const canonicalMatches = gatewayCanonical === deviceCanonical;
const deviceSignature = createHmac("sha256", signingKey).update(deviceCanonical).digest("hex");
const signatureMatches = deviceSignature === manifest.signature;

console.log(`release        ${release.channel}/${release.version} hardware=${release.hardwareModel}`);
console.log(`mandatory      ${Boolean(release.mandatory)}  sizeBytes=${release.sizeBytes}`);
console.log(`sha256         ${release.sha256}`);
console.log(`artifact url   ${redact(manifest.url)}`);
console.log(`canonical      ${canonicalMatches ? "gateway form == device form" : "MISMATCH"}`);
console.log(`signature      ${signatureMatches ? "device HMAC == gateway signature" : "MISMATCH"}`);
console.log("");

if (!canonicalMatches) {
  console.log("gateway canonical:", gatewayCanonical);
  console.log("device  canonical:", deviceCanonical);
  console.log("");
}

console.log("The image must be built with the SAME key the gateway signs with:");
console.log("  NEXT_CODER_OTA_VERIFY_KEY=<the gateway's OTA_SIGNING_KEY> pio run -e <board env>");
console.log("and REQUIRE_OTA_SIGNATURE=1 / ENABLE_OTA_APPLY=1 in that environment.");

// Mirror of src/manufacturing.mjs stableJson().
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

// Mirror of the device's jsonString() in GatewayOta.cpp.
function jsonString(text) {
  let output = "\"";
  for (const character of String(text)) {
    if (character === "\"" || character === "\\") output += "\\";
    output += character;
  }
  return `${output}\"`;
}

// Mirror of the device's canonicalManifest() in GatewayOta.cpp.
function canonicalManifest(manifest) {
  let output = "{";
  output += `"channel":${jsonString(manifest["channel"] ?? "stable")}`;
  output += `,"createdAt":${jsonString(manifest["createdAt"] ?? "")}`;
  output += `,"hardwareModel":${jsonString(manifest["hardwareModel"] ?? "")}`;
  output += `,"mandatory":${manifest["mandatory"] ? "true" : "false"}`;
  output += `,"releaseNotes":${jsonString(manifest["releaseNotes"] ?? "")}`;
  output += `,"sha256":${jsonString(manifest["sha256"] ?? "")}`;
  output += `,"sizeBytes":${String(manifest["sizeBytes"] ?? 0)}`;
  output += `,"url":${jsonString(manifest["url"] ?? "")}`;
  output += `,"version":${jsonString(manifest["version"] ?? "")}`;
  return `${output}}`;
}

function pick(releases, version) {
  const rows = Array.isArray(releases) ? releases : [];
  if (version) return rows.find((row) => row.version === version) ?? null;
  return rows
    .filter((row) => (row.channel ?? "stable") === "stable")
    .sort((left, right) => compareVersions(right.version, left.version))[0] ?? rows[0] ?? null;
}

function compareVersions(left, right) {
  const parse = (value) => String(value).replace(/^v/u, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function redact(url) {
  return String(url).replace(/([?&](?:token|expires)=)[^&]+/gu, "$1<redacted>");
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

if (!canonicalMatches || !signatureMatches) process.exitCode = 1;
