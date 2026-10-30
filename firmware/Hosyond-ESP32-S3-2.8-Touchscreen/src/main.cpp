// Hosyond / LCDWIKI ES3C28P — 2.8" IPS ESP32-S3 touchscreen module.
//
// This file is the board: power-on reporting, pins, radios, the one physical button, and the loop
// that drives everything else. The product lives next door — src/ui.cpp owns the five screens, the
// shared NextCoderCore owns the gateway conversation, and src/audio.cpp owns the codec.
//
// The controller is usable from the glass: pick a thread, hold to record a voice note, run a saved
// action, read the reply, approve a held command. There is no keyboard and there will not be one;
// on a device like this a request is made by voice or by choosing something the owner saved
// earlier, and every on-device edit is a bounded choice.
//
// BOOT is overloaded and the overload is deliberate: a tap reopens the configuration portal (the
// escape hatch for a wrong gateway URL, which otherwise leaves a unit online and unable to reach
// anything), while a hold of PROVISIONING_RESET_HOLD_MS wipes Wi-Fi and re-enters provisioning —
// the recovery for a revoked device, a house move, or a resale.

#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>

#include <DeviceStore.h>
#include <GatewayClient.h>
#include <Provisioning.h>

#include "qualification.h"
#include "audio.h"
#include "display.h"
#include "gatewayProbe.h"
#include "touch.h"
#include "ui.h"

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

#ifndef HARDWARE_MODEL
#define HARDWARE_MODEL "ips28-esp32-s3r8"
#endif
#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "0.1.0"
#endif
#ifdef BUILD_FIRMWARE_VERSION
#undef FIRMWARE_VERSION
#define FIRMWARE_VERSION BUILD_FIRMWARE_VERSION
#endif

namespace {

DeviceStore store;
Provisioning provisioning;
GatewayClient gateway;

ProvisioningState lastState = ProvisioningState::Unprovisioned;
uint32_t bootHeldSince = 0;
bool bootWasDown = false;

void reportMemory() {
  Serial.printf("Flash size:  %u bytes\n", (unsigned)ESP.getFlashChipSize());
  Serial.printf("Heap free:   %u bytes\n", (unsigned)ESP.getFreeHeap());

  const size_t psram = ESP.getPsramSize();
  if (psram == 0) {
    Serial.println("PSRAM:       NOT DETECTED");
    Serial.println("  The vendor spec says 8 MB internal OPI PSRAM. Check that platformio.ini sets");
    Serial.println("  board_build.arduino.memory_type = qio_opi.");
    return;
  }
  Serial.printf("PSRAM:       %u bytes free of %u\n",
                (unsigned)ESP.getFreePsram(), (unsigned)psram);
}

void reportBattery() {
  // GPIO9 sits behind a divide-by-two, so the pin reads half the cell voltage. analogReadMilliVolts
  // applies the ESP32-S3's own ADC calibration, which is why this is not a raw-count conversion.
  const uint32_t mv = analogReadMilliVolts(BATTERY_ADC_PIN) * BATTERY_DIVIDER_RATIO;
  Serial.printf("Battery:     %u mV%s\n", (unsigned)mv,
                mv < 500 ? "  (no cell connected, or USB-only)" : "");
}

void reportIdentity() {
  if (store.hasIdentity()) {
    Serial.printf("Device id:   %s\n", store.deviceId().c_str());
    Serial.printf("Gateway:     %s\n", store.gatewayUrl().c_str());
    return;
  }
  Serial.println("Device id:   none in NVS");
  Serial.println("  Seed one by copying controller_config.example.h to controller_config.h and");
  Serial.println("  filling in DEVICE_ID / DEVICE_SECRET from POST /v1/devices, or flash a factory");
  Serial.println("  nvsSeed CSV from POST /v1/factory/batches.");
}

void reportState(ProvisioningState state) {
  const ProvisioningStatus& status = provisioning.status();
  Serial.printf("[provisioning] %s", provisioningStateName(state));
  if (status.detail.length()) Serial.printf(" — %s", status.detail.c_str());
  Serial.println();

  if (state == ProvisioningState::Provisioning) {
    Serial.printf("  Join \"%s\" and open %s to set Wi-Fi.\n",
                  status.apName.c_str(), status.portalUrl.c_str());
  }
  if (state == ProvisioningState::Online) {
    Serial.printf("  IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  }
}

// A tap and a hold on the same key, decided on release. The reset has to win, so it fires the
// moment the threshold passes rather than waiting for a lift that may never come.
void pollBootButton() {
  const bool down = digitalRead(BOOT_BUTTON_PIN) == LOW;

  if (down && !bootWasDown) {
    bootHeldSince = millis();
    bootWasDown = true;
    return;
  }

  if (down) {
    if (millis() - bootHeldSince >= PROVISIONING_RESET_HOLD_MS) {
      Serial.println("[provisioning] BOOT held — clearing Wi-Fi and re-entering provisioning.");
      provisioning.resetToProvisioning();
      bootWasDown = false;
      while (digitalRead(BOOT_BUTTON_PIN) == LOW) delay(10);
    }
    return;
  }

  if (!bootWasDown) return;
  bootWasDown = false;

  // The escape hatch for a wrong gateway URL: the portal closes as soon as Wi-Fi joins, so without
  // this a typo left the device online, unable to reach any gateway, and recoverable only by the
  // long-press wipe — which also destroys Wi-Fi credentials that were perfectly good.
  Serial.println("[provisioning] BOOT tapped — opening the config portal.");
  provisioning.openConfigPortal();
}

}  // namespace

// Handed to the gateway probe task, which runs outside this translation unit's anonymous
// namespace and must not keep its own copy of the store.
DeviceStore& deviceStore() { return store; }

void setup() {
  Serial.begin(115200);

  // Never block on a serial write.
  //
  // This board's Serial is the ESP32-S3's native USB CDC, and by default a write waits for the host
  // to drain the TX buffer. With a monitor attached that is invisible; with nothing reading, the
  // buffer fills and every Serial.printf stalls the loop for the timeout — which presents as the
  // animation freezing at 0 fps for anyone watching the panel rather than the console. The bug is
  // therefore masked by the very tool used to look for it.
  //
  // 0 means "write what fits, drop the rest". Diagnostics are worth exactly nothing if printing
  // them is what stops the device working.
  Serial.setTxTimeoutMs(0);

  // Native USB CDC needs a moment before the host enumerates it; anything printed earlier is lost.
  delay(2000);

  Serial.println();
  Serial.println("=== Next Coder — Hosyond ES3C28P 2.8\" IPS ESP32-S3 ===");
  Serial.printf("Model:       %s\n", HARDWARE_MODEL);
  Serial.printf("Firmware:    %s\n", FIRMWARE_VERSION);
  reportMemory();
  reportBattery();

  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);

  // One I2C bus, shared by the FT6336G touch controller, the ES8311 codec and the external header.
  // It is started here rather than inside audio init because touch needs it in builds that have no
  // audio at all — which is exactly how the display build failed to see the touch controller.
  if (!Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, I2C_SPEED_HZ)) {
    Serial.println("[i2c] Wire.begin failed; touch and codec will not respond.");
  }

