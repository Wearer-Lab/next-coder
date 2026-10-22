#pragma once

#include <stdint.h>

namespace voice_poll {

// A temporary lost response never means the server job failed. Retain its identity and back off.
inline uint32_t retryDelay(uint8_t failures) {
  const uint8_t exponent = failures > 4 ? 4 : failures;
  const uint32_t delay = 2000UL << exponent;
  return delay > 30000UL ? 30000UL : delay;
}

inline bool terminalStatus(int code) {
  return code == 401 || code == 403 || code == 404 || code == 410;
}

}  // namespace voice_poll
