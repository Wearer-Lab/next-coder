import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("actual Wi-Fi store migrates, bounds, snapshots and commits complete last-good profiles under NVS faults", async (t) => {
  const compiler=process.env.CXX||"c++";
  if(spawnSync(compiler,["--version"]).error?.code==="ENOENT")return t.skip("Native C++ compiler unavailable");
  const source=await readFile("firmware/shared/NextCoderCore/src/DeviceStore.cpp","utf8");
  const methods=source.slice(source.indexOf("namespace {\nconstexpr size_t kMaxWifiProfileBytes"),source.indexOf("bool DeviceStore::setClaimCode("));
  const resetMethod=source.slice(source.indexOf("bool DeviceStore::resetForProvisioning()"),source.indexOf("bool DeviceStore::wipeToFactoryState()"));
  const dir=await mkdtemp(join(tmpdir(),"next-coder-wifi-store-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const code=`
#include <cassert>
#include <cstring>
#include <string>
#include <vector>
#include <map>
#include <set>
#include <mutex>
#include <thread>
#include <stdexcept>
struct String:std::string {
 using std::string::string;
 String(const std::string&s):std::string(s){}
 String(size_t value):std::string(std::to_string(value)){}
 String substring(size_t begin,size_t end)const{return substr(begin,end-begin);}
};
constexpr size_t kMaxSavedWifiNetworks=5;
constexpr const char*kKeyWifiNetworks="wifi_saved",*kKeyWifiSsid="wifi_ssid",*kKeyWifiPass="wifi_pass";
struct WifiNetworkProfile{String ssid,password;};
struct {void println(const char*){}}Serial;
struct DeviceStore {
 mutable std::recursive_mutex mutex;
 struct SettingsGuard{std::lock_guard<std::recursive_mutex> guard;SettingsGuard(const DeviceStore&s):guard(s.mutex){}};
 std::map<String,String> nvs;
 int writes=0,failAt=0,cutAt=0;bool opened_=true,failRollback=false;
 String wifiSsid_,wifiPassword_;WifiNetworkProfile savedWifiNetworks_[kMaxSavedWifiNetworks];
 size_t savedWifiNetworkCount_=0;bool wifiProfilesPersisted_=false;
 String readString(const char*key){return nvs.count(key)?nvs[key]:String();}
 bool putString(const char*key,const String&value){
  ++writes;
  if(cutAt && writes==cutAt)throw std::runtime_error("power loss");
  if(failAt && (writes==failAt || (failRollback && writes>failAt)))return false;
  if(value.empty())nvs.erase(key);else nvs[key]=value;return true;
 }
 void reboot(){wifiSsid_=readString(kKeyWifiSsid);wifiPassword_=readString(kKeyWifiPass);loadWifiNetworks();}
 void loadWifiNetworks();bool commitWifiNetworks(const WifiNetworkProfile*,size_t);
 std::vector<WifiNetworkProfile> savedWifiNetworksSnapshot()const;
 std::vector<String> savedWifiNamesSnapshot()const;
 bool saveWifiNetwork(const String&,const String&);
 bool activateSavedWifiNetwork(const String&);
 bool forgetWifiNetwork(const String&);
 bool setWifiCredentials(const String&,const String&);
 bool allowReceiptClear=true;
 bool clearPendingRequest(){return allowReceiptClear;}bool setConfigCache(const String&){return true;}bool clearClaimCode(){return true;}
 bool resetForProvisioning();
};
${methods}
${resetMethod}
void assertPair(const DeviceStore&s,const char*ssid,const char*password){
 assert(s.wifiSsid_==ssid && s.wifiPassword_==password);
 auto profiles=s.savedWifiNetworksSnapshot();
 if(*ssid){assert(!profiles.empty() && profiles[0].ssid==ssid && profiles[0].password==password);}
 else assert(profiles.empty());
}
int main(){
 DeviceStore legacy;legacy.nvs[kKeyWifiSsid]="old-network";legacy.nvs[kKeyWifiPass]="old-password";legacy.reboot();
 assertPair(legacy,"old-network","old-password");assert(legacy.writes==0);
 assert(legacy.saveWifiNetwork("new:network\\nUTF8-é","new:password\\nvalue"));
 assert(legacy.savedWifiNetworksSnapshot().size()==2);
 legacy.reboot();assert(legacy.wifiSsid_=="new:network\\nUTF8-é");
 assert(legacy.activateSavedWifiNetwork("old-network"));assertPair(legacy,"old-network","old-password");
 const int unchanged=legacy.writes;assert(legacy.activateSavedWifiNetwork("old-network"));assert(legacy.writes==unchanged);
 assert(!legacy.forgetWifiNetwork("old-network"));assert(!legacy.activateSavedWifiNetwork("not-saved"));
 assert(legacy.forgetWifiNetwork("new:network\\nUTF8-é"));assert(legacy.savedWifiNamesSnapshot().size()==1);
 auto isolated=legacy.savedWifiNetworksSnapshot();isolated[0].password="changed-outside";assertPair(legacy,"old-network","old-password");
 for(int i=0;i<4;i++)assert(legacy.saveWifiNetwork(String(std::string("network-")+std::to_string(i)),"password"));
 assert(legacy.savedWifiNamesSnapshot().size()==5);
 const auto before=legacy.nvs;assert(!legacy.saveWifiNetwork("sixth-network","password"));assert(legacy.nvs==before);
 assert(legacy.saveWifiNetwork("old-network","changed-password"));assertPair(legacy,"old-network","changed-password");
 assert(!legacy.saveWifiNetwork("","password"));assert(!legacy.saveWifiNetwork(std::string(33,'x'),"password"));
 assert(!legacy.saveWifiNetwork("network",std::string(65,'p')));
 assert(!legacy.saveWifiNetwork(String(std::string("x\\0y",3)),"password"));
 assert(!legacy.saveWifiNetwork("old-network",String(std::string("p\\0assword",9))));
 assertPair(legacy,"old-network","changed-password");
 assert(legacy.saveWifiNetwork("open-network","" )==false); // Still full: empty passwords do not bypass capacity.
 legacy.allowReceiptClear=false;
 const auto beforeReset=legacy.nvs;assert(!legacy.resetForProvisioning());assert(legacy.nvs==beforeReset);
 legacy.allowReceiptClear=true;
 assert(legacy.resetForProvisioning());assertPair(legacy,"","");legacy.reboot();assertPair(legacy,"","");
 assert(legacy.saveWifiNetwork("open-network",""));assertPair(legacy,"open-network","");
 // Every transaction write can fail: RAM remains unchanged and the authoritative blob
 // restores the old complete pair even if compatibility-mirror rollback also fails.
 for(int fail=1;fail<=4;fail++)for(bool rollbackFailure:{false,true}){
  DeviceStore s;s.nvs[kKeyWifiSsid]="old";s.nvs[kKeyWifiPass]="old-password";s.reboot();
  s.failAt=fail;s.failRollback=rollbackFailure;
  assert(!s.saveWifiNetwork("new","new-password"));assertPair(s,"old","old-password");
  s.failAt=0;s.failRollback=false;s.reboot();assertPair(s,"old","old-password");
 }
 // Power can disappear between any two compatibility writes or before the blob commit.
 for(int cut=1;cut<=4;cut++){
  DeviceStore s;s.nvs[kKeyWifiSsid]="old";s.nvs[kKeyWifiPass]="old-password";s.reboot();s.cutAt=cut;
  try{s.saveWifiNetwork("new","new-password");assert(false);}catch(const std::runtime_error&){}
  s.cutAt=0;s.reboot();assertPair(s,"old","old-password");
 }
 DeviceStore malformed;malformed.nvs[kKeyWifiSsid]="legacy";malformed.nvs[kKeyWifiPass]="password";
 for(const auto&blob:{String("W1\\n99:bad0:"),String("W1\\n1:a0:1:a0:"),String(std::string(601,'x'))}){
  malformed.nvs[kKeyWifiNetworks]=blob;malformed.reboot();assertPair(malformed,"legacy","password");
 }
 DeviceStore empty;empty.nvs[kKeyWifiNetworks]="W1\\n";empty.nvs[kKeyWifiSsid]="stale";empty.nvs[kKeyWifiPass]="stale";empty.reboot();assertPair(empty,"","");
 DeviceStore concurrent;assert(concurrent.saveWifiNetwork("alpha","alpha-password"));assert(concurrent.saveWifiNetwork("beta","beta-password"));
 std::thread writer([&]{for(int i=0;i<200;i++)assert(concurrent.activateSavedWifiNetwork(i%2?"alpha":"beta"));});
 std::thread reader([&]{for(int i=0;i<200;i++){auto values=concurrent.savedWifiNetworksSnapshot();assert(values.size()==2);
  for(const auto&value:values)assert(value.password==value.ssid+"-password");}});
 writer.join();reader.join();
}
`;
  await writeFile(join(dir,"check.cpp"),code);
  const compiled=spawnSync(compiler,["-std=c++17","-pthread",join(dir,"check.cpp"),"-o",join(dir,"check")],{encoding:"utf8"});assert.equal(compiled.status,0,compiled.stderr);
  const run=spawnSync(join(dir,"check"),[],{encoding:"utf8"});assert.equal(run.status,0,run.stderr);
});
