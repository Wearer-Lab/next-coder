# Hosyond interaction audit and proposed experience

Reviewed October 23, 2026. Current firmware baseline: Hosyond 0.2.18, source `359bfdd`.

**Recommendation:** make the selected Thread the stable center of the product. Keep destination selection, draft recording, accepted request, and displayed reply distinct. Make a touch feel acknowledged immediately, while reporting remote execution only when there is evidence. Preserve Next Coder’s visual identity and all trust-boundary protections.

This review changes documentation and the explanatory web page only. No firmware, gateway, connector, production configuration, account, NVS or device was modified. The earlier work in the checkout is preserved. This is a proposed design, not an approved implementation or a physical performance certification.

## Review method and confidence

All 19 corrected current-flow journeys were walked in the browser (117 explanatory frames), including a final pass after the setup correction. Source review covered the mapped states, contextual action priority, touch parser/router, browse/creation, confirmation handling, voice capture/upload/polling, output layout, approvals, setup and background maintenance. A first-time setup branch was split out after confirming that it has no DONE button; the current map contains 89 states.

The page is a model, not a firmware emulator. Its observer buttons represent conditions, not controls on the actual device. Source inspection found several optimistic shortcuts in that model; those were corrected before using it for this proposal. Native probes compile actual extracted firmware code with small boundary stubs, and call the real gateway output projection with synthetic text. They do not execute on the ESP32, measure touch latency or prove radio behavior.

- **Reproduced code defect:** the actual extracted branch/function fails the stated fixture.
- **Confirmed source defect / behavior:** directly established by implementation or cross-boundary projection; not newly exercised on hardware.
- **Conditional risk:** a specific precondition or input path needs physical/fault-injection reproduction before estimating frequency.
- **Intentional boundary:** supported console handoff or capability limit; a UX opportunity, not a broken authentication model.

Run the read-only historical baseline probes from the repository root (these deliberately load `359bfdd`; current regressions are in `test/firmware-*.test.mjs`):

```bash
node docs/device-flow/review/reproduce.mjs
```

See [probe evidence](evidence.json), [browser journey walk](journey-walkthrough.json), and the interactive page’s **Audit & proposed flow** tab.

## What should stay

Retain the black canvas, grayscale hierarchy, violet `#b7a8ff` signal, existing logo, fixed-width device type, orb vocabulary and bounded animations. Retain hold-to-record/release-to-keep, the explicit Send step, account/environment/capture destination isolation, worker/render separation, context/revision guards, durable mutation IDs, authenticated outbound connector routing, TLS validation and distinct blocking request types.

Every control remains capability- and profile-gated: a read-only device must never gain decision or Stop authority from the new layout. Show an unavailable reason when appropriate; apply the current ownership, environment and request checks again when work executes.

The visual language already provides enough identity. Product quality comes from consistent semantics, reliable touch targets and clear consequences—not an iOS-looking skin. An orb may explain activity, but cannot replace a readable destination, request state or next action. Emoji, color or motion alone must never carry critical meaning. Do not promise haptics or spoken replies without verified hardware support.

## Findings and priorities

P1 findings should be resolved before qualifying the interface as reliable. P2 findings affect usability, recovery or correct interpretation. These are product-review priorities, not claims of security exploits.

### B01 · P1 · The hidden microphone still accepts a press

**Classification:** Reproduced code defect.

**Trigger:** During a voice journey, with the worker idle between polls, press where the microphone used to be.

**Current consequence:** The Press handler calls startRecording even though the microphone is not rendered. beginCapture resets the earlier job/cursor tracking; that earlier job may still execute on the server.

**Proposal:** An invisible or unavailable control must have no hit target. Admit a new capture only in the explicit ready-to-record state. Keep the active request separate from the next draft.

**Evidence and limits:** Native probe compiles the actual Press branch with boundary stubs: a journey-active fixture still calls startRecording once. Hardware reproduction not performed.

