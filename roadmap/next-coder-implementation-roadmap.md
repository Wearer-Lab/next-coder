# Next Coder Implementation Roadmap

> **Superseded in part.** This document tracks the original twelve-phase build and remains the
> ledger of record for hardware and commercial execution (eFuse ceremony, OTA rollback, hardware
> capture validation, beta adoption). It is **not** current on product usability: a 2026-08-24
> codebase review found the input surface, media flow, voice pipeline, and environment lifecycle
> materially incomplete despite the phase table below once reading "Done". Subsequent local
> implementation is reflected in the current-status table and newer ledger linked below.
>
> For that work see
> [open-input-media-voice-environments-roadmap.md](open-input-media-voice-environments-roadmap.md).
> Current delivery state is maintained in
> [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md). Where these documents disagree, the newer
> roadmap and its status ledger win.

## Current Status

Every phase reached the limit of what its original scope required. Phases 3, 6, and 8 shipped
important plumbing but not the complete product experience and are reopened in the active roadmap.
As of 2026-08-27, active-roadmap Milestone 0.5 is complete; Milestones 2 and 3 are substantially
implemented, while Milestones 0, 1, 4, and 5 remain partial pending their named external proof.

| Phase | Status | Notes |
|---|---|---|
| 0 Product scope | Done | All three v1 workflows; deferred items still deferred |
| 1 Cloud foundation | Locally implemented; deploy open | Convex/file/memory stores, S3-compatible media, Worker/DO/Queue adapters, private Container, and protected deploy/bootstrap automation exist; no hosted deployment is claimed |
| 2 T3 integration | Locally implemented; live proof open | HTTP/Effect RPC, shared direct/connector adapter, outbound connector routing, subscriptions, background Queue/Cron ownership, and capability probes exist; deployed live-T3 parity remains unproven |
| 3 Environment pairing | Locally implemented; external proof open | Connector-first one-command enrollment, separate connector credentials, native credential adapters with private-file fallback, layered health, eight typed failure reasons, guided recovery, and dependency-aware removal are implemented. npm publication plus deployed cloud/live-T3 and clean-host OS proof remain |
| 4 Device provisioning | Code done; physical proof partial | QR claim labels and shared fail-closed CA validation/rotation exist across credential paths. **Production-root negative-TLS proof and eFuse ceremony outstanding** |
| 5 Firmware MVP | Code done, hardware partial | The canonical matrix contains 15 environments across four board folders. Current post-TLS evidence covers the secure release images, all CrowPanel/Waveshare environments, shared secure Waveshare claim/health/recovery, and default plus capability-gated T190 builds; a complete quiet-runner renewal is still open. Hosyond provisioning, audio, display, and orb UI have been exercised on silicon; CrowPanel, Waveshare, and T190 still lack current hardware validation |
| 6 Text / audio / camera | **Substantially implemented; external proof open** | Shared Operate/Quick composer, ordered and first-turn attachments, browser/device capture, raw integrity-finalized sessions, source-aware previews, durable request receipts and media jobs, automatic device transcription, and Parakeet/provider adapters are implemented. Hosted storage/worker and physical voice proof remain; see Categories 1–4 of the newer roadmap |
| 7 Policy engine | Done | All 8 dimensions; credential/deletion/install screening; custom profiles |
| 8 Phone and web apps | **Partially reopened** | PWA, scoped single-use phone companion, shared Quick/Operate composer, profile editor, billing, live T3 response/provider interactions, evidence-linked T3 task/subagent visibility, durable notifications, and optional Web Push exist. Deployed browser/WAN/live-T3/Web Push proof remains. See Categories 1, 4, and 6 |
| 9 Shell input | Done | Stages 1–4; `terminal:operate` opt-in, confirm-always, dispatched over WS |
| 10 Observability | Locally implemented; hosted proof open | Application metrics plus privacy-safe Worker/DO/Queue/Container telemetry, operational queries, and provisional thresholds exist; hosted ingestion/privacy/dashboard/alert delivery remains unproven |
| 11 Beta launch | Measurable | `/v1/observability/beta-readiness`. **Needs real users** |
| 12 Commercial | Code done | Billing, transfer/reset, diagnostics, OTA + rollback. **Rollback untested on hardware** |

