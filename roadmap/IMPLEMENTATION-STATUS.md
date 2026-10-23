# Implementation status

Canonical progress ledger for
[open-input-media-voice-environments-roadmap.md](open-input-media-voice-environments-roadmap.md).
This file records what the repository can do now; the roadmap records the target and sequence.
Anything not marked **done** is not complete.

Last verified: **2026-10-23** for connector-local voice and the production recovery below. The
September workstream tables remain the baseline for gates not explicitly superseded here.

## October 23 connector-local voice

- Production `TRANSCRIPTION_PROVIDER=connector` routes each leased recording to its owner's
  current environment connector. Account/environment/lease isolation, post-wait revocation checks,
  bounded authenticated download, transcript privacy and stable T3 dispatch identity have tests.
- Voice is prepared automatically by the packaged connector: private managed Python, pinned
  dependencies and verified model, owned loopback sidecar, health checks and bounded recovery.
  No repository checkout, system Python, exposed laptop port or cloud inference is required.
- `npm test` passed **1,466 tests** with three intentional live-S3 skips; two separate Python
  process/transport tests, container smoke, clean package installation and repository secret scan
  passed. Exact code CI `39901775422` is green.
- An empty-directory macOS install and generated-clip inference succeeded. The production Mac's
  connector owns a healthy speech process and advertises `media.transcribe`; Hosyond 0.2.17 is
  online with default voice auto-send enabled. This supersedes the disabled-transcription state
  recorded in the October 22 audit.
- A real owner-recorded Hosyond voice note reached local Parakeet and T3 on its first attempt:
  media job `ms703vnnm1szyh1x6bp1kj54as8gv0pb`, local ASR **1,997 ms**, queue wait **6,031 ms**,
  and command `jn7bn2vme8dyn17mq4e3gkfhd18gv755` completed at **00:53:01 EDT October 23**
  with `voice tests successful`. The device-authenticated reply endpoint returned HTTP 200 with
  that reply; physical screen confirmation remains pending. Windows/Linux clean-host and hardware qualification remain
  unverified. The bundled Parakeet checkpoint is English only.
- The package is packable and installable, but public npm lookup returned 404. Public `npx`
  distribution still requires first publication through the protected connector release flow;
  deployment of the gateway does not publish that package.

See [local voice operation](../docs/local-voice.md) for setup, boundaries and limitations.

## October 22 production and firmware evidence

- The official production origin is `https://coder.next-notes.com`. Google identity sign-in,
  the cloud-to-connector-to-local-T3 path (T3 0.1.1), a real completed read-only console command,
  and device-authenticated retrieval of that command's reply were observed during recovery.
  These observations supersede the older statement that the cloud workstream was never deployed;
  they do not establish the remaining hosted capacity, rollback, or cross-platform gates.
- The comprehensive shared-core/Hosyond repair covers transport recovery, nonblocking interaction
  jobs, stale-context rejection, durable mutation receipts, touch fault handling, capture destination
  pinning, transcription replay, and bounded signed OTA downloads. Details and explicit product
  limits are in [the firmware workflow audit](../docs/firmware-workflow-audit.md).
- The current repository gate passes: 383 frontend, 866 server, 102 connector, 16 cloud contract,
  29 edge, 13 resilience, and 20 private-control-plane tests (**1,429 passing**, three intentional
  live-S3 skips), together with the production console build, performance budgets and typechecks.
- Secure Hosyond 0.2.16 bench evidence now includes real microphone samples, recording UI
  sample retention, and successful cloud/T3 thread creation with list insertion and binding adoption.
  The disposable thread was archived and the verification binding restored. All 15 environments
  built after shared repairs; all seven Hosyond environments were rebuilt after final board changes.
- Physical Hosyond action-to-T3-to-screen completion is verified for the read-only Verify T3 action
  on firmware 0.2.17: owner tap and Confirm produced device command
  `jn772qe7txpzz77vtzg4286c3d8gvbs2`, completed at 23:18:12 EDT on October 22, and the owner
  confirmed `HOSYOND_PRODUCTION_E2E_OK` visible on the physical screen. This replaces the earlier
  failed-attempt evidence for that path; it does not close outage, stress, voice or OTA gates.
