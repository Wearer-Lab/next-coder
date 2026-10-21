# Hosyond / LCDWIKI ES3C28P — 2.8" IPS ESP32-S3 touchscreen

Vendor materials belong in [`docs/`](docs/README.md) (download instructions there; the kit itself is not committed) — schematic, specification, datasheets, and a 30-example
Arduino pack. This board's pin map and audio driver both come from there, not from guesswork.

**Status: hardware-proven prototype with a full touch UI; five environments compile.** The board has
been flashed and used to verify 8 MB PSRAM, 16 MB flash, battery telemetry, SoftAP provisioning, the
ES8311 codec and on-board microphone, the ILI9341 display, panel polarity, and the animated orb.

The five screens, the touch routing, media upload, and every gateway call behind them **have not run
on silicon** — they compile and no board has been attached since they were written. What is proven is
the layer underneath: the orb, the panel, the codec, NVS, and provisioning. See the
[canonical implementation ledger](../../roadmap/IMPLEMENTATION-STATUS.md).

## Why this board runs the full workflow

It has an on-board microphone **and** speaker, a capacitive touch screen, and 8 MB of PSRAM. That
is the same capability set as the Waveshare AMOLED board, with one structural simplification: a
single **ES8311 mono codec handles both directions** — ADC for the downward-facing MEMS microphone,
DAC for the speaker connector. The Waveshare board needs two chips for that (ES7210 to capture,
ES8311 to play), so this one is less driver work, not more.

Capture runs from on-board hardware. No Bluetooth headset or external microphone is required: the
ES8311 records locally today; the planned shared gateway client and CPU-hosted Parakeet service will
handle upload and transcription.

| Capability | This board |
|---|---|
| Voice input | On-board MEMS microphone via ES8311 ADC, 16 kHz mono — exactly what the gateway's transcription pipeline expects, so no on-device resampling |
| Audio output | Speaker connector via ES8311 DAC through an FM8002E amplifier, 1.5 W (8 Ω) or 2 W (4 Ω). Driven by `src/speaker.cpp` — seven UI cues and a PCM path |
| Typing / rich input | FT6336G capacitive touch, 240x320 — an on-screen keyboard fits a rectangular panel far better than the Waveshare's round one |
| Showing an agent reply | 2.8" IPS, 240x320, 262K colours |
| Clip memory | 8 MB OPI PSRAM; a 30 s 16 kHz mono clip is ~960 KB |
| Recording indicator | Single-wire WS2812B RGB LED on GPIO42, driven by `src/led.cpp` — seven breathing states |
| Portability | 3.7 V lithium connector with on-board charging; battery sense on GPIO9 |
| Storage | microSD over 4-bit SDIO |

### Against the Waveshare AMOLED board

Both are viable voice targets; they trade off differently.

- **Display.** 240x320 rectangular IPS here versus 466x466 round AMOLED there. Rectangular is far
  better for text and for an on-screen keyboard; AMOLED is better looking and has true blacks.
- **Framebuffer.** 150 KB at 16 bpp fits in SRAM here. The Waveshare's 434 KB must live in PSRAM.
- **Audio.** One codec here, two chips there. Simpler.
- **Echo cancellation.** The Waveshare has a dedicated ES7210 for it. This board does not, so
  simultaneous playback and capture will be worse — relevant only if we ever do barge-in.
- **Microphones.** One here, a two-mic array there. The array is better in a noisy room.
- **Enclosure.** The Waveshare ships in an aluminium case. This is a bare module.
- **Expansion.** This board exposes a 4-pin header (GPIO2, 3, 14, 21), a separate I2C header, a
  UART header, and microSD. The cased Waveshare may expose none of that.

Neither has a camera, so device-originated `camera_prompt` intents are impossible on both.

## Hardware

| | |
|---|---|
| MCU | ESP32-S3, Xtensa LX7 dual-core @ 240 MHz |
| Memory | 512 KB SRAM + 16 KB RTC SRAM + 84 KB ROM + **8 MB internal OPI PSRAM** |
| Flash | 16 MB external SPI |
| Display | 2.8" IPS 240x320, ILI9341V, 4-line SPI, white LED×4 backlight |
| Touch | FT6336G capacitive, I2C address 0x38 |
| Audio | ES8311 mono codec at I2C 0x18; on-board MEMS mic + speaker connector |
| Storage | microSD, 4-bit SDIO |
| Power | 5 V via USB-C; 3.7 V LiPo connector, ~290 mA charge current |
| Draw | 140 mA display only; 560 mA display + speaker + charging (2.8 W) |
| Buttons | BOOT (usable as a normal key), RESET (wired to chip reset) |
| USB | **Native USB CDC — no USB-to-UART bridge.** Windows 10+ only per the vendor note |
| SKU | ES3C28P is the touch variant; ES3N28P is the same board without touch |

