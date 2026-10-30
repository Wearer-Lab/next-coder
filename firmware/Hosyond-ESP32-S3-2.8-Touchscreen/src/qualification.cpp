#include "qualification.h"
#if BENCH_SELFTEST && HOSYOND_QUALIFICATION
#include <Arduino.h>
#include <WiFi.h>
#include <DeviceStore.h>
#include <GatewayClient.h>
#include <Provisioning.h>
#include "ui.h"

namespace {
char line[qualification::kLineCapacity]{};
size_t used=0;
bool overflow=false;
bool ready=false;
bool stress=false;
bool verifyConsumed=false,verifyWaiting=false,verifyBusyObserved=false;
uint16_t stressRequested=0,stressCompleted=0;
uint32_t nextStepAt=0,stepStartedAt=0,stressStartedAt=0,lastTickAt=0,maxTickGap=0;
uint32_t minimumHeap=UINT32_MAX;
String originalEnvironment,originalProject,originalThread;

// All strings emitted here are fixed vocabulary or enum labels. Never print input lines,
// SSIDs, credentials, context IDs, titles, prompts, transcripts, or response content.
void event(const char* name,const char* phase,bool accepted=false) {
  Serial.printf("[ncqual] {\"event\":\"%s\",\"phase\":\"%s\",\"accepted\":%s,\"completed\":false,\"stress_steps\":%u}\n",
    name,phase,accepted?"true":"false",static_cast<unsigned>(stressCompleted));
}
void status(Provisioning& provisioning,GatewayClient& gateway) {
  Serial.printf("[ncqual] {\"event\":\"status\",\"uptime_ms\":%u,\"heap\":%u,\"heap_min\":%u,\"tick_gap_max_ms\":%u,\"wifi_connected\":%s,\"provisioning\":\"%s\",\"gateway\":\"%s\",\"portal\":%s,\"ui_busy\":%s,\"stress_active\":%s,\"stress_requested\":%u,\"stress_steps\":%u,\"verify_issued\":%s,\"verify_waiting\":%s,\"command_completed\":false}\n",
    static_cast<unsigned>(millis()),static_cast<unsigned>(ESP.getFreeHeap()),static_cast<unsigned>(minimumHeap),static_cast<unsigned>(maxTickGap),
    WiFi.status()==WL_CONNECTED?"true":"false",provisioningStateName(provisioning.status().state),gatewayLinkName(gateway.link()),
    provisioning.configPortalActive()?"true":"false",uiQualificationBusy()?"true":"false",stress?"true":"false",
    static_cast<unsigned>(stressRequested),static_cast<unsigned>(stressCompleted),verifyConsumed?"true":"false",verifyWaiting?"true":"false");
}
bool snapshotBinding(GatewayClient& gateway,bool compare) {
  if(!gateway.tryLockState(0))return false;
  const auto& context=gateway.context();
  if(compare) {
    const bool same=context.environmentId==originalEnvironment && context.projectId==originalProject && context.threadId==originalThread;
    gateway.unlockState();
    if(!same){stress=false;event("stress","binding_changed");}
    return same;
  }
  originalEnvironment=context.environmentId;originalProject=context.projectId;originalThread=context.threadId;
  gateway.unlockState();return true;
}
void command(const qualification::Command& input,Provisioning& provisioning,GatewayClient& gateway) {
  using qualification::Kind;
  if(input.kind==Kind::Status){status(provisioning,gateway);return;}
  if(input.kind==Kind::Invalid){event("input","invalid");return;}
  if(stress){event("input","stress_in_progress");return;}
  switch(input.kind){
    case Kind::Drop:
      // Fault injection only: disconnect station once without powering the radio down or erasing NVS.
      {const bool accepted=WiFi.disconnect(false,false);event("drop","requested",accepted);return;}
    case Kind::Portal:provisioning.openConfigPortal();event("portal","requested",true);return;
    case Kind::Close:provisioning.closeConfigPortal();event("close","requested",true);return;
    case Kind::Stress:
      if(uiQualificationBusy() || !snapshotBinding(gateway,false)){event("stress","busy");return;}
      stressRequested=input.count;stressCompleted=0;stress=true;
      nextStepAt=stepStartedAt=stressStartedAt=millis();event("stress","started",true);return;
    case Kind::Reply:
      if(uiQualificationBusy()){event("reply","busy");return;}
      {const bool accepted=uiQualificationStep(8);event("reply",accepted?"queued":"unavailable",accepted);return;}
    case Kind::Verify:
      if(verifyConsumed){event("verify","already_issued_this_boot");return;}
      if(uiQualificationBusy()){event("verify","busy");return;}
      if(!uiQualificationVerify()){event("verify","unavailable");return;}
      verifyConsumed=true;verifyWaiting=true;verifyBusyObserved=uiQualificationBusy();
      event("verify","queued",true);return;
    default:return;
  }
}
}
void qualificationBegin() { ready=true;minimumHeap=ESP.getFreeHeap();event("qualification","usb_ready"); }
void qualificationTick(Provisioning& provisioning,GatewayClient& gateway,DeviceStore& store) {
  (void)store; // Fault injection never writes or clears persistent state.
  if(!ready)return;
  const uint32_t now=millis();
  const uint32_t heap=ESP.getFreeHeap();if(heap<minimumHeap)minimumHeap=heap;
  if(lastTickAt && now-lastTickAt>maxTickGap)maxTickGap=now-lastTickAt;
  lastTickAt=now;
  for(uint8_t budget=0;budget<16 && Serial.available()>0;++budget){
    const int value=Serial.read();if(value<0)break;
    if(value=='\r')continue;
    if(value=='\n'){
      if(overflow)event("input","line_too_long");
      else {line[used]='\0';command(qualification::parse(line),provisioning,gateway);}
      used=0;overflow=false;continue;
    }
    if(value<32 || value>126){overflow=true;continue;}
    if(used+1>=sizeof(line)){overflow=true;continue;}
    line[used++]=static_cast<char>(value);
  }
  if(verifyWaiting){
    if(uiQualificationBusy())verifyBusyObserved=true;
    else if(verifyBusyObserved){verifyWaiting=false;event("verify","ui_settled_not_t3_completion");}
  }
  if(!stress)return;
  if(now-stressStartedAt>15*60*1000u || now-stepStartedAt>30000u){stress=false;event("stress","timeout");return;}
  if(static_cast<int32_t>(now-nextStepAt)<0 || uiQualificationBusy())return;
  nextStepAt=now+250;
  if(!snapshotBinding(gateway,true))return;
  if(!uiQualificationStep(static_cast<uint8_t>(stressCompleted%10)))return;
  ++stressCompleted;stepStartedAt=millis();
  if(stressCompleted>=stressRequested){stress=false;event("stress","local_steps_finished",true);status(provisioning,gateway);}
}
#endif
