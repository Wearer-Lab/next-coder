import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const BOARD = "firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src";
const CORE = "firmware/shared/NextCoderCore/src";

async function native(t, code, { arduino = false, defines = [] } = {}) {
  const compiler = process.env.CXX || "c++";
  if (spawnSync(compiler, ["--version"]).error?.code === "ENOENT") return t.skip("Native C++ compiler unavailable");
  const directory = await mkdtemp(join(tmpdir(), "next-coder-tap-queue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A String that behaves like Arduino's for the handful of members the real headers touch.
  await writeFile(join(directory, "Arduino.h"), `#pragma once
#include <string>
#include <cstdint>
#include <cstdlib>
class String : public std::string {
public: using std::string::string; using std::string::operator=;
 String() = default; String(const std::string& v) : std::string(v) {}
 String(unsigned v) : std::string(std::to_string(v)) {}
 String(int v) : std::string(std::to_string(v)) {}
 String(size_t v) : std::string(std::to_string(v)) {}
 String substring(size_t a, size_t b) const { return substr(a, b - a); }
};
inline String operator+(const String& a, const char* b) { return String(std::string(a) + b); }
`);
  await writeFile(join(directory, "check.cpp"), code);
  const executable = join(directory, "check");
  const compiled = spawnSync(compiler, ["-std=c++17", "-pthread", ...defines, "-I", directory, "-I", resolve(BOARD), "-I", resolve(CORE), join(directory, "check.cpp"), "-o", executable], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const checked = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
}

test("actual held-gesture slot is single, latest-wins, single-shot, and refuses anything out of date", async (t) => {
  await native(t, `
#include <cassert>
#include "ui_gesture_queue.h"
int main() {
 PendingGesture slot; PendingGesture out;
 auto same = [](int16_t, int16_t) { return 7u; };
 assert(slot.take(1, 0, same, out) == PendingGesture::Fate::Nothing);
 // Latest wins: a second tap replaces the first, and only one is ever replayed.
 assert(!slot.put(4, 10, 20, 7, 1, 1000)); assert(slot.put(4, 30, 40, 7, 1, 1100) && slot.superseded == 1);
 assert(slot.take(1, 1200, same, out) == PendingGesture::Fate::Replay && out.x == 30 && out.y == 40);
 assert(!slot.valid && slot.take(1, 1200, same, out) == PendingGesture::Fate::Nothing); // single-shot
 // The screen moved on while it waited: not replayed, and the slot is spent either way.
 slot.put(4, 1, 1, 7, 1, 0); assert(slot.take(2, 10, same, out) == PendingGesture::Fate::Stale && !slot.valid);
 // Something else is under the finger now (a row was replaced): not replayed.
 slot.put(4, 1, 1, 7, 1, 0); assert(slot.take(1, 10, [](int16_t, int16_t) { return 8u; }, out) == PendingGesture::Fate::Stale);
 // A swipe has no target and is validated by the navigation epoch alone.
 slot.put(5, 0, 0, 0, 3, 0); assert(slot.take(3, 10, [](int16_t, int16_t) { return 99u; }, out) == PendingGesture::Fate::Replay && out.kind == 5);
 // It expires: exactly at the bound is still fine, one tick past is not; and the clock may wrap.
 slot.put(4, 1, 1, 7, 1, 100); assert(slot.take(1, 100 + PendingGesture::kMaxAgeMs, same, out) == PendingGesture::Fate::Replay);
 slot.put(4, 1, 1, 7, 1, 100); assert(slot.take(1, 101 + PendingGesture::kMaxAgeMs, same, out) == PendingGesture::Fate::Expired);
 slot.put(4, 1, 1, 7, 1, 0xfffffff0u); assert(slot.take(1, 40, same, out) == PendingGesture::Fate::Replay);
 // Cancelling (the person navigated on purpose) removes it without a verdict.
 slot.put(4, 1, 1, 7, 1, 0); slot.cancel(); assert(slot.take(1, 1, same, out) == PendingGesture::Fate::Nothing);
}
`);
});

test("actual UI job slot refuses out loud, holds taps behind a job, and replays them once on the same screen", async (t) => {
  const ui = await readFile(join(BOARD, "ui.cpp"), "utf8");
  const queue = ui.slice(ui.indexOf("bool uiNetworkReady = false;"), ui.indexOf("\nvoid queueResponsePage"));
  const slot = ui.slice(ui.indexOf("bool uiJobBackground = false;"), ui.indexOf("void stepReplyPage(int direction) {"));
  const hold = ui.slice(ui.indexOf("constexpr char kQueuedMessage"), ui.indexOf("// The part of a swipe that is decided"));
  const swipe = ui.slice(ui.indexOf("int swipeDirection("), ui.indexOf("// Runs the held gesture"));
  const drain = ui.slice(ui.indexOf("void drainPendingGesture() {"), ui.indexOf("}  // namespace\n\n// ----", ui.indexOf("void drainPendingGesture() {")));
  assert.ok(hold.includes("void holdTapForJob(") && swipe.includes("void routeSwipe(") && drain.length > 100);
  // holdTapForJob/drain live beside handleBusyLocalTap, which needs the whole UI; only the held-tap
  // functions themselves are compiled here.
  const holdOnly = hold.slice(hold.indexOf("// Holds a tap for the slot."));
  // Compiled with the measurement on AND off: the queue's behaviour must not depend on the
  // [touch-funnel] accounting that sits beside it, and with it on the counters must still be right.
  for (const profile of [0, 1]) await native(t, `
#include <cassert>
#include <atomic>
#include <functional>
#include <cstdint>
#include <Arduino.h>
#include <UiProfile.h>
#include "ui_gesture_queue.h"
struct DispatchResult {}; struct GatewayBrowse {};
enum class TouchGesture : uint8_t { None, Press, Drag, Release, Tap, SwipeLeft, SwipeRight, LongPress };
struct TouchEvent { TouchGesture gesture = TouchGesture::None; int16_t x = 0, y = 0; };
#if HOSYOND_UI_PROFILE
struct TouchFunnel { uint32_t queued = 0, replayed = 0, lost = 0, refused = 0; } touchFunnel;
#define FUNNEL_IS(field, n) assert(touchFunnel.field == (n))
#else
#define FUNNEL_IS(field, n) ((void)0)
#endif
bool chromeDirty = false, contentDirty = false, recordArmed = false, operableNow = true;
String message; uint32_t nowMs = 1000;
bool submitUiJob(std::function<void()> work, std::function<void()> completion, bool background = false);
uint32_t millis() { return nowMs; }
float drawerT = 0; enum class Modal { None }; Modal modal = Modal::None;
bool operable() { return operableNow; }
${queue}
${slot}
struct TouchTargetInfo { uint32_t identity; };
uint32_t identityNow = 9; int taps = 0, swipesForward = 0, builds = 0; int16_t tapX = 0, tapY = 0;
TouchTargetInfo touchTargetAt(int16_t, int16_t) { return {identityNow}; }
void handleTap(int16_t x, int16_t y) { ++taps; tapX = x; tapY = y; }
void buildActions() { ++builds; }
int dragTravel = 0, dragTravelX = 0;
void routeSwipe(int forward) { swipesForward += forward; }
constexpr char kQueuedMessage[] = "Queued; one moment";
${holdOnly}
${drain}
int main() {
 navigationGeneration = 5;
 uiNetworkReady = true;
 // A gesture that finds the slot taken is refused out loud, never swallowed.
 assert(enqueueUiNetworkJob([] {}, [] {})); assert(!uiJobSlotFree());
 assert(!submitUiJob([] {}, [] {})); assert(message == "Busy; tap again" && contentDirty); FUNNEL_IS(refused, 1);
 // A revalidating job leaves the action bar live; any other job locks it.
 uiNetworkLoop(); completeUiNetworkJob(); assert(uiJobSlotFree());
 assert(submitUiJob([] {}, [] {}, true) && uiNetworkBusy() && !uiBarLocked());
 uiNetworkLoop(); completeUiNetworkJob();
 assert(submitUiJob([] {}, [] {}, false) && uiBarLocked());
 // While that job is in flight a tap is held, not dropped; a second tap replaces it; the person is told.
 TouchEvent tap; tap.gesture = TouchGesture::Tap; tap.x = 11; tap.y = 22;
 holdTapForJob(tap); assert(pendingGesture.valid && message == kQueuedMessage); FUNNEL_IS(queued, 1);
 tap.x = 33; holdTapForJob(tap); FUNNEL_IS(queued, 2); FUNNEL_IS(lost, 1);
 // Nothing under the finger: nothing to hold.
 identityNow = 0; pendingGesture.cancel(); holdTapForJob(tap); assert(!pendingGesture.valid); identityNow = 9;
 holdTapForJob(tap);
 // It does not run while the slot is busy ...
 drainPendingGesture(); assert(taps == 0 && pendingGesture.valid);
 // ... and runs exactly once the moment it frees, with the queued note cleared.
 uiNetworkLoop(); completeUiNetworkJob();
 drainPendingGesture(); assert(taps == 1 && tapX == 33 && builds == 1 && message.empty()); FUNNEL_IS(replayed, 1);
 drainPendingGesture(); assert(taps == 1);
 // The screen was navigated by the job's own completion: told, not guessed.
 identityNow = 9; message = ""; tap.x = 5; holdTapForJob(tap); ++navigationGeneration; drainPendingGesture();
 assert(taps == 1 && message == "Screen changed; tap again"); FUNNEL_IS(lost, 2);
 // Something else is under the finger now.
 holdTapForJob(tap); identityNow = 10; drainPendingGesture(); assert(taps == 1 && message == "Screen changed; tap again");
 identityNow = 9;
 // Too old to be what the person still means.
 holdTapForJob(tap); nowMs += PendingGesture::kMaxAgeMs + 1; drainPendingGesture();
 assert(taps == 1 && message == "Timed out; tap again");
 // A swipe is replayed through the same router an immediate one uses.
 TouchEvent left; left.gesture = TouchGesture::SwipeLeft;
 pendingGesture.put(static_cast<uint8_t>(TouchGesture::SwipeLeft), 0, 0, 0, navigationGeneration, nowMs);
 drainPendingGesture(); assert(swipesForward == 1);
 pendingGesture.put(static_cast<uint8_t>(TouchGesture::SwipeRight), 0, 0, 0, navigationGeneration, nowMs);
 drainPendingGesture(); assert(swipesForward == 0);
 // A held tap never fires into a recording.
 recordArmed = true; holdTapForJob(tap); drainPendingGesture(); assert(taps == 1); recordArmed = false;
}
`, { defines: [`-DHOSYOND_UI_PROFILE=${profile}`] });
});

test("actual warm TLS session coordinator yields to every other session owner and to the event stream", async (t) => {
  const source = await readFile(join(CORE, "GatewayTls.h"), "utf8");
  const implementation = source.slice(source.indexOf("inline SemaphoreHandle_t& tlsLock()"), source.indexOf("inline bool isPrivateIpv4Host"));
  await native(t, `
#include <cassert>
#include <atomic>
#include <mutex>
#include <thread>
#include <chrono>
#include <cstdint>
using SemaphoreHandle_t=std::recursive_timed_mutex*;
SemaphoreHandle_t xSemaphoreCreateRecursiveMutex(){return new std::recursive_timed_mutex;}
constexpr int pdTRUE=1;unsigned pdMS_TO_TICKS(unsigned value){return value;}
int xSemaphoreTakeRecursive(SemaphoreHandle_t handle,unsigned ms){return handle->try_lock_for(std::chrono::milliseconds(ms));}
void xSemaphoreGiveRecursive(SemaphoreHandle_t handle){handle->unlock();}
std::atomic<uint32_t> now{100};uint32_t millis(){return now.load();}
namespace gateway_tls {${implementation}}
using namespace gateway_tls;
int drops = 0, sessions = 0; // sessions: how many TLS sessions' buffers are alive
void drop() { assert(sessions == 1); sessions = 0; ++drops; warmSessionOpen() = false; } // the hook runs with the gate held
void openWarm() { warmDropHook() = &drop; sessions = 1; warmSessionOpen() = true; warmLastUsedAt() = now.load(); }
int main() {
 tlsLock();
 // The owner of the warm session keeps it across requests.
 assert(lockTlsKeepWarm(10)); openWarm(); unlockTls();
 assert(lockTlsKeepWarm(10)); assert(sessions == 1 && drops == 0); unlockTls();
 // The event stream does not start while a session is warm, even after its quiet window.
 now += kEventQuietMs + 1;
 {EventSessionLock held; assert(!held.held());}
 // Anyone else about to build a session of their own closes it first, with the gate already held.
 assert(lockTls(10)); assert(drops == 1 && sessions == 0 && !warmSessionOpen()); sessions = 1; sessions = 0; unlockTls();
 // An idle session is reaped, which is what returns the lease; a recently used one is not.
 now += kEventQuietMs + 1;
 assert(lockTlsKeepWarm(10)); openWarm(); unlockTls();
 now += 7999; reapWarmIfIdle(8000); assert(warmSessionOpen() && drops == 1);
 now += 1; reapWarmIfIdle(8000); assert(!warmSessionOpen() && drops == 2);
 now += kEventQuietMs + 1;
 {EventSessionLock resumed; assert(resumed.held());}
 // A busy gate means the session is in use: reaping never waits for it and never announces itself.
 now += kEventQuietMs + 1;
 assert(lockTlsKeepWarm(10)); openWarm(); unlockTls(); now += 100000;
 std::atomic<bool> done{false};
 assert(lockTlsKeepWarm(10));
 std::thread reaper([&]{ reapWarmIfIdle(8000); assert(foregroundWaiters() == 0); done = true; });
 reaper.join(); assert(done && warmSessionOpen() && drops == 2);
 unlockTls();
 reapWarmIfIdle(8000); assert(!warmSessionOpen() && drops == 3);
 // The millis() clock wrapping does not make a fresh session look ancient.
 now = UINT32_MAX - 50; assert(lockTlsKeepWarm(10)); openWarm(); unlockTls();
 now = 100; reapWarmIfIdle(8000); assert(warmSessionOpen());
}
`);
});

test("actual interaction deferral holds polls briefly, is capped, never loses a connect edge and survives clock wrap", async (t) => {
  const source = await readFile(join(CORE, "GatewayClient.cpp"), "utf8");
  const method = source.slice(source.indexOf("bool GatewayClient::deferForTouch() {"), source.indexOf("void GatewayClient::networkTick() {"));
  const notice = source.slice(source.indexOf("void GatewayClient::noteInteraction() {"), source.indexOf("void GatewayClient::wakeNetworkTask() {"));
  // Decided BEFORE the connect edge is consumed, so deferring a tick can never lose it.
  const tick = source.slice(source.indexOf("void GatewayClient::networkTick() {"));
  assert.ok(tick.indexOf("deferForTouch()") > 0 && tick.indexOf("deferForTouch()") < tick.indexOf("justConnectedPending_.exchange(false)"));
  const quiet = source.match(/constexpr uint32_t kInteractionQuietMs = (\d+);/u)[1];
  const cap = source.match(/constexpr uint32_t kTouchDeferralCapMs = (\d+);/u)[1];
  await native(t, `
#include <cassert>
#include <atomic>
#include <cstdint>
uint32_t clockNow = 100; uint32_t millis() { return clockNow; }
constexpr uint32_t kInteractionQuietMs = ${quiet}, kTouchDeferralCapMs = ${cap};
struct GatewayClient {
 std::atomic<bool> interactionArmed_{false}; std::atomic<uint32_t> interactionUntil_{0};
 uint32_t touchDeferralStartedAt_ = 0;
 bool deferForTouch(); void noteInteraction();
};
${notice}
${method}
int main() {
 GatewayClient c;
 // Never touched: never deferred (and an unarmed zero deadline cannot read as "in the future").
 clockNow = 0xF0000000u; assert(!c.deferForTouch()); clockNow = 100;
 c.noteInteraction();
 assert(c.deferForTouch()); clockNow += kInteractionQuietMs - 1; assert(c.deferForTouch());
 clockNow += 1; assert(!c.deferForTouch() && !c.interactionArmed_); // quiet window over
 // Continuous touching postpones polls by at most the cap, then they run despite the touching.
 clockNow = 10000; c.noteInteraction(); assert(c.deferForTouch());
 for (uint32_t t = 0; t < kTouchDeferralCapMs - 500; t += 500) { clockNow += 500; c.noteInteraction(); assert(c.deferForTouch()); }
 clockNow += 500; c.noteInteraction(); assert(!c.deferForTouch());
 clockNow += 600; assert(!c.deferForTouch()); // past the cap: runs despite the touching
 clockNow += kInteractionQuietMs; assert(!c.deferForTouch()); // disarmed; the cap restarts next time
 c.noteInteraction(); assert(c.deferForTouch());
 // Clock wrap mid-window.
 clockNow = UINT32_MAX - 300; c.touchDeferralStartedAt_ = 0; c.noteInteraction(); assert(c.deferForTouch());
 clockNow += 400; assert(c.deferForTouch()); clockNow += 1200; assert(!c.deferForTouch());
}
`);
});

test("actual thread list scope: cleared only when the destination differs, and HOME rows are never another folder's", async (t) => {
  const source = await readFile(join(CORE, "GatewayOperate.cpp"), "utf8");
  const matches = source.slice(source.indexOf("bool GatewayClient::threadListMatches("), source.indexOf("const SavedMacro* GatewayClient::macro("));
  const clear = source.slice(source.indexOf("void GatewayClient::clearContextBinding("), source.indexOf("bool GatewayClient::refreshThreads()"));
  const stamp = source.slice(source.indexOf("  threadsEnvironmentId_ = String(doc[\"environmentId\"]"), source.indexOf("  size_t pendingWrite = 0;"));
  assert.ok(clear.includes("threadListMatches(environmentId, projectId)") && stamp.includes("atomic-v1"));
  await native(t, `
#include <cassert>
#include <map>
#include <Arduino.h>
uint32_t millis() { return 77; }
struct Node { std::map<std::string, Node> f; String v;
 Node& operator[](const char* k) { return f[k]; }
 String operator|(const char*) const { return v; } };
struct ThreadOption { String id; bool selected = false; };
struct RuntimeContext { String environmentId, projectId, threadId; };
struct RemoteBlockers { bool providerUnknown = false, inputUnknown = false; };
struct StateLock { explicit StateLock(void*) {} };
struct GatewayClient {
 RuntimeContext context_; ThreadOption threads_[12]; size_t threadCount_ = 0; int selectedThreadIndex_ = 0;
 String threadsEnvironmentId_, threadsProjectId_; bool threadsScopeKnown_ = false;
 uint32_t contextGeneration_ = 0, nextThreadsAt_ = 0, nextApprovalsAt_ = 0, nextConfigAt_ = 0, nextControlsAt_ = 0;
 RemoteBlockers remoteBlockers_; int closed = 0, touched = 0;
 void closeResponse() { ++closed; } void touch() { ++touched; }
 bool threadListMatches(const String&, const String&) const;
 void clearContextBinding(const String& environmentId = String(), const String& projectId = String());
 void stampFrom(Node& doc) {
${stamp}
 }
};
${matches}
${clear}
Node reply(const char* env, const char* project, const char* contract = "atomic-v1") {
 Node d; d["destinationSelection"].v = contract; d["environmentId"].v = env; d["projectId"].v = project; return d;
}
int main() {
 GatewayClient c;
 // Stamped by the gateway under the atomic-v1 contract: the list is vouched for that destination only.
 auto good = reply("envA", "folderA"); c.stampFrom(good);
 assert(c.threadListMatches("envA", "folderA"));
 assert(!c.threadListMatches("envA", "folderB") && !c.threadListMatches("envB", "folderA") && !c.threadListMatches("", ""));
 // A gateway without the stamp can never vouch for a list.
 auto old = reply("envA", "folderA", ""); c.stampFrom(old); assert(!c.threadListMatches("envA", "folderA"));
 c.stampFrom(good);
 c.threadCount_ = 3; c.threads_[0].id = "a"; c.threads_[1].id = "b"; c.threads_[1].selected = true; c.threads_[2].id = "c";
 c.context_ = {"envA", "folderA", "b"};
 // Binding another thread in the SAME folder keeps the rows (HOME stays populated) but un-selects
 // them: with no thread bound yet, no row may claim to be it.
 c.clearContextBinding("envA", "folderA");
 assert(c.threadCount_ == 3 && c.threadsScopeKnown_ && !c.threads_[1].selected && c.selectedThreadIndex_ == -1);
 assert(c.context_.threadId.empty() && c.closed == 1 && c.contextGeneration_ == 1);
 // Another folder: those rows are somebody else's threads. Emptied, scope forgotten, refetch due now.
 c.nextThreadsAt_ = 0; c.clearContextBinding("envA", "folderB");
 assert(c.threadCount_ == 0 && !c.threadsScopeKnown_ && c.nextThreadsAt_ == 77 && c.context_.projectId == "folderB");
 // Another environment likewise.
 c.stampFrom(good); c.threadCount_ = 2; c.clearContextBinding("envB", "folderA"); assert(c.threadCount_ == 0);
}
`);
});

test("actual preview seeding paints held rows, and a failed revalidation does not close the commit gate", async (t) => {
  const header = await readFile(join(CORE, "GatewayBrowse.h"), "utf8");
  const seed = header.slice(header.indexOf("  template <typename RowAt>"), header.indexOf("  bool previewEnvironment(size_t index);"));
  const source = await readFile(join(CORE, "GatewayBrowse.cpp"), "utf8");
  const start = source.indexOf("bool GatewayBrowse::refreshPreviewThreads() {");
  const refresh = source.slice(source.indexOf("{\n", start) + 2, source.indexOf("  if (String(doc[\"destinationSelection\"]", start));
  assert.ok(seed.includes("seedPreviewThreads") && refresh.includes("wasReady"));
  await native(t, `
#include <cassert>
#include <Arduino.h>
constexpr size_t kMaxThreadOptions = 12;
struct ThreadOption { String id, title; bool selected = false; };
String encodePathSegment(const String& s) { return s; }
String remedyFor(int c) { return c <= 0 ? "No response" : "HTTP"; }
bool ok(int c) { return c >= 200 && c < 300; }
int nextCode = 200; String nextBody = "{}"; bool parses = true;
struct Doc {};
bool deserializeJson(Doc&, const String&) { return !parses; }
using JsonDocument = Doc;
struct GatewayBrowse {
 bool previewContractReady_ = false; String previewEnvironmentId_ = "envA", previewProjectId_ = "folderA", previewDetail_;
 ThreadOption previewThreads_[kMaxThreadOptions]; size_t previewThreadCount_ = 0; int touches = 0;
 void touch() { ++touches; }
 int request(const char*, const char*, const String&, String& r) { r = nextBody; return nextCode; }
${seed}
 bool refresh() {
${refresh}
  return true; }
};
int main() {
 GatewayBrowse b;
 ThreadOption held[14]; for (int i = 0; i < 14; ++i) { held[i].id = "t" + std::to_string(i); held[i].title = "T"; }
 held[3].id = ""; // a row with no id is not a destination
 b.seedPreviewThreads(14, [&](size_t i) { return i < 14 ? &held[i] : nullptr; });
 assert(b.previewThreadCount_ == 12 && b.previewThreads_[3].id == "t4"); // bounded to the cap; the id-less row is skipped
 assert(b.previewContractReady_ && b.previewDetail_.empty());
 // Seeding with nothing held says so, and is still a valid (empty) destination list.
 b.seedPreviewThreads(0, [](size_t) -> const ThreadOption* { return nullptr; });
 assert(b.previewThreadCount_ == 0 && b.previewContractReady_ && b.previewDetail_ == "No threads; create one below");
 // A revalidation that never reached the gateway keeps the held list committable ...
 b.seedPreviewThreads(2, [&](size_t i) { return &held[i]; });
 nextCode = -1; assert(!b.refresh()); assert(b.previewContractReady_ && b.previewThreadCount_ == 2);
 nextCode = 200; parses = false; assert(!b.refresh()); assert(b.previewContractReady_ && b.previewDetail_ == "Bad thread JSON");
 // ... but a list that was never proven stays uncommittable when its first fetch fails.
 b.previewContractReady_ = false; nextCode = -1; assert(!b.refresh()); assert(!b.previewContractReady_);
}
`);
});

test("actual held reply copies are keyed per thread, bounded, text-only, and aged coarsely", async (t) => {
  await native(t, `
#include <cassert>
#include "ui_held_reply.h"
ThreadResponse reply(const char* text, const char* state = "complete", const char* id = "m1") {
 ThreadResponse r; r.lines[0] = text; r.lineCount = 3; r.state = state; r.messageId = id; r.pageCount = 2;
 r.followUpCount = 1; r.followUps[0].id = "suggestion"; return r;
}
int main() {
 HeldReplies held;
 // Only a readable first page is worth keeping.
 assert(!held.keep("e", "t1", reply(""), 10));
 assert(!held.keep("e", "t1", reply("x", "error"), 10) && !held.keep("e", "t1", reply("x", "loading"), 10));
 ThreadResponse later = reply("page two"); later.page = 1; assert(!held.keep("e", "t1", later, 10));
 assert(!held.keep("", "t1", reply("x"), 10) && !held.keep("e", "", reply("x"), 10));
 assert(held.keep("e", "t1", reply("first"), 100));
 const HeldReply* a = held.find("e", "t1");
 assert(a && a->lines[0] == "first" && a->pageCount == 2 && a->seenAt == 100);
 // Never the thread it did not come from, and never a follow-up suggestion.
 assert(!held.find("e", "t2") && !held.find("other", "t1"));
 // Seeing the same text again only refreshes when it was seen.
 assert(held.keep("e", "t1", reply("first"), 500)); assert(held.find("e", "t1")->seenAt == 500);
 // Three threads, least recently seen out.
 assert(held.keep("e", "t2", reply("two"), 600)); assert(held.keep("e", "t3", reply("three"), 700));
 assert(held.keep("e", "t1", reply("first"), 800));
 assert(held.keep("e", "t4", reply("four"), 900));
 assert(!held.find("e", "t2") && held.find("e", "t1") && held.find("e", "t3") && held.find("e", "t4"));
 // Revisiting replaces the text for that thread rather than adding a copy.
 assert(held.keep("e", "t1", reply("newer", "complete", "m2"), 1000)); assert(held.find("e", "t1")->lines[0] == "newer");
 held.clear(); assert(!held.find("e", "t1") && !held.find("e", "t4"));
 assert(HeldReplies::ageLabel(0) == "just now" && HeldReplies::ageLabel(59999) == "just now");
 assert(HeldReplies::ageLabel(60000) == "1m ago" && HeldReplies::ageLabel(59 * 60000u) == "59m ago");
 assert(HeldReplies::ageLabel(3600000u) == "1h ago" && HeldReplies::ageLabel(24u * 3600000u) == "1d+ ago");
}
`);
});
