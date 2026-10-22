#include "GatewayClient.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Update.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "GatewayTls.h"
#include "GatewayHttp.h"
#include "OtaDownloadSink.h"
#include <esp_ota_ops.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>

namespace {

// An idle timeout alone can be reset forever by a drip-fed response. Stop the underlying socket
// at an absolute deadline, including while HTTPClient is reading headers or chunk metadata.
template <typename Client>
class OtaDeadlineClient : public gateway_http::YieldingClient<Client> {
 public:
  explicit OtaDeadlineClient(uint32_t deadline) : deadline_(deadline) {}
  using gateway_http::YieldingClient<Client>::read;
  int available() override { return expired() ? 0 : Client::available(); }
  int read() override {
    if (expired()) { delay(1); return -1; }
    return gateway_http::YieldingClient<Client>::read();
  }
  int read(uint8_t* buffer, size_t size) override {
    if (expired()) { if (size) delay(1); return -1; }
    return gateway_http::YieldingClient<Client>::read(buffer, size);
  }
 private:
  bool expired() {
    if ((int32_t)(millis() - deadline_) < 0) return false;
    Client::stop();
    return true;
  }
  uint32_t deadline_;
};

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
  if (String(manifest["hardwareModel"] | "") != hardwareModel_) {
    reportFirmwareStatus("failed", target.c_str(), "firmware hardware model mismatch");
    return false;
  }
  if (urlValue.length() == 0 || expectedSha.length() != 64 || target.length() == 0
      || expectedSize == 0) {
    reportFirmwareStatus("failed", target.c_str(), "manifest incomplete");
    return false;
  }

  const auto settings = store_->transportSnapshot();
  String downloadUrl = urlValue;
  if (downloadUrl.startsWith("/")) downloadUrl = settings.gatewayUrl + downloadUrl;
  reportFirmwareStatus("downloading", target.c_str(), "download started", 0);

  uint8_t digest[32];
  bool updateStarted = false;
  size_t written = 0;
  const uint32_t downloadDeadline = millis() + 120000;
  const uint32_t heldDepth = releaseStateForBlockingCall();
  const char* failure = [&]() -> const char* {
    gateway_tls::ScopedLock tls;
    if (!tls.held()) return "download TLS gate busy";
    OtaDeadlineClient<WiFiClient> plain(downloadDeadline);
    OtaDeadlineClient<WiFiClientSecure> secure(downloadDeadline);
    HTTPClient http;
    http.setConnectTimeout(5000);
    http.setTimeout(15000);
    http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    int code = 0;
    for (int attempt = 1; attempt <= kDownloadAttempts; attempt += 1) {
      if ((int32_t)(millis() - downloadDeadline) >= 0) return "download deadline exceeded";
      if (!gateway_tls::beginHttp(http, plain, secure, downloadUrl, "ota")) {
        return "download connection failed (TLS refused)";
      }
      if (originOf(downloadUrl) == originOf(settings.gatewayUrl)) {
        http.addHeader("x-device-id", settings.deviceId);
        http.addHeader("x-device-secret", settings.deviceSecret);
      }
      code = http.GET();
      if (code == HTTP_CODE_OK) break;
      http.end();
      if (attempt < kDownloadAttempts) delay(kDownloadRetryDelayMs);
    }
    if (code != HTTP_CODE_OK) return "download request failed";
    const int contentLength = http.getSize();
    if (contentLength >= 0 && static_cast<size_t>(contentLength) != expectedSize) return "download size mismatch";
    if (!Update.begin(expectedSize)) return "OTA partition unavailable";
    updateStarted = true;
    OtaDownloadSink sink(expectedSize);
    const int read = http.writeToStream(&sink);
    written = sink.written();
    if (read < 0 || !sink.finish(digest)) return "download incomplete or oversized";
    http.end();
    return nullptr;
  }();
  // Socket buffers and the TLS gate are gone before state is reacquired, including every failure.
  reacquireStateAfterBlockingCall(heldDepth);
  if (failure) {
    if (updateStarted) Update.abort();
    reportFirmwareStatus("failed", target.c_str(), failure);
    return false;
  }
  const auto current = store_->transportSnapshot();
  if (current.gatewayUrl != settings.gatewayUrl || current.deviceId != settings.deviceId) {
    Update.abort();
    reportFirmwareStatus("failed", target.c_str(), "gateway changed during download");
    return false;
  }
  Serial.printf("[ota] verified download received %u bytes\n", (unsigned)written);
  if (!hexDigest(digest, sizeof(digest)).equalsIgnoreCase(expectedSha)) {
    Update.abort();
    reportFirmwareStatus("failed", target.c_str(), "sha256 mismatch");
    return false;
  }
  reportFirmwareStatus("installing", target.c_str(), "image verified", 100);
  const bool committed = store_->commitWithTransport(settings, [&] {
    if (!store_->setOtaAttempt(firmwareVersion_, target)) return false;
    if (Update.end(true)) return true;
    store_->clearOtaAttempt();
    return false;
  });
  if (!committed) {
    Update.abort();
    reportFirmwareStatus("failed", target.c_str(), "OTA commit failed or gateway changed");
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