  if (displayBegin()) {
    Serial.println("[display] ILI9341V up, 240x320, backlight on.");
    touchBegin();
    // 148 px across for the home orb, 44 px for the one that keeps the list screens alive.
    if (!displayBeginCanvases(148, 44)) {
      Serial.println("[display] Canvas allocation failed; running without the orb.");
    }
  } else {
    Serial.println("[display] Not initialised (ENABLE_LCD is 0, or init failed).");
  }

  if (!store.begin()) {
    // An NVS failure here means the partition table is wrong. Nothing after this would work.
    Serial.println("FATAL: NVS unavailable. Check board_build.partitions in platformio.ini.");
    return;
  }

  store.seedIdentityIfEmpty(DEVICE_ID, DEVICE_SECRET, GATEWAY_BASE_URL);
  reportIdentity();

  if (audio::begin()) {
#if !HOSYOND_QUALIFICATION
    audio::bootSelfTest();
#endif
  }

  // Declared before the first heartbeat, because the gateway decides what to assign this device and
  // how to wrap its text from these numbers. A board that does not claim a microphone is never
  // given a capture action, and one that claims the wrong label width gets clipped labels rather
  // than an error.
  gateway.setCapabilities(audio::available(), false);
  GatewayLimits limits;
  limits.menuItems = 8;
  limits.threadItems = 12;
  limits.labelCharacters = 24;
  limits.mediaUploadBytes = MEDIA_UPLOAD_MAX_BYTES;
  gateway.setLimits(limits);

  gateway.begin(store, HARDWARE_MODEL, FIRMWARE_VERSION);
  gateway.handleOtaBootAttempt();
  gateway.startNetworkTask();
  gatewayProbeBegin();
  provisioning.begin(store, store.deviceId());
  lastState = provisioning.status().state;
  reportState(lastState);

