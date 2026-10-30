# Hosyond interaction implementation — October 23, 2026

The [audit](REPORT.md) and interactive atlas describe the reviewed 0.2.18 baseline and the design
proposal. This document records implementation and qualification separately. The simulator is an
explanatory model, not a physical firmware test.

## Implemented behavior

- **Thread remains the anchor.** Talk/Resume/Request, Actions and Choose are reachable there.
  Reply pages return to Thread. An empty Actions screen explains assignment in the console.
- **Choose is explicit.** Machine → folder → thread browsing is read-only. Tap a row to preview,
  then Use thread to commit the complete destination. Refresh exists at every level; Back leaves
  the active destination intact. A new thread is created and selected together and returns to Thread.
- **A contact owns one target.** Press records the original contact, semantic target and navigation
  generation. A drag, leaving the target, changed model, stale contact or a different release target
  cancels activation. Pressed feedback uses the existing grayscale/violet visual language.
- **Local navigation remains available during network waits.** Four bounded retained input edges
  expire after 750 ms and are revalidated. One confirmed Stop can wait behind the current worker;
  its context and assigned-control revision are checked again before execution.
- **Voice preserves its identity.** Hidden mic targets cannot replace an active journey. Held audio
  shows its original destination; leaving the recorder retains it. Send/retry uses the original
  capture/session. Uncertain delivery cannot become a silent discard or new capture. Recheck reads
  the original job. Gateway approval and transcript review have distinct explanations. A background
  Sent cursor is transferred to the reply reader before a new recording can replace its tracker.
- **Replies preserve text.** Narrow-display subpages retain all wrapped rows. Paging has explicit
  ends; gateway truncation is visible. Failed reads retain readable text and expose Retry reply
  ahead of pagination. Retry repeats a read, never an agent command.
- **Decisions are deliberate.** Gateway approval and rejection both have a review step; Not now
  leaves the hold pending. An approval result follows its command's reply cursor without taking
  over a different destination. Provider permissions and agent questions remain distinct console
  handoffs. Claim-code replacement is confirmed, and reset copy names the local data it clears.

## Verification

- The full repository gate passed 1,481 tests with three existing intentional live-S3 skips.
- Current-source native regressions exercise actual firmware touch parsing, contact latching,
  bounded retention, voice receipt/recovery/cursor transfer, destination compatibility guards,
  malformed-response recovery and word wrapping. Gateway integration tests cover read-only preview,
  atomic selection, account/folder isolation and creation in a previewed folder.
- The secure Hosyond controller build passed with production certificate roots, verified TLS,
  required OTA signature verification and version 0.2.19. Physical flashing and hardware
  observations are recorded below.
- Passive 0.2.18 baseline: 35 seconds, 17 reporting windows, 27–30.5 FPS, worst draw 43 ms,
  worst frame gap 45 ms, no reported hitches, minimum free heap 45,872 bytes. This unattended
  workload does not establish touch-to-paint latency or mixed-workflow performance.
- New bounded diagnostics report sampled-event dispatch-age histogram upper bounds, retained or
  discarded batches, lock skips and frame gaps. These are not measurements from physical contact
  onset and must not be presented as physical touch latency.

## Qualification boundaries

Voice PCM and the voice-job tracker remain in RAM. Leaving a view or temporarily losing the network
retains them; power loss does not. Cloud jobs and ordinary mutation receipts retain their existing
durability. A local dismissal never claims to cancel cloud work.

Saved audio actions remain in the console: their prompt, target and confirmation cannot safely be
substituted by generic Talk. The board explicitly explains this instead of silently sending an
ordinary voice note. Provider persistent permission grants, free-text agent answers, transcript
editing and full reply history remain in the console. No new camera, haptic, speaker-response or device OTA-acceptance UI
is claimed. Existing cloud ownership/policy enforcement and dashboard-authorized OTA remain intact.

Memory/file/Convex Store method parity requires no new method: atomic destination selection uses
the existing `updateDeviceConfig` operation. No connector runtime or inference path changed;
transcription remains on each user's paired computer.

## Flashed hardware and production observation

The 0.2.19 image was flashed to the verified Hosyond's active application slot at `0x510000`.
Device-side image verification passed. NVS, bootloader, partition table and OTA metadata were
preserved; before/after OTA metadata bytes match. An application backup was recovered using ROM
reads after the bulk stub reader repeatedly stopped. No erase or eFuse operation was performed.

Firmware SHA-256: `098ff6fbe2692ec593667ce12f3b9ad0fa0ea969d2192a77f57dd32143504e92`.
The gateway repair is deployed on `coder.next-notes.com`; health, sign-in configuration, claimed
0.2.19 heartbeat and atomic-preview GETs return HTTP 200. The selected environment reports live
connector / T3 / provider readiness. These are endpoint and heartbeat observations, not proof of a
new physical voice turn or fresh sign-in gesture.

The passive new-firmware sample contains 183 reporting windows (about 366 seconds): 28.1–30.8 FPS, worst reported draw 69 ms, worst FPS-log frame gap 71 ms, and 3 reported hitches. The separate first diagnostic window includes a 128 ms startup/model-arrival gap; later windows
are smaller. No panic or watchdog was observed. No contact events were received during that passive sample. The owner test below verifies the
basic interactive path separately; it does not measure physical touch-to-paint latency or qualify
repeated scrolling, draft recovery, every decision branch, outage recovery or long-soak targets.

The 15-environment build sweep passed, and the final production-controller image was rebuilt after
the last Hosyond copy/navigation refinements. Final repository gate: 1,481 passes plus the three
existing intentional live-S3 skips. Source edits remain in the working tree; no commit or push was
performed in this interaction-repair step.

## Owner-confirmed 0.2.19 end-to-end retest

The owner explicitly confirmed all three requested checks passed:

1. Choose → preview → Back left the selected destination unchanged.
2. Actions → Verify T3 → Run returned `HOSYOND_PRODUCTION_E2E_OK` on Hosyond.
3. Talk → record → release → Send returned `flow test successful` on Hosyond.

Production history independently records the saved-action command
`jn7dfcqeh2bt906eqjveewvsr58gvks9` completed at **07:24:59 EDT October 23** and voice command
`jn717c9q9fjz041rm6n5tnn9fh8gvhzx` completed at **07:26:01 EDT**. Voice job
`ms781snm2an65xp89f2mhps3398gve13` used the local connector on attempt 1: queue wait **5,551 ms**,
transcription **4,219 ms**, job total **12,490 ms**. Gateway receipt to completed T3 reply was about
**14.2 seconds** for this recording. This is one real recording, not a latency percentile or a
controlled comparison with an earlier clip.

The device-authenticated job and cursor-bound reply endpoints both returned HTTP 200; the latter
reported a complete, one-page, non-truncated `flow test successful` reply. Physical screen delivery
and preview cancellation are established by the owner's explicit observation. The serial capture
had expired before the gestures, so this retest provides no new touch timing trace.
