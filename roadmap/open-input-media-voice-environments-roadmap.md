# Open Input, Media, Voice, Live Threads, and Environment Roadmap

Status: **active**. Last code-and-test verification: **2026-08-27**. Milestone 0.5 is complete;
Milestones 0–5 are partial, with Milestones 2 and 3 substantially implemented. The canonical,
item-level progress ledger is
[IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md). This roadmap supersedes the
product-usability portions of
[next-coder-implementation-roadmap.md](next-coder-implementation-roadmap.md), which
remains useful for the original platform, hardware, and commercial scope.

This roadmap covers the request to make Next Coder an unrestricted, convenient control
surface for arbitrary agent requests; bring media and voice into the main composer; improve the
T3 Code connection and recovery flow; show and control the complete T3 conversation, including
approvals, user-input requests, subagents, and parallel work; and make obsolete environments easy
and safe to remove.

## Current progress snapshot

| Category | State | Progress as of 2026-08-27 |
|---|---|---|
| 1. Open request and composer | done | Operate and QuickPage share a free-form composer; actor/operation-scoped durable receipts deduplicate existing-thread sends, actions/macros, first-thread launch, device intents, and device thread creation across browser/device/gateway/connector restarts. |
| 2. Unified media | partial | The Media page and shared composer upload, record, capture, reuse, transcribe, edit, retain, and delete. Integrity-finalized raw sessions, abandoned cleanup, source provenance, and bounded on-demand previews are locally implemented; hosted lifecycle/performance proof remains. |
| 3. Voice transcription | partial | Parakeet/provider adapters, durable staged jobs, automatic device processing, transcript versions, review/auto-send, metrics, integrity-finalized raw sessions, and abandoned-session cleanup exist. Hosted worker/storage capacity and physical voice proof remain. |
| 4. Controller voice | partial | Shared upload/status/auto-send paths, Hosyond capture/display, and a locally tested scoped PWA companion for phone/browser inputs exist. Deployed phone/earbud and remaining-board physical end-to-end proof remain. |
| 5. T3 environments | partial | Typed recovery, dependency-aware archive/removal, connector-first discovery/enrollment, layered health, guided handoff, tombstone retention, and the probe-derived capability manifest exist. npm publication and deployed/live connector proof remain. |
| 6. Live T3 conversation | partial | Streamed responses/tools, provider approvals, structured user input, an evidence-limited T3-native task tree/roster, durable in-app notifications, optional Web Push, and background liveness are implemented. Deployed Web Push/live-T3/browser/device proof remains. |
| 7. Security, observability, testing | partial | Local stream, interaction, voice-job, connector, cloud-edge, control-plane, console, and focused firmware gates exist, including bounded attribution and privacy-safe telemetry. Hosted/live/physical failure and end-to-end proof remain. |

| Milestone | State |
|---|---|
| 0.5 — independent repairs | **done** |
| 0 — contracts and diagnostics | partial |
| 1 — live conversation and interaction parity | partial |
| 2 — composer and connection | substantially done |
| 3 — automatic Parakeet voice pipeline | substantially done |
| 4 — controller voice paths | partial |
| 5 — adapter hardening and rollout | partial |

Current verification gates and board-by-board evidence are maintained in
[IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md). Hosyond remains the only board with current
silicon evidence; compilation and local tests must not be presented as physical proof.

## Executive decisions

1. **Free-form requests are the default product path.** Saved actions and predefined commands stay
   available as hardware-friendly shortcuts, but they must not define what the user is allowed to
   ask an agent to do.
2. **One composer component, mounted on every surface that can send.** Text, upload, existing media,
   camera, and voice recording belong beside the Send action. Operate gets the full version and
   `QuickPage` gets a compact one — built from the same components, because a phone that can only
   approve and replay saved actions is the problem this roadmap exists to fix. The separate Media
   page remains the library and retention-management surface.
3. **Server-side transcription is the default voice path.** Keep the original audio, produce an
   immutable raw transcript plus an editable normalized transcript, and dispatch only after the
   selected review/auto-send policy is satisfied.
4. **Do not depend on direct T3 audio yet.** Current upstream T3 Code accepts image attachments in
   its typed attachment contract, not audio. Direct audio must be capability- and version-gated;
   transcription to text is the reliable baseline.
5. **Do not promise ordinary Bluetooth-earphone capture on any ESP32-S3 board.** The chip has
   Bluetooth LE but no Bluetooth Classic and no ESP-BLE-ISO/LE Audio support, so no board choice
   fixes it — the Waveshare AMOLED evaluated in Category 4 has the identical limitation. Use a
   phone/PWA with the earbuds, or a board with an on-board microphone. Treat a different
   radio/audio coprocessor as a future hardware program. In practice the earbuds were only ever a
   way to get a microphone, and an on-board array gets one without the radio problem.
6. **Environment failures need reason codes, not a generic outage string.** Milestone 0.5 shipped
   eight typed reasons covering stopped/unreachable T3, timeout, TLS, credential, and compatibility
   failures, with retryability and targeted recovery actions.
7. **“Unpair” was already a hard delete in the backend.** Milestone 0.5 replaced the ambiguous
   wording with a dependency-aware Remove flow, exact-current-label confirmation, repaired live
   references, and a credential-free recoverable tombstone with explicit retention purge. Hosted
   Queue/Cron purge and live old-socket closure remain qualification work.
8. **Connecting the first environment is part of this initiative, not a prerequisite for it.** The
   current path routes a new user to a terminal on another machine before the product does anything.
   Diagnosis and removal only matter once an environment exists; getting the first one connected is
   the step that decides whether anyone reaches the rest.
9. **The visible repairs shipped before the contract work.** Dependency-aware environment removal,
   reason-specific recovery, first-turn attachments, and multi-attachment support landed together
   as Milestone 0.5.
10. **A dispatch acknowledgement is not an agent conversation.** T3 remains the canonical source
    for thread messages, activities, session state, checkpoints, and background work. Next Coder
    must load the selected thread detail and follow its live stream until it settles;
    the local `dispatched` command is only an acknowledgement and audit link.
11. **Keep Next Coder approvals and T3 provider approvals distinct.** A gateway policy
    approval authorizes Next Coder to dispatch a command. A T3 approval answers a provider
    request that occurred after dispatch. Give both visible source labels, different stable IDs,
    and separate response endpoints even when they appear in one pending-interactions area.
