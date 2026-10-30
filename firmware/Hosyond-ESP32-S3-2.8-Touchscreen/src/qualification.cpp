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

// ---- LATENCY batch -----------------------------------------------------------------------------
// One scripted interaction repeated N times, each timed on THIS clock (millis()) and reported as one
// JSON line. It runs from the same loop pass as everything else here: no task, no stack, and the
// only UI entry points are the three that already exist, so a touch handler never reaches HTTP.
//
// What the device can honestly time, and what it cannot:
//   inject  just before uiQualificationStep(), i.e. the instant a finger would have been decoded
//   accept  the step returned true (it only queues the gateway job; it never waits for it)
//   settle  uiQualificationBusy() fell: the job slot is free and uiTick() has already run the
//           completion and repainted, because uiTick() precedes this function in loop()
// The device does NOT see the request boundaries - GatewayTls prints them ([tls-heap] foreground.*)
// without a timestamp. Every line here therefore carries t_ms so the host can map its own arrival
// times onto this clock and split settle into queue / network / tail. A "frame committed" counter
// would make settle exact; ui.cpp has none, so settle is "within one loop pass of the repaint".
constexpr uint32_t kLatencyStepRetryMs=2000;       // lock contention on the model; a real stall beyond this
constexpr uint32_t kLatencyIdleWaitMs=30000;       // the UI never went idle (a stuck modal or screen)
constexpr uint32_t kLatencyIterationTimeoutMs=30000; // matches Stress's per-step ceiling
constexpr uint32_t kLatencyBatchBudgetMs=30*60*1000u;
constexpr uint32_t kLatencyAfterResetMs=100;       // ~3 frames: the reset screen is painted before the timed step
enum class Phase : uint8_t { Idle, Due, Reset, Inject, Wait };
struct Series {
  uint32_t count=0,minimum=UINT32_MAX,maximum=0,sum=0;
  void add(uint32_t value){++count;sum+=value;if(value<minimum)minimum=value;if(value>maximum)maximum=value;}
};
struct Latency {
  bool active=false,attempting=false,sawBusy=false;
  Phase phase=Phase::Idle;
  qualification::Scenario scenario=qualification::Scenario::None;
  qualification::ScenarioSteps steps{0,0};
  uint16_t requested=0,completed=0,networkIterations=0;
  uint32_t delayMs=0,startedAt=0,phaseAt=0,dueAt=0;
  uint32_t injectAt=0,acceptAt=0,busyAt=0,retries=0,retriesTotal=0,iterGapMax=0,batchGapMax=0;
  Series total,busy;
} lat;

