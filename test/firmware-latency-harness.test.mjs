import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";

const board = resolve("firmware/Hosyond-ESP32-S3-2.8-Touchscreen");
const compiler = process.env.CXX || "c++";
const FLAGS = ["-std=c++17", "-DBENCH_SELFTEST=1", "-DHOSYOND_QUALIFICATION=1", "-DHOSYOND_QUALIFICATION_ALLOWED=1", "-DARDUINO_USB_MODE=1", "-DARDUINO_USB_CDC_ON_BOOT=1"];
const hasCompiler = () => spawnSync(compiler, ["--version"]).error?.code !== "ENOENT";

test("LATENCY and CANCEL parse strictly, and no scenario can reach the thread-selecting step", async (t) => {
  if (!hasCompiler()) return t.skip("Native compiler unavailable");
  const directory = await mkdtemp(join(tmpdir(), "latency-parser-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "check.cpp"), `#include <cassert>
#include <cstring>
#include <initializer_list>
#include "qualification.h"
int main(){using namespace qualification;
 auto c=parse("NCQUAL LATENCY THREADS 20 3000");
 assert(c.kind==Kind::Latency && c.count==20 && c.scenario==Scenario::Threads && c.delayMs==3000);
 c=parse("NCQUAL LATENCY LOCAL 200 0");assert(c.kind==Kind::Latency && c.count==200 && c.scenario==Scenario::Local && c.delayMs==0);
 c=parse("NCQUAL LATENCY REPLY 1 60000");assert(c.kind==Kind::Latency && c.count==1 && c.scenario==Scenario::Reply && c.delayMs==60000);
 assert(parse("NCQUAL CANCEL").kind==Kind::Cancel);
 const char* invalid[]={"NCQUAL LATENCY","NCQUAL LATENCY ","NCQUAL LATENCY THREADS","NCQUAL LATENCY THREADS 20","NCQUAL LATENCY THREADS 20 ",
   "NCQUAL LATENCY THREADS 0 100","NCQUAL LATENCY THREADS 201 100","NCQUAL LATENCY THREADS 20 60001","NCQUAL LATENCY THREADS 020 100",
   "NCQUAL LATENCY THREADS 20 0100","NCQUAL LATENCY THREADS -1 100","NCQUAL LATENCY THREADS 20 -1","NCQUAL LATENCY THREADS 1000000000 1",
   "NCQUAL LATENCY THREADS 20 100 extra","NCQUAL LATENCY THREADS 20 100;DROP","NCQUAL LATENCY THREADS  20 100","NCQUAL LATENCY threads 20 100",
   "NCQUAL LATENCY NOPE 20 100","NCQUAL LATENCY THREADSX 20 100","NCQUAL LATENCY STRESS 20 100","NCQUAL LATENCY 1 20 100","NCQUAL CANCEL now","NCQUAL CANCEL ","NCQUAL LATENCYTHREADS 20 100"};
 for(const auto* line:invalid)assert(parse(line).kind==Kind::Invalid);
 // The longest valid command fits the line buffer with room to spare.
 assert(strlen("NCQUAL LATENCY THREADS 200 60000")<kLineCapacity);
 // A scenario names a step; none may be step 2 (selects a thread, changing the device's binding).
 for(auto s:{Scenario::Local,Scenario::Threads,Scenario::Reply}){assert(stepsFor(s).step!=2 && stepsFor(s).reset==0);}
 assert(stepsFor(Scenario::Threads).step==1 && stepsFor(Scenario::Reply).step==8 && stepsFor(Scenario::Local).step==4);
}
`);
  const binary = join(directory, "check");
  const compiled = spawnSync(compiler, [...FLAGS, "-I", join(board, "src"), join(directory, "check.cpp"), "-o", binary], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.equal(spawnSync(binary).status, 0);
});

// Host doubles for everything qualification.cpp touches. The REAL qualification.cpp is copied beside
// them (so its quoted #includes resolve to these doubles rather than the board's headers) and driven
// one loop pass at a time on a virtual clock, with a fake UI whose busy flag and step results the
// scenario controls. This is the state machine that will otherwise first run on silicon.
const DOUBLES = {
  "Arduino.h": `#pragma once
#include <cstdint>
#include <cstdio>
#include <cstdarg>
#include <cstring>
#include <deque>
#include <string>
extern uint32_t g_now, g_heap; extern int g_wifi, g_disconnects;
inline uint32_t millis(){return g_now;}
struct String{std::string s;String()=default;String(const char*v):s(v){}bool operator==(const String&o)const{return s==o.s;}};
struct SerialPort{
  std::deque<char> input;
  int available(){return static_cast<int>(input.size());}
  int read(){if(input.empty())return -1;int v=static_cast<unsigned char>(input.front());input.pop_front();return v;}
  void print(const char* text){fputs(text,stdout);}
  void printf(const char* format,...) __attribute__((format(printf,2,3))){va_list a;va_start(a,format);vprintf(format,a);va_end(a);}
};
extern SerialPort Serial;
struct EspClass{uint32_t getFreeHeap(){return g_heap;}};
extern EspClass ESP;
`,
  "WiFi.h": `#pragma once
#include "Arduino.h"
enum {WL_CONNECTED=3,WL_DISCONNECTED=6};
struct WiFiClass{int status(){return g_wifi;}bool disconnect(bool,bool){++g_disconnects;return true;}};
extern WiFiClass WiFi;
`,
  "DeviceStore.h": "#pragma once\n#include \"Arduino.h\"\nclass DeviceStore{};\n",
  "GatewayClient.h": `#pragma once
#include "Arduino.h"
enum class GatewayLink : uint8_t {NoIdentity,Idle,Connecting,Unclaimed,Claimed,Revoked,Unreachable};
struct GatewayContext{String environmentId,projectId,threadId;};
extern GatewayContext g_context; extern GatewayLink g_link; extern bool g_lockBusy;
class GatewayClient{public:
  bool tryLockState(int){return !g_lockBusy;}
  void unlockState(){}
  const GatewayContext& context() const{return g_context;}
  GatewayLink link() const{return g_link;}
};
inline const char* gatewayLinkName(GatewayLink l){return l==GatewayLink::Claimed?"claimed":"idle";}
`,
  "Provisioning.h": `#pragma once
#include "Arduino.h"
enum class ProvisioningState{Online};
struct ProvisioningStatus{ProvisioningState state;};
extern int g_portalOpens;
class Provisioning{public:
  ProvisioningStatus status(){return {ProvisioningState::Online};}
  bool configPortalActive(){return false;}
  void openConfigPortal(){++g_portalOpens;}
  void closeConfigPortal(){}
};
inline const char* provisioningStateName(ProvisioningState){return "online";}
`,
  "ui.h": `#pragma once
bool uiQualificationBusy();
bool uiQualificationStep(unsigned step);
bool uiQualificationVerify();
const char* uiBenchScreenName();
`,
};

const DRIVER = String.raw`
#include <cstdlib>
#include <string>
#include <vector>
#include <functional>
#include "Arduino.h"
#include "WiFi.h"
#include "DeviceStore.h"
#include "GatewayClient.h"
#include "Provisioning.h"
#include "ui.h"
#include "qualification.h"
uint32_t g_now=100000,g_heap=150000;int g_wifi=WL_CONNECTED,g_disconnects=0,g_portalOpens=0;
SerialPort Serial;EspClass ESP;WiFiClass WiFi;GatewayContext g_context;GatewayLink g_link=GatewayLink::Claimed;bool g_lockBusy=false;
struct FakeUi{uint32_t busyUntil=0,jobMs=1500;bool stuck=false;int refuseNext=0;bool refuseForever=false;std::vector<unsigned> steps;}ui;
bool uiQualificationBusy(){return ui.stuck||g_now<ui.busyUntil;}
bool uiQualificationStep(unsigned step){
  if(uiQualificationBusy()||ui.refuseForever)return false;
  if(ui.refuseNext>0){--ui.refuseNext;return false;}
  ui.steps.push_back(step%10);
  if(step==1||step==8)ui.busyUntil=g_now+ui.jobMs;   // the gateway job; every other step is local navigation
  return true;
}
bool uiQualificationVerify(){return false;}
const char* uiBenchScreenName(){return "Threads";}
Provisioning prov;GatewayClient gw;DeviceStore store;
void type(const char* text){for(;*text;++text)Serial.input.push_back(*text);}
// One loop pass every 33 ms, like the real render loop; the hook runs first, standing in for the world.
void run(uint32_t ms,const std::function<void(uint32_t)>& hook={}){
  const uint32_t start=g_now;
  for(uint32_t t=0;t<ms;t+=33){g_now=start+t;if(hook)hook(t);qualificationTick(prov,gw,store);}
}
void steps(){printf("STEPS:");for(unsigned s:ui.steps)printf(" %u",s);printf("\nDISCONNECTS:%d PORTALS:%d\n",g_disconnects,g_portalOpens);}
int main(int argc,char** argv){
  const std::string scenario=argc>1?argv[1]:"";
  g_context.environmentId=String("env");g_context.projectId=String("proj");g_context.threadId=String("thr");
  qualificationBegin();
  if(scenario=="threads"){type("NCQUAL LATENCY THREADS 3 100\n");run(15000);steps();}
  else if(scenario=="local"){type("NCQUAL LATENCY LOCAL 2 0\n");run(2000);steps();}
  else if(scenario=="reply"){type("NCQUAL LATENCY REPLY 2 6000\n");run(20000);steps();}
  else if(scenario=="refusals"){
    ui.busyUntil=g_now+60000;type("NCQUAL LATENCY THREADS 3 100\n");run(100);ui.busyUntil=0;
    g_wifi=WL_DISCONNECTED;type("NCQUAL LATENCY THREADS 3 100\n");run(100);
    type("NCQUAL LATENCY LOCAL 1 0\n");run(500);   // LOCAL needs no link
    g_wifi=WL_CONNECTED;g_link=GatewayLink::Unclaimed;type("NCQUAL LATENCY REPLY 3 100\n");run(100);
    g_lockBusy=true;g_link=GatewayLink::Claimed;type("NCQUAL LATENCY THREADS 3 100\n");run(100);g_lockBusy=false;
    steps();
  }
  else if(scenario=="exclusive"){
    type("NCQUAL LATENCY THREADS 5 1000\n");run(200);
    type("NCQUAL LATENCY LOCAL 1 0\nNCQUAL STRESS 3\nNCQUAL DROP\nNCQUAL PORTAL\nNCQUAL CLOSE\nNCQUAL REPLY\nNCQUAL VERIFY\nNCQUAL STATUS\n");run(200);
    type("NCQUAL CANCEL\n");run(100);type("NCQUAL STATUS\n");run(100);steps();
  }
  else if(scenario=="stress-first"){type("NCQUAL STRESS 3\n");run(100);type("NCQUAL LATENCY LOCAL 1 0\n");run(100);type("NCQUAL CANCEL\n");run(100);}
  else if(scenario=="binding"){
    type("NCQUAL LATENCY THREADS 5 500\n");run(5000,[](uint32_t t){if(t>2500)g_context.threadId=String("other");});steps();
  }
  else if(scenario=="timeout"){ui.jobMs=45000;type("NCQUAL LATENCY THREADS 3 100\n");run(40000);steps();}
  else if(scenario=="contention"){
    // Armed once the untimed reset step has run, so the refusals land on the timed step.
    bool armed=false;type("NCQUAL LATENCY THREADS 1 0\n");
    run(4000,[&](uint32_t){if(!armed && ui.steps.size()==1){ui.refuseNext=3;armed=true;}});steps();
  }
  else if(scenario=="refused-forever"){ui.refuseForever=true;type("NCQUAL LATENCY THREADS 1 0\n");run(8000);steps();}
  else if(scenario=="never-idle"){type("NCQUAL LATENCY THREADS 2 5000\n");run(2500);ui.stuck=true;run(40000);steps();}
  else if(scenario=="foreign-job"){
    // A job that was already in flight when the batch is due is waited out, not measured.
    type("NCQUAL LATENCY THREADS 1 0\n");run(40);ui.busyUntil=g_now+3000;run(8000);steps();   // the command line takes two passes to read
  }
  return 0;
}
`;

// Built once at load and shared by every simulation below; removed when the whole file is done.
const simulatorDirectory = hasCompiler() ? await mkdtemp(join(tmpdir(), "latency-sim-")) : null;
after(() => (simulatorDirectory ? rm(simulatorDirectory, { recursive: true, force: true }) : undefined));
async function buildSimulator() {
  const directory = simulatorDirectory;
  const binary = join(directory, "sim");
  if (existsSync(binary)) return binary;
  for (const [name, content] of Object.entries(DOUBLES)) await writeFile(join(directory, name), content);
  await writeFile(join(directory, "qualification.h"), await readFile(join(board, "src/qualification.h")));
  await writeFile(join(directory, "qualification.cpp"), await readFile(join(board, "src/qualification.cpp")));
  await writeFile(join(directory, "driver.cpp"), DRIVER);
  const compiled = spawnSync(compiler, [...FLAGS, "-Wall", "-Wno-unused-function", "-I", directory, join(directory, "driver.cpp"), join(directory, "qualification.cpp"), "-o", binary], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  return binary;
}

async function simulate(t, scenario) {
  const binary = await buildSimulator();
  const run = spawnSync(binary, [scenario], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 0, `${run.signal ?? ''} ${run.stderr}`);
  const events = run.stdout.split("\n").filter((line) => line.startsWith("[ncqual] ")).map((line) => JSON.parse(line.slice(9)));
  const stepLine = run.stdout.split("\n").find((line) => line.startsWith("STEPS:")) ?? "STEPS:";
  const steps = stepLine.slice(6).trim().split(/\s+/u).filter(Boolean).map(Number);
  const counters = /DISCONNECTS:(\d+) PORTALS:(\d+)/u.exec(run.stdout);
  return {
    events, steps, disconnects: counters ? Number(counters[1]) : null, portals: counters ? Number(counters[2]) : null,
    iterations: events.filter((event) => event.event === "latency_iter"),
    summary: events.find((event) => event.event === "latency" && (event.phase === "finished" || event.phase === "aborted")),
    started: events.find((event) => event.event === "latency" && event.phase === "started"),
    refusals: events.filter((event) => event.event === "latency" && event.phase === "refused").map((event) => event.reason),
  };
}

test("a THREADS batch resets to Home before every timed step and times the whole gateway job", async (t) => {
  if (!hasCompiler()) return t.skip("Native compiler unavailable");
  const run = await simulate(t, "threads");
  assert.deepEqual(run.steps, [0, 1, 0, 1, 0, 1], "reset (Home) then the timed step, three times");
  assert.equal(run.started.scenario, "THREADS");
  assert.equal(run.started.step, 1);
  assert.equal(run.started.reset_step, 0);
  assert.equal(run.iterations.length, 3);
  for (const [index, row] of run.iterations.entries()) {
    assert.equal(row.i, index + 1);
    assert.equal(row.network, true);
    assert.equal(row.timeout, false);
    assert.equal(row.retries, 0);
    assert.ok(row.accept_ms <= 33, `the step itself is one pass: ${row.accept_ms}`);
    assert.ok(row.busy_ms >= 1500 && row.busy_ms <= 1500 + 66, `settle follows the job within two passes: ${row.busy_ms}`);
    assert.equal(row.total_ms, row.accept_ms + row.busy_ms);
    assert.equal(row.t_settle_ms - row.t_inject_ms, row.total_ms);
    assert.ok(row.t_busy_ms === row.t_accept_ms, "the job was already queued when the step returned");
    assert.equal(row.screen, "Threads");
    assert.ok(Number.isInteger(row.t_ms));
  }
  assert.ok(run.iterations[1].t_inject_ms - run.iterations[0].t_settle_ms >= 100, "the inter-iteration delay is honoured");
  const s = run.summary;
  assert.equal(s.phase, "finished");
  assert.equal(s.reason, "completed");
  assert.equal(s.completed, 3);
  assert.equal(s.network_iterations, 3);
  assert.equal(s.local_iterations, 0);
  assert.equal(s.total_ms.count, 3);
  const totals = run.iterations.map((row) => row.total_ms);
  assert.equal(s.total_ms.min, Math.min(...totals));
  assert.equal(s.total_ms.max, Math.max(...totals));
  assert.equal(s.total_ms.mean, Math.round(totals.reduce((a, b) => a + b, 0) / 3));
  assert.ok(run.events.every((event) => Number.isInteger(event.t_ms) || event.event === "status"), "every event carries the device clock for host-side correlation");
  assert.equal(run.disconnects, 0, "no fault injection runs in a latency batch");
});

test("a LOCAL batch makes no job and settles on the next pass: the harness's own noise floor", async (t) => {
  if (!hasCompiler()) return t.skip("Native compiler unavailable");
  const run = await simulate(t, "local");
  assert.deepEqual(run.steps, [0, 4, 0, 4]);
  assert.equal(run.iterations.length, 2);
  for (const row of run.iterations) {
    assert.equal(row.network, false);
    assert.equal(row.t_busy_ms, 0);
    assert.ok(row.total_ms <= 66, `a local step settles within two passes: ${row.total_ms}`);
  }
  assert.equal(run.summary.local_iterations, 2);
  assert.equal(run.summary.network_iterations, 0);
});

test("REPLY runs step 8 and spaces iterations by the requested delay", async (t) => {
  if (!hasCompiler()) return t.skip("Native compiler unavailable");
  const run = await simulate(t, "reply");
  assert.deepEqual(run.steps, [0, 8, 0, 8]);
  assert.ok(run.iterations[1].t_inject_ms - run.iterations[0].t_settle_ms >= 6000);
});

test("a batch is refused, with a reason, when it could only measure a fault", async (t) => {
  if (!hasCompiler()) return t.skip("Native compiler unavailable");
  const run = await simulate(t, "refusals");
  assert.deepEqual(run.refusals, ["busy", "offline", "gateway_not_claimed", "busy"]);
  assert.equal(run.events.filter((event) => event.event === "latency" && event.phase === "started").length, 1, "only the LOCAL batch was accepted, with Wi-Fi down");
});

test("one batch at a time, no fault injection beneath it, STATUS stays answerable, CANCEL stops it", async (t) => {
  if (!hasCompiler()) return t.skip("Native compiler unavailable");
  const run = await simulate(t, "exclusive");
  const inputs = run.events.filter((event) => event.event === "input").map((event) => event.phase);
  assert.deepEqual(inputs, ["latency_in_progress", "latency_in_progress", "latency_in_progress", "latency_in_progress", "latency_in_progress", "latency_in_progress", "latency_in_progress"], "LATENCY, STRESS, DROP, PORTAL, CLOSE, REPLY and VERIFY are all refused");
  assert.equal(run.disconnects, 0, "DROP never reached the radio");
  assert.equal(run.portals, 0, "PORTAL never reached the provisioner");
  assert.equal(run.events.filter((event) => event.event === "status").length, 2);
  assert.equal(run.summary.phase, "aborted");
  assert.equal(run.summary.reason, "cancelled");
  assert.equal(run.events.find((event) => event.event === "cancel").phase, "stopped");
  assert.ok(run.iterations.length < 5);
  const afterCancel = await simulate(t, "stress-first");
  assert.ok(afterCancel.events.some((event) => event.event === "input" && event.phase === "stress_in_progress"), "a LATENCY command is refused while Stress runs");
  assert.ok(afterCancel.events.some((event) => event.event === "stress" && event.phase === "started"));
  assert.equal(afterCancel.events.find((event) => event.event === "cancel").phase, "stopped", "CANCEL also stops Stress");
});

test("a changed thread binding aborts the batch instead of timing the wrong thing", async (t) => {
  if (!hasCompiler()) return t.skip("Native compiler unavailable");
  const run = await simulate(t, "binding");
  assert.equal(run.summary.phase, "aborted");
  assert.equal(run.summary.reason, "binding_changed");
  assert.ok(run.summary.completed >= 1 && run.summary.completed < 5);
});

test("a job that never completes is reported as a timed-out iteration and aborts the batch", async (t) => {
  if (!hasCompiler()) return t.skip("Native compiler unavailable");
  const run = await simulate(t, "timeout");
  assert.equal(run.iterations.length, 1);
  assert.equal(run.iterations[0].timeout, true);
  assert.ok(run.iterations[0].total_ms >= 30000);
  assert.equal(run.summary.phase, "aborted");
  assert.equal(run.summary.reason, "timeout");
  assert.equal(run.summary.completed, 0, "a timed-out iteration is never counted into the statistics");
  assert.equal(run.summary.total_ms.count, 0);
});

test("brief model-lock contention keeps the clock running and is counted; a real stall aborts", async (t) => {
  if (!hasCompiler()) return t.skip("Native compiler unavailable");
  const brief = await simulate(t, "contention");
  assert.equal(brief.iterations[0].retries, 3);
  assert.ok(brief.iterations[0].accept_ms >= 66, `three refused passes are inside accept: ${brief.iterations[0].accept_ms}`);
  assert.equal(brief.summary.step_retries, 3);
  assert.equal(brief.summary.phase, "finished");
  const stalled = await simulate(t, "refused-forever");
  assert.equal(stalled.summary.reason, "step_refused");
  assert.equal(stalled.summary.phase, "aborted");
});

test("a UI that never goes idle is not measured through; a job already in flight is waited out", async (t) => {
  if (!hasCompiler()) return t.skip("Native compiler unavailable");
  const stuck = await simulate(t, "never-idle");
  assert.equal(stuck.summary.reason, "never_idle");
  const foreign = await simulate(t, "foreign-job");
  assert.equal(foreign.summary.phase, "finished");
  assert.ok(foreign.iterations[0].t_inject_ms >= 100033 + 3000, "the clock started after the foreign job finished");
  assert.ok(foreign.iterations[0].total_ms < 1700, "the foreign job's time is not charged to the tap");
});

test("the qualification gate and the release image are untouched by the latency harness", async () => {
  const overrides = await readFile(join(board, "scripts/build_overrides.py"), "utf8");
  assert.match(overrides, /Qualification is allowed only in hosyond-es3c28p-bench, never release/u);
  assert.match(overrides, /PIOENV"\) != "hosyond-es3c28p-bench"/u);
  const source = await readFile(join(board, "src/qualification.cpp"), "utf8");
  assert.match(source, /^#if BENCH_SELFTEST && HOSYOND_QUALIFICATION/mu, "the implementation is compiled only into the qualification build");
  for (const forbidden of [/HTTPClient/u, /WiFiClientSecure/u, /gateway\.request/u, /\bnew\s+std::thread\b/u, /xTaskCreate/u]) {
    assert.doesNotMatch(source, forbidden, "no HTTP from the harness and no new task or stack");
  }
});
