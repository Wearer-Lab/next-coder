#include "ui.h"

#include <math.h>
#include <memory>
#include <atomic>
#include <functional>

#include <GatewayBrowse.h>
#include <GatewayVoice.h>
#include <MediaUpload.h>
#include <OrbProfile.h>
#include <UiProfile.h>
#include <ThinkingOrb.h>
#include <ResponseLayout.h>
#include <SetupQr.h>

#include "audio.h"
#include "display.h"
#include "gatewayProbe.h"
#include "ui_content_job.h"
#include "ui_gesture_queue.h"
#include "ui_held_reply.h"
#include "ui_paint.h"
#include "wifi_keyboard.h"

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

#ifndef ORB_BENCH
#define ORB_BENCH 0
#endif
#ifndef HARDWARE_MODEL
#define HARDWARE_MODEL "ips28-esp32-s3r8"
#endif
#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "0.1.0"
#endif
#ifdef BUILD_FIRMWARE_VERSION
#undef FIRMWARE_VERSION
#define FIRMWARE_VERSION BUILD_FIRMWARE_VERSION
#endif

// The visual language is the orb's, not a dashboard's.
//
// The orb is an anti-aliased point cloud with no straight edge anywhere in it. Everything that used
// to be drawn beside it was a hard-cornered fill and a one-pixel rule, which is two products on one
// piece of glass. Every shape below now goes through uip::/displaySoft*, which composite a distance
// field: rounded, feathered, and curved where there used to be a rule. Clearing a band is still a
// rectangle, because that is invisible.
//
// Layout, 240x320:
//
//   0        header: device name, back, and the handle that pulls the status drawer down
//   52       (curved divider, with the pull grabber sitting above its low point)
//   56       content
//   262      action bar, WHEN there is something to press — otherwise content runs to 320
//   320
//
// Two things move and nothing else does: the status drawer slides down out of the header, and the
// action bar rises out of the bottom edge. Both are eased. The content underneath is repainted on
// change, which is what keeps a list screen inside the frame budget.

