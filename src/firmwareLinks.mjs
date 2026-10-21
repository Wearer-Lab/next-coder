import { createHmac, timingSafeEqual } from "node:crypto";

const MANAGED_ARTIFACT_PATH = /^\/v1\/device\/firmware\/artifacts\/([a-f0-9]{64})$/u;

// The signed capability is minted and verified by this gateway, so both ends of the contract are
// here. A capability signed before the rename used the legacy prefix; it is still inside its
// short lifetime, so verification accepts it and only the current prefix is ever signed.
const FIRMWARE_CAPABILITY_PREFIX = "next-coder-firmware-v1";
const LEGACY_FIRMWARE_CAPABILITY_PREFIX = "agent-controller-firmware-v1";

export function buildFirmwareArtifactUrl({ release, baseUrl, signingKey, ttlSeconds = 600, now = Date.now() }) {
  const url = new URL(release.url, baseUrl);
  const match = url.pathname.match(MANAGED_ARTIFACT_PATH);
  if (!match) return url.toString();
  const expires = Math.floor(now / 1000) + ttlSeconds;
  url.searchParams.set("hardware", release.hardwareModel);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("token", signFirmwareArtifactCapability({
    sha256: match[1], hardwareModel: release.hardwareModel, expires, signingKey,
  }));
  return url.toString();
}

export function signFirmwareArtifactCapability({ sha256, hardwareModel, expires, signingKey }) {
  return createHmac("sha256", signingKey).update(capabilityPayload({ sha256, hardwareModel, expires })).digest("base64url");
}

export function verifyFirmwareArtifactCapability({ sha256, hardwareModel, expires, token, signingKey,
  ttlSeconds = 600, now = Date.now() }) {
  const expiry = Number(expires);
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isInteger(expiry) || expiry <= nowSeconds || expiry > nowSeconds + ttlSeconds) return false;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
  const expected = signFirmwareArtifactCapability({ sha256, hardwareModel, expires: expiry, signingKey });
  const left = Buffer.from(token);
  if (matches(left, expected)) return true;
  const legacy = createHmac("sha256", signingKey)
    .update(capabilityPayload({ sha256, hardwareModel, expires: expiry }, LEGACY_FIRMWARE_CAPABILITY_PREFIX))
    .digest("base64url");
  return matches(left, legacy);
}

function matches(left, expected) {
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function capabilityPayload({ sha256, hardwareModel, expires }, prefix = FIRMWARE_CAPABILITY_PREFIX) {
  return `${prefix}\n${sha256}\n${hardwareModel}\n${expires}`;
}
