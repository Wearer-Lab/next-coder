#pragma once

// The board-agnostic half of "drive a thread": the shapes a UI renders from, with no drawing and
// no board in them.
//
// These are the structures the CrowPanel firmware grew inside its main.cpp — DeviceControl,
// ThreadOption, the response paging state — lifted out so a second board does not have to reinvent
// them. Field names and defaults follow that implementation exactly, because the gateway's wire
// format is what they encode, not a taste.
//
// EVERY collection here is a fixed array. Nothing grows. This runs alongside a renderer that wants
// its frame budget, and an unbounded String vector fragmenting the heap over days of uptime is the
// failure mode that does not show up on the bench. The caps are stated next to each one; a payload
// larger than a cap is truncated, and truncation is logged rather than silently absorbed.

#include <Arduino.h>

// The gateway's own `limits.menuItems`. It truncates the controls layout to what the heartbeat
// declares, so raising this means raising GatewayLimits::menuItems too or the extra slots stay
// empty.
constexpr size_t kMaxDeviceControls = 8;

// `limits.threadItems`. Twelve rows of an owner's thread list is already more than any of these
// screens shows at once; the list is browsed, not displayed whole.
constexpr size_t kMaxThreadOptions = 12;

// NOT screen geometry — this is the gateway's page size. src/deviceThreadOutput.mjs wraps assistant
// text to 31 printable characters and slices it into pages of DEVICE_RESPONSE_LINES_PER_PAGE = 3.
// A taller screen shows more by walking pages, not by raising this: the extra slots would never be
// filled without a matching gateway change.
constexpr size_t kMaxResponseLines = 3;

// The gateway parses at most two follow-up ids out of a model's suggestion comment and discards the
// rest, so a third slot could not be filled.
constexpr size_t kMaxFollowUpActions = 2;

// The approval queue can be arbitrarily long server-side. Four is what a hardware controller can
// meaningfully triage; beyond that the answer is the console, and `approvalOverflow()` says so.
constexpr size_t kMaxPendingApprovals = 4;

// Protocol v2 assigns a macro's action id directly, so this list only matters to a v1 gateway.
constexpr size_t kMaxMacros = 6;

// A device-facing response body larger than this is a bug or an attack, not a payload. The largest
// real one is a twelve-row thread list at a few hundred bytes per row.
constexpr size_t kMaxResponseBodyBytes = 8192;

// One row of the controls layout. The payload of a saved action never crosses the firmware
// boundary — prompt text, shell commands, and macro steps stay server-side, and only the opaque
// `actionId` is cached here.
struct DeviceControl {
  String id;
  String actionId;
  String label;
  String kind;        // status | remote_action | capture_audio | capture_image | stop | reset | legacy
  String mediaKind;   // audio | image, when the action consumes a capture
  String reason;      // why it is disabled, when it is
  bool enabled = true;
  bool requiresThread = false;
  bool requiresConfirmation = false;
};

bool isSupportedControlKind(const String& kind);

// A row of GET /v1/device/threads. Browsing this list never changes execution context; only an
// explicit selectThread() does.
struct ThreadOption {
  String id;
  String title;
  String status;      // upper-cased latest-turn/session value
  bool selected = false;
};

// v1 only. Protocol v2 hands the macro's action id through the controls layout instead.
struct SavedMacro {
  String id;
  String label;
};

// A command the gateway's policy engine parked pending an owner decision. `commandId` is what
// answerApproval() needs; the rest is for rendering the question.
struct PendingApproval {
  String commandId;
  String intentType;
  String summary;
  String risk;
  String createdAt;
};

