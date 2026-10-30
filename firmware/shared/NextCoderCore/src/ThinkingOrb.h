#pragma once

// A rotating point-cloud sphere: the agent-state indicator for boards with a real display.
//
// Ported from Thinking Orbs by Jakub Antalik (MIT), https://orbs.jakubantalik.com — specifically
// `spec/orbs-spec.json`, which is the library's own machine-readable definition of each mode and
// its parameters. Attribution and licence in ThinkingOrb.cpp.
//
// The component computes; it does not draw. It emits a depth-sorted list of screen-space dots with
// a radius and an ink level, and the board's display adapter paints them however it can. That
// keeps one implementation working across an e-ink panel, an IPS TFT, and an AMOLED, which
// otherwise share nothing.
//
// Why this and not an animated GIF or a sprite sheet: the orb has to represent *which* thing the
// agent is doing, and it has to keep moving during a multi-minute turn without burning flash on
// frames. A parametric sphere is a few hundred floats and reads as alive at 12 fps.

#include <Arduino.h>

// The nine states the upstream library defines, each with its own render mode. The names are the
// library's; the mapping from a Next Coder thread state is in orbModeForAgentState().
enum class OrbMode : uint8_t {
  Orbits,   // working    — particles on inclined orbits
  Globe,    // searching  — a scan meridian sweeps a dotted globe
  Rubik,    // solving    — bands scramble, then click back solved
  Wave,     // listening  — a waveform rolls through the rings
  Web,      // connecting — a constellation wires itself
  Braid,    // weaving    — three strands plait around the sphere
  Ribbon,   // composing  — an undulating multi-band sash
  Ring,     // breathing  — a ring slowly morphing
  Morph,    // shaping    — dotted outline: circle -> triangle -> square
  ModeCount
};

// Cycle order for the on-device mode picker, matching the order the library documents.
OrbMode orbModeAt(uint8_t index);
const char* orbStateName(OrbMode mode);

struct OrbDot {
  // Position and radius in SIXTEENTHS of a pixel, relative to the centre passed to render().
  //
  // Whole-pixel coordinates are what made the animation jitter: the sphere turns slowly, so a dot
  // spends many frames drifting within one pixel and then jumps to the next. Rounding at emit time
  // throws away exactly the information the painter needs to anti-alias, and no amount of frame
  // pacing recovers it. Sixteenths are plenty — a dot moves far less than 1/16 px per frame — and
  // keep the struct integer-sized for a paint path that runs a few hundred times a frame.
  int16_t x16;
  int16_t y16;
  uint8_t r16;    // radius; the mode's rMin and the sanity cap are already applied
  uint8_t ink;    // 0..255 grey, already mirrored for a dark ground
  uint8_t alpha;  // 0..255 coverage multiplier; modes use it to fade whole layers
};

// A stroked edge between two projected points. The "connecting" mode is mostly edges — a
// constellation without its lines is just scattered dots — so they are part of the frame rather
// than something the board is left to infer.
struct OrbLine {
  int16_t x16a, y16a;
  int16_t x16b, y16b;
  uint8_t ink;
  uint8_t alpha;
  uint8_t w16;    // stroke width in sixteenths of a pixel
};

struct OrbFrame {
  const OrbDot* dots;
  uint16_t count;
  const OrbLine* lines;   // drawn first, so nodes sit on top of their edges
  uint16_t lineCount;
};

class ThinkingOrb {
 public:
  // `diameter` is the drawing box in pixels. `capacity` bounds the dot budget — the sphere's
  // point count is scaled down to fit, so a small screen or a tight RAM budget degrades density
  // rather than overflowing.
  bool begin(uint16_t diameter, uint16_t capacity = 420);
  void end();

  void setMode(OrbMode mode);
  OrbMode mode() const { return mode_; }

  // Speed multiplier over the mode's own preset speed. 1.0 is the library default.
  void setSpeed(float speed) { speed_ = speed; }

  // Advance to `elapsedMs` and produce the frame. Time is absolute rather than a delta so a
  // dropped frame shows up as a jump instead of the animation silently running slow.
  OrbFrame render(uint32_t elapsedMs);

  uint16_t diameter() const { return diameter_; }

  // Edge budget for the constellation mode. 30 nodes can wire up densely for a moment.
  static constexpr uint16_t kMaxLines = 160;

 private:
  void buildGeometry();
  float radiusScale() const;
  void pushDot(float px, float py, float z01, float radiusPx, float white, float alpha,
               uint16_t& n);
  uint16_t emitGlobe(float t);
  uint16_t emitOrbits(float t);
  uint16_t emitWave(float t);
  uint16_t emitRing(float t);
  uint16_t emitWeb(float t);
  uint16_t emitRubik(float t);
  uint16_t emitBraid(float t);
  uint16_t emitRibbon(float t, bool faceOn);
  uint16_t emitMorph(float t);
  uint16_t emitGhostSphere(float t, float R, uint16_t& n);

  // Shared spin + tilt + orthographic projection, matching the reference engine's makeProj.
  void setProjection(float yaw, float tilt, float scale);
  bool projectPoint(float x, float y, float z, float& px, float& py, float& depth) const;


  OrbDot* dots_ = nullptr;
  OrbLine* lines_ = nullptr;

  // Per-instance, and that is the whole point. This was a file-scope global shared by every orb in
  // the firmware while capacity_ stayed per-instance, so the bound check in pushDot() guarded the
  // wrong object: ui.cpp builds a 900-dot orb and then a 180-dot one, the smaller begin() ran last
  // and shrank the shared buffer, and the big orb went on writing 405 entries into room for 180 —
  // 2.7 KB past the end, every frame. It landed in the internal-RAM pool the WiFi driver takes its
  // buffers from, so the board panicked inside ieee80211/lwIP with none of our code on the stack,
  // and heap integrity checks saw nothing because the overrun steps over block headers into
  // payload. Defined in the .cpp; a pointer to an incomplete type is all the header needs.
  struct Scratch;
  Scratch* scratch_ = nullptr;

  // Exact caches of values that depend on indices alone (see emitGhostSphere / emitRibbon). Fixed
  // arrays inside the object, so there is no allocation to fail and no pointer to outlive the
  // instance; a size that does not fit simply takes the uncached path. ~2.1 KB per orb.
  static constexpr int kGhostDots = 110;
  static constexpr int kMaxRibbonSegs = 96;
  float ghost_[kGhostDots * 3];
  bool ghostReady_ = false;
  float ribbonCos_[kMaxRibbonSegs];
  float ribbonSin_[kMaxRibbonSegs];
  uint8_t ribbonSegs_ = 0;
  uint16_t lineCount_ = 0;
  float cosYaw_ = 1.0f, sinYaw_ = 0.0f, cosTilt_ = 1.0f, sinTilt_ = 0.0f, scale_ = 1.0f;
  uint16_t capacity_ = 0;
  uint16_t diameter_ = 0;
  float radiusPx_ = 0.0f;
  OrbMode mode_ = OrbMode::Ring;
  float speed_ = 1.0f;

  // Density, scaled to fit both the capacity and the physical size. The upstream spec scales a
  // lat/lon pair by sqrt(count); the same rule is applied here.
  uint8_t latRings_ = 0;
  uint8_t lonDensity_ = 0;
};

// Maps a Next Coder thread/session state string to an orb mode. Unknown states fall back to
// Ring, the calm one, because an unrecognised state is not a reason to look busy.
OrbMode orbModeForAgentState(const String& state);

// The verb shown under the orb. Matches the upstream labels where a state corresponds.
const char* orbLabelForMode(OrbMode mode);