Source: `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:3609`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2818`; `firmware/shared/NextCoderCore/src/GatewayVoice.cpp:77`.

### B02 · P1 · A complete one-page reply can lose text

**Classification:** Reproduced code defect.

**Trigger:** A valid three-line, 31-column gateway page requires seven lines after Hosyond wraps it to 19 columns.

**Current consequence:** paintResponse keeps only six lines. The gateway says one page and truncated=false; the last line is unreachable and the user sees no warning.

**Proposal:** Paginate after wrapping for the actual device profile, or support bounded local subpages. Never discard unread text silently.

**Evidence and limits:** Real gateway projection + native actual wrapText probe: 1 gateway page, 7 required device lines, 6 displayed lines.

Source: `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:1888`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:1913`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui_paint.cpp:126`; `src/deviceThreadOutput.mjs:5`.

### B03 · P2 · Long-reply truncation is not communicated

**Classification:** Confirmed source defect.

**Trigger:** An answer exceeds the gateway’s 12-page cap.

**Current consequence:** The gateway returns truncated=true, but ThreadResponse has no such field and the firmware does not decode/render it. A partial answer looks complete.

**Proposal:** Keep the cap, but show “More in console” with a clear continuation route. Distinguish turn complete from full text displayed.

**Evidence and limits:** Synthetic long reply returns 12 pages and truncated=true. Flag omission confirmed by source; no native decode execution.

Source: `src/deviceThreadOutput.mjs:85`; `firmware/shared/NextCoderCore/src/OperateModel.h:167`; `firmware/shared/NextCoderCore/src/GatewayOperate.cpp:935`.

### B04 · P2 · Malformed reply data can hide the Retry action

**Classification:** Conditional source defect.

**Trigger:** After loading several pages, a subsequent HTTP-success response contains bad JSON or no response object.

**Current consequence:** Those error branches retain the previous pageCount. Footer priority chooses PREV/NEXT before checking error, hiding RETRY. Automatic retry still exists; this is a missing manual recovery affordance, not total loss of recovery.

**Proposal:** Error recovery outranks pagination. Retain the last readable content and show a local Retry reply action.

**Evidence and limits:** Source branch/precedence inspection. Ordinary non-2xx errors reset pageCount=1 and do not have this specific problem.

Source: `firmware/shared/NextCoderCore/src/GatewayOperate.cpp:909`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2393`.

### B05 · P2 · A policy approval is described as a wording problem

**Classification:** Confirmed contract mismatch.

**Trigger:** A successfully transcribed voice note is stopped by gateway policy.

**Current consequence:** approval_required projects to Review; firmware then says “Check the wording in the console,” although the required action is authorizing a command, not editing speech.

**Proposal:** Expose distinct reasons: transcript review, gateway approval, provider permission, or agent question. Route the user to the matching decision.

**Evidence and limits:** Deterministic projection and fixed renderer wording inspected; no live policy-triggering command was sent.

Source: `src/deviceAudio.mjs:57`; `firmware/shared/NextCoderCore/src/GatewayVoice.cpp:251`.

### B06 · P1 · A short finger drift can change the activated target

**Classification:** Source-confirmed interaction risk.

**Trigger:** Press near one control boundary and lift over a neighboring control while remaining within the touch parser’s tap slop.

**Current consequence:** The UI does not retain the non-microphone pressed target. Tap activation uses release coordinates. For adjacent confirmation actions, this makes intent less reliable.

**Proposal:** Capture target identity on touch-down; highlight it immediately; cancel activation when the finger leaves its permitted region. Never activate another target on the same contact.

**Evidence and limits:** Routing is confirmed by source. An accidental neighboring activation on hardware is a risk to reproduce, not an observed incident.

Source: `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/touch.cpp:202`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:3609`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:3272`.

### B07 · P2 · Reset promises less than it actually clears

**Classification:** Confirmed source copy defect.

**Trigger:** Choose RE-PROVISION or hold BOOT for ten seconds.

**Current consequence:** The UI says Wi-Fi only. The store also clears the config cache, claim code and pending receipt journal. The factory identity and gateway URL survive; accepted cloud work is not cancelled.

**Proposal:** Rename to “Reset network setup”; explain the exact retained/cleared state and that running work continues. Keep a deliberate confirmation and visible physical-hold progress.

**Evidence and limits:** Store behavior compared with the on-screen copy. No reset performed during review.

Source: `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2038`; `firmware/shared/NextCoderCore/src/DeviceStore.cpp:523`.

