#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <Update.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include <esp_ota_ops.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>
#include <cstring>

#if defined(CONTROLLER_CONFIG_PLACEHOLDER_BUILD)
#include "controller_config.example.h"
#elif __has_include("controller_config.h")
#include "controller_config.h"

// The production environment is authoritative even when a developer's older, ignored
// controller_config.h still defines these switches to zero. Distinct build-only macros avoid a
// preprocessor redefinition race and guarantee the secure build exercises the OTA/signature code.
#if SECURE_BUILD_ENABLE_OTA_APPLY
#undef ENABLE_OTA_APPLY
#define ENABLE_OTA_APPLY 1
#endif
#if SECURE_BUILD_REQUIRE_OTA_SIGNATURE
#undef REQUIRE_OTA_SIGNATURE
#define REQUIRE_OTA_SIGNATURE 1
#endif
#else
#include "controller_config.example.h"
#endif

#include <GatewayTls.h>
#include <MediaUpload.h>

// Writable device state and the provisioning state machine. Device id, secret, gateway URL, and
// Wi-Fi credentials now live in NVS: the values in controller_config.h are a bench seed used only
// when NVS is empty, never a source of truth. See firmware/shared/NextCoderCore.
#include <DeviceStore.h>
#include <Provisioning.h>

// Pulls in ENABLE_AUDIO_CAPTURE / ENABLE_CAMERA_CAPTURE and their pin defaults.
// Both default to 0, so a board with neither microphone nor camera builds and
// behaves exactly as before.
#include "media_capture.h"
#include "next_coder_ui.h"

#ifndef HARDWARE_MODEL
#define HARDWARE_MODEL "e213-esp32-s3r8"
#endif

#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "0.1.0"
#endif

#ifndef ENABLE_OTA_APPLY
#define ENABLE_OTA_APPLY 0
#endif

#ifndef REQUIRE_OTA_SIGNATURE
#define REQUIRE_OTA_SIGNATURE 0
#endif

#ifndef OTA_MANIFEST_VERIFY_KEY
#define OTA_MANIFEST_VERIFY_KEY ""
#endif

// Release automation supplies these through scripts/build_overrides.py. Keeping
// them distinct from controller_config.h lets one signed binary serve a batch
// without copying the signing verifier or release version into a local header.
#ifdef BUILD_FIRMWARE_VERSION
#undef FIRMWARE_VERSION
#define FIRMWARE_VERSION BUILD_FIRMWARE_VERSION
#endif
#ifdef BUILD_OTA_MANIFEST_VERIFY_KEY
#undef OTA_MANIFEST_VERIFY_KEY
#define OTA_MANIFEST_VERIFY_KEY BUILD_OTA_MANIFEST_VERIFY_KEY
#endif
#ifndef BUILD_OTA_ROLLBACK_DRILL
#define BUILD_OTA_ROLLBACK_DRILL 0
#endif

#ifndef DEFAULT_SHELL_COMMAND
#define DEFAULT_SHELL_COMMAND "npm test"
#endif

#if ENABLE_EINK
// This panel is a JD79661, not an SSD1680: it uses a different command set and
// the opposite BUSY polarity, so GxEPD2 cannot drive it (verified on hardware --
// GxEPD2 blocks forever in its busy wait). lib/ElecrowEPD is Elecrow's own
// driver for this exact board. See docs/hardware-protocol.md.
#include "EPD.h"
#include "EPD_Init.h"
#endif

namespace {
constexpr uint32_t kHeartbeatIntervalMs = 30000;
constexpr uint32_t kDisplayPollIntervalMs = 5000;
constexpr uint32_t kConfigPollIntervalMs = 60000;
constexpr uint32_t kControlsPollIntervalMs = 30000;
constexpr uint32_t kGatewayPollIntervalMs = 60000;
constexpr uint32_t kFirmwarePollIntervalMs = 6UL * 60UL * 60UL * 1000UL;
constexpr uint32_t kSetupCodeRefreshIntervalMs = 10UL * 60UL * 1000UL;
constexpr uint32_t kButtonDebounceMs = 250;
constexpr uint32_t kStopChordGraceMs = 150;
constexpr size_t kOtaBufferSize = 4096;
// On Home, EXIT reveals a locally cached unclaimed-device code; everywhere else it is Back/Cancel.
// A 10 s hold still wipes Wi-Fi and re-enters provisioning. The long-hold recovery is independent
// of the current screen so a moved, resold, or revoked unit never requires a USB reflash.
constexpr uint32_t kResetHoldMs = 10000;
constexpr uint32_t kStopHoldMs = 1500;
constexpr uint32_t kRealtimeCoalesceMs = 250;
uint32_t lastHeartbeatAt = 0;
uint32_t lastDisplayPollAt = 0;
uint32_t lastConfigPollAt = 0;
uint32_t lastControlsPollAt = 0;
uint32_t lastGatewayPollAt = 0;
uint32_t lastFirmwarePollAt = 0;
uint32_t lastSetupCodeAt = 0;
uint32_t nextGatewayRequestAt = 0;
int selectedMenuIndex = 0;

constexpr uint32_t kRefreshConfigBit = 1u << 0;
constexpr uint32_t kRefreshThreadsBit = 1u << 1;
constexpr uint32_t kRefreshControlsBit = 1u << 2;
constexpr uint32_t kRefreshDisplayBit = 1u << 3;
constexpr uint32_t kRefreshGatewayBit = 1u << 4;
constexpr uint32_t kRefreshFirmwareBit = 1u << 5;
volatile uint32_t pendingRealtimeRefreshMask = 0;
volatile uint32_t realtimeRefreshDueAt = 0;
portMUX_TYPE realtimeRefreshMux = portMUX_INITIALIZER_UNLOCKED;

SemaphoreHandle_t realtimeEndpointMutex = nullptr;
String realtimeGatewayBase;
String realtimeDeviceId;
String realtimeDeviceSecret;
volatile uint32_t realtimeEndpointGeneration = 0;
TaskHandle_t realtimeTaskHandle = nullptr;

// Universal physical-navigation contract:
//   DIAL UP/DOWN  move the visible selection and wrap within the current list
//   OK            open/commit the selected row; on Home, fetch current status
//   MENU          open Actions from any non-modal screen
//   EXIT          back/cancel one level; on Home it is a harmless no-op
//   EXIT 10 s     recover to Wi-Fi provisioning (preserved hardware escape hatch)
//   OK+EXIT 1.5 s emergency stop (preserved globally reserved chord)
//
// Text-entry operations stay in the dashboard. On-device edits are bounded
// choices (thread, gateway, action, approval) so an accidental dial movement
// can always be cancelled with EXIT before it changes gateway state.
enum class UiScreen : uint8_t {
  Home,
  Actions,
  Threads,
  ThreadActions,
  ThreadOutput,
  Gateways,
  Detail,
};

UiScreen uiScreen = UiScreen::Home;
UiScreen detailReturnScreen = UiScreen::Actions;
int selectedActionIndex = 0;
bool resetConfirmOpen = false;
bool stopConfirmOpen = false;
String pendingStopActionId;
String pendingStopLabel;
bool pendingStopLegacy = false;
bool firmwarePromptOpen = false;
bool firmwarePromptDeferred = false;
bool firmwareUpdateAvailable = false;
bool pendingFirmwareRequiresConfirmation = false;
bool lastFirmwarePollSucceeded = false;
UiScreen firmwarePromptReturnScreen = UiScreen::Home;
String pendingFirmwareVersion;
String pendingFirmwareManifestJson;

// Keys are latched in an ISR because the main loop spends most of its time
// blocked in HTTP calls and panel refreshes.
constexpr uint32_t kKeyUpBit = 1u << 0;
constexpr uint32_t kKeyDownBit = 1u << 1;
constexpr uint32_t kKeyOkBit = 1u << 2;
constexpr uint32_t kKeyMenuBit = 1u << 3;
constexpr uint32_t kKeyExitBit = 1u << 4;

volatile uint32_t pendingKeyMask = 0;
volatile uint32_t lastKeyIsrAt = 0;
uint32_t deferredChordKeyMask = 0;
uint32_t deferredChordKeyAt = 0;

void IRAM_ATTR onKeyIsr(void* arg) {
  const uint32_t now = millis();
  // One debounce window across all keys: these are mechanical switches on a
  // shared bezel and a bounce on one must not read as a press on another.
  if (now - lastKeyIsrAt < kButtonDebounceMs) return;
  lastKeyIsrAt = now;
  pendingKeyMask |= static_cast<uint32_t>(reinterpret_cast<uintptr_t>(arg));
}

// Six is the gateway's own menu length; the two extra slots exist so a board
// with capture hardware can offer "audio"/"camera" without dropping an entry
// the gateway sent.
constexpr size_t kMaxMenuItems = 8;

const char* kFallbackMenu[] = {
  "status",
  "prompt",
  "shell",
  "macro",
#if ENABLE_AUDIO_CAPTURE
  "audio",
#endif
#if ENABLE_CAMERA_CAPTURE
  "camera",
#endif
  "media",
  "stop",
};
String menuItems[kMaxMenuItems];
size_t menuCount = 0;

// Protocol v2 separates the text painted on the display from the stable id and
// behavior sent by the gateway. The payload of a saved action never lives on
// the controller: only its opaque id is cached here.
struct DeviceControl {
  String id;
  String actionId;
  String label;
  String kind;
  String mediaKind;
  String reason;
  bool enabled = true;
  bool requiresThread = false;
  bool requiresConfirmation = false;
};

DeviceControl controls[kMaxMenuItems];
bool actionConfirmOpen = false;
DeviceControl pendingActionControl;
bool controlsProtocolV2 = false;
uint32_t controlsRevision = 0;
uint32_t acknowledgedControlsRevision = UINT32_MAX;

bool gatewayMenuOpen = false;
int selectedGatewayProfileIndex = 0;

constexpr size_t kMaxThreadOptions = 12;
struct ThreadOption {
  String id;
  String title;
  String status;
  bool selected = false;
};

ThreadOption threadOptions[kMaxThreadOptions];
size_t threadOptionCount = 0;
int selectedThreadIndex = 0;

constexpr size_t kResponseLinesPerPage = 3;
constexpr size_t kMaxFollowUpActions = 2;
String responseLines[kResponseLinesPerPage];
size_t responseLineCount = 0;
int responsePage = 0;
int responsePageCount = 1;
String responseState = "empty";
String responseMessageId;
String responseAfter;
DeviceControl followUpActions[kMaxFollowUpActions];
size_t followUpActionCount = 0;
int selectedFollowUpIndex = 0;
bool followUpMode = false;

struct DisplayModel {
  String title = "Next Coder";
  String state = "boot";
  String line1 = "Starting";
  String line2 = "Connecting WiFi";
};

DisplayModel displayModel;

struct RuntimeConfig {
  String environmentId = ENVIRONMENT_ID;
  String threadId = THREAD_ID;
  String defaultPrompt = DEFAULT_AGENT_PROMPT;
  String shellCommand = DEFAULT_SHELL_COMMAND;
};

RuntimeConfig runtimeConfig;

String shortThreadId(const String& id) {
  if (id.length() <= 12) return id;
  return String("~") + id.substring(id.length() - 11);
}

String selectedThreadLabel() {
  if (runtimeConfig.threadId.length() == 0) return "Select a thread";
  for (size_t i = 0; i < threadOptionCount; i += 1) {
    if (threadOptions[i].selected || threadOptions[i].id == runtimeConfig.threadId) {
      if (threadOptions[i].title.length() > 0) return threadOptions[i].title;
    }
  }
  return String("Thread ") + shortThreadId(runtimeConfig.threadId);
}

DeviceStore deviceStore;
Provisioning provisioning;
// Set when the gateway answers 401 on a credential the device believes is good. That means the
// owner revoked it, and the only way out is the long-press reset — so the screen has to say so
// instead of showing "HTTP 401" forever.
bool deviceRevoked = false;
// Latches the revoked screen so it renders on entry rather than on every 10ms pass. Cleared
// wherever deviceRevoked is, so a recovered or re-claimed device redraws normally.
bool revokedScreenShown = false;

void confirmFirmwareIfPendingVerify();
bool applyFirmwareUpdate(JsonObject manifest);
bool verifyManifestSignature(JsonObject manifest);
void showFirmwarePrompt(UiScreen returnScreen);
bool installPendingFirmware();
void pollDisplay();
void fetchGatewayState(bool applyPending = true);
bool applyGatewayProfile(const GatewayProfile& profile, uint32_t revision);
bool postRemoteAction(
  const String& actionId,
  const String& label,
  const String& mediaUploadId = String(),
  bool showThreadOutput = true
);
void openThreadActions();
String beginDurableRequest(const String& signature);
bool fetchThreadOutput(int page, const String& after = String());
void openThreadOutput(const String& after = String());
void reportFirmwareStatus(
  const char* state,
  const char* targetVersion = "",
  const char* detail = "",
  int progress = -1
);
void syncRealtimeEndpoint();

#if ENABLE_EINK
// The driver's framebuffer, defined in lib/ElecrowEPD/EPD.cpp. Drawing helpers
// compose into it; EPD_DisplayImage() then ships it to the panel.
extern "C" uint8_t ImageBW[ALLSCREEN_BYTES];
// Landscape: USE_HORIZONTIAL 2 gives a 250 x 128 logical canvas.
constexpr uint8_t kFontHeight = 16;
// What is currently on the glass, so unchanged state does not burn a refresh.
String lastRenderedSignature;
#endif

String normalizeGatewayBase(String base) {
  base.trim();
  if (base.endsWith("/")) base.remove(base.length() - 1);
  return base;
}

String urlForBase(String base, const char* path) {
  base = normalizeGatewayBase(base);
  return base + path;
}

String urlFor(const char* path) {
  // NVS is the source of truth; the build-time value only seeded it on a blank unit.
  String base = deviceStore.gatewayUrl();
  if (base.length() == 0) base = GATEWAY_BASE_URL;
  return urlForBase(base, path);
}

String activeGatewayBase() {
  String base = deviceStore.gatewayUrl();
  if (base.length() == 0) base = GATEWAY_BASE_URL;
  return normalizeGatewayBase(base);
}

String urlOrigin(String url) {
  url.trim();
  const int schemeEnd = url.indexOf("://");
  if (schemeEnd <= 0) return String();
  const int pathStart = url.indexOf('/', schemeEnd + 3);
  String origin = pathStart < 0 ? url : url.substring(0, pathStart);
  origin.toLowerCase();
  return origin;
}

bool isValidGatewayUrl(const String& url) {
  return gateway_tls::gatewayUrlAllowed(url);
}

bool beginHttp(HTTPClient& http, WiFiClient& plainClient, WiFiClientSecure& secureClient, const String& url) {
  return gateway_tls::beginHttp(http, plainClient, secureClient, url, "crowpanel");
}

int requestJsonAtBase(
  const String& gatewayBase,
  const char* method,
  const char* path,
  const String& body,
  String& response,
  bool updatePrimaryGatewayState
) {
  if (nextGatewayRequestAt > 0 && millis() < nextGatewayRequestAt) {
    response = "rate limited locally";
    return 429;
  }

  // Declaration order is load-bearing, not style.
  //
  // C++ destroys locals in reverse declaration order, and HTTPClient keeps a reference to the
  // client beginHttp() handed it. With HTTPClient declared first it is destroyed LAST — after the
  // client it points at — so ~HTTPClient() calls stop() on freed memory. That crashed as
  // InstrFetchProhibited at PC 0xfffffffd (a call through a dead vtable) and corrupted the lwIP
  // TCP heap on the way out, surfacing later as pbuf_free/tcp_seg_free panics in the tcpip thread.
  // The device was rebooting roughly twice a minute.
  //
  // Clients first, HTTPClient last: it dies first, while what it points at is still alive.
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  HTTPClient http;
  const String url = urlForBase(gatewayBase, path);

  if (!beginHttp(http, plainClient, secureClient, url)) {
    response = "http begin failed";
    return -1;
  }

  http.addHeader("content-type", "application/json");
  http.addHeader("x-device-id", deviceStore.deviceId());
  http.addHeader("x-device-secret", deviceStore.deviceSecret());
  const char* responseHeaders[] = {"retry-after"};
  http.collectHeaders(responseHeaders, 1);

  int code = 0;
  if (strcmp(method, "GET") == 0) {
    code = http.GET();
  } else if (strcmp(method, "POST") == 0) {
    code = http.POST(body);
  } else {
    response = "unsupported method";
    http.end();
    return -1;
  }

  response = http.getString();
  // 401 means the credential itself was rejected: the owner revoked this device, or it was
  // transfer-reset. No amount of retrying fixes that, so surface it as a state with an on-device
  // recovery instead of letting the screen sit on an HTTP code.
  if (updatePrimaryGatewayState) {
    if (code == 401) {
      deviceRevoked = true;
    } else if (code >= 200 && code < 300) {
      deviceRevoked = false;
      revokedScreenShown = false;
    }
  }
  if (code == 429) {
    const int retryAfterSeconds = http.header("retry-after").toInt();
    const uint32_t delayMs = static_cast<uint32_t>(max(1, retryAfterSeconds)) * 1000UL;
    nextGatewayRequestAt = millis() + delayMs;
    Serial.printf("gateway rate limited, backing off for %u ms\n", static_cast<unsigned>(delayMs));
  }
  http.end();
  return code;
}

int requestJson(const char* method, const char* path, const String& body, String& response) {
  String base = deviceStore.gatewayUrl();
  if (base.length() == 0) base = GATEWAY_BASE_URL;
  return requestJsonAtBase(base, method, path, body, response, /*updatePrimaryGatewayState=*/true);
}

void drawDisplay() {
  Serial.printf(
    "[display] view=%u | %s | %s | %s | %s\n",
    static_cast<unsigned>(uiScreen),
    displayModel.title.c_str(),
    displayModel.state.c_str(),
    displayModel.line1.c_str(),
    displayModel.line2.c_str()
  );

#if ENABLE_EINK
  // A full refresh takes over a second and consumes one of the panel's finite
  // update cycles, and the display poll runs every 5s. Only redraw when the
  // rendered content actually differs from what is already on the glass.
  String signature = String(static_cast<unsigned>(uiScreen)) + "\x1f"
    + displayModel.title + "\x1f" + displayModel.state + "\x1f"
    + displayModel.line1 + "\x1f" + displayModel.line2 + "\x1f"
    + String(selectedActionIndex) + "\x1f" + String(selectedMenuIndex) + "\x1f"
    + String(selectedThreadIndex) + "\x1f"
    + String(selectedGatewayProfileIndex) + "\x1f"
    + String(controlsRevision) + "\x1f"
    + String(threadOptionCount) + "\x1f" + String(deviceStore.gatewayProfileCount());
  signature += "\x1f" + responseState + "\x1f" + responseMessageId
    + "\x1f" + String(responsePage) + "/" + String(responsePageCount)
    + "\x1f" + String(followUpActionCount) + "\x1f" + String(selectedFollowUpIndex)
    + (followUpMode ? "1" : "0");
  for (size_t i = 0; i < responseLineCount; i += 1) signature += "\x1e" + responseLines[i];
  for (size_t i = 0; i < followUpActionCount; i += 1) {
    signature += "\x1e" + followUpActions[i].actionId + followUpActions[i].label;
  }
  signature += "\x1f" + pendingFirmwareVersion
    + (firmwareUpdateAvailable ? "1" : "0") + (firmwarePromptOpen ? "1" : "0")
    + (actionConfirmOpen ? "1" : "0") + pendingActionControl.id;
  if (uiScreen == UiScreen::Threads) {
    for (size_t i = 0; i < threadOptionCount; i += 1) {
      signature += "\x1e" + threadOptions[i].id + "\x1f" + threadOptions[i].title
        + "\x1f" + threadOptions[i].status + (threadOptions[i].selected ? "1" : "0");
    }
  } else if (uiScreen == UiScreen::ThreadActions) {
    for (size_t i = 0; i < menuCount; i += 1) {
      signature += "\x1e" + controls[i].id + "\x1f" + controls[i].label
        + controls[i].reason + (controls[i].enabled ? "1" : "0")
        + (controls[i].requiresThread ? "1" : "0")
        + (controls[i].requiresConfirmation ? "1" : "0");
    }
  } else if (uiScreen == UiScreen::Gateways) {
    for (size_t i = 0; i < deviceStore.gatewayProfileCount(); i += 1) {
      const GatewayProfile* profile = deviceStore.gatewayProfile(i);
      if (profile != nullptr) signature += "\x1e" + profile->id + profile->label;
    }
  }
  if (signature == lastRenderedSignature) return;
  lastRenderedSignature = signature;

  ncuri::Frame frame;
  frame.state = displayModel.state;

  if (resetConfirmOpen) {
    frame.title = "RESET//CONFIRM";
    frame.icon = ncuri::Icon::Warning;
    frame.line1 = displayModel.line1;
    frame.line2 = displayModel.line2;
    frame.backLabel = "CANCEL";
  } else if (stopConfirmOpen) {
    frame.title = "STOP//CONFIRM";
    frame.state = "RISK";
    frame.icon = ncuri::Icon::Stop;
    frame.line1 = "Stop active T3 run?";
    frame.line2 = pendingStopLabel;
    frame.backLabel = "CANCEL";
  } else if (actionConfirmOpen) {
    frame.title = "ACTION//CONFIRM";
    frame.state = "CONFIRM";
    frame.icon = ncuri::Icon::Warning;
    frame.line1 = pendingActionControl.label;
    frame.line2 = runtimeConfig.threadId.length() > 0
      ? String("Target ") + shortThreadId(runtimeConfig.threadId)
      : String("Select thread first");
    frame.backLabel = "CANCEL";
  } else if (firmwarePromptOpen) {
    frame.title = "OTA//UPDATE";
    frame.state = "AVAILABLE";
    frame.icon = ncuri::Icon::Firmware;
    frame.line1 = String("Install ") + pendingFirmwareVersion + "?";
    frame.line2 = ENABLE_OTA_APPLY ? String("Signed release ready") : String("USB flash required");
    frame.backLabel = "LATER";
  } else if (uiScreen == UiScreen::Actions) {
    frame.title = "AC//MENU";
    frame.icon = ncuri::Icon::Home;
    frame.listMode = true;
    constexpr size_t actionCount = 3;  // Threads + Gateway + Firmware.
    // The position marker has its own header slot; the title stays a headline.
    frame.position = String(selectedActionIndex + 1) + "/" + String(actionCount);
    frame.state = "READY";
    for (size_t actionIndex = 0; actionIndex < actionCount; actionIndex += 1) {
      ncuri::Row& output = frame.rows[frame.rowCount++];
      output.selected = actionIndex == static_cast<size_t>(selectedActionIndex);
      if (actionIndex == 0) {
        output.label = "Threads";
        output.meta = threadOptionCount > 0 ? String(threadOptionCount) : String("LIST");
        output.icon = ncuri::Icon::Thread;
      } else if (actionIndex == 1) {
        output.label = "Gateway";
        output.meta = "NET";
        output.icon = ncuri::Icon::Gateway;
      } else {
        output.label = firmwareUpdateAvailable
          ? String("Update ") + pendingFirmwareVersion
          : String("Firmware");
        output.meta = firmwareUpdateAvailable ? String("READY") : String("CHECK");
        output.icon = ncuri::Icon::Firmware;
      }
    }
    frame.backLabel = "HOME";
  } else if (uiScreen == UiScreen::Threads) {
    frame.title = "AC//THREADS";
    frame.icon = ncuri::Icon::Thread;
    frame.listMode = threadOptionCount > 0;
    if (threadOptionCount > 0) {
      frame.position = String(selectedThreadIndex + 1) + "/" + String(threadOptionCount);
      frame.state = displayModel.state == "switching" || displayModel.state == "error"
          || displayModel.state == "active"
        ? displayModel.state
        : String("SELECT");
    } else {
      frame.state = displayModel.state;
    }
    if (threadOptionCount == 0) {
      frame.line1 = displayModel.line1;
      frame.line2 = displayModel.line2;
    } else {
      const size_t pageStart = (static_cast<size_t>(selectedThreadIndex) / 3) * 3;
      for (size_t row = 0; row < 3 && pageStart + row < threadOptionCount; row += 1) {
        const size_t threadIndex = pageStart + row;
        const ThreadOption& thread = threadOptions[threadIndex];
        ncuri::Row& output = frame.rows[frame.rowCount++];
        output.label = thread.title;
        output.meta = thread.selected ? String("ACTIVE")
          : (thread.status.length() > 0 ? thread.status : String("IDLE"));
        output.icon = ncuri::Icon::Thread;
        output.selected = threadIndex == static_cast<size_t>(selectedThreadIndex);
      }
    }
    frame.backLabel = "BACK";
  } else if (uiScreen == UiScreen::ThreadActions) {
    frame.title = "T//ACTIONS";
    frame.icon = ncuri::Icon::Action;
    const size_t threadActionCount = menuCount + 1;  // Latest response + assigned actions.
    frame.listMode = true;
    if (threadActionCount > 0) {
      frame.position = String(selectedMenuIndex + 1) + "/" + String(threadActionCount);
      frame.state = "READY";
      const size_t pageStart = (static_cast<size_t>(selectedMenuIndex) / 3) * 3;
      for (size_t row = 0; row < 3 && pageStart + row < threadActionCount; row += 1) {
        const size_t visualIndex = pageStart + row;
        if (visualIndex == 0) {
          ncuri::Row& output = frame.rows[frame.rowCount++];
          output.label = "Latest response";
          output.meta = "VIEW";
          output.icon = ncuri::Icon::Agent;
          output.selected = selectedMenuIndex == 0;
          continue;
        }
        const size_t controlIndex = visualIndex - 1;
        const DeviceControl& control = controls[controlIndex];
        const bool missingThread = control.requiresThread && runtimeConfig.threadId.length() == 0;
        const bool available = control.enabled && !missingThread;
        ncuri::Row& output = frame.rows[frame.rowCount++];
        output.label = control.label;
        output.disabled = !available;
        output.selected = visualIndex == static_cast<size_t>(selectedMenuIndex);
        output.meta = missingThread ? String("THREAD")
          : (!control.enabled ? String("LOCK")
            : (control.requiresConfirmation ? String("CONFIRM") : String("RUN")));
        if (control.kind == "status") {
          output.icon = ncuri::Icon::Status;
          if (available) output.meta = "VIEW";
        } else if (control.kind == "stop") {
          output.icon = ncuri::Icon::Stop;
          if (available) output.meta = "CONFIRM";
        } else {
          output.icon = ncuri::Icon::Action;
        }
      }
    }
    frame.backLabel = "THREAD";
  } else if (uiScreen == UiScreen::ThreadOutput) {
    if (followUpMode) {
      frame.title = "T//FOLLOW UPS";
      frame.icon = ncuri::Icon::Action;
      frame.listMode = followUpActionCount > 0;
      frame.state = followUpActionCount > 0 ? String("SELECT") : String("EMPTY");
      if (followUpActionCount > 0) {
        frame.position = String(selectedFollowUpIndex + 1) + "/" + String(followUpActionCount);
        for (size_t i = 0; i < followUpActionCount; i += 1) {
          ncuri::Row& output = frame.rows[frame.rowCount++];
          output.label = followUpActions[i].label;
          output.meta = "CONFIRM";
          output.icon = ncuri::Icon::Action;
          output.selected = i == static_cast<size_t>(selectedFollowUpIndex);
        }
      } else {
        frame.line1 = "No suggested actions";
        frame.line2 = "EXIT returns to response";
      }
      frame.footerLabel = "ROTATE:MOVE OK:REVIEW";
      frame.backLabel = "BACK";
    } else {
      frame.title = "AGENT//RESPONSE";
      frame.icon = ncuri::Icon::Agent;
      frame.state = responseState;
      frame.textPageMode = true;
      frame.position = String(responsePage + 1) + "/" + String(responsePageCount);
      frame.textLineCount = responseLineCount;
      for (size_t i = 0; i < responseLineCount; i += 1) frame.textLines[i] = responseLines[i];
      frame.footerLabel = followUpActionCount > 0 ? String("ROTATE:PAGE OK:ACTIONS") : String("ROTATE:PAGE OK:REFRESH");
      frame.backLabel = "ACTIONS";
    }
  } else if (uiScreen == UiScreen::Gateways) {
    frame.title = "AC//GATEWAYS";
    frame.icon = ncuri::Icon::Gateway;
    const size_t profileCount = deviceStore.gatewayProfileCount();
    frame.listMode = profileCount > 0;
    if (profileCount > 0) {
      frame.position = String(selectedGatewayProfileIndex + 1) + "/" + String(profileCount);
      frame.state = "SELECT";
    } else {
      frame.state = displayModel.state;
    }
    if (profileCount == 0) {
      frame.line1 = displayModel.line1;
      frame.line2 = displayModel.line2;
    } else {
      const size_t pageStart = (static_cast<size_t>(selectedGatewayProfileIndex) / 3) * 3;
      for (size_t row = 0; row < 3 && pageStart + row < profileCount; row += 1) {
        const size_t profileIndex = pageStart + row;
        const GatewayProfile* profile = deviceStore.gatewayProfile(profileIndex);
        if (profile == nullptr) continue;
        ncuri::Row& output = frame.rows[frame.rowCount++];
        output.label = profile->label;
        const bool active = profile->id == deviceStore.activeGatewayProfileId()
          || normalizeGatewayBase(profile->url) == activeGatewayBase();
        output.meta = active ? String("ACTIVE") : profile->mode;
        output.icon = ncuri::Icon::Gateway;
        output.selected = profileIndex == static_cast<size_t>(selectedGatewayProfileIndex);
      }
    }
    frame.backLabel = "BACK";
  } else {
    frame.title = uiScreen == UiScreen::Home ? String("AGENT//CTRL") : displayModel.title;
    frame.icon = uiScreen == UiScreen::Home ? ncuri::Icon::Agent
      : (displayModel.state == "error" || displayModel.state == "failed" ? ncuri::Icon::Error
        : (displayModel.state == "ready" || displayModel.state == "complete"
          || displayModel.state == "completed" ? ncuri::Icon::Success : ncuri::Icon::Status));
    frame.line1 = displayModel.line1;
    frame.line2 = displayModel.line2;
    if (uiScreen == UiScreen::Home) {
      frame.summaryMode = true;
      frame.rowCount = 3;
      frame.rows[0].icon = ncuri::Icon::Thread;
      frame.rows[0].label = selectedThreadLabel();
      frame.rows[0].meta = runtimeConfig.threadId.length() > 0 ? String("ACTIVE") : String("SELECT");
      frame.rows[1].icon = ncuri::Icon::Gateway;
      frame.rows[1].label = displayModel.line1.length() > 0 ? displayModel.line1 : String("Gateway status pending");
      frame.rows[1].meta = "SYSTEM";
      frame.rows[2].icon = ncuri::Icon::Status;
      frame.rows[2].label = displayModel.line2.length() > 0 ? displayModel.line2 : String("No commands yet");
      frame.rows[2].meta = displayModel.state;
      frame.backLabel = "BACK";
    } else {
      frame.backLabel = "BACK";
    }
  }

  ncuri::render(frame);
#endif
}

void setMenuDefaults() {
  menuCount = sizeof(kFallbackMenu) / sizeof(kFallbackMenu[0]);
  for (size_t i = 0; i < menuCount; i += 1) {
    menuItems[i] = kFallbackMenu[i];
    controls[i].id = kFallbackMenu[i];
    controls[i].actionId = "";
    controls[i].label = kFallbackMenu[i];
    controls[i].kind = "legacy";
    controls[i].mediaKind = "";
    controls[i].reason = "";
    controls[i].enabled = true;
    controls[i].requiresThread = false;
    controls[i].requiresConfirmation = false;
  }
}

void installLegacyMenu(JsonArray menu) {
  if (controlsProtocolV2 || menu.isNull() || menu.size() == 0) return;
  menuCount = menu.size() < kMaxMenuItems ? menu.size() : kMaxMenuItems;
  for (size_t i = 0; i < menuCount; i += 1) {
    const char* item = menu[i] | "";
    menuItems[i] = item;
    controls[i].id = item;
    controls[i].actionId = "";
    controls[i].label = item;
    controls[i].kind = "legacy";
    controls[i].mediaKind = "";
    controls[i].reason = "";
    controls[i].enabled = true;
    controls[i].requiresThread = false;
    controls[i].requiresConfirmation = false;
  }
  if (selectedMenuIndex >= static_cast<int>(menuCount)) selectedMenuIndex = 0;
}

void parseDisplayPayload(const String& payload) {
  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    displayModel.state = "error";
    displayModel.line1 = "Bad display JSON";
    displayModel.line2 = err.c_str();
    return;
  }

