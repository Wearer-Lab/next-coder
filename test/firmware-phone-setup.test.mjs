import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("phone setup authorizes only its local AP session and retains bounded, idempotent candidate outcomes", async (t) => {
  const compiler = process.env.CXX || "c++";
  if (spawnSync(compiler, ["--version"]).error?.code === "ENOENT") return t.skip("Native C++ compiler unavailable");
  const source = await readFile("firmware/shared/NextCoderCore/src/Provisioning.cpp", "utf8");
  const header = await readFile("firmware/shared/NextCoderCore/src/Provisioning.h", "utf8");
  const declaration = header.slice(header.indexOf("enum class ProvisioningState")).replace(" private:", " public:");
  const names = ["enterProvisioning", "publishWifi", "startWifiScan", "cancelWifiScan", "pollWifiScan", "validateWifiCandidate", "startWifiCandidate", "failWifiCandidate", "startSavedAttempt", "pollSavedJoin", "enterConnecting", "pollPortalJoin", "cancelWifiJoin", "phoneSetupSnapshot", "beginPhoneSetup", "endPhoneSetup", "queuePhoneNetwork", "pollPhoneSetup", "phoneHeaders", "phoneRequestAllowed"];
  const methods = names.map((name) => {
    const start = source.search(new RegExp(`(?:void|bool|PhoneSetupSnapshot) Provisioning::${name}\\(`, "u"));
    assert.notEqual(start, -1, name);
    return source.slice(start, source.indexOf("\n}", start) + 2);
  }).join("\n");
  const harness = (await readFile("test/support/firmware-wifi-stubs.h", "utf8"))
    .replace("@@DECLARATION@@", declaration).replace("@@METHODS@@", methods);
  const directory = await mkdtemp(join(tmpdir(), "next-coder-phone-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "check.cpp"), harness + `
int main(){
 DeviceStore store;Provisioning p;attach(p,store);p.apName_="agent-ctl-unit";
 assert(p.beginPhoneSetup());assert(p.phone_.active&&p.phone_.apPassword.length()==16&&p.phoneNonce_.length()==32);
 const String firstNonce=p.phoneNonce_,firstPassword=p.phone_.apPassword;
 assert(p.phoneSetupSnapshot().expiresInSeconds==600);
 p.server_.headers["X-Setup-Token"]=p.phoneNonce_;assert(p.phoneRequestAllowed());
 p.server_.connection.ip=Ip("192.0.2.1");assert(!p.phoneRequestAllowed()&&p.server_.status==403);p.server_.connection.ip=Ip("192.168.4.1");
 p.server_.host="evil.example";assert(!p.phoneRequestAllowed(false));p.server_.host="192.168.4.1";
 p.server_.headers["Origin"]="https://evil.example";assert(!p.phoneRequestAllowed());p.server_.headers["Origin"]="http://192.168.4.1";
 p.server_.headers["Sec-Fetch-Site"]="cross-site";assert(!p.phoneRequestAllowed());p.server_.headers["Sec-Fetch-Site"]="same-origin";
 p.server_.headers["X-Setup-Token"]="bad";assert(!p.phoneRequestAllowed());p.server_.headers["X-Setup-Token"]=p.phoneNonce_;
 assert(p.phoneRequestAllowed());
 const int before=WiFi.begins;
 assert(p.queuePhoneNetwork("request_one","target","password3"));
 assert(WiFi.begins==before&&p.phone_.phase==PhoneSetupPhase::Queued&&WiFi.status()==WL_CONNECTED);
 assert(p.queuePhoneNetwork("request_one","different","different")); // same receipt never executes twice
 assert(!p.queuePhoneNetwork("request_two","target","password3")); // cannot replace an in-flight request
 clockNow+=299;p.pollPhoneSetup();assert(WiFi.begins==before);
 ++clockNow;p.pollPhoneSetup();assert(WiFi.begins==before+1&&WiFi.requested=="target"&&p.phoneQueuedPassword_.empty());
 const auto candidate=p.phone_.candidateId;
 clockNow+=20001;p.pollPortalJoin();p.pollPhoneSetup();
 assert(p.phone_.phase==PhoneSetupPhase::Failed&&p.phone_.candidateResult==WifiCandidateResult::Failed&&store.saves==0);
 assert(p.queuePhoneNetwork("request_one","target","password3")&&WiFi.begins==before+1);
 assert(!p.queuePhoneNetwork("request_two","target","password3")); // stale predecessor cannot replace a terminal receipt
 assert(p.queuePhoneNetwork("request_two","target","password3",false,"request_one"));
 assert(!p.queuePhoneNetwork("request_one_late","target","password3"));
 clockNow+=300;p.pollPhoneSetup();WiFi.join("target");p.pollPortalJoin();
 assert(p.phone_.phase==PhoneSetupPhase::Succeeded&&p.phone_.candidateResult==WifiCandidateResult::Succeeded&&store.saves==1);
 assert(p.online()&&p.portalUp_&&!p.configPortal_); // cloud may resume while phone reads its saved receipt
 assert(!p.queuePhoneNetwork("third_request","other","password3",false,"request_two"));
 clockNow+=9999;p.pollPhoneSetup();assert(p.phone_.active);
 ++clockNow;p.pollPhoneSetup();assert(!p.phone_.active&&!p.portalUp_&&p.phone_.apPassword.empty()&&p.phoneNonce_.empty());
 assert(!p.phoneRequestAllowed()&&store.saves==1);
 assert(p.beginPhoneSetup());assert(p.phoneNonce_!=firstNonce&&p.phone_.apPassword!=firstPassword);
 clockNow+=600001;p.pollPhoneSetup();assert(!p.phone_.active&&store.saves==1);
 // Expiry/cancel before the deferred start never disconnects or saves an unvalidated network.
 assert(p.beginPhoneSetup());assert(p.queuePhoneNetwork("cancel_request","cancelled","password4"));const int prior=WiFi.begins;p.endPhoneSetup();
 clockNow+=500;p.pollPhoneSetup();assert(WiFi.begins==prior&&store.saves==1&&p.phoneQueuedPassword_.empty());
 // Existing explicit candidate cannot be silently cancelled by opening another setup transport.
 p.portalJoinPending_=true;assert(!p.beginPhoneSetup());p.portalJoinPending_=false;
 // First-time session ends closed rather than silently reverting to an unauthenticated open AP.
 DeviceStore fresh;fresh.profiles.clear();Provisioning unconfigured;unconfigured.store_=&fresh;unconfigured.apName_="fresh";WiFi.disconnect(false);
 assert(unconfigured.beginPhoneSetup());unconfigured.endPhoneSetup();assert(unconfigured.phonePortalClosed_&&!unconfigured.portalUp_&&fresh.saves==0);
 Provisioning hotspot;attach(hotspot,store);hotspot.apName_="hotspot";WiFi.join("target");
 assert(hotspot.beginPhoneSetup());assert(hotspot.queuePhoneNetwork("hotspot_receipt","Téléphone","password5",false,"",true));
 const int beforeHotspot=WiFi.begins;
 clockNow+=749;hotspot.pollPhoneSetup();assert(hotspot.portalUp_&&WiFi.begins==beforeHotspot);
 ++clockNow;hotspot.pollPhoneSetup();assert(!hotspot.portalUp_&&hotspot.phone_.active);
 assert(hotspot.phone_.apPassword.empty()&&hotspot.phoneNonce_.empty());
 assert(!hotspot.phoneRequestAllowed(false));
 assert(hotspot.phone_.phase==PhoneSetupPhase::WaitingHotspot&&hotspot.phoneSetupSnapshot().remainingSeconds==120);
 const auto handoffId=hotspot.phone_.candidateId;const int savesBefore=store.saves;
 assert(hotspot.queuePhoneNetwork("hotspot_receipt","ignored","ignored",false,"",true));
 for(int i=0;i<5;++i){clockNow+=20000;hotspot.pollPhoneSetup();hotspot.pollPortalJoin();hotspot.pollPortalJoin();
 assert(hotspot.phone_.candidateId==handoffId&&hotspot.wifi_.candidateResult==WifiCandidateResult::Pending&&store.saves==savesBefore);}
 clockNow+=19999;hotspot.pollPhoneSetup();assert(hotspot.phone_.waitingForHotspot);
 ++clockNow;hotspot.pollPhoneSetup();assert(hotspot.phone_.phase==PhoneSetupPhase::Failed);
 assert(!hotspot.portalUp_&&!hotspot.portalJoinPending_&&hotspot.pendingPassword_.empty()&&store.saves==savesBefore);
 hotspot.endPhoneSetup();
 assert(hotspot.beginPhoneSetup());assert(hotspot.queuePhoneNetwork("hotspot_success","Téléphone","password5",false,"",true));
 clockNow+=750;hotspot.pollPhoneSetup();clockNow+=20000;hotspot.pollPortalJoin();hotspot.pollPortalJoin();
 WiFi.join("Téléphone");hotspot.pollPortalJoin();
 assert(hotspot.phone_.phase==PhoneSetupPhase::Succeeded&&!hotspot.phone_.waitingForHotspot&&hotspot.online());
 assert(store.saves==savesBefore+1&&!hotspot.portalUp_&&hotspot.pendingPassword_.empty());hotspot.endPhoneSetup();
 Provisioning emptyHotspot;emptyHotspot.store_=&fresh;emptyHotspot.apName_="empty";WiFi.disconnect(false);
 assert(emptyHotspot.beginPhoneSetup());assert(emptyHotspot.queuePhoneNetwork("empty_hotspot","phone","password5",false,"",true));
 clockNow+=750;emptyHotspot.pollPhoneSetup();clockNow+=120000;emptyHotspot.pollPhoneSetup();
 assert(emptyHotspot.phone_.phase==PhoneSetupPhase::Failed&&!emptyHotspot.portalUp_&&emptyHotspot.phonePortalClosed_);
 assert(emptyHotspot.status_.state==ProvisioningState::Unprovisioned&&fresh.saves==0);
 emptyHotspot.endPhoneSetup();assert(!emptyHotspot.portalUp_&&emptyHotspot.pendingPassword_.empty());

}
`);
  const executable = join(directory, "check");
  const compiled = spawnSync(compiler, ["-std=c++17", join(directory, "check.cpp"), "-o", executable], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
});