12. **Expose T3-native subagents and parallel work instead of inventing a second orchestrator.**
    Fold structured T3 task/workflow activities into one inspectable work graph. Show progress and
    outputs everywhere; show controls only when the certified T3/provider contract advertises them.

## What exists today

Every row below reflects the 2026-08-27 code-and-test ledger. Local tests, builds, and image smoke
are kept separate from deployed, live-T3, and physical-hardware proof.

| Area | Existing implementation | Main gap |
| --- | --- | --- |
| Free-form web input | Operate uses the shared `ComposerShell` and sends a browser-restart-safe `clientRequestId`; the gateway claims a bounded privacy-minimal receipt before policy/T3 and replays the original command | Hosted rollover and live-T3 retry proof remain; upload-session and command-receipt state stay deliberately separate |
| Mobile / Dashboard input | `QuickPage.tsx` imports the same compact composer used by Operate; the PWA consumes a five-minute, single-use fragment bearer from a locally encoded QR and opens the exact environment/thread/action capture on a phone | Deployed phone/earbud usability proof remains |
| Saved controller input | Actions, macros, device controls, and protocol-v1 menu intents | Shortcuts are perceived as the only allowed requests; the small device has no general text-entry path |
| Browser media | `MediaPage.tsx` and the reusable composer support upload, microphone recording, camera capture, stored-media reuse, paste/drop, transcription/editing, retention, deletion, raw integrity-finalized sessions, source provenance, and bounded on-demand image/audio previews | Hosted storage lifecycle and deployed performance/usability proof remain |
| Device media | The shared gateway/media client uploads device audio, starts durable processing, polls compact job state, and applies review/auto-send policy; Hosyond capture is integrated, and claimed devices can mint a scoped companion handoff without exposing their credential | Remaining-board integration and physical controller-to-cloud voice proof remain |
| Media attachment transport | Signed media URLs, optional inline bytes, redacted persistence, ordered `mediaUploadIds`, per-item validation, an eight-item limit, scalar protocol-v1 compatibility, the shared composer, integrity-finalized raw sessions, durable processing state, and request receipts | Hosted storage lifecycle, failure-injection, and deployed performance proof remain |
| First-turn attachments | The launch endpoint resolves owned media and passes attachments through `buildT3ProjectLaunchCommands` to the bootstrap turn | **Milestone 0.5 repair complete**; durable request identity reuses this path rather than adding a third attachment contract |
| Speech-to-text | Dedicated Parakeet/provider adapters, durable staged jobs, automatic device processing/dispatch, raw upload/finalize, abandoned cleanup, transcript versions, correction/review, retries, and timing metrics | Hosted worker/storage capacity proof and physical voice validation remain |
| T3 integration | One versioned `T3Adapter` contract over direct and outbound-connector transports, a cached probe-derived owner manifest, HTTP/Effect RPC, compatibility checks, ACK/Interrupt, cancellation, and subscriptions | Deployed live-T3 parity, load, and failure proof remain |
| Live T3 response | A demand-driven long-lived subscription relays snapshots and deltas with acknowledgement, bounded deduplication, resume/reset semantics, truthful reconnect state, a bounded T3 task projection that survives a settled parent turn, durable in-app notifications, and optional queued Web Push | Deployed Web Push plus live-T3/browser/device proof remain |
| T3 interactions | Operate shows separate gateway holds, T3 provider approvals with all four decisions, and structured single/multi/free-text user-input forms with pre-dispatch validation | Work-node-specific controls and deployed live-T3 interaction proof remain |
| Subagents / parallel work | `frontend/src/workGraph.ts` folds verified T3 0.0.32 task lifecycle/linkage into a 64-node/16-activity tree or explicit roster; Operate has an Agents & work inspector, attributed tools move out of parent narration, background liveness stays truthful through reconnect, and devices receive content-free counts | T3 exposes no certified per-task input/stop/resume target, so only parent-thread controls are shown; live-T3 and browser/hardware performance proof remain |
| Workspace recovery | Eight typed failure reasons, retryability metadata, reason-specific instructions/actions, availability checks, guided in-place re-enrollment, credential-free tombstones, exact-label confirmation, restore, and explicit retention purge | Deployed connector/WAN recovery plus hosted purge and old-socket closure proof remain |
| Environment pairing (first run) | Connector-first console enrollment creates a one-time command, follows layered connector/T3/provider/project/model health, and requires a completed command plus newer reply before readiness | The npm package and cloud are not deployed; live OS service, sleep/wake, and completed-reply proof remain |
| Environment removal | The UI calls it Remove, previews current dependency labels, requires exact-label confirmation when dependencies exist, revokes connector/credential authority, repairs defaults/actions/macros/onboarding, and retains an owner-scoped tombstone with restore and background purge across stores | Hosted Queue/Cron purge and live edge-socket closure proof remain |

## Category 1 — Open request and composer experience

### Outcome

A signed-in user can type any request, record a voice request, attach one or more images/audio
items, and send it to the selected agent thread without first creating a saved action or choosing a
special command type. Hardware shortcuts remain fast entry points into the same request pipeline.

### Product and UX changes

1. **Implemented:** one free-form textarea is the primary control in `OperatePage.tsx`.
2. **Implemented:** Image and Audio are attachment sources while Shell remains an explicit
   secondary mode because its policy and approval semantics differ.
3. **Implemented:** the attachment button opens one source menu:
   - Upload from this device.
   - Record voice.
   - Take a photo.
   - Choose from Media library.
4. **Implemented locally:** removable ordered attachment chips, source provenance, bounded
   owner-triggered image/audio previews, processing/failure/retry state, and the server ceiling
   exist. Hosted storage lifecycle and deployed performance proof remain qualification work.
5. **Implemented:** users can paste or drag supported media onto the composer on desktop. Preserve keyboard send,
   visible focus, screen-reader labels, reduced motion, and coarse-pointer targets.
6. Keep Saved actions in the existing disclosure below the composer. Copy should present them as
   reusable shortcuts, not as the allowed command vocabulary.
7. **Completed in Milestone 0.5:** new-thread launch accepts the same ordered attachment list and
   media validation as an existing thread. Preserve that behavior when the request envelope lands.
8. **Implemented:** `QuickPage.tsx` mounts the same compact composer as Operate, including free-form
   text and the shared media source/capture components. The PWA companion reuses this capture
   boundary after a scoped one-time handoff; preserve it as request-state work continues.

