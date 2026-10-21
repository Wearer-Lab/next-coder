#include "GatewayVoice.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "GatewayTls.h"

#include "MediaUpload.h"
#include "OperateModel.h"

namespace {

bool ok2xx(int code) { return code >= 200 && code < 300; }

// A finished job is asked about roughly once a second. Transcription of a short clip takes a few
// seconds on a GPU and minutes on the CPU default, so this is a cadence that shows movement without
// spending the device's read budget: 60 requests a minute against a device-read limit of 120.
constexpr uint32_t kPollIntervalMs = 1000;

// Each blocking poll costs the render loop one frame, so the timeout is the shortest that a local
// gateway comfortably answers within rather than the 2 s the browse calls get. A poll that times
// out is not worth a second of frozen animation.
constexpr uint16_t kTimeoutMs = 800;

// Consecutive failures back off hard and then give up, because the alternative is a board that
// freezes for the timeout once a second forever against a gateway that has gone away.
constexpr uint8_t kMaxFailures = 4;

// Nothing in this pipeline legitimately takes longer than this. A job still unresolved afterwards
// is one the owner has to look at in the console, and the device stops asking.
constexpr uint32_t kGiveUpAfterMs = 180000;

// Percent-encoding for a path segment: a job id is generated and safe, but it lands in a URL and
// assuming that is how a 404 becomes unexplainable.
String encodePathSegment(const String& value) {
  static const char* digits = "0123456789ABCDEF";
  String encoded;
  encoded.reserve(value.length());
  for (size_t i = 0; i < value.length(); i += 1) {
    const uint8_t c = static_cast<uint8_t>(value[i]);
    const bool safe = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
      || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~';
    if (safe) {
      encoded += static_cast<char>(c);
    } else {
      encoded += '%';
      encoded += digits[(c >> 4) & 0x0F];
      encoded += digits[c & 0x0F];
    }
  }
  return encoded;
}

// The gateway's own milestone words, mapped onto the enum. An unknown word is NOT optimistically
// promoted: it stays wherever the device already was, because claiming a stage that was never
// observed is the one thing this class must not do.
bool milestoneToStage(const String& milestone, VoiceStage& out) {
  if (milestone == "transcribing") { out = VoiceStage::Transcribing; return true; }
  if (milestone == "review")       { out = VoiceStage::Review; return true; }
  if (milestone == "ready")        { out = VoiceStage::Ready; return true; }
  if (milestone == "sent")         { out = VoiceStage::Sent; return true; }
  if (milestone == "failed")       { out = VoiceStage::Failed; return true; }
  if (milestone == "recorded")     { out = VoiceStage::Recorded; return true; }
  if (milestone == "uploading")    { out = VoiceStage::Uploading; return true; }
  return false;
}

}  // namespace

const char* voiceStageName(VoiceStage stage) {
  switch (stage) {
    case VoiceStage::Recorded:     return "recorded";
    case VoiceStage::Uploading:    return "uploading";
    case VoiceStage::Transcribing: return "transcribing";
    case VoiceStage::Review:       return "review";
    case VoiceStage::Ready:        return "ready";
    case VoiceStage::Sent:         return "sent";
    case VoiceStage::Failed:       return "failed";
    default:                       return "idle";
  }
}

void GatewayVoice::begin(DeviceStore& store) { store_ = &store; }

void GatewayVoice::publish(VoiceStage stage, const String& detail) {
  if (stage == stage_ && detail == detail_) return;
  stage_ = stage;
  detail_ = detail;
  revision_ += 1;
}

void GatewayVoice::reset() {
  jobId_ = "";
  transcript_ = "";
  ok_ = true;
  failures_ = 0;
  nextPollAt_ = 0;
  giveUpAt_ = 0;
  publish(VoiceStage::Idle, String());
}

void GatewayVoice::setLocalStage(VoiceStage stage) {
  switch (stage) {
    case VoiceStage::Recorded:  publish(stage, String("Ready to send")); return;
    case VoiceStage::Uploading: publish(stage, String("Sending the recording")); return;
    default:                    publish(stage, String()); return;
  }
}

bool GatewayVoice::tracking() const {
  if (jobId_.length() == 0) return false;
  return stage_ != VoiceStage::Ready && stage_ != VoiceStage::Sent
    && stage_ != VoiceStage::Failed && stage_ != VoiceStage::Idle;
}

