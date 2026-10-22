#pragma once

// ILI9341V panel adapter for the Hosyond ES3C28P.
//
// The panel has no reset GPIO — its reset is tied to the ESP32-S3's CHIP_PU rail, so the only way
// to reset the panel is to reset the chip. Adafruit_ILI9341 accepts -1 for that.
//
// The SPI pins are not the ESP32-S3 defaults, so the bus is remapped with SPI.begin() before the
// panel is initialised.

#include <Arduino.h>
#include <Adafruit_ILI9341.h>

#include <Adafruit_GFX.h>
#include <ThinkingOrb.h>

// Panel output polarity.
//
// This glass renders what we send inverted: a 0x0000 fill comes out white. Both invertDisplay(true)
// and invertDisplay(false) were flashed and photographed, and the screen was identical white both
// times — the ILI9341's INVON/INVOFF simply does not control this panel's polarity, whatever the
// vendor's own init sequence does with 0x21 alongside their own gamma and power registers.
//
// So the correction happens here, where the bytes are ours and the result is deterministic. Every
// colour written to the panel goes through panelRgb()/panelGrey(). Flip this to 0 for a panel that
// behaves normally; it is one constant rather than a hunt through the drawing code.
#ifndef PANEL_OUTPUT_INVERTED
#define PANEL_OUTPUT_INVERTED 1
#endif

// Applies the panel's polarity to a finished RGB565 value.
inline uint16_t panelRgb(uint16_t rgb565) {
#if PANEL_OUTPUT_INVERTED
  return (uint16_t)~rgb565;
#else
  return rgb565;
#endif
}

// Greyscale convenience: 0 is ink-black on screen, 255 is white on screen, whatever the panel does.
inline uint16_t panelGrey(uint8_t g) {
  const uint16_t c = (uint16_t)(((g & 0xF8) << 8) | ((g & 0xFC) << 3) | (g >> 3));
  return panelRgb(c);
}

// The same grey ramp, expressed as a LOGICAL RGB565 colour — the colour the eye receives, before
// the panel's polarity is applied.
//
// Everything that blends has to blend in the colour the viewer sees: a shape composited against
// a grey ground and then inverted is not the shape that was computed. This is the grey ramp in
// that space, so a greyscale ground and a coloured shape can be mixed without either of them
// knowing about the other's world.
inline uint16_t greyRgb(uint8_t g) {
  return (uint16_t)(((g & 0xF8) << 8) | ((g & 0xFC) << 3) | (g >> 3));
}

// The design system is two tone: a black ground, white ink, and greys for hierarchy. The device
// follows the same rule as the console, so the ONE thing on the screen that matters is the
// brightest ink rather than a colour.
//
// 0xFFFF is white in RGB565. Text drawn on an accent-filled shape is cut out in the ground colour,
// so a filled accent shape reads as a white pill with black type — the console's primary call to
// action, on glass.
constexpr uint16_t kAccentRgb = 0xFFFF;

// The accent as bytes for the panel.
inline uint16_t panelAccent() { return panelRgb(kAccentRgb); }

bool displayBegin();

// Allocates the off-screen canvases the orb and label composite into. Must be called after
// displayBegin() and before either draw function.
//
// `miniSize` allocates a second, smaller coverage buffer. It exists because the list screens have
// no room for the 148 px orb but still have to show that the agent is doing something: a screen
// where the only moving thing stops moving reads as a hang, and the hang it looks like is the one
// the device is most likely to actually have. Pass 0 to skip it.
bool displayBeginCanvases(uint16_t orbSize, uint16_t miniSize = 0);

// Paints one orb frame centred at (cx, cy). Dots are drawn far-to-near as the renderer ordered
// them, so overlap reads as depth.
//
// The orb's own diameter() decides the box; it must not exceed the size the matching canvas was
// allocated with, so the two calls take separate ThinkingOrb instances rather than one resized
// between screens (resizing reallocates and rebuilds the geometry, which is not a per-frame cost
// anyone should pay).
// `drawDiameter` is the disc actually pushed to the panel, centred in the coverage buffer. Pass 0
// for the whole buffer. It exists because the buffer is allocated once at boot from main.cpp while
// the size the orb should occupy is a composition decision that belongs to the screen — HOME wants
// a smaller orb than a full-page voice moment does, and reallocating the buffer to switch between
// them would rebuild the geometry every time somebody changed screen.
void displayDrawOrb(ThinkingOrb& orb, int16_t cx, int16_t cy, uint32_t elapsedMs,
                    uint16_t drawDiameter = 0);
