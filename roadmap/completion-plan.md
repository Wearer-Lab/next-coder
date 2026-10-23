# Completion plan

Written 2026-09-09 from the current tree. This is the single ordered list of everything that still
stands between the repository and the definition of done in the two active roadmaps. It does not
restate what is built; [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) does that, and the
[cloud roadmap's gap register](cloud-control-plane-connector-roadmap.md) (CG-01 to CG-12) is the
authoritative closure ledger this plan sequences. A task is closed by the evidence named in its
row, never by the code existing.

The headline: **the software is implemented and locally green; almost everything left is
external proof.** The repository holds every workflow, harness, and verifier needed to produce
that proof, and none of them has been run against a real account, a clean machine, a live T3, or a
physical controller over the internet. The plan therefore reads as an operations sequence with a
few engineering items folded in where they block it.

## How to read it

| Column | Meaning |
|---|---|
| Owner | **Maintainer** (holds the accounts and makes decisions), **Engineer** (repository changes), **Bench** (physical hardware in hand) |
| Closes | The gap register row, milestone, or definition-of-done line the task retires |
| Evidence | What must exist for the task to be marked done; local tests never qualify |

Effort figures are working days for one person and assume the accounts exist. Wall-clock is
longer: provider approvals, reviewer availability, and hardware lead times are outside the
estimate. The evidence documents have freshness windows (72 hours for the promotion manifest,
14 days for final qualification), so Phases 4 to 7 must be scheduled back to back rather than
trickled.

## Critical path

```
Phase 0 ── Phase 1 ── Phase 2 ──┬── Phase 3 ──┐
 repo      accounts   staging   │   npm       │
 hygiene   & envs     deploy    ├── Phase 4 ──┼── Phase 7
                                │   hosted    │   production
                                ├── Phase 5 ──┤   + beta
                                │   journey   │
                                └── Phase 6 ──┘
                                    hardware
```

Phases 3 to 6 can run in parallel once staging exists. Phase 5 needs Phase 3 (the published
package is part of the journey). Phase 6 needs Phase 2 (a public TLS origin) and produces evidence
Phase 7 consumes. Phase 7 needs all four.

## Phase 0 — Release preconditions (Engineer + Maintainer, 1 to 2 days)

Nothing here needs a cloud account. Everything here must be true before the repository goes public
or anything is published.

| # | Task | Owner | Closes | Evidence |
|---|---|---|---|---|
| 0.1 | **Confirm the license.** Apache-2.0 was chosen on 2026-09-08 as a defensible default; the maintainer must ratify it or replace it before the repository is public. Root `LICENSE`, `packages/connector/LICENSE`, and both manifests already carry it. | Maintainer | CG-04, CG-10 | Written decision; `npm run pack:connector` and the release helper's license check pass |
| 0.2 | **Deferred, tracked in [deferred-items.md](../docs/deferred-items.md).** Rotate every credential that was ever tracked. The bench device secret and home Wi-Fi password from the purged `controller_config.old.h` (never pushed, but present in the local backup mirror), and the previously exposed Convex gateway secret that CG-10 records as still needing external rotation. | Maintainer | CG-10 | Rotation recorded outside the repository; Convex env and `GATEWAY_CONVEX_SECRET` replaced |
| 0.3 | **Deferred, tracked in [deferred-items.md](../docs/deferred-items.md).** Delete the pre-rewrite mirror `~/Documents/Claude/Projects/next-coder-pre-oss-backup.git` once 0.2 is done. It is the last copy of those secrets. | Maintainer | CG-10 | Mirror gone |
| 0.4 | **Move the working checkout off the cloud-synced folder** (or exclude it from File Provider sync). The status ledger, firmware gate, and this week's hollow `node_modules` all trace to sync interference. | Maintainer | Status ledger reliability | A full `npm test` completes without a worker-startup timeout |
| 0.5 | **Update the stale ledger rows.** The two examples this row originally named are already corrected: CG-10 now records the 2026-09-08 history rewrite, and CLAUDE.md no longer calls the orb verb compare a known gap. A 2026-09-09 audit found the remaining drift elsewhere — stale test/size counts, `src/app.mjs` and Store-method figures, `DANGEROUS_SHELL_PATTERNS` and the intent-type list, a "terminal write is not implemented" note in `docs/api.md`, stale `#L` anchors and route/method names in `docs/device-setup-flow.md`, and a README claim that no vendor documentation is redistributed. | Engineer | CG-11 | `npm run check:docs` passes; rows cite the 2026-09-08 rewrite |
| 0.6 | **Bump the pinned GitHub Actions.** Done 2026-09-09: all four moved off the deprecated Node 20 runtime, and each new SHA was re-resolved against its tag independently. | Engineer | Hygiene | CI green with no deprecation annotation. Note this only exercises `ci.yml`; the four protected workflows carry the same pins and are dispatch-only, so verify each pinned SHA resolves to its claimed tag rather than discovering a bad pin in a reviewer-gated run |
| 0.7 | **Done 2026-09-09.** Repository is public; private vulnerability reporting is on; `main` requires all eight CI jobs with force-push, deletion and non-linear history refused; a ruleset protects `connector-v*` tags against update and deletion. Administrators still bypass branch protection, so the owner can push to `main` directly. | Maintainer | CG-04 setup | Verified through the GitHub API |

## Phase 1 — Accounts, environments, and secrets (Maintainer, 1 to 2 days plus provider lead time)

The protected workflows refuse to run until these exist. Every value is scoped to one purpose; the
runbooks list them exactly and this plan does not repeat the tables.

**Work from [operator-setup.md](../docs/operator-setup.md).** It collapses this phase and Phase 2
into one ordered sequence, with every secret name cross-checked against the workflow that actually
consumes it and a verification step after each stage. The per-surface runbooks remain the reference
for detail.

| # | Task | Runbook | Notes |
|---|---|---|---|
| 1.1 | Cloudflare **staging** account on the Workers Paid plan (Containers require it), with a bootstrap token limited to Workers/Containers, Queues, R2 and reads on that account only | [staging-bootstrap.md](../docs/staging-bootstrap.md) | Isolated from production by account, not by naming |
| 1.2 | Cloudflare **production** account, separate token, separate Convex deployment, pre-provisioned media and firmware buckets | [production-promotion.md](../docs/production-promotion.md) | Promotion never creates resources |
| 1.3 | **Convex** staging and production deployments with deploy keys | [auth-storage.md](../docs/auth-storage.md) | `npm run smoke:convex` against staging is the first check |
| 1.4 | **Clerk** staging and production instances (secret and publishable keys) | [auth-storage.md](../docs/auth-storage.md) | Cloud mode disables dev tokens; a real Clerk user is required for qualification |
| 1.5 | Generate the runtime secrets: T3 token encryption key, gateway Convex secret (entered identically in Cloudflare and Convex), Web Push VAPID key set and sealing key, R2 access keys | [notifications.md](../docs/notifications.md), [staging-bootstrap.md](../docs/staging-bootstrap.md) | Rotation-aware `WEB_PUSH_VAPID_KEYS` form |
| 1.6 | GitHub environments **`staging-bootstrap`**, **`staging`**, **`npm-release`**, **`production`**. Staging and npm-release: you are the sole reviewer with **prevent-self-review off**, so you approve your own dispatch and these are solo-operable today. Production: **prevent-self-review on** and reviewers who are not you | **Three created 2026-09-09**; secrets still unset. [operator-setup.md](../docs/operator-setup.md) §4.0 | Two GitHub facts drive this. Self-review is allowed unless you switch it off, so a solo maintainer is not blocked. And when several reviewers are listed, **one** approval is enough, so extra names never create two-person control |
| 1.7 | **npm**: decide the final package name and scope (the `@next-coder` organisation must exist and be owned), register the package, configure the GitHub Actions trusted publisher for `npm-connector-release.yml` and environment `npm-release`, then disable token publishing | [npm-connector-release.md](../docs/npm-connector-release.md) | Open question in the cloud roadmap §21; no `NPM_TOKEN` anywhere |
| 1.8 | A **T3 host for staging**: one machine with T3 Code installed and a provider (Codex, Claude, OpenCode or xAI) authenticated, reachable only by its own connector | [staging-qualification.md](../docs/staging-qualification.md) | Also serves as the first clean connector host in Phase 3 |

## Phase 2 — First staging deployment (Maintainer runs, Engineer on call, 2 to 4 days)

| # | Task | Closes | Evidence |
|---|---|---|---|
| 2.1 | Dispatch **staging bootstrap**: three Queues, two buckets, edge stub, secrets, Convex, private control plane, final edge | CG-07 | `next-coder.staging-bootstrap` evidence artifact; `/health` reports every binding ready |
| 2.2 | Dispatch **staging release** to move from the bootstrapped commit A to a later commit B, then roll back to A. Release refuses `target == current` (`target_must_differ_from_current`), so B must be a real forward commit, and it must not touch `convex/` or either Durable Object topology or the rollback is refused as incompatible | CG-07 | Two `next-coder.staging-release.v1` artifacts, one `deploy` and one `rollback` |
| 2.3 | Run **qualification level 1**, the credential-free boundary: public health, cloud-mode auth config, exact `404` on every private capability | CG-07, Milestone 2 | `staging-boundary-evidence.json` |
| 2.4 | Run **qualification level 2**, authenticated connector-first readiness, with a real Clerk user and the Phase 1.8 host enrolled through `npx` | CG-05, Milestone 2 | Readiness evidence with all five layers green |
| 2.5 | Run **qualification level 3**, the completed first command: one thread, one prompt, a `completed` reply from a live provider | CG-05, Milestone 1 first-reply proof | `staging-first-command-evidence.json` |

Anything that fails here is an engineering item and goes to the top of the queue; the harnesses
were written against loopback fixtures and this is the first time they meet the real platform.

## Phase 3 — Publish the connector (Maintainer + Engineer, 2 to 3 days plus three clean hosts)

| # | Task | Closes | Evidence |
|---|---|---|---|
| 3.1 | Tag `connector-v0.1.0` (annotated, on `main`) and dispatch **npm-connector-release**; review the redacted evidence and the registry provenance | CG-04 | Registry digest and provenance attestation; package page shows the repository link |
| 3.2 | **Clean-host proof on macOS, Linux, and Windows**: exact-version `npm exec` with no checkout; `connect --install-service`; service start/status/doctor; native credential store write/read/delete and plaintext migration; owned T3 auto-start, pairing, stop and PID-tree cleanup; `update` with rollback; `rotate` with the ten-minute overlap and old-ticket rejection; disconnect | CG-04, Milestone 5 | One redacted record per platform covering every command; console shows the package version |
| 3.3 | **Sleep, WAN, and restart drills** on those hosts: laptop lid close and wake, Wi-Fi to tethering, process kill during a request, connector restart during a subscription | CG-03 | Replay of only live pending requests, lease and cursor restoration, stale-connection rejection, all observed against staging |

## Phase 4 — Hosted qualification matrices (Engineer runs, Maintainer attests, 5 to 8 days)

These produce the two operator attestations production promotion demands
(`next-coder.staging-capacity.v1` and `next-coder.staging-security.v1`) plus the
observability sign-off. All of them run against the Phase 2 stack.

| # | Matrix | Runbook | Closes | Evidence |
|---|---|---|---|---|
| 4.1 | **Queue/Cron ownership**: scheduled batches, controlled retry, controlled quarantine, DLQ correlation with Cloudflare's native metric, rollout reconciliation | [cloud-observability.md](../docs/cloud-observability.md) §Staging qualification | CG-01 | Redacted query results per event class |
| 4.2 | **Online revocation** through the deployed Service Binding: socket closes, heartbeat stops, in-flight work terminalises, no ticket race, replacement enrollment succeeds | [production-security.md](../docs/production-security.md) | CG-02 | Drill record |
| 4.3 | **Durable Object eviction and deploy rollover** with a browser and a device mid-request; durable request replay via `clientRequestId`; raw media upload retry across the rollover. Replay is scripted: `npm run drill:request-replay` | Engineer | CG-03, CG-12, status blocker 1 | No duplicate command, no lost receipt |
| 4.4 | **Capacity on `standard-1`**: the seven staging decision gates in [capacity-slo.md](../docs/capacity-slo.md) (CPU/memory high-water, cold and warm start, per-hop p50/p95/p99, 16 environments × 48 requests × saturated DO, Redis continuity across restart, soak availability, a billing observation) and the singleton-versus-partition decision | [capacity-slo.md](../docs/capacity-slo.md) | CG-08, CG-12 | Capacity attestation with an accepted decision and rollback thresholds |
| 4.5 | **Observability and privacy review**: both Analytics Engine datasets populated, dashboards and alert delivery live, every returned column and log field reviewed for paths, identifiers, content, secrets | [cloud-observability.md](../docs/cloud-observability.md) | CG-01, CG-12, Category 7 | Dashboard and alert references; a zero-finding privacy review |
| 4.6a | **Raw media lifecycle on R2:** session create, PUT, finalize, integrity refusal, abandoned-session cleanup, retention purge, signed URL expiry. Scripted: `npm run drill:media-lifecycle` | Engineer | Cat. 2, status blocker 2 | Redacted lifecycle log |
| 4.6b | **Voice pipeline:** transcription through the Parakeet sidecar or a configured provider, review and auto-send policy at hosted scale | Engineer | Cat. 3 | Redacted job log with timings |
| 4.6c | **Notifications and Web Push:** durable replay after browser reconnect, opt-in push delivery, VAPID rotation using the Phase 1.5 key set, scheduled-worker liveness. No push path has been exercised anywhere yet | Engineer | Cat. 6 | Delivery and rotation record |
| 4.7 | **Security drill**: TLS-only enforcement behind the proxy, rate-limit backend outage behaviour, connector credential rotation under load, browser response boundary, retention of connector results | [production-security.md](../docs/production-security.md) | CG-07 security input | Security attestation. **No tooling or schema exists for this record, nor for 4.1 and 4.5.** 4.7 emits `next-coder.staging-security.v1`, which Phase 7.1 hashes into the promotion manifest, so its shape must be settled before Phase 7 |

Decision folded in: **where Parakeet runs in production** (connector capability or operator
service, cloud roadmap §21). Task 4.6 cannot finish without it; the default for the first beta is
an operator-run sidecar, which needs no new code.

## Phase 5 — The truthful product journey (Engineer + Maintainer, 4 to 6 days)

The definition of done is a single traced journey. Every line below is exercised from a fresh
account, through the published package, against the deployed cloud and a live provider, on a
representative desktop browser and a phone.

| # | Task | Closes | Evidence |
|---|---|---|---|
| 5.1 | Fresh account → onboarding → one copied `npx` command → connector online → first streamed reply, with usability notes on a narrow viewport | CG-05, Milestones 0 and 2 | Screen recording and readiness evidence |
| 5.2 | **Live conversation parity**: streaming deltas, tool activity, all four provider approval decisions including allow-always, all three structured-question shapes, the Agents & work tree on a multi-agent turn, stop and interrupt, resume with a replay gap (`reset` + `gap`) | Milestone 1, Category 6 | One record per interaction kind, against the live T3 version in use |
| 5.3 | **Live T3 compatibility check**: confirm the capability manifest against the current T3 release (the contract was read from 0.0.32; T3 moves quickly) and record what the manifest disables | Milestone 5 | Manifest snapshot with version |
| 5.4 | **Composer and media**: paste/drop, camera, recording, stored-media reuse, image attachment reaching the agent, transcript review and edit, auto-send policy | Milestones 2 and 3 | Journey record |
| 5.5 | **Phone companion**: QR handoff, browser-selected Bluetooth earbuds as the microphone, single-use expiry | Milestone 4 software half | Journey record on a real phone |
| 5.6 | **Browser performance**: multi-hour heap soak on a real stream, CPU/GPU profile on desktop and a mid-range phone, the frontend budgets re-measured against the deployed bundle | CG-12 | Update to [frontend-performance-gate.md](../docs/frontend-performance-gate.md) |

## Phase 6 — Hardware (Bench + Engineer, 6 to 10 days plus lead time)

All four boards are in scope, sequenced by evidence. Hosyond is the only one with silicon evidence
and has never spoken to the cloud over the internet, so it goes first and proves the path; CrowPanel,
Waveshare and T190 follow through the same steps once that path is known good. Keep each board's UI
and media capabilities disabled until its own hardware proof exists, so a compile is never mistaken
for a working peripheral.

| # | Task | Closes | Evidence |
|---|---|---|---|
| 6.1 | **Renew the firmware matrix** on an uncontended runner: all 15 environments, including the Hosyond probes and benchmarks that still rest on older compilation evidence | CG-09 | Green report in [firmware-build-gate.md](../docs/firmware-build-gate.md) |
| 6.2 | **Production roots and negative TLS on Hosyond**: inject current and next roots, clock bootstrap, refuse expired and untrusted certificates, refuse plaintext, root rotation via OTA | CG-09, DoD "production roots proven" | Packet and runtime logs, credentials redacted |
| 6.3 | **Full controller loop over WAN**: claim, provisioning, browse environment → folder → thread, create a thread, send a prompt, hold-to-talk upload, approval and single-choice question, final result on glass; Wi-Fi loss, connector sleep, and reconnect | CG-06, CG-09, Milestone 4 | Complete controller-to-cloud-to-T3 trace |
| 6.4 | **Display-state matrix on glass**: online, sleeping, connector offline, T3 auth failed, provider auth required, stale, ready, action, approval, response | CG-06 | Photograph per state |
| 6.5 | **Speaker and notification LED** are compiled in but have never sounded or lit; verify or disable the flags before beta | Status ledger | Bench note |
| 6.6 | **OTA rollback drills**: application-level drill image, then the custom-bootloader drill, on real hardware; decide whether the eFuse secure-boot ceremony is in scope for the beta | Milestone 5, [production-security.md](../docs/production-security.md) | `rolled_back` observed twice; written eFuse decision |
| 6.7 | **CrowPanel**: silicon validation of the post-TLS build and the capture path; then Waveshare and T190 bring-up (pin maps unverified) and the PDM/I2S carrier prototype | Milestone 4 hardware half | Per-board records; do not enable their UI or media capabilities before this |

## Phase 7 — Production promotion and staged beta (Maintainer, 2 to 3 days once evidence is fresh)

| # | Task | Closes | Evidence |
|---|---|---|---|
| 7.1 | Use `node scripts/make-evidence-bundle.mjs` ([evidence-bundles.md](../docs/evidence-bundles.md)) to assemble the **promotion evidence bundle**: staging release, qualification, capacity and security records for one forward commit, hashed into the manifest, all under 72 hours old | CG-07 | Reviewed manifest SHA-256 |
| 7.1b | **Publish the bundle as a GitHub artifact.** Promotion downloads `evidence_artifact_name` from a completed same-repository run, but no workflow uploads a flat artifact containing the manifest plus its four evidence files: every existing upload step emits one evidence JSON under its own name. This is unwritten engineering work, and until it exists 7.2 cannot be dispatched at all | Engineer | CG-07 | A dispatchable workflow that uploads the reviewed bundle as one flat artifact |
| 7.2 | Dispatch **production promotion** through its four checkpoints: read-only preflight, Convex plus private Container, public edge, postflight | CG-07 | `next-coder.production-promotion.v1` artifacts; commit annotations match |
| 7.3 | **Rollback rehearsal**: a compatible rollback through staging release, and a written incident plan for the Convex/DO-migration case the workflow refuses to automate | CG-07, Milestone 5 | Rehearsal record and plan |
| 7.4 | **Staged cohorts** using the implemented rollout controls: internal, then browser-only owners, then voice, then connector update, then controller firmware, each with an evidence reference per transition and a recorded cancellation | Milestone 5 | Rollout ledger per cohort |
| 7.5 | **Final qualification**: nine evidence records within 14 days, verified by `npm run verify:final-qualification`; then flip the status ledger rows to done | Every remaining DoD line | Verifier passes on the release checkout |

## Open decisions the maintainer owns

These are not blocked on code. Each has a default that lets work continue.

| Decision | Default if undecided | Needed by |
|---|---|---|
| License ratification | **Apache-2.0, ratified 2026-09-09** | done |
| npm package name and scope ownership | `@wearer-haitch/connector` as committed | Phase 1.7 |
| Where Parakeet inference runs | **Operator-run sidecar next to the Container.** Decided 2026-09-09; not a connector capability | Phase 4.6b |
| Singleton Container versus partitioning versus admission queue | Singleton with the provisional 16-environment budget | Phase 4.4 |
| Console realtime stays SSE or moves to WebSocket | SSE | After beta |
| Beta concurrency and Cloudflare cost budget | Set from the Phase 4.4 billing observation | Phase 7.4 |
| Hardware scope for the beta | **All four boards, Hosyond first.** Decided 2026-09-09 | Phase 6 |
| eFuse secure boot and flash encryption | Deferred; rollback drills still required | Phase 6.6 |
| **Who reviews production** | **No default, and needed only at Phase 7.** Prevent-self-review is on for production alone, so its reviewer must be someone other than you. Staging, qualification and the npm publish all run solo | Phase 7.2 |

## What "done" looks like

One bundle links a clean npm installation, a fresh-account enrollment, a deployed Cloudflare request
path, a live local T3 and provider, a first streamed response, approval and structured-input
handling, sleep and reconnect replay, immediate revocation, a controller claiming and operating
over verified TLS, hosted observability with bounded performance, a rehearsed rollback, and a
credential-safe repository. That is the cloud roadmap's §22.2 audit, and this plan is its order of
operations.
