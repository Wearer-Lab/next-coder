#pragma once

// On-board microphone and speaker, through the single ES8311 mono codec.
//
// Extracted from main.cpp when the screen gained a push-to-talk button. The reason is not tidiness:
// the old capture loop blocked inside `while (digitalRead(BOOT) == LOW)`, which is fine for a
// diagnostic and impossible for a UI — the orb stops, the touch controller is never polled, and the
// finger that is holding the button cannot be seen to lift. Recording is therefore a state the
// caller pumps once per frame rather than a function that returns when the clip is done.
//
// Every entry point is declared unconditionally and compiles to a stub when ENABLE_AUDIO_CAPTURE is
// 0, so the display build has no #if scattered through its UI code and honestly reports that it has
// no microphone.

#include <Arduino.h>

namespace audio {

// True only in a build with the capture path compiled in AND a codec that answered at boot. The UI
// renders its record button disabled when this is false, rather than offering a control that
// silently does nothing.
bool available();

// Brings up I2S and the ES8311. Safe to call once, from setup().
bool begin();

// Push-to-talk. startRecording() discards whatever was held; pump() appends one I2S frame and
// returns false when a ceiling was hit (buffer full or maximum duration), which is the caller's cue
// to stop even though the finger is still down.
void startRecording();
bool pumpRecording();
// Ends the clip without discarding it. The finger lifting is one of three ways a recording ends
// (the others are the duration and buffer ceilings, which pumpRecording() reports itself), and the
// caller has to be able to say so or the codec stays flagged as live forever.
void stopRecording();
bool recording();
// Distinguishes a hardware read failure from a normal duration/buffer limit.
bool captureFailed();

// Valid after the last pump. `bytes` counts 16-bit mono PCM, without a WAV header.
uint32_t recordedMs();
size_t recordedBytes();
const uint8_t* pcm();
uint32_t sampleRateHz();
uint32_t minimumClipMs();
void discard();

// Peak and RMS are what tell you the microphone is alive without needing a speaker: a dead mic
// reads a flat zero, a clipping one pins peak at 32767. Printed after every clip, because a voice
// note that uploads silence is otherwise indistinguishable from a model that ignored it.
struct ClipStats {
  int32_t peak = 0;
  double rms = 0.0;
  uint32_t ms = 0;
  uint32_t dcOffset = 0;   // a stuck codec often reads a constant non-zero value rather than zero
};
ClipStats measureClip();
void printClipVerdict(const ClipStats& stats);

// Bench helpers. The boot self-test is the only microphone diagnostic available on a unit whose
// one button is also the provisioning reset.
void bootSelfTest();
void playClip();

}  // namespace audio
