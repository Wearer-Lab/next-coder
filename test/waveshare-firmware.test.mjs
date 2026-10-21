import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHARED = join(ROOT, "firmware/shared/NextCoderCore/src");
const BOARD = join(ROOT, "firmware/Waveshare-ESP32-S3-Touch-AMOLED-1.75C");

test("shared firmware capabilities preserve proven boards and gate unproven surfaces", async () => {
  const header = await readFile(join(SHARED, "GatewayClient.h"), "utf8");
  const source = await readFile(join(SHARED, "GatewayClient.cpp"), "utf8");

  assert.match(header, /void setCapabilities\(bool microphone, bool camera\);/u);
  assert.match(
    header,
    /void setCapabilities\(bool display, bool threadPicker, bool microphone, bool camera\);/u,
  );
  assert.match(
    source,
    /setCapabilities\(true, true, microphone, camera\);/u,
    "existing display-board callers must retain display and thread-picker capabilities",
  );

  assert.match(source, /if \(hasDisplay_\) features\.add\("display"\);/u);
  assert.match(source, /if \(hasThreadPicker_\) features\.add\("thread_picker"\);/u);
  assert.doesNotMatch(source, /^\s*features\.add\("(?:display|thread_picker)"\);$/mu);

  assert.match(source, /if \(hasThreadPicker_ && .*nextThreadsAt_/u);
  assert.match(source, /if \(hasDisplay_ && .*nextControlsAt_/u);
  assert.match(source, /if \(hasDisplay_ && .*nextApprovalsAt_/u);
  assert.match(source, /if \(hasDisplay_ && .*nextDisplayAt_/u);
});

test("Waveshare uses only the safe claim, health, and recovery path", async () => {
  const main = await readFile(join(BOARD, "src/main.cpp"), "utf8");
  const config = await readFile(join(BOARD, "include/controller_config.example.h"), "utf8");

  assert.match(main, /#include <GatewayClient\.h>/u);
  assert.match(main, /gateway\.setCapabilities\(false, false, false, false\);/u);
  assert.match(main, /gateway\.begin\(store, HARDWARE_MODEL, FIRMWARE_VERSION\);/u);
  assert.match(main, /gateway\.startNetworkTask\(\);/u);
  assert.match(main, /gateway\.notifyJustConnected\(\);/u);
  assert.match(main, /GatewayLink::Unclaimed/u);
  assert.match(main, /GatewayLink::Revoked/u);
  assert.match(main, /provisioning\.openConfigPortal\(\);/u);
  assert.match(main, /provisioning\.resetToProvisioning\(\);/u);

  assert.doesNotMatch(main, /GatewayBrowse|refreshThreads|selectThread|runControl|sendPrompt/u);
  assert.doesNotMatch(main, /Wire\.begin|AMOLED_|TOUCH_|AUDIO_|ES7210|ES8311/u);
  assert.equal(main.match(/pinMode\(/gu)?.length, 1, "only the BOOT recovery input may be configured");
  assert.match(config, /#ifndef ENABLE_AMOLED\s+#define ENABLE_AMOLED 0/u);
  assert.match(config, /#ifndef ENABLE_AUDIO_CAPTURE\s+#define ENABLE_AUDIO_CAPTURE 0/u);
});