  JsonObject displayJson = doc["display"];
  displayModel.title = displayJson["title"] | "Controller";
  displayModel.state = displayJson["state"] | "unknown";
  displayModel.line1 = displayJson["line1"] | "";
  displayModel.line2 = displayJson["line2"] | "";

  JsonArray menu = displayJson["menu"].as<JsonArray>();
  installLegacyMenu(menu);
}

void parseConfigPayload(const String& payload) {
  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    Serial.printf("config parse failed: %s\n", err.c_str());
    return;
  }

  JsonObject config = doc["config"];
  const char* environmentId = config["environmentId"] | "";
  const char* threadId = config["threadId"] | "";
  const char* defaultPrompt = config["defaultPrompt"] | "";
  const char* shellCommand = config["shellCommand"] | "";
  const char* gatewayUrl = config["gatewayUrl"] | "";

  // Empty values are meaningful: clearing the selected task in the dashboard
  // must immediately disable task-bound actions instead of retaining stale NVS context.
  runtimeConfig.environmentId = environmentId;
  runtimeConfig.threadId = threadId;
  if (strlen(defaultPrompt) > 0) runtimeConfig.defaultPrompt = defaultPrompt;
  if (strlen(shellCommand) > 0) runtimeConfig.shellCommand = shellCommand;
  const String candidateGatewayUrl = normalizeGatewayBase(String(gatewayUrl));
  const GatewayProfile* onlyGatewayProfile = deviceStore.gatewayProfile(0);
  const bool legacyGatewayMode = deviceStore.gatewayProfileCount() == 0
    || (deviceStore.gatewayProfileCount() == 1 && onlyGatewayProfile != nullptr
      && onlyGatewayProfile->id == "legacy");
  if (candidateGatewayUrl.length() > 0 && deviceStore.gatewayUrl() != candidateGatewayUrl
      && legacyGatewayMode
      && deviceStore.pendingGatewayProfileId().length() == 0) {
    // Never persist an untested endpoint. A typo or unreachable Tailnet URL would otherwise strand
    // the device until a physical factory reset. The same credential must authenticate against the
    // candidate before NVS changes; a failed probe leaves the known-good gateway untouched.
    String probeResponse;
    const int probeCode = requestJsonAtBase(
      candidateGatewayUrl,
      "GET",
      "/v1/device/config",
      "",
      probeResponse,
      /*updatePrimaryGatewayState=*/false
    );
    if (probeCode >= 200 && probeCode < 300) {
      if (deviceStore.setGatewayUrl(candidateGatewayUrl)) {
        Serial.printf("legacy gateway URL verified and updated from device config: %s\n", candidateGatewayUrl.c_str());
      } else {
        Serial.println("verified gateway URL but failed to persist it");
      }
    } else {
      Serial.printf(
        "gateway URL probe failed code=%d; keeping known-good endpoint %s\n",
        probeCode,
        deviceStore.gatewayUrl().c_str()
      );
    }
  }

  JsonArray menu = config["menu"].as<JsonArray>();
  installLegacyMenu(menu);
}

// A destructive action on a five-key bezel needs a deliberate second press, and the screen showing
// that prompt must survive the display poll — which overwrites displayModel every few seconds and
// would otherwise wipe the prompt out from under the owner mid-decision.

void renderProvisioningState();

void openResetConfirm() {
  resetConfirmOpen = true;
  detailReturnScreen = uiScreen;
  uiScreen = UiScreen::Detail;
  displayModel.title = "Factory reset";
  displayModel.state = "confirm";
  displayModel.line1 = "Erase WiFi + setup?";
  displayModel.line2 = "OK erase / EXIT cancel";
  drawDisplay();
}

void openStopConfirm(const DeviceControl& control) {
  stopConfirmOpen = true;
  pendingStopLegacy = control.kind == "legacy";
  pendingStopActionId = control.actionId.length() > 0 ? control.actionId : String("system_stop");
  pendingStopLabel = control.label.length() > 0 ? control.label : String("Stop run");
  detailReturnScreen = uiScreen == UiScreen::ThreadActions || detailReturnScreen == UiScreen::ThreadActions
    ? UiScreen::ThreadActions
    : UiScreen::Actions;
  uiScreen = UiScreen::Detail;
  displayModel.title = "Stop run";
  displayModel.state = "confirm";
  displayModel.line1 = "Stop active T3 run?";
  displayModel.line2 = "OK stop / EXIT cancel";
  drawDisplay();
}

