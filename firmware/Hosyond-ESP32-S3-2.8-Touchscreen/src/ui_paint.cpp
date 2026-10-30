#include "ui_paint.h"

#include <math.h>

#include "display.h"

namespace uip {

namespace {

Adafruit_GFX& g() { return displayRenderGfx(); }

}  // namespace

bool hit(const Rect& r, int16_t x, int16_t y) {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

// ---------------------------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------------------------

float easeOutCubic(float t) {
  if (t <= 0.0f) return 0.0f;
  if (t >= 1.0f) return 1.0f;
  const float u = 1.0f - t;
  return 1.0f - u * u * u;
}

float easeInOutCubic(float t) {
  if (t <= 0.0f) return 0.0f;
  if (t >= 1.0f) return 1.0f;
  if (t < 0.5f) return 4.0f * t * t * t;
  const float u = -2.0f * t + 2.0f;
  return 1.0f - u * u * u / 2.0f;
}

float approach(float value, float target, uint32_t frameMs, uint32_t durationMs) {
  if (durationMs == 0) return target;
  const float step = (float)frameMs / (float)durationMs;
  if (target > value) {
    value += step;
    return value > target ? target : value;
  }
  value -= step;
  return value < target ? target : value;
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

String fit(const String& value, size_t cols) {
  if (value.length() <= cols) return value;
  if (cols <= 1) return value.substring(0, cols);
  return value.substring(0, cols - 1) + "~";
}

String fitWords(const String& value, size_t cols) {
  const size_t len = value.length();
  if (len <= cols) return value;
  if (cols <= 4) return value.substring(0, cols);

  const size_t budget = cols - 3;          // room for the three dots
  size_t brk = budget;
  while (brk > 0 && value[brk] != ' ') brk -= 1;
  // A word boundary that throws away more than a third of the budget is not a better answer than
  // cutting mid-word — one long token would otherwise reduce the whole line to an ellipsis.
  if (brk == 0 || brk * 3 < budget * 2) brk = budget;

  while (brk > 0) {
    const char c = value[brk - 1];
    if (c == ' ' || c == ',' || c == '.' || c == ';' || c == ':' || c == '-'
        || c == '"' || c == '\'' || c == '(' || c == '[' || c == '/') {
      brk -= 1;
      continue;
    }
    break;
  }
  if (brk == 0) return value.substring(0, budget) + "...";
  return value.substring(0, brk) + "...";
}

void text(int16_t x, int16_t y, uint8_t size, uint8_t grey, const String& value) {
  if (value.length() == 0 || !displayRenderIntersects(x,y,static_cast<int32_t>(value.length())*6*size,8*size)) return;
  g().setTextWrap(false);
  g().setTextSize(size);
  g().setTextColor(panelGrey(grey));
  g().setCursor(x, y);
  g().print(value);
}

void textCentered(int16_t y, uint8_t size, uint8_t grey, const String& value) {
  if (value.length() == 0) return;
  const int16_t w = (int16_t)(value.length() * 6 * size);
  text((int16_t)((kW - w) / 2), y, size, grey, value);
}

void textCenteredIn(const Rect& r, int16_t y, uint8_t size, uint8_t grey, const String& value) {
  if (value.length() == 0) return;
  const int16_t w = (int16_t)(value.length() * 6 * size);
  text((int16_t)(r.x + (r.w - w) / 2), y, size, grey, value);
}

void textRight(int16_t right, int16_t y, uint8_t size, uint8_t grey, const String& value) {
  if (value.length() == 0) return;
  const int16_t w = (int16_t)(value.length() * 6 * size);
  text((int16_t)(right - w), y, size, grey, value);
}

void textAccent(int16_t x, int16_t y, uint8_t size, const String& value) {
  if (value.length() == 0 || !displayRenderIntersects(x,y,static_cast<int32_t>(value.length())*6*size,8*size)) return;
  g().setTextWrap(false);
  g().setTextSize(size);
  g().setTextColor(panelRgb(kAccentRgb));
  g().setCursor(x, y);
  g().print(value);
}

void textRightAccent(int16_t right, int16_t y, uint8_t size, const String& value) {
  if (value.length() == 0) return;
  const int16_t w = (int16_t)(value.length() * 6 * size);
  textAccent((int16_t)(right - w), y, size, value);
}

size_t wrapText(const String& value, size_t cols, String* out, size_t maxLines) {
  size_t lines = 0;
  size_t i = 0;
  const size_t len = value.length();
  while (i < len && lines < maxLines) {
    while (i < len && value[i] == ' ') i += 1;
    if (i >= len) break;
    size_t end = min(len, i + cols);
    if (end < len) {
      size_t brk = end;
      while (brk > i && value[brk] != ' ') brk -= 1;
      if (brk > i) end = brk;
    }
    out[lines++] = value.substring(i, end);
    i = end;
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

void card(const Rect& r, float radius, int16_t fill, int16_t stroke, float strokeWidth,
          float feather, uint8_t bg) {
  displaySoftRoundRect(r.x, r.y, r.w, r.h, radius, bg, fill, stroke, strokeWidth, feather);
}

void capsule(const Rect& r, int16_t fill, int16_t stroke, float strokeWidth, float feather,
             uint8_t bg) {
  displaySoftRoundRect(r.x, r.y, r.w, r.h, r.h * 0.5f, bg, fill, stroke, strokeWidth, feather);
}

void button(const Rect& r, const String& label, bool primary, bool enabled, uint8_t bg) {
  // ONLY a primary button has a fill. Everything else is an outline on the page.
  //
  // Secondary and disabled buttons used to be filled kSurface, which is the source of the "lighter
  // band behind DISCARD and SEND" in the CLIP READY photograph: nothing was painting a tray — the
  // tray had already been removed — but two kSurface capsules eight pixels apart across the full
  // width of a 240 px screen read as one band, and a disabled primary made it two. An outline
  // composites against whatever it is standing on and adds no surface to the page at all.
  const size_t cols = r.w > 16 ? (size_t)((r.w - 14) / 6) : 1;
  const String shown = fit(label, cols);
  const int16_t tw = (int16_t)(shown.length() * 6);
  const int16_t tx = (int16_t)(r.x + (r.w - tw) / 2);
  const int16_t ty = (int16_t)(r.y + (r.h - 8) / 2);

  if (primary && enabled) {
    // The design's call to action: a filled pill. On the reference page that pill is white and
    // glowing; on this panel it carries the product's accent instead, because the accent is the
    // one chromatic signal the device has and the action is the one thing that should spend it.
    // The label is the ground colour, so it reads as cut out of the pill rather than painted on.
    accentCapsule(r, bg);
    text(tx, ty, 1, kBg, shown);
    return;
  }

  const int16_t stroke = enabled ? (int16_t)kMuted : (int16_t)kHair;
  const uint8_t ink = enabled ? kText : kHair;
  capsule(r, -1, stroke, 1.3f, 1.2f, bg);
  text(tx, ty, 1, ink, shown);
}

void divider(int16_t x, int16_t y, int16_t w, uint8_t grey, uint8_t bg) {
  displaySoftArcDivider(x, y, w, 2.5f, 1.4f, bg, grey);
}

void dot(int16_t cx, int16_t cy, float radius, uint8_t grey, uint8_t bg) {
  const int16_t d = (int16_t)(radius * 2.0f + 2.0f);
  displaySoftRoundRect((int16_t)(cx - d / 2), (int16_t)(cy - d / 2), d, d, d * 0.5f, bg,
                       (int16_t)grey, -1, 0.0f, 1.1f);
}

void chevron(int16_t cx, int16_t cy, float size, int8_t dir, uint8_t grey, float thickness,
             uint8_t bg) {
  const float s = size;
  switch (dir) {
    case -1:   // left
      displaySoftSegment(cx + s * 0.5f, cy - s, cx - s * 0.5f, cy, thickness, bg, grey);
      displaySoftSegment(cx - s * 0.5f, cy, cx + s * 0.5f, cy + s, thickness, bg, grey);
      return;
    case 1:    // right
      displaySoftSegment(cx - s * 0.5f, cy - s, cx + s * 0.5f, cy, thickness, bg, grey);
      displaySoftSegment(cx + s * 0.5f, cy, cx - s * 0.5f, cy + s, thickness, bg, grey);
      return;
    case 2:    // down
      displaySoftSegment(cx - s, cy - s * 0.5f, cx, cy + s * 0.5f, thickness, bg, grey);
      displaySoftSegment(cx, cy + s * 0.5f, cx + s, cy - s * 0.5f, thickness, bg, grey);
      return;
    default:   // up
      displaySoftSegment(cx - s, cy + s * 0.5f, cx, cy - s * 0.5f, thickness, bg, grey);
      displaySoftSegment(cx, cy - s * 0.5f, cx + s, cy + s * 0.5f, thickness, bg, grey);
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// The accent
// ---------------------------------------------------------------------------------------------

void accentCapsule(const Rect& r, uint8_t bg) {
  displaySoftRoundRectRgb(r.x, r.y, r.w, r.h, r.h * 0.5f, greyRgb(bg), (int32_t)kAccentRgb, -1,
                           0.0f, 1.4f);
}

void accentOutline(const Rect& r, float strokeWidth, uint8_t bg) {
  displaySoftRoundRectRgb(r.x, r.y, r.w, r.h, r.h * 0.5f, greyRgb(bg), -1, (int32_t)kAccentRgb,
                           strokeWidth, 1.3f);
}

void accentMarker(int16_t x, int16_t y, int16_t h, uint8_t bg) {
  displaySoftRoundRectRgb(x, y, 4, h, 2.0f, greyRgb(bg), (int32_t)kAccentRgb, -1, 0.0f, 1.1f);
}

void accentDot(int16_t cx, int16_t cy, float radius, uint8_t bg) {
  const int16_t d = (int16_t)(radius * 2.0f + 2.0f);
  displaySoftRoundRectRgb((int16_t)(cx - d / 2), (int16_t)(cy - d / 2), d, d, d * 0.5f,
                           greyRgb(bg), (int32_t)kAccentRgb, -1, 0.0f, 1.1f);
}

void accentPixel(int16_t x, int16_t y, int16_t size, uint8_t bg) {
  displaySoftRoundRectRgb(x, y, size, size, 1.5f, greyRgb(bg), (int32_t)kAccentRgb, -1, 0.0f,
                           1.1f);
}

void pixel(int16_t x, int16_t y, int16_t size, uint8_t grey, uint8_t bg) {
  displaySoftRoundRect(x, y, size, size, 1.5f, bg, (int16_t)grey, -1, 0.0f, 1.1f);
}

// ---------------------------------------------------------------------------------------------
// The metric rhythm
// ---------------------------------------------------------------------------------------------

void statLine(int16_t x, int16_t y, const String& value, const String& caption,
              uint8_t valueTone) {
  // The glyph sits beside the value, not above it: the console stacks its stat blocks because it
  // has a column to stack them in, and a 240 px screen has a row.
  pixel(x, y + 4, 6, kHair);
  const int16_t vw = (int16_t)(value.length() * 6 * 2);
  text((int16_t)(x + 14), y, 2, valueTone, value);
  // The caption is bottom-aligned with the value it belongs to, which is what makes the pair read
  // as one line rather than as two things that happen to be beside each other. It is the console's
  // muted label, not a whisper: it is the only thing that says what the number is.
  if (caption.length() > 0) {
    text((int16_t)(x + 14 + vw + 8), (int16_t)(y + 7), 1, kMuted, caption);
  }
}

void factRow(int16_t x, int16_t y, const String& value, const String& caption,
             uint8_t valueTone, bool accent) {
  if (accent) accentPixel(x, y, 6);
  else pixel(x, y, 6, kHair);
  text((int16_t)(x + 14), y, 1, valueTone, value);
  text((int16_t)(x + 14), (int16_t)(y + 11), 1, kMuted, caption);
}

}  // namespace uip