- At this audit's cutoff production transcription was disabled; the October 23 connector-local
  implementation above supersedes that deployment state. Transcript editing, provider approvals and free-form user input currently
  hand off explicitly to the console. Other boards have compile evidence, not equivalent silicon proof.

## Cloud control-plane and local connector workstream

| Surface | State | Current evidence | Remaining gate |
|---|---|---|---|
| Connector backend | partial | Separate credential/ticket realm, Store/Convex parity, connector projections, `T3Transport`, private router, bounded 25-second immediate-wake result/subscription reads, credential-scoped idempotent self-revocation with fail-closed local cleanup, managed-topology exclusion of the local ticket issuer, and reconnect recovery; focused local gates cover these contracts | Deployed binding latency/call rate, machine sleep/WAN, and live T3 parity |
| Connector package | partial | Real npm bin and clean pack/install; manual protected release automation binds exact stable version, annotated tag, source commit and confirmation, enforces dependency-free contents/size/executable plus npm dry-run, grants OIDC only to `npm-release`, refuses immutable version reuse, requests provenance, designs clean external exact-version verification, and emits redacted evidence; the package manifest now carries Apache-2.0, a package-local `LICENSE`, and the `spyhack225/next-coder` repository/homepage/bugs metadata; native credential adapters, cross-platform T3 ownership, transactional update rollback, rotation, and platform-mocked service lifecycle remain covered locally | Confirm the final public package scope/name, configure the npm trusted publisher/environment/tag rules, execute publication; then prove clean macOS/Linux/Windows install, service/T3/native-store/sleep/update/rotation handoff behavior |
| Cloudflare edge | partial | Worker/Static Assets, per-environment Durable Object, bounded immediate-wake waits, Queue/Cron handlers, redacted terminal/exhaustion quarantine plus configured broker DLQs, revoke/reconnect recovery, and sampled privacy-safe Analytics Engine/log telemetry for request duration/outcome, DO capacity, Queue lag/retry/quarantine/DLQ risk, connector transitions, and rollouts; Wrangler/preflight sampling and binding policy plus hermetic telemetry tests are local-only | Execute isolated bootstrap and protected deploy/rollback; prove hosted ingestion/privacy, dashboards/alerts, native Queue/DLQ correlation, cron, rollover/load/security behavior |
| Cloudflare control plane | partial | Private Worker + bounded Container wrapper + private edge-router/background joins; managed Web Push VAPID rotation/sealing secrets are name-preflighted and passed only to the private Container with its process timer disabled in favor of Queue/Cron; Container proxy telemetry distinguishes startup-wait candidates, startup timeout, and response-header timeout without request data; reproducible `linux/amd64` image (about 78 MiB as a gzip-compressed `docker save` archive under a 100 MiB budget; 227 MiB uncompressed) runs non-root and passes public/private/graceful-stop release smoke; protected bootstrap/release/rollback and redacted qualification harnesses have local coverage | Execute paid-plan bootstrap/deploy, live rollback rehearsal, qualification/binding/jobs/R2/Web Push provider, hosted telemetry privacy/alert delivery, and `standard-1` CPU/memory/cold-start/cost proof |
| Capacity/SLO | partial | Provisional singleton budget and `npm run test:capacity`; local report qualifies 16 concurrent environments, 48 Container proxy requests, exact 32-request/16-lease/48-waiter DO bounds, fresh/warm/saturated latency, Node RSS/heap/CPU, and the process-local rate-limit restart caveat | Hosted `standard-1` saturation/soak/rollover, Redis continuity, per-hop WAN latency, availability, Cloudflare billing observation, and accepted singleton/partition decision |
| Console | partial | Connector-first enrollment, five-layer proof-gated readiness, recovery and fleet settings; the current frontend suite, production build, and typecheck pass; the browser gate enforces lazy feature chunks, first-load budgets, a 512-row live projection, and frame-batched SSE updates | Deployed live journey plus representative desktop/mobile GPU, usability, WAN, and real-stream heap-soak proof |
| Firmware TLS | partial | Fail-closed CA verification/rotation, compact layered device health, a statically complete 15-environment matrix including hermetic CrowPanel capture, explicit secure CrowPanel/Hosyond release targets, shared secure Waveshare claim/health/recovery, and a capability-gated T190 status/operate adapter | Production CA, negative TLS, WAN and hardware proof; remaining probe/benchmark environments need a quiet-runner matrix renewal |
| Release controls | partial | Owner-scoped firmware/connector rollouts plus manual protected npm/staging automation; production promotion now has a hermetic policy/orchestrator that binds an exact forward commit to fresh hashed staging release/qualification/hosted-capacity/security evidence and tracked deploy-input identities, verifies active versions/topology/resources/secret names, and separates Convex/private Container, public edge, and postflight with four protected operator checkpoints and redacted evidence; current single Container is truthfully immediate rather than canaried | Configure protected environments/provider scopes, create real hosted evidence, and execute bootstrap/staging/promotion; rehearse compatible and incident-specific rollback; publish/deploy candidate artifacts and prove internal/browser/controller cohorts on hosted Cloudflare and clean connector hosts |

