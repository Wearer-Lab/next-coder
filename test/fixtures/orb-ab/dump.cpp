// Renders every orb mode at several sizes/times through the REAL shared sources and writes the
// coverage buffers (plus a stats table) for comparison by test/orb-ab.test.mjs. Built twice: once
// against the frozen baseline in ../orb-baseline and once against the live firmware sources.
#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>
#include "ThinkingOrb.h"
#include "OrbPainter.h"

#ifdef OPCOUNT
#include "opcount.h"
unsigned long gOps[kOpKinds];
static const char* kOpNames[kOpKinds] = {"sinf","cosf","sqrtf","floorf","ceilf","fmodf","expf","powf","lroundf"};
#endif

struct Cfg { int diameter, capacity, dim; const char* name; };
// home orb as the Hosyond builds it, the mini orb, and two sizes/budgets the other boards may use.
static const Cfg kCfgs[] = {
  {104, 640, 148, "home"}, {40, 180, 44, "mini"}, {140, 420, 148, "wide"}, {60, 120, 64, "tiny"},
};
static const uint32_t kTimes[] = {0, 777, 1500, 3333, 7001, 12345, 30011, 60007};

int main(int argc, char** argv) {
  if (argc < 3) return 2;
  FILE* bin = fopen(argv[1], "wb");
  FILE* txt = fopen(argv[2], "w");
  if (!bin || !txt) return 3;
  for (int ci = 0; ci < 4; ++ci) {
    const Cfg& c = kCfgs[ci];
    ThinkingOrb orb;
    if (!orb.begin((uint16_t)c.diameter, (uint16_t)c.capacity)) return 4;
    std::vector<uint8_t> buf((size_t)c.dim * c.dim);
    for (int m = 0; m < (int)OrbMode::ModeCount; ++m) {
      orb.setMode((OrbMode)m);
      double dots = 0, lines = 0, box = 0, inside = 0, steps = 0;
#ifdef OPCOUNT
      unsigned long renderOps[kOpKinds] = {0}, paintOps[kOpKinds] = {0};
#endif
      for (uint32_t t : kTimes) {
#ifdef OPCOUNT
        memset(gOps, 0, sizeof gOps);
#endif
        const OrbFrame f = orb.render(t);
#ifdef OPCOUNT
        for (int k = 0; k < kOpKinds; ++k) renderOps[k] += gOps[k];
        memset(gOps, 0, sizeof gOps);
#endif
        // Dirty on purpose: the painter must overwrite every byte, whatever was there before.
        memset(buf.data(), 0xA5, buf.size());
        paintOrbCoverage(f, buf.data(), (int16_t)c.dim);
#ifdef OPCOUNT
        for (int k = 0; k < kOpKinds; ++k) paintOps[k] += gOps[k];
#endif
        {
          // The contract is "cleared and fully redrawn each call". Paint again over a DIFFERENT
          // dirty pattern: any byte the painter forgets to rewrite (a bounded clear that misses a
          // corner, a skipped row) survives from the fill and the two buffers disagree.
          std::vector<uint8_t> other(buf.size(), 0x3C);
          paintOrbCoverage(f, other.data(), (int16_t)c.dim);
          if (other != buf) { fprintf(stderr, "painter left stale bytes: cfg %d mode %d t %u\n", ci, m, t); return 5; }
        }
        const int mid = c.dim / 2;
        dots += f.count; lines += f.lineCount;
        // The same bounding boxes the splat loop walks, so "pixels evaluated" is a fact about the
        // frame rather than a timing.
        for (uint16_t i = 0; i < f.count; ++i) {
          const OrbDot& d = f.dots[i];
          const float fx = mid + d.x16 / 16.0f, fy = mid + d.y16 / 16.0f, r = d.r16 / 16.0f;
          if (d.ink * (d.alpha / 255.0f) < 1.0f) continue;
          const float outer = r + 0.5f;
          const int x0 = (int)std::floor(fx - outer), x1 = (int)std::ceil(fx + outer);
          const int y0 = (int)std::floor(fy - outer), y1 = (int)std::ceil(fy + outer);
          for (int py = y0; py <= y1; ++py) for (int px = x0; px <= x1; ++px) {
            if (px < 0 || py < 0 || px >= c.dim || py >= c.dim) continue;
            box += 1;
            const float dx = px + 0.5f - fx, dy = py + 0.5f - fy;
            if (dx * dx + dy * dy < outer * outer) inside += 1;
          }
        }
        for (uint16_t i = 0; i < f.lineCount; ++i) {
          const OrbLine& L = f.lines[i];
          const float ex = (L.x16b - L.x16a) / 16.0f, ey = (L.y16b - L.y16a) / 16.0f;
          const float len = std::sqrt(ex * ex + ey * ey);
          if (len >= 0.5f && L.ink * (L.alpha / 255.0f) >= 1.0f) steps += std::ceil(len) + 1;
        }
        const int32_t hdr[5] = {ci, m, (int32_t)t, f.count, f.lineCount};
        fwrite(hdr, sizeof hdr, 1, bin);
        fwrite(buf.data(), 1, buf.size(), bin);
      }
      const double n = sizeof kTimes / sizeof kTimes[0];
      fprintf(txt, "%s %s dots=%.1f lines=%.1f splatBoxPx=%.0f splatInsidePx=%.0f lineSteps=%.0f", c.name,
              orbStateName((OrbMode)m), dots / n, lines / n, box / n, inside / n, steps / n);
#ifdef OPCOUNT
      for (int k = 0; k < kOpKinds; ++k)
        fprintf(txt, " render.%s=%.0f paint.%s=%.0f", kOpNames[k], renderOps[k] / n, kOpNames[k], paintOps[k] / n);
#endif
      fprintf(txt, "\n");
    }
  }
  fclose(bin); fclose(txt);
  return 0;
}
