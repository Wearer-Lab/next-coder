# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Cloud control plane ("gateway") that lets remote controller hardware (ESP32 devices) and a web console drive
[T3 Code](https://github.com/pingdotgg/t3code) agent environments running on a user's own machine. The gateway never
runs agents itself — it authenticates actors, applies policy, and dispatches orchestration commands to a paired T3 Code
instance. In managed-cloud mode that traffic crosses an authenticated outbound connector WebSocket while T3 remains
loopback-local; the direct transport (HTTP for T3 0.0.x, WebSocket for 0.1.x) is retained only for self-hosted deployments.

Node >= 22 is required. The server uses ESM (`.mjs`) with **zero runtime web framework** — a hand-rolled `node:http`
server. The frontend is React 19 + Vite 8 + Tailwind 4.

## Commands

```bash
npm start                 # build client, then run gateway on http://127.0.0.1:3996
npm run dev:server        # gateway with --watch (no client build)
npm run dev:app           # Vite on :5173, proxies /v1 and /health to :3996
npm test                  # build:app + check:frontend-performance + typecheck:{app,convex,cloud,cloud-control-plane}
                          #   + test:{app,server,connector,cloud,cloud-control-plane}
```

Targeted checks:

```bash
npm run test:server                        # node --test test/*.test.mjs
node --test test/policy.test.mjs           # one server test file
node --test --test-name-pattern="claim"    # one server test by name
npm run test:app                           # vitest run (frontend, jsdom)
npx vitest run --config frontend/vitest.config.ts src/format.test.ts   # one frontend test file
npm run typecheck:app                      # tsc --noEmit on frontend/
npm run typecheck:convex                   # durable Store functions and schema
npm run test:connector                     # connector CLI/service lifecycle
npm run test:cloud                         # edge Worker/DO contract, runtime, resilience
npm run test:cloud-control-plane           # private Worker/Container boundary
npm run test:container                     # build and smoke the release Container image
npm run test:capacity                      # deterministic local qualification budget
npm run test:workflow                      # CI/release/qualification/performance workflow contracts
npm run test:staging-qualification         # hermetic tests for the staged-proof harness
npm run test:staging-release               # static/pure safety tests for manual deploy/rollback automation
npm run security:repo                      # fail-closed tracked-file/secret gate
npm run check:docs                         # deterministic maintained-doc relative-link gate
npm run pack:connector                     # pack and clean-install the npx package
```

Supporting scripts:

```bash
node scripts/mock-t3.mjs        # fake T3 Code instance for local dev
node scripts/simulate-device.mjs # register a fake controller device
npm run smoke:local             # HTTP smoke flow against the in-memory/file store
npm run smoke:convex            # same flow against a deployed Convex backend
npm run setup:t3                # guided T3 install/auth/tunnel/pairing wizard
npm run convex:dev              # convex dev (deploy convex/ functions)
```

There is no linter configured. `npm test` is the core repository gate. The credential-free GitHub
workflow also runs the repository-secret scan, maintained-documentation link gate, connector pack smoke, and release Container smoke in
separate jobs; capacity and staged/live qualification remain explicit evidence gates rather than
being folded into a single misleading green check.

## Architecture

### Request flow

`src/server.mjs` loads config → picks a store → calls `createApp()`. Everything routes through a single `handle(req, res)`
function in `src/app.mjs` (~8,300 lines): a long `if` chain matching `req.method` + `url.pathname` (exact strings) or
`url.pathname.match(/regex/u)` for parameterized routes. **New endpoints go in that chain** — order matters, static-file
and health routes are checked first. Handlers throw `HttpError` from `src/http.mjs`; the outer `try/catch` converts it to
a JSON error response.

### Four authentication realms

Every route belongs to exactly one, and they never mix:

| Realm | Credential | Helper | Rate limit helper |
|---|---|---|---|
| Platform user | Clerk session/JWT, or a legacy `Bearer` platform token | `authenticateUser()` | `enforceUserRead/Write` |
| Device | `x-device-id` + `x-device-secret` headers | `authenticateDevice()` | `enforceDevice{Heartbeat,Read,Write}` |
| Factory | `FACTORY_TOKEN` env secret | `authenticateFactory()` | `enforceFactoryWrite` |
| Connector | `Authorization: Connector <id>.<secret>` | `authenticateConnector()` | `enforceConnectorWrite` |

Connector rotation keeps the connector id stable. The user-realm
`POST /v1/connectors/:id/rotation-sessions` mints the canonical local command; connector-realm
`POST /v1/connectors/:id/rotate` combines the current credential with that single-use,
environment-scoped, `connector_rotation`-purpose code and stages a second hash. Enrollment and
rotation codes are not interchangeable. The long-running connector writes health/cursor state to
`connector-runtime.json`, never the credential document, so stale service persistence cannot erase
the rotation journal. The server stages the second hash
for at most ten minutes. Both hashes authenticate during that overlap, but the staged credential is
tagged with an unguessable rotation id. Consumption of its first socket ticket atomically promotes
it and invalidates every unconsumed old-generation ticket. Never split that commit into separate
mutations or let a credential-version integer substitute for the rotation id; doing so reintroduces
a replaced-staging race. Revocation clears both hashes.

The packaged connector stores its standing secret in an OS facility when one is available:
`com.next-coder.connector` generic-password items on macOS, Secret Service items with the same
service attribute on Linux, and generic Windows Credential Manager entries through the built-in
PowerShell/P/Invoke adapter. Secret values travel through subprocess stdin, never argv. State JSON
contains only the backend and an A/B slot pointer; rotation keeps the pending value in a separate
native item. Migration writes and verifies native storage before atomically removing plaintext.
Headless systems without a native facility retain the existing private-file representation, but an
enrollment already bound to a native backend fails closed if that backend becomes unavailable.
On macOS, send a hex-encoded `add-generic-password -X` command through `security -i` stdin.
Bare `-w` prompts through the controlling terminal and can store an empty value from a piped
process. Verify the native write by reading it back before committing the state pointer.

**The connector pins the T3 version it starts.** `DEFAULT_T3_VERSION` (`"0.1.5"`, in
`packages/connector/src/t3Process.mjs`) is what `npx --yes t3@<version> serve` launches; `connect
--t3-version` or `NEXT_CODER_T3_VERSION` may name one other **exact** version (a prerelease such as
`0.1.6-nightly.20261029` is allowed; `latest`, ranges and URLs fail with `T3_VERSION_INVALID`), and the
service installer captures an explicit choice at install time. The pin applies to the launch path and to
`auth pairing create` (same base directory, so it must be the same version) and is never consulted when
the connector reuses a T3 someone else started, which is judged by the protocol it advertises. The
contract moved inside 0.1.x (resume policy, subscribe opt-ins, default Claude slug, removed RPCs), so an
unpinned `npx t3` took whatever resolved that day. **An override is an unaudited T3**: only 0.1.1 and
0.1.5 were read, and changing the default means re-running the audit's extraction first. The pin makes
the launched version deterministic; it does not make 0.1.5 verified. `src/t3Compatibility.mjs` keeps
that distinction: `maximumTestedVersion` is 0.1.1 (run live), `maximumAuditedVersion` is 0.1.5 (read, never
run), and a version between them reports `review_required` worded as "read, never run". 0.0.33 to 0.1.0
were examined by no one and inherit "supported" from the ceiling.

**Intel Macs (`darwin-x64`) cannot run T3 >= 0.1.0 at all.** The `t3` launcher supports exactly
`darwin-arm64`, `linux-arm64`, `linux-x64`, `win32-arm64` and `win32-x64`; the connector mirrors that as
`T3_CLI_PLATFORMS` and refuses with `T3_PLATFORM_UNSUPPORTED` before touching ownership state. The only
T3 an Intel Mac can run from npm is the 0.0.x JavaScript line (protocol 1), reached through
`--no-start-t3` against a hand-started T3 plus `--t3-pairing-token` or `--t3-token-file`. That path was
blocked until 2026-10-30 by the `orchestration:write` pairing scope above; it is now unblocked in source,
unproven in practice (no 0.0.x run, no Intel hardware). The honest product statement is Apple Silicon,
x64/ARM64 Linux, x64/ARM64 Windows. The direct-agents path needs no T3 and is the answer for unsupported
hardware, not a substitute for the console's T3 features.

Connector-owned T3 process control is exact and platform-specific. POSIX uses a detached process
group. Windows never executes `npx.cmd` through a shell: it resolves the verified npm
`npx-cli.js`, launches it with the current `node.exe` and an argument array, fingerprints the
observed executable/command line/creation identity through a bounded encoded PowerShell/CIM query,
and stops only the reverified PID tree with `taskkill /PID ... /T`. A private starting journal is
promoted atomically to ownership metadata; an interruption before fingerprinting fails closed and
must never trigger a guessed kill or duplicate launch. Reused user-managed T3 processes are not
owned or stopped.

Provider model slugs do not establish provider availability. The connector hello and internal
catalogue sanitizer must preserve explicit bounded readiness, enabled/installed flags and auth
status while dropping credentials and private diagnostics. Missing or malformed health stays
unknown; a healthy local T3 provider must not become unavailable merely because its metadata was
stripped in transit. Keep a hello-to-owner-projection regression across both boundaries.

Managed connector welcome and heartbeat timers own process liveness until the connection settles.
A pending promise is not a keep-alive handle. Stop must prevent late ticket/welcome/message callbacks
from opening sockets, recreating timers, or dispatching local work; subprocess tests exercise the
actual Node event loop without a parent IPC handle masking early exit.

Connector Tailscale integration is diagnostic-only. `status` and `doctor` may execute only the
bounded, read-only `tailscale status --json` command (with the standard macOS app CLI fallback) and
must project a redacted state that excludes peers, users, Tailnet names, hostnames, and addresses.
Tailscale remains optional and operator-managed: the connector never installs it, runs `tailscale
up`, authenticates a node, or inspects or changes Serve or Funnel. Missing or disconnected
Tailscale adds static operator guidance but cannot make overall connector health fail by itself;
direct T3 reachability remains authoritative.

Auth mode comes from `AUTH_PROVIDER` (defaults to `clerk` if `CLERK_SECRET_KEY` is set, else `dev`). In Clerk mode
`POST /v1/users/dev` is hard-disabled; dev tokens only exist for tests and `DEMO_MODE=1`. `src/clerkAuth.mjs` adapts the
raw `node:http` request into a WHATWG `Request` for `@clerk/backend` and caches user profiles for 5 minutes.

The console pins Clerk's sign-in and sign-up return URLs to its current origin. The Clerk
instance's dashboard defaults may point at the parent-domain marketing site, so relying on those
defaults can send a successful OAuth flow away from the console. Keep deployment origins dynamic.
Selected-workspace loading uses `loadSnapshotRef` so capability/presence updates cannot change its
effect dependency and trigger another capabilities request. Key automatic reads to environment
identity/status changes, not the projection objects those reads update.

`authenticateUser()` takes an optional `url` argument, which enables `?token=` query-string auth for endpoints the
browser cannot send headers on (SSE). That path only applies in non-Clerk mode — in Clerk mode the same-origin session
cookie is used and the query token is ignored.

### Agent harnesses and models

**The T3 version matters in almost every paragraph below.** Unless a sentence names another version,
a T3 contract in this file was established against T3 Code 0.0.28/0.0.32 (orchestration protocol 1).
The owner's production T3 is 0.1.1 and the connector's pinned default is 0.1.5; both speak protocol 2,
which differs materially (no orchestration HTTP routes, no `activities[]`, five approval decisions).
[docs/t3-version-audit.md](docs/t3-version-audit.md) is the evidence-based comparison: a verdict per
assumption, bundle line citations, and the method for reading any version's server source. Read it
before trusting or extending a T3 claim here. Nothing in this repository has been observed against a
running 0.1.5; every 0.1.5 statement is "the shipped bundle says", not "the server does".

On T3 0.0.x (protocol 1, verified against a live 0.0.28), `GET /api/orchestration/snapshot` returns
**only** `{snapshotSequence, projects, threads, updatedAt}`; that route does not exist at 0.1.x, where
`orchestration.subscribeShell` is the equivalent (see "The T3 WebSocket API"). At neither version is
there a provider catalogue on the paired HTTP API — T3 publishes it to its own web UI over the
authenticated WebSocket (0.0.32 server spans: `upsertProviders`, `publishEnrichedSnapshot`; the
`server.getConfig` RPC still returns it at 0.1.5). So harnesses come from two places, merged in
`src/t3Harness.mjs`:

1. **Snapshot-derived** — instances/models referenced by `projects[].defaultModelSelection` and
   `threads[].modelSelection`. Shows what is *in use*, not what exists.
2. **Registered catalogue** — `scripts/setup-t3.mjs` runs on the T3 host, reads
   `<base-dir>/caches/<instanceId>.json`, and `PUT`s it to `/v1/t3/environments/:id/catalogue`.
   This is the authoritative list, stored on the environment as `providerCatalogue`.

`validateModelSelection()` only rejects when a catalogue is registered (`source === "catalogue"`).
Without one it returns null, because T3 provider instance ids are not restricted to built-ins and
rejecting against snapshot-derived data would block legitimate user-defined instances.

**Why this matters:** T3 accepts a dispatch and *then* has the provider reject an unknown model, so
a bad slug produced a command stuck at `dispatched` forever with no assistant reply. Thread launch
now validates before dispatch (422), and `extractSessionFailures()` surfaces `threads[].session.lastError`.

### The T3 WebSocket API

T3 v0.1.1 advertises orchestration protocol 2 in `/.well-known/t3/environment`. Its old
orchestration HTTP URLs return the web application, not snapshots. The 0.1.1 and 0.1.5 route tables
agree (below). The local connector negotiates
`orchestrationProtocol=2` on the ticket-authenticated socket and projects `subscribeShell` and
bounded `subscribeThread` snapshots through `packages/connector/src/t3v2.mjs`. Native v2 message
updates contain absolute text; only their streaming suffix becomes a gateway delta. Run IDs replace
legacy active-turn IDs. Permission modes are set on the thread before `message.dispatch`, and local
pairing requests `orchestration:read orchestration:operate terminal:operate` (`T3_PAIRING_SCOPES`).
Reconnects request authoritative snapshots; native v2 historical pagination is not advertised by this
adapter. On 2026-10-22 an isolated live v0.1.1 server returned actual Codex replies through both
snapshot and streaming paths. This proves the local adapter on 0.1.1, separately from cloud enrollment
and hardware, and says nothing about 0.1.5.

**The pairing scope was wrong for protocol 1 until 2026-10-30.** The connector's protocol-1 exchange
requested `orchestration:write`, which is not a T3 scope at any version: 0.0.32's `token` handler
answers an unrecognised scope with `invalid_scope` and rejects the whole exchange (0.0.32
`src/auth/http.ts:261-277`), and 0.1.x silently drops it (`bundle-0.1.5.js:387157`), leaving a token
without `operate`. The real scopes are `orchestration:read`, `orchestration:operate` and
`terminal:operate` (0.0.32 `packages/contracts/src/auth.ts:76-94`; `bundle-0.1.5.js:29303`), and
`operate` is what guards dispatch at every version. That fix is read from sources and covered by a
request-shape test; no protocol-1 pairing against a running 0.0.x has been observed.

**Protocol selection follows what the server advertises, never its version string.**
`orchestrationProtocolVersion` in `/.well-known/t3/environment` is optional and **an absent field
means 1** (`bundle-0.1.5.js:140431`). The connector (`fetchEnvironmentInfo`) and the direct transport
(`negotiateOrchestrationProtocol` in `src/t3Ws.mjs`, cached per transport instance for five minutes)
accept 1 or 2 and fail closed with `T3_PROTOCOL_UNSUPPORTED` for anything else. Protocol 1 (T3 0.0.x)
keeps the HTTP routes `GET /api/orchestration/snapshot`, `GET /api/orchestration/threads/:id` and
`POST /api/orchestration/dispatch`. **At 0.1.x the snapshot and dispatch routes do not exist**: the
0.1.5 orchestration HTTP table is exactly `shell`, `threads/:threadId`, `threads/:threadId/transcript`,
`/bounded` and `/history` (`bundle-0.1.5.js:42414-42437`; 0.1.1 `bundle-0.1.1.js:37605-37630`), and the
surviving `threads/:threadId` returns a different document: no `activities`, and `turnLimit` has no
meaning. Everything moves to the WebSocket (`subscribeShell`, `subscribeThread`, `dispatchCommand`), and
`/ws` answers **426 `orchestration_protocol_incompatible`** to any client that does not put
`orchestrationProtocol=2` on the upgrade URL, before it authenticates (`bundle-0.1.5.js:406750-406752`,
`408438-408442`; 0.1.1 `:394726`). The direct transport (`src/t3Transport.mjs`, `src/t3Client.mjs`)
selects per call and uses `src/t3Protocol2.mjs` (see Conventions for why that file is a copy). Before
that landed the direct transport could not work against any 0.1.x server. Unproven: its tests use a fake
T3 and captured fixtures, and no live run of the direct protocol-2 path is recorded.

On protocol 1 the orchestration HTTP API only exposes projects and threads. Everything else — the
provider catalogue, terminals, settings — is served over an authenticated WebSocket speaking Effect's
RPC protocol (on protocol 2 orchestration itself moves there too). `src/t3Ws.mjs` implements it
(reverse-engineered against T3 Code 0.0.28, verified live; the framing below was re-read, not re-run, in
the 0.1.1 and 0.1.5 bundles, which carry Effect 4.0.5 and the same message tags):

```
POST /api/auth/websocket-ticket   ->  { ticket }
ws://host/ws?wsTicket=...                      (0.1.x: &orchestrationProtocol=2 is mandatory)
client -> {"_tag":"Request","id","tag","payload","headers":[]}
server -> {"_tag":"Exit","requestId","exit":{"_tag":"Success","value"}}
          {"_tag":"Chunk","requestId","values":[…]}   // must be Ack'd or the stream stalls
          {"_tag":"Defect","defect":"Unknown request tag: …"}   // see the correction below
```

The `Defect` line is imprecise at every version: an unknown *method* tag is answered per request as an
`Exit` carrying a die cause (`sendRequestDefect`, `bundle-0.1.5.js:185881`), and only an unknown
message `_tag` produces the top-level `Defect` (`:185553`). `callT3Rpc` treats any non-`Success` `Exit`
as `T3_RPC_FAILED`, so a method removed by a newer T3 surfaces as a failure, not a defect. Examples of
tags that differ by version: `server.getSettings` exists at 0.0.32 and 0.1.1 and is gone at 0.1.5
(nothing here calls it; the constant was deleted from the connector). At 0.1.5 the ticket route also
accepts a `/:use` suffix (`rpc | media`); the un-suffixed `POST /api/auth/websocket-ticket` still issues
an audience-less ticket that `/ws` accepts (`bundle-0.1.5.js:29459`, `145559-145565`).

`tag` values are T3's `WS_METHODS` (`server.getConfig`, `terminal.open`, `terminal.write`,
`orchestration.dispatchCommand`, …). `server.getConfig` returns `providers` — the authoritative
harness catalogue, which is why `catalogueSource` can now be `"live"`.

