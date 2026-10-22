import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("actual firmware request releases state across TLS waits and transport destruction on every exit", async (t) => {
  const compiler = process.env.CXX || "c++";
  if (spawnSync(compiler, ["--version"]).error?.code === "ENOENT") return t.skip("Native C++ compiler unavailable");
  const directory = await mkdtemp(join(tmpdir(), "next-coder-locks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile("firmware/shared/NextCoderCore/src/GatewayClient.cpp", "utf8");
  const request = source.slice(source.indexOf("int GatewayClient::request("), source.indexOf("\nvoid GatewayClient::sendHeartbeat()"));
  await writeFile(join(directory, "check.cpp"), `
#include <cassert>
#include <cstdint>
#include <string>
#include <algorithm>
using std::max;
using String = std::string;
bool stateHeld = true, tlsHeld = false, allowTls = true, allowBegin = true;
int resultCode = 200, bodyLength = 0, bodyRead = 1;
unsigned resumed = 0;
constexpr int kTimeoutMs = 6000, kConnectTimeoutMs = 2500, kMaxResponseBodyBytes = 100;
constexpr int HTTPC_ERROR_STREAM_WRITE = -10;
unsigned millis() { return 100; }
struct { template<class... T> void printf(const char*, T...) {} } Serial;
namespace gateway_tls {
bool lockTls() { assert(!stateHeld); assert(!tlsHeld); tlsHeld = allowTls; return allowTls; }
void unlockTls() { assert(!stateHeld); assert(tlsHeld); tlsHeld = false; }
template<class... T> bool beginHttp(T&...) { assert(!stateHeld && tlsHeld); return allowBegin; }
}
struct WiFiClient { ~WiFiClient() { assert(!stateHeld); } };
struct WiFiClientSecure { ~WiFiClientSecure() { assert(!stateHeld); } };
namespace gateway_http {
template<class T> struct YieldingClient : T {};
struct BoundedBody { BoundedBody(String&, int) {} bool failed() { return false; } };
}
struct Header { long toInt() { return 4; } };
struct HTTPClient {
 ~HTTPClient() { assert(!stateHeld && tlsHeld); }
 void setTimeout(int) {} void setConnectTimeout(int) {}
 void addHeader(const char*, const String&) {} void collectHeaders(const char**, int) {}
 int POST(const String&) { assert(!stateHeld && tlsHeld); return resultCode; }
 int GET() { assert(!stateHeld && tlsHeld); return resultCode; }
 int getSize() { return bodyLength; }
 int writeToStream(gateway_http::BoundedBody*) { return bodyRead; }
 Header header(const char*) { return {}; }
 void end() { assert(!stateHeld && tlsHeld); }
};
struct Store { String gatewayUrl() { return "https://gateway"; } String deviceId() { return "device"; } String deviceSecret() { return "secret"; } };
struct GatewayClient {
 Store storage; Store* store_ = &storage; unsigned backoffUntil_ = 0; bool revoked_ = false;
 uint32_t releaseStateForBlockingCall() { assert(stateHeld); stateHeld = false; return 3; }
 void reacquireStateAfterBlockingCall(uint32_t depth) { assert(depth == 3 && !tlsHeld && !stateHeld); stateHeld = true; ++resumed; }
 int request(const char*, const char*, const String&, String&, const String* = nullptr, bool = true);
};
${request}
int main() {
 GatewayClient client; String output;
 for (int scenario = 0; scenario < 7; ++scenario) {
  stateHeld = true; tlsHeld = false; client.backoffUntil_ = 0;
  allowTls = scenario != 1; allowBegin = scenario != 2;
  resultCode = scenario == 3 ? -1 : scenario == 6 ? 429 : 200;
  bodyLength = scenario == 4 ? 101 : 0; bodyRead = scenario == 5 ? -11 : 1;
  const unsigned before = resumed;
  const int code = client.request("GET", "/reply", "", output);
  assert(stateHeld && !tlsHeld && resumed == before + 1);
  if (scenario == 0) assert(code == 200);
  if (scenario == 1 || scenario == 2 || scenario == 3) assert(code == -1);
  if (scenario == 4) assert(code == -10);
  if (scenario == 5) assert(code == -11);
  if (scenario == 6) assert(code == 429 && client.backoffUntil_ == 4100);
 }
}
`);
  const executable = join(directory, "check");
  const compiled = spawnSync(compiler, ["-std=c++17", join(directory, "check.cpp"), "-o", executable], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
});
