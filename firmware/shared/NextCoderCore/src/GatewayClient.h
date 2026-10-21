#pragma once

// The device's side of the gateway conversation: authenticate, heartbeat, and — before either of
// those can work — get claimed.
//
// This exists because a device cannot be set up by flashing it. The end user has no toolchain and
// no serial cable. The product flow is:
//
//   factory   flashes an identity (device id + secret) once, from POST /v1/factory/batches
//   device    boots, calls the gateway, and is told 403 because nobody owns it yet
//   device    asks POST /v1/device/setup-code and SHOWS the claim code on its screen
//   owner     types that code into the console
//   device    next heartbeat succeeds, and it belongs to them
//
// Only the first step involves flashing, it happens once per unit at manufacture, and it is the
// same image for every unit — the identity is data in NVS, not code.
//
// Lifted out of the CrowPanel firmware, where all of this lived inside a 3600-line main.cpp and so
// could not be used by any other board.

#include <Arduino.h>

#include "DeviceStore.h"
#include "OperateModel.h"

#ifndef ENABLE_OTA_APPLY
#if SECURE_BUILD_ENABLE_OTA_APPLY
#define ENABLE_OTA_APPLY 1
#else
#define ENABLE_OTA_APPLY 0
#endif
#endif
#ifndef REQUIRE_OTA_SIGNATURE
#if SECURE_BUILD_REQUIRE_OTA_SIGNATURE
#define REQUIRE_OTA_SIGNATURE 1
#else
#define REQUIRE_OTA_SIGNATURE 0
#endif
#endif
#ifndef OTA_MANIFEST_VERIFY_KEY
#ifdef BUILD_OTA_MANIFEST_VERIFY_KEY
#define OTA_MANIFEST_VERIFY_KEY BUILD_OTA_MANIFEST_VERIFY_KEY
#else
#define OTA_MANIFEST_VERIFY_KEY ""
#endif
#endif

enum class GatewayLink : uint8_t {
  NoIdentity,    // never provisioned: terminal, and the owner cannot fix it
  Idle,          // no network yet, or nothing asked since
  Connecting,    // online, first cycle not yet answered
  Unclaimed,     // authenticated, but no owner — claimCode() is what to show
  Claimed,       // owned and talking
  Revoked,       // credential rejected: revoked, or transfer-reset
  Unreachable,   // no gateway answered
};

class GatewayClient {
 public:
  void begin(DeviceStore& store, const String& hardwareModel, const String& firmwareVersion);

  // Run once the Wi-Fi link is up. `justConnected` fires every poll immediately rather than
  // waiting out its timer, which is what makes a fresh join show real state at once instead of up
  // to a minute later.
  //
  // Non-blocking in the sense that matters: at most one HTTP request per call.
  void runCycle(bool justConnected);

  // Runs runCycle() forever on its own FreeRTOS task, so gateway I/O never sits on the render loop.
  //
  // Every call here is a blocking HTTP request with a multi-second timeout. Driven from loop() it
  // froze the animation for 384-1823 ms at a time, measured on hardware — a heartbeat, a config
  // fetch or a display poll each stopping the orb dead. The renderer must never wait on a socket.

  // Holds the authenticated device event stream on its own task. A threads.changed event applies
  // the tiny local list delta immediately and schedules an authoritative refresh; neither the
  // render loop nor the ordinary request scheduler waits on this long-lived connection.
  void eventTaskLoop();

  // OTA is polled by the network task and can be made immediately due by firmware.changed.
  // Automatic/mandatory releases are verified, streamed to the inactive slot, and only confirmed
  // after a healthy gateway heartbeat. Manual releases remain dashboard-visible and untouched.
  void handleOtaBootAttempt();

  // State guard. The network task holds this while it mutates; the UI takes it with a ZERO timeout
  // and simply skips its observation for that frame when the task is mid-request. Reusing the
  // previous frame's values for 30 ms is invisible; blocking the renderer behind a 5-second socket
  // is not.
  bool tryLockState(uint32_t waitMs = 0);
  void lockState();   // waits; for callers that must run, not skip
  void unlockState();

