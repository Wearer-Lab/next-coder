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

// How many times the artifact download is attempted, and how long the device waits between
// attempts. A failed handshake leaves the heap in no worse a state than a successful one, so the
// retry is safe; the bound keeps a device that cannot reach the artifact from retrying forever.
constexpr int kDownloadAttempts = 4;
constexpr uint32_t kDownloadRetryDelayMs = 4000;

bool verifyManifest(JsonObject manifest) {
#if REQUIRE_OTA_SIGNATURE
  const char* signature = manifest["signature"] | "";
  if (strlen(signature) != 64 || strlen(OTA_MANIFEST_VERIFY_KEY) == 0) {
    // The two failure modes look identical from the outside - "manifest signature invalid" - but
    // they need different fixes: a missing key is a build or seed problem, a wrong digest is a
    // canonical-form problem. Say which one it is, and how long the key is, without ever printing
    // the key.
    Serial.printf("[ota] manifest rejected: signature length %u, verify key length %u\n",
                  (unsigned)strlen(signature), (unsigned)strlen(OTA_MANIFEST_VERIFY_KEY));
    return false;
  }
  const String canonical = canonicalManifest(manifest);
  uint8_t digest[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!info || mbedtls_md_hmac(
      info, reinterpret_cast<const unsigned char*>(OTA_MANIFEST_VERIFY_KEY),
      strlen(OTA_MANIFEST_VERIFY_KEY),
      reinterpret_cast<const unsigned char*>(canonical.c_str()), canonical.length(), digest) != 0) {
    Serial.printf("[ota] manifest rejected: HMAC over %u canonical bytes failed\n",
                  (unsigned)canonical.length());
    return false;
  }
  const String computed = hexDigest(digest, sizeof(digest));
  if (!computed.equalsIgnoreCase(signature)) {
    // Both digests are public values: the signature travelled in the manifest, and the computed one
    // is a hash of a public document. Printing them makes the failure diagnosable from the serial
    // log alone, which is the only place a bench operator can look.
    Serial.printf("[ota] manifest rejected: digest mismatch\n  gateway %s\n  device  %s\n",
                  signature, computed.c_str());
    // A fingerprint of every field the digest was taken over, so a mismatch is traced to the field
    // that parsed differently instead of being guessed at. Lengths only: the url carries a signed
    // capability token, and no field value is printed.
    Serial.printf(
        "[ota] canonical %u bytes: channel=%u createdAt=%u hardware=%u notes=%u sha=%u url=%u "
        "version=%u size=%u mandatory=%d\n",
        (unsigned)canonical.length(),
        (unsigned)strlen(manifest["channel"] | "stable"),
        (unsigned)strlen(manifest["createdAt"] | ""),
        (unsigned)strlen(manifest["hardwareModel"] | ""),
        (unsigned)strlen(manifest["releaseNotes"] | ""),
        (unsigned)strlen(manifest["sha256"] | ""),
        (unsigned)strlen(manifest["url"] | ""),
        (unsigned)strlen(manifest["version"] | ""),
        (unsigned)(long)(manifest["sizeBytes"] | 0),
        (int)(manifest["mandatory"] | false));
    return false;
  }
  return true;
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
    reportFirmwareStatus("failed", target.c_str(), "download connection failed (tls refused)");
    return false;
  }
  if (originOf(downloadUrl) == originOf(store_->gatewayUrl())) {
    http.addHeader("x-device-id", store_->deviceId());
    http.addHeader("x-device-secret", store_->deviceSecret());
  }

  // The download needs a TLS session of its own, and mbedTLS wants one contiguous block for
  // it. By the time an update is polled, the display buffers and the orb canvas have fragmented
  // the heap, and the handshake can fail on a request that a moment later would succeed - the
  // symptom is a socket hang-up on the far side and a bare -1 here. So the attempt is repeated a
  // few times: the update is idempotent, the cost is a few seconds, and the alternative is a
  // device that can never update itself while the screen is on.
  const uint32_t heldDepth = releaseStateForBlockingCall();
  int code = 0;
  for (int attempt = 1; attempt <= kDownloadAttempts; attempt += 1) {
    Serial.printf("[ota] download attempt %d/%d, free heap %u bytes\n", attempt, kDownloadAttempts,
                  (unsigned)ESP.getFreeHeap());
    code = http.GET();
    if (code == HTTP_CODE_OK) break;
    http.end();
    if (attempt < kDownloadAttempts) {
      delay(kDownloadRetryDelayMs);
      // A new session needs a new handshake, so the client is begun again.
      if (!gateway_tls::beginHttp(http, plain, secure, downloadUrl, "ota")) break;
      if (originOf(downloadUrl) == originOf(store_->gatewayUrl())) {
        http.addHeader("x-device-id", store_->deviceId());
        http.addHeader("x-device-secret", store_->deviceSecret());
      }
    }
  }
  if (code != HTTP_CODE_OK) {
    http.end();
    reacquireStateAfterBlockingCall(heldDepth);
    char detail[48];
    snprintf(detail, sizeof(detail), "download request failed (code %d)", code);
    reportFirmwareStatus("failed", target.c_str(), detail);
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
