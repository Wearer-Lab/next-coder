#pragma once

// The touch UI.
//
// Split out of main.cpp because main.cpp is the board — boot, pins, radios, buttons — and this is
// the product. The division is worth stating: nothing in here knows a pin number, and nothing in
// main.cpp knows what a thread is.
//
// The screens exist because a controller that can only say "Ready" is an ornament. In order of how
// a person uses one: HOME (what is happening), THREADS (where work goes), SEND (make a request),
// RESPONSE (read the answer), APPROVALS (unblock a command policy parked), and — above THREADS —
// ENVIRONMENTS and PROJECTS, which are the two levels of "where" the gateway grew device-facing
// endpoints for.
//
// There is no tab bar. Navigation is a status drawer pulled down from the header and a contextual
// action bar that exists only while there is something to press; the bottom of the screen belongs
// to the content the rest of the time.

#include <Arduino.h>

#include <DeviceStore.h>
#include <GatewayClient.h>
#include <Provisioning.h>

#include "touch.h"

// Must be called after displayBegin() and displayBeginCanvases(). Returns false when the orbs could
// not be allocated, in which case the UI still runs — it simply has no animation.
bool uiBegin(GatewayClient& gateway, Provisioning& provisioning, DeviceStore& store);

// One touch event from touchPoll(). Gateway operations enter a single bounded worker;
// duplicate gestures cannot enqueue mutations while that operation is in flight.
void uiHandleTouch(const TouchEvent& event);

// Call every loop pass. Owns the frame budget: it paces itself internally and returns immediately
// when the next frame is not yet due.
void uiTick();

// Sleeps until the next frame is actually due, rather than having the caller spin on delay(1).
void uiSleepUntilNextFrame();

#if BENCH_SELFTEST
// Bench only, compiled out of every product build. Navigation is a shortcut so the harness is
// deterministic; the action itself is dispatched through the ordinary runAction() path, because
// the create -> splice -> adopt sequence is the thing under test and a harness that reimplements
// it proves nothing.
void uiBenchGoToThreads();
bool uiBenchRunAction(const char* label);
bool uiBenchCaptureState(bool& audioReady, bool& threadReady, DeviceBlockerKind& blocker);
const char* uiBenchBoundThreadTitle();
int uiBenchThreadRowCount();
const char* uiBenchScreenName();
bool uiBenchRecording();
bool uiBenchNetworkBusy();
void uiBenchMicRect(int16_t* x, int16_t* y, int16_t* w, int16_t* h);
void uiBenchHoldGlass(bool held);
int uiBenchCreateStatus();
const char* uiBenchCreateDetail();
int uiBenchRebindFirstProject();
#endif