If T3 changes this protocol, its own contract is readable, but how depends on the version. **0.0.x**:
`/opt/homebrew/lib/node_modules/t3/dist/bin.mjs.map` ships `sourcesContent` (including
`packages/contracts/src/rpc.ts`); that npm package is 0.0.32. **0.1.x**: the npm `t3` package is now a
launcher whose `dist/bin.mjs` is 101 bytes and there is no source map. The 160 MB `t3` executable it
downloads to `~/.t3/runtime/versions/<version>/` embeds the server's whole bundle as one plain,
unminified, comment-bearing text blob, and [docs/t3-version-audit.md](docs/t3-version-audit.md) section 5
extracts it with a short script (its section 1 lists SHA-256 hashes, and the extraction reproduces them
for 0.1.1 and 0.1.5). Cite such lines as `bundle-<version>.js:N` and name the version: line numbers move
every release, and the bundler hoists declarations, so grep the identifier rather than trusting the
file-split markers. Reading never requires running the binary, and `t3 serve` opens ports and writes
under `~/.t3`; do not run it to "see what it says".

### The live thread stream

`orchestration.subscribeThread` was a string constant in `src/t3Ws.mjs` that nothing called; the
console and the device learned what an agent had done by refetching a snapshot every five seconds.
`openT3ThreadStream()` holds a real subscription and `src/threadStream.mjs` fans it out over the
existing SSE broker as `t3.thread.snapshot`, `t3.thread.event` and `t3.thread.status`.

It is deliberately not built on `callT3Rpc`, which collects chunks and resolves once. Three things
make a subscription a different lifecycle:

- **Every `Chunk` must be `Ack`ed.** Not folklore — `effect/dist/unstable/rpc/RpcServer.js:271-291`
  (the 0.0.32 path; 0.1.x bundles Effect 4.0.5 at `bundle-0.1.5.js:185685-185706`, same logic) does
  `latch.closeUnsafe(); write(Chunk); await latch` per streaming request, and only an inbound
  `Ack` opens it. Miss one and the stream goes quiet forever while looking healthy. Closing sends
  `Interrupt` first, or the server fiber stays parked on a latch nobody will open.
- **The resume cursor is the event's global `sequence`** (0.0.32 `EventBaseFields`,
  packages/contracts/src/orchestration.ts:1257-1267; at 0.1.x the high-water mark is
  `latestAgentSequence`, `MAX(sequence)` over the thread's event stream, `bundle-0.1.5.js:64620-64627`),
  *not* the optional per-activity `sequence` at 0.0.32 :323, which only orders activities inside a turn.
  A reconnect passes it as `afterSequence`; anything at or below the cursor is dropped. At 0.0.32 that
  overlap is by design because T3 attaches the live subscription before draining the replay
  (0.0.32 src/ws.ts:1300-1306). At 0.1.x T3 dedupes server-side (`withLiveDedupe`) and also *coalesces*
  repeated `*.updated` events in a replay, so a replay can omit intermediate message states; the 0.1.x
  attach-then-drain ordering was not traced (audit S4). The client-side dedup is what makes either safe.