void openActionConfirm(const DeviceControl& control) {
  actionConfirmOpen = true;
  pendingActionControl = control;
  detailReturnScreen = uiScreen == UiScreen::ThreadOutput
    ? UiScreen::ThreadOutput
    : (uiScreen == UiScreen::ThreadActions || detailReturnScreen == UiScreen::ThreadActions
      ? UiScreen::ThreadActions
      : UiScreen::Actions);
  uiScreen = UiScreen::Detail;
  displayModel.title = "Confirm action";
  displayModel.state = "confirm";
  displayModel.line1 = control.label;
  displayModel.line2 = runtimeConfig.threadId.length() > 0
    ? String("Target ") + shortThreadId(runtimeConfig.threadId)
    : String("Select thread first");
  drawDisplay();
}

void cancelResetConfirm() {
  resetConfirmOpen = false;
  displayModel.title = "Factory reset";
  displayModel.state = "cancelled";
  displayModel.line1 = "Cancelled";
  displayModel.line2 = "Nothing erased";
  drawDisplay();
  // Let the next display poll take the screen back.
  lastDisplayPollAt = 0;
}

void performFactoryReset() {
  resetConfirmOpen = false;
  gatewayMenuOpen = false;
  Serial.println("[reset] confirmed: wiping owner state, keeping device identity");

  displayModel.title = "Factory reset";
  displayModel.state = "erasing";
  displayModel.line1 = "Erasing settings";
  displayModel.line2 = "Do not unplug";
  drawDisplay();

  const bool wiped = deviceStore.wipeToFactoryState();
  deviceRevoked = false;
  revokedScreenShown = false;
  lastSetupCodeAt = 0;
  runtimeConfig.threadId = "";

  if (!wiped) {
    // NVS refused the write. Saying "done" here would be a lie the owner acts on, so report it.
    displayModel.state = "error";
    displayModel.line1 = "Erase failed";
    displayModel.line2 = "Retry or reflash";
    drawDisplay();
    return;
  }

  provisioning.resetToProvisioning();
  renderProvisioningState();
}

// Renders whatever provisioning state the device is in. There is deliberately no blocking wait
// anywhere in this path: the previous `while (WiFi.status() != WL_CONNECTED)` loop meant a wrong
// password, a renamed network, or a house move left the unit spinning forever with "Connecting
// WiFi" on the glass and no way out but a USB reflash.
void renderProvisioningState() {
  const ProvisioningStatus& status = provisioning.status();
  detailReturnScreen = UiScreen::Home;
  uiScreen = status.state == ProvisioningState::Online ? UiScreen::Home : UiScreen::Detail;
  switch (status.state) {
    case ProvisioningState::Provisioning:
      displayModel.title = "Setup";
      displayModel.state = "provisioning";
      displayModel.line1 = "Join " + status.apName;
      displayModel.line2 = status.portalUrl;
      break;
    case ProvisioningState::Connecting:
      displayModel.title = "Next Coder";
      displayModel.state = "connecting";
      displayModel.line1 = "Joining WiFi";
      displayModel.line2 = status.detail;
      break;
    case ProvisioningState::Online:
      uiScreen = UiScreen::Home;
      displayModel.title = "Next Coder";
      displayModel.state = "online";
      displayModel.line1 = "Connected";
      displayModel.line2 = status.detail;
      break;
    default:
      uiScreen = UiScreen::Detail;
      displayModel.title = "Setup";
      displayModel.state = provisioningStateName(status.state);
      displayModel.line1 = "Starting";
      displayModel.line2 = status.detail;
      break;
  }
  drawDisplay();
}

void renderRevoked() {
  detailReturnScreen = UiScreen::Home;
  uiScreen = UiScreen::Detail;
  displayModel.title = "Revoked";
  displayModel.state = "revoked";
  displayModel.line1 = "Access removed";
  displayModel.line2 = "Hold EXIT 10s to reset";
  drawDisplay();
}

bool gatewayReachable() {
  return provisioning.status().state == ProvisioningState::Online;
}

// Every menu action except "reset" is a gateway round trip, and offline those failed with a bare
// "HTTP -1" — a transport error code shown to someone whose actual problem is that the controller
// is not on a network. Name the cause, and keep the remedy on screen: the provisioning detail is
// the SSID to join or the network being joined, which is what the owner needs next.
void renderNotConnected(const String& action) {
  if (uiScreen != UiScreen::Detail) detailReturnScreen = uiScreen;
  uiScreen = UiScreen::Detail;
  const ProvisioningStatus& status = provisioning.status();
  displayModel.title = "Not connected";
  displayModel.state = "offline";
  displayModel.line1 = (action.length() ? action : String("Action")) + " needs network";
  displayModel.line2 = status.detail.length() ? status.detail : String("Join " + status.apName);
  drawDisplay();
}

void sendHeartbeat() {
  String response;
  JsonDocument doc;
  doc["protocolVersion"] = 2;
  doc["firmwareVersion"] = FIRMWARE_VERSION;
  doc["hardwareModel"] = HARDWARE_MODEL;
  JsonArray features = doc["features"].to<JsonArray>();
  features.add("display");
  features.add("buttons");
  features.add("ota");
  features.add("ota_confirm");
  features.add("thread_picker");
#if ENABLE_AUDIO_CAPTURE
  features.add("microphone");
#endif
#if ENABLE_CAMERA_CAPTURE
  features.add("camera");
#endif
  JsonObject limits = doc["limits"].to<JsonObject>();
  limits["menuItems"] = kMaxMenuItems;
  limits["threadItems"] = kMaxThreadOptions;
  limits["labelCharacters"] = 18;
  limits["mediaUploadBytes"] = MEDIA_UPLOAD_MAX_BYTES;
  doc["ipAddress"] = WiFi.localIP().toString();
  doc["wifiRssi"] = WiFi.RSSI();
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["uptimeMs"] = millis();
  JsonObject gateway = doc["gateway"].to<JsonObject>();
  gateway["revision"] = deviceStore.gatewayRevision();
  gateway["state"] = deviceStore.gatewaySwitchState();
  gateway["activeProfileId"] = deviceStore.activeGatewayProfileId();
  gateway["activeUrl"] = activeGatewayBase();
  if (deviceStore.pendingGatewayProfileId().length() > 0) {
    gateway["pendingProfileId"] = deviceStore.pendingGatewayProfileId();
    gateway["pendingUrl"] = deviceStore.pendingGatewayUrl();
  }
  if (deviceStore.gatewaySwitchDetail().length() > 0) {
    gateway["detail"] = deviceStore.gatewaySwitchDetail();
  }
  String body;
  serializeJson(doc, body);
  const int code = requestJson("POST", "/v1/device/heartbeat", body, response);
  Serial.printf("heartbeat code=%d response=%s\n", code, response.c_str());

  // A reachable gateway is our health signal: only then is a freshly flashed image confirmed.
  if (code >= 200 && code < 300) confirmFirmwareIfPendingVerify();
}

void reportFirmwareStatus(const char* state, const char* targetVersion, const char* detail, int progress) {
  JsonDocument doc;
  doc["state"] = state;
  doc["version"] = FIRMWARE_VERSION;
  if (strlen(targetVersion) > 0) doc["targetVersion"] = targetVersion;
  if (strlen(detail) > 0) doc["detail"] = detail;
  if (progress >= 0) doc["progress"] = progress;
  String body;
  serializeJson(doc, body);
  String response;
  const int code = requestJson("POST", "/v1/device/firmware/status", body, response);
  Serial.printf("firmware status=%s code=%d response=%s\n", state, code, response.c_str());
}

void handleOtaBootAttempt() {
  const uint32_t attempts = deviceStore.registerOtaBootAttempt(FIRMWARE_VERSION);
  if (attempts == 0) return;
  Serial.printf("OTA target %s boot attempt=%u\n", FIRMWARE_VERSION, static_cast<unsigned>(attempts));
  if (attempts < 2) return;

  // Arduino-ESP32's distributed bootloader can mark a freshly selected image
  // VALID immediately even when the application headers advertise rollback.
  // Preserve a second recovery layer: if the target restarts before its first
  // healthy heartbeat, send the boot selector back to the other OTA slot.
  const esp_partition_t* previous = esp_ota_get_next_update_partition(nullptr);
  if (previous == nullptr || esp_ota_set_boot_partition(previous) != ESP_OK) {
    Serial.println("OTA application rollback failed: previous partition unavailable");
    return;
  }
  Serial.printf("OTA application rollback selecting %s\n", previous->label);
  delay(500);
  ESP.restart();
}

// Roadmap Phase 12 requires an OTA pipeline with a rollback process, not just a download.
//
// With CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE the bootloader marks a newly flashed image
// PENDING_VERIFY. If the firmware never confirms itself, the next reset rolls back to the previous
// image automatically. Confirming on a successful heartbeat means an image that boots but cannot
// reach the gateway is rolled back instead of bricking the controller.
void confirmFirmwareIfPendingVerify() {
  static bool confirmed = false;
  if (confirmed) return;

  const String otaSource = deviceStore.otaSourceVersion();
  const String otaTarget = deviceStore.otaTargetVersion();
  if (otaTarget.length() > 0 && otaSource == FIRMWARE_VERSION && otaTarget != FIRMWARE_VERSION) {
    Serial.printf("OTA rollback detected: target=%s running=%s\n", otaTarget.c_str(), FIRMWARE_VERSION);
    reportFirmwareStatus("rolled_back", otaTarget.c_str(), "bootloader restored previous image", 100);
    deviceStore.clearOtaAttempt();
    confirmed = true;
    return;
  }

  const esp_partition_t* running = esp_ota_get_running_partition();
  if (running == nullptr) return;

  esp_ota_img_states_t state;
  if (esp_ota_get_state_partition(running, &state) != ESP_OK) return;
  if (otaTarget == FIRMWARE_VERSION) {
    if (state == ESP_OTA_IMG_PENDING_VERIFY
        && esp_ota_mark_app_valid_cancel_rollback() != ESP_OK) {
      Serial.println("failed to confirm OTA image; it will roll back on next reset");
      reportFirmwareStatus("failed", FIRMWARE_VERSION, "pending image verification failed");
      return;
    }
    confirmed = true;
    Serial.println("OTA image confirmed healthy");
    reportFirmwareStatus("verified", FIRMWARE_VERSION, "heartbeat healthy", 100);
    deviceStore.clearOtaAttempt();
    return;
  }

  if (state != ESP_OTA_IMG_PENDING_VERIFY) {
    confirmed = true;  // Normal boot with no recorded OTA attempt.
    return;
  }

  if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
    confirmed = true;
    Serial.println("OTA image confirmed healthy; rollback cancelled");
    reportFirmwareStatus("verified", FIRMWARE_VERSION, "heartbeat healthy", 100);
    deviceStore.clearOtaAttempt();
  } else {
    Serial.println("failed to confirm OTA image; it will roll back on next reset");
    reportFirmwareStatus("failed", FIRMWARE_VERSION, "pending image verification failed");
  }
}

void showCachedClaimCode() {
  displayModel.title = "Setup";
  displayModel.state = "unclaimed";
  if (deviceStore.hasClaimCode()) {
    displayModel.line1 = "Claim code";
    displayModel.line2 = deviceStore.claimCode();
  } else {
    // No cached code and the gateway will not reissue a live one, so the code printed at
    // manufacture is the only copy that exists. Saying "No code" sent owners looking for a fault
    // when the answer was sitting on the box in their hand.
    displayModel.line1 = "Use code on box";
    displayModel.line2 = "Lost it? See dashboard";
  }
  drawDisplay();
}

// `rotate` is the owner asking for a replacement code ("I lost the card"), driven by a menu action,
// never by a timer. Left false, this is safe to call on every 403: the gateway answers "the existing
// code is still valid" and hands back nothing, so the code printed on the box survives.
void fetchSetupCode(bool force = false, bool rotate = false) {
  // A cached code is the normal answer. Without this the device would ask the gateway on every
  // unclaimed poll, which is exactly the traffic the stable-code change was made to allow.
  if (!rotate && deviceStore.hasClaimCode()) {
    showCachedClaimCode();
    if (!force) return;
  }
  if (!force && !rotate && lastSetupCodeAt > 0
      && millis() - lastSetupCodeAt < kSetupCodeRefreshIntervalMs) {
    return;
  }

  String response;
  const String body = rotate ? "{\"rotate\":true}" : "{\"rotate\":false}";
  const int code = requestJson("POST", "/v1/device/setup-code", body, response);
  lastSetupCodeAt = millis();
  if (code < 200 || code >= 300) {
    Serial.printf("setup code fetch code=%d response=%s\n", code, response.c_str());
    // Falling back to the cached code keeps the setup screen usable through a gateway outage.
    if (deviceStore.hasClaimCode()) showCachedClaimCode();
    return;
  }

  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, response);
  if (err) {
    Serial.printf("setup code parse failed: %s\n", err.c_str());
    return;
  }

  JsonObject setup = doc["setup"];
  const bool claimed = setup["claimed"] | false;
  const bool rotated = setup["rotated"] | false;
  const char* claimCode = setup["claimCode"] | doc["claimCode"] | "";
  const char* expiresAt = setup["claimCodeExpiresAt"] | doc["claimCodeExpiresAt"] | "";

  if (claimed) {
    deviceStore.clearClaimCode();
    displayModel.title = "Next Coder";
    displayModel.state = "claimed";
    displayModel.line1 = "Device claimed";
    displayModel.line2 = "Loading config";
    drawDisplay();
    return;
  }

  // The plaintext is returned exactly once, at issue, because the gateway stores only its hash.
  // Persisting it here is what lets the endpoint stop rotating on every call.
  if (rotated && strlen(claimCode) > 0) {
    deviceStore.setClaimCode(String(claimCode), String(expiresAt));
    Serial.printf("[setup] new claim code issued, expires %s\n", expiresAt);
  }
  showCachedClaimCode();
}

void fetchDeviceConfig() {
  String response;
  const int code = requestJson("GET", "/v1/device/config", "", response);
  if (code >= 200 && code < 300) {
    parseConfigPayload(response);
    Serial.printf(
      "config loaded env=%s thread=%s shell=%s menu=%u\n",
      runtimeConfig.environmentId.c_str(),
      runtimeConfig.threadId.c_str(),
      runtimeConfig.shellCommand.c_str(),
      static_cast<unsigned>(menuCount)
    );
  } else {
    Serial.printf("config fetch code=%d response=%s\n", code, response.c_str());
    if (code == 403) fetchSetupCode();
  }
}

uint32_t gatewayRevisionFromPayload(const String& payload, uint32_t fallback) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return fallback;
  JsonObject root = doc["gateway"].as<JsonObject>();
  if (root.isNull()) root = doc.as<JsonObject>();
  return root["revision"] | fallback;
}

int postGatewaySwitchAtBase(
  const String& base,
  uint32_t revision,
  const String& profileId,
  const char* status,
  const String& detail,
  String& response
) {
  JsonDocument doc;
  doc["revision"] = revision;
  doc["profileId"] = profileId;
  doc["status"] = status;
  // The backend treats activeUrl as proof of the selected profile, not as fallback telemetry.
  // Omit it for requested/failed; on applied the request is deliberately sent through candidate.
  if (strcmp(status, "applied") == 0) doc["activeUrl"] = normalizeGatewayBase(base);
  if (detail.length() > 0) doc["detail"] = detail;
  String body;
  serializeJson(doc, body);
  return requestJsonAtBase(
    base,
    "POST",
    "/v1/device/gateway/switch",
    body,
    response,
    /*updatePrimaryGatewayState=*/base == activeGatewayBase()
  );
}

void renderGatewaySelection() {
  uiScreen = UiScreen::Gateways;
  const GatewayProfile* profile = deviceStore.gatewayProfile(
    static_cast<size_t>(selectedGatewayProfileIndex)
  );
  displayModel.title = "Gateway profiles";
  displayModel.state = deviceStore.gatewaySwitchState();
  if (profile == nullptr) {
    displayModel.line1 = "No profiles synced";
    displayModel.line2 = "Use app to add one";
  } else {
    displayModel.line1 = profile->label;
    const bool active = profile->id == deviceStore.activeGatewayProfileId()
      || normalizeGatewayBase(profile->url) == activeGatewayBase();
    String mode = profile->mode;
    mode.toUpperCase();
    displayModel.line2 = active ? String("Active - ") + mode : String("OK switch - ") + mode;
  }
  drawDisplay();
}

bool applyGatewayProfile(const GatewayProfile& profile, uint32_t revision) {
  detailReturnScreen = UiScreen::Actions;
  uiScreen = UiScreen::Detail;
  const String previousBase = activeGatewayBase();
  const String candidateBase = normalizeGatewayBase(profile.url);
  if (!isValidGatewayUrl(candidateBase)) {
    deviceStore.failGatewaySwitch("invalid profile URL", revision);
    return false;
  }
  if (!deviceStore.stageGatewaySwitch(profile, revision)) {
    displayModel.title = "Gateway switch";
    displayModel.state = "error";
    displayModel.line1 = "Could not save state";
    displayModel.line2 = "Still using old URL";
    drawDisplay();
    return false;
  }

  displayModel.title = "Gateway switch";
  displayModel.state = "probing";
  displayModel.line1 = profile.label;
  displayModel.line2 = "Testing connection";
  drawDisplay();

  // The same device credential must work at the candidate before it can become the NVS source of
  // truth. Tailnet profiles are simply URLs routed to this endpoint by the LAN/subnet router or an
  // overlay bridge; the ESP32 does not attempt to run a Tailscale client.
  String probeResponse;
  const int probeCode = requestJsonAtBase(
    candidateBase,
    "GET",
    "/v1/device/config",
    "",
    probeResponse,
    /*updatePrimaryGatewayState=*/false
  );
  if (probeCode < 200 || probeCode >= 300) {
    const String detail = String("candidate HTTP ") + probeCode;
    String failureResponse;
    postGatewaySwitchAtBase(previousBase, revision, profile.id, "failed", detail, failureResponse);
    deviceStore.failGatewaySwitch(detail, gatewayRevisionFromPayload(failureResponse, revision));
    displayModel.state = "failed";
    displayModel.line1 = "Gateway unreachable";
    displayModel.line2 = "Kept previous URL";
    drawDisplay();
    return false;
  }

  String applyResponse;
  const int applyCode = postGatewaySwitchAtBase(
    candidateBase,
    revision,
    profile.id,
    "applied",
    "candidate authenticated",
    applyResponse
  );
  if (applyCode < 200 || applyCode >= 300) {
    const String detail = String("apply ACK HTTP ") + applyCode;
    String failureResponse;
    postGatewaySwitchAtBase(previousBase, revision, profile.id, "failed", detail, failureResponse);
    deviceStore.failGatewaySwitch(detail, gatewayRevisionFromPayload(failureResponse, revision));
    displayModel.state = "failed";
    displayModel.line1 = "Switch not accepted";
    displayModel.line2 = "Kept previous URL";
    drawDisplay();
    return false;
  }

  const uint32_t appliedRevision = gatewayRevisionFromPayload(applyResponse, revision);
  if (!deviceStore.completeGatewaySwitch(profile, appliedRevision)) {
    // The old gw_url is still the boot source because completeGatewaySwitch writes it only after
    // all journal metadata required to resume exists. Surface the storage fault; never claim the
    // controller moved when NVS did not.
    displayModel.state = "error";
    displayModel.line1 = "Gateway applied";
    displayModel.line2 = "NVS commit failed";
    drawDisplay();
    return false;
  }

  syncRealtimeEndpoint();
  nextGatewayRequestAt = 0;
  displayModel.state = "stable";
  displayModel.line1 = profile.label;
  displayModel.line2 = "Gateway active";
  drawDisplay();
  // Force all gateway-owned state to refresh through the newly active route.
  lastHeartbeatAt = 0;
  lastConfigPollAt = 0;
  lastControlsPollAt = 0;
  lastDisplayPollAt = 0;
  return true;
}