Canonical detail: [cloud-control-plane-connector-roadmap.md](cloud-control-plane-connector-roadmap.md).
The evidence-backed remaining work is tracked as CG-01 through CG-12 in that roadmap. CG-01
(Queue/Cron ownership), CG-02 (online revocation), and CG-03 (reconnect replay) are implemented and
cross-runtime tested locally; each still requires its named hosted or real-machine proof before the
workstream is marked done.

## Verified baseline

- **Delivery:** Milestone 0.5 is complete. Milestones 2 and 3 are substantially complete.
  Milestones 0, 1, 4, and 5 are partial: the live-thread contracts and conversation path have
  landed, including the evidence-limited T3-native work graph, durable in-app notifications, locally
  verified rollout controls, and the expanded probed capability manifest. Hardware validation,
  deployed Web Push qualification, and live-system proof remain.
- **Current repository gate:** `npm test` completed green on 2026-09-09 in this working tree. The
  production build, frontend performance budgets, and the frontend, Convex, Cloudflare, and
  control-plane typechecks pass. The server suite reports 785 tests, 782 passing and three
  intentional live-S3 skips; connector passes 85; Cloudflare passes 16 contract, 28 Worker, 13
  resilience, and 13 private-control-plane tests; the frontend suite passes 50 files/365 tests. The
  earlier Vitest worker-startup timeout on the macOS File Provider-backed checkout did not recur in
  this run, so no file was skipped. `npm run smoke:convex` also passes against disposable live
  Convex records. The browser gate checks lazy feature chunks, a bounded initial static graph, a
  512-row live projection, and frame-batched SSE updates; current measurements are recorded by
  `docs/frontend-performance-gate.md` rather than duplicated as brittle totals here. All of this is
  local code evidence; none of it is deployed, live-T3, browser, or hardware proof.
- **Firmware baseline:** `firmware/build-matrix.json` now enumerates all 15 PlatformIO environments
  on the one pinned pioarduino toolchain, and CI checks that inventory plus secure release selection.
  Current isolated placeholder-config builds prove all four CrowPanel environments, the secure
  Hosyond controller (plus base/capture), both Waveshare environments, and the Vision controller
  from the same post-TLS source. The earlier CrowPanel/Waveshare pre-compile stall was a macOS File
  Provider conflict in worktree `.pio` output (`build 2`/`libdeps 2`), not a source failure. A
  contended exhaustive retry hit the build runner's bounded tool/setup timeout while PlatformIO
  repaired its local esptool Python package, so the remaining Hosyond probes/benchmarks still rely
  on earlier compilation evidence.
- **Hardware evidence:** Hosyond ES3C28P has been flashed and exercised on silicon: 8 MB PSRAM,
  16 MB flash, battery reading, ES8311 codec, microphone samples, SoftAP provisioning, ILI9341
  display, panel polarity, and the orb UI. Other boards remain unvalidated on hardware.
- **Self-hosted LAN onboarding proven end to end, without user-side flashing:** a factory NVS seed
  was written once, after which the owner entered Wi-Fi through the SoftAP portal, the device
  discovered the gateway over LAN broadcast, reported itself unclaimed, displayed its claim code,
  and was claimed from the console.
