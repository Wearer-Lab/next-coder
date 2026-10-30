#pragma once

// ONE SWITCH for every piece of UI/render measurement in the firmware.
//
// HOSYOND_UI_PROFILE gates the accounting AND the printing behind these serial lines:
//   [frame-split]  [touch-funnel]  [content-split]   Hosyond ui.cpp / ui_content_job.h
//   [blit-split]                                     Hosyond display.cpp
//   [orb-split]                                      shared OrbProfile.h (via ORB_PROFILE, below)
//
// DEFAULT OFF. It used to default on, by omission: ORB_PROFILE was `#define ... 1`, and the three
// ui.cpp reports had no guard at all, so a release image paid for micros() reads, per-frame
// accumulators and a few KB of format strings that nobody was reading. The printf was never the
// whole cost. A counter that nothing prints is still a store every frame, and a timer around a
// stage is still a register read either side of it.
//
// Turned on by hand, or automatically with TLS_SESSION_DIAGNOSTICS, which is the bench image's
// switch: the staged qualification build sets it so scripts/measure-device-latency.mjs still gets
// every line it parses without an extra flag. That is the same rule GATEWAY_REQUEST_TIMING
// (GatewayWarm.h) already follows, so one bench switch lights up one family of diagnostics.
//
//   pio run -e hosyond-es3c28p-controller                               release: none of it
//   PLATFORMIO_BUILD_FLAGS=-DHOSYOND_UI_PROFILE=1 pio run -e ...        profiled
//
// What it deliberately does NOT gate: [fps] and the "since boot" line (product behaviour, one
// printf every 2 s) and the optimisations measured with these probes (ORB_BLIT_ROWS_PER_WINDOW,
// ORB_BLIT_REACH_CLIP). Measurement is conditional; the wins it found are not.
//
// No includes, on purpose: ui_content_job.h is a pure header that host tests compile without the
// Arduino core, and it needs this switch.

#ifndef HOSYOND_UI_PROFILE
#if defined(TLS_SESSION_DIAGNOSTICS) && TLS_SESSION_DIAGNOSTICS
#define HOSYOND_UI_PROFILE 1
#else
#define HOSYOND_UI_PROFILE 0
#endif
#endif

// UI_PROFILE(statements) is a statement that exists in a profiled build and is nothing otherwise.
// It is how ui.cpp keeps its accounting beside the code it measures without a second copy of every
// function. Variadic so a statement may contain commas (`uint32_t a = 0, b = 0;`). Two rules for
// use, both learned the cheap way:
//   * never as the body of an `if`/`else` -- an empty expansion would swallow the NEXT statement.
//     Write `if (x) { UI_PROFILE(++n;) }`, which keeps a side-effecting condition evaluated.
//   * put only the measurement inside it; anything the product reads stays outside.
#if HOSYOND_UI_PROFILE
#define UI_PROFILE(...) __VA_ARGS__
#else
#define UI_PROFILE(...)
#endif
