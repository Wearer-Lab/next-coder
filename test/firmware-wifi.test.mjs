import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("actual provisioning scans asynchronously, validates candidates and fails over saved networks without losing credentials", async (t) => {
  const compiler = process.env.CXX || "c++";
  if (spawnSync(compiler, ["--version"]).error?.code === "ENOENT") return t.skip("Native C++ compiler unavailable");
  const source = await readFile("firmware/shared/NextCoderCore/src/Provisioning.cpp", "utf8");
  const header = await readFile("firmware/shared/NextCoderCore/src/Provisioning.h", "utf8");
  const declaration = header.slice(header.indexOf("enum class ProvisioningState")).replace(" private:", " public:");
  const names = ["begin", "resetToProvisioning", "enterProvisioning", "publishWifi", "startWifiScan", "cancelWifiScan", "pollWifiScan", "validateWifiCandidate", "startWifiCandidate", "tryWifiNetwork", "connectSavedWifiNetwork", "failWifiCandidate", "cancelWifiJoin", "startSavedAttempt", "pollSavedJoin", "enterConnecting", "pollPortalJoin", "poll", "closeConfigPortal"];
  const methods = names.map((name) => {
    const expression = new RegExp(`(?:void|bool|ProvisioningState) Provisioning::${name}\\(`, "u");
    const start = source.search(expression);
    assert.notEqual(start, -1, name);
    return source.slice(start, source.indexOf("\n}", start) + 2);
  }).join("\n");
  const directory = await mkdtemp(join(tmpdir(), "next-coder-wifi-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const harness = (await readFile("test/support/firmware-wifi-stubs.h", "utf8"))
    .replace("@@DECLARATION@@", declaration).replace("@@METHODS@@", methods);
  await writeFile(join(directory, "check.cpp"), harness + `
void Provisioning::pollPhoneSetup(){}
void Provisioning::endPhoneSetup(){}
int main(){
 // Configure SDK RAM-only credentials before initializing its radio; failure to reset is truthful.
 DeviceStore startup;Provisioning start;start.begin(startup,"unit");assert(!WiFi.persistentSetting&&!WiFi.autoReconnect);
 startup.resetOk=false;const int radioBegins=WiFi.begins;start.resetToProvisioning();assert(startup.profiles.size()==2&&start.wifi_.phase==WifiConnectionPhase::Failed&&WiFi.begins==radioBegins);
 // Async scan is bounded, sorts by signal, merges duplicate SSIDs and labels saved/security.
 DeviceStore store;Provisioning p;attach(p,store);
 assert(p.startWifiScan()&&WiFi.scanCalls==1&&p.wifiScanSnapshot().scanning);
 p.poll();assert(p.scan_.scanning);WiFi.rows={{"primary",-70,WIFI_AUTH_WPA2_PSK},{"primary",-40,WIFI_AUTH_WPA2_PSK},{"enterprise",-30,5},{"open",-55,WIFI_AUTH_OPEN}};
 for(int i=0;i<20;++i)WiFi.rows.push_back({String("network")+std::to_string(i),-60-i,WIFI_AUTH_WPA2_PSK});
 WiFi.scanState=WiFi.rows.size();p.poll();auto scan=p.wifiScanSnapshot();assert(!scan.scanning&&!scan.failed&&scan.count==12);
 assert(scan.networks[0].ssid=="enterprise"&&!scan.networks[0].supported);
 assert(scan.networks[1].ssid=="primary"&&scan.networks[1].rssi==-40&&scan.networks[1].saved);
 assert(scan.networks[2].ssid=="open"&&!scan.networks[2].secured&&scan.networks[2].supported);
 assert(!p.tryWifiNetwork("enterprise","password3"));
 assert(p.startWifiScan());clockNow+=15001;p.poll();assert(p.scan_.failed&&scanStops==1);
 // Invalid input and cancellation never persist; wrong SSID association is never accepted.
 assert(!p.tryWifiNetwork("bad","short")&&store.saves==0);
 String ssid="new",password="password3";assert(p.tryWifiNetwork(ssid,password));ssid="changed";password="changed";
 assert(WiFi.requested=="new"&&WiFi.password=="password3");WiFi.join("primary");p.poll();assert(store.saves==0&&p.portalJoinPending_);
 p.cancelWifiJoin();assert(store.saves==0&&p.pendingPassword_.empty()&&!p.portalJoinPending_);
 assert(p.tryWifiNetwork("new","password3"));clockNow+=20001;p.poll();assert(store.saves==0&&p.pendingPassword_.empty()&&p.wifi_.phase==WifiConnectionPhase::Failed);
 // Proven new-network association saves once; a saved network skips password entry and activates.
 assert(p.tryWifiNetwork("new","password3"));WiFi.join("new");p.poll();assert(store.saves==1&&store.wifiSsid()=="new"&&p.online()&&p.wifi_.candidateResult==WifiCandidateResult::Succeeded);
 assert(p.connectSavedWifiNetwork("backup"));WiFi.join("backup");p.poll();assert(store.wifiSsid()=="backup"&&store.activations==1);
 // A same-SSID password change cannot validate the old association or block inside begin().
 WiFi.join("backup");WiFi.deferDisconnect=true;int before=WiFi.begins;
 assert(p.tryWifiNetwork("backup","newsecret"));p.poll();assert(p.candidateBeginPending_&&WiFi.begins==before&&store.saves==1);
 WiFi.deferDisconnect=false;WiFi.disconnect(false);p.poll();assert(!p.candidateBeginPending_&&WiFi.begins==before+1);
 p.cancelWifiJoin();assert(store.saves==1&&p.wifi_.candidateResult==WifiCandidateResult::Cancelled);
 // Failure is a durable UI outcome even when automatic fallback reconnects the same SSID.
 assert(p.tryWifiNetwork("backup","wrongpass"));const auto failedId=p.wifi_.candidateId;
 clockNow+=20001;p.poll();assert(p.wifi_.candidateResult==WifiCandidateResult::Failed);
 clockNow+=1001;p.poll();WiFi.join("backup");p.poll();
 assert(p.wifi_.phase==WifiConnectionPhase::Connected&&p.wifi_.candidateId==failedId&&p.wifi_.candidateResult==WifiCandidateResult::Failed);
 // An NVS failure leaves profiles unchanged and clears candidate secrets before restoring them.
 store.saveOk=false;assert(p.tryWifiNetwork("newbad","password3"));WiFi.join("newbad");p.poll();
 assert(store.wifiSsid()=="backup"&&p.pendingPassword_.empty()&&p.wifi_.phase==WifiConnectionPhase::Failed);store.saveOk=true;
 // Full profile capacity rejects a new network before disconnecting the current connection.
 store.profiles={{"backup","password2"},{"a","password1"},{"b","password1"},{"c","password1"},{"d","password1"}};
 WiFi.join("backup");int begins=WiFi.begins;assert(!p.tryWifiNetwork("sixth","password6")&&WiFi.begins==begins&&WiFi.status()==WL_CONNECTED);
 // Known-good outage tries alternatives with bounded pauses and never resets credentials/portal.
 DeviceStore fallback;Provisioning q;attach(q,fallback);int beforePortal=portals;WiFi.disconnect(false);q.poll();assert(WiFi.requested=="primary");
 clockNow+=20001;q.poll();clockNow+=251;q.poll();assert(WiFi.requested=="backup"&&q.wifi_.phase==WifiConnectionPhase::TryingAlternate);
 WiFi.join("backup");q.poll();assert(q.online()&&fallback.wifiSsid()=="backup"&&q.wifi_.detail=="Switched to another saved network");
 for(int i=0;i<10;++i){WiFi.disconnect(false);q.poll();clockNow+=20001;q.poll();clockNow+=30001;q.poll();}
 assert(portals==beforePortal&&fallback.profiles.size()==2);
 // At first boot, all profiles are tried before fallback; the portal continues saved retries.
 DeviceStore initial;Provisioning boot;boot.store_=&initial;boot.enterConnecting();assert(WiFi.requested=="primary");
 clockNow+=20001;boot.poll();clockNow+=251;boot.poll();assert(WiFi.requested=="backup");
 clockNow+=20001;boot.poll();clockNow+=30001;boot.poll();clockNow+=20001;boot.poll();assert(boot.status_.state==ProvisioningState::Provisioning);
 clockNow+=30001;boot.poll();assert(boot.savedJoinPending_);WiFi.join(boot.savedAttemptSsid_);boot.poll();assert(boot.online());
 // Portal and on-device candidates use the same validate-before-persist path.
 DeviceStore portalStore;Provisioning portal;attach(portal,portalStore);portal.configPortal_=true;portal.enterProvisioning(true);
 assert(portal.startWifiCandidate("portal","password3",false,true));portal.closeConfigPortal();assert(portalStore.saves==0&&portal.pendingPassword_.empty());
 assert(portal.startWifiCandidate("portal","password3",false,true));WiFi.join("portal");portal.poll();assert(portalStore.saves==1&&portal.online());
}
`);
  const executable = join(directory, "check");
  const compiled = spawnSync(compiler, ["-std=c++17", join(directory, "check.cpp"), "-o", executable], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
});
