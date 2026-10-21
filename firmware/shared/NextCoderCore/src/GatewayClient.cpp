#include "GatewayClient.h"


#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <esp_system.h>

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <WiFiClientSecure.h>

#include "GatewayTls.h"

namespace {
// The reference firmware's cadences. A heartbeat is cheap and proves liveness; config changes
// rarely; and a claim code is deliberately slow to re-request because rotating one invalidates the
// code the owner is currently reading off the screen.
constexpr uint32_t kHeartbeatIntervalMs = 30000;
constexpr uint32_t kConfigIntervalMs = 60000;
constexpr uint32_t kSetupCodeIntervalMs = 10UL * 60UL * 1000UL;
// Bounds the worst-case render stall, because this call sits on the render loop until the client
// can publish under a lock instead of holding one across its request. A local gateway answers in
// tens of milliseconds; anything slower than this is a gateway that is not going to answer usefully
// inside a frame budget anyway, and waiting longer only freezes the animation for longer.
constexpr uint16_t kTimeoutMs = 1200;

String generateDeviceCredential() {
  uint8_t bytes[32];
  esp_fill_random(bytes, sizeof(bytes));
  static constexpr char kHex[] = "0123456789abcdef";
  char encoded[(sizeof(bytes) * 2) + 1];
  for (size_t index = 0; index < sizeof(bytes); index += 1) {
    encoded[index * 2] = kHex[bytes[index] >> 4];
    encoded[(index * 2) + 1] = kHex[bytes[index] & 0x0f];
  }
  encoded[sizeof(bytes) * 2] = '\0';
  return String(encoded);
}

// Operate cadences. The display poll dominates the request budget (12/min against a device-read
// limit of 120/min), which is what leaves room for the gesture-driven calls a person makes.
constexpr uint32_t kDisplayIntervalMs = 5000;
// The thread list is not a screen, it is the device's destination. HOME names the thread a message
// or a voice note will go to, and the picker steps through them — so the list has to be warm before
// anyone touches anything. It was previously fetched only when the THREADS screen was opened, which
// meant HOME said "Open THREADS to load the list": the device asking the owner to go and fetch its
// own state before it could tell them where their words were about to go.
constexpr uint32_t kThreadsIntervalMs = 30000;
constexpr uint32_t kControlsIntervalMs = 30000;
// The reference firmware never polled approvals — its only signal was a dispatch answering
// `approval_required`, so a command parked by policy afterwards was invisible until someone opened
// the console. On a screen that can show a queue, that is worth two requests a minute.
constexpr uint32_t kApprovalsIntervalMs = 30000;
constexpr uint32_t kFirmwareIntervalMs = 6UL * 60UL * 60UL * 1000UL;
}  // namespace

const char* gatewayLinkName(GatewayLink link) {
  switch (link) {
    case GatewayLink::NoIdentity:  return "no-identity";
    case GatewayLink::Connecting:  return "connecting";
    case GatewayLink::Unclaimed:   return "unclaimed";
    case GatewayLink::Claimed:     return "claimed";
    case GatewayLink::Revoked:     return "revoked";
    case GatewayLink::Unreachable: return "unreachable";
    default: return "idle";
  }
}

void GatewayClient::begin(DeviceStore& store, const String& hardwareModel,
                          const String& firmwareVersion) {
  store_ = &store;
  hardwareModel_ = hardwareModel;
  firmwareVersion_ = firmwareVersion;
  // A code cached from a previous boot is shown immediately, so a unit that has been sitting
  // unclaimed does not blank its screen while it waits for the first request to come back.
  claimCode_ = store.claimCode();
  // Same reasoning for the execution context: a boot with no gateway still knows which thread it
  // was driving, so the first frame is the real screen rather than a placeholder.
  if (store.configCache().length() > 0) applyConfigJson(store.configCache());
}

void GatewayClient::setCapabilities(bool microphone, bool camera) {
  setCapabilities(true, true, microphone, camera);
}

void GatewayClient::setCapabilities(bool display, bool threadPicker, bool microphone, bool camera) {
  hasDisplay_ = display;
  hasThreadPicker_ = threadPicker;
  hasMicrophone_ = microphone;
  hasCamera_ = camera;
}