### Contract and code work

1. Keep the existing policy entry points (`/v1/intents`, project launch, saved action/macro runs,
   and device thread creation) and require product clients to send a URL-safe `clientRequestId`.
   Compatibility clients may omit it, but only client-supplied identity can survive an uncertain
   response and retry.
2. Claim a privacy-minimal command receipt before policy evaluation or T3 dispatch. Scope the claim
   to owner, actor realm and identity, operation, and `clientRequestId`; bind it to the canonical
   request hash so reuse with different input returns `409 idempotency_conflict`.
3. Persist only status, timestamps, HTTP status, and the resulting command reference. The memory,
   file, and Convex implementations enforce a 24-hour TTL and 1,000-receipt per-owner bound, evict
   terminal receipts oldest-first, and fail closed rather than evicting in-flight work.
4. Carry stable stage-specific request ids into connector dispatch. This preserves the product
   request identity while preventing the launch route's `thread.create` and `thread.start` stages
   from colliding with each other.
5. Reuse an uncertain id from the browser/PWA local journal and the controller NVS journal. These
   journals contain only the id, a non-content input fingerprint, and expiry; they never persist the
   prompt or media description.
6. Recover request state through `GET /v1/requests/:clientRequestId` and the device-realm equivalent.
   A duplicate in-flight request returns its processing receipt; a settled duplicate returns the
   original command reference without dispatching again.
7. Continue using the implemented raw-upload session state separately from durable transcription
   processing state. Command SSE state remains keyed by the referenced command. Request and T3 work
   attribution use their current bounded receipt/work-graph contracts rather than an invented
   request-event stream.

### Acceptance criteria

- A user can send arbitrary text to an existing or new T3 thread without creating an action.
- The same is true on a phone, from the Dashboard, without navigating to Operate first.
- A request can include multiple compatible media items from any supported source.
- Refreshing or retrying during upload/dispatch creates at most one T3 turn.
- Shell input still passes through the existing policy and approval path.
- Saved actions remain runnable from web and device, but no empty state implies they are required.

## Category 2 — Unified media capture, upload, and library

### Outcome

Media can be added at the moment of conversation, reused from the library, or captured by a claimed
controller. Every item shows where it came from and whether it is ready to send.

### Frontend work

1. **Implemented:** `MediaPicker` and `MediaCaptureDialog` are reusable, sharing the audio-recorder
   and camera-capture hooks.
2. **Implemented:** Operate and QuickPage mount the shared capture/picker while Media remains the
   library, transcript, processing, retention, and deletion surface.
3. **Implemented:** the ordered attachment draft supports add, remove, move-up, and move-down with
   the reusable picker.
4. **Implemented:** filter the library by the T3 adapter's supported types. Do not show audio as directly sendable
   when it still requires transcription; show `Transcribing`, `Ready`, or `Failed` instead.
5. **Implemented:** expose privacy-safe origin metadata in the media projection (upload, browser
   recording, controller capture, or reuse), while retaining device attribution server-side and
   redacting private filenames, paths, and identifiers from support projections.
6. **Implemented:** add bounded, owner-triggered audio playback and image preview before send. Both have explicit remove controls and
   avoid downloading full media until opened.

### Upload and storage work

1. Retain the current base64 JSON route as protocol-v1 compatibility for short controller clips.
2. **Implemented:** use a raw, two-step upload protocol for browser/PWA and shared firmware:
   - Create upload metadata and receive an upload ID/limit.
   - Upload raw bytes to an authenticated gateway endpoint or a short-lived pre-signed S3 PUT.
   - Finalize after a second exact-length and SHA-256 validation.
3. **Partially implemented:** enforce the declared supported MIME set, per-kind byte limits,
   per-user quotas, exact length, and SHA-256 integrity. Expanding the accepted media set still
   requires content sniffing plus decompression, duration, and image-pixel bounds appropriate to
   each new format.
4. **Implemented:** keep media private by default. Continue using short-lived signed read URLs for
   T3 and stripping URLs/inline data from stored commands and support bundles.
5. **Implemented:** keep explicit upload-session state separate from transcription/vision status so
   a failed upload is not confused with a failed processor.
6. **Implemented:** clean up abandoned upload sessions and retain the existing user-configured expiry purge.

### Device-originated media

1. Keep `POST /v1/device/media` authenticated with the claimed device credential and preserve
   `deviceId` attribution.
2. **Implemented:** return a compact processing/job ID so the controller polls one bounded status
   endpoint rather than inferring success from several resources.
3. **Implemented on the shared/Hosyond path:** compact Recorded, Uploading, Transcribing,
   Ready/Review, Sent, and Failed states without continuous telemetry animation.
4. The shared device path uses raw segmented upload plus a durable request receipt; the legacy
   base64 upload remains a bounded protocol-v1 compatibility path.

### Acceptance criteria

- Upload, camera, record, and library selection are all reachable from the composer in two actions
  or fewer.
- Media captured by a device appears in the owner's library with device attribution.
- The user can preview, remove, reorder, and retry attachments before dispatch.
- No signed media URL, raw bytes, or transcript appears unredacted in diagnostics/audit exports.

## Category 3 — Voice transcription, correction, and dispatch

### Outcome

Stopping a recording starts server-side speech processing automatically. The system preserves the
source audio and raw transcript, produces a clean prompt, lets the user review it when appropriate,
and dispatches it reliably to T3.

### Processing model

1. Replace the synchronous provider branch in `transcribeStoredAudio` with a provider interface and
   background job runner. Development can use an in-process worker; production should use a
   durable queue/lease stored with the configured backend so a gateway restart does not lose work.
2. Add transcript versions instead of overwriting one string:
   - `rawTranscript`: exact ASR output.
   - `normalizedTranscript`: punctuation/whitespace and optional correction output.
   - `userEditedTranscript`: the final reviewed value, when present.
   - Provider, model, language, timestamps, processing times, and last error.
3. Processing stages are `queued -> transcribing -> normalizing -> review_required|ready ->
   dispatching -> dispatched`, with retryable and terminal failures distinguished.
4. Parakeet already supplies punctuation and capitalization. Start correction with deterministic
   cleanup only. Add an optional second-pass corrector later for project names, paths, model names,
   and code terms; preserve the raw transcript and show the diff because a “correction” can change
   the user's command.
