#include "GatewayClient.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Update.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "GatewayTls.h"
#include <esp_ota_ops.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>

namespace {
constexpr size_t kOtaBufferSize = 4096;

String hexDigest(const uint8_t* data, size_t length) {
  static const char* digits = "0123456789abcdef";
  String output;
  output.reserve(length * 2);
  for (size_t i = 0; i < length; i += 1) {
    output += digits[(data[i] >> 4) & 0x0f];
    output += digits[data[i] & 0x0f];
  }
  return output;
}

String jsonString(const char* text) {
  String output = "\"";
  while (*text) {
    if (*text == '"' || *text == '\\') output += '\\';
    output += *text++;
  }
  output += '"';
  return output;
}

String canonicalManifest(JsonObject manifest) {
  String output = "{";
  output += "\"channel\":" + jsonString(manifest["channel"] | "stable");
  output += ",\"createdAt\":" + jsonString(manifest["createdAt"] | "");
  output += ",\"hardwareModel\":" + jsonString(manifest["hardwareModel"] | "");
  output += ",\"mandatory\":";
  output += (manifest["mandatory"] | false) ? "true" : "false";
  output += ",\"releaseNotes\":" + jsonString(manifest["releaseNotes"] | "");
  output += ",\"sha256\":" + jsonString(manifest["sha256"] | "");
  output += ",\"sizeBytes\":" + String(static_cast<unsigned long>(manifest["sizeBytes"] | 0));
  output += ",\"url\":" + jsonString(manifest["url"] | "");
  output += ",\"version\":" + jsonString(manifest["version"] | "");
  output += "}";
  return output;
}

bool verifyManifest(JsonObject manifest) {
#if REQUIRE_OTA_SIGNATURE
  const char* signature = manifest["signature"] | "";
  if (strlen(signature) != 64 || strlen(OTA_MANIFEST_VERIFY_KEY) == 0) return false;
  const String canonical = canonicalManifest(manifest);
  uint8_t digest[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!info || mbedtls_md_hmac(
      info, reinterpret_cast<const unsigned char*>(OTA_MANIFEST_VERIFY_KEY),
      strlen(OTA_MANIFEST_VERIFY_KEY),
      reinterpret_cast<const unsigned char*>(canonical.c_str()), canonical.length(), digest) != 0) {
    return false;
  }
  return hexDigest(digest, sizeof(digest)).equalsIgnoreCase(signature);
#else
  (void)manifest;
  return true;
#endif
}

String originOf(const String& url) {
  const int scheme = url.indexOf("://");
  if (scheme < 0) return "";
  const int slash = url.indexOf('/', scheme + 3);
  return slash < 0 ? url : url.substring(0, slash);
}
}  // namespace

void GatewayClient::reportFirmwareStatus(const char* state, const char* targetVersion,
                                         const char* detail, int progress) {
  JsonDocument doc;
  doc["state"] = state;
  doc["version"] = firmwareVersion_;
  if (targetVersion && strlen(targetVersion) > 0) doc["targetVersion"] = targetVersion;
  if (detail && strlen(detail) > 0) doc["detail"] = detail;
  if (progress >= 0) doc["progress"] = progress;
  String body;
  serializeJson(doc, body);
  String response;
  const int code = request("POST", "/v1/device/firmware/status", body, response);
  Serial.printf("[ota] status=%s code=%d\n", state, code);
}

void GatewayClient::pollFirmwareManifest() {
  if (!store_) return;
  String path = String("/v1/device/firmware?version=") + firmwareVersion_
    + "&hardware=" + hardwareModel_;
  String response;
  const int code = request("GET", path.c_str(), "", response);
  if (code < 200 || code >= 300) {
    Serial.printf("[ota] manifest poll code=%d\n", code);
    return;
  }
  JsonDocument doc;
  if (deserializeJson(doc, response) || !(doc["updateAvailable"] | false)) return;
  JsonObject manifest = doc["manifest"];
  const String target = String(manifest["version"] | "");
  const String installation = String(doc["installation"] | "manual");
  if (target.length() == 0) return;
  reportFirmwareStatus("available", target.c_str(),
    installation == "automatic" ? "automatic install authorized" : "waiting for dashboard authorization");
  if (installation != "automatic") return;
#if ENABLE_OTA_APPLY
  applyFirmwareUpdate(response);
#else
  reportFirmwareStatus("failed", target.c_str(), "OTA apply unavailable; USB bootstrap required");
#endif
}

