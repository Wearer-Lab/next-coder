#include "display.h"

#include <esp_heap_caps.h>

#include <OrbPainter.h>
#include <UiProfile.h>

#ifndef DISPLAY_FRAME_PROBE
#define DISPLAY_FRAME_PROBE 0
#endif

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

#include <SPI.h>

namespace {

// Constructed lazily, NOT as a global.
//
// Adafruit_ILI9341's constructor captures a reference to the global `SPI` object. As a file-scope
// global this is the static initialization order fiasco: nothing orders `panel` after `SPI` across
// translation units, so it can capture an SPIClass that has not been constructed yet. The symptom
// is a board that dies before Serial.begin() and therefore explains nothing about itself — which
// is exactly what happened, and it happened even in builds with ENABLE_LCD=0, because the global
// is constructed regardless of whether the display is ever used.
Adafruit_ILI9341* panel = nullptr;
bool ready = false;

// 80 MHz works for the vendor's register-level demo, but it is not reliable through the Arduino
// SPI/Adafruit transaction path on the real board. A lost clock in a long RAM write does not look
// like random noise: the ILI9341 advances its address for every pixel it accepts, so every following
// raster row starts a little farther left or right. That is the sheared text and button outline seen
// after a page repaint. 40 MHz was verified during initial bring-up and leaves timing margin while
// still being substantially faster than Adafruit's 24 MHz default.
#ifndef LCD_SPI_FREQUENCY_HZ
#define LCD_SPI_FREQUENCY_HZ 40000000UL
#endif
uint32_t panelFreq = LCD_SPI_FREQUENCY_HZ;

}  // namespace

bool displayReady() { return ready && panel != nullptr; }

Adafruit_ILI9341& displayPanel() { return *panel; }

void displayBacklight(bool on) {
  // Ramped, not switched. The vendor spec rates this board at 140 mA with the display alone and
  // 560 mA with display + speaker + charging, and the backlight is four white LEDs. Slamming the
  // pin high draws the inrush in one step, which on a weak USB port is enough to brown out the
  // regulator — and a brownout during Wi-Fi bring-up looks exactly like the crash-reboot loop the
  // first hardware flash of this adapter produced.
  //
  // Ramping also avoids driving GPIO45 to a hard rail instantly. That pin is the VDD_SPI strapping
  // pin as well as the backlight, so it is the one pin here worth being gentle with.
  ledcAttach(LCD_BL, 5000, 8);
  if (!on) {
    ledcWrite(LCD_BL, 0);
    return;
  }
  for (int duty = 0; duty <= 255; duty += 5) {
    ledcWrite(LCD_BL, duty);
    delay(2);
  }
  ledcWrite(LCD_BL, 255);
}

bool displayBegin() {
#if !ENABLE_LCD
  return false;
#else
  // Remap the bus through the GPIO matrix: these are not the S3's default SPI pins. MISO is passed
  // because the panel shares the bus, though this driver never reads from it.
  SPI.begin(LCD_SCLK, LCD_MISO, LCD_MOSI, LCD_CS);

  // Built here, after Arduino's init and after SPI is known to exist.
  if (!panel) panel = new Adafruit_ILI9341(LCD_CS, LCD_DC, LCD_RST);
  if (!panel) return false;

  panel->begin(panelFreq);
  Serial.printf("[display] SPI clock: %lu Hz\n", (unsigned long)panelFreq);

  // Inversion OFF. The vendor's init sends 0x21 (INVON), but that sequence is relative to their
  // own register setup, not to Adafruit's — whose ILI9341 init already leaves this panel the right
  // way round. Sending it on top produced a white screen with dark dots on real glass (photo
  // evidence, 2026-08-24), so the two inversions were cancelling. Verified visually: do not
  // "restore" this from the vendor file without looking at the panel.
  // Left at the library default. It provably does nothing on this glass (see PANEL_OUTPUT_INVERTED
  // in display.h); polarity is corrected in software instead.

  panel->setRotation(0);           // portrait, 240x320, ribbon at the bottom
  panel->fillScreen(panelGrey(0));

  // Let the panel's own rails settle before adding the backlight load on top of them.
  delay(20);

  // Backlight goes on only after the framebuffer has been cleared. Enabling it first shows the
  // panel's power-on noise for a few hundred milliseconds, which reads as a fault.
  displayBacklight(true);

  ready = true;
  return true;
#endif
}

