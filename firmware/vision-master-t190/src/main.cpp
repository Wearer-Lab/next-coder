// Heltec Vision Master T190 board adapter.
//
// Account, policy, routing, credentials, claim state, and T3 state stay in the cloud gateway. This
// file owns only the T190 display and its optional external encoder. The network conversation is
// the shared NextCoderCore implementation used by the other controller boards.

#include <Arduino.h>
#include <SPI.h>
#include <WiFi.h>

#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>

#include <DeviceStore.h>
#include <GatewayBrowse.h>
#include <GatewayClient.h>
#include <Provisioning.h>

#if CONTROLLER_CONFIG_PLACEHOLDER_BUILD
#include "controller_config.example.h"
#elif __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

#ifndef HARDWARE_MODEL
#define HARDWARE_MODEL "vision-master-t190"
#endif
#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "0.2.0"
#endif
#ifdef BUILD_FIRMWARE_VERSION
#undef FIRMWARE_VERSION
#define FIRMWARE_VERSION BUILD_FIRMWARE_VERSION
#endif

#ifndef ENABLE_T190_DISPLAY
#define ENABLE_T190_DISPLAY 1
#endif
#ifndef ENABLE_T190_EXTERNAL_ENCODER
#define ENABLE_T190_EXTERNAL_ENCODER 0
#endif
#ifndef T190_EXTERNAL_ENCODER_PINS_VERIFIED
#define T190_EXTERNAL_ENCODER_PINS_VERIFIED 0
#endif

#if ENABLE_T190_EXTERNAL_ENCODER && !T190_EXTERNAL_ENCODER_PINS_VERIFIED
#error "External encoder support requires an explicitly verified T190 pin assignment"
#endif

