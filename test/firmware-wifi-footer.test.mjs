import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("actual Wi-Fi and phone setup controls survive retained drafts, portal and background work", async (t) => {
  const compiler=process.env.CXX||"c++";
  if(spawnSync(compiler,["--version"]).error?.code==="ENOENT")return t.skip("Native C++ compiler unavailable");
  const source=await readFile("firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp","utf8");
  const start=source.indexOf("void buildActions() {");
  assert.ok(start>=0);
  // Preserve every actual priority branch, then execute the actual Wi-Fi
  // cases. Unrelated rendering/approval/thread branches are outside this probe.
  const priorities=source.slice(start,source.indexOf("  switch (screen) {",start));
  const wifiStart=source.indexOf("    case Screen::Wifi:",start);
  const wifiCases=source.slice(wifiStart,source.indexOf("    case Screen::Device:",wifiStart));
  const actStart=source.indexOf("enum class Act :");
  const actEnum=source.slice(actStart,source.indexOf("};",actStart)+2);
  const modalStart=source.indexOf("enum class Modal :");
  const modalEnum=source.slice(modalStart,source.indexOf(";",modalStart)+1);
  const dir=await mkdtemp(join(tmpdir(),"hosyond-wifi-footer-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const code=`
#include <cassert>
// Fixed-width types need an explicit include: libc++ pulls <cstdint> in through <string>, libstdc++ (GCC/Ubuntu CI) does not.
#include <cstdint>
#include <string>
#include <vector>
using String=std::string;
${actEnum}
${modalEnum}
enum class Screen{Send,Wifi,WifiDetails,WifiPassword,WifiJoining,WifiPhone,Device};
Screen screen=Screen::Wifi;Modal modal=Modal::None;
struct Context{String environmentId="environment-original",threadId="thread-original";};
struct Gateway{Context value;const Context&context()const{return value;}}gateway;Gateway*gw=&gateway;
struct Provisioning{bool portal=true;bool configPortalActive()const{return portal;}}provisioning;Provisioning*prov=&provisioning;
struct Voice{bool resolved=false;bool canDismissCapture()const{return resolved;}}voice;
struct Control{String kind,id;}pendingControl;
struct Action{Act id;String label;bool enabled;};
std::vector<Action>actions;int actionCount=0;
bool busy=true,deferredStopPending=false,clipHeld=true,claimed=false,joinAllowed=true;
struct{bool active=true,hotspotHandoff=false,waitingForHotspot=false;String apPassword="setup-secret";}phoneSetup;bool phoneSetupSucceeded=false,phoneShowPage=false;
bool wifiShowSaved=false,wifiTargetSaved=true,wifiTargetSecured=true,wifiTargetSupported=true,wifiEditingSsid=false;
String voiceCaptureEnvironment="environment-original",voiceCaptureThread="thread-original",wifiTarget="network-fixture";
struct{bool scanning=false;}wifiScan;
struct{String activeSsid="other-network";bool joinPending=true;}wifiConnection;
bool uiNetworkBusy(){return busy;}bool operable(){return claimed;}
bool configScreen(){return screen==Screen::Wifi||screen==Screen::WifiDetails||screen==Screen::WifiPassword||screen==Screen::WifiJoining||screen==Screen::WifiPhone||screen==Screen::Device;}
bool wifiJoinCanStart(){return joinAllowed;}
void addAction(Act id,const char*label,bool,bool enabled=true){actions.push_back({id,label,enabled});++actionCount;}
${priorities}
  switch(screen){${wifiCases}default:return;}
}
const Action*find(Act id){for(const auto&action:actions)if(action.id==id)return &action;return nullptr;}
void render(Screen value){screen=value;actions.clear();buildActions();}
void assertNoDraftOrPortalOverride(){assert(!find(Act::SendClip)&&!find(Act::DiscardClip)&&!find(Act::VoiceConsole)&&!find(Act::ClosePortal));}
int main(){
 // Retained uncertain upload, gateway offline, network worker occupied and portal
 // open: Wi-Fi recovery must still own its own footer throughout the whole path.
 for(bool portal:{false,true})for(bool worker:{false,true})for(bool resolved:{false,true}){
  provisioning.portal=portal;busy=worker;voice.resolved=resolved;clipHeld=true;claimed=false;modal=Modal::None;
  wifiShowSaved=false;render(Screen::Wifi);assert(actions.size()==3);assert(find(Act::WifiScan)->label=="SCAN"&&find(Act::WifiPhone)->label=="PHONE"&&find(Act::WifiSaved)->label=="SAVED");assertNoDraftOrPortalOverride();
  wifiShowSaved=true;render(Screen::Wifi);assert(actions.size()==3);assert(find(Act::WifiAdd)->label=="ADD"&&find(Act::WifiPhone)->label=="PHONE"&&find(Act::WifiSaved)->label=="NEARBY");assertNoDraftOrPortalOverride();
  render(Screen::WifiDetails);assert(find(Act::WifiConnect)&&find(Act::WifiForget));assertNoDraftOrPortalOverride();
  render(Screen::WifiPassword);assert(find(Act::WifiConnect)&&find(Act::WifiConnect)->label=="CONNECT"&&find(Act::WifiConnect)->enabled);assert(find(Act::WifiCancel)&&find(Act::WifiPhone)&&actions.size()==3);assertNoDraftOrPortalOverride();
  phoneSetup.active=true;phoneSetup.hotspotHandoff=false;phoneSetup.waitingForHotspot=false;phoneSetup.apPassword="setup-secret";phoneSetupSucceeded=false;phoneShowPage=false;
  render(Screen::WifiPhone);assert(actions.size()==2&&find(Act::WifiPhoneDone)->label=="CANCEL"&&find(Act::WifiPhonePage)->label=="OPEN PAGE");assertNoDraftOrPortalOverride();
  phoneShowPage=true;render(Screen::WifiPhone);assert(find(Act::WifiPhonePage)->label=="JOIN WI-FI");assertNoDraftOrPortalOverride();
  phoneSetup.waitingForHotspot=true;phoneSetup.hotspotHandoff=true;phoneSetup.apPassword="";
  render(Screen::WifiPhone);assert(actions.size()==1&&find(Act::WifiPhoneDone)->label=="CANCEL"&&!find(Act::WifiPhonePage)&&!find(Act::WifiPhone));assertNoDraftOrPortalOverride();
  phoneSetup.waitingForHotspot=false;
  render(Screen::WifiPhone);assert(actions.size()==2&&find(Act::WifiPhoneDone)->label=="CANCEL"&&find(Act::WifiPhone)->label=="SETUP AGAIN"&&!find(Act::WifiPhonePage));assertNoDraftOrPortalOverride();
  phoneSetupSucceeded=true;render(Screen::WifiPhone);assert(actions.size()==1&&find(Act::WifiPhoneDone)->label=="DONE"&&!find(Act::WifiPhonePage));assertNoDraftOrPortalOverride();
  phoneSetupSucceeded=false;phoneSetup.active=false;render(Screen::WifiPhone);assert(actions.size()==1&&find(Act::WifiPhoneDone)->label=="CANCEL");assertNoDraftOrPortalOverride();
  wifiConnection.joinPending=true;render(Screen::WifiJoining);assert(find(Act::WifiCancel)&&find(Act::WifiCancel)->label=="CANCEL");assert(!find(Act::WifiEdit));assertNoDraftOrPortalOverride();
  wifiConnection.joinPending=false;render(Screen::WifiJoining);assert(find(Act::WifiCancel)->label=="BACK"&&find(Act::WifiEdit));assertNoDraftOrPortalOverride();
 }
 // Forget is a deliberate decision even when the portal, retained draft and
 // another gateway operation coexist. Its two decision controls must win.
 provisioning.portal=true;busy=true;modal=Modal::ConfirmForgetWifi;
 render(Screen::WifiDetails);assert(actions.size()==2);
 assert(find(Act::ConfirmNo)&&find(Act::ConfirmNo)->label=="CANCEL");
 assert(find(Act::ConfirmYes)&&find(Act::ConfirmYes)->label=="FORGET");assertNoDraftOrPortalOverride();
 // The exemptions do not erase the normal Send screen's draft controls.
 modal=Modal::None;provisioning.portal=false;busy=false;claimed=true;voice.resolved=true;
 render(Screen::Send);assert(find(Act::SendClip)&&find(Act::DiscardClip));
 // Existing validity/security gates remain effective inside the Wi-Fi footer.
 joinAllowed=false;render(Screen::WifiPassword);assert(!find(Act::WifiConnect)->enabled);
 wifiTargetSupported=false;render(Screen::WifiDetails);assert(!find(Act::WifiConnect)->enabled);
}
`;
  await writeFile(join(dir,"check.cpp"),code);
  const compiled=spawnSync(compiler,["-std=c++17",join(dir,"check.cpp"),"-o",join(dir,"check")],{encoding:"utf8"});
  assert.equal(compiled.status,0,compiled.stderr);
  const result=spawnSync(join(dir,"check"),[],{encoding:"utf8"});assert.equal(result.status,0,result.stderr);
});

test("actual phone setup lifecycle replaces rotated QR credentials and clears them on success or leaving", async (t) => {
  const compiler=process.env.CXX||"c++";
  if(spawnSync(compiler,["--version"]).error?.code==="ENOENT")return t.skip("Native C++ compiler unavailable");
  const source=await readFile("firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp","utf8");
  function actualFunction(signature) {
    const begin=source.indexOf(signature);assert.ok(begin>=0,signature);
    let depth=0;
    for(let i=source.indexOf("{",begin);i<source.length;i++) {
      if(source[i]==="{")depth++;
      else if(source[i]==="}"&&--depth===0)return source.slice(begin,i+1);
    }
    assert.fail(`Unclosed actual function ${signature}`);
  }
  const pollStart=source.indexOf("  if(screen==Screen::WifiPhone && static_cast<int32_t>(millis()-phoneNextCheckAt)>=0)");
  assert.ok(pollStart>=0);
  const pollEnd=source.indexOf("  if(wifiObservedRevision",pollStart);assert.ok(pollEnd>pollStart);
  const dir=await mkdtemp(join(tmpdir(),"hosyond-phone-qr-lifecycle-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const code=`
#include <cassert>
#include <cstdint>
#include <string>
using String=std::string;
enum class Screen{WifiPhone,Wifi,WifiPassword};
enum class Modal{None};
enum class PhoneSetupPhase{Ready,Joining,WaitingHotspot,Succeeded};
struct PhoneSetupSnapshot{bool active=false;uint32_t revision=0;String apName,apPassword,portalUrl;PhoneSetupPhase phase=PhoneSetupPhase::Ready;bool hotspotHandoff=false,waitingForHotspot=false;unsigned remainingSeconds=0;};
int qrEncodes=0;
namespace setup_qr {
struct Matrix{String content;void clear(){content.clear();}};
bool encodeWifi(const char*ssid,const char*password,Matrix&out){qrEncodes++;if(!*ssid)return false;out.content=String(ssid)+":"+password;return true;}
bool encodePortalUrl(const char*url,Matrix&out){qrEncodes++;if(!*url)return false;out.content=url;return true;}
}
PhoneSetupSnapshot phoneSetup;
setup_qr::Matrix phoneQr;
bool phoneShowPage=false,phoneSetupSucceeded=false;
uint32_t phoneNextCheckAt=0,now=0,navigationGeneration=0;
uint32_t millis(){return now;}
struct Provisioning{PhoneSetupSnapshot latest;int ends=0;PhoneSetupSnapshot phoneSetupSnapshot(){return latest;}void endPhoneSetup(){ends++;latest=PhoneSetupSnapshot();}}provisioning;
Provisioning*prov=&provisioning;
Screen screen=Screen::WifiPhone;
String wifiPassword;
struct PickerMotion{};PickerMotion pickerMotion;
bool pickerOpenResponse=false,chromeDirty=false,contentDirty=false,barDirty=false;
Modal modal=Modal::None;
void closeDrawerNow(){}
${actualFunction("void refreshPhoneQr() {")}
${actualFunction("void goTo(Screen next) {")}
void poll(){${source.slice(pollStart,pollEnd)}}
int main(){
 phoneSetup={true,1,"setup-original","secret-original","http://192.168.4.1",PhoneSetupPhase::Ready};
 refreshPhoneQr();assert(phoneQr.content=="setup-original:secret-original");
 provisioning.latest={true,2,"setup-rotated","secret-rotated","http://192.168.4.1",PhoneSetupPhase::Ready};
 poll();assert(phoneQr.content=="setup-rotated:secret-rotated");assert(phoneQr.content.find("original")==String::npos);
 // Failed/empty rendering must never leave a previously scannable credential.
 phoneSetup.apName="";refreshPhoneQr();assert(phoneQr.content.empty());
 phoneSetup=provisioning.latest;phoneShowPage=true;refreshPhoneQr();assert(phoneQr.content=="http://192.168.4.1");
 // Handoff turns the AP off while the phone enables its hotspot; neither the
 // stale setup credential nor the local URL is useful or safe to keep shown.
 provisioning.latest.revision++;provisioning.latest.phase=PhoneSetupPhase::WaitingHotspot;
 provisioning.latest.hotspotHandoff=true;provisioning.latest.waitingForHotspot=true;provisioning.latest.remainingSeconds=90;
 now=1000;int before=qrEncodes;poll();assert(phoneQr.content.empty()&&qrEncodes==before);
 // The countdown changes without a revision. Refresh its text without QR work.
 contentDirty=barDirty=false;provisioning.latest.remainingSeconds=89;now=2000;poll();
 assert(phoneSetup.remainingSeconds==89&&contentDirty&&barDirty&&phoneQr.content.empty()&&qrEncodes==before);
 // A failed hotspot join leaves AP credentials absent until explicit restart.
 provisioning.latest.revision++;provisioning.latest.waitingForHotspot=false;provisioning.latest.phase=PhoneSetupPhase::Ready;
 provisioning.latest.apName="";provisioning.latest.apPassword="";now=3000;poll();assert(phoneSetup.hotspotHandoff&&!phoneSetup.waitingForHotspot&&phoneSetup.apPassword.empty());
 provisioning.latest.revision++;provisioning.latest.phase=PhoneSetupPhase::Succeeded;now=4000;poll();
 assert(phoneSetupSucceeded&&phoneQr.content.empty());
 // Leaving terminates the setup AP and wipes both the matrix and cached secret.
 phoneShowPage=false;phoneSetup={true,8,"setup-leaving","secret-leaving","http://192.168.4.1",PhoneSetupPhase::Ready};refreshPhoneQr();assert(!phoneQr.content.empty());
 goTo(Screen::Wifi);assert(provisioning.ends==1&&phoneQr.content.empty());
 assert(!phoneSetup.active&&phoneSetup.apPassword.empty()&&phoneSetup.apName.empty());
 // A navigation to the same screen does not terminate an active phone session.
 screen=Screen::WifiPhone;provisioning.latest={true,4,"setup-new","secret-new","http://192.168.4.1",PhoneSetupPhase::Ready};phoneSetup=provisioning.latest;refreshPhoneQr();
 goTo(Screen::WifiPhone);assert(provisioning.ends==1&&!phoneQr.content.empty());
 // A stopped AP clears a cached QR on the next authoritative snapshot.
 provisioning.latest.active=false;provisioning.latest.revision++;now=5000;poll();assert(phoneQr.content.empty());
}
`;
  await writeFile(join(dir,"check.cpp"),code);
  const compiled=spawnSync(compiler,["-std=c++17",join(dir,"check.cpp"),"-o",join(dir,"check")],{encoding:"utf8"});
  assert.equal(compiled.status,0,compiled.stderr);
  const result=spawnSync(join(dir,"check"),[],{encoding:"utf8"});assert.equal(result.status,0,result.stderr);
});
