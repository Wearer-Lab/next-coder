#include "audio.h"

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

#if ENABLE_AUDIO_CAPTURE

#include <Wire.h>
#include <atomic>
#include <math.h>

#include "driver/i2s_std.h"
#include "es8311.h"

#include "audio_bus.h"
#include <PcmCaptureStats.h>

// Play each recording back through the speaker. Useful on the bench to prove the whole chain in
// one press; turn it off once the microphone is trusted, because a speaker next to a microphone is
// a feedback loop waiting for a reason. Off by default now that clips are uploaded rather than
// merely measured — playing back every voice note into the room is not a product behaviour.
#ifndef AUDIO_SELFTEST_PLAYBACK
#define AUDIO_SELFTEST_PLAYBACK 0
#endif

// Record a short clip at boot and report what the microphone actually produced.
#ifndef AUDIO_BOOT_SELFTEST_MS
#define AUDIO_BOOT_SELFTEST_MS 2000
#endif

namespace audio {
namespace {

i2s_chan_handle_t txHandle = nullptr;
i2s_chan_handle_t rxHandle = nullptr;

int16_t* clipBuffer = nullptr;      // mono 16-bit PCM, PSRAM
size_t clipSamples = 0;             // valid samples in clipBuffer
size_t clipCapacity = 0;            // in samples, not bytes
bool audioReady = false;
bool active = false;
bool captureFault = false;
uint32_t startedAt = 0;

// Arbitration state, shared with the speaker task on the other core. Atomic rather than plain
// bool: the speaker task polls these between DMA writes, and a torn or cached read is exactly the
// case where a cue leaks into a voice note. See audio_bus.h for the rule these implement.
std::atomic<bool> captureFlag{false};
std::atomic<uint32_t> captureGen{0};
std::atomic<bool> paOn{false};
portMUX_TYPE paMux = portMUX_INITIALIZER_UNLOCKED;
size_t settleSamples = 0;
media::PcmCaptureStats captureStats;

constexpr size_t kFrameSamples = 256;   // per i2s_channel_read, per channel

bool i2sInit() {
  i2s_chan_config_t chanCfg =
      I2S_CHANNEL_DEFAULT_CONFIG((i2s_port_t)AUDIO_I2S_PORT, I2S_ROLE_MASTER);
  chanCfg.auto_clear = true;
  if (i2s_new_channel(&chanCfg, &txHandle, &rxHandle) != ESP_OK) return false;

  i2s_std_config_t stdCfg = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(AUDIO_SAMPLE_RATE_HZ),
      // Stereo slots: the microphone is mono, but the codec clocks out two channels either way.
      // The capture path keeps the left one.
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
      .gpio_cfg = {
          .mclk = (gpio_num_t)AUDIO_I2S_MCLK_PIN,
          .bclk = (gpio_num_t)AUDIO_I2S_BCLK_PIN,
          .ws   = (gpio_num_t)AUDIO_I2S_WS_PIN,
          .dout = (gpio_num_t)AUDIO_I2S_DOUT_PIN,
          .din  = (gpio_num_t)AUDIO_I2S_DIN_PIN,
          .invert_flags = {
              .mclk_inv = false,
              .bclk_inv = false,
              .ws_inv = false,
          },
      },
  };
  // The ES8311 driver configures itself for a 384x MCLK. The I2S side has to agree, or the codec
  // returns silence with no error reported anywhere.
  stdCfg.clk_cfg.mclk_multiple = I2S_MCLK_MULTIPLE_384;

  if (i2s_channel_init_std_mode(txHandle, &stdCfg) != ESP_OK) return false;
  if (i2s_channel_init_std_mode(rxHandle, &stdCfg) != ESP_OK) return false;
  if (i2s_channel_enable(txHandle) != ESP_OK) return false;
  if (i2s_channel_enable(rxHandle) != ESP_OK) return false;
  return true;
}

}  // namespace

