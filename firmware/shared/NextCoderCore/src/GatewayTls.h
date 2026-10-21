#pragma once

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <time.h>

// Board projects expose their generated/bench configuration on PlatformIO's include path. Keeping
// trust configuration there lets manufacturing inject production roots without forking the shared
// gateway client.
#if defined(CONTROLLER_CONFIG_PLACEHOLDER_BUILD)
// Hermetic compile-only builds must not inspect an ignored live board config. Safe defaults below
// keep TLS fail-closed; board pins are included by the board's own translation units.
#elif __has_include("controller_config.h")
#include "controller_config.h"
#endif

#ifndef INSECURE_SKIP_TLS_VERIFY
#define INSECURE_SKIP_TLS_VERIFY 0
#endif

// Existing bench configs may still opt out, but a named secure/product build always fails closed.
#if (defined(SECURE_BUILD_REQUIRE_OTA_SIGNATURE) && SECURE_BUILD_REQUIRE_OTA_SIGNATURE) \
    || (defined(SECURE_BUILD_TLS_VERIFY) && SECURE_BUILD_TLS_VERIFY)
#undef INSECURE_SKIP_TLS_VERIFY
#define INSECURE_SKIP_TLS_VERIFY 0
#endif

// PEM roots may be concatenated during a CA rotation: ship both, move the cloud certificate, then
// remove the old root in a later firmware release.
#ifndef GATEWAY_TLS_ROOT_CA_PEM
#define GATEWAY_TLS_ROOT_CA_PEM ""
#endif
#ifndef GATEWAY_TLS_NEXT_ROOT_CA_PEM
#define GATEWAY_TLS_NEXT_ROOT_CA_PEM ""
#endif
#ifndef GATEWAY_TLS_TIME_SYNC_SERVER
#define GATEWAY_TLS_TIME_SYNC_SERVER "time.cloudflare.com"
#endif

namespace gateway_tls {

inline bool isPrivateIpv4Host(const String& host) {
  if (host == "localhost") return true;
  int octets[4] = {0, 0, 0, 0};
  int start = 0;
  for (int part = 0; part < 4; part += 1) {
    const int end = part == 3 ? host.length() : host.indexOf('.', start);
    if (end < 0 || end <= start || end - start > 3) return false;
    int value = 0;
    for (int index = start; index < end; index += 1) {
      const char digit = host[index];
      if (digit < '0' || digit > '9') return false;
      value = value * 10 + (digit - '0');
    }
    if (value > 255) return false;
    octets[part] = value;
    start = end + 1;
  }
  if (start != host.length() + 1) return false;
  return octets[0] == 127 || octets[0] == 10
    || (octets[0] == 192 && octets[1] == 168)
    || (octets[0] == 169 && octets[1] == 254)
    || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31);
}

inline bool isBenchLanHttpUrl(const String& url) {
  static constexpr char kPrefix[] = "http://";
  if (!url.startsWith(kPrefix)) return false;
  const size_t authorityStart = sizeof(kPrefix) - 1;
  int authorityEnd = url.indexOf('/', authorityStart);
  const int queryAt = url.indexOf('?', authorityStart);
  const int fragmentAt = url.indexOf('#', authorityStart);
  if (authorityEnd < 0 || (queryAt >= 0 && queryAt < authorityEnd)) authorityEnd = queryAt;
  if (authorityEnd < 0 || (fragmentAt >= 0 && fragmentAt < authorityEnd)) authorityEnd = fragmentAt;
  if (authorityEnd < 0) authorityEnd = url.length();
  String authority = url.substring(authorityStart, authorityEnd);
  if (authority.length() == 0 || authority.indexOf('@') >= 0) return false;

  String host;
  if (authority.startsWith("[")) {
    const int close = authority.indexOf(']');
    if (close < 0 || (close + 1 < authority.length() && authority[close + 1] != ':')) return false;
    host = authority.substring(1, close);
    host.toLowerCase();
    return host == "::1" || host.startsWith("fe80:")
      || ((host.startsWith("fc") || host.startsWith("fd")) && host.indexOf(':') >= 0);
  }
  const int portAt = authority.indexOf(':');
  host = portAt < 0 ? authority : authority.substring(0, portAt);
  host.toLowerCase();
  return isPrivateIpv4Host(host);
}

