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
#include <stddef.h>
#include <stdint.h>

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
  bool truncated = false; // the gateway capped the reply; the full text remains in the console
  String errorDetail; // read failure, kept separate so the last readable page survives
  bool retryPending = false; // transient read failure; never implies a command replay
  int retryPage = -1; // failed requested page; the readable page index remains unchanged
  DeviceControl followUps[kMaxFollowUpActions];
  size_t followUpCount = 0;
};

// ---------------------------------------------------------------------------------------------
// Incremental response text (GET /v1/device/thread-output `response.stream`)
// ---------------------------------------------------------------------------------------------
//
// The paged `lines` above are unchanged and stay the display authority. This is the additive half:
// the device says which message it holds, how many characters of it, and the fingerprint the
// gateway gave it for exactly that text; the gateway returns only what came after
// (src/deviceThreadOutput.mjs, buildResponseStream).
//
// THE CURSOR IS ONE UNIT: message id, character count, retained text and fingerprint are written
// together by applyResponseStream() and cleared together by ResponseStream::clear(). Nothing else
// mutates any of them, so they cannot drift apart. A device that holds text but cannot echo the
// fingerprint it was given reports hasCursor() == false and refetches from zero; it never sends a
// stale or empty fingerprint, because the fingerprint is what turns "the gateway rewrote what I
// hold" into a `reset` instead of a sentence the agent never wrote.
//
// THE CURSOR COUNTS UTF-16 CODE UNITS, NOT BYTES. The gateway is JavaScript: `offset`, `total` and
// the 512-character chunk bound are all `String.length` / `slice` units. Arduino Strings are UTF-8
// bytes. Counting bytes would drift by one for every accented letter and by three for every emoji,
// after which the next request would splice the wrong suffix onto the text. The scan below counts
// a 4-byte UTF-8 sequence as two units and everything else as one.
//
// A 512-unit chunk can end between the halves of a surrogate pair. ArduinoJson (verified against
// 7.4.2) DROPS an unpaired high surrogate while decoding, so such a chunk simply contributes one
// unit fewer than the gateway sent; the cursor stops before the pair and the next read re-requests
// all of it. That is self-correcting by construction and is why nothing here tries to repair split
// pairs. The unreachable-by-chunking residue is a genuinely unpaired LOW surrogate inside the
// agent's own text, which decodes to a 4-byte sequence and so counts two units against the
// gateway's one; the cost is one skipped character in the retained copy, and the fingerprint
// mismatch it causes on the next read becomes a reset, never a wrong splice.
//
// RETENTION IS A FIXED ARRAY. The display ceiling is DEVICE_RESPONSE_LINES_PER_PAGE (3) *
// DEVICE_RESPONSE_MAX_PAGES (12) * DEVICE_RESPONSE_LINE_LENGTH (31) = 1,116 characters
// (src/deviceThreadOutput.mjs), and this buffer is that many BYTES: exact for ASCII, a shorter
// character count for accented text, never more RAM. Nothing grows and nothing is allocated per
// poll.
//
// PAST THE CEILING THE CURSOR STAYS HONEST. Text that no longer fits is counted and discarded, and
// the cursor advances by exactly what was received. It does NOT skip ahead to the gateway's
// `total`: the fingerprint covers the text the gateway just sent, so a cursor that claimed more
// than that could never match it and every poll would come back as a reset. Each character is still
// downloaded once, never re-downloaded.
constexpr size_t kMaxResponseStreamBytes = 3 * 12 * 31;

// The gateway rejects a `streamOffset` longer than seven digits with 400. A device whose count has
// passed this has no valid cursor (see hasCursor()), so it asks from zero instead of wedging the
// read on a 400 every poll.
constexpr uint32_t kMaxResponseStreamOffset = 9999999;

// The gateway's fingerprint is exactly 16 lowercase hex characters (src/deviceThreadOutput.mjs,
// DEVICE_RESPONSE_STREAM_FINGERPRINT_LENGTH; the test suite asserts this constant equals it). The
// value is still treated as opaque: stored verbatim, echoed, never parsed or checked for shape. The
// constant is a size, not a validator, so a longer value is never truncated (a truncated digest
// could never match): the device keeps the text it got but reports no cursor and refetches. That
// costs bandwidth, not correctness.
constexpr size_t kMaxResponseStreamFingerprintBytes = 16;

// One fetchResponsePage() call may issue this many reads to catch up. From an empty buffer the
// 512-character chunks fill the 1,116-byte buffer in three reads and the fourth is spare. The
// loop cannot spin: an extra read needs the previous block to have made progress, and it stops
// once the buffer is full.
constexpr uint8_t kMaxResponseStreamReads = 4;

