# Cloud Control Plane and Local T3 Connector Roadmap

Status: active implementation roadmap  
Created: 2026-08-27  
Owner: Next Coder maintainers  
Scope: production cloud runtime, local connector CLI, remote transport, onboarding migration,
device cloud security, operations, and rollout

## Implementation checkpoint — 2026-08-27

| Workstream | State | Evidence | Remaining proof/work |
|---|---|---|---|
| Protocol, auth, Store, `T3Transport` | implemented and server-tested | Connector realm/tickets/projections across memory, file, and Convex; private Container-to-edge router; immediate revocation; request/subscription recovery; current repository and focused router gates pass | Deployed Service Binding, machine sleep, and live T3 parity |
| Connector npm package | implemented, pack-tested, and protected-release automated | Clean install; exact package/version/tag/commit authorization; dependency-free tarball bounds; npm dry-run; protected OIDC/provenance workflow with immutable-version refusal, redacted evidence, and clean external exact-version verification design; Apache-2.0 licensing plus committed `Wearer-Lab/next-coder` repository metadata; native credential, T3 ownership, update/rollback, rotation, and platform-mocked service lifecycle | Confirm the final public package scope/name, configure the npm trusted publisher and protected environment, execute publication; live macOS/Linux/Windows service/T3/native-store/sleep/update/rotation proof |
| Cloudflare edge runtime | implemented and Worker-tested | Worker Static Assets, Durable Object hub, hibernation/alarms, Queue/Cron consumers, current Worker/contract gates, staging/production dry-runs | External deploy, hosted Queue/cron, rollover/load/security proof |
| Cloudflare control plane | implemented as Container-backed private Worker | Private Container-to-edge named-entrypoint router, background endpoint, reproducible bounded `linux/amd64` non-root image and local public/private/graceful-stop smoke, current package/typecheck gates, staging/production dry-runs, production config fail-closed | Paid-plan deploy, live Service Binding and R2 proof |
| Console UX | implemented and locally verified | Connector-first enrollment, five-layer proof-gated readiness, settings/revoke, recovery; current frontend suite, build, and typecheck pass; deterministic entry/chunk, live-list and event-coalescing budgets pass | Deployed complete user journey plus representative desktop/mobile GPU, WAN, usability, and real-stream heap-soak proof |
| Controller security | implemented and release-build tested locally | No production `setInsecure()` outside explicit bench; compact layered device health/redaction; complete 15-environment static inventory; secure CrowPanel/Hosyond release builds and current CrowPanel/Waveshare compilation | Production CA injection, remaining probe/benchmark renewal, WAN/physical-device proof |

This checkpoint is not a completion claim. No npm publication, Cloudflare deployment, live T3
connector, or physical controller-to-cloud-to-T3 flow has been run.

## 1. Objective

Deliver the intended production topology end to end:

```text
Controller device ── HTTPS/WSS ─┐
                                ├── Next Coder cloud service ── durable state
Web console ─────── HTTPS/SSE ──┤        (Cloudflare preferred)
                                │
User machine                    │
  T3 Code <── local/Tailnet ── connector CLI ── outbound WSS/HTTPS ──┘
  Tailscale
```

The cloud service authenticates users, devices, factory tooling, and connectors; applies policy;
stores control-plane state; and routes commands and events. T3 Code and its provider credentials
remain on the user's machine. Controllers connect only to the cloud service. A published npm CLI
connects local T3 to the cloud without requiring an inbound port or exposing T3 publicly.

Completion means a new user can create an account, run one `npx` command, connect a local T3
environment, claim a physical controller, send a request from the console or controller, observe the
live response and blocking interactions, recover from sleep/network/restart, revoke the connector,
and receive truthful status throughout. Cloud deployment, connector packaging, TLS, observability,
and rollback must be proven, not inferred from unit tests.

## 2. Why this roadmap exists

At roadmap creation, the repository had strong policy, Store, T3 protocol, live-thread, console,
media, and device foundations, but its deployed shape was a long-lived Node process that called a
registered T3 `baseUrl` directly. The implementation checkpoint above records the connector,
Worker/Durable Object, and Container deployment artifacts added since then.

The original architecture seams and the first local correctness closure are now implemented in
source. The remaining release seams are:

1. The joined path must be deployed and exercised with live Convex, R2, Queue, T3, npm packaging,
   WAN transitions, and physical controller TLS rather than inferred from focused tests.
2. The singleton Container, hosted queue ownership, reconnect storms, rollover, observability, and
   capacity/cost assumptions must be tested in the real Cloudflare lifecycle.
3. The console and controller must carry equivalent truthful layered readiness through the first
   successful agent action and recovery path.

Firmware now uses fail-closed CA validation outside the explicit bench build. Production roots,
certificate-refusal tests, WAN behavior, and physical controller proof remain release gates.

## 3. Product principles

1. **The connector goes out; the cloud never reaches in.** The cloud must not require LAN, Tailnet,
   or inbound reachability to a user machine.
2. **T3 authority remains local.** T3 access/pairing tokens and provider credentials stay on the user
   machine. The cloud stores only connector credentials and routing metadata.
3. **One cloud origin.** Console, controllers, and connectors use a stable HTTPS/WSS origin.
4. **Truthful layered health.** Cloud, connector, T3, provider, and device health are separate facts.
5. **No silent queueing of writes.** When a connector is offline, new mutating commands fail before
   dispatch with a retryable `connector_offline` result. Reads may show explicitly stale cached data.
6. **At-least-once transport, exactly-once decisions.** Frames can repeat; request ids,
   idempotency keys, cursors, and the command arbiter prevent duplicate effects and outcomes.
7. **Bound everything.** Buffers, lists, retries, leases, payloads, queues, subscriptions, and local
   logs all have limits and retention rules.