### A vendor spec error worth knowing

The specification's parameter table claims **"Bluetooth V5.0 BR/EDR and Bluetooth LE standard"**.
That is wrong — it looks copy-pasted from an original ESP32 datasheet. The ESP32-S3 has **no
Bluetooth Classic (BR/EDR) radio at all**, only BLE. Do not let that line revive the idea that a
Bluetooth headset can be a microphone source here; it cannot, on this board or any other ESP32-S3.
The on-board microphone is the answer, which is the whole point of this board.

## Pin map

From the manufacturer's specification section 4.2 "ESP32-S3 pin allocation", cross-checked against
the vendor examples in `docs/`. Full detail in
[`include/controller_config.example.h`](include/controller_config.example.h).

| Function | Pins |
|---|---|
| LCD (ILI9341V) | CS 10, DC 46, SCLK 12, MOSI 11, MISO 13, BL 45; reset tied to CHIP_PU (no GPIO) |
| Touch (FT6336G) | SDA 16, SCL 15, RST 18, INT 17 |
| Audio I2S | MCLK 4, BCLK 5, WS 7, DOUT 8 (speaker), DIN 6 (mic); PA enable 1 |
| ES8311 | I2C 0x18, on the shared SDA 16 / SCL 15 bus |
| RGB LED | 42 |
| microSD SDIO | CLK 38, CMD 40, D0 39, D1 41, D2 48, D3 47 |
| Battery sense | 9 (ADC1_CH8), ÷2 divider |
| Expansion header | 2, 3, 14, 21 |
| BOOT key | 0 |

The I2C bus is shared between touch, the codec, and the external header — worth remembering before
assigning a new device to it.

## Toolchain

