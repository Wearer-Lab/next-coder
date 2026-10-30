#pragma once

// One TLS session kept open between foreground gateway requests.
//
// WHY. Every request here used to be: DNS lookup, TCP connect, a full TLS 1.2 handshake, one HTTP
// exchange, teardown. Measured on silicon (Hosyond, live gateway), a foreground request costs 1.7 to
// 2.2 s while the same gateway answers a fresh `curl` connection in 70-160 ms and a REUSED one in
// about 28 ms. The two seconds are connection setup on the device, so the cloud, the network and the
// edge are not the problem; the handshake is. HTTPClient already speaks keep-alive; what destroyed
// the connection was that the clients were locals of request().
//
// WHAT OWNS IT. The TLS gate (GatewayTls.h). A session is built, used and destroyed only while the
// gate is held, because it carries the ~34 KB of internal RAM the one-session rule exists to protect.
// It is therefore not a second session beside the SSE stream: it gives way to every other taker of
// the gate (lockTls() drops it), the stream does not start while one is open, and an idle one is
// closed after kIdleMs (reapWarmIfIdle, driven from the network task). Poll cadence is 5 s, so in
// steady state the session stays warm and the stream stays down; that is the cost of a tap that
// takes one round trip, and GATEWAY_WARM_CONNECTION=0 restores a session per request.
//
// WHAT IT DOES NOT CACHE. Authentication: x-device-id and x-device-secret go out on every request,
// so revocation, rotation and a transfer reset take effect on the very next one exactly as before.
// The connection is dropped when the gateway origin or device identity differs from the one it was
// built for, after any failed, rate-limited or server-error exchange, and whenever the server does
// not offer to keep it.
//
// STALE SOCKETS. A server or a NAT may close an idle connection without this side noticing until it
// writes. A failure on a REUSED connection that happened before any response was read (the send
// failed, or the connection was lost before a status line) is retried exactly once on a fresh
// connection. Nothing was read, so the exchange is the same one; mutating routes carry a
// clientRequestId, which is what already makes a retried write safe. A timeout is not retried: it
// proves nothing about whether the server acted.

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <new>

#include "GatewayHttp.h"
#include "GatewayTls.h"
#include "OperateModel.h"   // kMaxResponseBodyBytes

// Kill switch: 0 builds a session per request, as before.
#ifndef GATEWAY_WARM_CONNECTION
#define GATEWAY_WARM_CONNECTION 1
#endif
// Idle time after which the warm session is closed and the SSE stream may take the lease. Longer
// than the 5 s display poll on purpose: shorter and every poll would pay a handshake again.
#ifndef GATEWAY_WARM_IDLE_MS
#define GATEWAY_WARM_IDLE_MS 8000
#endif
// Per-request stage timing on the serial line ([gw-timing]). On wherever the TLS heap diagnostics
// are, so a build that already prints [tls-heap] prints these too; also settable on its own.
#ifndef GATEWAY_REQUEST_TIMING
#if defined(TLS_SESSION_DIAGNOSTICS) && TLS_SESSION_DIAGNOSTICS
#define GATEWAY_REQUEST_TIMING 1
#else
#define GATEWAY_REQUEST_TIMING 0
#endif
#endif

namespace gateway_warm {

constexpr uint32_t kIdleMs = GATEWAY_WARM_IDLE_MS;

// HTTPClient's own codes, spelled out so this header does not depend on their macro names.
constexpr int kRefused = -1, kSendHeader = -2, kSendPayload = -3, kNotConnected = -4,
  kConnectionLost = -5, kTooLessRam = -8, kStreamWrite = -10;

// ---- state ---------------------------------------------------------------------------------------
// (test/firmware-request-locks.test.mjs provides doubles for everything in this section)

struct Connection {
  // Declaration order is load-bearing, not style: HTTPClient keeps a reference to the client it was
  // handed and its destructor stops it, so it must be destroyed FIRST. Clients first, HTTPClient last.
  gateway_http::YieldingClient<WiFiClientSecure> secure;
  gateway_http::YieldingClient<WiFiClient> plain;
  HTTPClient http;
  String origin;      // scheme://host[:port] this socket was built for
  String deviceId;    // the identity it was built for
  uint32_t requests = 0;
};

// The one session. Touched only with the TLS gate held.
inline Connection*& slot() {
  static Connection* value = nullptr;
  return value;
}

// Closes and frees the session. Gate held.
inline void dropLocked() {
  Connection*& connection = slot();
  if (connection) {
    delete connection;   // ~HTTPClient stops the socket while the clients it points at still live
    connection = nullptr;
  }
  gateway_tls::warmSessionOpen().store(false, std::memory_order_release);
}

inline String originOf(const String& url) {
  const int schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) return url;
  const int pathStart = url.indexOf('/', schemeEnd + 3);
  return pathStart < 0 ? url : url.substring(0, pathStart);
}