8. **Self-hosted remains a deliberate mode.** The current direct transport stays available for local
   development and advanced self-hosting, but it is not the default production user journey.

## 4. Scope

### In scope

- Cloudflare Worker/static-assets entry and deployment configuration.
- Durable Object coordination for connector WebSockets and per-environment request routing.
- Platform-native scheduling/queue hooks for durable background work.
- A `T3Transport` interface with connector and direct adapters.
- Connector enrollment, credentials, presence, protocol, resume, and revocation.
- A publishable npm package with a real `bin` and `connect`, `status`, `doctor`, `disconnect`, and
  service-lifecycle commands.
- Connector-local T3 discovery/start, authentication, HTTP RPC, Effect WebSocket RPC, thread streams,
  provider catalogue, and event forwarding.
- Console-first one-command onboarding and layered environment health.
- Stable cloud endpoint provisioning for controllers.
- Firmware certificate validation and trust-anchor rotation strategy.
- Cloud-compatible storage, media, rate limits, realtime fanout, metrics, alerts, deploy, and rollback.
- Migration of existing direct environments without breaking local development.
- Contract, package, Worker, integration, chaos, performance, security, and real-hardware gates.

### Out of scope

- Running T3 or coding-agent providers in Next Coder's cloud account.
- Moving provider credentials or user workspaces into the cloud.
- Installing Tailscale on ESP32 controllers or requiring the Cloudflare account to join a Tailnet.
- Supporting arbitrary third-party connector protocols before the first-party connector is stable.
- Publishing to npm or deploying to a production Cloudflare account without explicit operator
  authorization; package/deployment artifacts and local/staging verification remain required.

## 5. Personas and end-to-end journeys

### 5.1 First-time owner

1. Opens the cloud console and signs in with Clerk.
2. Chooses **Connect T3 on this computer**.
3. Receives one copyable `npx` command containing a short-lived enrollment code, never a platform
   token.
4. Runs the command. The connector verifies Node/T3/Tailscale, discovers or launches T3, shows the
   account/environment it will connect, and asks only necessary local questions.
5. The connector redeems the code, stores its standing credential locally, registers capabilities,
   and opens the outbound cloud channel.
6. The console moves through `waiting_for_cli -> connector_online -> t3_verified -> ready` without
   requiring the user to paste a URL or token.
7. The user selects project/provider/model and launches a proof thread.

Acceptance evidence:

- A clean directory can run the packed connector through `npx`/npm exec.
- No repository checkout, platform token, T3 URL paste, or inbound port is required.
- Cloud storage never receives a T3 access/pairing token for connector-mode environments.
- Setup succeeds through machine sleep/network interruption by resuming or giving a specific repair.

### 5.2 Returning owner

- Sees separate **Cloud**, **Connector**, **T3**, and **Provider** states with last-seen times.
- Can copy a repair command, rotate/re-enroll, update the connector, or revoke it.
- Can distinguish `connector_offline`, `t3_stopped`, `t3_auth_failed`, `version_incompatible`, and
  cloud/service errors.

### 5.3 Controller user

- Provisions one stable HTTPS cloud origin.
- Sends actions without knowing the T3 machine address.
- Sees cloud offline, connector offline, T3 offline, waiting, approval, question, streaming, complete,
  and failed as distinct compact states.
- Never sends a device secret over an unverified TLS connection.

### 5.4 Operator

- Deploys a versioned Worker and migrations through CI/staging.
- Observes connector fleet/version/presence, active connections, request latency by hop, reconnects,
  queue depth, dropped/duplicate frames, device auth failures, and job failures.
- Can roll back the Worker without losing connector sessions or duplicating commands.

## 6. Fixed architecture decisions

These decisions unblock parallel implementation. Reversing one requires an ADR and migration plan.

### 6.1 Runtime topology

- Cloudflare Worker is the public HTTP/static entry.
- One Durable Object instance coordinates each environment's active connector socket, request waiters,
  event cursors, bounded transient buffers, and fanout.
- Convex remains the durable control-plane Store for the first production implementation.
- R2 is the production media/firmware object store. Disk remains local-development only.
- Cloudflare Queues and/or Durable Object alarms drive background work. Domain job functions remain
  deterministic and directly testable.
- The Node server remains a local/reference runtime using the same domain and route contracts.

### 6.2 Connector packaging

- Working package identity: `@wearer-haitch/connector`.
- Binary name: `next-coder-connect`.
- Primary UX: `npx @wearer-haitch/connector connect --server https://<cloud-origin> --code <code>`.
- Final registry naming may change, but the binary subcommands and wire protocol are stable contracts.
- Connector requires Node 22+. macOS launchd, Linux systemd-user, Windows per-user Task Scheduler,
  and safe automatic T3 launch are implemented. The Windows path bypasses command shims, fingerprints
  the exact process, controls only its PID tree, and journals interrupted ownership. All clean-host OS
  validation remains explicitly outside the current proof.

### 6.3 Trust and credentials

- Enrollment codes remain 15-minute, single-use, hash-at-rest credentials minted by an authenticated
  user.
- Redeeming a code creates one connector id and returns a high-entropy standing connector secret once.
- The cloud stores only the connector-secret hash, owner/environment binding, scopes, timestamps,
  version/capabilities, and revocation state.
- The connector prefers macOS Keychain, Linux Secret Service, or Windows Credential Manager for its
  standing secret, with an explicit mode-`0600` private-file fallback when no native facility exists.
  T3 access material remains local in the connector's private state.
- A connector exchanges its standing secret for a short-lived WebSocket ticket. Standing secrets are
  never placed in a WebSocket URL.
- Connector credentials are environment-scoped, rotatable, revocable, and rate-limited.
- Production device and connector TLS verification is mandatory.

