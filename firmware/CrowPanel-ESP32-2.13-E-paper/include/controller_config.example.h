#pragma once

// Copy this file to controller_config.h for real hardware builds.
// Keep controller_config.h out of git because it contains device secrets.
//
// Target board: CrowPanel ESP32 2.13" E-Paper HMI Display, 122x250.
// https://www.elecrow.com/wiki/CrowPanel_ESP32_E-Paper_HMI_2.13-inch_Display.html
//
// ---------------------------------------------------------------------------
// Wi-Fi credentials are NOT here any more.
//
// They live in NVS and are entered by the owner through the SoftAP setup portal
// (`agent-ctl-XXXX` -> http://192.168.4.1). A compile-time SSID could never work
// on a shipped unit, because the factory cannot know the customer's network.
// To reset them on a board, hold EXIT for 10 seconds.
// ---------------------------------------------------------------------------

// Bench seed only. DeviceStore copies these into NVS on a unit that has none, and
// never overwrites a factory-provisioned one. Leave the "replace_me" placeholders
// alone and the seed is skipped entirely.
//
// Gateway URL: your deployed gateway, for example
//   https://gateway.example.com
//   http://192.168.1.20:3996
#define GATEWAY_BASE_URL "http://127.0.0.1:3996"

// Values returned by POST /v1/factory/devices or POST /v1/devices.
#define DEVICE_ID "dev_replace_me"
#define DEVICE_SECRET "replace_me"

// e213 = 2.13 inch e-paper, esp32-s3r8 = ESP32-S3 with 8 MB PSRAM (WROOM-1 N8R8).
// This string is the firmware manifest matching key; changing it orphans devices
// from their release channel.
#define HARDWARE_MODEL "e213-esp32-s3r8"
#define FIRMWARE_VERSION "0.1.0"

// OTA apply is off by default for bench bring-up. Set to 1 when the partition
// table, rollback plan, and release process have been tested on real hardware.
#ifndef ENABLE_OTA_APPLY
#define ENABLE_OTA_APPLY 0
#endif

// Prototype manifest verification uses the gateway HMAC key. This is useful for
// development, but production hardware should move to asymmetric signatures.
#ifndef REQUIRE_OTA_SIGNATURE
#define REQUIRE_OTA_SIGNATURE 0
#endif
#ifndef OTA_MANIFEST_VERIFY_KEY
#define OTA_MANIFEST_VERIFY_KEY ""
#endif

// The environment/thread defaults are used by the menu prompt actions.
// The status action only needs ENVIRONMENT_ID.
#define ENVIRONMENT_ID "env_replace_me"
#define THREAD_ID "thread_replace_me"

// Default prompt sent by the hardware when the Prompt menu item is pressed.
#define DEFAULT_AGENT_PROMPT "Continue the current task, inspect progress, and run relevant tests."

// Default shell command sent by the hardware when the Shell menu item is pressed.
// The gateway policy still screens the command before dispatching it to T3 Code.
#define DEFAULT_SHELL_COMMAND "npm test"

// ---------------------------------------------------------------------------
// CrowPanel 2.13" board pin map. Taken from Elecrow's factory source
// (example/arduino-v1.2/main/spi.h and main.ino), not from guesswork.
// ---------------------------------------------------------------------------

// E-paper SPI. These are not the ESP32-S3 default SPI pins, so the firmware
// remaps the bus with SPI.begin(...) before initialising the panel.
#define EINK_SCK 12
#define EINK_MOSI 11
#define EINK_RST 10
#define EINK_DC 13
#define EINK_CS 14
#define EINK_BUSY 9

// Panel power rail. Must be driven HIGH before the panel responds; the display
// stays dark and BUSY never releases otherwise.
#define EINK_POWER_PIN 7

// Front-panel keys. The board carries external pull-ups and all keys read LOW
// when pressed, so these are configured as plain INPUT, matching Elecrow's
// firmware. There is no quadrature encoder on this board: the "dial" is three
// discrete switches.
#define KEY_UP_PIN 6       // dial up / previous menu item
#define KEY_DOWN_PIN 4     // dial down / next menu item
#define KEY_OK_PIN 5       // dial press / submit the selected intent
#define KEY_MENU_PIN 2     // MENU: refresh display state
#define KEY_EXIT_PIN 1     // EXIT: show the claim/setup code

// Power LED. Driven HIGH at boot by the vendor firmware.
// Note that GPIO19/20 are the ESP32-S3 native USB pins, which is why this board
// programs over a USB-to-UART bridge and USB CDC must stay disabled.
#define POWER_LED_PIN 19

// Two-pin expansion header, unused by this firmware.
#define EXPANSION_IO_A 40
#define EXPANSION_IO_B 41

// Set to 0 if you want to bring up networking and menu logic before touching
// the display.
#define ENABLE_EINK 1

// The panel controller is a JD79661, confirmed on hardware. It is NOT an
// SSD1680: different command set, and BUSY idles HIGH instead of LOW. GxEPD2
// therefore cannot drive it and blocks forever in its busy wait. The driver in
// lib/ElecrowEPD (Elecrow's arduino-v1.2 sources) is the one that works.
#define EINK_PANEL_JD79661 1

// HTTPS fails closed unless the cloud gateway's issuing root is configured. Concatenate a current
// and next root during rotation. Set INSECURE_SKIP_TLS_VERIFY=1 only in a local bench config; it
// exposes the long-lived device credential to interception.
#define GATEWAY_TLS_ROOT_CA_PEM ""
#define GATEWAY_TLS_NEXT_ROOT_CA_PEM ""
#define INSECURE_SKIP_TLS_VERIFY 0