// The audio::bus surface, declared in audio_bus.h and implemented here because this file is what
// actually owns the I2S channels and the amplifier pin. speaker.cpp borrows them through that
// header and never touches the hardware behind their backs.
namespace bus {

i2s_chan_handle_t txChannel() { return txHandle; }
bool codecReady() { return audioReady; }
bool captureActive() { return captureFlag.load(std::memory_order_acquire); }
uint32_t captureGeneration() { return captureGen.load(std::memory_order_acquire); }
bool paEnabled() { return paOn.load(std::memory_order_acquire); }

void setPaEnabled(bool on) {
  // Refuse to power the amplifier while the microphone is live, whoever asked. This is the
  // backstop for rule 4 in audio_bus.h: the speaker task checks captureActive() itself, but it
  // checks it and then acts, and a recording can start in between.
  // Serialize check + GPIO write. Atomic flags alone leave a race where the speaker checked
  // false, capture cut the amp, then the speaker powered it back on into the microphone.
  portENTER_CRITICAL(&paMux);
  if (on && captureFlag.load(std::memory_order_acquire)) {
    portEXIT_CRITICAL(&paMux);
    return;
  }
  paOn.store(on, std::memory_order_release);
#if AUDIO_PA_ENABLE_ACTIVE_LOW
  digitalWrite(AUDIO_PA_ENABLE_PIN, on ? LOW : HIGH);
#else
  digitalWrite(AUDIO_PA_ENABLE_PIN, on ? HIGH : LOW);
#endif
  portEXIT_CRITICAL(&paMux);
}

void captureBegin() {
  // Order matters. The generation bumps and the flag is raised BEFORE the amplifier is cut and
  // before the first frame is read, so a speaker task that looks at any point from here on sees a
  // reason to stop. Doing it the other way round leaves a window where the amp is already off but
  // the task still believes it may write, which is silent but keeps the DAC busy.
  captureGen.fetch_add(1, std::memory_order_acq_rel);
  captureFlag.store(true, std::memory_order_release);
  setPaEnabled(false);
}

void captureEnd() { captureFlag.store(false, std::memory_order_release); }

}  // namespace bus

namespace {

// Reads one I2S frame and appends the left channel to the clip. Returns false when the clip is
// full, which is one of the three ways recording ends.
enum class CaptureResult { Waiting, Captured, Full, Error };

CaptureResult captureFrame() {
  static int16_t frame[kFrameSamples * 2];  // stereo slots

  size_t bytesRead = 0;
  // Capture shares the UI task. Consume only DMA bytes already available; an empty DMA queue is
  // not the end of a recording and must never freeze touch input for the old 200 ms timeout.
  const esp_err_t result = i2s_channel_read(rxHandle, frame, sizeof(frame), &bytesRead, 0);
  if (bytesRead == 0) return result == ESP_OK || result == ESP_ERR_TIMEOUT
    ? CaptureResult::Waiting : CaptureResult::Error;

  const size_t framesRead = bytesRead / (sizeof(int16_t) * 2);
  for (size_t i = 0; i < framesRead; ++i) {
    if (settleSamples > 0) { settleSamples -= 1; continue; }
    if (clipSamples >= clipCapacity) return CaptureResult::Full;
    int32_t sample = frame[i * 2];  // left channel
#if AUDIO_GAIN_SHIFT
    // Left-shifting a negative signed microphone sample is undefined C++ behavior.
    sample *= (1 << AUDIO_GAIN_SHIFT);
    if (sample > INT16_MAX) sample = INT16_MAX;
    if (sample < INT16_MIN) sample = INT16_MIN;
#endif
    clipBuffer[clipSamples++] = (int16_t)sample;
    captureStats.add(static_cast<int16_t>(sample));
  }
  return CaptureResult::Captured;
}

}  // namespace

bool available() { return audioReady; }
bool recording() { return active; }
bool captureFailed() { return captureFault; }
uint32_t sampleRateHz() { return (uint32_t)AUDIO_SAMPLE_RATE_HZ; }
uint32_t minimumClipMs() { return (uint32_t)AUDIO_CAPTURE_MIN_MS; }
size_t recordedBytes() { return clipSamples * sizeof(int16_t); }
const uint8_t* pcm() { return (const uint8_t*)clipBuffer; }
void discard() {
  // Releasing a note also clears its private PCM, rather than retaining the last capture in PSRAM
  // until another recording happens to overwrite it. The capture buffer is never shared in flight.
  if (clipBuffer && clipSamples > 0) memset(clipBuffer, 0, clipSamples * sizeof(int16_t));
  clipSamples = 0;
  captureStats = media::PcmCaptureStats();
}

