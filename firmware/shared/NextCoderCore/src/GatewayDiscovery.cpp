#include "GatewayDiscovery.h"

#include <WiFi.h>
#include <WiFiUdp.h>

namespace {
constexpr uint16_t kDiscoveryPort = 3997;
const char* kProbe = "AGENTCTL?";

// Minimal field extraction. Pulling in a JSON parser for three strings from a datagram we defined
// ourselves is not worth the flash, and a malformed reply simply fails to match.
String jsonString(const String& src, const char* key) {
  const String needle = String("\"") + key + "\":\"";
  const int at = src.indexOf(needle);
  if (at < 0) return "";
  const int start = at + needle.length();
  const int end = src.indexOf('"', start);
  if (end < 0) return "";
  return src.substring(start, end);
}
}  // namespace

GatewayCandidate discoverGateway(uint32_t timeoutMs) {
  GatewayCandidate result;

  // Pure SoftAP means we are not on the owner's network and there is nothing to find. Saying so is
  // more useful than timing out.
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[discovery] no station connection; nothing to search");
    return result;
  }

  WiFiUDP udp;
  // Port 0 asks for an ephemeral local port, so this never collides with the gateway's own.
  if (!udp.begin(0)) {
    Serial.println("[discovery] could not open a UDP socket");
    return result;
  }

  // Directed subnet broadcast as well as the global one: some access points drop 255.255.255.255
  // between clients but will still forward a directed broadcast.
  const IPAddress local = WiFi.localIP();
  const IPAddress mask = WiFi.subnetMask();
  IPAddress directed(local[0] | ~mask[0], local[1] | ~mask[1],
                     local[2] | ~mask[2], local[3] | ~mask[3]);

  for (const IPAddress& target : {IPAddress(255, 255, 255, 255), directed}) {
    udp.beginPacket(target, kDiscoveryPort);
    udp.write((const uint8_t*)kProbe, strlen(kProbe));
    udp.endPacket();
  }

  const uint32_t deadline = millis() + timeoutMs;
  while ((int32_t)(millis() - deadline) < 0) {
    const int size = udp.parsePacket();
    if (size <= 0) {
      delay(10);
      continue;
    }

    char buf[512];
    const int len = udp.read(buf, sizeof(buf) - 1);
    if (len <= 0) continue;
    buf[len] = '\0';
    const String payload(buf);

    const String service = jsonString(payload, "service");
    // The service name is a wire value shared with src/discovery.mjs on the gateway. Accept the
    // current "next-coder" name and the legacy "agent-controller" name, so a device keeps finding a
    // gateway that has not been renamed yet.
    if (service != "next-coder" && service != "agent-controller") continue;
    const String url = jsonString(payload, "baseUrl");
    if (url.length() == 0) continue;

    result.baseUrl = url;
    result.name = jsonString(payload, "name");
    result.found = true;
    Serial.printf("[discovery] found %s at %s\n", result.name.c_str(), result.baseUrl.c_str());
    break;
  }

  udp.stop();
  if (!result.found) Serial.println("[discovery] no gateway answered");
  return result;
}