bool parseGatewayState(const String& payload, bool applyPending) {
  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    Serial.printf("gateway profile parse failed: %s\n", error.c_str());
    return false;
  }
  JsonObject root = doc["gateway"].as<JsonObject>();
  if (root.isNull()) root = doc.as<JsonObject>();
  JsonArray inputProfiles = root["profiles"].as<JsonArray>();
  if (inputProfiles.isNull()) {
    Serial.println("gateway response missing profiles");
    return false;
  }

  GatewayProfile parsed[kMaxGatewayProfiles];
  size_t count = 0;
  for (JsonObject input : inputProfiles) {
    if (count >= kMaxGatewayProfiles) break;
    GatewayProfile profile;
    profile.id = String(input["id"] | "");
    profile.label = String(input["label"] | "");
    profile.mode = String(input["mode"] | "custom");
    const char* url = input["url"] | "";
    if (strlen(url) == 0) url = input["baseUrl"] | "";
    profile.url = normalizeGatewayBase(String(url));
    const bool validMode = profile.mode == "lan" || profile.mode == "tailnet" || profile.mode == "custom";
    if (profile.id.length() == 0 || profile.label.length() == 0 || !validMode
        || !isValidGatewayUrl(profile.url)) {
      Serial.printf("ignoring invalid gateway profile id=%s\n", profile.id.c_str());
      continue;
    }
    parsed[count] = profile;
    count += 1;
  }
  if (count == 0) {
    Serial.println("gateway response contained no usable profiles");
    return false;
  }

  const uint32_t revision = root["revision"] | 0U;
  const String activeProfileId = String(root["activeProfileId"] | "");
  if (!deviceStore.replaceGatewayProfiles(parsed, count, revision, activeProfileId)) {
    Serial.println("failed to persist gateway profiles");
    return false;
  }

  const String state = String(root["state"] | "stable");
  const String pendingProfileId = String(root["pendingProfileId"] | "");
  if (state == "failed") {
    deviceStore.failGatewaySwitch(String(root["lastError"] | "gateway rejected switch"), revision);
    return true;
  }
  if (state == "stable" && pendingProfileId.length() == 0
      && deviceStore.pendingGatewayProfileId().length() == 0) {
    deviceStore.clearGatewaySwitchFailure();
  }
  if (!applyPending) return true;

  String candidateId = pendingProfileId;
  // A persisted local journal survives reset and takes precedence over an empty server pending
  // field. POST `applied` explicitly permits this hardware-local recovery case.
  if (candidateId.length() == 0 && deviceStore.pendingGatewayProfileId().length() > 0) {
    candidateId = deviceStore.pendingGatewayProfileId();
  }
  if (candidateId.length() > 0) {
    const GatewayProfile* candidate = deviceStore.findGatewayProfile(candidateId);
    if (candidate != nullptr) {
      GatewayProfile copy = *candidate;
      return applyGatewayProfile(copy, revision);
    }
  }
  return true;
}

void fetchGatewayState(bool applyPending) {
  String response;
  const int code = requestJson("GET", "/v1/device/gateway", "", response);
  if (code >= 200 && code < 300) {
    parseGatewayState(response, applyPending);
    return;
  }
  // Dedicated profiles are protocol-v2 functionality. A legacy gateway remains usable through
  // gw_url and the portal even when it does not implement these routes.
  if (code != 404 && code != 501) {
    Serial.printf("gateway profile fetch code=%d response=%s\n", code, response.c_str());
  }
}

bool requestLocalGatewaySwitch(const GatewayProfile& profile) {
  if (normalizeGatewayBase(profile.url) == activeGatewayBase()) {
    displayModel.state = "stable";
    displayModel.line1 = profile.label;
    displayModel.line2 = "Already active";
    drawDisplay();
    return true;
  }
  String response;
  const int code = postGatewaySwitchAtBase(
    activeGatewayBase(),
    deviceStore.gatewayRevision(),
    profile.id,
    "requested",
    "selected on controller",
    response
  );
  if (code < 200 || code >= 300) {
    displayModel.title = "Gateway switch";
    displayModel.state = "failed";
    displayModel.line1 = "Request rejected";
    displayModel.line2 = String("HTTP ") + code;
    drawDisplay();
    if (code == 409) fetchGatewayState(/*applyPending=*/false);
    return false;
  }
  return applyGatewayProfile(profile, gatewayRevisionFromPayload(response, deviceStore.gatewayRevision()));
}

void openGatewayMenu() {
  uiScreen = UiScreen::Gateways;
  gatewayMenuOpen = true;
  fetchGatewayState(/*applyPending=*/true);
  if (deviceStore.gatewayProfileCount() == 0) {
    displayModel.title = "Gateway profiles";
    displayModel.state = "empty";
    displayModel.line1 = "No profiles synced";
    displayModel.line2 = "Configure in app";
    drawDisplay();
    return;
  }
  selectedGatewayProfileIndex = 0;
  for (size_t index = 0; index < deviceStore.gatewayProfileCount(); index += 1) {
    const GatewayProfile* profile = deviceStore.gatewayProfile(index);
    if (profile != nullptr && (profile->id == deviceStore.activeGatewayProfileId()
        || normalizeGatewayBase(profile->url) == activeGatewayBase())) {
      selectedGatewayProfileIndex = static_cast<int>(index);
      break;
    }
  }
  renderGatewaySelection();
}

bool isSupportedControlKind(const String& kind) {
  return kind == "status" || kind == "remote_action" || kind == "capture_audio"
    || kind == "capture_image" || kind == "stop" || kind == "reset";
}

bool parseControlsPayload(const String& payload) {
  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    Serial.printf("controls parse failed: %s\n", err.c_str());
    return false;
  }

  // `layout` is accepted as a harmless envelope for early gateway builds; the
  // documented v2 response places revision and controls at the top level.
  JsonObject root = doc["layout"].as<JsonObject>();
  if (root.isNull()) root = doc.as<JsonObject>();
  JsonArray items = root["controls"].as<JsonArray>();
  if (items.isNull()) {
    Serial.println("controls response missing controls array");
    return false;
  }
  const uint32_t revision = root["revision"] | 0U;
  if (revision == 0) {
    Serial.println("controls response missing positive revision");
    return false;
  }

  DeviceControl parsed[kMaxMenuItems];
  size_t parsedCount = 0;
  const size_t receivedCount = items.size();
  for (JsonObject item : items) {
    if (parsedCount >= kMaxMenuItems) break;
    const char* id = item["id"] | "";
    const char* label = item["label"] | "";
    const char* kind = item["kind"] | "";
    if (strlen(id) == 0 || strlen(label) == 0 || strlen(kind) == 0) {
      Serial.println("ignoring malformed control without id, label, or kind");
      continue;
    }

    DeviceControl& control = parsed[parsedCount];
    control.id = id;
    const char* actionId = item["actionId"] | "";
    control.actionId = strlen(actionId) > 0 ? String(actionId) : control.id;
    control.label = label;
    control.kind = kind;
    control.mediaKind = item["mediaKind"] | "";
    control.reason = item["reason"] | "";
    control.enabled = item["enabled"] | true;
    control.requiresThread = item["requiresThread"] | false;
    control.requiresConfirmation = item["requiresConfirmation"] | false;
    if (!isSupportedControlKind(control.kind)) {
      control.enabled = false;
      control.reason = "Unsupported control";
    }
    parsedCount += 1;
  }

  for (size_t i = 0; i < parsedCount; i += 1) {
    controls[i] = parsed[i];
    menuItems[i] = parsed[i].label;
  }
  menuCount = parsedCount;
  controlsProtocolV2 = true;
  controlsRevision = revision;
  if (selectedMenuIndex >= static_cast<int>(menuCount)) selectedMenuIndex = 0;

  if (receivedCount > kMaxMenuItems) {
    Serial.printf(
      "controls truncated received=%u limit=%u\n",
      static_cast<unsigned>(receivedCount),
      static_cast<unsigned>(kMaxMenuItems)
    );
  }
  return true;
}

void acknowledgeControls() {
  if (!controlsProtocolV2 || acknowledgedControlsRevision == controlsRevision) return;
  const String body = String("{\"revision\":") + controlsRevision
    + ",\"protocolVersion\":2,\"appliedCount\":" + menuCount + "}";
  String response;
  const int code = requestJson("POST", "/v1/device/controls/ack", body, response);
  Serial.printf(
    "controls ack revision=%u code=%d response=%s\n",
    static_cast<unsigned>(controlsRevision), code, response.c_str()
  );
  if (code >= 200 && code < 300) acknowledgedControlsRevision = controlsRevision;
}

void fetchDeviceControls() {
  String response;
  const int code = requestJson("GET", "/v1/device/controls", "", response);
  if (code >= 200 && code < 300) {
    if (parseControlsPayload(response)) {
      Serial.printf(
        "controls loaded revision=%u count=%u\n",
        static_cast<unsigned>(controlsRevision),
        static_cast<unsigned>(menuCount)
      );
      acknowledgeControls();
      drawDisplay();
    }
    return;
  }

  // 404/501 means the gateway predates protocol v2. The config/display menu
  // already in memory remains authoritative. A transient failure after a v2
  // sync never destroys the last-known-good controls cache.
  if (code == 404 || code == 501) {
    Serial.println("controls v2 unavailable; using legacy config menu");
  } else {
    Serial.printf("controls fetch code=%d response=%s\n", code, response.c_str());
  }
  if (code == 403) fetchSetupCode();
}

void pollFirmwareManifest() {
  lastFirmwarePollSucceeded = false;
  String response;
  String path = String("/v1/device/firmware?version=") + FIRMWARE_VERSION + "&hardware=" + HARDWARE_MODEL;
  const int code = requestJson("GET", path.c_str(), "", response);
  if (code < 200 || code >= 300) {
    Serial.printf("firmware poll code=%d response=%s\n", code, response.c_str());
    return;
  }

  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, response);
  if (err) {
    Serial.printf("firmware manifest parse failed: %s\n", err.c_str());
    return;
  }
  lastFirmwarePollSucceeded = true;

  const bool updateAvailable = doc["updateAvailable"] | false;
  if (!updateAvailable) {
    Serial.println("firmware current");
    firmwareUpdateAvailable = false;
    firmwarePromptOpen = false;
    firmwarePromptDeferred = false;
    pendingFirmwareRequiresConfirmation = false;
    pendingFirmwareVersion = "";
    pendingFirmwareManifestJson = "";
    return;
  }

  JsonObject manifest = doc["manifest"];
  const char* version = manifest["version"] | "";
  const String nextVersion = String(version);
  const bool newlyAvailable = !firmwareUpdateAvailable || pendingFirmwareVersion != nextVersion;
  const String installation = String(doc["installation"] | "automatic");
  Serial.printf(
    "firmware update available version=%s installation=%s\n",
    version,
    installation.c_str()
  );

  firmwareUpdateAvailable = true;
  pendingFirmwareVersion = nextVersion;
  pendingFirmwareManifestJson = response;
  pendingFirmwareRequiresConfirmation = installation != "automatic";
  if (newlyAvailable) {
    reportFirmwareStatus(
      "available",
      version,
      installation == "automatic" ? "automatic install authorized" : "waiting for local confirmation"
    );
  }

  if (installation == "automatic") {
    displayModel.line1 = String("Update ") + version;
    displayModel.line2 = ENABLE_OTA_APPLY ? "Applying OTA" : "OTA unavailable";
    drawDisplay();
    if (!applyFirmwareUpdate(manifest)) {
      displayModel.state = "error";
      displayModel.line1 = "Update failed";
      displayModel.line2 = "See dashboard status";
      drawDisplay();
    }
    return;
  }

  // A manual/notify policy informs the person at the controller but never writes flash without
  // their OK. Do not interrupt another confirmation or a list they are actively navigating; the
  // pending release is also exposed as an Actions row and is prompted on the next return Home.
  if (newlyAvailable) firmwarePromptDeferred = true;
  if (uiScreen == UiScreen::Home && !resetConfirmOpen && !stopConfirmOpen) {
    showFirmwarePrompt(UiScreen::Home);
  } else if (uiScreen == UiScreen::Actions) {
    drawDisplay();
  }
}

void showFirmwarePrompt(UiScreen returnScreen) {
  if (!firmwareUpdateAvailable || pendingFirmwareVersion.length() == 0) return;
  firmwarePromptReturnScreen = returnScreen;
  firmwarePromptOpen = true;
  firmwarePromptDeferred = false;
  displayModel.state = "available";
  displayModel.line1 = String("Install ") + pendingFirmwareVersion;
  displayModel.line2 = ENABLE_OTA_APPLY ? "OK installs update" : "USB flash required";
  drawDisplay();
}

bool installPendingFirmware() {
  if (!firmwareUpdateAvailable || pendingFirmwareManifestJson.length() == 0) return false;
#if !ENABLE_OTA_APPLY
  firmwarePromptOpen = false;
  detailReturnScreen = firmwarePromptReturnScreen;
  uiScreen = UiScreen::Detail;
  displayModel.state = "blocked";
  displayModel.line1 = "OTA apply disabled";
  displayModel.line2 = "Use USB bootstrap";
  drawDisplay();
  return false;
#else
  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, pendingFirmwareManifestJson);
  if (err || !doc["manifest"].is<JsonObject>()) {
    firmwarePromptOpen = false;
    detailReturnScreen = firmwarePromptReturnScreen;
    uiScreen = UiScreen::Detail;
    displayModel.state = "error";
    displayModel.line1 = "Update data invalid";
    displayModel.line2 = "Poll again later";
    drawDisplay();
    return false;
  }

  firmwarePromptOpen = false;
  detailReturnScreen = firmwarePromptReturnScreen;
  uiScreen = UiScreen::Detail;
  const bool applied = applyFirmwareUpdate(doc["manifest"].as<JsonObject>());
  if (!applied) {
    displayModel.state = "error";
    displayModel.line1 = "Update failed";
    displayModel.line2 = "See dashboard status";
    drawDisplay();
  }
  return applied;
#endif
}

void pollDisplay() {
  // A confirmation prompt the owner is reading must not be overwritten by a routine poll. Without
  // this the "erase everything?" screen survives about five seconds.
  if (resetConfirmOpen || firmwarePromptOpen) return;
  if (uiScreen == UiScreen::ThreadOutput) {
    if (!followUpMode && (responseState == "waiting" || responseState == "streaming")) {
      fetchThreadOutput(responsePage, responseAfter);
    }
    return;
  }
  if (uiScreen != UiScreen::Home) return;

  String response;
  const int code = requestJson("GET", "/v1/device/display", "", response);
  if (code >= 200 && code < 300) {
    parseDisplayPayload(response);
  } else if (code == 403) {
    fetchSetupCode();
    return;
  } else {
    displayModel.state = "error";
    displayModel.line1 = "Display poll failed";
    displayModel.line2 = String("HTTP ") + code;
  }
  drawDisplay();
}

String jsonEscape(const char* text) {
  String out;
  while (*text) {
    if (*text == '"' || *text == '\\') out += '\\';
    out += *text;
    text += 1;
  }
  return out;
}

String hexDigest(const uint8_t* data, size_t length) {
  static const char* digits = "0123456789abcdef";
  String output;
  output.reserve(length * 2);
  for (size_t index = 0; index < length; index += 1) {
    output += digits[(data[index] >> 4) & 0x0F];
    output += digits[data[index] & 0x0F];
  }
  return output;
}

String jsonStringValue(const char* text) {
  String output = "\"";
  while (*text) {
    if (*text == '"' || *text == '\\') output += '\\';
    output += *text;
    text += 1;
  }
  output += "\"";
  return output;
}

String canonicalManifestJson(JsonObject manifest) {
  String output = "{";
  // Keep this key order identical to manufacturing.mjs stableJson(): adding a signed manifest
  // field on the gateway without adding it here makes every secure OTA update fail closed.
  output += "\"channel\":" + jsonStringValue(manifest["channel"] | "stable");
  output += ",\"createdAt\":" + jsonStringValue(manifest["createdAt"] | "");
  output += ",\"hardwareModel\":" + jsonStringValue(manifest["hardwareModel"] | "");
  output += ",\"mandatory\":";
  output += (manifest["mandatory"] | false) ? "true" : "false";
  output += ",\"releaseNotes\":" + jsonStringValue(manifest["releaseNotes"] | "");
  output += ",\"sha256\":" + jsonStringValue(manifest["sha256"] | "");
  output += ",\"sizeBytes\":";
  output += String(static_cast<unsigned long>(manifest["sizeBytes"] | 0));
  output += ",\"url\":" + jsonStringValue(manifest["url"] | "");
  output += ",\"version\":" + jsonStringValue(manifest["version"] | "");
  output += "}";
  return output;
}

bool verifyManifestSignature(JsonObject manifest) {
#if REQUIRE_OTA_SIGNATURE
  const char* signature = manifest["signature"] | "";
  if (strlen(signature) == 0 || strlen(OTA_MANIFEST_VERIFY_KEY) == 0) {
    Serial.println("manifest signature or verify key missing");
    return false;
  }

  const String canonical = canonicalManifestJson(manifest);
  uint8_t digest[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!info) return false;
  const int result = mbedtls_md_hmac(
    info,
    reinterpret_cast<const unsigned char*>(OTA_MANIFEST_VERIFY_KEY),
    strlen(OTA_MANIFEST_VERIFY_KEY),
    reinterpret_cast<const unsigned char*>(canonical.c_str()),
    canonical.length(),
    digest
  );
  if (result != 0) {
    Serial.printf("manifest hmac failed: %d\n", result);
    return false;
  }
  const String expected = hexDigest(digest, sizeof(digest));
  if (!expected.equalsIgnoreCase(signature)) {
    Serial.printf("manifest signature mismatch expected=%s got=%s\n", expected.c_str(), signature);
    return false;
  }
#endif
  return true;
}