  // Starts the network task. Until this is called stateMutex_ is null, every lock helper is a
  // no-op and the class behaves exactly as it did single-threaded — which is what the boards that
  // still drive runCycle() from their loop rely on.
  void startNetworkTask();

  // One iteration of the network task, taking the lock itself. Public only because the task calls it.
  void networkTick();

  // Set while the microphone is open. The I2S ring holds only tens of milliseconds, and although
  // the cycle no longer runs on the render loop, an upload competing for the radio mid-capture can
  // still cost samples out of the middle of a voice note. The task simply does nothing while this
  // is set; nothing is dropped, because every due-time is a deadline it catches up to afterwards.
  void setNetworkPaused(bool paused) { networkPaused_ = paused; }

  // Latches the just-connected edge for the network task to consume, since the task is not the one
  // watching provisioning.
  void notifyJustConnected() { justConnectedPending_ = true; }

  // Call when the link is NOT up, so the client stops claiming to know anything.
  void goOffline();

  // Marks the just-connected edge for the network task to consume on its next tick.
  GatewayLink link() const { return link_; }
  const String& claimCode() const { return claimCode_; }
  const String& detail() const { return detail_; }

  // True once after the device transitions into Claimed, so the caller can refresh its screen.
  bool consumeJustClaimed();

  // Owner asking for a replacement code ("I lost the card"). Never called on a timer: rotating
  // invalidates the code already printed or displayed.
  void requestNewClaimCode();

  // What this board can do and how much of a payload it can render. Call before begin() runs its
  // first heartbeat; the gateway truncates the controls layout and wraps assistant text against
  // these numbers, so wrong values here show up as clipped labels rather than as an error.
  // Existing display controllers call the two-argument form. It preserves the historical
  // contract: those boards have a rendered display and a thread picker, with microphone/camera
  // availability supplied by their board drivers.
  void setCapabilities(bool microphone, bool camera);

  // Bring-up targets must be able to use the authenticated claim/health path before their panel
  // or input silicon is proven. Advertising display/thread_picker unconditionally made such a
  // target look usable to the gateway and could assign controls it had no way to render or invoke.
  // Keep every capability independently evidence-gated instead.
  void setCapabilities(bool display, bool threadPicker, bool microphone, bool camera);
  void setLimits(const GatewayLimits& limits);

  // ---------------------------------------------------------------------------------------------
  // Operate surface
  //
  // Two kinds of call live below and the difference decides how a UI uses them.
  //
  // POLLED — display, controls, approvals, and an open response page are refreshed by runCycle() on
  // their own timers, one request per call. A UI never asks for these; it renders whatever the
  // accessors hold and repaints when revision() changes.
  //
  // GESTURE — refreshThreads(), selectThread(), the send* / run* calls, fetchResponsePage(), and
  // answerApproval() are driven by a person touching the screen. Each performs exactly one HTTP
  // request and BLOCKS for up to the 5 s timeout while it does: HTTPClient has no async mode, and
  // introducing a worker task here would make every accessor need a lock. The contract inherited
  // from the reference firmware is therefore: paint a pending frame FIRST, then call. On a board
  // running a continuous renderer, expect the animation to stall for the duration.
  //
  // This class is not thread-safe. One caller.
  // ---------------------------------------------------------------------------------------------

  // Bumped on every change to any model below, so a renderer can skip a frame's worth of diffing
  // and repaint only when something actually moved. Replaces the render-signature string the
  // reference firmware recomputed on every pass.
  uint32_t revision() const { return revision_; }

  const RuntimeContext& context() const { return context_; }
  bool hasThread() const { return context_.threadId.length() > 0; }
  const DisplayModel& display() const { return display_; }

  // Saved actions. `controlsAreV2()` is false against a gateway that predates the controls layout,
  // where the rows are legacy menu words carrying no action id.
  size_t controlCount() const { return controlCount_; }
  const DeviceControl* control(size_t index) const;
  uint32_t controlsRevision() const { return controlsRevision_; }
  bool controlsAreV2() const { return controlsV2_; }

  // Threads. Fetching is read-only: nothing here changes execution context until selectThread().
  bool refreshThreads();
  size_t threadCount() const { return threadCount_; }
  const ThreadOption* thread(size_t index) const;
  int selectedThreadIndex() const { return selectedThreadIndex_; }
  String selectedThreadLabel() const;
  bool selectThread(size_t index);