5. Never convert dictated text directly into `shell_input` without explicit review/confirmation.
   Voice defaults to an agent request, where the agent and existing approval mode provide another
   safety boundary.

### Parakeet adapter

1. Add `TRANSCRIPTION_PROVIDER=parakeet` and a dedicated adapter instead of overloading the OpenAI
   branch. Configure service URL, model, timeout, maximum duration, language, and concurrency.
2. Run `nvidia/parakeet-tdt-0.6b-v2` on the Next Coder server through a small local ASR
   service using NVIDIA NeMo. It is a compact 600M-parameter English model with punctuation,
   capitalization, word timestamps, and CC-BY-4.0 terms. CPU inference is the default deployment;
   a GPU is an optional throughput accelerator, not a requirement. Keep the ASR runtime in a local
   worker/sidecar so Python model dependencies and inference work do not block the Node gateway's
   HTTP and SSE event loop.
3. Normalize browser formats (WebM/Opus, M4A) to 16 kHz mono PCM in the worker; the current device
   WAV already uses 16 kHz mono.
4. Record queue wait, decode, inference, normalization, and total stop-to-dispatch latency. Enforce
   bounded retries and dead-letter/error state instead of holding HTTP requests for 30 seconds.
5. Make language support explicit. V2 is English; choose a separate configured model for other
   languages rather than silently producing low-quality English output.

### Review and auto-send policy

1. Web/PWA default: stop recording, transcribe automatically, place the normalized transcript in
   the composer, and require Send. Offer an account/device opt-in for `send_when_ready`.
2. Small controller default: show a short transcript preview plus Send, Record again, and Discard.
   If the display cannot show enough text, require a configured auto-send policy or hand off review
   to the phone/PWA.
3. If transcription fails, keep the audio and offer Retry, Edit/type prompt, or Discard. Do not send
   the current fallback sentence as if it were the user's request.

### Direct audio to T3

Current upstream T3 Code's typed `ChatAttachment` union contains image attachments only. Therefore:

1. Set `audioDirect: false` in the T3 capability adapter by default.
2. Transcribe audio and send text; retain the original audio in Next Coder for playback and
   audit/retention policy.
3. Add direct audio only when a probed T3 version advertises an audio attachment contract and the
   selected provider accepts it. Use the transcript as fallback context, never send an unknown
   attachment shape optimistically.

### Acceptance criteria

- A controller or browser recording automatically enters transcription without a manual Media-page
  action.
- Raw, normalized, and user-edited text are distinguishable and traceable.
- A processor restart resumes or safely retries queued work without duplicate dispatch.
- English voice stop-to-ready meets a measured target (initially p50 under 5 seconds and p95 under
  10 seconds for five-second clips on the reference CPU server), or the UI clearly reports delay.
  Benchmark the actual production CPU before locking the SLO; GPU acceleration may be added later
  only when concurrency or queue latency requires it.
- No audio is sent directly to an unsupported T3 version/provider.

## Category 4 — Controller hardware and wireless voice

### Outcome

The small controller can initiate arbitrary voice requests without pretending that its display is
a keyboard. The supported hardware path is explicit and manufacturable.

### Feasibility decision

The current CrowPanel uses an ESP32-S3. Espressif documents Bluetooth Classic as unsupported on
this chip, and its support table lists ESP-BLE-ISO and ESP-BLE-AUDIO as unavailable. Most existing
wireless-earphone microphone profiles depend on Bluetooth Classic HFP; LE Audio headsets need the
LE Audio/ISO stack. Consequently, direct pairing with ordinary earbuds is not a viable production
feature for this board.

### Near-term implementation paths

1. **Recommended companion path:** make the existing responsive React/PWA composer the voice
   companion. Earbuds pair with the phone or computer, the browser captures their selected
   microphone, and the request travels over Wi-Fi through the same gateway. Add a QR/deep link on
   the controller that opens the correct environment/thread after authentication.
2. **Controller microphone variant — now an off-the-shelf board, not a custom PCB.** The
   Waveshare ESP32-S3-Touch-AMOLED-1.75C ships a dual-microphone array with an ES7210
   echo-cancellation ADC, an ES8311 codec and speaker pads, 8 MB octal PSRAM, a 466x466 round
   capacitive touch AMOLED, an AXP2101 PMIC and a battery header — in an enclosure. It removes the
   carrier-board program described below from the critical path and answers the "too small to type
   on" problem with a touch screen. A scaffold folder exists at
   `firmware/Waveshare-ESP32-S3-Touch-AMOLED-1.75C/`; both PlatformIO environments compile, no board
   has been flashed, and its README carries the evaluation, the unverified pin map, and the port
   plan. Two caveats: it has **no camera**, so device-originated `camera_prompt` intents are not
   possible on it, and an always-on AMOLED cannot match e-ink battery life — it complements the
   CrowPanel status controller rather than replacing it.

   The port's real cost is not the drivers. It is that only `DeviceStore` and `Provisioning` are
   shared today; the gateway client still lives inside the CrowPanel's 3652-line `main.cpp`. A
   second working board requires extracting it into `firmware/shared` first.

   **A second candidate, and currently the better-evidenced one:** the Hosyond/LCDWIKI ES3C28P
   (`firmware/Hosyond-ESP32-S3-2.8-Touchscreen/`) — 2.8" IPS 240x320 capacitive touch, on-board MEMS
   microphone and speaker through a single ES8311 codec, 8 MB PSRAM, battery charging, microSD. Its
   vendor pack ships a schematic, a full pin-allocation table, and a working ES8311 driver, so its
   pin map is verified and its capture path is implemented rather than sketched: hold a key, record
   to PSRAM, measure peak/RMS, play back through the speaker — all offline. It has no echo
   cancellation and one microphone instead of an array, and it is a bare module rather than a cased
   unit, but it is the cheaper way to answer whether on-device voice works at all.

   Neither board has a camera, so device-originated `camera_prompt` intents are impossible on both.
   Whichever wins, the gateway-client extraction above is the shared prerequisite.

   The older plan, retained because it still applies to any board without a microphone: use the
   existing PDM/I2S implementation in
   `firmware/CrowPanel-ESP32-2.13-E-paper/src/media_capture.cpp` and the
   `crowpanel-esp32-213-epaper-capture` PlatformIO environment. Note that neither of its two modes
   fits the AMOLED board — the ES7210 is not PDM and needs an I2C register init before it emits
   anything. The stock CrowPanel has neither mic
   nor camera and only a two-pin expansion header, so define a carrier-board BOM with a supported
   two-wire PDM microphone, validate pin conflicts, enclosure acoustics, PSRAM, and power.