### B08 · P2 · A populated environment list has no refresh path

**Classification:** Confirmed source refresh gap.

**Trigger:** Load environments, then add or rename an environment in the console while the list remains nonempty.

**Current consequence:** Entry refresh is gated on an empty list, and RELOAD is offered only when empty. The board-local browse cache can keep showing the old environment list.

**Proposal:** Offer Refresh for every browse state, retain rows while refreshing, and report last confirmed freshness. Swiping between levels must not be required to recover.

**Evidence and limits:** Call-site and action-availability inspection; a live new-environment experiment was not performed.

Source: `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2373`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:3318`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:3440`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:3000`.

### U01 · P2 · Choosing a thread has different meanings in different places

**Classification:** Confirmed confusing behavior.

**Trigger:** Pick a thread from the list versus swiping Home versus creating one.

**Current consequence:** List selection opens Send; Home OPEN opens the reply; creation stays on its current screen. “Choose thread” sometimes feels like “start recording,” without an explicit choice.

**Proposal:** All confirmed selections return to the same Thread view. From there, explicitly choose Talk, Actions or Read reply. Keep creation a separate visible entry.

**Evidence and limits:** Source confirmed; earlier atlas shortcuts were corrected during this audit.

Source: `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2919`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:3301`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2950`.

### U02 · P2 · A swipe changes the execution destination after a timer

**Classification:** Confirmed confusing behavior.

**Trigger:** Swipe through Home’s thread picker and pause for 600 ms.

**Current consequence:** A local preview becomes a persisted binding. The preview message helps, but it is still easy to confuse browsing with committing the next voice/action destination.

**Proposal:** Make the destination a visible button. Browse freely in the chooser; commit with “Use thread.” A horizontal shortcut may preview, but cannot silently retarget.

**Evidence and limits:** 600 ms debounce and guarded commit are present. No wrong-thread execution was observed; the concern is intent clarity.

Source: `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2859`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:3390`.

### U03 · P1 · Terminal voice states leave no on-screen next action

**Classification:** Confirmed recovery gap.

**Trigger:** Transcription fails, needs review, times out, or finishes with auto-send off.

**Current consequence:** The full-page journey suppresses footer controls. The user must discover Back and often manually find the right console item. “Review” and “Ready” do not imply device-side editing/sending.

**Proposal:** Every terminal/waiting result has an explicit route: Record again, Resume status, Review in console, Open thread, or Back. Retry acts on the original job only when that operation is safe.

**Evidence and limits:** Source confirmed; lack of a local action is a product limitation, not evidence of failed transcription.

Source: `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:1695`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2380`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2550`; `firmware/shared/NextCoderCore/src/GatewayVoice.cpp:188`.

### U04 · P2 · Most buttons do not acknowledge the initial touch

**Classification:** Confirmed feedback gap.

**Trigger:** Touch and hold a non-microphone button or row before releasing.

**Current consequence:** Press records drag ownership, but there is no general pressed-target visual state. The interface acknowledges mainly on Tap/release. A slow network job then replaces the footer with a disabled WORKING label.

**Proposal:** Pressed highlight within the next eligible frame; cancel-on-drag; immediate local activation feedback; then a truthful request state that is independent of network completion.

**Evidence and limits:** Source inspection; exact physical touch-to-photon latency has not been measured in this audit.

Source: `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:3609`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2301`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui_paint.cpp:155`.

### U05 · P2 · Responsive animation can hide an input lockout

**Classification:** Confirmed control availability gap.

**Trigger:** A queued UI network request takes several seconds.

**Current consequence:** Only header Back is honored while the worker is busy; drawer and other controls are ignored. Separately, a failed tryLockState(0) drops a discrete touch event instead of queuing it. The orb may animate while input feels lost; Stop is not immediately reachable through navigation. The frequency of lock-related misses needs measurement.

**Proposal:** Keep local navigation responsive, retain bounded discrete input until it can be validated, show what is pending, and give Stop a deliberate, serialized path. Do not run concurrent writes or pretend leaving the screen cancels accepted work.

**Evidence and limits:** Source confirmed. Retain duplicate-mutation suppression; improve availability without breaking its invariant.

