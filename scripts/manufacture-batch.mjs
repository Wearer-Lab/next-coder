import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readEnv } from "./environment.mjs";

import {
  buildDeviceClaimPayload,
  buildDeviceClaimQrAscii,
  buildDeviceLabelSvg,
  claimLabelFilename,
} from "../src/manufacturing.mjs";

const gatewayUrl = requiredEnv("NEXT_CODER_URL").replace(/\/+$/u, "");
const factoryToken = requiredEnv("FACTORY_TOKEN");
const outputDir = process.env.OUTPUT_DIR ?? ".manufacturing";
const count = Number.parseInt(process.env.COUNT ?? "1", 10);

const body = {
  count,
  labelPrefix: process.env.LABEL_PREFIX ?? "Next Coder",
  profile: process.env.DEVICE_PROFILE ?? "next-coder",
  gatewayBaseUrl: process.env.PUBLIC_GATEWAY_URL ?? gatewayUrl,
  // No WIFI_SSID/WIFI_PASSWORD: a shipped unit takes its network from the owner through the
  // on-device SoftAP portal, so anything the factory baked in could only ever be wrong.
  hardwareModel: process.env.HARDWARE_MODEL ?? "e213-esp32-s3r8",
  firmwareVersion: process.env.FIRMWARE_VERSION ?? "0.1.0",
  enableOtaApply: process.env.ENABLE_OTA_APPLY === "1",
  requireOtaSignature: process.env.REQUIRE_OTA_SIGNATURE === "1",
  otaManifestVerifyKey: process.env.OTA_MANIFEST_VERIFY_KEY ?? "",
};

const response = await fetch(new URL("/v1/factory/batches", gatewayUrl), {
  method: "POST",
  headers: {
    authorization: `Bearer ${factoryToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
});

const payload = await response.json();
if (!response.ok) {
  throw new Error(`Batch provisioning failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
}

const claimBaseUrl = payload.batch?.gatewayBaseUrl ?? body.gatewayBaseUrl;
const qrStyle = process.env.QR_STYLE ?? "half";
const qrAnsi = process.env.QR_ANSI === "0" ? false : Boolean(process.stdout.isTTY);

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, "batch.json"), JSON.stringify(payload, null, 2));

const labels = [];
for (const item of payload.devices) {
  // The NVS seed is the production artefact: flash one signed image for the whole batch, then
  // write only this per unit. The generated header remains for bench builds.
  await writeFile(join(outputDir, item.nvsSeedFilename), item.nvsSeed);
  await writeFile(join(outputDir, item.flashConfigFilename), item.flashConfig);

  const claim = buildDeviceClaimPayload({
    gatewayBaseUrl: claimBaseUrl,
    deviceId: item.device.id,
    claimCode: item.claimCode,
    label: item.device.label ?? body.labelPrefix,
  });
  const labelFilename = claimLabelFilename(item.device.id);
  await writeFile(
    join(outputDir, labelFilename),
    buildDeviceLabelSvg({
      gatewayBaseUrl: claimBaseUrl,
      deviceId: item.device.id,
      claimCode: item.claimCode,
      label: item.device.label ?? body.labelPrefix,
    }),
  );
  labels.push({
    ...claim,
    labelFilename,
    flashConfigFilename: item.flashConfigFilename,
    nvsSeedFilename: item.nvsSeedFilename,
  });
}

console.log(`Created ${payload.devices.length} factory device(s).`);
console.log(`Wrote batch manifest, NVS seeds, controller_config.h and claim-label .svg files to ${outputDir}`);
console.log("");
console.log("To flash a unit's identity without rebuilding the image:");
console.log("  python $IDF_PATH/components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py \\");
console.log(`    generate ${outputDir}/<device>.nvs.csv ${outputDir}/<device>.nvs.bin 0x6000`);
console.log("  esptool.py write_flash <nvs-partition-offset> <device>.nvs.bin");

for (const label of labels) {
  console.log("");
  console.log(`${label.deviceId}  claim=${label.claimCode}`);
  console.log(label.claimUrl);
  console.log("");
  process.stdout.write(
    buildDeviceClaimQrAscii(
      { gatewayBaseUrl: claimBaseUrl, deviceId: label.deviceId, claimCode: label.claimCode },
      { style: qrStyle, ansi: qrAnsi },
    ),
  );
  console.log(`config=${label.flashConfigFilename} label=${label.labelFilename}`);
}

function requiredEnv(name) {
  const value = readEnv(process.env, name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