- **T3 answers an unfillable gap with a snapshot, not an error — but the bound is per version.** At
  0.0.x, past `THREAD_RESUME_MAX_GAP` = 1000 (0.0.32 src/ws.ts:301-307) or with a cursor ahead of its
  head. At 0.1.x **that constant no longer exists**: a snapshot answers a cursor ahead of the head, more
  than **128** events, more than **1 MiB** of raw payload (`THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES =
  1048576`), or a recreated thread (`bundle-0.1.5.js:407152-407176`, `decideThreadResume` `:370513`;
  identical in 0.1.1 at `bundle-0.1.1.js:395124-395139`). 1000 survives only as `SHELL_RESUME_MAX_GAP` on
  the shell stream, which this repository does not resume. `T3_THREAD_RESUME_LIMITS` in `src/t3Ws.mjs` is
  the single statement of both. Either way T3 abandons the replay and sends a fresh thread snapshot,
  because a truncated replay would drop events silently. The gateway publishes that as `reset: true,
  gap: true`: nothing is lost — the snapshot is the thread in full — but the intermediate history is,
  and a client must replace rather than append. A 0.1.x gap opens after far less absence than a 0.0.x
  one (129 events, one long reply).
- **Behind a connector, or on the direct transport, protocol 2 is never resumed.** The connector's
  protocol-2 `openThreadStream()` discards the cursor (`afterSequence: undefined`) and the direct
  transport passes `resumeProtocol2: false`, because a replay arrives with no snapshot in front of it
  and the projection cannot rebuild a thread from one. So every protocol-2 reconnect is a snapshot, and
  `gap: true` there means "the history was not delivered", not "T3 could not fill it".

Subscriptions are **demand-driven leases**, the same discipline as the snapshot poller one level
finer: `POST|DELETE /v1/t3/environments/:id/threads/:threadId/watch` registers/renews, a device
polling `/v1/device/thread-output` renews its own, and a lease that stops being renewed drops the
socket on the next tick. Watches are in-memory on purpose — the same category of fact as the
poller's active-user set — so no store method was added. Constructed in `createApp()`, **started
only from `server.mjs`**, with `runOnce()` that tests drive.

