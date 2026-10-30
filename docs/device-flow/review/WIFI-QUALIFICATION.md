# Hosyond Wi-Fi and interaction qualification — October 23, 2026

Qualification is in progress. A successful compile or simulated radio test is not a physical
connection, a readable screen, or a completed T3 turn.

## Implemented flow

Device → Wi-Fi scans nearby 2.4 GHz networks. Select a row to connect with saved credentials or
enter a password. The on-device keyboard has two horizontally scrolling rows of 56×60 px letter
targets, with fixed CAPS, 123, SPACE and DEL controls. Saved → Add supports hidden SSIDs. Network
names discovered by scanning retain their bytes; manual on-device entry supports printable ASCII.

PHONE opens a temporary secured controller setup network. Scan its first QR to join, then use
OPEN PAGE if the phone does not open the captive page. The local phone page scans networks,
accepts their password, and reports the controller's validation and save result. It can reuse a
saved password without exposing it. Settings change directly; no firmware flash or cloud
transcription/credential service is involved.

The same phone can provision its own hotspot using an explicit handoff: enter the hotspot name
and password, choose Use this phone’s hotspot, then enable the hotspot after setup Wi-Fi closes.
The controller waits up to two minutes, retries the same candidate, and saves only after
association. Page loss during that handoff is expected; the controller shows the result.

Up to five validated networks survive restart. Association loss tries saved alternatives with
bounded timeouts/backoff. Failure or cancellation preserves working profiles. A failed new
password followed by fallback to an old password is still a failed candidate. Hosyond announces
reconnect/switch events without replacing its current thread or retained voice draft.

## Changes prompted by hardware evidence

- Initial owner testing could not see an iPhone hotspot. Enabling Apple's Maximize Compatibility
  made it appear. The device now labels the 2.4 GHz requirement; setup instructions explain it.
- The owner found the first keyboard too small and reported flicker on typing, Back and scrolling.
  The revised larger swipe keyboard and screen composition are now in the qualification build.
  Header, footer and content are composed as completed strips using the existing internal
  240×22 buffer. Press feedback no longer clears every region. No new full-screen framebuffer or
  PSRAM drawing buffer was introduced.
- A 100-step read-only navigation/reply workload exposed transient internal heap below 2 KB,
  later 964 bytes. The persistent SSE session retained TLS buffers while another request started.
  TLS sessions now share a cooperative lease, with foreground priority, bounded handshake time,
  socket destruction before release and authoritative reconciliation after stream closure.

## Hardware baseline before those final repairs

Secure `0.2.20-qual` ran for 1,900 seconds. It completed 100 navigation steps with the destination
unchanged, recovered a forced station disconnect, and resumed reply reads. An unavailable-network
attempt returned to the stored working network; its portal response delivery was uncertain and
was not blindly retried. No panic or watchdog reset was observed. These results exposed the
memory and visual issues above and therefore do not establish a passed release qualification.

## Current qualification build

Secure `0.2.20-qual3` was written only to the verified device's active application slot. Image
verification passed; OTA metadata matched before/after. Identity and saved settings were retained.
SHA-256: `5149fa1f4ac0cb10b4b3f0d9d044f501bb3603734d2f0e5050e8f53f4140ac00`.

This build adds same-phone hotspot handoff and fixes recording-screen arrival repainting.
The focused native firmware suites pass 53 tests. Earlier qual2 capture attempts were interrupted
by host disk exhaustion; they do not establish a continuous soak. The owner confirmed that the
screen remained responsive during a USB capture interruption. Qual3 capture includes device
uptime and opens serial without asserting reset lines, so host capture and device continuity
can be assessed separately.

The production build must be restored after testing so the USB fault-injection controls are
absent. Physical keyboard/flicker, phone QR setup, alternate-network failover, repeated outages,
new-build soak, and final action/voice reply evidence are still pending at this checkpoint.