Source: `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:3594`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2499`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2301`.

### U06 · P2 · An empty action library is almost invisible from Home

**Classification:** Confirmed discovery gap.

**Trigger:** The owner has not assigned any controls.

**Current consequence:** Home hides ACTIONS when controlCount is zero. The helpful “None assigned” message exists inside Actions, but normal Home navigation offers no entry to that state. Audio action rows also say HOLD although the actual microphone lives elsewhere.

**Proposal:** Keep Actions visible with a meaningful empty state and console setup route. Audio rows open the recording flow; unsupported image controls remain clearly disabled.

**Evidence and limits:** Source confirmed. Action authoring remains in the console; adding an on-device editor is not proposed.

Source: `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2359`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:1835`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2667`.

### U07 · P2 · Provider permissions and questions strand remote users

**Classification:** Intentional boundary with weak handoff.

**Trigger:** The coding agent asks permission or needs an answer.

**Current consequence:** Hosyond truthfully reports the blocker, but only provides generic console instructions. Mixed gateway/provider queues can make “All clear” easy to misread if the distinctions are not understood.

**Proposal:** A Needs you inbox with explicit request type and target. Support only bounded, fully explainable decisions on device; otherwise provide an authenticated console continuation. Persistent grants and free text stay on the console.

**Evidence and limits:** This is a current capability limit, not an authentication bug. No backend answerability flag can substitute for a real board UI.

Source: `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:1950`; `firmware/shared/NextCoderCore/src/GatewayOperate.cpp:995`.

### U08 · P2 · Approving a gateway hold does not lead to its result

**Classification:** Confirmed completion-flow gap.

**Trigger:** Approve the final pending gateway command.

**Current consequence:** answerApproval updates a message and refresh scheduling, but never calls afterDispatch or opens its reply cursor. The queue may become All clear while the agent starts work elsewhere.

**Proposal:** Bind the approval result to the same request timeline. Show Running / View reply for that command, without stealing navigation if the user left.

**Evidence and limits:** Source confirmed; the atlas originally drew an automatic transition and now labels the manual navigation requirement.

Source: `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:3060`; `firmware/shared/NextCoderCore/src/GatewayOperate.cpp:1040`.

### U09 · P2 · Retained audio and current destination can disagree visually

**Classification:** Confirmed destination presentation gap.

**Trigger:** Keep a recording, navigate elsewhere, then change the selected thread.

**Current consequence:** The capture is correctly pinned to its original destination and SEND rejects a mismatch. But the visible destination painter uses the current thread, and the global SEND/DISCARD footer can appear away from the recorder.

**Proposal:** A bounded draft strip always names the recording’s original thread. “Resume recording” / Discard remain explicit; Send is disabled with a reason until the destination is resolved.

**Evidence and limits:** Source confirmed. The guard prevents silent redirection; the bug is misleading presentation, not demonstrated cross-thread dispatch.

Source: `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:1792`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2329`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2723`.

### U10 · P2 · Setup, claim renewal and recovery ask users to guess consequences

**Classification:** Confirmed setup/recovery friction.

**Trigger:** New setup, a failed claim, loss of connection, revoked access or firmware maintenance.

**Current consequence:** The same setup/status surface spans many causes. Claim-code taps replace an in-use code. First-time provisioning does not have the same DONE contract as an already-configured portal. A network reset cannot repair missing factory identity or revoked credentials.

**Proposal:** A short guided setup with explicit network → account claim → machine readiness. Name the failing layer and next action. Put claim replacement behind an explicit New code review; separate network reset, account access and service repair.

**Evidence and limits:** Source confirmed boundaries; new router/OTA/revoke experiments were not performed.