On protocol 1, `thread.message-sent` with `streaming: true` carries a **delta**, not the whole message
(0.0.32's own projector appends it, src/orchestration/projector.ts:497-515). Treating a delta as the
full text shows the last few tokens of every reply. Protocol 2 sends absolute text with a `streaming`
flag; `t3v2.mjs` converts the growth into the same suffix delta so everything downstream sees one
shape, and a message update that does not extend the text already held cannot be a suffix, so the stream
is closed with `T3_STREAM_RESET_REQUIRED` and the reconnect takes a fresh snapshot. Not re-verified
live at 0.1.5.

### One command, one decision

Two things now close the gap between `dispatched` and "the agent replied": the snapshot poller
(polled evidence) and the thread stream (live evidence). The store has no compare-and-set, so
"read status, then update" is a read-modify-write with an await in the middle. `src/commandArbiter.mjs`
is the single arbiter both go through — same `reconcileCommandStatus()`, same "evidence newer than
the dispatch" guard, but a command already decided or being written is never decided again.
`command.reconciled` carries `source: "stream" | "snapshot"` naming who got there first.

The poller was deliberately left polling: it also serves environment health, the compressed device
screen and thread titles, none of which a thread subscription covers. It is now the backstop for
threads nobody is watching rather than a second opinion on the ones that are.

### Durable agent request envelope

Mutating agent requests are claimed before policy evaluation or T3 dispatch. Product clients send a
URL-safe `clientRequestId` on `/v1/intents`, `/v1/device/intents`, saved-action/macro runs, first
project launch, and device thread creation. The gateway scopes that id to the user, actor realm/id,
and operation, and stores only a canonical SHA-256 request fingerprint—never prompt, transcript,
path, attachment content, or provider output. Same id plus same fingerprint replays the original
command reference; the same id with different content is `409 idempotency_conflict`; a concurrent
retry sees `processing` and is not dispatched.

`commandRequests` is durable in memory/file/Convex parity. Receipts retain the initial command
status, command id, and HTTP status for 24 hours, with at most 1,000 per owner. Oldest terminal rows
evict first; 1,000 simultaneously processing rows fail closed with `503` instead of sacrificing an
in-flight guard. `GET /v1/requests/:clientRequestId` and its device-realm counterpart expose the
privacy-minimal receipt plus the current command. The command remains authoritative as the arbiter
moves it from `dispatched` to a terminal result.

The file adapter's claim and settlement methods are write barriers: the awaited claim returns only
after its atomic state-file rename, and settlement waits for the command reference and receipt to be
persisted before the HTTP response may clear a client journal. Convex provides the equivalent
claim/settle atomicity in mutations; an indexed exact-retry lookup avoids the bounded owner scan on
the hot replay path.

Browser clients journal only a digest-to-id mapping in local storage until an HTTP response arrives.
Firmware journals one uncertain id plus a non-content fingerprint in NVS. Connector request and
idempotency ids are stable digests derived from the client id and dispatch stage, so Container/router
retries preserve the edge Durable Object's existing replay contract without exposing a caller id.
Missing ids are still accepted with a server-generated compatibility id, but only updated product
clients provide retry protection across a client restart.

### Two kinds of approval

They are different questions and the code keeps them apart everywhere.

A **gateway approval** is `evaluateIntentPolicy()` refusing to dispatch something the owner asked
for. It is a `command` row with status `approval_required`, answered at
`POST /v1/commands/:id/approve|reject`. Nothing has left the gateway.

A **provider approval** is T3 stopping mid-turn because the agent wants permission. It lives in T3
as a live provider callback, expires with the session, and the gateway neither owns nor can extend
it. `src/providerApprovals.mjs` carries the contract with file:line citations — into 0.0.32's own
sources for protocol 1, and, in its "T3 0.1.x SUPERSEDES" block, into the extracted 0.1.1 and 0.1.5
bundles. The facts that matter, by version:

- **The decision set is four at 0.0.x and FIVE at 0.1.x.** 0.0.32: `accept` | `acceptForSession` |
  `decline` | `cancel` (`ProviderApprovalDecision`, 0.0.32 orchestration.ts:134-139). 0.1.1 and 0.1.5
  add **`acceptAlways`** (`bundle-0.1.5.js:36665-36671`; 0.1.1 `:31403`). The two grants are not
  synonyms and **not uniform across providers**, which is why the gateway never assumes: on Claude v2
  `permissionResultFromDecision` (`bundle-0.1.5.js:274105-274123`) allows only `accept` and
  `acceptForSession` (the latter also returns `updatedPermissions` scoped to the session, i.e. a rule
  rather than an answer) and **everything else, `acceptAlways` included, falls through to a deny** —
  sending it silently refuses what the owner meant to allow. Codex v2 folds `acceptAlways` into
  `acceptForSession` for commands and file changes (`:307972-307973`, `:308021-308022`) and offers a real
  "forever" only for an MCP elicitation that says so (`:304372`); the generic ACP adapter treats it as a
  rejection (`:191154-191157`); OpenCode treats the two as the same act (`:336263-336269`); Muse splits
  them by scope (`:345629`). It follows that "`acceptForSession` is allow-always" is only a 0.0.x
  statement. `buildT3Command()` used to fold everything to accept/decline, which made two of the four
  (then) unreachable.
- **Approval requests carry their own `options[]`** at 0.1.x: `[{decision, label, warning?}]` naming which
  decisions that provider accepts (`bundle-0.1.5.js:36673-36677`, turn item `:38519`; present in 0.1.1,
  but Claude 0.1.1 never forwards its narrowing). The gateway narrows against a request's own list
  (`offeredDecisions`) and, when a request states none, against T3's default four — which omits
  `acceptAlways`, matching T3's own UI. This guard is the gateway's alone: T3's
  `dispatchRuntimeRequestRespond` checks only that the request exists, is `pending` and is not
  `not_resumable` (`bundle-0.1.5.js:366820-366860`) and does not enforce `options`.
- **There are five request kinds at 0.1.x, not three** (`ProviderRequestKind`, `bundle-0.1.5.js:36658-36664`):
  `command`, `file-read`, `file-change`, plus `mcp-elicitation` (Codex) and `permission` (generic bucket,
  e.g. Muse). 0.0.32 had the first three. Requests also carry `fullAccessOverride` (new in 0.1.5),
  `reason`, `appName` and a `responseCapability` (`live | message | not_resumable`) that the adapter
  ignores; what the server does on answering a `message`-only or `not_resumable` request was not traced
  (audit A6).
- **Pending approvals are NOT in the orchestration snapshot** (thread bodies empty). At protocol 1 they
  are derived from `threads[].activities[]` — `approval.requested` opens, `approval.resolved` closes,
  and `provider.approval.respond.failed` closes it **only** when the detail marks the request
  stale/unknown. That last clause is T3's own rule (`hasOpenBlockingRequest` in its decider) and
  omitting it leaves a card on screen for a request nothing is waiting on. **Protocol 2 has no
  `activities[]` at all**: pending state is `runtimeRequests[].status` = `pending | resolved | expired |
  cancelled` (`bundle-0.1.5.js:38103`), and `t3v2.mjs` re-synthesises legacy approval activities from it
  (any status other than `pending` or `resolved` becomes stale), so the stale-phrase matching above is
  moot on that path.
- **T3 0.0.32 accepts a response to a dead request and fails later, asynchronously.** So the gateway
  verifies the approval is still open before it dispatches, rather than discovering the problem as
  an error activity nobody reads. At 0.1.x the server itself refuses a non-`pending` request
  (`bundle-0.1.5.js:366820-366830`), but the gateway's check stays: it is the only thing that knows
  whether the owner already answered.

`answerProviderApproval()` in `app.mjs` claims the request id in the store *before* dispatching
(`claimProviderApprovalDecision`, all three store backends). Same decision twice is a 200 duplicate
with one dispatch; a different decision is a 409, because the first answer has already left. A
failed dispatch releases the claim — otherwise one second of T3 downtime would lock the approval
out of reach for the rest of the session.

Policy: `approval_response_persistent` (`acceptForSession`) is its own capability, held by
`power-controller` (the console) and not by `next-coder`. A standing grant made from a 240x320 panel,
where the request detail is clipped, is not the same act as making it in the console. `acceptAlways`
is a *third* capability, `approval_response_always`, for the same reason one level up: it is held by
`power-controller` only, and the policy engine additionally requires the actor to be the signed-in
owner and refuses a controller outright whatever its profile says (`baseline.approval-accept-always`,
risk high). Under a `maxAutoRisk` ceiling of medium or lower either escalates to a gateway
confirmation instead of dispatching. `read-only` **sees** pending approvals — listing is a read — and
is offered no decision at all.

### Terminal input (Phase 9 stage 3)

`terminal_input` is a capability **no built-in profile grants** — it needs a custom profile *and* an
environment paired with the `terminal:operate` scope, which the gateway's standard pairing never requests
(the connector's own token exchange always does, so a connector-paired environment holds the scope and
the custom profile remains the gate). It is
also confirm-always: `baseline.terminal-input` returns `requiresApproval` regardless of which
dimension allowed it, because a raw terminal write cannot be pattern-screened. Dispatch goes over
the socket (`terminal.open` then `terminal.write`), not orchestration dispatch — both in
`submitIntent` and in `approveCommand`.

`ALL_KNOWN_CAPABILITIES` in `policy.mjs` is derived from `DEVICE_CAPABILITIES`; it was previously a
hardcoded copy, which silently un-gated any newly added capability.

### Command reconciliation

`dispatched` means "T3 accepted the command", not "the agent replied". The poller closes that gap:
each reachable poll calls `extractThreadOutcomes()` and `reconcileCommandStatus()`, flipping stuck
`dispatched` commands to `failed` or `completed` and emitting a `command.reconciled` SSE event.

The discriminators matter and were verified against real T3 0.0.x state (they were not re-derived for
the protocol-2 projection, which builds status from runs in `t3v2.mjs`) — **`session.status` reads
`"stopped"` for success *and* failure**, so it proves nothing on its own:

| | failed turn | successful turn |
|---|---|---|
| `session.lastError` | populated | `null` |
| assistant message | none | present |
| turn `state` (T3 sqlite) | `error` | `completed` |

Reconciliation only acts on evidence *newer* than the command's own dispatch, so a reply or failure
from an earlier turn on the same thread is never misattributed. Terminal commands are never
re-decided, and a streaming assistant message does not yet count as a reply.

Real captured data lives in `test/fixtures/` (a live snapshot and the five provider caches); tests
run against it rather than invented shapes.

### Agent verbs (what the orb animates)

The controller renders nine orb animations. Five were driven by the words this gateway already
speaks; `searching` / `solving` / `weaving` / `shaping` are now derived in `src/agentVerb.mjs` and
published on the **selected** row's `status` in `GET /v1/device/threads` — the one field the orb
reads (`presentationForState()` in the Hosyond `ui.cpp`). The other six words are never replaced;
a verb only ever refines `running`.

**On protocol 2 this whole feature has no input, in production today.** Everything below describes
reading `thread.activities[]` over `GET /api/orchestration/threads/:threadId?turnLimit=1`. Protocol 2
produces no `activities[]` (it replaces them with `nodes[]`, `subagents[]` and typed `turnItems[]`), that
route no longer returns them, and the connector's `v2Thread()` synthesises only approval and user-input
activities. So against the owner's 0.1.1 an agent never leaves `running`, and the orb never shows
`searching` / `solving` / `weaving` / `shaping`. This is an inference from reading the adapter and the
audit (W1, W2), not a run. The code is kept because it is correct for protocol 1 and because a
classifier over protocol 2's typed turn items would be new work, not a patch to this one.

**The snapshot cannot answer this and never could** (on protocol 1). T3's own handler comment
(`src/orchestration/http.ts` in the 0.0.32 source map) says `GET /api/orchestration/snapshot`
serves "the lightweight command read model (thread bodies empty)" because hydrating every message
and activity "has OOM-killed servers" — which is why `test/fixtures/t3-snapshot.json` carries no
`messages` and no `activities` on any thread. The work log lives on
`GET /api/orchestration/threads/:threadId`, contract endpoint `threadSnapshot`, with an optional
`?turnLimit=` window. `fetchT3ThreadDetail()` calls it with `turnLimit: 1`, for the selected thread
only, and only while that thread is running.

The evidence is `thread.activities[]` (`OrchestrationThreadActivity`), whose tool rows
`ProviderRuntimeIngestion.ts` emits as `kind: tool.started|tool.updated|tool.completed` with
`payload.itemType` from `TOOL_LIFECYCLE_ITEM_TYPES` and a `payload.data` that
`ActivityPayloadProjection.ts` slims to `{item, command, files[].path, toolCallId, kind, rawOutput}`
— so `data.rawInput` is **not** on the wire and nothing may read it.
`classifyToolActivity()` is a port of T3's own `classifyToolAction`
(`packages/shared/src/toolActivity.ts`), so the gateway and the T3 UI cannot disagree about what a
tool call was.

Three refusals are the point: a settled turn yields no verb, an activity stamped with a different
`turnId` never speaks for the live one, and an unclassifiable tool (`mcp_tool_call`,
`dynamic_tool_call` with no `data.kind`) stays at `running`. A single-file edit is likewise not
`weaving`, which means "coordinated edits across multiple files" and needs two distinct paths.
T3 publishes no "the model is generating" activity, so a finished `tool.completed` with nothing
after it still reports that tool — a known, uncloseable gap.

`orbModeForAgentState()` (`ThinkingOrb.cpp`) case-folds the word it is handed, because
`GatewayOperate.cpp` upper-cases `ThreadOption.status` before the orb table reads it; an earlier
revision compared lowercase literals and silently rendered every verb as the idle ring.

### Media storage and processing

`storagePath` on a media record is a **local path or an S3 object key** depending on
`MEDIA_STORAGE_PROVIDER`; the record shape and Convex schema are identical either way, so switching
backends needs no migration. `readStoredMedia`/`deleteStoredMedia` take `config` as a second
argument — omit it and they always hit local disk, which is a silent bug under S3.

`src/s3.mjs` speaks SigV4 by hand (no dependency). Leave `S3_FORCE_PATH_STYLE` unset unless you
mean it: unset auto-detects (MinIO/R2 need path style, AWS does not), and coercing it to `false`
breaks non-AWS endpoints.

Two pluggable media processors, both `disabled` | `mock` | real provider, but no longer the same
shape. `describeStoredImage` (`src/vision.mjs`) still runs inside the request; transcription does
not. Images carry `visionStatus`/`descriptionSource`; audio carries
`transcriptionStatus`/`transcriptSource`. A vision description is user content — it is redacted from
support bundles alongside every transcript version.

### Media names are derived, never stored

Firmware calls every recording `controller.wav`, so a library of controller captures was a column of
identical rows. `src/mediaNaming.mjs` builds a `displayName` on read instead —
`Hosyond Touch screen · Verify Workspace · 24 Aug 19:32` — from the device label, the thread the
capture was pinned to, and its creation time, plus a structured `origin`. `nameMediaRecords()` in
`app.mjs` attaches both to every owner-facing media response.

**Derived, not stored, for the same reason the transcript diff is** (`withTranscriptChange`): a
stored name goes stale the moment a device is relabelled or a thread retitled, and it would need a
migration to reach clips a user already has. `originalName` is never overwritten — it is what the
client uploaded and what the agent still sees as the attachment filename.

The destination comes from the media **job** (`job.threadId`, pinned at enqueue), falling back to
`device.config.threadId`; the current binding is where the device points *now*, not where the
capture was going. Thread titles exist only in T3, so they are remembered from snapshots the gateway
already fetches (`readT3Snapshot()`, the poller) rather than fetched per listing, with one
short-timeout refresh for a stale environment and failures cached like successes. Every segment is
optional and every degenerate case has a defined answer: no label gives `Controller 7d2c9f`, no
thread drops the segment, an unresolvable title gives `Thread 4f2a1c`, a console upload gives
`Console · diagram.png · ...`. The frontend never composes its own name — `mediaLabel()` in
`features/MediaCapture.tsx` is the single reader, so the library, the composer picker and an
attachment chip cannot disagree. Support diagnostics deliberately keep the **undecorated** records: a
thread title would be new user content in the bundle.

### Transcription is a durable job

A 30-second ASR call held a connection open and died with the process, leaving the media stuck at
`processing` forever. So `POST /v1/media/:id/transcribe` now answers **202 with a job row** and
`src/mediaJobs.mjs` drives it — the same shape as the snapshot poller: constructed in `createApp()`,
**started only from `server.mjs`**, with a `runOnce()` tests call directly.

`src/transcription.mjs` is the provider interface (`transcribe()` → raw text plus metadata, or a
`TranscriptionError`). Its `retryable` flag is the whole point: a 429 or a timeout goes back to
`queued` and costs one attempt, while a missing API key fails terminally instead of burning three
identical attempts.

`failureCause` is the second axis on that error, and it is **declared at the throw site, never
parsed out of the message**: `configuration` (no provider, missing credential, sidecar that was not
running, English-only checkpoint pointed at French), `input` (container nothing decodes, clip over
the length limit, silence), `provider` (a 500, a timeout, storage having a bad minute) and
`unknown`. It is recorded on *every* failure, not only terminal ones — a retryable failure that
later burns the last attempt is failed inside `claimMediaJobs`, which has no error to look at and
inherits the cause left on the row.

Stages: `queued → transcribing → normalizing → review_required|ready → dispatching → dispatched`,
with `failed` terminal. `dispatched` and `failed` are never re-claimed — that is what stops a
restart from dispatching the same transcript twice.

**The one exception is an owner asking.** `POST /v1/media/jobs/retry-configuration` (owner realm)
requeues failed jobs whose recorded cause is `configuration`, and nothing else; it refuses with 409
when no provider is usable *now*, resets `attempts` to zero (the budget was spent on a fault that no
longer exists), and reports every skipped job with its cause. There is deliberately no boot hook and
no poller sweep: a terminal stage promises nothing happens on its own, and only a person may break
that promise. `store.requeueMediaJob()` also forces `reviewRequired` on, which is not a parameter —
see the safety rule below.

Two subtleties worth keeping:

- **`claimMediaJobs` recomputes the stage from stored evidence** (`resumeStageFor`), not from where
  the job crashed. A worker that died after recording the raw transcript does not pay for the ASR
  call again. A job whose `attempts` are spent is failed *inside the claim* rather than handed out,
  or it would be rediscovered on every tick forever.
- **The transcript is versions, not a field.** `rawTranscript` (verbatim ASR, whitespace included)
  and `normalizedTranscript` are write-once — `updateMediaJob` silently ignores a second write.
  Only `userEditedTranscript` stays writable, and the last version present wins. `review_required`
  is not runnable: it waits on a person and must not hold a lease.

The audio is never consumed. A transcript is derived; the upload has to stay playable.

**Normalisation may move spacing, punctuation and case — never letters.** `describeTranscriptChange()`
enforces that by comparing the two versions with everything but letters and digits stripped out; if
they differ, the job parks at `review_required` whatever `TRANSCRIPTION_REVIEW_REQUIRED` says. A
"correction" that changes someone's command has to be shown as a diff, not dispatched on their
behalf. The diff is computed on read (`withTranscriptChange` in `app.mjs`) rather than stored, so it
cannot go stale against the versions it describes.

### The device voice loop

`POST /v1/device/media` **enqueues transcription itself** — a controller records, uploads, and is
done, so nothing else was ever going to ask. Before this, device audio was stored and never
transcribed; the only caller of the transcriber was the owner-facing endpoint.

The device gets back one id and polls one device-realm route, `GET /v1/device/media/jobs/:id`, which
returns the projection in `src/deviceAudio.mjs` — six milestones (`recorded`, `uploading`,
`transcribing`, `review`, `ready`, `sent`, `failed`) plus `done`/`ok`/`transcript`/`error` and
nothing else. Stages, leases, attempt counts, provider names and timings are worker bookkeeping a
few square centimetres of screen cannot render, and they stay on `/v1/media/jobs/:id`. The route is
scoped to `job.deviceId`, not merely to the owner: two controllers on one account are two
microphones in two rooms, and the transcript is in the response. The same projection builds the
`media.job` SSE payload, so a console that listens and a device that polls cannot disagree.

**Auto-send is three-valued, and defaults on for a microphone.** `device.voiceAutoSend.ownerChoice`
is `true`, `false`, or `null` for "never said"; `enabled` is derived — an explicit choice always
wins, and only in its absence does the hardware decide, from `status.features` including
`microphone` (evidence the firmware sent, never the board's datasheet). A controller whose whole
purpose is to be spoken to should work when it is spoken to; a board that never claimed a microphone
gets nothing. The third state is load-bearing: with a plain boolean, an owner's "off" is
indistinguishable from silence and the default would switch it back on at the next heartbeat,
restart or re-claim. `PUT /v1/devices/:id/voice-auto-send` (owner realm) takes `true`, `false`, or
`null` to withdraw the decision; `enabledBy`/`enabledAt` stay null for a default, because a default
has nobody behind it and must not be recorded as a grant somebody signed. Still per device, never
per account: a device claimed later earns its own answer from its own hardware.

**A capture requeued by the configuration-retry path always waits for a person**, whatever the
grant says. The grant means "send what I say as I say it" — it was never consent for what was said
last Tuesday, and a bulk retry could otherwise dispatch a batch of hours-old transcripts into a
coding agent as instructions. The rule lives in `requeueMediaJob()` (forced `reviewRequired`) and is
enforced again in the worker, which parks a `ready`/`dispatching` job that must be reviewed and has
no `userEditedTranscript` — necessary because `resumeStageFor()` sends a job already holding both
transcript versions straight to `dispatching`, past the normalizing stage where review is normally
decided.

**The grant, the device and the policy are read at dispatch, never at enqueue.** A capture can sit
through a retry budget while the owner tightens a profile or revokes the grant, and the newer rule
has to win; `dispatchVoiceTranscript()` in `app.mjs` re-reads all three and then goes through the
ordinary `submitIntent()` path. The worker itself knows nothing about policy — the hook is injected
into `createMediaJobRunner()`.

Transcription succeeding and the send being refused are independent, which is why the outcome lives
on its own fields (`dispatchStatus`, `dispatchError`, `commandId`, `autoSend`) instead of
`lastError`/`failureKind`. A blocked send still reaches stage `dispatched`, because the transcript
is on the media record and the owner has something to look at; reporting it as `ready` would claim
the words are waiting when the gateway has already declined to act on them.

### The parakeet adapter

`TRANSCRIPTION_PROVIDER=parakeet` is its own adapter in `src/transcription.mjs`, not the OpenAI
branch with a different URL. It talks HTTP to a local sidecar running `nvidia/parakeet-tdt-0.6b-v2`:
the gateway never imports Python and never blocks its event loop on inference. The sidecar is
`scripts/parakeet-sidecar.py` and its weights come from `scripts/fetch-parakeet-model.mjs`
(`npm run parakeet:fetch` then `npm run parakeet:sidecar`). It runs the ONNX export of the
checkpoint under onnxruntime rather than the `.nemo` archive under nemo_toolkit — same weights,
without PyTorch/Lightning/Hydra — and nothing about the ONNX choice is visible to the gateway,
which only ever sees the HTTP contract in `docs/api.md`. **Leaving `TRANSCRIPTION_PROVIDER` unset
means `disabled`, and a disabled provider fails every job terminally**: the voice pipeline is inert
until it names a real provider, which is not obvious from the media UI. CPU is the supported
default, which is why `PARAKEET_TIMEOUT_MS` is minutes and `PARAKEET_CONCURRENCY` is 1 — the gate in
`createConcurrencyGate()` hands a released slot straight to the next waiter, because decrementing and
re-acquiring would let a fresh caller overtake the queue.

Three things it refuses before spending an inference, all terminal because no retry changes them:
a container outside `PARAKEET_ACCEPTED_CONTENT_TYPES` (browser WebM/Opus and MP4/AAC and controller
WAV are in; anything else fails naming the list, rather than becoming an opaque 4xx from a Python
traceback); a WAV whose own header says it is longer than `PARAKEET_MAX_CLIP_SECONDS`; and a
language the configured checkpoint cannot speak — v2 is English, and pointing it at French produces
confident nonsense rather than French, so that is a configuration error and is reported as one.

`timings` on a finished job carries `queueWaitMs`, `gateWaitMs`, `decodeMs`, `inferenceMs`,
`providerMs`, `normalizeMs` and `totalMs`, plus `realtimeFactor` (compute seconds per audio second)
when the sidecar reports the clip length — the number that decides whether a GPU is worth adding.

### Three things can block a turn, and they are not the same question

Two of the three predate this note; the third is `src/userInput.mjs`, and collapsing any two would
be a correctness bug.

| | what it is | answered at | answer |
|---|---|---|---|
| gateway hold | `evaluateIntentPolicy()` refused to dispatch something the owner asked for | `/v1/commands/:id/approve\|reject` | approve / reject |
| provider approval | the agent stopped mid-turn asking permission (`src/providerApprovals.mjs`) | `.../threads/:id/approvals/:requestId` | T3's `ProviderApprovalDecision` values (four at 0.0.x, five at 0.1.x), narrowed to what the request offers |
| agent question | the agent needs a **value** — "which database?" (`src/userInput.mjs`) | `.../threads/:id/user-input/:requestId` | a per-question answer set |

T3 separates the last two in its own code: `ProviderRuntimeIngestion.ts:372` and `:403` return `[]`
for a `tool_user_input` request, so it produces no approval activity at all and travels on
`user-input.requested` / `user-input.resolved` (`:503-537`) instead, with `tone: "info"` rather than
`"approval"`. Its stale-request phrases are four *different* strings from the approval ones
(`decider.ts:49-52`) — reusing the approval matcher would never match and every abandoned question
would read as pending forever.

The citations in this subsection are 0.0.32's. At 0.1.x the separation holds (a runtime request of
`kind: "user_input"`, its own `user_input_request` turn item, its own `thread.user-input.dismiss`
command; `bundle-0.1.5.js:38103`, `:38476`), but questions gained `allowCustomAnswer`,
`initialAnswer`, `required` and per-option `value` and `preview` (`:38226-38240`), and **which token
the server accepts as the answer — `label` or `value` — and whether `allowCustomAnswer: false` rejects
free text were not determined** (audit U2). `src/userInput.mjs` validates against `label` only.

**Question shapes come from the data, not a flag.** `options` is a required array that may be empty
(`providerRuntime.ts:450-459`), so: non-empty + `!multiSelect` = single-choice, non-empty +
`multiSelect` = multi-choice, empty = free-text. There is no file-path shape and no structured value.

**Validation happens before dispatch, for the same reason model slugs do.** An answer that is not an
exact option label is *silently dropped* by OpenCode (`opencodeRuntime.ts:376`), *silently relabelled*
as an "Other" note by xAI (`XAiAcpExtension.ts:133-155`), and a hard failure on Codex
(`CodexSessionRuntime.ts:792`). The universal answer value is `string | string[]`; the
`{answers: […]}` object form is Codex-only and is never emitted, because Claude hands the record to
its SDK verbatim.

**The answer key is the question id, and on Claude the id IS the question text**
(`ClaudeAdapter.ts:3782-3790`). That makes both halves user content, which is why
`providerUserInputAnswers` stores a SHA-256 fingerprint and nothing else, `storableT3Command()`
strips `answers` down to an `answerCount`, and `redactIntent()` collapses the whole record.

**The device answers exactly one shape**: a single single-choice question with two to four short
options. Everything else is still *listed* on `GET /v1/device/approvals` with `answerable: false` and
a `hint` — a controller that says "Working" for twenty minutes while the agent waits is the failure
this replaces — and posting it anyway is a 422 that names the console.

### Device profiles

Three built-ins live in code (`src/profiles.mjs`); custom profiles are user-scoped rows. The
critical wiring is `resolveActorProfile()` in `app.mjs`: a device stores only a profile *slug*, so a
custom profile must be looked up per user and passed to the policy engine as an object — otherwise
`capabilitiesForProfile()` cannot resolve it and silently falls back to `read-only`.
Built-ins cannot be shadowed, edited, or deleted, and a profile still assigned to a device is a 409.

Note the Convex naming: `updateDeviceProfile` assigns a profile *to a device*, while
`updateDeviceProfileDefinition` edits a custom profile's own definition.

### Billing and entitlements

`src/billing.mjs` owns the plan catalogue and what each tier grants; the payment provider only
supplies the tier. **Everything is gated behind `BILLING_ENFORCED` (default off)** — the default tier
is `free`, which grants 0 devices and no shell, so enabling it unconditionally would break every
existing deployment. When off, `assertWithinPlan()` returns immediately and no `subscriptionTier` is
passed to the policy engine. `POST /v1/billing/webhook` verifies an HMAC over the **raw** body
(hence `readRawBody`, not `readJson`) with a timestamp window, and is refused with 503 when no
secret is configured. A `past_due` or `canceled` subscription falls back to free entitlements
without losing data.

### Storage: one interface, three implementations

`src/storage.mjs` selects by `STORAGE_PROVIDER`:

- **memory** (default, no env) — `createStore()` / `createMemoryStore()` in `src/store.mjs`, the reference implementation
  and the source of truth for behavior. All tests run against it.
- **file** — `src/fileStore.mjs` wraps the memory store and persists `exportState()` to `DATA_FILE` on every change.
- **convex** — `src/convexStore.mjs` maps the same ~155 method names to `gatewayStore:*` Convex functions
  (see `DEFAULT_FUNCTIONS` at the top of that file), authenticating each call with `GATEWAY_CONVEX_SECRET`.

**Adding a store method means touching all three**, plus `convex/gatewayStore.ts` and `convex/schema.ts`. The store API
surface is listed as the return object at the bottom of `src/store.mjs`. `test/storeParity.test.mjs` guards the parts
that have to exist twice, including a check that every `gatewayStore:*` name the adapter maps is actually exported —
`updateMediaDescription` was mapped to a function that had never been written.

Secrets are never stored in plaintext: device secrets and API tokens are stored as SHA-256 hashes and compared with
`timingSafeEqual`; T3 access tokens are AES-256-GCM sealed by `src/secretBox.mjs` (`v1:iv:tag:ciphertext`, key derived
from `T3_TOKEN_ENCRYPTION_KEY`). Secret generation always happens in Node, never in Convex.

### Device lifecycle

Factory pre-provisions (`preprovisionDevice` → claim code) → user claims (`claimDevice`) → device authenticates with its
own secret. Supports `rotateDeviceSecret`, `resetDeviceForTransfer`, and `revokeDevice`. Each device carries a **profile**
(`src/profiles.mjs`: `next-coder`, `read-only`, `power-controller`) that maps to a capability set.

**Claim codes are stable, not rotating.** `ensureUnclaimedDeviceClaimCode({deviceId, rotate})` returns the existing code
untouched while it is unexpired — `POST /v1/device/setup-code` answers `200` with `rotated: false` and `claimCode: null`,
and only `rotate: true` (or an expired/absent code) mints a new one at `201`. This matters because firmware asks for a
setup code on its first 403, seconds after boot; the previous always-rotate behaviour invalidated the label printed on the
box before the owner ever read it. Plaintext is unrecoverable by design, so the *device* caches its code in NVS.
`claimCodeExpiresAt` defaults to 30 days and an expired code is refused by `claimDevice` rather than treated as unknown.

A scanned QR lands on `/claim?device=…&code=…`. `frontend/src/claimLink.ts` reads `location.search` **before** the hash
router (which would discard it) and mirrors the link into sessionStorage so it survives a Clerk round trip;
`features/ClaimPage.tsx` renders it, including an explicit dead-end for a used or expired code.

`buildOnboardingReadiness` requires `device.presence.latestActivityAt` — proof the hardware reached the gateway at least
once. Deliberately not `presence.online`: a controller unplugged since setup must not un-complete someone's onboarding.

### Intent → policy → command → T3

The core write path, in `submitIntent()` (`src/app.mjs`):

1. `normalizeIntent()` (`src/intent.mjs`) validates the intent shape (`status`, `agent_prompt`, `audio_prompt`,
   `camera_prompt`, `shell_input`, `terminal_input`, `session_control`, `approval_response`,
   `user_input_response`). `media_prompt` is a *capability* name, not an intent type: `audio_prompt` and
   `camera_prompt` both map onto it in `capabilityForIntent()`. `thread_create` is likewise a capability
   only — `normalizeIntent()` rejects it, so `POST /v1/device/threads` is its sole entry point.
2. `evaluateIntentPolicy()` (`src/policy.mjs`) checks the device profile's capabilities, then screens `shell_input`
   against `SHELL_RISK_RULES` (`rm -rf`, `sudo`, `git push`, `kubectl|terraform apply`, …). Dangerous commands are not
   blocked outright — they become `requiresApproval` with risk `high` and wait for an owner decision via
   `/v1/commands/:id/approve|reject`.
3. `buildT3Command()` (`src/t3Client.mjs`) translates the intent into T3's wire protocol (`thread.turn.start`,
   `thread.session.stop`, `thread.turn.interrupt`, `thread.approval.respond`).
