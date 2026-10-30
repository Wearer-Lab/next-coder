# Device interaction atlas

This atlas preserves the reviewed **0.2.18 baseline**. The approved repair is implemented in
0.2.19; see [implementation and verification](review/IMPLEMENTATION.md). Its baseline screen
walkthroughs deliberately retain the old behavior for comparison.

An interactive, standalone study of the firmware as of source `359bfdd` (October 23, 2026), focused
on Hosyond 0.2.18. Open `index.html` through a local HTTP server because it uses JavaScript modules:

```bash
python3 -m http.server 8765 --bind 127.0.0.1 --directory docs/device-flow
```

Then open <http://127.0.0.1:8765>. No dependencies, build, authentication or production connection.
The page never requests microphone access, captures audio, calls gateway APIs or dispatches commands.
All device content, claim codes, folders and action labels are explicit examples. Source anchors and
physical evidence are kept separate. The visual reconstruction uses the firmware's 240×320 logical
aspect ratio and grayscale/violet palette, but is not a screenshot or a C++ emulator.

## Explore

- **Audit & proposed flow:** ranked source-backed findings, a separate candidate storyboard,
  touch/motion budgets, all-journey coverage and an implementation qualification plan. Read
  [the full review](review/REPORT.md); current firmware behavior and proposed behavior stay separate.

- **Explore device:** 19 finite animated walkthroughs, clickable device controls, header drawer,
  Back, destination/paging swipes, simulated microphone hold/release, physical BOOT controls,
  observer-driven outcomes and navigation history. Playback stops on manual input, when hidden,
  and at the end; reduced-motion preferences disable decorative transition animation.
- **Flow map:** every authored state and transition; click a node to inspect it. Solid curves are
  device inputs; dashed curves are external outcomes/conditions. Download the model as JSON.
- **Every interaction:** searchable controls/outcomes plus common gesture rules. Header/physical
  navigation is factored out rather than duplicated as edges on every state.
- **Other devices:** capabilities and input differences, with honest compile-only limitations.
- **Evidence & limits:** observed hardware paths, service boundaries and open UX questions.

`model.js` owns the state/transition data; `app.js` renders and navigates it; `style.css` owns the study
layout. The simulation uses representative outcomes chosen by the reader; no random faults, synthetic
production telemetry, or claimed live data. Playback timing is illustrative, not measured network time.

## Source and coverage ledger

| Surface | Implementation / anchors | Included behavior |
|---|---|---|
| Hosyond screen taxonomy | `firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src/ui.cpp:171` | Status, Home, Threads, Send, Actions, Response, Approvals, Environments, Projects, Device, Gateway; three modal variants |
| Contextual footer | `ui.cpp:2301` | Precedence: busy → portal → modal → held clip → operability → current screen |
| Header drawer | `ui.cpp:3073`, `ui.cpp:3458` | Device/Gateway/Thread/Activity, conditional approval destination, dismissal |
| Home destination | `ui.cpp:1178`, `ui.cpp:2859`, `ui.cpp:3390` | OPEN/CHOOSE/CREATE, 600 ms binding debounce, virtual creation slot, first/last boundaries |
| Browse and create | `ui.cpp:2893–3060`, shared `GatewayBrowse.cpp` | Lists/empty/reload, binding validation, cleared lower context, failed create retains old binding, single returned-ID adoption |
| Assigned actions | `ui.cpp:2590–2688` | Enabled/reason/thread/media gates, stop/reset confirmation, action/layout/context rechecks, compact response vs agent reply |
| Confirmation/denial | `ui.cpp:3060–3268` | CANCEL leaves hold pending; gateway REJECT is immediate; APPROVE has second dialog; RUN is local control confirmation |
| Voice capture | `ui.cpp:2690–2856`, board `audio.cpp`, example config | Contact/lift, minimum/no-signal/read failures, held PCM, discard/send, frozen destination, default limits |
| Upload and voice polling | shared `MediaUpload.cpp`, `GatewayVoice.cpp`, `ui.cpp:4130` | Same-session exact replay, retained failed upload, 2-second nominal job polling with bounded backoff / ten-minute observation limit, Review/Ready/Failed, Sent opens immutable reply cursor |
| Local ASR and dispatch | `src/transcription.mjs`, `src/mediaJobs.mjs`, `src/deviceAudio.mjs`, `packages/connector/src/localTranscription.mjs` | Owner/environment/lease routing, local Parakeet, auto-send/review, profile/policy recheck, stable dispatch identity |
| Reply | `ui.cpp:1890`, `ui.cpp:2522`, `ui.cpp:3130–3169` | Newer-than-cursor loading, streaming, finished single-page no footer, paging wrap, two follow-ups, GET-only retry, failure and stale results |
| Blocking requests | `ui.cpp:1950`, `src/providerApprovals.mjs`, `src/userInput.mjs` | Distinct gateway hold, provider permission, value/choice request; Hosyond remote requests currently hand off to console |
| Touch routing | `ui.cpp:3458–3698`, board `touch.cpp` | Axis ownership, list scroll, release-only swipe, ignored generic long press, duplicate suppression, Back during worker |
| Wi-Fi/claim/trust | shared `Provisioning.cpp`, `DeviceStore.cpp`, `GatewayClient.cpp`, board `main.cpp:108` | Candidate join/cancel, last-good recovery, missing factory identity, claim rotation/expiry, revoked and unreachable, BOOT tap/10-second hold |
| Background lifecycle | shared `GatewayOta.cpp`, `GatewayClient.cpp` | Dashboard-authorized automatic OTA, compile gate/signature/board/hash, reboot/health recovery, credential maintenance; no invented Hosyond update button |
| Other boards | CrowPanel `src/main.cpp:143`, T190 `README.md`, Waveshare `README.md` | Input contracts, optional capability gates and source/physical limitations |