void GatewayClient::setLimits(const GatewayLimits& limits) {
  limits_ = limits;
  if (limits_.menuItems > kMaxDeviceControls) limits_.menuItems = kMaxDeviceControls;
  if (limits_.threadItems > kMaxThreadOptions) limits_.threadItems = kMaxThreadOptions;
}

int GatewayClient::request(const char* method, const char* path, const String& body,
                           String& response, const String* credentialOverride,
                           bool trackAuthState) {
  if (!store_) return -1;
  String base = store_->gatewayUrl();
  if (base.length() == 0) return -1;

  // One global gate, checked here rather than in runCycle() alone, because the operate surface is
  // driven by a person pressing things: without it a rate-limited gateway would still be hit once
  // per touch. Answering 429 locally costs no socket and keeps the caller's error path identical.
  if (backoffUntil_ != 0 && (int32_t)(millis() - backoffUntil_) < 0) {
    response = "rate limited locally";
    return 429;
  }

  const String url = base + path;

  // Declaration order is load-bearing, not style.
  //
  // C++ destroys locals in reverse declaration order, and HTTPClient keeps a reference to the
  // client it was handed. With HTTPClient declared first it is destroyed LAST — after the client it
  // points at — so ~HTTPClient() calls stop() on freed memory. That crashed as
  // InstrFetchProhibited at PC 0xfffffffd (a call through a dead vtable), and corrupted the lwIP
  // TCP heap on the way out, which surfaced later as pbuf_free/tcp_seg_free panics in the tcpip
  // thread. The device was rebooting roughly twice a minute.
  //
  // Clients first, HTTPClient last: it dies first, while what it points at is still alive.
  WiFiClientSecure secure;
  WiFiClient plain;
  HTTPClient http;

  http.setTimeout(kTimeoutMs);
  http.setConnectTimeout(kTimeoutMs);

  if (!gateway_tls::beginHttp(http, plain, secure, url, "gateway")) return -1;

  http.addHeader("content-type", "application/json");
  http.addHeader("x-device-id", store_->deviceId());
  http.addHeader("x-device-secret", credentialOverride ? *credentialOverride : store_->deviceSecret());
  // HTTPClient discards every response header it was not told to keep, so without this the
  // retry-after read below always parsed an empty string and every 429 backed off for the 1 s
  // floor instead of the interval the gateway asked for.
  const char* kCollected[] = {"retry-after"};
  http.collectHeaders(kCollected, 1);

  // Everything from here to the end of the read is socket wait, so the lock goes back first. The
  // renderer can take it and paint a frame from the values already published while this waits.
  const uint32_t heldDepth = releaseStateForBlockingCall();
  const int code = String(method) == "POST" ? http.POST(body) : http.GET();
  if (code > 0) {
    // A device-facing body larger than this is a bug or an attack, never a payload — the biggest
    // real one is a twelve-row thread list. Reading it into a String first and rejecting afterwards
    // would already have spent the heap this guard exists to protect.
    const int length = http.getSize();
    if (length > (int)kMaxResponseBodyBytes) {
      Serial.printf("[gateway] %s oversized response %d bytes\n", path, length);
      response = "response too large";
    } else {
      response = http.getString();
    }
  }

  // HTTPClient logs "error(-11): read Timeout" with no indication of which call died, which makes a
  // recurring failure impossible to attribute. Name the path and the code.
  if (code <= 0) Serial.printf("[gateway] %s failed code=%d\n", path, code);

  // Reader is done; take the lock back before touching a single member below.
  reacquireStateAfterBlockingCall(heldDepth);

  // 401 means the credential itself was rejected — the owner revoked this device, or it was
  // transfer-reset. No amount of retrying fixes that, so it is recorded here, once, rather than
  // being re-derived at every call site.
  if (trackAuthState) {
    if (code == 401) revoked_ = true;
    else if (code >= 200 && code < 300) revoked_ = false;
  }

  // A rate-limited gateway is telling us exactly how long to wait; ignoring it turns one 429 into
  // a storm.
  if (code == 429) {
    const int retryAfter = http.header("retry-after").toInt();
    backoffUntil_ = millis() + (uint32_t)max(1, retryAfter) * 1000UL;
  }

  http.end();
  return code;
}

