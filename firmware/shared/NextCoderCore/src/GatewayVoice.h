#pragma once

// The journey of one voice note, from the bytes leaving the board to the words reaching the agent.
//
// The device used to upload a clip and then show nothing at all about what became of it. Everything
// after the POST — the ASR call, the normalisation, the review gate, the dispatch — happens on the
// gateway and takes seconds to a minute, and a controller whose only moving part is an orb has to
// be able to say which of those is going on.
//
// The gateway already publishes exactly that and nothing more: `GET /v1/device/media/jobs/:id`
// returns the six-milestone projection in src/deviceAudio.mjs. Stages, leases, attempt counts,
// provider names and timings are worker bookkeeping that stays on the owner-facing route.
//
// This class exists because `GatewayClient::uploadMedia()` throws away the one identifier the poll
// needs. `POST /v1/device/media` answers `{ media, job }`; that method parses `media.id` and drops
// `job.jobId`, and it may not be edited. So the upload is re-expressed here — reusing
// media::Base64JsonBodyStream verbatim, which is the part that is delicate — and both ids are kept.
//
// Threading: one caller. On the Hosyond board both entry points are reached from inside main.cpp's
// `gateway.tryLockState(50)` frame, so they are serialised against the gateway's own task exactly
// as every other call the UI makes is.

#include <Arduino.h>

#include "DeviceStore.h"

// The six milestones the gateway projects, plus the two the device owns before a job exists and an
// Idle for "no capture in flight". The names are deviceAudio.mjs's, so firmware, console and
// gateway share one vocabulary rather than three near-identical ones.
enum class VoiceStage : uint8_t {
  Idle,
  Recorded,      // device-local: the clip is held, waiting for SEND
  Uploading,     // device-local: bytes are moving, no job to ask about yet
  Transcribing,
  Review,        // a person has to look at a diff. This is a STOP, not progress.
  Ready,
  Sent,
  Failed,
};

const char* voiceStageName(VoiceStage stage);

class GatewayVoice {
 public:
  void begin(DeviceStore& store);

  // POST /v1/device/media. Returns the MEDIA id — what an audio_prompt intent needs — and keeps the
  // JOB id for poll(). Blocks for up to 30 s: a megabyte of base64 over a domestic uplink.
  //
  // `maxRawBytes` is the gateway's declared ceiling; exceeding it is answered locally with 413
  // rather than by spending the upload first. Pass 0 to skip the check.
  String upload(const char* kind, const char* contentType, const char* originalName,
                const uint8_t* headerBytes, size_t headerLength, const uint8_t* bodyBytes,
                size_t bodyLength, uint32_t maxRawBytes, int& httpStatusOut);

  // True while there is a job worth asking about: one exists and it has not reached a terminal
  // milestone.
  bool tracking() const;

  // Paced, with backoff. The caller checks this and then calls poll(), which performs exactly one
  // blocking HTTP request — so it must be called with the screen already showing the current
  // stage, never before painting it.
  bool pollDue(uint32_t now) const;
  bool poll();

  // The two milestones the device owns itself, because at those points the gateway does not yet
  // know the capture exists.
  void setLocalStage(VoiceStage stage);

  // Forget the capture. Called when a new recording starts and when a finished journey has been
  // handed back to the ordinary agent-state display.
  void reset();

  VoiceStage stage() const { return stage_; }
  // One line a person can read: the milestone, or the transcript once there is one, or the error.
  const String& detail() const { return detail_; }
  const String& transcript() const { return transcript_; }
  bool ok() const { return ok_; }

  // Bumped whenever anything above changes, so a renderer repaints on a comparison rather than a
  // diff. Mirrors GatewayClient::revision().
  uint32_t revision() const { return revision_; }

 private:
  void publish(VoiceStage stage, const String& detail);

  DeviceStore* store_ = nullptr;
  String jobId_;
  String transcript_;
  String detail_;
  VoiceStage stage_ = VoiceStage::Idle;
  bool ok_ = true;
  uint32_t revision_ = 1;

  uint32_t nextPollAt_ = 0;
  uint32_t giveUpAt_ = 0;
  uint8_t failures_ = 0;
};
