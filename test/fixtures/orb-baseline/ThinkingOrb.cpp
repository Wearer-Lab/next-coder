#include "ThinkingOrb.h"

#include <algorithm>
#include <math.h>

// Ported from Thinking Orbs by Jakub Antalik.
//   https://orbs.jakubantalik.com  ·  https://github.com/Jakubantalik/Libraries
//   MIT License, Copyright (c) 2026 Jakub Antalik.
//
// Ported from the engine sources (src/engine/{core,lattice,web}.ts), not from the spec JSON alone.
// The spec gives the tuning constants; the engine gives what they mean, and an earlier pass here
// guessed wrong about three of them:
//
//   * rsPow is the exponent of radiusScale(size) = (size/300)^pow — a sub-linear correction so a
//     small orb keeps legible dots — NOT an exponent applied to depth.
//   * radius is LINEAR in depth: (rBase + rDepth * depth) * radiusScale.
//   * ink is `white = inkFar - inkSpan * depth`, where `white` is ink-on-paper and a dark ground
//     mirrors it to (1 - white). Near dots end bright, far dots genuinely dim.
//
// The motion detail matters as much as the geometry. Globe's tilt breathes rather than sitting
// still, and a scan meridian sweeps the sphere swelling dots as it passes. Web's nodes wander under
// value noise instead of sitting on a fixed lattice. Those are what make it read as alive rather
// than as a spinning model, and they are cheap.
//
// Divergences from the web original, all forced by the target:
//   * Density scales to a dot budget as well as size: a browser affords 750 dots at 60fps, a
//     240 MHz Xtensa pushing SPI does not.
//   * Output is fixed-point (sixteenths of a pixel) rather than float, so the painter can
//     anti-alias without the geometry step rounding first.
//   * No per-dot alpha blending against arbitrary content — the ground is uniform, so alpha folds
//     into coverage in the painter.