// This is used both by NVS persistence and by the socket boundary. Production accepts HTTPS only.
// Plain HTTP is a named local-bench escape hatch and is still restricted to loopback/private LAN
// authorities, so setting the flag cannot accidentally authorize credentials to a public host.
inline bool gatewayUrlAllowed(const String& url) {
  if (url.length() == 0 || url.indexOf(' ') >= 0 || url.indexOf('\n') >= 0 || url.indexOf('\r') >= 0) {
    return false;
  }
  if (url.startsWith("https://")) {
    const size_t authorityStart = 8;
    int authorityEnd = url.indexOf('/', authorityStart);
    const int queryAt = url.indexOf('?', authorityStart);
    const int fragmentAt = url.indexOf('#', authorityStart);
    if (authorityEnd < 0 || (queryAt >= 0 && queryAt < authorityEnd)) authorityEnd = queryAt;
    if (authorityEnd < 0 || (fragmentAt >= 0 && fragmentAt < authorityEnd)) authorityEnd = fragmentAt;
    if (authorityEnd < 0) authorityEnd = url.length();
    const String authority = url.substring(authorityStart, authorityEnd);
    return authority.length() > 0 && authority.indexOf('@') < 0;
  }
#if INSECURE_SKIP_TLS_VERIFY
  return isBenchLanHttpUrl(url);
#else
  return false;
#endif
}

// Certificate validity cannot be checked honestly against the ESP32's 1970 boot clock. Starting
// SNTP is non-blocking: the current request fails closed and a later poll succeeds after time lands.
inline bool clockReady() {
  constexpr time_t kMinimumTrustedEpoch = 1704067200;  // 2024-01-01T00:00:00Z
  static bool syncStarted = false;
  const time_t now = time(nullptr);
  if (now >= kMinimumTrustedEpoch) return true;
  if (!syncStarted) {
    configTime(0, 0, GATEWAY_TLS_TIME_SYNC_SERVER, "pool.ntp.org");
    syncStarted = true;
    Serial.printf("[tls] clock sync started via %s; HTTPS waits for trusted time\n",
                  GATEWAY_TLS_TIME_SYNC_SERVER);
  }
  return false;
}

inline bool configure(WiFiClientSecure& client, const char* component) {
#if INSECURE_SKIP_TLS_VERIFY
  // Explicit local-bench escape hatch. Production examples default this off.
  client.setInsecure();
  Serial.printf("[%s] WARNING: TLS certificate verification disabled by bench config\n", component);
  return true;
#else
  static constexpr char kCurrentRootCa[] = GATEWAY_TLS_ROOT_CA_PEM;
  static constexpr char kRootCaBundle[] =
      GATEWAY_TLS_ROOT_CA_PEM "\n" GATEWAY_TLS_NEXT_ROOT_CA_PEM;
  if (kCurrentRootCa[0] == '\0') {
    Serial.printf("[%s] HTTPS refused: GATEWAY_TLS_ROOT_CA_PEM is not configured\n", component);
    return false;
  }
  if (!clockReady()) {
    Serial.printf("[%s] HTTPS deferred until the device clock is trusted\n", component);
    return false;
  }
  client.setCACert(kRootCaBundle);
  return true;
#endif
}

inline bool beginHttp(HTTPClient& http, WiFiClient& plainClient, WiFiClientSecure& secureClient,
                      const String& url, const char* component) {
  if (!gatewayUrlAllowed(url)) {
    Serial.printf("[%s] request refused: gateway URL requires verified HTTPS (or explicit LAN bench mode)\n",
                  component);
    return false;
  }
  if (url.startsWith("https://")) {
    if (!configure(secureClient, component)) return false;
    return http.begin(secureClient, url);
  }
#if INSECURE_SKIP_TLS_VERIFY
  Serial.printf("[%s] WARNING: device credentials use plaintext on an explicit local bench LAN\n",
                component);
  return http.begin(plainClient, url);
#else
  return false;
#endif
}

}  // namespace gateway_tls