- **Cloud onboarding is locally proof-gated, not deployed:** readiness requires the selected
  environment/project/provider/model and a `completed` command with a newer T3 reply; an accepted
  dispatch alone is rejected by the test contract. No hosted connector or live-T3 first-reply
  journey has been observed. `npm run qualify:staging` can collect that narrow deployed proof after
  authorization; its eight tests currently prove only hermetic mock behavior.
- **Reboot loop fixed and verified on hardware.** Two distinct bugs, found in sequence:
  1. Both HTTP call sites declared `HTTPClient` before the `WiFiClient` handed to `begin()`. C++
     destroys locals in reverse order, so `~HTTPClient()` ran `stop()` on freed memory.
  2. `ThinkingOrb`'s scratch buffer was a file-scope global shared by every orb instance while
     `capacity_` stayed per-instance, so `pushDot()`'s bound check guarded the wrong object. The
     UI builds a 900-dot orb then a 180-dot one; the smaller `begin()` ran last and shrank the
     shared buffer, and the main orb kept writing 405 entries into room for 180 — 2.7 KB past the
     end, thirty times a second, into the internal-RAM pool the WiFi driver takes its buffers
     from. Hence panics inside `ieee80211_crypto_decap` and `etharp_tmr` with none of our code on
     the stack, and hence invisible to `heap_caps_check_integrity_all()`, which validates block
     headers while the overrun landed in payload.

  **150 s soak after the fix: 0 resets, 0 panics** (previously 18 resets in 120 s). This also
  explains the "device only ever shows Ready" symptom: the device reached `link: claimed` and then
  crashed during the config burst before it could paint the operate screens. One bug, two symptoms.
- **Render stall resolved.** The gateway cycle now runs on core 0 while the renderer keeps core 1.
  Measured on hardware: **worst frame gap 2332 ms -> 68 ms**, sustained 30.3 fps, typical draw
  9-20 ms of a 33 ms budget, 170 s soak with 0 resets and 0 panics.

  The first attempt at this crashed within seconds and was withdrawn. The second core was never the
  problem; sharing mutable Arduino Strings across it was. Three things make it correct:
  `request()` hands the state lock back for the duration of every socket wait (tracking recursion
  depth explicitly, since a recursive mutex only releases when given back as many times as taken);
  all 14 touch-driven entry points take the lock themselves; and the renderer holds it across the
  whole frame — affordable only because of the first point — skipping a frame rather than painting
  from state being rewritten underneath it.
- **The device UI is a real operate surface**, not a status screen: contextual action bar,
  pull-down status drawer, and environment -> folder -> thread browsing. Orb state selection is a
  total table over the vocabulary the gateway actually sends; it previously matched only one of
  those words and rendered failed turns identically to idle ones. The four remaining animations
  (searching, solving, weaving, shaping) now have a gateway trigger: `src/agentVerb.mjs` derives
  them from the selected running thread's own tool activities and `refineThreadStatus()` publishes
  them on that row's `status`, which `orbModeForAgentState()` case-folds and maps. That path is
  covered by `test/agentVerb.test.mjs`; it has not been observed on glass.
- **Speaker and notification LED** are implemented behind compile flags. The LED pin (GPIO42) is
  documented from four vendor sources; no LED has been lit and no sound has been heard, so both
  remain hardware-unverified.
- **Conversation and attention state:** the console shows streamed assistant/tool activity,
  supports provider approvals plus structured user questions, folds verified T3 `task.*` activities
  into a bounded Agents & work tree/roster, and persists privacy-minimal notifications with cursor
  replay, acknowledgement, dismissal, and bounded retention. Scheduled-worker liveness is separate
  from connector/T3/provider health. Controllers retain capability-scoped approval/input/result and
  content-free task-count projections; the owner inbox is intentionally not exposed to devices.

Firmware compilation reports deprecated ESP32 legacy I2S/PCNT API warnings in capture/probe code.

## Correction notice

Milestone numbering clashes between artefacts: commit `321ae1d` calls the Parakeet/voice work
"Milestone 2" while the roadmap calls it Milestone 3. The roadmap's numbering is authoritative
here. Earlier revisions of this file recorded Milestones 2 and 3 as `todo` when both were largely
implemented, and listed "shared firmware gateway client" as an active blocker after it had been
resolved. Status claims in this file are now expected to cite the file or test that evidences them.

