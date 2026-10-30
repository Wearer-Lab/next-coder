#pragma once

// The strip walk behind a content repaint, as a pure state machine so it can be tested natively.
//
// ui.cpp composes the content area in opaque full-width strips (displayComposeScene), and a whole
// area measured ~40 ms in one frame. A job remembers where it is in that walk so the strips can be
// spread across frames under a time budget. The invariants worth a host test, because a mistake in
// any of them is a visible seam or a screen that never finishes painting:
//
//   * strips are contiguous and non-overlapping, covering exactly [top, end) when the job is done;
//   * every advance() composes at least ONE strip, however small the budget, so a job always makes
//     progress and a slow strip cannot make it stall forever;
//   * arm() while active restarts from the top (the caller wants the freshest state painted);
//   * a compose that reports failure completes the job after the caller's direct fallback paint.
//
// No Arduino, no GFX: the compose step and the clock are injected.
//
// The strips/frames/spentUs bookkeeping exists only for the [content-split] report, so it is
// compiled in only under HOSYOND_UI_PROFILE (UiProfile.h). Everything the walk needs to make
// progress (`next`, `end`, the budget loop) is unconditional; what the report adds is a clock read
// either side of every strip and three accumulators nothing else consumes.

#include <stdint.h>

#include <UiProfile.h>

struct ContentJob {
  bool active = false;
  bool partial = false;        // HOME text rows only; the orb's area is not touched
  int16_t end = 0, next = 0;   // absolute panel y: [next, end) still to compose
#if HOSYOND_UI_PROFILE
  uint16_t strips = 0;         // strips composed so far, for the report
  uint16_t frames = 0;         // frames this job has spanned so far
  uint32_t spentUs = 0;        // composition time so far
#endif

  // Starts (or restarts) a walk over [top, end).
  void arm(int16_t top, int16_t bottom, bool isPartial) {
    *this = ContentJob{};
    active = bottom > top;
    partial = isPartial;
    next = top;
    end = bottom;
  }

  // Composes strips until the job is finished or `nowUs() - frameStartUs` reaches `budgetUs`.
  // `compose(y, rows)` returns false when it could not compose; the caller has then painted the
  // whole job directly (the pre-existing fallback), so the job is complete.
  // Returns true when the job finished during this call.
  template <typename Compose, typename Clock>
  bool advance(Compose&& compose, Clock&& nowUs, uint32_t frameStartUs, uint32_t budgetUs,
               int16_t stripRows) {
    if (!active) return false;
#if HOSYOND_UI_PROFILE
    ++frames;
#endif
    do {
#if HOSYOND_UI_PROFILE
      const uint32_t t0 = nowUs();
#endif
      int16_t rows = static_cast<int16_t>(end - next);
      if (rows > stripRows) rows = stripRows;
      if (!compose(next, rows)) next = end;
      else next = static_cast<int16_t>(next + rows);
#if HOSYOND_UI_PROFILE
      ++strips;
      spentUs += nowUs() - t0;
#endif
    } while (next < end && nowUs() - frameStartUs < budgetUs);
    if (next >= end) active = false;
    return !active;
  }
};