3. **Future wireless-audio hardware:** evaluate a Bluetooth Classic HFP audio coprocessor or a new
   LE Audio-capable MCU/module. Require a proof of headset interoperability, microphone uplink,
   coexistence with Wi-Fi, memory, licensing, battery, and OTA support before placing it on the
   product roadmap.

### Firmware work

1. Promote audio capture from a compile-time demo to a declared hardware capability in heartbeat
   and `/v1/device/controls`.
2. Add first-run microphone diagnostics: permission/capability, input level, clipping, silence,
   memory budget, maximum clip duration, and upload reachability.
3. Use push-to-talk: hold OK, release to stop, then Send/Record again/Discard. Preserve the current
   decision not to refresh e-ink during the recording window.
4. Add request idempotency, upload retry with backoff, and cancellation. Keep clips short; do not add
   continuous audio/video.
5. Surface `transcribing` and the final plain-language agent result through the existing display and
   thread-output endpoints.

### Acceptance criteria

- The product documentation clearly names which controller SKU can capture audio.
- A supported PDM/I2S build records intelligible five-second clips without starving Wi-Fi/e-ink
  memory and reports failures locally.
- A phone using Bluetooth earbuds can open the selected thread and record/send through the PWA.
- The stock ESP32-S3 UI never advertises Bluetooth-headset microphone support it cannot provide.

## Category 5 — T3 integration, recovery, and environment lifecycle

### Outcome

Connecting T3, diagnosing an outage, re-pairing, and removing an obsolete environment are coherent
flows with precise status, guided next actions, and no silent contract mismatch.

### T3 adapter and capability work

1. **Implemented locally:** create a `T3Adapter` boundary around HTTP snapshot/dispatch and WebSocket catalogue/terminal
   calls. Keep transport details out of `src/app.mjs` and make version-specific wire shapes testable.
2. **Implemented locally:** expand `/capabilities` from scope-derived booleans to a probed manifest:
   - Installed T3 version and contract version.
   - Shell snapshot, thread-detail read/pagination, thread subscription, dispatch, live catalogue,
     terminal, and launch support separately.
   - Attachment types and limits (`image`, `audio`, file) separately.
   - Runtime and interaction modes.
   - Approval decisions, structured user-input responses, interruption/session stop, proposed plans,
     checkpoints, and task/workflow lifecycle events.
3. **Implemented locally:** add fixtures and contract tests for the currently certified T3 version and latest supported
   version. Do not mark `attachments: true` merely because orchestration operate scope exists.
4. Prefer the official client/SDK if T3 publishes a stable one; until then, keep the adapter small
   and fail closed when a command cannot be encoded for the probed contract.
5. **Implemented locally:** reuse `t3Compatibility.mjs` results in Operate/Environments instead of isolating compatibility
   details in Settings.

### First-run connection

The console is now the starting point for the production flow. It creates a single-use pairing code
and copyable `npx @next-coder/connector` command; the local connector discovers or starts T3,
redeems the code over an outbound connection, and registers the environment without sending the T3
token to the cloud. Layered readiness reports connector, T3, provider, project, and model state.

1. **Implemented locally:** connector-first cloud enrollment, recovery/re-enrollment, fleet
   revocation, and cloud-mode rejection of direct URL/token creation.
2. **Implemented locally:** readiness requires the matching environment/project/provider/model and
   a completed command plus newer T3 reply; a dispatch acknowledgement alone is insufficient.
3. **Remaining:** publish the npm package and validate install, OS lifecycle, WAN/sleep recovery,
   revocation, and completed-reply onboarding against a deployed cloud and live T3.
4. Keep LAN discovery, manual URL/token entry, `setup:t3`, and Tailscale Serve/Funnel as explicitly
   self-hosted/advanced compatibility paths rather than production-cloud alternatives.
5. Instrument the production funnel from code issuance through connector/T3 readiness and first
   completed reply, without collecting tokens, prompts, paths, or reply content.

### Structured health and recovery

1. Introduce an environment failure reason enum:

   ```text
   process_not_running | network_unreachable | timeout | tls_error |
   token_expired | authentication_failed | contract_incompatible | unknown
   ```

2. Make `t3Client.mjs` throw typed errors with HTTP status, network code, endpoint, retryability,
   and sanitized detail. `checkEnvironmentHealth` — which lives in `src/app.mjs:3183-3223`, not in
   `t3Client.mjs` — stores the reason and last successful contact. It already narrows to
   `token_expired` / `reachable` / `unreachable`, so this is widening an existing classification
   and then actually surfacing it, not building one from nothing.
3. Replace `WorkspaceRecovery { message }` with structured recovery data. Preserve the generic
   message only as fallback.
4. Update `WorkspaceRecoveryDialog.tsx`:
   - `process_not_running`: show host-specific T3 start/setup command and auto-retry.
   - `token_expired` or `authentication_failed`: explain how to start T3, obtain a fresh pairing
     token, and open the selected environment's Credential tab.
   - Network/TLS: show the saved URL and access-path checks without exposing credentials.
   - Contract mismatch: show installed/supported versions and the compatibility action.
5. Generate setup instructions from a server endpoint using environment access mode and platform,
   rather than hard-coding one command in the dialog. Keep `npm run setup:t3` as the guided local
   fallback.
6. Continue automatic recovery for retryable outages, with exponential backoff and jitter. Stop
   polling for token/contract failures that require user action; resume after the credential or
   version changes.
7. Preserve the quiet centered empty state from the supplied screenshot, but make its primary
   action `Start/reconnect T3 Code` and its secondary action `Connection settings`.

### Remove old environments

1. **Completed in Milestone 0.5:** rename `Unpair environment` to `Remove environment`; preview
   assigned devices, saved actions, macros, and onboarding dependencies before confirmation.
2. **Completed in Milestone 0.5:** erase the credential/record idempotently, clear device and
   onboarding selections, and disable dependent fixed-target actions/macros with
   `environment_removed` rather than silently retargeting them.