## Legend

| State | Meaning |
|---|---|
| done | Implemented and covered by the current verification gate |
| partial | Useful implementation exists, but the roadmap outcome is not met |
| todo | Scheduled but not implemented |
| blocked | No meaningful implementation can continue until the named dependency changes |

## Category progress

| Category | State | What is real now | What remains |
|---|---|---|---|
| 1. Open request and composer | done | Shared `ComposerShell` serves Operate and QuickPage; durable actor/operation-scoped request identity covers command writes plus raw media create/finalize recovery across memory/file/Convex, browser restart, firmware NVS retry, and stable connector ids | Deployed/live retry proof remains an environment qualification item |
| 2. Unified media | partial | Media library plus shared composer support browser upload, recording, camera capture, stored-media reuse, paste/drop, transcription/editing, retention, deletion, private raw upload sessions, source provenance, and bounded owner-triggered image/audio previews with retry across Memory/File/Convex | Hosted private R2/Convex lifecycle and deployed browser/device performance proof |
| 3. Voice transcription | partial | Local Parakeet/provider adapters, durable staged jobs, automatic device processing, raw upload/finalize sessions, abandoned-upload cleanup, transcript versions, review/auto-send, retry gates, and timing metrics exist | Hosted worker/storage proof and physical voice validation |
| 4. Controller voice | partial | Shared gateway client, Hosyond 16 kHz capture, and CrowPanel's capability-gated carrier capture all delegate to one raw segmented session transport without base64 expansion; the PWA has an owner/device-authenticated, five-minute, single-use QR/fragment handoff pinned to environment/thread/action and browser audio-input selection for phone/earbud capture; durable job polling, review/auto-send policy, request status, and compact response paths exist | Deployed PWA/phone/earbud usability plus physical end-to-end CrowPanel audio/camera/display proof |
| 5. T3 environments | partial | Typed recovery, current-label dependency confirmation, recoverable credential-free tombstones, explicit retention purge, outbound connector package/enrollment, cloud-mode direct-origin blocking, layered health, a single direct/connector `T3Adapter`, cached versioned read-only capability manifests, and guided handoff exist | npm publication and deployed connector/probe/Queue-Cron proof |
| 6. Live T3 conversation | partial | Persistent thread subscription with resume/dedup, event folding, streamed responses/tools, T3 approval UI, structured user input, a 64-node/16-activity evidence-linked T3 task inspector, durable privacy-minimal notifications, an opt-in queued Web Push boundary, scheduled-worker liveness, conservative T3 feature gates, and compact device capability state exist | Deployed Web Push/live-T3/browser/device qualification; any per-task control remains blocked until T3 certifies a targetable command |
| 7. Security, observability, testing | partial | Auth, policy, fail-closed firmware TLS source/build gates, rate limits, media ownership/quotas, signed URLs, redaction, audit, diagnostics, plus fixed-schema sampled Cloudflare request/DO/Queue/connector/rollout/Container telemetry, queries, and provisional alert thresholds have local coverage | Hosted telemetry field/privacy review, dashboards/alert delivery, native DLQ and Container lifecycle/cost correlation, production CA and negative-TLS hardware proof, voice/live attribution metrics, failure injection, and deployed end-to-end tests |

## Milestone progress

### Milestone 0.5 — independent repairs: done

| Item | State | Evidence |
|---|---|---|
| Remove environment + dependency repair | done | Current-label dependency preview and confirmation; connector/credential revocation; recoverable tombstone with bounded retention; idempotent restore; explicit user-scoped purge runner; actions/macros disabled with `environment_removed`; onboarding and device defaults repaired across Memory/File/Convex stores |
| Reason-specific recovery dialog | done | Eight failure reasons, retryability metadata, reason-specific instructions, and recovery polling behavior |
| First-turn attachments | done | Project launch resolves and passes attachments through the same ownership/type/limit checks as follow-up turns |
| Multiple attachments end to end | done | Ordered list, maximum of eight, scalar protocol-v1 alias, validation, and Operate add/remove/reorder controls |

The local Remove flow now retains a credential-free tombstone, requires the exact current label when
dependencies exist, and offers restore until the configured purge deadline. Hosted Queue/Cron
execution and deployed connector-socket closure remain environment proof, not local green claims.

