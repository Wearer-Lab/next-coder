#pragma once

// What the device last SAW of a thread's reply, kept so reopening one is a repaint, not a wait.
//
// GatewayClient owns exactly one reply model and clears it whenever the thread, the folder or the
// environment moves, because that model is an answer about a conversation and must never be
// reinterpreted against another. That is right for the model and wrong for the screen: tapping a
// thread you looked at a minute ago showed "No response open" for the cost of a full TLS handshake
// and one to four gateway round trips, with the answer's text on the device the whole time.
//
// So the UI keeps its own small, labelled copy and paints it while the real model revalidates:
//
//   * keyed by environment + thread, so a copy is only ever shown for the thread it came from;
//   * a copy of the READABLE text only. Follow-up suggestions are deliberately not kept: a stale
//     suggestion that could be tapped is an action the gateway never offered for this moment;
//   * three threads, oldest out. This is a reading aid, not a cache the protocol depends on;
//   * always shown with its age and a word that says it is being refreshed, never as live truth.
//
// RAM only, never persisted: a reply is user content and the device is not where it is archived.
// The caller drops it all when the gateway realm changes (see ui.cpp, clearHeldReplies()).

#include <Arduino.h>

#include "OperateModel.h"

struct HeldReply {
  bool used = false;
  String environmentId, threadId;
  String lines[kMaxResponseLines];
  size_t lineCount = 0;
  int pageCount = 1;
  String state;
  bool truncated = false;
  String messageId;
  uint32_t seenAt = 0;   // millis() when the device last had this on glass
};

class HeldReplies {
 public:
  static constexpr size_t kSlots = 3;

  // Only a first page with something readable on it. An error or a still-loading model has nothing
  // worth showing, and a later page is not what "open the reply" starts from.
  static bool worthKeeping(const ThreadResponse& reply) {
    if (reply.page != 0 || reply.lineCount == 0) return false;
    if (reply.state == "error" || reply.state == "loading") return false;
    for (size_t i = 0; i < reply.lineCount && i < kMaxResponseLines; ++i) {
      if (reply.lines[i].length() > 0) return true;
    }
    return false;
  }

  // Returns true when a copy was stored or refreshed.
  bool keep(const String& environmentId, const String& threadId, const ThreadResponse& reply,
            uint32_t now) {
    if (environmentId.length() == 0 || threadId.length() == 0 || !worthKeeping(reply)) return false;
    HeldReply* slot = slotFor(environmentId, threadId);
    if (!slot) slot = oldest();
    const bool same = slot->used && slot->environmentId == environmentId
      && slot->threadId == threadId && slot->messageId == reply.messageId
      && slot->state == reply.state && slot->lineCount == reply.lineCount && sameLines(*slot, reply);
    slot->seenAt = now;
    if (same) return true;
    slot->used = true;
    slot->environmentId = environmentId;
    slot->threadId = threadId;
    slot->lineCount = reply.lineCount < kMaxResponseLines ? reply.lineCount : kMaxResponseLines;
    for (size_t i = 0; i < kMaxResponseLines; ++i) {
      slot->lines[i] = i < slot->lineCount ? reply.lines[i] : String();
    }
    slot->pageCount = reply.pageCount;
    slot->state = reply.state;
    slot->truncated = reply.truncated;
    slot->messageId = reply.messageId;
    return true;
  }

  const HeldReply* find(const String& environmentId, const String& threadId) const {
    if (environmentId.length() == 0 || threadId.length() == 0) return nullptr;
    for (const HeldReply& slot : slots_) {
      if (slot.used && slot.environmentId == environmentId && slot.threadId == threadId) return &slot;
    }
    return nullptr;
  }

  void clear() {
    for (HeldReply& slot : slots_) slot = HeldReply();
  }

  // "just now", "4m ago", "2h ago". Coarse on purpose: a panel this small cannot use precision,
  // and a precise number would imply the text was verified at that moment.
  static String ageLabel(uint32_t ageMs) {
    const uint32_t seconds = ageMs / 1000UL;
    if (seconds < 60UL) return String("just now");
    const uint32_t minutes = seconds / 60UL;
    if (minutes < 60UL) return String(static_cast<unsigned>(minutes)) + "m ago";
    const uint32_t hours = minutes / 60UL;
    if (hours < 24UL) return String(static_cast<unsigned>(hours)) + "h ago";
    return String("1d+ ago");
  }

 private:
  HeldReply slots_[kSlots];

  HeldReply* slotFor(const String& environmentId, const String& threadId) {
    for (HeldReply& slot : slots_) {
      if (slot.used && slot.environmentId == environmentId && slot.threadId == threadId) return &slot;
    }
    return nullptr;
  }
  // A free slot if there is one, otherwise the least recently seen. Wrap-safe: ages are compared
  // as signed differences, never as raw millis().
  HeldReply* oldest() {
    HeldReply* pick = &slots_[0];
    for (HeldReply& slot : slots_) {
      if (!slot.used) return &slot;
      if (static_cast<int32_t>(slot.seenAt - pick->seenAt) < 0) pick = &slot;
    }
    return pick;
  }
  static bool sameLines(const HeldReply& held, const ThreadResponse& reply) {
    for (size_t i = 0; i < held.lineCount; ++i) {
      if (held.lines[i] != reply.lines[i]) return false;
    }
    return true;
  }
};