uint32_t recordedMs() {
  return (uint32_t)((uint64_t)clipSamples * 1000ULL / (uint64_t)AUDIO_SAMPLE_RATE_HZ);
}

bool begin() {
  pinMode(AUDIO_PA_ENABLE_PIN, OUTPUT);
  bus::setPaEnabled(false);

  if (!i2sInit()) {
    Serial.println("[audio] I2S init failed.");
    return false;
  }
  if (es8311_codec_init() != ESP_OK) {
    Serial.println("[audio] ES8311 init failed — check the codec is at 0x18 on the shared I2C bus.");
    return false;
  }

  // Microphone gain, which es8311_codec_init deliberately leaves at its default (the vendor left
  // the call commented out). A second handle is cheap — it is a struct holding the port and
  // address, and the register write is idempotent — and it keeps lib/ES8311 byte-identical to the
  // vendor drop rather than forking it for one line.
  es8311_handle_t gainHandle = es8311_create((i2c_port_t)I2C_PORT_NUM, ES8311_I2C_ADDR);
  if (gainHandle) {
    if (es8311_microphone_gain_set(gainHandle, AUDIO_MIC_GAIN) != ESP_OK) {
      Serial.println("[audio] Could not set microphone gain; continuing at the default.");
    }
    es8311_delete(gainHandle);
  }

  clipCapacity = AUDIO_CAPTURE_MAX_BYTES / sizeof(int16_t);
  clipBuffer = (int16_t*)ps_malloc(clipCapacity * sizeof(int16_t));
  if (!clipBuffer) {
    // Falling back to internal RAM would succeed for a very short clip and then fail confusingly
    // at a longer one, so refuse instead.
    Serial.println("[audio] Could not allocate the clip buffer in PSRAM.");
    return false;
  }

  Serial.printf("[audio] Ready. %u kHz mono, up to %u ms into %u KB of PSRAM.\n",
                (unsigned)(AUDIO_SAMPLE_RATE_HZ / 1000),
                (unsigned)AUDIO_CAPTURE_MAX_MS,
                (unsigned)(clipCapacity * sizeof(int16_t) / 1024));
  audioReady = true;
  return true;
}

void startRecording() {
  if (!audioReady) return;
  discard();
  captureFault = false;
  // Claim the bus before touching the ADC. This does not wait for the speaker task — see rule 3 in
  // audio_bus.h — it only makes sure that everything the task does from now on is an abort.
  bus::captureBegin();
  clipSamples = 0;
  captureStats = media::PcmCaptureStats();
  // The first frames after the codec starts are unreliable while its ADC settles. Discarding them
  // here rather than after the fact is what stops a voice note beginning with a click.
  for (int i = 0; i < 2; ++i) captureFrame();
  clipSamples = 0;
  captureStats = media::PcmCaptureStats();
  // Drop newly arriving ADC samples as well as old DMA data, without sleeping on the UI task.
  settleSamples = static_cast<size_t>(AUDIO_SAMPLE_RATE_HZ) * 32 / 1000;
  startedAt = millis();
  active = true;
}

void stopRecording() {
  active = false;
  bus::captureEnd();
}

bool pumpRecording() {
  if (!audioReady || !active) return false;
  const CaptureResult captured = captureFrame();
  if (captured == CaptureResult::Waiting) delay(1);
  if (captured == CaptureResult::Full || captured == CaptureResult::Error) {
    captureFault = captured == CaptureResult::Error;
    active = false;
    bus::captureEnd();
    Serial.println(captured == CaptureResult::Full ? "[audio] Clip buffer full." : "[audio] Capture read failed.");
    return false;
  }
  if (millis() - startedAt >= AUDIO_CAPTURE_MAX_MS) {
    active = false;
    bus::captureEnd();
    Serial.println("[audio] Hit the maximum clip length.");
    return false;
  }
  return true;
}