// Compact blockers preserve the three trust realms without retaining private question text.
constexpr size_t kMaxRemoteBlockerCount = 99;
enum class DeviceBlockerKind : uint8_t { None, GatewayApproval, ProviderApproval, UserInput, Unknown };
struct RemoteBlockers {
  size_t providerApprovals = 0;
  size_t userInputs = 0;
  bool providerUnknown = false;
  bool inputUnknown = false;
};
inline size_t boundedRemoteBlockerCount(size_t count) {
  return count > kMaxRemoteBlockerCount ? kMaxRemoteBlockerCount : count;
}
inline DeviceBlockerKind deviceBlockerKind(size_t gatewayApprovals, const RemoteBlockers& remote) {
  if (gatewayApprovals) return DeviceBlockerKind::GatewayApproval;
  if (remote.userInputs) return DeviceBlockerKind::UserInput;
  if (remote.providerApprovals) return DeviceBlockerKind::ProviderApproval;
  if (remote.providerUnknown || remote.inputUnknown) return DeviceBlockerKind::Unknown;
  return DeviceBlockerKind::None;
}
inline const char* deviceBlockerLabel(DeviceBlockerKind kind) {
  switch (kind) {
    case DeviceBlockerKind::GatewayApproval: return "Gateway approval";
    case DeviceBlockerKind::ProviderApproval: return "Provider approval";
    case DeviceBlockerKind::UserInput: return "Needs input";
    case DeviceBlockerKind::Unknown: return "Check T3 status";
    default: return "";
  }
}

// The two-line status surface, from GET /v1/device/display and from the `screen` object a dispatch
// may answer with. `counts` is the account at a glance — a total per resource and nothing else.
// Naming a resource takes one of the list routes: threads here, environments and projects in
// GatewayBrowse.
struct DisplayCounts {
  int environments = 0;
  int devices = 0;
  int media = 0;
  int macros = 0;
  int commands = 0;
  int onlineDevices = 0;
};

struct DisplayModel {
  String title = "Next Coder";
  String state = "boot";
  String line1 = "Starting";
  String line2 = "";
  DisplayCounts counts;
};

// The execution context the gateway owns, as this class caches it.
//
// All three ids are writable by the device now, each through its own endpoint and each validated
// server-side: environments through the claiming owner's scope, projects and threads against the
// bound environment's live T3 snapshot (docs/hardware-protocol.md, "Environment, project, and
// thread API"). The comment that used to sit here said an environment was read-only from the
// hardware and that no device-facing list of environments or projects existed; both were true
// until the gateway grew those routes, and neither is now.
//
// GatewayClient keeps all three confirmed binding ids so a dispatch can carry preconditions.
// Browse owns labels and lists; successful selections publish their authoritative ids here.
struct RuntimeContext {
  String environmentId;
  String projectId;
  String threadId;
  String defaultPrompt;
  String shellCommand;
};

// One page of the selected thread's latest assistant message.
//
// `state` is the turn-completion discriminator and the subtlest thing in this file:
//   waiting    the gateway has no assistant message newer than `after` yet — keep polling
//   streaming  one is arriving — keep polling
//   complete   done
//   empty      the thread has never answered
//   error      set locally; the fetch failed
// Transient read failures stay visibly error and retain retryPending until recovery or close.
struct ThreadResponse {
  String lines[kMaxResponseLines];
  size_t lineCount = 0;
  int page = 0;
  int pageCount = 1;
  String state = "empty";
  String messageId;
  bool retryPending = false; // transient read failure; never implies a command replay
  DeviceControl followUps[kMaxFollowUpActions];
  size_t followUpCount = 0;
};

// What a dispatch actually returned. `commandId` is the identity of the dispatched command, and
// `responseAfter` is what openResponse() must be handed — see GatewayClient::openResponse().
struct DispatchResult {
  bool accepted = false;
  int httpStatus = 0;
  String commandId;
  String status;                 // command.status verbatim: dispatched | completed | approval_required | blocked | failed
  bool requiresApproval = false;
  String responseAfter;
  bool hasScreen = false;
  DisplayModel screen;
  String detail;                 // one line the person at the device can act on
};

// Declared in the heartbeat so the gateway wraps and truncates against what this screen can
// actually render. Sending the wrong numbers does not fail loudly — it just produces text that is
// clipped or a controls list with rows the device drops.
struct GatewayLimits {
  uint8_t menuItems = kMaxDeviceControls;
  uint8_t threadItems = kMaxThreadOptions;
  uint8_t labelCharacters = 18;
  uint32_t mediaUploadBytes = 0;   // 0 omits the field
};
