import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHARED = join(ROOT, "firmware/shared/NextCoderCore/src");
const CROW = join(ROOT, "firmware/CrowPanel-ESP32-2.13-E-paper");

test("CrowPanel delegates media transport to the shared raw upload-session client", async () => {
  const main = await readFile(join(CROW, "src/main.cpp"), "utf8");
  const capture = await readFile(join(CROW, "src/media_capture.h"), "utf8");
  assert.match(main, /#include <MediaUpload\.h>/u);
  assert.match(main, /media::uploadSession\(/u);
  assert.match(main, /#if ENABLE_AUDIO_CAPTURE \|\| ENABLE_CAMERA_CAPTURE[\s\S]*String uploadMedia\(/u);
  assert.doesNotMatch(main, /dataBase64|Base64JsonBodyStream|"\/v1\/device\/media"/u);
  assert.doesNotMatch(capture, /Base64JsonBodyStream|base64EncodedLength/u);
});

test("the shared firmware transport performs create, exact raw PUT, and finalize", async () => {
  const implementation = await readFile(join(SHARED, "MediaUpload.cpp"), "utf8");
  const media = await readFile(join(SHARED, "MediaUpload.h"), "utf8");
  const operate = await readFile(join(SHARED, "GatewayOperate.cpp"), "utf8");
  const voice = await readFile(join(SHARED, "GatewayVoice.cpp"), "utf8");
  assert.match(implementation, /"\/v1\/device\/media\/uploads"/u);
  assert.match(implementation, /http\.sendRequest\("PUT", &stream, stream\.contentLength\(\)\)/u);
  assert.match(implementation, /base, finalizePath, finalizeBody/u);
  assert.match(implementation, /const String sha256 = sha256Hex/u);
  assert.match(media, /class SegmentedBodyStream : public Stream/u);
  assert.doesNotMatch(implementation, /dataBase64/u);
  assert.match(operate, /media::uploadSession\(/u);
  assert.match(voice, /media::uploadSession\(/u);
  assert.doesNotMatch(operate, /"\/v1\/device\/media\/uploads"|sendRequest\("PUT"/u);
  assert.doesNotMatch(voice, /"\/v1\/device\/media\/uploads"|sendRequest\("PUT"/u);
});

test("CrowPanel's hermetic capture build cannot consume a live ignored config", async () => {
  const ini = await readFile(join(CROW, "platformio.ini"), "utf8");
  const main = await readFile(join(CROW, "src/main.cpp"), "utf8");
  const capture = await readFile(join(CROW, "src/media_capture.h"), "utf8");
  const ui = await readFile(join(CROW, "src/next_coder_ui.cpp"), "utf8");
  const tls = await readFile(join(SHARED, "GatewayTls.h"), "utf8");
  assert.match(ini, /\[env:crowpanel-esp32-213-epaper-capture-placeholder\][\s\S]*-DCONTROLLER_CONFIG_PLACEHOLDER_BUILD=1/u);
  assert.match(main, /#if defined\(CONTROLLER_CONFIG_PLACEHOLDER_BUILD\)\s+#include "controller_config\.example\.h"/u);
  assert.match(capture, /#if defined\(CONTROLLER_CONFIG_PLACEHOLDER_BUILD\)\s+#include "controller_config\.example\.h"/u);
  assert.match(ui, /#if defined\(CONTROLLER_CONFIG_PLACEHOLDER_BUILD\)\s+#include "controller_config\.example\.h"/u);
  assert.match(tls, /#if defined\(CONTROLLER_CONFIG_PLACEHOLDER_BUILD\)[\s\S]*Hermetic compile-only builds/u);
});

test("CrowPanel capture remains opt-in and keeps the verified reference-board pins", async () => {
  const config = await readFile(join(CROW, "include/controller_config.example.h"), "utf8");
  assert.match(config, /#define ENABLE_AUDIO_CAPTURE 0/u);
  assert.match(config, /#define ENABLE_CAMERA_CAPTURE 0/u);
  for (const [name, value] of [
    ["EINK_SCK", "12"], ["EINK_MOSI", "11"], ["EINK_RST", "10"],
    ["EINK_DC", "13"], ["EINK_CS", "14"], ["EINK_BUSY", "9"],
    ["EINK_POWER_PIN", "7"], ["KEY_UP_PIN", "6"], ["KEY_DOWN_PIN", "4"],
    ["KEY_OK_PIN", "5"], ["KEY_MENU_PIN", "2"], ["KEY_EXIT_PIN", "1"],
    ["POWER_LED_PIN", "19"],
  ]) {
    assert.match(config, new RegExp(`#define ${name} ${value}(?:\\s|$)`, "u"), `${name} changed`);
  }
});