### Milestone 0 — contracts and diagnostics: partial

Versioned thread detail/events, separate pending-interaction contracts, captured T3 fixtures,
long-lived subscription leases, sequence resume/dedup/reset behavior, typed recovery diagnostics,
a cached `next-coder.t3-capabilities.v1` manifest shared by direct/connector adapters, and the
durable command-request envelope have landed. The API decision is settled: existing command
write routes carry `clientRequestId`, while `GET /v1/requests/:clientRequestId` is a recovery read;
there is no second `POST /v1/requests` policy entry path. The evidence-limited work-node model is
implemented from T3 0.0.32's shipped contract. Media upload/finalize is a separate Category 2 state machine rather than being
mislabeled as a dispatched command; it is now locally implemented and awaits hosted object-store proof.

### Milestone 1 — live conversation and interaction parity: partial

Corrected: previously `todo`. The foundation has landed and the headline gap is closed —
`orchestration.subscribeThread` was a string constant that had never been called, and everything
the product knew about a running agent came from a five-second snapshot poll.

Done: `src/threadStream.mjs` opens a real long-lived subscription with Chunk acknowledgement
(Effect's RpcServer closes a latch per chunk and only an inbound Ack reopens it, so a reader that
does not ack stalls the stream — pinned by a test that stalls). Resume uses T3's own
`afterSequence`, keyed on the global event-log sequence rather than the activity's optional
per-turn one. An unfillable gap resolves as a fresh snapshot with `reset`+`gap`, so a client
replaces rather than appends. Watches are demand-driven 90 s leases. `src/commandArbiter.mjs`
gives the polled and live paths one decision point, so they cannot double-decide a command.
`frontend/src/liveThread.ts` + `useThreadWatch.ts` render it in Operate, with streaming deltas
accumulated rather than replaced, dedup on a bounded ring, and a connection claim that reports
`reconnecting` rather than a stale `live`.

Provider-approval routing has since landed. `src/providerApprovals.mjs` establishes the contract
from T3 0.0.32's own sources: the decision set is four values (`accept`, `acceptForSession`,
`decline`, `cancel`), not the binary approve/reject `buildT3Command()` had been folding everything
into — which made allow-always and cancel unreachable. Pending requests are derived from the
thread's activity log (the orchestration snapshot serves thread bodies empty), applying T3's own
clearing rule including the stale-failure case. Owner routes at
`/v1/t3/environments/:id/threads/:threadId/approvals`, a device route at
`/v1/device/provider-approvals/:requestId`, and the device poll now carries gateway holds and
provider requests under two separate keys rather than one list. Answers are claimed in the store
before dispatch, so a double-answer is idempotent, a conflicting one is refused, and an approval T3
has already abandoned is refused before anything is sent. `acceptForSession` is its own capability
and no hardware profile carries it.

Structured user input landed alongside it, as a THIRD blocking kind rather than a third approval
decision. T3 keeps `tool_user_input` off the approval path entirely
(`ProviderRuntimeIngestion.ts:372`), so it has its own activity pair, its own
`thread.user-input.respond` command, its own routes, its own store table and its own SSE event.
The three question shapes — single-choice, multi-choice, free-text — are derived from `options` and
`multiSelect`, rendered as the control they actually are, and validated against the request's own
questions **before** dispatch: an answer that is not an exact option label is silently dropped by
OpenCode, silently relabelled by xAI, and a hard failure on Codex, so guessing was never an option.
The durable row holds a SHA-256 fingerprint of the answers and nothing readable.

The device realm accepts exactly one shape — a single short multiple-choice question — and shows
every other question with the sentence to put on screen instead of an unanswerable form.

T3-native task inspection has now landed. `frontend/src/workGraph.ts` folds only verified
`task.started|progress|updated|completed` fields from T3 0.0.32, trusts its stamped `agentKind`, and
draws parent edges only from `parentAgentId`/`agentId`. The 64-node/16-activity projection replaces
on snapshot and inherits sequence/event-ID replay dedup; missing linkage becomes an explicit roster,
not an inferred graph. Agent-owned tools are re-homed by T3 attribution, background work keeps a
settled parent visibly in flight, reconnect/stopped projections say they may be stale, and there are
no fake per-agent controls because T3 exposes no certified target command. The device receives only
bounded status counts from `src/t3Work.mjs`. See `docs/t3-work-graph.md`.

