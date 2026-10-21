#pragma once

// Streams captured bytes to the gateway without holding a second copy. The upload-session API sends
// the raw header/body segments over an authenticated HTTP PUT, avoiding base64's 33% wire overhead
// and keeping large media off the device WebSocket path.
//
// Lifted from the CrowPanel firmware's media_capture.h, which is the only implementation proven
// against a live gateway. Nothing here is board-specific: it is a Stream over two byte ranges.

#include <Arduino.h>
#include <Stream.h>

class DeviceStore;

namespace media {

// Canonical 44-byte PCM WAV header. Separate from the sample data so the PCM is never memmoved to
// make room in front of it — the header is passed to the upload as its own segment.
constexpr size_t kWavHeaderBytes = 44;

void buildWavHeader(uint8_t header[kWavHeaderBytes], uint32_t dataBytes, uint32_t sampleRateHz,
                    uint16_t channels = 1, uint16_t bitsPerSample = 16);

String sha256Hex(const uint8_t* headerBytes, size_t headerLength,
                 const uint8_t* bodyBytes, size_t bodyLength);

struct UploadSessionResult {
  String mediaId;
  String jobId;
  int httpStatus = -1;
};

// Shared device upload transport used by every board and voice surface. The caller owns capture,
// review UI, pins and buffers; this owns authenticated create/raw-PUT/finalize, integrity metadata,
// retry-after backoff, and the private gateway contract.
UploadSessionResult uploadSession(
  DeviceStore& store,
  const char* requestNamespace,
  const char* kind,
  const char* contentType,
  const char* originalName,
  const uint8_t* headerBytes,
  size_t headerLength,
  const uint8_t* bodyBytes,
  size_t bodyLength,
  uint32_t maxRawBytes,
  uint32_t* backoffUntil = nullptr
);

class SegmentedBodyStream : public Stream {
 public:
  SegmentedBodyStream(const uint8_t* headerBytes, size_t headerLength,
                      const uint8_t* bodyBytes, size_t bodyLength)
    : header_(headerBytes),
      headerLength_(headerBytes ? headerLength : 0),
      body_(bodyBytes),
      bodyLength_(bodyBytes ? bodyLength : 0) {}

  size_t contentLength() const { return headerLength_ + bodyLength_; }
  int available() override {
    const size_t remaining = contentLength() - position_;
    return static_cast<int>(remaining);
  }
  int read() override {
    if (position_ >= contentLength()) return -1;
    return byteAt(position_++);
  }
  int peek() override { return position_ < contentLength() ? byteAt(position_) : -1; }
  size_t readBytes(char* buffer, size_t length) override {
    const size_t count = min(length, contentLength() - position_);
    for (size_t index = 0; index < count; index += 1) buffer[index] = byteAt(position_ + index);
    position_ += count;
    return count;
  }
  size_t write(uint8_t) override { return 0; }
  void flush() override {}

 private:
  uint8_t byteAt(size_t index) const {
    if (index < headerLength_) return header_[index];
    return body_[index - headerLength_];
  }
  const uint8_t* header_ = nullptr;
  size_t headerLength_ = 0;
  const uint8_t* body_ = nullptr;
  size_t bodyLength_ = 0;
  size_t position_ = 0;
};

// Length of the base64 encoding of rawLength bytes, including '=' padding.
inline size_t base64EncodedLength(size_t rawLength) {
  return ((rawLength + 2) / 3) * 4;
}

// Streams `prefix + base64(headerBytes ++ bodyBytes) + suffix` on demand.
//
// HTTPClient::sendRequest(type, Stream*, size) drives this through available() and readBytes(), so
// contentLength() must be exact or the send is aborted as a short write.
class Base64JsonBodyStream : public Stream {
 public:
  Base64JsonBodyStream(const String& prefix, const String& suffix, const uint8_t* headerBytes,
                       size_t headerLength, const uint8_t* bodyBytes, size_t bodyLength)
    : prefix_(prefix),
      suffix_(suffix),
      header_(headerBytes),
      headerLength_(headerBytes ? headerLength : 0),
      body_(bodyBytes),
      bodyLength_(bodyBytes ? bodyLength : 0) {}

  size_t contentLength() const {
    return prefix_.length() + base64EncodedLength(headerLength_ + bodyLength_) + suffix_.length();
  }

  int available() override {
    const size_t total = contentLength();
    if (produced_ >= total) return 0;
    return static_cast<int>(total - produced_);
  }

  int read() override {
    const int value = nextChar(true);
    if (value >= 0) produced_ += 1;
    return value;
  }

  int peek() override { return nextChar(false); }

  size_t readBytes(char* buffer, size_t length) override {
    size_t count = 0;
    while (count < length) {
      const int value = nextChar(true);
      if (value < 0) break;
      buffer[count] = static_cast<char>(value);
      count += 1;
      produced_ += 1;
    }
    return count;
  }

  // Write side is unused; this stream is read-only input for HTTPClient.
  size_t write(uint8_t) override { return 0; }
  void flush() override {}

 private:
  size_t rawTotal() const { return headerLength_ + bodyLength_; }

  uint8_t rawByte(size_t index) const {
    if (index < headerLength_) return header_[index];
    return body_[index - headerLength_];
  }

  // Encodes the next 3 raw bytes into quad_ when the current quad is spent.
  bool fillQuad() {
    if (quadPos_ < quadLength_) return true;
    const size_t total = rawTotal();
    if (rawIndex_ >= total) return false;

    static const char kAlphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    uint8_t chunk[3] = {0, 0, 0};
    uint8_t chunkLength = 0;
    while (chunkLength < 3 && rawIndex_ < total) {
      chunk[chunkLength] = rawByte(rawIndex_);
      chunkLength += 1;
      rawIndex_ += 1;
    }

    quad_[0] = kAlphabet[chunk[0] >> 2];
    quad_[1] = kAlphabet[((chunk[0] & 0x03) << 4) | (chunk[1] >> 4)];
    quad_[2] = chunkLength > 1 ? kAlphabet[((chunk[1] & 0x0F) << 2) | (chunk[2] >> 6)] : '=';
    quad_[3] = chunkLength > 2 ? kAlphabet[chunk[2] & 0x3F] : '=';
    quadLength_ = 4;
    quadPos_ = 0;
    return true;
  }

  int nextChar(bool consume) {
    if (prefixPos_ < prefix_.length()) {
      const char value = prefix_.charAt(prefixPos_);
      if (consume) prefixPos_ += 1;
      return static_cast<unsigned char>(value);
    }
    if (fillQuad()) {
      const char value = quad_[quadPos_];
      if (consume) quadPos_ += 1;
      return static_cast<unsigned char>(value);
    }
    if (suffixPos_ < suffix_.length()) {
      const char value = suffix_.charAt(suffixPos_);
      if (consume) suffixPos_ += 1;
      return static_cast<unsigned char>(value);
    }
    return -1;
  }

  String prefix_;
  String suffix_;
  const uint8_t* header_ = nullptr;
  size_t headerLength_ = 0;
  const uint8_t* body_ = nullptr;
  size_t bodyLength_ = 0;

  size_t prefixPos_ = 0;
  size_t suffixPos_ = 0;
  size_t rawIndex_ = 0;
  size_t produced_ = 0;
  char quad_[4] = {0, 0, 0, 0};
  uint8_t quadLength_ = 0;
  uint8_t quadPos_ = 0;
};

}  // namespace media