4. `dispatchT3Command()` sends it to T3, choosing by the advertised protocol: on protocol 1 (0.0.x) a `POST`
   to `{environment.baseUrl}/api/orchestration/dispatch`, a route that **does not exist at 0.1.x**; on
   protocol 2 an `orchestration.dispatchCommand` RPC with the command mapped by `v2Command`.

Media referenced by an intent becomes a real attachment (`buildMediaAttachments`): a signed,
short-lived, single-media URL (`src/mediaLinks.mjs`) that `GET /v1/media/:id/content` honours
**without a platform session**, since the T3 environment has no Clerk credentials — plus the bytes
inlined when under `MEDIA_INLINE_MAX_BYTES`. `storableT3Command()` strips both the inline bytes and
the live URL before the command is persisted, so neither media content nor a usable token is
retained in audit or support exports.

New browser and shared-controller uploads use the separate raw session state machine:
`POST /v1/{device/}media/uploads` creates an owner-scoped, request-idempotent intent;
`PUT .../:id/content` accepts only the declared content type, exact length, and SHA-256; and
`POST .../:id/finalize` re-reads and verifies the private staged bytes before creating the attachable
media row. Session state is `pending|uploaded|finalized|aborted|expired`, survives File/Convex
adapters, and is deliberately separate from transcription/vision processing state. The retention
runner removes expired staging objects. Browser XHR and the shared firmware stream raw bytes over
HTTP—not SSE/WebSocket—and session projections redact storage keys, filenames, transcripts, actor
identity, and client request IDs. Legacy base64 JSON routes remain for older clients. Hosted R2 and
physical controller proof are still separate release qualifications.