ClipStats measureClip() {
  ClipStats st;
  if (clipSamples == 0) return st;

  st.peak = captureStats.peak;
  st.rms = sqrt(static_cast<double>(captureStats.squares) / captureStats.count);
  st.ms = recordedMs();
  const int64_t mean = captureStats.sum / static_cast<int64_t>(captureStats.count);
  st.dcOffset = static_cast<uint32_t>(mean < 0 ? -mean : mean);
  return st;
}

void printClipVerdict(const ClipStats& st) {
  Serial.printf("[audio] %u ms, %u samples, %u bytes. peak %d, rms %.0f, dc %u",
                (unsigned)st.ms, (unsigned)clipSamples,
                (unsigned)(clipSamples * sizeof(int16_t)), (int)st.peak, st.rms,
                (unsigned)st.dcOffset);
  if (st.peak == 0) {
    Serial.print("  <- SILENT: the codec is not delivering samples");
  } else if (st.peak >= 32700) {
    Serial.print("  <- CLIPPING: lower the mic gain");
  } else if (st.rms < 8.0) {
    Serial.print("  <- VERY QUIET: check mic gain, or the room really is silent");
  }
  Serial.println();
}

void playClip() {
#if AUDIO_SELFTEST_PLAYBACK
  if (!audioReady || clipSamples == 0) return;

  Serial.println("[audio] Playing back through the speaker connector.");
  bus::setPaEnabled(true);

  // The clip is mono but the bus is running stereo slots, so duplicate each sample.
  static int16_t frame[kFrameSamples * 2];
  size_t offset = 0;
  while (offset < clipSamples) {
    const size_t chunk = min(kFrameSamples, clipSamples - offset);
    for (size_t i = 0; i < chunk; ++i) {
      frame[i * 2] = clipBuffer[offset + i];
      frame[i * 2 + 1] = clipBuffer[offset + i];
    }
    size_t written = 0;
    if (i2s_channel_write(txHandle, frame, chunk * 2 * sizeof(int16_t), &written, 1000) != ESP_OK) {
      Serial.println("[audio] Playback write failed.");
      break;
    }
    offset += chunk;
  }

  bus::setPaEnabled(false);
#endif
}

void bootSelfTest() {
#if AUDIO_BOOT_SELFTEST_MS > 0
  if (!audioReady) return;

  Serial.printf("[audio] Self-test: recording %u ms from the on-board microphone...\n",
                (unsigned)AUDIO_BOOT_SELFTEST_MS);
  startRecording();
  const uint32_t began = millis();
  while (millis() - began < AUDIO_BOOT_SELFTEST_MS) {
    if (!pumpRecording()) break;
    delay(1);
  }
  active = false;
  bus::captureEnd();

  const ClipStats st = measureClip();
  printClipVerdict(st);
  if (st.peak > 0 && st.peak < 32700) {
    Serial.println("[audio] Self-test PASSED — the microphone is delivering samples.");
  } else {
    Serial.println("[audio] Self-test FAILED — see the verdict above.");
  }
  discard();
#endif
}

}  // namespace audio

#else  // ENABLE_AUDIO_CAPTURE

// A build without the capture path still answers every question, so the UI can say "this image has
// no microphone" instead of offering a button that does nothing.
namespace audio {

bool available() { return false; }
bool begin() {
  Serial.println("[audio] Disabled. Build -e hosyond-es3c28p-capture to enable the microphone.");
  return false;
}
void startRecording() {}
bool pumpRecording() { return false; }
void stopRecording() {}
bool recording() { return false; }
bool captureFailed() { return false; }
uint32_t recordedMs() { return 0; }
size_t recordedBytes() { return 0; }
const uint8_t* pcm() { return nullptr; }
uint32_t sampleRateHz() { return 0; }
uint32_t minimumClipMs() { return 0; }
void discard() {}
ClipStats measureClip() { return ClipStats(); }
void printClipVerdict(const ClipStats&) {}
void bootSelfTest() {}
void playClip() {}

}  // namespace audio

#endif  // ENABLE_AUDIO_CAPTURE