Source: `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:1345`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:3468`; `firmware/shared/NextCoderCore/src/Provisioning.cpp:110`; `firmware/shared/NextCoderCore/src/GatewayOta.cpp:164`.

### U11 · P2 · Reading a reply is a fragile place to continue the conversation

**Classification:** Confirmed reading/navigation friction.

**Trigger:** Read a reply, retry a failed read, create into an unconfigured folder, or resolve an uncertain write.

**Current consequence:** Completed single-page replies offer no Talk/Actions footer; page cycling wraps; output is only a compact latest assistant projection. Generic Retry and error text can obscure whether work was ever sent.

**Proposal:** Keep the Thread view stable around the latest request. Show Read reply / Talk / Actions in predictable places, page boundaries with position, typed recovery, full-answer handoff, and explicit “outcome unknown” receipt checks.

**Evidence and limits:** Source confirmed. Never convert reply retry or receipt reconciliation into resending a command.

Source: `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:2390`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:3150`; `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:1890`; `firmware/shared/NextCoderCore/src/GatewayDeviceRequest.h:32`.

## Proposed user flow

The everyday experience has six places. Their request substates remain explicit; reducing navigation does not mean collapsing “sent,” “working,” “waiting for approval” and “complete.”

1. **Thread** is the anchor. It names the laptop/folder/thread, shows the current request or latest reply, and offers Talk and Actions. A visible destination control opens the chooser. An actionable Needs you indicator appears when necessary. A completed reply keeps the same conversation context; there is no empty end screen that forces the user to rediscover Talk.
2. **Choose destination** is a bounded environment → folder → thread stack. Each level has clear Back and Refresh. Moving through choices changes only a preview. Use thread commits once, after server confirmation. New thread is a visible action; readiness checks explain a missing folder model before offering creation. Creation returns to the same Thread surface. Avoid undocumented swipe/timer commitments.
3. **Voice** is one short, direct sequence: touch-down records; lift holds the clip; the clip names its original destination; Send is explicit. Discard clears local PCM. Back leaves a clearly named retained draft, with Resume and Discard. RAM-held audio is not promised to survive reboot. A changed selected thread cannot relabel the recording as if it belonged there; sending remains disabled until resolved. A sent recording becomes a request; it is no longer a draft and is never “discarded” by leaving a view.
4. **Actions** always has an entry, even when empty. Setup stays in the console; the empty state says how to assign an action. An audio action enters recording rather than telling users to find an unrelated hidden microphone. Normal action review names verb, destination and scope; the final button names the operation. Stop remains distinct from Back. Local review does not grant gateway/provider permission by implication.
5. **Needs you** lists the three real blockers: gateway policy hold, provider permission and agent question. View request is side-effect-free. Not now leaves pending. Approve/Reject affect exactly that current request; a consequential denial gets deliberate review too. The final approval binds back to the same request timeline. Provider persistent/session grants, long/truncated security details, transcript edits and free-text questions remain in the console. A future device implementation may handle only fully explainable, bounded decisions with explicit scopes and current-request checks.
6. **Settings and guided setup** contain infrequent repairs. Setup is network → ownership claim → connected machine → first usable thread. Network setup, account access, cloud reachability and missing factory identity have different remedies. Claim replacement is an explicit New code action with an explanation. Reset network setup explains precisely what is cleared/kept and that accepted cloud work continues. OTA stays dashboard-authorized; the page does not invent a Hosyond update-accept button.

### One durable request story

A user should be able to answer: where did I send this, did the service accept it, what is it waiting for, and where is its reply? Use one bounded request reference across navigation and reconnect. Keep the original command/job/cursor identity; persist minimum identifiers rather than audio, prompts or transcripts in a new long-lived cache. The existing single uncertain receipt must not be overwritten by a new send.

Present the supported phases: local recording → retained draft → upload → accepted → local transcription / waiting for computer → dispatched / needs a decision → agent running → reply ready / failed. Only show a phase that the current contract proves. Fine-grained computer/ASR phases may require a contract addition; an elapsed timer is not proof. A truthful “status unavailable” is preferable to a guessed “transcribing” or “working.”

Leaving a view never cancels accepted work. Background completion can update a thread indicator, but must not steal another screen or change the selected destination. View request restores the last authoritative phase. If the user remains on the relevant Thread, reply arrival can update its content without a disruptive full-screen navigation.

### Typed recovery, not a universal Retry

