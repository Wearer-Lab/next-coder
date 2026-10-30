import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The strip walk that spreads a content repaint over frames (ui_content_job.h) is pure, so its
// invariants are tested against the REAL header: a mistake here is a visible seam or a screen that
// never finishes painting, and neither can be seen without a board.
//
// Compiled twice. The strips/frames/spentUs bookkeeping exists only under HOSYOND_UI_PROFILE (it
// feeds nothing but the [content-split] report), so the walk's invariants are checked with it
// absent -- which is the release build -- and the bookkeeping itself is checked with it present.
for (const profile of [0, 1]) test(`content job covers its rows exactly once, always progresses, restarts on arm, and honours the budget (HOSYOND_UI_PROFILE=${profile})`, async (t) => {
  const compiler = process.env.CXX || "c++";
  if (spawnSync(compiler, ["--version"]).error?.code === "ENOENT") return t.skip("Native C++ compiler unavailable");
  const dir = await mkdtemp(join(tmpdir(), "next-coder-content-job-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "check.cpp"), `#include <cassert>
#include <vector>
#include <utility>
#include <type_traits>
#include "ui_content_job.h"
static uint32_t clockUs = 0;
// The report's members must not exist in a release build at all: a field nobody can read is the
// proof that nothing is accumulating into it.
template <class T, class = void> struct HasSpentUs : std::false_type {};
template <class T> struct HasSpentUs<T, std::void_t<decltype(std::declval<T&>().spentUs)>> : std::true_type {};
static_assert(HasSpentUs<ContentJob>::value == (HOSYOND_UI_PROFILE != 0), "report bookkeeping tracks HOSYOND_UI_PROFILE");
#if HOSYOND_UI_PROFILE
#define STATS(...) __VA_ARGS__
#else
#define STATS(...)
#endif
int main() {
  const auto now = []() { return clockUs; };
  // Walk [56, 320): 264 rows = 12 strips of 22. 4000 us a strip, 9000 us budget: 3 strips a frame
  // (the third crosses the budget and stops the loop), so 4 frames.
  {
    ContentJob job; job.arm(56, 320, false);
    std::vector<std::pair<int,int>> strips;
    auto compose = [&](int16_t y, int16_t rows) { strips.push_back({y, rows}); clockUs += 4000; return true; };
    int frames = 0; bool finished = false;
    while (!finished) {
      const uint32_t frameStart = clockUs;
      finished = job.advance(compose, now, frameStart, 9000, 22);
      ++frames; assert(frames < 100);
      assert(!finished == job.active);
    }
    assert(frames == 4 && strips.size() == 12);
    STATS(assert(job.strips == 12 && job.frames == 4);)
    int y = 56;
    for (auto& s : strips) { assert(s.first == y && s.second == 22); y += s.second; }
    assert(y == 320);
    STATS(assert(job.spentUs == 12 * 4000u);)
    assert(job.next == 320 && !job.active);
  }
  // A last strip shorter than a band is clipped, not overrun: [56, 100) = 22 + 22; [56, 90) = 22 + 12.
  {
    ContentJob job; job.arm(56, 90, false);
    std::vector<std::pair<int,int>> strips;
    auto compose = [&](int16_t y, int16_t rows) { strips.push_back({y, rows}); return true; };
    assert(job.advance(compose, now, clockUs, 1000000, 22));
    assert(strips.size() == 2 && strips[1].first == 78 && strips[1].second == 12);
  }
  // One strip is always composed, even when the budget is already spent: progress, not stall.
  {
    ContentJob job; job.arm(0, 220, false);
    int composed = 0;
    auto compose = [&](int16_t, int16_t) { ++composed; clockUs += 50000; return true; };
    job.advance(compose, now, clockUs - 1000000, 0, 22);
    assert(composed == 1 && job.active && job.next == 22);
  }
  // arm() while active restarts from the top with fresh counters, and may change the extent.
  {
    ContentJob job; job.arm(56, 320, false);
    auto compose = [&](int16_t, int16_t) { clockUs += 10000; return true; };
    job.advance(compose, now, clockUs, 1, 22);
    assert(job.active && job.next == 78);
    STATS(assert(job.strips == 1);)
    job.arm(56, 262, false);
    assert(job.active && job.next == 56 && job.end == 262 && !job.partial);
    STATS(assert(job.strips == 0 && job.spentUs == 0);)
  }
  // A failed compose means the caller painted everything directly: the job completes at once.
  {
    ContentJob job; job.arm(56, 320, false);
    int calls = 0;
    auto compose = [&](int16_t, int16_t) { ++calls; return false; };
    assert(job.advance(compose, now, clockUs, 1000000, 22));
    assert(calls == 1 && !job.active);
  }
  // An empty or inverted extent never becomes active (a content area of zero height).
  { ContentJob job; job.arm(100, 100, false); assert(!job.active); job.arm(120, 100, true); assert(!job.active); }
  // advance() on an idle job does nothing.
  { ContentJob job; int calls = 0; auto compose = [&](int16_t, int16_t) { ++calls; return true; };
    assert(!job.advance(compose, now, clockUs, 100, 22) && calls == 0); }
  // The clock is read for the budget and for nothing else in a release build: one read per strip
  // boundary (the loop condition), where the report adds two more around every strip.
  {
    ContentJob job; job.arm(56, 320, false);
    unsigned reads = 0;
    auto counting = [&]() { ++reads; return clockUs; };
    auto compose = [](int16_t, int16_t) { return true; };
    while (!job.advance(compose, counting, clockUs, 1000000, 22)) {}
    assert(reads == (HOSYOND_UI_PROFILE ? 12u * 2 + 11 : 11u));
  }
  // A partial job keeps its flag through the walk.
  { ContentJob job; job.arm(200, 280, true); assert(job.partial && job.active); }
  return 0;
}
`);
  const exe = join(dir, "check");
  const built = spawnSync(compiler, ["-std=c++17", "-Wall", `-DHOSYOND_UI_PROFILE=${profile}`, "-I", resolve("firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src"), "-I", resolve("firmware/shared/NextCoderCore/src"), join(dir, "check.cpp"), "-o", exe], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(exe, [], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});
