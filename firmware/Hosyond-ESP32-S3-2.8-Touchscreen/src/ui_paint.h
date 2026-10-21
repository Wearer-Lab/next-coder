#pragma once

// The drawing vocabulary the screens are built from, with no screen state in it.
//
// Split out of ui.cpp when the UI stopped being rectangles. The reason for the split is not line
// count: these are the only functions in the firmware that decide what the product LOOKS like, and
// having them in one file with no `screen` variable in sight is what stops a shape being tuned for
// one screen and diverging on the next.
//
// Everything here resolves through display.cpp's soft-shape primitives, which composite an
// anti-aliased distance field rather than filling a rectangle. There is deliberately no wrapper for
// fillRect or drawFastHLine: clearing a band is still a rectangle because it is invisible, but
// nothing a person can see is drawn with a hard corner or a one-pixel rule.

#include <Arduino.h>

namespace uip {

constexpr int16_t kW = 240;
constexpr int16_t kH = 320;

// Greys, before panelGrey(). The two surface tones are new: a card that is a slightly lifted
// ground rather than an outlined box is what lets a list stop needing separators between every
// row.
constexpr uint8_t kBg = 0;          // #000, the ground the orb sits on
constexpr uint8_t kSurface = 20;    // a card, barely lifted off the ground
constexpr uint8_t kSurfaceHi = 38;  // the lifted card: the drawer, the action tray
constexpr uint8_t kHair = 54;       // curved separators, disabled ink
constexpr uint8_t kMuted = 132;     // secondary text
constexpr uint8_t kText = 205;      // primary text
constexpr uint8_t kBright = 255;    // the one thing on the screen that matters

// 6 px per character at text size 1, 12 px at size 2. Everything that truncates counts characters,
// not pixels, because the font is fixed-width and counting pixels twice invites them to disagree.
constexpr size_t kCols1 = 38;
constexpr size_t kCols2 = 19;

// THE ACCENT.
//
// The console's palette carries one chromatic signal — a violet, #b7a8ff — and spends it on the
// things that are true rather than on decoration: live, selected, act now. This panel is a
// monochrome screen on a black canvas, which is the same ground the console and the marketing
// pages are drawn on, so the same discipline applies here.
//
// There is no second colour. Anything violet on the glass means one of three things: this is
// live, this is selected, or this is the thing to press. Everything else is the grey ramp above.
//
// The colour itself lives in display.h, next to the panel's polarity, because that is where a
// colour has to be correct to be written at all.

struct Rect {
  int16_t x, y, w, h;
};

bool hit(const Rect& r, int16_t x, int16_t y);

// ---------------------------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------------------------
//
// Nothing in this UI moves linearly. A panel that arrives at constant speed and stops dead reads
// as a redraw; the same distance over the same time with a decelerating tail reads as a thing that
// came to rest.

float easeOutCubic(float t);
float easeInOutCubic(float t);

// Advances `value` towards `target` at a rate of one full traversal per `durationMs`, given a frame
// of `frameMs`. Returns the new value; compare it with the old one to know whether to keep
// painting.
float approach(float value, float target, uint32_t frameMs, uint32_t durationMs);

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

String fit(const String& value, size_t cols);

// Truncation for anything a person reads as language: a thread title, a summary, a folder name.
//
// fit() cuts at the column and appends a tilde, which is right for an id and wrong for a sentence —
// on glass it produced `Open this project and report tha"`, half a word plus whatever punctuation
// the cut happened to land on. This backs up to a word boundary, drops the trailing punctuation the
// break exposed, and ends in three dots, which the 5x7 font actually has (U+2026 is not in it).
//
// A single token longer than the budget is still hard-cut: backing up would leave nothing.
String fitWords(const String& value, size_t cols);
void text(int16_t x, int16_t y, uint8_t size, uint8_t grey, const String& value);
void textCentered(int16_t y, uint8_t size, uint8_t grey, const String& value);
void textCenteredIn(const Rect& r, int16_t y, uint8_t size, uint8_t grey, const String& value);
void textRight(int16_t right, int16_t y, uint8_t size, uint8_t grey, const String& value);

// The accent, as ink. The only coloured text on the panel, and it says the same thing everywhere:
// this is the live thing, the selected thing, or the thing to press.
void textAccent(int16_t x, int16_t y, uint8_t size, const String& value);
void textRightAccent(int16_t right, int16_t y, uint8_t size, const String& value);

// Word wrap into a caller-owned array. Returns the number of lines written. A word longer than the
// column count is broken rather than allowed to run off the edge — a URL or a file path is exactly
// the kind of unbroken token an assistant reply is full of.
size_t wrapText(const String& value, size_t cols, String* out, size_t maxLines);

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

// A rounded surface. `fill` and `stroke` take -1 for "none".
// `bg` is the ground the shape is composited against. It is a parameter and not a constant
// because these nest: a marker inside a card, a chevron inside the drawer, a button inside the
// action tray. Compositing an anti-aliased edge against the wrong ground draws a dark halo around
// it, which is the one artefact that makes soft edges look worse than hard ones.
void card(const Rect& r, float radius, int16_t fill, int16_t stroke, float strokeWidth = 1.3f,
          float feather = 1.2f, uint8_t bg = kBg);

// A card whose corners are its own half-height: the shape every button, pill and badge in this UI
// is, so that nothing on the glass has a corner tighter than the orb's own curvature.
void capsule(const Rect& r, int16_t fill, int16_t stroke, float strokeWidth = 1.3f,
             float feather = 1.2f, uint8_t bg = kBg);

// A button. Primary is filled and reads as the thing to press; secondary is an outline. Disabled is
// neither — it is drawn, because a control that vanishes when it cannot be used is a control nobody
// learns exists.
void button(const Rect& r, const String& label, bool primary, bool enabled, uint8_t bg = kBg);

// The separator between two list rows. Curved, faded at both ends, and never touching the bezel.
void divider(int16_t x, int16_t y, int16_t w, uint8_t grey = kHair, uint8_t bg = kBg);

void dot(int16_t cx, int16_t cy, float radius, uint8_t grey, uint8_t bg = kBg);

// A chevron built from two soft segments. `dir` is -1 left, 1 right, 2 down, -2 up.
void chevron(int16_t cx, int16_t cy, float size, int8_t dir, uint8_t grey, float thickness = 2.0f,
             uint8_t bg = kBg);

// The marker beside the selected row of a list is the ACCENT one, below: a selected row is a
// statement about right now, and right now is what the accent is for.

// ---------------------------------------------------------------------------------------------
// The accent
// ---------------------------------------------------------------------------------------------
//
// The same three states the console gives the accent, in the shapes this panel already has. A
// filled accent shape is an action; an outlined one is a live state; a small accent mark is a
// selection. Nothing else on the glass is ever violet.

// A filled accent pill. The design's call to action, in the product's colour.
void accentCapsule(const Rect& r, uint8_t bg = kBg);

// An accent outline with nothing behind it: a control or a state that is marked, not pressed.
void accentOutline(const Rect& r, float strokeWidth = 1.6f, uint8_t bg = kBg);

// The accent marker beside the selected row of a list.
void accentMarker(int16_t x, int16_t y, int16_t h, uint8_t bg = kBg);

// A small accent dot: the live/attention mark beside a status row.
void accentDot(int16_t cx, int16_t cy, float radius, uint8_t bg = kBg);

// A small accent square: the device's pixel glyph, used as a metric marker.
void accentPixel(int16_t x, int16_t y, int16_t size, uint8_t bg = kBg);

// The greyscale twin of accentPixel(), for the markers that are not saying anything.
void pixel(int16_t x, int16_t y, int16_t size, uint8_t grey, uint8_t bg = kBg);

// ---------------------------------------------------------------------------------------------
// The metric rhythm
// ---------------------------------------------------------------------------------------------
//
// The console shows a strip of metrics where each one is a marker glyph, a tabular value and a
// faint caption. A 240 px screen has room for that rhythm rather than a table, so the same
// three-part shape is what the device's summary rows are built from.

// A metric line: a marker glyph, a large value, and a faint caption beside it. The value is the
// answer and the caption only names it, which is the order the console's stat strip reads in.
void statLine(int16_t x, int16_t y, const String& value, const String& caption, uint8_t valueTone);

// A fact row: the same rhythm at size 1, because a device id is thirty characters long and will
// not survive being doubled. The caption sits under the value, indented to it.
void factRow(int16_t x, int16_t y, const String& value, const String& caption, uint8_t valueTone,
             bool accent);

}  // namespace uip