bool GatewayVoice::pollDue(uint32_t now) const {
  if (!tracking()) return false;
  if (failures_ >= kMaxFailures) return false;
  return (int32_t)(now - nextPollAt_) >= 0;
}

String GatewayVoice::upload(const char* kind, const char* contentType, const char* originalName,
                            const uint8_t* headerBytes, size_t headerLength,
                            const uint8_t* bodyBytes, size_t bodyLength, uint32_t maxRawBytes,
                            int& httpStatusOut) {
  httpStatusOut = -1;
  jobId_ = "";
  transcript_ = "";
  ok_ = true;
  failures_ = 0;
  if (!store_) return String();
  const media::UploadSessionResult result = media::uploadSession(
    *store_, "voice", kind, contentType, originalName, headerBytes, headerLength, bodyBytes,
    bodyLength, maxRawBytes
  );
  httpStatusOut = result.httpStatus;
  jobId_ = result.jobId;

  if (jobId_.length() > 0) {
    const uint32_t now = millis();
    nextPollAt_ = now + kPollIntervalMs;
    giveUpAt_ = now + kGiveUpAfterMs;
    // Uploaded, and the gateway has queued the ASR itself. Transcribing is what it is doing now,
    // and it is an observation rather than a guess: the POST answered with the job.
    publish(VoiceStage::Transcribing, String("Transcribing"));
  }
  return result.mediaId;
}

bool GatewayVoice::poll() {
  if (!tracking() || !store_) return false;
  const uint32_t now = millis();
  nextPollAt_ = now + kPollIntervalMs;

  if (giveUpAt_ != 0 && (int32_t)(now - giveUpAt_) >= 0) {
    ok_ = false;
    publish(VoiceStage::Failed, String("Timed out; see the console"));
    return true;
  }

  const String base = store_->gatewayUrl();
  if (base.length() == 0 || WiFi.status() != WL_CONNECTED) return false;
  const String url = base + "/v1/device/media/jobs/" + encodePathSegment(jobId_);

  WiFiClientSecure secure;
  WiFiClient plain;
  HTTPClient http;

  http.setTimeout(kTimeoutMs);
  http.setConnectTimeout(kTimeoutMs);

  if (!gateway_tls::beginHttp(http, plain, secure, url, "voice")) return false;

  http.addHeader("x-device-id", store_->deviceId());
  http.addHeader("x-device-secret", store_->deviceSecret());

  const int code = http.GET();
  String response;
  if (code > 0) {
    const int length = http.getSize();
    if (length > (int)kMaxResponseBodyBytes) response = "";
    else response = http.getString();
  }
  http.end();

  if (!ok2xx(code)) {
    failures_ += 1;
    // Back off hard rather than freezing the renderer for the timeout once a second.
    nextPollAt_ = now + (uint32_t)(kPollIntervalMs * (1u << failures_));
    if (failures_ >= kMaxFailures) {
      ok_ = false;
      publish(VoiceStage::Failed,
              code > 0 ? String("Status unavailable ") + code : String("No answer"));
      return true;
    }
    // Not a stage change: the device simply did not observe anything this tick, and holding the
    // last known milestone is the whole point.
    return false;
  }
  failures_ = 0;

  JsonDocument doc;
  if (deserializeJson(doc, response)) return false;
  JsonObject job = doc["job"];
  if (job.isNull()) return false;

  const String milestone = String(job["milestone"] | "");
  VoiceStage next = stage_;
  if (!milestoneToStage(milestone, next)) return false;   // never promote on a word we do not know

  const char* transcript = job["transcript"] | "";
  if (strlen(transcript) > 0) transcript_ = transcript;
  const char* error = job["error"] | "";
  ok_ = job["ok"] | true;

  String detail;
  switch (next) {
    case VoiceStage::Transcribing:
      detail = "Transcribing";
      break;
    case VoiceStage::Review:
      // The normaliser changed something a person has to see. This is a stop, and the wording has
      // to say so rather than sounding like one more stage of progress.
      detail = "Check the wording in the console";
      break;
    case VoiceStage::Ready:
    case VoiceStage::Sent:
      detail = transcript_.length() > 0 ? transcript_ : String(job["label"] | "Sent");
      break;
    default:
      detail = strlen(error) > 0 ? String(error) : String("Voice note failed");
      ok_ = false;
      break;
  }
  publish(next, detail);
  return true;
}