### 6.4 Offline and delivery semantics

- Reads return the last durable/cached projection with `freshness`, `lastConnectorSeenAt`, and
  `stale: true` when live verification is unavailable.
- New mutating requests fail before T3 dispatch when no compatible connector is online. They produce a
  retryable domain error and do not sit in an indefinite cloud queue.
- Once a connector acknowledges a request, existing command state/arbiter rules decide completion.
- Cloud-to-connector delivery is at least once. The connector caches bounded completed request ids and
  returns the same terminal result for a duplicate idempotency key.
- Connector-to-cloud events carry T3's global sequence where available. A missing replay window
  produces an explicit authoritative snapshot reset.

### 6.5 Transport abstraction

All T3 operations go through `T3Transport`:

```ts
interface T3Transport {
  environmentInfo(environment, options): Promise<EnvironmentInfo>;
  snapshot(environment, options): Promise<T3Snapshot>;
  threadDetail(environment, threadId, options): Promise<ThreadDetail>;
  dispatch(environment, command, options): Promise<DispatchResult>;
  callRpc(environment, tag, payload, options): Promise<unknown>;
  openThreadStream(environment, input, options): ThreadStreamHandle;
}
```

- `DirectT3Transport` wraps the existing HTTP and Effect RPC clients for tests/self-hosted mode.
- `ConnectorT3Transport` sends request envelopes to the environment Durable Object.
- Application, poller, compatibility, approval, input, terminal, and live-thread code depend on the
  interface, never on `environment.baseUrl`.

## 7. Connector protocol v1

### 7.1 Endpoints

- `POST /v1/t3/connect-sessions` — user realm; mint enrollment.
- `POST /v1/connectors/enroll` — code realm; redeem and receive connector id/secret/environment.
- `POST /v1/connectors/ticket` — connector realm; exchange standing secret for short-lived socket
  ticket.
- `GET /v1/connectors/socket?ticket=...` — WebSocket upgrade routed to the environment Durable Object.
- `GET /v1/connectors` — user realm; list connector metadata/presence/version.
- `POST /v1/connectors/:id/rotation-sessions` — user realm; mint the single-use local rotation
  command for an owned active connector.
- `POST /v1/connectors/:id/rotate` — current connector realm plus a single-use,
  user-minted environment code; stage the bounded local rotation ceremony.
- `DELETE /v1/connectors/:id` — user realm; revoke and disconnect.

The legacy `/v1/t3/connect-sessions/redeem` remains during migration and is renamed/deprecated only
after existing setup flows move.

### 7.2 Frames

Every frame is JSON with `protocolVersion: 1`, `type`, `connectionId`, and a type-specific body.

Connector to cloud:

- `hello` — connector id, version, platform, T3 version, environment, capabilities, last event cursor.
- `heartbeat` — monotonic sequence, local T3 health, active request count, queue depth, sent time.
- `response.accepted` — request id and accepted time; proves only local receipt.
- `response.completed` — request id, terminal result, completion time.
- `response.failed` — request id, stable failure code, retryability, redacted detail.
- `event` — environment/thread event, global cursor, event id, payload.
- `snapshot` — authoritative environment/thread projection and reset reason.
- `credential.rotated` — rotation ceremony confirmation.

Cloud to connector:

- `welcome` — connection id, server time, heartbeat interval, max frame/pending limits.
- `request` — request id, idempotency key, method/tag, deadline, payload.
- `cancel` — request id and reason.
- `subscribe` / `unsubscribe` — thread id, cursor, lease id/expiry.
- `rotate` — one-time rotation challenge.
- `shutdown` — revocation, incompatible version, or planned maintenance reason.

### 7.3 Protocol limits

- Maximum JSON frame: 1 MiB initially; media bytes never travel in connector JSON frames.
- Heartbeat: 20 seconds; connector considered stale after 60 seconds and offline after 90 seconds.
- Maximum in-flight requests per connector: 32.
- Request default deadline: 30 seconds; operation-specific overrides are bounded.
- Completed idempotency cache: 1,000 entries or 24 hours, whichever evicts first.
- Event replay buffer: bounded by count and bytes; fall back to snapshot reset on a gap.
- Exponential reconnect with jitter, capped at 30 seconds; immediate reconnect after network becomes
  reachable.

## 8. Data model additions

### Connector

- `id`, `userId`, `environmentId`, `label`
- `secretHash`, `secretPrefix`, `scopes`, `status`
- `protocolVersion`, `connectorVersion`, `platform`, `capabilities`
- `createdAt`, `updatedAt`, `lastSeenAt`, `lastConnectedAt`, `revokedAt`
- `lastDisconnectReason`, `lastT3Health`, `lastT3HealthAt`

### Connector ticket

- `id`, `connectorId`, `environmentId`, `tokenHash`
- `createdAt`, `expiresAt`, `consumedAt`

### Environment migration fields

- `transportMode: "direct" | "connector"`
- `connectorId`
- `baseUrl` remains only for direct mode and local connector metadata; it is not a cloud routing
  target in connector mode.
- `lastProjectionAt`, `lastConnectorSeenAt`, `freshness`

### Durable connection state

- Active socket attachment with connector/environment/protocol metadata.
- Bounded pending request table keyed by request id.
- Last accepted/terminal idempotency results.
- Thread subscription leases and event cursors.

All durable Store additions must span memory, file export/import, Convex adapter/functions/schema,
redaction, and parity tests.

## 9. Cloudflare runtime work

### 9.1 Worker adapter

- Add Wrangler configuration, generated binding types, environments for local/staging/production, and
  versioned compatibility date.
- Serve the Vite build through Workers Static Assets.
- Adapt WHATWG `Request`/`Response` to portable route handlers; isolate Node req/res handling in the
  local adapter.
