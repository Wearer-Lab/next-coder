#include "GatewayVoice.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_system.h>

#include "GatewayTls.h"
#include "GatewayHttp.h"
#include "VoicePollSchedule.h"

#include "MediaUpload.h"
#include "OperateModel.h"

namespace {

bool ok2xx(int code) { return code >= 200 && code < 300; }

constexpr uint32_t kPollIntervalMs = 2000;
// Production includes cloud/connector cold starts. This wait is on the network worker, not UI.
constexpr uint16_t kTimeoutMs = 15000;
constexpr uint32_t kGiveUpAfterMs = 10 * 60 * 1000;

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

void GatewayVoice::beginCapture(const String& environmentId, const String& threadId) {
  reset();
  captureEnvironmentId_ = environmentId;
  captureThreadId_ = threadId;
  uint8_t nonce[16];
  esp_fill_random(nonce, sizeof(nonce));
  static const char digits[] = "0123456789abcdef";
  captureRequestId_ = "device-voice:";
  for (uint8_t value : nonce) {
    captureRequestId_ += digits[value >> 4];
    captureRequestId_ += digits[value & 15];
  }
}

void GatewayVoice::publish(VoiceStage stage, const String& detail) {
  if (stage == stage_ && detail == detail_) return;
  stage_ = stage;
  detail_ = detail;
  revision_ += 1;
}

void GatewayVoice::reset() {
  captureEnvironmentId_ = "";
  captureThreadId_ = "";
  captureRequestId_ = "";
  jobId_ = "";
  mediaId_ = "";
  transcript_ = "";
  responseAfter_ = "";
  ok_ = true;
  failures_ = 0;
  nextPollAt_ = 0;
  giveUpAt_ = 0;
  done_ = false;
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
  // Ready may be a transient pre-dispatch projection. Only the gateway done flag
  // can settle it; otherwise a poll racing dispatch would never observe Sent/the reply cursor.
  return !done_ && stage_ != VoiceStage::Sent
    && stage_ != VoiceStage::Failed && stage_ != VoiceStage::Review && stage_ != VoiceStage::Idle;
}

bool GatewayVoice::pollDue(uint32_t now) const {
  if (!tracking()) return false;
  return (int32_t)(now - nextPollAt_) >= 0;
}

String GatewayVoice::upload(const char* kind, const char* contentType, const char* originalName,
                            const uint8_t* headerBytes, size_t headerLength,
                            const uint8_t* bodyBytes, size_t bodyLength, uint32_t maxRawBytes,
                            int& httpStatusOut) {
  httpStatusOut = -1;
  jobId_ = "";
  mediaId_ = "";
  transcript_ = "";
  responseAfter_ = "";
  ok_ = true;
  failures_ = 0;
  done_ = false;
  if (!store_) return String();
  const media::UploadSessionContext context{captureEnvironmentId_, captureThreadId_, captureRequestId_};
  const media::UploadSessionResult result = media::uploadSession(
    *store_, "voice", kind, contentType, originalName, headerBytes, headerLength, bodyBytes,
    bodyLength, maxRawBytes, &uploadBackoffUntil_, &context
  );
  httpStatusOut = result.httpStatus;
  jobId_ = result.jobId;
  mediaId_ = result.mediaId;

  if (jobId_.length() > 0) {
    const uint32_t now = millis();
    nextPollAt_ = now + kPollIntervalMs;
    giveUpAt_ = now + kGiveUpAfterMs;
    // Uploaded, and the gateway has queued the ASR itself. Transcribing is what it is doing now,
    // and it is an observation rather than a guess: the POST answered with the job.
    publish(VoiceStage::Transcribing, String("Transcribing"));
  } else if (mediaId_.length() > 0) {
    done_ = true;
    ok_ = !result.transcriptionUnavailable;
    publish(result.transcriptionUnavailable ? VoiceStage::Failed : VoiceStage::Ready, result.transcriptionUnavailable
      ? String("Transcription unavailable; configure it in the console")
      : String("Uploaded without a voice job; check the console"));
  }
  return result.mediaId;
}

bool GatewayVoice::pollFailure(uint32_t, int code) {
  if (voice_poll::terminalStatus(code)) {
    ok_ = false;
    done_ = true;
    publish(VoiceStage::Failed, String("Voice status unavailable ") + code);
    return true;
  }
  if (failures_ < 5) failures_ += 1;
  nextPollAt_ = millis() + voice_poll::retryDelay(failures_);
  // Keep the same job and resume after Wi-Fi/cloud recovery. Never upload or dispatch again.
  publish(stage_, String("Connection lost; retrying"));
  return true;
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

  const auto settings = store_->transportSnapshot();
  const String base = settings.gatewayUrl;
  if (base.length() == 0 || WiFi.status() != WL_CONNECTED) return pollFailure(now, -1);
  const String url = base + "/v1/device/media/jobs/" + encodePathSegment(jobId_);

  gateway_tls::ScopedLock tlsLock;
  if (!tlsLock.held()) return pollFailure(now, -1);
  gateway_http::YieldingClient<WiFiClientSecure> secure;
  gateway_http::YieldingClient<WiFiClient> plain;
  HTTPClient http;

  http.setTimeout(kTimeoutMs);
  http.setConnectTimeout(kTimeoutMs);

  if (!gateway_tls::beginHttp(http, plain, secure, url, "voice")) return pollFailure(now, -1);

  http.addHeader("x-device-id", settings.deviceId);
  http.addHeader("x-device-secret", settings.deviceSecret);

  int code = http.GET();
  String response;
  if (code > 0) {
    gateway_http::BoundedBody body(response, kMaxResponseBodyBytes);
    if (http.getSize() > static_cast<int>(kMaxResponseBodyBytes)
        || http.writeToStream(&body) < 0 || body.failed()) code = -1;
  }
  http.end();
  if (!ok2xx(code)) return pollFailure(now, code);

  JsonDocument doc;
  if (deserializeJson(doc, response)) return pollFailure(now, -1);
  JsonObject job = doc["job"];
  if (job.isNull()) return pollFailure(now, -1);

  const String milestone = String(job["milestone"] | "");
  VoiceStage next = stage_;
  if (!milestoneToStage(milestone, next)) return pollFailure(now, -1);   // never promote on a word we do not know

  failures_ = 0;
  nextPollAt_ = millis() + kPollIntervalMs;
  done_ = job["done"] | false;
  responseAfter_ = String(job["responseAfter"] | "");
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
      if (!done_) { detail = "Sending to the agent"; break; }
      detail = transcript_.length() > 0 ? transcript_ : String(job["label"] | "Ready in console");
      break;
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
