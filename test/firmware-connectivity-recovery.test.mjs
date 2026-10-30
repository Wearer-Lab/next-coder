import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

async function native(t, source, headers = {}) {
  const compiler = process.env.CXX || "c++";
  if (spawnSync(compiler, ["--version"]).error?.code === "ENOENT") return t.skip("Native C++ compiler unavailable");
  const dir = await mkdtemp(join(tmpdir(), "next-coder-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await Promise.all(Object.entries({ "check.cpp": source, ...headers }).map(([name, text]) => writeFile(join(dir, name), text)));
  const bin = join(dir, "check");
  const compiled = spawnSync(compiler, ["-std=c++17", "-I", dir, "-I", resolve("firmware/shared/NextCoderCore/src"), join(dir, "check.cpp"), "-o", bin], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const result = spawnSync(bin, [], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("firmware scheduler backs off transport failures and restores context promptly without replaying commands", async (t) => {
  const source = await readFile("firmware/shared/NextCoderCore/src/GatewayClient.cpp", "utf8");
  const observe = source.slice(source.indexOf("void GatewayClient::observeTransportResult("), source.indexOf("\nvoid GatewayClient::sendHeartbeat()"));
  const cycle = source.slice(source.indexOf("void GatewayClient::runCycle("), source.indexOf("\nvoid GatewayClient::markOperateDue("));
  await native(t, `
#include <cstdint>
#include <cassert>
#include <algorithm>
using std::min;
uint32_t clockNow = 100; uint32_t millis() { return clockNow; }
constexpr int WL_CONNECTED = 3; struct { int status() { return WL_CONNECTED; } } WiFi;
enum class GatewayLink { NoIdentity, Idle, Connecting, Claimed, Revoked };
constexpr uint32_t kHeartbeatIntervalMs=30000,kConfigIntervalMs=60000,kFirmwareIntervalMs=21600000,kThreadsIntervalMs=30000,kControlsIntervalMs=30000,kApprovalsIntervalMs=30000,kDisplayIntervalMs=5000;
struct Store { bool hasIdentity() { return true; } };
struct GatewayClient {
 Store data; Store* store_=&data; GatewayLink link_=GatewayLink::Idle; const char* detail_="";
 uint32_t nextHeartbeatAt_=0,nextConfigAt_=0,nextFirmwareAt_=0,nextThreadsAt_=0,nextControlsAt_=0,nextApprovalsAt_=0,nextDisplayAt_=0,backoffUntil_=0,transportRetryAt_=0;
 unsigned transportFailures_=0, requests=0; bool revoked_=false,hasThreadPicker_=false,hasDisplay_=false,responseOpen_=false;
 struct { int page=0; } response_;
 bool pending=false; int heartbeatCode=200;
 bool processPendingDeviceCredential() { if (!pending) return false; ++requests; observeTransportResult(-1); return true; }
 void sendHeartbeat() { ++requests; observeTransportResult(heartbeatCode); }
 void fetchConfig() { ++requests; link_=GatewayLink::Claimed; observeTransportResult(200); }
 void markOperateDue(uint32_t) {} void goOffline() {} void pollFirmwareManifest() { ++requests; }
 void refreshThreads() {} void fetchControls() {} void refreshApprovals() {} bool responseInFlight() { return false; } void fetchResponsePage(int) {} void fetchDisplay() {}
 void observeTransportResult(int); void runCycle(bool);
};
${observe}
${cycle}
int main() {
 GatewayClient c;
 c.runCycle(true); assert(c.requests==1); // fresh join cannot monopolize two HTTP transactions
 c.runCycle(false); assert(c.requests==2 && c.link_==GatewayLink::Claimed);
 c.observeTransportResult(-11); assert(c.transportRetryAt_==1100);
 c.runCycle(false); assert(c.requests==2);
 clockNow=1100; c.runCycle(false); assert(c.requests==3 && c.transportFailures_==0);
 for(unsigned i=0;i<12;++i) { c.observeTransportResult(503); assert(c.transportRetryAt_-clockNow<=15000); }
 c.observeTransportResult(200); assert(c.transportFailures_==0 && c.nextConfigAt_==clockNow);
 c.pending=true; c.runCycle(false); unsigned n=c.requests; c.runCycle(false); assert(c.requests==n); // failed credential replay is bounded
 clockNow=UINT32_MAX-500; c.observeTransportResult(-1); assert((int32_t)(clockNow-c.transportRetryAt_)<0);
}
`);
});

test("firmware event parser rejects truncated and multi-line oversized events and resumes at the next frame", async (t) => {
  await native(t, `
#include <cassert>
#include <string>
#include "GatewayEventFrame.h"
int main() {
 gateway_http::EventFrame frame;
 auto feed=[&](const std::string& s) { unsigned n=0; for(char c:s) if(frame.feed(c)) ++n; return n; };
 assert(feed("event: threads.changed\\ndata: {\\\"id\\\":1}\\n\\n")==1);
 assert(frame.event()=="threads.changed" && frame.data()=="{\\\"id\\\":1}"); frame.reset();
 assert(feed("data: "+std::string(900,'x')+"\\n\\n")==0);
 for(int i=0;i<10;++i) assert(feed("data: "+std::string(300,'x')+"\\n")==0);
 assert(feed("\\n")==0); assert(feed("event: device.refresh\\ndata: {}\\n\\n")==1);
 assert(frame.data()=="{}"); frame.reset();
 assert(feed(": keepalive\\n\\n")==0);
}
`, { "Arduino.h": `#pragma once
#include <string>
class String: public std::string {
public: using std::string::string; using std::string::operator=; String(const std::string& s):std::string(s){}
 bool startsWith(const char* p)const{return rfind(p,0)==0;} String substring(size_t i)const{return substr(i);}
 void trim(){size_t first=find_first_not_of(" \\t\\r\\n"); if(first==npos){clear();return;} *this=substr(first,find_last_not_of(" \\t\\r\\n")-first+1);}
};
` });
});

// Wi-Fi association, cancellation, portal recovery and multi-profile outage coverage live in
// firmware-wifi.test.mjs, which compiles the current shared provisioning state machine.

test("transport snapshots cannot mix an origin or credential being replaced on another task", async (t) => {
  const source = await readFile("firmware/shared/NextCoderCore/src/DeviceStore.cpp", "utf8");
  const header = await readFile("firmware/shared/NextCoderCore/src/DeviceStore.h", "utf8");
  const snapshot = source.slice(source.indexOf("DeviceTransportSnapshot DeviceStore::transportSnapshot()"), source.indexOf("\nString DeviceStore::readString"));
  const setIdentity = source.slice(source.indexOf("bool DeviceStore::setIdentity("), source.indexOf("\nbool DeviceStore::stagePendingDeviceSecret("));
  const guard = header.slice(header.indexOf("  class SettingsGuard {"), header.indexOf("  mutable SemaphoreHandle_t settingsMutex_"));
  const commit = header.slice(header.indexOf("  template <typename Commit>"), header.indexOf("\n  // --- Identity."));
  await native(t, `
#include <cassert>
#include <cstdint>
#include <string>
#include <mutex>
#include <thread>
#include <atomic>
using String=std::string;using SemaphoreHandle_t=std::recursive_mutex*;
constexpr unsigned portMAX_DELAY=0xffffffff;constexpr const char*kKeyDeviceId="id",*kKeyDeviceSecret="secret",*kKeyCredentialVersion="version";
struct{void println(const char*){}}Serial;
void xSemaphoreTakeRecursive(SemaphoreHandle_t m,unsigned){m->lock();}void xSemaphoreGiveRecursive(SemaphoreHandle_t m){m->unlock();}
struct DeviceTransportSnapshot{String gatewayUrl,deviceId,deviceSecret,wifiSsid,wifiPassword;uint32_t credentialVersion;};
struct DeviceStore{
 ${guard}
 std::recursive_mutex mutex;mutable SemaphoreHandle_t settingsMutex_=&mutex;
 String gatewayUrl_="https://production",deviceId_="initial",deviceSecret_="initial",wifiSsid_="wifi",wifiPassword_="private",pendingRequestId_;uint32_t credentialVersion_=1;
 struct{unsigned putUInt(const char*,unsigned){return 1;}}prefs_;
 bool putString(const char*,const String&){return true;}bool rollbackPendingDeviceSecret(){return true;}
 DeviceTransportSnapshot transportSnapshot()const;bool setIdentity(const String&,const String&);
 ${commit}
};
${snapshot}
${setIdentity}
int main(){
 DeviceStore store;std::atomic<bool> done{false};
 std::thread writer([&]{for(int i=0;i<40000;++i){String value=std::to_string(i);assert(store.setIdentity(value,value));}done=true;});
 unsigned reads=0;do{auto snapshot=store.transportSnapshot();assert(snapshot.deviceId==snapshot.deviceSecret);assert(snapshot.gatewayUrl=="https://production");++reads;}while(!done || reads<10000);
 writer.join();assert(reads>=10000);
 const auto expected=store.transportSnapshot();std::atomic<bool> start{false},attempted{false},finished{false};
 std::thread changer([&]{while(!start)std::this_thread::yield();attempted=true;store.setIdentity("new-realm","new-realm");finished=true;});
 assert(store.commitWithTransport(expected,[&]{start=true;while(!attempted)std::this_thread::yield();for(int i=0;i<1000;++i)std::this_thread::yield();assert(!finished);assert(store.transportSnapshot().deviceId==expected.deviceId);return true;}));
 changer.join();assert(finished);bool called=false;assert(!store.commitWithTransport(expected,[&]{called=true;return true;}));assert(!called);
}
`);
});

test("cached claim expiry waits for trusted UTC time and preserves the fractional expiry second", async (t) => {
  await native(t, `
#include <cassert>
#include "GatewayClaimCode.h"
int main(){
 using gateway_claim::expired;
 const String expiry="2026-10-22T20:00:00.999Z";
 assert(!expired(expiry,0)); // an uninitialized clock cannot rotate an owner's code
 assert(!expired(expiry,1792699199));
 assert(!expired(expiry,1792699200));
 assert(expired(expiry,1792699201));
 assert(!expired("not-an-expiry",1792699201));
 assert(!expired("2026-10-22T20:00:00+05:00",1792699201)); // only the actual UTC contract is accepted
}
`, { "Arduino.h": "#pragma once\n#include <string>\nusing String=std::string;\n" });
});

test("pending request compare-and-swap cannot replace a changed receipt or clear a newer command", async (t) => {
  const source = await readFile("firmware/shared/NextCoderCore/src/DeviceStore.cpp", "utf8");
  const header = await readFile("firmware/shared/NextCoderCore/src/DeviceStore.h", "utf8");
  const methods = source.slice(source.indexOf("bool DeviceStore::setPendingRequest("), source.indexOf("\nbool DeviceStore::setIdentity("));
  const guard = header.slice(header.indexOf("  class SettingsGuard {"), header.indexOf("  mutable SemaphoreHandle_t settingsMutex_"));
  await native(t, `
#include <cassert>
#include <cstdint>
#include <string>
#include <mutex>
using String=std::string;using SemaphoreHandle_t=std::recursive_mutex*;
constexpr unsigned portMAX_DELAY=0xffffffff;constexpr const char*kKeyPendingRequestHash="hash",*kKeyPendingRequestId="id";
void xSemaphoreTakeRecursive(SemaphoreHandle_t m,unsigned){m->lock();}void xSemaphoreGiveRecursive(SemaphoreHandle_t m){m->unlock();}
struct DeviceRequestSnapshot{String id,hash,gatewayUrl,deviceId;};struct DeviceTransportSnapshot{String gatewayUrl,deviceId;};
struct DeviceStore{
 ${guard}
 std::recursive_mutex mutex;mutable SemaphoreHandle_t settingsMutex_=&mutex;
 String pendingRequestId_,pendingRequestHash_,gatewayUrl_="https://production",deviceId_="controller";
 bool putString(const char*,const String&){return true;}
 bool setPendingRequest(const String&,const String&);bool clearPendingRequest();DeviceRequestSnapshot pendingRequestSnapshot()const;
 bool replacePendingRequest(const DeviceRequestSnapshot&,const String&,const String&);bool clearPendingRequestIfCurrent(const String&);
};
${methods}
int main(){
 DeviceStore store;auto empty=store.pendingRequestSnapshot();assert(store.replacePendingRequest(empty,"A","hash-a"));
 auto original=store.pendingRequestSnapshot();assert(!store.replacePendingRequest(empty,"B","hash-b"));
 assert(store.replacePendingRequest(original,"B","hash-b"));assert(!store.clearPendingRequestIfCurrent("A"));assert(store.pendingRequestSnapshot().id=="B");
 auto beforeReset=store.pendingRequestSnapshot();store.clearPendingRequest();assert(!store.replacePendingRequest(beforeReset,"C","hash-c"));
 auto beforeRealm=store.pendingRequestSnapshot();store.gatewayUrl_="https://another-gateway";assert(!store.replacePendingRequest(beforeRealm,"C","hash-c"));
 auto current=store.pendingRequestSnapshot();assert(store.replacePendingRequest(current,"C","hash-c"));assert(store.clearPendingRequestIfCurrent("C"));
}
`);
});

test("uncertain request blocks ordinary realm changes until explicit reset clears its journal first", async (t) => {
  const source = await readFile("firmware/shared/NextCoderCore/src/DeviceStore.cpp", "utf8");
  const identity = source.slice(source.indexOf("bool DeviceStore::setIdentity("), source.indexOf("\nbool DeviceStore::stagePendingDeviceSecret("));
  const gateway = source.slice(source.indexOf("bool DeviceStore::setGatewayUrl("), source.indexOf("\nconst GatewayProfile* DeviceStore::gatewayProfile("));
  const reset = source.slice(source.indexOf("bool DeviceStore::resetForProvisioning("), source.indexOf("\nbool DeviceStore::wipeToFactoryState("));
  const stage = source.slice(source.indexOf("bool DeviceStore::stageGatewaySwitch("), source.indexOf("\nbool DeviceStore::completeGatewaySwitch("));
  const complete = source.slice(source.indexOf("bool DeviceStore::completeGatewaySwitch("), source.indexOf("\nbool DeviceStore::failGatewaySwitch("));
  await native(t, `
#include <cassert>
#include <cstdint>
#include <string>
#include <vector>
class String:public std::string{public:using std::string::string;using std::string::operator=;String(const std::string&s):std::string(s){}void trim(){}bool endsWith(const char*s)const{return size()>=std::char_traits<char>::length(s)&&compare(size()-std::char_traits<char>::length(s),std::char_traits<char>::length(s),s)==0;}void remove(size_t i){erase(i);}};
constexpr const char*kKeyGatewayUrl="gateway",*kKeyDeviceId="id",*kKeyDeviceSecret="secret",*kKeyCredentialVersion="version",*kKeyGatewayPrevious="previous",*kKeyGatewayPending="pending",*kKeyGatewayPendingUrl="pending-url",*kKeyGatewayState="state",*kKeyGatewayError="error",*kKeyGatewayRevision="revision",*kKeyGatewayActive="active";
struct GatewayProfile{String id,url;};
struct{void println(const char*){}}Serial;namespace gateway_tls{bool gatewayUrlAllowed(const String&){return true;}}
struct DeviceStore{
 struct SettingsGuard{SettingsGuard(DeviceStore&){}};
 String pendingRequestId_="uncertain",deviceId_="controller",deviceSecret_="old",gatewayUrl_="https://production";uint32_t credentialVersion_=1;
 std::vector<std::string> writes;bool clearAllowed=true,opened_=true;
 String previousGatewayUrl_,pendingGatewayProfileId_,pendingGatewayUrl_,gatewaySwitchState_,gatewaySwitchDetail_,activeGatewayProfileId_;uint32_t gatewayRevision_=0;
 struct{unsigned putUInt(const char*,unsigned){return 1;}}prefs_;
 bool putString(const char*key,const String&){writes.push_back(key);return true;}bool rollbackPendingDeviceSecret(){return true;}
 bool clearPendingRequest(){writes.push_back("journal");if(!clearAllowed)return false;pendingRequestId_="";return true;}
 bool setWifiCredentials(const String&,const String&){writes.push_back("wifi");return true;}bool setConfigCache(const String&){writes.push_back("config");return true;}bool clearClaimCode(){writes.push_back("claim");return true;}
 bool setIdentity(const String&,const String&);bool setGatewayUrl(const String&);bool resetForProvisioning();bool stageGatewaySwitch(const GatewayProfile&,uint32_t);bool completeGatewaySwitch(const GatewayProfile&,uint32_t);
};
${identity}
${gateway}
${reset}
${stage}
${complete}
int main(){
 DeviceStore store;GatewayProfile other{"other","https://other"};assert(!store.stageGatewaySwitch(other,2));assert(!store.completeGatewaySwitch(other,2));assert(store.writes.empty());assert(store.activeGatewayProfileId_.empty());assert(!store.setGatewayUrl("https://other"));assert(!store.setIdentity("another-controller","new"));assert(store.writes.empty());assert(store.pendingRequestId_=="uncertain");
 assert(store.setGatewayUrl("https://production/"));assert(store.writes.empty());assert(store.setIdentity("controller","rotated"));assert(store.pendingRequestId_=="uncertain");
 store.writes.clear();store.clearAllowed=false;assert(!store.resetForProvisioning());assert(store.writes.size()==1&&store.writes[0]=="journal"&&store.pendingRequestId_=="uncertain");
 store.writes.clear();store.clearAllowed=true;assert(store.resetForProvisioning());assert(store.writes[0]=="journal"&&store.pendingRequestId_.empty());assert(store.setGatewayUrl("https://other"));
}
`);
});

test("actual NVS string deletion preserves a failed receipt clear and blocks a realm change", async (t) => {
  const source = await readFile("firmware/shared/NextCoderCore/src/DeviceStore.cpp", "utf8");
  const put = source.slice(source.indexOf("bool DeviceStore::putString("), source.indexOf("\nbool DeviceStore::setPendingRequest("));
  const clear = source.slice(source.indexOf("bool DeviceStore::clearPendingRequest("), source.indexOf("\nDeviceRequestSnapshot DeviceStore::pendingRequestSnapshot("));
  const gateway = source.slice(source.indexOf("bool DeviceStore::setGatewayUrl("), source.indexOf("\nconst GatewayProfile* DeviceStore::gatewayProfile("));
  await native(t, `
#include <cassert>
#include <string>
#include <unordered_map>
class String:public std::string{public:using std::string::string;using std::string::operator=;String(const std::string&s):std::string(s){}void trim(){}bool endsWith(const char*s)const{return size()>=std::char_traits<char>::length(s)&&compare(size()-std::char_traits<char>::length(s),std::char_traits<char>::length(s),s)==0;}void remove(size_t i){erase(i);}};
constexpr const char*kKeyPendingRequestId="request-id",*kKeyPendingRequestHash="request-hash",*kKeyGatewayUrl="gateway";
struct{void println(const char*){}}Serial;namespace gateway_tls{bool gatewayUrlAllowed(const String&){return true;}}
struct DeviceStore{
 struct SettingsGuard{SettingsGuard(DeviceStore&){}};
 struct Preferences{
  bool removeAllowed=true;unsigned removes=0;std::unordered_map<std::string,std::string> data;
  bool isKey(const char*key){return data.count(key)>0;}
  bool remove(const char*key){++removes;if(!removeAllowed)return false;return data.erase(key)>0;}
  size_t putString(const char*key,const String&value){data[key]=value;return value.length();}
 }prefs_;
 bool opened_=true;String pendingRequestId_="A",pendingRequestHash_="hash-a",gatewayUrl_="https://production";
 bool putString(const char*,const String&);bool clearPendingRequest();bool setGatewayUrl(const String&);
};
${put}
${clear}
${gateway}
int main(){
 DeviceStore store;
 assert(store.putString("absent",""));assert(store.prefs_.removes==0);
 store.prefs_.data["present"]="value";assert(store.putString("present",""));assert(!store.prefs_.isKey("present"));
 store.prefs_.data[kKeyPendingRequestId]="A";store.prefs_.data[kKeyPendingRequestHash]="hash-a";store.prefs_.removeAllowed=false;
 assert(!store.putString(kKeyPendingRequestId,""));assert(store.prefs_.isKey(kKeyPendingRequestId));
 assert(!store.clearPendingRequest());assert(store.pendingRequestId_=="A"&&store.pendingRequestHash_=="hash-a");assert(!store.setGatewayUrl("https://other"));
 assert(store.gatewayUrl_=="https://production"&&store.prefs_.data[kKeyPendingRequestId]=="A");
 store.prefs_.removeAllowed=true;assert(store.clearPendingRequest());assert(store.pendingRequestId_.empty()&&!store.prefs_.isKey(kKeyPendingRequestId));assert(store.setGatewayUrl("https://other"));
}
`);
});
