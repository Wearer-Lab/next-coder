import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('actual firmware gesture queue bounds work, publishes once, and completes on the UI task', async (t) => {
  const compiler = process.env.CXX || 'c++';
  if (spawnSync(compiler, ['--version']).error?.code === 'ENOENT') return t.skip('Native C++ compiler unavailable');
  const directory = await mkdtemp(join(tmpdir(), 'next-coder-ui-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile('firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp', 'utf8');
  const queue = source.slice(source.indexOf('bool uiNetworkReady'), source.indexOf('\nvoid queueResponsePage'));
  const dispatch = source.slice(source.indexOf('void afterDispatch('), source.indexOf('\nvoid dispatchControl('));
  await writeFile(join(directory, 'check.cpp'), `
#include <cassert>
#include <atomic>
#include <functional>
#include <string>
using String = std::string;
using TaskHandle_t = void*;
constexpr int pdTRUE = 1, portMAX_DELAY = -1;
int notifications = 0;
void ulTaskNotifyTake(int,int) {}
void xTaskNotifyGive(TaskHandle_t) { ++notifications; }
struct Display { String line1, line2; };
struct DispatchResult { bool accepted=false, hasScreen=false, requiresApproval=false; String detail, status, responseAfter; Display screen; };
struct GatewayBrowse {};
bool chromeDirty=false, contentDirty=false;
String message;
${queue}
enum class Screen { Approvals, Response };
int approvalIndex=5, replyOpens=0, navigation=0;
void goTo(Screen screen) { navigation = screen == Screen::Approvals ? 1 : 2; }
void showBusy(const String&,const String&) {}
void queueResponsePage(int,bool,const String&) { ++replyOpens; }
${dispatch}
int main() {
 uiNetworkReady = true;
 int work=0, complete=0;
 assert(enqueueUiNetworkJob([&] { ++work; }, [&] { ++complete; }));
 assert(uiNetworkBusy() && work == 0 && complete == 0);
 assert(!enqueueUiNetworkJob([&] { work += 100; }, []{}));
 completeUiNetworkJob(); assert(work == 0 && complete == 0);
 uiNetworkLoop();
 assert(work == 1 && complete == 0 && uiNetworkBusy());
 completeUiNetworkJob(); completeUiNetworkJob();
 assert(complete == 1 && !uiNetworkBusy() && chromeDirty && contentDirty);
 assert(enqueueUiNetworkJob([]{}, [&] {
   ++complete;
   assert(enqueueUiNetworkJob([&] { ++work; }, [&] { ++complete; }));
 }));
 uiNetworkLoop(); completeUiNetworkJob();
 assert(uiNetworkBusy() && complete == 2);
 uiNetworkLoop(); completeUiNetworkJob();
 assert(!uiNetworkBusy() && complete == 3 && work == 2);
 DispatchResult result; result.accepted=true; result.requiresApproval=true; result.status="approval_required";
 afterDispatch(result,true); assert(navigation == 1 && replyOpens == 0 && approvalIndex == 0);
 result.requiresApproval=false; result.status="failed";
 afterDispatch(result,true); assert(replyOpens == 0);
 result.status="blocked"; afterDispatch(result,true); assert(replyOpens == 0);
 result.status="dispatched"; afterDispatch(result,true); assert(replyOpens == 1 && navigation == 2);
 result.hasScreen=true; afterDispatch(result,true); assert(replyOpens == 1);
}
`);
  const executable = join(directory, 'check');
  const compiled = spawnSync(compiler, ['-std=c++17', join(directory, 'check.cpp'), '-o', executable], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});

test('actual response fetch discards results across thread changes and same-thread reopen', async (t) => {
  const compiler = process.env.CXX || 'c++';
  if (spawnSync(compiler, ['--version']).error?.code === 'ENOENT') return t.skip('Native C++ compiler unavailable');
  const directory = await mkdtemp(join(tmpdir(), 'next-coder-response-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile('firmware/shared/NextCoderCore/src/GatewayOperate.cpp', 'utf8');
  const start = source.indexOf('bool GatewayClient::fetchResponsePage(');
  const end = source.indexOf('  if (!ok(code)) {', start);
  // URL composition is Arduino-specific; compile the actual operation and post-socket guards.
  const operation = source.slice(start, end)
    .replace(/String path = String\("\/v1\/device\/thread-output\?page="\) \+ \(page < 0 \? 0 : page\);/u, 'String path = "/response";');
  await writeFile(join(directory, 'check.cpp'), `
#include <cassert>
#include <cstdint>
#include <string>
using String = std::string;
String encodePathSegment(const String& input) { return input; }
constexpr int kMaxResponseStreamReads = 4;
void formatResponseStreamOffset(char*, unsigned, uint32_t) {}
int scenario=0;
struct GatewayClient {
 struct Context { String environmentId="env", threadId="thread"; } context_;
 bool responseOpen_=true;
 uint32_t responseGeneration_=1;
 struct { String state="empty"; bool retryPending=false; int retryPage=-1,page=0; } response_;
 String responseAfter_="after";
 struct { String messageId; uint32_t consumed=0; char fingerprint[2]=""; bool hasCursor() const { return false; } bool sendsFingerprint() const { return false; } } responseStream_;
 int request(const char*,const char*,const String&,String&) {
   if(scenario==1) context_.threadId="other";
   if(scenario==2) context_.environmentId="other";
   if(scenario==3) responseAfter_="newer";
   if(scenario==4) responseOpen_=false;
   if(scenario==5) ++responseGeneration_; // same thread/cursor, a new open operation
   return 200;
 }
 bool fetchResponsePage(int);
};
struct StateLock { explicit StateLock(GatewayClient*) {} };
${operation}
return true;
}
}
int main() {
 for(scenario=0;scenario<6;++scenario) {
  GatewayClient gateway;
  assert(gateway.fetchResponsePage(0) == (scenario==0));
 }
}
`);
  const executable = join(directory, 'check');
  const compiled = spawnSync(compiler, ['-std=c++17', join(directory, 'check.cpp'), '-o', executable], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});

test('actual durable gesture IDs survive a lost response and refuse unsaved receipts', async (t) => {
  const compiler = process.env.CXX || 'c++';
  if (spawnSync(compiler, ['--version']).error?.code === 'ENOENT') return t.skip('Native C++ compiler unavailable');
  const directory = await mkdtemp(join(tmpdir(), 'next-coder-device-receipt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile('firmware/shared/NextCoderCore/src/GatewayDeviceRequest.h', 'utf8');
  const operation = source.slice(source.indexOf('inline String requestFingerprint'), source.indexOf('template <typename Lookup>'));
  await writeFile(join(directory, 'check.cpp'), `
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <string>
using String=std::string;
uint32_t randomValue=0;
uint32_t esp_random() { return ++randomValue; }
struct DeviceStore {
 String id, hash; bool canSave=true;
 struct Snapshot { String id, hash; };
 Snapshot pendingRequestSnapshot() { return {id,hash}; }
 bool replacePendingRequest(const Snapshot& expected,const String& nextId,const String& nextHash) {
  if(!canSave || id!=expected.id || hash!=expected.hash) return false;
  id=nextId; hash=nextHash; return true;
 }
};
${operation}
int main() {
 DeviceStore store;
 String failure;
 bool terminal=false;
 int lookups=0;
 auto resolve=[&](const String&) { ++lookups; return terminal; };
 const String first=beginDurableDeviceRequest(&store,"thread-create\\nenv\\nproject\\n",resolve,failure);
 assert(!first.empty());
 const unsigned randomCalls=randomValue;
 assert(beginDurableDeviceRequest(&store,"thread-create\\nenv\\nproject\\n",resolve,failure)==first);
 assert(randomValue==randomCalls);
 DeviceStore rebooted=store;
 assert(beginDurableDeviceRequest(&rebooted,"thread-create\\nenv\\nproject\\n",resolve,failure)==first);
 assert(lookups==0);
 assert(beginDurableDeviceRequest(&store,"thread-create\\nenv\\nother-project\\n",resolve,failure).empty());
 assert(store.id==first && !failure.empty() && lookups==1);
 assert(beginDurableDeviceRequest(&store,"thread-create\\nenv\\nproject\\n",resolve,failure)==first);
 assert(lookups==1); // retry A still reuses its original id after blocked B
 terminal=true;
 assert(beginDurableDeviceRequest(&store,"thread-create\\nenv\\nother-project\\n",resolve,failure)!=first);
 store.canSave=false;
 assert(beginDurableDeviceRequest(&store,"action\\nnew",resolve,failure).empty());
 store.canSave=true;
 auto resetDuringLookup=[&](const String&) { store.id="portal-reset"; store.hash=""; return true; };
 assert(beginDurableDeviceRequest(&store,"action\\nnew",resetDuringLookup,failure).empty());
 assert(store.id=="portal-reset");
}
`);
  const executable = join(directory, 'check');
  const compiled = spawnSync(compiler, ['-std=c++17', join(directory, 'check.cpp'), '-o', executable], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});

test('actual response failure keeps transient reads retryable without replaying a command', async (t) => {
  const compiler = process.env.CXX || 'c++';
  if (spawnSync(compiler, ['--version']).error?.code === 'ENOENT') return t.skip('Native C++ compiler unavailable');
  const directory = await mkdtemp(join(tmpdir(), 'next-coder-response-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile('firmware/shared/NextCoderCore/src/GatewayOperate.cpp', 'utf8');
  const start = source.indexOf('bool GatewayClient::fetchResponsePage(');
  const end = source.indexOf('  JsonDocument doc;', start);
  const operation = source.slice(start, end)
    .replace(/String path = String\("\/v1\/device\/thread-output\?page="\) \+ \(page < 0 \? 0 : page\);/u, 'String path = "/response";');
  const inFlight = source.slice(source.indexOf('bool GatewayClient::responseInFlight('), source.indexOf('\nvoid GatewayClient::openResponse('));
  await writeFile(join(directory, 'check.cpp'), `
#include <cassert>
#include <cstdint>
#include <string>
using String = std::string;
String encodePathSegment(const String& input) { return input; }
String remedyFor(int) { return "retry"; }
constexpr int kMaxResponseStreamReads = 4;
void formatResponseStreamOffset(char*, unsigned, uint32_t) {}
unsigned millis() { return 100; }
int responseCode=200, requests=0;
bool ok(int code) { return code>=200 && code<300; }
struct GatewayClient {
 struct Context { String environmentId="env", threadId="thread"; } context_;
 struct Response { String state="waiting", lines[3], errorDetail; bool retryPending=false; int retryPage=-1,page=0,pageCount=1,lineCount=0,followUpCount=0; } response_;
 bool responseOpen_=true;
 uint32_t responseGeneration_=1, nextDisplayAt_=0;
 String responseAfter_="after";
 struct { String messageId; uint32_t consumed=0; char fingerprint[2]=""; bool hasCursor() const { return false; } bool sendsFingerprint() const { return false; } } responseStream_;
 int request(const char* method,const char*,const String&,String&) { assert(String(method)=="GET"); ++requests; return responseCode; }
 void touch() {}
 bool fetchResponsePage(int);
 bool responseInFlight() const;
};
struct StateLock { explicit StateLock(GatewayClient*) {} };
${operation}
return true;
}
}
${inFlight}
int main() {
 for(int code : {-1,-11,429,500,503,401,403,404,409}) {
  GatewayClient gateway;
  responseCode=code;
  assert(!gateway.fetchResponsePage(2));
  const bool retryable = code<=0 || code==429 || code>=500;
  assert(gateway.response_.state=="error" && gateway.response_.page==0 && gateway.response_.retryPage==2);
  assert(gateway.response_.retryPending==retryable);
  assert(gateway.responseInFlight()==retryable);
  if(retryable) assert(gateway.nextDisplayAt_==3100);
 }
 assert(requests==9);
}
`);
  const executable = join(directory, 'check');
  const compiled = spawnSync(compiler, ['-std=c++17', join(directory, 'check.cpp'), '-o', executable], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});

test('actual durable receipt settlement distinguishes a proven result from uncertain gateway failure', async (t) => {
  const compiler = process.env.CXX || 'c++';
  if (spawnSync(compiler, ['--version']).error?.code === 'ENOENT') return t.skip('Native C++ compiler unavailable');
  const directory = await mkdtemp(join(tmpdir(), 'next-coder-receipt-settle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile('firmware/shared/NextCoderCore/src/GatewayDeviceRequest.h', 'utf8');
  const operation = source.slice(source.indexOf('template <typename Lookup>'), source.indexOf('\n} // namespace'));
  await writeFile(join(directory, 'check.cpp'), `
#include <cassert>
#include <map>
#include <string>
using String=std::string;
std::map<String,String> fields;
bool malformed=false;
struct JsonObject {
 String path;
 JsonObject operator[](const char* key) const { return {path.empty() ? String(key) : path+"."+key}; }
 bool isNull() const {
  if(fields.count(path)) return false;
  for(const auto& field:fields) if(field.first.find(path+".")==0) return false;
  return true;
 }
 const char* operator|(const char* fallback) const { auto item=fields.find(path); return item==fields.end()?fallback:item->second.c_str(); }
 template<class T> T as() const { return T{path}; }
};
struct JsonDocument : JsonObject {};
bool deserializeJson(JsonDocument&,const String&) { return malformed; }
struct DeviceStore { int cleared=0; String id="pending"; bool clearPendingRequestIfCurrent(const String& expected) { if(expected!=id)return false; ++cleared; return true; } };
${operation}
int main() {
 DeviceStore store;
 settleDurableDeviceRequest(&store,"pending",-11,""); assert(store.cleared==0);
 for(int code:{200,408,429,500,503}) {
  fields.clear(); settleDurableDeviceRequest(&store,"pending",code,""); assert(store.cleared==0);
 }
 fields["request.status"]="processing"; fields["command.id"]="id";
 settleDurableDeviceRequest(&store,"pending",202,""); assert(store.cleared==0);
 fields.clear(); fields["error.details.request.status"]="failed";
 settleDurableDeviceRequest(&store,"pending",502,""); assert(store.cleared==1);
 fields.clear(); fields["command.id"]="id";
 settleDurableDeviceRequest(&store,"pending",202,""); assert(store.cleared==2);
 fields.clear(); fields["thread.id"]="thread";
 settleDurableDeviceRequest(&store,"pending",201,""); assert(store.cleared==3);
 fields.clear(); fields["error.message"]="validation";
 settleDurableDeviceRequest(&store,"pending",400,""); assert(store.cleared==4);
 for(const char* code:{"device_context_changed","idempotency_conflict"}) {
  fields.clear(); fields["error.details.code"]=code;
  settleDurableDeviceRequest(&store,"pending",409,""); assert(store.cleared==4);
 }
 for(int code:{401,403,404}) {
  fields.clear(); settleDurableDeviceRequest(&store,"pending",code,""); assert(store.cleared==4);
 }
 settleDurableDeviceRequest(&store,"older",200,""); assert(store.cleared==4);
 fields.clear(); fields["request.clientRequestId"]="pending"; fields["request.status"]="processing";
 int lookups=0;
 auto processing=[&](const char*,String&) { ++lookups; return 200; };
 assert(!resolveDurableDeviceReceipt("pending",processing) && lookups==1);
 fields["request.status"]="completed";
 auto threadReceipt=[&](const char* path,String&) {
  ++lookups;
  return String(path).find("thread.create")!=String::npos ? 200 : 404;
 };
 lookups=0;
 assert(resolveDurableDeviceReceipt("pending",threadReceipt) && lookups==2);
 fields["request.clientRequestId"]="different";
 assert(!resolveDurableDeviceReceipt("pending",processing));
 auto absent=[&](const char*,String&) { ++lookups; return 404; };
 lookups=0; assert(!resolveDurableDeviceReceipt("pending",absent) && lookups==2);
 malformed=true;
 settleDurableDeviceRequest(&store,"pending",200,""); assert(store.cleared==4);
}
`);
  const executable = join(directory, 'check');
  const compiled = spawnSync(compiler, ['-std=c++17', join(directory, 'check.cpp'), '-o', executable], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});

test('actual blocker projection keeps gateway approvals, provider approvals and user input distinct', async (t) => {
  const compiler = process.env.CXX || 'c++';
  if (spawnSync(compiler, ['--version']).error?.code === 'ENOENT') return t.skip('Native C++ compiler unavailable');
  const directory = await mkdtemp(join(tmpdir(), 'next-coder-blockers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const model = await readFile('firmware/shared/NextCoderCore/src/OperateModel.h', 'utf8');
  const projection = model.slice(model.indexOf('constexpr size_t kMaxRemoteBlockerCount'), model.indexOf('// The two-line status surface'));
  const ui = await readFile('firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp', 'utf8');
  const presentation = ui.slice(ui.indexOf('OrbPresentation presentationForState()'), ui.indexOf('  // 4. The voice note, while one is in flight.'));
  const operate = await readFile('firmware/shared/NextCoderCore/src/GatewayOperate.cpp', 'utf8');
  const parseStart = operate.indexOf('  JsonArray provider = doc["providerApprovals"]');
  const parser = operate.slice(parseStart, operate.indexOf('  const size_t before = approvalCount_;', parseStart));
  await writeFile(join(directory, 'check.cpp'), `
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstring>
${projection}
struct JsonArray { bool missing=false; size_t count=0; bool isNull()const{return missing;} size_t size()const{return count;} };
struct JsonValue {
 JsonArray value;
 bool isNull()const{return value.missing;}
 template<class T> T as()const{return value;}
};
struct JsonDocument {
 JsonArray providers,inputs;
 bool providerError=false,inputError=false;
 JsonValue operator[](const char* key) {
  if(std::strcmp(key,"providerApprovals")==0)return {providers};
  if(std::strcmp(key,"userInputRequests")==0)return {inputs};
  return {{std::strcmp(key,"providerApprovalsError")==0 ? !providerError : !inputError,0}};
 }
} doc;
RemoteBlockers remoteBlockers_;
void parseBlockers() {
${parser}
}
enum class OrbMode { Wave, Ring, Web, Orbits };
struct OrbPresentation { OrbMode mode; const char* label; bool speaks; };
namespace audio { bool recording() { return false; } }
enum class ProvisioningState { Provisioning, Failed, Unprovisioned, Connecting, Online };
enum class GatewayLink { NoIdentity, Revoked, Unreachable, Unclaimed, Idle, Connecting, Claimed };
struct Provisioning { struct Status { ProvisioningState state=ProvisioningState::Online; } value; const Status& status(){return value;} } provisioning;
struct Gateway {
 size_t approvals=0; RemoteBlockers remote;
 GatewayLink link() { return GatewayLink::Claimed; }
 bool hasBlockingRequests() { return blockerKind()!=DeviceBlockerKind::None; }
 DeviceBlockerKind blockerKind() { return deviceBlockerKind(approvals,remote); }
} gateway;
Gateway* gw=&gateway; Provisioning* prov=&provisioning;
${presentation}
return {OrbMode::Orbits,"Working",false};
}
int main() {
 assert(boundedRemoteBlockerCount(0)==0 && boundedRemoteBlockerCount(4)==4);
 assert(boundedRemoteBlockerCount(100000)==99);
 doc.providers.count=3; doc.inputs.count=2; parseBlockers();
 assert(remoteBlockers_.providerApprovals==3 && remoteBlockers_.userInputs==2);
 doc.providers.count=100000; parseBlockers(); assert(remoteBlockers_.providerApprovals==99);
 doc.providerError=true; doc.providers.count=0; parseBlockers();
 assert(remoteBlockers_.providerUnknown && remoteBlockers_.providerApprovals==99);
 doc.providerError=false; doc.providers.missing=true; parseBlockers(); assert(remoteBlockers_.providerUnknown);
 doc.providers.missing=false; doc.inputs.count=0; parseBlockers();
 assert(!remoteBlockers_.providerUnknown && !remoteBlockers_.inputUnknown);
 assert(remoteBlockers_.providerApprovals==0 && remoteBlockers_.userInputs==0);
 assert(std::strcmp(presentationForState().label,"Working")==0);
 gateway.remote.providerApprovals=2;
 assert(std::strcmp(presentationForState().label,"Provider approval")==0);
 assert(presentationForState().mode==OrbMode::Ring && presentationForState().speaks);
 gateway.remote.userInputs=1;
 assert(std::strcmp(presentationForState().label,"Needs input")==0);
 gateway.approvals=1;
 assert(std::strcmp(presentationForState().label,"Gateway approval")==0);
 gateway.approvals=0; gateway.remote={}; gateway.remote.inputUnknown=true;
 assert(std::strcmp(presentationForState().label,"Check T3 status")==0);
 gateway.remote.inputUnknown=false; gateway.remote.providerUnknown=true;
 assert(std::strcmp(presentationForState().label,"Check T3 status")==0);
}
`);
  const executable = join(directory, 'check');
  const compiled = spawnSync(compiler, ['-std=c++17', join(directory, 'check.cpp'), '-o', executable], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});

test('actual Home actions preserve Status and Stop access while blocked or awaiting inspection', async (t) => {
  const compiler = process.env.CXX || 'c++';
  if (spawnSync(compiler, ['--version']).error?.code === 'ENOENT') return t.skip('Native C++ compiler unavailable');
  const directory = await mkdtemp(join(tmpdir(), 'next-coder-home-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ui = await readFile('firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp', 'utf8');
  const actionsStart = ui.indexOf('void buildActions()');
  const homeStart = ui.indexOf('    case Screen::Home:', actionsStart);
  const home = ui.slice(homeStart, ui.indexOf('    case Screen::Threads:', homeStart));
  const routeStart = ui.indexOf('    case Act::SavedActions:', ui.indexOf('void runAction(Act id)'));
  const route = ui.slice(routeStart, ui.indexOf('    case Act::NewThread:', routeStart));
  const model = await readFile('firmware/shared/NextCoderCore/src/OperateModel.h', 'utf8');
  const projection = model.slice(model.indexOf('constexpr size_t kMaxRemoteBlockerCount'), model.indexOf('// The two-line status surface'));
  const operate = await readFile('firmware/shared/NextCoderCore/src/GatewayOperate.cpp', 'utf8');
  const systemStart = operate.indexOf('DispatchResult GatewayClient::runAction(');
  const system = operate.slice(systemStart, operate.indexOf('  if (actionId.length() == 0)', systemStart));
  const main = await readFile('firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/main.cpp', 'utf8');
  const settleStart = main.indexOf('    case Stage::Settle:');
  const settle = main.slice(settleStart, main.indexOf('    case Stage::TapTalk:', settleStart));
  await writeFile(join(directory, 'check.cpp'), `
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>
#include <algorithm>
using String=std::string;
${projection}
enum class Act { None,Review,PickThread,Retry,SavedActions,Talk };
enum class Screen { Home,Actions };
Screen screen=Screen::Home;
struct Action { Act id; };
std::vector<Action> actions;
void addAction(Act id,const char*,bool,bool=true) { actions.push_back({id}); }
bool haveThread() { return true; }
namespace audio { bool available() { return true; } }
struct Gateway {
 DeviceBlockerKind kind=DeviceBlockerKind::None;
 size_t controls=3;
 bool hasBlockingRequests() { return kind!=DeviceBlockerKind::None; }
 size_t controlCount() { return controls; }
 bool responseOpen() { return false; }
 struct Response { String state="complete"; } value;
 const Response& response(){return value;}
} gateway;
Gateway* gw=&gateway;
bool clipHeld=false; bool voiceInJourney(){return false;}
void buildHome() { actions.clear(); switch(Screen::Home) {
${home}
default:return;
} }
void goTo(Screen next) { screen=next; }
void activate(Act id) { switch(id) {
${route}
default:return;
} }
struct DispatchResult { int route=0; };
struct GatewayClient {
 DispatchResult sendStatus(){return {1};}
 DispatchResult sendStop(){return {2};}
 DispatchResult runAction(const String&,const String&);
};
struct StateLock { explicit StateLock(GatewayClient*){} };
${system}
return {};
}
enum class Stage { Settle, GoThreads, TapTalk };
Stage stage=Stage::Settle;
uint32_t dueAt=0,inspectionDeadline=0;
int talkAttempts=0;
bool uiBenchCaptureState(bool& microphone,bool& thread,DeviceBlockerKind& blocker) {
 microphone=thread=true; blocker=DeviceBlockerKind::Unknown; return true;
}
bool uiBenchRunAction(const char*) { ++talkAttempts; return false; }
const char* uiBenchScreenName() { return "Home"; }
struct { template<class... T> void printf(const char*,T...) {} void println(const char*) {} } Serial;
void benchTick(uint32_t now) { switch(stage) {
${settle}
default:return;
} }
int main() {
 for(auto kind:{DeviceBlockerKind::Unknown,DeviceBlockerKind::GatewayApproval,DeviceBlockerKind::ProviderApproval,DeviceBlockerKind::UserInput}) {
  gateway.kind=kind; buildHome();
  assert(actions.size()==3 && actions[0].id==Act::Review && actions[1].id==Act::SavedActions && actions[2].id==Act::PickThread);
  activate(actions[1].id); assert(screen==Screen::Actions);
 }
 gateway.kind=DeviceBlockerKind::None; buildHome();
 assert(actions.size()==3 && actions[0].id==Act::Talk && actions[1].id==Act::SavedActions && actions[2].id==Act::PickThread);
 gateway.kind=DeviceBlockerKind::Unknown; gateway.controls=0; buildHome();
 assert(actions.size()==3 && actions[0].id==Act::Review && actions[1].id==Act::SavedActions && actions[2].id==Act::PickThread);
 GatewayClient client;
 assert(client.runAction("system_status","").route==1);
 assert(client.runAction("system_stop","").route==2);
 benchTick(1); assert(talkAttempts==0 && inspectionDeadline==30001);
 benchTick(30000); assert(talkAttempts==0);
 benchTick(30001); assert(talkAttempts==1 && stage==Stage::GoThreads);
}
`);
  const executable = join(directory, 'check');
  const compiled = spawnSync(compiler, ['-std=c++17', join(directory, 'check.cpp'), '-o', executable], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});
