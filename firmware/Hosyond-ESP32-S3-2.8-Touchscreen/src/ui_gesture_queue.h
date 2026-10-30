#pragma once

// The one tap that waits for the gateway job slot, as a pure value so it can be tested natively.
//
// Exactly one gesture job runs at a time (ui.cpp, enqueueUiNetworkJob). A tap that lands while it is
// in flight used to be thrown away: the router answered it with a no-op, or let the handler start a
// second job that was refused and ignored. From the glass that is a button that does not respond.
//
// The rule now is that a tap is never discarded without saying so. It is HELD here and replayed
// through the ordinary tap router the moment the slot frees. The hazards, and which part answers each:
//
//   * a tap that went out of date while it waited must not act on whatever replaced its target.
//     The job's own completion can navigate, refresh a list or change a thread, so a held tap carries
//     the navigation epoch and the semantic identity of the thing under the finger, and is replayed
//     only if both still hold (otherwise it is reported as "tap again", not guessed at);
//   * the queue is bounded. One tap is held; a newer one supersedes it, because a person who tapped
//     twice means the second. It is never a backlog that can fire a stale burst of writes;
//   * a held tap is a hint about intent, not a lease on the device: it expires. A tap that has
//     waited longer than any single job could take is dropped with a message instead of landing
//     after the person has stopped looking.
//
// No Arduino, no UI: the caller supplies the clock, the epoch and the identity probe.

#include <stdint.h>

struct PendingGesture {
  // Longer than two serial 6 s requests (the longest foreground job) plus the wait to start, and
  // short enough that a tap does not land after the person has stopped looking at the screen.
  static constexpr uint32_t kMaxAgeMs = 15000;

  enum class Fate : uint8_t { Nothing, Replay, Stale, Expired };

  bool valid = false;
  uint8_t kind = 0;            // the caller's gesture code; opaque here
  int16_t x = 0, y = 0;
  uint32_t identity = 0;       // semantic target under the finger; 0 = none (a swipe has no target)
  uint32_t epoch = 0;          // navigation epoch when the gesture was made
  uint32_t queuedAt = 0;
  uint32_t superseded = 0;     // earlier held taps this slot replaced; diagnostic only

  // Latest wins. Returns true when an earlier held gesture was replaced.
  bool put(uint8_t gestureKind, int16_t px, int16_t py, uint32_t targetIdentity,
           uint32_t navigationEpoch, uint32_t now) {
    const bool replaced = valid;
    if (replaced) ++superseded;
    valid = true;
    kind = gestureKind;
    x = px;
    y = py;
    identity = targetIdentity;
    epoch = navigationEpoch;
    queuedAt = now;
    return replaced;
  }

  // The person moved on deliberately (they navigated somewhere else), so an older intent is moot.
  void cancel() { valid = false; }

  // Takes the held gesture out of the slot, whatever its fate: a gesture is replayed at most once.
  // `identityAt(x, y)` re-reads the semantic target currently under the held coordinates.
  template <typename IdentityAt>
  Fate take(uint32_t navigationEpoch, uint32_t now, IdentityAt&& identityAt, PendingGesture& out) {
    if (!valid) return Fate::Nothing;
    out = *this;
    valid = false;
    if (static_cast<uint32_t>(now - out.queuedAt) > kMaxAgeMs) return Fate::Expired;
    if (out.epoch != navigationEpoch) return Fate::Stale;
    if (out.identity != 0 && identityAt(out.x, out.y) != out.identity) return Fate::Stale;
    return Fate::Replay;
  }
};