void GatewayClient::sendHeartbeat() {
  JsonDocument doc;
  doc["protocolVersion"] = 2;
  doc["hardwareModel"] = hardwareModel_;
  doc["firmwareVersion"] = firmwareVersion_;
  doc["ipAddress"] = WiFi.localIP().toString();
  doc["wifiRssi"] = WiFi.RSSI();
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["uptimeMs"] = millis();

  // Features gate which controls the gateway is willing to assign: it will not put a capture action
  // on a board that never claimed a microphone.
  JsonArray features = doc["features"].to<JsonArray>();
  if (hasDisplay_) features.add("display");
  if (hasThreadPicker_) features.add("thread_picker");
  if (hasMicrophone_) features.add("microphone");
  if (hasCamera_) features.add("camera");
#if ENABLE_OTA_APPLY
  features.add("ota");
  features.add("ota_confirm");
#endif

  // Limits are how the gateway knows what to wrap and truncate to. They are declared, not
  // negotiated — send the wrong numbers and the text comes back clipped.
  JsonObject limits = doc["limits"].to<JsonObject>();
  limits["menuItems"] = limits_.menuItems;
  limits["threadItems"] = limits_.threadItems;
  limits["labelCharacters"] = limits_.labelCharacters;
  if (limits_.mediaUploadBytes > 0) limits["mediaUploadBytes"] = limits_.mediaUploadBytes;

  String body;
  serializeJson(doc, body);

  String response;
  const int code = request("POST", "/v1/device/heartbeat", body, response);
  if (code > 0 && (code < 200 || code >= 300)) {
    Serial.printf("[gateway] heartbeat %d\n", code);
  }
  if (code >= 200 && code < 300) {
    observeCredentialRotation(response);
    confirmFirmwareIfPendingVerify();
  }
  if (code <= 0) {
    link_ = GatewayLink::Unreachable;
    detail_ = "No response";
  }
}

void GatewayClient::observeCredentialRotation(const String& heartbeatPayload) {
  JsonDocument doc;
  if (deserializeJson(doc, heartbeatPayload)) return;
  JsonObject rotation = doc["device"]["credentialRotation"];
  if (rotation.isNull()) return;

  const String rotationId = String(rotation["id"] | "");
  const String state = String(rotation["state"] | "idle");
  const String purpose = String(rotation["purpose"] | "");
  const uint32_t version = rotation["pendingCredentialVersion"] | 0;
  const bool mayStage = state == "pending" || (state == "expired" && purpose == "transfer");
  if (!mayStage || rotationId.length() == 0 || version <= store_->credentialVersion()) {
    // A local candidate for a superseded or cancelled ordinary rotation must not leak into a later
    // rotation. A completed rotation is handled by the pending-auth replay path before heartbeat.
    if (store_->hasPendingDeviceSecret() && state != "completed") {
      store_->rollbackPendingDeviceSecret();
      stagedCredentialRotationId_ = "";
    }
    return;
  }

  if (store_->hasPendingDeviceSecret()
      && store_->pendingCredentialRotationId() == rotationId
      && store_->pendingCredentialVersion() == version) return;

  if (store_->hasPendingDeviceSecret()) store_->rollbackPendingDeviceSecret();
  const String candidate = generateDeviceCredential();
  if (!store_->stagePendingDeviceSecret(candidate, rotationId, version, purpose)) {
    Serial.println("[gateway] could not persist a pending device credential");
    return;
  }
  stagedCredentialRotationId_ = "";
  Serial.printf("[gateway] credential rotation staged locally version=%u purpose=%s\n",
                static_cast<unsigned>(version), purpose.c_str());
}