### Outstanding, and not completable by writing code

1. **Secure boot / flash encryption** — irreversible eFuse operations. Build config ships; the key
   ceremony is a human decision. See `docs/production-security.md`.
2. **OTA rollback test** — four-step procedure documented; needs one board and a deliberately
   broken image. Keep `ENABLE_OTA_APPLY=0` on shipping units until it passes.
3. **Remaining hardware validation** — Hosyond I2S audio and display now run on a board. CrowPanel
   capture, Waveshare display/touch/audio/pins, T190 display/input/network flows, and OTA rollback
   still need silicon evidence. The corresponding code and compile gates are not physical proof.
4. **Beta** — 10–20 users and 50+ paired device-days is real adoption over real time.

The remaining qualification gaps for Phases 3, 6, and 8 are tracked in
[open-input-media-voice-environments-roadmap.md](open-input-media-voice-environments-roadmap.md).

### Verified during implementation

- At this historical roadmap checkpoint, the then-current frontend, server, and firmware gates
  passed. The current 15-environment inventory and newer evidence live in
  `roadmap/IMPLEMENTATION-STATUS.md` and `docs/firmware-build-gate.md`.
- Hosyond ES3C28P: 8 MB PSRAM, 16 MB flash, battery telemetry, ES8311 codec/microphone, SoftAP
  provisioning, ILI9341 display, panel polarity, and the orb UI exercised on silicon; orb rendering
  quality/buffer tuning remains active.

- T3's WebSocket RPC protocol reverse-engineered and confirmed live against T3 Code 0.0.28.
- Provider catalogue read live from `server.getConfig`.
- QR encoder checked byte-for-byte against two independent encoders and decoded by OpenCV.
- SigV4 checked against official AWS vectors and round-tripped through MinIO.
- Partition table confirmed byte-for-byte against the attached ESP32-S3.
- Original local E2E on `/Users/you/Documents/Claude/Projects/Tacs` remains valid.

## Target Architecture

```text
Controller device ── authenticated HTTPS/WSS ─┐
                                              ├── Next Coder cloud control plane
Web console / phone PWA ── HTTPS/SSE ─────────┤   Cloudflare edge + private control plane
                                              │   Convex state + R2 media + Queue/Cron work
User machine                                  │
  T3 Code <── loopback or Tailnet ── connector CLI ── outbound authenticated WSS/HTTPS ──┘
  Tailscale (optional, operator-managed)
```

The cloud platform owns identity, device control, policy, routing, media processing, and audit logs.
T3 Code remains the private execution runtime that owns providers, terminals, projects, threads,
and workspace state. The cloud never reaches into a user's LAN or Tailnet: the local connector
discovers or launches T3, keeps T3 access material on that machine, and initiates the outbound
control channel. Controllers connect to the stable cloud origin and never run Tailscale.

## Phase 0: Product Scope

Define v1 around three workflows:

- Remote status: inspect active T3 Code environments, projects, threads, and agent state.
- Remote prompt: send text or audio prompts to Codex or Claude.
- Remote control: stop, continue, approve, reject, and run saved macros.

Defer until later:

- Continuous video.
- Arbitrary terminal streaming from the hardware device.
- Multi-user team permissions.
- Integration marketplace.
- LoRa remote mode.

## Phase 1: Cloud Foundation

Build the cloud SaaS control plane with an explicit local/reference adapter.

Core services:

- Auth service.
- User accounts.
- Organizations, optional for later.
- Device registry.
- Device pairing.
- Device policy profiles.
- T3 environment registry.
- Command router.
- Audit log.
- Media upload and processing pipeline.

Chosen production stack:

```text
Public edge: Cloudflare Worker + Static Assets
Connection coordination: per-environment Durable Objects
Private control plane: Cloudflare Container/Worker service binding
Local/reference adapter: Node.js 22+ ESM HTTP server
Auth: Clerk
Storage: Convex
Realtime: connector WebSocket plus demand-driven SSE/device projections
Background work: Cloudflare Queues, Cron, and Durable Object alarms
Object storage: R2 in production; adapter-backed local disk only in development
```