namespace {

// A GFXcanvas16 whose pixels live in INTERNAL RAM.
//
// The stock class allocates with plain malloc, which on this board lands in PSRAM, and the buffer
// then intermittently reads back as zeros. That was measured, not guessed: probing the buffer just
// before pushing it caught a frame where every sampled pixel was 0x0000 instead of the 0xFFFF the
// canvas had been filled with, while the surrounding frames were correct. Zeros on this inverted
// panel are white, which is the flickering box.
//
// Staging rows through DMA-capable RAM was necessary but not sufficient: the corruption is on the
// read side, before the copy. The fix is for the pixels never to be in PSRAM at all. 54 KB out of
// ~250 KB of free internal heap.
class InternalCanvas16 : public GFXcanvas16 {
 public:
  InternalCanvas16(uint16_t w, uint16_t h) : GFXcanvas16(w, h, false) {
    buffer = (uint16_t*)heap_caps_malloc((size_t)w * h * sizeof(uint16_t),
                                         MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    buffer_owned = false;   // freed here, not by the base destructor
  }
  ~InternalCanvas16() {
    heap_caps_free(buffer);
    buffer = nullptr;
  }
};

// Off-screen canvases, blitted in one transaction each.
//
// The first version drew every dot straight to the panel and erased the previous frame dot by dot.
// That is ~600 separate SPI transactions per frame, and the panel is scanning out the whole time,
// so the user sees the redraw sweep across the glass — the dark band visible in the bring-up
// video. Compositing in RAM and pushing one rectangle removes both problems: the cost stops
// scaling with dot count, and the panel never shows a half-built frame.
//
// A 148x148 canvas is 43 KB and the label strip is 11 KB, against ~300 KB of free internal heap.
// The orb composites as 8-bit coverage, not colour: it is greyscale by nature, this halves the
// buffer, and anti-aliasing wants to blend coverage rather than packed RGB565.
uint8_t* orbGrey = nullptr;
int16_t orbDim = 0;

// The list screens' activity indicator. A 44 px orb is 1.9 KB against the main orb's 22 KB, and
// its dot budget is small enough that the whole frame is dominated by the blit rather than the
// maths.
uint8_t* miniGrey = nullptr;
int16_t miniDim = 0;

InternalCanvas16* labelCanvas = nullptr;
bool composingBands = false;

constexpr int16_t kLabelH = 22;

// BEGIN ABSOLUTE SCENE PROXY: fixed state, no separate framebuffer or allocation.
bool sceneActive = false;
int16_t sceneBandTop = 0, sceneBandBottom = 0;
class SceneGfx : public Adafruit_GFX {
 public:
  SceneGfx() : Adafruit_GFX(240, 320) {}
  void drawPixel(int16_t x, int16_t y, uint16_t color) override {
    if (sceneActive && x >= 0 && x < 240 && y >= sceneBandTop && y < sceneBandBottom)
      labelCanvas->getBuffer()[static_cast<size_t>(y-sceneBandTop)*240+x] = color;
  }
  void writePixel(int16_t x, int16_t y, uint16_t color) override { drawPixel(x,y,color); }
  void fillRect(int16_t x, int16_t y, int16_t w, int16_t h, uint16_t color) override {
    if (!sceneActive || w<=0 || h<=0) return;
    const int32_t left=x<0?0:x, top=y<sceneBandTop?sceneBandTop:y;
    const int32_t right=static_cast<int32_t>(x)+w>240?240:static_cast<int32_t>(x)+w;
    const int32_t bottom=static_cast<int32_t>(y)+h>sceneBandBottom?sceneBandBottom:static_cast<int32_t>(y)+h;
    if(right<=left || bottom<=top)return;
    for(int32_t row=top;row<bottom;++row){
      uint16_t* dst=labelCanvas->getBuffer()+static_cast<size_t>(row-sceneBandTop)*240+left;
      for(int32_t col=left;col<right;++col)*dst++=color;
    }
  }
  void writeFillRect(int16_t x,int16_t y,int16_t w,int16_t h,uint16_t c) override {fillRect(x,y,w,h,c);}
  void drawFastHLine(int16_t x,int16_t y,int16_t w,uint16_t c) override {fillRect(x,y,w,1,c);}
  void drawFastVLine(int16_t x,int16_t y,int16_t h,uint16_t c) override {fillRect(x,y,1,h,c);}
  void writeFastHLine(int16_t x,int16_t y,int16_t w,uint16_t c) override {fillRect(x,y,w,1,c);}
  void writeFastVLine(int16_t x,int16_t y,int16_t h,uint16_t c) override {fillRect(x,y,1,h,c);}
};
SceneGfx sceneGfx;
// END ABSOLUTE SCENE PROXY

// One row of pixels in internal, DMA-capable RAM.
//
// GFXcanvas16 allocates with plain malloc, and on this board that lands in PSRAM (confirmed at
// runtime: the buffers came back at 0x3c0f_xxxx while the internal heap moved by 120 bytes for
// 54 KB of canvas). SPI DMA cannot reliably source from PSRAM — the controller reads stale or
// unmapped data — which is exactly what a rectangle that flickers between the drawn frame and
// white looks like.
//
// Rather than fight GFXcanvas16's allocator, each row is copied into this internal staging buffer
// on its way out. 480 bytes of DMA-safe RAM, one memcpy of ~300 bytes per row, and the canvas keeps
// all of Adafruit_GFX's drawing primitives.
uint16_t* dmaRow = nullptr;

// Raster kernels clip to the active band BEFORE computing distance fields; replay therefore
// evaluates each visible pixel once rather than repeating a full shape twelve times.
void clipSceneBand(int16_t& top,int16_t& bottom) {
  if(!sceneActive)return;
  if(top<sceneBandTop)top=sceneBandTop;
  if(bottom>sceneBandBottom)bottom=sceneBandBottom;
}
void beginRaster(int16_t x,int16_t y,int16_t width,int16_t rows) {
  if(sceneActive)return;
  auto& panel=displayPanel();panel.startWrite();panel.setAddrWindow(x,y,width,rows);
}
void publishRasterRow(int16_t x,int16_t y,int16_t width) {
  if(sceneActive) {
    if(y>=sceneBandTop && y<sceneBandBottom) {
      const int16_t from=x<0?static_cast<int16_t>(-x):0;
      const int16_t to=x+width>240?static_cast<int16_t>(240-x):width;
      if(to>from)memcpy(labelCanvas->getBuffer()+static_cast<size_t>(y-sceneBandTop)*240+x+from,dmaRow+from,static_cast<size_t>(to-from)*2);
    }
  } else displayPanel().writePixels(dmaRow,width);
}
void endRaster() {if(!sceneActive)displayPanel().endWrite();}

// Copies `len` pixels from a possibly-PSRAM source into the staging row and pushes them.
void pushRow(Adafruit_ILI9341& g, const uint16_t* src, int16_t len) {
  if (!dmaRow) return;
  memcpy(dmaRow, src, (size_t)len * sizeof(uint16_t));
  g.writePixels(dmaRow, len);
}

}  // namespace

Adafruit_GFX& displayRenderGfx() { return sceneActive ? static_cast<Adafruit_GFX&>(sceneGfx) : static_cast<Adafruit_GFX&>(displayPanel()); }
bool displaySceneActive() { return sceneActive; }
bool displayRenderIntersects(int16_t x,int16_t y,int32_t width,int32_t height) {
  if(width<=0 || height<=0)return false;
  return !sceneActive || (x<240 && static_cast<int32_t>(x)+width>0
    && y<sceneBandBottom && static_cast<int32_t>(y)+height>sceneBandTop);
}

bool displayBeginCanvases(uint16_t orbSize, uint16_t miniSize) {
  const uint32_t heapBefore = ESP.getFreeHeap();

  if (!orbGrey) {
    orbDim = (int16_t)orbSize;
    orbGrey = (uint8_t*)heap_caps_malloc((size_t)orbSize * orbSize,
                                         MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  }
  if (!miniGrey && miniSize > 0) {
    miniDim = (int16_t)miniSize;
    miniGrey = (uint8_t*)heap_caps_malloc((size_t)miniSize * miniSize,
                                          MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  }
  if (!labelCanvas) labelCanvas = new InternalCanvas16(240, kLabelH);

  const uint8_t* orbBuf = orbGrey;
  const uint16_t* labelBuf = labelCanvas ? labelCanvas->getBuffer() : nullptr;

  Serial.printf(
    "[display] buffers: orb %ux%u grey=%p (%u B), label 240x%d buf=%p (%u B), heap %u -> %u\n",
    (unsigned)orbSize, (unsigned)orbSize, (const void*)orbBuf,
    (unsigned)(orbSize * orbSize), (int)kLabelH, (const void*)labelBuf,
    (unsigned)(240 * kLabelH * 2), (unsigned)heapBefore, (unsigned)ESP.getFreeHeap()
  );

  if (!dmaRow) {
    dmaRow = (uint16_t*)heap_caps_malloc(240 * sizeof(uint16_t), MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  }

  Serial.printf("[display] dma row buf=%p (%s)\n", (const void*)dmaRow,
                dmaRow ? "internal/DMA" : "FAILED");

  if (!orbBuf || !labelBuf || !dmaRow) {
    Serial.println("[display] BUFFER ALLOCATION FAILED — the orb cannot be composited.");
    return false;
  }
  if (miniSize > 0 && !miniGrey) {
    Serial.println("[display] Mini-orb buffer failed; list screens will be static.");
  }
  return true;
}

namespace {

// How many disc rows share one address window. 4 is the middle of the trade: it removes three
// quarters of the per-row command transfers for ~4% extra (zero-coverage) pixels. 1 reproduces the
// original one-window-per-row output exactly.
#ifndef ORB_BLIT_ROWS_PER_WINDOW
#define ORB_BLIT_ROWS_PER_WINDOW 4
#endif

// panelGrey() as a table: the conversion ran per pixel, ~9 850 times a frame, and a 512-byte lookup
// is two loads where the arithmetic is a dozen ALU operations. Built from panelGrey() itself, so a
// panel with different polarity changes one function, not two.
uint16_t greyLut[256];
bool greyLutReady = false;

// Write only as much of the disc as the orb's ink can reach. 1 (default) clips; 0 writes the whole
// inscribed disc every frame, as before.
#ifndef ORB_BLIT_REACH_CLIP
#define ORB_BLIT_REACH_CLIP 1
#endif

// What the last blit of each coverage buffer left on the panel, so the next one knows how far to
// erase. Keyed by buffer (there are two: the big orb's and the mini orb's) and by where and how big
// it was drawn; any mismatch means "unknown", and unknown means the whole disc.
struct ReachMemo {
  const uint8_t* grey = nullptr;
  int16_t cx = 0, cy = 0, drawDim = 0;
  int16_t reachPx = 0;     // the ink radius this buffer's last frame occupied
};
ReachMemo reachMemo[2];

// The [blit-split] measurement: cycle counts around the three stages of the blit, summed over a
// 2 s window. Present only under HOSYOND_UI_PROFILE (UiProfile.h) -- the accounting, not just the
// printf, because a release frame would otherwise read the cycle counter around every address
// window and every row, and update a handful of accumulators, for a line nobody is listening to.
// BLIT_PROBE(...) is the whole mechanism: its argument is a statement that exists in a profiled
// build and vanishes otherwise, so the blit below reads as the blit with the probes marked, not as
// two functions.
#if HOSYOND_UI_PROFILE
struct BlitProbe {
  uint32_t frames = 0, windows = 0, pixels = 0, windowStartMs = 0, discRadiusSum = 0;
  uint32_t convertCyc = 0, windowCyc = 0, pushCyc = 0, totalCyc = 0;
};
BlitProbe blitProbe;
#define BLIT_PROBE(...) __VA_ARGS__
#else
#define BLIT_PROBE(...)
#endif

void blitOrb(ThinkingOrb& orb, int16_t cx, int16_t cy, uint32_t elapsedMs, uint8_t* grey,
             int16_t dim, int16_t drawDim) {
  if (!displayReady() || !grey || !dmaRow) return;
  if (drawDim <= 0 || drawDim > dim) drawDim = dim;

  const OrbFrame frame = orb.render(elapsedMs);
  const int16_t mid = dim / 2;
  const int16_t half = drawDim / 2;

  // Rasterised by the shared painter, so this board and every other draw the identical orb. An
  // e-paper controller and an AMOLED one should be recognisably the same product, which they will
  // not be if each grows its own rasteriser.
  paintOrbCoverage(frame, grey, dim);

  // Pushed as a DISC, one span per row, not as a square.
  //
  // The square was visible on glass: a circular object sitting in a box, because the corners of the
  // blit are written with the coverage buffer's zero — which is only the same colour as the page
  // when the page happens to be the ground. It is not, on a card or under the action tray, and the
  // box showed. Clipping to the inscribed circle means those pixels are never written at all, so
  // whatever is behind the orb stays behind it.
  //
  // It is also 21% fewer pixels — pi/4 of the box — which on the frame that costs the most is the
  // cheapest 21% available. The extra cost is one setAddrWindow per row instead of one per frame:
  // about eleven bytes of command at 80 MHz, against the ~150 pixels each row saves.
  //
  // No anti-aliasing at the rim, deliberately. The geometry never reaches the inscribed circle —
  // the widest mode projects to roughly 0.9 of it — so this cuts through pixels that are already
  // zero, and feathering an edge the drawing never touches would only cost time.
  const float r = (float)half;

  // THE DISC IS ONLY AS BIG AS THE INK.
  //
  // The inscribed disc is 56 px in radius; the ink never leaves ~47 (kOrbInkR in ui.cpp, measured
  // from the geometry, not assumed). Everything between is zero coverage, rewritten as zero every
  // frame over a ground that is already zero. That is 30% of the pixels, and since pushing pixels
  // is the single biggest term of the blit (4.1 ms against 2.0 ms of wire time, the difference
  // being fixed overhead on every 64-byte FIFO chunk), 30% fewer pixels is 30% fewer chunks too.
  //
  // So the disc is shrunk to this frame's actual reach plus the previous frame's, and a margin:
  //   * THIS frame's reach is the farthest dot centre plus the biggest dot radius plus the
  //     anti-aliasing half pixel (lines: a pixel). It is an upper bound, not the exact extent;
  //     over-covering by a pixel costs nothing, under-covering clips ink.
  //   * The PREVIOUS frame's reach is included because pixels it inked and this frame does not must
  //     be erased, or a shrinking orb leaves a ghost ring behind it.
  //   * A buffer drawn somewhere else, at another size, or for the first time has no memory, and
  //     gets the whole disc: unknown means rewrite everything, which is what it always did.
  // The ring that is no longer written is whatever the page already had there, which is the ground.
  float rad = r;
#if ORB_BLIT_REACH_CLIP
  if (!sceneActive) {
    int32_t farthest2 = 0;
    int32_t extra16 = 0;
    for (uint16_t i = 0; i < frame.count; ++i) {
      const OrbDot& d = frame.dots[i];
      const int32_t q = static_cast<int32_t>(d.x16) * d.x16 + static_cast<int32_t>(d.y16) * d.y16;
      if (q > farthest2) farthest2 = q;
      if (d.r16 > extra16) extra16 = d.r16;
    }
    extra16 += 8;                       // a dot's coverage reaches r + 0.5 px
    for (uint16_t i = 0; i < frame.lineCount; ++i) {
      const OrbLine& L = frame.lines[i];
      const int32_t qa = static_cast<int32_t>(L.x16a) * L.x16a + static_cast<int32_t>(L.y16a) * L.y16a;
      const int32_t qb = static_cast<int32_t>(L.x16b) * L.x16b + static_cast<int32_t>(L.y16b) * L.y16b;
      if (qa > farthest2) farthest2 = qa;
      if (qb > farthest2) farthest2 = qb;
      if (extra16 < 16) extra16 = 16;   // a stroke reaches one pixel either side of its centre line
    }
    const int32_t reach16 = static_cast<int32_t>(ceilf(sqrtf(static_cast<float>(farthest2)))) + extra16;
    const int16_t curReach = static_cast<int16_t>((reach16 + 15) / 16 + 1);

    ReachMemo* memo = nullptr;
    for (ReachMemo& m : reachMemo) if (m.grey == grey) memo = &m;
    if (!memo) memo = reachMemo[0].grey ? &reachMemo[1] : &reachMemo[0];
    const bool known = memo->grey == grey && memo->cx == cx && memo->cy == cy && memo->drawDim == drawDim;
    // +3: the span walk below truncates its half-width to whole pixels, which can take up to a pixel
    // and a half off the nominal radius.
    int16_t cover = known ? (memo->reachPx > curReach ? memo->reachPx : curReach) : half;
    cover = static_cast<int16_t>(cover + 3);
    if (cover < half) rad = static_cast<float>(cover);
    memo->grey = grey; memo->cx = cx; memo->cy = cy; memo->drawDim = drawDim; memo->reachPx = curReach;
  }
#endif
  const float rad2 = rad * rad;

  // The disc's span on one row, as it has always been computed, from the disc's radius `rad`
  // around the buffer's centre. False for a row with none.
  const auto spanOf = [&](int16_t row, int16_t& from, int16_t& to) -> bool {
    const float dy = (row - r) + 0.5f;
    const float inside = rad2 - dy * dy;
    if (inside <= 0.0f) return false;
    const int16_t reach = (int16_t)sqrtf(inside);
    from = (int16_t)(half - reach);
    to = (int16_t)(half + reach);
    if (from < 0) from = 0;
    if (to > drawDim) to = drawDim;
    return to - from > 0;
  };

  if (!greyLutReady) {
    for (int i = 0; i < 256; ++i) greyLut[i] = panelGrey(static_cast<uint8_t>(i));
    greyLutReady = true;
  }

  Adafruit_ILI9341& g = displayPanel();

  if (sceneActive) {
    // Scene replay copies each row into the band canvas; there is no SPI to batch, so it keeps the
    // original row-at-a-time walk.
    for (int16_t row = 0; row < drawDim; ++row) {
      const int16_t absoluteY = static_cast<int16_t>(cy - half + row);
      if (absoluteY < sceneBandTop || absoluteY >= sceneBandBottom) continue;
      int16_t from, to;
      if (!spanOf(row, from, to)) continue;
      const int16_t span = (int16_t)(to - from);
      const uint8_t* src = grey + (size_t)(mid - half + row) * dim + (mid - half + from);
      for (int16_t col = 0; col < span; ++col) dmaRow[col] = greyLut[src[col]];
      publishRasterRow(static_cast<int16_t>(cx - half + from), absoluteY, span);
    }
    return;
  }

  // ONE ADDRESS WINDOW PER GROUP OF ROWS, NOT PER ROW.
  //
  // What the old loop cost, from the SDK source rather than a guess. Every setAddrWindow() is up to
  // seven separate SPI transfers (CASET command, two 16-bit words, PASET command, two words, RAMWR
  // command), and on the ESP32-S3 each transfer in esp32-hal-spi.c is: load the FIFO, `cmd.update`
  // and wait for the register sync, `cmd.usr` and wait for the state machine. The wire time of one
  // byte at 80 MHz is 0.1 us; the start/sync latency around it is several microseconds. A 112 px
  // disc paid that 112 times a frame, and every 64-byte FIFO chunk of pixel data pays it again. Of
  // the measured 7.83 ms "blit&other", the pixel wire time is only ~2.0 ms (9 852 px x 16 bit /
  // 80 MHz); the rest is that fixed per-transfer latency plus the grey conversion. [blit-split]
  // below reports the three separately so the split is measured, not inferred.
  //
  // Rows are grouped so one RAMWR streams several rows: the window is the hull of the group's
  // spans, and the controller wraps to the next row at the window's right edge by itself. A disc's
  // spans differ most near its top and bottom, so the hull writes a few extra pixels there — about
  // B x 2r in all, ~4% of the disc at B = 4 — and those pixels are the coverage buffer's own
  // values, which are zero: the geometry never reaches the inscribed circle. They land on the
  // ground the disc already sits on; the original square-box bug was 21% of the box in the CORNERS,
  // not a hair of rim. Set ORB_BLIT_ROWS_PER_WINDOW to 1 to get the old one-window-per-row output.
  BLIT_PROBE(BlitProbe& probe = blitProbe;)
  BLIT_PROBE(const uint32_t cycStart = ESP.getCycleCount();)
  BLIT_PROBE(uint32_t convertCyc = 0, windowCyc = 0, pushCyc = 0, pixels = 0, windows = 0;)

  g.startWrite();
  int16_t row = 0;
  while (row < drawDim) {
    int16_t from = 0, to = 0;
    if (!spanOf(row, from, to)) { ++row; continue; }
    int16_t hullFrom = from, hullTo = to;
    int16_t n = 1;
    while (n < ORB_BLIT_ROWS_PER_WINDOW && row + n < drawDim) {
      int16_t f2, t2;
      if (!spanOf(static_cast<int16_t>(row + n), f2, t2)) break;
      if (f2 < hullFrom) hullFrom = f2;
      if (t2 > hullTo) hullTo = t2;
      ++n;
    }
    const int16_t w = static_cast<int16_t>(hullTo - hullFrom);
    if (w > 240) { row = static_cast<int16_t>(row + n); continue; }   // cannot happen: staging row is 240

    BLIT_PROBE(const uint32_t c0 = ESP.getCycleCount();)
    g.setAddrWindow(static_cast<int16_t>(cx - half + hullFrom), static_cast<int16_t>(cy - half + row), w, n);
    BLIT_PROBE(windowCyc += ESP.getCycleCount() - c0;)
    BLIT_PROBE(++windows;)

    for (int16_t i = 0; i < n; ++i) {
      const uint8_t* src = grey + (size_t)(mid - half + row + i) * dim + (mid - half + hullFrom);
      BLIT_PROBE(const uint32_t c1 = ESP.getCycleCount();)
      for (int16_t col = 0; col < w; ++col) dmaRow[col] = greyLut[src[col]];
      BLIT_PROBE(const uint32_t c2 = ESP.getCycleCount();)
      g.writePixels(dmaRow, w);
      BLIT_PROBE(const uint32_t c3 = ESP.getCycleCount();)
      BLIT_PROBE(convertCyc += c2 - c1;)
      BLIT_PROBE(pushCyc += c3 - c2;)
      BLIT_PROBE(pixels += static_cast<uint32_t>(w);)
    }
    row = static_cast<int16_t>(row + n);
  }
  g.endWrite();

#if HOSYOND_UI_PROFILE
  // MEASUREMENT (HOSYOND_UI_PROFILE only): bounded, one line per 2 s window.
  const uint32_t cycTotal = ESP.getCycleCount() - cycStart;
  ++probe.frames;
  probe.windows += windows;
  probe.pixels += pixels;
  probe.convertCyc += convertCyc;
  probe.windowCyc += windowCyc;
  probe.pushCyc += pushCyc;
  probe.totalCyc += cycTotal;
  probe.discRadiusSum += static_cast<uint32_t>(rad);
  const uint32_t nowMs = millis();
  if (probe.windowStartMs == 0) probe.windowStartMs = nowMs;
  if (nowMs - probe.windowStartMs >= 2000 && probe.frames) {
    const double perMs = static_cast<double>(getCpuFrequencyMhz()) * 1000.0 * probe.frames;
    const double convert = probe.convertCyc / perMs, window = probe.windowCyc / perMs;
    const double push = probe.pushCyc / perMs, total = probe.totalCyc / perMs;
    Serial.printf("[blit-split] rows_per_window=%d reach_clip=%d disc_r=%.1f frames=%u windows/frame=%.1f px/frame=%.0f | blit_ms=%.2f = convert %.2f + window %.2f + push %.2f + other %.2f  (wire time at %lu MHz would be %.2f)\n",
      static_cast<int>(ORB_BLIT_ROWS_PER_WINDOW), static_cast<int>(ORB_BLIT_REACH_CLIP),
      static_cast<double>(probe.discRadiusSum) / probe.frames, static_cast<unsigned>(probe.frames),
      static_cast<double>(probe.windows) / probe.frames, static_cast<double>(probe.pixels) / probe.frames,
      total, convert, window, push, total - convert - window - push,
      static_cast<unsigned long>(panelFreq / 1000000UL),
      static_cast<double>(probe.pixels) / probe.frames * 16.0 / static_cast<double>(panelFreq) * 1000.0);
    probe = BlitProbe{};
    probe.windowStartMs = nowMs;
  }
#endif  // HOSYOND_UI_PROFILE
}

}  // namespace

void displayDrawOrb(ThinkingOrb& orb, int16_t cx, int16_t cy, uint32_t elapsedMs,
                    uint16_t drawDiameter) {
  blitOrb(orb, cx, cy, elapsedMs, orbGrey, orbDim, (int16_t)drawDiameter);
}

void displayDrawMiniOrb(ThinkingOrb& orb, int16_t cx, int16_t cy, uint32_t elapsedMs) {
  blitOrb(orb, cx, cy, elapsedMs, miniGrey, miniDim, miniDim);
}

void displayClearStatus(int16_t cy) {
  if (!displayReady()) return;
  // Full width, because only the caller knows the label changed and the incoming word may be
  // narrower than the outgoing one.
  displayRenderGfx().fillRect(0, cy - 4, 240, kLabelH, panelGrey(0));
}

bool displayComposeBands(int16_t y, int16_t height, uint16_t background,
                         DisplayBandPainter painter, void* context) {
  if (!displayReady() || !labelCanvas || !labelCanvas->getBuffer() || !dmaRow
      || !painter || height <= 0 || composingBands) return false;
  const int32_t first = y < 0 ? 0 : y;
  const int32_t requestedEnd = static_cast<int32_t>(y) + height;
  const int32_t end = requestedEnd > 320 ? 320 : requestedEnd;
  if (first >= end || first >= 320) return false;
  composingBands = true;
  struct ComposeGuard { ~ComposeGuard() { composingBands = false; } } guard;
  for (int32_t top = first; top < end; top += kLabelH) {
    const int16_t rows = static_cast<int16_t>(end - top < kLabelH ? end - top : kLabelH);
    labelCanvas->setRotation(0);
    labelCanvas->setFont(nullptr);
    labelCanvas->setTextWrap(false);
    labelCanvas->setTextSize(1);
    labelCanvas->setCursor(0, 0);
    labelCanvas->setTextColor(background);
    labelCanvas->fillScreen(background);
    painter(*labelCanvas, static_cast<int16_t>(top), context);
    // Publish only after background, every key face, and every glyph in this band is complete.
    // The source and staging row both remain internal RAM, preserving the proven DMA path.
    Adafruit_ILI9341& panel = displayPanel();
    panel.startWrite();
    panel.setAddrWindow(0, static_cast<int16_t>(top), 240, rows);
    const uint16_t* pixels = labelCanvas->getBuffer();
    for (int16_t row = 0; row < rows; ++row) pushRow(panel, pixels + static_cast<size_t>(row) * 240, 240);
    panel.endWrite();
  }
  labelCanvas->setRotation(0);
  labelCanvas->setFont(nullptr);
  labelCanvas->setTextWrap(true);
  return true;
}

namespace {
struct SceneCall { DisplayScenePainter painter;void* context;int16_t end; };
void replaySceneBand(Adafruit_GFX&,int16_t top,void* raw) {
  const auto& call=*static_cast<SceneCall*>(raw);
  sceneBandTop=top;sceneBandBottom=static_cast<int16_t>(top+kLabelH<call.end?top+kLabelH:call.end);
  sceneActive=true;
  struct SceneGuard {~SceneGuard(){sceneActive=false;}} guard;
  sceneGfx.setRotation(0);sceneGfx.setFont(nullptr);sceneGfx.setTextWrap(false);
  sceneGfx.setTextSize(1);sceneGfx.setCursor(0,0);
  call.painter(call.context);
}
}
bool displayComposeScene(int16_t y,int16_t height,uint16_t background,
                         DisplayScenePainter painter,void* context) {
  if(!painter || height<=0 || composingBands || sceneActive)return false;
  const int32_t end=static_cast<int32_t>(y)+height;
  SceneCall call{painter,context,static_cast<int16_t>(end>320?320:end)};
  return displayComposeBands(y,height,background,replaySceneBand,&call);
}

void displayDrawStatus(const char* label, int16_t cy, uint32_t elapsedMs) {
  if (!displayReady() || !labelCanvas || !labelCanvas->getBuffer() || !label) return;

  const size_t len = strlen(label);
  if (len == 0) return;

  const int16_t charW = 12;                       // 6 px base glyph at size 2
  const int16_t textW = (int16_t)(len * charW);
  const int16_t x0 = (int16_t)((240 - textW) / 2);

  // The web component sweeps a bright band across the label with a CSS gradient. There is no
  // gradient here, so the same read is produced per-glyph: a moving window of brighter characters.
  //
  // The sweep is slow and the brightness range is narrow on purpose. The first version swung each
  // glyph between 96 and 255 every 1.1 s, which at a glance is not a shimmer, it is a flicker —
  // eight characters strobing out of phase. 150..235 over 2.6 s reads as a highlight travelling
  // across a word.
  const float head = fmodf(elapsedMs / 2600.0f, 1.5f) * (len + 4.0f) - 2.0f;

  // Only the glyphs, and only the width they occupy, are repainted. Clearing and pushing the full
  // 240 px strip every frame made the whole line pulse against the background.
  const int16_t stripX = (int16_t)(x0 - 4 < 0 ? 0 : x0 - 4);
  const int16_t stripW = (int16_t)(textW + 8 > 240 ? 240 : textW + 8);

  if(sceneActive) {
    if(!displayRenderIntersects(stripX,cy-4,stripW,kLabelH))return;
    sceneGfx.fillRect(stripX,cy-4,stripW,kLabelH,panelGrey(0));
    sceneGfx.setTextWrap(false);sceneGfx.setTextSize(2);
    for(size_t i=0;i<len;++i){
      const float d=fabsf(static_cast<float>(i)-head);
      const float lift=d>2.6f?0.0f:1.0f-d/2.6f;
      sceneGfx.setTextColor(panelGrey(static_cast<uint8_t>(150+lift*85)));
      sceneGfx.setCursor(x0+static_cast<int16_t>(i*charW),cy);sceneGfx.write(label[i]);
    }
    return;
  }
  labelCanvas->fillScreen(panelGrey(0));
  labelCanvas->setTextSize(2);
  for (size_t i = 0; i < len; ++i) {
    const float d = fabsf((float)i - head);
    const float lift = d > 2.6f ? 0.0f : (1.0f - d / 2.6f);
    const uint8_t grey = (uint8_t)(150 + lift * 85);
    labelCanvas->setTextColor(panelGrey(grey));
    labelCanvas->setCursor((x0 - stripX) + (int16_t)(i * charW), 4);
    labelCanvas->write(label[i]);
  }

  // Blit the sub-rectangle the text actually occupies. GFXcanvas16 has no stride-aware push, so the
  // rows are sent one at a time; that is still one transaction per row against 240 px of untouched
  // background per frame.
  Adafruit_ILI9341& g = displayPanel();
  const uint16_t* buf = labelCanvas->getBuffer();
  g.startWrite();
  g.setAddrWindow(stripX, cy - 4, stripW, kLabelH);
  for (int16_t row = 0; row < kLabelH; ++row) {
    pushRow(g, buf + (size_t)row * 240, stripW);
  }
  g.endWrite();
}

// ---------------------------------------------------------------------------------------------
// Soft shapes
// ---------------------------------------------------------------------------------------------

namespace {

// The panel's own frame at rotation 0, and — not incidentally — the capacity of `dmaRow`. Every
// clip below is taken against THIS, the buffer actually being written, rather than against the
// dimensions of the shape being asked for.
constexpr int16_t kPanelW = 240;
constexpr int16_t kPanelH = 320;

inline float clamp01(float v) { return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v); }

// One coverage step. The ground under everything this draws is flat, so a blend is a lerp and
// there is nothing to read back off the panel.
inline float over(float base, float ink, float cov) { return base + (ink - base) * cov; }

// Signed distance to a rounded box centred on the origin. Negative inside. The square-root is only
// reached in the four corner quadrants; the straight bands resolve without one, which is what keeps
// a 240 px wide tray affordable once a frame.
inline float roundBoxSdf(float px, float py, float halfW, float halfH, float r) {
  const float qx = fabsf(px) - (halfW - r);
  const float qy = fabsf(py) - (halfH - r);
  if (qx > 0.0f && qy > 0.0f) return sqrtf(qx * qx + qy * qy) - r;
  const float outer = qx > qy ? qx : qy;
  return (outer < 0.0f ? outer : 0.0f) + (qx > 0.0f ? qx : (qy > 0.0f ? qy : 0.0f)) - r;
}

// Blends `ink` over `base` by coverage, one channel at a time.
//
// The greyscale renderer blends a single number, which is why it is cheap. Colour cannot be faked
// with a single number — a violet over black is not "a grey between black and violet" — so this
// does the same lerp three times. It is only ever used for the small shapes that carry the
// accent, which is why the greyscale path was left alone.
inline uint16_t blendRgb(uint16_t base, uint16_t ink, float cov) {
  const int br = (base >> 11) & 0x1F;
  const int bg = (base >> 5) & 0x3F;
  const int bb = base & 0x1F;
  const int ir = (ink >> 11) & 0x1F;
  const int ig = (ink >> 5) & 0x3F;
  const int ib = ink & 0x1F;
  const float v = (float)br + ((float)ir - (float)br) * cov;
  const float g = (float)bg + ((float)ig - (float)bg) * cov;
  const float b = (float)bb + ((float)ib - (float)bb) * cov;
  const int r = (int)(v + 0.5f);
  const int gg = (int)(g + 0.5f);
  const int bbb = (int)(b + 0.5f);
  return (uint16_t)(((r & 0x1F) << 11) | ((gg & 0x3F) << 5) | (bbb & 0x1F));
}

}  // namespace

// The rounded rectangle, restricted to the rows in [bandTop, bandBottom).
//
// The shape is still evaluated in its own full coordinates — the corner arc is the arc the whole
// rectangle would have had — so a caller can draw one end of a very tall panel without the curve
// changing to suit the stub it asked for. displaySoftPanel() is the reason this exists.
void displaySoftRoundRectBand(int16_t x, int16_t y, int16_t w, int16_t h, float radius,
                              uint8_t bgGrey, int16_t fillGrey, int16_t strokeGrey,
                              float strokeWidth, float feather, int16_t bandTop,
                              int16_t bandBottom) {
  if (!displayReady() || !dmaRow || w <= 0 || h <= 0) return;

  // A STROKE STRADDLES THE BOUNDARY, so the box it is rasterised over has to be bigger than the
  // shape.
  //
  // The stroke is centred on the outline: half of it lies inside the rectangle and half outside.
  // Rasterising over the rectangle alone therefore threw the outer half away — measured at 32% of
  // the total stroke coverage for a 104x36 capsule. It is not lost evenly, which is what made it a
  // visible defect rather than merely a thin line: a corner ARC curves back inside the box and
  // keeps most of its width, while a straight top or bottom edge lies exactly on the box boundary
  // and loses its entire outer half. The result is bright corner arcs meeting dim straight edges —
  // an outline that looks shattered, corners not joining the edges.
  //
  // A FILLED shape has no such problem: its coverage outside the boundary is already zero, so
  // clipping to the box loses nothing. That is why the filled TALK button rendered cleanly and the
  // outlined ACTIONS button beside it did not, and why this pad is conditional on the stroke.
  const float padF = (strokeGrey >= 0 && strokeWidth > 0.0f)
    ? (strokeWidth * 0.5f + (feather < 0.35f ? 0.35f : feather))
    : 0.0f;
  const int16_t pad = (int16_t)ceilf(padF);

  int16_t x0 = (int16_t)(x - pad), y0 = (int16_t)(y - pad);
  int16_t x1 = (int16_t)(x + w + pad), y1 = (int16_t)(y + h + pad);
  // The band still wins. displaySoftPanel() splits a tall panel into rounded caps and a flat middle
  // and relies on the caps staying inside their own bands; it draws fill-only shapes, so the pad is
  // zero there, but the clamp order is what guarantees that.
  if (y0 < bandTop) y0 = bandTop;
  if (y1 > bandBottom) y1 = bandBottom;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > kPanelW) x1 = kPanelW;
  if (y1 > kPanelH) y1 = kPanelH;
  clipSceneBand(y0,y1);
  if (x1 <= x0 || y1 <= y0) return;
  const int16_t vw = (int16_t)(x1 - x0);

  const float cx = x + w * 0.5f;
  const float cy = y + h * 0.5f;
  const float halfW = w * 0.5f;
  const float halfH = h * 0.5f;
  float r = radius;
  const float rMax = halfW < halfH ? halfW : halfH;
  if (r > rMax) r = rMax;
  if (r < 0.0f) r = 0.0f;

  const float f = feather < 0.35f ? 0.35f : feather;
  const float halfStroke = strokeWidth * 0.5f;
  const float base = (float)bgGrey;
  const float fill = fillGrey >= 0 ? (float)fillGrey : base;
  const bool wantFill = fillGrey >= 0;
  const bool wantStroke = strokeGrey >= 0 && strokeWidth > 0.0f;
  const float stroke = wantStroke ? (float)strokeGrey : base;

  beginRaster(x0,y0,vw,static_cast<int16_t>(y1-y0));
  for (int16_t py = y0; py < y1; ++py) {
    const float fy = (py + 0.5f) - cy;
    for (int16_t col = 0; col < vw; ++col) {
      const float fx = (x0 + col + 0.5f) - cx;
      const float d = roundBoxSdf(fx, fy, halfW, halfH, r);
      float v = base;
      if (wantFill) v = over(v, fill, clamp01(0.5f - d / f));
      if (wantStroke) v = over(v, stroke, clamp01((halfStroke - fabsf(d)) / f + 0.5f));
      dmaRow[col] = panelGrey((uint8_t)(v + 0.5f));
    }
    publishRasterRow(x0,py,vw);
  }
  endRaster();
}

void displaySoftRoundRect(int16_t x, int16_t y, int16_t w, int16_t h, float radius,
                          uint8_t bgGrey, int16_t fillGrey, int16_t strokeGrey,
                          float strokeWidth, float feather) {
  displaySoftRoundRectBand(x, y, w, h, radius, bgGrey, fillGrey, strokeGrey, strokeWidth, feather,
                           0, kPanelH);
}

// The colour renderer.
//
// The same distance field as the greyscale one, but the ground, the fill and the stroke are
// RGB565 colours and the blend happens per channel. It is a separate function rather than a
// parameterised one because the greyscale path is the hot one: three channel blends per pixel is
// a cost the whole UI should not pay for the sake of one accent.
void displaySoftRoundRectRgb(int16_t x, int16_t y, int16_t w, int16_t h, float radius,
                             uint16_t bgRgb, int32_t fillRgb, int32_t strokeRgb,
                             float strokeWidth, float feather) {
  if (!displayReady() || !dmaRow || w <= 0 || h <= 0) return;

  // A stroke straddles the boundary, exactly as in the greyscale renderer: the pad below is what
  // keeps the outer half of the outline.
  const float padF = (strokeRgb >= 0 && strokeWidth > 0.0f)
    ? (strokeWidth * 0.5f + (feather < 0.35f ? 0.35f : feather))
    : 0.0f;
  const int16_t pad = (int16_t)ceilf(padF);

  int16_t x0 = (int16_t)(x - pad), y0 = (int16_t)(y - pad);
  int16_t x1 = (int16_t)(x + w + pad), y1 = (int16_t)(y + h + pad);
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > kPanelW) x1 = kPanelW;
  if (y1 > kPanelH) y1 = kPanelH;
  clipSceneBand(y0,y1);
  if (x1 <= x0 || y1 <= y0) return;
  const int16_t vw = (int16_t)(x1 - x0);

  const float cx = x + w * 0.5f;
  const float cy = y + h * 0.5f;
  const float halfW = w * 0.5f;
  const float halfH = h * 0.5f;
  float r = radius;
  const float rMax = halfW < halfH ? halfW : halfH;
  if (r > rMax) r = rMax;
  if (r < 0.0f) r = 0.0f;

  const float f = feather < 0.35f ? 0.35f : feather;
  const float halfStroke = strokeWidth * 0.5f;
  const bool wantFill = fillRgb >= 0;
  const bool wantStroke = strokeRgb >= 0 && strokeWidth > 0.0f;

  beginRaster(x0,y0,vw,static_cast<int16_t>(y1-y0));
  for (int16_t py = y0; py < y1; ++py) {
    const float fy = (py + 0.5f) - cy;
    for (int16_t col = 0; col < vw; ++col) {
      const float fx = (x0 + col + 0.5f) - cx;
      const float d = roundBoxSdf(fx, fy, halfW, halfH, r);
      uint16_t v = bgRgb;
      if (wantFill) v = blendRgb(v, (uint16_t)fillRgb, clamp01(0.5f - d / f));
      if (wantStroke) v = blendRgb(v, (uint16_t)strokeRgb, clamp01((halfStroke - fabsf(d)) / f + 0.5f));
      dmaRow[col] = panelRgb(v);
    }
    publishRasterRow(x0,py,vw);
  }
  endRaster();
}

void displaySoftSegment(float x0f, float y0f, float x1f, float y1f, float thickness,
                        uint8_t bgGrey, uint8_t inkGrey, float feather) {
  if (!displayReady() || !dmaRow || thickness <= 0.0f) return;

  const float pad = thickness * 0.5f + feather + 1.0f;
  int16_t x0 = (int16_t)floorf((x0f < x1f ? x0f : x1f) - pad);
  int16_t x1 = (int16_t)ceilf((x0f > x1f ? x0f : x1f) + pad);
  int16_t y0 = (int16_t)floorf((y0f < y1f ? y0f : y1f) - pad);
  int16_t y1 = (int16_t)ceilf((y0f > y1f ? y0f : y1f) + pad);
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > kPanelW) x1 = kPanelW;
  if (y1 > kPanelH) y1 = kPanelH;
  clipSceneBand(y0,y1);
  if (x1 <= x0 || y1 <= y0) return;
  const int16_t vw = (int16_t)(x1 - x0);