- Exclude filesystem, UDP discovery, child-process, local Tailscale inspection, direct Parakeet
  sidecar, and local disk stores from the Worker bundle.
- Use Cloudflare secrets/bindings rather than process env files.

### 9.2 Durable Object connection hub

- Upgrade and authenticate connector WebSockets.
- Use WebSocket hibernation and attachments for reconnectable metadata.
- Route requests to the one active compatible connector or return `connector_offline`.
- Enforce per-connector pending/frame/buffer limits and deadlines.
- Publish connector events to the cloud event projection and console SSE/WebSocket bridge.
- Persist only the minimum state required across eviction/restart.

### 9.3 Jobs and storage

- Move production media/firmware bytes to R2 bindings.
- Map durable media/transcription/reconciliation tasks to Queue consumers or alarms.
- Keep hosted transcription in cloud providers/worker services; local Parakeet may become an optional
  connector capability, but that trust/privacy decision needs a separate acceptance gate.
- Replace process-local rate limiting with a shared backend appropriate to the deployed runtime.
- Preserve deterministic job claim/lease/idempotency behavior.

## 10. CLI work

### Commands

- `connect` — enroll, discover/launch T3, register capabilities, persist credential, run foreground or
  install service.
- `status` — cloud reachability, connector identity/version, T3 reachability/version/auth, Tailscale
  status, last connection/error.
- `doctor` — actionable diagnostics without printing secrets.
- `disconnect` — revoke locally and optionally request cloud revocation; remove service/state only
  after confirmation.
- `start`, `stop`, `restart`, `logs` — explicit service lifecycle with exact PID/service ownership.
- `update` — report/update package version without silently replacing a running connector.

### Local behavior

- Reuse `t3Bootstrap.mjs` discovery, provider catalogue, and T3 client logic behind connector-owned
  modules.
- Do not require the repository or mutate a user's project.
- Store state below the platform-appropriate user config directory with restrictive permissions.
- Redact enrollment, standing, T3, and provider credentials from logs.
- Handle SIGTERM/SIGINT, sleep/wake, DNS/network changes, T3 restart, and cloud deploy disconnects.
- Make foreground mode the test/reference path; service installation is explicit.

### Package gates

- `npm pack` contains only required runtime files, license/readme, and executable bin.
- Install tarball in a clean temporary directory and run `--help`, `doctor`, mock enroll, reconnect,
  and disconnect tests.
- No import depends on repository-relative frontend, firmware, test, or local `.data` files.

## 11. Console and onboarding migration

### Default flow

- Replace access-mode (`local/tailscale/online`) choice with **Connect this computer** and **Connect
  another computer**; both mint the same enrollment and differ only in explanatory copy.
- Show one published `npx` command with copy affordance, expiration, regenerate, and security note.
- Poll enrollment, then subscribe to layered connector/environment health.
- Completion requires connector online, T3 verified, provider catalogue registered, and a successful
  proof action—not merely code redemption.

### Environment status model

- Cloud: `operational | degraded | unavailable`.
- Connector: `waiting | online | reconnecting | sleeping | offline | revoked | incompatible`.
- T3: `unknown | starting | ready | stopped | auth_failed | incompatible | error`.
- Provider: `unknown | ready | auth_required | model_unavailable | error`.
- Projection freshness and last-seen timestamps always accompany cached states.

### Recovery

- Connector offline: wake machine, check connector service/network, copy `status`/`doctor` command.
- T3 stopped: start through connector when authorized or show local command.
- Version mismatch: give exact minimum/current/update commands.
- Revoked credential: mint a new enrollment; never ask for the old secret.
- Keep direct/self-hosted URL/token flows under an explicit advanced mode and label their trust model.

### Settings cleanup

- Cloud deployments do not offer **Expose this gateway with Tailscale Serve/Funnel**.
- Local/self-hosted runtime keeps those controls behind deployment-mode detection.
- Add connector fleet, version, last seen, rotate, revoke, logs/doctor help, and environment binding.

## 12. Device cloud hardening

- Replace every production `setInsecure()` path with a shared TLS trust abstraction.
- Choose a root CA bundle or pinned public key strategy compatible with Cloudflare certificates and
  planned rotation. Document clock bootstrap and expired/rotated trust recovery.
- Provision a stable production cloud origin at manufacture/claim; owners do not enter a T3 or
  Tailnet address on the controller.
- Keep long-lived device secrets out of URLs and logs; preserve TLS-only issuance/use.
- Add connector/T3 layered compact states to display projection.
- Validate WAN latency/loss, DNS changes, TLS failure, cloud deploy reconnect, connector offline, and
  authoritative polling recovery on real hardware.
- OTA downloads and manifests use the same validated trust path.

## 13. Performance requirements

- Cloud API p95 excluding connector/T3 work: <= 500 ms under staged beta load.
- Connector dispatch acknowledgement p95 when online: <= 2 seconds.
- First visible live agent event p95: <= 10 seconds, tracked separately from model latency.
- Connector offline recognition: <= 90 seconds; reconnect status visible within one heartbeat.
- No unbounded Worker/DO/connector buffer or collection.
- Worker and DO payload/CPU/memory metrics remain under configured platform limits with headroom.
- Console idle pages do not maintain unused thread subscriptions or continuous heavy animation.
- Touch firmware maintains its recorded responsive frame behavior while cloud requests run; e-ink
  refreshes only on meaningful projection changes.
- Device auth/liveness writes are coalesced so high-frequency polls do not amplify durable-store
  writes/broadcasts.

## 14. Security requirements

