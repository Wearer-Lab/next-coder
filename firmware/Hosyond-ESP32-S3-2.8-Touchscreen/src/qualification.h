#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#ifndef HOSYOND_QUALIFICATION
#define HOSYOND_QUALIFICATION 0
#endif
#if HOSYOND_QUALIFICATION && (!BENCH_SELFTEST || !HOSYOND_QUALIFICATION_ALLOWED)
#error "Qualification requires the explicitly enabled hosyond-es3c28p-bench build"
#endif

#if HOSYOND_QUALIFICATION && (!ARDUINO_USB_MODE || !ARDUINO_USB_CDC_ON_BOOT)
#error "Qualification input is restricted to native USB CDC"
#endif

class Provisioning;
class GatewayClient;
class DeviceStore;

#if BENCH_SELFTEST && HOSYOND_QUALIFICATION
namespace qualification {
constexpr size_t kLineCapacity = 80;
enum class Kind : uint8_t { Invalid, Status, Drop, Portal, Close, Stress, Reply, Verify, Latency, Cancel };
// What a LATENCY batch repeats. Each is one existing uiQualificationStep() plus an untimed reset step
// that returns the UI to Home first, so every iteration starts from the same screen and the numbers
// are a distribution of one interaction rather than a walk through ten different ones (which is what
// Stress deliberately is). Names are the only thing a host can ask for: it cannot name a step number,
// so a typo cannot reach the one mutating step (2 selects a thread).
//   LOCAL    step 4 (open Actions)     no network request: the noise floor of the harness itself
//   THREADS  step 1 (open Threads)     one gateway read, always issued
//   REPLY    step 8 (open the reply)   one gateway read, but the UI skips it inside kReplyFreshMs, so
//                                      a delay under ~5 s measures nothing; the host flags those
enum class Scenario : uint8_t { None, Local, Threads, Reply };
constexpr uint16_t kLatencyMaxIterations = 200;
constexpr uint32_t kLatencyMaxDelayMs = 60000;
struct Command { Kind kind = Kind::Invalid; uint16_t count = 0; Scenario scenario = Scenario::None; uint32_t delayMs = 0; };
struct ScenarioSteps { uint8_t reset; uint8_t step; };
inline ScenarioSteps stepsFor(Scenario scenario) {
  switch(scenario) {
    case Scenario::Local:return {0,4};
    case Scenario::Threads:return {0,1};
    case Scenario::Reply:return {0,8};
    default:return {0,0};
  }
}
inline const char* scenarioName(Scenario scenario) {
  switch(scenario) {
    case Scenario::Local:return "LOCAL";
    case Scenario::Threads:return "THREADS";
    case Scenario::Reply:return "REPLY";
    default:return "NONE";
  }
}
// Canonical decimal only: no sign, no leading zero, at most nine digits, bounded. Advances `p` past
// the digits and leaves the caller to check what follows.
inline bool readNumber(const char*& p, uint32_t maximum, uint32_t& out) {
  if(*p<'0' || *p>'9')return false;
  if(*p=='0' && p[1]>='0' && p[1]<='9')return false;
  uint32_t value=0;size_t digits=0;
  while(*p>='0' && *p<='9'){
    if(++digits>9)return false;
    value=value*10+static_cast<uint32_t>(*p-'0');++p;
  }
  if(value>maximum)return false;
  out=value;return true;
}
inline Command parse(const char* line) {
  if (!line || strncmp(line,"NCQUAL ",7)!=0) return {};
  const char* verb=line+7;
  if(strcmp(verb,"STATUS")==0)return {Kind::Status,0};
  if(strcmp(verb,"DROP")==0)return {Kind::Drop,0};
  if(strcmp(verb,"PORTAL")==0)return {Kind::Portal,0};
  if(strcmp(verb,"CLOSE")==0)return {Kind::Close,0};
  if(strcmp(verb,"REPLY")==0)return {Kind::Reply,0};
  if(strcmp(verb,"VERIFY")==0)return {Kind::Verify,0};
  // Stops whichever batch is running. Without it a host that times out would leave the device
  // stepping through its UI with nobody listening.
  if(strcmp(verb,"CANCEL")==0)return {Kind::Cancel,0};
  if(strncmp(verb,"LATENCY ",8)==0) {
    // LATENCY <LOCAL|THREADS|REPLY> <iterations 1..200> <delay_ms 0..60000>, all three required.
    const char* p=verb+8;
    Scenario scenario=Scenario::None;
    const struct { const char* name; Scenario value; } names[]={{"LOCAL",Scenario::Local},{"THREADS",Scenario::Threads},{"REPLY",Scenario::Reply}};
    for(const auto& candidate:names) {
      const size_t length=strlen(candidate.name);
      if(strncmp(p,candidate.name,length)==0 && p[length]==' '){scenario=candidate.value;p+=length+1;break;}
    }
    if(scenario==Scenario::None)return {};
    uint32_t iterations=0,delay=0;
    if(!readNumber(p,kLatencyMaxIterations,iterations) || iterations<1 || *p!=' ')return {};
    ++p;
    if(!readNumber(p,kLatencyMaxDelayMs,delay) || *p!='\0')return {};
    return {Kind::Latency,static_cast<uint16_t>(iterations),scenario,delay};
  }
  if(strncmp(verb,"STRESS ",7)!=0)return {};
  const char* count=verb+7;
  if(*count<'1' || *count>'9')return {};
  uint16_t value=0;
  for(size_t i=0;count[i];++i){
    if(i>=3 || count[i]<'0' || count[i]>'9')return {};
    value=static_cast<uint16_t>(value*10+count[i]-'0');
  }
  return value<=500?Command{Kind::Stress,value}:Command{};
}
}
void qualificationBegin();
void qualificationTick(Provisioning&,GatewayClient&,DeviceStore&);
#else
inline void qualificationBegin() {}
inline void qualificationTick(Provisioning&,GatewayClient&,DeviceStore&) {}
#endif
