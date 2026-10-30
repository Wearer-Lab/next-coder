import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The real GatewayClient::request() and the real warm-session exchange (GatewayWarm.h), compiled
// against doubles that assert the lock discipline on every transport call and every destructor:
//   * the state lock is never held while the TLS gate is waited for, taken, or used;
//   * every socket / HTTPClient is destroyed while the gate is still held and the state is not;
//   * a warm session is reused only for the identity it was built for, is dropped on every
//     failed, rate-limited or server-error exchange, and a dead reused socket is rebuilt exactly once.
test("actual firmware request releases state across TLS waits and transport destruction on every exit", async (t) => {
  const compiler = process.env.CXX || "c++";
  if (spawnSync(compiler, ["--version"]).error?.code === "ENOENT") return t.skip("Native C++ compiler unavailable");
  const directory = await mkdtemp(join(tmpdir(), "next-coder-locks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile("firmware/shared/NextCoderCore/src/GatewayClient.cpp", "utf8");
  const request = source.slice(source.indexOf("int GatewayClient::request("), source.indexOf("\nvoid GatewayClient::observeTransportResult("));
  const warmSource = await readFile("firmware/shared/NextCoderCore/src/GatewayWarm.h", "utf8");
  const warm = warmSource.slice(warmSource.indexOf("constexpr int kRefused"), warmSource.indexOf("// END exchange"));
  assert.ok(warm.includes("inline int exchange(") && warm.includes("struct Connection"));
  await writeFile(join(directory, "check.cpp"), `
#include <cassert>
#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <deque>
#include <string>
#include <algorithm>
#include <new>
using std::max;
#define GATEWAY_WARM_CONNECTION 1
#define GATEWAY_REQUEST_TIMING 0
struct String : std::string {
 using std::string::string;
 String() = default;
 String(const std::string& v) : std::string(v) {}
 int indexOf(const char* needle) const { auto at = find(needle); return at == npos ? -1 : (int)at; }
 int indexOf(char c, int from = 0) const { auto at = find(c, from); return at == npos ? -1 : (int)at; }
 String substring(int a) const { return substr(a); }
 String substring(int a, int b) const { return substr(a, b - a); }
 bool startsWith(const char* p) const { return rfind(p, 0) == 0; }
 long toInt() const { return atol(c_str()); }
};
String operator+(const String& a, const char* b) { return String(std::string(a) + b); }
bool stateHeld = true, tlsHeld = false, allowTls = true, allowBegin = true;
int resumed = 0, beginCalls = 0, reuseCalls = 0, requests = 0, live = 0, bodyRead = 1, bodyLength = 0;
bool keepAlive = true, peerClosedIdle = false;
std::deque<int> codes;      // what the next POST/GET calls return, front first
constexpr int kTimeoutMs = 6000, kConnectTimeoutMs = 2500, kMaxResponseBodyBytes = 100;
uint32_t clockNow = 100; uint32_t millis() { return clockNow; }
struct { template<class... T> void printf(const char*, T...) {} } Serial;
namespace gateway_tls {
std::atomic<bool>& warmSessionOpen() { static std::atomic<bool> v{false}; return v; }
std::atomic<uint32_t>& warmLastUsedAt() { static std::atomic<uint32_t> v{0}; return v; }
std::atomic<void (*)()>& warmDropHook() { static std::atomic<void (*)()> v{nullptr}; return v; }
bool lockTlsKeepWarm() { assert(!stateHeld); assert(!tlsHeld); tlsHeld = allowTls; return allowTls; }
void unlockTls() { assert(!stateHeld); assert(tlsHeld); tlsHeld = false; }
}
struct WiFiClient { WiFiClient() { ++live; } virtual ~WiFiClient() { assert(!stateHeld); assert(tlsHeld); --live; } };
struct WiFiClientSecure : WiFiClient {};
namespace gateway_http {
template<class T> struct YieldingClient : T {};
struct BoundedBody { BoundedBody(String&, int) {} bool failed() { return false; } };
}
struct Header { long toInt() { return 4; } };
struct HTTPClient {
 bool open = false;
 ~HTTPClient() { assert(!stateHeld && tlsHeld); --live; }
 HTTPClient() { ++live; }
 void setReuse(bool) {} void setTimeout(int) {} void setConnectTimeout(int) {}
 void addHeader(const char*, const String&) {} void collectHeaders(const char**, int) {}
 int next() { assert(!stateHeld && tlsHeld); ++requests; int c = codes.empty() ? 200 : codes.front(); if (!codes.empty()) codes.pop_front(); open = c > 0; return c; }
 int POST(const String&) { return next(); }
 int GET() { return next(); }
 int getSize() { return bodyLength; }
 int writeToStream(gateway_http::BoundedBody*) { return bodyRead; }
 Header header(const char*) { return {}; }
 void end() { assert(!stateHeld && tlsHeld); }
 bool connected() { return open && keepAlive && !peerClosedIdle; }
};
namespace gateway_tls {
bool beginHttp(HTTPClient& h, WiFiClient&, WiFiClientSecure&, const String&, const char*) { assert(!stateHeld && tlsHeld); ++beginCalls; (void)h; return allowBegin; }
bool beginHttpReuse(HTTPClient&, WiFiClient&, WiFiClientSecure&, const String&) { assert(!stateHeld && tlsHeld); ++reuseCalls; return true; }
}
namespace gateway_warm {
${warm}
}
String gatewayUrl = "https://gateway", deviceId = "device";
struct Store { struct Snapshot { String gatewayUrl, deviceId, deviceSecret = "secret"; }; Snapshot transportSnapshot() { return {::gatewayUrl, ::deviceId, "secret"}; } };
struct GatewayClient {
 Store storage; Store* store_ = &storage; unsigned backoffUntil_ = 0; bool revoked_ = false;
 uint32_t releaseStateForBlockingCall() { assert(stateHeld); stateHeld = false; return 3; }
 void reacquireStateAfterBlockingCall(uint32_t depth) { assert(depth == 3 && !tlsHeld && !stateHeld); stateHeld = true; ++resumed; }
 void observeTransportResult(int) {}
 int request(const char*, const char*, const String&, String&, const String* = nullptr, bool = true);
};
${request}
static bool kept() { return gateway_warm::slot() != nullptr && gateway_tls::warmSessionOpen().load(); }
static void reset() {
 stateHeld = false; tlsHeld = true;
 if (gateway_warm::slot()) gateway_warm::dropLocked();
 tlsHeld = false; stateHeld = true;
 codes.clear(); allowTls = true; allowBegin = true; keepAlive = true; peerClosedIdle = false;
 bodyLength = 0; bodyRead = 1; beginCalls = reuseCalls = requests = 0;
 gatewayUrl = "https://gateway"; deviceId = "device";
}
static int callNo = 0;
static int call(GatewayClient& client, unsigned expectResumed = 1) {
 String out; const int before = resumed; ++callNo;
 const int code = client.request("GET", "/reply", "", out);
 if (!(stateHeld && !tlsHeld && resumed == before + (int)expectResumed)) { fprintf(stderr, "call %d: state=%d tls=%d resumed=%d/%d\\n", callNo, stateHeld, tlsHeld, resumed, before); abort(); }
 return code;
}
int main() {
 GatewayClient client;
 // 0. a clean exchange builds a session and KEEPS it; the second request reuses it with no new handshake.
 reset(); assert(call(client) == 200); assert(kept() && beginCalls == 1 && reuseCalls == 0 && live == 3);
 assert(call(client) == 200); assert(kept() && beginCalls == 1 && reuseCalls == 1 && live == 3);
 // 1. the TLS gate cannot be taken: nothing is built, nothing leaks, an existing session is untouched.
 allowTls = false; assert(call(client) == -1); assert(kept() && requests == 2); allowTls = true;
 // 2. the same session is NOT reused for another origin or another device identity.
 gatewayUrl = "https://other"; assert(call(client) == 200); assert(beginCalls == 2 && kept() && live == 3);
 deviceId = "other-device"; assert(call(client) == 200); assert(beginCalls == 3 && kept() && live == 3);
 // 3. a reused socket that is already dead fails before any status line: rebuilt once, then answered.
 reset(); assert(call(client) == 200); codes = {-5, 200}; int before = requests;
 assert(call(client) == 200); assert(requests == before + 2 && beginCalls == 2 && kept() && live == 3);
 // 3b. every stale-socket code qualifies; a second failure is surfaced, not retried again.
 for (int stale : {-1, -2, -3, -4, -5}) {
  reset(); assert(call(client) == 200); codes = {stale, 200}; before = requests;
  assert(call(client) == 200 && requests == before + 2);
 }
 reset(); assert(call(client) == 200); codes = {-5, -5, 200}; before = requests;
 assert(call(client) == -5); assert(requests == before + 2 && !kept() && live == 0 && codes.size() == 1);
 // 3c. a FRESH connection that fails is never retried: that is a real failure.
 reset(); codes = {-5, 200}; assert(call(client) == -5); assert(requests == 1 && !kept() && live == 0);
 // 3d. a timeout proves nothing about whether the server acted, so it is not retried either.
 reset(); assert(call(client) == 200); codes = {-11, 200}; before = requests;
 assert(call(client) == -11); assert(requests == before + 1 && !kept() && live == 0);
 // 4. nothing but a clean 2xx-4xx exchange keeps the session.
 for (int code : {500, 502, 429}) {
  reset(); codes = {code}; assert(call(client) == code); assert(!kept() && live == 0);
  if (code == 429) { assert(client.backoffUntil_ == 100 + 4000); client.backoffUntil_ = 0; } // Retry-After honoured
 }
 reset(); codes = {401}; assert(call(client) == 401); assert(kept()); // revocation is the gateway's answer, not a transport fault
 reset(); keepAlive = false; assert(call(client) == 200); assert(!kept() && live == 0); // the server declined keep-alive
 reset(); assert(call(client) == 200); peerClosedIdle = true; before = beginCalls; // closed while idle and noticed
 peerClosedIdle = true; assert(call(client) == 200); assert(beginCalls == before + 1);
 reset(); bodyLength = 101; assert(call(client) == -10); assert(!kept() && live == 0);
 reset(); bodyRead = -11; assert(call(client) == -11); assert(!kept() && live == 0);
 // 5. a refused transport (clock not trusted, URL not allowed) builds nothing and leaks nothing.
 reset(); allowBegin = false; assert(call(client) == -1); assert(!kept() && live == 0);
 // 6. the state lock was restored and the gate released on every path above (asserted in call()).
 reset();
}
`);
  const executable = join(directory, "check");
  const compiled = spawnSync(compiler, ["-std=c++17", join(directory, "check.cpp"), "-o", executable], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
});