  const float ex = x1f - x0f, ey = y1f - y0f;
  const float lenSq = ex * ex + ey * ey;
  const float invLenSq = lenSq > 0.0001f ? 1.0f / lenSq : 0.0f;
  const float f = feather < 0.35f ? 0.35f : feather;
  const float half = thickness * 0.5f;
  const float base = (float)bgGrey;
  const float ink = (float)inkGrey;

  beginRaster(x0,y0,vw,static_cast<int16_t>(y1-y0));
  for (int16_t py = y0; py < y1; ++py) {
    const float fy = py + 0.5f;
    for (int16_t col = 0; col < vw; ++col) {
      const float fx = x0 + col + 0.5f;
      float t = ((fx - x0f) * ex + (fy - y0f) * ey) * invLenSq;
      t = clamp01(t);
      const float dx = fx - (x0f + ex * t);
      const float dy = fy - (y0f + ey * t);
      const float d = sqrtf(dx * dx + dy * dy) - half;
      dmaRow[col] = panelGrey((uint8_t)(over(base, ink, clamp01(0.5f - d / f)) + 0.5f));
    }
    publishRasterRow(x0,py,vw);
  }
  endRaster();
}

void displaySoftArcDivider(int16_t x, int16_t y, int16_t w, float sag, float thickness,
                           uint8_t bgGrey, uint8_t inkGrey) {
  if (!displayReady() || !dmaRow || w <= 1) return;

  // A parabola, not a sine. At this sag the two are indistinguishable and this one costs two
  // multiplies per column instead of a transcendental per pixel — which matters because the
  // separator between two list rows is drawn once per visible row, per repaint.
  const float bandTop = y - thickness;
  const float bandBottom = y + sag + thickness + 1.0f;
  int16_t x0 = x, x1 = (int16_t)(x + w);
  int16_t y0 = (int16_t)floorf(bandTop), y1 = (int16_t)ceilf(bandBottom);
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > kPanelW) x1 = kPanelW;
  if (y1 > kPanelH) y1 = kPanelH;
  clipSceneBand(y0,y1);
  if (x1 <= x0 || y1 <= y0) return;
  const int16_t vw = (int16_t)(x1 - x0);

  const float invSpan = 1.0f / (float)(w - 1);
  const float half = thickness * 0.5f;
  const float base = (float)bgGrey;
  const float ink = (float)inkGrey;
  // Both ends fade out over a fifth of the width. A separator that runs into the bezel is a rule;
  // one that dissolves before it gets there is a curve that knows where it stops.
  constexpr float kFade = 0.22f;

  beginRaster(x0,y0,vw,static_cast<int16_t>(y1-y0));
  for (int16_t py = y0; py < y1; ++py) {
    const float fy = py + 0.5f;
    for (int16_t col = 0; col < vw; ++col) {
      const float t = clamp01((float)(x0 + col - x) * invSpan);
      const float curve = y + sag * 4.0f * t * (1.0f - t);
      float edge = 1.0f;
      if (t < kFade) edge = t / kFade;
      else if (t > 1.0f - kFade) edge = (1.0f - t) / kFade;
      edge = edge * edge * (3.0f - 2.0f * edge);
      const float cov = clamp01(half - fabsf(fy - curve) + 0.5f) * edge;
      dmaRow[col] = panelGrey((uint8_t)(over(base, ink, cov) + 0.5f));
    }
    publishRasterRow(x0,py,vw);
  }
  endRaster();
}