// ---------------------------------------------------------------------------
// Optional media capture (roadmap Phase 6: push-to-talk audio and still images)
//
// Both are OFF by default. The CrowPanel 2.13" reference board has neither a
// microphone nor a camera, and its only spare IO is the two-pin expansion
// header (40, 41), so enabling either one means a carrier board or a different
// board entirely. Every macro below is wrapped in #ifndef, so a platformio.ini
// env can override it with -D without a redefinition warning.
//
// Enabled captures use NextCoderCore's authenticated raw upload-session protocol and then
// submit an audio_prompt / camera_prompt intent referencing the finalized media id.
// ---------------------------------------------------------------------------

#ifndef ENABLE_AUDIO_CAPTURE
#define ENABLE_AUDIO_CAPTURE 0
#endif

#ifndef ENABLE_CAMERA_CAPTURE
#define ENABLE_CAMERA_CAPTURE 0
#endif

// Mirror of the gateway's MAX_MEDIA_BYTES. This caps the raw capture body. Lower it if your gateway
// runs with a smaller MAX_MEDIA_BYTES.
#ifndef MEDIA_UPLOAD_MAX_BYTES
#define MEDIA_UPLOAD_MAX_BYTES (2UL * 1024UL * 1024UL)
#endif

// --- Microphone (I2S) ------------------------------------------------------
// 1 = PDM MEMS mic, two wires, which is the only thing that fits the CrowPanel
// expansion header. 0 = standard I2S (INMP441, ICS-43434), which needs three.
#ifndef AUDIO_MIC_PDM
#define AUDIO_MIC_PDM 1
#endif

#ifndef AUDIO_I2S_PORT
#define AUDIO_I2S_PORT 0
#endif

// PDM: clock output. Standard I2S: bit clock. Defaults to the expansion header.
#ifndef AUDIO_I2S_CLK_PIN
#define AUDIO_I2S_CLK_PIN 40
#endif

// Standard I2S word select. Unused (leave at -1) in PDM mode.
#ifndef AUDIO_I2S_WS_PIN
#define AUDIO_I2S_WS_PIN -1
#endif

#ifndef AUDIO_I2S_DATA_PIN
#define AUDIO_I2S_DATA_PIN 41
#endif

// 16 kHz mono is the usual floor for speech recognition and keeps a 5 s clip
// at 160 KB raw, ~213 KB base64.
#ifndef AUDIO_SAMPLE_RATE_HZ
#define AUDIO_SAMPLE_RATE_HZ 16000
#endif

// Hardware slot width. PDM gives 16-bit samples; most I2S MEMS mics are 24-bit
// left-justified in a 32-bit slot and must be read at 32 and narrowed.
// Defaults follow AUDIO_MIC_PDM automatically; override only for an odd part.
// #define AUDIO_SLOT_BITS 32

// Extra left shift when narrowing a 32-bit slot to 16-bit PCM. Raise if clips
// come back too quiet. Narrowing clamps, so too much distorts rather than wraps.
#ifndef AUDIO_GAIN_SHIFT
#define AUDIO_GAIN_SHIFT 0
#endif

// Push-to-talk bounds. Recording stops when the confirm key is released, at
// AUDIO_CAPTURE_MAX_MS, or at AUDIO_CAPTURE_MAX_BYTES, whichever comes first.
// A press shorter than AUDIO_CAPTURE_MIN_MS is discarded as a mis-tap.
#ifndef AUDIO_CAPTURE_MAX_MS
#define AUDIO_CAPTURE_MAX_MS 5000
#endif

#ifndef AUDIO_CAPTURE_MIN_MS
#define AUDIO_CAPTURE_MIN_MS 400
#endif

// 192000 = 6 s of 16 kHz 16-bit mono. Allocated from PSRAM when present.
#ifndef AUDIO_CAPTURE_MAX_BYTES
#define AUDIO_CAPTURE_MAX_BYTES 192000UL
#endif

#ifndef AUDIO_PROMPT_TEXT
#define AUDIO_PROMPT_TEXT "Voice note from the hardware controller. Use it as the instruction for the current task."
#endif

// --- Camera (esp32-camera) -------------------------------------------------
// These defaults are the Freenove ESP32-S3-WROVER CAM pin map, a common
// bring-up target. They deliberately collide with the CrowPanel key and e-ink
// pins above, because the two cannot share one board: replace them with your
// carrier's map before setting ENABLE_CAMERA_CAPTURE to 1.
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

// esp32-camera frame size enum name. The firmware drops to FRAMESIZE_QVGA
// automatically when no PSRAM is present.
#ifndef CAMERA_FRAME_SIZE
#define CAMERA_FRAME_SIZE FRAMESIZE_SVGA
#endif

// 10..63; lower is better quality and a bigger file.
#ifndef CAMERA_JPEG_QUALITY
#define CAMERA_JPEG_QUALITY 12
#endif

// A still for prompt context does not need to approach MEDIA_UPLOAD_MAX_BYTES.
#ifndef CAMERA_CAPTURE_MAX_BYTES
#define CAMERA_CAPTURE_MAX_BYTES (512UL * 1024UL)
#endif

#ifndef CAMERA_PROMPT_TEXT
#define CAMERA_PROMPT_TEXT "Still image from the hardware controller camera. Use it as context for the current task."
#endif
