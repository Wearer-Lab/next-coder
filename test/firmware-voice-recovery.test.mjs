import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("firmware voice recovery bounds retries and never permits device credentials on foreign upload URLs", async (t) => {
  const compiler = process.env.CXX || "c++";
  const available = spawnSync(compiler, ["--version"], { encoding: "utf8" });
  if (available.error?.code === "ENOENT") return t.skip("A native C++ compiler is unavailable.");
  assert.equal(available.status, 0);
  const directory = await mkdtemp(join(tmpdir(), "next-coder-voice-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "Arduino.h"), `#pragma once
#include <cstdint>
#include <cstddef>
#include <string>
#include <algorithm>
using std::min;
class String {
  std::string value_;
 public:
  String(const char* value = "") : value_(value) {}
  size_t length() const { return value_.length(); }
  char charAt(size_t index) const { return value_.at(index); }
};
`);
  await writeFile(join(directory, "Stream.h"), `#pragma once
#include "Arduino.h"
class Stream {
 public:
  virtual ~Stream() = default;
  virtual int available() = 0;
  virtual int read() = 0;
  virtual int peek() = 0;
  virtual size_t readBytes(char*, size_t) = 0;
  virtual size_t write(uint8_t) = 0;
  virtual void flush() = 0;
};
`);
  await writeFile(join(directory, "check.cpp"), `#include <cassert>
#include <climits>
#include "MediaUploadPolicy.h"
#include "VoicePollSchedule.h"
#include "MediaUpload.h"
#include "PcmCaptureStats.h"
int main() {
  // Full-scale negative PCM is 32768 in magnitude and must not overflow signed int16 math.
  // Long recordings must produce the same diagnostics incrementally as a final reference scan.
  media::PcmCaptureStats stats;
  int64_t sum = 0;
  uint64_t squares = 0;
  for (int i = 0; i < 512000; ++i) {
    const int16_t sample = i % 3 == 0 ? INT16_MIN : i % 3 == 1 ? INT16_MAX : 0;
    stats.add(sample);
    sum += sample;
    squares += static_cast<uint64_t>(static_cast<int64_t>(sample) * sample);
  }
  assert(stats.count == 512000 && stats.peak == 32768);
  assert(stats.sum == sum && stats.squares == squares);
  stats = media::PcmCaptureStats();
  assert(stats.count == 0 && stats.peak == 0 && stats.squares == 0 && stats.sum == 0);
  // Exercise the actual two-segment stream through short reads and a segment boundary. A retry
  // creates a fresh stream and must reproduce every byte, including zeros and 0xff.
  const uint8_t header[] = {0, 1, 255};
  const uint8_t pcm[] = {2, 0, 128, 3};
  const std::string expected("\\0\\1\\xff\\2\\0\\x80\\3", 7);
  for (int attempt = 0; attempt < 2; ++attempt) {
    media::SegmentedBodyStream stream(header, sizeof(header), pcm, sizeof(pcm));
    assert(stream.contentLength() == 7 && stream.available() == 7);
    assert(stream.peek() == 0 && stream.available() == 7);
    std::string bytes;
    char buffer[2];
    while (stream.available()) {
      const size_t count = stream.readBytes(buffer, sizeof(buffer));
      assert(count > 0 && count <= sizeof(buffer));
      bytes.append(buffer, count);
    }
    assert(bytes == expected && stream.read() == -1 && stream.peek() == -1);
    assert(stream.readBytes(buffer, sizeof(buffer)) == 0);
  }
  media::SegmentedBodyStream empty(nullptr, 0, nullptr, 0);
  assert(empty.available() == 0 && empty.read() == -1);
  using upload_policy::credentialPathAllowed;
  assert(credentialPathAllowed("/v1/device/media/uploads"));
  assert(credentialPathAllowed("/v1/device/media/uploads/upload_123/content"));
  assert(credentialPathAllowed("/v1/device/media/uploads/upload_123/finalize"));
  const char* attacks[] = {nullptr, "", "https://evil.test/v1/device/media/uploads/x", "//evil.test/upload",
    "/v1/device/media/uploads-evil", "/v1/device/media/uploads/../../admin", "/v1/device/media/uploads/x?redirect=evil",
    "/v1/device/media/uploads/x#fragment", "/v1/device/media/uploads/x\\\\host", "/v1/device/media/uploads/x\\nsecret",
    "/v1/device/media/uploads//evil"};
  for (const char* path : attacks) assert(!credentialPathAllowed(path));
  assert(upload_policy::retryDelay(-1) == 1000);
  assert(upload_policy::retryDelay(0) == 1000);
  assert(upload_policy::retryDelay(60) == 60000);
  assert(upload_policy::retryDelay(INT_MAX) == 300000);
  assert(voice_poll::retryDelay(1) == 4000);
  assert(voice_poll::retryDelay(2) == 8000);
  assert(voice_poll::retryDelay(3) == 16000);
  assert(voice_poll::retryDelay(4) == 30000);
  assert(voice_poll::retryDelay(255) == 30000);
  for (int status : {-11, -1, 408, 425, 429, 500, 502, 503, 504}) assert(!voice_poll::terminalStatus(status));
  for (int status : {401, 403, 404, 410}) assert(voice_poll::terminalStatus(status));
}
`);
  const executable = join(directory, "check");
  const compiled = spawnSync(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-include", "initializer_list",
    "-I", directory, "-I", resolve("firmware/shared/NextCoderCore/src"), join(directory, "check.cpp"), "-o", executable], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
});

test("actual voice tracking keeps a nonterminal Ready job alive until Sent and preserves terminal review", async (t) => {
  const compiler = process.env.CXX || "c++";
  if (spawnSync(compiler, ["--version"]).error?.code === "ENOENT") return t.skip("Native C++ compiler unavailable");
  const { readFile } = await import("node:fs/promises");
  const source = await readFile("firmware/shared/NextCoderCore/src/GatewayVoice.cpp", "utf8");
  const header = await readFile("firmware/shared/NextCoderCore/src/GatewayVoice.h", "utf8");
  const pollStart = source.indexOf("bool GatewayVoice::poll()");
  const polledProjection = source.slice(source.indexOf("  JsonDocument doc;", pollStart), source.indexOf("\n}", pollStart));
  const captureMethods = source.slice(source.indexOf("bool GatewayVoice::canStartCapture()"), source.indexOf("void GatewayVoice::publish("));
  const recoveryMethods = source.slice(source.indexOf("void GatewayVoice::reset()"), source.indexOf("void GatewayVoice::setLocalStage("));
  const publication = source.slice(source.indexOf("void GatewayVoice::publish("), source.indexOf("\nvoid GatewayVoice::reset("));
  const methods = source.slice(source.indexOf("bool GatewayVoice::tracking()"), source.indexOf("String GatewayVoice::upload("));
  const enumeration = header.slice(header.indexOf("enum class VoiceStage"), header.indexOf("const char* voiceStageName"));
  const directory = await mkdtemp(join(tmpdir(), "next-coder-voice-terminal-"));
  t.after(() => rm(directory, {recursive:true,force:true}));
  await writeFile(join(directory,"check.cpp"), `
#include <cassert>
#include <cstdint>
#include <string>
#include <map>
#include <cstring>
using String=std::string;
struct Value {
 String text; bool boolean=false;
 const char* operator|(const char* fallback) const { return text.empty()?fallback:text.c_str(); }
 bool operator|(bool) const { return boolean; }
};
std::map<String,Value> values;
struct JsonObject { bool isNull() const {return false;} Value& operator[](const char* key){return values[key];} };
struct JsonDocument { JsonObject operator[](const char*) {return {};} };
bool deserializeJson(JsonDocument&,const String&){return false;}
uint32_t millis(){return 500;}
constexpr uint32_t kPollIntervalMs=2000;
constexpr uint32_t kGiveUpAfterMs=600000;
void esp_fill_random(uint8_t* bytes,size_t size){memset(bytes,0xab,size);}


${enumeration}
struct GatewayVoice {
 String jobId_="job", mediaId_, commandId_, responseAfter_,transcript_,detail_,reviewReason_,captureEnvironmentId_,captureThreadId_,captureRequestId_;
 uint8_t failures_=0;
 bool ok_=true;
 uint32_t revision_=0;
 VoiceStage stage_=VoiceStage::Transcribing;
 bool done_=false, captureResolved_=true;
 uint32_t nextPollAt_=0, giveUpAt_=0;
 bool canStartCapture() const;
 bool beginCapture(const String&,const String&);
 void reset();
 bool resumeStatus();
 bool hasJob() const {return !jobId_.empty();}
 bool tracking() const;
 bool pollDue(uint32_t) const;
 void publish(VoiceStage,const String&);
 bool pollFailure(uint32_t,int){assert(false);return false;}
 bool acceptProjection();
};
bool milestoneToStage(const String& milestone,VoiceStage& out){
 if(milestone=="ready"){out=VoiceStage::Ready;return true;}
 if(milestone=="sent"){out=VoiceStage::Sent;return true;}
 if(milestone=="failed"){out=VoiceStage::Failed;return true;}
 if(milestone=="review"){out=VoiceStage::Review;return true;}
 return false;
}
${publication}
${captureMethods}
${recoveryMethods}
${methods}
bool GatewayVoice::acceptProjection(){
 String response; const uint32_t now=millis();
 ${polledProjection}
}

int main(){
 GatewayVoice voice;
 assert(voice.pollDue(10));
 values["milestone"].text="ready"; values["done"].boolean=false;
 assert(voice.acceptProjection()); assert(voice.stage_==VoiceStage::Ready && voice.tracking());
 assert(voice.detail_=="Sending to the agent");
 values["milestone"].text="sent"; values["done"].boolean=true;
 values["responseAfter"].text="2026-10-23T04:52:45.962Z"; values["transcript"].text="fixture";
 assert(voice.acceptProjection()); assert(voice.stage_==VoiceStage::Sent && !voice.tracking());
 assert(voice.responseAfter_=="2026-10-23T04:52:45.962Z" && voice.revision_==2);

 voice.stage_=VoiceStage::Ready; voice.done_=false; voice.nextPollAt_=2000;
 assert(voice.tracking()); assert(!voice.pollDue(1999)); assert(voice.pollDue(2000));
 voice.stage_=VoiceStage::Sent; voice.done_=true; assert(!voice.tracking());
 voice.stage_=VoiceStage::Ready; assert(!voice.tracking());
 voice.stage_=VoiceStage::Review; voice.done_=false; assert(!voice.tracking());
 voice.stage_=VoiceStage::Failed; assert(!voice.tracking());
 voice.stage_=VoiceStage::Idle; assert(!voice.tracking());
 voice.stage_=VoiceStage::Transcribing; voice.jobId_=""; assert(!voice.tracking());
 voice.reset(); assert(voice.canStartCapture());
 assert(voice.beginCapture("environment-a","thread-a"));
 assert(voice.stage_==VoiceStage::Recorded && !voice.canStartCapture());
 const auto receipt=voice.captureRequestId_;
 assert(!voice.beginCapture("environment-b","thread-b"));
 assert(voice.captureRequestId_==receipt && voice.captureThreadId_=="thread-a");
 voice.jobId_="original-job"; voice.responseAfter_="original-cursor";
 voice.captureResolved_=false; voice.stage_=VoiceStage::Failed; voice.done_=true;
 assert(!voice.canStartCapture()); assert(voice.resumeStatus());
 assert(voice.tracking() && voice.pollDue(millis()));
 assert(voice.jobId_=="original-job" && voice.responseAfter_=="original-cursor" && voice.captureRequestId_==receipt);
 values["milestone"].text="review"; values["done"].boolean=true;
 values["reviewReason"].text="gateway_approval"; values["commandId"].text="original-command";
 assert(voice.acceptProjection()); assert(voice.detail_=="Approve request in console" && !voice.captureResolved_ && voice.commandId_=="original-command");
 values["reviewReason"].text="transcript_review";
 assert(voice.acceptProjection()); assert(voice.detail_=="Review transcript in console");
 values["reviewReason"].text="future-unknown";
 assert(voice.acceptProjection()); assert(voice.detail_=="Needs attention in console" && voice.reviewReason_.empty());
 values["milestone"].text="failed";
 assert(voice.acceptProjection()); assert(voice.captureResolved_);

}
`);
  const executable=join(directory,"check");
  const compiled=spawnSync(compiler,["-std=c++17",join(directory,"check.cpp"),"-o",executable],{encoding:"utf8"});
  assert.equal(compiled.status,0,compiled.stderr);
  assert.equal(spawnSync(executable,[],{encoding:"utf8"}).status,0);
});