- TLS certificate verification on every production device and connector request.
- Separate platform, device, factory, connector, and enrollment-code realms.
- Connector secret hash at rest; standing secret shown once; rotation/revocation proven.
- T3 tokens never enter cloud storage in connector mode.
- Strict user/environment ownership on connector routes and Durable Object ids.
- WebSocket ticket single use, short TTL, origin/audience bound, and excluded from logs.
- Request deadlines, max sizes, schema validation, rate limits, replay/idempotency checks, and
  backpressure enforced on both sides.
- Cloud diagnostics redact connector frames, local paths, prompts, transcripts, tokens, and secrets.
- Security review covers Worker bindings, Clerk authorized parties, CORS/origins, R2 access, Queue
  messages, DO storage, firmware trust anchors, and npm supply chain.

## 15. Observability and operations

Metrics:

- Connector online/offline count, version distribution, heartbeats, reconnects, disconnect reasons.
- Enrollment mint/redeem/expire/fail counts without codes.
- Request latency by cloud queue, connector receipt, T3 acceptance, first event, completion.
- In-flight, timed-out, retried, duplicate, rejected, and backpressured request counts.
- Event sequence gaps, snapshot resets, dropped frames, payload sizes.
- Worker/DO exceptions, CPU, duration, storage operations, Queue lag/retries/dead letters.
- Device cloud reachability, TLS failures, auth failures, projection freshness.

Operations:

- Staging and production Wrangler environments, secret inventory, custom domains, migrations.
- Connector protocol compatibility matrix and minimum-supported version.
- Staged deploy, canary connector cohort, rollback, DO migration, and credential-rotation runbooks.
- Incident diagnostics that never require collecting raw user prompts, transcripts, or tokens.

## 16. Testing strategy

### Contract and unit

- Protocol encoder/decoder, schemas, limits, stable error codes, duplicate/replay behavior.
- Connector credential hashing, ticket issuance/consumption, rotation, revocation, ownership.
- Store parity for all connector/environment additions.
- Direct and connector transports pass the same behavioral contract suite.

### Connector package

- Pack/install/run from a clean directory.
- Mock cloud and real mock-T3 flows.
- Restart with pending/settled requests, corrupted/missing state, permission checks, version mismatch.
- Sleep/wake and network change simulations; bounded reconnect and logs.

### Cloud runtime

- Worker/Miniflare request tests and static asset delivery.
- Durable Object WebSocket authentication, hibernation/restart, request routing, timeout,
  backpressure, revocation, and deploy rollover.
- Convex/R2/Queue or selected binding integration tests.

### Product integration

- Console enrollment through ready/proof-thread.
- Console and device prompt through cloud connector to T3 and streamed response back.
- Gateway approval, provider approval, structured user question, stop/cancel, media attachment, and
  thread resume/reset.
- Connector offline before dispatch, disconnect after acceptance, T3 restart, expired credentials,
  incompatible versions, and cloud rollback.

### Hardware/security/performance

- Real controller validates cloud certificate and refuses MITM/unknown/expired trust.
- Provision/claim with stable cloud origin and no manual gateway/T3 address.
- WAN latency/loss soak, connector machine sleep/wake, OTA trust and rollback.
- Load test active connectors, devices, streams, and payload bounds against staging.

## 17. Delivery milestones

### Milestone 0 — Architecture contract and scaffolding

Deliverables:

- This roadmap accepted as canonical.
- ADRs for Cloudflare boundaries, connector protocol/credentials, offline semantics, and T3 token
  locality.
- `T3Transport` contract plus direct-adapter parity tests.
- Connector package and Worker/DO scaffolds build in CI/local gates.

Exit gate: no production call site needs to know whether T3 is direct or connector-backed.

### Milestone 1 — Connector enrollment and persistent channel

Deliverables:

- Connector Store/schema/auth realm and routes.
- Published-package-shaped CLI with pack/install smoke.
- Outbound WSS hello/heartbeat/request/response/reconnect/revocation.
- Local T3 discovery/auth/catalogue and health reporting.

Exit gate: Node cloud adapter can route snapshot and dispatch through a connector after the setup
script exits and restarts.

### Milestone 2 — Cloudflare runtime

Deliverables:

- Worker/static-assets entry, Wrangler environments, binding types.
- Durable Object connector hub and cloud transport.
- Durable storage, shared limits, jobs, deploy/rollback path.

Exit gate: staging survives Worker/DO eviction and deployment rollover without losing connector truth
or duplicating a decided command.

### Milestone 3 — Full T3 feature parity through connector

Deliverables:

- Snapshot, thread detail, dispatch, provider RPC, terminal operations, live subscription,
  approvals/questions, catalogue, media, stop/cancel routed through `T3Transport`.
- Direct mode remains green against the same contract suite.

Exit gate: the full existing console feature set works with a connector environment and the cloud
stores no T3 token.

### Milestone 4 — User experience migration

Deliverables:

- One-command onboarding, connector fleet/settings, layered health, recovery, update/revoke.
- Self-hosted direct mode moved to advanced/deployment-specific UI.
- Documentation and support diagnostics updated.

Exit gate: a first-time user completes setup without URL/token paste or repository checkout.

### Milestone 5 — Device cloud security and behavior

Deliverables:

- Verified TLS trust/rotation across all production firmware network paths.
- Stable cloud origin provisioning and layered connector/T3 states.
- Cloud/WAN/OTA hardware gates.

Exit gate: a real claimed controller completes the cloud-to-connector-to-T3 loop and refuses an
untrusted certificate.

### Milestone 6 — Operations, performance, and staged rollout

Deliverables:

- Metrics/alerts/runbooks, protocol compatibility/update policy, load/chaos/security evidence.
- Staging canary, rollback rehearsal, beta rollout gates.
- Owner-scoped firmware/connector release records with stable percentage or explicit allowlist
  cohorts, compatibility/capability blocks, evidence-gated pause/resume/expand/cancel/rollback/
  completion, durable per-target truth, and idempotent Node plus Cloudflare reconciliation.