  uiBegin(gateway, provisioning, store);
  qualificationBegin();

  // -----------------------------------------------------------------------------------------
  // Not yet implemented, in dependency order:
  //
  //   Gateway profiles     — the LAN/tailnet switch protocol, likewise unported.
  //   RGB LED indicator    — GPIO42, recording state.
  //   Camera               — no sensor on this board; capture_image controls report as much.
  // -----------------------------------------------------------------------------------------
}


#if BENCH_SELFTEST && !HOSYOND_QUALIFICATION
// A bench-only harness, compiled out of every product environment.
//
// It exists because the two paths that matter most had only ever been reasoned about: recording
// with the recording UI active, and creating a thread. Both need a finger on the
// glass, and the person driving this board cannot always be at it. So the board drives itself —
// through the SAME entry points a finger reaches, never a parallel copy, because a harness that
// calls its own reimplementation proves nothing about the code that ships.
//
// The number this exists to produce: a gap-free N ms clip at AUDIO_SAMPLE_RATE_HZ has a known
// sample count. A shortfall reveals capture/pump loss; it does not prove orb performance.
namespace bench {

enum class Stage : uint8_t { Idle, Settle, TapTalk, PressMic, Holding, Release, Report,
                            GoThreads, Create, CreateCheck, Done };
Stage stage = Stage::Idle;
uint32_t dueAt = 0;
uint32_t recordBeganAt = 0;
uint32_t inspectionDeadline = 0;
int rowsBefore = -1;
char boundBefore[48] = {0};

constexpr uint32_t kHoldMs = 4000;

// Geometry taken from ui.cpp rather than guessed: actionRect() puts a button at
// top = kH - kBarH + 11 with height 36, and TALK is the FIRST action HOME adds.
constexpr int16_t kActionY = 320 - 58 + 11 + 18;
constexpr int16_t kTalkX = 12 + ((240 - 24 - 8) / 2) / 2;
// micButtonRect() is {14, capsuleY, kW - 28, kVoiceCapsuleH}; the capsule spans y 121..213.
constexpr int16_t kMicX = 120;
constexpr int16_t kMicY = 167;

void send(TouchGesture gesture, int16_t x, int16_t y) {
  TouchEvent e;
  e.gesture = gesture;
  e.x = x;
  e.y = y;
  uiHandleTouch(e);
}

void tick(GatewayClient& gateway) {
  // Production gestures are asynchronous; inspect their result only after UI completion applies it.
  if (uiBenchNetworkBusy()) return;
  const uint32_t now = millis();
  switch (stage) {
    case Stage::Idle:
      if (gateway.link() != GatewayLink::Claimed) return;
      Serial.println("[bench] claimed; settling before the run");
      dueAt = now + 6000;
      stage = Stage::Settle;
      return;

    case Stage::Settle: {
      if ((int32_t)(now - dueAt) < 0) return;
      if (inspectionDeadline == 0) inspectionDeadline = now + 30000;
      bool audioReady = false;
      bool threadReady = false;
      DeviceBlockerKind blocker = DeviceBlockerKind::Unknown;
      const bool inspected = uiBenchCaptureState(audioReady, threadReady, blocker);
      // Ownership/config arrives before the provider/input inspection finishes. Wait on that
      // ordinary background evidence, with a deadline; never issue extra HTTP or stall a frame.
      if ((!inspected || blocker == DeviceBlockerKind::Unknown)
          && (int32_t)(now - inspectionDeadline) < 0) return;
      Serial.printf("[bench] capture readiness: inspected=%s audioReady=%s threadReady=%s blocker=%s\n",
                    inspected ? "yes" : "no", audioReady ? "yes" : "no",
                    threadReady ? "yes" : "no", deviceBlockerLabel(blocker));
      Serial.printf("[bench] screen before: %s\n", uiBenchScreenName());
      if (!uiBenchRunAction("TALK")) {
        Serial.println("[bench] CAPTURE: SKIP - TALK unavailable; see readiness metadata above");
        dueAt = now + 500;
        stage = Stage::GoThreads;
        return;
      }
      dueAt = now + 900;
      stage = Stage::TapTalk;
      return;
    }

    case Stage::TapTalk:
      if ((int32_t)(now - dueAt) < 0) return;
      {
        int16_t rx = 0, ry = 0, rw = 0, rh = 0;
        uiBenchMicRect(&rx, &ry, &rw, &rh);
        const int16_t px = (int16_t)(rx + rw / 2);
        const int16_t py = (int16_t)(ry + rh / 2);
        Serial.printf("[bench] screen now: %s; mic rect {%d,%d,%d,%d}; pressing (%d,%d)\n",
                      uiBenchScreenName(), (int)rx, (int)ry, (int)rw, (int)rh, (int)px, (int)py);
        send(TouchGesture::Press, px, py);
        uiBenchHoldGlass(true);
        Serial.printf("[bench] recording armed: %s (glass held for the harness)\n",
                      uiBenchRecording() ? "yes" : "NO");
      }
      recordBeganAt = millis();
      dueAt = recordBeganAt + kHoldMs;
      stage = Stage::Holding;
      return;

    case Stage::Holding:
      // Deliberately does nothing: the loop keeps running, so recording is pumped and the timer
      // is animated by exactly the code that runs when a person is holding the button. That
      // contention is the whole subject of the test.
      if ((int32_t)(now - dueAt) < 0) return;
      Serial.println("[bench] releasing");
      uiBenchHoldGlass(false);
      send(TouchGesture::Release, kMicX, kMicY);
      dueAt = now + 400;
      stage = Stage::Report;
      return;

    case Stage::Report: {
      if ((int32_t)(now - dueAt) < 0) return;
      const uint32_t heldMs = dueAt - 400 - recordBeganAt;
      const uint32_t ms = audio::recordedMs();
      const size_t bytes = audio::recordedBytes();
      const audio::ClipStats st = audio::measureClip();
      const uint32_t expected = (uint32_t)((uint64_t)heldMs * AUDIO_SAMPLE_RATE_HZ / 1000ULL);
      const uint32_t actual = (uint32_t)(bytes / sizeof(int16_t));
      Serial.println("[bench] ---- capture with recording UI active ----");
      Serial.printf("[bench] held %u ms, recorded %u ms, %u bytes\n",
                    (unsigned)heldMs, (unsigned)ms, (unsigned)bytes);
      Serial.printf("[bench] samples expected ~%u, actual %u, shortfall %d (%.2f%%)\n",
                    (unsigned)expected, (unsigned)actual, (int)((int32_t)expected - (int32_t)actual),
                    expected ? (100.0 * ((double)expected - (double)actual) / (double)expected) : 0.0);
      Serial.printf("[bench] peak %d rms %d\n", (int)st.peak, (int)st.rms);
      if (actual == 0) Serial.println("[bench] CAPTURE: FAIL - no samples; the press did not start a recording");
      else if (st.peak <= 0) Serial.println("[bench] CAPTURE: FAIL - silence");
      else if (expected && actual * 100ULL < (uint64_t)expected * 97ULL)
        Serial.println("[bench] CAPTURE: FAIL - more than 3% of expected capture samples missing");
      else Serial.println("[bench] CAPTURE: PASS - expected sample count retained with recording UI active");
      dueAt = now + 1500;
      stage = Stage::GoThreads;
      return;
    }

    case Stage::GoThreads:
      if ((int32_t)(now - dueAt) < 0) return;
      // The held clip keeps the Send screen and its DISCARD/SEND bar, so nothing else is reachable
      // until it is dealt with. Discarded rather than sent: this run is measuring the create path,
      // and dispatching four seconds of room tone into a real thread is not a side effect a bench
      // run should have.
      if (uiBenchRunAction("DISCARD")) Serial.println("[bench] discarded the bench clip");
      Serial.printf("[bench] ---- create -> splice -> adopt ----\n");
      rowsBefore = -1;   // taken after the rebind, below
      strncpy(boundBefore, uiBenchBoundThreadTitle(), sizeof(boundBefore) - 1);
      boundBefore[sizeof(boundBefore) - 1] = 0;
      Serial.printf("[bench] before: %d rows, bound \"%s\"\n", rowsBefore, boundBefore);
      {
        const int rebind = uiBenchRebindFirstProject();
        Serial.printf("[bench] rebound project -> %d (>=0 is the project count)\n", rebind);
      }
      uiBenchGoToThreads();
      Serial.printf("[bench] screen for create: %s\n", uiBenchScreenName());
      dueAt = now + 2500;   // let the list settle so an empty folder is genuinely empty
      stage = Stage::Create;
      return;

    case Stage::Create:
      if ((int32_t)(now - dueAt) < 0) return;
      if (rowsBefore < 0) {
        rowsBefore = uiBenchThreadRowCount();
        strncpy(boundBefore, uiBenchBoundThreadTitle(), sizeof(boundBefore) - 1);
        boundBefore[sizeof(boundBefore) - 1] = 0;
        Serial.printf("[bench] baseline after rebind: %d rows, bound \"%s\"\n",
                      rowsBefore, boundBefore);
      }
      // Through runAction(), not a direct call: the handler is what is under test.
      if (!uiBenchRunAction("NEW THREAD")) {
        Serial.println("[bench] CREATE: FAIL - NEW THREAD was not offered");
        stage = Stage::Done;
        return;
      }
      dueAt = now + 1200;
      stage = Stage::CreateCheck;
      return;

    case Stage::CreateCheck: {
      if ((int32_t)(now - dueAt) < 0) return;
      const int rows = uiBenchThreadRowCount();
      const char* bound = uiBenchBoundThreadTitle();
      Serial.printf("[bench] after: %d rows, bound \"%s\"\n", rows, bound);
      Serial.printf("[bench] create status=%d detail=\"%s\"\n",
                    uiBenchCreateStatus(), uiBenchCreateDetail());
      // The splice must be visible without waiting for the 30 s refresh, and the adopt must have
      // moved the binding to it. Either failing separately tells us which half broke.
      // Compared against what was true BEFORE. The first version of this asserted rows > 0 and
      // bound != none, which were already true, so it passed without the create doing anything.
      if (rows != rowsBefore + 1)
        Serial.printf("[bench] CREATE: FAIL - rows %d -> %d, expected %d; the splice did not land\n",
                      rowsBefore, rows, rowsBefore + 1);
      else if (strcmp(bound, boundBefore) == 0)
        Serial.println("[bench] CREATE: FAIL - the binding did not move; adoptThreadBinding did not take");
      else Serial.println("[bench] CREATE: PASS - created, spliced, and the binding moved to it");
      Serial.println("[bench] ---- run complete ----");
      stage = Stage::Done;
      return;
    }

    default:
      return;
  }
}

}  // namespace bench
#endif