bool GatewayClient::applyFirmwareUpdate(const String& manifestPayload) {
#if !ENABLE_OTA_APPLY
  (void)manifestPayload;
  return false;
#else
  JsonDocument doc;
  if (deserializeJson(doc, manifestPayload) || !doc["manifest"].is<JsonObject>()) return false;
  JsonObject manifest = doc["manifest"].as<JsonObject>();
  const String urlValue = String(manifest["url"] | "");
  const String expectedSha = String(manifest["sha256"] | "");
  const String target = String(manifest["version"] | "");
  const size_t expectedSize = static_cast<size_t>(manifest["sizeBytes"] | 0);
  if (!verifyManifest(manifest)) {
    reportFirmwareStatus("failed", target.c_str(), "manifest signature invalid");
    return false;
  }
  if (urlValue.length() == 0 || expectedSha.length() != 64 || target.length() == 0
      || expectedSize == 0) {
    reportFirmwareStatus("failed", target.c_str(), "manifest incomplete");
    return false;
  }

  String downloadUrl = urlValue;
  if (downloadUrl.startsWith("/")) downloadUrl = store_->gatewayUrl() + downloadUrl;
  reportFirmwareStatus("downloading", target.c_str(), "download started", 0);

  WiFiClient plain;
  WiFiClientSecure secure;
  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(15000);
  if (!gateway_tls::beginHttp(http, plain, secure, downloadUrl, "ota")) {
    reportFirmwareStatus("failed", target.c_str(), "download connection failed");
    return false;
  }
  if (originOf(downloadUrl) == originOf(store_->gatewayUrl())) {
    http.addHeader("x-device-id", store_->deviceId());
    http.addHeader("x-device-secret", store_->deviceSecret());
  }

  const uint32_t heldDepth = releaseStateForBlockingCall();
  const int code = http.GET();
  if (code != HTTP_CODE_OK) {
    http.end();
    reacquireStateAfterBlockingCall(heldDepth);
    reportFirmwareStatus("failed", target.c_str(), "download request failed");
    return false;
  }
  const int contentLength = http.getSize();
  if (contentLength > 0 && static_cast<size_t>(contentLength) != expectedSize) {
    http.end();
    reacquireStateAfterBlockingCall(heldDepth);
    reportFirmwareStatus("failed", target.c_str(), "download size mismatch");
    return false;
  }
  if (!Update.begin(expectedSize)) {
    http.end();
    reacquireStateAfterBlockingCall(heldDepth);
    reportFirmwareStatus("failed", target.c_str(), "OTA partition unavailable");
    return false;
  }

  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0);
  WiFiClient* stream = http.getStreamPtr();
  uint8_t buffer[kOtaBufferSize];
  size_t written = 0;
  int reportedProgress = 0;
  uint32_t lastDataAt = millis();
  while (written < expectedSize && http.connected()) {
    const size_t available = stream->available();
    if (available == 0) {
      if (millis() - lastDataAt > 15000) break;
      delay(10);
      continue;
    }
    lastDataAt = millis();
    const int count = stream->readBytes(buffer, min(available, sizeof(buffer)));
    if (count <= 0) continue;
    mbedtls_sha256_update(&sha, buffer, count);
    if (Update.write(buffer, count) != static_cast<size_t>(count)) break;
    written += count;
    const int progress = static_cast<int>((written * 100) / expectedSize);
    if (progress >= reportedProgress + 10) {
      reportedProgress = progress;
      // Do not issue another socket request while the artifact stream is open. Progress is logged;
      // the gateway receives the terminal installing/rebooting state immediately afterwards.
      Serial.printf("[ota] download %d%%\n", progress);
    }
  }
  uint8_t digest[32];
  mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);
  http.end();
  reacquireStateAfterBlockingCall(heldDepth);

  if (written != expectedSize) {
    Update.abort();
    reportFirmwareStatus("failed", target.c_str(), "download incomplete");
    return false;
  }
  if (!hexDigest(digest, sizeof(digest)).equalsIgnoreCase(expectedSha)) {
    Update.abort();
    reportFirmwareStatus("failed", target.c_str(), "sha256 mismatch");
    return false;
  }
  reportFirmwareStatus("installing", target.c_str(), "image verified", 100);
  if (!store_->setOtaAttempt(firmwareVersion_, target)) {
    Update.abort();
    reportFirmwareStatus("failed", target.c_str(), "OTA state marker unavailable");
    return false;
  }
  if (!Update.end(true)) {
    store_->clearOtaAttempt();
    reportFirmwareStatus("failed", target.c_str(), "OTA finalize failed");
    return false;
  }
  reportFirmwareStatus("rebooting", target.c_str(), "booting pending image", 100);
  delay(500);
  ESP.restart();
  return true;
#endif
}

void GatewayClient::handleOtaBootAttempt() {
#if ENABLE_OTA_APPLY
  if (!store_) return;
  const uint32_t attempts = store_->registerOtaBootAttempt(firmwareVersion_);
  if (attempts < 2) return;
  const esp_partition_t* previous = esp_ota_get_next_update_partition(nullptr);
  if (previous && esp_ota_set_boot_partition(previous) == ESP_OK) {
    Serial.printf("[ota] unhealthy image; selecting %s\n", previous->label);
    delay(500);
    ESP.restart();
  }
#endif
}

void GatewayClient::confirmFirmwareIfPendingVerify() {
#if ENABLE_OTA_APPLY
  static bool confirmed = false;
  if (confirmed || !store_) return;
  const String source = store_->otaSourceVersion();
  const String target = store_->otaTargetVersion();
  if (target.length() > 0 && source == firmwareVersion_ && target != firmwareVersion_) {
    reportFirmwareStatus("rolled_back", target.c_str(), "previous image restored", 100);
    store_->clearOtaAttempt();
    confirmed = true;
    return;
  }
  const esp_partition_t* running = esp_ota_get_running_partition();
  if (!running) return;
  esp_ota_img_states_t state;
  if (esp_ota_get_state_partition(running, &state) != ESP_OK) return;
  if (target == firmwareVersion_ || state == ESP_OTA_IMG_PENDING_VERIFY) {
    if (state == ESP_OTA_IMG_PENDING_VERIFY
        && esp_ota_mark_app_valid_cancel_rollback() != ESP_OK) {
      reportFirmwareStatus("failed", firmwareVersion_.c_str(), "pending image verification failed");
      return;
    }
    reportFirmwareStatus("verified", firmwareVersion_.c_str(), "heartbeat healthy", 100);
    store_->clearOtaAttempt();
  }
  confirmed = true;
#endif
}
