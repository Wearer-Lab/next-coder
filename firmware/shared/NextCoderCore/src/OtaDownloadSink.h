#pragma once

#include <Arduino.h>
#include <Update.h>
#include <mbedtls/sha256.h>

// HTTPClient removes HTTP chunk framing before this sink sees bytes. Only the signed number of
// decoded image bytes may reach the inactive partition; no whole-image allocation is needed.
class OtaDownloadSink : public Stream {
 public:
  explicit OtaDownloadSink(size_t expected) : expected_(expected) {
    mbedtls_sha256_init(&sha_);
    failed_ = mbedtls_sha256_starts(&sha_, 0) != 0;
  }
  ~OtaDownloadSink() { mbedtls_sha256_free(&sha_); }
  size_t write(uint8_t value) override { return write(&value, 1); }
  size_t write(const uint8_t* bytes, size_t size) override {
    if (failed_ || size > expected_ - written_) { failed_ = true; return 0; }
    if (mbedtls_sha256_update(&sha_, bytes, size) != 0
        || Update.write(const_cast<uint8_t*>(bytes), size) != size) {
      failed_ = true;
      return 0;
    }
    written_ += size;
    return size;
  }
  bool finish(uint8_t digest[32]) {
    return !failed_ && written_ == expected_ && mbedtls_sha256_finish(&sha_, digest) == 0;
  }
  size_t written() const { return written_; }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
 private:
  mbedtls_sha256_context sha_;
  size_t expected_;
  size_t written_ = 0;
  bool failed_ = false;
};