- Legacy direct-mode migration/deprecation policy.

Local implementation status (2026-08-27): the rollout control plane, Store/File/Convex parity,
owner APIs, Queue/Cron runner, Settings fleet UI, and runbook are implemented and focused tests pass.
The connector contract has no remote self-update operation, so connector assignments deliberately
remain `awaiting_operator_update` until the local CLI reports the target version. Hosted canary,
package publication, clean-host update, signed firmware downgrade, physical rollback, and operator
rehearsal evidence remain required; local state-machine tests do not satisfy this milestone's exit
gate.

Exit gate: all definition-of-done evidence below is recorded against the deployed candidate.

## 18. Definition of done

Every item is required. Checked items have local evidence only unless the text explicitly names a
hosted or physical result:

- [x] Cloudflare Worker, Durable Object, Queue/Cron, and private Container deployment artifacts exist.
- [ ] Staging bootstrap/deploy succeeds against the real Cloudflare, Convex, Queue, and R2 resources.
- [x] Connector package has a real `bin`, packs cleanly, and runs outside the repository.
- [x] Connector enrollment creates a separate revocable credential; T3 tokens stay local.
- [x] Persistent outbound channel locally handles heartbeat, request/response, events, resume,
  limits, revocation, reconnect, and process restart.
- [ ] Clean-host sleep/wake, WAN transition, and deployed rollover behavior are proven.
- [x] Application T3 operations use the shared direct/connector adapter and local parity gates pass.
- [ ] Deployed connector mode is proven against live T3 across the supported feature set.
- [ ] Cloud/runtime state remains correct across isolate/DO eviction and deployment rollover.
- [x] Default onboarding locally uses one `npx` command and layered health/recovery, including
  completed-reply evidence rather than dispatch acknowledgement.
- [ ] That onboarding journey is completed through the published package and deployed cloud.
- [x] Production firmware paths share fail-closed certificate validation and a stable configured
  cloud origin; insecure TLS is isolated to the explicit bench build.
- [ ] Production roots and negative TLS behavior are proven on physical controllers.
- [ ] Console and physical controller both complete prompt -> dispatch -> live response.
- [ ] Gateway, provider approval, user question, media, stop/cancel, and resume/reset work end to end.
- [x] Direct/self-hosted mode is explicitly separated and its tests remain green.
- [x] Local Store parity, protocol, package, Worker/DO, frontend, security, deterministic resilience,
  capacity, and selected firmware gates pass.
- [ ] Hosted integration, soak, deployment, rollback, clean-host, and physical gates pass.
- [x] Documentation, status ledger, observability, runbooks, and migration policy distinguish local
  implementation from unrun external proof.
- [x] No completion claim relies on an unrun live-T3, cloud, package, or hardware test.

## 19. Implementation sequence and remaining qualification

The original backend, connector, and cloud-runtime waves are complete locally: the shared adapter,
connector Store/auth/protocol, package and T3 bridge, Worker/Durable Object/private Container join,
console onboarding/settings/recovery, firmware TLS abstraction, and rollout controls are present and
covered by their repository gates.

The remaining wave is external qualification: publish the connector through the protected workflow;
bootstrap and deploy the Cloudflare/Convex/R2/Queue topology; exercise live T3 feature parity,
sleep/WAN/revocation/rollover/chaos/load/security behavior; and complete the physical firmware and
controller-to-cloud-to-T3 evidence. The primary integrator owns final cross-surface gates, evidence
reconciliation, and truthfulness of any release claim.

## 20. Known risks and mitigations

| Risk | Mitigation |
|---|---|
| Node compatibility hides Worker lifecycle incompatibility | Explicit runtime adapter; Worker-native tests; no local disk/process timer assumptions |
| Connector becomes a second gateway | Keep policy and durable command decisions in cloud; connector only authenticates local T3 and transports operations/events |
| Duplicate effects after reconnect | Stable request/idempotency ids, bounded result cache, command arbiter, explicit accepted vs completed |
| Connector offline queues stale destructive actions | Fail new writes before dispatch; no indefinite automatic mutation queue |
| T3 protocol changes | Connector reports T3/contract version; compatibility gate; captured fixtures and live canary |
| Durable Object eviction loses truth | Durable Store is source of truth; DO persists minimal cursor/request metadata and resets from authoritative projections |
| Firmware trust-anchor expiry bricks devices | Root/public-key strategy with overlap, OTA rotation, clock/recovery design, staged certificate tests |
| Cloud costs scale with polling | Outbound connector events/heartbeats, demand-driven subscriptions, coalesced liveness, bounded DOs |
| npm connector supply-chain compromise | Minimal package, lockfile/provenance, signed releases, version policy, no auto-update without visibility |
| UI reports cloud online while local T3 is dead | Layered health model with freshness and last-seen evidence |

## 21. Open implementation questions

These do not block the remaining external qualification unless noted:

- Native credential policy is decided and implemented locally: the standing connector credential
  prefers Keychain, Secret Service, or Credential Manager; a mode-`0600` file is an explicit
  automatic fallback only when no native facility exists. A configured native store fails closed.
- Whether optional local Parakeet inference is exposed as a connector capability or remains an
  operator-managed service.
- Whether console realtime remains SSE from Worker or moves to WebSocket for shared DO fanout.
- Final public npm package scope/name. Windows per-user Task Scheduler support is implemented locally
  and still requires clean-host qualification.
- Exact beta connector/device concurrency and Cloudflare cost budgets.

Any choice must preserve the fixed principles, contracts, and acceptance gates above.

## 22. Completion gap register — independent audit, 2026-08-27

This register is the authoritative closure plan for the remaining difference between the locally
integrated candidate and the production journey defined in section 1. A row moves to **proven** only
when its named evidence exists; code presence or a narrower unit test is not sufficient.