Unproven: none of this has met a live T3 instance. It is verified against T3's checked-in contract
(read from its shipped source map), its real Effect runtime, and the current focused frontend suite,
including mutation checks for the trap cases.

### Milestone 2 — composer and connection: substantially done

Corrected: this was recorded as `partial` with the composer "not landed". It had landed.
`frontend/src/features/Composer.tsx` exports `ComposerShell`, `useComposerDraft`,
`buildComposerIntent` and `sendComposerIntent`, and pulls `MediaPicker`/`MediaCaptureDialog` from
`MediaCapture.tsx`; `Composer.test.tsx` covers ten cases including paste/drop, the single source
menu, camera reuse, and the server attachment ceiling. `QuickPage.tsx` imports the same composer
rather than forking it, and `MediaPage.tsx` reuses `MediaCaptureDialog` — a real extraction.
Connector-first connection uses `POST /v1/t3/connect-sessions` to mint the console's one-time code,
`POST /v1/connectors/enroll` for the local CLI's tokenless cloud redemption, and
`GET /v1/t3/connect-sessions/:id` for status. Cloud mode rejects the legacy direct `/redeem` path
before consuming the code or making outbound network requests. Guided recovery creates a replacement
enrollment and closes the old connector socket before issuing the new standing credential.

Outstanding: production proof of the connector-first flow. Direct Tailscale/Funnel enrollment is retained only for self-hosted/advanced
deployments; it is not the cloud production path.

### Milestone 3 — automatic Parakeet voice pipeline: substantially done

Corrected: this was recorded as `todo` asserting none of it existed. Most of it does.
`src/transcription.mjs` lists `parakeet` in `TRANSCRIPTION_PROVIDERS` with a dedicated adapter,
concurrency gate and three terminal pre-checks.
`src/mediaJobs.mjs` implements the durable stage machine
`queued → transcribing → normalizing → review_required|ready → dispatching → dispatched`.
Transcript versioning exists as
`rawTranscript`/`normalizedTranscript`/`userEditedTranscript` with the `describeTranscriptChange`
letter-preservation guard. Auto-send is `PUT /v1/devices/:id/voice-auto-send` with the policy
re-read at dispatch. Metrics cover `queueWaitMs`, `gateWaitMs`, `inferenceMs`, `realtimeFactor`.
The device loop is `POST /v1/device/media` → `GET /v1/device/media/jobs/:id`.

The two-step raw upload/finalize protocol is now implemented locally. Browser and shared-controller
clients create an authenticated session, stream exact raw bytes over private HTTP, and finalize only
after a second length/SHA-256 check. Pending/uploaded/finalized/aborted/expired is distinct from media
processing; Memory/File/Convex adapters persist it; retention removes abandoned staged bytes; and
responses redact object keys and user content. The legacy base64 routes remain only for compatibility.
No presigned R2 route or live hosted R2 lifecycle has been exercised, so that production proof remains.

### Milestone 4 — controller voice paths: partial

Corrected: the shared gateway client HAS been extracted. `firmware/shared/NextCoderCore/src/`
now holds `GatewayClient.{h,cpp}`, `GatewayDiscovery.{h,cpp}`, `GatewayOperate.cpp`,
`MediaUpload.{h,cpp}` and `OperateModel.h`; the Hosyond `main.cpp` instantiates `GatewayClient` and
`ui.cpp` includes `MediaUpload.h`. All four board folders pull `lib_extra_dirs = ../shared`.

The device can also now list and select its environment, project and thread — `GET/POST
/v1/device/environments`, `/v1/device/projects`, `/v1/device/threads` and the matching
`/v1/device/config/*` setters (documented in `docs/hardware-protocol.md`).

The PWA deep-link/QR companion is implemented locally with a separate one-shot fragment bearer;
`claimLink.ts` remains dedicated to device ownership claiming. Outstanding work is deployed
phone/earbud usability evidence and silicon validation of the operate UI and its gateway calls.

### Milestone 5 — adapter hardening and rollout: partial