// What the gateway said for one read. Pointers belong to the decoded JSON document and are valid
// only for the call that applies them.
struct ResponseStreamBlock {
  bool present = false;           // the response carried a `stream` object at all
  const char* messageId = "";     // "" when the gateway reported null
  uint32_t offset = 0;
  uint32_t total = 0;
  const char* appended = "";
  const char* fingerprint = "";   // "" when the gateway sent none (an older gateway)
  bool complete = false;
  bool reset = false;
};

// The retained text and its cursor. One per GatewayClient, cleared whenever the response model is
// opened or closed, so a different thread, a newer dispatch or a closed screen can never inherit
// another message's prefix.
struct ResponseStream {
  String messageId;                              // the message `text` is a prefix of
  char text[kMaxResponseStreamBytes + 1];        // verbatim UTF-8, always NUL-terminated
  uint16_t textBytes = 0;
  uint32_t consumed = 0;                         // the cursor: UTF-16 units of this message taken
  // Opaque gateway digest of exactly the text this device holds, stored verbatim and echoed back.
  // Never parsed, never computed here.
  char fingerprint[kMaxResponseStreamFingerprintBytes + 1];
  uint8_t fingerprintBytes = 0;
  bool fingerprintSeen = false;                  // the gateway has sent one for this message
  bool truncated = false;                        // text past the buffer was counted and dropped
  bool complete = false;                         // the gateway: every character held AND turn settled

  ResponseStream() { text[0] = '\0'; fingerprint[0] = '\0'; }
  void clear() {
    messageId = "";
    text[0] = '\0';
    textBytes = 0;
    consumed = 0;
    fingerprint[0] = '\0';
    fingerprintBytes = 0;
    fingerprintSeen = false;
    truncated = false;
    complete = false;
  }
  // Only a device that already holds something for a message may name it in a request. If the
  // gateway has been giving this message fingerprints, the cursor additionally requires the one it
  // gave last: text without it is not a cursor, it is something to refetch.
  bool hasCursor() const {
    return messageId.length() > 0 && consumed > 0 && consumed <= kMaxResponseStreamOffset
      && (!fingerprintSeen || fingerprintBytes > 0);
  }
  bool sendsFingerprint() const { return hasCursor() && fingerprintBytes > 0; }
};

enum class ResponseStreamOutcome : uint8_t {
  Absent,    // no `stream` object (older gateway): retained text dropped, nothing else changes
  Cleared,   // the gateway has no message to describe
  Appended,  // the block extended what was held
  Replaced,  // the block started over: a reset, a different message, or a read sent without a cursor
  Rejected,  // the block did not begin where the cursor was, or dropped a fingerprint it had been
             // giving; retained text dropped
};

struct ResponseStreamUpdate {
  ResponseStreamOutcome outcome = ResponseStreamOutcome::Absent;
  // True only when another immediate read would deliver more text this device wants: the previous
  // block made progress, the gateway still has characters beyond the cursor, and the buffer is not
  // yet full.
  bool more = false;
};

// Lead byte -> sequence length. A stray continuation byte (invalid input) is its own unit.
inline size_t responseStreamSequenceLength(uint8_t lead) {
  if (lead >= 0xF0) return 4;
  if (lead >= 0xE0) return 3;
  if (lead >= 0xC0) return 2;
  return 1;
}

inline void formatResponseStreamOffset(char* out, size_t capacity, uint32_t value) {
  if (!out || capacity == 0) return;
  char reversed[11];
  size_t count = 0;
  do {
    reversed[count++] = static_cast<char>('0' + value % 10);
    value /= 10;
  } while (value > 0 && count < sizeof(reversed));
  size_t written = 0;
  while (count > 0 && written + 1 < capacity) out[written++] = reversed[--count];
  out[written] = '\0';
}