Firmware has one raw transport implementation: `media::uploadSession()` in shared
`NextCoderCore/MediaUpload.{h,cpp}`. `GatewayClient`, `GatewayVoice`, and CrowPanel's optional
audio/camera carrier wrapper delegate to it. CrowPanel retains its verified board pins, compile-time
capability gates, capture buffers, and e-ink review flow; its former board-local base64 stream was
removed. The `crowpanel-esp32-213-epaper-capture-placeholder` environment forces the checked-in
example configuration and makes a compile-only proof without inspecting ignored live credentials.

Every step writes a command record plus a `commandEvent` timeline entry, so `/v1/commands/:id/events` reconstructs the
full history. T3 commands are always dispatched with `runtimeMode: "approval-required"`.

Self-hosted T3 environments can be paired by exchanging a pairing token at `{baseUrl}/oauth/token` (RFC 8693 token
exchange; the gateway asks for `orchestration:read orchestration:operate`, `STANDARD_T3_SCOPES`) or by supplying an
access token directly (local dev only). In `DEPLOYMENT_MODE=cloud`, connector enrollment
is the only pairing path: the legacy redeem/create routes fail before consuming a code, accepting a URL/token, or making
network requests, and the transport resolver refuses persisted direct environments. Expired self-hosted tokens surface
as `token_expired` health and block snapshot/dispatch until re-paired.

### Real-time

`src/events.mjs` is an SSE broker. `store.subscribe()` is wired in `createApp()`, so any store
mutation pushes to `/v1/events` (user-scoped) and `/v1/device/events` (device-scoped).
`src/displayState.mjs` builds the compact payload the e-ink device renders.

The two store families report changes differently and `createApp()` handles both: memory/file hand
back a full snapshot (`broadcastStateChange`), while Convex can only name the affected user
(`broadcastUserChange`) because it holds the state remotely. Subscribers treat `state.changed`
purely as a refetch trigger, so the lighter payload is equivalent.

`src/snapshotPoller.mjs` keeps T3 state warm (roadmap Phase 2). It polls only users who are
actually present — an open SSE stream or a recent device heartbeat — since polling every
environment does not scale and Convex exposes no global enumeration. It pushes `t3.snapshot` only
when the compressed screen actually changes, and skips overlapping ticks. Started from
`server.mjs`, never from `createApp()`, so tests stay hermetic and drive `runOnce()` directly.

### Durable notifications and scheduler liveness

`src/notifications.mjs` projects only meaningful transitions into a durable owner inbox: terminal
turns, the three distinct blocking states, and connector/T3 offline or recovered edges. Titles are
static and rows contain only navigation ids; prompts, transcripts, paths, answers, provider detail,
and raw upstream request ids never enter the row or SSE payload. An owner-scoped SHA-256 dedupe key
is private store state. Memory, file, and Convex retain at most 1,000 rows per owner for 30 days.

`GET /v1/notifications` uses `after` for ascending reconnect replay and `before` for descending older
inbox pages. The cursors are mutually exclusive. SSE `notification.created|updated` is live delivery
and invalidation, not the replay authority. Read, read-all, dismiss, and approval/input resolution
are idempotent. There is no device inbox: controllers continue to receive their bounded,
capability-scoped approval/input/result projections.

`GET /v1/background/liveness` reports only durable Queue/Cron scheduled-worker evidence. Never infer
it from an SSE heartbeat, connector presence, T3 reachability, or provider state. The browser can
raise content-free local OS notifications while open. Optional Web Push is a separate owner-scoped,
explicit opt-in backed by VAPID rotation, durable idempotent delivery jobs, bounded retries, dead
subscription cleanup, and a strict push-host allowlist. A push-service acceptance is not proof that
the device displayed anything. See `docs/notifications.md` for the secret and rotation runbook.

### Onboarding

`src/onboarding.mjs` defines a versioned six-step state machine (`welcome → host → connect → workspace → device → ready`)
persisted per user. `buildOnboardingReadiness()` gates completion on *operational evidence* (a reachable environment, a
real thread, a claimed device or an explicit `browser_only` choice) — the server refuses to mark it complete on client
assertion alone. Mirrored in `frontend/src/onboarding.ts` and `features/OnboardingPage.tsx`. See
[docs/onboarding-flow.md](docs/onboarding-flow.md).

### Frontend

`frontend/src/controller.ts` is a single large `useController()` hook holding essentially all app state and API calls;
`App.tsx` renders a nav shell over the `features/*Page.tsx` route workspaces (operate, devices, environments, media,
activity, settings). `api.ts` is the thin fetch wrapper (`ApiError`, `requestJson`). Clerk session tokens are fetched
fresh per request and **never** written to `localStorage`. Builds to `dist/web`, which the gateway serves statically;
The pre-React dashboard has been removed; the React build is the only client.

#### The live thread transcript

`liveThread.ts` is a pure reducer over the three `t3.thread.*` SSE events; `useThreadWatch.ts` owns
the lease and the fan-in; `useController()` composes both and `OperatePage` renders it. Splitting it
that way is what makes the three traps testable without a T3:

- **A `thread.message-sent` with `streaming: true` is a DELTA.** It is accumulated onto the entry
  with the same `messageId`. Only a terminal frame replaces the body, and an *empty* terminal frame
  means "keep what you have".
- **A snapshot replaces; it never appends.** `gap: true` additionally means the intermediate events
  were never delivered, which `historyGap` says out loud rather than showing a seamless transcript.
- **The same event arrives twice by design** (the replay/live overlap). Dedup is a bounded ring of
  `sequence` keys falling back to `eventId` — not a "greater than the cursor" test, because arrival
  order is not assumed monotonic. The cursor is trusted only as the snapshot floor and as a horizon
  older than the ring.

The watch is registered because a thread is **on screen**, not because one is selected, and it is a
lease: `POST .../watch` renews every 30s inside the 90s TTL, `DELETE` is the polite release on
unmount and navigation, and a closing tab gets one best-effort `keepalive` release on `pagehide`.
The lease, not that handler, is the guarantee — a leaked watch costs one TTL. The polled snapshot
path is untouched: live entries render only once a snapshot has arrived, and `selectedThread.messages`
still renders for anyone not watching.

#### T3-native agents and background work