3. Extend the dependency preview with current project/thread, recent command count, last
   reachability, and current UI selection where those are not already represented. Retain immutable
   command/audit context with an environment label/base-URL snapshot for history.
4. **Implemented locally:** removal retains a credential-free tombstone (`deletedAt`, `purgeAfter`),
   hides it from active/device lists, preserves command/audit context, and delegates permanent purge
   to an explicit user-scoped retention task.
5. **Implemented locally:** dependency-heavy removal requires the exact current environment label,
   returns the repair/revocation summary, and repeated removal/restore are idempotent.
6. Clear selected environment/project/thread and route to the next valid environment or the Connect
   empty state after success.

### Acceptance criteria

- A new user can connect their first environment without leaving the console except to run one
  copied command, and the console detects success without a manual paste on the common path.
- A stopped process, expired token, and unreachable host produce different UI instructions.
- Restarting T3 closes the retryable modal automatically and reloads the same environment/thread
  when it still exists.
- Re-pairing updates the existing environment ID and does not create a duplicate for the same host.
- Removing an environment is discoverable, confirmed with dependency impact, removes credentials,
  and leaves no active device/action/macro targeting a missing host.
- Historical activity remains readable after removal.

## Category 6 — Live T3 conversation, decisions, and multi-agent work

### Outcome

After a user sends a request, Next Coder becomes a complete remote control surface for that
T3 thread: it shows the agent's response as it streams, tool and command activity, working and
background status, approvals and questions that need an answer, and subagent/parallel-task progress.
The user can follow up, answer, approve, interrupt, or stop without opening T3 Code.

### Gateway thread-detail and streaming architecture

1. Add a long-lived streaming RPC path to `T3Adapter`; do not reuse `callT3Rpc`, whose one-shot
   lifecycle deliberately collects chunks and waits for `Exit`. For each selected thread:
   - Load a bounded recent thread-detail snapshot, including messages, activities, session,
     checkpoints, proposed plans, and its `snapshotSequence`.
   - Subscribe with `orchestration.subscribeThread { threadId, afterSequence,
     requestCompletionMarker: true }`.
   - Apply live events in sequence, deduplicate overlaps, and backfill after reconnect. Page older
     turns only when the user asks for them.
2. Relay normalized thread events to the signed-in browser through the existing gateway SSE
   connection or a dedicated authenticated per-thread stream. Scope every subscription by user,
   environment, and thread; unsubscribe when the selection changes or the last viewer leaves.
3. Introduce a versioned Next Coder view contract rather than exposing raw T3 wire objects:

   ```ts
   interface ThreadDetailView {
     environmentId: string;
     threadId: string;
     sequence: number;
     messages: ThreadMessageView[];
     activities: ThreadActivityView[];
     pendingInteractions: PendingInteractionView[];
     session: ThreadSessionView | null;
     work: WorkNodeView[];
     backgroundLiveness: "working" | "monitoring" | null;
     planProgress: { step: string; completed: number; total: number } | null;
   }
   ```

4. Keep T3 authoritative for transcript and provider activity. Cache only resumable sequence,
   minimal last-known state, unread markers, and Next Coder's own response audit. On refresh,
   reload detail from T3 rather than reconstructing a transcript from gateway `Command` records.
5. Coalesce high-frequency assistant deltas and task progress before sending/rendering them. Preserve
   message/activity IDs and task linkage so parallel streams never splice into the wrong output.
6. Define explicit stream states: `connecting`, `synchronized`, `live`, `reconnecting`, `stale`, and
   `unavailable`. A stale cached response must remain readable but visibly stale; it must never show
   a false `live` or `finished` state.

### Conversation and workbench UI

1. Replace the command-card fallback as the primary thread feed. Render, in order:
   - User and assistant messages, including streaming text and safe Markdown/code blocks.
   - Tool/command activity with source, status, concise summary, elapsed time, and expandable detail.
   - Plan/progress updates, errors, diffs, checkpoints, and final completion state.
   - The gateway dispatch record only as a compact delivery receipt linked to its T3 turn.
2. Preserve the docked composer throughout a turn. Allow a normal follow-up when T3 allows it; show
   clear queued/steering semantics when the thread is already busy. Add `Interrupt turn` and `Stop
   session` as distinct actions, gated by current session state and capability.
3. Put the most recent pending approval or user-input request directly above the composer and also
   inline beside the activity that caused it. Do not replace the canvas with a large blocking modal.
4. Auto-follow new output only while the user is already near the bottom. Otherwise preserve their
   reading position and show a `New activity` control. Keep focus stable while deltas arrive and
   announce important state changes through an accessible live region.
5. Add source-aware sidebar badges and optional notifications for `approval required`, `answer
   required`, `failed`, `completed`, and `background work still running`. Clear unread state only
   when the matching activity is viewed or resolved.

### Approvals and structured user input

1. Normalize both approval realms into `PendingInteractionView`, but retain a source discriminator
   (`next-coder-policy` or `t3-provider`), the source request ID, environment/thread/turn IDs,
   risk/detail, available decisions, creation time, and resolution.
2. Route decisions by source:
   - Next Coder policy: keep `/v1/commands/:id/approve|reject`.
   - T3 provider: dispatch `thread.approval.respond` using the T3 `requestId` and advertised
     decision set. Support `acceptForSession` only when the current provider exposes it; label its
     scope precisely and never silently translate it to a permanent grant.
3. Add `user_input_response` to intent normalization, profile capabilities, policy evaluation, and
   `buildT3Command`, mapping it to `thread.user-input.respond { requestId, answers }`.
4. Render T3's structured questions as accessible controls (single choice, multiple choice, text,
   and validation when present). Preserve partially entered answers through reconnects and submit
   them atomically with an idempotent command ID.
5. Show a resolving state immediately, but mark the interaction resolved only after T3 accepts the
   command and the stream confirms it. Disable repeated decisions while pending and show a retryable
   error without discarding the original question or approval detail.

### Subagents, workflows, and parallel tasks

1. Fold structured `task.started`, `task.progress`, `task.updated`, `task.completed`, and workflow
   activities into a stable work graph; do not infer agents from message wording or tool labels when
   structured linkage exists:

   ```ts
   interface WorkNodeView {
     id: string;
     parentId: string | null;
     kind: "workflow" | "subagent" | "parallel-task" | "tool";
     label: string;
     status: "queued" | "working" | "waiting" | "completed" | "failed" | "stopped";
     progress?: { summary?: string; completed?: number; total?: number };
     outputRef?: string;
     startedAt?: string;
     completedAt?: string;
     capabilities: { inspect: boolean; provideInput: boolean; stop: boolean; resume: boolean };
   }
   ```