bool GatewayClient::processPendingDeviceCredential() {
  if (!store_->hasPendingDeviceSecret()) return false;
  const String rotationId = store_->pendingCredentialRotationId();
  const uint32_t version = store_->pendingCredentialVersion();
  const String pendingSecret = store_->pendingDeviceSecret();

  JsonDocument doc;
  doc["rotationId"] = rotationId;
  doc["credentialVersion"] = version;

  if (stagedCredentialRotationId_ != rotationId) {
    doc["secret"] = pendingSecret;
    String body;
    serializeJson(doc, body);
    String response;
    const int code = request("POST", "/v1/device/credentials/stage", body, response,
                             nullptr, /*trackAuthState=*/false);
    if (code >= 200 && code < 300) {
      stagedCredentialRotationId_ = rotationId;
    } else if (code == 401) {
      // The gateway may already have promoted the candidate and lost only its success response.
      // The pending-auth ACK is idempotent and distinguishes that case on the next pass.
      stagedCredentialRotationId_ = rotationId;
    } else if (code == 409 || code == 410) {
      store_->rollbackPendingDeviceSecret();
      stagedCredentialRotationId_ = "";
      nextHeartbeatAt_ = millis();
    }
    return true;
  }

  String body;
  serializeJson(doc, body);
  String response;
  const int code = request("POST", "/v1/device/credentials/ack", body, response,
                           &pendingSecret, /*trackAuthState=*/false);
  if (code >= 200 && code < 300) {
    const bool resetForTransfer = store_->pendingCredentialPurpose() == "transfer";
    if (!store_->promotePendingDeviceSecret(rotationId, version)) {
      Serial.println("[gateway] credential ACK received but local promotion failed; retrying");
      return true;
    }
    stagedCredentialRotationId_ = "";
    revoked_ = false;
    Serial.printf("[gateway] credential rotation acknowledged version=%u\n",
                  static_cast<unsigned>(version));
    if (resetForTransfer) {
      claimCode_ = "";
      store_->resetForProvisioning();
      link_ = GatewayLink::Unclaimed;
      detail_ = "Ready to claim";
      nextSetupCodeAt_ = 0;
    }
  } else if (code == 401 || code == 409 || code == 410) {
    // 401 here is safe to roll back: an already-promoted candidate is accepted by the ACK replay
    // branch, while a rejected candidate leaves the still-active old secret as the recovery path.
    store_->rollbackPendingDeviceSecret();
    stagedCredentialRotationId_ = "";
    nextHeartbeatAt_ = millis();
  }
  return true;
}

// Claim state is discovered HERE, not from the heartbeat.
//
// The gateway answers 403 on the owned resources — config and display — while a device is
// authenticated but unowned. The heartbeat is a liveness signal and deliberately does not decide
// this, which matters because a revoked device must keep heartbeating so its owner can see it is
// still alive.
void GatewayClient::fetchConfig() {
  String response;
  const int code = request("GET", "/v1/device/config", "", response);

  if (code >= 200 && code < 300) {
    if (link_ != GatewayLink::Claimed) {
      justClaimed_ = true;
      Serial.println("[gateway] claimed — this controller now has an owner");
      // A device that has just been claimed has no controls, no display state, and no approval
      // queue. Making all three due now is what turns the claim screen into a working screen
      // within a few passes instead of within a controls interval.
      markOperateDue(millis());
    }
    link_ = GatewayLink::Claimed;
    detail_ = "";
    // Cached only once it has parsed. A body that failed the size guard still arrives with a 200,
    // and writing that to NVS would make the next boot render garbage before the first poll.
    if (applyConfigJson(response)) store_->setConfigCache(response);
    // The code is spent. Keeping it would show a stale claim screen after a transfer reset.
    if (claimCode_.length() > 0) {
      claimCode_ = "";
      store_->clearClaimCode();
    }
    return;
  }

  if (code == 403) {
    link_ = GatewayLink::Unclaimed;
    detail_ = "";
    fetchSetupCode(false);
    return;
  }

  if (code == 401) {
    link_ = GatewayLink::Revoked;
    detail_ = "Credential rejected";
    return;
  }

  link_ = GatewayLink::Unreachable;
  detail_ = code > 0 ? String("HTTP ") + code : String("No response");
}