bool applyFirmwareUpdate(JsonObject manifest) {
#if !ENABLE_OTA_APPLY
  Serial.println("OTA apply disabled by ENABLE_OTA_APPLY");
  return false;
#else
  const char* firmwareUrl = manifest["url"] | "";
  const char* expectedSha = manifest["sha256"] | "";
  const char* targetVersion = manifest["version"] | "";
  if (!verifyManifestSignature(manifest)) {
    reportFirmwareStatus("failed", targetVersion, "manifest signature invalid");
    return false;
  }

  const size_t expectedSize = static_cast<size_t>(manifest["sizeBytes"] | 0);
  if (strlen(firmwareUrl) == 0 || strlen(expectedSha) != 64 || expectedSize == 0) {
    Serial.println("firmware manifest is incomplete");
    reportFirmwareStatus("failed", targetVersion, "manifest incomplete");
    return false;
  }

  reportFirmwareStatus("downloading", targetVersion, "download started", 0);

  // Clients first, HTTPClient last; see the note in requestJsonAtBase().
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  HTTPClient http;
  String downloadUrl = String(firmwareUrl);
  if (downloadUrl.startsWith("/")) downloadUrl = activeGatewayBase() + downloadUrl;
  if (!beginHttp(http, plainClient, secureClient, downloadUrl)) {
    Serial.println("firmware http begin failed");
    reportFirmwareStatus("failed", targetVersion, "download connection failed");
    return false;
  }

  // Private firmware artifacts are proxied by the gateway. Authenticate same-origin downloads,
  // but never forward the device secret to an arbitrary host merely because its URL appeared in a
  // signed manifest. The signature and SHA still protect intentionally cross-origin public files.
  if (urlOrigin(downloadUrl) == urlOrigin(activeGatewayBase())) {
    http.addHeader("x-device-id", deviceStore.deviceId());
    http.addHeader("x-device-secret", deviceStore.deviceSecret());
  }
  const int code = http.GET();
  if (code != HTTP_CODE_OK) {
    Serial.printf("firmware download failed code=%d\n", code);
    http.end();
    reportFirmwareStatus("failed", targetVersion, "download request failed");
    return false;
  }

  const int contentLength = http.getSize();
  if (contentLength > 0 && static_cast<size_t>(contentLength) != expectedSize) {
    Serial.printf("firmware size mismatch header=%d manifest=%u\n", contentLength, static_cast<unsigned>(expectedSize));
    http.end();
    reportFirmwareStatus("failed", targetVersion, "download size mismatch");
    return false;
  }

  if (!Update.begin(expectedSize)) {
    Serial.printf("Update.begin failed: %s\n", Update.errorString());
    http.end();
    reportFirmwareStatus("failed", targetVersion, "OTA partition unavailable");
    return false;
  }

  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0);

  WiFiClient* stream = http.getStreamPtr();
  uint8_t buffer[kOtaBufferSize];
  size_t written = 0;
  uint32_t lastProgressAt = 0;
  int lastReportedProgress = 0;

  while (http.connected() && written < expectedSize) {
    const size_t available = stream->available();
    if (available == 0) {
      delay(10);
      continue;
    }
    const size_t toRead = min(available, sizeof(buffer));
    const int read = stream->readBytes(buffer, toRead);
    if (read <= 0) continue;

    mbedtls_sha256_update(&sha, buffer, read);
    const size_t otaWritten = Update.write(buffer, read);
    if (otaWritten != static_cast<size_t>(read)) {
      Serial.printf("OTA write failed: %s\n", Update.errorString());
      mbedtls_sha256_free(&sha);
      Update.abort();
      http.end();
      reportFirmwareStatus("failed", targetVersion, "OTA flash write failed");
      return false;
    }
    written += otaWritten;

    if (millis() - lastProgressAt > 1000) {
      lastProgressAt = millis();
      const int progress = static_cast<int>((written * 100) / expectedSize);
      displayModel.line1 = "Updating firmware";
      displayModel.line2 = String(progress) + "%";
      drawDisplay();
      if (progress >= lastReportedProgress + 10) {
        lastReportedProgress = progress;
        reportFirmwareStatus("downloading", targetVersion, "download in progress", progress);
      }
    }
  }

  uint8_t digest[32];
  mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);
  http.end();

  const String actualSha = hexDigest(digest, sizeof(digest));
  if (written != expectedSize) {
    Serial.printf("firmware download incomplete written=%u expected=%u\n", static_cast<unsigned>(written), static_cast<unsigned>(expectedSize));
    Update.abort();
    reportFirmwareStatus("failed", targetVersion, "download incomplete");
    return false;
  }
  if (!actualSha.equalsIgnoreCase(expectedSha)) {
    Serial.printf("firmware sha mismatch expected=%s actual=%s\n", expectedSha, actualSha.c_str());
    Update.abort();
    reportFirmwareStatus("failed", targetVersion, "sha256 mismatch");
    return false;
  }

  reportFirmwareStatus("installing", targetVersion, "image verified", 100);
  if (!Update.end(true)) {
    Serial.printf("Update.end failed: %s\n", Update.errorString());
    reportFirmwareStatus("failed", targetVersion, "OTA finalize failed");
    return false;
  }
  if (!deviceStore.setOtaAttempt(FIRMWARE_VERSION, targetVersion)) {
    Serial.println("failed to persist OTA attempt marker; refusing an unobservable restart");
    reportFirmwareStatus("failed", targetVersion, "OTA state marker unavailable");
    return false;
  }

  displayModel.line1 = "Firmware updated";
  displayModel.line2 = "Restarting";
  drawDisplay();
  reportFirmwareStatus("rebooting", targetVersion, "booting pending image", 100);
  delay(1000);
  ESP.restart();
  return true;
#endif
}

#if ENABLE_AUDIO_CAPTURE || ENABLE_CAMERA_CAPTURE
// Uploads one capture through NextCoderCore's private raw session protocol and returns the
// finalized media id,
// or an empty String on failure. `httpCodeOut` always receives the transport
// result so the caller can put something specific on the display.
//
// The payload is presented as two contiguous segments (a container header plus
// the captured bytes) so a WAV header can be prepended without reallocating or
// memmoving the recording. Nothing is copied: the shared segmented stream reads both ranges
// directly while HTTPClient drains the raw PUT, so the capture buffer stays the only full copy in
// RAM and the board does not own a second protocol implementation.
String uploadMedia(
  const char* kind,
  const char* contentType,
  const char* originalName,
  const uint8_t* headerBytes,
  size_t headerLength,
  const uint8_t* bodyBytes,
  size_t bodyLength,
  int& httpCodeOut
) {
  const media::UploadSessionResult result = media::uploadSession(
    deviceStore,
    "crowpanel",
    kind,
    contentType,
    originalName,
    headerBytes,
    headerLength,
    bodyBytes,
    bodyLength,
    MEDIA_UPLOAD_MAX_BYTES,
    &nextGatewayRequestAt
  );
  httpCodeOut = result.httpStatus;
  return result.mediaId;
}
#endif  // ENABLE_AUDIO_CAPTURE || ENABLE_CAMERA_CAPTURE

// Loads a bounded, display-safe list of real T3 threads from the environment
// assigned by the owner. Fetching is read-only: turning the dial never changes
// execution context. Only an explicit OK on a visible row calls selectThread().
bool openThreadMenu() {
  uiScreen = UiScreen::Threads;
  threadOptionCount = 0;
  selectedThreadIndex = 0;
  displayModel.title = "Threads";
  displayModel.state = "loading";
  displayModel.line1 = "Loading threads";
  displayModel.line2 = "Please wait";
  drawDisplay();

  String response;
  int code = requestJson("GET", "/v1/device/threads", "", response);
  if (code < 200 || code >= 300) {
    displayModel.state = "error";
    displayModel.line1 = "Thread list failed";
    // Convert gateway status into something the person at the device can act on. The exact
    // diagnostic remains in the dashboard; this 27-character line tells them what fixes it.
    if (code == 409) displayModel.line2 = "No environment set";
    else if (code == 502 || code == 500) displayModel.line2 = "Start T3 Code; OK retry";
    else if (code == 401 || code == 403) displayModel.line2 = "Re-pair T3 in dashboard";
    else if (code == 429) displayModel.line2 = "Wait, then press OK";
    else displayModel.line2 = String("HTTP ") + code + "; OK retry";
    drawDisplay();
    return false;
  }

  JsonDocument doc;
  if (deserializeJson(doc, response)) {
    displayModel.state = "error";
    displayModel.line1 = "Bad thread JSON";
    displayModel.line2 = "Try again";
    drawDisplay();
    return false;
  }

  JsonArray threads = doc["threads"].as<JsonArray>();
  if (threads.isNull() || threads.size() == 0) {
    displayModel.state = "empty";
    displayModel.line1 = "No threads";
    displayModel.line2 = "Start one first";
    drawDisplay();
    return false;
  }

  const String current = String(doc["threadId"] | runtimeConfig.threadId.c_str());
  for (JsonObject input : threads) {
    if (threadOptionCount >= kMaxThreadOptions) break;
    const String id = String(input["id"] | "");
    if (id.length() == 0) continue;
    ThreadOption& thread = threadOptions[threadOptionCount];
    thread.id = id;
    thread.title = String(input["title"] | "Untitled thread");
    thread.status = String(input["status"] | "");
    thread.status.toUpperCase();
    thread.selected = (input["selected"] | false) || id == current;
    if (thread.selected) selectedThreadIndex = static_cast<int>(threadOptionCount);
    threadOptionCount += 1;
  }

  if (threadOptionCount == 0) {
    displayModel.state = "empty";
    displayModel.line1 = "No valid threads";
    displayModel.line2 = "Refresh dashboard";
    drawDisplay();
    return false;
  }

  displayModel.state = "ready";
  displayModel.line1 = "Select a thread";
  displayModel.line2 = "OK opens thread";
  drawDisplay();
  return true;
}

bool selectThread() {
  if (threadOptionCount == 0 || selectedThreadIndex < 0
      || selectedThreadIndex >= static_cast<int>(threadOptionCount)) {
    return false;
  }

  ThreadOption& selected = threadOptions[selectedThreadIndex];
  if (selected.selected && selected.id == runtimeConfig.threadId) {
    // Availability (especially Stop and media capture) belongs to the opened task's latest state.
    // Refresh before rendering so an old no-thread controls response cannot leave valid actions locked.
    fetchDeviceControls();
    openThreadActions();
    return true;
  }

  displayModel.state = "switching";
  displayModel.line1 = selected.title;
  displayModel.line2 = "Validating context";
  drawDisplay();

  String body = String("{\"threadId\":\"") + jsonEscape(selected.id.c_str()) + "\"}";
  String response;
  const int code = requestJson("POST", "/v1/device/config/thread", body, response);
  Serial.printf("thread select id=%s code=%d\n", selected.id.c_str(), code);
  if (code >= 200 && code < 300) {
    runtimeConfig.threadId = selected.id;
    for (size_t i = 0; i < threadOptionCount; i += 1) threadOptions[i].selected = false;
    selected.selected = true;
    fetchDeviceControls();
    openThreadActions();
  } else {
    displayModel.state = "error";
    displayModel.line1 = "Thread select failed";
    if (code == 404) displayModel.line2 = "Refresh thread list";
    else if (code == 502 || code == 500) displayModel.line2 = "Start T3 Code";
    else displayModel.line2 = String("HTTP ") + code;
  }
  if (code < 200 || code >= 300) drawDisplay();
  return code >= 200 && code < 300;
}

bool runFirstMacro() {
  String response;
  int code = requestJson("GET", "/v1/device/macros", "", response);
  Serial.printf("macro list code=%d response=%s\n", code, response.c_str());
  if (code < 200 || code >= 300) {
    displayModel.line1 = "Macro list failed";
    displayModel.line2 = String("HTTP ") + code;
    drawDisplay();
    return false;
  }

  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, response);
  if (error) {
    displayModel.line1 = "Bad macro JSON";
    displayModel.line2 = error.c_str();
    drawDisplay();
    return false;
  }

  JsonArray macros = doc["macros"].as<JsonArray>();
  if (macros.isNull() || macros.size() == 0) {
    displayModel.line1 = "No saved macros";
    displayModel.line2 = "Use dashboard";
    drawDisplay();
    return false;
  }

  JsonObject macro = macros[0];
  const char* macroId = macro["id"] | "";
  const char* macroLabel = macro["label"] | "Macro";
  if (strlen(macroId) == 0) {
    displayModel.line1 = "Macro missing id";
    displayModel.line2 = "";
    drawDisplay();
    return false;
  }

  JsonDocument requestDoc;
  requestDoc["clientRequestId"] = beginDurableRequest(
    String("macro\n") + macroId + "\n" + runtimeConfig.environmentId + "\n" + runtimeConfig.threadId
  );
  String body;
  serializeJson(requestDoc, body);
  response = "";
  String path = String("/v1/device/macros/") + macroId + "/run";
  code = requestJson("POST", path.c_str(), body, response);
  if (code > 0) deviceStore.clearPendingRequest();
  Serial.printf("macro run id=%s code=%d response=%s\n", macroId, code, response.c_str());

  JsonDocument runDoc;
  const DeserializationError runError = deserializeJson(runDoc, response);
  const char* commandStatus = runError ? nullptr : runDoc["command"]["status"] | nullptr;
  if (commandStatus && strcmp(commandStatus, "approval_required") == 0) {
    displayModel.line1 = "Approval needed";
    displayModel.line2 = macroLabel;
  } else if (commandStatus && strcmp(commandStatus, "completed") == 0) {
    displayModel.line1 = String(macroLabel);
    displayModel.line2 = "Complete";
  } else if (commandStatus && strcmp(commandStatus, "dispatched") == 0) {
    displayModel.line1 = String(macroLabel);
    displayModel.line2 = "Dispatched";
  } else {
    displayModel.line1 = "Macro sent";
    displayModel.line2 = String("HTTP ") + code;
  }
  drawDisplay();
  return code >= 200 && code < 300;
}

bool handleFirstApproval(const char* action) {
  String response;
  int code = requestJson("GET", "/v1/device/approvals", "", response);
  Serial.printf("approval list action=%s code=%d response=%s\n", action, code, response.c_str());
  if (code < 200 || code >= 300) {
    displayModel.line1 = "Approval list failed";
    displayModel.line2 = String("HTTP ") + code;
    drawDisplay();
    return false;
  }

  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, response);
  if (error) {
    displayModel.line1 = "Bad approval JSON";
    displayModel.line2 = error.c_str();
    drawDisplay();
    return false;
  }

  JsonArray commands = doc["commands"].as<JsonArray>();
  if (commands.isNull() || commands.size() == 0) {
    displayModel.line1 = "No approvals";
    displayModel.line2 = "Queue empty";
    drawDisplay();
    return false;
  }

  JsonObject command = commands[0];
  const char* commandId = command["id"] | "";
  const char* intentType = command["intent"]["type"] | "command";
  if (strlen(commandId) == 0) {
    displayModel.line1 = "Approval missing id";
    displayModel.line2 = "";
    drawDisplay();
    return false;
  }

  String path = String("/v1/device/approvals/") + commandId + "/" + action;
  response = "";
  code = requestJson("POST", path.c_str(), "{}", response);
  Serial.printf("approval action=%s id=%s code=%d response=%s\n", action, commandId, code, response.c_str());

  JsonDocument actionDoc;
  const DeserializationError actionError = deserializeJson(actionDoc, response);
  const char* commandStatus = actionError ? nullptr : actionDoc["command"]["status"] | nullptr;
  if (commandStatus) {
    displayModel.line1 = String(action) + " " + commandStatus;
    displayModel.line2 = intentType;
  } else {
    displayModel.line1 = String(action) + " sent";
    displayModel.line2 = String("HTTP ") + code;
  }
  drawDisplay();
  return code >= 200 && code < 300;
}

// Wraps an intent object in the device envelope, posts it, and reflects the
// resulting command status on the display. Shared by the menu actions and the
// media capture flows so they all report status the same way.
String beginDurableRequest(const String& signature) {
  uint64_t fingerprint = 1469598103934665603ULL;
  for (size_t index = 0; index < signature.length(); index += 1) {
    fingerprint ^= static_cast<uint8_t>(signature[index]);
    fingerprint *= 1099511628211ULL;
  }
  char hashText[17];
  snprintf(hashText, sizeof(hashText), "%08lx%08lx",
    static_cast<unsigned long>(fingerprint >> 32),
    static_cast<unsigned long>(fingerprint & 0xffffffffULL));
  String clientRequestId;
  if (deviceStore.pendingRequestHash() == hashText) clientRequestId = deviceStore.pendingRequestId();
  if (clientRequestId.length() == 0) {
    char requestText[41];
    snprintf(requestText, sizeof(requestText), "dev:%08lx-%08lx-%08lx-%08lx",
      static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()),
      static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()));
    clientRequestId = requestText;
  }
  deviceStore.setPendingRequest(clientRequestId, hashText);
  return clientRequestId;
}

bool postIntent(const String& intentJson, const String& label) {
  const String clientRequestId = beginDurableRequest(
    runtimeConfig.environmentId + "\n" + runtimeConfig.threadId + "\n" + intentJson
  );

  JsonDocument bodyDoc;
  bodyDoc["environmentId"] = runtimeConfig.environmentId;
  bodyDoc["threadId"] = runtimeConfig.threadId;
  bodyDoc["clientRequestId"] = clientRequestId;
  JsonDocument intentDoc;
  if (deserializeJson(intentDoc, intentJson)) return false;
  bodyDoc["intent"] = intentDoc.as<JsonObject>();
  String body;
  serializeJson(bodyDoc, body);

  String response;
  const int code = requestJson("POST", "/v1/device/intents", body, response);
  if (code > 0) deviceStore.clearPendingRequest();
  Serial.printf("intent menu=%s code=%d response=%s\n", label.c_str(), code, response.c_str());

  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, response);
  const char* commandStatus = error ? nullptr : doc["command"]["status"] | nullptr;
  if (commandStatus && strcmp(commandStatus, "approval_required") == 0) {
    displayModel.line1 = "Approval needed";
    displayModel.line2 = label;
  } else if (commandStatus && strcmp(commandStatus, "completed") == 0) {
    displayModel.line1 = label + " complete";
    displayModel.line2 = "Updated";
  } else if (commandStatus && strcmp(commandStatus, "dispatched") == 0) {
    displayModel.line1 = label + " sent";
    displayModel.line2 = "Dispatched";
  } else {
    displayModel.line1 = label + " sent";
    displayModel.line2 = String("HTTP ") + code;
  }
  drawDisplay();
  return code >= 200 && code < 300;
}