| ID | Gap and current failure mode | Implementation work | Evidence required to close |
|---|---|---|---|
| CG-01 | **Implemented locally; hosted proof remains.** Worker Queue/Cron handlers now own connector projection, snapshot, live-thread, media, retention, and bounded user fan-out through the private Container endpoint. | Preserve the single-owner invariant and operational health while staging the bindings. | Local Worker/cross-runtime tests and dry-runs pass; staged Queue/Cron invocation must still show Store projection, retry, lag, and dead-letter behavior. |
| CG-02 | **Implemented locally; hosted proof remains.** Store revocation now crosses the private router, tombstones the connector, closes its live socket, terminalizes matching work, and preserves replacement safety. | Exercise the same semantics through deployed Service Bindings and the real WebSocket lifecycle. | Local ownership/idempotency/revoked-reconnect tests pass; staged socket close must prove no heartbeat, work, or ticket race survives revocation. |
| CG-03 | **Implemented locally; real sleep/network proof remains.** Reconnect redelivers only live pending requests, restores subscription leases/cursors, rejects stale connections, and retains bounded buffers. | Run machine sleep, process restart, WAN transition, Durable Object eviction, and deploy rollover drills. | Local replay/dedup/cancel/expiry/stale-connection/buffer tests pass; staged and live-T3 recovery evidence remains required. |
| CG-04 | **Atomic rotation, native credential adapters, cross-platform managed lifecycle, Windows T3 ownership, and protected npm release automation are implemented locally; publication/OS proof remains.** Rotation retains one connector id, bounds overlap to ten minutes, commits on staged-ticket consumption, invalidates old-generation tickets, journals local state atomically, and bridges until the managed service takes over. The standing secret prefers Keychain, Secret Service, or Credential Manager with atomic migration and explicit private-file fallback. Safe T3 auto-start on all three supported platforms, transactional update rollback, and an owned per-user Windows Task Scheduler lifecycle are implemented; Windows uses a verified Node/npx entrypoint, exact process fingerprint, private interruption journal, and PID-scoped tree shutdown. The manual `npm-release` workflow now binds exact version/tag/commit confirmation, repeats dependency-free test/pack/clean-install/dry-run checks, requires a non-`UNLICENSED` manifest plus a package-local `LICENSE`, grants OIDC only after environment approval, refuses immutable reuse, requests provenance, designs clean external exact-version verification, and emits a redacted evidence projection. The package manifest now declares Apache-2.0, ships a package-local `LICENSE`, and carries `Wearer-Lab/next-coder` repository/homepage/bugs metadata. Platform-native paths are mocked only and no npm release has run. | Confirm the final public package scope/name, configure npm trusted publishing plus GitHub environment/tag protection, and execute/review the protected publication. Then pin/validate the released T3 launcher contract and exercise native storage, T3 launch/pairing/stop/recovery, migration, rotation, and interrupted-resume through launchd, systemd-user, and Task Scheduler on clean hosts. | Protected run with registry digest/provenance evidence; clean exact-version `npm exec` on macOS/Linux/Windows machines without the repo; live native-store write/read/delete/migration plus launch/start/status/doctor/update/rotate/stop; observed no-offline handoff and old-auth rejection; package version shown in console. |
| CG-05 | **Truthfulness fix implemented; frontend/deployed proof remains.** Enrollment is no longer labeled connection-ready and the result copy separates connector, T3, provider, and first-action evidence; onboarding already gates final completion on readiness. | Keep recovery routing aligned with the first failed health layer and verify the concurrent UI edit through the full frontend gate. | Frontend tests for every layer and recovery action; deployed browser journey from fresh account through successful first response; usability pass on narrow/mobile viewport. |
| CG-06 | **Implemented locally; physical proof remains.** The device projection carries bounded non-secret transport/freshness/connector/T3/provider facts and an actionable priority. Shared firmware parses it; Hosyond renders it; Waveshare joins securely without advertising unproved UI/media; and T190 renders status plus capability-gated browsing/operate flows. | Exercise every claimed failure/ready/action state on physical displays and inputs. Do not enable Waveshare UI/media or T190 thread-picker capability until the corresponding hardware path is proven. | API ownership/redaction/payload tests, focused board contracts, and isolated builds pass; physical display/input evidence for online, sleeping, connector-offline, T3-auth-failed, provider-auth-required, stale, ready, action, approval, and response states remains. |
| CG-07 | **Local image and protected bootstrap/release/production-promotion policy are implemented; hosted path remains unproven.** The digest-pinned `linux/amd64` Container image is non-root, allowlisted, dependency-minimized, and locally smoke-tested. Manual-only staging bootstrap creates/verifies exact dependencies; staging release pins versions and deploys Convex -> private Container -> edge with compatible rollback. Production promotion now binds a forward commit to fresh hash-locked release/qualification/hosted-capacity/security evidence plus deterministic tracked deploy-input identities, verifies production versions/topology/resources/secret names, and separates read-only, private, edge, and postflight through four protected approvals. Current `standard-1`/one-instance/100% Container config does not support a truthful canary, so it uses explicit checkpoints and never auto-rolls back or bootstraps. | Configure all protected environments and provider-scoped credentials; execute bootstrap/staging qualification; produce the hosted evidence manifest; execute production promotion and rehearse compatible plus incident-specific recovery. | Protected workflow/evidence artifacts; live private-binding, R2/Queue/Convex and capacity/security proof; exact active commit annotations; rollback rehearsal. No external provisioning, deployment, or live qualification has occurred. |
| CG-08 | **Locally qualified; hosted decision remains.** `docs/capacity-slo.md` defines the provisional singleton beta budget and records a deterministic gate for 16 concurrent environments, 48 Container proxy requests, exact 32-request/16-lease/48-waiter DO saturation, local p50/p95/p99, fresh/warm Node adapter latency, RSS/heap/CPU, and the process-local rate-limit restart caveat. | Run the named staging matrix on `standard-1`; record hosted CPU/memory/cold start/rollover/availability, Redis continuity, full per-hop latency and a Cloudflare billing observation; then accept singleton, partitioning, or a lower enforced admission limit. Shared rate limiting is mandatory before `max_instances > 1`. | Local command is `npm run test:capacity`; staging evidence must include the report fields above and an explicit capacity decision. Local results are not hosted-capacity or cost proof. |
| CG-09 | **The matrix and release-build slice are implemented locally; public-cloud TLS and the full physical loop remain unproven.** A canonical 15-environment manifest, CI/static parity gate, secret-safe temporary build runner, and explicit secure release targets exist. All CrowPanel and Waveshare environments plus the secure Hosyond controller compile from current post-TLS source. The updated T190 default and explicitly gated external-input variants also compile; earlier worktree stalls were isolated to macOS File Provider build-output conflicts. | Renew the remaining Hosyond probes/benchmarks on an uncontended runner; inject current/next production roots; exercise clock bootstrap, expired/untrusted certificate refusal, Wi-Fi/WAN loss, connector sleep/reconnect, OTA trust rotation, and controller-originated request/result/approval/input. | Complete green compile report plus separate on-silicon evidence per board; packet/runtime logs redacted of credentials; successful and negative TLS tests; complete controller-to-cloud-to-T3 trace. |
| CG-10 | **Repository scan, CI enforcement, adapter error redaction, release guards, and tracked-file remediation are implemented; external credential rotation remains.** The path/signature gate blocks every non-example `controller_config*` variant, Convex adapter failures expose only local allowlisted metadata, and connector release refuses missing/`UNLICENSED` licensing. Both live CrowPanel variants were removed from the index and from history on 2026-09-08 before the first push to GitHub (a pre-rewrite mirror remains on the maintainer's machine until the rotation below is done); a previously exposed Convex gateway credential and the purged bench device secret still need external rotation, deliberately deferred and tracked in `docs/deferred-items.md` because no deployment exists for them to protect yet. | Rotate every credential that may have appeared and delete the pre-rewrite mirror once that rotation is recorded. The tracked-file, licensing, and repository-metadata work is done: `git ls-files` now returns only the four `controller_config.example.h` files, and both manifests carry Apache-2.0 plus repository metadata. | `git ls-files` excludes live configs; examples contain placeholders only; local and CI secret scans pass; external rotation is recorded; package/license/repository release checks pass. Index/history changes and external rotation require maintainer authorization. |
| CG-11 | **Documentation reconciled and deterministic local-link validation implemented; release-time review remains.** README, package/runtime docs, protocol/runbooks, both active roadmaps, and `IMPLEMENTATION-STATUS.md` distinguish implemented local behavior from deployed, live-T3, clean-host, browser, and hardware proof. `npm run check:docs` now checks maintained first-party Markdown without Git or network access, excludes downloaded firmware/dependency documentation, and runs in credential-free CI; its workflow test also repeats the current-tree validation in release aggregates. | Keep the ledger and runbooks synchronized with later runtime or external evidence changes. Review external URL availability and heading fragments separately because the hermetic gate validates local targets only. | Current first-party relative targets, firmware inventory, and workflow/runbook contract tests pass; repeat from the release checkout and review the final release diff. |
| CG-12 | **Deterministic local resilience and browser gates added; staged/perceptual proof remains.** Connector/cloud tests cover eviction, stable replay, stale/out-of-order/late results, cancellation, reconnect storms, lease recovery/expiry, exact caps, oversize frames, byte-bounded buffers, redacted rotated logs, and local p95 ceilings. The console now enforces entry/chunk budgets, lazy workspaces, a 512-row live projection, and one state transition per animation-frame event batch; a cold local Chrome observation is recorded without treating its timing as an SLO. | Run WAN/Queue/deploy soaks; profile authenticated real-stream CPU/GPU and multi-hour heap behavior on representative desktop/mobile browsers; measure firmware responsiveness; capture hosted per-hop latency/capacity/cost. | Local reports are `docs/connector-resilience-gate.md` and `docs/frontend-performance-gate.md`; staged loss/latency/DNS/sleep/rollover/Queue lag plus real browser, physical, and hosted evidence remain required. |

### 22.1 Remaining evidence sequence

1. **Release preconditions:** complete CG-10's external credential rotation and mirror deletion —
   its tracked-config side closed with the 2026-09-08 history rewrite — and repeat CG-11's
   documentation checks from the release checkout.
2. **Staging proof:** exercise CG-01, CG-02, CG-03, CG-07, CG-08, and CG-12 through the isolated
   Cloudflare/Convex/R2/Queue topology. Their implementation is local; this step collects the hosted
   lifecycle, capacity, privacy, alerting, and resilience evidence.
3. **Truthful product journey:** publish and qualify CG-04, then complete CG-05 and CG-06 through a
   fresh account, clean connector host, live T3/provider, and representative browser.
4. **Physical beta:** close CG-09 and repeat the complete section-1 journey with controller TLS,
   rollback, and revocation evidence.

### 22.2 Final definition-of-done audit

The workstream is complete only when one evidence bundle links all of the following: clean npm
installation; fresh account enrollment; deployed Cloudflare request path; live local T3/provider;
first streamed response; approval and structured user-input handling; sleep/reconnect replay;
immediate revocation; controller claim and operation over verified TLS; observability and bounded
performance; deploy rollback; and credential-safe repository state. A successful local unit suite,
Worker dry-run, firmware compilation, or browser-only demonstration cannot substitute for that bundle.