namespace {

constexpr uint16_t kScreenWidth = 320;
constexpr uint8_t kVisibleRows = 4;
constexpr uint32_t kButtonHoldMs = 1500;
constexpr uint32_t kRecoveryHoldMs = 10000;

// The "intelligence design" palette, in the RGB565 words the ST7789 speaks. A black ground,
// white ink, one lilac accent, and muted greys that carry every other distinction.
//
// The accent is the ONLY chromatic signal on the screen. It marks the live target, the active
// row and the cursor, exactly the way the console's accent marks its live pill. Everything that
// used to be a vendor colour - cyan titles, yellow state, blue rules, green body - collapses into
// ink or grey, so the lilac is always the thing the eye lands on. Failures keep a semantic red:
// a monochrome screen must never hide an error.
constexpr uint16_t kInk = ST77XX_WHITE;   // #ffffff, the console's --ac-ink
constexpr uint16_t kAccent = 0xB55F;      // #b7a8ff, the console's --ac-accent
constexpr uint16_t kMuted = 0x9CD3;       // #9b9b9e, the console's --ac-ink-muted
constexpr uint16_t kFaint = 0x6B4D;       // #6b6b6f, the console's --ac-ink-faint
constexpr uint16_t kDanger = 0xE30D;      // #e2616e, the console's --ac-danger

// The one word a list screen uses for the bound environment, folder or thread.
constexpr const char* kActiveLabel = "ACTIVE";

DeviceStore store;
Provisioning provisioning;
GatewayClient gateway;
GatewayBrowse browse;

#if ENABLE_T190_DISPLAY
Adafruit_ST7789 tft(DISPLAY_CS, DISPLAY_DC, DISPLAY_RST);
#endif

enum class Screen : uint8_t {
  Home,
  Menu,
  Environments,
  Projects,
  Threads,
  Controls,
  Approvals,
  ApprovalDecision,
  Response,
  ConfirmAction,
  ConfirmReset,
  Result,
};

enum class ButtonEvent : uint8_t { None, Tap, Hold };

Screen screen = Screen::Home;
ProvisioningState provisioningState = ProvisioningState::Unprovisioned;
size_t cursor = 0;
size_t selectedApproval = 0;
size_t selectedControl = 0;
String resultTitle;
String resultLine1;
String resultLine2;
bool resultIsError = false;
bool dirty = true;
uint32_t seenGatewayRevision = 0;
uint32_t seenBrowseRevision = 0;
bool contextSyncPending = false;
uint32_t contextSyncAfterRevision = 0;
uint32_t contextSyncRequestedAt = 0;

#if ENABLE_T190_EXTERNAL_ENCODER
uint8_t encoderHistory = 0;
int8_t encoderAccumulator = 0;
bool rawButtonDown = false;
bool stableButtonDown = false;
bool holdReported = false;
bool recoveryReported = false;
uint32_t rawButtonChangedAt = 0;
uint32_t buttonDownAt = 0;
#endif

String clipped(const String& input, size_t limit) {
  if (input.length() <= limit) return input;
  if (limit < 2) return input.substring(0, limit);
  return input.substring(0, limit - 1) + "~";
}

String upper(String value) {
  value.toUpperCase();
  return value;
}

String shortId(const String& value) {
  if (value.length() <= 12) return value;
  return String("~") + value.substring(value.length() - 11);
}

const char* screenName(Screen value) {
  switch (value) {
    case Screen::Menu: return "NAVIGATE";
    case Screen::Environments: return "ENVIRONMENTS";
    case Screen::Projects: return "FOLDERS";
    case Screen::Threads: return "THREADS";
    case Screen::Controls: return "ACTIONS";
    case Screen::Approvals: return "APPROVALS";
    case Screen::ApprovalDecision: return "DECISION";
    case Screen::Response: return "LATEST RESPONSE";
    case Screen::ConfirmAction: return "CONFIRM ACTION";
    case Screen::ConfirmReset: return "RESET NETWORK";
    case Screen::Result: return "RESULT";
    default: return "NEXT CODER";
  }
}

void beginDisplay() {
#if ENABLE_T190_DISPLAY
  pinMode(DISPLAY_POWER, OUTPUT);
  digitalWrite(DISPLAY_POWER, LOW);  // active-low on the published T190 schematic
  pinMode(DISPLAY_BL, OUTPUT);
  digitalWrite(DISPLAY_BL, HIGH);
  SPI.begin(DISPLAY_SCL, -1, DISPLAY_SDA, DISPLAY_CS);
  tft.init(170, 320);
  tft.setRotation(1);
  tft.setTextWrap(false);
  tft.fillScreen(ST77XX_BLACK);
#endif
}

void drawHeader(const String& title, const String& state, uint16_t stateColor = kMuted) {
#if ENABLE_T190_DISPLAY
  tft.fillScreen(ST77XX_BLACK);
  // The title is the display headline: bright ink, not a vendor colour.
  tft.setTextColor(kInk);
  tft.setTextSize(1);
  tft.setCursor(8, 7);
  tft.print(clipped(title, 31));
  // The state marker on the right is a quiet label. It only turns accent when the screen is
  // reporting something live, and red when it is reporting a failure.
  tft.setTextColor(stateColor);
  tft.setCursor(248, 7);
  tft.print(clipped(state, 10));
  tft.drawFastHLine(8, 21, kScreenWidth - 16, kFaint);
#else
  (void)title;
  (void)state;
  (void)stateColor;
#endif
}

void drawLine(uint16_t y, const String& value, uint16_t color = kInk,
              uint8_t textSize = 1) {
#if ENABLE_T190_DISPLAY
  tft.setTextColor(color);
  tft.setTextSize(textSize);
  tft.setCursor(10, y);
  tft.print(clipped(value, textSize > 1 ? 25 : 49));
#else
  (void)y;
  (void)value;
  (void)color;
  (void)textSize;
#endif
}

void drawFooter(const String& value) {
#if ENABLE_T190_DISPLAY
  // The footer rule is a hairline, not a band, and the footer line is a quiet hint.
  tft.drawFastHLine(8, 149, kScreenWidth - 16, kFaint);
  drawLine(156, value, kMuted);
#else
  (void)value;
#endif
}

using RowText = String (*)(size_t);

void drawRows(size_t count, RowText label, RowText metadata) {
  if (count == 0) return;
  const size_t pageStart = (cursor / kVisibleRows) * kVisibleRows;
  for (size_t row = 0; row < kVisibleRows && pageStart + row < count; row += 1) {
    const size_t index = pageStart + row;
    const uint16_t y = 31 + static_cast<uint16_t>(row * 28);
    // The cursor row is the accent. It is the only place on a list screen that says "you are here".
    drawLine(y, String(index == cursor ? "> " : "  ") + clipped(label(index), 30),
             index == cursor ? kAccent : kInk);
#if ENABLE_T190_DISPLAY
    const String meta = clipped(metadata(index), 10);
    // The bound environment/folder/thread is the live target, so it keeps the accent even when
    // the cursor sits on another row. Every other metadata value is a quiet label.
    const bool active = meta == kActiveLabel;
    tft.setTextColor(index == cursor || active ? kAccent : kMuted);
    tft.setCursor(252, y);
    tft.print(meta);
#endif
  }
}

void renderProvisioning() {
  const ProvisioningStatus& status = provisioning.status();
  // The marker stays quiet while the device is merely waiting, turns accent while it is doing
  // something, and keeps a semantic red when the join has failed.
  uint16_t stateColor = kMuted;
  if (status.state == ProvisioningState::Provisioning
      || status.state == ProvisioningState::Connecting) stateColor = kAccent;
  if (status.state == ProvisioningState::Failed) stateColor = kDanger;
  drawHeader("DEVICE SETUP", upper(String(provisioningStateName(status.state))), stateColor);
  if (status.state == ProvisioningState::Provisioning) {
    drawLine(36, "JOIN WI-FI:", kAccent);
    drawLine(55, status.apName, kInk, 2);
    drawLine(87, status.portalUrl, kInk);
    drawLine(108, clipped(status.detail, 48), kMuted);
  } else if (status.state == ProvisioningState::Connecting) {
    drawLine(46, "Joining saved Wi-Fi", kInk, 2);
    drawLine(83, status.detail, kMuted);
  } else {
    drawLine(46, "Wi-Fi unavailable", kDanger, 2);
    drawLine(83, status.detail, kMuted);
    drawLine(105, "Setup portal will reopen", kMuted);
  }
  drawFooter("Credentials never leave this device");
}

void renderGatewayBoundary() {
  switch (gateway.link()) {
    case GatewayLink::NoIdentity:
      drawHeader("DEVICE IDENTITY", "BLOCKED");
      drawLine(42, "FACTORY ID REQUIRED", kDanger, 2);
      drawLine(79, "Flash an NVS factory seed.", kMuted);
      drawLine(99, "Owner setup cannot create identity.", kMuted);
      drawFooter("Service required");
      return;
    case GatewayLink::Unclaimed:
      drawHeader("CLAIM THIS DEVICE", "UNCLAIMED");
      drawLine(34, "Sign in, then enter:", kMuted);
      // The claim code is the one live thing on this screen.
      drawLine(57, gateway.claimCode().length() ? gateway.claimCode() : String("REQUESTING CODE"),
               kAccent, 2);
      drawLine(92, "Device: " + shortId(store.deviceId()), kMuted);
      drawLine(111, "Gateway remains account authority.", kMuted);
      drawFooter("Code is cached; it does not rotate");
      return;
    case GatewayLink::Revoked:
      drawHeader("ACCESS REMOVED", "REVOKED");
      drawLine(42, "Credential rejected", kDanger, 2);
#if ENABLE_T190_EXTERNAL_ENCODER
      drawLine(82, "Hold the external button 10s", kMuted);
      drawLine(101, "to reset network setup.", kMuted);
#else
      drawLine(82, "External recovery input disabled.", kMuted);
      drawLine(101, "Use the service/flash path.", kMuted);
#endif
      drawFooter("Identity is never erased locally");
      return;
    default:
      return;
  }
}

void renderHome() {
  const bool live = gateway.link() == GatewayLink::Claimed;
  drawHeader(gateway.display().title.length() ? gateway.display().title : String("Next Coder"),
             live ? upper(gateway.display().state) : String("OFFLINE"),
             live ? kAccent : kMuted);
  drawLine(31, "ENV  " + clipped(browse.environmentLabel().length()
    ? browse.environmentLabel() : shortId(gateway.context().environmentId), 36));
  drawLine(53, "DIR  " + clipped(browse.projectLabel().length()
    ? browse.projectLabel() : String("Not loaded"), 36));
  // The selected task is the live target of the controller.
  drawLine(75, "TASK " + clipped(gateway.selectedThreadLabel(), 36), kAccent);
  drawLine(99, clipped(gateway.display().line1, 48));
  drawLine(119, contextSyncPending ? String("Refreshing authoritative target...")
                                    : clipped(gateway.display().line2, 48), kMuted);
#if ENABLE_T190_EXTERNAL_ENCODER
  drawFooter(live ? "PRESS: MENU  HOLD 10S: RECOVERY" : "Cached state - PRESS for menu");
#else
  drawFooter(live ? "STATUS-ONLY BUILD - INPUT DISABLED" : "Cached state - input disabled");
#endif
}

String menuLabel(size_t index) {
  static const char* labels[] = {
    "Environments", "Folders", "Threads", "Actions", "Approvals", "Latest response", "Back"
  };
  return index < 7 ? String(labels[index]) : String();
}

String menuMeta(size_t index) {
  switch (index) {
    case 0: return String(gateway.display().counts.environments);
    case 2: return String(gateway.threadCount());
    case 3: return String(gateway.controlCount());
    case 4: return String(gateway.approvalCount());
    default: return String();
  }
}

void renderMenu() {
  drawHeader(screenName(screen), String(cursor + 1) + "/7");
  drawRows(7, menuLabel, menuMeta);
  drawFooter("ROTATE: MOVE  PRESS: OPEN");
}

String environmentLabel(size_t index) {
  if (index == browse.environmentCount()) return "Back";
  const BrowseEnvironment* row = browse.environment(index);
  return row ? row->label : String();
}

String environmentMeta(size_t index) {
  const BrowseEnvironment* row = browse.environment(index);
  if (!row) return String();
  return row->selected ? String("ACTIVE") : clipped(row->status, 10);
}

void renderEnvironments() {
  const size_t rows = browse.environmentCount() + 1;
  drawHeader(screenName(screen), String(cursor + 1) + "/" + rows);
  drawRows(rows, environmentLabel, environmentMeta);
  if (browse.environmentsDetail().length()) drawFooter(browse.environmentsDetail());
  else {
    const BrowseEnvironment* row = browse.environment(cursor);
    drawFooter(row ? browseEnvironmentAction(*row) : String("PRESS: BACK"));
  }
}

String projectLabel(size_t index) {
  if (index == browse.projectCount()) return "Back";
  const BrowseProject* row = browse.project(index);
  return row ? row->title : String();
}

String projectMeta(size_t index) {
  const BrowseProject* row = browse.project(index);
  if (!row) return String();
  return row->selected ? String("ACTIVE") : String(row->threadCount);
}

void renderProjects() {
  const size_t rows = browse.projectCount() + 1;
  drawHeader(screenName(screen), String(cursor + 1) + "/" + rows);
  drawRows(rows, projectLabel, projectMeta);
  drawFooter(browse.projectsDetail().length() ? browse.projectsDetail() : String("PRESS: SELECT"));
}

String threadLabel(size_t index) {
  if (index == gateway.threadCount()) return "New thread";
  if (index == gateway.threadCount() + 1) return "Back";
  const ThreadOption* row = gateway.thread(index);
  return row ? row->title : String();
}

String threadMeta(size_t index) {
  const ThreadOption* row = gateway.thread(index);
  if (!row) return index == gateway.threadCount() ? String("CREATE") : String();
  return row->selected ? String("ACTIVE") : clipped(row->status, 10);
}

void renderThreads() {
  const size_t rows = gateway.threadCount() + 2;
  drawHeader(screenName(screen), String(cursor + 1) + "/" + rows);
  drawRows(rows, threadLabel, threadMeta);
  drawFooter(gateway.threadsDetail().length() ? gateway.threadsDetail() : String("PRESS: SELECT"));
}

String controlLabel(size_t index) {
  if (index == gateway.controlCount()) return "Back";
  const DeviceControl* row = gateway.control(index);
  return row ? row->label : String();
}

String controlMeta(size_t index) {
  const DeviceControl* row = gateway.control(index);
  if (!row) return String();
  if (contextSyncPending) return "WAIT";
  if (!row->enabled) return "BLOCKED";
  if (row->requiresConfirmation || row->kind == "stop" || row->kind == "reset") return "HOLD";
  return "RUN";
}

void renderControls() {
  const size_t rows = gateway.controlCount() + 1;
  drawHeader(screenName(screen), String(cursor + 1) + "/" + rows);
  drawRows(rows, controlLabel, controlMeta);
  const DeviceControl* row = gateway.control(cursor);
  if (contextSyncPending) drawFooter("WAIT FOR AUTHORITATIVE CONFIG");
  else drawFooter(row && !row->enabled ? row->reason : String("PRESS: REVIEW/RUN"));
}

String approvalLabel(size_t index) {
  if (index == gateway.approvalCount()) return "Back";
  const PendingApproval* row = gateway.approval(index);
  return row ? row->summary : String();
}

String approvalMeta(size_t index) {
  const PendingApproval* row = gateway.approval(index);
  return row ? upper(row->risk) : String();
}

void renderApprovals() {
  const size_t rows = gateway.approvalCount() + 1;
  drawHeader(screenName(screen), String(cursor + 1) + "/" + rows);
  drawRows(rows, approvalLabel, approvalMeta);
  drawFooter(gateway.approvalOverflow() ? "More approvals in console" : "PRESS: REVIEW");
}

void renderApprovalDecision() {
  const PendingApproval* approval = gateway.approval(selectedApproval);
  drawHeader(screenName(screen), approval ? upper(approval->risk) : String("STALE"));
  drawLine(31, approval ? clipped(approval->summary, 48) : String("Request no longer pending"));
  static const char* labels[] = {"Approve", "Deny", "Keep pending"};
  for (size_t index = 0; index < 3; index += 1) {
    drawLine(65 + index * 24, String(index == cursor ? "> " : "  ") + labels[index],
             index == cursor ? kAccent : kInk);
  }
  drawFooter(cursor == 0 && approval && approval->risk == "high"
    ? "HOLD: APPROVE HIGH RISK" : "PRESS: CHOOSE");
}

void renderResponse() {
  const ThreadResponse& response = gateway.response();
  drawHeader(screenName(screen), upper(response.state));
  for (size_t index = 0; index < response.lineCount; index += 1) {
    drawLine(35 + index * 25, response.lines[index], index == 0 ? kAccent : kInk);
  }
  drawLine(119, "Page " + String(response.page + 1) + "/" + String(response.pageCount), kMuted);
  drawFooter("ROTATE: PAGE  PRESS: BACK");
}

void renderConfirm() {
  drawHeader(screenName(screen), "HOLD");
  if (screen == Screen::ConfirmReset) {
    drawLine(37, "Erase Wi-Fi and cached setup?", kAccent, 2);
    drawLine(84, "Identity remains on this device.", kMuted);
  } else {
    const DeviceControl* row = gateway.control(selectedControl);
    drawLine(37, row ? clipped(row->label, 25) : String("Action is stale"), kAccent, 2);
    drawLine(84, row && row->requiresThread ? gateway.selectedThreadLabel()
                                             : String("Gateway policy still applies"), kMuted);
  }
  drawLine(113, "HOLD 1.5S TO CONFIRM", kMuted);
  drawFooter("TAP: CANCEL");
}

void renderResult() {
  drawHeader(resultTitle.length() ? resultTitle : String("RESULT"), "STATUS");
  // The emphasis line is the accent, except when the gateway refused the work: a failure keeps
  // the semantic red so the monochrome treatment cannot make it read as ordinary.
  drawLine(40, clipped(resultLine1, 25), resultIsError ? kDanger : kAccent, 2);
  drawLine(82, clipped(resultLine2, 48), kMuted);
  drawLine(107, "Remote work continues unless stopped.", kMuted);
  drawFooter("PRESS: HOME");
}

void render() {
  if (provisioningState != ProvisioningState::Online) {
    renderProvisioning();
    dirty = false;
    return;
  }
  if (gateway.link() == GatewayLink::NoIdentity || gateway.link() == GatewayLink::Unclaimed
      || gateway.link() == GatewayLink::Revoked) {
    renderGatewayBoundary();
    dirty = false;
    return;
  }
  switch (screen) {
    case Screen::Menu: renderMenu(); break;
    case Screen::Environments: renderEnvironments(); break;
    case Screen::Projects: renderProjects(); break;
    case Screen::Threads: renderThreads(); break;
    case Screen::Controls: renderControls(); break;
    case Screen::Approvals: renderApprovals(); break;
    case Screen::ApprovalDecision: renderApprovalDecision(); break;
    case Screen::Response: renderResponse(); break;
    case Screen::ConfirmAction:
    case Screen::ConfirmReset: renderConfirm(); break;
    case Screen::Result: renderResult(); break;
    default: renderHome(); break;
  }
  dirty = false;
}

void showPending(const String& title, const String& detail) {
  resultTitle = title;
  resultLine1 = "CONTACTING GATEWAY";
  resultLine2 = detail;
  resultIsError = false;
  screen = Screen::Result;
  dirty = true;
  render();
}

// `isError` is a colour decision, not a behaviour one: it only tells the renderer that this
// particular outcome is a failure and must keep the semantic red.
void showResult(const String& title, const String& line1, const String& line2,
                bool isError = false) {
  resultTitle = title;
  resultLine1 = line1;
  resultLine2 = line2;
  resultIsError = isError;
  screen = Screen::Result;
  dirty = true;
}

void showDispatchResult(const DispatchResult& result) {
  if (!result.accepted) {
    showResult("ACTION FAILED", result.httpStatus == 404 ? String("STALE / UNAVAILABLE")
                                                         : String("NOT ACCEPTED"), result.detail,
               true);
    return;
  }
  const String state = result.status.length() ? upper(result.status) : String("ACCEPTED");
  showResult("ACTION", state, result.detail.length() ? result.detail : String("Gateway accepted request"));
  if (result.responseAfter.length()) gateway.openResponse(result.responseAfter);
}

void moveCursor(int delta, size_t count) {
  if (count == 0 || delta == 0) return;
  if (delta > 0) cursor = (cursor + 1) % count;
  else cursor = cursor == 0 ? count - 1 : cursor - 1;
  dirty = true;
}

size_t rowCountForScreen() {
  switch (screen) {
    case Screen::Menu: return 7;
    case Screen::Environments: return browse.environmentCount() + 1;
    case Screen::Projects: return browse.projectCount() + 1;
    case Screen::Threads: return gateway.threadCount() + 2;
    case Screen::Controls: return gateway.controlCount() + 1;
    case Screen::Approvals: return gateway.approvalCount() + 1;
    case Screen::ApprovalDecision: return 3;
    default: return 0;
  }
}

void openEnvironments() {
  showPending("ENVIRONMENTS", "Loading compact health");
  browse.refreshEnvironments();
  cursor = browse.selectedEnvironmentIndex() >= 0
    ? static_cast<size_t>(browse.selectedEnvironmentIndex()) : 0;
  screen = Screen::Environments;
  dirty = true;
}

void openProjects() {
  showPending("FOLDERS", "Loading selected environment");
  browse.refreshProjects();
  cursor = browse.selectedProjectIndex() >= 0 ? static_cast<size_t>(browse.selectedProjectIndex()) : 0;
  screen = Screen::Projects;
  dirty = true;
}

void openThreads() {
  showPending("THREADS", "Loading compact task list");
  gateway.refreshThreads();
  cursor = gateway.selectedThreadIndex() >= 0 ? static_cast<size_t>(gateway.selectedThreadIndex()) : 0;
  screen = Screen::Threads;
  dirty = true;
}

void executeControl(size_t index) {
  if (contextSyncPending) {
    showResult("ACTION", "WAIT FOR CONFIG", "Gateway target is still refreshing");
    return;
  }
  const DeviceControl* row = gateway.control(index);
  if (!row) { showResult("ACTION", "STALE", "Refresh the action list"); return; }
  if (!row->enabled) { showResult("ACTION BLOCKED", "NOT AVAILABLE", row->reason); return; }
  if (row->kind == "capture_audio" || row->kind == "capture_image" || row->mediaKind.length()) {
    showResult("NO CAPTURE", "HARDWARE DISABLED", "Use the web console on this T190 build");
    return;
  }
  if (row->kind == "reset") { screen = Screen::ConfirmReset; dirty = true; return; }
  if (row->requiresConfirmation || row->kind == "stop") {
    selectedControl = index;
    screen = Screen::ConfirmAction;
    dirty = true;
    return;
  }
  const DeviceControl copy = *row;
  showPending("ACTION", copy.label);
  showDispatchResult(gateway.runControl(copy));
}

void handleTap() {
  if (provisioningState != ProvisioningState::Online || gateway.link() == GatewayLink::Unclaimed) return;
  if (screen == Screen::Home || screen == Screen::Result) {
    screen = screen == Screen::Home ? Screen::Menu : Screen::Home;
    cursor = 0;
    dirty = true;
    return;
  }
  if (screen == Screen::ConfirmAction || screen == Screen::ConfirmReset) {
    screen = Screen::Controls;
    cursor = selectedControl;
    dirty = true;
    return;
  }
  if (screen == Screen::Response) {
    gateway.closeResponse();
    screen = Screen::Menu;
    cursor = 5;
    dirty = true;
    return;
  }
  if (screen == Screen::Menu) {
    switch (cursor) {
      case 0: openEnvironments(); return;
      case 1: openProjects(); return;
      case 2: openThreads(); return;
      case 3: screen = Screen::Controls; cursor = 0; dirty = true; return;
      case 4: screen = Screen::Approvals; cursor = 0; dirty = true; return;
      case 5:
        gateway.openResponse(String());
        gateway.fetchResponsePage(0);
        screen = Screen::Response;
        cursor = 0;
        dirty = true;
        return;
      default: screen = Screen::Home; cursor = 0; dirty = true; return;
    }
  }
  if (screen == Screen::Environments) {
    if (cursor >= browse.environmentCount()) { screen = Screen::Menu; cursor = 0; dirty = true; return; }
    const BrowseEnvironment* target = browse.environment(cursor);
    const bool changesContext = target && (!target->selected || target->id != browse.boundEnvironmentId());
    showPending("ENVIRONMENT", "Changing target clears folder/task");
    if (browse.selectEnvironment(cursor)) {
      if (changesContext) {
        contextSyncPending = true;
        contextSyncAfterRevision = gateway.revision();
        contextSyncRequestedAt = millis();
        gateway.notifyJustConnected();
      }
      showResult("ENVIRONMENT", "SELECTED", "Choose a folder and thread next");
    } else showResult("ENVIRONMENT", "NOT CHANGED", browse.environmentsDetail());
    return;
  }
  if (screen == Screen::Projects) {
    if (cursor >= browse.projectCount()) { screen = Screen::Menu; cursor = 1; dirty = true; return; }
    const BrowseProject* target = browse.project(cursor);
    const bool changesContext = target && (!target->selected || target->id != browse.boundProjectId());
    showPending("FOLDER", "Changing task scope");
    if (browse.selectProject(cursor)) {
      if (changesContext) {
        contextSyncPending = true;
        contextSyncAfterRevision = gateway.revision();
        contextSyncRequestedAt = millis();
        gateway.notifyJustConnected();
      }
      showResult("FOLDER", "SELECTED", "Choose or create a thread next");
    } else showResult("FOLDER", "NOT CHANGED", browse.projectsDetail());
    return;
  }
  if (screen == Screen::Threads) {
    if (cursor == gateway.threadCount() + 1) { screen = Screen::Menu; cursor = 2; dirty = true; return; }
    if (cursor == gateway.threadCount()) {
      showPending("NEW THREAD", "Creating in selected folder");
      if (browse.createThread()) {
        gateway.adoptThreadBinding(browse.createdThread().id);
        showResult("NEW THREAD", "CREATED", browse.createdThread().title);
      } else showResult("NEW THREAD", "NOT CREATED", browse.createDetail());
      return;
    }
    showPending("THREAD", "Switching target only");
    if (gateway.selectThread(cursor)) showResult("THREAD", "SELECTED", gateway.selectedThreadLabel());
    else showResult("THREAD", "NOT CHANGED", gateway.threadsDetail());
    return;
  }
  if (screen == Screen::Controls) {
    if (cursor >= gateway.controlCount()) { screen = Screen::Menu; cursor = 3; dirty = true; return; }
    executeControl(cursor);
    return;
  }
  if (screen == Screen::Approvals) {
    if (cursor >= gateway.approvalCount()) { screen = Screen::Menu; cursor = 4; dirty = true; return; }
    selectedApproval = cursor;
    cursor = 2;
    screen = Screen::ApprovalDecision;
    dirty = true;
    return;
  }
  if (screen == Screen::ApprovalDecision) {
    if (cursor == 2) { screen = Screen::Approvals; cursor = selectedApproval; dirty = true; return; }
    const PendingApproval* row = gateway.approval(selectedApproval);
    if (!row) { showResult("APPROVAL", "STALE", "Refresh the approval list"); return; }
    if (cursor == 0 && row->risk == "high") return;
    const String commandId = row->commandId;
    showPending("APPROVAL", cursor == 0 ? String("Approving") : String("Denying"));
    showDispatchResult(gateway.answerApproval(commandId, cursor == 0));
  }
}

void handleHold() {
  if (screen == Screen::ConfirmReset) {
    provisioning.resetToProvisioning();
    screen = Screen::Home;
    dirty = true;
    return;
  }
  if (screen == Screen::ConfirmAction) {
    const DeviceControl* row = gateway.control(selectedControl);
    if (!row) { showResult("ACTION", "STALE", "Refresh the action list"); return; }
    const DeviceControl copy = *row;
    showPending("ACTION", copy.label);
    showDispatchResult(gateway.runControl(copy));
    return;
  }
  if (screen == Screen::ApprovalDecision && cursor == 0) {
    const PendingApproval* row = gateway.approval(selectedApproval);
    if (!row) { showResult("APPROVAL", "STALE", "Refresh the approval list"); return; }
    const String commandId = row->commandId;
    showPending("APPROVAL", "Approving high risk");
    showDispatchResult(gateway.answerApproval(commandId, true));
  }
}

#if ENABLE_T190_EXTERNAL_ENCODER
int pollEncoder() {
  encoderHistory = static_cast<uint8_t>(((encoderHistory << 2)
    | (digitalRead(ENCODER_PIN_A) ? 2 : 0) | (digitalRead(ENCODER_PIN_B) ? 1 : 0)) & 0x0f);
  static constexpr int8_t transitions[16] = {0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0};
  encoderAccumulator += transitions[encoderHistory];
  if (encoderAccumulator >= 4) { encoderAccumulator = 0; return 1; }
  if (encoderAccumulator <= -4) { encoderAccumulator = 0; return -1; }
  return 0;
}

ButtonEvent pollButton() {
  const bool down = digitalRead(ENCODER_BUTTON_PIN) == LOW;
  if (down != rawButtonDown) {
    rawButtonDown = down;
    rawButtonChangedAt = millis();
  }
  if (down != stableButtonDown && millis() - rawButtonChangedAt >= 30) {
    stableButtonDown = down;
    if (down) {
      buttonDownAt = millis();
      holdReported = false;
      recoveryReported = false;
    } else {
      const bool wasHold = holdReported;
      holdReported = false;
      recoveryReported = false;
      if (!wasHold) return ButtonEvent::Tap;
    }
  }
  if (stableButtonDown && !holdReported && millis() - buttonDownAt >= kButtonHoldMs) {
    holdReported = true;
    return ButtonEvent::Hold;
  }
  return ButtonEvent::None;
}

bool recoveryHoldReached() {
  if (!stableButtonDown || recoveryReported || millis() - buttonDownAt < kRecoveryHoldMs) return false;
  recoveryReported = true;
  return true;
}
#endif

void reportState(ProvisioningState state) {
  const ProvisioningStatus& status = provisioning.status();
  Serial.printf("[provisioning] %s", provisioningStateName(state));
  if (status.detail.length()) Serial.printf(" - %s", status.detail.c_str());
  Serial.println();
}

}  // namespace