| Situation | User action | Operation | Must not happen |
|---|---|---|---|
| Upload not finalized | Retry upload | Resume the original verified upload session/capture | Create an unrelated second capture/turn |
| Job status GET failed | Resume status | Poll the same owned job within bounds | Replay accepted audio or dispatch |
| Reply unavailable | Retry reply | GET the original thread/cursor/page | Send the prompt again |
| Send outcome uncertain | Check request status | Resolve original durable receipt | Replace its identity or imply failure |
| Known terminal speech failure | Review/retry safely, or Record again | Explicit action consistent with the job’s dispatch evidence | Silently execute an old recording |
| Needs transcript review | Review in console | Continue to the exact owned media/job | Mislabel it as an agent approval |
| Computer offline | Check connection / safe Back | Observe connector readiness and reconcile later | Claim the cloud can wake it or that work completed |

### How it should feel under a finger

Touch-down selects a single visible target and changes its local pressed state immediately. The target’s identity remains captured for the contact. A drag into scrolling cancels activation; a release over a neighbor never activates that neighbor. Moving outside the original hit region cancels or suspends its activation according to one consistent slop rule. The same contract applies to Run, Reject, row selection and reply suggestions. The microphone is the specialized exception: contact deliberately starts local capture, and release stops it.

Scrolling follows the finger in a locked axis. The list and its row targets stay in one coordinate system; a drag is never a tap afterward. Investigate a small bounded deceleration on real hardware; do not add elastic motion that outruns the frame budget or changes a selection. Visible Back and destination controls carry essential navigation; swipes are shortcuts. Dismissal remains local, and long press outside the microphone does not invoke surprising setup.

Feedback communicates three different moments: **I touched it**, **the request was accepted**, and **the work finished**. Only the first two should be expected quickly; remote execution can take time. Show the exact pending operation, not a global disabled WORKING surface. Local navigation and rendering should remain available. Stop must have a deliberate serialized path without introducing concurrent or duplicate writes.

## Touch and motion acceptance targets

The current source aims at 33 ms frames (about 30 fps), with drawer opening/closing at 220/150 ms and a 170 ms footer transition. Those are implementation constants, not measured touch-to-photon latency. First make 30 fps consistent; a 60/120 Hz phone promise would be unsupported on this hardware.

