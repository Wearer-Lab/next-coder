import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIRMWARE = join(ROOT, "firmware");
const FIRMWARE_SOURCE_DIRS = [
  "shared/NextCoderCore/src",
  "CrowPanel-ESP32-2.13-E-paper/src",
  "Hosyond-ESP32-S3-2.8-Touchscreen/src",
  "Waveshare-ESP32-S3-Touch-AMOLED-1.75C/src",
  "vision-master-t190/src",
].map((directory) => join(FIRMWARE, directory));

test("every firmware device-credential HTTP path crosses the shared TLS gate first", async () => {
  const sources = (await Promise.all(FIRMWARE_SOURCE_DIRS.map(firmwareSources))).flat();
  const credentialPaths = [];

  for (const file of sources) {
    const source = await readFile(file, "utf8");
    const credentialAt = source.search(/addHeader\(\s*"x-device-(?:id|secret)"/u);
    if (credentialAt < 0) continue;
    credentialPaths.push(file);

    assert.match(source, /#include\s+[<"]GatewayTls\.h[>"]/u, `${file} does not include GatewayTls`);
    const gateAt = source.indexOf("gateway_tls::beginHttp(");
    assert.ok(gateAt >= 0 && gateAt < credentialAt, `${file} adds device credentials before the shared TLS gate`);
    const secretHeaders = source.match(/addHeader\(\s*"x-device-secret"/gu)?.length ?? 0;
    const gatedRequests = source.match(/(?:gateway_tls::)?beginHttp\s*\(/gu)?.length ?? 0;
    assert.ok(
      gatedRequests >= secretHeaders,
      `${file} has ${secretHeaders} credential requests but only ${gatedRequests} shared TLS gates`,
    );
    assert.doesNotMatch(
      source,
      /\bhttp\.begin\s*\(/u,
      `${file} contains a raw HTTPClient::begin path beside device credentials`,
    );
  }

  assert.ok(credentialPaths.length >= 6, "the scan did not find the known firmware credential paths");
  assert.ok(
    credentialPaths.some((file) => file.endsWith("shared/NextCoderCore/src/GatewayClient.cpp")),
    "the shared controller heartbeat was not covered",
  );
});

test("the shared TLS policy fails closed and URL persistence uses it", async () => {
  const tls = await readFile(join(FIRMWARE, "shared/NextCoderCore/src/GatewayTls.h"), "utf8");
  assert.match(tls, /SECURE_BUILD_TLS_VERIFY/u);
  assert.match(tls, /#undef INSECURE_SKIP_TLS_VERIFY\s+#define INSECURE_SKIP_TLS_VERIFY 0/u);
  assert.match(tls, /inline bool gatewayUrlAllowed/u);
  assert.match(tls, /#if INSECURE_SKIP_TLS_VERIFY\s+return isBenchLanHttpUrl\(url\);\s+#else\s+return false;/u);
  assert.match(tls, /GATEWAY_TLS_ROOT_CA_PEM "\\n" GATEWAY_TLS_NEXT_ROOT_CA_PEM/u);
  assert.match(tls, /if \(!clockReady\(\)\)/u);
  assert.match(tls, /if \(!gatewayUrlAllowed\(url\)\)/u);

  const store = await readFile(join(FIRMWARE, "shared/NextCoderCore/src/DeviceStore.cpp"), "utf8");
  assert.match(store, /discardInvalidGatewayUrl\(gatewayUrl_/u);
  assert.match(store, /setGatewayUrl[\s\S]*gateway_tls::gatewayUrlAllowed\(trimmed\)/u);
  assert.match(store, /replaceGatewayProfiles[\s\S]*gateway_tls::gatewayUrlAllowed\(profiles\[index\]\.url\)/u);
  assert.match(store, /stageGatewaySwitch[\s\S]*gateway_tls::gatewayUrlAllowed\(profile\.url\)/u);

  const provisioning = await readFile(
    join(FIRMWARE, "shared/NextCoderCore/src/Provisioning.cpp"),
    "utf8",
  );
  assert.match(provisioning, /gateway_tls::gatewayUrlAllowed\(gateway\)/u);
});

test("Vision Master delegates the canonical bounded heartbeat to the shared controller client", async () => {
  const source = await readFile(join(FIRMWARE, "vision-master-t190/src/main.cpp"), "utf8");
  assert.match(source, /#include <GatewayClient\.h>/u);
  assert.match(source, /#include <DeviceStore\.h>/u);
  assert.match(source, /#include <Provisioning\.h>/u);
  assert.match(source, /gateway\.setCapabilities\(ENABLE_T190_DISPLAY != 0, ENABLE_T190_EXTERNAL_ENCODER != 0, false, false\)/u);
  assert.match(source, /gateway\.startNetworkTask\(\)/u);
  assert.match(source, /gateway\.notifyJustConnected\(\)/u);
  assert.doesNotMatch(source, /"\/v1\/device\/heartbeat"/u);
  assert.doesNotMatch(source, /addHeader\(\s*"x-device-secret"/u);
  assert.doesNotMatch(source, /"\/health"/u);

  const shared = await readFile(
    join(FIRMWARE, "shared/NextCoderCore/src/GatewayClient.cpp"),
    "utf8",
  );
  assert.match(shared, /"\/v1\/device\/heartbeat"/u);
  for (const field of [
    "protocolVersion",
    "hardwareModel",
    "firmwareVersion",
    "ipAddress",
    "wifiRssi",
    "freeHeap",
    "uptimeMs",
    "features",
  ]) {
    assert.match(shared, new RegExp(`doc\\["${field}"\\]`, "u"), `heartbeat omits ${field}`);
  }
  // The bounded-body read moved with the transport into the warm-session exchange that the shared
  // client's request() delegates to; the bound itself is unchanged.
  const exchange = await readFile(
    join(FIRMWARE, "shared/NextCoderCore/src/GatewayWarm.h"),
    "utf8",
  );
  assert.match(shared, /gateway_warm::exchange\(/u);
  assert.match(exchange, /kMaxResponseBodyBytes/u);
  assert.match(shared, /request\("POST", "\/v1\/device\/heartbeat", body, response\)/u);
  assert.match(shared, /if \(code >= 200 && code < 300\) \{\s+observeCredentialRotation\(response\);/u);
});

async function firmwareSources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".pio" || entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await firmwareSources(path));
    else if (/\.(?:cpp|h|ino)$/u.test(entry.name)) files.push(path);
  }
  return files;
}