// A failure that says "this reused socket was already dead", as opposed to "the server did
// something". Only these are retried, and only once, and only on a reused connection.
inline bool staleSocketFailure(int code) {
  return code == kRefused || code == kSendHeader || code == kSendPayload || code == kNotConnected
    || code == kConnectionLost;
}

// ---- exchange --------------------------------------------------------------------------------------
// BEGIN exchange (sliced into test/firmware-request-locks.test.mjs and compiled against doubles)

// One request/response over the warm session, building (or rebuilding) it as needed.
//
// Caller contract: the TLS gate is held (lockTlsKeepWarm) and the model/state lock is NOT. Nothing
// here ever takes or waits on the state lock, so the two can never wait on each other.
// `retryAfterSeconds` receives the 429 Retry-After. `gateWaitMs` is only for the timing line.
inline int exchange(const char* component, const char* method, const char* path, const String& url,
                    const String& deviceId, const String& credential, const String& body,
                    String& response, long& retryAfterSeconds, uint16_t connectTimeoutMs,
                    uint16_t timeoutMs, uint32_t gateWaitMs) {
  (void)gateWaitMs;
  const uint32_t startedAt = millis();
  const String origin = originOf(url);
  Connection* connection = slot();
  // Anything about the session's identity having moved means it is somebody else's socket.
  if (connection && (connection->origin != origin || connection->deviceId != deviceId)) {
    dropLocked();
    connection = nullptr;
  }
  // The peer closed it while it sat idle, and the stack noticed.
  if (connection && !connection->http.connected()) {
    dropLocked();
    connection = nullptr;
  }

  int code = 0;
  bool reused = false;
  bool retried = false;
  bool bodyIncomplete = false;
  for (int attempt = 0; attempt < 2; ++attempt) {
    reused = connection != nullptr;
    if (!connection) {
      connection = new (std::nothrow) Connection();
      if (!connection) return kTooLessRam;
      connection->origin = origin;
      connection->deviceId = deviceId;
      slot() = connection;
      gateway_tls::warmDropHook().store(&dropLocked, std::memory_order_release);
      if (!gateway_tls::beginHttp(connection->http, connection->plain, connection->secure, url, component)) {
        dropLocked();
        return -1;
      }
    } else if (!gateway_tls::beginHttpReuse(connection->http, connection->plain, connection->secure, url)) {
      dropLocked();
      return -1;
    }
    HTTPClient& http = connection->http;
    http.setReuse(true);
    http.setTimeout(timeoutMs);
    http.setConnectTimeout(connectTimeoutMs);
    http.addHeader("content-type", "application/json");
    http.addHeader("x-device-id", deviceId);
    http.addHeader("x-device-secret", credential);
    // HTTPClient discards every response header it was not told to keep, so without this a 429's
    // retry-after would always parse empty and back off for the 1 s floor.
    const char* kCollected[] = {"retry-after"};
    http.collectHeaders(kCollected, 1);

#if GATEWAY_REQUEST_TIMING
    uint32_t dnsMs = 0, tcpMs = 0, tlsMs = 0;
    if (!reused) {
      // Split a fresh connection into stages by doing them ourselves, in the order HTTPClient would.
      // Diagnostic builds only: the TCP probe is an extra connection, so `tcp` is a round-trip
      // estimate and `connect` (which includes its own TCP leg) is the real total; tls ~ connect - tcp.
      const String host = origin.substring(origin.indexOf("://") + 3);
      const int colon = host.indexOf(':');
      const String name = colon < 0 ? host : host.substring(0, colon);
      const uint16_t port = colon < 0 ? (origin.startsWith("https://") ? 443 : 80) : host.substring(colon + 1).toInt();
      uint32_t t = millis();
      IPAddress address;
      WiFi.hostByName(name.c_str(), address);
      dnsMs = millis() - t;
      t = millis();
      { WiFiClient probe; probe.connect(address, port, connectTimeoutMs); probe.stop(); }
      tcpMs = millis() - t;
      t = millis();
      const bool secureUrl = origin.startsWith("https://");
      const bool connectedNow = secureUrl ? connection->secure.connect(name.c_str(), port, connectTimeoutMs)
                                          : connection->plain.connect(name.c_str(), port, connectTimeoutMs);
      tlsMs = millis() - t;
      if (connectedNow) http.setTimeout(timeoutMs);   // applies it to the live socket
    }
    const uint32_t requestAt = millis();
#endif

    code = String(method) == "POST" ? http.POST(body) : http.GET();

#if GATEWAY_REQUEST_TIMING
    const uint32_t requestMs = millis() - requestAt;
    const uint32_t bodyAt = millis();
#endif
    // Nothing of the response was read: this was a dead reused socket, not an answer. Rebuild once.
    if (code <= 0 && reused && attempt == 0 && staleSocketFailure(code)) {
      http.end();
      dropLocked();
      connection = nullptr;
      retried = true;
      continue;
    }

    bodyIncomplete = false;
    if (code > 0) {
      // A device-facing body larger than this is a bug or an attack, never a payload. Reading it
      // into a String first and rejecting afterwards would already have spent the heap this guard
      // exists to protect.
      const int length = http.getSize();
      if (length > (int)kMaxResponseBodyBytes) {
        Serial.printf("[gateway] %s oversized response %d bytes\n", path, length);
        response = "response too large";
        code = kStreamWrite;
        bodyIncomplete = true;
      } else {
        gateway_http::BoundedBody sink(response, kMaxResponseBodyBytes);
        const int read = http.writeToStream(&sink);
        if (read < 0 || sink.failed()) {
          response = "gateway response incomplete";
          code = read < 0 ? read : kStreamWrite;
          bodyIncomplete = true;
        }
      }
    }
    // HTTPClient logs "error(-11): read Timeout" with no indication of which call died.
    if (code <= 0) Serial.printf("[gateway] %s failed code=%d\n", path, code);
    if (code == 429) retryAfterSeconds = max(1L, http.header("retry-after").toInt());

#if GATEWAY_REQUEST_TIMING
    const uint32_t bodyMs = millis() - bodyAt;
    const uint32_t endAt = millis();
#endif
    // end() keeps the socket open for the next request when the server agreed to keep-alive.
    http.end();
    // Keep it only after a clean exchange the server is still willing to continue on. Anything else
    // (failure, rate limit, server error, a body that did not finish) starts the next request clean.
    const bool clean = GATEWAY_WARM_CONNECTION && code > 0 && code < 500 && code != 429 && !bodyIncomplete;
    if (clean && http.connected()) {
      ++connection->requests;
      gateway_tls::warmLastUsedAt().store(millis(), std::memory_order_release);
      gateway_tls::warmSessionOpen().store(true, std::memory_order_release);
    } else {
      dropLocked();
    }
#if GATEWAY_REQUEST_TIMING
    if (reused) {
      Serial.printf("[gw-timing] %s %s code=%d conn=%s gate=%ums req=%ums body=%ums end=%ums total=%ums\n",
        method, path, code, retried ? "retried" : "reused", static_cast<unsigned>(gateWaitMs),
        static_cast<unsigned>(requestMs), static_cast<unsigned>(bodyMs),
        static_cast<unsigned>(millis() - endAt), static_cast<unsigned>(millis() - startedAt));
    } else {
      Serial.printf("[gw-timing] %s %s code=%d conn=%s gate=%ums dns=%ums tcp_probe=%ums connect_incl_tls=%ums req=%ums body=%ums end=%ums total=%ums\n",
        method, path, code, retried ? "retried" : "fresh", static_cast<unsigned>(gateWaitMs),
        static_cast<unsigned>(dnsMs), static_cast<unsigned>(tcpMs), static_cast<unsigned>(tlsMs),
        static_cast<unsigned>(requestMs), static_cast<unsigned>(bodyMs),
        static_cast<unsigned>(millis() - endAt), static_cast<unsigned>(millis() - startedAt));
    }
#endif
    break;
  }
  (void)startedAt;
  return code;
}

// END exchange

}  // namespace gateway_warm
