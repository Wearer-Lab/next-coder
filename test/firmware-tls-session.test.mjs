import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

async function native(t, code) {
  const compiler = process.env.CXX || "c++";
  if (spawnSync(compiler, ["--version"]).error?.code === "ENOENT") return t.skip("Native C++ compiler unavailable");
  const directory = await mkdtemp(join(tmpdir(), "next-coder-tls-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "check.cpp"), code);
  const executable = join(directory, "check");
  const compiled = spawnSync(compiler, ["-std=c++17", "-pthread", join(directory, "check.cpp"), "-o", executable], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
}

test("actual TLS session coordinator gives foreground priority, waits for event destruction and quiets reconnect bursts", async (t) => {
  const source = await readFile("firmware/shared/NextCoderCore/src/GatewayTls.h", "utf8");
  const implementation = source.slice(source.indexOf("inline SemaphoreHandle_t& tlsLock()"), source.indexOf("inline bool isPrivateIpv4Host"));
  await native(t, `
#include <cassert>
#include <atomic>
#include <mutex>
#include <thread>
#include <chrono>
#include <cstdint>
using SemaphoreHandle_t=std::recursive_timed_mutex*;
SemaphoreHandle_t xSemaphoreCreateRecursiveMutex(){return new std::recursive_timed_mutex;}
constexpr int pdTRUE=1;unsigned pdMS_TO_TICKS(unsigned value){return value;}
int xSemaphoreTakeRecursive(SemaphoreHandle_t handle,unsigned ms){return handle->try_lock_for(std::chrono::milliseconds(ms));}
void xSemaphoreGiveRecursive(SemaphoreHandle_t handle){handle->unlock();}
std::atomic<uint32_t> now{100};uint32_t millis(){return now.load();}
namespace gateway_tls {${implementation}}
int main(){
 using namespace gateway_tls;
 tlsLock(); // production initializes once before starting the network tasks
 std::atomic<bool> acquired{false};std::atomic<int> eventBuffers{1};
 auto event=new EventSessionLock;assert(event->held());
 std::thread foreground([&]{assert(lockTls(1000));assert(eventBuffers==0);acquired=true;unlockTls();});
 for(unsigned i=0;i<1000&&!eventSessionShouldYield();++i)std::this_thread::sleep_for(std::chrono::milliseconds(1));
 assert(eventSessionShouldYield()&&!acquired);
 eventBuffers=0;delete event;foreground.join();assert(acquired);
 {EventSessionLock blocked;assert(!blocked.held());}
 now+=kEventQuietMs+1;
 {EventSessionLock resumed;assert(resumed.held());}
 assert(lockTls(10));assert(lockTls(10)); // recursive ordinary requests remain supported
 unlockTls();unlockTls();
 {EventSessionLock quiet;assert(!quiet.held());}
 now+=kEventQuietMs+1;
 {
   EventSessionLock held;assert(held.held());
   bool timedOut=false;
   std::thread waiter([&]{timedOut=!lockTls(10);});waiter.join();
   assert(timedOut&&foregroundWaiters()==0&&eventSessionShouldYield());
 }
 now=UINT32_MAX-100;deferEventSession();assert(eventSessionShouldYield());
 now=1900;assert(!eventSessionShouldYield()); // quiet deadline crosses millis wrap safely
}
`);
});

test("actual SSE socket exits destroy transport before releasing lease and reconcile only after close", async (t) => {
  const source = await readFile("firmware/shared/NextCoderCore/src/GatewayClient.cpp", "utf8");
  const start = source.indexOf("    enum class StreamExit");
  const end = source.indexOf("    vTaskDelay(pdMS_TO_TICKS(exit", start);
  const iteration = source.slice(start, end);
  await native(t, `
#include <cassert>
#include <string>
#include <cstdint>
using String=std::string;
constexpr int WL_CONNECTED=3,kConnectTimeoutMs=2500,kTimeoutMs=6000;
unsigned millis(){return 100;}unsigned pdMS_TO_TICKS(unsigned value){return value;}void vTaskDelay(unsigned){}
bool tlsHeld=false,allowLease=true,allowBegin=true,shouldYield=false,allowState=true;
int code=200,clients=0,snapshots=0,applied=0,yieldChecks=0;
struct {int status(){return WL_CONNECTED;}} WiFi;
struct {template<class...T>void printf(const char*,T...){}} Serial;
struct WiFiClient {
 bool fed=false;
 WiFiClient(){++clients;}~WiFiClient(){assert(tlsHeld);--clients;}
 bool connected(){return !fed;}int available(){return fed?0:1;}int read(){fed=true;return 'x';}
};
struct WiFiClientSecure:WiFiClient {};
struct HTTPClient {
 WiFiClient* stream=nullptr;
 ~HTTPClient(){assert(tlsHeld&&clients==2);}
 void useHTTP10(bool){}void setConnectTimeout(int){}void setTimeout(int){}
 void addHeader(const char*,const String&){}
 int GET(){assert(tlsHeld);return code;}
 WiFiClient* getStreamPtr(){return stream;}
};
namespace gateway_tls {
 struct EventSessionLock {
  bool acquired;
  EventSessionLock():acquired(allowLease){assert(!tlsHeld);tlsHeld=acquired;}
  ~EventSessionLock(){if(acquired){assert(clients==0&&tlsHeld);tlsHeld=false;}}
  bool held(){return acquired;}
 };
 bool eventSessionShouldYield(){return shouldYield&&++yieldChecks>1;}
 void deferEventSession(){assert(!tlsHeld);}
 template<class A,class B>bool beginHttp(HTTPClient&http,A&plain,B&,const String&,const char*){http.stream=&plain;return allowBegin;}
}
namespace gateway_http {
 template<class T>struct YieldingClient:T {};
 struct EventFrame{bool feed(char){return true;}String event(){return "refresh";}String data(){return "{}";}void reset(){}};
}
struct Store {struct Settings{String gatewayUrl="gateway",deviceSecret="secret";};Settings transportSnapshot(){return {};}} store;
namespace GatewayLink {constexpr int Claimed=1;}
struct Subject {
 Store* store_=&store;bool networkPaused_=false;unsigned nextConfigAt_=0;int link_=1;
 bool tryLockState(unsigned ms=0){assert(ms==0);return allowState;}
 void lockState(){assert(!tlsHeld);}void unlockState(){}
 void markOperateDue(unsigned){assert(!tlsHeld);++snapshots;}
 void applyThreadChangedEvent(const String&){++applied;}void applyRefreshEvent(const String&,const String&){++applied;}
 int iterate(){String base="gateway",deviceId="device",deviceSecret="secret";
 ${iteration}
 return static_cast<int>(exit);
 }
};
int main(){
 Subject subject;
 for(int scenario=0;scenario<7;++scenario){
  allowLease=scenario!=2;allowBegin=scenario!=3;shouldYield=scenario==1;
  allowState=scenario!=6;code=scenario==4?503:scenario==5?429:200;
  snapshots=0;applied=0;yieldChecks=0;
  subject.iterate();assert(!tlsHeld&&clients==0);
  if(scenario==0){assert(snapshots==1&&applied==1);}
  if(scenario==1){assert(snapshots==1&&applied==0);}
  if(scenario==6){assert(snapshots==1&&applied==0);}
  if(scenario>=2&&scenario<=5)assert(snapshots==0&&applied==0);
 }
}
`);
});

test("actual offline transition never waits on state or writes across a busy model owner", async (t) => {
  const source = await readFile("firmware/shared/NextCoderCore/src/GatewayClient.cpp", "utf8");
  const method = source.slice(source.indexOf("void GatewayClient::goOffline()"), source.indexOf("\nvoid GatewayClient::lockState()"));
  await native(t, `
#include <cassert>
enum class GatewayLink{NoIdentity,Idle,Claimed};
struct GatewayClient{
 GatewayLink link_=GatewayLink::Claimed;bool available=false;int unlocks=0;
 bool tryLockState(unsigned wait){assert(wait==0);return available;}
 void unlockState(){++unlocks;}
 void goOffline();
};
${method}
int main(){GatewayClient c;c.goOffline();assert(c.link_==GatewayLink::Claimed&&c.unlocks==0);
 c.available=true;c.goOffline();assert(c.link_==GatewayLink::Idle&&c.unlocks==1);
 c.link_=GatewayLink::NoIdentity;c.goOffline();assert(c.link_==GatewayLink::NoIdentity&&c.unlocks==2);}
`);
});