The whole firmware tree is pinned to **ESP-IDF 5.5 / Arduino core 3.3** via the
[pioarduino](https://github.com/pioarduino/platform-espressif32) platform fork.

Espressif stopped maintaining the official `platformio/platform-espressif32`, which is frozen at
Arduino 2.0.17 on ESP-IDF 4.4 — where `driver/i2s_std.h` does not exist and only the legacy I2S
driver is available. This board's vendored ES8311 driver and its capture path are both written
against the IDF 5.x I2S API, so the old platform could not build them.

All four boards and all 12 environments were rebuilt and pass on the new platform, so the tree
runs one toolchain rather than two.

## Display configuration

Taken from the vendor's own init sequence, `docs/.../2-规格书_Specification/ILI9341V_Init.txt`,
which is the authority for this glass. Adafruit_ILI9341 handles almost all of it; one setting it
does not:

| Setting | Value | Why |
|---|---|---|
| **Display inversion** | **corrected in software, not by `0x21`** | The vendor's sequence sends INVON, but on real glass this panel's polarity does not respond to INVON or INVOFF at all — both were flashed and photographed and the screen was identical. Sending it on top of Adafruit's own init simply cancelled out. So every colour goes through `panelGrey()` / `panelRgb()` in `src/display.h` instead, where the bytes are ours and the result is deterministic. Do not "restore" `invertDisplay(true)` from the vendor file without looking at the panel. |
| Pixel format `0x3A` | `0x55` | 16-bit RGB565. Matches the library default. |
| MADCTL `0x36` | BGR bit set | The vendor sets bit 3 (BGR) in every rotation. Adafruit also sets `MADCTL_BGR`, so rotations agree. |
| Reset | software only | The panel's reset is tied to CHIP_PU, so there is no GPIO for it. The constructor takes `-1` and the library issues a software reset instead. |
| SPI mode | 0 | Vendor `spi_dev.h`. |
| SPI clock | vendor uses 80 MHz | Adafruit defaults to 24 MHz. Safe, but this UI redraws an animated orb, so the bus is the budget — worth raising once the panel is confirmed working. |
| Interface control `0xF6` | `0x01, 0x30` | Panel-specific; the library's defaults have been fine on this controller elsewhere. |
| Gamma `0xE0`/`0xE1` | vendor curves | Panel-specific tuning. Only worth porting if the stock gamma looks wrong on real glass. |

## Audio driver

`lib/ES8311` is Espressif's Apache-2.0 ES8311 driver, vendored from this board's own example pack
(`Example_17_echo`) with exactly one line removed — an `#include` of the vendor's LVGL panel
config, which the driver never reads and which would drag their display setup into our build. See
[`lib/ES8311/README.md`](lib/ES8311/README.md).

Vendored rather than fetched, for the same reason the CrowPanel vendors `ElecrowEPD`: the audio
path must not depend on a network fetch or a third-party package that can move.

## Speaker output

`src/speaker.h` is the whole surface: `speakerBegin()`, `speakerSetVolume(pct)`,
`speakerPlayCue(cue)`, `speakerPlayPcm(samples, count, rateHz)`, `speakerBusy()`, `speakerStop()`.
Seven cues — tap, confirm, error, turn-complete, approval-needed, recording-start, recording-stop —
synthesised as sine segments under a raised-cosine envelope, because a tone that starts on a step
is a click and on a 45 ms cue the click is most of what you hear.

**Nothing here waits for a sound to finish.** A cue is handed to a FreeRTOS task pinned to core 0
and the caller returns in microseconds; the render loop in `src/ui.cpp` has a 33 ms budget and the
shortest cue is 45 ms, so a synchronous API could not be called from the place that knows a button
was tapped. Core 0 rather than core 1 because core 1 runs the panel, touch, and the blocking
gateway calls — a beep that stutters because an HTTP POST is waiting on a socket is worse than no
beep. The one call that touches I2C, `speakerSetVolume()`, deliberately runs on the *caller's*
thread so the shared `Wire` bus is only ever driven from the core that already polls touch.

The ES8311 needs no separate bring-up for output: `es8311_codec_init()` already configures the DAC
and sets a volume, so `ENABLE_SPEAKER` requires `ENABLE_AUDIO_CAPTURE` and `#error`s without it
rather than half-building.

### Capture and playback share one codec — the arbitration rule

Both directions run on one ES8311, one I2S port, one MCLK, one amplifier enable line. The rule,
written out in full in [`src/audio_bus.h`](src/audio_bus.h), is:

> **Recording wins, always, and a cue is dropped rather than deferred.**

- While a capture is live the speaker task starts nothing and aborts anything already sounding, at
  the next DMA chunk boundary (16 ms).
- A cue requested during a capture is **discarded, not queued**. A cue is feedback about something
  the person just did; playing it eleven seconds later when the clip finally ends is not late
  feedback, it is a mystery noise — and deferral would make the queue longest exactly when the user
  is mid-sentence, so every beep would arrive in a burst at the release.
- Capture never waits for playback. `startRecording()` is on the finger-lift path of the render
  loop and may not block on a task on the other core, so it signals and proceeds.
- The amplifier is forced off by capture regardless of what the speaker task believed. An idle
  class-D amp hisses, and it hisses into the microphone.

**It is worth being precise about why**, because the obvious explanation is wrong. This is *not* a
half-duplex codec taking turns. The ES8311 has an independent ADC and DAC, `i2s_new_channel()`
hands back a tx and an rx handle on the same port precisely so both can run at once, and the
vendor's own `Example_17_echo` streams capture straight back out to the speaker in real time.
Simultaneous playback and capture **works** on this silicon.

It is refused anyway, for an acoustic reason that is worse than a driver limitation because no
amount of correct code fixes it: the speaker connector and the downward-facing MEMS microphone are
centimetres apart, and unlike the Waveshare AMOLED board there is no ES7210 and no echo canceller
anywhere in the chain. A confirmation beep played while recording is a confirmation beep
transcribed by Parakeet and dispatched to somebody's shell as part of their instruction. The rule
is a product rule, deliberately stricter than the hardware requires.

Two generation counters rather than two flags make it correct rather than nearly correct.
`captureGeneration()` distinguishes "no capture happened" from "a whole capture started and
finished while the speaker task was not looking" — a plain boolean misses the second, and the tail
of the cue plays into the tail of the clip. `stopGeneration` does the same for `speakerStop()`: a
flag that the task cleared as it picked up each request cancelled the sound that was playing and
then let the very next queued cue straight through.

## Notification LED

One WS2812B-class addressable RGB LED on **GPIO42**, driven from `src/led.h`: `ledBegin()`,
`ledSetState(state)`, `ledTick()`, plus `ledSetBrightness(pct)`.

Seven states — Idle, Connecting, Listening, Thinking, NeedsApproval, Error, Offline — and **not one
hard blink in the file**. Every effect is a continuous function of time, a raised cosine or a sum
of them, crossfaded over 300 ms when the state changes, gamma-corrected so the ramp looks linear to
the eye. The board's visual language is already the Thinking Orb, which morphs rather than cuts;
a blinking LED reads as a fault indicator on consumer hardware, which is precisely the wrong thing
to say about an agent that is merely thinking.

Listening is red with the brightest floor of any state, because a live microphone is red on every
device anybody owns and this is the one state where being understood across a room beats being
pretty. Error is told apart from it by **rhythm** rather than hue — three grouped pulses against a
continuous breath — because "is that reddish or that other reddish" is not a distinction people
make at a glance, and colour-blind users make it never.

`ledTick()` paces itself to 40 Hz and returns after one `millis()` comparison when an update is not
due. When one is due it costs a few floating-point operations and one **asynchronous** 24-bit RMT
transmission it does not wait for. It uses the Arduino core's RMT peripheral driver directly rather
than `Adafruit_NeoPixel`, whose `show()` disables interrupts and busy-waits for the whole frame —
that is what lets `ledTick()` be honest about being non-blocking.

### The pin is vendor-documented, not guessed

Four independent sources in `docs/` agree, which is why this is not behind an "unverified default"
caveat the way an inferred pin would be:

| Source | What it says |
|---|---|
| `5-原理图_Schematic/ESP32-S3芯片IO资源分配表.xlsx`, row **48 \| IO42** | 单线RGB三色LED灯控制引脚 — "single-wire RGB tri-colour LED control pin". The same sheet the rest of this board's pin map came from |
| `2.8inch_ESP32-S3_Display_Schematic.pdf` | names the part **XL-5050RGBC-WS2812B**, one instance, net `RGB_LED` |
| `4-数据手册_DataSheet/RGB+LED(IC)_WS2812B-V5-W.PDF` | the LED's own datasheet ships in the pack |
| `Example_06_RGB_LED`, `Example_15_RGB_LED_TOUCH` | both `#define LED_PIN 42`, Adafruit_NeoPixel at 800 kHz |

GPIO42 is MTMS (JTAG TMS) and is **not** a strapping pin, so unlike the backlight on GPIO45 there
is no boot hazard here — the board uses the internal USB-Serial-JTAG, leaving the pin free.

One detail is *not* confirmed: both vendor examples declare `LED_COUNT 60`, and `Example_06`
declares `NEO_GRBW`. Both are unedited Adafruit strip-demo boilerplate — the schematic shows a
single RGB (not RGBW) part and `Example_15` uses `NEO_GRB`. We drive one LED in GRB order. If a
real board lights up with red and green swapped, `LED_COLOR_ORDER_GRB` is the switch.

## The screens

`src/ui.cpp` owns the screens; `src/ui_paint.cpp` owns the shapes they are drawn from.

**There is no tab bar.** Navigation is a status drawer pulled down out of the header, and the bottom
of the screen carries a contextual action bar that is drawn only while there is something to press.
A permanent five-tab strip spent 42 px advertising four destinations that were usually inert; the
drawer says what is actually true of the device and doubles as the way to the screen that fixes it.

- **Pull down, or tap the header**, for DEVICE / GATEWAY / THREAD / ACTIVITY — each a one-line
  status and each a route to where that thing is changed. Only the rows the device's state justifies
  are drawn: an unclaimed unit has no thread and no activity, because every route behind both
  answers 403.
- **The action bar** carries at most three things, all of them doable on the screen in front of you:
  APPROVE/REJECT on a held command, SEND/DISCARD on a recorded clip, PREV/NEXT on a paged reply,
  RETRY on a failed turn, RELOAD on an empty list. When it has nothing, it is not drawn and those
  58 px belong to the content.
- **A vertical drag** scrolls a list, **a horizontal swipe** pages the response, and **a drag that
  started in the header** pulls the drawer. One gesture, one meaning, decided by where the finger
  landed rather than by where it ended up.

| Screen | What it is for |
|---|---|
| **HOME** | The orb, and under it the destination: the selected thread's name, its status, and OPEN. A horizontal swipe steps through the threads and the line updates live — it is a picker, not a readout |
| **THREADS** | The thread list, scrolled with a finger; tapping a row selects it. The breadcrumb capsule at the top shows the bound environment and folder, and opens the browser. NEW THREAD is in the action bar, and is the primary action when the folder is empty |
| **ENVIRONMENTS** | Which paired T3 host this controller drives. Tapping a row `POST`s it and clears the folder and thread, because those ids only meant something inside the environment being left |
| **FOLDERS** | The projects inside the bound environment, each with its thread count. There is no "all folders" row: `POST /v1/device/config/project` reads `projectId` as a required string, so widening the scope again is a console operation |
| **SEND** | The voice screen, and nothing else: the orb, the record button, and the thread the clip is going to. Four views — ready, recording, held clip, full-page journey — and the first three are **one composition**, so nothing moves as a capture progresses |
| **ACTIONS** | The owner's saved actions. Moved off SEND, where they were four things to press in the middle of a voice interaction; reachable from HOME's action bar |
| **REPLY** | The assistant's answer, paged. The gateway wraps to 31 characters for a 122x250 e-ink panel; this screen re-joins and re-wraps to 19 so the text can be size 2 and read at arm's length |
| **APPROVALS** | One held command at a time with REJECT and APPROVE. Approve goes through a second confirm, because it runs on the owner's own machine |
| **DEVICE** / **GATEWAY** | Identity, Wi-Fi, model, URL, link and probe state, with the config portal and the provisioning reset behind them. Both stay reachable on an unclaimed unit, because they are what somebody opens when the claim screen is not working |

An unclaimed device gets none of the thread-shaped screens. It shows the claim code and the three
steps to use it, with no action bar at all — rotating the code invalidates the number the owner may
be part-way through typing, so it stays behind a deliberate tap on the code itself.

### Environment -> project -> thread

The gateway grew device-facing endpoints for the two levels above a thread
(`docs/hardware-protocol.md`, "Environment, project, and thread API"), and
`firmware/shared/NextCoderCore/src/GatewayBrowse.cpp` is the client for them:
`GET/POST /v1/device/environments` and `/v1/device/projects`, in their own translation unit with
their own state rather than as new members on `GatewayClient`.

Older comments in this tree still say a picker is impossible because `GET /v1/device/threads` is
the only list the protocol offers. That was true and is not any more.

### The shapes

The orb is an anti-aliased point cloud with no straight edge in it, and everything drawn beside it
used to be a hard-cornered `fillRect` and a one-pixel rule. `displaySoftRoundRect`,
`displaySoftSegment` and `displaySoftArcDivider` in `src/display.cpp` composite a signed distance
field through the same DMA staging row the orb blit already uses — no second buffer, and a
`feather` that can be wider than a pixel where an edge should read as soft rather than merely
un-jagged. Separators are shallow arcs that fade out before either bezel; every button is a
capsule; the drawer and the action tray are surfaces that slide, eased, rather than appearing.

### Push-to-talk

Holding the microphone button records into PSRAM, releasing uploads and dispatches. The recording
runs as a state the frame loop pumps rather than a blocking `while (key down)` loop — the old
version could not see the finger lift, and the orb stopped for the duration of the clip.

**Releasing does not send.** The clip is held in PSRAM and the action bar offers DISCARD and SEND.
The old behaviour uploaded and dispatched the instant the finger lifted, which meant the only way to
cancel a voice note recorded by accident was to let it reach the agent and then stop the turn.

SEND streams it to `POST /v1/device/media` as base64 straight into the TCP buffer, then to the
owner's saved capture action if there is one, or to a plain `audio_prompt` on the selected thread if
there is not.

### Layout stability

Three separate bugs in this firmware have been "text ends up where it should not", and they had one
family of causes. Both halves of the discipline that fixes them are worth stating, because neither
is obvious and both regress silently:

**A layout is computed from STRUCTURE, never from content.** HOME reserves the same four bands — orb,
prominent line, secondary line, action row — whether or not it has anything to put in them. It used
to pass two content-derived values into the centring: whether the first line fitted at size 2, and
whether the second line had any text. So a status word changing length, or a thread name being
replaced by "Needs you", changed the measured block height, moved the centring, and walked the orb,
both lines and the OPEN button a few pixels. That is text drift, and it is not residue — nothing is
left behind, the whole composition simply moves. The only input now is `contentBottom()`, which
changes when the action bar appears: a genuine structural change and the one case where the block
*should* re-centre. Content decides what is drawn inside a band; it never decides where the band is.
Long titles still drop to size 1, but they are centred *within the same 16 px band*.

**Arriving at a screen clears the whole content area, in one shared place.** `clearForArrival()` is
the only code that does this, keyed on `paintedViewKey` — the screen, the modal, and which voice
state, because those are four different pictures inside one `Screen`. Each screen still clears the
region it draws into, which is right for a repaint and wrong for an arrival: the recording state
paints a capsule and an elapsed time, so it never touched the two destination lines the previous
state had left below the capsule, and "SENDING TO" and half a thread title stayed on the glass. The
first two variants of this were fixed per-screen, which is exactly why there was a third.

### Creating a thread

A project with no threads used to leave the controller with nothing to point at and no way out
except the web console — which is the one place the owner is not standing when they pick the device
up. `POST /v1/device/threads` fixes that, and the firmware side is one tap: no keyboard, no prompt,
no title. The gateway names it `<D Mon HH:MM> · <device label>` with uniqueness guaranteed, and T3
only auto-retitles a thread still carrying its own default, so that is the name the thread keeps.

It is reachable from two places, and the second one is the point:

- **HOME**, as a slot one past the end of the picker. Swipe to it and the button reads CREATE.
- **THREADS**, in the action bar — **primary and enabled when the folder is empty**, which is
  exactly the state this removes.

Two things in the contract shape the implementation:

**The returned row is spliced, not re-fetched.** `thread` comes back shaped exactly like a row from
`GET /v1/device/threads`. T3 answers a dispatch as soon as the event is appended and its projection
catches up afterwards, so a re-fetch can legitimately *not* contain a thread that certainly exists.
`GatewayClient` owns `threads_[]` and may not be edited, so the splice is an overlay: one row past
the end of whatever the client holds, which retires itself the moment the real list contains the
same id. `threadRowCount()` / `threadRowAt()` are what every screen walks, so the new thread appears
in the picker, in the THREADS list, and as the destination on SEND without anything else changing.

**Creating also selects**, and a follow-up `POST /v1/device/config/thread` is not merely redundant
but harmful — it validates against the live snapshot and can `404` on the thread that was just made.
So the firmware does not send one. It calls `gw->adoptThreadBinding(threadId)` instead, immediately
on the 201: the server has already bound the device, and this tells the client what is already true.

That call is not cosmetic. `context_.threadId` inside `GatewayClient` only moves on its 60 s config
poll, and until it does `postIntent()` keeps stamping the **previous** thread's id on every
dispatch — a voice note recorded in that window lands in the wrong conversation. `adoptThreadBinding`
also closes the open response, because that model is an answer about the conversation the user has
just left; `closeResponse()` resets the whole `ThreadResponse`, so there is no stale `Failed` or
`Done` for any screen to render before the next poll. The firmware clears a **finished** voice
capture on the same reasoning, and leaves one still in flight alone: it was dispatched against the
old thread, that is where it is going, and its completion still deserves to be reported.

**A refused create changes nothing**, so every error path leaves the device on the thread it was
already on and the highlight snaps back to it — the line never shows something that was not created.
The messages follow the protocol doc's table: `403` names the policy dimension that refused it,
`404` says the folder is gone, `409` distinguishes "pick a folder first" from "no model configured",
and `502` says to start T3 Code.

### The destination line

The line under the orb on HOME is the selector, not a caption. Swiping left steps to the next
thread, right to the previous, and the line updates immediately — but **binding is a server write**
(`POST /v1/device/config/thread`), so the highlight moves locally and the write is debounced 600 ms
after the finger settles. Swiping past eight threads costs one request, and the device is never
bound to something the user merely passed over. A selection that has not been committed is drawn
differently from one that has, and a write that fails reverts the line to whatever the device is
genuinely bound to: showing thread B while bound to thread A would send somebody's voice to the
wrong place.

**The prominent line shows the thread's NAME unless the state carries information the orb cannot
express, in which case the state wins.** The orb has nine animations, so "Ready" beside it is
redundant while the name is the one thing nothing else on the screen carries. But `Revoked`,
`No gateway`, `Needs you`, `Needs review`, `Wi-Fi failed`, `Not set up`, `Claim me` and `Failed` all
render the same calm Ring — the orb cannot tell them apart, so for those the word IS the message and
it takes the big line. Every branch of `presentationForState()` sets a `speaks` flag explicitly and
there is no default, so a state added later cannot quietly hide a fault behind a thread name.

### Gestures

Ownership is decided once, on the press, and then the axis is locked:

| Where the finger landed | What it does |
|---|---|
| header / grabber | the drawer, in both directions |
| inside an open drawer | scrolls its rows; closes only on overscroll |
| page content, vertical | scrolls the page — never touches the drawer |
| page content, horizontal | HOME: steps the destination picker. ENVIRONMENTS / FOLDERS / THREADS: moves between the three levels. REPLY: pages |

Travel is accumulated on both axes and the first to pass 18 px wins and holds for the rest of the
gesture, so a horizontal swipe can never open the drawer and a vertical scroll can never change the
selection. Level direction follows the breadcrumb's reading order — environment / folder / thread
runs left to right, so **swiping left goes deeper** and right comes back up. Swiping past either end
says so rather than silently doing nothing.

Moving between levels only navigates. Binding an environment or a project is destructive — changing
environment clears the project and the thread server-side — so those stay behind a deliberate tap on
their own screen rather than under a gesture that can be made by accident.

### The journey, on the orb

The gateway queues transcription itself on that POST and answers with a job id, so everything after
the upload — ASR, normalisation, the review gate, the dispatch — happens out of sight and takes
seconds to a minute. `GatewayVoice` polls `GET /v1/device/media/jobs/:id` for the six-milestone
projection in `src/deviceAudio.mjs` and the orb says which one it is in:

| Milestone | Orb | Word |
|---|---|---|
| recording (the ADC is open) | Wave | Listening — the orb runs inside the audio pump's slice, see below |
| uploading | Ribbon | Sending — **a still frame**, see below |
| transcribing | Globe | Transcribing |
| review | **Ring** | Needs review |
| ready / sent | *deferred* | whatever the turn is actually doing |
| failed | Ring | Voice failed |

Three of those are deliberate rather than obvious. **Review is a stop**, not progress — the
normaliser changed something a person has to look at before it is dispatched — so it gets the calm
orb, never a busy one. **Ready and sent hand back** to the ordinary agent-state table instead of
asserting "Working": that table will say Working when a turn really is in flight and say the truth
when the dispatch was refused by policy. And **nothing is promoted on a milestone the device has not
observed** — a poll that fails holds the last known stage rather than advancing hopefully.

`GatewayVoice` exists at all because `GatewayClient::uploadMedia()` parses `media.id` out of the
POST response and discards `job.jobId`, which is the identifier the poll takes. The upload is
re-expressed there with both ids kept; the part that is actually delicate, `Base64JsonBodyStream`,
is reused rather than reimplemented.

### The orb during capture

The orb animates while recording, and the size of it is a capture-quality decision rather than a
visual one. Capture owns the loop: the I2S ring holds only tens of milliseconds, and a full frame
between reads is how a clip gains a gap, so anything drawn between pumps is a hole in the pumping.

- the 112 px orb is ~640 dots, a 21 904-byte clear and a 9 852-pixel blit — on the order of 15 ms,
  which is most of the ring's margin in one go
- the 44 px orb is a twentieth of that dot budget and a 1 520-pixel blit — on the order of 1.5 ms

So the **mini orb** runs at 30 Hz inside the pump's slice, a ~6% duty. A dropped orb frame is
invisible; a dropped sample is a corrupted voice note, so the trade goes this way round every time —
and if the measured margin is tighter than this, the cadence comes down first, because the animation
degrades gracefully and the audio does not. **These costs are arithmetic, not measurements.**

The capsule's travelling dots are gone: the orb carries the motion now, and two competing animations
on one small screen is what they were originally there to avoid. The elapsed seconds stay, but only
the digits are repainted, into a fixed band — the old code redrew the whole capsule four times a
second, which is 19 500 pixels and about 4 ms of a 25 ms pump slice for a number that changes in one
place.

**The uploading frame is still, and that is not papered over.** `uploadMedia()` holds the render loop
for the whole transfer, so no orb frame runs during it. What the device does instead is paint the
complete full-page moment — one real Ribbon frame, centred, with "Sending" under it and no buttons —
*before* the call begins, so the picture a person is left looking at for those one to three seconds
is the correct one. The motion arrives at the next stage: transcribing is poll-driven and therefore
genuinely animated. Moving the upload to its own task would fix it, and was judged not worth the
concurrency against a one-to-three-second still.

The poll is the one recurring blocking call on the render loop. It runs at the very end of a frame —
paint, then stall — costs one dropped frame about once a second while a capture is in flight, stops
at a terminal milestone, and backs off and gives up rather than freezing the board against a gateway
that has gone away.

## What `src/main.cpp` does today

Boots, reports memory and battery, opens NVS, brings up the panel, touch, the codec, and the shared
provisioning state machine, then runs the loop that drives the gateway client and the UI. It is the
board — pins, radios, the one physical button — and nothing in it knows what a thread is.

- **Tap BOOT** to reopen the configuration portal without erasing otherwise-valid Wi-Fi credentials.
  This is the escape hatch for a mistyped gateway URL.
- **Hold BOOT for 10 s** to wipe Wi-Fi and re-enter provisioning, matching the CrowPanel's EXIT
  long-press recovery. This is the way back from a revoked device, a house move, or a resale.
- BOOT no longer records. It was overloaded three ways and the screen is the interface now.

### Hardware evidence recorded on 2026-08-24

- 8 MB PSRAM and 16 MB flash detected at runtime.
- Battery telemetry reported 4116 mV on the connected unit.
- ES8311 acknowledged and the boot microphone self-test produced non-zero, non-clipping samples
  (`peak 779`, `RMS 284`, `DC offset 12`) at 30 dB gain in a quiet room.
- SoftAP provisioning and the BOOT recovery path ran on the board.
- The ILI9341 panel initialized after the ES8311/Adafruit stack was unified on the same `Wire`
  driver generation; IPS inversion and the orb UI were then exercised visually. Internal-buffer,
  anti-alias, and flicker tuning is still active.

## What is missing

In dependency order:

1. **Gateway profiles.** The two-phase LAN/tailnet switch protocol is still unported, so
   `config.gatewayUrl` is read and ignored rather than persisted unprobed.
2. **On-screen keyboard**, for correcting a transcript rather than for composing a request.
3. **On-device transcript correction.** The gateway transcribes a device upload automatically and
   the board now follows the job to its milestone, but a capture that lands at `review` can only be
   resolved in the console — there is no keyboard here to edit a transcript with.

## What is unverified

1. **Everything on the glass.** Every screen, the status drawer, the action bar, all the soft
   shapes, every tap target, the list scrolling, push-to-talk, media upload, and every gateway call
   behind them were written without a board attached. They compile; nothing has been executed. The
   frame cost of the drawer's largest slide frame — a 240x240 distance-field fill plus its band
   clear — is estimated, not measured: read `draw<=` off the `[fps]` line on real hardware before
   believing it.
2. **The touch coordinate mapping.** `src/touch.cpp` maps the FT6336G's frame onto the panel's as
   the identity, which is what the vendor's own examples do at rotation 0 — but it has never been
   checked against a finger. If the tap targets are mirrored or transposed, the fix is one of the
   three flags at the top of that file; `-DTOUCH_TRACE=1` prints the raw and mapped points.
3. **Every sound the speaker makes.** `src/speaker.cpp` compiles and its arbitration is reasoned
   through, but nobody has heard it. Specifically unproven: that the amplifier produces audible
   output at all; that `SPEAKER_PA_SETTLE_MS`/`SPEAKER_PA_TAIL_MS` are long enough to suppress the
   switch-on and switch-off pop, which are guesses biased towards "no pop" rather than measurements
   against the FM8002E datasheet; that the cue volumes are sensible in a room rather than merely
   sensible on paper; and that a cue aborted mid-tone by a recording sounds like a cut rather than
   a bang. The PA polarity itself is no longer a guess — see below.
4. **Every colour the LED shows.** `src/led.cpp` compiles and the pin is vendor-documented four
   ways, but no LED on this board has been lit by this firmware. Unproven: the GRB channel order
   (the vendor examples contradict each other, hence `LED_COLOR_ORDER_GRB`); that one LED is the
   right count; that the WS2812B-V5 part latches on our 100 ns-tick bit timings; and every
   brightness and hue judgement, all of which were made without seeing the diffuser.
5. **Bootloader rollback drill.** Signed OTA download, SHA verification, inactive-slot boot,
   heartbeat confirmation, and the NVS fallback were exercised on hardware with `0.1.1 -> 0.2.1`,
   followed by the event-triggered production rollout to `0.2.2` (`verified`, 100%). A deliberately
   broken-image bootloader rollback drill is still outstanding.
6. **Touch/display bus coexistence.** Display and codec work, but adding FT6336G on the shared I2C
   bus still needs a real-board test.
7. **Sustained capture/upload power and thermals.** Local clips work; Wi-Fi upload under battery
   load cannot be measured until the gateway client is present. The LED and the amplifier both add
   to that budget — a WS2812B at full white is roughly 60 mA, which is why
   `LED_DEFAULT_BRIGHTNESS_PCT` is 55 and not 100.

**Promoted out of this list:** the PA enable polarity on GPIO1 used to be recorded here as an
inference from one vendor example. It is not an inference any more — the manufacturer's IO
allocation table states 音频功放IC使能引脚，低电平使能 ("audio power amplifier IC enable pin, LOW
enables") for GPIO1, and three vendor examples agree. What remains unverified is whether the
amplifier makes a noise, not which way round its enable line goes.

## Build

```
pio run -e hosyond-es3c28p-controller   # display + microphone: the actual product
pio run -e hosyond-es3c28p              # bring-up, display and audio off
pio run -e hosyond-es3c28p-capture      # microphone + speaker, no panel
pio run -e hosyond-es3c28p-display      # panel + touch UI, no microphone
pio run -e hosyond-es3c28p-recovery     # provisioning/recovery image
pio run -e hosyond-es3c28p-orbbench     # cycles every orb mode and reports frame cost
```

Two flags gate the hardware added most recently. `ENABLE_SPEAKER=1` is set in `-capture` and
`-controller`; it requires `ENABLE_AUDIO_CAPTURE=1` and refuses to build without it, because the
I2S channels and the ES8311 are brought up by `src/audio.cpp` and the DAC borrows them.
`ENABLE_NOTIFICATION_LED=1` is set in `-capture`, `-display`, `-orbbench` and `-controller` — the
LED needs no codec, so a display bisect can still have its status light while everything touching
I2S stays out of a build whose whole purpose is to have no audio in it. Both are off in the base
and `-recovery` environments, following the convention `ENABLE_LCD` set for unproven hardware.

`-display` and `-capture` each disable half the product, which was right while both were bring-up
harnesses and is not right now that the screen is the interface and the microphone is how a request
is made. They are kept because bisecting a display fault still wants a build with no audio in it,
and vice versa. Flash `-controller`.

Copy `include/controller_config.example.h` to `include/controller_config.h` first. Wi-Fi
credentials are deliberately not in it — the owner enters them through the SoftAP portal and they
live in NVS.