void displaySoftPanel(int16_t x, int16_t y, int16_t w, int16_t h, float radius, uint8_t bgGrey,
                      uint8_t fillGrey, bool roundTop, bool roundBottom) {
  if (!displayReady() || w <= 0 || h <= 0) return;

  // The cap is the band a corner of this radius can reach into, plus a row for the feathered edge.
  int16_t cap = (int16_t)(radius + 1.5f);
  if (cap < 0) cap = 0;
  if (cap * 2 > h) cap = (int16_t)(h / 2);

  const int16_t topCap = roundTop ? cap : 0;
  const int16_t bottomCap = roundBottom ? cap : 0;
  const int16_t middle = (int16_t)(h - topCap - bottomCap);

  // Each cap is drawn as the full rounded rectangle clipped to its own band, so the corner arc is
  // the same curve the one-shot version would have produced rather than an arc fitted to a stub.
  if (topCap > 0) {
    displaySoftRoundRectBand(x, y, w, h, radius, bgGrey, (int16_t)fillGrey, -1, 0.0f, 1.4f,
                             y, (int16_t)(y + topCap));
  }
  if (middle > 0) {
    displayRenderGfx().fillRect(x < 0 ? 0 : x, (int16_t)(y + topCap),
                            (int16_t)(x < 0 ? w + x : w), middle, panelGrey(fillGrey));
  }
  if (bottomCap > 0) {
    displaySoftRoundRectBand(x, y, w, h, radius, bgGrey, (int16_t)fillGrey, -1, 0.0f, 1.4f,
                             (int16_t)(y + h - bottomCap), (int16_t)(y + h));
  }
}
