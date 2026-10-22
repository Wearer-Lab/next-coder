#include "MediaUpload.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <mbedtls/sha256.h>
#include <string.h>

#include "DeviceStore.h"
#include "GatewayTls.h"
#include "GatewayHttp.h"
#include "MediaUploadPolicy.h"

namespace {

void writeLe16(uint8_t* out, uint16_t value) {
  out[0] = static_cast<uint8_t>(value & 0xFF);
  out[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
}

void writeLe32(uint8_t* out, uint32_t value) {
  out[0] = static_cast<uint8_t>(value & 0xFF);
  out[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
  out[2] = static_cast<uint8_t>((value >> 16) & 0xFF);
  out[3] = static_cast<uint8_t>((value >> 24) & 0xFF);
}

bool ok(int code) { return code >= 200 && code < 300; }

void applyRetryAfter(HTTPClient& http, int code, uint32_t* backoffUntil) {
  if (code != 429 || backoffUntil == nullptr) return;
  const int retryAfter = http.header("retry-after").toInt();
  *backoffUntil = millis() + upload_policy::retryDelay(retryAfter);
}

bool readResponse(HTTPClient& http, String& response) {
  constexpr size_t kResponseLimit = 12 * 1024;
  gateway_http::BoundedBody sink(response, kResponseLimit);
  return http.getSize() <= static_cast<int>(kResponseLimit)
    && http.writeToStream(&sink) >= 0 && !sink.failed();
}

String gatewayPathUrl(const String& base, const String& path) {
  // The current contract supplies gateway-relative routes. Never attach the standing device
  // credential to an absolute object-storage URL, redirected host, or protocol-relative URL.
  if (!upload_policy::credentialPathAllowed(path.c_str())) return String();
  return base + path;
}

int postJson(const String& deviceId, const String& deviceSecret, const String& base, const String& path, const String& body,
             const char* tlsLabel, String& response, uint32_t* backoffUntil) {
  gateway_tls::ScopedLock tlsLock;
  if (!tlsLock.held()) return -1;
  gateway_http::YieldingClient<WiFiClientSecure> secure;
  gateway_http::YieldingClient<WiFiClient> plain;
  HTTPClient http;
  const String url = gatewayPathUrl(base, path);
  if (url.length() == 0) return -1;
  if (!gateway_tls::beginHttp(http, plain, secure, url, tlsLabel)) return -1;
  http.addHeader("content-type", "application/json");
  http.addHeader("x-device-id", deviceId);
  http.addHeader("x-device-secret", deviceSecret);
  const char* collected[] = {"retry-after"};
  http.collectHeaders(collected, 1);
  http.setTimeout(30000);
  int code = http.POST(body);
  if (code > 0 && !readResponse(http, response)) code = -1;
  applyRetryAfter(http, code, backoffUntil);
  http.end();
  return code;
}

}  // namespace

namespace media {

UploadSessionResult uploadSession(
  DeviceStore& store,
  const char* requestNamespace,
  const char* kind,
  const char* contentType,
  const char* originalName,
  const uint8_t* headerBytes,
  size_t headerLength,
  const uint8_t* bodyBytes,
  size_t bodyLength,
  uint32_t maxRawBytes,
  uint32_t* backoffUntil,
  const UploadSessionContext* context
) {
  UploadSessionResult result;
  const size_t rawBytes = (headerBytes ? headerLength : 0) + (bodyBytes ? bodyLength : 0);
  if ((headerLength > 0 && !headerBytes) || (bodyLength > 0 && !bodyBytes)
      || headerLength > SIZE_MAX - bodyLength || rawBytes == 0
      || !kind || !contentType || !requestNamespace || WiFi.status() != WL_CONNECTED) return result;
  if (maxRawBytes > 0 && rawBytes > static_cast<size_t>(maxRawBytes)) {
    result.httpStatus = 413;
    return result;
  }
  if (backoffUntil && *backoffUntil != 0 && static_cast<int32_t>(millis() - *backoffUntil) < 0) {
    result.httpStatus = 429;
    return result;
  }
  const auto settings = store.transportSnapshot();
  const String base = settings.gatewayUrl;
  if (base.length() == 0) return result;

  const String sha256 = sha256Hex(headerBytes, headerLength, bodyBytes, bodyLength);
  JsonDocument intent;
  intent["clientRequestId"] = context && context->clientRequestId.length() > 0
    ? context->clientRequestId
    : String("device-") + requestNamespace + ":" + sha256.substring(0, 32);
  if (context && context->environmentId.length() > 0) intent["environmentId"] = context->environmentId;
  if (context && context->threadId.length() > 0) intent["threadId"] = context->threadId;
  intent["kind"] = kind;
  intent["contentType"] = contentType;
  intent["originalName"] = originalName;
  intent["sizeBytes"] = rawBytes;
  intent["sha256"] = sha256;
  String requestBody;
  serializeJson(intent, requestBody);
  String response;
  result.httpStatus = postJson(
    settings.deviceId, settings.deviceSecret, base, "/v1/device/media/uploads", requestBody, requestNamespace, response, backoffUntil
  );
  if (!ok(result.httpStatus)) return result;
  JsonDocument session;
  if (deserializeJson(session, response)) return result;
  const String status = String(session["session"]["status"] | "");
  const String uploadPath = String(session["session"]["upload"]["url"] | "");
  const String finalizePath = String(session["session"]["finalizeUrl"] | "");
  if (gatewayPathUrl(base, finalizePath).length() == 0) { result.httpStatus = -1; return result; }

  // A lost finalize response must resume by replaying finalize: the response contains the existing
  // transcription job as well as the media id. Re-uploading or inventing a fresh job duplicates work.
  if (status != "finalized" && status != "uploaded") {
    if (status != "pending" || gatewayPathUrl(base, uploadPath).length() == 0) {
      result.httpStatus = -1;
      return result;
    }
    gateway_tls::ScopedLock tlsLock;
    if (!tlsLock.held()) { result.httpStatus = -1; return result; }
    SegmentedBodyStream stream(headerBytes, headerLength, bodyBytes, bodyLength);
    gateway_http::YieldingClient<WiFiClientSecure> secure;
    gateway_http::YieldingClient<WiFiClient> plain;
    HTTPClient http;
    const String uploadUrl = gatewayPathUrl(base, uploadPath);
    if (!gateway_tls::beginHttp(http, plain, secure, uploadUrl, requestNamespace)) return result;
    http.addHeader("content-type", contentType);
    http.addHeader("x-device-id", settings.deviceId);
    http.addHeader("x-device-secret", settings.deviceSecret);
    const char* collected[] = {"retry-after"};
    http.collectHeaders(collected, 1);
    http.setTimeout(30000);
    result.httpStatus = http.sendRequest("PUT", &stream, stream.contentLength());
    if (result.httpStatus > 0 && !readResponse(http, response)) result.httpStatus = -1;
    applyRetryAfter(http, result.httpStatus, backoffUntil);
    http.end();
    Serial.printf("[media] raw session kind=%s bytes=%u code=%d\n", kind,
                  static_cast<unsigned>(rawBytes), result.httpStatus);
    if (!ok(result.httpStatus)) return result;
  }

  JsonDocument finalize;
  if (context && context->environmentId.length() > 0) finalize["environmentId"] = context->environmentId;
  if (context && context->threadId.length() > 0) finalize["threadId"] = context->threadId;
  String finalizeBody;
  if (finalize.isNull()) finalize.to<JsonObject>();
  serializeJson(finalize, finalizeBody);
  result.httpStatus = postJson(
    settings.deviceId, settings.deviceSecret, base, finalizePath, finalizeBody, requestNamespace, response, backoffUntil
  );
  if (!ok(result.httpStatus)) return result;
  JsonDocument finalized;
  if (deserializeJson(finalized, response)) return result;
  result.mediaId = String(finalized["media"]["id"] | "");
  result.jobId = String(finalized["job"]["jobId"] | "");
  result.transcriptionUnavailable = String(finalized["media"]["processing"]["transcriptionStatus"] | "") == "unavailable";
  return result;
}

String sha256Hex(const uint8_t* headerBytes, size_t headerLength,
                 const uint8_t* bodyBytes, size_t bodyLength) {
  mbedtls_sha256_context context;
  mbedtls_sha256_init(&context);
  mbedtls_sha256_starts(&context, 0);
  if (headerBytes && headerLength > 0) mbedtls_sha256_update(&context, headerBytes, headerLength);
  if (bodyBytes && bodyLength > 0) mbedtls_sha256_update(&context, bodyBytes, bodyLength);
  uint8_t digest[32];
  mbedtls_sha256_finish(&context, digest);
  mbedtls_sha256_free(&context);
  static const char* digits = "0123456789abcdef";
  String output;
  output.reserve(64);
  for (size_t index = 0; index < sizeof(digest); index += 1) {
    output += digits[(digest[index] >> 4) & 0x0f];
    output += digits[digest[index] & 0x0f];
  }
  return output;
}

void buildWavHeader(uint8_t header[kWavHeaderBytes], uint32_t dataBytes, uint32_t sampleRateHz,
                    uint16_t channels, uint16_t bitsPerSample) {
  const uint16_t blockAlign = static_cast<uint16_t>(channels * (bitsPerSample / 8));
  const uint32_t byteRate = sampleRateHz * blockAlign;

  memcpy(header + 0, "RIFF", 4);
  writeLe32(header + 4, 36 + dataBytes);
  memcpy(header + 8, "WAVE", 4);
  memcpy(header + 12, "fmt ", 4);
  writeLe32(header + 16, 16);           // PCM fmt chunk size
  writeLe16(header + 20, 1);            // audio format: PCM
  writeLe16(header + 22, channels);
  writeLe32(header + 24, sampleRateHz);
  writeLe32(header + 28, byteRate);
  writeLe16(header + 32, blockAlign);
  writeLe16(header + 34, bitsPerSample);
  memcpy(header + 36, "data", 4);
  writeLe32(header + 40, dataBytes);
}

}  // namespace media