2. Keep the thread feed primary. Collapse a fan-out into one inline row such as `Started 4 parallel
   tasks · 2 complete · 2 working`; selecting it opens an `Agents & work` inspector. Use a right-side
   drawer on desktop and a sheet/tab on smaller screens.
3. In the inspector, show the parent/child tree, role/model when T3 provides them, live status,
   elapsed time, current step/tool, output summary, failures, and token/tool counts. Selecting a node
   filters/highlights its activities without mixing child narration into the parent answer.
4. Derive the thread's visible `Working` state from both the parent session and T3
   `backgroundLiveness`; a settled foreground turn with active children must not look finished.
5. Capability-gate every control. If T3 exposes only thread/session-level stop, label it `Stop all
   background work` and do not draw fake per-agent Stop buttons. Add per-node stop, resume, or input
   only after a certified contract exposes a stable target ID and response command.
6. Keep the composer targeted at the parent T3 thread unless the contract exposes a real child-task
   input command. If direct subagent messaging is unavailable, say so in the inspector and offer a
   parent-thread follow-up such as `Ask the research agent to...`; do not imply it is a private
   message to that child.
7. For the small hardware controller, show aggregate status and the first actionable interaction:
   task count, working/completed/failed, approval/answer needed, and final result. Keep the full graph
   on the web/PWA rather than forcing a dense tree onto e-ink.

### Acceptance criteria

- Within one second of T3 accepting a turn event, an online Next Coder viewer sees its
  working state or first streamed output under normal LAN conditions.
- A refresh or WebSocket reconnect resumes from sequence without missing or duplicating messages,
  task activities, or decisions.
- The user can read the final T3 answer, send a follow-up, interrupt a running turn, and stop a
  session without opening T3 Code.
- Both Next Coder policy approvals and T3 provider approvals are visible, correctly labeled,
  and resolved through the correct backend path.
- Every structured T3 user-input request can be answered from Next Coder.
- Parallel/subagent work remains visibly active after the parent turn settles, and each structured
  task's status/output is attributable to the correct node.
- Unsupported per-agent controls are absent—not disabled-looking promises—and the UI explains the
  available thread-level control.

## Category 7 — Security, observability, testing, and rollout

### Security and privacy

1. Treat audio, transcripts, correction output, images, and descriptions as user content. Apply the
   current retention/redaction rules to every new field and processing job.
2. Do not log raw prompts, transcripts, signed URLs, tokens, or inline attachment bytes.
3. Enforce TLS for remote device uploads, per-actor rate limits, media quotas, MIME sniffing, and
   short-lived URLs. Keep policy evaluation immediately before dispatch so a delayed voice request
   cannot bypass a newer policy.
4. Make auto-send opt-in per user/device and record who enabled it. Provide an obvious way to stop
   or cancel a processing request.
5. Authorize every T3 detail subscription and interaction against the selected environment/thread.
   Redact command payloads and file paths according to the existing policy before relaying them to a
   browser or small controller.
6. Audit who approved, declined, answered, interrupted, or stopped work, recording the source realm
   and request/turn/task IDs without storing credentials or duplicating sensitive transcript text.

### Observability and service targets

Add metrics for upload success/bytes, queue depth/age, transcription latency by stage/provider,
correction latency, review time, stop-to-dispatch time, T3 dispatch result, duplicate prevention,
recovery reason, time-to-recover, and environment removal dependencies. Extend beta readiness from
`mediaCapturedAt -> dispatch` to stage-level measurements so a slow ASR queue is diagnosable.

For live threads, add dispatch-to-first-T3-event, dispatch-to-first-token, event relay lag, reconnect
and backfill counts, sequence-gap failures, pending-interaction age, decision latency/error, active
background-work age, task-event coalescing ratio, and incorrect/stale liveness incidents.

Initial targets:

- Text request acknowledgement p50 under 500 ms and p95 under 2 seconds, excluding T3 work.
- Five-second voice clip stop-to-ready p50 under 5 seconds and p95 under 10 seconds on the reference
  CPU-hosted Parakeet service, with the final target calibrated from production-server benchmarks.
- No duplicate T3 turn for the same `clientRequestId`.
- No unauthenticated media read or request dispatch.
- Recovery reason classification on at least 95% of failed T3 health checks.
- Live thread relay p95 under one second on the reference LAN, excluding T3/provider generation.
- Zero known cross-thread message, decision, or task-attribution errors.

### Test plan

1. **Frontend/Vitest:** composer text, drag/paste/upload, multiple attachment chips, inline record,
   transcript review/auto-send, retry/cancel, recovery reason variants, Remove confirmation with
   each dependency type present, the `QuickPage` compact composer, and the first-run connection
   states (waiting for host, discovered candidate, paired, manual-paste fallback). Add live message
   deltas, pinned scroll position, new-activity affordance, both approval realms, structured user
   input, background liveness, and work-graph/inspector states.
2. **Server/node:test:** request state machine, idempotency, media ownership/type/limits, Parakeet
   success/timeout/retry, correction versioning, policy-at-dispatch, T3 capability gating, typed
   health errors, deletion dependency cleanup, thread subscription lifecycle, event deduplication,
   sequence-gap recovery, user-input response encoding, and source-correct approval routing.
3. **Store parity:** every new request/media/environment method against memory, file, and Convex.
4. **T3 contract fixtures:** certified image attachment, rejected audio on image-only T3, future
   audio capability fixture, first-turn attachments, thread-detail snapshot/pagination, live message
   and activity events, approval decisions, structured questions, task/workflow lifecycle,
   background liveness, and version skew.
5. **Firmware/bench:** default CrowPanel build, capture build, five-second audio memory budget,
   silence/clipping, Wi-Fi loss during upload, retry idempotency, and e-ink milestone screens.
6. **End-to-end:** browser text, browser voice review, device/PDM auto-send, phone with Bluetooth
   earbuds, stopped-T3 recovery, token re-pair, environment removal with dependencies, streamed T3
   response and follow-up, provider approval, structured answer, interrupt/stop, reconnect during a
   turn, and parallel subagents whose parent turn has already settled.

