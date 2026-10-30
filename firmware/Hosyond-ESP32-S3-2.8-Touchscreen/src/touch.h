#pragma once

// FT6336G capacitive touch, on the I2C bus shared with the ES8311 codec.
//
// Deliberately minimal: this panel reports up to two points, but nothing in this UI needs a second
// finger, and a gesture recogniser that only has to tell a tap from a drag does not need the
// controller's gesture registers (which are unreliable across FT6xxx variants anyway).
//
// The UI needs three things from a finger and gets exactly those: where it landed (tap targets),
// how far it has moved since the last poll (list scrolling, which is direct manipulation rather
// than a fling), and whether it is still down (push-to-talk).

#include <Arduino.h>

enum class TouchGesture : uint8_t {
  None,
  Press,        // first contact, at (x, y)
  Drag,         // still down and moved since the last poll; dx/dy carry the movement
  Release,      // lifted after a drag — the gesture was movement, not a tap
  Tap,          // pressed and lifted without travelling
  SwipeLeft,
  SwipeRight,
  LongPress,    // fires WHILE held
};

// One event per poll. `x`/`y` are panel pixels for Press, Drag and Tap — the coordinate frame the
// renderer draws in, not the controller's raw frame. `dx`/`dy` are movement since the previous
// poll and are zero except on Drag.
struct TouchEvent {
  TouchGesture gesture = TouchGesture::None;
  int16_t x = 0;
  int16_t y = 0;
  int16_t dx = 0;
  int16_t dy = 0;
  int16_t startX = 0, startY = 0; // immutable point captured on first contact
  uint32_t contactId = 0;
  uint32_t sampledAt = 0;
  int16_t minX = 0, minY = 0, maxX = 0, maxY = 0; // complete contact excursion
};

// Resets the controller and probes for it on I2C. Wire must already be started.
bool touchBegin();
bool touchPresent();

// Call from loop(). Returns a gesture once.
//
// Everything but LongPress and Drag is decided on release, because a swipe is not distinguishable
// from a tap until the finger lifts. LongPress fires WHILE held, the moment the threshold passes —
// waiting for release would mean holding a button with no acknowledgement, which reads as broken.
TouchEvent touchPoll();

// True while a finger is on the glass. Push-to-talk needs the held state rather than an edge: the
// recording runs for as long as this is true and stops when it goes false.
bool touchDown();
uint32_t touchContactId();

// Geometry/identity captured at down. A contact may cancel its original target, never migrate
// into a neighbor. The UI supplies a semantic target identity and its current navigation epoch.
struct TouchTargetLatch {
  uint32_t contact = 0, identity = 0, generation = 0;
  int16_t x = 0, y = 0, w = 0, h = 0;
  bool active = false;
  bool contains(int16_t px, int16_t py) const {
    return px >= x && py >= y && px < x + w && py < y + h;
  }
  void cancel() { active = false; }
  void begin(const TouchEvent& event, uint32_t target, uint32_t epoch,
             int16_t rx, int16_t ry, int16_t rw, int16_t rh) {
    contact = event.contactId; identity = target; generation = epoch;
    x = rx; y = ry; w = rw; h = rh;
    active = target != 0 && contains(event.x, event.y);
  }
  void move(const TouchEvent& event) {
    if (event.contactId != contact || !contains(event.x, event.y) || !trajectoryInside(event)) cancel();
  }
  bool trajectoryInside(const TouchEvent& event) const {
    return event.contactId == 0 || (contains(event.minX,event.minY) && contains(event.maxX,event.maxY));
  }
  bool accepts(const TouchEvent& event, uint32_t target, uint32_t epoch) const {
    return active && event.contactId == contact && target == identity
      && generation == epoch && contains(event.x, event.y) && trajectoryInside(event);
  }
};

// Bounded retention for discrete input while the model lock is occupied. Drags are sampled live
// for scrolling; a missed drag cancels activation rather than being replayed as a stale gesture.
class TouchEventBuffer {
 public:
  struct Item { TouchEvent event; uint32_t generation, revision, queuedAt; };
  static bool current(const Item& item, uint32_t generation, uint32_t revision, uint32_t now) {
    return now - item.queuedAt <= 750 && item.generation == generation && item.revision == revision;
  }
  bool push(const TouchEvent& event, uint32_t generation, uint32_t revision, uint32_t now) {
    if (event.gesture == TouchGesture::None || event.gesture == TouchGesture::Drag) return true;
    if (size_ == 4) { clear(); return false; }
    items_[(head_ + size_) % 4] = {event, generation, revision, now};
    ++size_; return true;
  }
  bool pop(Item& item) {
    if (size_ == 0) return false;
    item = items_[head_]; head_ = (head_ + 1) % 4; --size_; return true;
  }
  bool empty() const { return size_ == 0; }
  void clear() { head_ = size_ = 0; }
 private:
  Item items_[4];
  uint8_t head_ = 0, size_ = 0;
};

// Fixed-size, non-content performance evidence. Age starts at the sampled contact edge, not at
// physical finger contact; histogram quantiles are upper bounds, never exact percentiles.
struct TouchPerformanceWindow {
  uint32_t frames=0, maxFrameGap=0, lockSkips=0, inputs=0, maxInputAge=0, retained=0, discarded=0;
  uint32_t ages[8]{};
  uint32_t lastFrameAt=0;
  bool hasFrame=false;
  void frame(uint32_t now) {
    if(hasFrame && now-lastFrameAt>maxFrameGap)maxFrameGap=now-lastFrameAt;
    hasFrame=true;lastFrameAt=now;++frames;
  }
  void dispatched(uint32_t age) {
    ++inputs;if(age>maxInputAge)maxInputAge=age;
    const uint32_t bounds[7]={16,33,66,125,250,500,750};
    uint8_t bucket=0;while(bucket<7 && age>bounds[bucket])++bucket;
    ++ages[bucket];
  }
  uint32_t p95UpperMs() const {
    if(inputs==0)return 0;
    const uint32_t bounds[8]={16,33,66,125,250,500,750,maxInputAge};
    uint32_t seen=0;const uint32_t rank=inputs-inputs/20;
    for(uint8_t i=0;i<8;++i){seen+=ages[i];if(seen>=rank)return bounds[i];}
    return maxInputAge;
  }
  void resetWindow() {
    frames=maxFrameGap=lockSkips=inputs=maxInputAge=retained=discarded=0;
    for(auto& count:ages)count=0;
  }
};