namespace {

using uip::Rect;
using uip::kBg;
using uip::kBright;
using uip::kHair;
using uip::kMuted;
using uip::kSurface;
using uip::kSurfaceHi;
using uip::kText;
using uip::kCols1;
using uip::kCols2;

constexpr int16_t kW = uip::kW;
constexpr int16_t kH = uip::kH;

constexpr int16_t kHeaderH = 52;
constexpr int16_t kContentTop = 56;

// The action bar's full height when it is all the way out. It overlays the content rather than
// resizing it every frame: the content region is recomputed only when the bar's presence changes,
// which is twice per appearance rather than once per frame.
constexpr int16_t kBarH = 58;

// The frame target: 16 ms, ~62 fps (millis() cannot express 16.7).
//
// This rests on a MEASUREMENT, not an aspiration. Instrumented on the board at 80 MHz SPI (0.2.22),
// a steady HOME frame did tick=6.4 ms of work (orb 6.2 of it: emit 3.1, raster 1.2, blit+other
// 1.7) and then slept 25.8 ms to land on the old 33 ms cap, i.e. 78% idle. Typical work therefore
// fits a 16 ms frame with ~9 ms to spare. The previous "~27 ms" figure this comment carried was
// wrong; it conflated a content repaint frame with a steady one.
//
// What does NOT fit is any single frame that repaints a whole region: a full-width content compose
// measured 40 ms, chrome ~12 ms and the action bar ~18 ms. Those are bounded separately — content
// is painted in time-budgeted slices (kPaintBudgetUs) so no frame blows this target by more than
// one band — and the numbers to re-check after any change here (in a HOSYOND_UI_PROFILE build) are
// [frame-split] tick/sleep and the [content-split] line. Raising the target back up is the safe direction if sleep reaches 0.
constexpr uint32_t kTargetFrameMs = 16;

// Per-frame cap on band-composition time for a content repaint, measured from the start of the
// tick (so it already includes anything painted before it this frame). The frame target minus the
// ~6.4 ms steady cost minus slack for the orb's own variance. A slice always paints at least one
// band so a repaint cannot stall, and overshoots by at most the cost of that band (~4 ms measured).
constexpr uint32_t kPaintBudgetUs = 9000;

// Slide durations. Both are deliberately shorter than a beat and longer than a frame: under about
// 120 ms an eased slide is indistinguishable from a jump, and over about 300 ms the device feels
// like it is thinking about it.
constexpr uint32_t kDrawerOpenMs = 220;
// Shorter on the way out, and eased at both ends. The drawer covers the whole page, so the strip it
// vacates is the bare ground until the screen underneath is repainted at the end of the slide;
// getting out of the way quickly is what stops that reading as a blank frame.
constexpr uint32_t kDrawerCloseMs = 150;
constexpr uint32_t kBarSlideMs = 170;

// The home orb, and the one that keeps a list screen from looking frozen. 148 px is the measured
// budget; 44 px costs about a twentieth of it, which is what makes "keep animating during a list"
// affordable rather than a trade against the list itself.
// The COVERAGE BUFFER, allocated by main.cpp's displayBeginCanvases(148, 44). Not the size the orb
// is drawn at.
constexpr uint16_t kOrbPx = 148;
constexpr uint16_t kMiniOrbPx = 44;

// What is actually blitted, and it is smaller than the buffer on purpose.
//
// HOME carries a list of threads under the orb now, and a 148 px disc in a 206 px content area left
// room for one row. 112 px leaves room for two with the action bar out and three without, and it is
// CHEAPER rather than a trade: the disc blit drops from 17 200 pixels to 9 900 and the geometry from
// 900 dots to 640, which is most of what the list costs paid for in advance.
constexpr uint16_t kOrbDrawPx = 112;
constexpr uint16_t kOrbDots = 640;

constexpr int16_t kOrbCx = kW / 2;

// The home composition is MEASURED, not positioned.
//
// The orb, the shimmer label and the lines under them used to sit at four fixed y-coordinates,
// which is only right for the one case they were tuned against. Both of the lines are conditional —
// a thread whose name is not known yet, an empty gateway line — and the action bar comes and goes
// underneath, so a fixed layout is top-anchored by construction and the slack collects at the
// bottom. That is exactly what the photograph showed: a small gap above the orb and a wide one
// between the last line and the TALK button.
//
// So the block's height is computed from what is actually about to be drawn, and the whole thing is
// centred in whatever space is left above the action bar — or in the full content area when there
// is no bar.

// What displayDrawOrb() actually writes.
constexpr int16_t kOrbBlitR = (int16_t)(kOrbDrawPx / 2);

// What the orb LOOKS like, which is not the same number. The geometry projects to radiusPx_ * 0.82
// with a little breathing on top of that — about 47 px of the 56 px box. Centring on the box makes
// the composition sit visibly low, because the empty margin above the dots counts as orb while the
// margin below counts as gap. Centring on the ink is what makes it look deliberate.
constexpr int16_t kOrbInkR = 47;

// The label strip is a 240 px wide blit, 22 px tall, drawn from labelY - 4. It therefore must start
// at or below the bottom of the orb's blit box or it would erase a band of the orb on every frame
// and flicker. This offset is that constraint, written down once.
constexpr int16_t kLabelDrop = kOrbBlitR + 4;
constexpr int16_t kLabelInkH = 16;    // size-2 glyphs inside the strip
constexpr int16_t kLineH = 8;         // size-1 glyphs
constexpr int16_t kGapLabelLine = 12;
constexpr int16_t kGapLine = 8;

// Where the orb and each line of the stack ended up. Computed by the screen that is about to paint
// and read by the frame loop, so the orb and the text it belongs with can never disagree about
// where the composition is.
// The action row is a 30 px band, not a text line: it carries the thread's status and the OPEN
// button side by side, which is the one control HOME has under the orb.
constexpr int16_t kActionRowBand = 30;
constexpr int16_t kGapLineAction = 10;

struct Stack {
  bool label = false;      // whether the shimmer strip is part of this composition
  int16_t orbCy = 120;
  int16_t labelY = 180;
  int16_t line1Y = 208;
  int16_t line2Y = 224;
  int16_t actionY = 232;
  bool line1 = false;
  bool line2 = false;
  bool action = false;
};

// Deliberately not tighter to the right edge: the blit is 44 px wide and centred, so a smaller cx
// would push setAddrWindow past the panel, and a smaller cy would push it negative.
constexpr int16_t kMiniOrbCx = kW - 32;
constexpr int16_t kMiniOrbCy = 22;

enum class Screen : uint8_t {
  Status, Home, Threads, Send, Actions, Response, Approvals, Environments, Projects, Device, Gateway, Wifi, WifiDetails, WifiPassword, WifiJoining, WifiPhone
};
enum class Modal : uint8_t { None, ConfirmControl, ConfirmApproval, ConfirmReprovision, ConfirmRejection, ConfirmClaim, ConfirmForgetWifi, ConfirmNativeResume };

// What the action bar can offer. Every one of these is something the person can do RIGHT NOW on
// the screen they are looking at; there is no entry here that navigates for its own sake, because
// that is what the drawer is for.
enum class Act : uint8_t {
  None, Review, Retry, Talk, PickThread, Reload, PrevPage, NextPage, Refresh, Agents, AgentUse, AgentSessions, AgentResume, AgentBack,
  Approve, Reject, NextApproval, SendClip, DiscardClip, Portal, ClosePortal, Reprovision,
  ConfirmYes, ConfirmNo, SavedActions, NewThread, VoiceStatus, VoiceDismiss, VoiceConsole, VoiceReview, UseThread, NotNow, ReturnThread, WifiOpen, WifiScan, WifiSaved, WifiAdd, WifiConnect, WifiEdit, WifiForget, WifiCancel, WifiPhone, WifiPhonePage, WifiPhoneDone
};

struct Action {
  Act id = Act::None;
  const char* label = "";
  bool primary = false;
  bool enabled = true;
};

// Three is what fits at 240 px with a capsule each and still leaves a label readable at arm's
// length. A fourth belongs in the drawer or on the screen itself.
constexpr uint8_t kMaxActions = 3;

// The drawer's categories. Each one is a fact about the device AND the way to the screen that acts
// on it — the two were previously separate ideas, one in a tab and one nowhere.
enum class Row : uint8_t { Device, Gateway, Thread, Activity };

constexpr uint8_t kMaxDrawerRows = 4;
// Taller than a list row, because the drawer covers the whole page and four rows in a 264 px column
// with 46 px each left most of the panel empty for no reason.
constexpr int16_t kDrawerRowH = 58;

GatewayClient* gw = nullptr;
Provisioning* prov = nullptr;
DeviceStore* store = nullptr;

// Its own translation unit's state, deliberately: GatewayClient is shared with three other boards
// and is not the place to grow a browser while it is being worked on elsewhere.
GatewayBrowse browse;

// The voice note's journey after it leaves the board. Its own TU for the same reason, and because
// GatewayClient::uploadMedia() discards the job id the status poll needs.
GatewayVoice voice;
uint32_t lastVoiceRevision = 0;

ThinkingOrb orb;
ThinkingOrb miniOrb;
bool orbReady = false;
bool miniReady = false;
uint32_t orbStartedAt = 0;
OrbMode currentMode = OrbMode::Ring;
// The word under the orb, chosen alongside the mode rather than derived from it. Ring is five
// different facts — idle, done, revoked, failed, waiting on a person — and orbLabelForMode() calls
// all of them "Thinking".
const char* currentLabel = "Starting";
// Whether that word is the whole message, or merely a caption for an animation already saying it.
bool currentSpeaks = true;

Screen screen = Screen::Status;
Modal modal = Modal::None;

DeviceControl pendingControl;
String pendingApprovalId;
String pendingApprovalSummary;
int previewThreadIndex = -1;
String previewThreadId;
WifiScanSnapshot wifiScan;
WifiConnectionSnapshot wifiConnection;
std::vector<String> wifiSavedNames;
String wifiTarget, wifiPassword;
bool wifiTargetSaved=false, wifiTargetSecured=true, wifiTargetSupported=true;
bool wifiShowSaved=false, wifiKeyboardSymbols=false, wifiKeyboardUpper=false, wifiEditingSsid=false;
int16_t wifiScroll=0;
uint32_t wifiObservedRevision=0, wifiNoticeUntil=0, wifiUiCandidateId=0;
bool wifiHadDisconnect=false;
String wifiNotice, wifiPreviousActive;
PhoneSetupSnapshot phoneSetup;
setup_qr::Matrix phoneQr;
bool phoneShowPage=false,phoneSetupSucceeded=false;
uint32_t phoneNextCheckAt=0;
void refreshPhoneQr() {
  phoneQr.clear();
  if(!phoneSetup.active)return;
  if(phoneShowPage)setup_qr::encodePortalUrl(phoneSetup.portalUrl.c_str(),phoneQr);
  else setup_qr::encodeWifi(phoneSetup.apName.c_str(),phoneSetup.apPassword.c_str(),phoneQr);
}
bool wifiEntryDirty=false;
bool wifiLettersDirty=false, wifiUtilityDirty=false;
int16_t wifiKeyboardOffset=0, wifiKeyboardDragStart=0;
bool wifiKeyboardDragging=false, wifiKeyboardDragged=false;

size_t approvalIndex = 0;

// HOME's destination picker.
//
// The line under the orb is not a readout, it is the selector: a horizontal swipe steps through the
// fetched threads and the line updates immediately. Its whole purpose is that a person can tell
// where their voice is about to go, which drives two rules that are more important than any of the
// visuals:
//
//   ONE WRITE PER GESTURE, NOT PER STEP. Binding is POST /v1/device/config/thread. The highlight
//   moves locally and the write is debounced by kPickerCommitMs after the finger settles, so
//   swiping past eight threads produces one request and never leaves the device bound to something
//   the user merely passed over.
//
//   THE LINE NEVER LIES. A selection that has not been committed is drawn differently from one that
//   has, and a write that FAILS reverts the highlight to whatever the device is genuinely bound to.
//   Showing thread B while bound to thread A would send somebody's voice to the wrong place, which
//   is worse than any amount of visual roughness.
int pickerIndex = -1;          // into the thread list; -1 means "follow the bound thread"
uint32_t pickerCommitAt = 0;   // 0 when there is nothing pending
bool pickerOpenResponse = false;
bool pickerBinding = false;    // a write is in flight this frame
constexpr uint32_t kPickerCommitMs = 600;

// The destination picker is a carousel, not a value that changes after the finger has gone away.
// Only its lower composition moves — the orb is the stable landmark above it. During a drag the
// offset follows the glass directly; on release it eases the remaining distance into place. The
// strings are captured at the start of the motion so the 30 fps path does not allocate two Arduino
// Strings per frame.
struct HomePickerVisual {
  String prominent;
  String secondary;
  String verb;
  bool big = false;
  uint8_t prominentTone = kText;
  uint8_t secondaryTone = kMuted;
};

struct PickerMotion {
  bool active = false;
  bool dragging = false;
  int8_t direction = 0;       // 1: later slot enters from right; -1: earlier enters from left
  float offset = 0.0f;        // outgoing copy's x offset
  float startOffset = 0.0f;
  float targetOffset = 0.0f;
  uint32_t startedAt = 0;
  HomePickerVisual from;
  HomePickerVisual to;
};

PickerMotion pickerMotion;
constexpr uint32_t kPickerSlideMs = 190;

// Whether the thread list has ever been asked for this boot. Before that, an empty list means "not
// loaded", not "none" — and the two must never look the same on the destination line.
//
// Set by this screen's own fetch, but no longer the only way the list arrives: the gateway cycle
// now refreshes threads every 30 s and on the just-connected edge, so a populated list is proof of
// itself whoever asked for it. threadListKnown() is what the UI consults; the flag only settles the
// one case data cannot, which is "we asked and there genuinely are none".
bool threadsFetched = false;
// True from the moment THREADS asks the gateway to confirm a list until the answer is published. It
// only changes what an EMPTY list says ("Loading" rather than "No threads in this folder"): a list
// that is already on screen is never replaced by a loading card, it is revalidated behind itself.
bool threadsLoading = false;
// The reply screen was opened and its first read has not finished. With nothing held to show, it
// reads "Loading the latest reply" instead of the misleading "No response open".
bool replyLoadPending = false;
// Native discovery is bounded to twelve rows and uses the existing scrolling destination view.
uint8_t agentBrowseMode = 0; // threads / agents-models / native sessions
int selectedAgentRow = -1;

bool threadListKnown();
bool createdRowLive();
size_t threadRowCount();
const ThreadOption* threadRowAt(size_t index);
bool haveThread();

// THE THREAD THIS DEVICE JUST CREATED, held locally until the client's own list catches up.
//
// POST /v1/device/threads answers with a row shaped exactly like one from GET /v1/device/threads
// and the protocol says to splice it in rather than re-fetch — T3 answers a dispatch as soon as the
// event is appended and its projection catches up afterwards, so a re-fetch can legitimately not
// contain a thread that certainly exists. GatewayClient owns `threads_[]` and may not be edited, so
// the splice is an overlay: one extra row appended past the end of whatever the client holds, which
// retires itself the moment the real list contains the same id.
ThreadOption createdRow;

int16_t threadScroll = 0;
int16_t actionScroll = 0;
int16_t envScroll = 0;
int16_t projectScroll = 0;

// One line of feedback for whatever the person just did. Deliberately not the display payload's
// line2 — that is the account's last command, which is a different fact and arrives up to 5 s late.
String message;

String statusLabel = "Starting";
String shownLabel;
// Where the current screen put its composition. Written by whichever paint function laid it out,
// read by the frame loop when it draws the orb and the label, so the two can never disagree about
// where the block is.
Stack stack;
// The name last drawn into the header, so a display poll that finally learns the device's label can
// dirty the chrome. Nothing else does: revision() drives the CONTENT, and the header was painted
// once at boot with whatever was known then — which is why it sat on the id-tail fallback.
String shownDeviceName;
// And once a real name has been seen it is kept. A later poll that fails, or a gateway that answers
// with its own "Controller" placeholder, must not demote the header back to an id.
String resolvedDeviceName;
bool chromeDirty = true;
bool contentDirty = true;

uint32_t lastRevision = 0;
uint32_t lastBrowseRevision = 0;
Screen lastScreen = Screen::Status;
Modal lastModal = Modal::None;
GatewayLink lastLink = GatewayLink::Idle;
ProvisioningState lastProvState = ProvisioningState::Unprovisioned;
size_t lastApprovalCount = 0;

// Push-to-talk state. `recordArmed` is the press that landed on the microphone button; the
// recording itself runs in uiTick() so the loop keeps polling touch and can see the finger lift.
bool recordArmed = false;
String voiceCaptureEnvironment;
String voiceCaptureThread;
String voiceCaptureTitle;
#if BENCH_SELFTEST
bool benchGlassHeld = false;
#endif
uint32_t recordPaintedAt = 0;
uint32_t recordOrbAt = 0;

// A finished clip is HELD, not sent.
//
// The old behaviour uploaded and dispatched the moment the finger lifted, which means the only way
// to cancel a voice note recorded by accident was to let it reach the agent and then stop the turn.
// Holding it is what gives the action bar something to be: SEND and DISCARD, on a clip whose length
// is on screen.
bool clipHeld = false;
uint32_t clipHeldMs = 0;

// The status drawer. `drawerT` is the eased 0..1 position and `drawerShownPx` is how much of it is
// currently ON the glass, which is what makes the slide incremental rather than a full repaint per
// frame.
bool drawerOpen = false;
float drawerT = 0.0f;
int16_t drawerShownPx = 0;
bool drawerDirty = false;
uint8_t drawerRowCount = 0;
Row drawerRows[kMaxDrawerRows];
// How much of each row is already correct on the glass. Repainting a row whose text has not
// changed is what drew text over text: the surface is not cleared between redraws, so a shorter
// new value left the tail of the old one standing beside it. A row is now repainted only when its
// own string moved, and its band is cleared first.
String drawerPainted[kMaxDrawerRows];
bool drawerRowOnGlass[kMaxDrawerRows] = {false, false, false, false};

// The action bar. `barT` eases; `barReserved` is whether the content region currently stops short
// of the bottom, and only that second flag costs a content repaint.
Action actions[kMaxActions];
uint8_t actionCount = 0;
uint32_t actionSignature = 0;
float barT = 0.0f;
bool barReserved = false;
bool barDirty = false;

// ---------------------------------------------------------------------------------------------
// Content repaint as a bounded job
// ---------------------------------------------------------------------------------------------
//
// A content repaint is composed in 22 px strips (displayComposeScene), each strip replaying the
// screen's whole painter once and then publishing 22 rows over SPI. Measured on the board that is
// ~4 ms a strip, so the ~206 px content area is ~40 ms in ONE frame — two to four frames' worth of
// stall at the old 33 ms cadence, and the reason a scroll or a model refresh felt like the device
// froze. The strips are independent opaque full-width bands, so nothing requires them to be
// published in the same frame: this spreads them across frames under a time budget.
//
// Rules that keep it honest:
//  * It is level-triggered by `contentDirty`, exactly as before. A new request while a job is
//    running RESTARTS it from the top with the fresh state; the painter reads current state per
//    strip, so a half-finished job is never allowed to finish with stale layout.
//  * The orb is not drawn while a full job is active. The strips cover the orb's area; drawing it
//    between strips would show it, then wipe it, then show it (this is what the one-frame hole in
//    the old single-frame repaint already did, just longer).
//  * The picker's carousel motion paints straight onto the panel and would be overwritten by the
//    later strips, so it waits for the job to finish. It is time-based, so it does not slow down.
//  * A strip that cannot be composed (no band canvas) falls back to the old direct paint.
ContentJob contentJob;

// HOME repaint requested only because the model moved. See markContentForModelChange().
bool homeTextDirty = false;

// Why a repaint happened, for the [content-split] line. First cause since the last arming wins.
// `kCauseOther` is everything that sets contentDirty directly (touch handlers, picker, message).
// The names stay in every build because the call sites that pass them are product code; only the
// recording of the cause (pendingContentCause, and the counters that consume it) is profile-only.
enum : uint8_t { kCauseOther, kCauseRevision, kCauseBrowse, kCauseScreen, kCauseLink, kCauseReserve,
                 kCauseArrival, kCauseCount };
constexpr uint8_t kNoCause = 0xFF;
UI_PROFILE(uint8_t pendingContentCause = kNoCause;)

// A finger that came down in the header is pulling the drawer, wherever it ends up. Decided on the
// press rather than on each drag, because a drag that starts in a list and wanders into the header
// is a scroll, not a pull.
// ---------------------------------------------------------------------------------------------
// Gesture ownership
// ---------------------------------------------------------------------------------------------
//
// One finger, three things it could mean. The rule is decided by WHERE THE FINGER LANDED, once, on
// the press — never by whichever handler happens to see the event first, which is how the drawer
// came to eat the page's scrolls:
//
//   Drawer      the finger landed in the header or on the grabber. It owns the drawer in both
//               directions: downward opens, upward closes. Nothing else here does.
//   DrawerList  the finger landed inside the open drawer. It scrolls the drawer's own row list
//               when that list can scroll, and closes the drawer only on OVERSCROLL — the list is
//               already at its top and the finger is still travelling in the closing direction.
//   Content     the finger landed on the page. It scrolls the page and NEVER closes the drawer.
//
// And nothing commits from the first few pixels. `dragTravel` accumulates movement since the finger
// landed and the drawer acts only once it passes kDragCommitPx; a two-pixel wobble at the start of
// a scroll used to be read as a dismissal, which is the whole of "the slider closes back when the
// user tries to scroll content up".
enum class DragOwner : uint8_t { Content, Drawer, DrawerList };
DragOwner dragOwner = DragOwner::Content;

// AXIS ARBITRATION, layered on top of that ownership.
//
// The device now has both a vertical language (drawer, scrolling) and a horizontal one (stepping
// through threads, moving between levels), and one finger has to be unambiguously one or the other.
// So travel is accumulated on BOTH axes, and the first to pass the commit distance wins and LOCKS
// for the rest of the gesture:
//
//   a horizontal swipe can never open or close the drawer
//   a vertical scroll can never change the selection or the level
//
// This is where "the slider closes when I scroll" came from the first time, with only one axis in
// play. With two it would happen twice as often, and locking is the only thing that reliably stops
// a gesture being reinterpreted halfway through.
enum class DragAxis : uint8_t { Undecided, Vertical, Horizontal };
DragAxis dragAxis = DragAxis::Undecided;
int16_t dragTravel = 0;    // vertical, signed: positive is downward
int16_t dragTravelX = 0;   // horizontal, signed: positive is rightward

// Far enough that it is a gesture and not a tremor, short enough that it still feels immediate.
constexpr int16_t kDragCommitPx = 18;

// Frame statistics. Draw time alone was not enough to explain a visible hitch — it stayed at 27 ms
// while the animation still stumbled — so the interval BETWEEN frames is measured as well as the
// work inside one, and anything that blocks (a gateway call, the captive portal, DNS) shows up as a
// gap even though it never touches the renderer.
struct FrameStats {
  uint32_t frames = 0;
  uint32_t worstDrawMs = 0;
  uint32_t worstGapMs = 0;
  uint32_t hitches = 0;
  float fps = 0.0f;
  uint32_t worstGapEverMs = 0;
  uint32_t hitchesEver = 0;
};

FrameStats stats;

#if HOSYOND_UI_PROFILE
// MEASUREMENT (HOSYOND_UI_PROFILE only, with the [frame-split]/[orb-split] lines): where a painted
// frame's time goes, in microseconds. `draw<=` in [fps] is one number that adds all of this up; it cannot say
// whether the orb, the chrome or the bookkeeping before the first pixel is the long pole.
//
//   pre      uiTick() entry -> drawStart: retained-touch replay, network-job completion, Wi-Fi/phone
//            polling, the model-lock observe block. Nothing here paints.
//   logic    drawStart -> first paint: picker motion, drawer/bar easing, buildActions(), the
//            action signature, clearForArrival(). Computation, plus the arrival clear when a screen changed.
//   chrome / bar / drawer / content / picker   the compose-and-publish stages, each only when it ran.
//   orb      displayDrawOrb()/displayDrawMiniOrb() in full: geometry + raster + blit.
//   status   the shimmer label and the header dot.
//   tick     uiTick() entry -> the end of the last paint, for a painted frame (= pre + logic + the
//            paint stages). The voice-poll enqueue after it is not included.
//   sleep    time spent inside uiSleepUntilNextFrame(): HEADROOM. If sleep is ~0 the loop is
//            saturated; if it is large the frame cap, not the work, is what limits fps.
//   rest     period - tick - sleep: loop() work outside uiTick (touchPoll, provisioning.poll,
//            qualification, early-return passes).
struct FrameSplit {
  uint32_t frames = 0;
  uint32_t pre = 0, logic = 0, chrome = 0, bar = 0, drawer = 0, content = 0, picker = 0, orb = 0, status = 0;
  uint32_t tick = 0, sleep = 0, period = 0;
  uint32_t tickMax = 0, orbMax = 0, preMax = 0, contentMax = 0, periodMax = 0;
  uint32_t orbFrames = 0, contentFrames = 0, chromeFrames = 0, barFrames = 0;
  uint32_t lastTickEnterUs = 0;
  // Content repaint jobs (see ContentJob). cause[] indexes the k*Cause enum.
  uint32_t jobs = 0, partialJobs = 0, strips = 0, jobUs = 0, jobUsMax = 0, jobFramesMax = 0, restarts = 0;
  uint32_t cause[8] = {};
  uint8_t lastJobScreen = 0;
} split;
#endif  // HOSYOND_UI_PROFILE
uint32_t lastFrameAt = 0;
uint32_t nextFrameAt = 0;

#if ORB_BENCH
uint8_t benchIndex = 0;
uint32_t benchNextAt = 0;
#endif

// ---------------------------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------------------------

Adafruit_GFX& g() { return displayRenderGfx(); }

bool operable() {
  return gw != nullptr && gw->link() == GatewayLink::Claimed;
}

bool unclaimed() {
  return gw != nullptr && gw->link() == GatewayLink::Unclaimed;
}

bool voiceInJourney();
bool voiceNeedsRecovery();

// Whether this screen keeps the bottom 58 px clear for buttons.
//
// The voice screen ALWAYS does, even in the two states that have no buttons. Otherwise the capsule
// would sit 29 px lower in "hold to talk" than in "clip ready" purely because two buttons appeared,
// and the three states are meant to read as one object changing rather than three screens. The
// full-page journey is the exception: it has no buttons and wants the whole page.
bool reservesActionBand() {
  if (screen == Screen::Send) return !voiceInJourney() || voiceNeedsRecovery();
  return barReserved;
}

// Where the content stops. Recomputed only when the band's presence changes, and the change is what
// dirties the content — a bar that is mid-slide does not reflow a list underneath it.
int16_t contentBottom() { return reservesActionBand() ? (int16_t)(kH - kBarH) : kH; }

// Clears only as far as the content actually extends. The action bar owns the bottom band while it
// is out, and a content repaint that erased it would fight the bar for the same pixels every time a
// list changed underneath it.
void clearContent() {
  g().fillRect(0, kContentTop, kW, (int16_t)(contentBottom() - kContentTop), panelGrey(kBg));
}

// ONE PLACE clears a screen transition, and this is it.
//
// Third variant of the residue bug, and the first two were fixed per-screen — which is why there
// was a third. Every screen clears the region IT draws into, and that is correct for a repaint but
// wrong for an arrival: the recording state paints a capsule and an elapsed time, so it never
// touched the two lines the previous state had left below the capsule, and "SENDING TO" and half a
// thread title stayed on the glass beside it.
//
// So arrival is not a screen's business any more. `paintedViewKey` identifies what is currently on
// the panel — the screen, the modal, and which of the voice states, because those are four
// different pictures inside one Screen — and any change to it clears the WHOLE content area, all
// the way to the bottom of the panel rather than to contentBottom(), before anything is drawn.
uint16_t paintedViewKey = 0xFFFF;
uint16_t viewKey();

void clearForArrival() {
  // The destination is composed as complete strips. Do not expose an empty panel first.
  paintedViewKey = viewKey();
  // The full clear took the action band with it, which is the point — nothing survives an arrival —
  // so the bar has to be told it is no longer on the glass.
  barDirty = true;
}

// Clears only the scrolling part of a list screen. The band above it belongs to that screen's own
// chrome, which clears it again when it repaints on top of the rows — clearing it twice was 13 000
// to 29 000 wasted pixels on every list repaint, which at 80 MHz is real milliseconds.
void clearListRegion(int16_t top) {
  const int16_t bottom = contentBottom();
  if (bottom > top) g().fillRect(0, top, kW, (int16_t)(bottom - top), panelGrey(kBg));
}

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

// The device's own name, which is what the owner called it in the console — `device.label`, carried
// to the hardware as the display payload's title. "NEXT CODER" is the product's name, not this
// unit's, and on a desk with two of them it identified neither.
String deviceName() {
  if (gw) {
    const String& title = gw->display().title;
    // Both of these are the fallback the gateway or the parser substituted, not a name anybody
    // chose, so neither is worth showing over the device's own id. "Agent Controller" is the
    // legacy spelling of the same product-name fallback.
    if (title.length() > 0 && title != "Controller" && title != "Next Coder"
        && title != "Agent Controller") {
      resolvedDeviceName = title;
      return title;
    }
  }
  if (resolvedDeviceName.length() > 0) return resolvedDeviceName;
  if (store) {
    const String& id = store->deviceId();
    if (id.length() >= 4) return String("Controller ") + id.substring(id.length() - 4);
  }
  return String("Controller");
}

// The selected thread's human title, or an empty string.
//
// GatewayClient::selectedThreadLabel() falls back to a shortened id when the thread list has not
// been fetched this boot, which is what put `~85f4dc4dd4a` under the orb and in the drawer. It is
// the same defect the environment breadcrumb had, and it has the same answer: an id names the
// thread to the gateway and to nobody standing in front of the device. Return nothing, and let each
// caller say something a person can act on.
//
// The list is fetched on the way into THREADS, so the gap lasts until the owner looks at the list
// once. It is deliberately not fetched from here: this is called from paint functions, and a
// blocking socket has no business on the render loop.
String threadTitle() {
  if (!gw) return String();
  // The overlay outranks the client's own answer: the gateway bound the new thread when it created
  // it, so while that row is live it IS the destination, whatever GatewayClient's stale config says.
  if (createdRowLive()) return createdRow.title;
  if (!gw->hasThread()) return String();
  const String& id = gw->context().threadId;
  for (size_t i = 0; i < gw->threadCount(); ++i) {
    const ThreadOption* row = gw->thread(i);
    if (!row) continue;
    if (row->id == id && row->title.length() > 0) return row->title;
  }
  return String();
}

// Whether the device has a destination at all, counting one it has just created.
bool haveThread() {
  return gw != nullptr && (gw->hasThread() || createdRowLive());
}

// ---------------------------------------------------------------------------------------------
// Status rows
// ---------------------------------------------------------------------------------------------

const char* rowTitle(Row row) {
  switch (row) {
    case Row::Device:   return "DEVICE";
    case Row::Gateway:  return "GATEWAY";
    case Row::Thread:   return "DESTINATION";
    default:            return "NEEDS YOU / REPLY";
  }
}

String rowValue(Row row) {
  switch (row) {
    case Row::Device: {
      if (!prov) return String("Unknown");
      switch (prov->status().state) {
        case ProvisioningState::Provisioning: return String("Setup portal open");
        case ProvisioningState::Connecting:   return String("Joining Wi-Fi");
        case ProvisioningState::Failed:       return String("Wi-Fi failed");
        case ProvisioningState::Unprovisioned: return String("No Wi-Fi saved");
        default: break;
      }
      if (!gw) return String("Online");
      switch (gw->link()) {
        case GatewayLink::Claimed:    return String("Claimed and online");
        case GatewayLink::Unclaimed:  return String("Waiting to be claimed");
        case GatewayLink::Revoked:    return String("Access revoked");
        case GatewayLink::NoIdentity: return String("No identity flashed");
        default:                      return String("Online");
      }
    }
    case Row::Gateway: {
      if (!gw) return String("Not configured");
      if (gw->link() == GatewayLink::Unreachable) return String("No answer");
      const GatewayStatus probe = gatewayStatus();
      if (probe == GatewayStatus::Unreachable || probe == GatewayStatus::BadResponse) {
        return String(gatewayStatusText(probe));
      }
      if (!store || store->gatewayUrl().length() == 0) return String("No URL set");
      return String("Reachable");
    }
    case Row::Thread: {
      if (!gw) return String("None");
      if (!haveThread()) return String("None selected");
      const String title = threadTitle();
      // Bound, but the list has not been fetched, so the title is not known here. Saying so is
      // better than showing the id — and the row is a link to the screen that will resolve it.
      return title.length() > 0 ? title : String("Open to see which");
    }
    default: {
      if (!gw) return String("Nothing yet");
      const size_t approvals = gw->approvalCount();
      if (approvals > 0) return String(approvals) + " gateway approval";
      const RemoteBlockers& remote = gw->remoteBlockers();
      if (remote.userInputs) return String(remote.userInputs) + " input needed; console";
      if (remote.providerApprovals) return String(remote.providerApprovals) + " provider approval; console";
      if (gw->hasBlockingRequests()) return "Check requests in console";
      if (gw->responseOpen() && gw->responseInFlight()) return String("Agent is working");
      const String& line = gw->display().line2;
      return line.length() > 0 ? line : String("Nothing yet");
    }
  }
}

// A row's own health, which is the only thing the little dot beside it says. Bright is "needs you",
// muted is fine, hair is "not applicable yet".
uint8_t rowTone(Row row) {
  switch (row) {
    case Row::Device:
      if (!gw) return kHair;
      return (gw->link() == GatewayLink::Claimed) ? kMuted : kBright;
    case Row::Gateway: {
      if (!gw) return kHair;
      if (gw->link() == GatewayLink::Unreachable) return kBright;
      const GatewayStatus probe = gatewayStatus();
      if (probe == GatewayStatus::Unreachable || probe == GatewayStatus::BadResponse) return kBright;
      return kMuted;
    }
    case Row::Thread:
      if (!gw) return kHair;
      return haveThread() ? kMuted : kBright;
    default:
      if (!gw) return kHair;
      return gw->hasBlockingRequests() ? kBright : kMuted;
  }
}

// Only the rows this device's situation justifies.
//
// A unit that has never been claimed has no thread and no activity — every route behind both
// answers 403 — so offering them would be offering two dead ends. The device and the gateway rows
// are always there because they are exactly what is wrong when the other two are missing.
void rebuildDrawerRows() {
  const uint8_t before = drawerRowCount;
  Row previous[kMaxDrawerRows];
  for (uint8_t i = 0; i < before && i < kMaxDrawerRows; ++i) previous[i] = drawerRows[i];

  drawerRowCount = 0;
  drawerRows[drawerRowCount++] = Row::Device;
  drawerRows[drawerRowCount++] = Row::Gateway;
  if (operable()) {
    // Bounds-checked against drawerRows, which is the array being written — not against
    // kMaxDrawerRows-as-a-guess about how many categories exist.
    if (drawerRowCount < kMaxDrawerRows) drawerRows[drawerRowCount++] = Row::Thread;
    if (drawerRowCount < kMaxDrawerRows) drawerRows[drawerRowCount++] = Row::Activity;
  }

  if (drawerRowCount != before) {
    drawerDirty = true;
    return;
  }
  for (uint8_t i = 0; i < drawerRowCount; ++i) {
    if (previous[i] != drawerRows[i]) { drawerDirty = true; return; }
  }
}

// The drawer covers the whole page. It used to open as a band sized to its rows, which left the
// screen underneath showing below it and read as a popup rather than as a surface being pulled
// down over the device.
constexpr int16_t kDrawerFullH = kH - kContentTop;
constexpr int16_t kDrawerPadTop = 12;
int16_t drawerHeight() { return kDrawerFullH; }

// Every row the device can justify fits, whole, with no scrolling.
//
// A row sliced in half at the bottom edge looks like a bug because it is one, so this is a build
// error rather than a runtime clip: add a fifth category or make the rows taller and the compiler
// stops you, at which point either the row height comes down or the drawer grows a scroll — and
// the overscroll branch in handleDrag() is already written for that day.
static_assert(kDrawerPadTop + kMaxDrawerRows * kDrawerRowH <= kDrawerFullH,
              "The drawer's rows must fit its height without clipping the last one.");

// True when the drawer's own list is taller than the panel. Constant today, by the assert above,
// and consulted rather than assumed so the gesture rule stays honest if that ever changes.
bool drawerListScrolls() {
  return kDrawerPadTop + (int16_t)drawerRowCount * kDrawerRowH > kDrawerFullH;
}

// ---------------------------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------------------------

bool canGoBack() {
  return screen != Screen::Home && screen != Screen::Status;
}

// DEVICE and GATEWAY are reachable — and useful — on a controller that has no owner yet. They are
// what somebody opens when the claim screen is not working, so neither the action bar nor the touch
// router may gate them on being claimed the way every thread-shaped screen is.
bool configScreen() {
  return screen == Screen::Device || screen == Screen::Gateway || screen == Screen::Wifi
    || screen == Screen::WifiDetails || screen == Screen::WifiPassword || screen == Screen::WifiJoining || screen == Screen::WifiPhone;
}

constexpr Rect kBackHit = {0, 0, 46, kContentTop};
constexpr Rect kHandleHit = {46, 0, kW - 46, kContentTop};

void drawHeader() {
  g().fillRect(0, 0, kW, kContentTop, panelGrey(kBg));

  const bool back = canGoBack();
  if (back) uip::chevron(20, 24, 6.0f, -1, kMuted, 2.2f);

  const int16_t nameX = back ? 40 : 14;
  const size_t nameCols = (size_t)((kW - nameX - 46) / 6);
  // The device's own name is the title of every screen on it, so it is the brightest thing in the
  // header: in the reference design the chrome is white and the content below it is not.
  uip::text(nameX, 20, 1, kBright, uip::fit(wifiNoticeUntil != 0 ? wifiNotice : deviceName(), nameCols));

  // The divider is a shallow arc that fades out before either bezel, and the pull grabber sits
  // above its low point rather than on it — a rule with a tab welded to it is the shape this UI is
  // trying to stop being.
  displaySoftArcDivider(14, 46, (int16_t)(kW - 28), 3.5f, 1.5f, kBg, kHair);
  uip::capsule({(int16_t)(kW / 2 - 17), 38, 34, 4}, (int16_t)kHair, -1);
}

// The header's right-hand affordance: one dot, whose tone is the worst thing any drawer row has to
// say. When the big orb is not on screen the mini orb lives here instead.
//
// There was a small chevron under the dot pointing at the pull-down. It has been removed. The
// grabber under the title stays: with the arrow gone it is the only remaining hint that the header
// opens, and it is not a second copy of the same idea — the arrow sat beside the STATUS dot, where
// it read as a property of the status rather than of the header, while the grabber is the ordinary
// sheet handle sitting centred on the edge the panel comes out of.
//
// The dot is the accent when something needs a person. That is the console's rule too: the violet
// is spent on live state, and a state that needs a person is the one that is live.
void drawHeaderStatusDot() {
  bool alert = false;
  for (uint8_t i = 0; i < drawerRowCount; ++i) {
    if (rowTone(drawerRows[i]) == kBright) { alert = true; break; }
  }
  if (alert) uip::accentDot(kMiniOrbCx, kMiniOrbCy, 5.0f);
  else uip::dot(kMiniOrbCx, kMiniOrbCy, 5.0f, kMuted);
}

void drawChrome() {
  // Only the very first paint needs the whole panel cleared. After that the header, the drawer, the
  // content region and the action bar each clear their own band.
  static bool everPainted = false;
  if (!everPainted) {
    g().fillScreen(panelGrey(kBg));
    everPainted = true;
  }
  drawHeader();
  chromeDirty = false;
}

// ---------------------------------------------------------------------------------------------
// Orb mode
// ---------------------------------------------------------------------------------------------
//
// The orb is this device's primary status indicator, which makes a wrong mode a lie about what the
// agent is doing. So this is a TOTAL decision table over the states the device can actually be in,
// and every arm names both the animation and the word under it — the two are returned together
// precisely so they cannot drift apart. Deriving the label from the mode, as this used to, meant
// every calm state said "Thinking", including a revoked credential and a failed turn.
//
// The vocabulary is the one the gateway really speaks, checked against the server rather than
// assumed:
//
//   threads[].status   running | starting | streaming | completed | error | stopped | idle
//                      (app.mjs deviceThreadStatus(): active work wins over a stale session, and
//                      anything else is T3's own latestTurn.state or session.status verbatim)
//   response.state     waiting | streaming | complete | empty | error  (deviceThreadOutput.mjs)
//   display.state      ready | setup   (displayState.mjs), plus boot/unknown/error set locally
//
// orbModeForAgentState() in the shared ThinkingOrb also matches searching / solving / planning /
// weaving / composing / writing / shaping / pairing / listening. None of those strings exist
// anywhere in src/ — that mapper is written against a vocabulary this gateway does not have. It is
// still consulted, last, for a status word this table does not recognise, so that a gateway which
// one day publishes a real agent verb lights the matching animation with no firmware change.

// `speaks` is the classification that decides what gets the prominent line on HOME.
//
// The orb has nine animations, so in normal operation the state word beside it is redundant — the
// thread's NAME is the thing nothing else on the screen carries, and it is what a person needs to
// see before they speak into the device. But several states all render the calm Ring, and for those
// the word is the entire message: the orb cannot tell "Revoked" from "Idle", and hiding that behind
// a thread name would hide a fault behind a decoration.
//
// So: THE PROMINENT LINE SHOWS THE THREAD NAME UNLESS THE STATE CARRIES INFORMATION THE ORB CANNOT
// EXPRESS, IN WHICH CASE THE STATE WINS. Every branch of the table below sets this explicitly and
// there is no default, so a state added later cannot quietly classify itself as decorative.
struct OrbPresentation {
  OrbMode mode;
  const char* label;
  bool speaks;
};

// Case-insensitive compare with no allocation. The client upper-cases a thread status for display
// and Arduino's String::equalsIgnoreCase only takes a String, so the obvious spelling would build
// and destroy a temporary for every arm of the table below.
bool stateIs(const String& value, const char* word) {
  return strcasecmp(value.c_str(), word) == 0;
}

// The one word for a thread's status, and the ONLY place that decision is made.
//
// The orb's label and the thread line under it are the same fact, so they come from the same
// function — a screen that says "Working" over an orb and "RUNNING" beside the thread is describing
// one thing two ways. Returns an empty string when the status is a word this firmware has no
// vocabulary for, so the caller can leave the space blank rather than print something raw.
const char* threadStatusWord(const String& status) {
  if (status.length() == 0) return "";
  if (stateIs(status, "running") || stateIs(status, "working"))    return "Working";
  if (stateIs(status, "streaming"))                                return "Composing";
  if (stateIs(status, "starting"))                                 return "Starting";
  if (stateIs(status, "error") || stateIs(status, "failed"))       return "Failed";
  if (stateIs(status, "completed") || stateIs(status, "complete")) return "Done";
  if (stateIs(status, "stopped") || stateIs(status, "idle")
      || stateIs(status, "empty"))                                 return "Idle";
  // A word the table does not know: ask the shared mapper, in case the gateway has grown a real
  // agent verb since this was written.
  const OrbMode mapped = orbModeForAgentState(status);
  return mapped != OrbMode::Ring ? orbLabelForMode(mapped) : "";
}

// True while the overlay row is still the only place the new thread exists.
bool createdRowLive() {
  if (createdRow.id.length() == 0 || !gw) return false;
  // Rename/delete/archive events can move the binding while this local projection still exists.
  // Once the gateway no longer points at the created id, retaining the overlay would resurrect a
  // removed thread on glass even though the shared client correctly removed its real row.
  if (gw->context().threadId != createdRow.id) return false;
  for (size_t i = 0; i < gw->threadCount(); i += 1) {
    const ThreadOption* row = gw->thread(i);
    if (row && row->id == createdRow.id) return false;   // the real list has it; retire
  }
  return true;
}

// The thread list as the screen sees it: the client's rows, plus the overlay when it is live.
size_t threadRowCount() {
  if (!gw) return 0;
  if (screen == Screen::Threads && agentBrowseMode) return browse.agentCount();
  if (screen == Screen::Threads && browse.previewActive()) return browse.previewThreadCount();
  return gw->threadCount() + (createdRowLive() ? 1 : 0);
}

const ThreadOption* threadRowAt(size_t index) {
  if (!gw) return nullptr;
  if (screen == Screen::Threads && agentBrowseMode) { const BrowseAgent* item = browse.agent(index); return item ? &item->row : nullptr; }
  if (screen == Screen::Threads && browse.previewActive()) return browse.previewThread(index);
  if (index < gw->threadCount()) return gw->thread(index);
  if (createdRowLive() && index == gw->threadCount()) return &createdRow;
  return nullptr;
}

bool threadListKnown() {
  return threadRowCount() > 0 || threadsFetched;
}

// The row the device is actually bound to, overlay included. One place, so the orb's animation, the
// word beside it and the destination line cannot disagree about which thread they are describing.
const ThreadOption* boundThreadRow() {
  if (!gw) return nullptr;
  if (createdRowLive()) return &createdRow;
  if (!gw->hasThread()) return nullptr;
  const int index = gw->selectedThreadIndex();
  const ThreadOption* row = gw->thread((size_t)(index < 0 ? 0 : index));
  return (row && row->selected) ? row : nullptr;
}

// The bound thread's status word, or nothing when the list has not been fetched.
const char* selectedThreadStatusWord() {
  const ThreadOption* row = boundThreadRow();
  return row ? threadStatusWord(row->status) : "";
}

OrbPresentation presentationForState() {
  // 1. The microphone, above everything. "Listening" means the ADC is open and a clip is growing —
  //    not that a screen with a microphone on it happens to be showing, and not that a finished
  //    clip is waiting to be sent. It is the one state the person is directly causing.
  if (audio::recording()) return {OrbMode::Wave, "Listening", false};

  if (!gw || !prov) return {OrbMode::Ring, "Starting", true};

  // 2. Getting onto a network and onto an account. Only one of these is genuinely "connecting":
  //    a device sitting on a revoked credential or an unreachable gateway is not establishing
  //    anything, and wiring a constellation together while it is stuck was the previous
  //    behaviour's plainest lie.
  switch (prov->status().state) {
    case ProvisioningState::Provisioning:  return {OrbMode::Ring, "Set up", true};
    case ProvisioningState::Failed:        return {OrbMode::Ring, "Wi-Fi failed", true};
    case ProvisioningState::Unprovisioned: return {OrbMode::Ring, "Not set up", true};
    case ProvisioningState::Connecting:    return {OrbMode::Web, "Joining", false};
    case ProvisioningState::Online:        break;
  }

  switch (gw->link()) {
    case GatewayLink::NoIdentity:  return {OrbMode::Ring, "Not set up", true};
    case GatewayLink::Revoked:     return {OrbMode::Ring, "Revoked", true};
    case GatewayLink::Unreachable: return {OrbMode::Ring, "No gateway", true};
    case GatewayLink::Unclaimed:   return {OrbMode::Ring, "Claim me", true};
    // Online, and the first cycle has not come back yet. This is the real one.
    case GatewayLink::Idle:
    case GatewayLink::Connecting:  return {OrbMode::Web, "Connecting", false};
    case GatewayLink::Claimed:     break;
  }

  // 3. A command parked by policy outranks any amount of agent activity, because it is the only
  //    thing on this device that cannot proceed without a person. The action bar says REVIEW at
  //    the same moment for the same reason.
  if (gw->hasBlockingRequests()) return {OrbMode::Ring, deviceBlockerLabel(gw->blockerKind()), true};

  // 4. The voice note, while one is in flight.
  //
  //    Everything after the POST happens on the gateway and used to be completely invisible here:
  //    the board uploaded a clip and then showed whatever the thread happened to be doing, which
  //    for the twenty seconds of a CPU transcription is nothing at all.
  //
  //    Ready and Sent are deliberately absent. At that point the journey is over and the ordinary
  //    table below is more truthful than anything this block could say — it will show Working if
  //    the turn really is in flight, and the actual state if the dispatch was refused. Forcing
  //    "Working" here would claim an agent was busy on a send that policy had already blocked.
  switch (voice.stage()) {
    case VoiceStage::Uploading:
      // Bytes move on the network worker; the render task keeps animating and handling Back.
      return {OrbMode::Ribbon, "Sending", false};
    case VoiceStage::Transcribing:
      // The scan meridian sweeping a dotted globe is a genuinely good read for ASR working through
      // a clip, and this is the first real trigger `searching` has ever had on this device.
      return {OrbMode::Globe, "Transcribing", false};
    case VoiceStage::Ready:
      if (voice.tracking()) return {OrbMode::Ribbon, "Sending to agent", false};
      return {OrbMode::Ring, "Ready in console", true};
    case VoiceStage::Review:
      // A STOP. The normaliser changed something a person has to look at before it is dispatched,
      // so this must not animate as work in progress.
      return {OrbMode::Ring, voice.reviewReason() == "gateway_approval" ? "Approval needed"
        : voice.reviewReason() == "transcript_review" ? "Review transcript" : "Needs you", true};
    case VoiceStage::Failed:
      return {OrbMode::Ring, "Voice failed", true};
    default:
      break;
  }

  // 4. The turn in front of us. `waiting` and `streaming` were previously both "working"; they are
  //    different facts. Waiting is the agent thinking with nothing to show. Streaming is text
  //    arriving right now, which is what "composing" means.
  if (gw->responseOpen()) {
    const ThreadResponse& r = gw->response();
    if (stateIs(r.state, "streaming")) return {OrbMode::Ribbon, "Composing", false};
    if (stateIs(r.state, "error"))     return {OrbMode::Ring, "Failed", true};
    if (gw->responseInFlight())        return {OrbMode::Orbits, "Working", false};
  }

  // 5. The selected thread's own status.
  const ThreadOption* selected = boundThreadRow();
  if (selected && selected->status.length() > 0) {
    const String& st = selected->status;
    // The animation, paired with the word threadStatusWord() gives the same status — the two are
    // kept beside each other here precisely so they cannot drift.
    if (stateIs(st, "running") || stateIs(st, "working"))     return {OrbMode::Orbits, "Working", false};
    if (stateIs(st, "streaming"))                             return {OrbMode::Ribbon, "Composing", false};
    // A session coming up is establishing something, which is the honest reading of the
    // constellation. The word says which kind of coming-up it is.
    if (stateIs(st, "starting"))                              return {OrbMode::Web, "Starting", false};
    if (stateIs(st, "error") || stateIs(st, "failed"))        return {OrbMode::Ring, "Failed", true};
    if (stateIs(st, "completed") || stateIs(st, "complete"))  return {OrbMode::Ring, "Done", false};
    if (stateIs(st, "stopped") || stateIs(st, "idle")
        || stateIs(st, "empty"))                              return {OrbMode::Ring, "Idle", false};
    // Unrecognised. Ask the shared mapper in case the gateway has grown a verb since this table
    // was written; if it has nothing either, say so rather than picking a busy animation.
    const OrbMode mapped = orbModeForAgentState(st);
    if (mapped != OrbMode::Ring) return {mapped, orbLabelForMode(mapped), false};
    return {OrbMode::Ring, "Ready", false};
  }

  // 6. No thread selected: the account's own state, which is all the display payload carries.
  const String& shown = gw->display().state;
  if (stateIs(shown, "setup")) return {OrbMode::Ring, "Set up", true};
  if (stateIs(shown, "boot"))  return {OrbMode::Ring, "Starting", false};
  if (stateIs(shown, "error")) return {OrbMode::Ring, "Failed", true};
  // The picker line under the orb says this far better than a word can, so it keeps the prominent
  // slot rather than being displaced by a caption for it.
  if (!haveThread())           return {OrbMode::Ring, "No thread", false};
  return {OrbMode::Ring, "Ready", false};
}

void setMode(OrbMode mode) {
  currentMode = mode;
  orb.setMode(mode);
  miniOrb.setMode(mode);
}

// Applies both halves at once. The label is a `const char*` and is assigned into `statusLabel`
// without a String temporary, which is what keeps this off the per-frame allocation path.
void applyPresentation() {
  const OrbPresentation next = presentationForState();
  currentLabel = next.label;
  currentSpeaks = next.speaks;
  if (next.mode != currentMode) setMode(next.mode);
}

// ---------------------------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------------------------

String gatewayLine() {
  if (!gw) return String();
  switch (gw->link()) {
    case GatewayLink::Claimed:     return gw->display().line2;
    case GatewayLink::Unclaimed:   return "Waiting to be claimed";
    case GatewayLink::Revoked:     return "Hold BOOT 10s to reset";
    case GatewayLink::NoIdentity:  return "Factory flash needed";
    case GatewayLink::Unreachable: return store ? store->gatewayUrl() : String();
    default:                       return gatewayStatusText(gatewayStatus());
  }
}

// Lays the orb, the label and up to two lines out as one block, centred in the space available.
//
// `bottom` is contentBottom() everywhere except the claim screen, where the claim block owns the
// lower half and the orb centres in what is left above it.
Stack layOutStack(bool showLabel, bool line1, bool line2, int16_t bottom, bool action = false,
                  bool line1Big = false) {
  Stack out;
  out.label = showLabel;
  out.line1 = line1;
  out.line2 = line2;

  // How far the ink reaches BELOW the orb's centre. Everything else follows from the centre, so the
  // block's height is this plus the ink radius above it.
  out.action = action;
  int16_t below = showLabel ? (int16_t)(kLabelDrop + kLabelInkH) : kOrbBlitR;
  if (line1) below = (int16_t)(below + kGapLabelLine + (line1Big ? kLabelInkH : kLineH));
  if (line2) below = (int16_t)(below + kGapLine + kLineH);
  if (action) below = (int16_t)(below + kGapLineAction + kActionRowBand);

  const int16_t height = (int16_t)(kOrbInkR + below);
  const int16_t space = (int16_t)(bottom - kContentTop);
  int16_t cy = (int16_t)(kContentTop + (space - height) / 2 + kOrbInkR);

  // The ink is narrower than the blit, so centring the ink can push the 148 px disc up into the
  // header. The disc is what actually gets written, so it is the thing that has to be clamped.
  if (cy < kContentTop + kOrbBlitR) cy = (int16_t)(kContentTop + kOrbBlitR);

  out.orbCy = cy;
  out.labelY = (int16_t)(cy + kLabelDrop);
  // Without a label the block still has to clear the orb's BLIT, not merely its ink, or the first
  // line lands inside the disc that gets rewritten every frame.
  int16_t cursor = showLabel ? (int16_t)(out.labelY + kLabelInkH) : (int16_t)(cy + kOrbBlitR);
  if (line1) {
    out.line1Y = (int16_t)(cursor + kGapLabelLine);
    cursor = (int16_t)(out.line1Y + (line1Big ? kLabelInkH : kLineH));
  }
  if (line2) {
    out.line2Y = (int16_t)(cursor + kGapLine);
    cursor = (int16_t)(out.line2Y + kLineH);
  }
  if (action) out.actionY = (int16_t)(cursor + kGapLineAction);
  return out;
}

// ---------------------------------------------------------------------------------------------
// HOME: the orb, and the destination
// ---------------------------------------------------------------------------------------------

// The OPEN control, centred under the picker line.
Rect homeActionRect() {
  return {(int16_t)(kW / 2 - 46), stack.actionY, 92, kActionRowBand};
}

int boundThreadIndex() {
  if (!gw) return -1;
  // A thread this device just created is bound by definition — the gateway said so in the 201 —
  // and the client's own rows still mark the previous one, so the overlay has to win here too.
  if (createdRowLive()) return (int)gw->threadCount();
  for (size_t i = 0; i < gw->threadCount(); i += 1) {
    const ThreadOption* row = gw->thread(i);
    if (row && row->selected) return (int)i;
  }
  return -1;
}

// The picker's slots are the rows PLUS one past the end, which is NEW THREAD.
//
// Putting it there rather than on a button of its own is what makes it reachable in the state that
// needs it most: a project with no threads has no rows, so the virtual slot is the only slot and
// the screen opens on it already offering the way out.
int pickerSlotCount() { return (int)threadRowCount() + 1; }

int pickerSlot() {
  const int slots = pickerSlotCount();
  if (pickerIndex >= 0 && pickerIndex < slots) return pickerIndex;
  const int bound = boundThreadIndex();
  return bound >= 0 ? bound : slots - 1;
}

bool pickerOnNew() { return pickerSlot() == (int)threadRowCount(); }

// What the line is pointing at: a row index, or -1 when it is on the virtual slot.
int pickerTarget() {
  const int slot = pickerSlot();
  return slot < (int)threadRowCount() ? slot : -1;
}

// A selection the user has made but the gateway has not yet been told about. The virtual slot is
// never pending — there is nothing to bind until it is pressed.
bool pickerPending() {
  return pickerCommitAt != 0 && !pickerOnNew() && pickerTarget() != boundThreadIndex();
}

// HOME's layout is computed from STRUCTURE. Never from content.
//
// This is the third variant of one bug in this file. The first two were residue — text drawn over
// text — and this one is worse, because nothing is left behind: the whole block simply moves. Two
// content-derived values were feeding layOutStack(), which centres whatever block it is handed:
//
//   `big`, from `prominent.length() <= 19`, changed the first line's reserved height between 16 px
//   and 8 px, and
//   `secondary.length() > 0` decided whether the second line existed at all.
//
// So the moment a status word changed length, or `speaks` flipped and swapped a thread name for
// "Needs you", the measured height changed, the centring moved, and the orb, both lines AND the
// OPEN button all walked a few pixels. Every repaint landed somewhere slightly different. That is
// the drift in the photographs.
//
// HOME now always reserves the same four bands whether or not it has anything to put in them. The
// only input is contentBottom(), which moves when the action bar appears — a genuine structural
// change and the one case where the composition SHOULD re-centre. Content decides what is drawn
// inside a band; it never decides where the band is.
//
// Deliberately not cached: the layout is a pure function of one structural input, so recomputing it
// yields an identical answer unless the structure really changed. That is a stronger guarantee than
// a cache, which could go stale.
Stack homeStack() {
  return layOutStack(/*showLabel=*/false, /*line1=*/true, /*line2=*/true, contentBottom(),
                     /*action=*/true, /*line1Big=*/true);
}

HomePickerVisual homePickerVisual(int slot, bool pending) {
  const bool onNew = slot == (int)threadRowCount();
  const int target = slot >= 0 && slot < (int)threadRowCount() ? slot : -1;
  const ThreadOption* row = (target >= 0) ? threadRowAt((size_t)target) : nullptr;

  // The destination, by name. Never an id — see threadTitle().
  String name;
  if (onNew) {
    name = threadRowCount() == 0 ? String("No threads yet") : String("New thread");
  } else if (row && row->title.length() > 0) {
    name = row->title;
  } else if (haveThread()) {
    // Bound, but the list has not arrived yet, so the title is not known here. This must not read
    // as "no thread": the device HAS a destination, it just cannot name it for another moment.
    name = threadListKnown() ? String("Selected thread") : String("Loading threads");
  } else if (!threadListKnown()) {
    name = "Loading threads";
  } else {
    // The case that matters most. A person about to hold the microphone with nothing bound would be
    // speaking into the void, so this says so plainly and OPEN becomes CHOOSE.
    name = "No thread selected";
  }

  HomePickerVisual visual;

  // THE RULE. See OrbPresentation::speaks: the name wins unless the state is something the orb has
  // no animation for, in which case the word is the only way to know and it takes the big line.
  const String prominent = currentSpeaks ? String(currentLabel) : name;

  String secondary;
  if (pickerBinding) secondary = "Selecting...";
  else if (pending) secondary = "Swipe to choose - not sent yet";
  else if (message.length() > 0) secondary = message;
  else if (onNew) secondary = "Creates one and points here";
  else if (currentSpeaks) secondary = name;
  else {
    const char* word = row ? threadStatusWord(row->status) : "";
    secondary = strlen(word) > 0 ? String(word) : String(currentLabel);
  }

  // A title too long for size 2 drops to size 1 rather than being cut down to something that no
  // longer identifies the thread — but it is drawn CENTRED IN THE SAME BAND, so changing size moves
  // the glyphs within the band and never moves the band.
  visual.big = prominent.length() <= kCols2;
  visual.prominent = uip::fitWords(prominent, visual.big ? kCols2 : kCols1);
  visual.secondary = uip::fitWords(secondary, kCols1);
  visual.verb = haveThread() ? "REPLY" : "CHOOSE";
  // The title is the brightest thing on the screen, as in the reference design. A selection that
  // has not been committed is the exception: it recedes, and the warning takes the brightness,
  // because the line must never look more certain than it is.
  visual.prominentTone = pending ? kMuted : kBright;
  visual.secondaryTone = pending ? kBright : kMuted;
  return visual;
}

void drawHomePickerVisual(const HomePickerVisual& visual, int16_t offsetX) {
  const uint8_t size = visual.big ? 2 : 1;
  const int16_t promY = visual.big
    ? stack.line1Y : (int16_t)(stack.line1Y + (kLabelInkH - kLineH) / 2);
  const int16_t prominentW = (int16_t)(visual.prominent.length() * 6 * size);
  const int16_t secondaryW = (int16_t)(visual.secondary.length() * 6);
  uip::text((int16_t)((kW - prominentW) / 2 + offsetX), promY, size, visual.prominentTone,
            visual.prominent);
  uip::text((int16_t)((kW - secondaryW) / 2 + offsetX), stack.line2Y, 1,
            visual.secondaryTone, visual.secondary);

  Rect action = homeActionRect();
  action.x = (int16_t)(action.x + offsetX);
  if (action.x < kW && action.x + action.w > 0) {
    uip::button(action, visual.verb, true, true);
  }
}

void drawHomePickerChevrons() {
  // The swipe affordance. Only drawn when there is somewhere to swipe to, because a chevron that
  // does nothing is worse than no chevron.
  if (pickerSlotCount() > 1) {
    const Rect action = homeActionRect();
    const int16_t cy = (int16_t)(action.y + action.h / 2);
    uip::chevron((int16_t)(action.x - 18), cy, 5.0f, -1, kHair, 2.0f);
    uip::chevron((int16_t)(action.x + action.w + 18), cy, 5.0f, 1, kHair, 2.0f);
  }
}

void paintHome() {
  stack = homeStack();
  clearContent();
  drawHomePickerVisual(homePickerVisual(pickerSlot(), pickerPending()), 0);
}


// Records why the next content repaint was asked for, unless something already asked.
void noteContentCause(uint8_t cause) {
  UI_PROFILE(if (!contentDirty && pendingContentCause == kNoCause) pendingContentCause = cause;)
  (void)cause;
}
void markContentDirty(uint8_t cause) {
  noteContentCause(cause);
  contentDirty = true;
}

// The rows paintHome() actually has to rewrite when only the MODEL moved: the two text lines and
// the OPEN button. Everything above them is the orb's box (rewritten by the orb every frame, with
// 12 px of gap before line 1 by construction in layOutStack()) and plain ground, so repainting it
// is 60% of a content compose spent re-publishing pixels that cannot have changed. A 4 px margin
// each side covers the button's anti-aliased edge.
bool homeTextRows(int16_t& top, int16_t& end) {
  top = (int16_t)max<int>(kContentTop, stack.line1Y - 4);
  end = (int16_t)min<int>(contentBottom(), stack.actionY + kActionRowBand + 4);
  return end > top;
}

// A model change (gateway revision, browse revision) used to mean a full content repaint on every
// screen, however little had changed. On HOME the model can only change the text and the button,
// and only if the STRUCTURE is the same: if the layout inputs moved (the action bar appeared and
// re-centred the composition) the whole block moved and the answer is a full repaint.
//
// Safe because every other reason to repaint — arrival, drawer retraction, modal, picker commit,
// message — still sets contentDirty directly and wins. This path only ever REPLACES a full request
// that would have been the bare "model moved" kind, and it falls back to the full request whenever
// anything is unsettled.
void markContentForModelChange(uint8_t cause) {
  if (contentDirty) return;                                   // a full repaint is already pending
  if (contentJob.active && !contentJob.partial) { markContentDirty(cause); return; }  // restart fresh
  const bool settledHome = screen == Screen::Home && modal == Modal::None && !pickerMotion.active
    && drawerT <= 0.001f && viewKey() == paintedViewKey;
  if (settledHome) {
    const Stack now = homeStack();
    if (now.orbCy == stack.orbCy && now.line1Y == stack.line1Y && now.line2Y == stack.line2Y
        && now.actionY == stack.actionY) {
      noteContentCause(cause);
      homeTextDirty = true;
      return;
    }
  }
  markContentDirty(cause);
}

bool homePickerSlotPending(int slot) {
  return slot >= 0 && slot < (int)threadRowCount() && slot != boundThreadIndex();
}

// Repaints only the carousel's bands. The orb and header stay untouched, which both makes the
// gesture read as movement within HOME and keeps the redraw comfortably inside one frame.
void paintHomePickerMotion() {
  if (!pickerMotion.active || screen != Screen::Home) return;
  stack = homeStack();
  const Rect action = homeActionRect();
  const int16_t top = (int16_t)(stack.line1Y - 2);
  const int16_t bottom = (int16_t)(action.y + action.h + 3);
  g().fillRect(0, top, kW, (int16_t)(bottom - top), panelGrey(kBg));

  const int16_t outgoingX = (int16_t)lroundf(pickerMotion.offset);
  drawHomePickerVisual(pickerMotion.from, outgoingX);
  if (pickerMotion.direction != 0) {
    const int16_t incomingX = (int16_t)(outgoingX + pickerMotion.direction * kW);
    drawHomePickerVisual(pickerMotion.to, incomingX);
  }
  drawHomePickerChevrons();
}

void updateHomePickerDrag(int16_t travelX) {
  return; // Destination preview belongs to Choose, never the active Thread view.
  if (screen != Screen::Home || modal != Modal::None || drawerT > 0.05f) return;

  const int fromSlot = pickerSlot();
  const int8_t direction = travelX < 0 ? 1 : (travelX > 0 ? -1 : 0);
  int toSlot = fromSlot + direction;
  const bool atWall = direction == 0 || toSlot < 0 || toSlot >= pickerSlotCount();

  float offset = (float)travelX;
  if (offset < -kW * 0.82f) offset = -kW * 0.82f;
  if (offset > kW * 0.82f) offset = kW * 0.82f;
  // Resistance at either end makes the boundary tangible without letting the selector disappear.
  if (atWall) offset *= 0.24f;

  if (!pickerMotion.active || !pickerMotion.dragging || pickerMotion.direction != direction) {
    pickerMotion.from = homePickerVisual(fromSlot, pickerPending());
    pickerMotion.to = atWall ? HomePickerVisual()
                             : homePickerVisual(toSlot, homePickerSlotPending(toSlot));
  }
  pickerMotion.active = true;
  pickerMotion.dragging = true;
  pickerMotion.direction = atWall ? 0 : direction;
  pickerMotion.offset = offset;
}

void settleHomePickerBack() {
  if (!pickerMotion.active || !pickerMotion.dragging) return;
  pickerMotion.dragging = false;
  pickerMotion.startOffset = pickerMotion.offset;
  pickerMotion.targetOffset = 0.0f;
  pickerMotion.startedAt = millis();
}

bool advanceHomePickerMotion(uint32_t now) {
  if (!pickerMotion.active) return false;
  if (pickerMotion.dragging) return true;

  const uint32_t elapsed = now - pickerMotion.startedAt;
  const float t = elapsed >= kPickerSlideMs ? 1.0f : (float)elapsed / (float)kPickerSlideMs;
  const float eased = uip::easeOutCubic(t);
  pickerMotion.offset = pickerMotion.startOffset
    + (pickerMotion.targetOffset - pickerMotion.startOffset) * eased;
  if (t < 1.0f) return true;

  pickerMotion.active = false;
  pickerMotion.direction = 0;
  pickerMotion.offset = 0.0f;
  // Replace the final carousel frame with the canonical settled HOME paint. This also picks up any
  // gateway revision that arrived during the 190 ms motion.
  contentDirty = true;
  return false;
}

// The claim screen. A brand-new controller has one job: tell its owner how to take possession of
// it. There is no printed code — this screen is the only place the code is ever shown — so it
// outranks every other thing the device could say, including the shimmer label, whose strip lands
// exactly here, which is why unclaimed() gates it rather than the two overlapping.
//
// It is also the one screen with no action bar. Rotating the code is a real action, but it is
// destructive of the number the owner may be part-way through typing, so it stays behind a tap on
// the code itself rather than sitting under their thumb.
constexpr int16_t kClaimTop = 210;

void paintStatus() {
  if (unclaimed()) {
    // No label and no lines here — the claim block owns everything from kClaimTop down, and the orb
    // centres in the band above it.
    stack = layOutStack(true, false, false, (int16_t)(kClaimTop - 6));
    stack.label = false;   // the claim block owns this band; the shimmer would sit on top of it
    clearContent();
    const String code = gw->claimCode();
    uip::textCentered(kClaimTop, 1, kMuted, "CLAIM THIS CONTROLLER");
    if (code.length() > 0) {
      // The largest thing on the screen: it is read from across a desk and typed by hand into
      // another device.
      const int16_t codeW = (int16_t)(code.length() * 18);
      uip::text((int16_t)((kW - codeW) / 2), kClaimTop + 18, 3, kBright, code);
    } else {
      // Transient: the device asks the gateway to mint one as soon as it knows it is unowned.
      uip::textCentered(kClaimTop + 22, 2, kMuted, "Getting code...");
    }
    const String steps[3] = {
      store && store->gatewayUrl().length() ? store->gatewayUrl() : String("Open the console"),
      String("Devices  >  Claim"),
      String("Tap the code to replace it"),
    };
    int16_t y = kClaimTop + 52;
    for (uint8_t i = 0; i < 3; ++i) {
      uip::dot(22, (int16_t)(y + 3), 2.5f, kHair);
      uip::text(34, y, 1, kMuted, uip::fit(steps[i], 32));
      y += 16;
    }
    return;
  }

  const String line1 = gatewayLine();
  String line2;
  if (prov && prov->status().state == ProvisioningState::Provisioning) {
    line2 = String("Join ") + prov->status().apName;
  } else {
    line2 = message;
  }

  stack = layOutStack(true, line1.length() > 0, line2.length() > 0, contentBottom());
  clearContent();
  if (stack.line1) uip::textCentered(stack.line1Y, 1, kMuted, uip::fitWords(line1, kCols1));
  if (stack.line2) uip::textCentered(stack.line2Y, 1, kHair, uip::fitWords(line2, kCols1));
}

// ---------------------------------------------------------------------------------------------
// Threads, and the two levels above it
// ---------------------------------------------------------------------------------------------

constexpr Rect kBreadcrumb = {12, kContentTop + 4, kW - 24, 30};
constexpr int16_t kThreadListTop = kContentTop + 56;
constexpr int16_t kThreadRowH = 48;

// The breadcrumb is the entry to the browser, and it is a capsule rather than a line of text
// because it is a control: it says where the work is going AND opens the list of somewhere else.
void paintBreadcrumb() {
  uip::capsule(kBreadcrumb, (int16_t)kSurface, (int16_t)kHair, 1.2f);
  // A name, or an admission that we do not have one yet. This used to fall back to
  // context().environmentId, which put `jn72kshfoxn642tdlhsjspv1e58o34` across the top of the
  // thread list — thirty characters that identify the environment to the gateway and to nobody
  // standing in front of the device. The list is fetched on the way into this screen, so the gap
  // lasts one request rather than forever.
  String where = browse.environmentLabel();
  if (where.length() == 0) {
    where = gw->context().environmentId.length() > 0 ? String("Environment")
                                                     : String("No environment");
  }
  const String project = browse.projectLabel();
  if (project.length() > 0) where += String("  /  ") + project;
  uip::text(kBreadcrumb.x + 14, (int16_t)(kBreadcrumb.y + 11), 1, kText, uip::fitWords(where, 32));
  uip::chevron((int16_t)(kBreadcrumb.x + kBreadcrumb.w - 16),
               (int16_t)(kBreadcrumb.y + kBreadcrumb.h / 2), 5.0f, 1, kMuted, 2.0f, kSurface);
}

// A scrolling list has no clipping, so it has to be given one.
//
// Adafruit_GFX draws wherever it is told; there is no scissor rectangle. A row scrolled half out of
// the top of the viewport therefore drew its title and its status line straight over the section
// heading and the breadcrumb above it — on glass, a thread title landing on the breadcrumb capsule
// and a "STOPPED" landing on "5 THREADS". Two rules fix it, and both are needed:
//
//   TOP     rows are painted FIRST and the fixed chrome above them is repainted on top afterwards,
//           so anything that overran is covered. Pixel-accurate scrolling survives; the header
//           always wins.
//   BOTTOM  a row is skipped once its own INK would cross the viewport floor — the floor is the
//           action tray, and a row half under it cannot be covered by anything.
//
// kRowInk is how far down a row its last pixel of text reaches, and it is the measurement the
// bottom rule is made against rather than the row pitch, which includes the gap below it.
constexpr int16_t kRowInk = 34;

// And the same measurement at the TOP, which is the half that was missing.
//
// The top rule used to skip a row only once it was ENTIRELY above kContentTop — so a row scrolled
// most of the way out still drew, and its ink landed in the HEADER, which no list screen clears.
// On ACTIONS that put a control's label at y+6 directly under the device name: two strings at
// almost the same origin, stacked and unreadable. Repainting the chrome afterwards could not cover
// it, because the chrome band starts at kContentTop and the ink was above it.
//
// So the rule is now the row's TOPMOST DRAWN PIXEL, and the invariant is absolute: nothing a list
// draws ever lands above kContentTop. What disappears at the moment a row is dropped is already
// underneath the chrome band, so nothing readable is lost.
constexpr int16_t kChoiceRowInkTop = 2;    // the selected row's card, which starts before its text
constexpr int16_t kActionRowInkTop = 6;    // the control's label

// One row of any of the three lists. They are the same shape on purpose: an environment, a folder
// and a thread are the same kind of choice at three depths, and a person should not have to relearn
// the row between them.
//
// `accentLabel` is the word that says the row is the LIVE one — the thread this device is bound
// to. It is the accent because "this is where your voice goes" is a fact about right now, and the
// accent is what the console spends on facts about right now.
void paintChoiceRow(int16_t y, int16_t rowH, const String& title, const String& meta,
                    bool selected, bool last, const char* accentLabel = nullptr) {
  if (selected) {
    uip::card({8, (int16_t)(y + 2), (int16_t)(kW - 16), (int16_t)(rowH - 10)}, 14.0f,
              (int16_t)kSurface, -1, 0.0f, 1.6f);
    // Composited against the card it sits on, not against the ground: an anti-aliased edge blended
    // towards the wrong colour draws a dark halo, which is the one artefact that makes a soft shape
    // look worse than a hard one.
    //
    // The marker is the accent: the selection is one of the three facts the violet is spent on,
    // and it is the only thing on a row that says which row this is.
    uip::accentMarker(14, (int16_t)(y + 10), (int16_t)(rowH - 26), kSurface);
  }
  uip::text(26, (int16_t)(y + 9), 1, selected ? kBright : kText, uip::fitWords(title, 33));
  if (accentLabel) {
    uip::textAccent(26, (int16_t)(y + 25), 1, accentLabel);
    const int16_t metaX = (int16_t)(26 + strlen(accentLabel) * 6 + 6);
    uip::text(metaX, (int16_t)(y + 25), 1, selected ? kMuted : kHair, uip::fit(meta, 28));
  } else {
    uip::text(26, (int16_t)(y + 25), 1, selected ? kMuted : kHair, uip::fit(meta, 33));
  }
  if (!last && !selected) uip::divider(20, (int16_t)(y + rowH - 5), (int16_t)(kW - 40));
}

// The band above a list: everything that does not scroll. Repainted after the rows, so a row that
// scrolled up into it is covered rather than left showing through.
void paintThreadsChrome() {
  g().fillRect(0, kContentTop, kW, (int16_t)(kThreadListTop - kContentTop), panelGrey(kBg));
  paintBreadcrumb();
  // The metric line. The count is the answer and the word only names it — the rhythm the console
  // uses in its stat strip, which is the one thing a list of this size can carry.
  const size_t count = threadRowCount();
  if (message.length() > 0) uip::text(14, kContentTop + 42, 1, kMuted, uip::fitWords(message, 35));
  else uip::statLine(14, kContentTop + 40, String(count), "THREADS", kBright);
}

void paintThreads() {
  clearListRegion(kThreadListTop);

  const size_t count = threadRowCount();
  if (count == 0) {
    paintThreadsChrome();
    // The dead end this screen used to be. NEW THREAD is in the action bar below, primary and
    // enabled, so an empty folder is one press from having something to point at.
    uip::textCentered(kContentTop + 92, 1, kMuted,
                      uip::fit(browse.previewDetail().length() > 0 ? browse.previewDetail()
                                                                : String("No threads in this folder"),
                               kCols1));
    uip::textCentered(kContentTop + 112, 1, kHair, "Create one below");
    return;
  }

  const int16_t bottom = contentBottom();
  for (size_t i = 0; i < count; ++i) {
    const int16_t y = (int16_t)(kThreadListTop + (int16_t)i * kThreadRowH - threadScroll);
    if (y + kRowInk > bottom) break;
    if (y + kChoiceRowInkTop < kContentTop) continue;
    const ThreadOption* row = threadRowAt(i);
    if (!row) continue;
    const bool active = (int)i == (agentBrowseMode ? selectedAgentRow : previewThreadIndex);
    // "ACTIVE" says this is the thread the device is bound to; it is the accent, because it is
    // the one row whose state is about right now rather than about the past.
    paintChoiceRow(y, kThreadRowH, row->title, row->status, active, i + 1 == count,
                   active ? "USE BELOW" : (row->id == gw->context().threadId ? "CURRENT" : nullptr));
  }
  paintThreadsChrome();
}

constexpr int16_t kBrowseListTop = kContentTop + 34;
constexpr int16_t kBrowseRowH = 48;

// The heading band of a browse list. Cleared whole and repainted on top of the rows, for the same
// reason the thread list does it: a row scrolled halfway out of the viewport has already drawn its
// title up here, and there is no clipping to stop it.
void paintBrowseChrome(const char* label, size_t count) {
  g().fillRect(0, kContentTop, kW, (int16_t)(kBrowseListTop - kContentTop), panelGrey(kBg));
  uip::statLine(14, kContentTop + 6, String(count), label, kBright);
  if (message.length() > 0) uip::text(14, kContentTop + 23, 1, kMuted, uip::fitWords(message, 35));
}

void paintEnvironments() {
  clearListRegion(kBrowseListTop);
  const size_t count = browse.environmentCount();
  if (count == 0) {
    paintBrowseChrome("ENVIRONMENT", count);
    const String detail = browse.environmentsDetail();
    uip::textCentered(kContentTop + 100, 1, kMuted,
                      uip::fit(detail.length() > 0 ? detail : String("Tap RELOAD"), kCols1));
    return;
  }
  const int16_t bottom = contentBottom();
  for (size_t i = 0; i < count; ++i) {
    const int16_t y = (int16_t)(kBrowseListTop + (int16_t)i * kBrowseRowH - envScroll);
    if (y + kRowInk > bottom) break;
    if (y + kChoiceRowInkTop < kContentTop) continue;
    const BrowseEnvironment* row = browse.environment(i);
    if (!row) continue;
    // Show the first layer a person can act on. The shared helper gives connector reachability
    // priority over T3 and provider state, then freshness, so a sleeping computer never appears
    // to have a provider-only fault merely because its last catalogue was incomplete.
    const String meta = browseEnvironmentAction(*row);
    paintChoiceRow(y, kBrowseRowH, row->label, meta, row->selected, i + 1 == count);
  }
  paintBrowseChrome("ENVIRONMENT", count);
}

void paintProjects() {
  clearListRegion(kBrowseListTop);
  // There is no "all folders" row, and it is not an omission: POST /v1/device/config/project reads
  // `projectId` as a required string, so the device protocol offers no way to clear a folder once
  // one is bound. Widening the scope again is a console operation.
  const size_t count = browse.projectCount();
  if (count == 0) {
    paintBrowseChrome("FOLDER", count);
    const String detail = browse.projectsDetail();
    uip::textCentered(kContentTop + 100, 1, kMuted,
                      uip::fit(detail.length() > 0 ? detail : String("Tap RELOAD"), kCols1));
    return;
  }
  const int16_t bottom = contentBottom();
  for (size_t i = 0; i < count; ++i) {
    const int16_t y = (int16_t)(kBrowseListTop + (int16_t)i * kBrowseRowH - projectScroll);
    if (y + kRowInk > bottom) break;
    if (y + kChoiceRowInkTop < kContentTop) continue;
    const BrowseProject* row = browse.project(i);
    if (!row) continue;
    // The count is what makes this list usable at arm's length: it says which folder has anything
    // in it before somebody pages into an empty one.
    const String meta = row->threadCount == 1 ? String("1 thread")
                                              : String(row->threadCount) + " threads";
    paintChoiceRow(y, kBrowseRowH, row->title, meta, row->selected, i + 1 == count);
  }
  paintBrowseChrome("FOLDER", count);
}

// ---------------------------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// SEND: the voice screen, and only the voice screen
// ---------------------------------------------------------------------------------------------
//
// This screen used to carry the microphone AND the saved-actions list AND their RUN metadata, all
// at once, through every state of a capture — so the moment a person held the button to speak, the
// screen was still offering them four other things to press. The list has moved to its own screen
// (reachable from HOME, which is where it belongs); what is left here is one control and one fact:
// the record button, and the thread the recording is going to.
//
// Four views, one at a time:
//
//   Ready      the capsule, and the thread's title under it
//   Recording  the same capsule, animated, with the elapsed seconds
//   Held       the clip's length, and DISCARD / SEND in the action bar
//   Journey    the full page: the orb, running the animation for the stage the gateway last
//              reported, and no buttons at all

// ONE composition, four states. The capsule does not move between them.
//
// It used to be a fixed rect at the top of the content area, so it sat high; and because the action
// band only existed once there were buttons, it also sat 29 px lower in "clip ready" than in "hold
// to talk". Nothing about a capture changes the shape of this screen, so nothing about it may move:
// the block is measured from structure, centred once, and every state draws into the same bands.
//
// The orb is part of that block rather than in the header, because during a capture it IS the
// recording indicator.

// The orb is the main animation on this device and carries the same weight here as it does on
// every other screen. It was previously the 44 px mini orb under a 92 px capsule, which inverted
// that: the button dominated the glass and the orb read as a decoration above it. The proportions
// are now the other way round — the orb is the full 112 px one HOME draws, and the capsule is an
// ordinary button rather than a slab.
//
// 112 + 10 + 48 + 14 + 8 + 4 + 8 = 204 in the 206 px between the header and the action band, so
// the block still centres with the gaps trimmed rather than the orb.
constexpr int16_t kVoiceOrbR = (int16_t)(kOrbDrawPx / 2);
constexpr int16_t kVoiceGapOrbCapsule = 10;
constexpr int16_t kVoiceCapsuleH = 48;
constexpr int16_t kVoiceGapCapsuleLabel = 14;
constexpr int16_t kVoiceGapLabelName = 4;
constexpr int16_t kVoiceBlockH = kVoiceOrbR * 2 + kVoiceGapOrbCapsule + kVoiceCapsuleH
  + kVoiceGapCapsuleLabel + kLineH + kVoiceGapLabelName + kLineH;

// Where the capsule's own two lines sit, measured from the top of the capsule.
//
// Both live INSIDE the pill. They used to sit below it, which put them exactly where the
// destination block puts "SENDING TO" — three rows of overprint on every screen that is not in
// the middle of a capture. The pill is 48 px tall and a size-2 label is 14 px, so the two lines
// fit with room to spare.
constexpr int16_t kMicMainLine = 14;
constexpr int16_t kMicSubLine = 32;
// The one line that genuinely cannot fit inside the pill: the recording instruction. The gap
// between the capsule and "SENDING TO" is exactly fourteen pixels, which is one size-1 line.
constexpr int16_t kMicCaptionOutside = 50;

// A block taller than the band would centre to a negative top and slide the orb under the header.
// A build error is the right way to find that out.
static_assert(kVoiceBlockH <= kH - kBarH - kContentTop,
              "the voice block no longer fits between the header and the action band");

struct VoiceLayout {
  int16_t orbCy;
  int16_t capsuleY;
  int16_t labelY;
  int16_t nameY;
};

// Pure function of the panel and the reserved band, both of which are constants on this screen. It
// therefore returns the same answer in every state, which is the whole requirement.
VoiceLayout voiceLayout() {
  constexpr int16_t bottom = kH - kBarH;
  constexpr int16_t top = kContentTop + (bottom - kContentTop - kVoiceBlockH) / 2;
  VoiceLayout out;
  out.orbCy = top + kVoiceOrbR;
  out.capsuleY = (int16_t)(top + kVoiceOrbR * 2 + kVoiceGapOrbCapsule);
  out.labelY = (int16_t)(out.capsuleY + kVoiceCapsuleH + kVoiceGapCapsuleLabel);
  out.nameY = (int16_t)(out.labelY + kLineH + kVoiceGapLabelName);
  return out;
}

Rect micButtonRect() {
  return {14, voiceLayout().capsuleY, (int16_t)(kW - 28), kVoiceCapsuleH};
}

enum class VoiceView : uint8_t { Ready, Recording, Held, Journey };

// True while the gateway is doing something with a clip that has already left the board.
bool voiceInJourney() {
  switch (voice.stage()) {
    case VoiceStage::Uploading:
    case VoiceStage::Transcribing:
    case VoiceStage::Ready:
    case VoiceStage::Review:
    case VoiceStage::Failed:
    case VoiceStage::Sent:
      return true;
    default:
      return false;
  }
}

bool voiceNeedsRecovery() {
  return voice.stage() == VoiceStage::Failed || voice.stage() == VoiceStage::Review
    || voice.stage() == VoiceStage::Sent
    || (voice.stage() == VoiceStage::Ready && !voice.tracking());
}

VoiceView voiceView() {
  if (voiceInJourney()) return VoiceView::Journey;
  if (audio::recording()) return VoiceView::Recording;
  if (clipHeld) return VoiceView::Held;
  return VoiceView::Ready;
}

// The full-page voice moment owns the screen: SEND, no buttons, one orb in the middle of the page.
bool voiceOwnsScreen() {
  return screen == Screen::Send && voiceInJourney();
}

// Whether the mini orb belongs in the voice composition this frame rather than in the header.
bool voiceShowsOrb() {
  return screen == Screen::Send && !voiceInJourney() && modal == Modal::None;
}

// The elapsed seconds, and ONLY the elapsed seconds.
//
// This used to repaint the whole capsule four times a second, which is 19 500 pixels of fill and
// about 4 ms — spent between two pumps of an I2S ring that holds only tens of milliseconds. A band
// the width of the text and a redraw at a fixed origin is 2 400 pixels and about 0.5 ms, and it
// buys most of the budget the orb now needs.
void paintMicTimer(uint32_t ms) {
  const Rect capsule = micButtonRect();
  const int16_t y = (int16_t)(capsule.y + kMicSubLine);
  // The band is cleared in the capsule's own colour. It is inset far enough to stay inside the
  // pill's flat middle, because the ends of a capsule are curved and a hard rectangle across them
  // would draw a step that the shape itself does not have.
  g().fillRect((int16_t)(capsule.x + 26), (int16_t)(y - 2), (int16_t)(capsule.w - 52), 9,
               panelAccent());
  char buf[16];
  snprintf(buf, sizeof(buf), "%u.%us", (unsigned)(ms / 1000), (unsigned)((ms % 1000) / 100));
  uip::textCentered(y, 1, kBg, buf);
}

// The capsule and its words. Drawn on arrival at a state, not on a timer.
//
// The capsule holds two lines: the main label and a sub-line. Both used to sit OUTSIDE the
// capsule — "press and speak" was drawn at capsule.y + 58 and "release to stop" at capsule.y + 64,
// which is where "SENDING TO" is drawn as well. Those three strings overprinted each other by
// three rows and nobody had photographed that screen. Everything the capsule says now lives
// inside the capsule, and the one line that has to sit outside it (the recording instruction)
// goes in the fourteen pixels between the capsule and the destination block.
void paintMicButton() {
  const bool have = audio::available();
  const bool live = audio::recording();
  const Rect capsule = micButtonRect();

  // A capsule, and at this height the radius is 46 px — there is no corner on it at all, which is
  // the point: the one thing on this screen a thumb lands on should not be a box.
  if (!have) {
    uip::capsule(capsule, -1, (int16_t)kHair, 1.4f, 1.6f);
    uip::textCentered((int16_t)(capsule.y + kMicMainLine), 2, kHair, "NO MIC");
    uip::textCentered((int16_t)(capsule.y + kMicSubLine), 1, kHair, "flash the -controller build");
    return;
  }
  if (live) {
    // Filled, because the accent is the console's live signal and a recording IS live. The label
    // is the ground colour so it reads as cut out of the pill.
    uip::accentCapsule(capsule);
    uip::textCentered((int16_t)(capsule.y + kMicMainLine), 2, kBg, "RECORDING");
    paintMicTimer(audio::recordedMs());
    uip::textCentered((int16_t)(capsule.y + kMicCaptionOutside), 1, kMuted, "release to stop");
    return;
  }
  // Idle and held share the capsule's treatment: an outlined accent pill, because the action is
  // waiting for a thumb rather than happening.
  uip::accentOutline(capsule, 1.8f);
  if (clipHeld) {
    char buf[16];
    snprintf(buf, sizeof(buf), "%u.%us CLIP", (unsigned)(clipHeldMs / 1000),
             (unsigned)((clipHeldMs % 1000) / 100));
    uip::textCentered((int16_t)(capsule.y + kMicMainLine), 2, kText, buf);
    uip::textCentered((int16_t)(capsule.y + kMicSubLine), 1, kMuted,
      uip::fitWords(message.length() > 0 ? message : String("send or discard below"), kCols1));
    return;
  }
  uip::textCentered((int16_t)(capsule.y + kMicMainLine), 2, kText, "HOLD TO TALK");
  uip::textCentered((int16_t)(capsule.y + kMicSubLine), 1, kMuted,
    uip::fitWords(message.length() > 0 ? message : String("press and speak"), kCols1));
}

// Where the clip is going. The thread's own title, so a person knows before they speak.
void paintMicDestination() {
  const VoiceLayout at = voiceLayout();
  String where;
  uint8_t tone = kText;
  if (voice.stage() != VoiceStage::Idle && voiceCaptureThread.length() > 0) {
    where = voiceCaptureTitle.length() > 0 ? voiceCaptureTitle : String("Original thread");
  } else if (!haveThread()) {
    where = "No thread selected";
    tone = kBright;
  } else {
    const String title = threadTitle();
    // Never the id. The gateway cycle keeps the thread list warm, so this is the boot-window case.
    where = title.length() > 0 ? title : String("Selected thread");
  }
  uip::textCentered(at.labelY, 1, kHair,
    voice.stage() != VoiceStage::Idle ? "RECORDED FOR" : "SENDING TO");
  uip::textCentered(at.nameY, 1, tone, uip::fitWords(where, kCols1));
}

void paintSend() {
  if (voiceView() == VoiceView::Journey) {
    // The full-page moment. The orb is drawn by the frame loop at stack.orbCy; all this has to do
    // is lay the block out and say which stage it is.
    const String detail = voice.detail();
    const String target = voiceCaptureTitle.length() > 0 ? voiceCaptureTitle : String("Original thread");
    stack = layOutStack(true, true, true, contentBottom());
    clearContent();
    uip::textCentered(stack.line1Y, 1, kMuted, uip::fitWords(String("To: ") + target, kCols1));
    uip::textCentered(stack.line2Y, 1, kMuted,
      uip::fitWords(message.length() > 0 ? message : detail, kCols1));
    return;
  }

  clearContent();
  paintMicButton();
  paintMicDestination();
}

// ---------------------------------------------------------------------------------------------
// The saved actions, on their own screen
// ---------------------------------------------------------------------------------------------
//
// Moved off SEND, where they were four things to press in the middle of a voice interaction.
// Nothing was deleted: HOME's action bar offers ACTIONS whenever the owner has assigned any.

constexpr int16_t kActionListTop = kContentTop + 34;
constexpr int16_t kActionRowH = 42;

void paintActionsChrome() {
  g().fillRect(0, kContentTop, kW, (int16_t)(kActionListTop - kContentTop), panelGrey(kBg));
  // The same metric line as the other lists: how many are saved, and what they are.
  uip::statLine(14, kContentTop + 6, String(gw->controlCount()), "SAVED ACTIONS", kBright);
  if (message.length() > 0) uip::text(14, kContentTop + 23, 1, kMuted, uip::fitWords(message, 35));
}

void paintActions() {
  clearListRegion(kActionListTop);

  const size_t count = gw->controlCount();
  if (count == 0) {
    paintActionsChrome();
    uip::textCentered(kActionListTop + 40, 1, kHair, "None assigned - add them in the console");
    return;
  }

  const int16_t bottom = contentBottom();
  for (size_t i = 0; i < count; ++i) {
    const int16_t y = (int16_t)(kActionListTop + (int16_t)i * kActionRowH - actionScroll);
    // The saved-action row's ink stops at y+28: a label, and a reason under it when it is blocked.
    if (y + 28 > bottom) break;
    if (y + kActionRowInkTop < kContentTop) continue;
    const DeviceControl* c = gw->control(i);
    if (!c) continue;
    const bool blocked = !c->enabled || (c->requiresThread && !haveThread());
    uip::text(14, (int16_t)(y + 6), 1, blocked ? kHair : kText, uip::fitWords(c->label, 28));
    // The right-hand word is why the row will or will not do anything, which is the only thing a
    // person needs to read before pressing it.
    String meta = "RUN";
    if (!c->enabled) meta = "LOCK";
    else if (c->requiresThread && !haveThread()) meta = "THREAD";
    else if (c->kind == "capture_audio" || c->mediaKind == "audio") meta = "CONSOLE";
    else if (c->kind == "status") meta = "VIEW";
    else if (c->requiresConfirmation || c->kind == "stop" || c->kind == "reset") meta = "CONFIRM";
    uip::textRight((int16_t)(kW - 14), (int16_t)(y + 6), 1, kHair, meta);
    const String sub = blocked && c->reason.length() > 0 ? c->reason : String();
    if (sub.length() > 0) uip::text(14, (int16_t)(y + 20), 1, kHair, uip::fitWords(sub, 34));
    // Both the pitch and this offset come from kActionRowH, so they cannot drift apart. It is
    // placed midway between the deepest ink this row can have (a reason line, ending at y+28) and
    // the first ink of the next (its label, at y+kActionRowH+6), so the rhythm down the list is
    // even whether or not a given row happens to carry a reason.
    if (i + 1 < count) uip::divider(20, (int16_t)(y + kActionRowH - 4), (int16_t)(kW - 40));
  }
  paintActionsChrome();
}

// ---------------------------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------------------------

constexpr int16_t kReplyTextTop = kContentTop + 8;
constexpr int16_t kReplyLineH = 20;
// Gateway pages may wrap beyond this panel's six visible rows. Local subpages retain every line.
constexpr size_t kReplyMaxLines = 6;
size_t replyLocalPage = 0;
int replyRemotePage = -1;
int replyPendingRemotePage = -1;
size_t replyPendingLocalPage = 0;
String replyMessageId;
String replyCachedLines[kMaxResponseLines];
size_t replyCachedLineCount = 0;

ResponseLayout replyLayout(String* lines) {
  const ThreadResponse& r = gw->response();
  bool changed = replyRemotePage != r.page || replyMessageId != r.messageId
    || replyCachedLineCount != r.lineCount;
  for (size_t i = 0; i < r.lineCount; ++i) changed = changed || replyCachedLines[i] != r.lines[i];
  if (changed) {
    replyLocalPage = r.page == replyPendingRemotePage ? replyPendingLocalPage : 0;
    replyPendingRemotePage = -1;
    replyRemotePage = r.page;
    replyMessageId = r.messageId;
    replyCachedLineCount = r.lineCount;
    for (size_t i = 0; i < kMaxResponseLines; ++i) replyCachedLines[i] = r.lines[i];
  }
  const ResponseLayout layout = layoutResponsePage(r.lines, r.lineCount, kCols2,
    kReplyMaxLines, replyLocalPage, lines, kReplyMaxLines);
  replyLocalPage = layout.page;
  return layout;
}

void stepReplyPage(int direction);
constexpr Rect kFollowLeft = {12, kContentTop + 160, 106, 34};
constexpr Rect kFollowRight = {122, kContentTop + 160, 106, 34};

// ---------------------------------------------------------------------------------------------
// The reply is local-first
// ---------------------------------------------------------------------------------------------
//
// GatewayClient clears its reply model whenever the thread moves, so reopening a thread read a
// minute ago painted "No response open" for the whole of a gateway round trip while the text sat on
// the device. The UI keeps its own labelled copy of what it last SAW (ui_held_reply.h) and paints
// it while the real model revalidates. It is shown only for the bound thread, only while the live
// model has nothing readable of its own, and always as "UPDATING" with its age - never as live truth.

HeldReplies heldReplies;
uint32_t heldReplyCapturedRevision = 0;
uint32_t replyRefreshedAt = 0;
// A reply opened again within this long of its last read is not re-read just for being opened.
constexpr uint32_t kReplyFreshMs = 5000;

String heldReplyRealm;

// A reply is content from one gateway and one device identity. If either changes (a transfer reset,
// a re-claim, a gateway switch) nothing held may survive it to be shown to whoever uses it next.
void sealHeldRepliesToRealm() {
  const DeviceRequestSnapshot snapshot = store->pendingRequestSnapshot();
  const String realm = snapshot.gatewayUrl + "|" + snapshot.deviceId;
  if (realm == heldReplyRealm) return;
  heldReplies.clear();
  heldReplyRealm = realm;
}

// Remembers the reply the person is looking at, for the next time this thread is opened. Cheap to
// call every frame: it does nothing until the model's revision moves.
void captureHeldReply() {
  if (screen != Screen::Response || !gw->responseOpen() || !gw->hasThread()) return;
  const uint32_t revision = gw->revision();
  if (revision == heldReplyCapturedRevision) return;
  heldReplyCapturedRevision = revision;
  sealHeldRepliesToRealm();
  heldReplies.keep(gw->context().environmentId, gw->context().threadId, gw->response(), millis());
}

// The held copy to paint in place of an empty or still-loading reply, or null.
const HeldReply* heldReplyToShow() {
  if (!gw->hasThread()) return nullptr;
  const ThreadResponse& r = gw->response();
  if (gw->responseOpen() && !(r.state == "loading" && r.lineCount == 0)) return nullptr;
  return heldReplies.find(gw->context().environmentId, gw->context().threadId);
}

void paintHeldResponse(const HeldReply& held) {
  String lines[kReplyMaxLines];
  const ResponseLayout layout = layoutResponsePage(held.lines, held.lineCount, kCols2,
    kReplyMaxLines, 0, lines, kReplyMaxLines);
  for (size_t i = 0; i < layout.lineCount; ++i) {
    uip::text(10, (int16_t)(kReplyTextTop + (int16_t)i * kReplyLineH), 2, kText, lines[i]);
  }
  uip::divider(20, kContentTop + 138, (int16_t)(kW - 40));
  uip::pixel(14, kContentTop + 145, 6, kHair);
  uip::text(26, kContentTop + 146, 1, kText, "UPDATING");
  uip::textRight((int16_t)(kW - 14), kContentTop + 146, 1, kHair,
                 HeldReplies::ageLabel(millis() - held.seenAt));
}

void paintResponse() {
  clearContent();
  const ThreadResponse& r = gw->response();

  if (const HeldReply* held = heldReplyToShow()) { paintHeldResponse(*held); return; }

  if (!gw->responseOpen()) {
    if (replyLoadPending) {
      uip::textCentered(kContentTop + 70, 1, kMuted, "Loading the latest reply");
      uip::textCentered(kContentTop + 90, 1, kHair, "One moment");
    } else {
      uip::textCentered(kContentTop + 70, 1, kMuted, "No response open");
      uip::textCentered(kContentTop + 90, 1, kHair, "Load the latest below");
    }
    return;
  }

  String lines[kReplyMaxLines];
  const ResponseLayout layout = replyLayout(lines);
  const size_t count = layout.lineCount;
  for (size_t i = 0; i < count; ++i) {
    uip::text(10, (int16_t)(kReplyTextTop + (int16_t)i * kReplyLineH), 2, kText, lines[i]);
  }
  if (count == 0) {
    const String waiting = r.state == "waiting" || r.state == "streaming"
      ? String("Waiting for the agent")
      : r.state == "loading" ? String("Loading the latest reply") : String("Nothing to show yet");
    uip::textCentered(kReplyTextTop + 40, 1, kMuted, waiting);
  }

  // State is the turn-completion discriminator and the only honest answer to "is it done".
  String state = r.state;
  state.toUpperCase();
  if (r.state == "error") state = "RETRY REPLY";
  else if (r.truncated) state = "More in console";
  uip::divider(20, kContentTop + 138, (int16_t)(kW - 40));
  // The metric rhythm again: the marker, the value, the quiet column beside it. The marker is the
  // accent while the turn is in flight, because "the agent is working" is the one live fact on
  // this screen and the accent is what the console spends on live.
  const bool live = stateIs(r.state, "waiting") || stateIs(r.state, "streaming");
  if (live) uip::accentPixel(14, kContentTop + 145, 6);
  else uip::pixel(14, kContentTop + 145, 6, kHair);
  uip::text(26, kContentTop + 146, 1, kText, state);
  uip::textRight((int16_t)(kW - 14), kContentTop + 146, 1, kHair,
                 String(r.page + 1) + "/" + String(r.pageCount)
                   + (layout.pageCount > 1 ? String(" ") + String(layout.page + 1) + "/" + String(layout.pageCount) : String()));

  for (size_t i = 0; i < r.followUpCount && i < 2; ++i) {
    uip::button(i == 0 ? kFollowLeft : kFollowRight, r.followUps[i].label, false, haveThread());
  }
}

// ---------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------

void paintApprovals() {
  clearContent();
  const size_t count = gw->approvalCount();
  if (count == 0) {
    const RemoteBlockers& remote = gw->remoteBlockers();
    if (gw->hasBlockingRequests()) {
      uip::textCentered(kContentTop + 52, 2, kBright, deviceBlockerLabel(gw->blockerKind()));
      if (remote.providerApprovals) uip::textCentered(kContentTop + 90, 1, kText,
        String(remote.providerApprovals) + " provider approval(s)");
      if (remote.userInputs) uip::textCentered(kContentTop + 110, 1, kText,
        String(remote.userInputs) + " input request(s)");
      uip::textCentered(kContentTop + 145, 1, kMuted, "Open the web console");
      uip::textCentered(kContentTop + 165, 1, kHair, "Answer in the thread there");
    } else {
      uip::textCentered(kContentTop + 80, 2, kMuted, "All clear");
      uip::textCentered(kContentTop + 112, 1, kHair, "Gateway holds appear here");
    }
    return;
  }
  if (approvalIndex >= count) approvalIndex = 0;
  const PendingApproval* a = gw->approval(approvalIndex);
  if (!a) return;

  const Rect box = {10, kContentTop + 4, kW - 20, 178};
  uip::card(box, 20.0f, (int16_t)kSurface, (int16_t)kHair, 1.3f, 1.6f);

  String header = String(approvalIndex + 1) + " of " + String(count);
  if (gw->approvalOverflow()) header += "+  (see console)";
  else if (count > 1) header += "  swipe for next";
  uip::text(24, box.y + 14, 1, kMuted, header);
  if (a->risk.length() > 0) {
    String risk = a->risk;
    risk.toUpperCase();
    // The risk is the one thing on this card that is asking for a decision, so it is the one thing
    // that wears the accent.
    uip::textRightAccent((int16_t)(kW - 24), (int16_t)(box.y + 14), 1, risk);
  }

  // The card's title: large, tight and the brightest thing in the card, as in the reference design.
  uip::text(24, box.y + 36, 2, kBright, uip::fit(a->intentType, 17));

  String lines[4];
  const size_t wrapped = uip::wrapText(a->summary, 33, lines, 4);
  for (size_t i = 0; i < wrapped; ++i) {
    uip::text(24, (int16_t)(box.y + 70 + (int16_t)i * 16), 1, kMuted, lines[i]);
  }
  uip::divider(24, (int16_t)(box.y + box.h - 22), (int16_t)(box.w - 28), kHair, kSurface);
  uip::text(24, (int16_t)(box.y + box.h - 14), 1, kHair, "Runs on your own machine");
  const RemoteBlockers& remote = gw->remoteBlockers();
  if (remote.providerApprovals || remote.userInputs || remote.providerUnknown || remote.inputUnknown) {
    uip::textCentered(kContentTop + 190, 1, kMuted, "Other requests: open console");
  } else if (message.length() > 0) uip::textCentered(kContentTop + 190, 1, kMuted, uip::fitWords(message, 35));
}

// ---------------------------------------------------------------------------------------------
// Device and gateway configuration
// ---------------------------------------------------------------------------------------------

// Whether a row's value is a fact that needs a person right now.
//
// The accent is spent here and nowhere else: it is the console's live state, and a state that
// needs a person is the one that is live. Everything else on this screen is a fact about a
// machine, and a fact about a machine does not need a colour.
bool rowAlerts(Row row) { return rowTone(row) == kBright; }

// One label/value pair. The value is the answer and the caption only names it — the order the
// console's metric strip reads in, and the opposite of a table, which is what this used to want
// to be.
void paintFact(int16_t y, const char* label, const String& value, uint8_t tone,
               bool alert = false) {
  uip::factRow(16, y, uip::fit(value, 34), label, tone, alert);
}

void paintDevice() {
  clearContent();
  // The headline. In the reference design the title is the largest and brightest thing on the
  // page and everything under it is quiet; a configuration screen is no different.
  uip::text(14, kContentTop + 4, 2, kBright, "DEVICE");

  int16_t y = kContentTop + 26;
  paintFact(y, "NAME", deviceName(), kText);
  y += 30;
  paintFact(y, "IDENTITY", store && store->deviceId().length() > 0 ? store->deviceId()
                                                                  : String("Not flashed"), kText);
  y += 30;
  paintFact(y, "MODEL", String(HARDWARE_MODEL) + "  fw " + FIRMWARE_VERSION, kMuted);
  y += 30;
  paintFact(y, "WI-FI", store && store->wifiSsid().length() > 0 ? store->wifiSsid()
                                                                : String("Not configured"), kMuted);
  y += 30;
  paintFact(y, "STATE", rowValue(Row::Device), rowAlerts(Row::Device) ? kBright : kText,
            rowAlerts(Row::Device));
  y += 30;
  uip::divider(20, y, (int16_t)(kW - 40));
  uip::text(16, (int16_t)(y + 8), 1, kHair, "RE-PROVISION clears Wi-Fi only");
}

void paintGateway() {
  clearContent();
  uip::text(14, kContentTop + 4, 2, kBright, "GATEWAY");

  // The URL is a fact like any other, except that it can be two lines long.
  const String url = store ? store->gatewayUrl() : String();
  uip::pixel(16, kContentTop + 31, 6, kHair);
  String lines[2];
  const size_t wrapped = uip::wrapText(url.length() > 0 ? url : String("Not configured"), 34,
                                       lines, 2);
  for (size_t i = 0; i < wrapped; ++i) {
    uip::text(30, (int16_t)(kContentTop + 30 + (int16_t)i * 14), 1, kText, lines[i]);
  }
  uip::text(30, (int16_t)(kContentTop + 30 + (int16_t)wrapped * 14), 1, kHair, "URL");

  int16_t y = kContentTop + 76;
  paintFact(y, "LINK", gw ? String(gatewayLinkName(gw->link())) : String("None"),
            rowAlerts(Row::Gateway) ? kBright : kText, rowAlerts(Row::Gateway));
  y += 30;
  paintFact(y, "PROBE", String(gatewayStatusText(gatewayStatus())), kMuted);
  y += 30;
  const String detail = gw && gw->detail().length() > 0 ? gw->detail() : gatewayLine();
  paintFact(y, "LAST", detail.length() > 0 ? detail : String("Nothing reported"), kMuted);
  y += 30;
  uip::divider(20, y, (int16_t)(kW - 40));
  uip::text(16, (int16_t)(y + 8), 1, kHair, "PORTAL reopens the setup form");
}

// ---------------------------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------------------------

constexpr int16_t kWifiListTop = kContentTop + 46;
constexpr int16_t kWifiRowH = 46;
constexpr int16_t kWifiKeyboardTop = 92;
constexpr int16_t kWifiLetterW = 56, kWifiLetterH = 60;
constexpr int16_t kWifiUtilityTop = 212, kWifiUtilityH = 44;
Rect wifiKeyRect(size_t key) {
  if(key>=64)return {static_cast<int16_t>(8+(key-64)*56),kWifiUtilityTop,56,kWifiUtilityH};
  const size_t columns=wifiKeyboardColumns(wifiKeyboardSymbols);
  return {static_cast<int16_t>(8+(key%columns)*kWifiLetterW-wifiKeyboardOffset),
    static_cast<int16_t>(kWifiKeyboardTop+(key/columns)*kWifiLetterH),kWifiLetterW,kWifiLetterH};
}
int16_t wifiKeyboardMaxOffset(){return max<int16_t>(0,static_cast<int16_t>(wifiKeyboardColumns(wifiKeyboardSymbols)*kWifiLetterW-224));}
void moveWifiKeyboard(int16_t offset) {
  const int16_t next=max<int16_t>(0,min<int16_t>(wifiKeyboardMaxOffset(),offset));
  if(next!=wifiKeyboardOffset){wifiKeyboardOffset=next;wifiLettersDirty=true;}
}
bool wifiJoinCanStart() {
  if(wifiEditingSsid)return wifiPassword.length()>0 && wifiPassword.length()<=32;
  return wifiTargetSupported && (wifiTargetSaved || !wifiTargetSecured || wifiPassphraseValid(wifiPassword));
}
void paintWifi() {
  clearContent();
  uip::text(14,kContentTop+6,1,kBright,wifiShowSaved ? "SAVED WI-FI" : "NEARBY / 2.4 GHz");
  const String detail=wifiScan.scanning ? String("Searching...")
    : wifiScan.failed && !wifiShowSaved ? String("Search failed; scan again")
    : message.length()>0 ? message : wifiConnection.detail;
  uip::text(14,kContentTop+23,1,kMuted,uip::fitWords(detail,35));
  const size_t count=wifiShowSaved?wifiSavedNames.size():wifiScan.count;
  if(!count) {
    uip::textCentered(kWifiListTop+38,1,kMuted,wifiShowSaved?"No saved networks":"No networks found");
    uip::textCentered(kWifiListTop+58,1,kHair,"Scan again or add a network");
    if(!wifiShowSaved)uip::textCentered(kWifiListTop+78,1,kHair,"iPhone: enable Compatibility");
    return;
  }
  for(size_t i=0;i<count;++i) {
    const int16_t y=kWifiListTop+static_cast<int16_t>(i)*kWifiRowH-wifiScroll;
    if(y<kWifiListTop || y+kWifiRowH>contentBottom())continue;
    const String name=wifiShowSaved?wifiSavedNames[i]:wifiScan.networks[i].ssid;
    String meta=name==wifiConnection.activeSsid?"CONNECTED":wifiShowSaved||wifiScan.networks[i].saved?"SAVED":wifiScan.networks[i].secured?"PASSWORD":"OPEN";
    if(!wifiShowSaved && !wifiScan.networks[i].supported)meta="UNSUPPORTED";
    uip::text(14,y+5,1,kText,uip::fitWords(name,34));
    uip::text(14,y+23,1,kMuted,meta);
    if(!wifiShowSaved)uip::textRight(kW-14,y+23,1,kHair,String(wifiScan.networks[i].rssi)+" dBm");
    uip::divider(14,y+kWifiRowH-3,kW-28,kHair,kBg);
  }
}
void paintWifiDetails() {
  clearContent();
  uip::textCentered(kContentTop+22,1,kMuted,"WI-FI NETWORK");
  String lines[2];const size_t n=uip::wrapText(wifiTarget,30,lines,2);
  for(size_t i=0;i<n;++i)uip::textCentered(kContentTop+52+i*18,1,kBright,lines[i]);
  uip::textCentered(kContentTop+104,1,kMuted,wifiTarget==wifiConnection.activeSsid?"Currently connected":wifiTargetSaved?"Saved; connects automatically":wifiTargetSecured?"Password needed":"Open network");
  const String hint=!wifiTargetSupported?String("Personal Wi-Fi only")
    :message.length()?message:String("Working settings stay until joined");
  uip::textCentered(kContentTop+138,1,kHair,uip::fitWords(hint,35));
}
void paintWifiEntryBand(Adafruit_GFX& canvas,int16_t bandTop,void*) {
  canvas.setTextSize(1);canvas.setTextWrap(false);canvas.setTextColor(panelGrey(kMuted));
  canvas.setCursor(14,kContentTop+4-bandTop);
  canvas.print(uip::fitWords(message.length()?message:(wifiEditingSsid?String("Network name"):wifiTarget),35));
  String shown;
  if(wifiEditingSsid)shown=uip::fit(wifiPassword,32);
  else if(wifiPassword.length()){for(size_t i=0;i<wifiPassword.length()&&i<24;++i)shown+='*';shown+=" ("+String(wifiPassword.length())+")";}
  canvas.setTextColor(panelGrey(kBright));canvas.setCursor(14,kContentTop+18-bandTop);
  canvas.print(shown.length()?shown:String("Swipe letters left / right"));
}
void paintWifiEntry() {
  displayComposeBands(kContentTop,kWifiKeyboardTop-kContentTop,panelGrey(kBg),paintWifiEntryBand,nullptr);
  wifiEntryDirty=false;
}

void paintWifiLettersBand(Adafruit_GFX& canvas,int16_t bandTop,void*) {
  const size_t columns=wifiKeyboardColumns(wifiKeyboardSymbols);
  canvas.setTextSize(2);canvas.setTextWrap(false);canvas.setTextColor(panelGrey(kBright));
  for(size_t row=0;row<2;++row)for(size_t col=0;col<columns;++col) {
    const size_t key=row*columns+col;
    const char c=wifiKeyboardLetter(wifiKeyboardSymbols,wifiKeyboardUpper,col,row);
    if(!c)continue;
    const Rect r=wifiKeyRect(key);
    if(r.x+r.w<=0 || r.x>=kW || r.y+r.h<=bandTop || r.y>=bandTop+22)continue;
    canvas.fillRoundRect(r.x+2,r.y+2-bandTop,r.w-4,r.h-4,8,panelGrey(kSurfaceHi));
    canvas.drawRoundRect(r.x+2,r.y+2-bandTop,r.w-4,r.h-4,8,panelGrey(kHair));
    canvas.setCursor(r.x+(r.w-12)/2,r.y+(r.h-16)/2-bandTop);canvas.write(c);
  }
}
void paintWifiLetters(){
  if(!displayComposeBands(kWifiKeyboardTop,2*kWifiLetterH,panelGrey(kBg),paintWifiLettersBand,nullptr)) {
    // A missing compositor must remain an explicit, recoverable setup state.
    g().fillRect(0,kWifiKeyboardTop,kW,2*kWifiLetterH,panelGrey(kBg));
    uip::textCentered(kWifiKeyboardTop+50,1,kMuted,"Keyboard unavailable; use phone");
  }
  wifiLettersDirty=false;
}
void paintWifiUtilitiesRaw(){
  for(size_t i=0;i<4;++i){
    const Rect cell=wifiKeyRect(64+i);
    const Rect ink={static_cast<int16_t>(cell.x+2),static_cast<int16_t>(cell.y+2),52,40};
    const char* label=i==0?"CAPS":i==1?(wifiKeyboardSymbols?"ABC":"123"):i==2?"SPACE":"DEL";
    uip::button(ink,label,(i==0&&wifiKeyboardUpper)||(i==1&&wifiKeyboardSymbols),i!=0||!wifiKeyboardSymbols,kBg);
  }
  wifiUtilityDirty=false;
}
void paintWifiUtilities(){
  if(!displayComposeScene(kWifiUtilityTop,kWifiUtilityH,panelGrey(kBg),[](void*){paintWifiUtilitiesRaw();},nullptr))paintWifiUtilitiesRaw();
}
void paintWifiPassword() {
  paintWifiEntry();paintWifiLetters();paintWifiUtilities();
  g().fillRect(0,kWifiUtilityTop+kWifiUtilityH,kW,contentBottom()-kWifiUtilityTop-kWifiUtilityH,panelGrey(kBg));
}
void paintWifiJoining() {
  clearContent();
  const bool failed=wifiConnection.candidateId==wifiUiCandidateId
    && wifiConnection.candidateResult==WifiCandidateResult::Failed;
  uip::textCentered(kContentTop+42,2,kBright,failed?"Change failed":"Connecting");
  uip::textCentered(kContentTop+82,1,kText,uip::fitWords(wifiTarget,35));
  String lines[3];const size_t n=uip::wrapText(failed?wifiConnection.candidateDetail:wifiConnection.detail,33,lines,3);
  for(size_t i=0;i<n;++i)uip::textCentered(kContentTop+116+i*16,1,kMuted,lines[i]);
}

void paintWifiPhone() {
  clearContent();
  if(phoneSetup.waitingForHotspot) {
    uip::textCentered(kContentTop+20,2,kBright,"Start your hotspot");
    uip::textCentered(kContentTop+58,1,kText,"You can leave the setup page now.");
    uip::textCentered(kContentTop+82,1,kMuted,"iPhone: Settings / Personal Hotspot");
    uip::textCentered(kContentTop+102,1,kMuted,"Allow Others to Join: ON");
    uip::textCentered(kContentTop+122,1,kMuted,"Maximize Compatibility: ON");
    uip::textCentered(kContentTop+154,2,kBright,String(phoneSetup.remainingSeconds)+"s");
    uip::textCentered(kContentTop+184,1,kHair,"Connecting automatically...");return;
  }
  if(phoneSetupSucceeded) {
    uip::textCentered(kContentTop+46,2,kBright,"Wi-Fi saved");
    uip::textCentered(kContentTop+82,1,kMuted,"Your controller is connected.");
    uip::textCentered(kContentTop+110,1,kHair,"Return your phone to its Wi-Fi.");return;
  }
  if(!phoneSetup.active) {
    uip::textCentered(kContentTop+50,2,kBright,"Setup closed");
    uip::textCentered(kContentTop+86,1,kMuted,"Saved networks were kept.");return;
  }
  if(phoneSetup.hotspotHandoff && !phoneSetup.apPassword.length()) {
    uip::textCentered(kContentTop+38,2,kBright,"Not connected");
    String lines[4];const size_t count=uip::wrapText(phoneSetup.detail,33,lines,4);
    for(size_t i=0;i<count;++i)uip::textCentered(kContentTop+80+i*18,1,kMuted,lines[i]);
    uip::textCentered(kContentTop+174,1,kHair,"Saved networks are still available.");return;
  }
  uip::textCentered(kContentTop+4,1,kBright,phoneShowPage?"2 / OPEN SETUP PAGE":"1 / JOIN DEVICE SETUP");
  const int16_t left=(kW-setup_qr::kPixels)/2,top=kContentTop+22;
  g().fillRect(left,top,setup_qr::kPixels,setup_qr::kPixels,panelGrey(255));
  if(phoneQr.size) {
    for(int y=0;y<phoneQr.size;++y)for(int x=0;x<phoneQr.size;++x)
      if(phoneQr.dark(x,y))g().fillRect(left+phoneQr.offset()+x*phoneQr.scale(),top+phoneQr.offset()+y*phoneQr.scale(),phoneQr.scale(),phoneQr.scale(),panelGrey(0));
  }
  else uip::textCentered(top+58,1,kMuted,"Use setup address below");
  uip::textCentered(kContentTop+158,1,kMuted,phoneShowPage?"Stay on the device setup Wi-Fi":"Scan with your phone camera");
  uip::textCentered(kContentTop+176,1,kHair,phoneShowPage?"http://192.168.4.1":"Join, then open the setup page");
  if(phoneSetup.phase==PhoneSetupPhase::Joining || phoneSetup.phase==PhoneSetupPhase::Queued)
    uip::textCentered(kContentTop+194,1,kText,"Connecting; saved networks kept");
}

void paintModal() {
  // The whole content region, not just the box: leaving the screen underneath visible around the
  // edges shows half a list row and reads as a rendering fault rather than as a dialog.
  clearContent();
  const Rect box = {12, 86, kW - 24, 144};
  // A glass card: a hairline edge over a barely-lifted surface, which is what the reference
  // design's cards are. The edge was a full kMuted, which read as a second, louder border than
  // the one every other card on this screen wears.
  uip::card(box, 22.0f, (int16_t)kSurface, (int16_t)kHair, 1.3f, 1.8f);

  const bool approval = modal == Modal::ConfirmApproval || modal == Modal::ConfirmRejection;
  const bool reject = modal == Modal::ConfirmRejection;
  const bool claim = modal == Modal::ConfirmClaim;
  const bool forgetWifi = modal == Modal::ConfirmForgetWifi;
  const bool reprovision = modal == Modal::ConfirmReprovision;
  const bool nativeResume = modal == Modal::ConfirmNativeResume;
  uip::textCentered((int16_t)(box.y + 18), 1, kMuted,
                    forgetWifi ? "FORGET WI-FI" : claim ? "REPLACE CLAIM CODE" : approval ? (reject ? "REJECT COMMAND" : "APPROVE COMMAND")
                             : (reprovision ? "RE-PROVISION" : "CONFIRM ACTION"));

  String lines[4];
  const String subject = nativeResume ? String("Stop this session in its other app first. Continue saved history here?") : forgetWifi ? wifiTarget : claim ? String("The previous code stops working") : approval ? pendingApprovalSummary
                                  : (reprovision ? String("Clear Wi-Fi, cached setup, claim code and local receipt")
                                                 : pendingControl.label);
  const size_t wrapped = uip::wrapText(subject, 30, lines, 4);
  for (size_t i = 0; i < wrapped; ++i) {
    uip::textCentered((int16_t)(box.y + 46 + (int16_t)i * 18), 1, kText, lines[i]);
  }
  // Approving runs it on the owner's own machine — the one thing on this device worth a second
  // deliberate press.
  uip::textCentered((int16_t)(box.y + box.h - 26), 1, kHair,
                    forgetWifi ? "Stops automatic connection to it" : claim ? "Your account is unchanged" : approval ? (reject ? "This request will not run" : "Runs on your machine")
                             : (reprovision ? "Cloud work continues; ID kept"
                                            : uip::fitWords(threadTitle(), 30)));
}

// What is currently on the panel. The voice states are part of it because they are four different
// pictures inside one Screen, and arriving at one of them is an arrival like any other.
uint16_t viewKey() {
  return (uint16_t)(((uint16_t)screen << 8) | ((uint16_t)modal << 4) | (uint16_t)voiceView());
}

void paintContent() {
  if (modal != Modal::None) {
    paintModal();
    contentDirty = false;
    return;
  }
  switch (screen) {
    case Screen::Home:         paintHome(); break;
    case Screen::Threads:      paintThreads(); break;
    case Screen::Send:         paintSend(); break;
    case Screen::Actions:      paintActions(); break;
    case Screen::Response:     paintResponse(); break;
    case Screen::Approvals:    paintApprovals(); break;
    case Screen::Environments: paintEnvironments(); break;
    case Screen::Projects:     paintProjects(); break;
    case Screen::Wifi:         paintWifi(); break;
    case Screen::WifiDetails:  paintWifiDetails(); break;
    case Screen::WifiPassword: paintWifiPassword(); break;
    case Screen::WifiJoining:  paintWifiJoining(); break;
    case Screen::WifiPhone:    paintWifiPhone(); break;
    case Screen::Device:       paintDevice(); break;
    case Screen::Gateway:      paintGateway(); break;
    default:                   paintStatus(); break;
  }
  contentDirty = false;
}

// ---------------------------------------------------------------------------------------------
// The status drawer
// ---------------------------------------------------------------------------------------------

// Anchored at kContentTop, not at kHeaderH: the drawer occupies exactly the region a content
// repaint clears, so putting it away never leaves a sliver of its surface stranded under the
// header's curved divider.
Rect drawerRowRect(uint8_t index) {
  return {0, (int16_t)(kContentTop + kDrawerPadTop + (int16_t)index * kDrawerRowH), kW,
          kDrawerRowH};
}

// Paints one row of the drawer onto the surface, clearing its band first.
void paintDrawerRow(uint8_t index) {
  const Rect r = drawerRowRect(index);
  const Row row = drawerRows[index];
  const String value = uip::fitWords(rowValue(row), 27);

  // Cleared to the whole row, never to the ink. A band sized to the new string leaves the tail of
  // a longer old one beside it, which is the defect that produced "C.Weaving g" in this project
  // once already.
  g().fillRect(0, r.y, kW, r.h, panelGrey(kSurfaceHi));

  // The row's own mark. The accent is spent on the row that needs a person, which is the same
  // rule the header's dot follows.
  if (rowAlerts(row)) uip::accentDot(26, (int16_t)(r.y + 26), 4.0f, kSurfaceHi);
  else uip::dot(26, (int16_t)(r.y + 26), 4.0f, rowTone(row), kSurfaceHi);
  uip::text(44, (int16_t)(r.y + 12), 1, kMuted, rowTitle(row));
  uip::text(44, (int16_t)(r.y + 30), 1, rowAlerts(row) ? kBright : kText, value);
  uip::chevron((int16_t)(kW - 24), (int16_t)(r.y + 26), 5.0f, 1, kMuted, 2.0f, kSurfaceHi);
  displaySoftArcDivider(44, (int16_t)(r.y + r.h - 4), (int16_t)(kW - 88), 2.0f, 1.2f,
                        kSurfaceHi, kHair);

  drawerPainted[index] = value;
  drawerRowOnGlass[index] = true;
}

// Advances the drawer by exactly the strip that changed, and nothing else.
//
// The previous version redrew the entire surface, every row and every string on every frame of the
// slide. Repainting a region that is already correct is what made it read as the screen reloading
// rather than as a panel moving: the text flickered as it was laid over itself, and the whole panel
// flashed as the fill swept back across it. Now a frame touches three things — the strip the lip
// vacated or exposed, the lip itself, and any row that has just become fully visible.
void paintDrawerFrame() {
  const float eased = drawerOpen ? uip::easeOutCubic(drawerT) : uip::easeInOutCubic(drawerT);
  const int16_t revealed = (int16_t)(eased * drawerHeight());
  const int16_t was = drawerShownPx;
  drawerShownPx = revealed;

  // The lip is a curve a few pixels tall; the strip has to include where it WAS or its old copy is
  // left behind on the surface.
  constexpr int16_t kLip = 12;

  if (revealed > was) {
    // Opening: new surface appears below the old edge.
    int16_t top = (int16_t)(kContentTop + was - kLip);
    if (top < kContentTop) top = kContentTop;
    int16_t bottom = (int16_t)(kContentTop + revealed);
    if (bottom > kH) bottom = kH;
    if (bottom > top) g().fillRect(0, top, kW, (int16_t)(bottom - top), panelGrey(kSurfaceHi));
  } else if (revealed < was) {
    // Closing: the vacated strip goes back to the ground. The content underneath is repainted once,
    // when the panel is fully away — the drawer covers the whole page, so there is nothing to
    // reveal progressively without re-rendering the screen beneath it on every frame, which is the
    // cost this rewrite exists to remove.
    int16_t top = (int16_t)(kContentTop + revealed - kLip);
    if (top < kContentTop) top = kContentTop;
    int16_t bottom = (int16_t)(kContentTop + was + kLip);
    if (bottom > kH) bottom = kH;
    if (bottom > top) g().fillRect(0, top, kW, (int16_t)(bottom - top), panelGrey(kBg));
    // Rows inside the vacated strip are gone from the glass and must be repainted if it comes back.
    for (uint8_t i = 0; i < kMaxDrawerRows; ++i) {
      const Rect r = drawerRowRect(i);
      if (r.y + r.h > kContentTop + revealed) drawerRowOnGlass[i] = false;
    }
  }

  if (revealed <= 2) return;

  // No rounded top. The panel emerges from under the header's own curved divider, so its top edge
  // is never on screen — drawing corners there would paint over the header instead of tucking
  // beneath it. The end that IS visible is the leading edge below, and that one is a curve.

  for (uint8_t i = 0; i < drawerRowCount; ++i) {
    const Rect r = drawerRowRect(i);
    // A row appears only once there is room for the whole of it. Half a row sliding past the lip
    // is the thing that makes a reveal look like a repaint.
    if (r.y + r.h > kContentTop + revealed - kLip) break;
    if (drawerRowOnGlass[i] && drawerPainted[i] == uip::fitWords(rowValue(drawerRows[i]), 27)) {
      continue;
    }
    paintDrawerRow(i);
  }

  // The leading edge: a brighter curve at the bottom of the panel, which is the thing the eye
  // follows down and back up again. Skipped once the panel is fully out — at full extension the
  // edge is the bottom of the screen and there is nothing for it to lead.
  if (revealed < drawerHeight()) {
    displaySoftArcDivider(18, (int16_t)(kContentTop + revealed - 8), (int16_t)(kW - 36), 3.0f, 1.8f,
                          kSurfaceHi, kMuted);
  }
}

void openDrawer() {
  if (drawerOpen) return;
  drawerOpen = true;
  drawerDirty = true;
  // Every row has to be painted afresh: the surface it sits on is about to be laid down again.
  for (uint8_t i = 0; i < kMaxDrawerRows; ++i) drawerRowOnGlass[i] = false;

  // The tray does NOT animate away. The drawer slides over it.
  //
  // Letting the two animate at once left a black band across the bottom of an open drawer, and it
  // is worth writing down why, because it is not obvious: the bar clears its whole 58 px band
  // before it paints, while the drawer only ever paints the strip that moved. The bar's animation
  // is shorter than the drawer's, so its final clear landed AFTER the drawer had already swept
  // past that region — and the drawer, having no reason to revisit ground it had already covered,
  // never painted it again. What the photograph showed as "the ACTIVITY row cut off, a dark band,
  // then a light strip at the very bottom" was exactly that: surface, the bar's black, and the one
  // strip the drawer painted after the bar had finished.
  //
  // So it is retired here, in one step, before the drawer's first frame.
  barT = 0.0f;
  barReserved = false;
  barDirty = false;
  if (displayReady()) g().fillRect(0, (int16_t)(kH - kBarH), kW, kBarH, panelGrey(kBg));
}

void closeDrawer() {
  if (!drawerOpen) return;
  drawerOpen = false;
  drawerDirty = true;
}

// Immediate, for the paths that are about to paint something else over the whole content region.
void closeDrawerNow() {
  drawerOpen = false;
  drawerT = 0.0f;
  drawerShownPx = 0;
  drawerDirty = false;
  for (uint8_t i = 0; i < kMaxDrawerRows; ++i) drawerRowOnGlass[i] = false;
  contentDirty = true;
}

// ---------------------------------------------------------------------------------------------
// The action bar
// ---------------------------------------------------------------------------------------------

void addAction(Act id, const char* label, bool primary, bool enabled = true) {
  // Bounds-checked against `actions`, which is the array being written.
  if (actionCount >= kMaxActions) return;
  actions[actionCount].id = id;
  actions[actionCount].label = label;
  actions[actionCount].primary = primary;
  actions[actionCount].enabled = enabled;
  actionCount += 1;
}

// What there is to do, right now, on this screen.
//
// The rule that produces an empty bar is the whole point: if this function adds nothing, the bar is
// not drawn and those 58 pixels belong to the content. A permanent strip of five tabs, four of them
// inert, was the opposite of that.
bool uiNetworkBusy();
// Busy for the purposes of the action bar. A job that only REVALIDATES what is already on screen
// (see submitUiJob) does not lock the bar: the buttons stay live, and a press during it is held and
// replayed when the job ends (pendingGesture), instead of the bar saying WORKING for the length of
// a request the person is not waiting on.
bool uiBarLocked();
extern bool deferredStopPending;

void buildActions() {
  actionCount = 0;
  if (!gw) return;
  if (uiBarLocked() && !(screen==Screen::Wifi || screen==Screen::WifiDetails || screen==Screen::WifiPassword || screen==Screen::WifiJoining || screen==Screen::WifiPhone)) {
    if (modal == Modal::ConfirmControl && (pendingControl.kind == "stop"
        || (pendingControl.kind == "legacy" && pendingControl.id == "stop"))) {
      addAction(Act::ConfirmNo, "CANCEL", false);
      addAction(Act::ConfirmYes, deferredStopPending ? "STOP QUEUED" : "STOP", true, !deferredStopPending);
    } else {
      addAction(Act::SavedActions, "ACTIONS", false);
      addAction(Act::None, deferredStopPending ? "STOP QUEUED" : "WORKING", false, false);
    }
    return;
  }

  // An open config portal takes over the screen, and nothing offered a way out of it: the only
  // exits were joining a network or pulling the power. A device in this state is usually still
  // online and still reachable — the owner opened the portal, saw they did not need it, and simply
  // wants their screen back. Offered before every other rule, including the modal, because being
  // unable to leave a screen is a worse dead end than any of them.
  if (prov && prov->configPortalActive()
      && !(screen==Screen::Wifi || screen==Screen::WifiDetails || screen==Screen::WifiPassword || screen==Screen::WifiJoining || screen==Screen::WifiPhone)) {
    addAction(Act::ClosePortal, "DONE", true);
    return;
  }

  // A modal outranks everything, including a held clip. Both want the same two buttons, and a
  // confirmation that cannot be answered because a recording is queued behind it is a dead end
  // with no way out of it.
  if (modal != Modal::None) {
    addAction(Act::ConfirmNo, "CANCEL", false);
    addAction(Act::ConfirmYes,
              modal == Modal::ConfirmForgetWifi ? "FORGET" : modal == Modal::ConfirmRejection ? "REJECT" : modal == Modal::ConfirmClaim ? "NEW CODE" : modal == Modal::ConfirmApproval ? "APPROVE"
                                              : (modal == Modal::ConfirmReprovision || pendingControl.kind == "reset" ? "RESET"
                                                                                    : (pendingControl.kind == "stop" || pendingControl.id == "stop" ? "STOP" : "RUN")),
              true);
    return;
  }

  // A held clip outranks the screen. It is a recording sitting in RAM that has not been sent
  // anywhere, and there is exactly one pair of things to do with it.
  if (clipHeld && screen == Screen::Send) {
    if (voice.canDismissCapture()) addAction(Act::DiscardClip, "DISCARD", false);
    else addAction(Act::VoiceConsole, "CONSOLE", false);
    addAction(Act::SendClip, voice.canDismissCapture() ? "SEND" : "RETRY UPLOAD", true,
      gw->context().environmentId == voiceCaptureEnvironment && gw->context().threadId == voiceCaptureThread);
    return;
  }

  if (!operable() && !configScreen()) {
    // The claim screen keeps its rotate behind a tap on the code itself; there is nothing else an
    // unowned device can be asked to do.
    return;
  }

  switch (screen) {
    case Screen::Home: {
      if (gw->hasBlockingRequests()) {
        addAction(Act::Review, "REVIEW", true);
        // A blocked or unknown turn still needs independent Status/Stop controls. Never trap
        // the owner behind the console handoff by hiding the assigned Actions menu.
        addAction(Act::SavedActions, "ACTIONS", false);
        addAction(Act::PickThread, "CHOOSE", false);
        return;
      }
      if (!haveThread()) {
        addAction(Act::PickThread, "CHOOSE", true);
        addAction(Act::SavedActions, "ACTIONS", false);
        return;
      }
      if (gw->responseOpen() && gw->response().state == "error") {
        addAction(Act::Retry, "RETRY", true);
        // A failed reply read must not trap the owner outside saved actions.
        addAction(Act::SavedActions, "ACTIONS", false);
        addAction(Act::PickThread, "CHOOSE", false);
        return;
      }
      if (audio::available()) addAction(Act::Talk, clipHeld ? "RESUME" : voiceInJourney() ? "REQUEST" : "TALK", true);
      // The saved actions moved off the voice screen and this is how they stay reachable. There is
      // deliberately no REPLY here: the OPEN button under the picker already goes into the thread,
      // and two controls for one destination is the clutter this pass exists to remove.
      addAction(Act::SavedActions, "ACTIONS", false);
      addAction(Act::PickThread, "CHOOSE", false);
      return;
    }
    case Screen::Threads:
      if (agentBrowseMode) {
        addAction(Act::AgentBack, "THREADS", false);
        if (agentBrowseMode == 1) {
          addAction(Act::AgentSessions, "SESSIONS", false, selectedAgentRow >= 0);
          addAction(Act::AgentUse, "USE AGENT", true, selectedAgentRow >= 0 && haveThread());
        } else {
          const BrowseAgent* row = selectedAgentRow < 0 ? nullptr : browse.agent((size_t)selectedAgentRow);
          addAction(Act::AgentResume, "RESUME", true, row && row->resumable);
        }
        return;
      }
      if (previewThreadIndex >= 0) addAction(Act::UseThread, "USE THREAD", true);
      else addAction(Act::NewThread, "NEW THREAD", threadRowCount() == 0,
                     browse.previewProjectId().length() > 0);
      addAction(Act::Reload, "REFRESH", false);
      addAction(Act::Agents, "AGENTS", false);
      return;
    case Screen::Environments:
    case Screen::Projects:
      addAction(Act::Reload, "REFRESH", false);
      return;
    case Screen::Send:
      if (voiceNeedsRecovery()) {
        const bool gatewayApproval = voice.reviewReason() == "gateway_approval" && voice.commandId().length() > 0;
        if (gatewayApproval) addAction(Act::VoiceReview, "NEEDS YOU", true);
        if (voice.hasJob()) addAction(Act::VoiceStatus, "RECHECK", !gatewayApproval);
        addAction(Act::VoiceConsole, "CONSOLE", false);
        if (voice.canDismissCapture()) addAction(Act::VoiceDismiss, "NEW CLIP", false);
      }
      return;
    case Screen::Actions:
      return;   // every row is its own control
    case Screen::Response: {
      if (!gw->responseOpen()) {
        addAction(Act::Refresh, "LOAD LATEST", true, haveThread());
        return;
      }
      const ThreadResponse& r = gw->response();
      // Recovery must remain reachable even when the last readable reply had many pages.
      if (r.state == "error") {
        addAction(Act::Retry, "RETRY REPLY", true);
        addAction(Act::ReturnThread, "THREAD", false);
        return;
      }
      String lines[kReplyMaxLines];
      const ResponseLayout layout = replyLayout(lines);
      if (r.pageCount > 1 || layout.pageCount > 1) {
        addAction(Act::PrevPage, "PREV", false, r.page > 0 || layout.page > 0);
        addAction(Act::NextPage, "NEXT", false, r.page + 1 < r.pageCount || layout.page + 1 < layout.pageCount);
        addAction(Act::ReturnThread, "THREAD", false);
        return;
      }
      if (gw->responseInFlight()) addAction(Act::Refresh, "REFRESH", false);
      addAction(Act::ReturnThread, "THREAD", false);
      return;
    }
    case Screen::Approvals: {
      if (gw->approvalCount() == 0) { addAction(Act::NotNow, "BACK TO THREAD", false); return; }
      addAction(Act::Reject, "REJECT", false);
      addAction(Act::Approve, "APPROVE", true);
      addAction(Act::NotNow, "NOT NOW", false);
      return;
    }
    case Screen::Wifi:
      if(wifiShowSaved)addAction(Act::WifiAdd,"ADD",true);
      else addAction(Act::WifiScan,"SCAN",true,!wifiScan.scanning);
      addAction(Act::WifiPhone,"PHONE",false);
      addAction(Act::WifiSaved,wifiShowSaved?"NEARBY":"SAVED",false);
      return;
    case Screen::WifiDetails:
      addAction(Act::WifiConnect,wifiTargetSaved||!wifiTargetSecured?"CONNECT":"PASSWORD",true,wifiTargetSupported);
      if(wifiTargetSaved) {
        addAction(Act::WifiEdit,"EDIT",false);
        addAction(Act::WifiForget,"FORGET",false,wifiTarget!=wifiConnection.activeSsid);
      }
      return;
    case Screen::WifiPhone:
      addAction(Act::WifiPhoneDone,phoneSetupSucceeded?"DONE":"CANCEL",false);
      if(phoneSetup.active && !phoneSetupSucceeded && !phoneSetup.waitingForHotspot) {
        if(phoneSetup.hotspotHandoff && !phoneSetup.apPassword.length())addAction(Act::WifiPhone,"SETUP AGAIN",true);
        else addAction(Act::WifiPhonePage,phoneShowPage?"JOIN WI-FI":"OPEN PAGE",true);
      }
      return;
    case Screen::WifiPassword:
      addAction(Act::WifiCancel,"CANCEL",false);
      addAction(Act::WifiPhone,"PHONE",false);
      addAction(Act::WifiConnect,wifiEditingSsid?"NEXT":"CONNECT",true,wifiJoinCanStart());
      return;
    case Screen::WifiJoining:
      addAction(Act::WifiCancel,wifiConnection.joinPending?"CANCEL":"BACK",false);
      if(!wifiConnection.joinPending)addAction(Act::WifiEdit,"EDIT",true);
      return;
    case Screen::Device:
      addAction(Act::WifiOpen,"WI-FI",true);
      addAction(Act::Portal, "PORTAL", false);
      addAction(Act::Reprovision, "RE-PROVISION", false);
      return;
    case Screen::Gateway:
      addAction(Act::Portal, "PORTAL", false);
      addAction(Act::Retry, "RE-PROBE", false);
      return;
    default:
      return;
  }
}

uint32_t signatureOfActions() {
  uint32_t sig = actionCount;
  for (uint8_t i = 0; i < actionCount; ++i) {
    sig = sig * 131u + (uint32_t)actions[i].id * 4u + (actions[i].enabled ? 2u : 0u)
      + (actions[i].primary ? 1u : 0u);
  }
  return sig;
}

Rect actionRect(uint8_t index, int16_t top) {
  constexpr int16_t kSide = 12;
  constexpr int16_t kGap = 8;
  const uint8_t n = actionCount == 0 ? 1 : actionCount;
  const int16_t span = (int16_t)(kW - kSide * 2 - kGap * (n - 1));
  const int16_t w = (int16_t)(span / n);
  return {(int16_t)(kSide + (int16_t)index * (w + kGap)), (int16_t)(top + 11), w, 36};
}

void paintActionBar() {
  const int16_t offset = (int16_t)((1.0f - uip::easeOutCubic(barT)) * kBarH);
  const int16_t top = (int16_t)(kH - kBarH + offset);
  g().fillRect(0, (int16_t)(kH - kBarH), kW, kBarH, panelGrey(kBg));
  barDirty = false;
  if (offset >= kBarH || actionCount == 0) return;

  // The hairline that separates the tray from the content.
  //
  // There is still no tray — no fill, no panel, no second surface; that was the whole point of
  // the version before this one. But the reference design's architecture is a header band, a
  // content field and a footer, divided by hairlines, and without the third line the buttons
  // float on the page with nothing saying they belong to the bottom of it. One curved rule, in
  // the same hairline grey as every other separator, and it rides up with the tray.
  uip::divider(20, (int16_t)(top + 5), (int16_t)(kW - 40));

  // No tray. The buttons sit on the page.
  //
  // There used to be a filled surface behind them, drawn ten pixels wider than the screen on each
  // side so that "only its top corners are ever visible". That was the mistake: pushing the shape
  // past the bezel put its curves off-glass and left a full-width band with HARD SQUARE CORNERS —
  // the most rectangular thing on a screen whose entire brief was to stop being rectangular. It
  // was also a second surface stacked on the page for no reason, when the button already has the
  // strongest shape and the strongest contrast on it.
  //
  // The reserved band stays: contentBottom() still stops short of these 58 px, so the buttons keep
  // their clear space and nothing scrolls underneath them. Only the fill is gone.
  for (uint8_t i = 0; i < actionCount; ++i) {
    uip::button(actionRect(i, top), actions[i].label, actions[i].primary, actions[i].enabled, kBg);
  }
}

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------

// Exactly one gesture operation may be in flight. Network work never draws or mutates UI
// state. Release/acquire publishes the bounded job and its result across the two tasks.
bool deferredStopPending = false;
DeviceControl deferredStop;
String deferredStopEnvironment, deferredStopThread;
uint32_t deferredStopRevision = 0;
TouchTargetLatch touchTarget;
TouchEventBuffer retainedTouches;
bool inputWasDiscarded = false;
bool replayingTouches = false;
TouchPerformanceWindow touchPerformance;
uint32_t touchPerformanceReportAt = 0;

#if HOSYOND_UI_PROFILE
// MEASUREMENT (HOSYOND_UI_PROFILE only, with the [touch-funnel] report).
//
// `input_n` in [ui-perf] is counted only AFTER the model lock is taken and AFTER a retained event
// passed its age/generation/revision check, and it ignores drags. Zero there therefore cannot tell
// "the glass was never sampled" from "events were sampled and then dropped before dispatch", which
// are opposite diagnoses. This funnel counts the same input at every stage so the stage where it
// disappears is visible:
//
//   contacts    new finger-down edges the driver itself recorded (touchContactId() delta). Read
//               from the driver's own monotonic sequence, so it is exact even if uiTick skipped
//               frames. 0 here with a finger on the glass = the controller/bus/driver, not the UI.
//   discrete    non-Drag, non-None events that reached uiHandleTouch (Press/Tap/Release/Swipe/Long).
//   drags       Drag events that reached uiHandleTouch.
//   held        uiTick entries on which the driver reported the glass touched.
//   retained    discrete events parked because the model lock was busy (or a replay was pending).
//   overflow    retained queue full: the whole pending sequence was cancelled.
//   stale       retained events that failed TouchEventBuffer::current() on replay (older than
//               750 ms, or navigation generation / model revision moved) and were thrown away.
//   dispatched  discrete events that ran the dispatch (same population as [ui-perf] input_n).
//   tick_gap_max  longest gap between consecutive uiTick entries. Input is sampled at most once
//               per loop() pass, so this is the worst-case age a touch can have before it is read.
// What a uiTick() pass turned out to be, recorded by an exit guard so every return path is covered.
enum : uint8_t { kTickNotDue, kTickLockSkip, kTickRecording, kTickPainted };
const char* const kTickKindName[] = {"not-due", "lock-skip", "recording", "painted"};
uint32_t lastTickDurUs = 0, lastSleepUs = 0;
uint8_t lastTickKind = kTickNotDue;

struct TouchFunnel {
  uint32_t contacts = 0, discrete = 0, drags = 0, held = 0, retained = 0, overflow = 0, stale = 0;
  uint32_t dispatched = 0, ticks = 0, lockSkips = 0, painted = 0;
  // Taps that reached for the gateway job slot while it was taken (see pendingGesture):
  //   queued    held for replay; superseded replaces an earlier held tap, which is counted in lost
  //   replayed  held taps that ran when the slot freed
  //   lost      held taps that expired, went stale, or were superseded (the person was told)
  //   refused   gestures that found the slot taken and could not be held (the person was told)
  // A non-zero `refused` after this change is a call path that still starts work behind a tap.
  uint32_t queued = 0, replayed = 0, lost = 0, refused = 0;
  // The longest gap between tick entries and what it was made of: the previous tick's own duration
  // (and what kind of pass it was), the sleep after it, and the remainder, which is loop() work
  // outside uiTick (touchPoll, provisioning.poll, qualification, the boot button).
  uint32_t gapMaxUs = 0, gapTickUs = 0, gapSleepUs = 0;
  uint8_t gapKind = 0;
  uint32_t ageSum = 0, ageMax = 0;
  uint32_t lastContactId = 0, lastTickAt = 0, windowAt = 0, quietWindows = 0, lastTickEnterUs = 0;
  bool primed = false;
} touchFunnel;
#endif  // HOSYOND_UI_PROFILE

// Defined after the queue below. Declared here so queueResponsePage(), the first job starter after
// the queue, can use it without moving text the queue's native test slices by name.
bool submitUiJob(std::function<void()> work, std::function<void()> completion, bool background = false);

bool uiNetworkReady = false;
std::atomic<unsigned> uiJobState{0}; // idle / queued / complete
std::function<void()> uiJobWork;
std::function<void()> uiJobCompletion;
DispatchResult uiDispatchResult;
bool uiOperationSucceeded = false;
GatewayBrowse uiStagedBrowse;
uint32_t navigationGeneration = 0;
String pendingControlEnvironment;
String pendingControlThread;
uint32_t pendingControlRevision = 0;

bool uiNetworkBusy() { return uiJobState.load(std::memory_order_acquire) != 0; }

// Drained by GatewayClient's existing network task; no extra TLS-sized task stack.
void uiNetworkLoop() {
  if (uiJobState.load(std::memory_order_acquire) != 1) return;
  uiJobWork();
  uiJobState.store(2, std::memory_order_release);
}

bool enqueueUiNetworkJob(std::function<void()> work, std::function<void()> completion) {
  if (!uiNetworkReady) {
    message = "Network worker unavailable; restart device";
    contentDirty = true;
    return false;
  }
  if (uiNetworkBusy()) return false;
  uiJobWork = std::move(work);
  uiJobCompletion = std::move(completion);
  uiJobState.store(1, std::memory_order_release);
  return true;
}

void completeUiNetworkJob() {
  if (uiJobState.load(std::memory_order_acquire) != 2) return;
  auto completion = std::move(uiJobCompletion);
  uiJobWork = nullptr;
  uiJobState.store(0, std::memory_order_release);
  if (completion) completion();
  chromeDirty = true;
  contentDirty = true;
}

// Reads one page of the reply, or opens the reply when `open`. `background` marks a read that only
// revalidates what the screen already shows (see submitUiJob). A refused job leaves the screen as
// it was and says so: nothing may keep waiting on a read that is not going to run.
void queueResponsePage(int page, bool open = false, const String& after = String(), bool background = false) {
  const uint32_t generation = navigationGeneration;
  const String environment = gw->context().environmentId;
  const String thread = gw->context().threadId;
  if (!submitUiJob([page, open, after, environment, thread] {
    gw->lockState();
    if (environment == gw->context().environmentId && thread == gw->context().threadId) {
      if (open) gw->openResponse(after);
      else gw->fetchResponsePage(page);
    }
    gw->unlockState();
  }, [generation] {
    replyLoadPending = false;
    if (generation == navigationGeneration) contentDirty = true;
  }, background)) {
    replyPendingRemotePage = -1;
    replyLoadPending = false;
  }
}

// ---------------------------------------------------------------------------------------------
// The job slot, and the taps that reach for it
// ---------------------------------------------------------------------------------------------
//
// There is one gateway job at a time. Every way of reaching for it must end in exactly one of: it
// runs; it is held and runs when the slot frees (pendingGesture, below); or the person is told it
// did not run. "Silently nothing" is the one outcome that is never acceptable, because from the
// glass it is indistinguishable from a button that is broken.

// The in-flight job only revalidates something already painted. Meaningful only while busy, and
// refreshed by every submitUiJob() (the sole caller that can change it while a job is in flight).
bool uiJobBackground = false;
PendingGesture pendingGesture;
bool uiJobKicked = false;

bool uiBarLocked() { return uiNetworkBusy() && !uiJobBackground; }

// Whether a gesture may begin work that stages state for a job. Checked BEFORE anything is staged or
// painted: the staged browser copy (uiStagedBrowse) is owned by the in-flight job's network thread
// until it completes, so even assigning to it from a second gesture is a data race, never mind
// the dropped enqueue that follows.
bool uiJobSlotFree() { return uiNetworkReady && !uiNetworkBusy(); }

// The one visible answer to a gesture that found the slot taken. It also repaints, which retires any
// pending-state card the gesture drew on its way in.
void gestureRefused() {
  UI_PROFILE(++touchFunnel.refused;)
  if (!uiNetworkReady) return;   // enqueueUiNetworkJob() has already said the worker is unavailable
  message = "Busy; tap again";
  contentDirty = true;
}

// Every gesture job starts here. Returns false, with the refusal already visible, when the slot is
// not free. `background` is for a read that merely refreshes data already on screen (thread list
// revalidation, reply refresh): the action bar stays live during it, and a button pressed meanwhile
// is held by the touch router and replayed when the job ends.
bool submitUiJob(std::function<void()> work, std::function<void()> completion, bool background) {
  if (!enqueueUiNetworkJob(std::move(work), std::move(completion))) {
    gestureRefused();
    return false;
  }
  uiJobBackground = background;
  return true;
}

// Local subpages are read without a network request; only crossing a gateway page starts HTTP.
void stepReplyPage(int direction) {
  if (!gw->responseOpen() || gw->response().state == "error") return;
  String lines[kReplyMaxLines];
  const ResponseLayout layout = replyLayout(lines);
  if (direction > 0 && layout.page + 1 < layout.pageCount) ++replyLocalPage;
  else if (direction < 0 && layout.page > 0) --replyLocalPage;
  else {
    const ThreadResponse& r = gw->response();
    if ((direction > 0 && r.page + 1 >= r.pageCount) || (direction < 0 && r.page == 0)) {
      contentDirty = true;
      return; // A visible beginning/end never wraps into different text.
    } else {
      const int next = r.page + (direction > 0 ? 1 : -1);
      replyPendingRemotePage = next;
      replyPendingLocalPage = direction > 0 ? 0 : (size_t)-1;
      queueResponsePage(next);
    }
  }
  chromeDirty = true;
  contentDirty = true;
}

// Paint the pending state immediately; all socket work is scheduled off the render task.
void showBusy(const String& title, const String& detail) {
  message = "";
  if (!displayReady()) return;
  closeDrawerNow();
  drawHeader();
  clearContent();
  uip::textCentered(kContentTop + 70, 2, kBright, uip::fitWords(title, kCols2));
  uip::textCentered(kContentTop + 102, 1, kMuted, uip::fitWords(detail, kCols1));
  contentDirty = true;
}

void goTo(Screen next) {
  closeDrawerNow();
  if (screen == next) return;
  if(screen==Screen::WifiPassword)wifiPassword="";
  if(screen==Screen::WifiPhone && next!=Screen::WifiPhone){prov->endPhoneSetup();phoneQr.clear();phoneSetup=PhoneSetupSnapshot();}
  pickerMotion = PickerMotion();
  // Navigation never dismisses a recording or an unresolved cloud receipt.
  screen = next;
  navigationGeneration += 1;
  pickerOpenResponse = false;
  modal = Modal::None;
  chromeDirty = true;
  contentDirty = true;
}

// Opening the reply: the screen change and its first paint are local, and the gateway is asked
// behind them. With a held copy (or an already-open model) the person is reading before the network
// has been touched; with neither, the screen says it is loading instead of claiming nothing is open.
// A read that only refreshes something already on screen is a background job, so the bar stays live.
void openReply() {
  if (!haveThread()) { goTo(Screen::Response); return; }
  goTo(Screen::Response);
  sealHeldRepliesToRealm();
  if (!gw->responseOpen()) {
    const bool havePaint = heldReplies.find(gw->context().environmentId, gw->context().threadId) != nullptr;
    replyLoadPending = true;
    replyRefreshedAt = millis();
    queueResponsePage(0, true, String(), havePaint);
    return;
  }
  // Open already (the model survives leaving the screen). Revalidate unless it is a live turn the
  // poll is already following, or was read moments ago.
  if (gw->responseInFlight()) return;
  if (millis() - replyRefreshedAt < kReplyFreshMs) return;
  replyRefreshedAt = millis();
  queueResponsePage(gw->response().page, false, String(), true);
}

void refreshProjects();

void goBack() {
  if (modal != Modal::None) { modal = Modal::None; contentDirty = true; return; }
  switch (screen) {
    case Screen::WifiPhone: goTo(Screen::Wifi);return;
    case Screen::WifiPassword:
      wifiPassword="";goTo(wifiEditingSsid?Screen::Wifi:Screen::WifiDetails);return;
    case Screen::WifiDetails: goTo(Screen::Wifi);return;
    case Screen::WifiJoining:
      prov->cancelWifiJoin();wifiPassword="";goTo(Screen::Wifi);return;
    case Screen::Wifi: goTo(Screen::Device);return;
    case Screen::Projects:     goTo(Screen::Environments); return;
    case Screen::Environments: goTo(Screen::Home); return;
    case Screen::Threads:      goTo(Screen::Projects); refreshProjects(); return;
    case Screen::Actions:      goTo(Screen::Home); return;
    // An unclaimed device's home IS the claim screen; sending it to a home it does not have would
    // land on a thread label for a thread it cannot see.
    default:                   goTo(operable() ? Screen::Home : Screen::Status); return;
  }
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

// What to do with a dispatch that was accepted. A turn that produces an assistant reply opens the
// response and switches to it — that is the whole "fire it and watch the answer arrive" gesture —
// while status and stop, which produce no new turn, stay put and just report.
void afterDispatch(const DispatchResult& result, bool expectReply) {
  message = result.detail;
  if (result.hasScreen) {
    message = result.screen.line1 + " " + result.screen.line2;
    contentDirty = true;
    return;
  }
  if (result.requiresApproval) {
    approvalIndex = 0;
    goTo(Screen::Approvals);
    return;
  }
  if (result.accepted && expectReply
      && (result.status == "dispatched" || result.status == "completed")) {
    showBusy("Sent", "Waiting for the agent");
    goTo(Screen::Response);
    queueResponsePage(0, true, result.responseAfter);
    return;
  }
  contentDirty = true;
}

void dispatchControl(const DeviceControl& c) {
  // Local, not a dispatch: wiping Wi-Fi has no gateway side.
  if (c.kind == "reset") {
    message = "Re-entering provisioning";
    contentDirty = true;
    prov->resetToProvisioning();
    return;
  }
  // Status and stop produce no new assistant turn, so there is nothing to open a response for. A
  // v1 row carries its verb in the id rather than the kind, which is why both are consulted.
  const bool quiet = c.kind == "status" || c.kind == "stop"
    || (c.kind == "legacy" && (c.id == "status" || c.id == "stop"));
  const bool expectReply = !quiet;
  // Before painting a pending card for it: a send that cannot start must not look as if it did.
  if (!uiJobSlotFree()) { gestureRefused(); return; }
  showBusy(c.label, "Sending to selected task");
  const DeviceControl control = c;
  const String environment = gw->context().environmentId;
  const String thread = gw->context().threadId;
  const uint32_t generation = navigationGeneration;
  const uint32_t layout = gw->controlsRevision();
  submitUiJob([control, environment, thread, layout] {
    gw->lockState();
    if (gw->context().environmentId != environment || gw->context().threadId != thread
        || gw->controlsRevision() != layout) {
      uiDispatchResult = DispatchResult();
      uiDispatchResult.detail = "Context changed; review again";
    } else uiDispatchResult = gw->runControl(control);
    gw->unlockState();
  }, [generation, expectReply, environment, thread] {
    if (environment != gw->context().environmentId || thread != gw->context().threadId) {
      message = uiDispatchResult.accepted ? "Sent to previous thread; see console" : uiDispatchResult.detail;
      return;
    }
    if (generation == navigationGeneration) afterDispatch(uiDispatchResult, expectReply);
  });
}

void confirmControl(const DeviceControl& c) {
  pendingControl = c;
  pendingControlEnvironment = gw->context().environmentId;
  pendingControlThread = gw->context().threadId;
  pendingControlRevision = gw->controlsRevision();
  modal = Modal::ConfirmControl;
  contentDirty = true;
}

void runControlRow(const DeviceControl& c) {
  if (!c.enabled) {
    message = c.reason.length() > 0 ? c.reason : String("Unavailable");
    contentDirty = true;
    return;
  }
  if (c.requiresThread && !haveThread()) {
    message = "Select a thread first";
    contentDirty = true;
    return;
  }
  // A capture action needs a clip, and the clip comes from the microphone button. Saying so beats
  // dispatching an action with no media id and letting the gateway explain it 5 s later.
  if (c.kind == "capture_audio" || (c.kind == "remote_action" && c.mediaKind == "audio")) {
    // A saved audio action has its own template, target and confirmation contract.
    // Generic Talk auto-dispatches a voice note and cannot stand in for that action.
    message = "Saved audio needs the web console";
    contentDirty = true;
    return;
  }
  if (c.kind == "capture_image") {
    message = "No camera on this board";
    contentDirty = true;
    return;
  }
  // Local confirmation is the device's own review step and is a separate gate from gateway
  // approval. Stop and reset are always confirmed regardless of what the layout says: both are
  // destructive and neither can be undone from here.
  if (c.requiresConfirmation || c.kind == "stop" || c.kind == "reset") {
    confirmControl(c);
    return;
  }
  dispatchControl(c);
}

void discardClip() {
  if (!voice.canDismissCapture()) return;
  if (uiNetworkBusy()) { gestureRefused(); return; }
  clipHeld = false;
  clipHeldMs = 0;
  audio::discard();
  voice.reset();
  message = "Clip discarded";
  contentDirty = true;
}

// One complete frame of the full-page voice moment, painted synchronously. Used immediately before
// a blocking call so the still image the person is left looking at is the correct one.
void paintVoiceMomentNow() {
  if (!displayReady()) return;
  closeDrawerNow();
  screen = Screen::Send;
  applyPresentation();
  statusLabel = currentLabel;
  shownLabel = "";
  // The bar band is cleared by hand: buildActions() will agree there is nothing to press, but that
  // does not happen until the next frame and this one is the last for a while.
  g().fillRect(0, (int16_t)(kH - kBarH), kW, kBarH, panelGrey(kBg));
  barT = 0.0f;
  barReserved = false;
  paintSend();
  const uint32_t elapsed = millis() - orbStartedAt;
  if (orbReady) displayDrawOrb(orb, kOrbCx, stack.orbCy, elapsed, kOrbDrawPx);
  if (stack.label) displayDrawStatus(currentLabel, stack.labelY, elapsed);
  contentDirty = true;
}

// Captured PCM remains immutable until the bounded worker completes. A failed transfer keeps it
// available for explicit retry, and a successful upload follows the one server-owned voice job.
void sendHeldClip() {
  if (!clipHeld) return;
  if (uiNetworkBusy()) { gestureRefused(); return; }
  if (gw->context().environmentId != voiceCaptureEnvironment
      || gw->context().threadId != voiceCaptureThread) {
    message = "Thread changed; reselect the recording's thread or discard";
    contentDirty = true;
    return;
  }
  const size_t bytes = audio::recordedBytes();
  if (bytes == 0) { discardClip(); return; }

  struct VoiceUploadWork {
    GatewayVoice state;
    uint8_t header[media::kWavHeaderBytes];
    String mediaId;
    int httpStatus = -1;
  };
  auto work = std::make_shared<VoiceUploadWork>();
  work->state = voice;
  media::buildWavHeader(work->header, static_cast<uint32_t>(bytes), audio::sampleRateHz());
  const uint8_t* pcm = audio::pcm();
  if (!submitUiJob([work, pcm, bytes]() {
        work->mediaId = work->state.upload("audio", "audio/wav", "controller.wav", work->header,
          sizeof(work->header), pcm, bytes, MEDIA_UPLOAD_MAX_BYTES, work->httpStatus);
      }, [work]() {
        if (work->mediaId.length() == 0) {
          // Keep the exact capture, so Retry resumes its idempotent session rather than losing it.
          voice = work->state;
          voice.setLocalStage(VoiceStage::Recorded);
          message = work->httpStatus == 413 ? String("Clip too large; record a shorter note")
            : work->httpStatus == 429 ? String("Gateway busy; recording kept. Retry shortly")
            : String("Upload failed; recording kept. Retry SEND");
          contentDirty = true;
          return;
        }
        voice = work->state;
        clipHeld = false;
        clipHeldMs = 0;
        audio::discard();
        // Device uploads enqueue transcription and its policy-controlled auto-send themselves.
        // Sending an audio_prompt here would run the same voice note twice and bypass review.
        if (!voice.tracking()) {
          message = voice.detail().length() > 0 ? voice.detail()
            : String("Uploaded; check voice note in the console");
        } else {
          message = "Transcribing";
        }
        contentDirty = true;
      })) return;
  voice.setLocalStage(VoiceStage::Uploading);
  paintVoiceMomentNow();
}

// Ends the recording and HOLDS it. Nothing leaves the device here.
void finishRecording() {
  recordArmed = false;
  audio::stopRecording();
  const uint32_t ms = audio::recordedMs();
  const size_t bytes = audio::recordedBytes();

  const audio::ClipStats st = audio::measureClip();
  audio::printClipVerdict(st);

  if (audio::captureFailed()) {
    audio::discard();
    voice.reset();
    clipHeld = false;
    clipHeldMs = 0;
    message = "Microphone read failed; record again";
    contentDirty = true;
    return;
  }
  if (ms < audio::minimumClipMs() || bytes == 0) {
    audio::discard();
    voice.reset();
    clipHeld = false;
    clipHeldMs = 0;
    message = "Too short - hold longer";
    contentDirty = true;
    return;
  }

  if (st.peak == 0) {
    audio::discard();
    voice.reset();
    clipHeld = false;
    clipHeldMs = 0;
    message = "No microphone signal; try recording again";
    contentDirty = true;
    return;
  }
  clipHeld = true;
  clipHeldMs = ms;
  voice.setLocalStage(VoiceStage::Recorded);
  message = "";
  contentDirty = true;
}

void startRecording() {
  if (uiNetworkBusy() || screen != Screen::Send || modal != Modal::None || clipHeld
      || voiceInJourney() || !voice.canStartCapture()) return;
  if (!audio::available()) {
    message = "This build has no microphone";
    contentDirty = true;
    return;
  }
  if (!haveThread()) {
    message = "Select a thread first";
    contentDirty = true;
    return;
  }
  // startRecording() drops whatever was held, so the flag has to go with it or the bar would offer
  // to send a clip that no longer exists.
  clipHeld = false;
  clipHeldMs = 0;
  const String environment = gw->context().environmentId;
  const String thread = gw->context().threadId;
  if (!voice.beginCapture(environment, thread)) return;
  voiceCaptureEnvironment = environment;
  voiceCaptureThread = thread;
  voiceCaptureTitle = threadTitle();
  recordArmed = true;
  audio::startRecording();
  // Wave, and the mini orb is told about it here — the pump branch below never reaches
  // applyPresentation().
  applyPresentation();
  statusLabel = currentLabel;
  recordPaintedAt = 0;
  recordOrbAt = 0;
  // Arrival, through the one place that does arrivals. The pump takes the loop over on the very
  // next pass and never reaches the frame's own transition check, so it has to happen now — and
  // going through clearForArrival() is what stops the previous state's destination lines being left
  // on the glass beside the capsule.
  clearForArrival();
  if(!displayComposeScene(kContentTop,kH-kContentTop,panelGrey(kBg),[](void*){paintContent();},nullptr)) {
    g().fillRect(0,kContentTop,kW,kH-kContentTop,panelGrey(kBg));
    paintContent();
  }
}

// Writes a pending selection through, or does nothing when there is none.
//
// Called from two places and it matters that it is the same code: the debounce timer, and OPEN —
// which must commit BEFORE it opens, because selectThread() closes the open response and doing it
// the other way round would arm the reply and then immediately discard it.
void commitPicker() {
  if (pickerCommitAt == 0 || uiNetworkBusy()) return;
  pickerCommitAt = 0;
  const int target = pickerIndex;
  pickerIndex = -1;
  if (target < 0 || target == boundThreadIndex()) {
    const bool open = pickerOpenResponse;
    pickerOpenResponse = false;
    if (open && haveThread()) openReply();
    return;
  }
  const ThreadOption* row = gw->thread((size_t)target);
  if (!row) return;
  const String targetId = row->id;
  // True only if the write actually started: a refused job must not leave the highlight claiming a
  // bind in progress that nothing will ever complete.
  pickerBinding = submitUiJob([target, targetId] {
    gw->lockState();
    const ThreadOption* current = gw->thread((size_t)target);
    uiOperationSucceeded = current && current->id == targetId && gw->selectThread((size_t)target);
    gw->unlockState();
  }, [] {
    pickerBinding = false;
    const bool open = pickerOpenResponse;
    pickerOpenResponse = false;
    if (open && uiOperationSucceeded) openReply();
    message = uiOperationSucceeded ? "" : "Not confirmed; reload threads";
    contentDirty = true;
  });
}


// ---------------------------------------------------------------------------------------------
// THREADS is local-first
// ---------------------------------------------------------------------------------------------
//
// Entering the screen used to blank the list and then run two serial requests (environments, then
// threads) before painting a row, although the device already held that list: the gateway cycle
// refreshes it every 30 s and HOME's picker steps through it. The data was on the glass one screen
// ago and the person waited for the network to be told what they were already looking at.
//
// So the screen now paints what is held, at once, and checks it with the gateway BEHIND the list:
//   * the held rows are shown only when GatewayClient says the gateway stamped them for exactly this
//     environment and folder (threadListMatches), never on the strength of "it was the last list";
//   * the check is a background job: the action bar stays live, and USE THREAD pressed while it runs
//     is held and replayed when it ends (pendingGesture);
//   * the highlighted row is re-found by id when the list is replaced, so it does not jump;
//   * binding a thread is untouched in spirit: a paint is optimistic, a write is not. The only write
//     is still commitPreviewThread(): one server round trip validated against the live snapshot, and
//     nothing is bound locally until the gateway confirms it.

int16_t maxScroll(size_t count, int16_t rowH, int16_t top);

bool environmentKnown(const String& id) {
  if (id.length() == 0) return false;
  for (size_t i = 0; i < browse.environmentCount(); ++i) {
    const BrowseEnvironment* row = browse.environment(i);
    if (row && row->id == id) return true;
  }
  return false;
}

// Seeds the preview list from the client's held list when, and only when, it is that destination's.
bool seedHeldThreads() {
  if (!gw->threadListMatches(browse.previewEnvironmentId(), browse.previewProjectId())) return false;
  browse.seedPreviewThreads(gw->threadCount(), [](size_t i) { return gw->thread(i); });
  threadsFetched = true;
  return true;
}

// Keeps the person's highlighted row (by id) when the list under it is replaced.
bool reconcilePreviewSelection() {
  if (previewThreadId.length() == 0) { previewThreadIndex = -1; return true; }
  for (size_t i = 0; i < browse.previewThreadCount(); ++i) {
    const ThreadOption* row = browse.previewThread(i);
    if (row && row->id == previewThreadId) { previewThreadIndex = (int)i; return true; }
  }
  previewThreadIndex = -1;
  previewThreadId = "";
  return false;
}

// Publishes a revalidation. Replacing the browser wholesale is safe here: the slot is exclusive, and
// the only gesture allowed through while it runs (previewing a row) touches no browser state.
void finishThreadsRevalidation() {
  threadsLoading = false;
  browse = uiStagedBrowse;
  threadsFetched = true;
  const bool hadSelection = previewThreadId.length() > 0;
  const bool kept = reconcilePreviewSelection();
  const int16_t limit = maxScroll(browse.previewThreadCount(), kThreadRowH, kThreadListTop);
  if (threadScroll > limit) threadScroll = limit;
  message = hadSelection && !kept ? String("That thread is no longer listed") : browse.previewDetail();
  contentDirty = true;
  barDirty = true;
}

// Asks the gateway to confirm the list behind the one on screen. `announce` is for an explicit
// REFRESH, which should acknowledge itself; the automatic check on entry stays silent.
bool startThreadsRevalidation(bool withEnvironments, bool announce) {
  if (!uiJobSlotFree()) { gestureRefused(); return false; }
  uiStagedBrowse = browse;
  threadsLoading = true;
  if (announce) { message = "Refreshing"; contentDirty = true; }
  if (submitUiJob([withEnvironments] {
        if (withEnvironments) uiStagedBrowse.refreshEnvironments();
        uiStagedBrowse.refreshPreviewThreads();
      }, [] { finishThreadsRevalidation(); }, /*background=*/true)) return true;
  threadsLoading = false;
  return false;
}

void refreshThreads() {
  startThreadsRevalidation(false, true);
}

void goToThreads() {
  if (!uiJobSlotFree()) { gestureRefused(); return; }
  agentBrowseMode = 0; selectedAgentRow = -1;
  const String environment = gw->context().environmentId;
  browse.beginPreview(environment, gw->context().projectId);
  seedHeldThreads();
  previewThreadIndex = -1;
  previewThreadId = "";
  threadScroll = 0;
  message = "";
  goTo(Screen::Threads);
  // The environment list only names the breadcrumb, and it changes when a host is paired: it is
  // fetched when the name is not already known, not on every visit.
  startThreadsRevalidation(!environmentKnown(environment), false);
}

void selectThreadRow(size_t index) {
  if (agentBrowseMode) { selectedAgentRow = (int)index; contentDirty = true; barDirty = true; return; }
  const ThreadOption* row = browse.previewThread(index);
  if (!row) return;
  previewThreadIndex = (int)index;
  previewThreadId = row->id;
  message = "Preview only; use thread below";
  contentDirty = true;
  barDirty = true;
}

void usePreviewThread() {
  const int index = previewThreadIndex;
  const ThreadOption* row = index < 0 ? nullptr : browse.previewThread((size_t)index);
  if (!row || row->id != previewThreadId) { message = "Choose a thread again"; return; }
  if (!uiJobSlotFree()) { gestureRefused(); return; }
  const uint32_t generation = navigationGeneration;
  const String id = row->id;
  const String title = row->title;
  uiStagedBrowse = browse;
  showBusy("Use thread", uip::fitWords(title, kCols1));
  submitUiJob([index, id] {
    const ThreadOption* candidate = uiStagedBrowse.previewThread((size_t)index);
    uiOperationSucceeded = candidate && candidate->id == id
      && uiStagedBrowse.commitPreviewThread((size_t)index);
    if (uiOperationSucceeded) {
      gw->clearContextBinding(uiStagedBrowse.boundEnvironmentId(), uiStagedBrowse.boundProjectId());
      gw->adoptThreadBinding(id);
    }
  }, [generation, id, title] {
    browse = uiStagedBrowse;
    message = uiOperationSucceeded ? "Thread selected" : browse.previewDetail();
    if (!uiOperationSucceeded) return;
    createdRow = ThreadOption();
    createdRow.id = id;
    createdRow.title = title;
    createdRow.selected = true;
    browse.endPreview();
    previewThreadIndex = -1;
    if (generation == navigationGeneration) goTo(Screen::Home);
  });
}

// The single door into THREADS.
//
// Three call sites used to open it and each remembered a different subset of what has to be true
// when it does: a thread list, and an environment NAME for the breadcrumb. The environment listing
// is a per-user store read on the gateway — no T3 round trip — so fetching it here costs one fast
// request and is what stops the breadcrumb showing a raw id.
void goToThreads();

// One tap: creates a thread in the bound folder, and the gateway binds it before it answers.
//
// No keyboard, no prompt, no title. The gateway names it "<D Mon HH:MM> - <device label>" with
// uniqueness guaranteed, and T3 only auto-retitles a thread still carrying its own default, so that
// is the name the thread keeps.
void createThreadNow() {
  if (!uiJobSlotFree()) { gestureRefused(); return; }
  showBusy("New thread", "Asking the gateway");
  uiStagedBrowse = browse;
  submitUiJob([] { uiOperationSucceeded = uiStagedBrowse.createThread(); }, [] {
  browse = uiStagedBrowse;
  if (!uiOperationSucceeded) {
    // A refused create changes NOTHING server-side: the device stays on the thread it was on. So
    // the highlight goes back to the bound row and the line never shows something uncreated.
    pickerIndex = -1;
    pickerCommitAt = 0;
    message = browse.createDetail();
    contentDirty = true;
    return;
  }

  // Spliced, not re-fetched. The row is shaped exactly like one from GET /v1/device/threads.
  const BrowseThread& made = browse.createdThread();
  createdRow = ThreadOption();
  createdRow.id = made.id;
  createdRow.title = made.title;
  createdRow.status = made.status;
  createdRow.status.toUpperCase();
  createdRow.selected = true;

  // The client is told what the gateway has ALREADY made true.
  //
  // The create binds server-side, but GatewayClient's own `context_.threadId` would not know until
  // its 60 s config poll — and until it did, postIntent() would keep stamping the PREVIOUS thread's
  // id on every dispatch, so a voice note recorded in that window would land in the wrong
  // conversation. adoptThreadBinding() closes that synchronously with the authoritative id in hand:
  // it is not selectThread(), which validates an index against a list that cannot yet contain this
  // thread. It also closes the open response, because that model is an answer about the
  // conversation the user has just left.
  gw->clearContextBinding(browse.boundEnvironmentId(), browse.boundProjectId());
  gw->adoptThreadBinding(made.id);

  // The recording keeps its original destination and receipt until explicit safe dismissal.

  pickerIndex = -1;
  pickerCommitAt = 0;
  threadsFetched = true;
  browse.endPreview();
  message = "Thread created";
  goTo(Screen::Home);
  contentDirty = true;
  });
}

void browseDirectAgents(bool sessions) {
  const BrowseAgent* selected = selectedAgentRow < 0 ? nullptr : browse.agent((size_t)selectedAgentRow);
  if (sessions && !selected) return;
  const String runtimeId = selected ? selected->runtimeId : String();
  const String model = selected ? selected->model : String();
  if (!uiJobSlotFree()) { gestureRefused(); return; }
  uiStagedBrowse = browse;
  showBusy(sessions ? "Saved sessions" : "Agents", "Reading selected folder");
  submitUiJob([sessions, runtimeId, model] {
    uiOperationSucceeded = sessions ? uiStagedBrowse.refreshNativeSessions(runtimeId, model) : uiStagedBrowse.refreshAgents();
  }, [sessions] {
    browse = uiStagedBrowse;
    agentBrowseMode = uiOperationSucceeded && browse.directAgentsSupported() ? (sessions ? 2 : 1) : 0;
    selectedAgentRow = -1; threadScroll = 0; message = browse.agentDetail(); contentDirty = true; barDirty = true;
  });
}

void applyDirectAgent(bool resume) {
  if (selectedAgentRow < 0) return;
  const int index = selectedAgentRow;
  const String thread = gw->context().threadId;
  const String environment = gw->context().environmentId;
  if (!uiJobSlotFree()) { gestureRefused(); return; }
  uiStagedBrowse = browse;
  showBusy(resume ? "Continue session" : "Change agent", "Waiting for confirmation");
  submitUiJob([resume, index, thread, environment] {
    uiOperationSucceeded = gw->context().threadId == thread && gw->context().environmentId == environment
      && (resume ? uiStagedBrowse.resumeNativeSession((size_t)index, thread) : uiStagedBrowse.useAgent((size_t)index, thread));
    if (uiOperationSucceeded && resume) {
      gw->clearContextBinding(uiStagedBrowse.boundEnvironmentId(), uiStagedBrowse.boundProjectId());
      gw->adoptThreadBinding(uiStagedBrowse.createdThread().id);
    }
  }, [] {
    browse = uiStagedBrowse; message = browse.agentDetail();
    if (uiOperationSucceeded) { agentBrowseMode = 0; selectedAgentRow = -1; browse.endPreview(); goTo(Screen::Home); }
    contentDirty = true; barDirty = true;
  });
}

void refreshEnvironments() {
  if (!uiJobSlotFree()) { gestureRefused(); return; }
  showBusy("Environments", "Asking the gateway");
  uiStagedBrowse = browse;
  submitUiJob([] { uiStagedBrowse.refreshEnvironments(); }, [] {
    browse = uiStagedBrowse;
    envScroll = 0;
  });
}


void refreshProjects() {
  if (!uiJobSlotFree()) { gestureRefused(); return; }
  showBusy("Folders", "Asking the gateway");
  uiStagedBrowse = browse;
  submitUiJob([] { uiStagedBrowse.refreshProjects(); }, [] {
    browse = uiStagedBrowse;
    projectScroll = 0;
  });
}


void selectEnvironmentRow(size_t index) {
  if (!uiJobSlotFree()) { gestureRefused(); return; }
  if (!browse.previewEnvironment(index)) return;
  goTo(Screen::Projects);
  refreshProjects();
}

void selectProjectRow(size_t index) {
  if (!uiJobSlotFree()) { gestureRefused(); return; }
  if (!browse.previewProject(index)) return;
  // Another folder's threads: the old highlight and scroll belong to a list that is gone. If the
  // device happens to hold this folder's list (the one it is bound to), it is shown at once.
  previewThreadIndex = -1;
  previewThreadId = "";
  threadScroll = 0;
  seedHeldThreads();
  goTo(Screen::Threads);
  refreshThreads();
}


void answerApproval(const String& commandId, const String& label, bool approve) {
  if (commandId.length() == 0) return;
  if (!uiJobSlotFree()) { gestureRefused(); return; }
  showBusy(approve ? "Approving" : "Rejecting", uip::fit(label, kCols1));
  const uint32_t generation = navigationGeneration;
  const String environment = gw->context().environmentId;
  const String thread = gw->context().threadId;
  submitUiJob([commandId, approve] {
    uiDispatchResult = gw->answerApproval(commandId, approve);
  }, [generation, environment, thread, approve] {
    message = uiDispatchResult.detail;
    approvalIndex = 0;
    if (approve && generation == navigationGeneration
        && environment == gw->context().environmentId && thread == gw->context().threadId) {
      afterDispatch(uiDispatchResult, true);
    }
  });
}

// Where a drawer row goes. Each category navigates to the screen that ACTS on it, which is the
// whole reason the drawer is navigation rather than a status panel with an OK button.
void openCategory(Row row) {
  switch (row) {
    case Row::Device:
      goTo(Screen::Device);
      return;
    case Row::Gateway:
      goTo(Screen::Gateway);
      return;
    case Row::Thread:
      goToThreads();
      return;
    default:
      // An approval queue is the thing that most needs a person; a reply is what they came for
      // otherwise.
      if (gw->hasBlockingRequests()) {
        approvalIndex = 0;
        goTo(Screen::Approvals);
        return;
      }
      openReply();
      return;
  }
}

void refreshWifiUi() {
  wifiScan=prov->wifiScanSnapshot();
  wifiConnection=prov->wifiConnectionSnapshot();
  wifiSavedNames=store->savedWifiNamesSnapshot();
  wifiConnection.savedCount=wifiSavedNames.size();
  for(size_t i=0;i<wifiScan.count;++i) {
    wifiScan.networks[i].saved=false;
    for(const auto& name:wifiSavedNames)if(name==wifiScan.networks[i].ssid)wifiScan.networks[i].saved=true;
  }
  wifiObservedRevision=prov->wifiRevision();
}
void openWifiUi() {
  wifiPassword="";wifiScroll=0;wifiShowSaved=false;
  refreshWifiUi();goTo(Screen::Wifi);
  if(!wifiScan.scanning)prov->startWifiScan();
  refreshWifiUi();message="";
}
void editWifiPassword(bool ssid=false) {
  wifiEditingSsid=ssid;wifiPassword="";
  wifiKeyboardOffset=0;wifiKeyboardSymbols=false;wifiKeyboardUpper=false;message="";
  goTo(Screen::WifiPassword);
}
void chooseWifiRow(size_t index) {
  if(wifiShowSaved) {
    if(index>=wifiSavedNames.size())return;
    wifiTarget=wifiSavedNames[index];wifiTargetSaved=true;wifiTargetSupported=true;wifiTargetSecured=true;
  } else {
    if(index>=wifiScan.count)return;
    const auto& row=wifiScan.networks[index];
    wifiTarget=row.ssid;wifiTargetSaved=row.saved;wifiTargetSecured=row.secured;wifiTargetSupported=row.supported;
  }
  message="";goTo(Screen::WifiDetails);
}
void wifiKeyboardTap(size_t key) {
  const bool couldConnect=wifiJoinCanStart();message="";
  if(key<64) {
    const size_t columns=wifiKeyboardColumns(wifiKeyboardSymbols);
    const char c=wifiKeyboardLetter(wifiKeyboardSymbols,wifiKeyboardUpper,key%columns,key/columns);
    if(c && wifiPassword.length()<(wifiEditingSsid?32:64))wifiPassword+=c;
  } else if(key==64 && !wifiKeyboardSymbols){wifiKeyboardUpper=!wifiKeyboardUpper;wifiLettersDirty=true;}
  else if(key==65){wifiKeyboardSymbols=!wifiKeyboardSymbols;wifiKeyboardOffset=0;wifiLettersDirty=true;}
  else if(key==66){if(wifiPassword.length()<(wifiEditingSsid?32:64))wifiPassword+=' ';}
  else if(key==67 && wifiPassword.length())wifiPassword.remove(wifiPassword.length()-1);
  wifiEntryDirty=true;wifiUtilityDirty=true;
  if(couldConnect!=wifiJoinCanStart())barDirty=true;
}

void runAction(Act id) {
  switch (id) {
    case Act::WifiOpen: openWifiUi();return;
    case Act::WifiPhone:
      if(screen==Screen::WifiPhone && !phoneSetup.apPassword.length())prov->endPhoneSetup();
      if(!prov->beginPhoneSetup()){message="Phone setup could not start";contentDirty=true;return;}
      phoneSetup=prov->phoneSetupSnapshot();phoneShowPage=false;phoneSetupSucceeded=false;
      refreshPhoneQr();goTo(Screen::WifiPhone);phoneNextCheckAt=millis()+1000;return;
    case Act::WifiPhonePage:phoneShowPage=!phoneShowPage;refreshPhoneQr();contentDirty=true;barDirty=true;return;
    case Act::WifiPhoneDone:goTo(Screen::Wifi);refreshWifiUi();return;
    case Act::WifiScan:
      wifiShowSaved=false;wifiScroll=0;message="";prov->startWifiScan();refreshWifiUi();contentDirty=true;return;
    case Act::WifiSaved:
      wifiShowSaved=!wifiShowSaved;wifiScroll=0;message="";refreshWifiUi();contentDirty=true;return;
    case Act::WifiAdd: wifiTarget="";wifiTargetSaved=false;wifiTargetSecured=true;wifiTargetSupported=true;editWifiPassword(true);return;
    case Act::WifiEdit: wifiTargetSaved=false;editWifiPassword();return;
    case Act::WifiForget: modal=Modal::ConfirmForgetWifi;contentDirty=true;return;
    case Act::WifiCancel:
      prov->cancelWifiJoin();wifiPassword="";refreshWifiUi();goTo(Screen::Wifi);return;
    case Act::WifiConnect: {
      if(screen==Screen::WifiPassword && wifiEditingSsid) {
        if(!wifiJoinCanStart())return;
        wifiTarget=wifiPassword;
        if(!wifiTarget.length())return;
        editWifiPassword();return;
      }
      if(screen==Screen::WifiDetails && !wifiTargetSaved && wifiTargetSecured){editWifiPassword();return;}
      if(!wifiTargetSaved && wifiTargetSecured && !wifiPassphraseValid(wifiPassword))return;
      const bool started=wifiTargetSaved?prov->connectSavedWifiNetwork(wifiTarget):prov->tryWifiNetwork(wifiTarget,wifiPassword);
      if(started){wifiPassword="";goTo(Screen::WifiJoining);refreshWifiUi();wifiUiCandidateId=wifiConnection.candidateId;}
      else {message=prov->wifiConnectionSnapshot().detail;contentDirty=true;}
      return;
    }
    case Act::UseThread: usePreviewThread(); return;
    case Act::NotNow: goTo(Screen::Home); return;
    case Act::Review:
      approvalIndex = 0;
      goTo(Screen::Approvals);
      return;
    case Act::VoiceReview: {
      const String command = voice.commandId();
      const uint32_t generation = navigationGeneration;
      if (voice.reviewReason() != "gateway_approval" || command.length() == 0) return;
      if (!enqueueUiNetworkJob([] { gw->refreshApprovals(); }, [command, generation] {
        if (generation != navigationGeneration || command != voice.commandId()) return;
        for (size_t i = 0; i < gw->approvalCount(); ++i) {
          const PendingApproval* row = gw->approval(i);
          if (row && row->commandId == command) {
            approvalIndex = i;
            goTo(Screen::Approvals);
            return;
          }
        }
        message = "Original approval unavailable; use console or recheck";
        contentDirty = true;
      })) {
        message = "Busy; tap again";
        contentDirty = true;
      }
      return;
    }
    case Act::VoiceStatus:
      if (voice.resumeStatus()) { message = "Checking original recording"; contentDirty = true; }
      return;
    case Act::VoiceConsole:
      goTo(Screen::Send);
      message = "Continue this note in the web console";
      contentDirty = true;
      return;
    case Act::VoiceDismiss: {
      if (!voice.canDismissCapture()) return;
      if (uiNetworkBusy()) { message = "Busy; tap again"; contentDirty = true; return; }
      // Sent acknowledges dispatch, not a finished T3 turn. Transfer a background
      // completion's cursor to the reply reader before a new draft can replace it.
      if (voice.stage() == VoiceStage::Sent && voice.responseAfter().length() > 0) {
        const String environment = voiceCaptureEnvironment;
        const String thread = voiceCaptureThread;
        const String after = voice.responseAfter();
        const String media = voice.mediaId();
        if (!enqueueUiNetworkJob([environment, thread, after] {
          gw->lockState();
          uiOperationSucceeded = environment == gw->context().environmentId && thread == gw->context().threadId;
          if (uiOperationSucceeded) {
            gw->openResponse(after);
            uiOperationSucceeded = environment == gw->context().environmentId
              && thread == gw->context().threadId && gw->responseOpen();
          }
          gw->unlockState();
        }, [media] {
          if (media != voice.mediaId()) return;
          if (!uiOperationSucceeded) {
            message = "Open the original thread before starting a new clip";
          } else {
            voice.reset();
            message = "Previous reply remains in the thread";
          }
          contentDirty = true;
        })) {
          message = "Busy; tap again";
          contentDirty = true;
        }
        return;
      }
      voice.reset();
      message = "Previous note remains in the console";
      contentDirty = true;
      return;
    }
    case Act::Talk:
      goTo(Screen::Send);
      return;
    case Act::SavedActions:
      goTo(Screen::Actions);
      return;
    case Act::NewThread:
      createThreadNow();
      return;
    case Act::Agents: browseDirectAgents(false); return;
    case Act::AgentSessions: browseDirectAgents(true); return;
    case Act::AgentUse: applyDirectAgent(false); return;
    case Act::AgentResume: modal = Modal::ConfirmNativeResume; contentDirty = true; return;
    case Act::AgentBack: goToThreads(); return;
    case Act::PickThread:
      goToThreads();
      return;
    case Act::Reload:
      if (screen == Screen::Environments) { refreshEnvironments(); return; }
      if (screen == Screen::Projects) { refreshProjects(); return; }
      refreshThreads();
      return;
    case Act::Retry:
    case Act::Refresh: {
      if (screen == Screen::Gateway) {
        // Non-blocking on purpose: the probe runs on its own task and this only brings its next
        // pass forward, so the render loop never waits on it.
        gatewayProbeNow();
        message = "Probing the gateway";
        contentDirty = true;
        return;
      }
      if (!gw->responseOpen()) {
        openReply();
        return;
      }
      // An explicit refresh keeps the text on screen and refreshes it behind itself.
      replyRefreshedAt = millis();
      queueResponsePage(gw->response().page, false, String(), true);
      contentDirty = true;
      return;
    }
    case Act::PrevPage:
      stepReplyPage(-1);
      return;
    case Act::NextPage:
      stepReplyPage(1);
      return;
    case Act::ReturnThread:
      goTo(Screen::Home);
      return;
    case Act::Approve: {
      const PendingApproval* a = gw->approval(approvalIndex);
      if (!a) return;
      pendingApprovalId = a->commandId;
      pendingApprovalSummary = a->summary;
      modal = Modal::ConfirmApproval;
      contentDirty = true;
      return;
    }
    case Act::Reject: {
      const PendingApproval* a = gw->approval(approvalIndex);
      if (a) {
        pendingApprovalId = a->commandId;
        pendingApprovalSummary = a->summary;
        modal = Modal::ConfirmRejection;
        contentDirty = true;
      }
      return;
    }
    case Act::NextApproval:
      if (gw->approvalCount() > 1) {
        approvalIndex = (approvalIndex + 1) % gw->approvalCount();
        contentDirty = true;
      }
      return;
    case Act::SendClip:
      sendHeldClip();
      return;
    case Act::DiscardClip:
      discardClip();
      return;
    case Act::Portal:
      message = "Config portal open";
      contentDirty = true;
      prov->openConfigPortal();
      return;
    case Act::ClosePortal:
      // Closes the portal only. Wi-Fi credentials and the gateway URL are untouched, so a device
      // that was online before the portal opened is online the moment it closes.
      Serial.println("[provisioning] closing the config portal at the owner's request.");
      prov->closeConfigPortal();
      message = "";
      contentDirty = true;
      chromeDirty = true;
      return;
    case Act::Reprovision:
      modal = Modal::ConfirmReprovision;
      contentDirty = true;
      return;
    case Act::ConfirmNo:
      modal = Modal::None;
      contentDirty = true;
      return;
    case Act::ConfirmYes: {
      const Modal which = modal;
      modal = Modal::None;
      if (which == Modal::ConfirmNativeResume) { applyDirectAgent(true); return; }
      if(which==Modal::ConfirmForgetWifi) {
        const bool removed=store->forgetWifiNetwork(wifiTarget);
        message=removed?"Saved network removed":"Switch networks before forgetting";
        refreshWifiUi();goTo(Screen::Wifi);
      } else if (which == Modal::ConfirmClaim) {
        if (!uiJobSlotFree()) { gestureRefused(); return; }
        showBusy("New code", "Previous code will stop working");
        submitUiJob([] { gw->requestNewClaimCode(); }, [] {});
      } else if (which == Modal::ConfirmRejection) {
        answerApproval(pendingApprovalId, pendingApprovalSummary, false);
      } else if (which == Modal::ConfirmApproval) {
        answerApproval(pendingApprovalId, pendingApprovalSummary, true);
      } else if (which == Modal::ConfirmReprovision) {
        message = "Re-entering provisioning";
        contentDirty = true;
        prov->resetToProvisioning();
      } else if (which == Modal::ConfirmControl) {
        if (pendingControlEnvironment != gw->context().environmentId
            || pendingControlThread != gw->context().threadId
            || pendingControlRevision != gw->controlsRevision()) {
          message = "Context changed; review again";
          contentDirty = true;
          return;
        }
        if (pendingControl.kind != "reset") {
          bool stillAssigned = false;
          auto matches = [](const DeviceControl& current) {
            return current.id == pendingControl.id && current.enabled
              && current.actionId == pendingControl.actionId && current.kind == pendingControl.kind
              && current.mediaKind == pendingControl.mediaKind;
          };
          for (size_t i = 0; i < gw->controlCount(); ++i) {
            const DeviceControl* current = gw->control(i);
            if (current && matches(*current)) stillAssigned = true;
          }
          const ThreadResponse& reply = gw->response();
          for (size_t i = 0; i < reply.followUpCount; ++i) {
            if (matches(reply.followUps[i])) stillAssigned = true;
          }
          if (!stillAssigned) {
            message = "Action changed; review again";
            contentDirty = true;
            return;
          }
        }
        // Re-entered with the confirmation already given, which is why local confirmation lives
        // here and not inside runControl(): the gate must not loop back on itself.
        if (uiNetworkBusy()) {
          if (pendingControl.kind != "stop" && !(pendingControl.kind == "legacy" && pendingControl.id == "stop")) {
            message = "Request pending; review again when finished"; return;
          }
          if (!deferredStopPending) {
            deferredStop = pendingControl;
            deferredStopEnvironment = pendingControlEnvironment;
            deferredStopThread = pendingControlThread;
            deferredStopRevision = pendingControlRevision;
            deferredStopPending = true;
          }
          message = "Stop queued after the pending request";
          contentDirty = true; return;
        }
        dispatchControl(pendingControl);
      }
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Touch routing
// ---------------------------------------------------------------------------------------------

int16_t maxScroll(size_t count, int16_t rowH, int16_t top) {
  const int16_t content = (int16_t)count * rowH;
  const int16_t viewport = (int16_t)(contentBottom() - top);
  return content > viewport ? (int16_t)(content - viewport) : 0;
}

bool barVisible() { return barT > 0.9f && actionCount > 0; }

void handleBarTap(int16_t x) {
  const int16_t top = (int16_t)(kH - kBarH);
  for (uint8_t i = 0; i < actionCount; ++i) {
    const Rect r = actionRect(i, top);
    // Vertically generous: the tray is 58 px tall and the capsule inside it is 36, and a thumb
    // that lands on the tray meant the button under it.
    if (x >= r.x - 4 && x < r.x + r.w + 4) {
      if (actions[i].enabled) runAction(actions[i].id);
      return;
    }
  }
}

void handleDrawerTap(int16_t x, int16_t y) {
  if (y < kContentTop) { closeDrawer(); return; }
  for (uint8_t i = 0; i < drawerRowCount; ++i) {
    const Rect r = drawerRowRect(i);
    if (r.y + r.h > kContentTop + drawerShownPx - 12) break;
    if (uip::hit(r, x, y)) {
      const Row row = drawerRows[i];
      closeDrawerNow();
      openCategory(row);
      return;
    }
  }
  // Anywhere below the panel is "put it away", which is the gesture everybody already knows.
  closeDrawer();
}

void handleContentTap(int16_t x, int16_t y) {
  switch (screen) {
    case Screen::Wifi: {
      if(y<kWifiListTop || y>=contentBottom())return;
      chooseWifiRow(static_cast<size_t>((y-kWifiListTop+wifiScroll)/kWifiRowH));return;
    }
    case Screen::WifiPassword:
      if(x>=8 && x<232 && y>=kWifiKeyboardTop && y<kWifiUtilityTop) {
        const size_t col=static_cast<size_t>((x-8+wifiKeyboardOffset)/kWifiLetterW);
        const size_t row=static_cast<size_t>((y-kWifiKeyboardTop)/kWifiLetterH);
        wifiKeyboardTap(row*wifiKeyboardColumns(wifiKeyboardSymbols)+col);
      } else if(x>=8 && x<232 && y>=kWifiUtilityTop && y<kWifiUtilityTop+kWifiUtilityH)
        wifiKeyboardTap(64+(x-8)/56);
      return;
    case Screen::Home: {
      if (!uip::hit(homeActionRect(), x, y)) return;
      if (!haveThread()) { goToThreads(); return; }
      openReply();
      return;
    }
    case Screen::Actions: {
      const int16_t local = (int16_t)(y - kActionListTop + actionScroll);
      if (local < 0) return;
      const size_t index = (size_t)(local / kActionRowH);
      const DeviceControl* c = gw->control(index);
      if (c) runControlRow(*c);
      return;
    }
    case Screen::Threads: {
      if (uip::hit(kBreadcrumb, x, y)) {
        goTo(Screen::Environments);
        refreshEnvironments();
        return;
      }
      const int16_t local = (int16_t)(y - kThreadListTop + threadScroll);
      if (local < 0) return;
      const size_t index = (size_t)(local / kThreadRowH);
      if (index < threadRowCount()) selectThreadRow(index);
      return;
    }
    case Screen::Environments: {
      const int16_t local = (int16_t)(y - kBrowseListTop + envScroll);
      if (local < 0) return;
      const size_t index = (size_t)(local / kBrowseRowH);
      if (index < browse.environmentCount()) selectEnvironmentRow(index);
      return;
    }
    case Screen::Projects: {
      const int16_t local = (int16_t)(y - kBrowseListTop + projectScroll);
      if (local < 0) return;
      const size_t index = (size_t)(local / kBrowseRowH);
      if (index < browse.projectCount()) selectProjectRow(index);
      return;
    }
    case Screen::Send: {
      if (voiceInJourney()) return;   // nothing on this screen is pressable while a clip is in flight
      if (uip::hit(micButtonRect(), x, y)) {
        if (clipHeld) {
          message = "Send or discard the clip below";
        } else {
          // Handled on Press, not Tap: a hold never produces a tap. Landing here means the finger
          // came and went too quickly to be a recording.
          message = "Hold the button while you speak";
        }
        contentDirty = true;
      }
      return;
    }
    case Screen::Response: {
      if (!gw->responseOpen()) return;
      const ThreadResponse& r = gw->response();
      for (size_t i = 0; i < r.followUpCount && i < 2; ++i) {
        if (uip::hit(i == 0 ? kFollowLeft : kFollowRight, x, y)) {
          // A suggestion gets no shortcut past the local review step.
          confirmControl(r.followUps[i]);
          return;
        }
      }
      return;
    }
    default:
      return;
  }
}

// Steps HOME's destination picker. Local only — the write is debounced by the caller's timer, so
// eight swipes cost one request and the device is never bound to something merely passed over.
void pickerStep(int delta) {
  const int slots = pickerSlotCount();
  const int current = pickerSlot();
  const int next = current + delta;
  if (next < 0 || next >= slots) {
    // A wall, said out loud. A swipe that silently does nothing is indistinguishable from one the
    // device failed to see. NEW THREAD is the last slot, so "last thread" is never the far end.
    message = next < 0 ? "First thread" : "That is the end";
    if (pickerMotion.active && pickerMotion.dragging) settleHomePickerBack();
    else contentDirty = true;
    return;
  }

  const bool continuingDrag = pickerMotion.active && pickerMotion.dragging
    && pickerMotion.direction == delta;
  HomePickerVisual from = continuingDrag
    ? pickerMotion.from : homePickerVisual(current, pickerPending());
  float startOffset = continuingDrag ? pickerMotion.offset : 0.0f;
  // A noisy final touch sample must not start the settle on the wrong side of centre.
  if ((delta > 0 && startOffset > 0.0f) || (delta < 0 && startOffset < 0.0f)) startOffset = 0.0f;

  pickerIndex = next;
  // The virtual slot binds nothing, so it arms no write. Stepping onto it and away again costs the
  // gateway nothing at all.
  pickerCommitAt = (next == (int)threadRowCount()) ? 0 : (millis() + kPickerCommitMs);
  message = "";

  pickerMotion.active = true;
  pickerMotion.dragging = false;
  pickerMotion.direction = (int8_t)delta;
  pickerMotion.offset = startOffset;
  pickerMotion.startOffset = startOffset;
  pickerMotion.targetOffset = (float)(-delta * kW);
  pickerMotion.startedAt = millis();
  pickerMotion.from = from;
  pickerMotion.to = homePickerVisual(next, homePickerSlotPending(next));
}

// Moves between the three levels of the hierarchy.
//
// Direction follows the breadcrumb's reading order, which runs environment / folder / thread from
// left to right: swiping LEFT moves the content leftward and brings the next level in from the
// right, so left goes DEEPER and right goes back UP. Only navigation happens here — binding an
// environment or a project is destructive of the levels below it, so those stay behind a deliberate
// tap on their own screen rather than under a gesture that can be made by accident.
void levelStep(int delta) {
  if (delta > 0) {
    if (screen == Screen::Environments) {
      goTo(Screen::Projects);
      if (browse.projectCount() == 0) refreshProjects();
      return;
    }
    if (screen == Screen::Projects) { goToThreads(); return; }
    message = "Threads are the last level";
    contentDirty = true;
    return;
  }
  if (screen == Screen::Threads || screen == Screen::Projects) {
    const Screen next = screen == Screen::Threads ? Screen::Projects : Screen::Environments;
    goTo(next);
    if (next == Screen::Projects && browse.projectCount() == 0) refreshProjects();
    if (next == Screen::Environments && browse.environmentCount() == 0) refreshEnvironments();
    return;
  }
  message = "Environments are the first level";
  contentDirty = true;
}

void handleTap(int16_t x, int16_t y) {
  if (drawerT > 0.05f) { handleDrawerTap(x, y); return; }

  if (y < kContentTop) {
    if (canGoBack() && uip::hit(kBackHit, x, y)) { goBack(); return; }
    if (uip::hit(kHandleHit, x, y)) { openDrawer(); return; }
    return;
  }

  if (barVisible() && y >= kH - kBarH) { handleBarTap(x); return; }
  if (modal != Modal::None) return;

  if (screen == Screen::Status) {
    // The one thing an unclaimed device can be asked for: a replacement code. Deliberately behind a
    // tap on the code itself rather than anything ambient — rotating invalidates the code the owner
    // may be part-way through typing, which is also why this is not an action-bar button.
    if (unclaimed() && y >= kClaimTop && y < kClaimTop + 46) {
      modal = Modal::ConfirmClaim;
      contentDirty = true;
    }
    return;
  }

  // A modal owns the content region; its two answers live in the action bar, and a tap anywhere
  // else inside the dialog does nothing rather than something surprising.
  if (modal != Modal::None) return;
  if (!operable() && !configScreen()) return;
  handleContentTap(x, y);
}

void handleDrag(int16_t y, int16_t dy) {
  if (modal != Modal::None) return;
  // A finger held on the microphone wanders; scrolling the list under it while it records is not
  // what anybody meant by that.
  if (recordArmed) return;

  dragTravel = (int16_t)(dragTravel + dy);
  (void)y;

  // Lock the axis the moment either one is decisive, and never revisit it.
  if (dragAxis == DragAxis::Undecided) {
    const int16_t ax = dragTravelX < 0 ? (int16_t)-dragTravelX : dragTravelX;
    const int16_t ay = dragTravel < 0 ? (int16_t)-dragTravel : dragTravel;
    if (ax >= kDragCommitPx || ay >= kDragCommitPx) {
      dragAxis = ax > ay ? DragAxis::Horizontal : DragAxis::Vertical;
    }
  }
  // HOME previews its adjacent thread while the finger is still down. Navigation and response
  // paging remain release-only because they trigger screen changes or network work. In every case
  // a horizontal gesture leaves the drawer untouched.
  if (dragAxis == DragAxis::Horizontal) return;

  if (dragOwner == DragOwner::Drawer) {
    if (!drawerOpen && dragTravel > kDragCommitPx) openDrawer();
    else if (drawerOpen && dragTravel < -kDragCommitPx) closeDrawer();
    return;
  }

  if (dragOwner == DragOwner::DrawerList) {
    // Scroll first, dismiss only on overscroll. The list does not scroll today — the static_assert
    // beside drawerHeight() guarantees every row the device can justify fits without one — so this
    // branch is unreachable and the dismissal below is what actually runs. It is written out anyway
    // because the day a fifth category is added is the day this would otherwise start silently
    // eating scrolls again, and the assert is what will make that impossible to miss.
    if (drawerListScrolls()) return;
    if (drawerOpen && dragTravel < -kDragCommitPx) closeDrawer();
    return;
  }

  // Content. With the drawer out it covers the whole page, so there is nothing underneath to
  // scroll; with it shut there is nothing to close. Either way this never touches the drawer.
  if (drawerT > 0.05f) return;

  if (screen == Screen::Threads) {
    const int16_t limit = maxScroll(threadRowCount(), kThreadRowH, kThreadListTop);
    int16_t next = (int16_t)(threadScroll - dy);
    if (next < 0) next = 0;
    if (next > limit) next = limit;
    if (next != threadScroll) { threadScroll = next; contentDirty = true; }
    return;
  }
  if (screen == Screen::Environments) {
    const int16_t limit = maxScroll(browse.environmentCount(), kBrowseRowH, kBrowseListTop);
    int16_t next = (int16_t)(envScroll - dy);
    if (next < 0) next = 0;
    if (next > limit) next = limit;
    if (next != envScroll) { envScroll = next; contentDirty = true; }
    return;
  }
  if (screen == Screen::Projects) {
    const int16_t limit = maxScroll(browse.projectCount(), kBrowseRowH, kBrowseListTop);
    int16_t next = (int16_t)(projectScroll - dy);
    if (next < 0) next = 0;
    if (next > limit) next = limit;
    if (next != projectScroll) { projectScroll = next; contentDirty = true; }
    return;
  }
  if (screen == Screen::Actions) {
    const int16_t limit = maxScroll(gw->controlCount(), kActionRowH, kActionListTop);
    int16_t next = (int16_t)(actionScroll - dy);
    if (next < 0) next = 0;
    if (next > limit) next = limit;
    if (next != actionScroll) { actionScroll = next; contentDirty = true; }
  }
  if(screen==Screen::Wifi) {
    const size_t count=wifiShowSaved?wifiSavedNames.size():wifiScan.count;
    const int16_t limit=maxScroll(count,kWifiRowH,kWifiListTop);
    const int16_t next=max<int16_t>(0,min<int16_t>(limit,wifiScroll-dy));
    if(next!=wifiScroll){wifiScroll=next;contentDirty=true;}
  }

}

struct TouchTargetInfo { uint32_t identity = 0; Rect rect{0,0,0,0}; };
uint32_t touchIdentity(const String& label) {
  uint32_t value = 2166136261u;
  for (size_t i=0; i<label.length(); ++i) { value ^= static_cast<uint8_t>(label[i]); value *= 16777619u; }
  return value == 0 ? 1 : value;
}
TouchTargetInfo touchTargetAt(int16_t x, int16_t y) {
  auto target = [&](const String& name, const Rect& rect) {
    // Semantic identity prevents a row replacement or changed confirmation from inheriting a tap.
    const String scope = String(static_cast<int>(screen)) + ":" + String(static_cast<int>(modal))
      + ":" + gw->context().environmentId + ":" + gw->context().threadId + ":" + name;
    return TouchTargetInfo{touchIdentity(scope),rect};
  };
  if (drawerT > 0.05f) {
    if (y < kContentTop) return target("drawer-close",{0,0,kW,kContentTop});
    for (uint8_t i=0;i<drawerRowCount;++i) {
      const Rect r=drawerRowRect(i);
      if (r.y+r.h > kContentTop+drawerShownPx-12) break;
      if (uip::hit(r,x,y)) return target(String("drawer:")+String(static_cast<int>(drawerRows[i])),r);
    }
    return target("drawer-dismiss",{0,static_cast<int16_t>(kContentTop+drawerShownPx),kW,kH});
  }
  if (y < kContentTop) {
    if (canGoBack() && uip::hit(kBackHit,x,y)) return target("back",kBackHit);
    if (uip::hit(kHandleHit,x,y)) return target("drawer",kHandleHit);
    return {};
  }
  if (barVisible() && y>=kH-kBarH) {
    for(uint8_t i=0;i<actionCount;++i) {
      const Rect button=actionRect(i,kH-kBarH);
      const Rect r{static_cast<int16_t>(button.x-4),static_cast<int16_t>(kH-kBarH),static_cast<int16_t>(button.w+8),kBarH};
      if(uip::hit(r,x,y) && actions[i].enabled) {
        const String name=String("action:")+String(static_cast<int>(actions[i].id))+":"+String(gw->controlsRevision())
          +":"+pendingControl.id+":"+pendingApprovalId+":"+previewThreadId
          +":"+browse.previewEnvironmentId()+":"+browse.previewProjectId()+":"+wifiTarget;
        return target(name,r);
      }
    }
    return {};
  }
  if (screen==Screen::Status && modal==Modal::None) {
    if (unclaimed() && y>=kClaimTop && y<kClaimTop+46) return target("claim",{0,kClaimTop,kW,46});
    return {};
  }
  if(modal!=Modal::None || (!operable() && !configScreen())) return {};
  if(screen==Screen::WifiPassword && x>=8 && x<232) {
    size_t key=100;
    if(y>=kWifiKeyboardTop && y<kWifiUtilityTop) {
      const size_t col=static_cast<size_t>((x-8+wifiKeyboardOffset)/kWifiLetterW);
      const size_t row=static_cast<size_t>((y-kWifiKeyboardTop)/kWifiLetterH);
      if(wifiKeyboardLetter(wifiKeyboardSymbols,wifiKeyboardUpper,col,row))key=row*wifiKeyboardColumns(wifiKeyboardSymbols)+col;
    } else if(y>=kWifiUtilityTop && y<kWifiUtilityTop+kWifiUtilityH)key=64+(x-8)/56;
    if(key<68) {
      const Rect r=wifiKeyRect(key);
      if(r.x<0 || r.x+r.w>kW)return {};
      return target(String("wifi-key:")+String(key)+":"+String(wifiKeyboardOffset)+":"+String(wifiKeyboardUpper)+":"+String(wifiKeyboardSymbols),r);
    }
    return {};
  }
  if(screen==Screen::Wifi && y>=kWifiListTop && y<contentBottom()) {
    const size_t index=static_cast<size_t>((y-kWifiListTop+wifiScroll)/kWifiRowH);
    const size_t count=wifiShowSaved?wifiSavedNames.size():wifiScan.count;
    if(index>=count)return {};
    const int16_t rowTop=kWifiListTop+static_cast<int16_t>(index)*kWifiRowH-wifiScroll;
    if(rowTop<kWifiListTop || rowTop+kWifiRowH>contentBottom())return {};
    const String name=wifiShowSaved?wifiSavedNames[index]:wifiScan.networks[index].ssid;
    const int16_t top=max<int16_t>(kWifiListTop,kWifiListTop+index*kWifiRowH-wifiScroll);
    return target(String("wifi:")+name,{0,top,kW,static_cast<int16_t>(min<int16_t>(contentBottom(),kWifiListTop+(index+1)*kWifiRowH-wifiScroll)-top)});
  }
  if(screen==Screen::Home && uip::hit(homeActionRect(),x,y))
    return target(String("home:")+String(pickerSlot()),homeActionRect());
  if(screen==Screen::Threads && uip::hit(kBreadcrumb,x,y)) return target("breadcrumb",kBreadcrumb);
  if(screen==Screen::Send && !voiceInJourney() && uip::hit(micButtonRect(),x,y)) return target("microphone",micButtonRect());
  if(screen==Screen::Response && gw->responseOpen()) {
    const ThreadResponse& reply=gw->response();
    for(size_t i=0;i<reply.followUpCount && i<2;++i) {
      const Rect r=i==0?kFollowLeft:kFollowRight;
      if(uip::hit(r,x,y)) return target(String("follow:")+reply.followUps[i].id,r);
    }
  }
  int16_t top=0,rowH=0,scroll=0;
  size_t count=0;
  if(screen==Screen::Actions){top=kActionListTop;rowH=kActionRowH;scroll=actionScroll;count=gw->controlCount();}
  if(screen==Screen::Threads){top=kThreadListTop;rowH=kThreadRowH;scroll=threadScroll;count=threadRowCount();}
  if(screen==Screen::Projects){top=kBrowseListTop;rowH=kBrowseRowH;scroll=projectScroll;count=browse.projectCount();}
  if(screen==Screen::Environments){top=kBrowseListTop;rowH=kBrowseRowH;scroll=envScroll;count=browse.environmentCount();}
  if(rowH==0 || y<top || y>=contentBottom()) return {};
  const size_t index=static_cast<size_t>((y-top+scroll)/rowH);
  if(index>=count) return {};
  String identity;
  if(screen==Screen::Actions){const auto* row=gw->control(index); if(!row||!row->enabled)return {};identity=row->id+":"+String(gw->controlsRevision());}
  if(screen==Screen::Threads){const auto* row=threadRowAt(index);if(!row)return {};identity=row->id;}
  if(screen==Screen::Projects){const auto* row=browse.project(index);if(!row)return {};identity=row->id;}
  if(screen==Screen::Environments){const auto* row=browse.environment(index);if(!row)return {};identity=row->id;}
  const int16_t rowTop=max(top,static_cast<int16_t>(top+index*rowH-scroll));
  const int16_t rowBottom=min(contentBottom(),static_cast<int16_t>(top+(index+1)*rowH-scroll));
  return target(String("row:")+identity,{0,rowTop,kW,static_cast<int16_t>(rowBottom-rowTop)});
}
void reportTouchPerformance() {
  const uint32_t now=millis();
  if(touchPerformanceReportAt==0){touchPerformanceReportAt=now;return;}
  if(now-touchPerformanceReportAt<60000)return;
  if(touchPerformance.frames || touchPerformance.inputs || touchPerformance.lockSkips) {
    Serial.printf("[ui-perf] window_ms=%u frames=%u frame_gap_max_ms=%u lock_skips=%u input_n=%u sample_dispatch_max_ms=%u sample_dispatch_p95_upper_ms=%u retained=%u discard_batches=%u\n",
      static_cast<unsigned>(now-touchPerformanceReportAt),static_cast<unsigned>(touchPerformance.frames),
      static_cast<unsigned>(touchPerformance.maxFrameGap),static_cast<unsigned>(touchPerformance.lockSkips),
      static_cast<unsigned>(touchPerformance.inputs),static_cast<unsigned>(touchPerformance.maxInputAge),
      static_cast<unsigned>(touchPerformance.p95UpperMs()),static_cast<unsigned>(touchPerformance.retained),static_cast<unsigned>(touchPerformance.discarded));
  }
  touchPerformance.resetWindow();touchPerformanceReportAt=now;
}
#if HOSYOND_UI_PROFILE
// MEASUREMENT (HOSYOND_UI_PROFILE only): called once per uiTick, before any early return, so a frame skipped for
// the model lock still observes the driver's contact sequence and the loop cadence.
void sampleTouchFunnel() {
  const uint32_t now=millis();
  const uint32_t nowUs=micros();
  const uint32_t contact=touchContactId();
  if(!touchFunnel.primed){touchFunnel.primed=true;touchFunnel.lastContactId=contact;touchFunnel.windowAt=now;}
  else {
    touchFunnel.contacts+=contact-touchFunnel.lastContactId; // wraps correctly; 0 is skipped by the driver
    touchFunnel.lastContactId=contact;
    const uint32_t gapUs=nowUs-touchFunnel.lastTickEnterUs;
    if(gapUs>touchFunnel.gapMaxUs) {
      touchFunnel.gapMaxUs=gapUs;
      touchFunnel.gapTickUs=lastTickDurUs;touchFunnel.gapSleepUs=lastSleepUs;touchFunnel.gapKind=lastTickKind;
    }
  }
  touchFunnel.lastTickEnterUs=nowUs;
  touchFunnel.lastTickAt=now;
  ++touchFunnel.ticks;
  if(touchDown())++touchFunnel.held;
  if(now-touchFunnel.windowAt<5000)return;
  const bool active=touchFunnel.lockSkips||touchFunnel.contacts||touchFunnel.discrete||touchFunnel.drags||touchFunnel.held
    ||touchFunnel.retained||touchFunnel.overflow||touchFunnel.stale||touchFunnel.queued||touchFunnel.refused;
  // Quiet windows print once in six (30 s) so "no touches" is distinguishable from "not built in".
  if(active || ++touchFunnel.quietWindows>=6) {
    touchFunnel.quietWindows=0;
    const float gapMs=static_cast<float>(touchFunnel.gapMaxUs)/1000.0f;
    const float gapTick=static_cast<float>(touchFunnel.gapTickUs)/1000.0f;
    const float gapSleep=static_cast<float>(touchFunnel.gapSleepUs)/1000.0f;
    Serial.printf("[touch-funnel] win_ms=%u ticks=%u painted=%u lock_skips=%u contacts=%u held_ticks=%u discrete=%u drags=%u retained=%u overflow=%u stale=%u dispatched=%u age_avg_ms=%u age_max_ms=%u queued=%u replayed=%u lost=%u refused=%u tick_gap_max_ms=%.1f (prev tick %.1f [%s] + sleep %.1f + loop-rest %.1f)\n",
      static_cast<unsigned>(now-touchFunnel.windowAt),static_cast<unsigned>(touchFunnel.ticks),
      static_cast<unsigned>(touchFunnel.painted),static_cast<unsigned>(touchFunnel.lockSkips),
      static_cast<unsigned>(touchFunnel.contacts),static_cast<unsigned>(touchFunnel.held),
      static_cast<unsigned>(touchFunnel.discrete),static_cast<unsigned>(touchFunnel.drags),
      static_cast<unsigned>(touchFunnel.retained),static_cast<unsigned>(touchFunnel.overflow),
      static_cast<unsigned>(touchFunnel.stale),static_cast<unsigned>(touchFunnel.dispatched),
      static_cast<unsigned>(touchFunnel.dispatched?touchFunnel.ageSum/touchFunnel.dispatched:0),
      static_cast<unsigned>(touchFunnel.ageMax),
      static_cast<unsigned>(touchFunnel.queued),static_cast<unsigned>(touchFunnel.replayed),
      static_cast<unsigned>(touchFunnel.lost),static_cast<unsigned>(touchFunnel.refused),static_cast<double>(gapMs),static_cast<double>(gapTick),
      kTickKindName[touchFunnel.gapKind<4?touchFunnel.gapKind:0],static_cast<double>(gapSleep),
      static_cast<double>(gapMs-gapTick-gapSleep>0.0f?gapMs-gapTick-gapSleep:0.0f));
  }
  const uint32_t keepContact=touchFunnel.lastContactId,keepTick=touchFunnel.lastTickAt,keepEnterUs=touchFunnel.lastTickEnterUs;
  touchFunnel=TouchFunnel{};
  touchFunnel.primed=true;touchFunnel.lastContactId=keepContact;touchFunnel.lastTickAt=keepTick;
  touchFunnel.lastTickEnterUs=keepEnterUs;touchFunnel.windowAt=now;
}
// MEASUREMENT (HOSYOND_UI_PROFILE only): the [frame-split], [orb-split] and [content-split] lines. Millisecond figures are
// per-frame AVERAGES over the 2 s window unless marked max, so a stage that runs on one frame in
// ten shows a tenth of its true cost; the [n] counts say how often each stage ran, and `orb_ms` is
// normalised by orb frames only.
void reportFrameSplit() {
  FrameSplit& f = split;
#if ORB_PROFILE
  OrbProfile prof;
  const bool haveProf = orbProfileTake(prof);
#endif
  if (f.frames == 0) { f = FrameSplit{}; return; }
  const float n = static_cast<float>(f.frames);
  const auto avg = [n](uint32_t us) { return static_cast<float>(us) / n / 1000.0f; };
  const auto mx = [](uint32_t us) { return static_cast<float>(us) / 1000.0f; };
  Serial.printf("[frame-split] frames=%u period=%.1f(max %.1f) tick=%.1f(max %.1f) sleep=%.1f rest=%.1f | pre=%.1f(max %.1f) logic=%.1f chrome=%.1f[%u] bar=%.1f[%u] drawer=%.1f content=%.1f(max %.1f)[%u] picker=%.1f orb=%.1f(max %.1f)[%u] status=%.1f\n",
    static_cast<unsigned>(f.frames), avg(f.period), mx(f.periodMax), avg(f.tick), mx(f.tickMax), avg(f.sleep),
    avg(f.period) - avg(f.tick) - avg(f.sleep),
    avg(f.pre), mx(f.preMax), avg(f.logic), avg(f.chrome), static_cast<unsigned>(f.chromeFrames),
    avg(f.bar), static_cast<unsigned>(f.barFrames), avg(f.drawer), avg(f.content), mx(f.contentMax),
    static_cast<unsigned>(f.contentFrames), avg(f.picker), avg(f.orb), mx(f.orbMax),
    static_cast<unsigned>(f.orbFrames), avg(f.status));
#if ORB_PROFILE   // the orb's own probes: a separate switch, which follows HOSYOND_UI_PROFILE by default
  if (haveProf && f.orbFrames) {
    const float p = static_cast<float>(prof.frames);
    const auto pa = [p](uint32_t us) { return static_cast<float>(us) / p / 1000.0f; };
    const float orbTotal = static_cast<float>(f.orb) / static_cast<float>(f.orbFrames) / 1000.0f;
    const float emit = pa(prof.emitUs), sort = pa(prof.sortUs);
    const float raster = pa(prof.clearUs) + pa(prof.lineUs) + pa(prof.dotUs);
    Serial.printf("[orb-split] %s orb_frames=%u dots=%.0f lines=%.0f | orb_ms=%.2f = emit %.2f(max %.2f) + sort %.2f(max %.2f) + raster %.2f(max %.2f)[clear %.2f line %.2f dot %.2f] + blit&other %.2f\n",
      orbStateName(currentMode), static_cast<unsigned>(prof.frames),
      static_cast<double>(prof.dots) / p, static_cast<double>(prof.lines) / p,
      orbTotal, emit, mx(prof.emitMaxUs), sort, mx(prof.sortMaxUs), raster, mx(prof.rasterMaxUs),
      pa(prof.clearUs), pa(prof.lineUs), pa(prof.dotUs), orbTotal - emit - sort - raster);
  }
#endif  // ORB_PROFILE
  if (f.jobs) {
    // Completed jobs only contribute strips/ms; a job still running at the window edge is counted in
    // `jobs` but not yet in the averages, which is why they can differ by one.
    const float done = static_cast<float>(f.strips ? f.strips : 1);
    Serial.printf("[content-split] jobs=%u partial=%u restarts=%u strips=%u ms_per_strip=%.1f job_ms_max=%.1f job_frames_max=%u causes: revision=%u browse=%u screen=%u link=%u reserve=%u arrival=%u other=%u last_screen=%u\n",
      static_cast<unsigned>(f.jobs), static_cast<unsigned>(f.partialJobs), static_cast<unsigned>(f.restarts),
      static_cast<unsigned>(f.strips), static_cast<double>(static_cast<float>(f.jobUs) / done / 1000.0f),
      static_cast<double>(mx(f.jobUsMax)), static_cast<unsigned>(f.jobFramesMax),
      static_cast<unsigned>(f.cause[kCauseRevision]), static_cast<unsigned>(f.cause[kCauseBrowse]),
      static_cast<unsigned>(f.cause[kCauseScreen]), static_cast<unsigned>(f.cause[kCauseLink]),
      static_cast<unsigned>(f.cause[kCauseReserve]), static_cast<unsigned>(f.cause[kCauseArrival]),
      static_cast<unsigned>(f.cause[kCauseOther]), static_cast<unsigned>(f.lastJobScreen));
  }
  const uint32_t keepEnterUs = f.lastTickEnterUs;  // the next window's first period still has a start
  f = FrameSplit{};
  f.lastTickEnterUs = keepEnterUs;
}
#endif  // HOSYOND_UI_PROFILE
// ---------------------------------------------------------------------------------------------
// Taps that arrive while the gateway job slot is taken
// ---------------------------------------------------------------------------------------------
//
// One gateway job runs at a time, and everything else in the UI is local. A tap on something local
// must not wait for a request, so the few that never need the slot run right away. A tap that
// DOES need it used to be answered with nothing: no action, no message, no trace - a button that
// seemed dead. It is held instead (pendingGesture: one slot, latest wins) and replayed through the
// normal router when the slot frees, if the screen and the thing under the finger are still the
// same. Taken together, a tap now always ends in: it ran, it ran after a short wait, or the person
// was told why it did not.

constexpr char kQueuedMessage[] = "Queued; one moment";

// true = handled here without the slot. false = it needs the slot; the caller holds it.
bool handleBusyLocalTap(int16_t x,int16_t y) {
  if(drawerT>0.05f) {
    if(y<kContentTop){closeDrawer();return true;}
    for(uint8_t i=0;i<drawerRowCount;++i) {
      const Rect r=drawerRowRect(i);
      if(r.y+r.h>kContentTop+drawerShownPx-12)break;
      if(!uip::hit(r,x,y))continue;
      const Row row=drawerRows[i];closeDrawerNow();
      goTo(row==Row::Device?Screen::Device:row==Row::Gateway?Screen::Gateway:row==Row::Thread?Screen::Threads:gw->hasBlockingRequests()?Screen::Approvals:Screen::Response);
      return true;
    }
    closeDrawer();return true;
  }
  if(y<kContentTop) {
    // Opening the drawer is local. BACK is held: leaving a level can refresh the one it returns to.
    if(uip::hit(kHandleHit,x,y)){openDrawer();return true;}
    return false;
  }
  if(barVisible() && y>=kH-kBarH) {
    // The busy bar exposes local navigation and one deliberate, serialized Stop confirmation.
    // Any other enabled button is held and replayed when the slot frees.
    for(uint8_t i=0;i<actionCount;++i) {
      const Rect r=actionRect(i,kH-kBarH);
      if(x<r.x-4 || x>=r.x+r.w+4 || !actions[i].enabled)continue;
      if(actions[i].id==Act::SavedActions || actions[i].id==Act::ConfirmNo || actions[i].id==Act::ConfirmYes) {
        runAction(actions[i].id);
        return true;
      }
      return false;
    }
    return true;
  }
  if(screen==Screen::Threads && modal==Modal::None && y>=kThreadListTop && y<contentBottom()
      && !uip::hit(kBreadcrumb,x,y)) {
    // Previewing a row only moves a highlight (previewThreadIndex/Id are UI state, not the staged
    // browser), so it never waits on a request. The row is re-found by id when the list under it is
    // replaced by a revalidation. This is what lets a person pick a row while the list is still
    // being confirmed.
    const int16_t local=(int16_t)(y-kThreadListTop+threadScroll);
    if(local>=0 && (size_t)(local/kThreadRowH)<threadRowCount()) selectThreadRow((size_t)(local/kThreadRowH));
    return true;
  }
  if(screen==Screen::Actions && modal==Modal::None && y>=kActionListTop && y<contentBottom()) {
    const size_t index=static_cast<size_t>((y-kActionListTop+actionScroll)/kActionRowH);
    const DeviceControl* control=gw->control(index);
    if(control && control->enabled && (control->kind=="stop" || (control->kind=="legacy" && control->id=="stop"))) {
      confirmControl(*control);
      return true;
    }
    return false;   // any other row runs, with its own confirmation, once the slot frees
  }
  return false;
}

// Holds a tap for the slot. A tap with nothing actionable under it would have done nothing when idle
// either (touchTargetAt() has no identity for it), so it is not held.
void holdTapForJob(const TouchEvent& event) {
  const TouchTargetInfo target=touchTargetAt(event.x,event.y);
  if(target.identity==0)return;
  if(pendingGesture.put(static_cast<uint8_t>(TouchGesture::Tap),event.x,event.y,target.identity,navigationGeneration,millis())) { UI_PROFILE(++touchFunnel.lost;) }
  UI_PROFILE(++touchFunnel.queued;)
  message=kQueuedMessage;
  contentDirty=true;
}

// The part of a swipe that is decided before any screen is asked to act. Returns 0 when it was
// consumed (it ended a recording, was scroll drift, or put the drawer away) and +1 / -1 for a
// forward / back navigation.
int swipeDirection(TouchGesture gesture) {
  dragTravel = 0;
  dragTravelX = 0;
  if (recordArmed) { finishRecording(); return 0; }
  // A gesture that already locked to the vertical axis is a scroll that happened to drift, and
  // must not be re-read as a swipe on the way out. A flick fast enough never to produce a Drag
  // leaves the axis Undecided, and that is a genuine swipe.
  if (dragAxis == DragAxis::Vertical) { dragAxis = DragAxis::Undecided; return 0; }
  dragAxis = DragAxis::Undecided;
  if (drawerT > 0.05f) { closeDrawer(); return 0; }
  if (!operable() || modal != Modal::None) return 0;
  // Left is "forward": deeper into the hierarchy, later in the thread list, next page.
  return gesture == TouchGesture::SwipeLeft ? 1 : -1;
}

void routeSwipe(int forward) {
  // HOME's line under the orb is the destination picker.
  if (screen == Screen::Home) { goToThreads(); return; }

  if (screen == Screen::Approvals && gw->approvalCount() > 1) {
    const int count = (int)gw->approvalCount();
    approvalIndex = (size_t)(((int)approvalIndex + forward + count) % count);
    contentDirty = true;
    return;
  }

  // The three levels.
  if (screen == Screen::Threads || screen == Screen::Projects
      || screen == Screen::Environments) {
    levelStep(forward);
    return;
  }

  // Paging the reply, which is the meaning this gesture already had here.
  if (screen != Screen::Response || !gw->responseOpen()) return;
  stepReplyPage(forward);
}

void holdSwipeForJob(TouchGesture gesture) {
  const int forward=swipeDirection(gesture);
  if(forward==0)return;
  if(pendingGesture.put(static_cast<uint8_t>(gesture),0,0,0,navigationGeneration,millis())) { UI_PROFILE(++touchFunnel.lost;) }
  UI_PROFILE(++touchFunnel.queued;)
  message=kQueuedMessage;
  contentDirty=true;
}

// Runs the held gesture, once, when the slot is free - or says why it did not. Called from the
// frame after the job's completion has been published, so the screen it is validated against is the
// one the person is now looking at.
void drainPendingGesture() {
  if(!pendingGesture.valid || uiNetworkBusy())return;
  buildActions();   // a held bar press is checked against the bar as it is NOW, not as it was while busy
  PendingGesture held;
  const PendingGesture::Fate fate=pendingGesture.take(navigationGeneration,millis(),
    [](int16_t x,int16_t y){return touchTargetAt(x,y).identity;},held);
  if(message==kQueuedMessage)message="";
  if(fate==PendingGesture::Fate::Nothing)return;
  if(fate!=PendingGesture::Fate::Replay || recordArmed) {
    UI_PROFILE(++touchFunnel.lost;)
    message=fate==PendingGesture::Fate::Expired?"Timed out; tap again":"Screen changed; tap again";
    contentDirty=true;
    return;
  }
  UI_PROFILE(++touchFunnel.replayed;)
  dragTravel=0;dragTravelX=0;
  if(held.kind==static_cast<uint8_t>(TouchGesture::Tap)) handleTap(held.x,held.y);
  else if(drawerT<=0.05f && operable() && modal==Modal::None)
    routeSwipe(held.kind==static_cast<uint8_t>(TouchGesture::SwipeLeft)?1:-1);
}

}  // namespace

// ---------------------------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------------------------

bool uiBegin(GatewayClient& gateway, Provisioning& provisioning, DeviceStore& deviceStore) {
  gw = &gateway;
  prov = &provisioning;
  store = &deviceStore;
  browse.begin(deviceStore);
  voice.begin(deviceStore);
  gw->setInteractionHandler(uiNetworkLoop);
  uiNetworkReady = gw->networkRunning();

  orbReady = orb.begin(kOrbDrawPx - 8, kOrbDots);
  // A fifth of the home orb's dot budget. It is 44 px across; a denser cloud at that size reads as
  // a smudge, and the point of it is only to show that something is still happening.
  miniReady = miniOrb.begin(kMiniOrbPx - 4, 180);
  orbStartedAt = millis();
  setMode(OrbMode::Ring);
  rebuildDrawerRows();
  chromeDirty = true;
  contentDirty = true;
  return orbReady && miniReady;
}

void uiHandleTouch(const TouchEvent& event) {
  // Counted before ANY gate, including the readiness check below, so an event that is swallowed
  // there still shows up as delivered-but-never-dispatched. Replayed events are not re-counted.
  UI_PROFILE(
    if(!replayingTouches) {
      if(event.gesture==TouchGesture::Drag)++touchFunnel.drags;
      else if(event.gesture!=TouchGesture::None)++touchFunnel.discrete;
    }
  )
  if (!displayReady() || !gw || !prov) return;
  // Any contact holds the gateway scheduler's own polls for a moment (GatewayClient::noteInteraction):
  // a poll that starts under a finger is the request this tap's job would queue behind.
  if (!replayingTouches && event.gesture != TouchGesture::None) gw->noteInteraction();
  if (!replayingTouches && !retainedTouches.empty()) {
    if(event.gesture==TouchGesture::Drag)touchTarget.move(event);
    if(event.gesture!=TouchGesture::Drag && event.gesture!=TouchGesture::None){++touchPerformance.retained;UI_PROFILE(++touchFunnel.retained;)}
    if(!retainedTouches.push(event,navigationGeneration,lastRevision,millis())){touchTarget.cancel();inputWasDiscarded=true;UI_PROFILE(++touchFunnel.overflow;)}
    return;
  }
  if (!gw->tryLockState(0)) {
    if(event.gesture==TouchGesture::Drag)touchTarget.move(event);
    if(event.gesture!=TouchGesture::Drag && event.gesture!=TouchGesture::None){++touchPerformance.retained;UI_PROFILE(++touchFunnel.retained;)}
    if(!retainedTouches.push(event,navigationGeneration,lastRevision,millis())) { touchTarget.cancel();inputWasDiscarded=true;UI_PROFILE(++touchFunnel.overflow;) }
    return;
  }
  struct TouchStateGuard { GatewayClient* client; ~TouchStateGuard() { client->unlockState(); } } touchGuard{gw};
  if(event.gesture!=TouchGesture::None && event.gesture!=TouchGesture::Drag) {
    const uint32_t age=millis()-event.sampledAt;
    touchPerformance.dispatched(age);
    UI_PROFILE(++touchFunnel.dispatched;touchFunnel.ageSum+=age;if(age>touchFunnel.ageMax)touchFunnel.ageMax=age;)
  }
  if(event.gesture==TouchGesture::Press && event.y>=kContentTop && lastRevision!=gw->revision()) {
    touchTarget.cancel();message="Screen changed; tap again";contentDirty=true;return;
  }
  if(event.gesture==TouchGesture::Press) {
    const TouchTargetInfo target=touchTargetAt(event.x,event.y);
    touchTarget.begin(event,target.identity,navigationGeneration,target.rect.x,target.rect.y,target.rect.w,target.rect.h);
    dragTravel=0;dragTravelX=0;dragAxis=DragAxis::Undecided;
    wifiKeyboardDragStart=wifiKeyboardOffset;wifiKeyboardDragged=false;
    wifiKeyboardDragging=screen==Screen::WifiPassword && event.y>=kWifiKeyboardTop && event.y<kWifiUtilityTop;
    dragOwner=event.y<kContentTop?DragOwner::Drawer:drawerT>0.05f?DragOwner::DrawerList:DragOwner::Content;
  } else if(event.gesture==TouchGesture::Drag) {
    touchTarget.move(event);
  } else if(event.gesture==TouchGesture::Tap) {
    const TouchTargetInfo target=touchTargetAt(event.x,event.y);
    const bool activate=touchTarget.accepts(event,target.identity,navigationGeneration);
    touchTarget.cancel();
    if(recordArmed){finishRecording();return;}
    if(!activate)return;
  } else if(event.gesture!=TouchGesture::None) {
    touchTarget.cancel();
  }
  // Local navigation stays usable. Mutations remain serialized; only an explicitly confirmed
  // Stop may be held behind one existing job, with context/revision revalidation at execution.
  if(uiNetworkBusy() && !(screen==Screen::Wifi || screen==Screen::WifiDetails || screen==Screen::WifiPassword || screen==Screen::WifiJoining || screen==Screen::WifiPhone)) {
    if(event.gesture==TouchGesture::Tap) {
      const uint32_t before=navigationGeneration;
      if(!handleBusyLocalTap(event.x,event.y))holdTapForJob(event);
      // The person navigated on purpose, so a tap held before it is moot rather than "stale".
      else if(before!=navigationGeneration)pendingGesture.cancel();
    }
    else if(event.gesture==TouchGesture::Drag) {dragTravelX+=event.dx;handleDrag(event.y,event.dy);}
    else if(event.gesture==TouchGesture::SwipeLeft || event.gesture==TouchGesture::SwipeRight) holdSwipeForJob(event.gesture);
    else if(event.gesture==TouchGesture::Press && screen==Screen::Send && uip::hit(micButtonRect(),event.x,event.y)) {
      // Hold-to-talk cannot wait for a slot - a recording starts on contact or not at all - so it is
      // refused out loud rather than being swallowed.
      UI_PROFILE(++touchFunnel.refused;)
      message="Busy; hold again in a moment";
      contentDirty=true;
    }
    return;
  }

  switch (event.gesture) {
    case TouchGesture::Press:
      // Ownership is decided here and nowhere else, from where the finger landed.
      dragTravel = 0;
      dragTravelX = 0;
      dragAxis = DragAxis::Undecided;
      if (event.y < kContentTop) dragOwner = DragOwner::Drawer;
      else if (drawerT > 0.05f) dragOwner = DragOwner::DrawerList;
      else dragOwner = DragOwner::Content;
      // Push-to-talk starts on contact, not on release: waiting for the lift would record nothing.
      if (operable() && modal == Modal::None && screen == Screen::Send && !clipHeld
          && !voiceInJourney() && voice.canStartCapture()
          && touchDown() && event.contactId==touchContactId() && drawerT <= 0.05f && uip::hit(micButtonRect(), event.x, event.y)) {
        startRecording();
      }
      return;

    case TouchGesture::Drag:
      dragTravelX = (int16_t)(dragTravelX + event.dx);
      handleDrag(event.y, event.dy);
      if(wifiKeyboardDragging && dragAxis==DragAxis::Horizontal) {
        wifiKeyboardDragged=true;moveWifiKeyboard(wifiKeyboardDragStart-dragTravelX);return;
      }
      if (dragAxis == DragAxis::Horizontal && dragOwner == DragOwner::Content) {
        updateHomePickerDrag(dragTravelX);
      }
      return;

    case TouchGesture::Release:
      if (dragAxis == DragAxis::Horizontal) settleHomePickerBack();
      dragTravel = 0;
      dragTravelX = 0;
      if (recordArmed) finishRecording();
      return;

    case TouchGesture::Tap:
      dragTravel = 0;
      dragTravelX = 0;
      if (recordArmed) { finishRecording(); return; }
      handleTap(event.x, event.y);
      return;

    case TouchGesture::SwipeLeft:
    case TouchGesture::SwipeRight: {
      if(screen==Screen::WifiPassword && wifiKeyboardDragging) {
        if(!wifiKeyboardDragged && dragAxis!=DragAxis::Vertical)
          moveWifiKeyboard(wifiKeyboardOffset+(event.gesture==TouchGesture::SwipeLeft?168:-168));
        wifiKeyboardDragging=false;wifiKeyboardDragged=false;dragTravel=0;dragTravelX=0;dragAxis=DragAxis::Undecided;return;
      }
      // Decided in swipeDirection()/routeSwipe() so that a swipe held behind a gateway job (see
      // holdSwipeForJob) takes exactly the route an immediate one does.
      const int forward = swipeDirection(event.gesture);
      if (forward != 0) routeSwipe(forward);
      return;
    }

    case TouchGesture::LongPress:
      // Deliberately does nothing now.
      //
      // This used to open the config portal from ANY screen, with no confirmation — and the portal
      // had no exit, so one accidental hold locked the device on the setup screen until it was
      // power-cycled. That is far too much consequence for a gesture a person makes by resting a
      // thumb, especially on a screen that now also owns holds for push-to-talk and drags for the
      // drawer and the picker.
      //
      // The portal is still one tap away where it belongs and where its consequences are legible:
      // the PORTAL action on the Device and Gateway screens.
      return;

    default:
      return;
  }
}

#if BENCH_SELFTEST
void uiBenchGoToThreads() { goToThreads(); }

bool uiBenchCaptureState(bool& audioReady, bool& threadReady, DeviceBlockerKind& blocker) {
  if (!gw || !gw->tryLockState(0)) return false;
  audioReady = audio::available();
  threadReady = haveThread();
  blocker = gw->blockerKind();
  gw->unlockState();
  return true;
}

bool uiBenchRunAction(const char* label) {
  buildActions();
  for (uint8_t i = 0; i < actionCount; ++i) {
    if (strcmp(actions[i].label, label) != 0) continue;
    if (!actions[i].enabled) {
      Serial.printf("[bench] action \"%s\" is present but disabled\n", label);
      return false;
    }
    runAction(actions[i].id);
    return true;
  }
  Serial.printf("[bench] action \"%s\" is not offered on this screen (%u actions)\n",
                label, (unsigned)actionCount);
  return false;
}

const char* uiBenchBoundThreadTitle() {
  const ThreadOption* row = boundThreadRow();
  return row ? row->title.c_str() : "(none)";
}

int uiBenchThreadRowCount() { return (int)threadRowCount(); }

const char* uiBenchScreenName() {
  switch (screen) {
    case Screen::Status: return "Status";
    case Screen::Home: return "Thread";
    case Screen::Threads: return "Threads";
    case Screen::Send: return "Send";
    case Screen::Actions: return "Actions";
    case Screen::Response: return "Response";
    case Screen::Approvals: return "Approvals";
    case Screen::Environments: return "Environments";
    case Screen::Projects: return "Projects";
    case Screen::Device: return "Device";
    case Screen::Gateway: return "Gateway";
    case Screen::Wifi: return "Wi-Fi";
    case Screen::WifiDetails: return "Wi-Fi network";
    case Screen::WifiPassword: return "Wi-Fi entry";
    case Screen::WifiJoining: return "Wi-Fi connecting";
    default: return "?";
  }
}

bool uiBenchRecording() { return recordArmed; }
bool uiBenchNetworkBusy() { return uiNetworkBusy(); }

// The recording branch ends a clip on !touchDown(), reading the panel directly — correct, because
// a clip ends when the glass stops being touched and that must not depend on which gesture
// touchPoll() eventually decides the hold was. A synthesised Press cannot hold the glass, so the
// first tick would end the clip before a sample is pumped. This substitutes for the finger and
// nothing else.
void uiBenchHoldGlass(bool held) { benchGlassHeld = held; }

// Rebinds through the ordinary selection path. The device under test carries a projectId from
// before folder selection existed, and the gateway correctly refuses to create into a folder that
// is not in the live snapshot — so the happy path cannot be reached until the binding is current.
int uiBenchRebindFirstProject() {
  if (!browse.refreshProjects()) {
    Serial.printf("[bench] refreshProjects failed: %s\n", browse.projectsDetail().c_str());
    return -1;
  }
  Serial.printf("[bench] projects=%u boundProjectId=\"%s\"\n",
                (unsigned)browse.projectCount(), browse.boundProjectId().c_str());
  for (size_t i = 0; i < browse.projectCount(); ++i) {
    const BrowseProject* pr = browse.project(i);
    if (pr) Serial.printf("[bench]   [%u] id=\"%s\" title=\"%s\" selected=%s\n",
                          (unsigned)i, pr->id.c_str(), pr->title.c_str(),
                          pr->selected ? "yes" : "no");
  }
  if (browse.projectCount() == 0) return -2;
  const bool ok = browse.selectProject(0);
  Serial.printf("[bench] selectProject(0) -> %s; boundProjectId now \"%s\"\n",
                ok ? "true" : "false", browse.boundProjectId().c_str());
  return ok ? (int)browse.projectCount() : -3;
}

int uiBenchCreateStatus() { return browse.createStatus(); }
const char* uiBenchCreateDetail() { return browse.createDetail().c_str(); }

void uiBenchMicRect(int16_t* x, int16_t* y, int16_t* w, int16_t* h) {
  const Rect r = micButtonRect();
  *x = r.x; *y = r.y; *w = r.w; *h = r.h;
}

bool uiQualificationBusy() {
  return uiNetworkBusy() || recordArmed || audio::recording() || clipHeld || voice.tracking()
    || (!voice.canDismissCapture() && voice.hasJob()) || screen==Screen::WifiPassword
    || screen==Screen::WifiJoining || screen==Screen::WifiPhone || screen==Screen::Wifi
    || screen==Screen::WifiDetails || modal!=Modal::None;
}
bool uiQualificationStep(unsigned step) {
  if(uiQualificationBusy() || !gw->tryLockState(0))return false;
  struct Guard { GatewayClient* c;~Guard(){c->unlockState();} } guard{gw};
  switch(step%10) {
    case 0: goTo(Screen::Home);return true;
    case 1: runAction(Act::PickThread);return true;
    case 2: if(browse.previewThreadCount())selectThreadRow(0);return true;
    case 3: goBack();return true;
    case 4: runAction(Act::SavedActions);return true;
    case 5: goTo(Screen::Home);return true;
    case 6: runAction(Act::Talk);return true;
    case 7: goTo(Screen::Home);return true;
    case 8: runAction(Act::Refresh);return true;
    default: goTo(Screen::Home);return true;
  }
}
bool uiQualificationVerify() {
#ifndef NEXT_CODER_QUALIFICATION_VERIFY_ACTION_ID
  // A mutable display label is not authority to dispatch a production action.
  return false;
#else
  if(uiQualificationBusy() || !gw->tryLockState(0))return false;
  struct Guard { GatewayClient* c;~Guard(){c->unlockState();} } guard{gw};
  for(size_t i=0;i<gw->controlCount();++i) {
    const DeviceControl* row=gw->control(i);
    if(!row || row->actionId!=NEXT_CODER_QUALIFICATION_VERIFY_ACTION_ID
        || row->kind!="remote_action" || !row->enabled || row->mediaKind.length())continue;
    runControlRow(*row);
    if(modal==Modal::ConfirmControl) {
      uiBenchRunAction("RUN");
      uiBenchRunAction("RUN"); // Deliberate duplicate: busy/replaced footer must reject it.
    }
    return uiNetworkBusy();
  }
  return false;
#endif
}

#endif

void uiTick() {
  if (!displayReady()) return;
  // setup() returns early when NVS is unavailable — a wrong partition table — without ever calling
  // uiBegin(). The board is dead at that point, but it must say so on the serial line rather than
  // panicking on a null pointer thirty times a second.
  if (!gw || !prov) return;
  // A queued gesture job would otherwise start at the network task's next tick, up to 100 ms away.
  // Atomics only, so it is safe before the model lock is taken (and when that lock is skipped).
  if (uiJobState.load(std::memory_order_acquire) == 1) {
    if (!uiJobKicked) { uiJobKicked = true; gw->wakeNetworkTask(); }
  } else {
    uiJobKicked = false;
  }
  // A finger resting on the glass (a hold, a long scroll) keeps the scheduler's polls quiet as well.
  if (touchDown()) gw->noteInteraction();
  // Not measurement: the content job's frame budget is counted from here (see contentJob.advance()
  // below), so this one clock read stays in every build. What the profile adds is only the exit
  // guard that records how long the pass took and what kind of pass it was.
  const uint32_t tickEnterUs = micros();
#if HOSYOND_UI_PROFILE
  uint8_t tickKind = kTickNotDue;
  struct TickExit {
    uint32_t enterUs; uint8_t& kind;
    ~TickExit() { lastTickDurUs = micros() - enterUs; lastTickKind = kind; }
  } tickExit{tickEnterUs, tickKind};
#endif
  // Read models and draw from one coherent state. A socket drops this lock; only compact
  // parsing can defer a frame. Never block the render task waiting for another task.
  reportTouchPerformance();
  UI_PROFILE(sampleTouchFunnel();)
  if (!gw->tryLockState(0)) { ++touchPerformance.lockSkips;UI_PROFILE(++touchFunnel.lockSkips;tickKind=kTickLockSkip;)nextFrameAt=millis()+kTargetFrameMs; return; }
  struct FrameStateGuard { GatewayClient* client; ~FrameStateGuard() { client->unlockState(); } } frameGuard{gw};
  completeUiNetworkJob();
  // Only meaningful while a job is in flight; cleared when idle so a job started by a path that does
  // not go through submitUiJob() can never inherit "background" from an earlier one.
  if (!uiNetworkBusy()) uiJobBackground = false;
  if(screen==Screen::WifiPhone && static_cast<int32_t>(millis()-phoneNextCheckAt)>=0) {
    phoneNextCheckAt=millis()+1000;
    auto latest=prov->phoneSetupSnapshot();
    if(latest.revision!=phoneSetup.revision || latest.active!=phoneSetup.active
        || (latest.waitingForHotspot && latest.remainingSeconds!=phoneSetup.remainingSeconds)) {
      const bool newQr=latest.apName!=phoneSetup.apName || latest.apPassword!=phoneSetup.apPassword || latest.active!=phoneSetup.active;
      phoneSetup=latest;
      if(phoneSetup.phase==PhoneSetupPhase::Succeeded){phoneSetupSucceeded=true;phoneQr.clear();}
      else if(phoneSetup.waitingForHotspot)phoneQr.clear();
      else if(newQr)refreshPhoneQr();
      contentDirty=true;barDirty=true;
    }
  }
  if(wifiObservedRevision!=prov->wifiRevision()) {
    refreshWifiUi();
    if(wifiConnection.phase==WifiConnectionPhase::TryingAlternate) {
      wifiHadDisconnect=true;
      wifiNotice="Trying saved Wi-Fi";wifiNoticeUntil=millis()+8000;
    } else if(wifiConnection.phase==WifiConnectionPhase::Joining
        && !wifiConnection.activeSsid.length() && wifiPreviousActive.length()) {
      wifiHadDisconnect=true;
      wifiNotice="Reconnecting Wi-Fi";wifiNoticeUntil=millis()+8000;
    } else if(wifiConnection.phase==WifiConnectionPhase::Connected) {
      if(wifiPreviousActive.length() && (wifiConnection.activeSsid!=wifiPreviousActive || wifiHadDisconnect)) {
        wifiNotice=wifiConnection.activeSsid==wifiPreviousActive?String("Wi-Fi restored"):String("Wi-Fi: ")+wifiConnection.activeSsid;
        wifiNoticeUntil=millis()+8000;
      }
      wifiPreviousActive=wifiConnection.activeSsid;wifiHadDisconnect=false;
    }
    if(screen==Screen::Wifi)message=wifiConnection.detail;
    if(screen==Screen::WifiJoining && wifiConnection.candidateId==wifiUiCandidateId
        && wifiConnection.candidateResult==WifiCandidateResult::Succeeded) {
      wifiPassword="";wifiShowSaved=true;message=wifiConnection.candidateDetail;goTo(Screen::Wifi);
    }
    chromeDirty=true;contentDirty=true;
  }
  if(wifiNoticeUntil && static_cast<int32_t>(millis()-wifiNoticeUntil)>=0){wifiNoticeUntil=0;wifiNotice="";chromeDirty=true;}
  TouchEventBuffer::Item retained;
  replayingTouches=true;
  while(retainedTouches.pop(retained)) {
    if(!TouchEventBuffer::current(retained,navigationGeneration,gw->revision(),millis())) {
      touchTarget.cancel();inputWasDiscarded=true;UI_PROFILE(++touchFunnel.stale;)continue;
    }
    uiHandleTouch(retained.event);
  }
  replayingTouches=false;
  if(inputWasDiscarded){++touchPerformance.discarded;inputWasDiscarded=false;message="Screen changed; tap again";contentDirty=true;}
  if(deferredStopPending && !uiNetworkBusy()) {
    deferredStopPending=false;
    if(deferredStopEnvironment==gw->context().environmentId && deferredStopThread==gw->context().threadId
        && deferredStopRevision==gw->controlsRevision()) dispatchControl(deferredStop);
    else {message="Stop context changed; review again";contentDirty=true;}
  }
  // A tap held behind the job that just finished. After the deferred Stop, which was confirmed
  // first and may have taken the slot again, in which case this waits for that one too.
  drainPendingGesture();
  captureHeldReply();

  // Recording owns the loop while it runs. The I2S ring holds tens of milliseconds, so the pump
  // has to be tighter than the frame budget; the orb stops for the duration and the button's own
  // timer is the moving thing instead. Redrawn four times a second, because a full frame between
  // reads is how a clip gains a gap.
  if (recordArmed && audio::recording()) {
    UI_PROFILE(tickKind = kTickRecording;)
    // startRecording() has just composed the whole page directly. A content job half-way through
    // its strips is moot, and resuming it after the capture would paint stale strips over the
    // result. (Done here rather than in startRecording(), whose test stubs only what it uses.)
    contentJob = ContentJob{};
    homeTextDirty = false;
    const uint32_t until = millis() + 25;
    while ((int32_t)(millis() - until) < 0) {
      if (!audio::pumpRecording()) break;
    }
    // The lift, taken from the held state rather than from a gesture. touchPoll() only decides
    // between a tap, a swipe and a release once the finger is off, and which of those it picks is
    // not this loop's business: a clip ends when the glass stops being touched. Reading it here
    // also means a hold that was already consumed as something else — a long press, say — cannot
    // leave the recording running.
    if (!touchDown()
#if BENCH_SELFTEST
        && !benchGlassHeld
#endif
       ) {
      finishRecording();
      return;
    }

    const uint32_t now = millis();
    bool capturePainted=false;
    // Only the digits, at a fixed origin. Repainting the whole capsule here cost about 4 ms of a
    // 25 ms pump slice, four times a second, for a number that changes in one place.
    if (now - recordPaintedAt >= 250) {
      recordPaintedAt = now;
      paintMicTimer(audio::recordedMs());
      capturePainted=true;
    }
    // THE ORB, INSIDE THE PUMP'S SLICE.
    //
    // The mini orb, not the 112 px one, and the choice is a capture-quality decision rather than a
    // visual one. Capture owns this loop: the I2S ring holds only tens of milliseconds and a full
    // frame between reads is how a clip gains a gap, so whatever is drawn here is a hole in the
    // pumping. The 112 px orb is ~640 dots, a 21 904-byte clear, and a 9 852-pixel blit — on the
    // order of 15 ms, which is most of the ring's margin in one go. The 44 px orb is a twentieth of
    // that dot budget and a 1 520-pixel blit, on the order of 1.5 ms.
    //
    // 30 Hz of a 1.5 ms draw is a 6% duty against the pump. A dropped orb frame is invisible; a
    // dropped sample is a corrupted voice note, so the trade goes this way round every time. If the
    // measured pump margin turns out to be tighter than this, lower the cadence here first — the
    // animation degrades gracefully and the audio does not.
    if (miniReady && now - recordOrbAt >= 33) {
      recordOrbAt = now;
      // The big orb, and during a capture this runs inside the pump's slice — see the cadence
      // note where recordOrbAt is set. Verified by the bench harness, not by reasoning: a full
      // 4 s hold still returns every sample.
      displayDrawOrb(orb, kOrbCx, voiceLayout().orbCy, now - orbStartedAt, kOrbDrawPx);
      capturePainted=true;
    }
    if(capturePainted)touchPerformance.frame(millis());
    // A ceiling was hit while the finger is still down: stop here rather than waiting for a lift
    // that may not come for another twenty seconds.
    if (!audio::recording()) finishRecording();
    nextFrameAt = millis();
    return;
  }

  const uint32_t now = millis();
  if (nextFrameAt == 0) nextFrameAt = now;
  if ((int32_t)(now - nextFrameAt) < 0) return;
  // Paced against a running deadline rather than "33 ms since the last frame finished". The latter
  // adds the draw time to every interval, so a 27 ms draw yields 37 ms frames — 27 fps that also
  // wanders as the draw cost changes.
  nextFrameAt += kTargetFrameMs;
  // If a frame ran long, do not catch up by drawing several back to back — that reads as a stutter
  // followed by a sprint. Drop the missed slots and resync.
  if ((int32_t)(now - nextFrameAt) > (int32_t)kTargetFrameMs) nextFrameAt = now + kTargetFrameMs;

  // The time the animations below advance by: what actually passed since the last painted frame,
  // not the nominal period. approach() used to be handed the constant frame length, which is only
  // true while every frame lands on time; a 40 ms content frame then made the drawer and the action
  // bar crawl in slow motion for the length of the stall. Clamped so a long sleep or pause cannot
  // teleport an animation to its end in a single step.
  uint32_t frameDtMs = kTargetFrameMs;
  if (lastFrameAt != 0) frameDtMs = min<uint32_t>(max<uint32_t>(now - lastFrameAt, 1), 3 * kTargetFrameMs);
  if (lastFrameAt != 0) {
    const uint32_t gap = now - lastFrameAt;
    if (gap > stats.worstGapMs) stats.worstGapMs = gap;
    if (gap > stats.worstGapEverMs) stats.worstGapEverMs = gap;
    if (gap > kTargetFrameMs * 3 / 2) { stats.hitches++; stats.hitchesEver++; }
  }
  lastFrameAt = now;

  // modeForState() lower-cases a thread status and hands string literals to the shared mapper, so
  // every call is a heap round trip. Running it once a frame is the per-frame allocation this path
  // is meant to be free of — sixty malloc/free pairs a second, fragmenting the internal heap the
  // orb buffers live in. Its answer only moves when the client's revision does, when the link
  // changes, or when the microphone opens, so it is recomputed on those edges instead.
  static bool recordingWas = false;
  const bool recordingNow = audio::recording();
  bool modeDirty = recordingNow != recordingWas;
  recordingWas = recordingNow;

  // Observing the client is guarded, rendering is not.
  //
  // The gateway's network task holds this lock across a request, so waiting for it would put a
  // multi-second socket back in front of the renderer — the exact stall this split removes. A zero
  // timeout means a frame that arrives mid-request simply reuses the previous frame's values and
  // draws on time; text is at most a few frames stale, which is invisible, and the orb never
  // stops.
  static GatewayLink link = GatewayLink::Idle;
  static ProvisioningState provState = ProvisioningState::Unprovisioned;

  const bool observed = gw->tryLockState(0);
  if (observed) {

  // Claim state and link state change asynchronously — the owner is typing a code on another
  // device — so the screen is driven by them rather than only by what the finger did.
  link = gw->link();
  provState = prov->status().state;
  if (link != lastLink || provState != lastProvState) {
    lastLink = link;
    lastProvState = provState;
    if (!operable() && screen != Screen::Status && !configScreen()) {
      screen = Screen::Status;
      message = "";
    }
    if (operable() && screen == Screen::Status) { screen = Screen::Home; message = ""; }
    rebuildDrawerRows();
    chromeDirty = true;
    markContentDirty(kCauseLink);
    modeDirty = true;
  }
  if (gw->revision() != lastRevision) {
    lastRevision = gw->revision();
    // Local network entry has no dependency on thread/display refreshes. Repainting the
    // complete keyboard for those updates adds work underneath an owner's active contact.
    if (!(screen==Screen::Wifi || screen==Screen::WifiDetails
          || screen==Screen::WifiPassword || screen==Screen::WifiJoining || screen==Screen::WifiPhone)) markContentForModelChange(kCauseRevision);
    drawerDirty = true;
    modeDirty = true;
    // The header is painted on chromeDirty, which revision() does not set — so the device's own
    // label, which only arrives with the first successful display fetch, was computed once at boot
    // and never looked at again. That is why the header sat on "Controller 3bq7" while the gateway
    // had been sending "Hosyond Touch screen" for minutes.
    const String name = deviceName();
    if (name != shownDeviceName) {
      shownDeviceName = name;
      chromeDirty = true;
    }
  }
  if (browse.revision() != lastBrowseRevision) {
    lastBrowseRevision = browse.revision();
    if (!(screen==Screen::Wifi || screen==Screen::WifiDetails
          || screen==Screen::WifiPassword || screen==Screen::WifiJoining || screen==Screen::WifiPhone)) markContentForModelChange(kCauseBrowse);
  }
  if (gw->approvalCount() != lastApprovalCount) {
    lastApprovalCount = gw->approvalCount();
    drawerDirty = true;
    // A parked command outranks agent activity in presentationForState(), so its edge has to
    // recompute the orb as well as the drawer row.
    modeDirty = true;
  }
  if (screen != lastScreen || modal != lastModal) {
    lastScreen = screen;
    lastModal = modal;
    chromeDirty = true;
    markContentDirty(kCauseScreen);
  }

  gw->unlockState();
  }   // observed

#if ORB_BENCH
  // The bench walks the modes on a timer; nothing the gateway says drives them here.
  (void)modeDirty;
  if ((int32_t)(now - benchNextAt) >= 0) {
    benchNextAt = now + 6000;
    benchIndex = (uint8_t)((benchIndex + 1) % (uint8_t)OrbMode::ModeCount);
    setMode(orbModeAt(benchIndex));
    statusLabel = orbLabelForMode(currentMode);
    contentDirty = true;
  }
#else
  // One call decides the animation AND the word, on the edges that can change either: the
  // microphone opening or closing, the link or provisioning state moving, the client's revision
  // bumping (which covers the response state and the thread list), and the approval queue.
  if (modeDirty) applyPresentation();
  // Assigned from const char*, never through a String temporary: Arduino's String reuses its own
  // buffer for an assignment that fits, so this costs nothing, while wrapping it in String(...)
  // would allocate and free once a frame.
  statusLabel = currentLabel;
#endif

  UI_PROFILE(tickKind = kTickPainted; ++touchFunnel.painted;)
  const uint32_t drawStart = millis();
#if HOSYOND_UI_PROFILE
  // MEASUREMENT: see FrameSplit. lap() charges the time since the previous lap to one stage.
  uint32_t lapUs = micros();
  const uint32_t preUs = lapUs - tickEnterUs;
  uint32_t logicUs = 0, chromeUs = 0, barUs = 0, drawerUs = 0, contentUs = 0, pickerUs = 0, orbUs = 0, statusUs = 0;
  const auto lap = [&lapUs](uint32_t& bucket) { const uint32_t t = micros(); bucket += t - lapUs; lapUs = t; };
#endif
  const bool pickerMoving = advanceHomePickerMotion(now);

  // The drawer eases open and shut. While it is moving nothing else in the content region is
  // painted: it covers all of it, and repainting underneath would be work nobody can see.
  const float drawerTarget = drawerOpen ? 1.0f : 0.0f;
  const float nextDrawerT = uip::approach(drawerT, drawerTarget, frameDtMs,
                                          drawerOpen ? kDrawerOpenMs : kDrawerCloseMs);
  const bool drawerMoved = nextDrawerT != drawerT;
  drawerT = nextDrawerT;

  // The bar's contents are decided every frame and its presence follows from them. Hidden entirely
  // while the drawer is out: the drawer's own rows are the navigation, and two competing sets of
  // controls on one screen is what the tab bar used to be.
  buildActions();
  const uint32_t sig = signatureOfActions();
  if (sig != actionSignature) {
    actionSignature = sig;
    barDirty = true;
  }
  const float barTarget = (actionCount > 0 && drawerT <= 0.001f && !drawerOpen) ? 1.0f : 0.0f;
  const float nextBarT = uip::approach(barT, barTarget, frameDtMs, kBarSlideMs);
  const bool barMoved = nextBarT != barT;
  barT = nextBarT;
  // The content stops short of the tray whenever the tray BELONGS on screen, not merely once it has
  // finished arriving. Deciding this from barT meant that on the frame the drawer finished closing
  // the content was laid out at full height, and then laid out again as the tray rose — which on
  // HOME is the entire composition jumping.
  const bool reserve = actionCount > 0 && !drawerOpen;
  if (reserve != barReserved) {
    barReserved = reserve;
    markContentDirty(kCauseReserve);
  }

  // Arrival first, before anything paints into the region. A screen change clears the whole content
  // area exactly once, here, rather than each screen being trusted to cover its predecessor.
  if (viewKey() != paintedViewKey && drawerT <= 0.001f) {
    clearForArrival();
    markContentDirty(kCauseArrival);
  }

  UI_PROFILE(lap(logicUs);)
  UI_PROFILE(const bool chromeRan = chromeDirty;)
  if (chromeDirty && !displayComposeScene(0,kContentTop,panelGrey(kBg),[](void*){drawChrome();},nullptr))drawChrome();
  UI_PROFILE(lap(chromeUs);)

  // Order is load-bearing, three times over.
  //
  // The BAR goes first because clearContent() stops at contentBottom(): with the bar out, a content
  // repaint no longer touches the bottom band, and with the bar gone the same repaint reclaims it.
  // Painting the bar afterwards would have it wipe the content it had just been given room beside.
  //
  // The DRAWER goes second because on the frames where both move — the bar retracting as the drawer
  // slides down — the drawer is the one arriving, and it ends up covering the tray's band along
  // with everything else.
  //
  // The CONTENT goes last and only when the drawer is fully away, because the drawer covers the
  // whole page and repainting underneath it is work nobody can see.
  // Never while the drawer owns the screen — see openDrawer() for what interleaving the two did.
  const bool barRan = (barMoved || barDirty) && !drawerOpen && drawerT <= 0.001f;
  if (barRan) {
    if(!displayComposeScene(kH-kBarH,kBarH,panelGrey(kBg),[](void*){paintActionBar();},nullptr))paintActionBar();
  }
  UI_PROFILE(lap(barUs);)

  const bool drawerActive = drawerMoved || drawerT > 0.0f || drawerShownPx > 0;
  if (drawerActive && (drawerMoved || drawerDirty)) {
    paintDrawerFrame();
    // Fully retracted: whatever the drawer was covering has to come back.
    if (drawerT <= 0.0f && drawerShownPx <= 0) contentDirty = true;
  }
  drawerDirty = false;
  UI_PROFILE(lap(drawerUs);)

  // ---- Content: arm, then advance a time-budgeted slice of the job. See ContentJob. ----
  //
  // A drawer that comes out over a half-composed job abandons it: the drawer covers the page, and
  // when it retracts it sets contentDirty, which re-arms a full job from the top.
  if (contentJob.active && drawerT > 0.001f) { contentJob.active = false; contentDirty = true; }
  if (contentDirty && drawerT <= 0.001f) {
    // A fresh full request (or a restart of one in flight, with the freshest state).
    UI_PROFILE(if (contentJob.active) ++split.restarts;)
    contentJob.arm(kContentTop, contentBottom(), /*isPartial=*/false);
    contentDirty = false;
    homeTextDirty = false;
    UI_PROFILE(
      ++split.jobs;
      ++split.cause[pendingContentCause == kNoCause ? kCauseOther : pendingContentCause];
      pendingContentCause = kNoCause;
      split.lastJobScreen = (uint8_t)screen;
    )
  } else if (homeTextDirty && drawerT <= 0.001f && !(contentJob.active && !contentJob.partial)) {
    homeTextDirty = false;
    int16_t top = 0, end = 0;
    if (screen == Screen::Home && modal == Modal::None && homeTextRows(top, end)) {
      UI_PROFILE(if (contentJob.active) ++split.restarts;)
      contentJob.arm(top, end, /*isPartial=*/true);
      UI_PROFILE(
        ++split.jobs;
        ++split.partialJobs;
        ++split.cause[pendingContentCause == kNoCause ? kCauseOther : pendingContentCause];
        pendingContentCause = kNoCause;
        split.lastJobScreen = (uint8_t)screen;
      )
    } else {
      contentDirty = true;   // no longer HOME or no rows: the safe answer is the full repaint
    }
  }

  // True while a job that covers the orb's area is unfinished (or finished this frame): the orb is
  // withheld, as it always was on a repaint frame.
  bool repaintedContent = false;
  if (contentJob.active) {
    if (screen == Screen::WifiPassword) {
      // Its keyboard is painted by its own dirty flags straight to the panel; one shot, as before.
      paintContent();
      contentJob.active = false;
    } else {
      constexpr int16_t kStripRows = 22;   // displayComposeBands()'s band height
      contentJob.advance(
        [](int16_t y, int16_t rows) {
          if (displayComposeScene(y, rows, panelGrey(kBg), [](void*){paintContent();}, nullptr)) return true;
          paintContent();                    // no band canvas: the old direct paint of everything
          return false;
        },
        []() { return micros(); }, tickEnterUs, kPaintBudgetUs, kStripRows);
    }
    contentDirty = false;   // paintContent() clears it per strip; make it unconditional
    repaintedContent = !contentJob.partial;
#if HOSYOND_UI_PROFILE
    if (!contentJob.active) {
      split.strips += contentJob.strips;
      split.jobUs += contentJob.spentUs;
      if (contentJob.spentUs > split.jobUsMax) split.jobUsMax = contentJob.spentUs;
      if (contentJob.frames > split.jobFramesMax) split.jobFramesMax = contentJob.frames;
    }
#endif
  }
  if(!repaintedContent && screen==Screen::WifiPassword && modal==Modal::None && drawerT<=0.001f) {
    if(wifiEntryDirty)paintWifiEntry();
    if(wifiLettersDirty)paintWifiLetters();
    if(wifiUtilityDirty)paintWifiUtilities();
  }

  UI_PROFILE(lap(contentUs);)
  const bool paintedPickerMotion = pickerMoving && screen == Screen::Home
    && modal == Modal::None && drawerT <= 0.001f && !contentJob.active;
  if (paintedPickerMotion) paintHomePickerMotion();
  UI_PROFILE(lap(pickerUs);)

  // The orb, its label, and HOME's small carousel band animate. Everything else is repainted on
  // change, which is what keeps a list screen inside the frame budget: a full list redraw costs
  // several frames' worth of SPI and happens once, when the list actually changed.
  const uint32_t elapsed = now - orbStartedAt;
  const bool bigOrb = (screen == Screen::Home || screen == Screen::Status || voiceOwnsScreen())
    && modal == Modal::None && drawerT <= 0.001f;

  // The orb and either a full content repaint or a carousel frame do not share a frame.
  //
  // Measured on the board at 80 MHz SPI (0.2.22): the orb is ~6 ms a frame (geometry 3.1,
  // rasterisation 1.2, blit and the rest 1.7), NOT the ~24 ms this comment used to claim. A full
  // content repaint is ~40 ms on top of that, which is what produced the 70 ms frames. So the orb
  // yields to a content job that covers its area, and the job itself is sliced across frames
  // (ContentJob) so that no single frame carries the whole 40 ms. A HOME text-only refresh does
  // not cover the orb and does not interrupt it.
  //
  // The drawer and the action tray are cheap enough to coexist with it now that neither pays
  // distance-field arithmetic for its flat middle. The carousel draws up to two anti-aliased
  // buttons, so it gets the same one-frame priority as a content repaint.
  UI_PROFILE(bool orbDrawn = false;)
  if (repaintedContent || paintedPickerMotion) {
    // Nothing: the orb resumes when the short repaint/transition is finished.
  } else if (bigOrb && orbReady) {
    displayDrawOrb(orb, kOrbCx, stack.orbCy, elapsed, kOrbDrawPx);
    UI_PROFILE(orbDrawn = true;)
    UI_PROFILE(lap(orbUs);)
    // The claim block starts where the label would be, and the label's strip is full width: drawing
    // both means the code is repainted over four times a second by a word.
    // HOME has no shimmer: its prominent line is the thread's name, and the state word — when it
    // is worth showing at all — takes that same line. Drawing both would be the redundancy this
    // screen was decluttered to remove, and it would also cost a 240x22 blit every frame.
    if (!stack.label) {
      shownLabel = "";
    } else if (statusLabel != shownLabel) {
      displayClearStatus(stack.labelY);
      shownLabel = statusLabel;
    }
    if (stack.label) displayDrawStatus(statusLabel.c_str(), stack.labelY, elapsed);
  } else if (miniReady) {
    // On the voice screen the mini orb is part of the composition, not the header: it is the
    // recording indicator, and during a capture it is the only thing on the panel that moves.
    const bool inComposition = voiceShowsOrb();
    displayDrawMiniOrb(miniOrb, inComposition ? kOrbCx : kMiniOrbCx,
                       inComposition ? voiceLayout().orbCy : kMiniOrbCy, elapsed);
    UI_PROFILE(orbDrawn = true;)
    UI_PROFILE(lap(orbUs);)
    shownLabel = "";
  }
  // The header's right-hand affordance never disappears: whenever the mini orb is not sitting in
  // the header, a dot stands in for it so the drawer's tap target keeps its mark.
  if ((bigOrb || voiceShowsOrb()) && orbReady) drawHeaderStatusDot();
  UI_PROFILE(lap(statusUs);)

#if HOSYOND_UI_PROFILE
  // MEASUREMENT: fold this frame into the split window. See FrameSplit and the [frame-split] line.
  {
    const uint32_t tickUs = lapUs - tickEnterUs;
    FrameSplit& f = split;
    ++f.frames;
    f.pre += preUs; f.logic += logicUs; f.chrome += chromeUs; f.bar += barUs; f.drawer += drawerUs;
    f.content += contentUs; f.picker += pickerUs; f.orb += orbUs; f.status += statusUs; f.tick += tickUs;
    if (orbDrawn) ++f.orbFrames;
    if (repaintedContent) ++f.contentFrames;
    if (chromeRan) ++f.chromeFrames;
    if (barRan) ++f.barFrames;
    if (tickUs > f.tickMax) f.tickMax = tickUs;
    if (orbUs > f.orbMax) f.orbMax = orbUs;
    if (preUs > f.preMax) f.preMax = preUs;
    if (contentUs > f.contentMax) f.contentMax = contentUs;
    if (f.lastTickEnterUs) {
      const uint32_t period = tickEnterUs - f.lastTickEnterUs;
      f.period += period;
      if (period > f.periodMax) f.periodMax = period;
    }
    f.lastTickEnterUs = tickEnterUs;
  }
#endif  // HOSYOND_UI_PROFILE

  touchPerformance.frame(millis());
  const uint32_t drawMs = millis() - drawStart;
  if (drawMs > stats.worstDrawMs) stats.worstDrawMs = drawMs;
  stats.frames++;

  static uint32_t lastReport = 0;
  if (lastReport == 0) lastReport = now;
  if (now - lastReport >= 2000) {
    const uint32_t windowMs = now - lastReport;
    stats.fps = stats.frames * 1000.0f / windowMs;
    // The mode is on the line because draw cost varies enormously between them, so a slow frame is
    // only diagnosable if you know what was being drawn.
    Serial.printf("[fps] %-10s %.1f  draw<=%ums  gap<=%ums  hitches=%u  budget=%ums  heap=%u\n",
                  orbStateName(currentMode), stats.fps, (unsigned)stats.worstDrawMs,
                  (unsigned)stats.worstGapMs, (unsigned)stats.hitches, (unsigned)kTargetFrameMs,
                  (unsigned)ESP.getFreeHeap());
    Serial.printf("      since boot: worst gap %u ms, %u hitches, up %u s\n",
                  (unsigned)stats.worstGapEverMs, (unsigned)stats.hitchesEver,
                  (unsigned)(millis() / 1000));
    UI_PROFILE(reportFrameSplit();)
    stats.frames = 0;
    stats.worstDrawMs = 0;
    stats.worstGapMs = 0;
    stats.hitches = 0;
    lastReport = now;
  }

  // HOME's pending selection, committed once the finger has settled.
  //
  // This is a server write (POST /v1/device/config/thread) and it runs after the frame is painted,
  // for the same reason the poll below does. A failed write REVERTS the highlight: the line under
  // the orb is what tells a person where their voice is going, and showing thread B while bound to
  // thread A would send it to the wrong place.
  // Destination browsing never writes on a timer; USE THREAD is the only commit.

  // Network polling runs on the same bounded worker as browse/action requests. Render state is a
  // private worker copy until completion, so an in-flight TLS read never races the orb renderer.
  if (!uiNetworkBusy() && voice.pollDue(millis()) && operable()) {
    auto polledVoice = std::make_shared<GatewayVoice>(voice);
    submitUiJob([polledVoice]() { polledVoice->poll(); }, [polledVoice]() {
      voice = *polledVoice;
      if (voice.revision() == lastVoiceRevision) return;
      lastVoiceRevision = voice.revision();
      applyPresentation();
      statusLabel = currentLabel;
      message = voice.detail();
      contentDirty = true;
      // Only an observed Sent milestone opens the thread reply. Review/failure remains explicit.
      if (voice.stage() == VoiceStage::Sent && screen == Screen::Send) {
        if (gw->context().environmentId != voiceCaptureEnvironment
            || gw->context().threadId != voiceCaptureThread) {
          message = "Voice sent to its original thread; open that thread for the reply";
        } else if (voice.responseAfter().length() > 0) {
          goTo(Screen::Response);
          queueResponsePage(0, true, voice.responseAfter());
        } else {
          message = "Voice sent; open its reply in the console";
        }
      }
    });
  }

}

void uiSleepUntilNextFrame() {
  // Sleep until the next frame is actually due rather than spinning on delay(1). Polling in 1 ms
  // steps means a frame fires on the first iteration AFTER its deadline, so the interval wanders by
  // a millisecond or more around the target. That wander is small in absolute terms and very
  // visible in an animation.
  UI_PROFILE(const uint32_t sleepStartUs = micros();)  // MEASUREMENT: see FrameSplit (headroom)
  const int32_t waitMs = (int32_t)(nextFrameAt - millis());
  if (waitMs > 1) delay((uint32_t)(waitMs - 1));
  else delay(1);
  UI_PROFILE(lastSleepUs = micros() - sleepStartUs; split.sleep += lastSleepUs;)
}
