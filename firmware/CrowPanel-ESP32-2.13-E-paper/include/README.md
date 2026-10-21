# CrowPanel ESP32 controller guide

Target: **CrowPanel ESP32 2.13-inch E-Paper HMI Display**, 250x122 landscape monochrome,
ESP32-S3-WROOM-1 N8R8.

- [Elecrow wiki](https://www.elecrow.com/wiki/CrowPanel_ESP32_E-Paper_HMI_2.13-inch_Display.html)
- [Vendor source and schematics](https://github.com/Elecrow-RD/CrowPanel-ESP32-2.13-E-paper-HMI-Display-with-122-250)
- [Hardware protocol and complete UI contract](../../../docs/hardware-protocol.md)
- [Device setup flow](../../../docs/device-setup-flow.md)
- [Device actions protocol](../../../docs/device-actions-protocol.md)

The Vision Master T190 is still a development target. Do not assume this CrowPanel screen,
five-button navigation, or protocol parity applies to the T190.

## Configure a bench unit

Create the private header before flashing real hardware:

```bash
cp include/controller_config.example.h include/controller_config.h
```

Then set:

- Wi-Fi SSID and password;
- device-reachable gateway base URL;
- device ID and secret from factory provisioning or development registration;
- fallback T3 environment ID and thread ID;
- optional development prompt/shell fallbacks.

`controller_config.h` is ignored by git. Production identity belongs in the unit's `agentctl` NVS
namespace; the generated header is a bench path and must not be treated as a fleet credential store.
The gateway remains authoritative after claim.

Build and upload from `firmware/esp32-controller`:

```bash
pio run
pio run --target upload
pio device monitor
```

## Electrical and display facts

| Function | GPIO / detail |
|---|---|
| E-paper SCK / MOSI | 12 / 11; MISO is not wired |
| E-paper RST / DC / CS / BUSY | 10 / 13 / 14 / 9 |
| Panel power enable | GPIO7; drive HIGH before display init |
| Dial up / down / press | 6 / 4 / 5 |
| MENU / EXIT | 2 / 1 |
| Power LED | 19 |
| Expansion header | 40 / 41 |

All five application keys are discrete active-low switches with external pull-ups and use plain
`INPUT`. The wheel is not a rotary encoder. The separate `BOOT` and `RESET` buttons are maintenance
controls: RESET restarts the ESP32; BOOT is reserved for flashing/recovery and is not a product key.

Important board behavior:

- **Drive panel power GPIO7 HIGH before display initialization.** Otherwise BUSY remains asserted
  and the screen stays blank.
- **Use the remapped SPI pins.** These are not the ESP32-S3 defaults.
- **Native USB is unavailable.** GPIO19/20 are the native USB pins and GPIO19 is also the board's
  power LED. The board programs through its USB-to-UART bridge, so `ARDUINO_USB_CDC_ON_BOOT` stays 0.
- **The tested panel controller is JD79661, not SSD1680.** The working implementation is vendored in
  `lib/ElecrowEPD/`; GxEPD2's SSD1680 command sequence and BUSY handling do not drive these units.
- **Use `EPD_Clear()`, never `EPD_ALL_Fill()`.** The latter is leftover SSD1680 code. `EPD_Clear()`
  primes both RAM planes and loads the software waveform LUTs required by this controller.
- **Bound every BUSY wait.** Vendor examples contain unbounded loops; a panel fault must not hang
  heartbeat, recovery, or input processing.

The panel exposes 250x122 visible pixels in landscape. The driver buffer is 250x128, so rows
122–127 are padding and must carry no meaningful UI.

## Current firmware versus target interaction

The current source implements the first redesigned slice:

- the shared retro renderer and 250x122 hardware-control-rail/content grid below;
- original Agent, Home, Action, Thread, Gateway, Firmware, Status, Stop, Warning, Success, and Error glyphs;
- Home, three-row Root, Threads, opened-thread Actions, Gateways, and compact Detail/result screens;
- MENU opens Root, EXIT returns Home/back one level, and Home OK requests status;
- the thread endpoint is rendered as a paged list of up to 12 rows with `status` and `selected`
  metadata; dial browses and OK switches then opens the visible thread; an unavailable T3 host is identified as
  `Start T3 Code` and OK retries the request;
- signed firmware polling distinguishes automatic installs from local confirmation. A manual or
  notify release opens `OTA//UPDATE` with `EXIT:LATER` and `OK:INSTALL`, and remains discoverable
  as a Root row after deferral; the always-visible `Firmware / CHECK` row also runs the poll on
  demand;
- gateway selection, assigned-control dispatch, unchanged-frame suppression, the 10-second EXIT
  recovery hold, and the 1.5-second OK+EXIT stop chord.

The complete interaction below remains the target contract. Separate action/thread detail
confirmation, Session and Approvals screens, review-before-upload, output paging, MENU-hold refresh,
general OK-hold confirmations, and rapid-dial coalescing are not implemented yet. Current thread OK
switches directly from the list and opens that thread's assigned actions; current reset confirmation
accepts a second OK tap.

## Retro terminal presentation

Use a sparse, one-bit field-terminal style:

- predominantly white screen, black pixel/mono text, single-pixel rules, square corners;
- terminal cursor `>` for selection, `ACTIVE` for the active thread, `x` for disabled;
- short bracketed states such as `[LIVE]`, `[RUN]`, `[WAIT]`, `[RISK]`, and `[ERROR]`;
- slash counts such as `2/7`, compact verbs, and `~` for truncation;
- no spinner, blinking cursor, marquee, scanline texture, or large decorative black fill.

Next Coder uses its own 12x12 one-bit glyph family. The identity mark is a terminal frame with
`>_`. Capability glyphs cover thread, status, action, shell, macro, approval, continue, interrupt,
stop, audio, image, gateway, firmware, success, warning, and error. Every glyph must be paired with
text; never copy T3 Code branding or use an icon as the only status signal. Pixel concepts and
semantics are canonical in the hardware protocol.

## Screen grid

| Region | Visible coordinates | Rule |
|---|---|---|
| Physical control rail | `x=2..43`, `y=2..119` | Centered MENU at y5, rotary up/OK/down at y36/57/78, BACK at y106 |
| Header | `x=47..247`, `y=0..22` | 12x12 glyph at 49,5; title; boxed right state |
| Body | `x=47..247`, `y=23..101` | Three list/summary rows at y 27/52/77 or two prompt lines |
| Context footer | `x=47..247`, `y=102..121` | `ROTATE:MOVE` for lists; `OK:STATUS MENU:ACTIONS` on Home |
| Buffer padding | `y=122..127` | blank and not visible |

```text
+-------+-----------------------+
| MENU  |[G] TITLE       [STATE]|
|       |-----------------------|
| ^     |> selected row         |
|  OK   |  row                  |
| v     |  row                  |
|       |-----------------------|
| BACK  |ROTATE:MOVE            |
+-------+-----------------------+
```

The compact left-side rail mirrors the installed enclosure: the top MENU key, center rotary switch,
and bottom EXIT/BACK key. The center shows only `OK`; contextual verbs such as Run, Switch, and
Install remain in the content pane. The selected row uses a cursor, not inverse fill, to remain legible.

Home fills the full body with three non-interactive facts: selected task, system/device summary, and
latest command state. Assigned actions carry gateway-provided `requiresThread` and
`requiresConfirmation` flags. Missing task context renders `THREAD` and cannot dispatch; saved
actions render `CONFIRM` and require a second OK from a review screen. Stop keeps its dedicated
risk confirmation. Firmware never infers these behaviors from an action label.

The dashboard's Controller Details preview mirrors this renderer contract: 250x122 proportions,
left physical-control rail, three rows per page, and separate Root, Threads, opened-thread Actions,
and Response states. Root contains only `Threads`, `Gateway`, and `Firmware`; assigned Action Library
controls appear only after a task is opened. Dashboard sync state comes from the controls revision
acknowledgement; its cursor is only a local preview because rotary position is not synchronized to
the gateway.

## Universal button contract

| Gesture | Normal meaning | Important exceptions |
|---|---|---|
| Dial up/down | Move the list cursor or page response text | Moves among the maximum two follow-up suggestions when that list is open |
| OK tap | Open, choose, or run a routine action from detail | On a response, opens validated follow-ups or refreshes when none exist |
| OK hold 1.5 s | Confirm the operation named on a risk screen | Push-to-talk uses a dedicated capture context |
| MENU tap | Open root navigation without changing remote state | Ignored during recording, erase, and unsafe OTA write |
| MENU hold 1 s | Refresh the current list/status | No action while another hold gesture is armed |
| EXIT tap | Back, cancel before dispatch, or dismiss a view | Never means Deny; running remote work continues |
| EXIT hold 10 s | Clear local setup and re-enter provisioning | Disabled while erasing, writing OTA, or rebooting |
| OK+EXIT hold 1.5 s | Emergency `system_stop` | Chord wins over both single-key holds and consumes release edges |

Hold thresholds are measured from pin state, not e-paper feedback. Coalesce rapid dial movement for
roughly 200–300 ms and render the final cursor once. Do not refresh during push-to-talk or while
measuring a chord. After a successful hold, consume its release so it cannot trigger another action.

Cancellation vocabulary is strict:

- EXIT before dispatch: `CANCELLED`, no request sent;
- EXIT after dispatch: dismiss the screen, remote work continues;
- Deny: explicit decision row followed by OK;
- Interrupt: separate T3 turn action;
- Stop: separate session action or emergency chord;
- macro cancellation never promises rollback of completed steps.

## Navigation hierarchy

```text
HOME
├─ STATUS
├─ ACTIONS
├─ THREADS
├─ SESSION -> continue / interrupt / stop
├─ APPROVALS
└─ DEVICE -> gateway / firmware / network / identity / about / reset
```

MENU opens the root. EXIT walks up one level, then returns Home. Routine owner-assigned controls may
remain directly on Home for speed, but system capabilities have stable locations in the hierarchy.
Home always shows the active thread or `NO THREAD`; its alert priority is pending approval, failure,
running work, latest result, idle status, then device/network warnings.

Major state families that the renderer must cover are:

- boot, Wi-Fi provisioning, connecting, unclaimed/claim code, claimed, and revoked;
- Home, root, list, disabled reason, detail, confirm, cancelled, and outcome;
- approvals list/detail/decision plus approved, denied, stale, and still pending;
- dispatched, running, completed, failed, interrupted, stopped, and approval-required;
- gateway probing/applied/failed, OTA milestones, network/about, and reset/erase;
- media ready/captured/review/upload/failed when the build reports capture hardware.

## Thread list and switching

The target thread flow replaces direct cycling:

1. `MENU -> ACTIONS -> THREADS` calls `GET /v1/device/threads` and renders a three-row paged list.
2. Seed the cursor from returned `threadId`/`selected`; row metadata marks the active target and
   `>` is only the cursor. Compact `status` may show running/stopped/idle state.
3. Dial moves the cursor without modifying runtime config.
4. OK sends `POST /v1/device/config/thread` with only the exact visible
   row ID; EXIT returns to Actions without changing context.
5. Persist/update the active target only after a 2xx response, then show `ACTIVE` and open the task.

A switch affects subsequent actions only. It does not migrate, interrupt, or stop work already sent
to the previous thread. `409` means no environment is bound, `404` means the selection became stale
or foreign, and either failure leaves the previous thread active. Empty and offline states provide
dashboard/retry guidance. Duplicate or truncated titles use a shortened ID on detail. Creating,
renaming, deleting, and arbitrary text editing remain dashboard tasks.

## Agent response and follow-up flow

An opened task always begins with `Latest response`, followed by the Controller Details Action
Library layout. OK calls `GET /v1/device/thread-output?page=0`; the dial requests adjacent three-line
pages. After a device action is accepted, firmware supplies the gateway's `responseAfter` timestamp
so an older assistant message cannot appear as the new result. Waiting and streaming results poll
every five seconds, but the renderer suppresses unchanged e-paper updates.

When the response contains validated recommendations, OK opens a list of at most two follow-up
actions. The controller holds only opaque id, label, kind, and confirmation metadata. It never
receives prompt text, shell text, or macro steps. OK on a recommendation opens the same confirmation
screen used by its assigned Action Library row; EXIT cancels, MENU returns to Root, and gateway
policy remains authoritative.

## E-paper implementation checklist

- Compare the complete visible screen model before calling `EPD_Update()`.
- Keep network polling independent of drawing; unchanged five-second polls must not refresh glass.
- Use static milestones instead of animation or continuously changing elapsed time.
- Keep all essential content within visible row 121.
- Prefer sparse outlines over inverse-black regions to limit ghosting.
- Preserve input responsiveness while HTTP and panel work occurs; ISR latching alone does not make a
  long, blocking state transition safe.
- Replace the stale retained image early in boot with a clear boot/restored-status screen.
- Test tap, hold, chord priority, key-release consumption, rapid dial coalescing, offline behavior,
  and power loss during every destructive state on real hardware.