  // Adopts a binding the GATEWAY has already made, without asking it again.
  //
  // POST /v1/device/threads creates a thread and binds the device to it in one call, so by the time
  // the 201 arrives the server-side binding is a fact. context_ is what postIntent() stamps on every
  // outgoing intent, and it otherwise only moves on the 60 s config poll — so without this a voice
  // note recorded in that window would be dispatched with the PREVIOUS thread's id, explicitly, and
  // land in the wrong conversation. That is a correctness bug, not staleness.
  //
  // Deliberately not selectThread(): that one validates an index against a list which cannot yet
  // contain the new thread, and re-fetching to make it valid means guessing how long T3's
  // projection takes to catch up. The caller already holds the authoritative answer.
  void adoptThreadBinding(const String& threadId);
  const String& threadsDetail() const { return threadsDetail_; }

  // Sending. All three shapes go through POST /v1/device/intents with the device envelope; a saved
  // action goes to its own route because its payload stays server-side.
  DispatchResult sendPrompt(const String& text);
  DispatchResult sendAudioPrompt(const String& mediaUploadId, const String& prompt);
  DispatchResult sendShell(const String& command);
  DispatchResult sendStatus();
  DispatchResult sendStop();
  DispatchResult runAction(const String& actionId, const String& mediaUploadId = String());
  DispatchResult runControl(const DeviceControl& control, const String& mediaUploadId = String());

  // v1 macros. Under protocol v2 the macro already appears in the controls layout with its own
  // action id and this list stays empty.
  bool refreshMacros();
  size_t macroCount() const { return macroCount_; }
  const SavedMacro* macro(size_t index) const;
  DispatchResult runMacro(const String& macroId);

  // Response retrieval.
  //
  // openResponse() takes the `responseAfter` a dispatch returned and is the whole reason a fired
  // action does not instantly show the PREVIOUS turn's answer: until an assistant message newer
  // than that timestamp exists the gateway answers `waiting`, and runCycle() keeps polling. Passing
  // an empty string means "show me whatever is there now", which is the correct call for opening
  // the latest response without having sent anything.
  void openResponse(const String& after);
  void closeResponse();
  bool responseOpen() const { return responseOpen_; }
  bool responseInFlight() const;      // state is waiting or streaming: the turn has not finished
  bool fetchResponsePage(int page);
  const ThreadResponse& response() const { return response_; }

  // Media upload. Returns the `media.id` a capture intent needs, or an empty string on failure with
  // the HTTP status in `httpStatusOut` (413 is set locally, without a request, when the decoded
  // size exceeds `mediaUploadBytes`).
  //
  // The bytes are SHA-256 checked and streamed through the gateway's raw upload-session PUT straight
  // out of the caller's buffers — nothing is copied, and the buffers must stay alive for the call.
  // `headerBytes` exists so a WAV header can precede PCM without the recording being memmoved to
  // make room for it; pass nullptr when there is none.
  //
  // The slowest call in this class by a wide margin: a megabyte of media over a domestic uplink
  // gets a 30 s timeout, against 5 s for everything else. Paint before calling, and mean it.
  String uploadMedia(const char* kind, const char* contentType, const char* originalName,
                     const uint8_t* headerBytes, size_t headerLength, const uint8_t* bodyBytes,
                     size_t bodyLength, int& httpStatusOut);

  // Approvals. Refreshed by runCycle() on its own timer, because a command parked awaiting approval
  // stalls the turn silently and nothing else in the protocol announces it.
  size_t approvalCount() const { return approvalCount_; }
  const PendingApproval* approval(size_t index) const;
  bool approvalOverflow() const { return approvalOverflow_; }
  bool refreshApprovals();
  DispatchResult answerApproval(const String& commandId, bool approve);

 private:
  int request(const char* method, const char* path, const String& body, String& response,
              const String* credentialOverride = nullptr, bool trackAuthState = true);
  void sendHeartbeat();
  void observeCredentialRotation(const String& heartbeatPayload);
  bool processPendingDeviceCredential();
  void fetchConfig();
  void fetchSetupCode(bool rotate);

