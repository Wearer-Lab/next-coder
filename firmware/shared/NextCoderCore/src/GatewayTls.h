#pragma once

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <time.h>
#include <atomic>
#if defined(TLS_SESSION_DIAGNOSTICS) && TLS_SESSION_DIAGNOSTICS
#include <esp_heap_caps.h>
#endif

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

// One TLS session at a time. Established SSE sessions retain their mbedTLS buffers too.
//
// mbedTLS allocates its input and output buffers as one contiguous block of roughly 32 KB when
// the session is set up. On this hardware that block has to come out of internal RAM, which the
// display buffers and the Wi-Fi driver have already fragmented. Two handshakes alive at the same
// moment therefore do not fail slowly — the second one fails with MBEDTLS_ERR_SSL_ALLOC_FAILED
// and the request never reaches the gateway.
//
// The probe task and the gateway request path are separate tasks on different cores, so nothing
// else stops them from overlapping. This lock is the only thing that does, and it is recursive
// because the gateway client is re-entrant (a request made while answering another one must not
// deadlock against itself).
inline SemaphoreHandle_t& tlsLock() {
  static SemaphoreHandle_t handle = nullptr;
  if (handle == nullptr) {
    handle = xSemaphoreCreateRecursiveMutex();
  }
  return handle;
}

constexpr uint32_t kEventQuietMs = 2000;
inline void traceSessionHeap(const char* phase) {
#if defined(TLS_SESSION_DIAGNOSTICS) && TLS_SESSION_DIAGNOSTICS
  Serial.printf("[tls-heap] phase=%s internal_free=%u internal_largest=%u\n", phase,
    static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
    static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)));
#else
  (void)phase;
#endif
}
// ---------------------------------------------------------------------------------------------
// The warm foreground session
// ---------------------------------------------------------------------------------------------
//
// Every foreground request used to build, handshake and destroy its own TLS session: measured on
// silicon at 1.7 to 2.2 s apiece against about 30 ms of server time. GatewayWarm.h keeps ONE such
// session open between requests. It is still "one ~32 KB session at a time", so it lives entirely
// inside this gate and gives way to every other user of it:
//
//   * it exists only while the gate is free of anyone else's session. Any other taker of the gate
//     (lockTls(): OTA, media upload, the gateway probe) closes it first, through the drop hook, while
//     holding the gate - the same moment it would otherwise have started its own handshake;
//   * the SSE stream does not start while one is open (eventSessionShouldYield), and an idle one is
//     closed after GATEWAY_WARM_IDLE_MS (reapWarmIfIdle), which is what hands the lease back;
//   * only the foreground request path uses lockTlsKeepWarm(), because only it is the session's
//     owner. It still announces itself as foreground, so a live SSE stream still yields to it.
//
// The warm session is therefore owned by the gate: created, used and destroyed only with the gate
// held. These flags are the lock-free view of it for the tasks that must decide without taking it.
inline std::atomic<bool>& warmSessionOpen() {
  static std::atomic<bool> value{false};
  return value;
}
inline std::atomic<uint32_t>& warmLastUsedAt() {
  static std::atomic<uint32_t> value{0};
  return value;
}
// Registered by GatewayWarm.h. Called ONLY with the gate held.
inline std::atomic<void (*)()>& warmDropHook() {
  static std::atomic<void (*)()> value{nullptr};
  return value;
}
inline void dropWarmSessionLocked() {
  if (!warmSessionOpen().load(std::memory_order_acquire)) return;
  if (const auto drop = warmDropHook().load(std::memory_order_acquire)) drop();
}

inline std::atomic<unsigned>& foregroundWaiters() {
  static std::atomic<unsigned> value{0};
  return value;
}
inline std::atomic<uint32_t>& eventQuietUntil() {
  static std::atomic<uint32_t> value{0};
  return value;
}
inline void deferEventSession() {
  eventQuietUntil().store(millis() + kEventQuietMs, std::memory_order_release);
}
inline bool eventSessionShouldYield() {
  const uint32_t quiet = eventQuietUntil().load(std::memory_order_acquire);
  return foregroundWaiters().load(std::memory_order_acquire) != 0
    || warmSessionOpen().load(std::memory_order_acquire)
    || (quiet != 0 && static_cast<int32_t>(millis() - quiet) < 0);
}