void GatewayClient::fetchSetupCode(bool rotate) {
  // A cached code short-circuits: the gateway answers "the existing code is still valid" and
  // returns nothing, so re-asking would only cost a request.
  if (!rotate && claimCode_.length() > 0) return;
  if (millis() < nextSetupCodeAt_) return;
  nextSetupCodeAt_ = millis() + kSetupCodeIntervalMs;

  // No cached code and the device is unowned: ROTATE to obtain one.
  //
  // The stable-code rule exists to protect a code printed on a box before the owner ever reads it.
  // This product has no printed code — the device's own screen is the only place it is ever shown —
  // so a unit with nothing cached has no code in the world, and refusing to mint one strands it
  // saying "use the code on the box" about a box that does not exist.
  const bool mustRotate = rotate || claimCode_.length() == 0;

  String response;
  const String body = mustRotate ? "{\"rotate\":true}" : "{\"rotate\":false}";
  const int code = request("POST", "/v1/device/setup-code", body, response);
  if (code < 200 || code >= 300) {
    Serial.printf("[gateway] setup-code failed: %d\n", code);
    return;
  }

  JsonDocument doc;
  if (deserializeJson(doc, response)) return;

  JsonObject setup = doc["setup"];
  if (setup["claimed"] | false) {
    claimCode_ = "";
    store_->clearClaimCode();
    return;
  }

  const char* issued = setup["claimCode"] | doc["claimCode"] | "";
  const char* expires = setup["claimCodeExpiresAt"] | doc["claimCodeExpiresAt"] | "";
  // The plaintext comes back exactly once, at issue, because the gateway stores only its hash.
  // Persisting it here is what lets the endpoint stop rotating on every call — and what keeps the
  // code on the box agreeing with the code on the screen.
  if (strlen(issued) > 0) {
    claimCode_ = issued;
    store_->setClaimCode(claimCode_, String(expires));
    Serial.printf("[gateway] claim code %s (expires %s)\n", issued, expires);
  }
}

void GatewayClient::requestNewClaimCode() {
  if (!store_ || WiFi.status() != WL_CONNECTED) return;
  claimCode_ = "";
  store_->clearClaimCode();
  nextSetupCodeAt_ = 0;
  fetchSetupCode(true);
}

void GatewayClient::goOffline() {
  // The portal owns the screen while offline, and polling here would only stack up failures.
  if (link_ != GatewayLink::NoIdentity) link_ = GatewayLink::Idle;
}

void GatewayClient::lockState() {
  if (!stateMutex_) return;
  xSemaphoreTakeRecursive((SemaphoreHandle_t)stateMutex_, portMAX_DELAY);
  lockOwner_ = xTaskGetCurrentTaskHandle();
  lockDepth_ += 1;
}

bool GatewayClient::tryLockState(uint32_t waitMs) {
  if (!stateMutex_) return true;   // task not started yet: single-threaded, nothing to guard
  if (xSemaphoreTakeRecursive((SemaphoreHandle_t)stateMutex_, pdMS_TO_TICKS(waitMs)) != pdTRUE) {
    return false;
  }
  lockOwner_ = xTaskGetCurrentTaskHandle();
  lockDepth_ += 1;
  return true;
}

void GatewayClient::unlockState() {
  if (!stateMutex_) return;
  if (lockDepth_ > 0) {
    lockDepth_ -= 1;
    if (lockDepth_ == 0) lockOwner_ = nullptr;
  }
  xSemaphoreGiveRecursive((SemaphoreHandle_t)stateMutex_);
}

// Hands the lock back for the duration of a blocking call, all the way down.
//
// This is the whole reason the second core is usable at all. The task holds the lock across a
// fetch so its parse and its member writes are atomic against the renderer — but the socket wait
// inside that fetch is up to the full request timeout, and a renderer blocked on it drops every
// frame in that window. That is precisely the stall this was meant to remove.
//
// A recursive mutex is only released when it has been given back as many times as it was taken, so
// releasing once would leave the renderer queued behind the remaining depth. Hence the explicit
// count: nothing else can tell us what it is.
uint32_t GatewayClient::releaseStateForBlockingCall() {
  if (!stateMutex_) return 0;
  if (lockOwner_ != xTaskGetCurrentTaskHandle()) return 0;
  const uint32_t depth = lockDepth_;
  lockDepth_ = 0;
  lockOwner_ = nullptr;
  for (uint32_t i = 0; i < depth; i += 1) xSemaphoreGiveRecursive((SemaphoreHandle_t)stateMutex_);
  return depth;
}

