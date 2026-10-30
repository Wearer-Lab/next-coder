#include "touch.h"

#include <Wire.h>

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

// Controller-to-panel mapping.
//
// The vendor's own examples map the FT6336G's raw range straight onto the display at rotation 0:
// x over 0..240, y over 0..320, no swap and no inversion (docs/.../Example_29_touch_pen/touch.h).
// This adapter runs the panel at rotation 0, so the mapping is the identity — but it is expressed
// as three flags in one place because a touch panel bonded the other way up is a one-line fix here
// and an unfindable bug everywhere else. TOUCH_TRACE prints raw and mapped coordinates so a bench
// session can tell which of the three is wrong rather than guessing.
#ifndef TOUCH_SWAP_XY
#define TOUCH_SWAP_XY 0
#endif
#ifndef TOUCH_INVERT_X
#define TOUCH_INVERT_X 0
#endif
#ifndef TOUCH_INVERT_Y
#define TOUCH_INVERT_Y 0
#endif
#ifndef TOUCH_TRACE
#define TOUCH_TRACE 0
#endif

namespace {

bool present = false;

bool down = false;
int16_t startX = 0, startY = 0;
int16_t lastX = 0, lastY = 0;
int16_t prevX = 0, prevY = 0;     // the previous poll's point, for the per-poll delta
uint32_t startMs = 0;
uint32_t contactSequence = 0;
int16_t minX = 0, minY = 0, maxX = 0, maxY = 0;
bool moved = false;               // travelled beyond the tap slop at any point in this press

// A swipe has to travel this far to count, and a tap has to stay within it. Below this the two are
// indistinguishable from a finger rolling slightly on release.
constexpr int16_t kSwipeMinPx = 40;
constexpr uint32_t kTapMaxMs = 500;
constexpr uint32_t kLongPressMs = 1200;
// A long press is a press, not a slow drag: the finger has to stay put.
constexpr int16_t kLongPressSlopPx = 24;
// Movement beyond this in either axis means the press was a drag, and a drag is never also a tap.
// A small wobble stays a tap; once this threshold is crossed the contact is permanently
// ineligible for tap or long-press activation, even if it later returns to the origin.
constexpr int16_t kDragSlopPx = 8;
bool longFired = false;
bool longEligible = true;
bool canceledUntilLift = false;
uint32_t lastSampleMs = 0;
constexpr uint32_t kLostContactMs = 150;

enum class PointSample { Unavailable, Released, Point, Cancel };

PointSample readPoint(int16_t& x, int16_t& y) {
  Wire.beginTransmission(TOUCH_I2C_ADDR);
  Wire.write(0x02);                       // touch count, then point 1
  if (Wire.endTransmission(false) != 0) return PointSample::Unavailable;
  if (Wire.requestFrom((int)TOUCH_I2C_ADDR, 5) != 5) return PointSample::Unavailable;

  const uint8_t count = Wire.read() & 0x0F;
  const uint8_t xh = Wire.read();
  const uint8_t xl = Wire.read();
  const uint8_t yh = Wire.read();
  const uint8_t yl = Wire.read();
  if (count == 0) return PointSample::Released;
  // A second finger cannot become a tap or a confirmation on behalf of the first.
  if (count != 1) return PointSample::Cancel;

  int16_t rawX = (int16_t)(((xh & 0x0F) << 8) | xl);
  int16_t rawY = (int16_t)(((yh & 0x0F) << 8) | yl);

#if TOUCH_SWAP_XY
  const int16_t swap = rawX;
  rawX = rawY;
  rawY = swap;
#endif
#if TOUCH_INVERT_X
  rawX = (int16_t)(LCD_WIDTH - 1 - rawX);
#endif
#if TOUCH_INVERT_Y
  rawY = (int16_t)(LCD_HEIGHT - 1 - rawY);
#endif

  // Clamped rather than rejected: a point one pixel off the edge is a real touch on the bezel, and
  // dropping it makes a button at the screen edge feel dead.
  if (rawX < 0) rawX = 0;
  if (rawY < 0) rawY = 0;
  if (rawX > LCD_WIDTH - 1) rawX = LCD_WIDTH - 1;
  if (rawY > LCD_HEIGHT - 1) rawY = LCD_HEIGHT - 1;

  x = rawX;
  y = rawY;
  return PointSample::Point;
}

}  // namespace

bool touchPresent() { return present; }
bool touchDown() { return down; }
uint32_t touchContactId() { return contactSequence; }

bool touchBegin() {
  pinMode(TOUCH_RST_PIN, OUTPUT);
  digitalWrite(TOUCH_RST_PIN, LOW);
  delay(10);
  digitalWrite(TOUCH_RST_PIN, HIGH);
  delay(120);                              // the controller needs this long before it will ACK

  pinMode(TOUCH_INT_PIN, INPUT_PULLUP);

  Wire.beginTransmission(TOUCH_I2C_ADDR);
  present = Wire.endTransmission() == 0;
  Serial.printf("[touch] FT6336G at 0x%02x: %s\n", TOUCH_I2C_ADDR,
                present ? "present" : "no ACK");
  return present;
}