// Returns true when the lock was taken. A caller that cannot get it in time must skip the request
// rather than perform a handshake outside the lock, which is the exact failure this prevents.
//
// `keepWarm` is true only for the owner of the warm foreground session. Everyone else is about to
// build a session of their own, so the warm one is closed first - here, with the gate held, so there
// is never a moment with two sessions' buffers alive.
inline bool lockTlsImpl(unsigned int timeoutMs, bool keepWarm) {
  SemaphoreHandle_t handle = tlsLock();
  if (handle == nullptr) return false;
  foregroundWaiters().fetch_add(1, std::memory_order_acq_rel);
  deferEventSession();
  const bool held = xSemaphoreTakeRecursive(handle, pdMS_TO_TICKS(timeoutMs)) == pdTRUE;
  foregroundWaiters().fetch_sub(1, std::memory_order_acq_rel);
  deferEventSession();
  if (held) {
    if (!keepWarm) dropWarmSessionLocked();
    traceSessionHeap("foreground.begin");
  }
  return held;
}
inline bool lockTls(unsigned int timeoutMs = 10000) { return lockTlsImpl(timeoutMs, false); }
inline bool lockTlsKeepWarm(unsigned int timeoutMs = 10000) { return lockTlsImpl(timeoutMs, true); }

// Closes the warm session once it has been idle for `idleMs`, without ever waiting for the gate or
// announcing itself as foreground (a busy gate means the session is in use, which is the answer).
// Called from the network task's tick; this is what returns the SSE stream's lease.
inline void reapWarmIfIdle(uint32_t idleMs) {
  if (!warmSessionOpen().load(std::memory_order_acquire)) return;
  if (static_cast<uint32_t>(millis() - warmLastUsedAt().load(std::memory_order_acquire)) < idleMs) return;
  SemaphoreHandle_t handle = tlsLock();
  if (handle == nullptr || xSemaphoreTakeRecursive(handle, 0) != pdTRUE) return;
  dropWarmSessionLocked();
  xSemaphoreGiveRecursive(handle);
}

inline void unlockTls() {
  SemaphoreHandle_t handle = tlsLock();
  if (handle != nullptr) {
    traceSessionHeap("foreground.end");
    deferEventSession();
    xSemaphoreGiveRecursive(handle);
  }
}

// SSE acquires without waiting and never announces itself as foreground. Declare this before
// clients: the event task alone closes its socket, and destroys it before releasing this lease.
class EventSessionLock {
 public:
  EventSessionLock() {
    if (eventSessionShouldYield()) return;
    const auto handle = tlsLock();
    if (!handle || xSemaphoreTakeRecursive(handle, 0) != pdTRUE) return;
    if (eventSessionShouldYield()) { xSemaphoreGiveRecursive(handle); return; }
    held_ = true;
    traceSessionHeap("events.begin");
  }
  ~EventSessionLock() {
    if (held_) {
      traceSessionHeap("events.end");
      xSemaphoreGiveRecursive(tlsLock());
    }
  }
  bool held() const { return held_; }
  EventSessionLock(const EventSessionLock&) = delete;
  EventSessionLock& operator=(const EventSessionLock&) = delete;
 private:
  bool held_ = false;
};

// Declare before HTTP/socket objects so they are destroyed before releasing the allocation gate.
class ScopedLock {
 public:
  explicit ScopedLock(unsigned int timeoutMs = 10000) : held_(lockTls(timeoutMs)) {}
  ~ScopedLock() { if (held_) unlockTls(); }
  bool held() const { return held_; }
  ScopedLock(const ScopedLock&) = delete;
  ScopedLock& operator=(const ScopedLock&) = delete;
 private:
  bool held_;
};

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
  // Arduino defaults to 120 s independently of HTTP deadlines. Bound the stream owner's lease.
  client.setHandshakeTimeout(6); // seconds; certificate and hostname validation stay unchanged
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

// Same transport selection as beginHttp(), minus the one-time TLS configuration, for a client that
// is ALREADY connected. Re-running configure() (setCACert, clock check) on a live socket is neither
// needed nor safe; the origin was validated when the session was built and the caller has checked
// it is unchanged. Returns false if the URL is no longer allowed.
inline bool beginHttpReuse(HTTPClient& http, WiFiClient& plainClient, WiFiClientSecure& secureClient,
                           const String& url) {
  if (!gatewayUrlAllowed(url)) return false;
  if (url.startsWith("https://")) return http.begin(secureClient, url);
#if INSECURE_SKIP_TLS_VERIFY
  return http.begin(plainClient, url);
#else
  (void)plainClient;
  return false;
#endif
}

}  // namespace gateway_tls
