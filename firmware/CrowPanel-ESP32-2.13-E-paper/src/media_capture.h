#pragma once

// Optional hardware capture for the Next Coder controller: a short push-to-talk
// audio clip over I2S, and a still JPEG over esp32-camera.
//
// Both features are compile-time optional and OFF by default. The CrowPanel
// 2.13" reference board has neither a microphone nor a camera, so a stock
// build must not pull in the drivers, the pin definitions, or the RAM.
//
// Everything here is guarded by ENABLE_AUDIO_CAPTURE / ENABLE_CAMERA_CAPTURE.
// With both at 0 this translation unit compiles to no capture implementation. Transport belongs
// to shared NextCoderCore and is linked only when a capture surface calls it.

#include <Arduino.h>

#if defined(CONTROLLER_CONFIG_PLACEHOLDER_BUILD)
#include "controller_config.example.h"
#elif __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

// ---------------------------------------------------------------------------
// Feature switches. Declared with #ifndef so a controller_config.h that predates
// this feature still builds, and so a platformio.ini env can flip them with -D.
// ---------------------------------------------------------------------------

#ifndef ENABLE_AUDIO_CAPTURE
#define ENABLE_AUDIO_CAPTURE 0
#endif

#ifndef ENABLE_CAMERA_CAPTURE
#define ENABLE_CAMERA_CAPTURE 0
#endif

// Mirror of the gateway's MAX_MEDIA_BYTES (default 2 MiB). The gateway compares
// this against the *decoded* byte count, so the device caps raw bytes, not the
// base64 expansion. Captures are refused on-device rather than uploaded and
// rejected with a 413.
#ifndef MEDIA_UPLOAD_MAX_BYTES
#define MEDIA_UPLOAD_MAX_BYTES (2UL * 1024UL * 1024UL)
#endif

// ---------------------------------------------------------------------------
// Audio capture configuration
// ---------------------------------------------------------------------------

// 1 = PDM microphone (2 wires: clock + data). 0 = standard I2S / Philips
// (3 wires: BCLK + WS + DIN), which is what an INMP441 or ICS-43434 needs.
#ifndef AUDIO_MIC_PDM
#define AUDIO_MIC_PDM 1
#endif

#ifndef AUDIO_I2S_PORT
#define AUDIO_I2S_PORT 0
#endif

// PDM: clock output. Standard I2S: bit clock.
#ifndef AUDIO_I2S_CLK_PIN
#define AUDIO_I2S_CLK_PIN 40
#endif

// Standard I2S only. Leave at -1 for PDM.
#ifndef AUDIO_I2S_WS_PIN
#define AUDIO_I2S_WS_PIN -1
#endif

#ifndef AUDIO_I2S_DATA_PIN
#define AUDIO_I2S_DATA_PIN 41
#endif

#ifndef AUDIO_SAMPLE_RATE_HZ
#define AUDIO_SAMPLE_RATE_HZ 16000
#endif

// Width of one hardware slot. PDM delivers 16-bit samples. Most I2S MEMS mics
// are 24-bit left-justified inside a 32-bit slot, so they must be read at 32
// and narrowed to 16 for the WAV.
#ifndef AUDIO_SLOT_BITS
#if AUDIO_MIC_PDM
#define AUDIO_SLOT_BITS 16
#else
#define AUDIO_SLOT_BITS 32
#endif
#endif

// Extra left shift applied when narrowing a 32-bit slot to 16-bit PCM. 0 keeps
// the mic's natural level; raise it only if recordings come back too quiet.
// Narrowing clamps, so an over-large value distorts rather than wraps.
#ifndef AUDIO_GAIN_SHIFT
#define AUDIO_GAIN_SHIFT 0
#endif

// Hard stop for a single clip. Push-to-talk ends earlier when the key is
// released; this is the runaway guard.
#ifndef AUDIO_CAPTURE_MAX_MS
#define AUDIO_CAPTURE_MAX_MS 5000
#endif

// Below this a press is treated as a mis-tap and nothing is uploaded.
#ifndef AUDIO_CAPTURE_MIN_MS
#define AUDIO_CAPTURE_MIN_MS 400
#endif

// Second, independent budget on the recording buffer. The smaller of this and
// the duration budget wins, so raising the sample rate can never quietly blow
// out the allocation. 192000 = 6 s of 16 kHz 16-bit mono.
#ifndef AUDIO_CAPTURE_MAX_BYTES
#define AUDIO_CAPTURE_MAX_BYTES 192000UL
#endif

#ifndef AUDIO_PROMPT_TEXT
#define AUDIO_PROMPT_TEXT "Voice note from the hardware controller. Use it as the instruction for the current task."
#endif