void displayDrawMiniOrb(ThinkingOrb& orb, int16_t cx, int16_t cy, uint32_t elapsedMs);

// The status line under the orb, with the shimmer sweep the web component uses. `phase` advances
// the highlight; pass the same elapsedMs as the orb.
// Only the rectangle the current text occupies is repainted, so switching to a SHORTER label must
// be preceded by displayClearStatus() — otherwise the wider previous word leaves its ends on the
// glass ("Connecting" showing around "Weaving").
void displayDrawStatus(const char* label, int16_t cy, uint32_t elapsedMs);
void displayClearStatus(int16_t cy);
void displayBacklight(bool on);
Adafruit_ILI9341& displayPanel();

// True once displayBegin() has run successfully. Everything that draws checks this, so a board
// with ENABLE_LCD 0 or a failed init degrades to serial-only rather than crashing.
bool displayReady();

// ---------------------------------------------------------------------------------------------
// Soft shapes
// ---------------------------------------------------------------------------------------------
//
// The orb is an anti-aliased point cloud. Everything that used to be drawn beside it was
// fillRect corners and 1 px hairlines, which is a different product sharing one piece of glass.
// These composite a signed-distance field straight onto the panel through the same DMA staging
// row the orb blit uses: no second buffer, coverage blended against a known flat ground, and a
// `feather` that can be wider than one pixel where an edge should read as soft rather than merely
// un-jagged.
//
// Greys are 0..255 BEFORE panelGrey(), matching the rest of this adapter. `fillGrey` and
// `strokeGrey` accept -1 for "none", which is how a stroke-only capsule or a plain fill is asked
// for without two functions.
//
// Everything here clips to the panel. The staging row holds exactly one panel width, so a shape
// that starts left of the origin or runs past the right edge is trimmed against THAT row's
// capacity rather than the shape's own.

// A rounded rectangle. `radius >= min(w, h) / 2` is a capsule; `radius == 0` is a rectangle with
// anti-aliased edges, which is still not the same thing as fillRect and is not what this is for.
void displaySoftRoundRect(int16_t x, int16_t y, int16_t w, int16_t h, float radius,
                          uint8_t bgGrey, int16_t fillGrey, int16_t strokeGrey,
                          float strokeWidth = 1.4f, float feather = 1.0f);

// The same shape in colour.
//
// The greyscale renderer above is the workhorse and is left exactly as it was: it is on the hot
// path, and three channel blends per pixel is a cost the whole UI should not pay for the sake of
// one accent. This is the colour variant, for the handful of shapes that carry the accent — the
// call to action, the selected marker, the live dot — where the colour IS the message.
//
// `bgRgb` is the ground the shape composites against, in logical RGB565. `fillRgb` and
// `strokeRgb` are logical RGB565 colours, or -1 for "none".
void displaySoftRoundRectRgb(int16_t x, int16_t y, int16_t w, int16_t h, float radius,
                             uint16_t bgRgb, int32_t fillRgb, int32_t strokeRgb,
                             float strokeWidth = 1.4f, float feather = 1.0f);

// A capsule-ended line at any angle: chevrons, back arrows, the marker beside a selected row.
void displaySoftSegment(float x0, float y0, float x1, float y1, float thickness,
                        uint8_t bgGrey, uint8_t inkGrey, float feather = 1.0f);

// The replacement for drawFastHLine. A shallow parabolic sag with both ends faded out, so a list
// separator is a curve that stops rather than a rule that hits the bezel.
void displaySoftArcDivider(int16_t x, int16_t y, int16_t w, float sag, float thickness,
                           uint8_t bgGrey, uint8_t inkGrey);

// A large flat surface with rounded ends: the status drawer and the action tray.
//
// displaySoftRoundRect() evaluates a distance field for every pixel it covers, which is right for a
// button and wrong for a panel — a full-page drawer is 63 000 pixels and only the ~26 rows at each
// rounded end have any curvature in them. This splits the shape: the caps go through the field, the
// middle goes through the panel's own accelerated fill. Same picture, a fraction of the arithmetic.
//
// `roundTop` / `roundBottom` say which ends are actually on screen. A tray that slides up from
// below the bezel has no bottom corners to draw.
void displaySoftPanel(int16_t x, int16_t y, int16_t w, int16_t h, float radius, uint8_t bgGrey,
                      uint8_t fillGrey, bool roundTop, bool roundBottom);