// All strings emitted here are fixed vocabulary or enum labels. Never print input lines,
// SSIDs, credentials, context IDs, titles, prompts, transcripts, or response content.
// t_ms is this board's millis() at the instant of printing. The host's latency script takes the
// minimum of (arrival time - t_ms) over every event as its clock offset, so each event is also a
// clock-sync sample; it adds one integer and no new vocabulary.
void event(const char* name,const char* phase,bool accepted=false) {
  Serial.printf("[ncqual] {\"event\":\"%s\",\"phase\":\"%s\",\"accepted\":%s,\"completed\":false,\"stress_steps\":%u,\"t_ms\":%u}\n",
    name,phase,accepted?"true":"false",static_cast<unsigned>(stressCompleted),static_cast<unsigned>(millis()));
}
void status(Provisioning& provisioning,GatewayClient& gateway) {
  Serial.printf("[ncqual] {\"event\":\"status\",\"uptime_ms\":%u,\"heap\":%u,\"heap_min\":%u,\"tick_gap_max_ms\":%u,\"wifi_connected\":%s,\"provisioning\":\"%s\",\"gateway\":\"%s\",\"portal\":%s,\"ui_busy\":%s,\"stress_active\":%s,\"stress_requested\":%u,\"stress_steps\":%u,\"verify_issued\":%s,\"verify_waiting\":%s,\"command_completed\":false}\n",
    static_cast<unsigned>(millis()),static_cast<unsigned>(ESP.getFreeHeap()),static_cast<unsigned>(minimumHeap),static_cast<unsigned>(maxTickGap),
    WiFi.status()==WL_CONNECTED?"true":"false",provisioningStateName(provisioning.status().state),gatewayLinkName(gateway.link()),
    provisioning.configPortalActive()?"true":"false",uiQualificationBusy()?"true":"false",stress?"true":"false",
    static_cast<unsigned>(stressRequested),static_cast<unsigned>(stressCompleted),verifyConsumed?"true":"false",verifyWaiting?"true":"false");
}
enum class Binding : uint8_t { Unavailable, Same, Changed };
// Unavailable means only that the model lock was busy this pass; try again next pass.
Binding bindingState(GatewayClient& gateway) {
  if(!gateway.tryLockState(0))return Binding::Unavailable;
  const auto& context=gateway.context();
  const bool same=context.environmentId==originalEnvironment && context.projectId==originalProject && context.threadId==originalThread;
  gateway.unlockState();
  return same?Binding::Same:Binding::Changed;
}
bool snapshotBinding(GatewayClient& gateway,bool compare) {
  if(compare) {
    const Binding state=bindingState(gateway);
    if(state==Binding::Changed){stress=false;event("stress","binding_changed");}
    return state==Binding::Same;
  }
  if(!gateway.tryLockState(0))return false;
  const auto& context=gateway.context();
  originalEnvironment=context.environmentId;originalProject=context.projectId;originalThread=context.threadId;
  gateway.unlockState();return true;
}
void seriesJson(const char* name,const Series& series) {
  Serial.printf("\"%s\":{\"count\":%u,\"min\":%u,\"max\":%u,\"mean\":%u}",name,static_cast<unsigned>(series.count),
    static_cast<unsigned>(series.count?series.minimum:0),static_cast<unsigned>(series.maximum),
    static_cast<unsigned>(series.count?(series.sum+series.count/2)/series.count:0));
}
void latencyRefused(const char* reason) {
  Serial.printf("[ncqual] {\"event\":\"latency\",\"phase\":\"refused\",\"reason\":\"%s\",\"accepted\":false,\"t_ms\":%u}\n",
    reason,static_cast<unsigned>(millis()));
}
// Ends the batch. `finished` is true only when every requested iteration completed; anything else is
// an abort whose reason the host must treat as a failed measurement, never a short successful one.
void latencyFinish(bool finished,const char* reason) {
  if(!lat.active)return;
  lat.active=false;lat.phase=Phase::Idle;
  Serial.printf("[ncqual] {\"event\":\"latency\",\"phase\":\"%s\",\"reason\":\"%s\",\"accepted\":true,\"t_ms\":%u,\"scenario\":\"%s\",\"requested\":%u,\"completed\":%u,\"network_iterations\":%u,\"local_iterations\":%u,\"step_retries\":%u,\"elapsed_ms\":%u,\"heap_min\":%u,\"tick_gap_max_ms\":%u,",
    finished?"finished":"aborted",reason,static_cast<unsigned>(millis()),qualification::scenarioName(lat.scenario),
    static_cast<unsigned>(lat.requested),static_cast<unsigned>(lat.completed),static_cast<unsigned>(lat.networkIterations),
    static_cast<unsigned>(lat.completed-lat.networkIterations),static_cast<unsigned>(lat.retriesTotal),
    static_cast<unsigned>(millis()-lat.startedAt),static_cast<unsigned>(minimumHeap),static_cast<unsigned>(lat.batchGapMax));
  seriesJson("total_ms",lat.total);Serial.print(",");seriesJson("busy_ms",lat.busy);Serial.print("}\n");
}
void latencyStart(const qualification::Command& input,GatewayClient& gateway) {
  using qualification::Scenario;
  // A measurement over a dead link is a timeout dressed as a number. LOCAL needs neither.
  if(uiQualificationBusy() || verifyWaiting){latencyRefused("busy");return;}
  if(input.scenario!=Scenario::Local) {
    if(WiFi.status()!=WL_CONNECTED){latencyRefused("offline");return;}
    if(gateway.link()!=GatewayLink::Claimed){latencyRefused("gateway_not_claimed");return;}
  }
  if(!snapshotBinding(gateway,false)){latencyRefused("busy");return;}
  lat=Latency{};
  lat.active=true;lat.phase=Phase::Due;lat.scenario=input.scenario;lat.steps=qualification::stepsFor(input.scenario);
  lat.requested=input.count;lat.delayMs=input.delayMs;
  lat.startedAt=lat.phaseAt=lat.dueAt=millis();
  Serial.printf("[ncqual] {\"event\":\"latency\",\"phase\":\"started\",\"accepted\":true,\"t_ms\":%u,\"scenario\":\"%s\",\"step\":%u,\"reset_step\":%u,\"iterations\":%u,\"delay_ms\":%u,\"iteration_timeout_ms\":%u}\n",
    static_cast<unsigned>(millis()),qualification::scenarioName(lat.scenario),static_cast<unsigned>(lat.steps.step),
    static_cast<unsigned>(lat.steps.reset),static_cast<unsigned>(lat.requested),static_cast<unsigned>(lat.delayMs),
    static_cast<unsigned>(kLatencyIterationTimeoutMs));
}
void latencyIteration(uint32_t settleAt,bool timedOut) {
  const uint32_t totalMs=settleAt-lat.injectAt,busyMs=settleAt-lat.acceptAt;
  Serial.printf("[ncqual] {\"event\":\"latency_iter\",\"i\":%u,\"scenario\":\"%s\",\"t_ms\":%u,\"t_inject_ms\":%u,\"t_accept_ms\":%u,\"t_busy_ms\":%u,\"t_settle_ms\":%u,\"accept_ms\":%u,\"busy_ms\":%u,\"total_ms\":%u,\"network\":%s,\"retries\":%u,\"timeout\":%s,\"tick_gap_max_ms\":%u,\"heap\":%u,\"screen\":\"%s\"}\n",
    static_cast<unsigned>(lat.completed+1),qualification::scenarioName(lat.scenario),static_cast<unsigned>(millis()),
    static_cast<unsigned>(lat.injectAt),static_cast<unsigned>(lat.acceptAt),static_cast<unsigned>(lat.sawBusy?lat.busyAt:0),
    static_cast<unsigned>(settleAt),static_cast<unsigned>(lat.acceptAt-lat.injectAt),static_cast<unsigned>(busyMs),
    static_cast<unsigned>(totalMs),lat.sawBusy?"true":"false",static_cast<unsigned>(lat.retries),timedOut?"true":"false",
    static_cast<unsigned>(lat.iterGapMax),static_cast<unsigned>(ESP.getFreeHeap()),uiBenchScreenName());
}
void latencyTick(uint32_t now,uint32_t gap,GatewayClient& gateway) {
  if(!lat.active)return;
  if(lat.attempting && gap>lat.iterGapMax)lat.iterGapMax=gap;
  if(gap>lat.batchGapMax)lat.batchGapMax=gap;
  if(now-lat.startedAt>kLatencyBatchBudgetMs){latencyFinish(false,"batch_timeout");return;}
  const bool busy=uiQualificationBusy();
  switch(lat.phase) {
    case Phase::Due: {
      if(static_cast<int32_t>(now-lat.dueAt)<0)return;
      // The clock for an iteration starts only once nothing else holds the job slot; a poll that
      // happens to be in flight is not part of what the tap cost.
      if(busy){if(now-lat.phaseAt>kLatencyIdleWaitMs)latencyFinish(false,"never_idle");return;}
      const Binding state=bindingState(gateway);
      if(state==Binding::Changed){latencyFinish(false,"binding_changed");return;}
      if(state==Binding::Unavailable)return;
      lat.phase=Phase::Reset;lat.phaseAt=now;return;
    }
    case Phase::Reset:
      // Untimed. Navigation only; it exists so the timed step always starts from Home.
      if(busy)return;
      if(!uiQualificationStep(lat.steps.reset)){if(now-lat.phaseAt>kLatencyStepRetryMs)latencyFinish(false,"step_refused");return;}
      lat.phase=Phase::Inject;lat.phaseAt=now;lat.dueAt=now+kLatencyAfterResetMs;lat.attempting=false;return;
    case Phase::Inject: {
      if(static_cast<int32_t>(now-lat.dueAt)<0)return;
      if(busy){lat.attempting=false;if(now-lat.phaseAt>kLatencyIdleWaitMs)latencyFinish(false,"never_idle");return;}
      // A refusal here is the model lock being held for a parse (tryLockState(0)); the finger would
      // have felt the same wait, so the clock keeps running across retries instead of restarting.
      if(!lat.attempting){lat.attempting=true;lat.injectAt=millis();lat.retries=0;lat.iterGapMax=0;}
      if(!uiQualificationStep(lat.steps.step)) {
        ++lat.retries;++lat.retriesTotal;
        if(millis()-lat.injectAt>kLatencyStepRetryMs)latencyFinish(false,"step_refused");
        return;
      }
      lat.acceptAt=millis();
      // step() submits its gateway job synchronously, so busy is already true here when there is one.
      lat.sawBusy=uiQualificationBusy();lat.busyAt=lat.sawBusy?lat.acceptAt:0;
      lat.phase=Phase::Wait;lat.phaseAt=lat.acceptAt;return;
    }
    case Phase::Wait: {
      if(busy){
        lat.sawBusy=true;if(!lat.busyAt)lat.busyAt=millis();
        if(now-lat.phaseAt>kLatencyIterationTimeoutMs){latencyIteration(millis(),true);latencyFinish(false,"timeout");}
        return;
      }
      // First pass after the slot freed (or, with no job, first pass after the step): uiTick() ran
      // earlier in this same loop pass, so the completion callback and the repaint it triggered are done.
      const uint32_t settleAt=millis();
      latencyIteration(settleAt,false);
      lat.total.add(settleAt-lat.injectAt);lat.busy.add(settleAt-lat.acceptAt);
      if(lat.sawBusy)++lat.networkIterations;
      ++lat.completed;lat.attempting=false;
      if(lat.completed>=lat.requested){latencyFinish(true,"completed");return;}
      lat.phase=Phase::Due;lat.phaseAt=settleAt;lat.dueAt=settleAt+lat.delayMs;
      return;
    }
    default:return;
  }
}

void command(const qualification::Command& input,Provisioning& provisioning,GatewayClient& gateway) {
  using qualification::Kind;
  if(input.kind==Kind::Status){status(provisioning,gateway);return;}
  if(input.kind==Kind::Cancel) {
    const bool wasRunning=stress||lat.active;
    stress=false;
    if(lat.active)latencyFinish(false,"cancelled");
    event("cancel",wasRunning?"stopped":"nothing_running",wasRunning);return;
  }
  if(input.kind==Kind::Invalid){event("input","invalid");return;}
  // One batch at a time, and no fault injection under either: a dropped station mid-measurement
  // would be recorded as a slow request.
  if(stress){event("input","stress_in_progress");return;}
  if(lat.active){event("input","latency_in_progress");return;}
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
    case Kind::Latency:latencyStart(input,gateway);return;
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
  const uint32_t gap=lastTickAt?now-lastTickAt:0;
  if(gap>maxTickGap)maxTickGap=gap;
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
  latencyTick(now,gap,gateway);
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