// ---------------------------------------------------------------------------
// Camera capture configuration
//
// The CrowPanel 2.13" board exposes only a two-pin expansion header, so a
// camera means a different board or a carrier. These defaults are the Freenove
// ESP32-S3-WROVER CAM pin map, which is a common bring-up target; they
// deliberately collide with the CrowPanel key/e-ink pins because the two cannot
// coexist on one board. Replace them with your carrier's map.
// ---------------------------------------------------------------------------

#ifndef CAMERA_PIN_PWDN
#define CAMERA_PIN_PWDN -1
#endif
#ifndef CAMERA_PIN_RESET
#define CAMERA_PIN_RESET -1
#endif
#ifndef CAMERA_PIN_XCLK
#define CAMERA_PIN_XCLK 15
#endif
#ifndef CAMERA_PIN_SIOD
#define CAMERA_PIN_SIOD 4
#endif
#ifndef CAMERA_PIN_SIOC
#define CAMERA_PIN_SIOC 5
#endif
#ifndef CAMERA_PIN_D7
#define CAMERA_PIN_D7 16
#endif
#ifndef CAMERA_PIN_D6
#define CAMERA_PIN_D6 17
#endif
#ifndef CAMERA_PIN_D5
#define CAMERA_PIN_D5 18
#endif
#ifndef CAMERA_PIN_D4
#define CAMERA_PIN_D4 12
#endif
#ifndef CAMERA_PIN_D3
#define CAMERA_PIN_D3 10
#endif
#ifndef CAMERA_PIN_D2
#define CAMERA_PIN_D2 8
#endif
#ifndef CAMERA_PIN_D1
#define CAMERA_PIN_D1 9
#endif
#ifndef CAMERA_PIN_D0
#define CAMERA_PIN_D0 11
#endif
#ifndef CAMERA_PIN_VSYNC
#define CAMERA_PIN_VSYNC 6
#endif
#ifndef CAMERA_PIN_HREF
#define CAMERA_PIN_HREF 7
#endif
#ifndef CAMERA_PIN_PCLK
#define CAMERA_PIN_PCLK 13
#endif

#ifndef CAMERA_XCLK_FREQ_HZ
#define CAMERA_XCLK_FREQ_HZ 20000000
#endif

// esp32-camera frame size enum name. SVGA (800x600) is a reasonable still for a
// vision prompt; drop to FRAMESIZE_VGA or FRAMESIZE_QVGA on a board without
// PSRAM. The firmware downgrades automatically when no PSRAM is present.
#ifndef CAMERA_FRAME_SIZE
#define CAMERA_FRAME_SIZE FRAMESIZE_SVGA
#endif

// 10..63, lower is better quality and a bigger file.
#ifndef CAMERA_JPEG_QUALITY
#define CAMERA_JPEG_QUALITY 12
#endif

// Refuse to upload a frame larger than this even though the gateway would
// accept up to MEDIA_UPLOAD_MAX_BYTES. A still for prompt context does not need
// half a megabyte, and the upload is on a e-ink-paced UI.
#ifndef CAMERA_CAPTURE_MAX_BYTES
#define CAMERA_CAPTURE_MAX_BYTES (512UL * 1024UL)
#endif

#ifndef CAMERA_PROMPT_TEXT
#define CAMERA_PROMPT_TEXT "Still image from the hardware controller camera. Use it as context for the current task."
#endif

namespace capture {

#if ENABLE_AUDIO_CAPTURE

// Installs and starts the I2S RX driver. Safe to call repeatedly.
bool audioBegin();

// Uninstalls the driver so the pins and DMA buffers go back to the system
// between clips.
void audioEnd();

// Reads up to maxBytes of 16-bit mono PCM. Returns the number of bytes written,
// which is 0 on timeout. Internally bounded to a small chunk so a push-to-talk
// loop can re-check the key without waiting out a long DMA read.
size_t audioReadPcm(uint8_t* destination, size_t maxBytes, uint32_t timeoutMs);

// Fills a 44-byte canonical PCM WAV header for dataBytes of payload.
void buildWavHeader(uint8_t header[44], uint32_t dataBytes);

constexpr size_t kWavHeaderBytes = 44;

// Bytes of 16-bit mono PCM per second at the configured sample rate.
constexpr size_t kAudioBytesPerSecond = static_cast<size_t>(AUDIO_SAMPLE_RATE_HZ) * 2;

#endif  // ENABLE_AUDIO_CAPTURE

#if ENABLE_CAMERA_CAPTURE

// Initialises esp32-camera. Safe to call repeatedly; returns false and leaves
// the driver uninitialised when the sensor does not answer.
bool cameraBegin();

// Grabs one JPEG frame. On success the caller owns the pointer until it calls
// cameraRelease(); the buffer belongs to the driver and must never be freed.
bool cameraCaptureJpeg(const uint8_t** data, size_t* length);

// Returns the frame buffer to the driver. Must be called after every successful
// cameraCaptureJpeg(), including the failure paths that follow it.
void cameraRelease();

#endif  // ENABLE_CAMERA_CAPTURE

}  // namespace capture