TouchEvent touchPoll() {
  TouchEvent event;
  event.contactId = contactSequence;
  event.startX = startX; event.startY = startY;
  event.sampledAt = millis();
  event.minX=minX;event.minY=minY;event.maxX=maxX;event.maxY=maxY;
  if (!present) return event;

  int16_t x = 0, y = 0;
  const PointSample sample = readPoint(x, y);
  if (sample == PointSample::Unavailable || sample == PointSample::Cancel) {
    // An I2C error is not evidence of a lift. Brief codec/bus contention keeps the gesture alive;
    // a lost contact or multi-touch cancels it with Release, never a synthetic Tap/confirmation.
    if (sample == PointSample::Cancel) canceledUntilLift = true;
    if (!down || (sample == PointSample::Unavailable
        && millis() - lastSampleMs < kLostContactMs)) return event;
    down = false;
    canceledUntilLift = true;
    longFired = false;
    event.gesture = TouchGesture::Release;
    event.x = lastX;
    event.y = lastY;
    return event;
  }
  lastSampleMs = millis();
  if (canceledUntilLift) {
    if (sample == PointSample::Released) canceledUntilLift = false;
    return event;
  }

  if (sample == PointSample::Point) {
#if TOUCH_TRACE
    Serial.printf("[touch] point %d,%d\n", (int)x, (int)y);
#endif
    if (!down) {
      down = true;
      longFired = false;
      longEligible = true;
      moved = false;
      startX = prevX = lastX = x;
      startY = prevY = lastY = y;
      startMs = millis();
      contactSequence += 1;
      if (contactSequence == 0) contactSequence = 1;
      event.contactId = contactSequence;
      event.startX = x; event.startY = y;
      minX=maxX=x;minY=maxY=y;
      event.minX=minX;event.minY=minY;event.maxX=maxX;event.maxY=maxY;
      event.gesture = TouchGesture::Press;
      event.x = x;
      event.y = y;
      return event;
    }
    // The release read returns nothing at all, so the travel has to be measured from the last
    // point seen while the finger was still down.
    lastX = x;
    lastY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    event.minX=minX;event.minY=minY;event.maxX=maxX;event.maxY=maxY;
    if (abs(x - startX) > kDragSlopPx || abs(y - startY) > kDragSlopPx) moved = true;
    if (moved) longEligible = false;

    if (!longFired && longEligible && millis() - startMs >= kLongPressMs) {
      const int16_t mx = x - startX, my = y - startY;
      if (abs(mx) <= kLongPressSlopPx && abs(my) <= kLongPressSlopPx) {
        longFired = true;
        event.gesture = TouchGesture::LongPress;
        event.x = x;
        event.y = y;
        return event;
      }
    }

    if (x != prevX || y != prevY) {
      event.gesture = TouchGesture::Drag;
      event.x = x;
      event.y = y;
      event.dx = (int16_t)(x - prevX);
      event.dy = (int16_t)(y - prevY);
      prevX = x;
      prevY = y;
      return event;
    }
    return event;
  }

  if (!down) return event;
  down = false;
  event.x = lastX;
  event.y = lastY;
  // A long press already fired; the lift that follows it is not also a tap or a swipe — but it is
  // still a lift, and it has to be reported as one.
  //
  // Returning None here silently swallowed the end of every push-to-talk hold: a voice note is by
  // definition held past kLongPressMs, so LongPress fired, the UI ignored it (holding the
  // microphone is the whole point of the gesture), and then the finger coming off produced no
  // event at all. The recording only ended when it hit the buffer or duration ceiling, which made
  // every clip the maximum length regardless of when the speaker stopped talking.
  if (longFired) { longFired = false; event.gesture = TouchGesture::Release; return event; }

  const int16_t dx = lastX - startX;
  const uint32_t heldMs = millis() - startMs;

  // Horizontal intent wins over a tap; a slow drag still counts, because a deliberate swipe on a
  // 2.8" panel is often slower than a phone gesture.
  const int16_t dy = lastY - startY;
  if (abs(dx) > abs(dy)) {
    if (dx <= -kSwipeMinPx) { event.gesture = TouchGesture::SwipeLeft; return event; }
    if (dx >= kSwipeMinPx) { event.gesture = TouchGesture::SwipeRight; return event; }
  }
  // A press that scrolled a list is never also a tap on whatever ended up under the finger.
  if (!moved && heldMs <= kTapMaxMs) { event.gesture = TouchGesture::Tap; return event; }
  event.gesture = TouchGesture::Release;
  return event;
}