Initial Convex tables:

```text
users
devices
device_credentials
device_sessions
t3_environments
connector_credentials
connector_tickets
controller_profiles
commands
command_events
media_uploads
audit_logs
```

Gateway boundary:

```text
HTTP/API routes -> Store API -> Convex functions
```

Keep gateway domain and route code independent from Convex and Cloudflare runtime APIs. Memory/file
stores and the Node server are reference adapters; production uses Convex, R2, Queue/Cron, Durable
Objects, and the private control-plane binding without assuming a permanent process or local disk.

## Phase 2: T3 Code Integration

Treat T3 Code as a versioned local external system behind one `T3Transport` boundary. The connector
uses T3's HTTP and Effect WebSocket contracts on the user's machine; cloud application code uses the
connector transport and never calls a stored user-machine `baseUrl` in production.

Known useful endpoints:

```text
GET  /.well-known/t3/environment
POST /oauth/token
GET  /api/orchestration/snapshot
POST /api/orchestration/dispatch
POST /api/auth/websocket-ticket
GET  /ws?wsTicket=...
```

Production flow:

```text
controller | console -> cloud policy/router -> outbound connector channel -> local T3
local T3 events -> connector cursor/dedup -> cloud projection -> subscribed surfaces
```

Snapshots remain the authoritative reset path. Live subscriptions are demand-driven and resumable;
disconnects use leases, cursors, idempotency keys, bounded replay, and an explicit snapshot reset on
an unfillable gap. Dispatch acknowledgement remains distinct from completed provider work.

Required T3 scopes for normal remote agent control:

```text
orchestration:read
orchestration:operate
```

Keep this separate and opt-in:

```text
terminal:operate
```

## Phase 3: T3 Environment Pairing

Production user flow:

1. User opens the web dashboard.
2. The console mints a short-lived, single-use connector enrollment code and a copyable `npx`
   command.
3. The user runs `npx @next-coder/connector connect --server <cloud-origin> --code <code>`.
4. The connector discovers or safely launches local T3, performs local T3 authentication, and keeps
   the resulting access material in the OS credential store or an explicit mode-`0600` fallback.
5. The connector redeems the cloud code for an environment-scoped standing credential, exchanges it
   for a short-lived socket ticket, and opens the outbound channel.
6. The console advances truthfully through cloud, connector, T3, provider, and first-completed-action
   readiness. A socket connection or accepted dispatch alone is not “ready.”

Self-hosted development may retain an explicitly named direct-transport flow. It is not the cloud
product contract, and the cloud must never store a T3 access/pairing token, require an inbound port,
or join a customer's Tailnet. Tailscale may protect connector-to-T3 traffic on the user machine but
is not installed on controllers and is not required in the cloud account.

## Phase 4: Device Provisioning

Manufacturing flow:

```text
Generate device_id
Generate per-device secret or keypair
Flash firmware
Print QR code
Store public identity in platform
```

User pairing flow:

```text
Device shows code / QR
User logs into web app
User claims device
Platform binds device to account
Device receives profile
```

Minimum production security:

- TLS only.
- Per-device credential.
- Credential rotation.
- Lost-device revocation.
- Firmware version tracking.
- OTA update support.
- Secure boot and flash encryption where practical.

## Phase 5: Device Firmware MVP

For the ESP32 controller:

- Wi-Fi setup.
- Device authentication.
- Authenticated outbound HTTPS/WSS connection to the cloud control plane.
- E-ink status rendering.
- Rotary encoder and menu navigation.
- Button actions.
- OTA update check.
- Heartbeat, battery, and status reporting.

First device actions:

```text
status
switch environment
switch thread
send saved prompt
continue
stop
approve
reject
```

Allow shell input capture from hardware, phone, and web clients, but route it through the platform policy engine before dispatch. In early firmware, keep hardware shell entry to short macro-style inputs because the encoder/e-ink UI is not ergonomic for long commands.

## Phase 6: Text, Audio, And Camera Input

Normalize every input into a platform command:

