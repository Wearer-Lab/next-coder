#pragma once

#include <Arduino.h>

namespace gateway_http {

// ESP32 Stream::timedRead spins until its timeout without yielding. HTTPClient uses it for
// chunk framing; a cloud response pausing between chunks otherwise starves the idle watchdog.
// Keep the normal socket timeout and TLS validation, but let the scheduler run on empty reads.
template <typename Client>
class YieldingClient : public Client {
 public:
  using Client::read;
  int read() override {
    const int value = Client::read();
    if (value < 0) delay(1);
    return value;
  }
  int read(uint8_t* buffer, size_t size) override {
    const int count = Client::read(buffer, size);
    if (count <= 0 && size) delay(1);
    return count;
  }
};

// HTTPClient decodes chunk framing before writing here. Bound unknown-length responses too:
// rejecting an oversized String after getString() has already allocated it is too late.
class BoundedBody : public Stream {
 public:
  BoundedBody(String& output, size_t limit) : output_(output), limit_(limit) { output_ = ""; }
  size_t write(uint8_t value) override { return write(&value, 1); }
  size_t write(const uint8_t* bytes, size_t size) override {
    if (failed_ || size > limit_ - output_.length()) {
      failed_ = true;
      return 0;
    }
    if (!output_.concat(reinterpret_cast<const char*>(bytes), size)) {
      failed_ = true;
      return 0;
    }
    return size;
  }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
  bool failed() const { return failed_; }

 private:
  String& output_;
  const size_t limit_;
  bool failed_ = false;
};

}  // namespace gateway_http
