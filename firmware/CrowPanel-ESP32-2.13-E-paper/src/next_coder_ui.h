#pragma once

#include <Arduino.h>

// The CrowPanel is a 250 x 122 monochrome terminal, not a miniature web app.
// This renderer owns the stable screen grammar used by every firmware state:
//
//   0..43 compact left control rail: MENU at top, rotary/OK in the middle, BACK at bottom
//   47..249 content: header, three-row list or two-line detail, and compact context footer
//
// The content pane is structured like the console: a hairline-separated header
// band carrying the state marker, the display title, and the position marker;
// a body of hairline-separated rows whose selected row is an inverted block;
// and a compact context footer below the last rule.
//
// Keeping this contract in one module prevents network and lifecycle screens
// from quietly inventing different button meanings or painting past the glass.
namespace ncuri {

enum class Icon : uint8_t {
  Agent,
  Home,
  Action,
  Thread,
  Gateway,
  Firmware,
  Status,
  Stop,
  Warning,
  Success,
  Error,
};

struct Row {
  String label;
  String meta;
  Icon icon = Icon::Action;
  bool selected = false;
  bool disabled = false;
};

struct Frame {
  String title;
  String state;
  // The compact position marker for a paged screen, such as "2/7". It is the
  // header's right-hand marker; an empty marker leaves that slot blank.
  String position;
  Icon icon = Icon::Agent;

  // Detail mode uses prompt-like prefixes to evoke a compact hacker terminal.
  String line1;
  String line2;

  // List mode renders at most three rows. The caller pages larger lists and
  // supplies a compact position marker such as "2/7" in position.
  bool listMode = false;
  // Summary mode fills Home with three non-interactive facts. It reuses Row so
  // status always keeps an icon, label, and optional text marker.
  bool summaryMode = false;
  // Text-page mode renders three gateway-wrapped response lines without list
  // chrome. The controller receives only the current bounded page.
  bool textPageMode = false;
  Row rows[3];
  size_t rowCount = 0;
  String textLines[3];
  size_t textLineCount = 0;
  String footerLabel;

  // These labels sit beside the physical MENU and EXIT controls. The center rail deliberately
  // shows only the universal OK label; contextual action verbs belong in the content pane.
  String menuLabel = "MENU";
  String backLabel = "BACK";
};

// Bounds a gateway-owned label to the panel's printable ASCII vocabulary and
// fixed-width line capacity. Raw prompts, commands, URLs, and secrets never
// belong in Frame rows.
String safeLabel(const String& value, size_t maxChars);

#if ENABLE_EINK
void render(const Frame& frame);
#endif

}  // namespace ncuri