Paths shortened to `ui.cpp` in the table refer to the Hosyond board's `src/ui.cpp`. Line numbers
refer to the recorded source snapshot and can move in later revisions. The old firmware audit's
“transcription disabled” text is historical: `roadmap/IMPLEMENTATION-STATUS.md` records the current
connector-local production implementation and physical voice proof.

## Deliberate limits

This maps user-visible interaction and relevant background boundaries; it does not claim exhaustive
execution of every C++ branch, each provider-specific permission dialect, production outage case or
peripheral. Simulated observer controls do not become proposed device buttons. The full map factors
repeated status/Back/physical navigation into the shared inventory and uses example list contents;
actual counts, grants, controls, names, page contents and available capabilities are server-dependent.

A read reply is not an editable conversation history. Creating/configuring saved actions, pairing,
claiming, grant/profile changes, transcript editing, provider approvals and agent questions remain
console workflows where the Hosyond implementation hands off. Server API support alone does not
prove that a board has a matching input UI. CrowPanel/T190/Waveshare are compared, not presented as
hardware-equivalent Hosyond simulators.

No gateway, storage, protocol, console production routes, connector, or firmware behavior is changed
by this documentation artifact. It does not need a firmware build or a production deployment.

## Verification of this artifact (October 23)

- JavaScript syntax checks passed for both modules; all state IDs are unique and all control,
  outcome and guided-journey references resolve: **88 states, 254 modeled transitions, 19 journeys**.
- Browser UI navigation rendered every one of the 88 states. Saved-action review, gateway
  approve/cancel/reject distinctions, response page movement, inventory filtering, retained upload
  recovery, retained clip after Back and the restricted unclaimed drawer were exercised.
- A short microphone keyboard press reached the too-short branch. Positive clip release was
  exercised through the explicitly labeled simulation outcome, not a real microphone. Actual browser
  long-hold timing was not separately qualified.
- Animated voice playback progressed to its final reply and stopped; graph journey filtering and
  JSON download were verified (88 exported states and 19 journeys). Browser error log was empty.
- Layout inspected at 390×844 and 1280×900; no outer horizontal overflow was observed. Full graph
  and inventory tables deliberately scroll within their containers. Temporary viewport overrides
  were reset after inspection.
- Static source scan found no fetch/XHR/WebSocket/EventSource/getUserMedia, persistent browser
  storage, eval or interval-polling calls. Approximately 79 KB of uncompressed documentation assets;
  playback is finite, history is capped at 80 steps and animations respect reduced motion.
- `git diff --check` passed. The repository product suite and firmware builds were not rerun:
  only standalone documentation assets and the README link changed. This artifact adds no new
  hardware, radio, provider, production or performance qualification.

## Interaction design review

The follow-up audit walks all 19 current journeys and records 19 findings (4 P1 priorities),
separating reproduced code defects, source-confirmed behavior, conditional risks and intentional
console handoffs. The current map has **89 states / 257 transitions** after correcting first-time
setup and several optimistic navigation shortcuts. Existing initial verification counts above
refer to the first atlas revision, before these review corrections.

`review-data.js` contains the findings, journey coverage and candidate-flow states;
`review-ui.js` renders the isolated **Audit & proposed flow** tab. The candidate prototype never
changes the current-flow model or calls the firmware. Touch budgets are proposed, not measured.
Read the [full report](review/REPORT.md), [native probe evidence](review/evidence.json) and
[browser walkthrough record](review/journey-walkthrough.json). Run the native probes from the
repository root with `node docs/device-flow/review/reproduce.mjs`.

Review validation: all 19 corrected current journeys and all eight proposed tours were walked in
the browser; native source probes and gateway synthetic projections passed. The full report
records exact checks and limits. Product runtime and firmware files remain unchanged.
