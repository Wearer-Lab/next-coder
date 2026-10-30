import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("actual Hosyond voice hit targets, recovery controls and labels preserve the original capture", async (t) => {
  const compiler = process.env.CXX || "c++";
  if (spawnSync(compiler, ["--version"]).error?.code === "ENOENT") return t.skip("Native compiler unavailable");
  const source = await readFile(process.env.HOSYOND_UI_SOURCE ?? "firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp", "utf8");
  const header = await readFile("firmware/shared/NextCoderCore/src/GatewayVoice.h", "utf8");
  const enumeration = header.slice(header.indexOf("enum class VoiceStage"), header.indexOf("const char* voiceStageName"));
  const press = source.slice(source.indexOf("    case TouchGesture::Press:", source.indexOf("void uiHandleTouch(")) + "    case TouchGesture::Press:".length,
    source.indexOf("    case TouchGesture::Drag:", source.indexOf("void uiHandleTouch(")));
  const journey = source.slice(source.indexOf("bool voiceInJourney() {"), source.indexOf("VoiceView voiceView() {"));
  const actionsStart = source.indexOf("void buildActions()");
  const sendActions = source.slice(source.indexOf("    case Screen::Send:", actionsStart), source.indexOf("    case Screen::Actions:", actionsStart));
  const heldActions = source.slice(source.indexOf("  if (clipHeld && screen == Screen::Send) {", actionsStart), source.indexOf("  if (!operable()", actionsStart));
  const destination = source.slice(source.indexOf("void paintMicDestination() {"), source.indexOf("void paintSend() {"));
  const dir = await mkdtemp(join(tmpdir(), "hosyond-voice-interactions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const code = `
#include <cassert>
// Fixed-width types need an explicit include: libc++ pulls <cstdint> in through <string>, libstdc++ (GCC/Ubuntu CI) does not.
#include <cstdint>
#include <string>
#include <vector>
using String=std::string;
${enumeration}
enum class Act {VoiceStatus,VoiceConsole,VoiceDismiss,VoiceReview,DiscardClip,SendClip};
enum class Screen {Send}; enum class Modal {None}; enum class DragAxis {Undecided}; enum class DragOwner {Drawer,DrawerList,Content};
struct Voice { VoiceStage value=VoiceStage::Idle; bool resolved=true,job=false,tracked=false;
 String reason,command; const String& reviewReason()const{return reason;} const String& commandId()const{return command;}
 VoiceStage stage() const{return value;} bool canStartCapture() const{return resolved && value==VoiceStage::Idle;}
 bool canDismissCapture() const{return resolved;} bool hasJob() const{return job;} bool tracking() const{return tracked;}
} voice;
${journey}
int dragTravel=0,dragTravelX=0,kContentTop=48,captures=0;
DragAxis dragAxis; DragOwner dragOwner; Modal modal=Modal::None; Screen screen=Screen::Send;
bool clipHeld=false; float drawerT=0; struct Event {int x=100,y=200,contactId=7;} event;
bool heldContact=true; bool touchDown(){return heldContact;} int touchContactId(){return 7;}
bool operable(){return true;} int micButtonRect(){return 1;}
struct Context{String environmentId="environment-a",threadId="thread-a";};
struct Gateway{Context c; const Context& context()const{return c;}} gateway; Gateway* gw=&gateway;
String voiceCaptureEnvironment="environment-a",voiceCaptureThread="thread-a",voiceCaptureTitle="Original thread A";
int kText=1,kBright=2,kHair=3,kCols1=31;
struct VoiceLayout{int labelY=0,nameY=1;}; VoiceLayout voiceLayout(){return {};}
bool haveThread(){return true;} String threadTitle(){return "Current thread B";}
std::vector<String> labels;
namespace uip {bool hit(int,int,int){return true;} String fitWords(const String& s,int){return s;} void textCentered(int,int,int,const String& s){labels.push_back(s);}}
void startRecording(){++captures;}
void press(){${press}}
std::vector<Act> controls; std::vector<bool> enabled;
void addAction(Act id,const char*,bool,bool on=true){controls.push_back(id);enabled.push_back(on);}
void sendControls(){switch(screen){${sendActions}}}
void heldControls(){${heldActions}}
${destination}
int main(){
 for(auto state:{VoiceStage::Uploading,VoiceStage::Transcribing,VoiceStage::Review,VoiceStage::Ready,VoiceStage::Failed,VoiceStage::Sent}){
  voice.value=state; voice.resolved=false; press(); assert(captures==0);
 }
 voice.value=VoiceStage::Idle; voice.resolved=true;
 heldContact=false; press(); assert(captures==0);
 heldContact=true; event.contactId=8; press(); assert(captures==0);
 event.contactId=7; press(); assert(captures==1);
 voice.value=VoiceStage::Failed; voice.resolved=false; voice.job=true;
 sendControls(); assert(controls.size()==2 && controls[0]==Act::VoiceStatus && controls[1]==Act::VoiceConsole);
 controls.clear(); enabled.clear(); voice.resolved=true;
 sendControls(); assert(controls.size()==3 && controls[2]==Act::VoiceDismiss);
 controls.clear(); enabled.clear(); voice.value=VoiceStage::Review; voice.resolved=false;
 sendControls(); assert(controls.size()==2);
 controls.clear(); enabled.clear(); voice.reason="gateway_approval"; voice.command="original-command";
 sendControls(); assert(controls.size()==3 && controls[0]==Act::VoiceReview);
 voice.reason=""; voice.command="";
 controls.clear(); enabled.clear(); clipHeld=true;
 heldControls(); assert(controls.size()==2 && controls[0]==Act::VoiceConsole && controls[1]==Act::SendClip);
 controls.clear(); enabled.clear(); gw->c.threadId="thread-b";
 heldControls(); assert(!enabled[1]);
 voice.value=VoiceStage::Recorded; paintMicDestination();
 assert(labels[0]=="RECORDED FOR" && labels[1]=="Original thread A");
}
`;
  await writeFile(join(dir,"check.cpp"), code);
  const compiled = spawnSync(compiler,["-std=c++17",join(dir,"check.cpp"),"-o",join(dir,"check")],{encoding:"utf8"});
  assert.equal(compiled.status,0,compiled.stderr);
  const run=spawnSync(join(dir,"check"),[],{encoding:"utf8"});
  assert.equal(run.status,0,run.stderr);
});


test("actual voice recovery routes exact approvals and transfers Sent cursor before replacing the capture", async (t) => {
  const compiler=process.env.CXX||"c++";
  if(spawnSync(compiler,["--version"]).error?.code==="ENOENT")return t.skip("Native compiler unavailable");
  const source=await readFile(process.env.HOSYOND_UI_SOURCE??"firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp","utf8");
  const reviewStart=source.indexOf("    case Act::VoiceReview:");
  const dismissStart=source.indexOf("    case Act::VoiceDismiss:");
  assert.ok(reviewStart>=0,"Exact voice review route must be present");
  const review=source.slice(reviewStart,source.indexOf("    case Act::VoiceStatus:",reviewStart));
  const dismiss=source.slice(dismissStart,source.indexOf("    case Act::Talk:",dismissStart));
  const dir=await mkdtemp(join(tmpdir(),"hosyond-voice-cursor-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const code=`
#include <cassert>
// Fixed-width types need an explicit include: libc++ pulls <cstdint> in through <string>, libstdc++ (GCC/Ubuntu CI) does not.
#include <cstdint>
#include <string>
#include <vector>
#include <functional>
using String=std::string;
enum class VoiceStage{Sent,Review};enum class Screen{Send,Approvals};enum class Act{VoiceReview,VoiceDismiss};
struct Voice{
 String media="media-original",after="cursor-original",command="command-original",reason="gateway_approval";
 VoiceStage value=VoiceStage::Sent;bool resolved=true;int resets=0;
 const String& mediaId()const{return media;}const String& responseAfter()const{return after;}
 const String& commandId()const{return command;}const String& reviewReason()const{return reason;}
 VoiceStage stage()const{return value;}bool canDismissCapture()const{return resolved;}
 void reset(){++resets;after="";media="";command="";}
}voice;
struct PendingApproval{String commandId;};struct Context{String environmentId="environment-a",threadId="thread-a";};
struct Gateway{Context ctx;String cursor;bool opened=false,changeDuringOpen=false;std::vector<PendingApproval> approvals;
 const Context& context()const{return ctx;}void lockState(){}void unlockState(){}
 void openResponse(const String& after){cursor=after;opened=true;if(changeDuringOpen){ctx.threadId="thread-b";opened=false;cursor="";}}
 bool responseOpen()const{return opened;}void refreshApprovals(){}
 size_t approvalCount()const{return approvals.size();}const PendingApproval* approval(size_t i)const{return &approvals[i];}
}gateway;Gateway*gw=&gateway;
String voiceCaptureEnvironment="environment-a",voiceCaptureThread="thread-a",message;
bool uiOperationSucceeded=false,contentDirty=false,acceptQueue=true;
uint32_t navigationGeneration=0;size_t approvalIndex=0;Screen screen=Screen::Send;
std::function<void()>work,completion;
bool uiNetworkBusy(){return bool(work);}void goTo(Screen value){screen=value;}
bool enqueueUiNetworkJob(std::function<void()>a,std::function<void()>b){if(!acceptQueue)return false;work=a;completion=b;return true;}
void drain(){work();work=nullptr;auto callback=completion;completion=nullptr;callback();}
void action(Act id){switch(id){${review}${dismiss}}}
void resetFixture(){voice=Voice();gateway=Gateway();work=nullptr;completion=nullptr;acceptQueue=true;screen=Screen::Send;navigationGeneration=0;}
int main(){
 resetFixture();voice.resolved=false;action(Act::VoiceDismiss);assert(!work && voice.resets==0);
 resetFixture();acceptQueue=false;action(Act::VoiceDismiss);assert(voice.resets==0 && voice.after=="cursor-original");
 resetFixture();action(Act::VoiceDismiss);assert(voice.resets==0 && work);drain();assert(gateway.cursor=="cursor-original" && voice.resets==1);
 resetFixture();gateway.ctx.threadId="thread-b";action(Act::VoiceDismiss);drain();assert(voice.resets==0 && voice.after=="cursor-original");
 resetFixture();gateway.changeDuringOpen=true;action(Act::VoiceDismiss);drain();assert(voice.resets==0 && voice.after=="cursor-original");
 resetFixture();voice.value=VoiceStage::Review;gateway.approvals={{"unrelated"},{"command-original"}};
 action(Act::VoiceReview);drain();assert(screen==Screen::Approvals && approvalIndex==1);
 resetFixture();gateway.approvals={{"unrelated"}};action(Act::VoiceReview);drain();assert(screen==Screen::Send);
 resetFixture();gateway.approvals={{"command-original"}};action(Act::VoiceReview);++navigationGeneration;drain();assert(screen==Screen::Send);
}
`;
  await writeFile(join(dir,"check.cpp"),code);
  const compiled=spawnSync(compiler,["-std=c++17",join(dir,"check.cpp"),"-o",join(dir,"check")],{encoding:"utf8"});assert.equal(compiled.status,0,compiled.stderr);
  const run=spawnSync(join(dir,"check"),[],{encoding:"utf8"});assert.equal(run.status,0,run.stderr);
});