void loop() {
  const ProvisioningState state = provisioning.poll();
  if (state != lastState) {
    lastState = state;
    reportState(state);
  }

  // Mirrors the reference loop: while the link is down the portal owns the screen, and polling the
  // gateway would only stack up failures.
  if (state == ProvisioningState::Online) {
    // The cycle runs on its own core now; the loop only forwards edges to it.
    //
    // This was tried once before and withdrawn, because a task mutating gateway state while the
    // renderer walked the same Strings faulted within seconds. What makes it safe now is not the
    // task but the lock discipline underneath it: the task holds the state lock across a fetch so
    // its parse is atomic, request() hands that lock back for the duration of the socket wait, and
    // every touch-driven entry point takes it too. The renderer takes it with a zero timeout and
    // reuses the previous frame's values when it cannot, so it never waits on the network at all.
    gateway.setNetworkPaused(audio::recording());
    if (provisioning.consumeJustConnected()) gateway.notifyJustConnected();
  } else {
    gateway.goOffline();
  }

  if (gateway.consumeJustClaimed()) {
    Serial.println("[gateway] claim confirmed; loading configuration");
    gatewayProbeNow();
  }

  // The whole frame runs under the gateway's state lock, touch handling included.
  //
  // The paint path reads gateway Strings — thread titles, statuses, response lines — in dozens of
  // places, and the cycle that reassigns those Strings now runs on the other core. Reading one
  // while it is being reassigned is a use-after-free, and it is the exact fault that crashed this
  // board before: panics inside the WiFi driver with none of our code on the stack.
  //
  // Holding the lock across a whole frame is only affordable because request() hands it back for
  // the duration of every socket wait. The task therefore holds it just for the microseconds of
  // parsing on either side of a fetch, so this almost never waits. When it genuinely cannot get
  // the lock in time, the frame is skipped rather than painted from state that is being rewritten
  // underneath it — one dropped frame at 30 fps is invisible, and a torn String is not.
  // Sample the glass even while the network parser owns the model. The UI retains at most
  // four discrete edges and validates their age/navigation/model before replay.
  const TouchEvent touch = touchPoll();
  if (touch.gesture != TouchGesture::None) uiHandleTouch(touch);
  // uiTick owns its model lock and records a skipped frame when it cannot acquire it.
  uiTick();

#if BENCH_SELFTEST && !HOSYOND_QUALIFICATION
  bench::tick(gateway);
#endif
  qualificationTick(provisioning,gateway,store);
  pollBootButton();
  uiSleepUntilNextFrame();
}
