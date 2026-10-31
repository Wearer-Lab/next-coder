# Next Coder

[![Hermetic CI](https://github.com/Wearer-Lab/next-coder/actions/workflows/ci.yml/badge.svg)](https://github.com/Wearer-Lab/next-coder/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Next Coder is a cloud control plane between remote controller hardware, a phone/web console,
and [T3 Code](https://github.com/pingdotgg/t3code) environments running on users' machines. The
production server should run in the cloud—preferably on Cloudflare—while T3 Code and Tailscale stay
on each user's machine. The `@wearer-haitch/connector` npm package pairs local T3 with that cloud
service over an outbound authenticated WebSocket; publication and live-cloud validation remain.

Next Coder does not run coding agents. It authenticates people, devices, and connectors;
applies policy; persists control-plane state; and routes commands and live results between a cloud
endpoint and the user's T3 instance.

The current product includes:

- **Agent operation:** arbitrary text/media requests, streamed thread responses, command timelines,
  gateway approval gates, T3 provider decisions, structured agent questions, and a bounded
  evidence-linked T3 work inspector.
- **T3 environments:** guided pairing, health/recovery, project and model selection, thread creation,
  live watches, and dependency-aware removal with connector revocation, exact-label confirmation,
  recoverable credential-free tombstones, and explicit retention purge.
- **Controller fleet:** factory pre-provisioning, claim/onboarding, device credentials, policy
  profiles, configuration, diagnostics, secret rotation, transfer reset, and revocation.
- **Media and voice:** browser and device capture, a short-lived single-use phone companion,
  truthful source provenance, bounded previews, disk or S3-compatible storage, retention,
  transcript review, durable media jobs, and local Parakeet or provider-backed transcription.
- **Operations:** Clerk authentication, memory/file/Convex stores, scoped rate limits, redacted support
  diagnostics, durable privacy-minimal in-app notifications, optional encrypted Web Push,
  explicit scheduled-worker liveness, remote-access setup, manufacturing tools, and signed
  firmware metadata.
- **Hardware:** four ESP32-S3 firmware targets with 15 PlatformIO environments in the current tree;
  Hosyond has the richest touch/voice workflow and the strongest recorded on-device validation.

The same action may cross the console, gateway, T3 transport, storage, and controller firmware.
The [firmware workflow audit](docs/firmware-workflow-audit.md) records recovery and interaction
repairs, their test coverage, and the physical checks still required.
Contributors should read [AGENTS.md](AGENTS.md) for the complete-change checklist and
[CLAUDE.md](CLAUDE.md) for detailed architecture and protocol invariants.

## Open source and project status

Next Coder is open source under the [Apache License 2.0](LICENSE). The gateway, web console,
connector CLI, and four firmware targets are implemented and covered by the hermetic repository
gate (`npm test`, the secret scan, and the documentation link gate), but no managed cloud
deployment, npm publication, or live-T3 qualification has been performed yet. Read
[roadmap/IMPLEMENTATION-STATUS.md](roadmap/IMPLEMENTATION-STATUS.md) before trusting any claim
about what works: it records what has been proven, where, and what has not. Contributions are
welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md), never in a public issue.

## Product architecture priorities

### Device architecture

Controllers are thin, purpose-built remote surfaces. They connect directly to the cloud Next Coder
endpoint over authenticated HTTPS/WSS, capture input, show a compact view of the selected
environment/project/thread, and render truthful agent state. They do not run Tailscale and do not
connect directly to T3. The cloud service owns identity, policy, durable control-plane state, and
routing; the paired T3 environment owns projects, threads, provider sessions, and agent output.

Shared provisioning, persisted device state, gateway operations, media upload, OTA support, and orb
rendering live in `firmware/shared/NextCoderCore`. Each board folder supplies only its hardware
adaptation: pins, display, touch/buttons, audio, and board-specific recovery behavior. This keeps one
gateway contract across the four ESP32-S3 targets without pretending their hardware is identical.

### Remote control

Next Coder is remote-first. Production has one stable public cloud origin for the console,
controller API, and local connectors. T3 Code and Tailscale run on the user's machine. The connector
CLI initiates the authenticated link to the cloud, so the user does not need to expose T3 publicly,
open an inbound router port, or place the cloud service inside their Tailnet.

The cloud service uses compact device projections, demand-driven live streams, leases,
deduplication, idempotent commands, and explicit offline/reconnecting states. Features must work
without shared filesystem access, baked-in localhost origins, direct cloud-to-LAN reachability, or
permanent connectivity.

### Performance and security

Performance is an end-to-end budget. The gateway avoids hydrating full thread bodies for lists,
subscriptions exist only while work is being watched, and controller endpoints return only what a
constrained display needs. Console and orb animations must avoid sustained CPU/GPU work; firmware
network operations must not block touch or rendering; media and transcription use bounded sizes,
queues, retries, and concurrency. Performance-sensitive changes should include measured payload,
latency, memory, render, frame-gap, or refresh evidence.

Security follows the same boundaries. Platform users, devices, factory tooling, and local connectors
need separate credentials and rate limits. Connector enrollment uses a short-lived, single-use code;
its standing credential must be revocable and environment-scoped. In cloud mode, direct T3 pairing
and transport are disabled before token exchange or outbound network I/O, so T3 URLs and tokens stay
on the user machine. Device secrets and API tokens are hashed, self-hosted direct-mode T3 tokens are
encrypted, media links are short-lived and scoped, support diagnostics are redacted, and delayed
jobs re-check current device policy before dispatch. See
[docs/auth-storage.md](docs/auth-storage.md) and
[docs/production-security.md](docs/production-security.md) for the controls implemented today.
Staged firmware and connector cohort operations are documented in
[docs/release-rollouts.md](docs/release-rollouts.md); the cloud never auto-promotes a cohort or
runs connector package-manager commands on a user's machine.
Notification retention, cursor replay, local PWA delivery, optional encrypted Web Push configuration,
and scheduler-health semantics are documented in
[docs/notifications.md](docs/notifications.md).

The shared firmware now fails closed with a maintained current/next CA trust set and trusted-clock
bootstrap. Public-cloud device rollout still requires production CA injection plus physical tests
that prove valid Cloudflare certificates are accepted and untrusted certificates are refused.

## Target production topology

```text
Controller device ── HTTPS/WSS ─┐
                                ├── Next Coder cloud service ── durable state
Web console ─────── HTTPS/SSE ──┤        (Cloudflare preferred)
                                │
User machine                    │
  T3 Code <── local/Tailnet ── connector CLI ── outbound HTTPS/WSS ──┘
  Tailscale
```

The intended setup flow is:

1. The user runs T3 Code and Tailscale on their machine.
2. The console creates a short-lived connector pairing code.
3. The user runs a published `npx` connector command on the T3 machine.
4. The connector discovers or launches T3, redeems the code, registers the environment and provider
   catalogue, and maintains the authenticated cloud connection.
5. Controllers and the console send commands to the cloud service; the service routes them through
   the connector and streams results back.

The connector package is `@wearer-haitch/connector`; the generated one-time command has this
shape:

```bash
npx @wearer-haitch/connector connect --server 'https://controller.example.com' --code 'one-time-code'
```

The package exists and passes clean-pack/install tests in this repository. A protected manual
workflow now binds an exact version, annotated tag, commit, dependency-free tarball, npm dry-run,
OIDC trusted publication, provenance, and clean external `npm exec` verification. It has not yet
been published to npm, so use the generated command only after a release is published and verified.
See [docs/npm-connector-release.md](docs/npm-connector-release.md).

Removal is fail-closed by default: `next-coder-connect disconnect --revoke-cloud --yes` uses
the connector's own scoped credential, waits for durable cloud revocation and live edge closure,
then deletes the local service and credentials. A failed response retains local authority for a safe
retry. `--force-local` must be stated explicitly to clean up locally without confirmed cloud
revocation.

When `DEPLOYMENT_MODE=cloud`, this connector command is the only supported T3 enrollment path. The
legacy direct-create and code-redeem APIs are self-hosted compatibility surfaces and fail closed in
cloud mode; connector environment edits are limited to safe metadata such as the label.

### Current implementation gap

The repository now includes the connector protocol/authentication realm, tokenless connector-mode
environments, a publishable CLI package, a shared direct/connector `T3Adapter` with a cached
versioned read-only capability manifest, and a Cloudflare Worker/Durable Object
runtime. Direct T3 URLs remain available as an advanced self-hosted compatibility mode.

The production blocker is now runtime completion and proof rather than a missing hosting shape. The
edge Worker binds privately to a Cloudflare Container running the existing Node `node:http` control
plane, and that Container routes connector-mode T3 operations back through a private named Worker
entrypoint to the environment Durable Object and outbound connector. The container is
production-gated on Convex, Clerk, TLS, encryption, and S3-compatible R2. Queue/Cron ownership,
online revocation, request replay, and subscription recovery are implemented and covered by local
cross-runtime tests. Deployment, hosted Queue/Service Binding behavior, and live-system proof remain.
No Worker, Container, or npm package is claimed as deployed from this checkout.

An authorized operator can qualify an isolated deployment without giving the harness deployment
authority. `npm run qualify:staging -- --base-url 'https://staging.example.com'` checks the public
Cloudflare health contract and exact `404` behavior for private capabilities. Supplying an explicit
test user token and connector-backed environment adds fresh connector/T3/provider checks; a separate
`--exercise-first-command` flag is required before it creates one test thread and waits for a
completed agent reply. Output is redacted JSON. See
[docs/staging-qualification.md](docs/staging-qualification.md). This tooling has only been exercised
against hermetic loopback fixtures so far and is not hosted proof.

First-time staging bootstrap and routine staging releases are separate manual-only, protected
GitHub-environment workflows. Bootstrap creates/verifies exactly three Queues and two R2 buckets,
breaks the reciprocal Service Binding cycle with a non-public fail-closed edge stub, provisions only
named runtime secrets over standard input, deploys Convex/private control plane/final edge in safe
order, and supports exact-version resume plus a narrow stub-only abort. Routine release then pins
candidate/current commits and active Worker versions, validates the named dependencies, deploys in
dependency order, and supports an explicit compatibility-gated rollback. Both emit redacted
evidence. See [docs/staging-bootstrap.md](docs/staging-bootstrap.md) and
[docs/staging-release.md](docs/staging-release.md). Neither workflow has been run, so no cloud
resource or live deployment is claimed.

Production promotion is a third manual-only boundary. It accepts only an exact forward commit whose
staging release, qualification, hosted-capacity, security, and tracked deploy-input hashes are bound
by one reviewed manifest no older than 72 hours. Separate protected `production` approvals gate the
read-only dependency check, Convex/private Container phase, public edge phase, and postflight. The
current one-instance Container configuration rolls out at 100%, so this is explicitly checkpointed
rather than described as a canary. It never bootstraps production, writes secrets, deletes resources,
or performs automatic rollback. See [docs/production-promotion.md](docs/production-promotion.md).
The workflow has not been run and is not production-deployment evidence.

[Cloudflare Workers now offers Node HTTP compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/),
and [Durable Objects provide long-lived WebSocket coordination](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
but Node compatibility does not make process-local timers, filesystem work, UDP discovery, or local
sidecars portable. Those paths remain outside the Worker bundle and need explicit cloud adapters.

### Migration readiness

The target topology has moved beyond an architecture sketch: its protocol, credential, package,
Durable Object, private Container, and connector-router seams are joined and covered by focused
cross-runtime tests. It remains a pre-production candidate because hosted background/reconnect
behavior, external deployment, and real T3/controller proof are incomplete.

| Area | Implemented evidence | Remaining production gap |
|---|---|---|
| Domain and policy | Separate connector realm, short-lived tickets, immediate edge-socket revocation, tombstones, command arbiter and transport routing | Exercise revocation/policy through a deployed binding and live connector |
| T3 integration | Direct and connector transports, HTTP/Effect RPC, ACK/Interrupt, subscriptions, reconnect replay and bounded idempotency | Prove recovery and feature parity against deployed Cloudflare and live T3 |
| Connector enrollment | One-time codes, hash-at-rest credentials, outbound WSS package, native Keychain/Secret Service/Credential Manager adapters with atomic migration and explicit private-file fallback, safe local T3 start on macOS/Linux/Windows, transactional update with process-identity health rollback, overlap-safe ticket-acknowledged credential rotation, launchd/systemd-user plus Windows Task Scheduler lifecycle | Publish npm package; live macOS/Linux/Windows service, T3 launch/pairing, native-store, sleep, update, and rotation tests |
| Cloud runtime | Static Assets Worker, per-environment Durable Object, hibernation/alarms, Queue/Cron/DLQ handlers, bounded long polls, private Container control plane/router, privacy-safe sampled Analytics Engine/log/trace configuration, verified non-root amd64 image, and a 16-environment/48-request local capacity gate | Deploy/rollback/hosted load, telemetry/privacy/alert delivery, and live Queue/Service Binding/R2 proof; no supported hosted capacity is claimed |
| Durable data | Memory/file/Convex parity for connector, ticket, presence, health, provider catalogue | Deployed Convex/Worker binding and event-consumer proof |
| Console/onboarding | Connector-first enrollment, layered health, fleet/revoke settings, recovery, a passing frontend gate, typecheck, production build, lazy feature chunks, and deterministic first-load/live-list/event-coalescing budgets | Validate the complete journey against deployed cloud and a live connector; profile representative desktop/mobile GPU, WAN, and real-stream heap behavior |
| Controllers | Outbound shared client, verified-TLS fail-closed implementation, compact layered environment health, secure CrowPanel/Hosyond release builds, safe claim/health/recovery on Waveshare, and capability-gated T190 browsing/operate code | Configure production CA; complete negative-TLS, WAN, and real-hardware proof on every claimed surface |
| Testing/operations | Server/package/protocol/Worker gates, deterministic resilience and capacity suites, non-root amd64 Container smoke, protected manual staging bootstrap/deploy/rollback automation, privacy-safe cloud telemetry queries/thresholds, and focused firmware builds | Execute bootstrap and rehearse deploy/rollback, then create/verify hosted dashboards and alerts, run staged WAN/rollover/load/security drills, collect CPU/memory/cold-start/cost evidence, and complete physical proof |

Recommended implementation order:

1. **Implemented:** architecture decisions, connector protocol, credential model, and offline limits.
2. **Implemented:** `T3Transport` with direct compatibility and connector routing.
3. **Implemented locally:** package, enrollment, atomic managed-service credential rotation, safe T3 auto-start and
   transactional update/health rollback, WSS, heartbeat, resume, and backpressure.
4. **Implemented and locally tested:** Worker/static assets and Durable Object routing.
5. **Implemented locally:** private Worker-to-Container control plane, Container-to-edge router join,
   and Queue/Cron background ownership; hosted Queue/Service Binding and live R2 proof remain.
6. **Implemented and locally verified:** connector-first console, fail-closed controller TLS,
   secure release plus CrowPanel/Waveshare builds, safe Waveshare cloud presence, and a T190
   status/operate adapter whose input path stays compile-gated until its carrier pins are proven;
   remaining probe/benchmark renewal and live validation remain.
7. **Not yet proven:** hosted deploy/rollover, real sleep/wake/load/security drills, npm release, and a real
   controller-to-cloud-to-T3 loop.

Run the deterministic local capacity gate with `npm run test:capacity`. Its provisional SLO,
concurrency budget, exact local report, rate-limit restart caveat, and hosted decision gates are in
[docs/capacity-slo.md](docs/capacity-slo.md). Passing it does not establish Cloudflare
`standard-1` capacity or cost.

## Roadmap status

Active-roadmap **Milestone 0.5 is complete**. The live-thread foundation, streamed conversation UI,
T3-native provider approvals, structured user questions, shared composer, console-first connection,
and most of the durable Parakeet voice pipeline have also landed. The private two-step raw media
session path now covers browser and shared controller uploads with integrity finalization,
restart-safe Store adapters, expiry cleanup, and explicit progress/retry/cancel UI. Milestones 1, 2,
3, and 4 remain partial: the PWA now has a locally encoded, five-minute, single-use companion
handoff plus bounded on-demand media previews and source provenance; hosted R2/worker proof,
deployed phone usability, and live/hardware validation still have gaps. Milestones 0 and 5 are also
partial: the versioned adapter/capability contract, durable request identity, T3-native work graph,
notifications, and rollout controls have landed locally; deployed live-T3 qualification,
representative load/security evidence, and certified per-task T3 controls remain.

See the active
[open-input/media/voice/environment roadmap](roadmap/open-input-media-voice-environments-roadmap.md)
and its [canonical implementation ledger](roadmap/IMPLEMENTATION-STATUS.md) for verified progress,
tests, firmware evidence, and next dependencies.

The target cloud runtime and local connector migration is specified separately in the active
[cloud control plane and connector roadmap](roadmap/cloud-control-plane-connector-roadmap.md).

## How it fits together

| Surface | Responsibility | Main code |
|---|---|---|
| Cloud service | Auth, policy, routing, HTTP/SSE/WSS API, jobs | `src/` Node/domain service; `cloudflare/` edge runtime; `cloudflare-control-plane/` private Container wrapper |
| Console/PWA | Operate, fleet, environments, media, activity, settings | `frontend/src/` |
| Durable store | Production schema and Store API implementation | `convex/` |
| Connector CLI | Bridges local T3 to the cloud over an outbound authenticated channel | `packages/connector/`; npm publication still needed |
| Controllers | Cloud-connected board UI, provisioning, audio and display | `firmware/` |
| T3 Code | Runs provider harnesses and owns projects, threads, and agent state | External paired environment |

Local file, in-memory, and Convex storage implement the same Store API. The console receives gateway
changes over SSE, while the gateway holds resumable T3 WebSocket subscriptions only for actively
watched threads.

## Run locally for development

Prerequisite: Node.js 22 or newer. PlatformIO is additionally required for firmware builds.

```bash
npm install
npm start
```

`npm start` builds the React client and starts the gateway at:

```text
http://127.0.0.1:3996
```

Open the dashboard at:

```text
http://127.0.0.1:3996/
```

For frontend development with hot reload, run the gateway and Vite in separate terminals:

```bash
npm run dev:server
npm run dev:app
```

Vite listens on `http://127.0.0.1:5173` and proxies gateway requests to port `3996`. Use `npm run build`, `npm run typecheck:web`, and `npm test` before shipping.

To persist local platform state:

```bash
DATA_FILE=.data/next-coder.json npm start
```

## Current self-hosted remote access

`npm run setup:tunnel` and the current Settings flow expose a locally running gateway with Tailscale
Serve or Funnel. That is a supported development/self-hosted bridge, not the intended production
topology. In production, the Next Coder endpoint is already in the cloud; Tailscale belongs on
the user machine beside T3, and the connector CLI links that private runtime to the cloud.

See [docs/remote-access.md](docs/remote-access.md) for the primary cloud-plus-connector flow and the
separately scoped self-hosted Serve, Funnel, direct-T3, and LAN options.

## Create A Device

```bash
node scripts/simulate-device.mjs
```

## ESP32 Firmware

Four board targets are present. Environment counts below describe the current `platformio.ini`
files; hardware evidence is tracked separately in the implementation ledger.

| Folder | Hardware | PlatformIO environments | Current role |
|---|---|---:|---|
| `firmware/CrowPanel-ESP32-2.13-E-paper` | 2.13-inch e-ink + keys | 5 | Mature low-power controller workflow plus hermetic capture proof |
| `firmware/Hosyond-ESP32-S3-2.8-Touchscreen` | 240x320 touch + microphone/speaker | 7 | Primary touch/voice product and bench builds |
| `firmware/Waveshare-ESP32-S3-Touch-AMOLED-1.75C` | Round AMOLED touch + microphones | 2 | Shared secure claim/health/recovery; all UI/media capabilities disabled until silicon proof |
| `firmware/vision-master-t190` | 1.9-inch TFT | 1 | Shared secure status adapter; browse/operate input is gated behind verified external encoder wiring |

Shared provisioning, persisted device state, gateway operations, media upload, OTA support, and orb
rendering live under `firmware/shared/NextCoderCore`.

Validate the complete manifest without compiling:

```bash
npm run check:firmware-manifests
```

Build the two named release images, or every declared environment:

```bash
npm run build:firmware
npm run build:firmware:all
```

Both commands stage only source plus `controller_config.example.h` in a local temporary directory,
so a live board configuration is neither read nor copied into build evidence. Each environment has
a bounded timeout and reports dependency/setup failures separately from compile/link failures. The
canonical 15-environment inventory is `firmware/build-matrix.json`.

See [docs/firmware-build-gate.md](docs/firmware-build-gate.md) for the failure classifications,
current compile evidence, and the limits of build-only proof.

See [docs/hardware-protocol.md](docs/hardware-protocol.md) for provisioning, claim, display, media, and intent details.

Hosyond's Device → Wi-Fi controls scan nearby networks, accept passwords on the touchscreen and
save up to five successfully connected networks. Saved alternatives are tried automatically after
Wi-Fi loss, with an on-screen reconnect/switch notice. See the
[network flow and limits](docs/hardware-protocol.md#saved-wi-fi-and-hosyond-network-controls).

The [interactive device flow atlas](docs/device-flow/README.md) maps the current Hosyond screens,
buttons, voice journey, confirmations and recovery branches, and compares the other boards. It is
a local explanatory simulation; it does not operate real devices.

## Manufacturing

Create factory devices and per-device `controller_config.h` files:

```bash
NEXT_CODER_URL=http://127.0.0.1:3996 \
FACTORY_TOKEN=replace-with-factory-secret \
COUNT=10 \
LABEL_PREFIX="Next Coder" \
PUBLIC_GATEWAY_URL=https://gateway.example.com \
GATEWAY_TLS_ROOT_CA_PEM="$(< issuing-root.pem)" \
ENABLE_OTA_APPLY=0 \
npm run manufacture:batch
```

Production firmware refuses HTTPS without a trusted root and valid clock. During a planned CA
rotation, also set `GATEWAY_TLS_NEXT_ROOT_CA_PEM` so firmware carries both issuing roots before the
gateway certificate moves. `INSECURE_SKIP_TLS_VERIFY=1` is an explicit local-bench setting only.

Publish a signed firmware release manifest:

```bash
NEXT_CODER_URL=http://127.0.0.1:3996 \
FACTORY_TOKEN=replace-with-factory-secret \
FIRMWARE_VERSION=0.2.0 \
FIRMWARE_URL=https://cdn.example.com/firmware/next-coder-0.2.0.bin \
FIRMWARE_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
FIRMWARE_SIZE_BYTES=901385 \
npm run firmware:publish
```

For a managed artifact, set `FIRMWARE_FILE` instead of the URL, digest, and size. The gateway
computes integrity metadata and stores the immutable binary on disk or in configured private S3/R2:

```bash
NEXT_CODER_URL=https://gateway.example.com \
FACTORY_TOKEN=replace-with-factory-secret \
FIRMWARE_FILE=.pio/build/secure/firmware.bin \
FIRMWARE_VERSION=0.2.0 \
npm run firmware:publish
```

Set `OTA_SIGNING_KEY` on the gateway before publishing production firmware metadata.
Generated firmware configs default to `ENABLE_OTA_APPLY=0`; enable OTA application only after testing the partition table and rollback process on real hardware.

## Rate Limits

The gateway applies fixed-window limits per user, device, factory client, and connector. Defaults are configured in `.env.example`:

```text
RATE_LIMIT_WINDOW_MS=60000
AUTH_RATE_LIMIT=30
FACTORY_WRITE_RATE_LIMIT=30
USER_READ_RATE_LIMIT=240
USER_WRITE_RATE_LIMIT=60
DEVICE_HEARTBEAT_RATE_LIMIT=120
DEVICE_READ_RATE_LIMIT=120
DEVICE_WRITE_RATE_LIMIT=30
```

HTTP `429` responses include `x-ratelimit-*` and `retry-after` headers. The limiter backend is
pluggable: it counts in-process by default, and setting `RATE_LIMIT_REDIS_URL` shares the window
across processes over a dependency-free RESP client (`src/resp.mjs`). Redis-backed limiting has only
been exercised locally.

## Clerk And Convex

The React dashboard uses Clerk exclusively for platform user authentication. Link a Clerk application and pull its development keys:

```bash
clerk auth login
clerk init --app YOUR_CLERK_APP_ID
clerk doctor
```

The Clerk CLI writes the secret and Vite publishable key to the gitignored `.env.local`. Gateway configuration stays in `.env`:

```text
AUTH_PROVIDER=clerk
CLERK_AUTHORIZED_PARTIES=http://127.0.0.1:3996,https://gateway.example.com
STORAGE_PROVIDER=convex
CONVEX_URL=https://your-deployment.convex.cloud
```

The browser obtains fresh Clerk session tokens for API requests and uses the same-origin Clerk session cookie for live events. Tokens are never persisted in `localStorage`. The gateway verifies every session with `@clerk/backend` and synchronizes the verified Clerk ID, name, and primary email into the platform store.

After the first Clerk sign-in, the React app opens a resumable six-step setup workbench. It
configures the T3 host and network path, pairs and verifies the environment, selects a live
project/provider/model, launches the first proof thread, and either configures a controller or
records an explicit browser-only choice. Progress is user-scoped in the configured store, and
the server refuses completion unless the operational evidence is present. The detailed flow is
documented in [docs/onboarding-flow.md](docs/onboarding-flow.md).

`POST /v1/users/dev` remains available only in explicit legacy/test mode. It is disabled in Clerk mode and is not exposed in the React dashboard.

Convex schema/functions are scaffolded under `convex/`, including `gatewayStore:*` functions for the Node Store API. The gateway bridge in `src/convexStore.mjs` generates secrets locally, stores only hashes in Convex, encrypts T3 access tokens before storage, and authenticates store calls with `GATEWAY_CONVEX_SECRET`. See [docs/auth-storage.md](docs/auth-storage.md) for deployment validation steps.

Run the Convex-backed HTTP smoke flow after `npx convex dev --once --env-file .env` has deployed the functions:

```bash
npm run smoke:convex
```

For local audio transcription development, set:

```text
TRANSCRIPTION_PROVIDER=mock
```

The mock provider produces deterministic transcripts for smoke tests. Cloud deployments use
`TRANSCRIPTION_PROVIDER=connector` to route audio to each user's paired computer for local Parakeet
inference. Voice setup belongs to the connector package, without a repository checkout or public
laptop port. See [local voice operation and verification](docs/local-voice.md), including the
English-only model and first-install download requirements.

## Connect a T3 environment today

Until the published connector CLI exists, a repository checkout can use:

```bash
npm run setup:t3
```

This legacy script predates the `npx` connector. It checks for T3 Code, handles provider
and project setup, and registers a directly reachable T3 URL with the current Node gateway. It does
not maintain the target outbound cloud connector channel.

Harness selection is not restricted to OpenAI. The built-in choices are automatic detection, Codex/OpenAI, Claude Code, Cursor, OpenCode, Grok, and a custom T3 provider instance. OpenAI/Codex is only the choice used by the current Mac test.

Pairing also registers the host's **agent harness catalogue** with the gateway. T3's orchestration
HTTP API does not expose which harnesses and models exist, so the setup script reads T3's own
provider caches from the base directory and uploads them. That is what lets the dashboard show real
harness and model dropdowns instead of free-text fields, and lets the gateway reject a model T3 does
not offer before it is dispatched.

Without this step the dashboard can only list harnesses and models already in use by an existing
project or thread.

Project registration is a convenience, not a requirement. Choose `--skip-project` to start T3 without adding one, then manage projects later in the T3 Code app or with `t3 project`.

Example for the local Tacs test:

```bash
npm run setup:t3 -- \
  --yes \
  --project /path/to/your/project \
  --provider openai \
  --tunnel local \
  --gateway-url http://127.0.0.1:3996 \
  --gateway-dev-user user_t3_e2e \
  --initial-prompt "Report that the remote session is ready."
```

For Tailnet access, use `--tunnel tailscale`. The script verifies or installs Tailscale, requires the user to finish Tailnet sign-in, and launches T3 with `--tailscale-serve`, following T3 Code's [remote access guidance](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md).

Use either a T3 pairing token:

```bash
curl -X POST http://127.0.0.1:3996/v1/t3/environments \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer PLATFORM_TOKEN' \
  -d '{
    "label": "Mac T3 Code",
    "baseUrl": "https://your-mac.tailnet.ts.net",
    "pairingToken": "T3_PAIRING_TOKEN"
  }'
```

Or, for local development only, provide an existing access token:

```bash
curl -X POST http://127.0.0.1:3996/v1/t3/environments \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer PLATFORM_TOKEN' \
  -d '{
    "label": "Mac T3 Code",
    "baseUrl": "https://your-mac.tailnet.ts.net",
    "accessToken": "T3_ACCESS_TOKEN",
    "accessTokenExpiresAt": "2026-06-16T19:00:00.000Z"
  }'
```

When a pairing token exchange returns `expires_in`, the gateway stores `accessTokenExpiresAt` automatically. Manual access-token registration can include the same field; omit it only when the token has no known expiry. Expired T3 credentials return `token_expired` health and block snapshot/dispatch calls until the environment is re-paired or updated.

## Send A Device Prompt

```bash
curl -X POST http://127.0.0.1:3996/v1/device/intents \
  -H 'content-type: application/json' \
  -H 'x-device-id: DEVICE_ID' \
  -H 'x-device-secret: DEVICE_SECRET' \
  -d '{
    "clientRequestId": "dev:84d1f1d2-88984f43-a15b19c0-9238f411",
    "environmentId": "ENVIRONMENT_ID",
    "threadId": "THREAD_ID",
    "intent": {
      "type": "agent_prompt",
      "text": "Continue the implementation and run tests."
    }
  }'
```

Generate a fresh `clientRequestId` for each new agent action. If the connection drops before the
HTTP response arrives, retry the exact request with the same id; the gateway returns the original
command (or an explicit `processing` receipt) instead of dispatching a second turn. Reusing an id
for different input is a `409` conflict. Web clients can recover through
`GET /v1/requests/:clientRequestId`; devices use `GET /v1/device/requests/:clientRequestId`.

## Web Dashboard

The built-in dashboard supports:

- Creating a local platform token.
- Registering development devices, claiming factory devices, updating profiles, rotating secrets, transfer-resetting devices, and revoking devices.
- Pairing, updating, dependency-previewing/removing, reachability-checking, and browsing T3 Code sessions.
- Selecting any T3 project/provider instance/model and launching its first thread.
- Watching streamed assistant/tool activity and reconnecting a live thread without losing its state.
- Answering T3 provider approvals with the full decision set and responding to structured agent questions.
- Uploading, deleting, and retention-managing image/audio media from phone or laptop.
- Composing text and ordered media requests from Operate or QuickPage, plus shell, status, and stop intents.
- Saving and running prompt or shell macros.
- Running saved macros from claimed hardware.
- Approving or rejecting pending commands from claimed hardware.
- Approving or rejecting high-risk shell commands before dispatch.
- Downloading a redacted support diagnostics bundle.
- Viewing live display state, devices, environments, media, and audit activity.

## Test

Run the full local code gate (console build/typecheck/tests, gateway tests, connector tests, and
Cloudflare edge/private-control-plane typechecks and tests):

```bash
npm test
```

Run the repository credential-safety, maintained-documentation, and release Container gates separately:

```bash
npm run security:repo
npm run check:docs
npm run test:container
```

Run the production bundle, live-list, and SSE render-coalescing gate directly with:

```bash
npm run test:browser-performance
```

Its deterministic budgets and the latest local Chrome observation are documented in
[docs/frontend-performance-gate.md](docs/frontend-performance-gate.md). Real mobile/GPU, WAN, and
long-session live-stream evidence remains a separate release gate.

GitHub pull requests and pushes run these boundaries as separate, credential-free jobs, including
connector package smoke and the Docker release-image smoke. See
[docs/ci-release-gates.md](docs/ci-release-gates.md) for the exact matrix and the hosted, live-T3,
browser-performance, and hardware evidence that CI intentionally cannot claim.

Connector publication is a separate manual `npm-release` environment operation, never a pull-request
or push CI side effect. Its setup, exact confirmation syntax, immutable-version refusal, provenance,
clean external verification, and rollback/deprecation limits are documented in
[docs/npm-connector-release.md](docs/npm-connector-release.md). No npm publication is claimed here.

Run one layer at a time:

```bash
npm run test:server
```

```bash
npm run test:app
```

Run a single server test file or a single test by name:

```bash
node --test test/policy.test.mjs
```

```bash
node --test --test-name-pattern="claim" test/app.test.mjs
```

Do not run a bare `node --test` from the repository root. Node's default discovery also picks up the
frontend `src/**/*.test.ts` files, which need the jsdom environment and setup that only
`npm run test:app` provides.

## Local Mock T3

For local development without a real T3 Code instance:

```bash
node scripts/mock-t3.mjs
```

See [docs/api.md](docs/api.md) for endpoint examples and the local end-to-end flow. Product work in
progress is tracked in
[roadmap/open-input-media-voice-environments-roadmap.md](roadmap/open-input-media-voice-environments-roadmap.md),
with current verified state in [roadmap/IMPLEMENTATION-STATUS.md](roadmap/IMPLEMENTATION-STATUS.md)
and the ordered list of everything still outstanding in
[roadmap/completion-plan.md](roadmap/completion-plan.md). Operators deploying this stack should start
from [docs/operator-setup.md](docs/operator-setup.md), which sequences the accounts, protected
environments, secrets and first staging deployment, then
[docs/staging-drills.md](docs/staging-drills.md) and
[docs/evidence-bundles.md](docs/evidence-bundles.md) for hosted qualification and release evidence.
Known non-blocking follow-ups are tracked in [docs/deferred-items.md](docs/deferred-items.md).

## License

Copyright the Next Coder contributors. Licensed under the [Apache License, Version 2.0](LICENSE).
The CrowPanel, Hosyond, and Waveshare vendor documentation kits are not redistributed with this
repository; those boards' `docs/` folders hold only a README explaining where to download them. The
`firmware/vision-master-t190/docs/` folder still tracks five Heltec reference files (datasheet,
schematic, panel specification, and two pin/hardware images), which remain under their vendor's own
terms rather than this repository's licence.

Hosyond interaction changes and qualification: [0.2.19 implementation notes](docs/device-flow/review/IMPLEMENTATION.md).
## Direct agent connections

The connector also supports native Codex, Claude and generic ACP agents with T3 optional.
See [direct-agent setup, existing sessions and conversation handoffs](docs/direct-agents.md).
This source feature requires a connector build containing `--agents-file`; publication and live
provider/device qualification are separate release steps.
