# Vision Master T190 firmware

Board adapter for the Heltec Vision Master T190 (ESP32-S3R8 and 170x320 ST7789 TFT). It now uses
the shared `NextCoderCore` for writable NVS state, Wi-Fi provisioning, per-device
authentication, claim/revocation, TLS, compact gateway projections, controls, approvals, response
paging, credential rotation, and environment/project/thread requests.

## Honest status

The firmware compiles from the checked-in placeholder configuration. It has not been flashed to a
T190, so display power, backlight, color/rotation, native USB, flash/PSRAM settings, and every GPIO
remain **compile-verified only**. The display nets are transcribed from the bundled Heltec schematic;
that is stronger than a guessed pin map but is not silicon evidence.

The bare T190 has one user button, not a rotary encoder. This UI needs bounded up/down/select input,
so the complete operate surface is gated behind an optional external three-pin encoder:

```c
#define ENABLE_T190_EXTERNAL_ENCODER 1
#define T190_EXTERNAL_ENCODER_PINS_VERIFIED 1
```

Do not set the verification flag merely to make a build pass. It means the encoder carrier and its
GPIO assignment were actually checked on hardware. The checked-in build keeps both values at `0`,
does not initialize those pins, advertises `display` but not `thread_picker`, and renders a truthful
status-only surface. It also advertises neither microphone nor camera. Media controls are refused
locally if an incompatible gateway sends one anyway.

## Implemented board behavior

- NVS identity seeded once from a factory partition or, for a bench unit, from
  `controller_config.h`; a build never overwrites an existing device identity.
- Non-blocking shared SoftAP provisioning with explicit joining, online, failed, and portal screens.
- Shared fail-closed HTTPS policy and background gateway task, so network waits do not sit on the
  TFT render/input loop.
- Full claim boundary: cached stable claim code, factory-identity-required, claimed, unreachable,
  and revoked screens. Secrets are never rendered or printed.
- Compact Home projection with gateway freshness, environment, folder, selected thread, and latest
  command state. Cached content is labeled offline rather than presented as live.
- When the verified external encoder gate is enabled: bounded environment health, folder, and
  thread lists; server-confirmed selection; thread creation; assigned controls; gateway-policy
  approvals; selected-thread response pages; and explicit results.
- High-risk approval, stop, reset, and gateway-marked confirmation paths require a 1.5-second hold.
  A tap cancels a confirmation. Approval dismissal means “Keep pending,” never “Deny.”
- A 10-second external-button hold resets Wi-Fi, config cache, and cached claim code while retaining
  factory identity. Revoked credentials do not enter a request loop.
- Unknown or disabled controls never dispatch. Audio/image capture stays unavailable because no
  capture path has been verified for this board.

Changing environment or folder triggers an authoritative gateway config refresh. The UI tells the
operator to select the next level rather than pretending the old project/thread still applies.
Thread switching and creation only update local context after the gateway confirms the mutation.

## Build without live credentials

The repository build runner stages `controller_config.example.h` as `controller_config.h` in an
isolated temporary tree, so an ignored live configuration is not inspected or copied:

```bash
npm run build:firmware:all -- --environment vision-master-t190
```

For a local bench build outside that gate:

```bash
cd firmware/vision-master-t190
cp include/controller_config.example.h include/controller_config.h
pio run -e vision-master-t190
```

The placeholder gateway is loopback HTTP while `SECURE_BUILD_TLS_VERIFY=1` is forced by the
PlatformIO environment. That mismatch is intentional: the firmware compiles, but the shared TLS
gate refuses to send a device credential. A real cloud build needs a current/next CA bundle and a
trusted clock. No `setInsecure()` path exists in the product environment.

## Input mapping when an external encoder is verified

| Gesture | Behavior |
|---|---|
| Rotate | Move through bounded rows or response pages |
| Press | Open/select/run routine action; result screens return Home |
| Hold 1.5 s | Confirm only when the screen explicitly says `HOLD` |
| Hold 10 s | Reset network/provisioning state; device identity survives |

Every list contains a visible Back row because this carrier has no separate Back key. Remote work
continues when a local result is dismissed. Stop is always a separate confirmed action.

## Physical-only release gaps

- Verify the schematic-derived TFT pins, active-low display power, GPIO17 backlight enable,
  ST7789 dimensions/offsets, rotation, color order, and reset behavior on an actual T190.
- Verify 16 MB flash, OPI PSRAM configuration, native USB CDC, NVS persistence, heap headroom, and
  clean boot with no serial monitor attached.
- Design and verify the external input carrier. The example GPIO1/2/3 assignment overlaps exposed
  QuickLink/general-purpose functions and is not a product pin decision.
- Exercise SoftAP setup, bad-password recovery, Wi-Fi roam/sleep-wake, cloud TLS clock bootstrap,
  claim, transfer/revocation, credential rotation, slow/lossy links, and gateway deployment rollover.
- Exercise every encoder gesture against live gateway/T3 fixtures, including stale selections,
  truncated lists, 429 backoff, stopped/already-stopped, approval races, and response paging.
- Measure TFT update time, input latency during gateway requests, heap/PSRAM over long reconnect
  runs, payload rate, and power. Compile success is not performance evidence.
- OTA apply is intentionally absent: this folder has no validated dual-slot partition/rollback and
  no T190 bootloader or signed-update hardware proof. Firmware metadata remains a console concern.
- No microphone, camera, touch, battery telemetry, LoRa, or direct terminal-byte input is claimed.

Do not flash this target as a release image until the applicable physical gaps above have recorded
evidence. Do not copy a pin or a successful test result from another ESP32-S3 board.