Apple’s [gesture guidance](https://developer.apple.com/design/human-interface-guidelines/gestures) emphasizes predictable feedback during interaction; its [button guidance](https://developer.apple.com/design/human-interface-guidelines/buttons) calls for feedback when an action takes time. The targets below are our proposed Hosyond budgets, not Apple guarantees or measurements of current firmware.

| Interaction | Current evidence | Proposed contract |
|---|---|---|
| Touch-down | Most non-mic controls have no retained pressed visual state. | Capture one target; acknowledge its contact in the next eligible frame, p95 ≤50 ms. Use a local grayscale/violet change, not a large scale animation. |
| Release / drag-away | Tap activates by release position; scrolling and activation are separate code paths. | Release inside the captured target activates once; drag out cancels it. An adjacent control can never inherit the same contact. |
| Scrolling | Lists follow drag deltas; hard bounds, no momentum model is evident. | Track the finger directly with axis lock. A short, bounded deceleration may be tested; no rubber-band spectacle or accidental row activation. |
| Navigation | Hidden drawer plus mode-dependent horizontal swipes; 600 ms thread bind timer. | Visible destination control and Back. Browse without side effects; commit explicitly. Suggested transition 150–220 ms, interruptible. |
| Button action | A busy worker disables nearly all input. | Local acknowledgement ≤100 ms p95; background work never gates a harmless local Back. Show the specific operation, not a generic global freeze. |
| Recording | Recording begins on contact; lift holds PCM. | Keep this directness. Show RECORDING in text plus existing accent, an immediately advancing timer, and a stable target. No upload before Send. |
| Network wait | Voice/status can stay on a full-page orb with no next action. | Separate local capture, upload acceptance, computer availability, speech processing, agent execution and reply. Only show a phase supported by evidence. |
| Long waits | A successful voice round trip previously took about 43 s; that is observed total time, not render latency. | At ~1 s show the concrete ongoing activity; at several seconds explain the dependency and safe exit. No fake percent or fabricated ETA. |
| Confirmation | CANCEL/RUN, CANCEL/APPROVE; REJECT is immediate. | Name the action and original thread, use one explicit final verb, keep Not now separate from Reject, and retain distinct local versus gateway/provider authorization. |
| Reply | 31-column gateway page is rewrapped to 19 columns and clipped at six lines. | Paginate after device layout, preserve all accessible text, expose truncation, retain a stable request-to-reply identity. |
| Failure | Some outcomes require Back and a generic console handoff. | Keep context visible. Offer exactly the correct recovery: Retry upload, Retry reply, Check request status, Record again, or Review in console. |
| Frame pacing | Source frame budget is 33 ms (about 30 fps); existing drawer timings are 220/150 ms. | First qualify steady 30 fps: p95 frame ≤33 ms, p99 gap ≤66 ms as a proposed normal-interaction target. Measure recording separately. Do not promise 60/120 Hz on this board. |
| Touch size / readability | Logical panel is 240×320; firmware footer visual button height is 36 px with a generous hit band. | Start with ≥44 logical-pixel hit areas where feasible, verify physical thumb usability and spacing on Hosyond, and never equate panel pixels with iPhone points. Prefer two consequential footer choices. |
| Brand / accessibility | Black/gray canvas, #b7a8ff accent, existing orb and fixed-width device typography. | Keep logo, palette, typography and orb semantics. No new mascot, emoji status language, glass blur, sound-only feedback or unverified haptic promise. Text carries meaning; motion can be reduced. |

## Measurement and qualification plan

Instrument the actual controller with monotonic timestamps for raw touch observation, gesture classification, target capture, first changed pixels/blit, activation, worker enqueue, gateway acknowledgement, each voice phase, reply receipt and first reply render. Record normal operation and active capture separately. Trace with bounded/redacted metadata; no ambient audio, transcripts, prompts, secrets or provider text in diagnostics.

Use the physical display to correlate touch and pixels, ideally with a high-frame-rate camera. Report p50/p95/p99 and worst gaps, not just average FPS. A smooth orb does not prove responsive input. Proposed normal-interaction goals: p95 touch feedback ≤50 ms, p95 local activation feedback ≤100 ms, p95 frame time ≤33 ms, p99 frame gap ≤66 ms. If measurements disprove the budget, reduce work/motion before changing the promise. First-pairing model downloads and agent generation are separate latency budgets with truthful status, not failures of the 50 ms touch budget.

A starting physical qualification workload: 50 intentional taps, 50 drag-away cancellations and 50 double taps around adjacent consequential controls; list drags across row boundaries; 20 short/long voice notes during concurrent network activity; at least 10 disconnect/reconnect/sleep-recovery cycles; and a 30-minute mixed interaction soak. Require zero unintended activations and zero duplicate agent turns in that workload. These counts are proposed gates, not statistical proof of all hardware behavior. Verify memory, dropped samples, frame gaps and battery/CPU implications before adding inertia, haptics or more animation.

Test all decisive branches: absent microphone, too-short/silent/read-failed capture, retained upload after 413/429/5xx, lost finalize response, job timeout, revoked credential, frozen destination mismatch, stale local confirmation, denied gateway command, gateway/provider/input mixed blockers, malformed multi-page output, overlong replies, receipt processing/unknown, failed create and OTA rollback/health. Preserve the existing secure and shared-core boundaries.

## Coverage of every existing journey

| Journey | Findings | Simpler flow |
|---|---|---|
| Saved action → reply | B06, U04, U05, U11 | Keep local review; name target and pending phase; carry one request into its reply. |
| Voice → local Parakeet → T3 | B01, B02, B05, U03, U09 | One capture/draft/job/request identity; immediate record feedback; explicit processing phases and result. |
| First-time setup & claim | B07, U10 | Guided steps, clear failing layer, safe code replacement, correct first-time portal behavior. |
| Select environment, folder, thread | B08, U01, U02 | Explicit chooser and one commit; every list can refresh. |
| Create a new thread | U01, U11 | Check folder readiness before create; return consistently to Thread after confirmed creation. |
| Configure and run a saved action | B06, U04, U06 | Author in console, assign, acknowledge on device; discoverable empty state. |
| Gateway approve vs reject | B06, U07, U08 | Request-specific review, deliberate denial, pending preserved on dismiss, then the same request result. |
| Provider approval handoff | U07, U05 | Separate provider request; precise console continuation or bounded one-time decision in a future phase. |
| Agent question handoff | U07 | Value/choice input is its own request; no invented approval dialog. |
| Reply retry without duplicate turn | B04, U11 | Retry reply GET; keep command identity and last readable content. |
| Upload recovery preserves clip | U03, U09 | Retain exact clip; distinguish Retry upload from Record again. |
| Voice requires transcript review | B05, U03, U07 | Explain why review is needed and continue to the exact recording in console. |
| Laptop sleeps during voice job | U03, U05, U10 | Show cloud online / computer unavailable using evidence; reconnect without duplicate work. |
| Cancel and reject are different | B06, U07, U08 | Not now leaves pending; Reject is an explicit decision with review. |
| Connection recovery | U05, U10, U11 | Preserve context and request identity; reconcile authoritatively after recovery. |
| Stale action confirmation | B06, U02 | Retain current context/revision guards; return to a meaningful current action summary. |
| Stop a turn | B06, U05 | A distinct Stop operation with confirmation, accurate scope and a reachable pending-result state. |
| Leave a held recording and return | B01, U09 | Visible original-target draft; SEND reopens Send today; background completion never steals another view. |
| Re-provision safely | B07, U10 | Clear recovery language, hold progress and exact data consequences; no implication that cloud work is cancelled. |

### Corrections to the earlier atlas

The original page was an explanatory sketch and drew several convenient transitions that are not automatic in firmware. This audit corrects them: thread-list selection opens Send; thread creation stays on its originating screen; approval answering stays on Approvals unless the user navigates; sending a retained clip explicitly reopens Send; a voice policy hold is projected as Review; and first-time setup does not expose the configured portal’s DONE action. The new proposal is isolated from the current-flow explorer and labeled as a candidate.

The reproduction identified another possible-sounding issue that needed narrowing: normal non-2xx reply errors reset pageCount to 1, so they do expose Retry. Only malformed/invalid HTTP-success response branches retain the old page count and can hide it. Likewise, retained-capture destination guards already prevent silent redirection; this review identifies misleading labels, not an observed wrong-thread send.

## Implementation sequence after design review

1. Review the six-surface model, terms, destination commitment, request timeline, drafts, typed recovery and console boundaries in the candidate storyboard.
2. Reproduce and fix correctness first: hidden capture target, pressed-target ownership, reply layout/truncation, reason-specific voice review, accurate reset copy, and populated-list refresh. Add focused native/contract regressions for these actual defects.
3. Implement the interaction model in small, reviewable changes. Shared transport/state belongs in NextCoderCore; Hosyond owns touch/layout. Add contract fields only where the new truthful states require them. Cover memory/file/Convex and all relevant surfaces if the contract changes.
4. Measure the actual board before/after each performance-sensitive change. Qualify touch, capture, rendering and slow/lossy links together. Keep state lock/socket/inference work away from the render path; retain backpressure and bounded retries.
5. Run the appropriate repository gates and secure board builds. Test real account-scoped device → cloud → local connector → T3 → device paths, with separate evidence for screens, gestures, audio, network and physical recovery. Build coverage on other boards is not equivalent silicon proof.
6. Release and flash only as a later authorized implementation step. The current review has not changed or deployed firmware.


## Review-artifact validation

The corrected current model resolves all references (89 states, 257 transitions). Every one of its
19 journeys was walked again after the corrections. All eight candidate tours rendered to their
final frames. Direct prototype checks confirmed that approval remains “Sending approval,” a lost
reply becomes “Refreshing reply,” and uncertain delivery becomes “Checking original request”
before any simulated external result. Returning to a request restores its observed phase.

P1 and reproduced-evidence filters returned four and two findings respectively. The native source
probes and gateway synthetic projections passed. JavaScript syntax and model-reference checks,
phone/desktop layout inspection, browser error-log inspection and git diff whitespace checks
passed. Deep links to the review and its subsections work; temporary viewport overrides were reset.

No full product npm test or firmware build was run for these documentation/prototype edits.
No new physical touch, audio, radio, T3, performance or OTA qualification is claimed. The firmware,
services and production deployment are unchanged.
