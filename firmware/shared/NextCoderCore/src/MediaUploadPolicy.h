#pragma once

#include <stdint.h>
#include <string.h>

namespace upload_policy {

// Upload/finalize URLs come from the gateway but are data, never authority to disclose secrets.
inline bool credentialPathAllowed(const char* path) {
  static constexpr char prefix[] = "/v1/device/media/uploads";
  if (!path || strncmp(path, prefix, sizeof(prefix) - 1) != 0) return false;
  const char next = path[sizeof(prefix) - 1];
  if (next != '\0' && next != '/') return false;
  for (const char* p = path; *p; ++p) {
    if (*p == '\\' || *p == '?' || *p == '#' || static_cast<unsigned char>(*p) <= 32) return false;
  }
  return strstr(path, "..") == nullptr && strstr(path, "//") == nullptr;
}

inline uint32_t retryDelay(int seconds) {
  if (seconds < 1) seconds = 1;
  if (seconds > 300) seconds = 300;
  return static_cast<uint32_t>(seconds) * 1000UL;
}

}  // namespace upload_policy