// Apply one gateway block to the retained stream.
//
// THE CORRECTNESS-CRITICAL BRANCH is replacing instead of appending. `reset` means the agent began
// a different message, the text it held was replaced rather than extended (T3 sends absolute text
// for a native v2 message update), or the gateway recomputed the fingerprint of what this device
// claimed to hold and it did not match, i.e. the prefix was rewritten under it. Appending across
// any of those would display a sentence the agent never produced. So the retained text is
// discarded and this block becomes the whole of it. The same happens when the message id differs
// from the one held, whatever `reset` says: the id is the identity, the flag is the gateway's
// opinion of it.
//
// A block that is neither a replacement nor begins exactly at the cursor cannot be spliced onto
// anything, so it is rejected: the text is dropped, the cursor goes back to zero, and the next
// read starts clean. Dropping is always safe here; splicing never is.
//
// A read sent WITHOUT a cursor (nothing held, or hasCursor() false) is answered from offset zero
// without `reset`, because the gateway had nothing to reset. That is a fresh start, so whatever is
// retained is discarded first rather than mistaken for a cursor mismatch.
inline ResponseStreamUpdate applyResponseStream(ResponseStream& stream, const ResponseStreamBlock& block) {
  ResponseStreamUpdate update;
  if (!block.present) {
    stream.clear();
    update.outcome = ResponseStreamOutcome::Absent;
    return update;
  }
  const char* id = block.messageId ? block.messageId : "";
  if (id[0] == '\0') {
    stream.clear();
    update.outcome = ResponseStreamOutcome::Cleared;
    return update;
  }

  // The request that produced this block carried a cursor only if hasCursor() was true when it was
  // built, and nothing changes the stream between building it and applying its answer.
  if (!stream.hasCursor()) stream.clear();

  const bool sameMessage = stream.messageId.length() > 0 && stream.messageId == id;
  const bool replace = block.reset || !sameMessage;
  const bool hadFingerprint = stream.fingerprintBytes > 0;
  if (replace) {
    stream.clear();
    stream.messageId = id;
  }
  if (block.offset != stream.consumed) {
    stream.clear();
    update.outcome = ResponseStreamOutcome::Rejected;
    return update;
  }

  const char* fingerprint = block.fingerprint ? block.fingerprint : "";
  size_t fingerprintLength = 0;
  while (fingerprint[fingerprintLength] != '\0' && fingerprintLength <= kMaxResponseStreamFingerprintBytes) ++fingerprintLength;
  // A gateway that was fingerprinting this message and stops has either been downgraded under us
  // or is answering a cursor it did not verify. Either way nothing it says about the text can be
  // trusted to extend it.
  if (!replace && hadFingerprint && fingerprintLength == 0) {
    stream.clear();
    update.outcome = ResponseStreamOutcome::Rejected;
    return update;
  }

  const char* cursor = block.appended ? block.appended : "";
  uint32_t units = 0;
  while (*cursor) {
    const uint8_t lead = static_cast<uint8_t>(*cursor);
    const size_t declared = responseStreamSequenceLength(lead);
    size_t length = 1;
    while (length < declared && (static_cast<uint8_t>(cursor[length]) & 0xC0) == 0x80) ++length;
    units += (declared == 4 && length == 4) ? 2 : 1;
    // Keep whole sequences only, so the buffer never ends mid-character.
    if (!stream.truncated) {
      if (stream.textBytes + length <= kMaxResponseStreamBytes) {
        for (size_t i = 0; i < length; ++i) stream.text[stream.textBytes + i] = cursor[i];
        stream.textBytes = static_cast<uint16_t>(stream.textBytes + length);
      } else {
        stream.truncated = true;
      }
    }
    cursor += length;
  }
  stream.text[stream.textBytes] = '\0';

  // Saturate one past the largest cursor the gateway accepts, so an over-long count reads as "no
  // valid cursor" instead of silently wrapping or being clamped to a number that is merely wrong.
  const uint64_t advanced = static_cast<uint64_t>(stream.consumed) + units;
  stream.consumed = advanced > kMaxResponseStreamOffset ? kMaxResponseStreamOffset + 1 : static_cast<uint32_t>(advanced);

  // The digest belongs to the text as it stands after THIS block, so it replaces the previous one
  // in the same step that moved the text and the count.
  stream.fingerprintSeen = fingerprintLength > 0;
  if (fingerprintLength > 0 && fingerprintLength <= kMaxResponseStreamFingerprintBytes) {
    for (size_t i = 0; i < fingerprintLength; ++i) stream.fingerprint[i] = fingerprint[i];
    stream.fingerprint[fingerprintLength] = '\0';
    stream.fingerprintBytes = static_cast<uint8_t>(fingerprintLength);
  } else {
    // Absent (older gateway: unverified, as before) or too long to hold (seen but unusable, so
    // hasCursor() is false and the next read refetches).
    stream.fingerprint[0] = '\0';
    stream.fingerprintBytes = 0;
  }
  stream.complete = block.complete;

  update.outcome = replace ? ResponseStreamOutcome::Replaced : ResponseStreamOutcome::Appended;
  update.more = units > 0 && !stream.truncated && block.total > stream.consumed && stream.hasCursor();
  return update;
}

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
