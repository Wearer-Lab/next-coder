#!/usr/bin/env node
// Produce a board's controller_config.h for a given gateway, with a real trust anchor.
//
// Why this exists: a controller's seed decides which gateway it talks to and which certificate it
// will accept from that gateway. Two things make that hard to get right by hand.
//
//   1. The trust anchor. A cloud origin serves a public certificate chain whose leaf rotates every
//      few months. Pinning the leaf breaks on the next rotation; pinning the root survives it. The
//      root has to be a certificate that actually terminates the chain the server presents, which
//      for a Cloudflare workers.dev origin is a cross-signed root: the server sends the cross-signed
//      form, and the self-signed form is what a verifier should trust.
//
//   2. The pin map. The seed also carries the board's pins, audio bus and display geometry. The
//      repository's factory header generator emits a CrowPanel pin map, so it cannot be used for
//      another board as it stands. This script therefore REWRITES the named macros in the board's
//      existing seed instead of generating a new file, which keeps the board's own pin map intact.
//
// It never prints a secret. The OTA verifier key is written into the seed and the key's variable
// name is printed instead; no key value is echoed.
//
// Usage:
//   node scripts/build-device-seed.mjs \
//     --board firmware/Hosyond-ESP32-S3-2.8-Touchscreen \
//     --gateway https://agent-controller-cloud-staging.sergio-williomes.workers.dev \
//     --version 0.2.3 \
//     --out firmware/Hosyond-ESP32-S3-2.8-Touchscreen/include/controller_config.staging.h
//
// Options:
//   --board <dir>            board directory that holds include/controller_config.h
//   --gateway <https url>   the gateway origin the unit will talk to
//   --version <x.y.z>       FIRMWARE_VERSION for the image
//   --out <file>            where to write the seed (default: the board's own seed, in place)
//   --anchor <file.pem>     an explicit trust anchor (repeatable)
//   --no-os-anchors         do not look for anchors in the operating system trust store
//   --ota-key-from-env      take OTA_MANIFEST_VERIFY_KEY from OTA_SIGNING_KEY
//   --clear-ota-key         empty OTA_MANIFEST_VERIFY_KEY (a seed pointed at another gateway
//                           must not carry the previous gateway's key)
//   --print                 write the seed to stdout instead of a file
//
// The OS trust store is used only as a SOURCE of public root certificates. It is never copied
// wholesale into a device: an ESP32 stores one or two anchors, not a hundred.

import { createHash, X509Certificate } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { connect as tlsConnect } from "node:tls";

const boardDirectory = argument("--board") ?? "firmware/Hosyond-ESP32-S3-2.8-Touchscreen";
const gateway = argument("--gateway");
const version = argument("--version") ?? null;
const out = argument("--out") ?? null;
const anchorFiles = process.argv.reduce(
  (acc, value, index) => (value === "--anchor" ? [...acc, process.argv[index + 1]] : acc),
  [],
);
const useOsAnchors = !process.argv.includes("--no-os-anchors");
const otaKeyFromEnv = process.argv.includes("--ota-key-from-env");
const clearOtaKey = process.argv.includes("--clear-ota-key");
const printOnly = process.argv.includes("--print");

if (!gateway) throw new Error("--gateway is required.");
const gatewayUrl = new URL(gateway);
if (gatewayUrl.protocol !== "https:") throw new Error("--gateway must be https.");

const seedPath = `${boardDirectory}/include/controller_config.h`;
let seed = await readFile(seedPath, "utf8");

// ---------------------------------------------------------------------------------------------
// 1. What does the origin actually serve?
// ---------------------------------------------------------------------------------------------
const chain = await servedChain(gatewayUrl.hostname, Number(gatewayUrl.port || 443));
console.log(`origin   ${gatewayUrl.origin}`);
for (const [index, certificate] of chain.entries()) {
  console.log(`  chain[${index}] subject="${certificate.subject}" issuer="${certificate.issuer}"`);
}

