#include "OrbPainter.h"
#include "OrbProfile.h"

#include <math.h>
#include <string.h>

namespace {

// floorf()/ceilf() without the libm call, exactly. Each is a 63-instruction function on this core
// and splatDot() made four per dot (~2 000 a frame). `(int)v` truncates toward zero, so the answer
// differs from the floor/ceiling by at most one, decided by a comparison that is exact in float.
// The orb-ab test holds the painted output identical at zero tolerance.
inline int floorInt(float v) {
  const int t = (int)v;
  return v < (float)t ? t - 1 : t;
}
inline int ceilInt(float v) {
  const int t = (int)v;
  return v > (float)t ? t + 1 : t;
}

// Anti-aliased splat. Coverage falls off over one pixel at the rim: wider reads as blurred,
// narrower brings back the aliasing that made a slowly rotating sphere jitter between pixels.
void splatDot(const OrbDot& d, uint8_t* grey, int16_t dim, int16_t mid) {
  const float fx = mid + d.x16 / 16.0f;
  const float fy = mid + d.y16 / 16.0f;
  const float r = d.r16 / 16.0f;
  // Alpha folds into coverage: the ground is uniform, so a half-transparent dot and a half-covered
  // pixel are indistinguishable, and one multiply is cheaper than a blend.
  const float ink = d.ink * (d.alpha / 255.0f);
  if (ink < 1.0f) return;

  const float outer = r + 0.5f;
  const float outer2 = outer * outer;
  const float innerEdge = r - 0.5f;
  const float inner2 = innerEdge > 0.0f ? innerEdge * innerEdge : 0.0f;

  // Clamped to the buffer once, here, instead of testing every pixel of every dot against it. The
  // set of pixels visited is the same — the old loop `continue`d past the same ones — and a dot
  // that is wholly off the buffer now visits none.
  int16_t x0 = (int16_t)floorInt(fx - outer), x1 = (int16_t)ceilInt(fx + outer);
  int16_t y0 = (int16_t)floorInt(fy - outer), y1 = (int16_t)ceilInt(fy + outer);
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > dim - 1) x1 = (int16_t)(dim - 1);
  if (y1 > dim - 1) y1 = (int16_t)(dim - 1);

  for (int16_t py = y0; py <= y1; ++py) {
    const float dy = (py + 0.5f) - fy;
    const float dy2 = dy * dy;
    uint8_t* row = grey + (size_t)py * dim;
    for (int16_t px = x0; px <= x1; ++px) {
      const float dx = (px + 0.5f) - fx;
      const float d2 = dx * dx + dy2;
      // Reject on squared distance first; the bounding-box corners are always outside the disc, so
      // roughly a fifth of every dot's pixels were paying for a sqrt only to be discarded.
      if (d2 >= outer2) continue;
      float cov = 1.0f;
      if (d2 > inner2) cov = outer - sqrtf(d2);
      if (cov <= 0.0f) continue;
      if (cov > 1.0f) cov = 1.0f;
      const uint8_t v = (uint8_t)(ink * cov);
      // Max, not sum: one colour on one ground, so adding would blow out crossings into blobs, and
      // the painter's far-to-near order already decides what reads as being in front.
      if (v > row[px]) row[px] = v;
    }
  }
}

// Walked along the segment rather than rasterised over its bounding box. A near-diagonal edge fills
// a box that is almost entirely empty, and the constellation mode can have a hundred of them.
void strokeLine(const OrbLine& L, uint8_t* grey, int16_t dim, int16_t mid) {
  const float ax = mid + L.x16a / 16.0f, ay = mid + L.y16a / 16.0f;
  const float bx = mid + L.x16b / 16.0f, by = mid + L.y16b / 16.0f;
  const float ink = L.ink * (L.alpha / 255.0f);
  if (ink < 1.0f) return;

  const float ex = bx - ax, ey = by - ay;
  const float len = sqrtf(ex * ex + ey * ey);
  if (len < 0.5f) return;

  const int steps = (int)ceilf(len);
  const float sx = ex / steps, sy = ey / steps;

  for (int st = 0; st <= steps; ++st) {
    const float cx = ax + sx * st, cy = ay + sy * st;
    const int16_t bx0 = (int16_t)floorInt(cx - 1.0f), by0 = (int16_t)floorInt(cy - 1.0f);
    for (int16_t py = by0; py <= by0 + 2; ++py) {
      if (py < 0 || py >= dim) continue;
      uint8_t* row = grey + (size_t)py * dim;
      for (int16_t px = bx0; px <= bx0 + 2; ++px) {
        if (px < 0 || px >= dim) continue;
        const float dx = (px + 0.5f) - cx, dy = (py + 0.5f) - cy;
        const float d2 = dx * dx + dy * dy;
        if (d2 >= 1.0f) continue;
        float cov = 1.0f - sqrtf(d2);
        if (cov <= 0.0f) continue;
        const uint8_t v = (uint8_t)(ink * cov);
        if (v > row[px]) row[px] = v;
      }
    }
  }
}

}  // namespace

#if ORB_PROFILE
OrbProfile gOrbProfile;

bool orbProfileTake(OrbProfile& out) {
  out = gOrbProfile;
  gOrbProfile = OrbProfile{};
  return out.frames != 0;
}
#endif

void paintOrbCoverage(const OrbFrame& frame, uint8_t* grey, int16_t dim) {
  if (!grey || dim <= 0) return;
  // The four probes here and the accumulation below exist only under ORB_PROFILE (OrbProfile.h);
  // a release frame does no timing at all.
  ORB_PROBE(t0);
  memset(grey, 0, (size_t)dim * dim);
  const int16_t mid = dim / 2;
  ORB_PROBE(t1);

  // Edges first, so nodes sit on top of their own links.
  for (uint16_t i = 0; i < frame.lineCount; ++i) strokeLine(frame.lines[i], grey, dim, mid);
  ORB_PROBE(t2);
  for (uint16_t i = 0; i < frame.count; ++i) splatDot(frame.dots[i], grey, dim, mid);
  ORB_PROBE(t3);

#if ORB_PROFILE
  OrbProfile& p = gOrbProfile;
  ++p.frames;
  p.clearUs += t1 - t0;
  p.lineUs += t2 - t1;
  p.dotUs += t3 - t2;
  p.dots += frame.count;
  p.lines += frame.lineCount;
  if (t3 - t0 > p.rasterMaxUs) p.rasterMaxUs = t3 - t0;
#endif
}
