#pragma once

#include <stdint.h>

namespace media {

// Compute capture diagnostics as samples arrive. Ending a maximum-length recording must not scan
// a megabyte of PSRAM on the touch/render task. The bounds cover full-scale int16 PCM safely.
struct PcmCaptureStats {
  uint32_t count = 0;
  int32_t peak = 0;
  int64_t sum = 0;
  uint64_t squares = 0;

  void add(int16_t value) {
    const int32_t sample = value;
    const int32_t magnitude = sample < 0 ? -sample : sample;
    if (magnitude > peak) peak = magnitude;
    sum += sample;
    squares += static_cast<uint64_t>(static_cast<int64_t>(sample) * sample);
    count += 1;
  }
};

}  // namespace media
