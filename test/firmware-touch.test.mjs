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
}
`);
  const exe = join(dir, "check");
  const result = spawnSync(compiler, ["-std=c++17", "-I", dir, "-I", resolve("firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src"),
    resolve("firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/touch.cpp"), join(dir, "check.cpp"), "-o", exe], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const run = spawnSync(exe, [], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});
