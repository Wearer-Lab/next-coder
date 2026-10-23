# Firmware workflow audit

This audit covers shared NextCoderCore and the Hosyond controller, with compatibility builds for
the other boards. It separates code evidence, compiled images, cloud integration, and physical
observations. A successful build is not evidence that a peripheral or touch interaction worked.

## Repair coverage

| Path | Defect addressed | Verification |
| --- | --- | --- |
| Boot and device identity | Failed task creation could leave a gesture queued without a consumer; transport settings could tear during a concurrent update | Native scheduler/settings tests; secure builds |
| Wi-Fi loss and reconnect | Known-good networks stopped retrying; fallback setup delayed recovery | Actual provisioning code exercised with repeated failures and restored connectivity |
| Setup portal | Joining blocked the render loop; closing a pending join could retain uncommitted credentials | Polled join, candidate cancellation and saved-network recovery tests |
| Gateway transport | State/TLS lock inversion, overlapping handshakes, unbounded or non-yielding reads | Actual request-body exit tests, TLS security tests, bounded stream tests |
| Gateway discovery | A transient cloud failure could trigger adoption of an unauthenticated LAN advertisement | Automatic adoption restricted to explicit insecure LAN bench builds |
| Events and refresh | Half-open streams, oversized lines/events, stale origin or credentials | Bounded event parser, idle reset, atomic transport snapshots |
| Touch gestures | I2C failures could look like a lift/tap; multi-touch and diagonal scroll could activate unintended actions | Actual touch parser with scripted bus faults, contact loss, multitouch, long press and swipe inputs |
| Gesture/network scheduling | Touch requests blocked rendering; late work could force navigation | One bounded job on the existing network task, UI-task completion and stale-screen guards |
| Environment/project/thread selection | Old thread context and late responses could survive a selection change | Staged browse model, generation checks and server context preconditions |
| Thread creation | Lost responses could create duplicates | Durable request ID, exact retry fingerprint, compare-and-swap journal |
| Saved actions and confirmations | Double taps, stale confirmations, acknowledgements mistaken for rendered screens | Actual queue/dispatch tests and expected-context HTTP regressions |
| Uncertain requests | A new intent could overwrite an unresolved request; fresh context rejection could strand its journal | Bounded receipt lookup, atomic journal updates and conclusive rejection receipts |
| Reply loading, paging and retry | One failed GET stopped recovery; old replies could replace a reopened/new thread | Generation/cursor checks; transient GET retry without command replay |
| Gateway approvals | HTTP success could conceal a blocked/failed result | Separate accepted, approval-required, blocked and completed projections |
| Provider approvals and user input | Remote blocking requests were ignored | Explicit distinct console handoff; no false working/completed state |
| Voice capture | Blocking DMA waits, premature empty-read termination, amplifier race and final full-buffer scan | Native PCM statistics and capture-state tests; board builds |
| Voice upload | Unbounded bodies, unsafe credential URLs, lost job IDs, ambiguous retries | Relative credential-route policy, exact byte replay and finalize recovery tests |
| Capture destination | A delayed upload could inherit a later thread; identical new recordings could deduplicate | Per-recording random ID, frozen session destination and HTTP regressions |
| Transcription job | Polling stopped after transient failures, continued during review, or dispatched audio twice | Same-job bounded backoff, terminal milestone handling, single server-owned dispatch |
| OTA download | Raw chunk frames, unbounded duration, missing board check, commit/origin race | Decoded bounded partition sink, absolute socket deadline, signed model check, atomic realm commit |
| Build isolation | A placeholder environment's directly included example header was omitted | Both staged headers come from the checked-in example; staging regression and full matrix |

## Recovery rules

- Observation retries never replay an agent command, approval answer, or thread creation.
- A transport error does not establish whether a write executed. Retrying the same mutation uses
  its original ID; another mutation cannot silently replace an unresolved receipt.
- Status and Stop remain available while a previous mutation is uncertain.
- The server rejects stale confirmed context before execution and records a conclusive rejection
  receipt when there was no earlier receipt. An existing processing or completed receipt is preserved.
