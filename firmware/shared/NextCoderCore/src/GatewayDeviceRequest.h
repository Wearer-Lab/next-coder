#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <esp_system.h>
#include "DeviceStore.h"

// Durable receipts protect every non-idempotent device gesture, including thread creation.
// A lost socket or gateway failure is not evidence that the operation never executed.
namespace gateway_request {
inline String requestFingerprint(const String& value) {
  uint64_t hash = 1469598103934665603ULL;
  for (size_t index = 0; index < value.length(); index += 1) {
    hash ^= static_cast<uint8_t>(value[index]);
    hash *= 1099511628211ULL;
  }
  char output[17];
  snprintf(output, sizeof(output), "%08lx%08lx",
    static_cast<unsigned long>(hash >> 32), static_cast<unsigned long>(hash & 0xffffffffULL));
  return String(output);
}

inline String newDeviceRequestId() {
  char output[41];
  snprintf(output, sizeof(output), "dev:%08lx-%08lx-%08lx-%08lx",
    static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()),
    static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()));
  return String(output);
}

template <typename ResolveReceipt>
inline String beginDurableDeviceRequest(DeviceStore* store, const String& signature,
                                        ResolveReceipt resolveReceipt, String& failure) {
  failure = "";
  if (!store) { failure = "Device storage unavailable"; return String(); }
  const String hash = requestFingerprint(signature);
  auto pending = store->pendingRequestSnapshot();
  if (pending.id.length() > 0) {
    if (pending.hash == hash) return pending.id;
    // Do not overwrite an uncertain A with B. A later retry of A would otherwise acquire a
    // new id and execute twice. Resolve the old write through its scoped durable receipt.
    if (!resolveReceipt(pending.id)) {
      failure = "Check console: previous unresolved";
      return String();
    }
  }
  const String requestId = newDeviceRequestId();
  if (!store->replacePendingRequest(pending, requestId, hash)) {
    failure = "Request changed; review again";
    return String();
  }
  return requestId;
}

template <typename Lookup>
inline bool resolveDurableDeviceReceipt(const String& requestId, Lookup lookup) {
  String response;
  String path = String("/v1/device/requests/") + requestId + "?operation=intent.submit";
  int code = lookup(path.c_str(), response);
  if (code == 404) {
    path = String("/v1/device/requests/") + requestId + "?operation=thread.create";
    code = lookup(path.c_str(), response);
  }
  if (code != 200) return false;
  JsonDocument doc;
  if (deserializeJson(doc, response)) return false;
  JsonObject request = doc["request"];
  if (String(request["clientRequestId"] | "") != requestId) return false;
  const String status = String(request["status"] | "");
  return status == "failed" || status == "blocked" || status == "rejected"
    || status == "completed" || status == "dispatched" || status == "approval_required";
}

inline void settleDurableDeviceRequest(DeviceStore* store, const String& expectedId, int code, const String& payload) {
  if (!store || code <= 0) return;
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return;
  JsonObject request = doc["request"];
  if (request.isNull()) request = doc["error"]["details"]["request"].as<JsonObject>();
  const String receiptId = String(request["clientRequestId"] | "");
  if (receiptId.length() > 0 && receiptId != expectedId) return;
  const String status = String(request["status"] | "");
  if (status == "processing") return;
  const bool provenTerminal = status == "failed" || status == "blocked" || status == "rejected"
    || status == "completed" || status == "dispatched" || status == "approval_required";
  const String errorCode = String(doc["error"]["details"]["code"] | "");
  if ((code >= 500 || code == 408 || code == 429 || code == 401 || code == 403 || code == 404
      || errorCode == "device_context_changed" || errorCode == "idempotency_conflict") && !provenTerminal) return;
  if (provenTerminal || code >= 400 || !doc["command"]["id"].isNull()
      || !doc["thread"]["id"].isNull() || !doc["screen"].isNull()
      || !doc["run"]["status"].isNull()) store->clearPendingRequestIfCurrent(expectedId);
}

} // namespace gateway_request
