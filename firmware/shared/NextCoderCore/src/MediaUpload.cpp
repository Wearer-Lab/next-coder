#include "MediaUpload.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <mbedtls/sha256.h>
#include <string.h>

#include "DeviceStore.h"
#include "GatewayTls.h"

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
  *backoffUntil = millis() + static_cast<uint32_t>(max(1, retryAfter)) * 1000UL;
}

int postJson(DeviceStore& store, const String& base, const String& path, const String& body,
             const char* tlsLabel, String& response, uint32_t* backoffUntil) {
  WiFiClientSecure secure;
  WiFiClient plain;
  HTTPClient http;
  const String url = path.startsWith("http") ? path : base + path;
  if (!gateway_tls::beginHttp(http, plain, secure, url, tlsLabel)) return -1;
  http.addHeader("content-type", "application/json");
  http.addHeader("x-device-id", store.deviceId());
  http.addHeader("x-device-secret", store.deviceSecret());
  const char* collected[] = {"retry-after"};
  http.collectHeaders(collected, 1);
  http.setTimeout(30000);
  const int code = http.POST(body);
  response = code > 0 ? http.getString() : String();
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
  uint32_t* backoffUntil
) {
  UploadSessionResult result;
  const size_t rawBytes = (headerBytes ? headerLength : 0) + (bodyBytes ? bodyLength : 0);
  if (rawBytes == 0 || WiFi.status() != WL_CONNECTED) return result;
  if (maxRawBytes > 0 && rawBytes > static_cast<size_t>(maxRawBytes)) {
    result.httpStatus = 413;
    return result;
  }
  if (backoffUntil && *backoffUntil != 0 && static_cast<int32_t>(millis() - *backoffUntil) < 0) {
    result.httpStatus = 429;
    return result;
  }
  const String base = store.gatewayUrl();
  if (base.length() == 0) return result;

  const String sha256 = sha256Hex(headerBytes, headerLength, bodyBytes, bodyLength);
  JsonDocument intent;
  intent["clientRequestId"] = String("device-") + requestNamespace + ":" + sha256.substring(0, 32);
  intent["kind"] = kind;
  intent["contentType"] = contentType;
  intent["originalName"] = originalName;
  intent["sizeBytes"] = rawBytes;
  intent["sha256"] = sha256;
  String requestBody;
  serializeJson(intent, requestBody);
  String response;
  result.httpStatus = postJson(
    store, base, "/v1/device/media/uploads", requestBody, requestNamespace, response, backoffUntil
  );
  if (!ok(result.httpStatus)) return result;
  JsonDocument session;
  if (deserializeJson(session, response)) return result;
  if (String(session["session"]["status"] | "") == "finalized") {
    result.mediaId = String(session["session"]["mediaId"] | "");
    return result;
  }
  const String uploadPath = String(session["session"]["upload"]["url"] | "");
  const String finalizePath = String(session["session"]["finalizeUrl"] | "");
  if (uploadPath.length() == 0 || finalizePath.length() == 0) return result;

  SegmentedBodyStream stream(headerBytes, headerLength, bodyBytes, bodyLength);
  WiFiClientSecure secure;
  WiFiClient plain;
  HTTPClient http;
  const String uploadUrl = uploadPath.startsWith("http") ? uploadPath : base + uploadPath;
  if (!gateway_tls::beginHttp(http, plain, secure, uploadUrl, requestNamespace)) return result;
  http.addHeader("content-type", contentType);
  http.addHeader("x-device-id", store.deviceId());
  http.addHeader("x-device-secret", store.deviceSecret());
  const char* collected[] = {"retry-after"};
  http.collectHeaders(collected, 1);
  http.setTimeout(30000);
  result.httpStatus = http.sendRequest("PUT", &stream, stream.contentLength());
  response = result.httpStatus > 0 ? http.getString() : String();
  applyRetryAfter(http, result.httpStatus, backoffUntil);
  http.end();
  Serial.printf("[media] raw session kind=%s bytes=%u code=%d\n", kind,
                static_cast<unsigned>(rawBytes), result.httpStatus);
  if (!ok(result.httpStatus)) return result;

  result.httpStatus = postJson(
    store, base, finalizePath, "{}", requestNamespace, response, backoffUntil
  );
  if (!ok(result.httpStatus)) return result;
  JsonDocument finalized;
  if (deserializeJson(finalized, response)) return result;
  result.mediaId = String(finalized["media"]["id"] | "");
  result.jobId = String(finalized["job"]["jobId"] | "");
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