```ts
type UserIntent =
  | { type: "agent_prompt"; text: string; source: "web" | "phone" | "device" }
  | { type: "shell_input"; command: string; targetTerminalId?: string }
  | { type: "approval_response"; requestId: string; decision: "approve" | "reject" }
  | { type: "media_prompt"; text?: string; imageUrl?: string; audioTranscript?: string };
```

Text flow:

```text
phone/web/device -> cloud policy/router -> local connector -> T3 thread.turn.start
```

Audio flow:

```text
device/phone -> cloud private upload -> durable transcription -> preview -> connector dispatch
```

Camera flow:

```text
device/phone -> cloud private image upload -> vision/attachment -> connector dispatch
```

For ESP32, start with:

- Short push-to-talk audio clips.
- Still images.
- No continuous video.

Continuous audio/video will stress battery, bandwidth, memory, and cloud cost.

## Phase 7: Policy Engine

Because shell input is allowed, policy is a core platform feature from the start.

Separate input capability from execution permission:

```text
Device can capture shell text
Platform decides whether it may execute
```

Policy dimensions:

```text
user
device
environment
command type
risk level
time window
network location
subscription tier
```

Example profiles:

```text
Read-only
Agent prompts only
Approvals allowed
Media prompts allowed
Terminal input allowed
Admin
```

Require confirmation for:

```text
destructive shell commands
git push
deployments
file deletion
credential access
package install
terminal:operate actions
```

## Phase 8: Phone And Web Apps

Web dashboard:

- Device management.
- T3 environment pairing.
- Session browser.
- Prompt composer.
- Audio and camera input.
- Approval queue.
- Audit log.
- Profile editor.
- Billing.

Phone app or PWA:

- Push-to-talk.
- Camera prompt.
- Approval notifications.
- Device setup.
- Quick macros.

If BLE setup is required on iPhone, plan for a native app eventually. Browser BLE support on iOS is not a strong foundation.

## Phase 9: Shell Input

Add shell control in stages:

1. Shell as agent prompt: "Run npm test and summarize."
2. Saved shell macros: predefined commands only.
3. Direct terminal write: requires `terminal:operate`.
4. Interactive terminal: web/phone only, not e-ink hardware.

This avoids turning the hardware into an unaudited remote shell.

## Phase 10: Reliability And Observability

Track:

```text
device online/offline
last heartbeat
command latency
T3 environment reachable/unreachable
token expiration
failed dispatches
media processing failures
firmware version
battery level
```

Add audit events for every remote action:

```text
who
device
environment
thread
input type
normalized command
risk level
result
timestamp
```

## Phase 11: Beta Launch

Beta success criteria:

```text
10-20 users
50+ paired device-days
<2s median command acknowledgement
<10s audio-to-prompt dispatch
zero unauthenticated command execution
reliable device reconnect after Wi-Fi loss
clear token/device revocation
```

Beta device feature set:

```text
status
prompt
push-to-talk
approve/reject
stop
saved macros
basic camera snapshot
```

## Phase 12: Commercial Launch

Before selling broadly:

- Billing and subscriptions.
- Device transfer/reset flow.
- Factory reset.
- OTA update pipeline.
- Support diagnostics bundle.
- Privacy settings for audio/image retention.
- SOC2-minded logging boundaries.
- Clear T3 Code setup docs.

## Build Order

Implement in this order:

1. Cloud runtime plus runtime-neutral domain/store boundaries.
2. Outbound connector enrollment, local T3 pairing, snapshot, and resumable event transport.
3. Web dashboard for sending prompts.
4. Device registry and simulated device client.
5. ESP32 firmware for status and buttons.
6. Audio upload and transcription.
7. Camera snapshot.
8. Policy engine and policy-screened shell input.
9. Higher-trust shell approvals for dangerous actions.
10. OTA and production provisioning.

## Highest-Risk Areas

The riskiest parts are not the buttons or e-ink display. They are:

- T3 environment connectivity.
- Remote authentication.
- Shell permissions.
- Media processing cost and reliability.
- Token storage and revocation.
- Customer setup complexity.

Build these boundaries early, test them with simulated devices, and only then expand the hardware input surface.
