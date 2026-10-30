import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("real Hosyond touch parser never turns bus faults, multitouch, or scrolling into a confirmation tap", async (t) => {
  const compiler = process.env.CXX || "c++";
  if (spawnSync(compiler, ["--version"]).error?.code === "ENOENT") return t.skip("Native C++ compiler unavailable");
  const dir = await mkdtemp(join(tmpdir(), "next-coder-touch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "Arduino.h"), `#pragma once
#include <cstdint>
#include <cstdlib>
inline uint32_t nowMs = 0;
inline uint32_t millis() { return nowMs; }
inline void delay(unsigned n) { nowMs += n; }
inline void pinMode(int, int) {} inline void digitalWrite(int, int) {}
constexpr int OUTPUT=1, INPUT_PULLUP=2, LOW=0, HIGH=1;
struct SerialStub { template<class... T> void printf(const char*, T...) {} };
inline SerialStub Serial;
`);
  await writeFile(join(dir, "Wire.h"), `#pragma once
struct WireStub {
 int count=0, x=0, y=0, cursor=0; bool error=false;
 void beginTransmission(int) {} void write(int) {}
 int endTransmission(bool = true) { return error ? 1 : 0; }
 int requestFrom(int,int) { cursor=0; return 5; }
 int read() { switch(cursor++) { case 0:return count; case 1:return x>>8; case 2:return x&255; case 3:return y>>8; default:return y&255; } }
}; inline WireStub Wire;
`);
  await writeFile(join(dir, "controller_config.h"), `#pragma once
#define TOUCH_I2C_ADDR 0x38
#define TOUCH_RST_PIN 1
#define TOUCH_INT_PIN 2
#define LCD_WIDTH 240
#define LCD_HEIGHT 320
`);
  await writeFile(join(dir, "check.cpp"), `#include <cassert>
#include "touch.h"
#include "Wire.h"
TouchGesture point(unsigned at,int count,int x=20,int y=20,bool error=false) {
 nowMs=at; Wire.count=count; Wire.x=x; Wire.y=y; Wire.error=error; return touchPoll().gesture;
}
int main() {
 assert(touchBegin());
 assert(point(200,1)==TouchGesture::Press);
 assert(point(210,0,0,0,true)==TouchGesture::None && touchDown());
 assert(point(230,1)==TouchGesture::None);
 assert(point(250,0)==TouchGesture::Tap);
 assert(point(300,1)==TouchGesture::Press);
 assert(point(500,0,0,0,true)==TouchGesture::Release && !touchDown());
 assert(point(510,1)==TouchGesture::None);
 assert(point(520,0)==TouchGesture::None);
 assert(point(530,1)==TouchGesture::Press);
 assert(point(550,0)==TouchGesture::Tap);
 assert(point(600,1)==TouchGesture::Press);
 assert(point(610,2)==TouchGesture::Release);
 assert(point(620,1)==TouchGesture::None);
 assert(point(630,0)==TouchGesture::None);
 assert(point(700,1,10,10)==TouchGesture::Press);
 assert(point(740,1,70,150)==TouchGesture::Drag);
 assert(point(750,0)==TouchGesture::Release);
 assert(point(800,1,10,10)==TouchGesture::Press);
 assert(point(840,1,80,20)==TouchGesture::Drag);
 assert(point(850,0)==TouchGesture::SwipeRight);
 assert(point(900,1,10,10)==TouchGesture::Press);
 assert(point(1000,1,100,100)==TouchGesture::Drag);
 assert(point(2200,1,10,10)==TouchGesture::Drag);
 assert(point(2210,0)==TouchGesture::Release);
 assert(point(2300,1)==TouchGesture::Press);
 assert(point(3500,1)==TouchGesture::LongPress);
 assert(point(3510,0)==TouchGesture::Release);
 // A deliberate drag inside the old long-press radius cannot later become a long press.
 assert(point(3600,1,20,20)==TouchGesture::Press);
 assert(point(3650,1,30,20)==TouchGesture::Drag);
 assert(point(4900,1,30,20)==TouchGesture::None);
 assert(point(4910,0)==TouchGesture::Release);
 // The contact origin remains immutable even when a short wobble ends in an adjacent target.
 nowMs=5000;Wire.count=1;Wire.x=99;Wire.y=20;
 TouchEvent press=touchPoll(); assert(press.gesture==TouchGesture::Press);
 assert(press.startX==99 && press.startY==20 && press.contactId!=0);
 const uint32_t contact=press.contactId;
 point(5010,1,103,20);
 nowMs=5020;Wire.count=0;TouchEvent tap=touchPoll();
 assert(tap.gesture==TouchGesture::Tap && tap.x==103 && tap.startX==99 && tap.contactId==contact);
 TouchTargetLatch latch;
 latch.begin(press,1,7,0,0,100,50);
 assert(latch.active); // pressed feedback has a bounded captured rectangle immediately
 assert(!latch.accepts(tap,1,7)); // full excursion rejects even if the Drag edge was not replayed
 latch.move(tap);assert(!latch.active);
 assert(!latch.accepts(tap,2,7)); // neighbor can never inherit the contact
 tap.x=99;assert(!latch.accepts(tap,1,7)); // leaving and coming back stays cancelled
 latch.begin(press,1,7,0,0,100,50);
 tap.x=98;tap.minX=98;tap.maxX=99;assert(latch.accepts(tap,1,7));
 assert(!latch.accepts(tap,1,8)); // navigation changed
 assert(!latch.accepts(tap,3,7)); // semantic row/action changed
 ++tap.contactId;assert(!latch.accepts(tap,1,7));
 TouchEventBuffer queue;TouchEventBuffer::Item item;
 assert(queue.push(press,7,9,100)); assert(queue.push(tap,7,9,105));
 assert(queue.pop(item) && item.event.gesture==TouchGesture::Press);
 assert(TouchEventBuffer::current(item,7,9,850));
 assert(!TouchEventBuffer::current(item,7,9,851));
 assert(!TouchEventBuffer::current(item,8,9,110));
 assert(!TouchEventBuffer::current(item,7,10,110));
 assert(queue.pop(item) && item.event.gesture==TouchGesture::Tap && !queue.pop(item));
 for(int i=0;i<4;++i) assert(queue.push(press,7,9,100));
 assert(!queue.push(tap,7,9,100) && !queue.pop(item)); // overload cancels the whole sequence
 assert(queue.push(press,7,9,0xfffffff0u)); assert(queue.pop(item));
 assert(TouchEventBuffer::current(item,7,9,10)); // monotonic clock rollover
 TouchPerformanceWindow perf;
 perf.frame(100);perf.frame(133);perf.frame(175);assert(perf.frames==3 && perf.maxFrameGap==42);
 for(int i=0;i<19;++i)perf.dispatched(20);
 perf.dispatched(700);assert(perf.inputs==20 && perf.maxInputAge==700 && perf.p95UpperMs()==33);
 perf.resetWindow();assert(perf.inputs==0 && perf.frames==0 && perf.p95UpperMs()==0);
 perf.frame(205);assert(perf.maxFrameGap==30); // reset preserves continuity across reporting windows
 perf.resetWindow();perf.dispatched(900);assert(perf.p95UpperMs()==900);


}
`);
  const exe = join(dir, "check");
  const result = spawnSync(compiler, ["-std=c++17", "-I", dir, "-I", resolve("firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src"),
    resolve("firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/touch.cpp"), join(dir, "check.cpp"), "-o", exe], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const run = spawnSync(exe, [], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});
