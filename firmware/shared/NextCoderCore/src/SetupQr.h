#pragma once

#include <cstddef>
#include <cstdint>

// Pure setup-only QR generation. No display, socket, logging, heap or shared state.
// Cache only while setup is visible; clear() on portal close/password rotation.
namespace setup_qr {
constexpr int kPixels = 128;
constexpr int kQuietModules = 4;
constexpr int kMaxModules = 37; // QR version 5; minimum 2 physical pixels per module at 128px.
constexpr size_t kMatrixBytes = (kMaxModules * kMaxModules + 7) / 8;

struct Matrix {
  uint8_t size = 0;
  uint8_t bits[kMatrixBytes]{};
  bool dark(int x, int y) const;
  int scale() const;
  int offset() const; // First data module, including centered four-module white quiet zone.
  bool pixelBlack(int x, int y) const;
  void clear();
};

// Escapes the standard WIFI text fields. Returned matrix contains the setup AP
// password: never use this for the owner's home-network credentials or log it.
// Unsupported/oversized input clears output and returns false (render manual fallback).
bool encodeWifi(const char* apSsid, const char* apPassword, Matrix& output);
// Restricted to the local setup origin; no third-party redirect or embedded cloud credential.
bool encodePortalUrl(const char* localUrl, Matrix& output);
} // namespace setup_qr
