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
