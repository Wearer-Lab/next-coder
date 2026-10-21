import { readFile } from "node:fs/promises";

import { readEnv } from "./environment.mjs";

const gatewayUrl = requiredEnv("NEXT_CODER_URL").replace(/\/+$/u, "");
const factoryToken = requiredEnv("FACTORY_TOKEN");

const body = {
  version: requiredEnv("FIRMWARE_VERSION"),
  channel: process.env.FIRMWARE_CHANNEL ?? "stable",
  hardwareModel: process.env.HARDWARE_MODEL ?? "e213-esp32-s3r8",
  mandatory: process.env.FIRMWARE_MANDATORY === "1",
  releaseNotes: process.env.FIRMWARE_RELEASE_NOTES ?? "",
};

const firmwareFile = process.env.FIRMWARE_FILE;
let response;
if (firmwareFile) {
  const artifact = await readFile(firmwareFile);
  const endpoint = new URL("/v1/factory/firmware/releases/upload", gatewayUrl);
  for (const [key, value] of Object.entries({ version: body.version, channel: body.channel,
    hardwareModel: body.hardwareModel, mandatory: body.mandatory ? "1" : "0", releaseNotes: body.releaseNotes })) {
    endpoint.searchParams.set(key, String(value));
  }
  response = await fetch(endpoint, { method: "POST", headers: {
    authorization: `Bearer ${factoryToken}`, "content-type": "application/octet-stream",
    "content-length": String(artifact.length),
  }, body: artifact });
} else {
  response = await fetch(new URL("/v1/factory/firmware/releases", gatewayUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${factoryToken}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body, url: requiredEnv("FIRMWARE_URL"),
      sha256: requiredEnv("FIRMWARE_SHA256"),
      sizeBytes: Number.parseInt(requiredEnv("FIRMWARE_SIZE_BYTES"), 10) }),
  });
}

const payload = await response.json();
if (!response.ok) {
  throw new Error(`Firmware publish failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
}

console.log(JSON.stringify(payload, null, 2));

function requiredEnv(name) {
  const value = readEnv(process.env, name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
