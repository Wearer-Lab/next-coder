import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The Hosyond disc blit streams several rows per ILI9341 address window instead of one window per
// row. This extracts the REAL blitOrb() from display.cpp, runs it against a model of the
// controller (window, column wrap at the right edge, row advance), and compares the resulting panel
// memory with the original one-window-per-row algorithm. It proves the part that does not need a
// board: the pixels are the same, any extra pixel is a zero-coverage one, and the transfer count
// really drops. It does not and cannot measure the time; [blit-split] on the board does.
test("grouped orb blit paints the same panel memory as one window per row, in fewer windows", async (t) => {
  const compiler = process.env.CXX || "c++";
  if (spawnSync(compiler, ["--version"]).error?.code === "ENOENT") return t.skip("Native C++ compiler unavailable");
  const dir = await mkdtemp(join(tmpdir(), "next-coder-orb-blit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = await readFile("firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/display.cpp", "utf8");
  // From the blit's own tunables (macros, grey table, reach memo, probe) through the end of
  // blitOrb(): everything the function depends on that display.cpp defines, taken verbatim.
  const a = source.indexOf("#ifndef ORB_BLIT_ROWS_PER_WINDOW");
  const b = source.indexOf("}  // namespace\n\nvoid displayDrawOrb(", a);
  assert.ok(a > 0 && b > a, "blitOrb markers present in display.cpp");
  const blit = source.slice(a, b);
  assert.doesNotMatch(blit, /\b(?:malloc|calloc|new)\b/u, "no allocation in the blit");

  const code = `#include <cassert>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <vector>
#include "Arduino.h"
#include "ThinkingOrb.h"
#include "OrbPainter.h"

struct SerialStub { template <class... A> void printf(const char*, A...) {} } Serial;
struct EspStub { uint32_t getCycleCount() { return 0; } } ESP;
inline uint32_t millis() { return 0; }
inline uint32_t getCpuFrequencyMhz() { return 240; }
inline uint16_t panelGrey(uint8_t g) { return (uint16_t)~(uint16_t)(((g & 0xF8) << 8) | ((g & 0xFC) << 3) | (g >> 3)); }

// ILI9341 memory model: a window, a write pointer that wraps at the window's right edge, 240x320.
struct Panel {
  uint16_t mem[240 * 320]; bool written[240 * 320];
  int x1 = 0, y1 = 0, w = 0, h = 0, cx = 0, cy = 0; long windows = 0, started = 0;
  void ground() { for (auto& m : mem) m = panelGrey(0); }   // the page the orb sits on: cleared to zero
  void newFrame() { memset(written, 0, sizeof written); windows = 0; }
  void startWrite() { ++started; }
  void endWrite() {}
  void setAddrWindow(int x, int y, int ww, int hh) { x1 = x; y1 = y; w = ww; h = hh; cx = x; cy = y; ++windows; }
  void writePixels(uint16_t* p, uint32_t len) {
    for (uint32_t i = 0; i < len; ++i) {
      assert(cy < y1 + h);                       // never writes past the window
      mem[cy * 240 + cx] = p[i]; written[cy * 240 + cx] = true;
      if (++cx == x1 + w) { cx = x1; ++cy; }
    }
  }
} panels[2], *cur = &panels[0];
using Adafruit_ILI9341 = Panel;
Panel& displayPanel() { return *cur; }
bool displayReady() { return true; }
uint16_t dmaRowStore[240]; uint16_t* dmaRow = dmaRowStore;
bool sceneActive = false; int sceneBandTop = 0, sceneBandBottom = 0; uint32_t panelFreq = 80000000UL;
void publishRasterRow(int16_t, int16_t, int16_t) {}

#define panel (*cur)
namespace grouped {
${blit}
}

// The original algorithm, verbatim in behaviour: one window per row, per-pixel panelGrey.
void referenceBlit(ThinkingOrb& orb, int16_t cx, int16_t cy, uint32_t elapsedMs, uint8_t* grey, int16_t dim, int16_t drawDim) {
  if (drawDim <= 0 || drawDim > dim) drawDim = dim;
  const OrbFrame frame = orb.render(elapsedMs);
  const int16_t mid = dim / 2, half = drawDim / 2;
  paintOrbCoverage(frame, grey, dim);
  const float r = (float)half, r2 = r * r;
  panel.startWrite();
  for (int16_t row = 0; row < drawDim; ++row) {
    const int16_t absoluteY = (int16_t)(cy - half + row);
    const float dy = (row - r) + 0.5f; const float inside = r2 - dy * dy;
    if (inside <= 0.0f) continue;
    const int16_t reach = (int16_t)sqrtf(inside);
    int16_t from = (int16_t)(half - reach), to = (int16_t)(half + reach);
    if (from < 0) from = 0; if (to > drawDim) to = drawDim;
    const int16_t span = (int16_t)(to - from); if (span <= 0) continue;
    const uint8_t* src = grey + (size_t)(mid - half + row) * dim + (mid - half + from);
    for (int16_t col = 0; col < span; ++col) dmaRow[col] = panelGrey(src[col]);
    panel.setAddrWindow((int16_t)(cx - half + from), absoluteY, span, 1);
    panel.writePixels(dmaRow, span);
  }
  panel.endWrite();
}

int main() {
  struct Cfg { int diameter, capacity, dim, draw; } cfgs[] = {{104, 640, 148, 112}, {40, 180, 44, 44}, {140, 420, 148, 148}, {104, 640, 148, 100}};
  long refWindows = 0, groupedWindows = 0, refPixels = 0, groupedPixels = 0, frames = 0, shrunk = 0;
  for (const Cfg& c : cfgs) {
    ThinkingOrb orb; assert(orb.begin(c.diameter, c.capacity));
    std::vector<uint8_t> grey(((size_t)c.dim * c.dim)), grey2(grey.size());
    // Both panels persist across the whole sequence and start as the cleared page. Persisting is the
    // point: a shrinking orb that left a ghost ring, or a reach that clipped ink, shows up as the
    // two memories disagreeing on a LATER frame, not the one that caused it.
    panels[0].ground(); panels[1].ground();
    auto both = [&](int cx, int cy, uint32_t tm) -> bool {
      cur = &panels[0]; panel.newFrame(); referenceBlit(orb, cx, cy, tm, grey.data(), c.dim, c.draw);
      refWindows += panel.windows; for (bool w : panel.written) refPixels += w;
      cur = &panels[1]; panel.newFrame(); grouped::blitOrb(orb, cx, cy, tm, grey2.data(), c.dim, c.draw);
      groupedWindows += panel.windows; for (bool w : panel.written) groupedPixels += w;
      ++frames;
      for (int i = 0; i < 240 * 320; ++i) if (panels[0].mem[i] != panels[1].mem[i]) {
        fprintf(stderr, "panel memory differs: diameter %d draw %d mode %d t %u at (%d,%d): reference %04x, grouped %04x\\n", c.diameter, c.draw, (int)orb.mode(), tm, i % 240, i / 240, panels[0].mem[i], panels[1].mem[i]);
        return false;
      }
      return true;
    };
    // Every mode, every time, consecutively on ONE orb: the modes have different reaches, so a
    // switch from a wide mode to a narrow one is the case where the previous frame's ink must be
    // erased by a disc that is otherwise smaller.
    for (uint32_t tm : {0u, 777u, 1500u, 3333u, 7001u, 12345u, 30011u, 60007u})
      for (int m = 0; m < (int)OrbMode::ModeCount; ++m) { orb.setMode((OrbMode)m); if (!both(120, 150, tm)) return 1; }
    // The same mode over many consecutive frames (animation, not just samples).
    for (int m = 0; m < (int)OrbMode::ModeCount; ++m) { orb.setMode((OrbMode)m); for (uint32_t tm = 0; tm < 3000; tm += 33) if (!both(120, 150, tm)) return 1; }
    // Moved: the buffer has no memory of this place, so the whole disc is written again; the ink
    // left at the old place is equally untouched in both.
    // (The page is cleared first, as an arrival does it: the grouped hull writes a few zero pixels
    // beyond the original disc, which would erase ink the original leaves behind when the orb is
    // moved WITHOUT any repaint. That does not happen in the product and would only test the test.)
    panels[0].ground(); panels[1].ground();
    orb.setMode(OrbMode::Ring); if (!both(100, 140, 5000) || !both(100, 140, 5033)) return 1;
  }
  fprintf(stderr, "frames=%ld windows ref=%ld grouped=%ld pixels ref=%ld grouped=%ld (%.1f%% of the reference)\\n", frames, refWindows, groupedWindows, refPixels, groupedPixels, 100.0 * groupedPixels / refPixels);
  assert(groupedWindows * 3 < refWindows);                  // at least three times fewer address windows
  assert(groupedPixels * 100 < refPixels * 90);             // and the disc shrank: under 90% of the pixels
  (void)shrunk;
  return 0;
}
`;
  await writeFile(join(dir, "check.cpp"), code);
  const shared = resolve("firmware/shared/NextCoderCore/src");
  const exe = join(dir, "check");
  const built = spawnSync(compiler, ["-std=c++17", "-O1", "-I", resolve("test/fixtures/orb-ab"), "-I", shared, join(shared, "ThinkingOrb.cpp"), join(shared, "OrbPainter.cpp"), join(dir, "check.cpp"), "-o", exe], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(exe, [], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  t.diagnostic(run.stderr.trim());
});