**This section describes protocol 1 (T3 0.0.x), and under protocol 2 the work graph has no input in
production.** The `task.*` activity rows are 0.0.32's contract; 0.1.1 still defines the four literals in
its provider-runtime schema (`bundle-0.1.1.js:32079-32082`), 0.1.5 no longer does, and neither protocol-2
wire carries activities. T3's replacement is first-class — `subagents[]` (status, progress, `workflow`,
`parentNodeId`, `childThreadId`) and `nodes[]` of `kind` `root_turn | assistant_message | reasoning | plan |
todo_list | tool_call | approval_request | user_input_request | subagent | hook | system`, with
`subagent.updated` stream events (`bundle-0.1.5.js:37843`) — and `t3v2.mjs` maps neither, so
`frontend/src/workGraph.ts`, `src/agentVerb.mjs` and `src/t3Work.mjs` receive nothing from the owner's
0.1.1. The panel therefore shows an empty or roster state there. Do not delete this code (it is correct
for 0.0.x and its fixture is real), and do not read a green work-graph test as production evidence.
Projecting `subagents[]` into the legacy shape in `t3v2.mjs` (and its gateway copy) is the open fix.

T3 0.0.32's shipped source map proves a task lifecycle that earlier roadmap drafts treated as
hypothetical. `providerRuntime.ts:177-180,471-646` defines `task.started|progress|updated|completed`;
`ProviderRuntimeIngestion.ts:315-357,539-739` preserves `taskId`, `agentKind`, `agentId`,
`parentAgentId`, task identity, status, typed usage, workflow/phase fields, and stable progress IDs
in thread activities. The deterministic fixture at
`test/fixtures/t3-work-activities-contract.json` is transcribed from those contracts and contains no
live user data.

`frontend/src/workGraph.ts` is an evidence-limited latest-state fold over those rows. It trusts
T3-stamped `agentKind`, uses only explicit `parentAgentId`/`agentId` edges, labels legacy unlinked
rows as tasks, and re-homes only tools carrying T3's own `taskId`/`agentId` attribution. It never
infers agents or hierarchy from prose, tool labels, timing, or model output. A snapshot replaces the
work projection; live activity inherits the transcript's sequence/event-ID dedup and replay-gap
rules. The UI calls an unlinked window a roster rather than drawing a fake tree.

The projection is capped at 64 nodes and 16 activity rows per node, retaining active work ahead of
old terminal nodes and reporting omissions. `Agents & work` distinguishes loading, empty, live,
reconnecting/stale, stopped, failed, missing-parent, and truncated evidence. Active task lifecycle
also keeps the thread visibly in flight after the foreground session settles. T3 0.0.32 exposes no stable
per-task input/stop/resume command, so there are no fake per-agent controls; the composer and Stop
remain parent-thread operations. At 0.1.x `orchestration.stopWorkflow` (scope `operate`) is the first
per-task stop T3 publishes, for provider-native workflow children (`bundle-0.1.5.js:401644`); its reach
relative to ordinary subagents is not established and nothing here calls it.

`src/t3CapabilityManifest.mjs` is the versioned adapter boundary for direct and connector T3 calls.
Its `next-coder.t3-capabilities.v1` projection comes from read-only response shapes,
`server.getConfig` flags, scopes, and actual adapter method availability—not the reported T3 version.
Fresh manifests are cached for five minutes and stale fallback is labeled. T3 0.0.32 certifies image
attachments only; audio/file and nonexistent per-task input/stop/resume controls must remain absent
*for 0.0.32*. At 0.1.x the contract has `ChatFileAttachment` (up to 50 MiB, up to 100 attachments) and
unknown attachment types are accepted by the decoder (`bundle-0.1.5.js:27800-27917`); the manifest code and
`docs/t3-capability-manifest.md` still state the 0.0.32 limits (audit section 2.5, outstanding).
The owner sees the full bounded manifest; device health receives only a compact state/action.

`src/t3Work.mjs` separately projects only status counts for `/v1/device/thread-output`; task IDs,
titles, roles, models, paths, summaries, errors, output and usage never enter the device payload.
See `docs/t3-work-graph.md` for the field map, status mapping, resource budgets, tests, and explicit
unverified live/hardware evidence.

## Conventions

The private Container's `startGateway()` RPC accepts only the string startup environment and a
timeout. Create its cancellation signal inside the Durable Object, retain the Containers SDK's
startup/lifecycle path (including outbound interception and alarms). Never add
`enable_abortsignal_rpc`: it is experimental and the deployed Cloudflare API rejects it. A raw
`this.container.start()` bypasses that lifecycle. Health probe `pingEndpoint` is a host/path, not a
full URL. Never publish arbitrary platform error fields, including names or stacks: they may echo
startup secrets. See `cloudflare-control-plane/README.md`.
Register `outboundByHost` through the inherited SDK setter (a static block assignment), not a
static class field. A field shadows the registry setter: interception selects the private host,
but ContainerProxy cannot find its handler and falls through to DNS.
The private connector ticket-consume service returns flat `ConnectorTicketClaims`, not the raw
Store `{ connector, ticket, reason }` result. Exercise the real service projection in edge handshake
tests, including audience and expiry checks; separate fixtures can otherwise hide protocol drift.

- **`src/t3Protocol2.mjs` is a deliberate copy of `packages/connector/src/t3v2.mjs`, and the two must
  move together.** The connector is a separate npm package and the release Container image copies only
  `src/` (`COPY --chown=node:node src ./src` in `cloudflare-control-plane/Dockerfile`), so neither can
  import the other, and the direct and connector transports are parallel implementations on purpose.
  The gateway file is a header comment, a marker line, and then the connector file **byte for byte**; a
  fix to a projection, command mapping or stream-delta rule belongs in both. `test/t3Protocol2.test.mjs`
  compares everything below the marker and fails on drift — it has already caught one. To re-sync, replace
  everything below the marker with the connector file's current contents. The same copy carries the
  `ProviderApprovalDecision` vocabulary, which another test pins to `src/providerApprovals.mjs`.
- Server code is `.mjs` ESM with no build step and only two runtime dependencies: `@clerk/backend`, and
  `web-push`, which `src/webPush.mjs` alone imports. Keep it that way.
- IDs come from `src/ids.mjs` (`createId("prefix")`); timestamps are ISO strings via `nowIso()`.
- Server tests use `node:test` + `node:assert/strict`, spin up a real `createApp()` server on an ephemeral port, and stub
  `globalThis.fetch` to fake the T3 instance (restore it in `t.after()`). Follow the pattern at the top of
  `test/app.test.mjs`.
- Rate limiting (`src/rateLimit.mjs`) is fixed-window behind a pluggable backend: in-process by
  default, shared via `RATE_LIMIT_REDIS_URL` (raw RESP in `src/resp.mjs`, no dependency). `check()`
  is **async**, so every `enforce*` call must be awaited — an un-awaited one silently skips the
  limit and then crashes on the rejection. `test/rateLimit.test.mjs` has a guard test that fails if
  any call site in `app.mjs` loses its `await`.
- In `handle()`, any `return someAsyncFn(...)` must be `return await` — a bare returned promise
  escapes the surrounding try/catch and becomes a process-killing unhandled rejection.
- Support diagnostics (`/v1/support/diagnostics`) run everything through the `redact*` helpers in `app.mjs`; any new
  field containing user content or secrets must be added there too.

### Production security

`REQUIRE_TLS=1` makes the gateway refuse to issue or accept a device credential over plaintext
(`src/transport.mjs`). The subtlety: a loopback socket is only exempt when **no** `x-forwarded-proto`
is present — once a proxy forwards a request, the real client is elsewhere and its scheme decides.
Off by default so existing deployments keep working.

Firmware rollback is real but needs all three of: `partitions_ota.csv` (dual app slots),
`confirmFirmwareIfPendingVerify()` confirming only after a successful heartbeat, and a bootloader
built with rollback enabled. `docs/production-security.md` documents the eFuse ceremony, which is
deliberately not scripted.

## Docs

[docs/api.md](docs/api.md) (endpoints + local e2e flow), [docs/auth-storage.md](docs/auth-storage.md) (Clerk/Convex
deployment validation), [docs/hardware-protocol.md](docs/hardware-protocol.md) (device provisioning/display/intent wire
format), [roadmap/open-input-media-voice-environments-roadmap.md](roadmap/open-input-media-voice-environments-roadmap.md)
(active product roadmap), and [roadmap/IMPLEMENTATION-STATUS.md](roadmap/IMPLEMENTATION-STATUS.md)
(canonical verified progress).

T3 versions: [docs/t3-version-audit.md](docs/t3-version-audit.md) compares 0.0.32, 0.1.1 and 0.1.5 with a
verdict per assumption and the bundle-extraction method; it supersedes any unversioned T3 claim in this file.

Operations: [docs/operator-setup.md](docs/operator-setup.md) is the ordered account, environment and
first-deployment sequence; [docs/staging-drills.md](docs/staging-drills.md) documents the scripted
hosted qualification drills; [docs/evidence-bundles.md](docs/evidence-bundles.md) covers assembling
the promotion and final-qualification evidence bundles.
[roadmap/completion-plan.md](roadmap/completion-plan.md) sequences everything that remains.
[docs/deferred-items.md](docs/deferred-items.md) records known non-blocking work, including two
credential rotations that are deliberately postponed. Milestone 0.5 is complete; Milestones 2 and 3 are substantially
implemented, while Milestones 0, 1, 4, and 5 remain partial pending their named deployed, live-T3,
browser, or hardware proof.

Firmware is PlatformIO C++ under four board folders; copy `include/controller_config.example.h` to
`controller_config.h`, then `pio run`.

| Folder | Board | State |
|---|---|---|
| `CrowPanel-ESP32-2.13-E-paper` | 2.13" e-ink, five active-low keys | Most complete gateway-connected implementation; 5 build environments including hermetic capture proof; current silicon validation not recorded |
| `vision-master-t190` | 1.9" TFT | Shared `DeviceStore`/`Provisioning`/`GatewayClient`/`GatewayBrowse` status and environment/folder/thread/approval screens; 1 environment, whose default build compile-gates the unverified external input carrier. Display pins, input, and every network flow are unverified on silicon |
| `Waveshare-ESP32-S3-Touch-AMOLED-1.75C` | 466x466 round AMOLED touch, dual-mic array | Scaffold; pin map unverified |
| `Hosyond-ESP32-S3-2.8-Touchscreen` | 2.8" IPS 240x320 touch, on-board mic + speaker (ES8311) | Five-screen touch UI over the shared gateway client (home/threads/send/reply/approvals) with hold-to-talk upload; 7 environments, `-controller` is the product build. Capture/display/orb/provisioning proven on silicon, the UI and every gateway call are not |

Every board is pinned to **ESP-IDF 5.5 / Arduino core 3.3** via the pioarduino platform fork. The official
`platformio/platform-espressif32` is unmaintained at Arduino 2.0.17 / ESP-IDF 4.4, which lacks `driver/i2s_std.h`
and cannot build the audio boards. Changing the pin means re-verifying all 15 environments. The
canonical inventory is `firmware/build-matrix.json`; `npm run build:firmware:all` builds it from
placeholder configs in a temporary directory so live board credentials never enter build evidence.