namespace {

struct Profile {
  uint8_t latRings;
  uint8_t lonDensity;
  float rBase;
  float rDepth;
  float inkFar;
  float inkSpan;
  float speed;     // multiplies elapsed seconds before any mode maths
  float count;     // density multiplier
  float rsPow;     // exponent of radiusScale
  float dimBase;   // layers below the highlight fade to this
};

constexpr float kRMin = 0.3f;
constexpr float kCullAlpha = 0.02f;
constexpr float kPi = 3.14159265358979f;

// Order must match OrbMode exactly.
const Profile kProfiles[] = {
  /* Orbits  */ { 0,  0,   1.20f, 1.60f, 0.55f, 0.45f, 1.885f, 1.00f, 0.6f, 1.00f },
  /* Globe   */ { 17, 44,  0.60f, 1.70f, 0.62f, 0.54f, 2.015f, 1.00f, 0.6f, 0.45f },
  /* Rubik   */ { 15, 40,  0.60f, 1.70f, 0.62f, 0.54f, 1.820f, 0.85f, 0.6f, 1.00f },
  /* Wave    */ { 15, 40,  0.60f, 1.70f, 0.62f, 0.54f, 4.388f, 0.90f, 0.6f, 1.00f },
  /* Web     */ { 0,  0,   1.40f, 1.80f, 0.55f, 0.45f, 2.400f, 1.00f, 0.6f, 1.00f },
  /* Braid   */ { 0,  0,   1.20f, 1.80f, 0.55f, 0.45f, 1.600f, 1.00f, 0.6f, 1.00f },
  /* Ribbon  */ { 5,  88,  1.10f, 1.70f, 0.52f, 0.44f, 1.500f, 0.85f, 0.6f, 1.00f },
  /* Ring    */ { 5,  88,  1.10f, 1.70f, 0.52f, 0.44f, 1.200f, 0.85f, 0.6f, 1.00f },
  /* Morph   */ { 0,  0,   1.10f, 0.00f, 0.20f, 0.00f, 1.000f, 1.00f, 0.6f, 1.00f },
};

const Profile& profileFor(OrbMode m) { return kProfiles[static_cast<uint8_t>(m)]; }


// Deterministic hash in [0,1), and smooth value noise on a 2D lattice. Web's nodes drift under
// this rather than sitting on their lattice positions, which is the difference between a
// constellation that is alive and one that is merely rotating.
float hashD(float a, float b) {
  const float h = sinf(a * 12.9898f + b * 78.233f) * 43758.5453f;
  return h - floorf(h);
}

float vnoise(float x, float y) {
  const float xi = floorf(x), yi = floorf(y);
  float fx = x - xi, fy = y - yi;
  fx = fx * fx * (3.0f - 2.0f * fx);
  fy = fy * fy * (3.0f - 2.0f * fy);
  const float a = hashD(xi, yi);
  const float b = hashD(xi + 1, yi);
  const float c = hashD(xi, yi + 1);
  const float d = hashD(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// Shortest signed angular distance, wrapped to (-pi, pi].
//
// The reference uses atan2(sin(d), cos(d)), which is three transcendentals; called once per dot on
// a 500-dot globe that is 1500 a frame for something a subtraction and a wrap can do exactly.
float angleDelta(float a, float b) {
  float d = fmodf(a - b + kPi, 2.0f * kPi);
  if (d < 0.0f) d += 2.0f * kPi;
  return d - kPi;
}

void fibDir(int i, int n, float& x, float& y, float& z) {
  const float golden = kPi * (3.0f - sqrtf(5.0f));
  y = 1.0f - (2.0f * (i + 0.5f)) / n;
  const float rad = sqrtf(fmaxf(0.0f, 1.0f - y * y));
  const float a = i * golden;
  x = rad * cosf(a);
  z = rad * sinf(a);
}

inline uint8_t clamp8(float v) {
  if (v <= 0.0f) return 0;
  if (v >= 255.0f) return 255;
  return (uint8_t)lroundf(v);
}

// `white` is ink-on-paper, 0 = darkest. The ground here is dark, so it mirrors.
inline uint8_t inkFromWhite(float white) {
  if (white < 0.0f) white = 0.0f;
  if (white > 1.0f) white = 1.0f;
  return clamp8((1.0f - white) * 255.0f);
}

inline int16_t toFixed(float px) {
  const float v = px * 16.0f;
  if (v < -32000.0f) return -32000;
  if (v > 32000.0f) return 32000;
  return (int16_t)lroundf(v);
}

}  // namespace

struct ThinkingOrb::Scratch {
  OrbDot dot;
  float z;
};

bool ThinkingOrb::begin(uint16_t diameter, uint16_t capacity) {
  end();
  if (diameter < 8 || capacity < 16) return false;

  diameter_ = diameter;
  radiusPx_ = diameter * 0.5f;
  capacity_ = capacity;

  dots_ = (OrbDot*)malloc(sizeof(OrbDot) * capacity_);
  scratch_ = (Scratch*)malloc(sizeof(Scratch) * capacity_);
  lines_ = (OrbLine*)malloc(sizeof(OrbLine) * kMaxLines);
  if (!dots_ || !scratch_ || !lines_) {
    end();
    return false;
  }

  buildGeometry();
  return true;
}

void ThinkingOrb::end() {
  free(dots_);   dots_ = nullptr;
  free(scratch_); scratch_ = nullptr;
  free(lines_);  lines_ = nullptr;
  capacity_ = 0;
  lineCount_ = 0;
}

void ThinkingOrb::setMode(OrbMode mode) {
  if (mode == mode_) return;
  mode_ = mode;
  buildGeometry();
}

// The reference scales a lat/lon pair by sqrt(count) so both axes thin evenly and the sphere stays
// a sphere. The dot budget is applied the same way.
void ThinkingOrb::buildGeometry() {
  const Profile& p = profileFor(mode_);
  if (p.latRings == 0) {
    latRings_ = 0;
    lonDensity_ = 0;
    return;
  }

  const float countScale = sqrtf(p.count);
  float lat = fmaxf(2.0f, roundf(p.latRings * countScale));
  float lon = fmaxf(2.0f, roundf(p.lonDensity * countScale));

  if (capacity_ > 0 && lat * lon > capacity_) {
    const float fit = sqrtf((float)capacity_ / (lat * lon));
    lat = fmaxf(2.0f, floorf(lat * fit));
    lon = fmaxf(2.0f, floorf(lon * fit));
  }

  latRings_ = (uint8_t)lat;
  lonDensity_ = (uint8_t)lon;
}

void ThinkingOrb::setProjection(float yaw, float tilt, float scale) {
  cosYaw_ = cosf(yaw);   sinYaw_ = sinf(yaw);
  cosTilt_ = cosf(tilt); sinTilt_ = sinf(tilt);
  scale_ = scale;
}

// Returns screen offset from the centre, plus depth in 0..1. The clamp is load-bearing: modes that
// breathe push points slightly off the unit sphere, and a fractionally negative depth used to reach
// powf() as a NaN and come back as a dot the width of the canvas.
bool ThinkingOrb::projectPoint(float x, float y, float z, float& px, float& py, float& depth) const {
  const float x1 = x * cosYaw_ + z * sinYaw_;
  const float z1 = -x * sinYaw_ + z * cosYaw_;
  const float y1 = y * cosTilt_ - z1 * sinTilt_;
  const float z2 = y * sinTilt_ + z1 * cosTilt_;

  px = x1 * scale_;
  py = -y1 * scale_;          // screen Y grows downward
  depth = (z2 + 1.0f) * 0.5f;
  if (depth < 0.0f) depth = 0.0f;
  if (depth > 1.0f) depth = 1.0f;
  return true;
}

float ThinkingOrb::radiusScale() const {
  // Radii were tuned for a 300 pt frame; sub-linear scaling keeps a small orb legible.
  const Profile& p = profileFor(mode_);
  return powf(diameter_ / 300.0f, p.rsPow);
}

void ThinkingOrb::pushDot(float px, float py, float z01, float radiusPx, float white, float alpha,
                          uint16_t& n) {
  if (n >= capacity_) return;
  if (alpha < kCullAlpha) return;

  float r = radiusPx < kRMin ? kRMin : radiusPx;
  const long r16 = lroundf(r * 16.0f);
  const long bounded = r16 < 5L ? 5L : (r16 > 160L ? 160L : r16);

  Scratch& s = scratch_[n++];
  s.z = z01;
  s.dot.x16 = toFixed(px);
  s.dot.y16 = toFixed(py);
  s.dot.r16 = (uint8_t)bounded;
  s.dot.ink = inkFromWhite(white);
  s.dot.alpha = clamp8(alpha * 255.0f);
}

// --- Globe: a lat/long field with a scan meridian sweeping it ---------------------------------
uint16_t ThinkingOrb::emitGlobe(float t) {
  const Profile& p = profileFor(mode_);
  const float spin = 0.5f;
  // The tilt breathes. A fixed tilt reads as a model on a turntable; this reads as something alive.
  const float tilt = 0.4f + 0.06f * sinf(t * 0.35f);
  setProjection(t * spin, tilt, radiusPx_ * 0.82f);

  const float scan = t * (spin + (1.7f - spin) * 4.08f);
  const float rs = radiusScale();

  uint16_t n = 0;
  for (uint8_t li = 0; li <= latRings_; ++li) {
    const float lat = -kPi / 2.0f + ((float)li / latRings_) * kPi;
    const float cosLat = cosf(lat), sinLat = sinf(lat);
    const uint16_t lonCount = (uint16_t)fmaxf(1.0f, roundf(fabsf(cosLat) * lonDensity_));
    for (uint16_t lj = 0; lj < lonCount; ++lj) {
      const float lon = ((float)lj / lonCount) * 2.0f * kPi;
      float px, py, depth;
      projectPoint(cosLat * cosf(lon), sinLat, cosLat * sinf(lon), px, py, depth);

      // The scan reads as a size ripple rather than a shine, so it survives a panel with no
      // gradients at all.
      const float d = angleDelta(lon + t * spin, scan);
      const float zSigned = depth * 2.0f - 1.0f;
      const float boost = expf(-(d * d) / 0.18f) * fmaxf(0.0f, zSigned);

      pushDot(px, py, depth,
              (p.rBase + p.rDepth * depth + boost) * rs,
              p.inkFar - p.inkSpan * depth,
              p.dimBase + (1.0f - p.dimBase) * fminf(1.0f, boost),
              n);
    }
  }
  return n;
}

// --- Wave: the same field, rings breathing with amplitude ------------------------------------
uint16_t ThinkingOrb::emitWave(float t) {
  const Profile& p = profileFor(mode_);
  setProjection(t * 0.4f, 0.36f + 0.05f * sinf(t * 0.3f), radiusPx_ * 0.82f);
  const float rs = radiusScale();

  uint16_t n = 0;
  for (uint8_t li = 0; li <= latRings_; ++li) {
    const float u = (float)li / latRings_;
    const float lat = -kPi / 2.0f + u * kPi;
    const float cosLat = cosf(lat), sinLat = sinf(lat);
    const uint16_t lonCount = (uint16_t)fmaxf(1.0f, roundf(fabsf(cosLat) * lonDensity_));

    // The swell rides the RADIUS, not the position. Displacing points off the unit sphere is what
    // produced out-of-range depths; amplitude belongs in how big a dot is, not where it is.
    const float swell = 1.0f + 0.35f * sinf(t * 2.2f - u * 6.0f);

    for (uint16_t lj = 0; lj < lonCount; ++lj) {
      const float lon = ((float)lj / lonCount) * 2.0f * kPi;
      float px, py, depth;
      projectPoint(cosLat * cosf(lon), sinLat, cosLat * sinf(lon), px, py, depth);
      pushDot(px, py, depth,
              (p.rBase + p.rDepth * depth) * swell * rs,
              p.inkFar - p.inkSpan * depth,
              1.0f, n);
    }
  }
  return n;
}

// --- Ring: face-on concentric lanes, the calm state -------------------------------------------
uint16_t ThinkingOrb::emitRing(float t) {
  const Profile& p = profileFor(mode_);
  setProjection(0.0f, 0.0f, radiusPx_ * 0.82f);
  const float rs = radiusScale();

  uint16_t n = 0;
  const uint8_t lanes = latRings_;
  for (uint8_t i = 0; i < lanes; ++i) {
    const float laneR = 0.34f + 0.60f * ((i + 1) / (float)lanes);
    const float breathe = 1.0f + 0.04f * sinf(t * 0.9f - i * 0.55f);
    const uint16_t segs = lonDensity_;
    for (uint16_t j = 0; j < segs; ++j) {
      const float theta = ((float)j / segs) * 2.0f * kPi + t * (0.14f + i * 0.035f);
      const float rr = laneR * breathe;
      float px, py, depth;
      projectPoint(cosf(theta) * rr, sinf(theta) * rr, 0.0f, px, py, depth);
      // Face-on has no real depth, so brightness travels around each lane instead.
      const float phase = 0.5f + 0.5f * sinf(theta * 2.0f - t * 1.1f);
      pushDot(px, py, depth,
              (p.rBase + p.rDepth * 0.45f) * rs,
              p.inkFar - p.inkSpan * phase,
              0.55f + 0.45f * phase, n);
    }
  }
  return n;
}

// --- Orbits: particles riding inclined rings ---------------------------------------------------
uint16_t ThinkingOrb::emitOrbits(float t) {
  const Profile& p = profileFor(mode_);
  setProjection(t * 0.25f, 0.5f, radiusPx_ * 0.82f);
  const float rs = radiusScale();

  uint16_t n = 0;
  const uint8_t orbits = 7;
  const uint16_t perOrbit = (uint16_t)std::max(8, std::min(44, capacity_ / (orbits + 1)));
  for (uint8_t o = 0; o < orbits; ++o) {
    const float incl = ((float)o / orbits) * kPi;
    const float cosI = cosf(incl), sinI = sinf(incl);
    for (uint16_t j = 0; j < perOrbit; ++j) {
      const float a = ((float)j / perOrbit) * 2.0f * kPi + t * (0.55f + o * 0.08f);
      float px, py, depth;
      projectPoint(cosf(a), sinf(a) * sinI, sinf(a) * cosI, px, py, depth);
      pushDot(px, py, depth,
              (p.rBase + p.rDepth * depth) * rs,
              p.inkFar - p.inkSpan * depth,
              0.35f + 0.65f * depth, n);
    }
  }
  return n;
}

// --- Web: a constellation wiring itself --------------------------------------------------------
uint16_t ThinkingOrb::emitWeb(float t) {
  const Profile& p = profileFor(mode_);
  // Barely turning. "Connecting" is about the links forming, not about rotation.
  setProjection(t * 0.12f, 0.32f, radiusPx_ * 0.80f);
  const float rs = radiusScale();

  constexpr int kNodes = 30;
  constexpr float kThr = 0.72f;
  float nx[kNodes], ny[kNodes], nz[kNodes];

  for (int i = 0; i < kNodes; ++i) {
    float dx, dy, dz;
    fibDir(i, kNodes, dx, dy, dz);
    // Slow noise wander, renormalised back onto the surface. This is the organic part: the lattice
    // gives an even spread, the noise stops it looking manufactured.
    float x = dx + 0.3f * (vnoise(i * 0.31f + 9.0f, t * 0.24f) - 0.5f) * 2.0f;
    float y = dy + 0.3f * (vnoise(i * 0.53f + 27.0f, t * 0.21f) - 0.5f) * 2.0f;
    float z = dz + 0.3f * (vnoise(i * 0.77f + 55.0f, t * 0.27f) - 0.5f) * 2.0f;
    const float l = fmaxf(1e-6f, sqrtf(x * x + y * y + z * z));
    nx[i] = x / l; ny[i] = y / l; nz[i] = z / l;
  }

  // Edges between close neighbours, faded by proximity and depth.
  lineCount_ = 0;
  for (int i = 0; i < kNodes && lineCount_ < kMaxLines; ++i) {
    for (int j = i + 1; j < kNodes && lineCount_ < kMaxLines; ++j) {
      const float dx = nx[i] - nx[j], dy = ny[i] - ny[j], dz = nz[i] - nz[j];
      const float dist = sqrtf(dx * dx + dy * dy + dz * dz);
      if (dist >= kThr) continue;

      float ax, ay, ad, bx, by, bd;
      projectPoint(nx[i], ny[i], nz[i], ax, ay, ad);
      projectPoint(nx[j], ny[j], nz[j], bx, by, bd);
      const float depth = (ad + bd) * 0.5f;
      const float alpha = (1.0f - dist / kThr) * (0.3f + 0.55f * depth);
      if (alpha < kCullAlpha) continue;

      OrbLine& L = lines_[lineCount_++];
      L.x16a = toFixed(ax); L.y16a = toFixed(ay);
      L.x16b = toFixed(bx); L.y16b = toFixed(by);
      L.ink = inkFromWhite(0.42f);
      L.alpha = clamp8(alpha * 255.0f);
      L.w16 = (uint8_t)std::max(10L, lroundf(0.8f * rs * 16.0f));
    }
  }

  uint16_t n = 0;
  for (int i = 0; i < kNodes; ++i) {
    float px, py, depth;
    projectPoint(nx[i], ny[i], nz[i], px, py, depth);
    // Pulse on the radius, never on the position.
    const float pulse = 1.0f + 0.25f * sinf(t * 1.4f + i * 2.7f);
    pushDot(px, py, depth, (p.rBase + p.rDepth * depth) * pulse * rs,
            0.55f - 0.45f * depth, 1.0f, n);
  }

  // Signals: bright packets running between re-picked pairs. Small, but they are what make the
  // constellation look like it is doing something rather than merely existing.
  constexpr int kSignals = 5;
  for (int s = 0; s < kSignals; ++s) {
    const float seg = floorf(t * 0.55f + s * 7.31f);
    const int a = (int)(hashD(seg, s * 3.1f + 1.7f) * kNodes) % kNodes;
    const int b = (int)(hashD(seg, s * 5.7f + 4.2f) * kNodes) % kNodes;
    if (a == b) continue;
    const float f = (t * 0.55f + s * 7.31f) - seg;
    float x = nx[a] + (nx[b] - nx[a]) * f;
    float y = ny[a] + (ny[b] - ny[a]) * f;
    float z = nz[a] + (nz[b] - nz[a]) * f;
    const float l = fmaxf(1e-6f, sqrtf(x * x + y * y + z * z));
    float px, py, depth;
    projectPoint(x / l, y / l, z / l, px, py, depth);
    pushDot(px, py, depth, (p.rBase * 1.5f + p.rDepth * depth) * rs,
            0.05f, 0.5f + 0.5f * depth, n);
  }
  return n;
}

// --- Ghost sphere: the faint dotted shell braid and ribbon sit inside --------------------------
uint16_t ThinkingOrb::emitGhostSphere(float t, float R, uint16_t& n) {
  const float rs = radiusScale();
  constexpr int kGhost = 110;
  for (int i = 0; i < kGhost; ++i) {
    float dx, dy, dz;
    fibDir(i, kGhost, dx, dy, dz);
    float px, py, depth;
    projectPoint(dx, dy, dz, px, py, depth);
    // Very faint and very small: this is a hint of the surface the strands wrap, not a globe.
    pushDot(px, py, depth, 0.8f * rs, 0.78f, 0.10f + 0.22f * depth, n);
  }
  return n;
}

// --- Rubik: bands twist in quarter turns, scramble then solve --------------------------------
uint16_t ThinkingOrb::emitRubik(float t) {
  const Profile& p = profileFor(mode_);
  setProjection(t * 0.55f, 0.35f + 0.1f * sinf(t * 0.9f), radiusPx_ * 0.82f);
  const float rs = radiusScale();

  // The palindrome: moves apply in order, then unwind in reverse, so the sphere always clicks back
  // to solved and rests before scrambling again. That resolution is the whole character of the
  // state — an agent that finishes, not one that churns.
  constexpr int kMoves = 14;
  constexpr float kSlot = 0.42f, kRest = 1.2f;
  const float cyc = 2 * kMoves * kSlot + kRest;
  const float tc = fmodf(t, cyc);

  float amount[kMoves] = {0};
  int active = -1;
  if (tc < 2 * kMoves * kSlot) {
    const int slot = (int)(tc / kSlot);
    const float prog = (tc - slot * kSlot) / kSlot;
    const float cl = fminf(1.0f, prog / 0.7f);
    const float ep = 1.0f - powf(1.0f - cl, 3.0f);   // machine ease-out
    if (slot < kMoves) {
      for (int i = 0; i < slot; ++i) amount[i] = 1.0f;
      amount[slot] = ep;
      active = slot;
    } else {
      const int u = 2 * kMoves - 1 - slot;
      for (int i = 0; i < u; ++i) amount[i] = 1.0f;
      if (u >= 0 && u < kMoves) amount[u] = 1.0f - ep;
      active = u;
    }
  }

  // The move table is built ONCE per frame, not once per dot.
  //
  // These values depend only on the move index, but they were being recomputed inside the per-dot
  // loop: three hashD calls (each a sinf) and a cos/sin pair, for every one of ~500 dots times 14
  // moves. That is roughly 35,000 transcendental calls a frame, and it measured as a draw time of
  // 184 ms against a 33 ms budget — the freeze. Hoisted, it is 14 iterations.
  struct MoveRow { int axis; float lo; float ca; float sa; bool live; };
  MoveRow rows[kMoves];
  for (int i = 0; i < kMoves; ++i) {
    rows[i].live = amount[i] > 0.0f;
    if (!rows[i].live) continue;
    rows[i].axis = (int)fminf(2.0f, floorf(hashD(i, 2.3f) * 3.0f));
    rows[i].lo = -1.0f + 0.5f * fminf(3.0f, floorf(hashD(i, 5.9f) * 4.0f));
    const float dir = hashD(i, 7.7f) < 0.5f ? 1.0f : -1.0f;
    const float a = dir * (kPi / 2.0f) * amount[i];
    rows[i].ca = cosf(a);
    rows[i].sa = sinf(a);
  }

  uint16_t n = 0;
  for (uint8_t li = 0; li <= latRings_; ++li) {
    const float lat = -kPi / 2.0f + ((float)li / latRings_) * kPi;
    const float cosLat = cosf(lat), sinLat = sinf(lat);
    const uint16_t lonCount = (uint16_t)fmaxf(1.0f, roundf(fabsf(cosLat) * lonDensity_));
    for (uint16_t lj = 0; lj < lonCount; ++lj) {
      const float lon = ((float)lj / lonCount) * 2.0f * kPi;
      float x = cosLat * cosf(lon), y = sinLat, z = cosLat * sinf(lon);
      bool inActive = false;

      for (int i = 0; i < kMoves; ++i) {
        const MoveRow& m = rows[i];
        if (!m.live) continue;
        const float coord = m.axis == 0 ? x : (m.axis == 1 ? y : z);
        if (coord < m.lo || coord >= m.lo + 0.5f) continue;
        if (i == active) inActive = true;

        if (m.axis == 0)      { const float y2 = y * m.ca - z * m.sa; z = y * m.sa + z * m.ca; y = y2; }
        else if (m.axis == 1) { const float x2 = x * m.ca + z * m.sa; z = -x * m.sa + z * m.ca; x = x2; }
        else                  { const float x2 = x * m.ca - y * m.sa; y = x * m.sa + y * m.ca; x = x2; }
      }

      float px, py, depth;
      projectPoint(x, y, z, px, py, depth);
      pushDot(px, py, depth,
              (p.rBase + p.rDepth * depth) * rs,
              p.inkFar - p.inkSpan * depth,
              inActive ? 1.0f : 0.72f, n);   // the turning band reads brighter
    }
  }
  return n;
}

// --- Braid: three strands plait around the sphere ---------------------------------------------
uint16_t ThinkingOrb::emitBraid(float t) {
  const Profile& p = profileFor(mode_);
  setProjection(t * 0.4f, 0.3f, radiusPx_ * 0.76f);
  const float rs = radiusScale();

  uint16_t n = 0;
  emitGhostSphere(t, 1.0f, n);

  constexpr int kStrand = 46;
  constexpr float kTurns = 3.0f;
  for (int s = 0; s < 3; ++s) {
    const float phase = ((float)s / 3.0f) * 2.0f * kPi;
    for (int i = 0; i < kStrand; ++i) {
      // u walks pole to pole; the wrap slides the whole strand along its own helix.
      float f = (float)i / kStrand + t * 0.045f;
      f -= floorf(f);
      const float u = (f * 2.0f - 1.0f) * 0.96f;
      const float surf = sqrtf(fmaxf(0.0f, 1.0f - u * u));
      const float endFade = fminf(1.0f, (1.0f - fabsf(u)) / 0.1f);
      const float a = u * kPi * kTurns + phase;
      // Radial breathing is what reads as over/under: the strands trade places rather than merely
      // running parallel.
      const float weave = 1.0f + 0.075f * sinf(u * kPi * kTurns * 2.0f + phase * 2.0f + t * 0.8f);
      const float rr = surf * weave;

      float px, py, depth;
      projectPoint(cosf(a) * rr, u * weave, sinf(a) * rr, px, py, depth);
      pushDot(px, py, depth,
              (p.rBase + p.rDepth * depth) * rs,
              0.55f - 0.45f * depth,
              endFade * (0.45f + 0.55f * depth), n);
    }
  }
  return n;
}

// --- Ribbon / Ring: an undulating multi-band sash ---------------------------------------------
uint16_t ThinkingOrb::emitRibbon(float t, bool faceOn) {
  const Profile& p = profileFor(mode_);
  const float camTilt = 0.3f;
  setProjection(t * 0.1f, camTilt, radiusPx_ * 0.78f);
  const float rs = radiusScale();

  uint16_t n = 0;
  emitGhostSphere(t, 1.0f, n);

  // The band's own frame: u and v span its plane, nrm is its normal. Advancing ya and ta rotates
  // the sash independently of the camera, which is what stops it looking like a painted stripe.
  const float ya = t * 0.24f;
  const float ta = faceOn ? -camTilt : 0.55f + 0.3f * sinf(t * 0.18f);
  const float ux = cosf(ya), uy = 0.0f, uz = sinf(ya);
  const float vx = -uz * sinf(ta), vy = cosf(ta), vz = ux * sinf(ta);
  const float nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;

  const float wobAmp = 0.23f;
  const float baseR = faceOn ? 1.0f / (1.0f + 0.85f * wobAmp) : 1.0f;
  const int lanes = latRings_ > 0 ? latRings_ : 5;
  const int segs = lonDensity_ > 0 ? lonDensity_ : 88;

  for (int w = 0; w < lanes; ++w) {
    const float laneOff = (w - (lanes - 1) / 2.0f) * 0.075f;
    const float edge = fabsf(w - (lanes - 1) / 2.0f) / fmaxf(1.0f, (lanes - 1) / 2.0f);
    for (int k = 0; k < segs; ++k) {
      const float a = ((float)k / segs) * 2.0f * kPi;
      const float wob = 0.16f * sinf(a * 3.0f - t * 1.7f + w * 0.22f)
                      + 0.07f * sinf(a * 5.0f + t * 1.1f);

      // Face-on modulates the in-plane radius so lobes genuinely swell outward; the sash instead
      // wobbles out of plane, where re-normalisation pins the silhouette at R.
      const float radial = faceOn ? 1.0f + wob : 1.0f;
      const float off = faceOn ? laneOff : laneOff + wob;

      float x = ux * cosf(a) + vx * sinf(a) + nx * off;
      float y = uy * cosf(a) + vy * sinf(a) + ny * off;
      float z = uz * cosf(a) + vz * sinf(a) + nz * off;
      const float l = fmaxf(1e-6f, sqrtf(x * x + y * y + z * z));
      const float rr = baseR * radial;

      float px, py, depth;
      projectPoint((x / l) * rr, (y / l) * rr, (z / l) * rr, px, py, depth);
      pushDot(px, py, depth,
              (p.rBase + p.rDepth * depth) * (1.0f - 0.25f * edge) * rs,
              p.inkFar - p.inkSpan * depth + 0.18f * edge,
              0.40f + 0.60f * depth, n);
    }
  }
  return n;
}

// --- Morph: a dotted outline cycling circle -> triangle -> square ------------------------------
namespace {

// Each shape is sampled by arc-length fraction so dots stay evenly spaced whatever the outline,
// and so two shapes can be blended by interpolating corresponding points.
void shapePoint(int shape, float f, float& x, float& y) {
  if (shape == 0) {                       // circle
    const float a = -kPi / 2.0f + f * 2.0f * kPi;
    x = cosf(a) * 0.24f; y = sinf(a) * 0.24f;
    return;
  }
  static const float tri[3][2]  = {{0.0f, -0.26f}, {0.24f, 0.16f}, {-0.24f, 0.16f}};
  // Five vertices so the square's path starts at top-centre like the others; a mismatch there
  // makes the morph rotate as it transitions.
  static const float sq[5][2]   = {{0.0f, -0.2f}, {0.2f, -0.2f}, {0.2f, 0.2f},
                                   {-0.2f, 0.2f}, {-0.2f, -0.2f}};
  const int V = shape == 1 ? 3 : 5;
  const float (*verts)[2] = shape == 1 ? tri : sq;

  float len[5], total = 0.0f;
  for (int i = 0; i < V; ++i) {
    const float dx = verts[(i + 1) % V][0] - verts[i][0];
    const float dy = verts[(i + 1) % V][1] - verts[i][1];
    len[i] = sqrtf(dx * dx + dy * dy);
    total += len[i];
  }
  float target = f * total;
  int i = 0;
  while (i < V - 1 && target > len[i]) { target -= len[i]; ++i; }
  const float ff = len[i] > 0.0f ? fminf(1.0f, target / len[i]) : 0.0f;
  x = verts[i][0] + (verts[(i + 1) % V][0] - verts[i][0]) * ff;
  y = verts[i][1] + (verts[(i + 1) % V][1] - verts[i][1]) * ff;
}

}  // namespace

uint16_t ThinkingOrb::emitMorph(float t) {
  const Profile& p = profileFor(mode_);
  setProjection(0.0f, 0.0f, radiusPx_ * 2.0f);   // shapes are authored in ±0.26 units
  const float rs = radiusScale();

  constexpr float kHold = 1.4f, kMorph = 0.9f;
  constexpr float kSeg = kHold + kMorph;
  const int K = 3;
  const float tc = fmodf(t, kSeg * K);
  const int k = (int)(tc / kSeg);
  const float local = tc - k * kSeg;

  // Smoothstep, so the shapes ease into each other instead of sliding linearly.
  float m = 0.0f;
  if (local > kHold) {
    const float u = (local - kHold) / kMorph;
    m = u * u * (3.0f - 2.0f * u);
  }

  constexpr int kDots = 108;
  const float pulse = 1.0f + 0.02f * sinf(local * 3.1f);

  uint16_t n = 0;
  for (int i = 0; i < kDots; ++i) {
    const float f = (float)i / kDots;
    float ax, ay, bx, by;
    shapePoint(k, f, ax, ay);
    shapePoint((k + 1) % K, f, bx, by);
    const float x = (ax + (bx - ax) * m) * pulse;
    const float y = (ay + (by - ay) * m) * pulse;

    float px, py, depth;
    projectPoint(x, y, 0.0f, px, py, depth);
    // Flat by nature, so every dot is the same size and weight; the outline is the whole message.
    pushDot(px, py, 0.5f, p.rBase * rs, p.inkFar, 1.0f, n);
  }
  return n;
}

OrbFrame ThinkingOrb::render(uint32_t elapsedMs) {
  if (!dots_ || !scratch_) return {nullptr, 0, nullptr, 0};

  const Profile& p = profileFor(mode_);
  const float t = (elapsedMs / 1000.0f) * p.speed * speed_;

  lineCount_ = 0;
  uint16_t n = 0;
  switch (mode_) {
    case OrbMode::Orbits: n = emitOrbits(t);       break;
    case OrbMode::Globe:  n = emitGlobe(t);        break;
    case OrbMode::Rubik:  n = emitRubik(t);        break;
    case OrbMode::Wave:   n = emitWave(t);         break;
    case OrbMode::Web:    n = emitWeb(t);          break;
    case OrbMode::Braid:  n = emitBraid(t);        break;
    case OrbMode::Ribbon: n = emitRibbon(t, false); break;
    case OrbMode::Ring:   n = emitRibbon(t, true);  break;
    case OrbMode::Morph:  n = emitMorph(t);        break;
    default: break;
  }

  // Painter's order: far to near, so a near dot overwrites the one behind it.
  std::sort(scratch_, scratch_ + n, [](const Scratch& a, const Scratch& b) { return a.z < b.z; });
  for (uint16_t i = 0; i < n; ++i) dots_[i] = scratch_[i].dot;

  return {dots_, n, lines_, lineCount_};
}

OrbMode orbModeForAgentState(const String& stateIn) {
  // Case-folded, because this function's whole job is absorbing whatever word the gateway sends
  // and the gateway does not promise a case. GatewayOperate.cpp upper-cases every thread status
  // before it is stored, so every literal below — all lower case — silently failed to match and
  // the mapper returned Ring. That is not a cosmetic miss: Ring is the calm orb labelled "Ready",
  // so a device whose agent was mid-search would have looked idle. Comparing against a word this
  // function was handed is exactly where the normalisation belongs.
  String state = stateIn;
  state.toLowerCase();
  if (state == "running" || state == "working" || state == "dispatched") return OrbMode::Orbits;
  if (state == "searching") return OrbMode::Globe;
  if (state == "solving" || state == "planning") return OrbMode::Rubik;
  if (state == "listening" || state == "recording") return OrbMode::Wave;
  if (state == "connecting" || state == "pairing") return OrbMode::Web;
  if (state == "weaving") return OrbMode::Braid;
  if (state == "composing" || state == "writing") return OrbMode::Ribbon;
  if (state == "shaping") return OrbMode::Morph;
  return OrbMode::Ring;
}

OrbMode orbModeAt(uint8_t index) {
  const uint8_t count = (uint8_t)OrbMode::ModeCount;
  return (OrbMode)(index % count);
}

const char* orbStateName(OrbMode mode) {
  switch (mode) {
    case OrbMode::Orbits: return "working";
    case OrbMode::Globe:  return "searching";
    case OrbMode::Rubik:  return "solving";
    case OrbMode::Wave:   return "listening";
    case OrbMode::Web:    return "connecting";
    case OrbMode::Braid:  return "weaving";
    case OrbMode::Ribbon: return "composing";
    case OrbMode::Ring:   return "breathing";
    case OrbMode::Morph:  return "shaping";
    default: return "idle";
  }
}

const char* orbLabelForMode(OrbMode mode) {
  switch (mode) {
    case OrbMode::Orbits: return "Working";
    case OrbMode::Globe:  return "Searching";
    case OrbMode::Rubik:  return "Solving";
    case OrbMode::Wave:   return "Listening";
    case OrbMode::Web:    return "Connecting";
    case OrbMode::Braid:  return "Weaving";
    case OrbMode::Ribbon: return "Composing";
    case OrbMode::Ring:   return "Thinking";
    case OrbMode::Morph:  return "Shaping";
    default: return "Ready";
  }
}
