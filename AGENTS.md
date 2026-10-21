# Next Coder

Next Coder is a cloud control plane between people, controller hardware, the web console, and
[T3 Code](https://github.com/pingdotgg/t3code). The production server should run in the cloud,
preferably on Cloudflare. T3 Code and optional Tailscale run on the user's machine, where the
install-free `@next-coder/connector` CLI connects the local T3 runtime to Next Coder.
The cloud service authenticates actors,
applies policy, stores control-plane state, and routes work; it never runs coding agents itself.

This file is the default working agreement for coding agents in this repository. User instructions
override it. Read the relevant parts of `CLAUDE.md` before changing a subsystem; it contains the
detailed protocol history and invariants that do not fit here.

## What we never compromise on

### 1. Device architecture

Controllers are purpose-built remote surfaces, not miniature gateways and not sources of account
truth. They connect directly to the cloud Next Coder endpoint over authenticated outbound
HTTPS/WSS, capture intent, render a compact projection, cache only what is needed to survive a
temporary disconnect, and recover through explicit provisioning and claim flows. ESP32 controllers
do not run Tailscale. Authentication, policy, durable control-plane state, and routing stay in the
cloud service.

Reusable device behavior belongs in `firmware/shared/NextCoderCore`; board folders own pins,
display/input drivers, and genuinely board-specific UI. A feature is not complete when only the
console or one board can use it. Follow the full path—input, policy, dispatch, live result, recovery,
and reverse action—on every applicable surface.

### 2. Remote control

Remote operation is the product, not an optional deployment mode. The production topology is:

1. Next Coder runs at a stable cloud HTTPS/WSS origin, preferably on Cloudflare.
2. Controllers and the web console connect to that cloud origin.
3. T3 Code and Tailscale run on each user's machine.
4. An `npx` connector CLI pairs local T3 with the user's cloud account and maintains the authenticated
   control path to Next Coder.

The connector should initiate the cloud connection so a user does not need to open an inbound port,
publish T3 to the internet, or place the cloud service inside their Tailnet. Tailscale remains the
private network layer on the user machine; the connector is the application bridge. Do not bake a
localhost origin, local path, direct cloud-to-LAN reachability, same-machine credential, or
always-online assumption into a product contract.

Remote state must remain truthful through disconnects. Use leases, resume cursors, deduplication,
idempotency, bounded retries, and explicit stale/offline/reconnecting states. A remote control must
always show whether an action was accepted by the gateway, dispatched to T3, completed, failed,
blocked for approval, or waiting for user input.

### 3. Performance without compromise

Performance is a product constraint across the gateway, network, console, and device. Avoid large or
repeated WebSocket/SSE payloads, unconditional polling, unbounded lists and caches, blocking the Node
event loop, firmware network calls on the render path, and CSS/orb animations that cause sustained
CPU or GPU load. Touch displays need responsive frames; e-ink needs deliberate refreshes; remote
links need compact projections and demand-driven subscriptions.

Performance-sensitive work needs evidence. Measure the affected budget—payload size/rate, render
time, frame gaps, memory, queue wait, request latency, or reconnect behavior—before and after the
change. A passing unit test does not prove smooth hardware or remote behavior.

### 4. Security at every boundary

Platform users, devices, factory tooling, the cloud service, connector CLIs, media storage, and T3
environments are separate trust boundaries. Preserve least-privilege scopes, per-realm credentials,
ownership checks, TLS rules, short-lived pairing codes, connector credential rotation, secret
hashing/encryption, and diagnostics redaction. The public cloud endpoint is internet-facing by
design; local T3 access remains private behind the connector and Tailscale.

Production device TLS must validate the cloud server certificate through a maintained CA bundle or
pinning/rotation design. `WiFiClientSecure::setInsecure()` is allowed only in an explicit local bench
build and is a release blocker for any firmware that sends device credentials to the cloud.

Prompts, transcripts, media, paths, tokens, device secrets, and provider answers are private. Store
the minimum, never print or commit secrets, and re-check authorization when delayed work executes—not
only when it was queued.

### 5. Truth and simplicity

Do not put mock or fabricated data in product paths. Tests and explicitly named mock providers may
use deterministic fixtures. Never claim live T3, remote, performance, security, or hardware
verification that was not actually observed. Preserve the hand-rolled Node HTTP boundary, explicit
adapters, and pure projections; add machinery only when the behavior requires it.

## Terminology

- **gateway**: this Node control-plane service.
- **console**: the React web/PWA client served by the gateway.
- **controller** or **device**: claimed ESP32 hardware using device credentials.
- **T3 environment**: one paired T3 server plus its machine, projects, providers, and threads.
- **project**: a T3 workspace rooted at a directory. UI copy may call it a folder.
- **thread**: the durable T3 conversation and work history for a project.
- **provider** or **harness**: the coding-agent runtime T3 wraps, such as Codex or Claude Code.
- **gateway approval**: policy stopped a command before it left this service.
- **provider approval**: T3 stopped an active turn for permission.
- **user input**: T3 asked for a value or choice; this is not an approval.

Use these distinctions in code, tests, docs, and UI copy. Collapsing the three blocking states is a
correctness bug.

## Before changing code

- Read `git status` and preserve all existing work. This repository is often changed from a live T3
  session and may already contain uncommitted code from the maintainer or another agent.
- Read the nearest implementation and its tests before designing a replacement. Search with `rg`.
- Read the relevant contract docs and the applicable `CLAUDE.md` section. For roadmap work, compare
  the roadmap with `roadmap/IMPLEMENTATION-STATUS.md` and the code; current code and tests win when
  documents disagree.
- Keep the task's scope. Do not commit, push, open a PR, deploy, modify external services, or operate
  the user's browser unless explicitly requested.

## The complete-change checklist

Before calling a product change done, decide which of these surfaces apply and cover each one:

- **Contract and validation:** request/response shapes, compatibility, error semantics, and idempotency.
- **HTTP and authentication:** route order in `src/app.mjs`, exactly one auth realm, and the matching
  rate-limit helper.
- **Storage:** memory reference behavior, file persistence, Convex adapter/functions/schema, export and
  redaction behavior, and store-parity tests.
- **T3 transport:** HTTP snapshot/dispatch and authenticated WebSocket behavior, including reconnect,
  resume, acknowledgement, and stale-request handling.
- **Console:** loading, success, empty, stale, failure, reconnect, and reverse-action states.
- **Controller:** compact projection, capability/profile gating, offline recovery, and the relevant
  board UI where the feature belongs.
- **Realtime and background work:** SSE payloads, replay/dedup rules, leases, job retries, and process
  restart behavior.
- **Performance:** payload size and frequency, list/caching bounds, render and animation cost,
  request/queue latency, device frame or refresh budget, and behavior on a slow or lossy link.
- **Security and privacy:** ownership checks, secret handling, user-content redaction, retention, and
  support diagnostics.
- **Documentation:** user behavior in `README.md` or `docs/`, protocol changes in the contract docs,
  and verified roadmap status when relevant.

If a surface does not apply, say why in the handoff when the omission would otherwise be surprising.

## Architecture invariants

### Device architecture

- Keep controllers thin and capability-scoped. The cloud service owns authentication, policy,
  routing, and durable control-plane state; T3 owns projects, threads, provider sessions, and agent
  output; the local connector translates between them.
- Device APIs return compact projections designed for constrained screens and links. Do not send a
  full owner record, transcript, provider catalogue, or audit timeline when the controller needs a
  label, state, and available action.
- Cache enough device state for boot and temporary network loss, but reconcile it with the gateway.
  NVS is not a second source of account or T3 truth.
- Shared protocol behavior belongs in `firmware/shared/NextCoderCore`. Board-specific code is
  the hardware adaptation layer and must not fork policy or gateway contracts.

### Gateway and authentication

- Keep domain logic independent of the hosting runtime. The current Node 22+ ESM `node:http` server
  is the local-development/reference adapter, not the final production topology.
- Cloudflare is the preferred production target. Add an explicit Worker/runtime adapter and validate
  every dependency, background lifecycle, WebSocket, streaming, and storage assumption in the
  Workers runtime; Node compatibility is not permission to assume a long-lived process or local disk.
- `src/app.mjs` is an ordered route chain. Exact/static routes must not be shadowed by parameterized
  routes. Throw `HttpError` and let the outer boundary serialize it.
- A returned promise inside `handle()` must use `return await` so the surrounding `try/catch` owns
  the rejection.
- Platform-user, device, and factory authentication are separate realms. Never accept one realm's
  credential on another realm's route.
- The connector is a fourth realm. Pair it with a short-lived, single-use user-authorized code, then
  issue a revocable environment-scoped credential. Never reuse a platform token or T3 pairing token
  as its standing credential.
- T3 access and pairing tokens stay on the user machine in the target architecture. The connector
  stores them through OS-protected or mode-`0600` local state; the cloud stores only the hashed
  connector credential and environment routing metadata.
- Rate-limit checks are asynchronous. Every `enforce*` call must be awaited.

### T3 and realtime

- Treat T3 as a versioned external system. Do not invent fields from memory; use captured fixtures,
  the installed T3 contract/source map, and compatibility tests.
- A dispatch acknowledgement is not a completed agent turn. Completion needs newer reply or failure
  evidence and must pass through the command arbiter.
- Streaming `thread.message-sent` content is a delta. A thread snapshot replaces current state. Event
  replay and live delivery may overlap, so deduplicate without assuming monotonic arrival.
- Every Effect RPC `Chunk` must be acknowledged. Close subscriptions with `Interrupt`, and preserve
  global event-sequence resume behavior.
- Gateway holds, provider approvals, and user-input requests keep separate routes, capabilities,
  persistence, and answer schemas.

### Remote control and connectivity

- Production traffic follows `controller|console -> cloud service -> local connector -> T3`, with
  results returning over the same trusted boundaries. The cloud service must not depend on direct
  reachability to a user's LAN or Tailnet.
- The `npx` connector is a required product component. It must discover or launch local T3, redeem a
  one-time cloud pairing code, register environment/provider capabilities, maintain heartbeats and a
  resumable authenticated channel, proxy commands and events, and surface actionable reconnect state.
- Test the applicable paths: device-to-cloud, browser-to-cloud, connector-to-cloud, connector-to-T3
  over loopback or Tailnet, machine sleep/wake, network changes, CLI restart, and cloud deployment
  rollover. If a path is not exercised, state that explicitly.
- Keep browser APIs same-origin in development. Do not compile a localhost HTTP or WebSocket origin
  into the client bundle.
- A reconnect must be resumable or explicitly reset from an authoritative snapshot. Never present
  cached state as live, silently truncate missed events, or retry a non-idempotent action blindly.
- Do not require Tailscale on controllers or in the cloud account. It runs on user machines; the
  connector owns the bridge between private local T3 access and the cloud control plane.

### Performance and resource budgets

- Keep subscriptions demand-driven and projections compact. Avoid polling data already carried by a
  live stream, and never hydrate every T3 thread body for a list or device screen.
- Bound event deduplication, caches, retries, queues, concurrency, media sizes, and rendered lists.
  Every long-lived collection needs an eviction or retention rule.
- Do not perform blocking inference, storage, network, or serial work on the Node request loop or a
  firmware render path. Preserve the sidecar/worker and firmware task boundaries.
- Cloud connection state must scale by active environment, not by polling every user or holding
  process-local state that disappears on a Worker isolate restart. Bound per-connector buffers and
  backpressure command/event streams.
- Treat animation as state communication. Avoid continuous full-page repainting, excessive blur or
  particle counts, and timer loops that keep running when hidden or idle.
- For performance-sensitive changes, record the metric and workload used. Do not replace measurement
  with subjective claims such as “feels faster.”

### Stores, jobs, and media

- `src/store.mjs` is the reference Store API. A new durable method normally also requires
  `src/fileStore.mjs`, `src/convexStore.mjs`, `convex/gatewayStore.ts`, `convex/schema.ts`, and parity
  coverage.
- In the current Node adapter, background runners are constructed in `createApp()`, started only by
  `src/server.mjs`, and exposed through deterministic `runOnce()`-style hooks for tests. A Cloudflare
  adapter must preserve the same domain steps through platform-native scheduling/queues/alarms rather
  than assuming a permanent Node process.
- Keep retries idempotent and classify terminal versus retryable failures at the throw site. Do not
  parse control flow out of error-message text.
- `storagePath` may be a local path or an object-store key. Go through the storage adapter.
- Media descriptions, transcripts, answer keys, filenames, paths, and prompts are user content.
  Audit and support projections must redact them.

### Console

- The frontend is React 19 + Vite + Tailwind. `frontend/src/api.ts` is the fetch boundary and
  `frontend/src/controller.ts` coordinates app state.
- Clerk tokens are fetched per request and are never stored in `localStorage`.
- Reuse shared composer, media, recovery, and projection logic instead of creating route-specific
  variants. A state label must reflect evidence; never leave a lying spinner or stale success state.
- Keep animation work bounded. The orb is meaningful state feedback, not permission for continuous
  full-page repainting or avoidable GPU/CPU use.

### Firmware

- Shared writable state, provisioning, gateway transport, media upload, and orb behavior belong in
  `firmware/shared/NextCoderCore` when more than one board needs them.
- `controller_config.h` is a bench seed, not runtime truth. Factory identity comes from NVS seed data;
  customer Wi-Fi never belongs in a factory image.
- Boards differ in display, input, recovery gesture, and verified peripherals. Do not copy an
  unverified pin map or claim one board's silicon result for another.
- Network waits must not stall touch/render work. Keep cross-task state synchronized, bound buffers,
  avoid repeated heap churn in the frame loop, and verify memory plus frame/refresh behavior on the
  affected hardware.
- Never ship an HTTPS client that calls `setInsecure()`. Certificate validation, clock bootstrap,
  trust-anchor rotation, and OTA recovery must be designed and exercised together before cloud use.
- Flash, erase, OTA, partition, and eFuse operations affect physical devices. Resolve the exact port,
  board, environment, and requested operation first. Secure-boot/eFuse actions require explicit
  confirmation because they can be irreversible.

## Repository map

- `src/` — gateway, policy, T3 adapters, realtime, background jobs, and storage bridges.
- `frontend/src/` — React console/PWA, pure client projections, hooks, and feature workspaces.
- `convex/` — production schema and remotely executed Store implementation.
- `firmware/shared/` — reusable controller core.
- `firmware/<board>/` — board-specific PlatformIO entry points, pins, display/input code, and docs.
- `test/` — Node server and contract tests, including captured T3 fixtures.
- `docs/` — API, device protocol, onboarding, security, storage, and operations documentation.
- `roadmap/` — target design and the canonical evidence-backed implementation ledger.
- `scripts/` — setup, smoke, simulation, manufacturing, firmware publishing, and Parakeet helpers.

The repository-local `npm run setup:t3` flow is a precursor, not the finished connector. The target
requires a publishable package with a `bin` entry that users can run through `npx` outside a checkout.

## Commands and verification

Install and run the current local-development adapter:

```bash
npm install
npm start
npm run dev:server
npm run dev:app
```

Use the smallest proof while iterating:

```bash
node --test test/policy.test.mjs
node --test --test-name-pattern="claim" test/app.test.mjs
npx vitest run --config frontend/vitest.config.ts src/format.test.ts
npm run typecheck:app
```

The repository gate is:

```bash
npm test
```

`npm test` builds the console, asserts its performance budgets, typechecks the console, Convex, the
Cloudflare edge and the private control plane, and then runs the frontend, server, connector,
Cloudflare edge, and control-plane suites. There is no linter. Do not run bare `node --test` at the
root; it incorrectly discovers browser tests without Vitest's jsdom setup.

For firmware, build the specific environment you changed first:

```bash
pio run -d firmware/Hosyond-ESP32-S3-2.8-Touchscreen -e hosyond-es3c28p-controller
```

Run broader gates in proportion to the change. Tests prove code behavior, not physical display,
audio, touch, radio, OTA, or live-T3 behavior. Report each kind of evidence separately.

## Safe process and data handling

- Never kill by name or pattern (`pkill -f`, `pgrep | kill`). Track the PID of a process you start,
  or identify the exact port owner and confirm its working directory before stopping it.
- Stop only services you started unless the user explicitly asks otherwise. A gateway, T3 server,
  tunnel, browser, sidecar, or serial monitor may belong to the maintainer's active session.
- Treat `.env`, `.env.local`, `.data/`, board `controller_config.h` files, NVS/manufacturing output,
  local Claude/T3 transcripts, Convex deployments, and real device state as live user data. Read
  only what the task requires; do not reset, rewrite, upload, or expose it.
- Do not edit generated/runtime/vendor output such as `node_modules/`, `dist/`, `.pio/`,
  `.venv-parakeet/`, or downloaded board reference archives as ordinary source.
- Prefer captured fixtures for regression tests. Never point a test runner or dev server at a live
  T3 data directory.

## Documentation and handoff

- `README.md` is the newcomer and operator entry point. Keep its commands executable and its status
  claims conservative.
- `CLAUDE.md` is the detailed architecture notebook. Update it when a subtle invariant or protocol
  finding becomes durable.
- `docs/api.md`, `docs/hardware-protocol.md`, and related docs own public contracts and runbooks.
- `roadmap/IMPLEMENTATION-STATUS.md` is the canonical progress ledger. Mark work done only with
  current evidence; record code/test, live-T3, and hardware proof separately.
- Do not turn this file into a changelog or paste ephemeral implementation plans into it.
- Before handing off, inspect the final diff, list the checks actually run, call out checks not run,
  and name any remaining blocker without presenting it as complete.

This guidance takes structural inspiration from
[T3 Code's `AGENTS.md`](https://github.com/pingdotgg/t3code/blob/main/AGENTS.md), adapted to Next
Coder's gateway, storage, web, and hardware boundaries.
