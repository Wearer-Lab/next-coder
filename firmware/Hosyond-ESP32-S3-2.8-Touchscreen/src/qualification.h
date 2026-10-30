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
enum class Kind : uint8_t { Invalid, Status, Drop, Portal, Close, Stress, Reply, Verify };
struct Command { Kind kind = Kind::Invalid; uint16_t count = 0; };
inline Command parse(const char* line) {
  if (!line || strncmp(line,"NCQUAL ",7)!=0) return {};
  const char* verb=line+7;
  if(strcmp(verb,"STATUS")==0)return {Kind::Status,0};
  if(strcmp(verb,"DROP")==0)return {Kind::Drop,0};
  if(strcmp(verb,"PORTAL")==0)return {Kind::Portal,0};
  if(strcmp(verb,"CLOSE")==0)return {Kind::Close,0};
  if(strcmp(verb,"REPLY")==0)return {Kind::Reply,0};
  if(strcmp(verb,"VERIFY")==0)return {Kind::Verify,0};
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