void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);
  delay(1000);
  Serial.println();
  Serial.println("=== Next Coder - Vision Master T190 ===");
  Serial.printf("Model: %s  Firmware: %s\n", HARDWARE_MODEL, FIRMWARE_VERSION);

  beginDisplay();
  drawHeader("NEXT CODER", "BOOT");
  drawLine(52, "Starting secure controller", kInk, 2);
  drawLine(89, "Loading device identity...", kMuted);

  if (!store.begin()) {
    drawHeader("DEVICE STORAGE", "FAILED", kDanger);
    drawLine(50, "NVS unavailable", kDanger, 2);
    drawLine(88, "Check the partition table.", kMuted);
    Serial.println("FATAL: NVS unavailable");
    return;
  }
  store.seedIdentityIfEmpty(DEVICE_ID, DEVICE_SECRET, GATEWAY_BASE_URL);

#if ENABLE_T190_EXTERNAL_ENCODER
  pinMode(ENCODER_PIN_A, INPUT_PULLUP);
  pinMode(ENCODER_PIN_B, INPUT_PULLUP);
  pinMode(ENCODER_BUTTON_PIN, INPUT_PULLUP);
  encoderHistory = static_cast<uint8_t>((digitalRead(ENCODER_PIN_A) ? 2 : 0)
    | (digitalRead(ENCODER_PIN_B) ? 1 : 0));