String encodePathSegment(const String& value) {
  static const char* digits = "0123456789ABCDEF";
  String encoded;
  encoded.reserve(value.length());
  for (size_t i = 0; i < value.length(); i += 1) {
    const uint8_t c = static_cast<uint8_t>(value[i]);
    const bool safe = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
      || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~';
    if (safe) {
      encoded += static_cast<char>(c);
    } else {
      encoded += '%';
      encoded += digits[(c >> 4) & 0x0F];
      encoded += digits[c & 0x0F];
    }
  }
  return encoded;
}

// Executes a gateway-owned action by opaque id. Prompt text, shell commands,
// macro steps, and media prompt templates never cross the firmware boundary.
bool postRemoteAction(
  const String& actionId,
  const String& label,
  const String& mediaUploadId,
  bool showThreadOutput
) {
  if (actionId.length() == 0) {
    displayModel.state = "error";
    displayModel.line1 = "Action missing id";
    displayModel.line2 = label;
    drawDisplay();
    return false;
  }

  JsonDocument request;
  if (mediaUploadId.length() > 0) request["mediaUploadId"] = mediaUploadId;
  request["clientRequestId"] = beginDurableRequest(
    String("action\n") + actionId + "\n" + runtimeConfig.environmentId + "\n"
      + runtimeConfig.threadId + "\n" + mediaUploadId
  );
  String body;
  serializeJson(request, body);
  const String path = String("/v1/device/actions/") + encodePathSegment(actionId) + "/run";
  String response;
  const int code = requestJson("POST", path.c_str(), body, response);
  if (code > 0) deviceStore.clearPendingRequest();
  Serial.printf(
    "action run id=%s label=%s media=%s code=%d response=%s\n",
    actionId.c_str(), label.c_str(), mediaUploadId.c_str(), code, response.c_str()
  );

  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, response);
  const char* commandStatus = nullptr;
  if (!error) {
    commandStatus = doc["command"]["status"] | nullptr;
    if (commandStatus == nullptr) commandStatus = doc["run"]["status"] | nullptr;
    if (commandStatus == nullptr) commandStatus = doc["status"] | nullptr;
  }
  const String nextResponseAfter = !error ? String(doc["responseAfter"] | "") : String();

  JsonObject screen;
  if (!error) {
    screen = doc["screen"].as<JsonObject>();
    if (screen.isNull()) screen = doc["command"]["result"].as<JsonObject>();
  }
  if (!screen.isNull()) {
    displayModel.title = screen["title"] | "T3 Code";
    displayModel.state = screen["state"] | "reachable";
    displayModel.line1 = screen["line1"] | label;
    displayModel.line2 = screen["line2"] | "Updated";
    drawDisplay();
    return code >= 200 && code < 300;
  }

  displayModel.state = code >= 200 && code < 300 ? "working" : "error";
  if (commandStatus && strcmp(commandStatus, "approval_required") == 0) {
    displayModel.line1 = "Approval needed";
    displayModel.line2 = label;
  } else if (commandStatus && strcmp(commandStatus, "completed") == 0) {
    displayModel.line1 = label;
    displayModel.line2 = "Complete";
    displayModel.state = "ready";
  } else if (commandStatus && strcmp(commandStatus, "dispatched") == 0) {
    displayModel.line1 = label;
    displayModel.line2 = "Dispatched";
  } else if (code >= 200 && code < 300) {
    displayModel.line1 = label;
    displayModel.line2 = commandStatus ? commandStatus : "Accepted";
  } else if (code == 403) {
    displayModel.line1 = "Action blocked";
    displayModel.line2 = label;
  } else if (code == 404) {
    displayModel.line1 = "Action unavailable";
    displayModel.line2 = label;
  } else {
    displayModel.line1 = label + " failed";
    displayModel.line2 = String("HTTP ") + code;
  }
  const bool accepted = code >= 200 && code < 300;
  if (accepted && showThreadOutput) {
    openThreadOutput(nextResponseAfter);
  } else {
    drawDisplay();
  }
  return accepted;
}

#if ENABLE_AUDIO_CAPTURE
// Push-to-talk: records for as long as the confirm key stays down, uploads the
// clip as a WAV, then references it from an audio_prompt intent.
//
// Nothing is drawn between the press and the end of the clip on purpose. A full
// e-ink refresh costs on the order of a second, and spending that inside a
// push-to-talk window would swallow the beginning of the utterance.
bool captureAndSendAudio(const String& actionId = String(), const String& actionLabel = "audio") {
  // Three independent ceilings; the tightest wins. The duration ceiling is the
  // product decision, the byte ceiling protects the allocation if the sample
  // rate is raised, and the gateway ceiling keeps the upload acceptable.
  size_t budget = (capture::kAudioBytesPerSecond * static_cast<size_t>(AUDIO_CAPTURE_MAX_MS)) / 1000;
  if (budget > static_cast<size_t>(AUDIO_CAPTURE_MAX_BYTES)) {
    budget = static_cast<size_t>(AUDIO_CAPTURE_MAX_BYTES);
  }
  if (budget + capture::kWavHeaderBytes > static_cast<size_t>(MEDIA_UPLOAD_MAX_BYTES)) {
    budget = static_cast<size_t>(MEDIA_UPLOAD_MAX_BYTES) - capture::kWavHeaderBytes;
  }
  budget &= ~static_cast<size_t>(1);
  if (budget == 0) return false;

  // PSRAM is where a clip belongs; internal DRAM is shared with the WiFi stack
  // and the e-ink frame buffer, so only borrow it when there is real headroom.
  uint8_t* pcm = static_cast<uint8_t*>(ps_malloc(budget));
  if (pcm == nullptr && ESP.getFreeHeap() > budget + 65536) {
    pcm = static_cast<uint8_t*>(malloc(budget));
  }
  if (pcm == nullptr) {
    displayModel.state = "error";
    displayModel.line1 = "Audio: no memory";
    displayModel.line2 = String(static_cast<unsigned>(budget / 1024)) + " KB needed";
    drawDisplay();
    return false;
  }

  if (!capture::audioBegin()) {
    free(pcm);
    displayModel.state = "error";
    displayModel.line1 = "Mic init failed";
    displayModel.line2 = "Check I2S pins";
    drawDisplay();
    return false;
  }

  const uint32_t startedAt = millis();
  size_t recorded = 0;
  while (recorded < budget) {
    const uint32_t elapsed = millis() - startedAt;
    if (elapsed >= static_cast<uint32_t>(AUDIO_CAPTURE_MAX_MS)) break;
    // Releasing the key ends the utterance. This is the whole point of reading
    // in small chunks.
    if (digitalRead(KEY_OK_PIN) != LOW) break;
    recorded += capture::audioReadPcm(pcm + recorded, budget - recorded, 20);
  }
  const uint32_t durationMs = millis() - startedAt;
  capture::audioEnd();

  // Swallow the key release so it does not immediately re-trigger the menu.
  lastKeyIsrAt = millis();

  const size_t minimumBytes =
    (capture::kAudioBytesPerSecond * static_cast<size_t>(AUDIO_CAPTURE_MIN_MS)) / 1000;
  if (recorded < minimumBytes) {
    free(pcm);
    displayModel.state = "ready";
    displayModel.line1 = "Clip too short";
    displayModel.line2 = "Hold OK to talk";
    drawDisplay();
    return false;
  }

  displayModel.state = "uploading";
  displayModel.line1 = String("Recorded ") + String(durationMs / 1000.0f, 1) + "s";
  displayModel.line2 = String("Uploading ") + String(static_cast<unsigned>(recorded / 1024)) + " KB";
  drawDisplay();

  uint8_t wavHeader[capture::kWavHeaderBytes];
  capture::buildWavHeader(wavHeader, static_cast<uint32_t>(recorded));

  int httpCode = 0;
  const String mediaId = uploadMedia(
    "audio",
    "audio/wav",
    "controller-capture.wav",
    wavHeader,
    sizeof(wavHeader),
    pcm,
    recorded,
    httpCode
  );
  free(pcm);

  if (mediaId.length() == 0) {
    displayModel.state = "error";
    displayModel.line1 = "Audio upload failed";
    displayModel.line2 = String("HTTP ") + httpCode;
    drawDisplay();
    return false;
  }

  // No transcript is sent: the device does not transcribe. The gateway falls
  // back to the media upload's own transcript, or attaches the clip as context.
  const String intent = String("{\"type\":\"audio_prompt\",\"mediaUploadId\":\"")
    + jsonEscape(mediaId.c_str())
    + "\",\"prompt\":\"" + jsonEscape(AUDIO_PROMPT_TEXT) + "\"}";
  if (actionId.length() > 0) return postRemoteAction(actionId, actionLabel, mediaId);
  return postIntent(intent, "audio");
}
#endif  // ENABLE_AUDIO_CAPTURE

#if ENABLE_CAMERA_CAPTURE
// Grabs one JPEG still and references it from a camera_prompt intent. The frame
// buffer belongs to the driver and is streamed straight out of PSRAM, so the
// image is never copied and never base64-expanded in RAM.
bool captureAndSendImage(const String& actionId = String(), const String& actionLabel = "camera") {
  lastKeyIsrAt = millis();

  if (!capture::cameraBegin()) {
    displayModel.state = "error";
    displayModel.line1 = "Camera init failed";
    displayModel.line2 = "Check pins/power";
    drawDisplay();
    return false;
  }

  const uint8_t* frame = nullptr;
  size_t frameLength = 0;
  if (!capture::cameraCaptureJpeg(&frame, &frameLength)) {
    displayModel.state = "error";
    displayModel.line1 = "Capture failed";
    displayModel.line2 = "No frame";
    drawDisplay();
    return false;
  }

  const size_t ceiling = static_cast<size_t>(CAMERA_CAPTURE_MAX_BYTES)
      < static_cast<size_t>(MEDIA_UPLOAD_MAX_BYTES)
    ? static_cast<size_t>(CAMERA_CAPTURE_MAX_BYTES)
    : static_cast<size_t>(MEDIA_UPLOAD_MAX_BYTES);
  if (frameLength > ceiling) {
    capture::cameraRelease();
    displayModel.state = "error";
    displayModel.line1 = "Image too large";
    displayModel.line2 = String(static_cast<unsigned>(frameLength / 1024)) + " KB";
    drawDisplay();
    return false;
  }

  displayModel.state = "uploading";
  displayModel.line1 = "Photo captured";
  displayModel.line2 = String("Uploading ") + String(static_cast<unsigned>(frameLength / 1024)) + " KB";
  drawDisplay();

  int httpCode = 0;
  const String mediaId = uploadMedia(
    "image",
    "image/jpeg",
    "controller-capture.jpg",
    nullptr,
    0,
    frame,
    frameLength,
    httpCode
  );
  // Hold the frame until the upload has drained it, then give it straight back:
  // with fb_count 1 the driver cannot produce another frame until it is
  // returned.
  capture::cameraRelease();

  if (mediaId.length() == 0) {
    displayModel.state = "error";
    displayModel.line1 = "Photo upload failed";
    displayModel.line2 = String("HTTP ") + httpCode;
    drawDisplay();
    return false;
  }

  const String intent = String("{\"type\":\"camera_prompt\",\"mediaUploadId\":\"")
    + jsonEscape(mediaId.c_str())
    + "\",\"prompt\":\"" + jsonEscape(CAMERA_PROMPT_TEXT) + "\"}";
  if (actionId.length() > 0) return postRemoteAction(actionId, actionLabel, mediaId);
  return postIntent(intent, "camera");
}
#endif  // ENABLE_CAMERA_CAPTURE

#if !ENABLE_AUDIO_CAPTURE || !ENABLE_CAMERA_CAPTURE
// A menu entry the gateway sent that this build has no hardware for. Say so
// rather than silently falling through to a status request.
void reportCaptureUnavailable(const char* what, const char* macro) {
  displayModel.state = "error";
  displayModel.line1 = String("No ") + what;
  displayModel.line2 = String("Build ") + macro;
  drawDisplay();
}
#endif

void submitIntent(const String& menuItem) {
  String intent;
  if (menuItem == "status") {
    intent = "{\"type\":\"status\"}";
  } else if (menuItem == "prompt") {
    intent = String("{\"type\":\"agent_prompt\",\"text\":\"") + jsonEscape(runtimeConfig.defaultPrompt.c_str()) + "\"}";
  } else if (menuItem == "shell") {
    if (runtimeConfig.shellCommand.length() == 0) {
      displayModel.line1 = "No shell command";
      displayModel.line2 = "Configure device";
      drawDisplay();
      return;
    }
    intent = String("{\"type\":\"shell_input\",\"command\":\"") + jsonEscape(runtimeConfig.shellCommand.c_str()) + "\"}";
  } else if (menuItem == "stop") {
    intent = "{\"type\":\"session_control\",\"action\":\"stop\"}";
  } else if (menuItem == "macro") {
    runFirstMacro();
    return;
  } else if (menuItem == "thread") {
    openThreadMenu();
    return;
  } else if (menuItem == "reset") {
    openResetConfirm();
    return;
  } else if (menuItem == "approve") {
    handleFirstApproval("approve");
    return;
  } else if (menuItem == "reject") {
    handleFirstApproval("reject");
    return;
  } else if (menuItem == "audio" || menuItem == "mic" || menuItem == "talk" || menuItem == "voice") {
#if ENABLE_AUDIO_CAPTURE
    captureAndSendAudio();
#else
    reportCaptureUnavailable("microphone", "ENABLE_AUDIO_CAPTURE");
#endif
    return;
  } else if (menuItem == "camera" || menuItem == "photo" || menuItem == "snapshot") {
#if ENABLE_CAMERA_CAPTURE
    captureAndSendImage();
#else
    reportCaptureUnavailable("camera", "ENABLE_CAMERA_CAPTURE");
#endif
    return;
  } else if (menuItem == "media") {
    // The gateway's stock menu carries a single generic "media" entry. On a
    // board that can actually capture, take a real capture; otherwise keep the
    // historical behaviour of pointing the agent at the most recent upload.
#if ENABLE_CAMERA_CAPTURE
    captureAndSendImage();
    return;
#elif ENABLE_AUDIO_CAPTURE
    captureAndSendAudio();
    return;
#else
    intent = "{\"type\":\"camera_prompt\",\"prompt\":\"Use the latest hardware media capture as context.\"}";
#endif
  } else {
    intent = "{\"type\":\"status\"}";
  }

  postIntent(intent, menuItem);
}

void submitControl(const DeviceControl& control, bool locallyConfirmed = false) {
  const bool missingThread = control.requiresThread && runtimeConfig.threadId.length() == 0;
  if (!control.enabled || missingThread) {
    displayModel.state = "disabled";
    displayModel.line1 = control.label;
    displayModel.line2 = missingThread
      ? String("Select a thread first")
      : (control.reason.length() > 0 ? control.reason : String("Unavailable"));
    drawDisplay();
    return;
  }

  if (control.kind == "stop" || (control.kind == "legacy" && control.id == "stop")) {
    openStopConfirm(control);
    return;
  }
  if (control.kind == "legacy") {
    submitIntent(control.id);
    return;
  }
  if (control.kind == "status") {
    // Protocol v2 status is an on-demand T3 snapshot for the selected task. The
    // gateway owns the T3 token and policy boundary; firmware submits only the
    // assigned opaque system action id. Fall back for older gateways.
    if (control.actionId.length() > 0) postRemoteAction(control.actionId, control.label, String(), false);
    else pollDisplay();
    return;
  }
  if (control.kind == "reset") {
    openResetConfirm();
    return;
  }
  if (control.requiresConfirmation && !locallyConfirmed) {
    openActionConfirm(control);
    return;
  }
  if (control.kind == "capture_audio"
      || (control.kind == "remote_action" && control.mediaKind == "audio")) {
#if ENABLE_AUDIO_CAPTURE
    captureAndSendAudio(control.actionId, control.label);
#else
    reportCaptureUnavailable("microphone", "ENABLE_AUDIO_CAPTURE");
#endif
    return;
  }
  if (control.kind == "capture_image"
      || (control.kind == "remote_action" && control.mediaKind == "image")) {
#if ENABLE_CAMERA_CAPTURE
    captureAndSendImage(control.actionId, control.label);
#else
    reportCaptureUnavailable("camera", "ENABLE_CAMERA_CAPTURE");
#endif
    return;
  }
  if (control.kind == "remote_action") {
    postRemoteAction(control.actionId, control.label);
    return;
  }

  // Unknown kinds are made disabled while parsing, but keep this fail-closed
  // guard in case a locally constructed control reaches the dispatcher.
  displayModel.state = "error";
  displayModel.line1 = "Unsupported control";
  displayModel.line2 = control.label;
  drawDisplay();
}

void moveSelection(int delta) {
  if (menuCount == 0) return;
  selectedMenuIndex += delta;
  if (selectedMenuIndex < 0) selectedMenuIndex = static_cast<int>(menuCount) - 1;
  if (selectedMenuIndex >= static_cast<int>(menuCount)) selectedMenuIndex = 0;
  drawDisplay();
}

void openActionsMenu() {
  gatewayMenuOpen = false;
  uiScreen = UiScreen::Actions;
  constexpr int actionCount = 3;
  if (selectedActionIndex < 0 || selectedActionIndex >= actionCount) selectedActionIndex = 0;
  displayModel.state = "ready";
  drawDisplay();
}

void openThreadActions() {
  gatewayMenuOpen = false;
  uiScreen = UiScreen::ThreadActions;
  const int threadActionCount = static_cast<int>(menuCount + 1);
  if (selectedMenuIndex < 0 || selectedMenuIndex >= threadActionCount) selectedMenuIndex = 0;
  displayModel.state = "ready";
  displayModel.line1 = selectedThreadLabel();
  displayModel.line2 = menuCount > 0 ? String("Response or action") : String("View latest response");
  drawDisplay();
}

