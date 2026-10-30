#pragma once

// MEASUREMENT for the orb's CPU cost, OFF unless the build asks for it: ORB_PROFILE follows
// HOSYOND_UI_PROFILE (UiProfile.h), which is off by default and on with TLS_SESSION_DIAGNOSTICS.
// Pass -DORB_PROFILE=1 or 0 to override it for the orb alone.
//
// When it is off nothing of this exists in the image: no ORB_PROBE() timer, no accumulator writes,
// no gOrbProfile storage, and orbProfileTake() is an inline `false`. It used to default on, so
// every release frame paid for seven micros() reads and a dozen read-modify-writes that only a
// developer with a serial cable would ever see.
//
// Why it exists: a frame that "draws in 26 ms" is geometry (ThinkingOrb::render: trig, projection,
// depth sort), rasterisation (paintOrbCoverage: line strokes, dot splats) and the panel blit
// (board-specific, in the display adapter) added together, and the three have different cures.
// Optimising one on a guess about the split is how a week goes. The painter and the emitter each
// time themselves here; the board subtracts them from its own total to get the blit.
//
// Cost of the probes when ON: two micros() reads per phase, six phases a frame. micros() is a
// register read plus a multiply on this core, so the probes are well under the resolution they
// report. That is why the profiled numbers can be trusted and why it is still not free to leave on.
//
// Single-writer by design: the orb is rendered from one task, and the reader runs on that same
// task between frames. No locking, because a torn read of a diagnostic counter is not worth a lock
// in the render path.

#include <Arduino.h>

#include "UiProfile.h"

#ifndef ORB_PROFILE
#define ORB_PROFILE HOSYOND_UI_PROFILE
#endif

struct OrbProfile {
  uint32_t frames = 0;            // paintOrbCoverage() calls in the window (big + mini orb together)
  uint32_t emitUs = 0;            // ThinkingOrb::render(): per-mode geometry (trig, projection)
  uint32_t sortUs = 0;            // ThinkingOrb::render(): depth sort + copy into the output list
  uint32_t clearUs = 0;           // paintOrbCoverage(): memset of the coverage buffer
  uint32_t lineUs = 0;            // paintOrbCoverage(): strokeLine over every edge
  uint32_t dotUs = 0;             // paintOrbCoverage(): splatDot over every dot
  uint32_t emitMaxUs = 0, sortMaxUs = 0, rasterMaxUs = 0;  // worst single frame in the window
  uint32_t dots = 0, lines = 0;   // summed, so dots/frames is the average geometry size
};

#if ORB_PROFILE
extern OrbProfile gOrbProfile;

// Copies the window out and starts a new one. Returns false when nothing was rendered.
bool orbProfileTake(OrbProfile& out);

// Declares `var` as the current time in microseconds.
#define ORB_PROBE(var) const uint32_t var = micros()
#else
// A caller that reports the window (Hosyond's [orb-split]) still links when it is off, and simply
// finds no data. The struct above stays declared so that call site needs no guard of its own.
inline bool orbProfileTake(OrbProfile&) { return false; }

#define ORB_PROBE(var) ((void)0)
#endif
