#include "gatewayProbe.h"

#include <DeviceStore.h>
#include <GatewayDiscovery.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include <GatewayTls.h>
#include <GatewayHttp.h>

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

extern DeviceStore& deviceStore();

namespace {

// Written by the probe task, read by the render loop. A single aligned byte, so a torn read is not
// possible; nothing here needs a mutex and taking one on the render path would be worse than the
// problem it solves.
volatile GatewayStatus status = GatewayStatus::Unknown;
volatile bool probeNow = false;

constexpr uint32_t kIntervalMs = 20000;
constexpr uint16_t kTimeoutMs = 4000;

GatewayStatus probeOnce(const String& base) {
  if (base.length() == 0) return GatewayStatus::Unknown;

  const String url = base + "/health";

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
  gateway_http::YieldingClient<WiFiClientSecure> secure;
  gateway_http::YieldingClient<WiFiClient> plain;
  HTTPClient http;

  http.setTimeout(kTimeoutMs);
  http.setConnectTimeout(kTimeoutMs);
  // A gateway that redirects is a gateway that is up; following the redirect only slows the answer.
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);

  if (!gateway_tls::beginHttp(http, plain, secure, url, "probe")) return GatewayStatus::Unreachable;

  const int code = http.GET();
  http.end();

  if (code <= 0) return GatewayStatus::Unreachable;     // negative codes are transport failures
  if (code >= 200 && code < 400) return GatewayStatus::Reachable;
  // 4xx/5xx means something is listening and talking HTTP, just not a gateway — a different
  // problem from a wrong host, and worth saying differently.
  return GatewayStatus::BadResponse;
}

// The probe shares the TLS lock with the gateway request path. mbedTLS needs one ~32 KB
// contiguous block per handshake, and internal RAM here is already fragmented; a probe that
// overlaps a gateway request can leave the request without a session buffer at all.
GatewayStatus probeOnceLocked(const String& base) {
  if (!gateway_tls::lockTls()) return GatewayStatus::Unknown;
  const GatewayStatus status = probeOnce(base);
  gateway_tls::unlockTls();
  return status;
}

void probeTask(void*) {
  // Its own task on purpose. HTTPClient blocks for the whole connect-and-read, up to four seconds
  // here, and doing that on the render loop would stall the animation exactly like the blocking
  // serial writes did.
  uint32_t nextAt = 0;
  for (;;) {
    const uint32_t now = millis();
    if (probeNow || (int32_t)(now - nextAt) >= 0) {
      probeNow = false;
      nextAt = now + kIntervalMs;

      if (WiFi.status() != WL_CONNECTED) {
        status = GatewayStatus::Unknown;
      } else {
        const String configuredUrl = deviceStore().transportSnapshot().gatewayUrl;
        GatewayStatus s = probeOnceLocked(configuredUrl);

        // If the configured gateway does not answer, look for one. An address that cannot be
        // reached is worth nothing, so replacing it with one that can is never a downgrade — and
        // this is the whole reason a device on the same network should not need to be told an
        // address in the first place.
        //
        // Only on failure, never on success: a working gateway is not second-guessed because some
        // other machine on the network also answered.
#if INSECURE_SKIP_TLS_VERIFY
        // LAN discovery is an explicit bench convenience only. A transient cloud failure must
        // never redirect a provisioned identity to an unauthenticated UDP advertiser.
        if (s != GatewayStatus::Reachable
            && gateway_tls::isBenchLanHttpUrl(configuredUrl)) {
          const GatewayCandidate found = discoverGateway();
          if (found.found && found.baseUrl != configuredUrl) {
            const GatewayStatus probed = probeOnceLocked(found.baseUrl);
            if (probed == GatewayStatus::Reachable) {
              Serial.printf("[gateway] adopting discovered %s (%s); previous %s was %s\n",
                            found.baseUrl.c_str(), found.name.c_str(),
                            configuredUrl.c_str(), gatewayStatusText(s));
              deviceStore().setGatewayUrl(found.baseUrl);
              s = probed;
            }
          }
        }
#endif

        if (s != status) {
          Serial.printf("[gateway] %s -> %s\n", configuredUrl.c_str(),
                        gatewayStatusText(s));
        }
        status = s;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(250));
  }
}

}  // namespace

void gatewayProbeBegin() {
  // 4 KB is comfortable for HTTPClient without TLS; TLS needs more, hence 8.
  xTaskCreatePinnedToCore(probeTask, "gwprobe", 8192, nullptr, 1, nullptr, 0);
}

GatewayStatus gatewayStatus() { return status; }

void gatewayProbeNow() { probeNow = true; }

const char* gatewayStatusText(GatewayStatus s) {
  switch (s) {
    case GatewayStatus::Reachable:   return "reachable";
    case GatewayStatus::Unreachable: return "unreachable";
    case GatewayStatus::BadResponse: return "answered, not a gateway";
    default: return "unknown";
  }
}