bool fetchThreadOutput(int page, const String& after) {
  String path = String("/v1/device/thread-output?page=") + max(0, page);
  if (after.length() > 0) path += String("&after=") + encodePathSegment(after);
  String response;
  const int code = requestJson("GET", path.c_str(), "", response);
  if (code < 200 || code >= 300) {
    responseState = "error";
    responsePage = 0;
    responsePageCount = 1;
    responseLineCount = 2;
    responseLines[0] = "Response fetch failed";
    responseLines[1] = code == 409 ? String("Select a thread first") : String("HTTP ") + code;
    followUpActionCount = 0;
    drawDisplay();
    return false;
  }

  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, response);
  if (error) {
    responseState = "error";
    responsePage = 0;
    responsePageCount = 1;
    responseLineCount = 2;
    responseLines[0] = "Bad response JSON";
    responseLines[1] = "Press OK to retry";
    followUpActionCount = 0;
    drawDisplay();
    return false;
  }

  JsonObject output = doc["response"];
  responseState = String(output["state"] | "empty");
  responseMessageId = String(output["messageId"] | "");
  responsePage = output["page"] | 0;
  responsePageCount = max(1, static_cast<int>(output["pageCount"] | 1));
  responseLineCount = 0;
  JsonArray lines = output["lines"].as<JsonArray>();
  for (JsonVariant line : lines) {
    if (responseLineCount >= kResponseLinesPerPage) break;
    responseLines[responseLineCount++] = String(line | "");
  }
  while (responseLineCount < kResponseLinesPerPage) responseLines[responseLineCount++] = "";

  followUpActionCount = 0;
  JsonArray suggestions = doc["suggestions"].as<JsonArray>();
  for (JsonObject suggestion : suggestions) {
    if (followUpActionCount >= kMaxFollowUpActions) break;
    const String actionId = String(suggestion["actionId"] | "");
    if (actionId.length() == 0) continue;
    DeviceControl& control = followUpActions[followUpActionCount++];
    control.id = actionId;
    control.actionId = actionId;
    control.label = String(suggestion["label"] | "Action");
    control.kind = String(suggestion["kind"] | "remote_action");
    control.enabled = true;
    control.requiresThread = true;
    control.requiresConfirmation = suggestion["requiresConfirmation"] | true;
  }
  if (selectedFollowUpIndex >= static_cast<int>(followUpActionCount)) selectedFollowUpIndex = 0;
  drawDisplay();
  return true;
}

void openThreadOutput(const String& after) {
  uiScreen = UiScreen::ThreadOutput;
  followUpMode = false;
  responsePage = 0;
  responseAfter = after;
  responseState = after.length() > 0 ? String("waiting") : String("loading");
  responseLineCount = 3;
  responseLines[0] = after.length() > 0 ? String("Waiting for agent response") : String("Loading latest response");
  responseLines[1] = "The display will refresh";
  responseLines[2] = "EXIT returns to actions";
  followUpActionCount = 0;
  drawDisplay();
  fetchThreadOutput(0, responseAfter);
}

void showCachedThreadMenu() {
  uiScreen = UiScreen::Threads;
  displayModel.state = threadOptionCount > 0 ? String("ready") : String("empty");
  displayModel.line1 = threadOptionCount > 0 ? String("Select a thread") : String("No threads");
  displayModel.line2 = threadOptionCount > 0 ? String("OK opens thread") : String("OK to refresh");
  drawDisplay();
}

void showHome() {
  gatewayMenuOpen = false;
  uiScreen = UiScreen::Home;
  lastDisplayPollAt = 0;
  if (firmwareUpdateAvailable && firmwarePromptDeferred) {
    showFirmwarePrompt(UiScreen::Home);
    return;
  }
  drawDisplay();
}

void moveActionSelection(int delta) {
  constexpr int actionCount = 3;
  if (actionCount <= 0) return;
  selectedActionIndex += delta;
  if (selectedActionIndex < 0) selectedActionIndex = actionCount - 1;
  if (selectedActionIndex >= actionCount) selectedActionIndex = 0;
  drawDisplay();
}

void moveThreadActionSelection(int delta) {
  const int threadActionCount = static_cast<int>(menuCount + 1);
  selectedMenuIndex += delta;
  if (selectedMenuIndex < 0) selectedMenuIndex = threadActionCount - 1;
  if (selectedMenuIndex >= threadActionCount) selectedMenuIndex = 0;
  drawDisplay();
}

void moveThreadSelection(int delta) {
  if (threadOptionCount == 0) return;
  selectedThreadIndex += delta;
  if (selectedThreadIndex < 0) selectedThreadIndex = static_cast<int>(threadOptionCount) - 1;
  if (selectedThreadIndex >= static_cast<int>(threadOptionCount)) selectedThreadIndex = 0;
  drawDisplay();
}

// The CrowPanel dial is three discrete switches, not a quadrature encoder, so
// selection is edge-driven off five active-low keys sharing one debounce window.
// Drains whatever the ISRs latched since the last pass. Polling digitalRead here
// instead would miss almost every press: this runs between blocking work, and a
// display poll is an HTTP round trip plus a refresh well over a second long,
// which is far longer than anyone holds a key.
void handleButtons() {
  noInterrupts();
  uint32_t pending = pendingKeyMask;
  pendingKeyMask = 0;
  interrupts();

  bool releasingDeferredKey = false;
  if (deferredChordKeyMask != 0) {
    if (digitalRead(KEY_OK_PIN) == LOW && digitalRead(KEY_EXIT_PIN) == LOW) {
      deferredChordKeyMask = 0;
      deferredChordKeyAt = 0;
    } else if (millis() - deferredChordKeyAt >= kStopChordGraceMs) {
      pending |= deferredChordKeyMask;
      deferredChordKeyMask = 0;
      deferredChordKeyAt = 0;
      releasingDeferredKey = true;
    }
  }

  // Give the second half of the stop chord a small window to arrive before a
  // lone OK/EXIT edge is dispatched. Direct pin reads detect the chord even
  // though the shared ISR debounce intentionally suppresses near-simultaneous
  // edges from the second key.
  const uint32_t chordKeys = pending & (kKeyOkBit | kKeyExitBit);
  if (!releasingDeferredKey && chordKeys != 0) {
    deferredChordKeyMask |= chordKeys;
    deferredChordKeyAt = millis();
    pending &= ~(kKeyOkBit | kKeyExitBit);
  }
  if (pending == 0) return;

  // While the erase prompt is up the bezel means only yes or no. Letting the dial keep browsing the
  // menu underneath a modal is how someone ends up confirming a wipe they thought they had left.
  if (resetConfirmOpen) {
    if (pending & kKeyOkBit) {
      Serial.println("[key] ok -> factory reset confirmed");
      performFactoryReset();
    } else if (pending & (kKeyExitBit | kKeyMenuBit | kKeyUpBit | kKeyDownBit)) {
      Serial.println("[key] cancel -> factory reset abandoned");
      cancelResetConfirm();
    }
    return;
  }

  // A menu stop is deliberately two-step. This is separate from the reserved
  // OK+EXIT emergency chord, whose 1.5 s hold is already its confirmation.
  if (stopConfirmOpen) {
    if (pending & kKeyOkBit) {
      stopConfirmOpen = false;
      displayModel.title = "Next Coder";
      displayModel.state = "stopping";
      displayModel.line1 = "Stopping active run";
      displayModel.line2 = "Please wait";
      drawDisplay();
      if (pendingStopLegacy) {
        postIntent("{\"type\":\"session_control\",\"action\":\"stop\"}", pendingStopLabel);
      } else {
        postRemoteAction(pendingStopActionId, pendingStopLabel, String(), false);
      }
    } else if (pending & kKeyMenuBit) {
      stopConfirmOpen = false;
      pendingStopActionId = "";
      pendingStopLabel = "";
      pendingStopLegacy = false;
      openActionsMenu();
    } else if (pending & (kKeyExitBit | kKeyUpBit | kKeyDownBit)) {
      stopConfirmOpen = false;
      pendingStopActionId = "";
      pendingStopLabel = "";
      pendingStopLegacy = false;
      if (detailReturnScreen == UiScreen::ThreadOutput) {
        uiScreen = UiScreen::ThreadOutput;
        drawDisplay();
      } else if (detailReturnScreen == UiScreen::ThreadActions) openThreadActions();
      else openActionsMenu();
    }
    return;
  }

  // Saved prompts, shell tasks, macros, and captures get an explicit local
  // review screen before anything reaches the gateway. Gateway approval, when
  // policy requires it, remains a separate owner decision after this step.
  if (actionConfirmOpen) {
    if (pending & kKeyOkBit) {
      DeviceControl confirmed = pendingActionControl;
      actionConfirmOpen = false;
      pendingActionControl = DeviceControl();
      displayModel.state = "working";
      displayModel.line1 = confirmed.label;
      displayModel.line2 = "Sending to selected task";
      drawDisplay();
      submitControl(confirmed, /*locallyConfirmed=*/true);
    } else if (pending & kKeyMenuBit) {
      actionConfirmOpen = false;
      pendingActionControl = DeviceControl();
      openActionsMenu();
    } else if (pending & (kKeyExitBit | kKeyUpBit | kKeyDownBit)) {
      actionConfirmOpen = false;
      pendingActionControl = DeviceControl();
      if (detailReturnScreen == UiScreen::ThreadOutput) {
        uiScreen = UiScreen::ThreadOutput;
        drawDisplay();
      } else if (detailReturnScreen == UiScreen::ThreadActions) openThreadActions();
      else openActionsMenu();
    }
    return;
  }

  if (firmwarePromptOpen) {
    if (pending & kKeyOkBit) {
      Serial.printf("[key] ok -> install firmware %s\n", pendingFirmwareVersion.c_str());
      installPendingFirmware();
    } else if (pending & (kKeyExitBit | kKeyMenuBit | kKeyUpBit | kKeyDownBit)) {
      Serial.printf("[key] later -> defer firmware %s\n", pendingFirmwareVersion.c_str());
      firmwarePromptOpen = false;
      firmwarePromptDeferred = false;
      if (firmwarePromptReturnScreen == UiScreen::Actions) openActionsMenu();
      else showHome();
    }
    return;
  }

  if (gatewayMenuOpen) {
    const int profileCount = static_cast<int>(deviceStore.gatewayProfileCount());
    if ((pending & kKeyUpBit) && profileCount > 0) {
      selectedGatewayProfileIndex -= 1;
      if (selectedGatewayProfileIndex < 0) selectedGatewayProfileIndex = profileCount - 1;
      renderGatewaySelection();
    }
    if ((pending & kKeyDownBit) && profileCount > 0) {
      selectedGatewayProfileIndex = (selectedGatewayProfileIndex + 1) % profileCount;
      renderGatewaySelection();
    }
    if (pending & kKeyOkBit) {
      const GatewayProfile* selected = deviceStore.gatewayProfile(
        static_cast<size_t>(selectedGatewayProfileIndex)
      );
      if (selected != nullptr) {
        GatewayProfile copy = *selected;
        gatewayMenuOpen = false;
        requestLocalGatewaySwitch(copy);
        return;
      }
    }
    if (pending & (kKeyExitBit | kKeyMenuBit)) {
      gatewayMenuOpen = false;
      openActionsMenu();
    }
    return;
  }

  if (uiScreen == UiScreen::Threads) {
    if (pending & kKeyUpBit) moveThreadSelection(-1);
    if (pending & kKeyDownBit) moveThreadSelection(1);
    if (pending & kKeyOkBit) {
      if (threadOptionCount == 0) openThreadMenu();
      else selectThread();
    }
    if (pending & (kKeyExitBit | kKeyMenuBit)) openActionsMenu();
    return;
  }

  if (uiScreen == UiScreen::ThreadOutput) {
    if (pending & kKeyMenuBit) {
      openActionsMenu();
      return;
    }
    if (followUpMode) {
      if ((pending & kKeyUpBit) && followUpActionCount > 0) {
        selectedFollowUpIndex -= 1;
        if (selectedFollowUpIndex < 0) selectedFollowUpIndex = static_cast<int>(followUpActionCount) - 1;
        drawDisplay();
      }
      if ((pending & kKeyDownBit) && followUpActionCount > 0) {
        selectedFollowUpIndex = (selectedFollowUpIndex + 1) % static_cast<int>(followUpActionCount);
        drawDisplay();
      }
      if (pending & kKeyExitBit) {
        followUpMode = false;
        drawDisplay();
        return;
      }
      if ((pending & kKeyOkBit) && followUpActionCount > 0) {
        detailReturnScreen = UiScreen::ThreadOutput;
        openActionConfirm(followUpActions[selectedFollowUpIndex]);
        return;
      }
    } else {
      if ((pending & kKeyUpBit) && responsePageCount > 1) {
        responsePage = responsePage == 0 ? responsePageCount - 1 : responsePage - 1;
        fetchThreadOutput(responsePage, responseAfter);
      }
      if ((pending & kKeyDownBit) && responsePageCount > 1) {
        responsePage = (responsePage + 1) % responsePageCount;
        fetchThreadOutput(responsePage, responseAfter);
      }
      if (pending & kKeyExitBit) {
        openThreadActions();
        return;
      }
      if (pending & kKeyOkBit) {
        if (followUpActionCount > 0) {
          followUpMode = true;
          selectedFollowUpIndex = 0;
          drawDisplay();
        } else {
          fetchThreadOutput(responsePage, responseAfter);
        }
        return;
      }
    }
    return;
  }

  if (uiScreen == UiScreen::ThreadActions) {
    if (pending & kKeyUpBit) moveThreadActionSelection(-1);
    if (pending & kKeyDownBit) moveThreadActionSelection(1);
    if (pending & kKeyExitBit) {
      showCachedThreadMenu();
      return;
    }
    if (pending & kKeyMenuBit) {
      openActionsMenu();
      return;
    }
    if (pending & kKeyOkBit) {
      if (selectedMenuIndex == 0) {
        openThreadOutput();
        return;
      }
      const int controlIndex = selectedMenuIndex - 1;
      if (controlIndex < 0 || controlIndex >= static_cast<int>(menuCount)) return;
      const DeviceControl& control = controls[controlIndex];
      detailReturnScreen = UiScreen::ThreadActions;
      uiScreen = UiScreen::Detail;
      const bool localReset = control.kind == "reset"
        || (control.kind == "legacy" && control.id == "reset");
      if (!control.enabled || localReset || gatewayReachable()) submitControl(control);
      else renderNotConnected(control.label);
    }
    return;
  }

  if (uiScreen == UiScreen::Actions) {
    if (pending & kKeyUpBit) moveActionSelection(-1);
    if (pending & kKeyDownBit) moveActionSelection(1);
    if (pending & kKeyExitBit) {
      showHome();
      return;
    }
    if (pending & kKeyOkBit) {
      if (selectedActionIndex == 0) {
        if (!gatewayReachable()) renderNotConnected("Threads");
        else openThreadMenu();
        return;
      }
      if (selectedActionIndex == 1) {
        if (!gatewayReachable()) renderNotConnected("Gateways");
        else openGatewayMenu();
        return;
      }
      if (selectedActionIndex == 2) {
        if (firmwareUpdateAvailable) {
          showFirmwarePrompt(UiScreen::Actions);
          return;
        }
        detailReturnScreen = UiScreen::Actions;
        uiScreen = UiScreen::Detail;
        displayModel.state = "checking";
        displayModel.line1 = "Checking firmware";
        displayModel.line2 = "Contacting gateway";
        drawDisplay();
        pollFirmwareManifest();
        if (firmwareUpdateAvailable && pendingFirmwareRequiresConfirmation) {
          showFirmwarePrompt(UiScreen::Actions);
        } else if (!firmwareUpdateAvailable && lastFirmwarePollSucceeded) {
          displayModel.state = "current";
          displayModel.line1 = String("Firmware ") + FIRMWARE_VERSION;
          displayModel.line2 = "No update available";
          drawDisplay();
        } else if (!firmwareUpdateAvailable) {
          displayModel.state = "error";
          displayModel.line1 = "Firmware check failed";
          displayModel.line2 = "Press EXIT, try later";
          drawDisplay();
        }
        return;
      }

    }
    return;
  }

  if (pending & kKeyMenuBit) {
    Serial.println("[key] menu -> actions");
    if (!gatewayReachable()) renderNotConnected("Actions");
    else openActionsMenu();
    return;
  }

  if (uiScreen == UiScreen::Home && (pending & kKeyOkBit)) {
    Serial.println("[key] home ok -> status");
    if (!gatewayReachable()) {
      renderNotConnected("Status");
      return;
    }
    detailReturnScreen = UiScreen::Home;
    uiScreen = UiScreen::Detail;
    for (size_t i = 0; i < menuCount; i += 1) {
      if (controls[i].kind == "status" || (controls[i].kind == "legacy" && controls[i].id == "status")) {
        submitControl(controls[i]);
        return;
      }
    }
    // A protocol-v1 gateway may omit Status from its menu; its display route
    // still returns the same compact T3 snapshot.
    uiScreen = UiScreen::Home;
    pollDisplay();
    return;
  }

  if (pending & kKeyExitBit) {
    Serial.println("[key] exit -> back");
    if (uiScreen == UiScreen::Detail && gatewayReachable()) {
      if (detailReturnScreen == UiScreen::Home) showHome();
      else if (detailReturnScreen == UiScreen::ThreadOutput) {
        uiScreen = UiScreen::ThreadOutput;
        drawDisplay();
      }
      else if (detailReturnScreen == UiScreen::ThreadActions) openThreadActions();
      else if (detailReturnScreen == UiScreen::Threads) showCachedThreadMenu();
      else openActionsMenu();
    } else if (uiScreen == UiScreen::Home && deviceStore.hasClaimCode()) {
      // Preserve the factory claim-card recovery without redefining EXIT as a
      // destructive or network action on already-claimed controllers.
      detailReturnScreen = UiScreen::Home;
      uiScreen = UiScreen::Detail;
      showCachedClaimCode();
    }
    return;
  }
}

const DeviceControl* assignedStopControl() {
  if (!controlsProtocolV2) return nullptr;
  for (size_t i = 0; i < menuCount; i += 1) {
    if (controls[i].kind == "stop") return &controls[i];
  }
  return nullptr;
}