  // Operate internals, in GatewayOperate.cpp.
  bool applyConfigJson(const String& payload);
  void applyDisplayJson(const String& payload);
  bool applyControlsJson(const String& payload);
  void fetchDisplay();
  void fetchControls();
  void acknowledgeControls();
  DispatchResult postIntent(const String& intentJson, const String& label);
  DispatchResult readDispatch(int code, const String& response, const String& label);
  void markOperateDue(uint32_t now);
  void applyThreadChangedEvent(const String& payload);
  void applyRefreshEvent(const String& event, const String& payload);
  void pollFirmwareManifest();
  bool applyFirmwareUpdate(const String& manifestPayload);
  void confirmFirmwareIfPendingVerify();
  void reportFirmwareStatus(const char* state, const char* targetVersion, const char* detail,
                            int progress = -1);
  void touch() { revision_ += 1; }

  DeviceStore* store_ = nullptr;
  String hardwareModel_;
  String firmwareVersion_;

  GatewayLink link_ = GatewayLink::Idle;
  String claimCode_;
  String detail_;
  bool justClaimed_ = false;

  // Separate cadences, following the reference firmware: a heartbeat is cheap and proves liveness,
  // config changes rarely, and a claim code must not be re-requested on a timer at all.
  uint32_t nextHeartbeatAt_ = 0;
  uint32_t nextConfigAt_ = 0;
  uint32_t nextSetupCodeAt_ = 0;
  uint32_t backoffUntil_ = 0;   // honours 429 retry-after
  bool revoked_ = false;
  // RAM-only progress. NVS contains the candidate and its server rotation identity, so rebooting
  // safely repeats the idempotent stage call before attempting acknowledgement.
  String stagedCredentialRotationId_;
  void* stateMutex_ = nullptr;      // SemaphoreHandle_t, kept opaque so the header stays portable

  // Who holds the lock and how deep. A recursive mutex will not tell us either, and request() has
  // to hand the lock back COMPLETELY while it blocks on a socket — giving it back once would leave
  // the renderer waiting on the remaining depth.
  void* lockOwner_ = nullptr;       // TaskHandle_t
  uint32_t lockDepth_ = 0;
  volatile bool justConnectedPending_ = false;
  volatile bool networkPaused_ = false;

  uint32_t releaseStateForBlockingCall();
  void reacquireStateAfterBlockingCall(uint32_t depth);

  bool hasDisplay_ = true;
  bool hasThreadPicker_ = true;
  bool hasMicrophone_ = false;
  bool hasCamera_ = false;
  GatewayLimits limits_;

  uint32_t revision_ = 1;

  RuntimeContext context_;
  DisplayModel display_;

  DeviceControl controls_[kMaxDeviceControls];
  size_t controlCount_ = 0;
  bool controlsV2_ = false;
  uint32_t controlsRevision_ = 0;
  // UINT32_MAX rather than 0 so revision 0 — which the parser rejects anyway — can never read as
  // "already acknowledged".
  uint32_t acknowledgedControlsRevision_ = UINT32_MAX;

  ThreadOption threads_[kMaxThreadOptions];
  size_t threadCount_ = 0;
  int selectedThreadIndex_ = 0;
  String threadsDetail_;
  struct PendingDeviceThreadMutation {
    String threadId;
    String title;
    bool remove = false;
    uint32_t expiresAt = 0;
  };
  static constexpr size_t kMaxPendingThreadMutations = 8;
  PendingDeviceThreadMutation pendingThreadMutations_[kMaxPendingThreadMutations];
  size_t pendingThreadMutationCount_ = 0;

  SavedMacro macros_[kMaxMacros];
  size_t macroCount_ = 0;

  ThreadResponse response_;
  bool responseOpen_ = false;
  String responseAfter_;

  PendingApproval approvals_[kMaxPendingApprovals];
  size_t approvalCount_ = 0;
  bool approvalOverflow_ = false;

  uint32_t nextDisplayAt_ = 0;
  uint32_t nextThreadsAt_ = 0;
  uint32_t nextControlsAt_ = 0;
  uint32_t nextApprovalsAt_ = 0;
  uint32_t nextFirmwareAt_ = 0;
};

const char* gatewayLinkName(GatewayLink link);