- A late response cannot overwrite a new selection or a newly opened response with the same cursor.
- Cancelling a locally held recording discards and clears its PCM. Returning from an uploaded job
  does not claim to cancel server work that has already been accepted.
- A firmware image must retain certificate verification and signed OTA checks. No eFuse or secure-boot
  changes are part of this repair.

## Limits and follow-up verification

Production transcription is currently disabled. Firmware reports this explicitly and retains the
uploaded media reference; it does not invent a transcript or submit an empty audio prompt. A real
voice-to-T3 round trip requires a configured production-reachable transcription provider.

On-device transcript editing/manual transcript submission, provider approval answering, and free-form
T3 user input remain console handoffs. These are not counted as completed on-device workflows.

After installing the repaired image, the physical workflow pass should cover:

1. Boot with Wi-Fi available, boot during an outage, and restore the network without changing credentials.
2. Open a thread, navigate Back while a request is pending, reload the reply, and retry after a disconnect.
3. Change environment/project/thread during a read and confirm that stale results do not replace selection.
4. Run a read-only saved action, tap confirmation repeatedly, and verify one device-origin command and its reply.
5. Exercise a rejected action, a gateway approval, and the distinct provider/input console handoffs.
6. Record, release, discard, retry a failed upload, and verify the original capture destination.
7. Once transcription is configured, verify transcript review, single dispatch and the fresh reply cursor.

Other boards receive compile coverage only in this audit. Pin maps, display/audio quality, arbitrary
router conditions, power-cut OTA rollback, and prolonged hardware soak require separate silicon
evidence. The operational evidence report records the checks actually run and their measured limits.

## Observed Hosyond bench evidence (2026-10-22)

The secure 0.2.16 bench image exercised the production recording UI entry points with synthetic
press/release events on the physical board. The microphone boot self-test received 31,408 samples
over 1,963 ms. A 4,027 ms hold retained 64,768 samples (4,048 ms of 16 kHz mono PCM); the clip was
discarded locally. This establishes capture and sample retention, not transcription, speech quality
or a human touch-sensor test.

With the Next Coder folder default set to the existing verification thread's actual
`codex/gpt-6.1-sol` selection, thread creation returned 201, added exactly one list row and adopted
the new binding. The empty bench thread was archived and the verification-thread binding restored.
The earlier 409 without a folder model was a real configuration failure, not a successful create.

All 15 firmware environments built after the shared-core fixes. Following the final Hosyond-only
Home/bench changes, all seven Hosyond environments were rebuilt. Other-board evidence remains
compile-only. Production TLS verification and signed OTA checks stayed enabled; USB flashing wrote
only the confirmed active application slot and preserved provisioning. OTA download fault handling
has native tests; a physical OTA power-cut/rollback rehearsal was not performed.

Production boot capture is disabled by default; the explicit bench environment opts into the
two-second microphone self-test. Normal startup therefore avoids recording ambient audio and
waiting for that diagnostic. The final production image is 0.2.17.

## Confirmed physical production round trip (2026-10-22 EDT)

On production firmware 0.2.17, the owner tapped Verify T3 and Confirm on the Hosyond. The resulting
device-origin command `jn772qe7txpzz77vtzg4286c3d8gvbs2` was created at 23:18:02 EDT and completed
at 23:18:12 EDT (2026-10-23T03:18:12.894Z). Its durable result contained
`HOSYOND_PRODUCTION_E2E_OK`, and the device reply endpoint returned HTTP 200 with the same marker
after the command's immutable dispatch cursor. The owner then explicitly confirmed that the exact
reply was visible on the physical Hosyond screen. This closes the saved-action confirmation, cloud
routing, local T3 execution and on-device reply path for this test.

The serial trace from the earlier session had expired before this tap, so the screen-delivery proof
is the owner's observation, not a recorded render acknowledgement. Radio outage recovery, repeated
confirmation stress, transcription and the other physical cases above remain separate gates.