The shared `T3Transport` boundary, direct/connector implementations, compatibility UI, deterministic
connector resilience tests, Cloudflare adapter boundaries, and conservative release controls have
landed. Rollouts are owner scoped, select stable percentage or explicit allowlist cohorts, require an
evidence reference for every transition, re-check protocol/capabilities during execution, retain
per-target truth across File/Convex stores, and reconcile through the Node timer or Cloudflare
Queue/Cron. Firmware may queue only an existing compatible signed release; connector rollout status
truthfully remains `awaiting_operator_update` until the local CLI reports the target version. A fully
consolidated versioned T3 adapter, staged live-T3 beta, and hosted load/failure/security/retention and
rollback evidence remain. Runbook: [../docs/release-rollouts.md](../docs/release-rollouts.md).

## Hardware status

| Board / component | State | Current evidence |
|---|---|---|
| CrowPanel 2.13-inch e-paper | partial | All four prior environments compile post-TLS; the new hermetic capture-placeholder target proves shared raw create/PUT/finalize transport at 20.4% RAM/37.5% flash without reading live config; verified reference pins/capability-off defaults remain unchanged; no current capture silicon validation recorded |
| Hosyond ES3C28P | done (hardware) | Only board validated end to end on silicon: provisioning, LAN discovery, claim, flash/PSRAM, battery, codec, microphone, ILI9341 display, polarity, touch, orb rendering, BOOT recovery. Operate UI confirmed on glass from photographs. 170 s soak: 0 resets, 0 panics, 30.3 fps, worst frame gap 68 ms. Speaker and LED compile but are unheard and unlit |
| Waveshare AMOLED 1.75C | partial | Both placeholder environments compile with shared `DeviceStore`/`Provisioning`/`GatewayClient` claim, health, rotation, OTA observation, and recovery (each 15.8% RAM/20.9% flash). The default heartbeat truthfully disables display, thread picker, microphone, and camera; the board, pin map, AMOLED, touch, audio, power, and OTA apply remain unverified on silicon |
| Vision Master T190 | partial | Shared `DeviceStore`/`Provisioning`/`GatewayClient`/`GatewayBrowse` now provide secure status and the compact environment/folder/thread/control/approval/response path. The default status-only build disables its unverified external encoder and thread-picker capability (16.9% RAM/34.2% flash); both the default and explicitly gated input variants compile, but display pins, input carrier, network flows, and all physical behavior remain unverified |
| Shared `NextCoderCore` | done | `DeviceStore`, `Provisioning`, `ThinkingOrb`, `OrbPainter`, `GatewayClient`, `GatewayDiscovery`, `GatewayOperate`, `MediaUpload` and `OperateModel` are shared across the board folders |

## Active blockers and next dependency

1. **Durable request production proof:** the single-path `clientRequestId` contract, bounded receipts,
   browser/NVS recovery, and stable connector ids are locally implemented; exercise browser/device
   retry during hosted Container rollover and real machine sleep/wake.
2. **Raw media production proof:** the private raw session/finalize/cleanup boundary is locally
   implemented; exercise live R2/Convex lifecycle, failure recovery, expiry, and hosted voice scale.

## Next recommended implementation order

The ordered, owner-assigned version of this list, with the evidence each step needs, is
[completion-plan.md](completion-plan.md).

1. Qualify raw upload/finalize, abandoned-session cleanup, and post-move retry through deployed R2/Convex.
2. Qualify notification replay, optional Web Push, and scheduled-worker liveness through deployed
   Queue/Cron/Convex, browser reconnect, VAPID rotation, and provider-failure exercises.
3. Publish and deploy the connector/cloud packages, then prove completed-reply onboarding with live T3.
4. Configure production roots and run negative-TLS plus physical controller-to-cloud validation;
   renew the remaining Hosyond probe/benchmark environments on an uncontended runner.
5. Run hosted telemetry/privacy/alert, Queue/DLQ/R2/Convex, Container cold-start/cost, rollover, load,
   failure, security, retention, and WAN/sleep gates.
6. Use the implemented rollout controls to stage the browser, voice, connector, and controller beta;
   record hosted cohort, per-target, promotion, cancellation, and rollback evidence.