A board **can** browse environments → projects → threads. That was untrue for most of this
project's life — `GET /v1/device/threads` was the only list the device protocol offered — and the
claim outlived the gateway change that fixed it. The routes are
`GET/POST /v1/device/environments` and `/v1/device/projects` alongside the thread pair
(`docs/hardware-protocol.md`, "Environment, project, and thread API"); each level is scoped by the
one above and every id is checked server-side, so the owner still keeps the boundary. The firmware
client is `firmware/shared/NextCoderCore/src/GatewayBrowse.cpp`, in its own translation unit
with its own state rather than as members on `GatewayClient`, and the Hosyond board drives it.
Two limits are real: changing environment clears the project and thread server-side, and
`POST /v1/device/config/project` reads `projectId` as a **required** string — so a device can narrow
to a folder but cannot widen back out to "all folders" without the console.

A board can also **create** a thread: `POST /v1/device/threads` creates one in the bound project and
selects it in the same request. Creating and not selecting would be half the job — T3 answers a
dispatch as soon as the event is appended, so a follow-up `POST /v1/device/config/thread` can 404 on
a thread that certainly exists. It needs no new T3 transport: `thread.create` is a member of
`ClientOrchestrationCommand`, the payload schema of the ordinary `POST /api/orchestration/dispatch`
(contract citations live on `buildT3ThreadCreateCommand()` in `src/t3Client.mjs`). It is gated by a
real capability, `thread_create` — `read-only` browses, it does not create.

**The name is the hard part, and `src/threadNaming.mjs` owns it.** A device has no keyboard, so
`title` is optional and the gateway mints `"<D Mon HH:MM> · <device label>"` when it is absent —
time first, unlike a media name, because every thread one controller makes carries that same
label. Uniqueness is enforced against the snapshot *and* against titles minted in the last ten
minutes, since the projection the snapshot reads lags the dispatch. The minted name is permanent:
T3's `canReplaceThreadTitle` only regenerates a title that is still its own default `"New thread"`
or exactly equal to a `titleSeed`, and the device dispatch sends neither — which is the right trade,
because a picker of identical `New thread` rows is the dead end this endpoint removes.

**Every ESP32-S3 board is BLE-only** — no Bluetooth Classic, so no HFP headset microphone, and no LE Audio.
Bluetooth earbuds cannot be a microphone source on any current or planned board. On-board mics or a phone
companion are the two real paths.

`firmware/shared/NextCoderCore` (via `lib_extra_dirs`) owns the writable device state and orb
renderer the boards share:

Cloud chunk framing must not busy-wait on a network core. The Arduino `HTTPClient` chunk parser
calls `Stream::readStringUntil`, whose `timedRead` spins without yielding; a six-second response
pause triggered the Hosyond idle watchdog in October 2026. Shared `GatewayHttp.h` makes empty
single-byte and bulk reads yield and bounds decoded bodies before allocation. Bulk TLS reads can return no bytes while HTTPClient yields only `delay(0)`; the claimed-device heartbeat exposed a second idle-watchdog spin, fixed by yielding on non-positive bulk reads too. Preserve both properties
when changing the HTTP transport; moving HTTP off the render task alone does not prevent watchdogs.

`DeviceStore` wraps NVS (namespace `agentctl`) for identity, gateway URL, Wi-Fi credentials, the cached claim code, and
the config cache; `Provisioning` is the boot state machine plus a SoftAP captive portal. **`controller_config.h` is a
bench seed, not a source of truth** — `DeviceStore` copies it into NVS only on a unit that has none, and a factory unit
gets its identity from the `nvsSeed` CSV that `POST /v1/factory/batches` returns. There is no `WIFI_SSID` macro any more;
the factory cannot know the customer's network. CrowPanel uses EXIT hold for Wi-Fi reset; Hosyond
uses BOOT hold, while a short BOOT tap reopens its configuration portal. See
`firmware/shared/README.md` and the board READMEs.

Wi-Fi candidates must use RAM-only SDK credentials (`WiFi.persistent(false)` before radio init).
The versioned NVS profile blob commits at most five complete validated profiles; the legacy pair
is only a compatibility mirror. A fresh exact-SSID association and successful persistence are
both necessary for candidate success. Keep candidate ID/outcome separate from radio phase: a
wrong password followed by automatic recovery to the same SSID with its old saved password is
still a failed candidate. Use timeout-zero disconnect and defer `begin()` until disconnection is
observed; the Arduino defaults otherwise wait on the UI task. Wi-Fi recovery controls must
remain available with retained voice audio or an active portal. Gateway changes and Wi-Fi joins
are separate portal saves so failed joins cannot partially change the authentication realm.

Convex authentication bookkeeping (`ensureUser`, `authenticate*`, connector ticket issue/consume) must not broadcast full console invalidations. Every authenticated read runs that bookkeeping, so broadcasting it creates a read → auth → invalidation → read loop. Older deployed adapters are filtered at the console during rollout; real product mutations still invalidate their owner.

Device gesture work is one bounded job drained by the existing gateway network task; the render task alone applies its completion. Do not add a permanent network task/stack per feature or call HTTP from touch handlers. Capture and reply results carry a target/generation so a late socket cannot overwrite a newer selection. DeviceStore transport and receipt snapshots are copied under its settings mutex; no transport may retain an unprotected reference across a yield. A pending request cannot cross a gateway/device realm change or be overwritten by a different uncertain intent.

Device audio raw-upload sessions freeze their environment/thread before bytes transfer. Each logical recording has a random request ID reused for retries; SHA alone is not an intent identity. A finalized device capture reuses its original transcription job even when terminal, and firmware follows that job rather than issuing a second audio command. Read-only polling stops for review/ready and resumes transient transport failures with bounded backoff. A missing transcription provider must be explicit. Provider approvals and user-input requests remain separate from gateway holds; unsupported on-device answering must direct the owner to the console rather than display a lying Working state.

Gateway HTTP state and TLS gates must never be held while waiting for each other. Release all recursive state-lock depth before waiting for the TLS gate, and destroy HTTP/socket objects plus release TLS before reacquiring state. A touch reply read otherwise holds state while waiting on a background heartbeat that is waiting to publish its result, producing a 10-second TLS-gate timeout. `test/firmware-request-locks.test.mjs` compiles the actual request body against lock-checking transport doubles and covers every transport exit. A reply-read failure must also leave Hosyond's Actions menu reachable.

The environment capabilities HTTP response has both `manifest` (the versioned feature/freshness contract) and `capabilities` (coarse gateway permission flags). The console stores `manifest` in `health.capabilities`; storing the coarse flags there falsely disables all composer actions. Device SSE holds the global TLS session lease for its entire socket lifetime. Foreground requests announce demand; SSE closes and destroys its own clients before releasing the lease. It reconciles authoritative snapshots after close and waits for a bounded foreground quiet window before reconnecting. Never wait for model state while holding the SSE lease. The 6-second handshake timeout is independent of HTTP read/connect timeouts. This prevents retained SSE buffers overlapping another internal-RAM TLS session.

The explicit Cloudflare Node Container adapter currently needs `THREAD_STREAM_ENABLED=1` and `CLOUD_THREAD_STREAM_CONSUMER_ENABLED=0`. No platform thread-stream background task exists; setting the consumer flag without an implementation leaves watches idle and commands dispatched after real replies arrive. The existing one-second hub tick is demand-driven by expiring watches. Platform-native stream scheduling/fanout remains outstanding.

Container shutdown must call `server.closeAllConnections()` after stopping listeners: SSE keeps `server.close()` pending indefinitely, leaving the process alive with closed HTTP ports after SIGTERM. Inherited saved actions must retain explicit `null` environment/thread targets through normalization; `undefined` disappears on the Convex wire and fails its required nullable validators.

Capability freshness is a renewable lease, not a requirement to reconnect a healthy connector every five minutes. Visible selected console workspaces renew at expiry; hidden tabs wait until visible, failures retry at 30 seconds. Device control reads re-probe stale manifests once per distinct target environment in the bounded layout and persist fresh evidence before projecting enabled controls. Projected `system_status`/`system_stop` action aliases normalize back to system controls; never pass those aliases to a saved-action Store lookup.

Completion evidence is newer than dispatch start, not necessarily newer than its delayed acknowledgement or durable command row. The immutable `metrics.dispatchStartedAt` preserves that boundary through acknowledgement and completion updates, and anchors the device response cursor. Older commands fall back to the acknowledgement timestamp minus dispatch duration. After recording an acknowledged command, reconcile any real reply already collected by its leased stream; never equate the acknowledgement itself with completion.

Protocol-2 shell snapshots contain no message bodies. The device response endpoint must read the selected thread detail (bounded to eight turns) when the shell row has no messages, while thread menus stay shell-only. The adapter thread-detail result may be the thread itself; do not assume an additional `{ thread }` envelope.

### Connector-local speech boundary

Cloud voice uses `TRANSCRIPTION_PROVIDER=connector`: the durable runner passes its leased job to
an injected transcription provider, which routes only `{mediaId, jobId}` to that environment's
current connector. Authenticated `/v1/connector/media/:id` rechecks account/environment ownership,
lease, current connector and revocation before and after storage reads; bounded bytes and SHA-256
are verified again by the laptop. Cloud never addresses the laptop's loopback speech port.

The connector prepares and owns its private Python/Parakeet runtime by default. Only explicit
bench configuration may reuse an external compatible sidecar. Owned sidecars watch their parent
stdin pipe and exit on EOF as well as on ordinary shutdown, preventing orphaned inference processes
after a connector crash. Transcripts never enter durable connector request caches or speech logs;
the hub keeps bounded short-lived results and persists only retryable receipt metadata.

Queue wakeups remove the five-minute Cron latency; a skipped busy media runner is retryable work,
not an acknowledgement. Production uses one leased job per invocation with a timeout shorter than
the lease and private request budget. Voice dispatch uses `voice:${job.id}` as its request identity,
so a crash after T3 acceptance but before media-job settlement cannot create a second turn.
## Direct runtime boundary

`packages/connector/src/agents/` owns optional native Codex/Claude/ACP integration. Its local
conversation domain projects into the gateway's existing conversation contract; it does not
pretend to be T3. `next-coder.runtime-probe.v1` explicitly identifies a direct runtime while the
public manifest retains its compatibility envelope. Never infer T3 compatibility/version from it.
Only direct entries may be selectable with unknown native authentication; retain `runtimeKind`
through hello, catalogue normalization and persistence instead of fabricating an authenticated flag.

The native conversation journal is local, single-writer and crash-safe. Prompts are claimed before
native dispatch; restart never replays them. Separate per-agent native bindings plus bounded missed
history implement handoffs. Reimporting an already-linked native session returns its existing app
conversation. Unknown external-process ownership requires explicit idle-session handoff, not a claim
of live attachment. Read payloads must not enter durable connector response receipts.
