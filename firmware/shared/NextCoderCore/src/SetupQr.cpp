#include "SetupQr.h"

#include <cstring>
#include "third_party/qrcodegen/qrcodegen.h"

namespace setup_qr {
namespace {
constexpr size_t kPayloadBytes = 192;
constexpr int kMaxVersion = 5;
constexpr size_t kEncoderBytes = qrcodegen_BUFFER_LEN_FOR_VERSION(kMaxVersion);

void wipe(void* memory, size_t size) {
  volatile uint8_t* bytes = static_cast<volatile uint8_t*>(memory);
  while (size--) *bytes++ = 0;
}

bool boundedText(const char* value, size_t limit, size_t& length) {
  if (!value) return false;
  for (length = 0; length <= limit; ++length) {
    const uint8_t c = static_cast<uint8_t>(value[length]);
    if (c == 0) return true;
    if (c < 32 || c == 127) return false;
  }
  return false;
}

bool append(char* output, size_t& used, const char* value, bool escape = false) {
  for (size_t i = 0; value[i]; ++i) {
    const char c = value[i];
    if (escape && (c == '\\' || c == ';' || c == ',' || c == ':' || c == '"')) {
      if (used + 1 >= kPayloadBytes) return false;
      output[used++] = '\\';
    }
    if (used + 1 >= kPayloadBytes) return false;
    output[used++] = c;
  }
  output[used] = 0;
  return true;
}

bool encode(const char* payload, Matrix& output) {
  output.clear();
  uint8_t scratch[kEncoderBytes]{}, code[kEncoderBytes]{};
  const bool encoded = qrcodegen_encodeText(payload, scratch, code, qrcodegen_Ecc_MEDIUM,
    1, kMaxVersion, qrcodegen_Mask_AUTO, true);
  if (encoded) {
    const int size = qrcodegen_getSize(code);
    if (size >= 21 && size <= kMaxModules) {
      output.size = static_cast<uint8_t>(size);
      for (int y = 0; y < size; ++y) for (int x = 0; x < size; ++x) {
        if (qrcodegen_getModule(code, x, y)) {
          const size_t bit = static_cast<size_t>(y * size + x);
          output.bits[bit / 8] |= static_cast<uint8_t>(1u << (bit % 8));
        }
      }
    }
  }
  wipe(scratch, sizeof(scratch)); wipe(code, sizeof(code));
  return output.size != 0;
}
} // namespace

void Matrix::clear() { size = 0; wipe(bits, sizeof(bits)); }
bool Matrix::dark(int x, int y) const {
  if (size < 21 || size > kMaxModules || x < 0 || y < 0 || x >= size || y >= size) return false;
  const size_t bit = static_cast<size_t>(y * size + x);
  return (bits[bit / 8] & (1u << (bit % 8))) != 0;
}
int Matrix::scale() const { return size >= 21 && size <= kMaxModules ? kPixels / (size + 2 * kQuietModules) : 0; }
int Matrix::offset() const { return scale() > 0 ? (kPixels - (size + 2 * kQuietModules) * scale()) / 2 + kQuietModules * scale() : 0; }
bool Matrix::pixelBlack(int x, int y) const {
  const int pixels = scale(), start = offset();
  if (pixels < 2 || x < start || y < start || x >= start + size * pixels || y >= start + size * pixels) return false;
  return dark((x - start) / pixels, (y - start) / pixels);
}

bool encodeWifi(const char* apSsid, const char* apPassword, Matrix& output) {
  output.clear();
  size_t ssidLength = 0, passwordLength = 0;
  if (!boundedText(apSsid, 32, ssidLength) || ssidLength == 0
      || !boundedText(apPassword, 64, passwordLength)) return false;
  char payload[kPayloadBytes]{};
  size_t used = 0;
  const bool built = append(payload, used, passwordLength ? "WIFI:T:WPA;S:" : "WIFI:T:nopass;S:")
    && append(payload, used, apSsid, true)
    && append(payload, used, ";P:") && append(payload, used, apPassword, true) && append(payload, used, ";;");
  const bool result = built && encode(payload, output);
  wipe(payload, sizeof(payload));
  return result;
}

bool encodePortalUrl(const char* localUrl, Matrix& output) {
  output.clear();
  size_t length = 0;
  static const char origin[] = "http://192.168.4.1";
  constexpr size_t originLength = sizeof(origin) - 1;
  if (!boundedText(localUrl, 100, length) || length < originLength
      || std::strncmp(localUrl, origin, originLength) != 0
      || (localUrl[originLength] != 0 && localUrl[originLength] != '/' && localUrl[originLength] != '?')) return false;
  return encode(localUrl, output);
}
} // namespace setup_qr