## Recommended delivery sequence

### Milestone 0.5 — Complete (shipped 2026-08-24)

Everything here shipped independently of the request envelope and ASR pipeline.

- **Done — Remove environment.** The UI uses Remove, previews dependencies, requires the current
  label when dependencies exist, revokes credentials, repairs device/onboarding references,
  disables dependent fixed-target actions/macros, and retains a recoverable tombstone until purge.
- **Done — reason-specific recovery modal.** Eight typed reasons carry retryability and targeted
  instructions/actions to the frontend.
- **Done — first-turn attachments.** Project launch resolves and sends the same validated ordered
  attachments as follow-up turns.
- **Done — multiple attachments end to end.** The intent contract accepts an ordered list with an
  eight-item limit and preserves the scalar field as a protocol-v1 alias; Operate can add, remove,
  and reorder stored media.

The completed repair has dedicated frontend, server, and store coverage in the current test gate.

### Milestone 0 — Contracts and diagnostics (1–2 weeks)

**State: partial.** Versioned thread detail/events, separate pending interactions, typed recovery,
captured fixtures, the persistent acknowledged subscription, durable request identity, and the
expanded probe-derived `next-coder.t3-capabilities.v1` manifest have landed. The work-node
view remains an ephemeral T3 read projection by design; duplicating T3 task truth into
memory/file/Convex would create a second stale graph. Remaining work is deployed live-T3 contract
qualification and failure/recovery evidence.

The command-request envelope is implemented in memory, file, and Convex with 24-hour/1,000-row
bounds, conflict semantics, browser/NVS recovery journals, and stable connector request ids. Durable
voice jobs and live subscription behavior no longer depend on all of Milestone 0 being complete.

**Decision implemented:** do not add a second `POST /v1/requests` policy entry path. Existing command
routes carry `clientRequestId`; `GET /v1/requests/:clientRequestId` is the recovery read. Raw upload
sessions and media processing jobs retain separate durable state so upload failure is not confused
with transcription or vision failure.

### Milestone 1 — Live conversation and interaction parity (2–4 weeks)

**State: partial.** Selected-thread detail, live message/tool relay, safe reconnect/reset, truthful
working/final states, provider approvals, structured user input, follow-up, interrupt/session stop,
the evidence-linked Agents & work inspector, background liveness, and compact controller
interaction/result/work projections, expanded probe-derived capabilities, durable notifications,
optional queued Web Push, and bounded request/task attribution have landed. Remaining work is
deployed live-T3/Web Push/browser/device qualification. Any future per-task control remains blocked
until T3 exposes a certified stable target command.

This closes the critical post-dispatch gap shown in the screenshots: the user can see and control
what T3 is doing instead of leaving Next Coder to finish the task in T3 Code.

### Milestone 2 — Composer and connection (2–3 weeks)

**State: substantially done.** Operate and QuickPage share the reusable free-form composer and media
capture/picker; first-turn attachments, paste/drop, durable request idempotency, connector-first
one-command enrollment, layered readiness, and guided re-enrollment have landed. Remaining work is
npm publication, deployed connector proof, and live completed-reply onboarding.

This delivers the largest usability improvement without waiting for new hardware.

### Milestone 3 — Automatic Parakeet voice pipeline (3–5 weeks)

**State: substantially done.** The CPU-hosted Parakeet/provider adapters, durable staged jobs,
format handling, transcript versions, correction/review, opt-in auto-send, progress, retry gates,
and timing metrics have landed. Direct audio remains capability-disabled for the current T3
contract. Raw upload/finalize, abandoned-session cleanup, and the local capacity decision are
implemented. Remaining work is hosted worker/storage capacity proof and physical voice validation.

### Milestone 4 — Controller voice paths (2–4 weeks plus hardware lead time)

**State: partial.** Shared gateway/media behavior, Hosyond capture and streaming upload, durable job
polling, review/auto-send policy, request status, browse/operate controls, display, microphone, orb
UI, and the locally tested PWA QR/fragment companion have landed. Hosyond's earlier local path is
the only current silicon evidence.

- Deploy and exercise the PWA companion on a phone with browser-selected Bluetooth earbuds.
- Physical proof on a supported PDM/I2S carrier-board prototype; firmware capability reporting is
  already implemented locally.
- Remaining-board integration and physical controller-to-cloud audio/display validation.

Do not block the software voice release on a new controller PCB.

### Milestone 5 — T3 adapter hardening and rollout (1–2 weeks, then ongoing)

**State: partial.** One versioned `T3Adapter` contract now wraps the direct and connector paths;
read-only probes produce a cached, owner-safe manifest used by compatibility, recovery, and compact
device health. Deterministic connector resilience tests and Cloudflare adapter seams have landed.
Remaining work is hosted load/failure/security/retention qualification, clean-host connector proof,
live T3/provider compatibility validation, and staged rollout through the implemented owner-scoped
firmware/connector cohort controls. Direct audio remains capability-disabled until a verified
T3/provider pair advertises it; no undocumented feature-flag names are treated as a contract.

## Definition of done

The initiative is complete when a new user can connect their first T3 environment from the console
with one copied command, then — on a laptop or a phone — choose an environment/thread, type or speak
any normal-language request, add or reuse media in the composer, review processing when desired, and
see one traceable request reach T3. From the same Next Coder thread, they can watch the live
response and tool activity, answer T3 questions, resolve the correct approval, inspect parallel
subagents, understand when background work is still active, send a follow-up, and interrupt or stop
work without opening T3 Code. A small controller can initiate the same flow through a supported
microphone or phone companion and show actionable aggregate status plus the final result. T3 outages
lead to precise repair instructions, and obsolete environments can be removed without dangling live
dependencies or losing historical explainability.

Saved actions still exist throughout, and nowhere in the product do they look like the only thing a
user is allowed to ask for.

## External constraints verified for this roadmap

- NVIDIA Parakeet TDT 0.6B V2 model card:
  <https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2>
- Current T3 Code orchestration attachment contract (image-only `ChatAttachment` union):
  <https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/orchestration.ts>
- T3 Code RPC and event-sourced orchestration architecture, including `orchestration.subscribeThread`:
  <https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md>
- T3 Code provider task/workflow runtime contract:
  <https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/providerRuntime.ts>
- ESP32-S3 Bluetooth/LE Audio support table:
  <https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-guides/ble/overview.html>
