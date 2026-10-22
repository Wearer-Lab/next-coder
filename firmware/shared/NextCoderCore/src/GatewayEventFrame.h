#pragma once
#include <Arduino.h>

namespace gateway_http {
// A malformed/oversized event is discarded through its blank terminator, never parsed as a
// truncated mutation. Multi-line data is bounded too; bounding only each line leaks across lines.
class EventFrame {
 public:
  bool feed(char c) {
    if (c == '\r') return false;
    if (c != '\n') {
      if (line_.length() >= 768) { discarded_ = true; return false; }
      line_ += c;
      return false;
    }
    if (line_.length() == 0) {
      const bool complete = !discarded_ && data_.length() > 0;
      if (!complete) reset();
      return complete;
    }
    if (!discarded_) {
      if (line_.startsWith("event:")) {
        event_ = line_.substring(6); event_.trim();
      } else if (line_.startsWith("data:")) {
        String part = line_.substring(5); part.trim();
        if (data_.length() + part.length() + 1 > 2048) discarded_ = true;
        else { if (data_.length()) data_ += '\n'; data_ += part; }
      }
    }
    line_ = "";
    return false;
  }
  const String& event() const { return event_; }
  const String& data() const { return data_; }
  void reset() { line_ = ""; event_ = ""; data_ = ""; discarded_ = false; }
 private:
  String line_, event_, data_;
  bool discarded_ = false;
};
}  // namespace gateway_http
