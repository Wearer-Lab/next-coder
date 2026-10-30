#pragma once
// Host stand-in for the parts of Arduino.h the shared orb sources touch: fixed-width types,
// micros(), and the small slice of String that orbModeForAgentState() uses.
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <string>
inline uint32_t micros() {
  using namespace std::chrono;
  return (uint32_t)duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count();
}
class String {
 public:
  String() {}
  String(const char* s) : s_(s) {}
  void toLowerCase() { for (auto& c : s_) if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a'); }
  bool operator==(const char* o) const { return s_ == o; }
 private:
  std::string s_;
};
