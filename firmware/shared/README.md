# firmware/shared

PlatformIO libraries shared by every Next Coder board, pulled in with `lib_extra_dirs = ../shared`.

The target is for every board to run the same client logic and differ only in its panel and input
surface. Keeping that logic here is what will stop `CrowPanel-ESP32-2.13-E-paper`, `vision-master-t190`,
`Waveshare-ESP32-S3-Touch-AMOLED-1.75C`, and `Hosyond-ESP32-S3-2.8-Touchscreen` from drifting into
four unrelated firmwares.

All four are pinned to one toolchain — ESP-IDF 5.5 / Arduino core 3.3 via the
[pioarduino](https://github.com/pioarduino/platform-espressif32) platform fork. The official
`platformio/platform-espressif32` is unmaintained and frozen at Arduino 2.0.17 / ESP-IDF 4.4, which
has no `driver/i2s_std.h` and therefore cannot build the on-board audio boards.

**Still to lift out of the CrowPanel's `src/main.cpp`:** the two-phase gateway-profile switch. OTA
now lives in `GatewayOta.cpp`, `GatewayClient` covers claiming and the whole operate flow, and every
capture surface—including CrowPanel's optional carrier build—uses the shared raw media-session
transport. Port plans:
[`Waveshare`](../Waveshare-ESP32-S3-Touch-AMOLED-1.75C/README.md),
[`Hosyond`](../Hosyond-ESP32-S3-2.8-Touchscreen/README.md).

## NextCoderCore

| Unit | What it owns |
|---|---|
| `DeviceStore` | Writable device state in NVS (namespace `agentctl`): identity, gateway profiles and switch journal, Wi-Fi credentials, the cached claim code, and the last-known runtime config. |
| `Provisioning` | The boot state machine and its first transport, a SoftAP captive portal. |
| `ThinkingOrb` | Provider-neutral visual state model and point-cloud renderer used by display-capable boards. |
| `GatewayClient` | The device's whole conversation with the gateway: claim, heartbeat, runtime config, saved actions, threads, dispatch, response paging, and the approval queue. No drawing — see [the operate surface](#the-operate-surface). |
| `OperateModel.h` | The board-agnostic shapes a UI renders from, and the fixed cap on every one of them. |

### Why this exists

Everything above used to be a compile-time `#define`, which made a shipped unit unrecoverable:

- the factory cannot know the customer's Wi-Fi network, so a baked-in SSID could never work;
- a wrong password left `connectWiFi()` spinning in an unbounded loop until someone reflashed over USB;
- a rotated device secret had no way to reach the device at all;
- a revoked device displayed `HTTP 401` forever with no on-device recovery.

See [docs/device-setup-flow.md](../../docs/device-setup-flow.md) for the full analysis and phasing.

### State machine

```
unprovisioned --> provisioning --> connecting --> online
                       ^               |            |
                       |               v            v
                       +---- 3 join failures    link lost --> connecting
```

The rule the whole design serves: **the device never blocks indefinitely in any state.** Every state
has a screen, and every failure has a next action visible on that screen.

### NVS keys

Keys are capped at 15 characters by NVS, hence the abbreviations. `buildNvsSeedCsv()` in
[`src/manufacturing.mjs`](../../src/manufacturing.mjs) emits these same names — change one and you
must change the other, or factory-flashed units authenticate against nothing.

| Key | Written by |
|---|---|
| `dev_id`, `dev_secret` | factory flashing station (or a bench seed from `controller_config.h`) |
| `gw_url` | factory default; the owner can override it in the portal |
| `gw_profiles`, `gw_rev`, `gw_active` | device-synced gateway profile cache, revision, and active profile; `gw_url` remains the active URL for compatibility |
| `gw_pending`, `gw_purl`, `gw_prev`, `gw_state`, `gw_error` | two-phase gateway switch journal; an interrupted or failed probe retains the prior working URL |
| `wifi_ssid`, `wifi_pass` | the owner, through the portal |
| `claim_code`, `claim_exp` | the device, from the one time `/v1/device/setup-code` returns plaintext |
| `cfg_cache` | the device, from `/v1/device/config` |

On production units this partition needs flash encryption. Without it, `esptool read_flash` recovers
both the Wi-Fi password and the device secret — see
[docs/production-security.md](../../docs/production-security.md).

### Gateway TLS

Every shared gateway client verifies HTTPS by default. Production configuration must provide the
gateway's issuing root in `GATEWAY_TLS_ROOT_CA_PEM`; `GATEWAY_TLS_NEXT_ROOT_CA_PEM` lets a release
carry the current and next roots during a planned CA rotation. The first request after boot starts
SNTP and fails closed until the device has a credible clock, because certificate validity cannot be
checked against the ESP32's 1970 boot time.

`INSECURE_SKIP_TLS_VERIFY=1` is a local-bench escape hatch only. It exposes the device credential and
must not appear in a production image. A build with `SECURE_BUILD_REQUIRE_OTA_SIGNATURE=1` or
`SECURE_BUILD_TLS_VERIFY=1` overrides that setting and continues to fail closed. Never replace the
root with a leaf certificate: doing so makes routine certificate renewal an emergency firmware
rollout.

### The portal is not an auth surface

It is an open AP serving one local form. It never carries the device secret, never talks to the
gateway, and never asks for a Next Coder account. A WPA passphrase the owner would have to
read off a 122x250 panel doubles the failure surface for no real gain.

Credentials are validated by attempting the join **before** they are persisted, so a wrong password
returns the owner to the form instead of writing a value that bricks the next boot.

## The operate surface

`GatewayClient` splits its calls two ways, and the difference decides how a board uses them.

**Polled.** `runCycle()` refreshes the thread list, display, controls layout, approval queue, firmware
manifest, and an open response page on their own timers — heartbeat 30 s, config 60 s,
threads/controls/approvals 30 s, display 5 s, firmware 6 h. It makes **at most one HTTP request per call** on every path, including the
just-connected edge, which marks the operate resources due rather than firing them in a burst. A UI
never asks for these: it renders whatever the accessors hold, and repaints when `revision()` changes.

**Event-driven.** Boards that call `startNetworkTask()` also hold `/v1/device/events` on a second
network task. `threads.changed` applies a rename/archive/delete delta under the state mutex and
wakes the list after creation.
`device.refresh` coalesces config/control/display refreshes, `firmware.changed` wakes the six-hour
manifest poll immediately, and T3 command/thread/approval/user-input/media events refresh only the
affected read model. Every signal is reduced to a due-time flag; bursts never issue HTTP from the
event task and the ordinary scheduler still performs one request at a time.

`GatewayOta.cpp` streams automatic or mandatory releases to the inactive slot, verifies the signed
manifest and artifact SHA-256, records the attempt in NVS, and confirms the new image only after a
healthy gateway heartbeat. The 16 KB network-task stack is intentional: the 4 KB OTA buffer plus
HTTP/TLS frames overflowed the former 8 KB stack during a physical rollout test.

Cloud HTTP responses can be chunked even when their bodies are small. `GatewayHttp.h` wraps
the request clients so an empty single-byte read yields to the scheduler: ESP32's
`Stream::timedRead()` otherwise spins for the six-second HTTP timeout while parsing chunk framing,
starving the idle watchdog. `BoundedBody` caps decoded bytes before allocation for both declared
and unknown response lengths. Incomplete or oversized responses fail the request instead of
returning a truncated success. TLS certificate verification remains mandatory.

On 2026-10-22, Hosyond firmware 0.2.10 reproduced the watchdog in that chunk-header path against
production. The 0.2.11 fix completed a 90-second physical observation with real production
heartbeats, no watchdog/panic/reboot or gateway request failures, and steady 30.3 FPS after startup.
Steady frame gaps were at most 34 ms; startup and the initial state transition had 144 ms and
70 ms gaps. This was an unclaimed-device test, not proof of account control or a hardware-to-T3
command. The shared code also compiled in the CrowPanel capture-placeholder environment; other
boards were not physically exercised.

**Gesture.** Manual `refreshThreads()`, `selectThread()`, the `send*` / `run*` calls, `fetchResponsePage()`,
and `answerApproval()` are driven by a person. Each performs one request and **blocks for up to the
5 s timeout** — `HTTPClient` has no async mode, and a worker task would put a lock in front of every
accessor. The contract inherited from the CrowPanel firmware is therefore: paint a pending frame
first, then call. On a board running a continuous renderer, expect the animation to stall.

Two things in here are easy to break by simplifying:

- **`responseAfter`.** A dispatch returns an ISO timestamp; `openResponse()` takes it and carries it
  into every page fetch. Without it the gateway answers with the *previous* turn's completed reply
  the instant an action is fired, and the poll that waits for the real one never starts.
- **Local confirmation is not gateway approval.** `runControl()` deliberately does not enforce
  `requiresConfirmation` — that gate belongs to the UI, which is what lets a confirmed action be
  re-dispatched without looping back into its own prompt.

Every collection is a fixed array, because this runs beside a renderer and an unbounded `String`
vector fragmenting the heap over days of uptime does not show up on the bench. Caps: 8 controls (the
gateway's `limits.menuItems`), 12 threads, 3 response lines per page (the gateway's page size, not
screen geometry — a taller screen walks pages), 2 follow-ups, 4 pending approvals, 6 macros, and an
8 KB ceiling on any response body. `setLimits()` declares the first two to the gateway in the
heartbeat; wrong numbers there come back as clipped text rather than as an error.

`GatewayClient` itself only picks a thread. The two levels above it — which paired T3 host, and
which folder inside it — live in `GatewayBrowse.{h,cpp}`, against
`GET/POST /v1/device/environments` and `/v1/device/projects`
(`docs/hardware-protocol.md`, "Environment, project, and thread API").

It is a separate class with its own state and its own copy of the request helper, not new members
on `GatewayClient`, so a board that does not browse pays nothing and the class every board already
depends on did not have to grow a surface. Caps are 8 environments and 12 projects, truncation
reported rather than silently clipped. Two behaviours are load-bearing: changing environment clears
the project and thread server-side, so both local lists are dropped rather than kept; and
`POST /v1/device/config/project` reads `projectId` as a **required** string, so a device can narrow
to a folder but cannot widen back to "all folders" — that stays a console operation.

Earlier revisions of this file said such a picker was impossible because the thread list was the
whole picker the protocol offered. That was true, and stopped being true when the gateway grew
those routes.

### Media upload

`media::uploadSession()` owns the device-side create → raw PUT → finalize contract. It hashes and
streams `header ++ body` directly, so the capture buffer stays the only full copy and base64's 33%
wire expansion is gone. `buildWavHeader()` fills the 44-byte header as its own segment so PCM is
never memmoved. GatewayClient, GatewayVoice, and CrowPanel's optional capture carrier all delegate
to this one function; boards retain only pins, capture buffers, review UI, and capability gating.

The shared transport owns the local size guard, credentials, TLS gate, retry-after backoff, 30 s
timeout, idempotent request digest, exact raw content length, and finalize response. It answers 413
locally without opening a socket when the raw size exceeds the declared `mediaUploadBytes`.

## Status

The shared operate surface and signed OTA path have run against a live gateway on Hosyond hardware;
the mandatory 0.2.1 rollout downloaded, installed, rebooted, and reported `verified`. The CrowPanel
keeps its mature monolithic operate client, but now listens to the same device event stream and
coalesces refreshes before issuing requests from its main loop. Waveshare and Vision Master T190 are
still bring-up scaffolds rather than production gateway clients. Current evidence and blockers are maintained in
[roadmap/IMPLEMENTATION-STATUS.md](../../roadmap/IMPLEMENTATION-STATUS.md).