// A 1.5 s OK+EXIT chord is the always-visible emergency stop gesture. EXIT
// alone remains the 10 s provisioning reset, so stopping a run can never erase
// connectivity and a deliberate reset does not implicitly operate the agent.
void pollReservedStopHold() {
  static uint32_t heldSince = 0;
  static bool triggered = false;
  if (resetConfirmOpen) {
    heldSince = 0;
    triggered = false;
    return;
  }
  const bool down = digitalRead(KEY_OK_PIN) == LOW && digitalRead(KEY_EXIT_PIN) == LOW;
  if (!down) {
    heldSince = 0;
    triggered = false;
    return;
  }

  // Swallow both falling edges while the chord is active. Otherwise OK would
  // run the selected menu control and EXIT would open setup before the hold
  // timer had a chance to fire.
  noInterrupts();
  pendingKeyMask &= ~(kKeyOkBit | kKeyExitBit);
  interrupts();
  deferredChordKeyMask = 0;
  deferredChordKeyAt = 0;

  const uint32_t now = millis();
  if (heldSince == 0) {
    heldSince = now;
    return;
  }
  if (triggered || now - heldSince < kStopHoldMs) return;
  triggered = true;
  stopConfirmOpen = false;

  if (!gatewayReachable()) {
    renderNotConnected("Stop");
    return;
  }
  const DeviceControl* stop = assignedStopControl();
  if (stop != nullptr && !stop->enabled) {
    submitControl(*stop);
    return;
  }
  detailReturnScreen = uiScreen == UiScreen::Home ? UiScreen::Home : UiScreen::Actions;
  uiScreen = UiScreen::Detail;
  displayModel.title = "Next Coder";
  displayModel.state = "stopping";
  displayModel.line1 = "Stopping active run";
  displayModel.line2 = "Please wait";
  drawDisplay();
  postRemoteAction(
    stop != nullptr && stop->actionId.length() > 0 ? stop->actionId : String("system_stop"),
    "Stop run",
    String(),
    false
  );
}

// EXIT held down wipes Wi-Fi and re-enters provisioning. Polled rather than driven from the ISR
// because a hold has no falling edge to latch, and it deliberately reads the pin directly so a
// device wedged anywhere else in the loop can still be recovered.
void pollResetHold() {
  static uint32_t heldSince = 0;
  static bool warned = false;

  // EXIT is also "cancel" on the erase prompt. Without this, holding it a moment too long while
  // backing out would trigger the very reset the owner just declined.
  if (resetConfirmOpen) {
    heldSince = 0;
    warned = false;
    return;
  }


  // OK+EXIT belongs exclusively to the reserved stop gesture. Never advance
  // the EXIT-only reset timer while the chord is down.
  if (digitalRead(KEY_OK_PIN) == LOW) {
    heldSince = 0;
    warned = false;
    return;
  }

  // The board's keys are active-low with external pull-ups.
  const bool down = digitalRead(KEY_EXIT_PIN) == LOW;
  if (!down) {
    heldSince = 0;
    warned = false;
    return;
  }

  const uint32_t now = millis();
  if (heldSince == 0) {
    heldSince = now;
    return;
  }

  const uint32_t held = now - heldSince;
  if (!warned && held > 3000) {
    warned = true;
    stopConfirmOpen = false;
    displayModel.title = "Reset";
    displayModel.state = "resetting";
    displayModel.line1 = "Keep holding EXIT";
    displayModel.line2 = "Release to cancel";
    drawDisplay();
  }

  if (held >= kResetHoldMs) {
    Serial.println("[key] EXIT held: resetting Wi-Fi and re-entering provisioning");
    heldSince = 0;
    warned = false;
    deviceRevoked = false;
    revokedScreenShown = false;
    lastSetupCodeAt = 0;
    provisioning.resetToProvisioning();
    renderProvisioningState();
  }
}

void attachKeys() {
  attachInterruptArg(digitalPinToInterrupt(KEY_UP_PIN), onKeyIsr, (void*)kKeyUpBit, FALLING);
  attachInterruptArg(digitalPinToInterrupt(KEY_DOWN_PIN), onKeyIsr, (void*)kKeyDownBit, FALLING);
  attachInterruptArg(digitalPinToInterrupt(KEY_OK_PIN), onKeyIsr, (void*)kKeyOkBit, FALLING);
  attachInterruptArg(digitalPinToInterrupt(KEY_MENU_PIN), onKeyIsr, (void*)kKeyMenuBit, FALLING);
  attachInterruptArg(digitalPinToInterrupt(KEY_EXIT_PIN), onKeyIsr, (void*)kKeyExitBit, FALLING);
}

void queueRealtimeRefresh(const String& event, const String& payload, const String& deviceId) {
  uint32_t mask = 0;
  if (event == "threads.changed") {
    // A rename, archive, or delete can also change the selected thread and action availability.
    mask = kRefreshThreadsBit | kRefreshConfigBit | kRefreshControlsBit | kRefreshDisplayBit;
  } else if (event == "device.refresh") {
    JsonDocument doc;
    if (deserializeJson(doc, payload)) return;
    const String targetDevice = String(doc["deviceId"] | "");
    if (targetDevice.length() > 0 && targetDevice != deviceId) return;
    for (JsonVariant value : doc["resources"].as<JsonArray>()) {
      const String resource = String(value | "");
      if (resource == "config") mask |= kRefreshConfigBit;
      else if (resource == "threads") mask |= kRefreshThreadsBit;
      else if (resource == "controls") mask |= kRefreshControlsBit;
      else if (resource == "display" || resource == "approvals") mask |= kRefreshDisplayBit;
      else if (resource == "gateway") mask |= kRefreshGatewayBit;
    }
  } else if (event == "firmware.changed") {
    JsonDocument doc;
    if (deserializeJson(doc, payload)) return;
    const String targetDevice = String(doc["deviceId"] | "");
    const String model = String(doc["hardwareModel"] | "");
    if (targetDevice.length() > 0 && targetDevice != deviceId) return;
    if (model.length() == 0 || model == HARDWARE_MODEL) mask = kRefreshFirmwareBit;
  } else if (event == "t3.approval.decided" || event == "t3.user-input.answered") {
    mask = kRefreshControlsBit | kRefreshDisplayBit;
  } else if (event == "command.reconciled" || event == "t3.snapshot"
             || event == "t3.thread.snapshot" || event == "t3.thread.event"
             || event == "t3.thread.status" || event == "media.job"
             || event == "state.changed") {
    mask = kRefreshDisplayBit;
  }
  if (mask == 0) return;

  portENTER_CRITICAL(&realtimeRefreshMux);
  const bool wasEmpty = pendingRealtimeRefreshMask == 0;
  pendingRealtimeRefreshMask |= mask;
  // Do not extend the deadline for every event: a busy task must still make progress.
  if (wasEmpty) realtimeRefreshDueAt = millis() + kRealtimeCoalesceMs;
  portEXIT_CRITICAL(&realtimeRefreshMux);
}

void realtimeEventTask(void*) {
  for (;;) {
    if (WiFi.status() != WL_CONNECTED || realtimeEndpointMutex == nullptr) {
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }

    String gatewayBase;
    String deviceId;
    String deviceSecret;
    uint32_t endpointGeneration = 0;
    if (xSemaphoreTake(realtimeEndpointMutex, pdMS_TO_TICKS(1000)) == pdTRUE) {
      gatewayBase = realtimeGatewayBase;
      deviceId = realtimeDeviceId;
      deviceSecret = realtimeDeviceSecret;
      endpointGeneration = realtimeEndpointGeneration;
      xSemaphoreGive(realtimeEndpointMutex);
    }
    if (gatewayBase.length() == 0 || deviceId.length() == 0 || deviceSecret.length() == 0) {
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }

    // Clients are declared before HTTPClient so HTTPClient is destroyed first.
    WiFiClient plainClient;
    WiFiClientSecure secureClient;
    HTTPClient http;
    http.useHTTP10(true);
    http.setConnectTimeout(5000);
    http.setTimeout(5000);
    const String url = normalizeGatewayBase(gatewayBase) + "/v1/device/events";
    if (!beginHttp(http, plainClient, secureClient, url)) {
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }
    http.addHeader("x-device-id", deviceId);
    http.addHeader("x-device-secret", deviceSecret);

    const int code = http.GET();
    if (code != 200) {
      Serial.printf("[events] stream failed code=%d\n", code);
      http.end();
      vTaskDelay(pdMS_TO_TICKS(code == 429 ? 5000 : 2000));
      continue;
    }

    Serial.println("[events] realtime stream connected");
    WiFiClient* stream = http.getStreamPtr();
    String line;
    String event;
    String data;
    line.reserve(160);
    data.reserve(384);
    while (WiFi.status() == WL_CONNECTED
           && endpointGeneration == realtimeEndpointGeneration
           && (stream->connected() || stream->available())) {
      if (!stream->available()) {
        vTaskDelay(pdMS_TO_TICKS(20));
        continue;
      }
      const char c = static_cast<char>(stream->read());
      if (c != '\n') {
        if (c != '\r' && line.length() < 768) line += c;
        continue;
      }
      if (line.startsWith("event:")) {
        event = line.substring(6);
        event.trim();
      } else if (line.startsWith("data:")) {
        if (data.length() > 0) data += '\n';
        String part = line.substring(5);
        part.trim();
        data += part;
      } else if (line.length() == 0) {
        if (event.length() > 0) queueRealtimeRefresh(event, data, deviceId);
        event = "";
        data = "";
      }
      line = "";
    }
    http.end();
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

void syncRealtimeEndpoint() {
  if (realtimeEndpointMutex == nullptr) return;
  if (xSemaphoreTake(realtimeEndpointMutex, pdMS_TO_TICKS(1000)) != pdTRUE) return;
  realtimeGatewayBase = activeGatewayBase();
  realtimeDeviceId = deviceStore.deviceId();
  realtimeDeviceSecret = deviceStore.deviceSecret();
  realtimeEndpointGeneration += 1;
  xSemaphoreGive(realtimeEndpointMutex);
}

void startRealtimeTask() {
  if (realtimeTaskHandle != nullptr) return;
  realtimeEndpointMutex = xSemaphoreCreateMutex();
  if (realtimeEndpointMutex == nullptr) {
    Serial.println("[events] could not create endpoint mutex; periodic polling remains active");
    return;
  }
  syncRealtimeEndpoint();
  if (xTaskCreatePinnedToCore(
        realtimeEventTask, "events", 8192, nullptr, 1, &realtimeTaskHandle, 0
      ) != pdPASS) {
    realtimeTaskHandle = nullptr;
    Serial.println("[events] could not start stream task; periodic polling remains active");
    return;
  }
  Serial.println("[events] realtime refresh task started");
}
}

void setup() {
  Serial.begin(115200);
  delay(200);

  setMenuDefaults();

  pinMode(POWER_LED_PIN, OUTPUT);
  digitalWrite(POWER_LED_PIN, HIGH);

  // The board carries external pull-ups on all five keys; they read LOW when pressed.
  pinMode(KEY_UP_PIN, INPUT);
  pinMode(KEY_DOWN_PIN, INPUT);
  pinMode(KEY_OK_PIN, INPUT);
  pinMode(KEY_MENU_PIN, INPUT);
  pinMode(KEY_EXIT_PIN, INPUT);
  // Idle levels, so a miswired or wrong-polarity key shows up here rather than
  // as silence when someone presses it.
  Serial.printf(
    "[keys] idle up=%d down=%d ok=%d menu=%d exit=%d (all should read 1)\n",
    digitalRead(KEY_UP_PIN), digitalRead(KEY_DOWN_PIN), digitalRead(KEY_OK_PIN),
    digitalRead(KEY_MENU_PIN), digitalRead(KEY_EXIT_PIN)
  );
  attachKeys();

#if ENABLE_EINK
  // The panel rail must come up and settle before the controller answers.
  pinMode(EINK_POWER_PIN, OUTPUT);
  digitalWrite(EINK_POWER_PIN, HIGH);
  delay(300);
  // EPD_Init() calls EPD_GPIOInit(), which owns the bit-banged SPI pins, so no
  // SPI.begin() here. EPD_Clear() primes both RAM planes and loads the waveform
  // LUTs; without it the first refresh returns in milliseconds having done
  // nothing. EPD_ALL_Fill() is dead SSD1680 code in this library -- do not use it.
  EPD_Init();
  EPD_Clear();
  EPD_Update();
#endif

  if (!deviceStore.begin()) {
    displayModel.title = "Storage error";
    displayModel.state = "fault";
    displayModel.line1 = "NVS unavailable";
    displayModel.line2 = "Reflash required";
    drawDisplay();
    return;
  }
  // Bench convenience only: seeds an otherwise-blank unit from controller_config.h. A
  // factory-flashed device already has NVS identity and this writes nothing.
  deviceStore.seedIdentityIfEmpty(DEVICE_ID, DEVICE_SECRET, GATEWAY_BASE_URL);
  deviceStore.ensureLegacyGatewayProfile();
  handleOtaBootAttempt();

#if BUILD_OTA_ROLLBACK_DRILL
  // Hardware validation image: deliberately reboot before any network work or
  // confirmation. The ESP-IDF bootloader must restore the previous slot. This
  // is intentionally unconditional: a state check could accidentally turn the
  // bad image healthy when a framework reports NEW/UNDEFINED during setup.
  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t imageState;
  const esp_err_t stateResult = running == nullptr
    ? ESP_ERR_NOT_FOUND
    : esp_ota_get_state_partition(running, &imageState);
  Serial.printf(
    "OTA rollback drill: refusing version %s stateResult=%d state=%d and restarting\n",
    FIRMWARE_VERSION,
    stateResult,
    stateResult == ESP_OK ? static_cast<int>(imageState) : -1
  );
  delay(1500);
  ESP.restart();
#endif

  if (!deviceStore.hasIdentity()) {
    // Nothing can be done over the network without a credential, and the owner cannot supply one:
    // identity is written at manufacture. Say so rather than looping on 401s.
    displayModel.title = "Not provisioned";
    displayModel.state = "unprovisioned";
    displayModel.line1 = "No device identity";
    displayModel.line2 = "Factory flash needed";
    drawDisplay();
    return;
  }

  provisioning.begin(deviceStore, deviceStore.deviceId());
  startRealtimeTask();
  renderProvisioningState();
}

bool consumeRealtimeRefresh() {
  const uint32_t now = millis();
  uint32_t nextBit = 0;
  portENTER_CRITICAL(&realtimeRefreshMux);
  if (pendingRealtimeRefreshMask != 0
      && static_cast<int32_t>(now - realtimeRefreshDueAt) >= 0) {
    // Priority prevents a release or selected-thread repair from sitting behind cosmetic updates.
    const uint32_t priorities[] = {
      kRefreshFirmwareBit,
      kRefreshGatewayBit,
      kRefreshConfigBit,
      kRefreshThreadsBit,
      kRefreshControlsBit,
      kRefreshDisplayBit,
    };
    for (uint32_t bit : priorities) {
      if ((pendingRealtimeRefreshMask & bit) != 0) {
        nextBit = bit;
        pendingRealtimeRefreshMask &= ~bit;
        break;
      }
    }
    realtimeRefreshDueAt = pendingRealtimeRefreshMask == 0 ? 0 : now + kRealtimeCoalesceMs;
  }
  portEXIT_CRITICAL(&realtimeRefreshMux);
  if (nextBit == 0) return false;

  if (nextBit == kRefreshFirmwareBit) {
    lastFirmwarePollAt = now;
    pollFirmwareManifest();
  } else if (nextBit == kRefreshGatewayBit) {
    lastGatewayPollAt = now;
    fetchGatewayState(/*applyPending=*/true);
    syncRealtimeEndpoint();
  } else if (nextBit == kRefreshConfigBit) {
    lastConfigPollAt = now;
    fetchDeviceConfig();
  } else if (nextBit == kRefreshThreadsBit) {
    // The list is fetched only while visible. Opening it already performs a fresh fetch, so a
    // background event never spends bandwidth on data the person is not looking at.
    if (uiScreen == UiScreen::Threads) openThreadMenu();
  } else if (nextBit == kRefreshControlsBit) {
    lastControlsPollAt = now;
    fetchDeviceControls();
  } else if (nextBit == kRefreshDisplayBit) {
    lastDisplayPollAt = now;
    pollDisplay();
  }
  return true;
}

// Everything that talks to the gateway, run once the link is up. Kept together so the loop has a
// single "we are online" branch rather than a reachability check per call site.
void runGatewayCycle(bool justConnected) {
  const uint32_t now = millis();
  if (justConnected) {
    lastHeartbeatAt = now;
    lastConfigPollAt = now;
    lastControlsPollAt = now;
    lastGatewayPollAt = now;
    lastFirmwarePollAt = now;
    lastDisplayPollAt = now;
    sendHeartbeat();
    fetchGatewayState(/*applyPending=*/true);
    fetchDeviceConfig();
    fetchDeviceControls();
    pollFirmwareManifest();
    pollDisplay();
    return;
  }
  if (consumeRealtimeRefresh()) return;
  if (now - lastHeartbeatAt > kHeartbeatIntervalMs) {
    lastHeartbeatAt = now;
    sendHeartbeat();
  }
  if (now - lastConfigPollAt > kConfigPollIntervalMs) {
    lastConfigPollAt = now;
    fetchDeviceConfig();
  }
  if (now - lastControlsPollAt > kControlsPollIntervalMs) {
    lastControlsPollAt = now;
    fetchDeviceControls();
  }
  if (now - lastGatewayPollAt > kGatewayPollIntervalMs) {
    lastGatewayPollAt = now;
    fetchGatewayState(/*applyPending=*/true);
  }
  if (now - lastFirmwarePollAt > kFirmwarePollIntervalMs) {
    lastFirmwarePollAt = now;
    pollFirmwareManifest();
  }
  if (now - lastDisplayPollAt > kDisplayPollIntervalMs) {
    lastDisplayPollAt = now;
    pollDisplay();
  }
}

void loop() {
  pollReservedStopHold();
  handleButtons();
  pollResetHold();

  if (!deviceStore.hasIdentity()) {
    delay(50);
    return;
  }

  const ProvisioningState state = provisioning.poll();
  static ProvisioningState lastRenderedState = ProvisioningState::Unprovisioned;
  if (state != lastRenderedState) {
    lastRenderedState = state;
    renderProvisioningState();
  }

  if (state != ProvisioningState::Online) {
    // Offline states are the portal's to drive. Polling the gateway here would just stack up
    // failures, and the portal's web server needs the cycles.
    delay(10);
    return;
  }

  if (deviceRevoked) {
    // A revoked device keeps heartbeating — that is how the owner sees it is still alive after a
    // transfer reset — but the screen tells the truth and offers the way out.
    //
    // Rendered once on entry, not every pass: this branch runs every 10ms, and re-rendering there
    // rebuilt the display strings and logged a line ~37 times a second forever. The e-ink itself was
    // spared only because drawDisplay() skips unchanged content.
    if (!revokedScreenShown) {
      revokedScreenShown = true;
      renderRevoked();
    }
    if (millis() - lastHeartbeatAt > kHeartbeatIntervalMs) {
      lastHeartbeatAt = millis();
      sendHeartbeat();
    }
    delay(10);
    return;
  }

  runGatewayCycle(provisioning.consumeJustConnected());
  delay(10);
}
