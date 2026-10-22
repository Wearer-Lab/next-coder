#pragma once

#include <Arduino.h>
#include <time.h>
#include <cstring>

namespace gateway_claim {
// Cached codes remain stable until the gateway's UTC expiry is actually observed. A boot clock
// still in 1970 must never invalidate the displayed code and rotate an owner's enrollment.
inline bool expired(const String& expiresAt, time_t now) {
  if (now < 1704067200 || expiresAt.length() < 20 || expiresAt[expiresAt.length() - 1] != 'Z') {
    return false;
  }
  for (size_t i = 0; i < 19; ++i) {
    const char value = expiresAt[i];
    if (i == 4 || i == 7) { if (value != '-') return false; }
    else if (i == 10) { if (value != 'T') return false; }
    else if (i == 13 || i == 16) { if (value != ':') return false; }
    else if (value < '0' || value > '9') return false;
  }
  tm utc{};
  char current[20];
  if (!gmtime_r(&now, &utc) || strftime(current, sizeof(current), "%Y-%m-%dT%H:%M:%S", &utc) != 19) {
    return false;
  }
  // Wait until the whole expiry second has passed, including any fractional milliseconds.
  return strncmp(current, expiresAt.c_str(), 19) > 0;
}
}  // namespace gateway_claim