// ---------------------------------------------------------------------------------------------
// 2. Which anchors terminate that chain?
// ---------------------------------------------------------------------------------------------
const chosen = [];
for (const anchor of await collectAnchors(chain, anchorFiles)) {
  if (chosen.some((existing) => existing.subject === anchor.subject)) continue;
  chosen.push(anchor);
}
// The most precise anchor goes first: the self-signed form of a certificate the server actually
// serves, before the broader root that issued it.
chosen.sort((left, right) => rank(left) - rank(right));
for (const anchor of chosen) {
  console.log(`  anchor  subject="${anchor.subject}" sha256=${anchor.fingerprint}`);
}
if (chosen.length === 0) {
  throw new Error(
    "No trust anchor found for this chain. Pass --anchor <root.pem> for the root that issued the chain's last certificate.",
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Rewrite the seed.
// ---------------------------------------------------------------------------------------------
seed = replaceDefine(seed, "GATEWAY_BASE_URL", quote(gatewayUrl.origin));
seed = replaceDefine(seed, "FIRMWARE_VERSION", quote(version ?? currentDefine(seed, "FIRMWARE_VERSION")));
seed = replaceDefine(seed, "INSECURE_SKIP_TLS_VERIFY", "0");
seed = replaceDefine(seed, "GATEWAY_TLS_ROOT_CA_PEM", pemLiteral(chosen[0].pem));
seed = replaceDefine(seed, "GATEWAY_TLS_NEXT_ROOT_CA_PEM", chosen[1] ? pemLiteral(chosen[1].pem) : '""');
if (otaKeyFromEnv) {
  const key = process.env.OTA_SIGNING_KEY;
  if (!key) throw new Error("OTA_SIGNING_KEY is not set.");
  seed = replaceDefine(seed, "OTA_MANIFEST_VERIFY_KEY", quote(key));
  console.log("  ota key OTA_MANIFEST_VERIFY_KEY set from OTA_SIGNING_KEY (value not printed)");
}
if (clearOtaKey) {
  // A seed pointed at a different gateway must not carry the previous gateway's verifier key:
  // the key belongs to the environment, and a stale one makes every manifest fail verification.
  seed = replaceDefine(seed, "OTA_MANIFEST_VERIFY_KEY", '""');
  console.log("  ota key OTA_MANIFEST_VERIFY_KEY cleared (set the target gateway's OTA_SIGNING_KEY)");
}

if (printOnly) {
  process.stdout.write(seed);
} else {
  const destination = out ?? seedPath;
  await writeFile(destination, seed);
  console.log(`seed     ${destination}`);
}

// ---------------------------------------------------------------------------------------------

async function servedChain(hostname, port) {
  // SNI is a hostname, never an address: Node refuses it for an IP literal, and a self-hosted
  // gateway on a LAN address is exactly the case where the certificate names something else.
  const isAddress = /^\d{1,3}(\.\d{1,3}){3}$/u.test(hostname);
  const options = { host: hostname, port, rejectUnauthorized: false };
  if (!isAddress) options.servername = hostname;
  return await new Promise((resolve, reject) => {
    const socket = tlsConnect(options, () => {
      const certificates = [];
      const seen = new Set();
      let current = socket.getPeerCertificate(true);
      while (current && current.raw) {
        // Node points a self-signed root's issuerCertificate back at itself, so the chain has to
        // be walked with a visited set or it never ends.
        const raw = current.raw;
        const marker = createHash("sha256").update(raw).digest("hex");
        if (seen.has(marker)) break;
        seen.add(marker);
        const parsed = new X509Certificate(raw);
        certificates.push({
          subject: oneLine(parsed.subject),
          issuer: oneLine(parsed.issuer),
          pem: parsed.toString(),
          fingerprint: parsed.fingerprint256,
          selfSigned: parsed.subject === parsed.issuer,
          checkIssued: (other) => parsed.checkIssued(other),
        });
        current = current.issuerCertificate;
      }
      socket.end();
      resolve(certificates);
    });
    socket.on("error", reject);
    socket.setTimeout(15000, () => reject(new Error(`TLS handshake timed out for ${hostname}:${port}`)));
  });
}

async function collectAnchors(certificates, explicitFiles) {
  const found = [];

  // An anchor already present in the served chain (a self-signed root the server sent) is the
  // best possible answer: it is provably the chain's terminator.
  for (const certificate of certificates) {
    if (certificate.selfSigned) found.push(certificate);
  }

  // A cloud origin usually serves a CROSS-signed root: the same subject and public key as the real
  // root, but a different issuer. Two anchors are then needed, and the device has two slots for
  // exactly this (GATEWAY_TLS_ROOT_CA_PEM and GATEWAY_TLS_NEXT_ROOT_CA_PEM):
  //
  //   * the SELF-SIGNED form of that subject — the same key as the cross-signed certificate the
  //     server sends, so a verifier that prefers its trust store terminates the chain there;
  //   * the root that ISSUED the cross-signed certificate — so a verifier that follows the served
  //     chain to the end also terminates at a trusted self-signed certificate.
  //
  // Pinning only one of them leaves a verifier that takes the other path with an unterminated
  // chain and a handshake that fails against a healthy origin.
  if (useOsAnchors) {
    const store = await osCertificates();
    for (const certificate of certificates) {
      if (certificate.selfSigned) continue;
      const sameSubject = store.find((candidate) => candidate.selfSigned
        && canonicalDn(candidate.subject) === canonicalDn(certificate.subject));
      if (sameSubject) found.push(sameSubject);
      const issuer = store.find((candidate) => candidate.selfSigned
        && canonicalDn(candidate.subject) === canonicalDn(certificate.issuer));
      if (issuer) found.push(issuer);
    }
  }

  for (const file of explicitFiles) {
    const pem = await readFile(file, "utf8");
    const parsed = new X509Certificate(pem);
    found.push({
      subject: oneLine(parsed.subject),
      issuer: oneLine(parsed.issuer),
      pem: parsed.toString(),
      fingerprint: parsed.fingerprint256,
      selfSigned: parsed.subject === parsed.issuer,
    });
  }
  return found;
}

// The operating system trust store: a source of public roots, never a wholesale copy.
async function osCertificates() {
  const candidates = [
    "/etc/ssl/cert.pem",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/certs/ca-certificates.crt",
  ];
  const results = [];
  for (const path of candidates) {
    let bundle;
    try {
      bundle = await readFile(path, "utf8");
    } catch {
      continue;
    }
    for (const pem of bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? []) {
      try {
        const parsed = new X509Certificate(pem);
        results.push({
          subject: oneLine(parsed.subject),
          issuer: oneLine(parsed.issuer),
          pem: parsed.toString(),
          fingerprint: parsed.fingerprint256,
          selfSigned: parsed.subject === parsed.issuer,
        });
      } catch {
        // A bundle can contain blocks this parser rejects; skip them rather than fail the run.
      }
    }
  }
  return results;
}

// Node prints distinguished names one component per line; a device operator reads them on one.
function oneLine(value) {
  return String(value).split("\n").map((part) => part.trim()).filter(Boolean).join(", ");
}

// Distinguished names compare as sets of components, not as strings: two bundles can order the
// components differently and still name the same certificate.
function canonicalDn(value) {
  return String(value).split(",").map((part) => part.trim().toLowerCase()).sort().join(",");
}

// 0: the anchor is the self-signed form of a certificate the server serves (most precise).
// 1: the anchor issued the last certificate the server serves (the chain's terminator).
function rank(anchor) {
  for (const certificate of chain) {
    if (!certificate.selfSigned && canonicalDn(anchor.subject) === canonicalDn(certificate.subject)) return 0;
  }
  return 1;
}

function pemLiteral(pem) {
  const escaped = pem.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n");
  return `"${escaped}"`;
}

function quote(value) {
  return `"${String(value).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function currentDefine(text, name) {
  const match = text.match(new RegExp(`^#define\\s+${name}\\s+(".*")$`, "mu"));
  return match ? match[1].replace(/^"|"$/gu, "") : "";
}

// Replace a #define, including a multi-line definition whose continuation lines end with a
// backslash. The whole block is replaced by one line, so a multi-line PEM cannot leave a
// continuation behind to be parsed as code.
function replaceDefine(text, name, value) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^#define\\s+${name}\\b`, "u").test(line));
  if (start < 0) throw new Error(`${name} is not defined in the seed; add it before running this script.`);
  let end = start;
  while (end < lines.length && lines[end].replace(/\s+$/u, "").endsWith("\\")) end += 1;
  lines.splice(start, end - start + 1, `#define ${name} ${value}`);
  return lines.join("\n");
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}
