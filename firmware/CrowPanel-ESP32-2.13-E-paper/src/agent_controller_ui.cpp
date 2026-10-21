#if defined(CONTROLLER_CONFIG_PLACEHOLDER_BUILD)
#include "controller_config.example.h"
#elif __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

#include "agent_controller_ui.h"

#if ENABLE_EINK
#include "EPD.h"
#include "EPD_Init.h"
#include <cstring>

namespace acui {
namespace {

extern "C" uint8_t ImageBW[ALLSCREEN_BYTES];

// The panel shows 250 x 122 of paper; the driver's rows 122..127 stay blank.
// The screen keeps one coordinate contract: a left control rail (0..43) and a
// content pane (47..247) split by a single hairline.
constexpr uint16_t kCanvasWidth = 250;
constexpr uint16_t kCanvasHeight = 122;
constexpr uint16_t kControlRailRight = 43;
constexpr uint16_t kContentLeft = 47;
constexpr uint16_t kContentRight = 247;

// The header is one hairline-separated band holding two rows: a small mono
// eyebrow (state on the left, position marker on the right) and the display
// title. The body below it holds three list rows or two detail lines.
constexpr uint16_t kEyebrowY = 1;
constexpr uint16_t kTitleY = 14;
constexpr uint16_t kHeaderRuleY = 30;
constexpr uint16_t kBodyTop = 31;
constexpr uint16_t kRowPitch = 23;
constexpr uint16_t kRowInset = 5;
constexpr uint16_t kContextRuleY = 102;
constexpr uint16_t kContextTextY = 106;

// The columns of a list row: the cursor marker, the 12 x 12 capability glyph,
// and the label. The metadata field is right-aligned against the content edge.
constexpr uint16_t kRowCursorX = 48;
constexpr uint16_t kRowGlyphX = 59;
constexpr uint16_t kRowLabelX = 77;

// The panel ships two bitmap faces and no others: 6 x 12 mono for labels and
// 8 x 16 for the display headline. Nothing new is embedded.
constexpr uint8_t kFontSmall = 12;
constexpr uint8_t kFontBody = 16;
constexpr uint8_t kSmallCharWidth = 6;
constexpr uint8_t kBodyCharWidth = 8;

// EPD_DrawPoint's color convention is inverted in the vendor driver when the
// landscape transform is active. WHITE clears a framebuffer bit and therefore
// paints visible black ink on the physical panel; BLACK sets it and leaves
// bare paper.
void ink(uint16_t x, uint16_t y) {
  if (x < kCanvasWidth && y < kCanvasHeight) EPD_DrawPoint(x, y, WHITE);
}

void paper(uint16_t x, uint16_t y) {
  if (x < kCanvasWidth && y < kCanvasHeight) EPD_DrawPoint(x, y, BLACK);
}

void inkLine(uint16_t x0, uint16_t y0, uint16_t x1, uint16_t y1) {
  if (x0 == x1) {
    for (uint16_t y = y0; y <= y1 && y < kCanvasHeight; y += 1) ink(x0, y);
    return;
  }
  if (y0 == y1) {
    for (uint16_t x = x0; x <= x1 && x < kCanvasWidth; x += 1) ink(x, y0);
    return;
  }
  EPD_DrawLine(x0, y0, x1, y1, WHITE);
}

// A filled band. Used for the selected row only: a 1-bit panel cannot dim a
// label, so the active row earns the design's inverted pill by laying ink
// down and printing its label back out in paper.
void inkFill(uint16_t x0, uint16_t y0, uint16_t x1, uint16_t y1) {
  for (uint16_t y = y0; y <= y1 && y < kCanvasHeight; y += 1) inkLine(x0, y, x1, y);
}

// Original Agent Controller glyph set. Each icon is a purpose-built 12 x 12
// monochrome bitmap: no vendor/product artwork or external assets are copied.
constexpr uint8_t kIconAgent[] = {
  0x3f,0xc0, 0x40,0x20, 0x9f,0x10, 0xa0,0x50,
  0xa4,0x50, 0xa0,0x50, 0x91,0x10, 0x8e,0x10,
  0x80,0x10, 0x5f,0x20, 0x20,0x40, 0x1f,0x80,
};
constexpr uint8_t kIconHome[] = {
  0x06,0x00, 0x0f,0x00, 0x19,0x80, 0x30,0xc0,
  0x60,0x60, 0xc0,0x30, 0x9f,0x90, 0x90,0x90,
  0x90,0x90, 0x97,0x90, 0x94,0x90, 0xff,0xf0,
};
constexpr uint8_t kIconAction[] = {
  0x00,0x00, 0x30,0x00, 0x18,0x00, 0x0c,0x00,
  0xfe,0x00, 0x03,0x00, 0x01,0x80, 0x03,0x00,
  0x06,0x00, 0x0c,0x00, 0x18,0x00, 0x00,0x00,
};
constexpr uint8_t kIconThread[] = {
  0x00,0x00, 0x70,0x00, 0x88,0x00, 0x88,0x00,
  0x70,0x00, 0x20,0x00, 0x20,0x00, 0x27,0x00,
  0x28,0x80, 0x28,0x80, 0x27,0x00, 0x00,0x00,
};
constexpr uint8_t kIconGateway[] = {
  0x00,0x00, 0x10,0x00, 0x38,0x00, 0x54,0x00,
  0x92,0x00, 0x10,0x00, 0x7c,0x00, 0x10,0x00,
  0x10,0x00, 0x38,0x00, 0x44,0x00, 0x82,0x00,
};
constexpr uint8_t kIconFirmware[] = {
  0x0f,0x00, 0x10,0x80, 0x20,0x40, 0x44,0x20,
  0x44,0x20, 0x7f,0xe0, 0x04,0x00, 0x04,0x00,
  0x15,0x00, 0x0e,0x00, 0x04,0x00, 0x00,0x00,
};
constexpr uint8_t kIconStatus[] = {
  0x00,0x00, 0x00,0x00, 0x81,0x00, 0x82,0x00,
  0x44,0x00, 0x28,0x00, 0x10,0x00, 0x28,0x00,
  0x44,0x00, 0x82,0x00, 0x81,0x00, 0x00,0x00,
};
constexpr uint8_t kIconStop[] = {
  0x1f,0x80, 0x20,0x40, 0x40,0x20, 0x8f,0x10,
  0x9f,0x90, 0x9f,0x90, 0x9f,0x90, 0x9f,0x90,
  0x8f,0x10, 0x40,0x20, 0x20,0x40, 0x1f,0x80,
};
constexpr uint8_t kIconWarning[] = {
  0x06,0x00, 0x06,0x00, 0x0f,0x00, 0x09,0x00,
  0x19,0x80, 0x31,0xc0, 0x21,0x40, 0x61,0x60,
  0xc0,0x30, 0xc1,0x30, 0x7f,0xe0, 0x00,0x00,
};
constexpr uint8_t kIconSuccess[] = {
  0x00,0x00, 0x00,0x10, 0x00,0x30, 0x00,0x60,
  0x80,0xc0, 0xc1,0x80, 0x63,0x00, 0x36,0x00,
  0x1c,0x00, 0x08,0x00, 0x00,0x00, 0x00,0x00,
};
constexpr uint8_t kIconError[] = {
  0x00,0x00, 0x80,0x10, 0x40,0x20, 0x20,0x40,
  0x10,0x80, 0x09,0x00, 0x09,0x00, 0x10,0x80,
  0x20,0x40, 0x40,0x20, 0x80,0x10, 0x00,0x00,
};

const uint8_t* bitmapFor(Icon icon) {
  switch (icon) {
    case Icon::Home: return kIconHome;
    case Icon::Action: return kIconAction;
    case Icon::Thread: return kIconThread;
    case Icon::Gateway: return kIconGateway;
    case Icon::Firmware: return kIconFirmware;
    case Icon::Status: return kIconStatus;
    case Icon::Stop: return kIconStop;
    case Icon::Warning: return kIconWarning;
    case Icon::Success: return kIconSuccess;
    case Icon::Error: return kIconError;
    default: return kIconAgent;
  }
}

// The inverted form paints only the glyph, because the ink field behind it is
// already laid down: the glyph reads as paper inside a black block.
void drawIcon(uint16_t x, uint16_t y, Icon icon, bool inverted = false) {
  const uint8_t* bitmap = bitmapFor(icon);
  for (uint8_t row = 0; row < 12; row += 1) {
    const uint16_t bits = static_cast<uint16_t>(bitmap[row * 2]) << 8 | bitmap[row * 2 + 1];
    for (uint8_t col = 0; col < 12; col += 1) {
      if ((bits & (0x8000 >> col)) == 0) continue;
      if (inverted) {
        paper(x + col, y + row);
      } else {
        ink(x + col, y + row);
      }
    }
  }
}

// The driver paints every pixel of a glyph cell, so paper text is the exact
// inverse of ink text and needs the ink field behind it.
void text(uint16_t x, uint16_t y, const String& value, uint8_t size, bool inverted = false) {
  EPD_ShowString(x, y, value.c_str(), inverted ? WHITE : BLACK, size);
}

String upperState(const String& input) {
  String state = safeLabel(input, 12);
  state.toUpperCase();
  if (state.length() == 0) state = "IDLE";
  return state;
}

// The title is the screen's display headline, so it wears the larger face and
// one case, the way the console's display titles do.
String upperTitle(const String& input, size_t maxChars) {
  String title = safeLabel(input, maxChars);
  title.toUpperCase();
  return title;
}

void renderHeader(const Frame& frame) {
  // Eyebrow row: the state word on the left, the position marker on the right.
  // Both are small mono, the way the design sets its status labels.
  const String state = upperState(frame.state);
  text(kContentLeft, kEyebrowY, state, kFontSmall);

  const String position = safeLabel(frame.position, 8);
  if (position.length() > 0) {
    const uint16_t width = position.length() * kSmallCharWidth;
    text(kContentRight - width - 1, kEyebrowY, position, kFontSmall);
  }

  // Title row: the status glyph keeps the header's left cell, and the
  // headline takes the rest of the band.
  const uint16_t titleX = kContentLeft + 17;
  const size_t titleChars = (kContentRight - titleX) / kBodyCharWidth;
  drawIcon(kContentLeft + 2, kTitleY + 2, frame.icon);
  text(titleX, kTitleY, upperTitle(frame.title, titleChars), kFontBody);

  inkLine(kContentLeft, kHeaderRuleY, kContentRight, kHeaderRuleY);
}

uint16_t centeredRailTextX(const String& value) {
  const uint16_t width = value.length() * kSmallCharWidth;
  return width < kControlRailRight ? (kControlRailRight - width) / 2 : 2;
}

void renderControlRail(const Frame& frame) {
  // In the installed orientation the bezel controls are stacked immediately to the left:
  // MENU at the top, the three rotary switches at center, and EXIT at the bottom.
  // Keeping the labels at those same heights lets the display teach the hardware without a legend.
  inkLine(kControlRailRight, 2, kControlRailRight, 119);
  // Two short hairlines give the rail the same structure as the content pane:
  // MENU above, the rotary cluster in the middle, BACK below.
  inkLine(6, 26, 37, 26);
  inkLine(6, 96, 37, 96);

  const String menu = safeLabel(frame.menuLabel, 6);
  const String back = safeLabel(frame.backLabel, 6);
  text(centeredRailTextX(menu), 5, menu, kFontSmall);

  text(centeredRailTextX("^"), 36, "^", kFontSmall);
  text(centeredRailTextX("OK"), 57, "OK", kFontSmall);
  text(centeredRailTextX("v"), 78, "v", kFontSmall);

  text(centeredRailTextX(back), 106, back, kFontSmall);
}

// List rows and the Home summary share one grid: cursor column, glyph, label,
// right-aligned metadata. A hairline separates consecutive rows.
void renderRows(const Frame& frame, bool interactive) {
  for (size_t i = 0; i < frame.rowCount && i < 3; i += 1) {
    const Row& row = frame.rows[i];
    const uint16_t top = kBodyTop + i * kRowPitch;
    const uint16_t rowTextY = top + kRowInset;
    const bool selected = interactive && row.selected;

    // The active row is the device's inverted pill: an ink block whose label
    // is printed back out in paper.
    if (selected) inkFill(kContentLeft, top + 1, kContentRight, top + 20);

    // A disabled row keeps its marker in the cursor column, printed in the
    // row's own polarity so it survives the inversion.
    if (row.disabled) text(kRowCursorX, rowTextY, "x", kFontSmall, selected);

    drawIcon(kRowGlyphX, rowTextY, row.icon, selected);

    const String meta = safeLabel(row.meta, 8);
    const uint16_t metaWidth = meta.length() * kSmallCharWidth;
    const uint16_t metaX = meta.length() > 0 ? kContentRight - metaWidth - 1 : kContentRight + 1;
    if (meta.length() > 0) text(metaX, rowTextY, meta, kFontSmall, selected);

    const size_t labelChars = metaX > kRowLabelX + 4 ? (metaX - kRowLabelX - 4) / kSmallCharWidth : 8;
    text(kRowLabelX, rowTextY, safeLabel(row.label, labelChars), kFontSmall, selected);

    if (i + 1 < frame.rowCount) inkLine(kContentLeft, top + 22, kContentRight, top + 22);
  }
}

void renderDetail(const Frame& frame) {
  // A terminal prompt is decoration with meaning: '$' is gateway/system output,
  // while '>' is the currently relevant next fact. It remains ASCII-only.
  text(kContentLeft + 1, 36, "$", kFontBody);
  text(kContentLeft + 15, 36, safeLabel(frame.line1, 22), kFontBody);
  text(kContentLeft + 1, 66, ">", kFontBody);
  text(kContentLeft + 15, 66, safeLabel(frame.line2, 22), kFontBody);
  inkLine(kContentLeft + 1, 88, kContentLeft + 14, 88);
  inkLine(kContentLeft + 1, 91, kContentLeft + 8, 91);
}

void renderTextPage(const Frame& frame) {
  constexpr uint16_t kLineY[3] = {34, 58, 82};
  for (size_t index = 0; index < frame.textLineCount && index < 3; index += 1) {
    text(kContentLeft + 1, kLineY[index], safeLabel(frame.textLines[index], 31), kFontSmall);
  }
}

void renderContextFooter(const Frame& frame) {
  inkLine(kContentLeft, kContextRuleY, kContentRight, kContextRuleY);
  if (frame.footerLabel.length() > 0) {
    text(kContentLeft + 1, kContextTextY, safeLabel(frame.footerLabel, 32), kFontSmall);
  } else if (frame.listMode) {
    text(kContentLeft + 1, kContextTextY, "ROTATE:MOVE", kFontSmall);
  } else if (frame.summaryMode) {
    text(kContentLeft + 1, kContextTextY, "OK:STATUS MENU:ACTIONS", kFontSmall);
  }
}

}  // namespace

String safeLabel(const String& value, size_t maxChars) {
  String output;
  output.reserve(value.length() < maxChars ? value.length() : maxChars);
  for (size_t i = 0; i < value.length() && output.length() < maxChars; i += 1) {
    const char c = value.charAt(i);
    output += (c >= ' ' && c <= '~') ? c : '?';
  }
  if (value.length() > maxChars && maxChars >= 2) {
    output.remove(maxChars - 1);
    output += '~';
  }
  return output;
}

void render(const Frame& frame) {
  memset(ImageBW, 0xFF, ALLSCREEN_BYTES);
  renderControlRail(frame);
  renderHeader(frame);
  if (frame.listMode) renderRows(frame, true);
  else if (frame.summaryMode) renderRows(frame, false);
  else if (frame.textPageMode) renderTextPage(frame);
  else renderDetail(frame);
  renderContextFooter(frame);
  EPD_DisplayImage(ImageBW);
  EPD_Update();
}

}  // namespace acui
#else
namespace acui {
String safeLabel(const String& value, size_t maxChars) {
  return value.substring(0, value.length() < maxChars ? value.length() : maxChars);
}
}  // namespace acui
#endif