void GatewayClient::reacquireStateAfterBlockingCall(uint32_t depth) {
  if (!stateMutex_ || depth == 0) return;
  for (uint32_t i = 0; i < depth; i += 1) {
    xSemaphoreTakeRecursive((SemaphoreHandle_t)stateMutex_, portMAX_DELAY);
  }
  lockOwner_ = xTaskGetCurrentTaskHandle();
  lockDepth_ = depth;
}

namespace {

void gatewayNetworkTask(void* arg) {
  GatewayClient* client = static_cast<GatewayClient*>(arg);
  for (;;) {
    client->networkTick();
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

void gatewayEventTask(void* arg) {
  static_cast<GatewayClient*>(arg)->eventTaskLoop();
}

}  // namespace

void GatewayClient::networkTick() {
  if (networkPaused_) return;
  const bool justConnected = justConnectedPending_;
  justConnectedPending_ = false;
  if (!tryLockState(5000)) return;
  runCycle(justConnected);
  unlockState();
}

void GatewayClient::startNetworkTask() {
  if (stateMutex_) return;
  stateMutex_ = xSemaphoreCreateRecursiveMutex();
  if (!stateMutex_) {
    Serial.println("[gateway] could not create the state mutex; staying on the caller's thread");
    return;
  }
  // Core 0. The Arduino loop, and therefore the renderer, runs on core 1.
  // OTA adds a 4 KB streaming buffer on top of HTTP/TLS and ArduinoJson frames. The former 8 KB
  // stack hit its canary on real hardware as soon as a mandatory manifest began downloading.
  xTaskCreatePinnedToCore(gatewayNetworkTask, "gwnet", 16384, this, 1, nullptr, 0);
  xTaskCreatePinnedToCore(gatewayEventTask, "gwevents", 6144, this, 1, nullptr, 0);
  Serial.println("[gateway] network and event tasks started; the render loop never waits on HTTP");
}

void GatewayClient::eventTaskLoop() {
  for (;;) {
    if (!store_ || WiFi.status() != WL_CONNECTED || link_ != GatewayLink::Claimed
        || networkPaused_) {
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }

    String base = store_->gatewayUrl();
    if (base.length() == 0) {
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }

    WiFiClientSecure secure;
    WiFiClient plain;
    HTTPClient http;
    http.useHTTP10(true);  // close-delimited body: no chunk frames mixed into the SSE lines
    http.setConnectTimeout(kTimeoutMs);
    http.setTimeout(kTimeoutMs);
    const String url = base + "/v1/device/events";
    if (!gateway_tls::beginHttp(http, plain, secure, url, "events")) {
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }
    http.addHeader("x-device-id", store_->deviceId());
    http.addHeader("x-device-secret", store_->deviceSecret());

    const int code = http.GET();
    if (code != 200) {
      Serial.printf("[gateway] device event stream failed code=%d\n", code);
      http.end();
      vTaskDelay(pdMS_TO_TICKS(code == 429 ? 5000 : 2000));
      continue;
    }

    WiFiClient* stream = http.getStreamPtr();
    String line;
    String event;
    String data;
    line.reserve(160);
    data.reserve(384);
    while (WiFi.status() == WL_CONNECTED && !networkPaused_
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
        if (data.length() > 0) {
          if (event == "threads.changed") applyThreadChangedEvent(data);
          else applyRefreshEvent(event, data);
        }
        event = "";
        data = "";
      }
      line = "";
    }
    http.end();
    vTaskDelay(pdMS_TO_TICKS(2000));
  }
}

void GatewayClient::applyRefreshEvent(const String& event, const String& payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return;
  const String targetDevice = String(doc["deviceId"] | "");
  if (targetDevice.length() > 0 && (!store_ || targetDevice != store_->deviceId())) return;

  lockState();
  const uint32_t due = millis() + 250;  // coalesce a route's store write + typed event burst
  if (event == "device.refresh") {
    for (JsonVariant value : doc["resources"].as<JsonArray>()) {
      const char* raw = value | "";
      const String resource = String(raw);
      if (resource == "config") nextConfigAt_ = due;
      else if (resource == "threads") nextThreadsAt_ = due;
      else if (resource == "controls") nextControlsAt_ = due;
      else if (resource == "approvals") nextApprovalsAt_ = due;
      else if (resource == "display") nextDisplayAt_ = due;
    }
  } else if (event == "firmware.changed") {
    const String model = String(doc["hardwareModel"] | "");
    if (model.length() == 0 || model == hardwareModel_) nextFirmwareAt_ = due;
  } else if (event == "t3.approval.decided" || event == "t3.user-input.answered") {
    nextApprovalsAt_ = due;
    nextDisplayAt_ = due;
  } else if (event == "command.reconciled" || event == "t3.snapshot"
             || event == "t3.thread.snapshot" || event == "t3.thread.event"
             || event == "t3.thread.status" || event == "media.job") {
    nextDisplayAt_ = due;
  }
  unlockState();
}

void GatewayClient::applyThreadChangedEvent(const String& payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return;
  const String environmentId = String(doc["environmentId"] | "");
  const String threadId = String(doc["threadId"] | "");
  const String action = String(doc["action"] | "");
  const String title = String(doc["title"] | "");
  if (environmentId.length() == 0 || threadId.length() == 0) return;
  if (action != "created" && action != "renamed" && action != "archived" && action != "deleted") return;
  if (action == "renamed" && title.length() == 0) return;

  lockState();
  if (context_.environmentId != environmentId) {
    unlockState();
    return;
  }

  if (action != "created") {
    size_t pendingIndex = pendingThreadMutationCount_;
    for (size_t i = 0; i < pendingThreadMutationCount_; i += 1) {
      if (pendingThreadMutations_[i].threadId == threadId) {
        pendingIndex = i;
        break;
      }
    }
    if (pendingIndex >= kMaxPendingThreadMutations) pendingIndex = 0;
    if (pendingIndex == pendingThreadMutationCount_
        && pendingThreadMutationCount_ < kMaxPendingThreadMutations) {
      pendingThreadMutationCount_ += 1;
    }
    PendingDeviceThreadMutation& pending = pendingThreadMutations_[pendingIndex];
    pending.threadId = threadId;
    pending.title = title;
    pending.remove = action == "archived" || action == "deleted";
    pending.expiresAt = millis() + 2UL * 60UL * 1000UL;
  }

  bool changed = false;
  if (action == "renamed" && title.length() > 0) {
    for (size_t i = 0; i < threadCount_; i += 1) {
      if (threads_[i].id != threadId || threads_[i].title == title) continue;
      threads_[i].title = title;
      changed = true;
    }
  } else if (action == "archived" || action == "deleted") {
    size_t write = 0;
    for (size_t read = 0; read < threadCount_; read += 1) {
      if (threads_[read].id == threadId) {
        changed = true;
        continue;
      }
      if (write != read) threads_[write] = threads_[read];
      write += 1;
    }
    threadCount_ = write;
    if (context_.threadId == threadId) {
      context_.threadId = "";
      closeResponse();
      nextConfigAt_ = millis();
      nextControlsAt_ = millis();
      changed = true;
    }
    selectedThreadIndex_ = -1;
    for (size_t i = 0; i < threadCount_; i += 1) {
      threads_[i].selected = threads_[i].id == context_.threadId;
      if (threads_[i].selected) selectedThreadIndex_ = static_cast<int>(i);
    }
  }

  // T3 accepts commands before its snapshot projection necessarily catches up. The event supplies
  // the immediate delta; the pending entry keeps later snapshot polls from resurrecting stale data
  // until T3's read projection agrees.
  nextThreadsAt_ = millis() + 1500;
  if (changed) touch();
  unlockState();
}


void GatewayClient::runCycle(bool justConnected) {
  if (!store_) return;
  if (!store_->hasIdentity()) {
    // Terminal. Identity is written at manufacture and the owner cannot supply one, so say so
    // instead of looping on 401s.
    link_ = GatewayLink::NoIdentity;
    detail_ = "Factory flash needed";
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    goOffline();
    return;
  }
  const uint32_t now = millis();
  if (backoffUntil_ != 0 && (int32_t)(now - backoffUntil_) < 0) return;

  // Credential recovery precedes ordinary traffic. It performs at most one HTTP request per pass,
  // and the active slot is not replaced until the gateway has authenticated the candidate.
  if (processPendingDeviceCredential()) return;

  if (justConnected) {
    if (link_ == GatewayLink::Idle) link_ = GatewayLink::Connecting;
    nextHeartbeatAt_ = now + kHeartbeatIntervalMs;
    nextConfigAt_ = now + kConfigIntervalMs;
    nextFirmwareAt_ = now + 1500;
    sendHeartbeat();
    fetchConfig();
    // Deliberately not fetched here. The reference firmware ran the whole sequence in one burst on
    // the just-connected edge; marking them due instead spreads the same work across the next few
    // passes and keeps the one-request-per-call rule true on every path, including this one.
    markOperateDue(now);
    return;
  }

  // One request per call, heartbeat first: it is the cheaper of the two and the one that proves the
  // device is alive even when it is revoked and nothing else will answer.
  if ((int32_t)(now - nextHeartbeatAt_) >= 0) {
    nextHeartbeatAt_ = now + kHeartbeatIntervalMs;
    sendHeartbeat();
    if (revoked_) {
      link_ = GatewayLink::Revoked;
      detail_ = "Credential rejected";
    }
    return;
  }

  // A revoked device keeps heartbeating — that is how its owner sees it is still there after a
  // transfer reset — but there is nothing else worth asking for.
  if (revoked_) return;

  if ((int32_t)(now - nextConfigAt_) >= 0) {
    nextConfigAt_ = now + kConfigIntervalMs;
    fetchConfig();
    return;
  }

  // Nothing below is answerable while the device is unowned — the gateway returns 403 on every
  // owned resource — so an unclaimed unit sits on heartbeat plus config and nothing else.
  if (link_ != GatewayLink::Claimed) return;

  if ((int32_t)(now - nextFirmwareAt_) >= 0) {
    nextFirmwareAt_ = now + kFirmwareIntervalMs;
    pollFirmwareManifest();
    return;
  }

  // Ahead of controls and approvals: a device that cannot name its destination cannot be used at
  // all, while a stale action row or approval badge is merely out of date.
  if (hasThreadPicker_ && (int32_t)(now - nextThreadsAt_) >= 0) {
    nextThreadsAt_ = now + kThreadsIntervalMs;
    refreshThreads();
    return;
  }

  if (hasDisplay_ && (int32_t)(now - nextControlsAt_) >= 0) {
    nextControlsAt_ = now + kControlsIntervalMs;
    fetchControls();
    return;
  }

  if (hasDisplay_ && (int32_t)(now - nextApprovalsAt_) >= 0) {
    nextApprovalsAt_ = now + kApprovalsIntervalMs;
    refreshApprovals();
    return;
  }

  if (hasDisplay_ && (int32_t)(now - nextDisplayAt_) >= 0) {
    nextDisplayAt_ = now + kDisplayIntervalMs;
    // An open, unfinished response takes the display slot rather than adding a request to it. This
    // is the whole turn-completion poll: `waiting` or `streaming` means the assistant has not
    // finished, and any other state stops it.
    if (responseOpen_ && responseInFlight()) {
      fetchResponsePage(response_.page);
    } else {
      fetchDisplay();
    }
  }
}

void GatewayClient::markOperateDue(uint32_t now) {
  nextThreadsAt_ = now;
  nextDisplayAt_ = now;
  nextControlsAt_ = now;
  nextApprovalsAt_ = now;
}

bool GatewayClient::consumeJustClaimed() {
  const bool value = justClaimed_;
  justClaimed_ = false;
  return value;
}