#endif

  // No microphone or camera exists in the verified adapter. `thread_picker` is advertised only
  // when the external encoder was explicitly enabled with a verified pin assignment.
  gateway.setCapabilities(ENABLE_T190_DISPLAY != 0, ENABLE_T190_EXTERNAL_ENCODER != 0, false, false);
  GatewayLimits limits;
  limits.menuItems = 8;
  limits.threadItems = 12;
  limits.labelCharacters = 34;
  limits.mediaUploadBytes = 0;
  gateway.setLimits(limits);
  gateway.begin(store, HARDWARE_MODEL, FIRMWARE_VERSION);
  gateway.handleOtaBootAttempt();
  gateway.startNetworkTask();
  browse.begin(store);

  provisioning.begin(store, store.deviceId());
  provisioningState = provisioning.status().state;
  reportState(provisioningState);
  dirty = true;
}

void loop() {
  const ProvisioningState nextState = provisioning.poll();
  if (nextState != provisioningState) {
    provisioningState = nextState;
    reportState(nextState);
    dirty = true;
  }

  int encoderDelta = 0;
  ButtonEvent buttonEvent = ButtonEvent::None;
  bool resetRequested = false;
#if ENABLE_T190_EXTERNAL_ENCODER
  encoderDelta = pollEncoder();
  buttonEvent = pollButton();
  resetRequested = recoveryHoldReached();
#endif

  if (gateway.tryLockState(20)) {
    if (provisioningState == ProvisioningState::Online) {
      if (provisioning.consumeJustConnected()) gateway.notifyJustConnected();
    } else {
      gateway.goOffline();
    }

    if (seenGatewayRevision != gateway.revision()) {
      seenGatewayRevision = gateway.revision();
      dirty = true;
    }
    // Environment/project mutation clears or changes the gateway-owned thread context. Until a
    // subsequent config response has changed the shared model, do not let a legacy intent stamp
    // the pre-mutation environment/thread ids into a new request.
    if (contextSyncPending && millis() - contextSyncRequestedAt >= 2500
        && gateway.link() == GatewayLink::Claimed
        && gateway.revision() != contextSyncAfterRevision
        && gateway.context().environmentId == browse.boundEnvironmentId()) {
      contextSyncPending = false;
      dirty = true;
    }
    if (seenBrowseRevision != browse.revision()) {
      seenBrowseRevision = browse.revision();
      dirty = true;
    }

    if (resetRequested) {
      provisioning.resetToProvisioning();
      screen = Screen::Home;
      dirty = true;
    } else {
      if (encoderDelta != 0) {
        if (screen == Screen::Response) {
          const int page = gateway.response().page + encoderDelta;
          if (page >= 0 && page < gateway.response().pageCount) gateway.fetchResponsePage(page);
        } else {
          moveCursor(encoderDelta, rowCountForScreen());
        }
      }
      if (buttonEvent == ButtonEvent::Tap) handleTap();
      else if (buttonEvent == ButtonEvent::Hold) handleHold();
    }

    if (dirty) render();
    gateway.unlockState();
  }

  delay(5);
}
