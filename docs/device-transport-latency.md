# Device transport latency: analysis and options

Status: analysis and design only. Nothing here is implemented and no number in this document was
measured on silicon. Where a figure is arithmetic from constants it is labelled an estimate; where a
claim rests on reading code it carries a file reference. The owner's report that triggered this work:
tapping a thread, an action or a reply on the Hosyond controller "takes too much time" and sometimes
"does not respond"; they asked whether a WebSocket would make the connection instant.

`ui.cpp` is being edited concurrently, so UI references below are by function name, not line.
Firmware line numbers are against the tree as read on 2026-10-30.

## 1. Summary

1. A tap is not one request. Every request on this firmware is a fresh TCP connect, a fresh full
   TLS 1.2 handshake, one HTTP exchange and a teardown. A thread selection followed by reading the
   reply is five to nine of those, mostly serialised by a 100 ms scheduler, plus one wasted SSE
   handshake that a tap must sometimes wait out.
2. The SSE stream is up for a small fraction of the time and its preemption schedules a five-resource
   reconcile (`GatewayClient.cpp:718-726`). Read strictly, this makes idle traffic a near-continuous
   request chain, which is also what a tap collides with. This is the highest-consequence finding and
   the cheapest to confirm (count requests per minute at idle). It is a prediction from code, not an
   observation.
3. Session resumption is reachable without forking the Arduino core. The core exposes a STARTTLS
   seam (`setPlainStart()` / `startTLS()`) and a protected `sslclient`, and mbedTLS 3.6.6 in the
   prebuilt libs exports `mbedtls_ssl_get_session` / `mbedtls_ssl_set_session`. The earlier
   conclusion that it needs a core rebuild is wrong; it needs about one small subclass.
4. The "one 32 KB TLS session" constraint is a build-time allocator policy that can be overridden at
   run time with `mbedtls_platform_set_calloc_free()`. Whether a second session then fits is a
   measurement, not a fact.
5. A WebSocket is a legitimate end state and the owner's instinct is half right, but it is the
   largest change here, it does not remove every second-session case (OTA, uploads, probes), and it
   adds a server component that does not exist. It should be gated behind cheaper steps that capture
   most of the same benefit.
6. The cheapest large improvement to *felt* latency needs no transport change: stop clearing the
   Threads screen on entry, serve reads stale-while-revalidate, and never silently drop a tap.

Recommended first change: section 7, item 1 (local-first Threads and Reply, plus the dropped-tap fix).

## 2. Evidence ledger

| Claim | Source | Status |
|---|---|---|
| Each `request()` builds its own client, handshakes, and destroys it at scope exit | `GatewayClient.cpp:149-208` (`secure`, `plain`, `HTTPClient http` are locals) | read |
| `HTTPClient` sends `Connection: keep-alive` by default, but the socket dies with the local | `HTTPClient.cpp:489,1152` (`_reuse = !useHTTP10`), `GatewayClient.cpp:207` | read |
| No resumption or reuse anywhere in shared firmware | grep for `setReuse`, `setSession`, `SESSION_TICKET`, `keep-alive` over `firmware/` | read |
| TLS buffers are allocated from internal RAM only | prebuilt `esp32s3/sdkconfig:2783` `CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC=y`; disassembly of `esp_mbedtls_mem_calloc` in `libmbedcrypto.a` calls `heap_caps_calloc(n, size, 0x804)` = `INTERNAL\|8BIT` | read, confirmed in object code |
| Runtime allocator override is possible | `mbedtls_platform_set_calloc_free` is exported (`T`) in `libmbedcrypto.a`; `esp_config.h:130-137` enables `MBEDTLS_PLATFORM_MEMORY` and defines only `PLATFORM_STD_CALLOC/FREE`, not `PLATFORM_CALLOC_MACRO`, so `mbedtls_calloc` dispatches through the `mbedtls_calloc_func` data pointer (`platform.c.obj`) | read, confirmed in object code |
| Record buffers are 16 KiB each way | `CONFIG_MBEDTLS_SSL_MAX_CONTENT_LEN=16384`, `ASYMMETRIC_CONTENT_LEN` unset (`sdkconfig:2787-2788`) | read |
| PSRAM exists and spills large `malloc` to it | `CONFIG_SPIRAM_USE_MALLOC=y`, `SPIRAM_MALLOC_ALWAYSINTERNAL=4096` (`sdkconfig:2117-2118`); board is `qio_opi`, 8 MB (`platformio.ini`) | read |
| mbedTLS 3.6.6, TLS 1.3 not built | `build_info.h:37`, `sdkconfig:2794` | read |
| Client tickets compiled in; esp-tls client tickets are not | `sdkconfig:2872` set, `:1662` unset | read |
| Handshake MPI is hardware-assisted | `sdkconfig:2828` | read; says nothing about where the time goes |
| Core has a STARTTLS seam and a protected session object | `NetworkClientSecure.h:29-31,86-96`; `NetworkClientSecure.cpp:147-182`; `ssl_client.cpp` splits `start_ssl_client()` (setup, returns socket) from `ssl_starttls_handshake()` | read |
| `connect(host,port,timeout)` is virtual | `Network/src/NetworkClient.h:33-34`; `HTTPClient.cpp:1109` calls it | read |
| Pinned roots are GTS Root R4 (ECDSA P-384) and GlobalSign Root CA (RSA 2048) | `controller_config.h:64,66` | read |
| Foreground and SSE fight over one gate | `GatewayTls.h:70-126`, `GatewayClient.cpp:658-728` | read |
| Per-tap latency, handshake cost, SSE duty cycle, idle request rate | none | **not measured** |

The task brief's "~32 KB contiguous block" is slightly off: `mbedtls_ssl_setup` allocates the input and
output buffers separately, so the largest-free-block requirement is about 17 KB, twice. The
`[tls-heap]` diagnostics (`GatewayTls.h:72-81`) report `internal_largest` and settle which figure
binds.

## 3. Where the time goes

### 3.1 Cost of one request

A request on this firmware is, in order: wait for the gateway task to be free; wait for the TLS gate
(and, if the SSE is mid-handshake, wait it out); DNS lookup (`NetworkClientSecure::connect(host,...)`
calls `Network.hostByName` every time); TCP connect; parse the pinned CA PEM
(`ssl_client.cpp` `mbedtls_x509_crt_parse`, repeated per connection, and `GatewayTls.h:264-270`
concatenates a second RSA root that is parsed too); full TLS 1.2 handshake (TCP SYN, ClientHello to
ServerHello, key exchange to Finished, then the request: about four network round trips before the
first response byte, against one on a warm connection); server work; body read; teardown. TLS 1.3
(one fewer round trip, standard PSK resumption) is not built into the prebuilt library.

Public-key work per full handshake, from the pinned roots (the cipher suite and chain Cloudflare
serves are **not** established by static reading): ephemeral ECDH key generation and shared secret,
one ECDSA verification of the ServerKeyExchange signature, and one or two chain verifications. If the
chain is served through the GlobalSign cross-sign, one of those is an RSA-2048 public operation; if
through R4 directly, one is a P-384 verification. That is roughly eight P-256-equivalent scalar
operations of CPU on an Xtensa core, plus the round trips. `MBEDTLS_HARDWARE_MPI` accelerates large
multiplications; whether it moves ECC point arithmetic enough to matter is unknown. This is why the
section 6 measurements split CPU from network time before anything is built on resumption.

### 3.2 The tap paths

Costs below are counted in requests (R), each of which is a full handshake today (H). "T3 trips" are
gateway-to-connector-to-local-T3 round trips (Durable Object, then the laptop's WebSocket); the gateway
has no snapshot cache for device reads, so each device route that needs one pays one
(`readT3SnapshotForStore`, `app.mjs:8599`; `fetchDeviceSnapshot`, `app.mjs:8761`).

**A. Reply: Home tap to Response screen** (`handleContentTap` Screen::Home, then `queueResponsePage(0, true)`)

| # | Request | Server work |
|---|---|---|
| 1 | `GET /v1/device/thread-output` (`GatewayOperate.cpp:932`) | auth, rate limit, store reads, snapshot (T3 trip 1), thread detail with `turnLimit: 8` (T3 trip 2), controls resolve (`app.mjs:3981-4044`) |
| 1b..1d | Up to `kMaxResponseStreamReads = 4` repeats (`OperateModel.h:246`) while behind a long reply | same, per repeat |

Painted result: `goTo(Response)` shows the loading state until request 1 returns. Minimum 1 R, 2 T3 trips.

**B. Threads screen: tap "choose", pick a row, use it** (`goToThreads`, `selectThreadRow`, `usePreviewThread`)

| # | When | Request | Server work |
|---|---|---|---|
| 1 | on entry | `GET /v1/device/environments` (`GatewayBrowse.cpp:249`) | two store reads |
| 2 | on entry | `GET /v1/device/threads?environmentId=&projectId=` (`:663`) | snapshot (T3 trip 1) |
| - | row tap | none; `selectThreadRow` is a local preview | - |
| 3 | "use thread" | `POST /v1/device/config/thread` (`:700`) | snapshot again to validate (T3 trip 2, `app.mjs:4046-4083`), config write |
| 4 | after 3 | `GET /v1/device/config` | `clearContextBinding` sets `nextConfigAt_` (`GatewayOperate.cpp:404`) |
| 5 | after 3 | `GET /v1/device/controls` | `nextControlsAt_` (`:405`) |
| 6 | after 3 | `GET /v1/device/approvals` | `nextApprovalsAt_` (`:397`); T3 read |
| 7 | reply tap | as path A | 2 T3 trips |

The Threads list is discarded on entry: `GatewayBrowse::beginPreview` zeroes `previewThreadCount_`
(`GatewayBrowse.cpp:636`) and `goToThreads` paints "Choose destination" over an empty list while
requests 1 and 2 run serially in one job. The controller already holds a warm 12-row list
(`kThreadsIntervalMs = 30000`, `GatewayClient.cpp:61`) that this screen does not use. Requests 4 to 6
are scheduled by `runCycle` one per 100 ms tick (`GatewayClient.cpp:881-936`), each with its own
handshake. `clearContextBinding` also empties `threads_` (`GatewayOperate.cpp:401`), so the warm list
that backs the Home carousel disappears until the next 30 s fetch.

Count: 7 R, about 5 T3 trips, 7 handshakes, before the SSE reconnect below.

**C. Home picker swipe** (`commitPicker`, debounced `kPickerCommitMs = 600`, `ui.cpp`)

600 ms debounce, then `POST /v1/device/config/thread` (`selectThread`, `GatewayOperate.cpp:511`),
then controls (`:537`) and approvals (`:527`) follow-ups, then, if OPEN was used, request A. 4 R
including the reply. The debounce is deliberate and not part of the problem.

**D. Action tap** (`dispatchControl`)

`showBusy` paints at once. One `POST /v1/device/actions/:id/run` (`GatewayOperate.cpp:748`; server:
capability freshness check, policy, command and request-envelope writes, connector dispatch to T3),
two NVS journal writes around it (`beginDurableDeviceRequest` / `settle...`, flash write each), then,
for a turn-producing action, `afterDispatch` queues request A. 2 R.

### 3.3 What the SSE lease does at each step

- A foreground `lockTls()` increments `foregroundWaiters` and arms a 2 s quiet window
  (`GatewayTls.h:99-109`). `unlockTls()` re-arms it (`:112-119`).
- The SSE task sees the waiter within its 20 ms poll, returns `Preempted`, destroys its client, and
  releases the gate (`GatewayClient.cpp:686,714-728`).
- **The SSE can only check for preemption before `http.GET()` and inside the read loop**
  (`GatewayClient.cpp:672-674,686`). A tap that arrives while the SSE is inside its own handshake
  waits for that handshake (up to the 6 s handshake timeout, `GatewayTls.h:252`) before it can start
  its own. This is a wait with no useful work in it.
- After the foreground burst, the SSE cannot reconnect until the quiet window passes, then pays one
  full handshake and one rate-limited `authenticateDevice` read on the gateway.
- **On every `Preempted` or `Disconnected` exit the event task marks all five resources due**
  (`GatewayClient.cpp:718-726`: `markOperateDue` plus `nextConfigAt_`). The justification in the code
  is correct for a *missed-event gap*, but the effect is that any poll that preempts an established
  stream schedules five more polls.

### 3.4 Idle behaviour implied by the constants (estimate, unverified)

Foreground cadences: display 5 s, heartbeat 30 s, config 60 s, threads/controls/approvals 30 s each
(`GatewayClient.cpp:23-66`), about 21 requests per minute with no SSE involvement. Because the display
poll preempts the SSE every 5 s and the quiet window plus reconnect handshake cost roughly 3 s, the SSE
is established for on the order of a fifth of the time at best. Each preemption of an *established*
stream then schedules the five-resource reconcile. If the reconcile fires as written, steady state is
a repeating chain of about six requests, each a handshake, followed by an SSE reconnect, followed by the
next display poll preempting it. That would put the gateway network task near saturation at idle, which
is exactly the condition under which a tap waits behind a background request. Device read quota is 120
per minute (`DEVICE_READ_RATE_LIMIT`, `rateLimit.mjs:98`) and SSE connects consume it too;
the predicted idle rate is well inside it but leaves less headroom than the "12 per minute" in the
cadence comment implies.

Push events do not help while this holds. Every pushed `device.refresh`, `t3.thread.event` or
`command.reconciled` only sets a `next*At_` due time (`applyRefreshEvent`, `GatewayClient.cpp:733-770`),
which makes a foreground request, which preempts the stream that delivered it. While a reply streams,
`t3.thread.event` arrives per chunk, so each chunk costs a pull, a teardown and two handshakes.
**Trigger-then-pull push is self-defeating under a one-session constraint.** The `threads.changed`
event is the one exception: it carries enough to patch local state (`applyThreadChangedEvent`).

### 3.5 Head-of-line blocking in the gateway task

UI jobs run inside `networkTick()` via `interactionHandler_` (`GatewayClient.cpp:587-593`;
`uiNetworkLoop`), in the same `gwnet` task as `runCycle`. A tap that lands while a background request
is in flight waits for it, up to 6 s (`kTimeoutMs`) on a bad request. If idle traffic is near-continuous
(3.4), that is a large fraction of taps.

`enqueueUiNetworkJob()` also returns false while any job is in flight (`ui.cpp`, `uiNetworkBusy`), and
several callers ignore the result: `goToThreads` has already navigated and painted the busy card by
then, `queueResponsePage` is fire-and-forget. A tap during an earlier job's flight is therefore dropped,
with at best a stuck busy card. This is the most plausible reading of "it just does not respond", and it
is a UI-layer fix.

### 3.6 Unavoidable versus artefact

| Component | Class |
|---|---|
| One cloud round trip per user-visible write (select, action) | unavoidable |
| Gateway store reads, policy, connector to T3 hop | unavoidable, shortenable (snapshot single-flight cache) |
| Full handshake per request | artefact (no reuse, no resumption) |
| SSE teardown and reconnect per burst; waiting out a doomed SSE handshake | artefact of the single-session lease |
| Five-resource reconcile after each preemption | artefact |
| Requests 4 to 6 in path B, serialised on a 100 ms tick | artefact; the three could be one response |
| Blank list on Threads entry; loading card on Reply open | artefact (data is on the device) |
| Dropped taps during a job | defect |
| 600 ms picker debounce | intentional |

## 4. Toolchain facts that constrain the options

1. **The single-session constraint is an allocator choice, not silicon.** `INTERNAL_MEM_ALLOC` pins the
   two ~17 KB record buffers to internal RAM, while 8 MB of PSRAM is present and `SPIRAM_USE_MALLOC`
   is on. IDF's own `MBEDTLS_DEFAULT_MEM_ALLOC` behaviour (plain `calloc`, which spills allocations
   over 4096 bytes to PSRAM) is reproducible at run time:
   `mbedtls_platform_set_calloc_free(calloc, free)`, called once at boot before any TLS object exists.
   No sdkconfig change or core rebuild. Caveats: it is process-global (every mbedTLS user, though only
   TLS clients exist here); free must pair, so it must run before the first allocation; bulk AES-GCM
   and SHA on PSRAM-resident buffers go through the DMA drivers' external-memory path, which IDF
   supports for its own `EXTERNAL_MEM_ALLOC` option but which is **unproven on this board**; flash
   writes (OTA, NVS) stall PSRAM access; large-allocation latency is higher than internal. Small
   objects (bignum limbs, handshake structs, under 4 KB) stay internal, which is the performance-
   sensitive part. Expected effect: per-session internal RAM falls from about 34 KB to a few KB.
   Whether two sessions then coexist safely is read off `[tls-heap]`, not assumed.
2. **Resumption needs a seam, and the seam exists.** `setPlainStart()` makes `connect()` stop after
   TCP connect and `mbedtls_ssl_setup()`; `startTLS()` then runs the handshake. `sslclient` is a
   `protected` `shared_ptr<sslclient_context>`, so a subclass (the firmware already subclasses for
   `YieldingClient`, `GatewayHttp.h:12-31`) can call `mbedtls_ssl_set_session(&sslclient->ssl_ctx, ...)`
   between the two, and `mbedtls_ssl_get_session()` after. The subclass overrides the virtual
   `connect(const char*, uint16_t, int32_t)` that `HTTPClient` calls. A resumed handshake skips
   certificate verification and key exchange (the saved verify result is restored, so
   `ssl_starttls_handshake`'s check still passes) and saves one network round trip. It does not
   reduce RAM: `ssl_setup` still allocates the full buffers. Open points: whether
   `mbedtls_ssl_config_defaults` enables client tickets by default in 3.6.6 (believed yes; log
   `session->ticket_len` after the first handshake to see), whether Cloudflare issues and accepts
   tickets for this client and how long they live, and where the serialized session (about 2 to 3 KB
   with `KEEP_PEER_CERTIFICATE=y`) lives. It must be invalidated on gateway URL change, credential
   realm change, any handshake failure, and OTA.
3. **No TLS 1.3, no `max_fragment_length` tuning, no asymmetric lengths**: all prebuilt. Options that
   depend on them are out without a core build.
4. **Zero-copy keep-alive is a client-lifetime change, not a flag.** `HTTPClient` already advertises
   keep-alive and will reuse a connected client (`HTTPClient.cpp:1074-1085`), but only if the same
   `WiFiClientSecure` object outlives the request. Today it is a local in `request()`.

## 5. Options

Savings are per request unless stated. "S/M/L" are relative implementation sizes, not schedules.
Constraint columns refer to: **32K** (one session), **task** (no new permanent task or stack),
**lock** (state lock and TLS gate never wait on each other), **gen** (late result cannot overwrite a
newer selection), **realm** (nothing widens device authority).

| # | Option | Expected saving | Cost | Risk and constraint check | Gate |
|---|---|---|---|---|---|
| O1 | **Local-first reads** (stale-while-revalidate for Threads list and Reply; pending-confirmation paint for writes) | Perceived latency of Threads entry and Reply open drops to a repaint; no change to wire cost | S to M, UI plus a small client accessor | 32K: none. task: none. lock: none. gen: reuse `navigationGeneration` / `contextGeneration_` / `responseGeneration_`; a stale revalidation must be discarded exactly as `fetchResponsePage` does (`GatewayOperate.cpp:938-942`). realm: none. Hazard: an optimistic **binding** that later fails would show thread B while the gateway still routes to A and a voice note goes to the wrong thread. So paint optimistically, bind only on confirmation (the picker already does this: `pickerBinding`/`pickerPending`), and keep Send and Talk disabled while pending | none; do first |
| O2 | **Never drop a tap**: depth-one latest-wins pending job, or refuse with visible feedback before navigating | Removes the "does not respond" mode | S | task: still drained by `uiNetworkLoop`. gen: pending job carries the generation it was created under and is discarded if it no longer matches | confirm by logging `enqueueUiNetworkJob` rejections |
| O3 | **Interaction-aware scheduling**: while a touch is down or within ~1.5 s of a tap, defer scheduled background polls; skip `markOperateDue` after a *deliberate* preemption | Cuts head-of-line blocking; stops reconcile chains | S | lock: no new waits. Risk: staleness bounded by the deferral | idle request rate, tap queue wait |
| O4 | **Collapse the post-select follow-ups** (config, controls, approvals) into the select response or one bundle route; single-flight 1 to 2 s gateway cache for device snapshot reads | Path B 7 R to 3 R; path A server time down by one T3 trip when bursts overlap | M, additive gateway change plus firmware parse; keep old routes | realm: the bundle must be exactly the union of what the three routes already return to this device, no more. Store parity untouched (no store method). Cache must be keyed by environment and never shared across users | server per-route timings |
| O5 | **TLS session resumption** via the STARTTLS seam | Saves the public-key CPU and one round trip per handshake after the first. Size depends on CPU share of H (unmeasured) | S to M (one subclass, session slot, invalidation rules; applies to every board since the client is shared) | 32K: unchanged (full buffers still allocated). lock: unchanged. realm: resumption reuses a session the device authenticated; the device secret is still sent per request in headers. Failure mode: a bad resumption must fall back to a full handshake rather than fail | split H into network and CPU; confirm tickets issued |
| O6 | **mbedTLS buffers in PSRAM** (runtime allocator) | No latency by itself. Makes a second concurrent session plausible, which lets the SSE stay up while a foreground request runs | S to code, M to qualify | 32K: relaxes it, but the gate stays until measured. Needs flash-write stall and DMA-from-PSRAM checks. If it destabilises the radio or display, revert is one line | `internal_largest` with and without it |
| O7 | **Persistent HTTP session** (hold one client alive between requests; share it across `GatewayClient`, `GatewayBrowse`, voice) | Removes the handshake from most requests: tap latency becomes one round trip plus server time | M to L | 32K: the idle session holds the 34 KB (or less with O6) permanently. lock: other TLS users (OTA, media upload, probe, different hosts) must `release()` it under the gate before their own handshake. Server or NAT can close it silently; retry once on first-byte failure, safe because writes already carry `clientRequestId`. Cannot coexist with an SSE socket under 32K | O5 result, O6 result |
| O8 | **Drop the SSE**, poll only | Frees the second session entirely, removes reconnect churn and the reconcile chain; loses sub-second console-to-device propagation | S | Becomes the natural pair for O7. Staleness bound = poll interval (5 s display, 30 s others) unless intervals are tuned | idle rate; owner acceptance of staleness |
| O9 | **Device WebSocket** carrying events and request/response | One TLS session, no lease fight, handshake only at connect, true push | L, see 5.1 | See 5.1 | all of the above |
| O10 | Content-carrying events (extend the `threads.changed` pattern to display, controls, approval counts) | Removes the pull after a push | M | Only pays off once a persistent connection exists (O7 plus push channel, or O9). Under the current lease it still preempts | after O9 or O6 |
| O11 | Cheap per-connection waste: parse the pinned CA once (reuse a decoded chain instead of two PEM parses per connect), cache DNS result, drop the empty `NEXT` root when unset | Tens of ms per handshake, estimate | S | Core's `start_ssl_client` takes a PEM string, so true reuse needs the same seam as O5 (`setCACertBundle`/pre-parsed chain); low priority | handshake phase timing |
| O12 | Prefetch on intent: while the picker settles or a screen that implies a next request opens, warm the next read into the local cache | Hides one round trip in common flows | S, on top of O1 | Must not add background traffic that recreates 3.4; rate budget (120 read, 30 write per minute) | O1 |

### 5.1 The WebSocket, evaluated honestly

**What it fixes.** One persistent TLS session replaces SSE plus per-request sessions. Taps stop
tearing anything down. Push arrives on the same connection that carries requests, so it can carry
content and end trigger-then-pull. The lease fight disappears for interactive traffic.

**Where the coordinator's reframing holds.** Memory is a reason to prefer one long-lived session, not a
reason against it. The design today allocates and frees a ~34 KB internal block roughly every few
seconds, which is the fragmentation generator, and it needs two sessions at once whenever a tap lands.
A WebSocket allocates its buffers once, early, while the heap is least fragmented.

**Where it needs qualification.**
- It does not remove the second-session cases. OTA download (`GatewayOta.cpp`), raw media upload
  (`MediaUpload.cpp`, `GatewayVoice.cpp`), the gateway probe (`gatewayProbe.cpp`) and `GatewayBrowse`
  each build their own client. Either all of them move into the socket (binary upload frames, firmware
  stream, which is a protocol redesign) or the socket is closed for each, with a handshake to reopen.
  The lease and quiet-window machinery survives, just exercised rarely.
- A single session is a single point of failure for interactivity. A half-open socket is not detected
  by lwip's default keepalive (hours); `ssl_client.cpp` sets `SO_KEEPALIVE` but the effective idle is
  far longer than the 25 s SSE heartbeat (`events.mjs`). It needs an application ping and a dead-peer
  timer like the SSE's 90 s byte timeout (`GatewayClient.cpp:688`). Cloudflare closes idle WebSockets and
  tells integrators to implement keepalive (docs: "Network, WebSockets, Connection limits"); the exact
  idle period is not stated there.
- Revocation and rotation. Today every request re-authenticates (`authenticateDevice`, `app.mjs:7945`
  area), so revocation, credential staging and transfer reset take effect on the next request. A socket
  authenticated once at upgrade must be closed by the gateway on revoke, rotation and transfer, and each
  frame must still be rate limited. This is the realm boundary and must not be skipped.
- Idempotency is already solved: `clientRequestId` envelopes make a retry across a reconnect safe, so a
  dead socket does not create a new correctness hole. Responses must be matched by request id and
  checked against the generation they were issued under, same as `fetchResponsePage`.

**Gateway side.** There is no device WebSocket. The device realm is HTTP plus SSE at
`/v1/device/events` (`app.mjs:4305`). `handle()` is one 8,300-line `if` chain over `req`/`res`
(CLAUDE.md), so the lowest-duplication design is frames of `{id, method, path, body}` dispatched through
`handle()` with a synthetic request/response pair, so auth, rate limiting, policy and idempotency are
the existing code. Two hosting choices:
- *Terminate in the Node gateway in the Container.* The private Worker already forwards with
  `container.fetch` (`cloudflare-control-plane/src/handler.ts:63`), and Cloudflare documents `fetch` as
  the only Container method that proxies WebSockets. Whether an Upgrade survives edge Worker, service
  binding, private Worker and Container intact is **untested here**. It also pins a Worker request open
  per device, against `max_instances = 1` and a capacity budget (`docs/capacity-slo.md`) that never
  qualified long-lived device sockets.
- *Terminate in a hibernatable Durable Object per device* (the connector hub pattern,
  `cloudflare/src/hub.ts`), which keeps idle sockets cheap and handles ping/pong without waking, but
  adds a new DO class, a push path from the Container to the DO (an outbound-host binding like
  `connector-router.internal`), and a per-frame call back into the Container.
Either is a new component with new capacity qualification, and neither is in the current deploy.

**Device side.** No WebSocket library is in `lib_deps`. Options are the RFC 6455 client written by hand
over the same `HTTPClient` GET-then-`getStreamPtr()` pattern the SSE already uses (`Sec-WebSocket-Accept`
needs SHA-1 and base64, both in mbedTLS; client frames must be masked; ping/pong; close), or a new
dependency. It must run in an existing task: the `gwevents` task has 6144 bytes of stack
(`GatewayClient.cpp:615`) and would own the socket, while UI jobs run in `gwnet`, so sends from `gwnet`
need a mutex and a request-id to completion map. `request()` keeps its signature (code plus body) so
callers are untouched, with HTTP as the fallback when the socket is down; that keeps older gateways
working. Realistically a few hundred lines of new firmware that has to be proven on silicon alongside the
existing watchdog and lock-ordering lessons (CLAUDE.md, `test/firmware-request-locks.test.mjs`).

**Verdict.** Right end state if per-request connection cost still dominates after cheaper steps, and the
only option that gives true push on one session. It is not the first step: most of the benefit it
promises (no handshake per tap, no lease fight on the tap path) is available from O5 plus O6 or O7 plus
O8 with an order of magnitude less new surface and no new server component, and O1 to O4 do not depend
on the transport at all.

## 6. Measurements, and what static reading cannot settle

Instrument first (the bench build already defines `TLS_SESSION_DIAGNOSTICS`, `build_overrides.py`).
Per request, log with `millis()`: touch-up to job start (queue wait), TLS gate wait, DNS, TCP connect,
CA parse, handshake, request to first byte, body read, teardown; and per SSE cycle: connect time,
established duration, exit reason. Server side, per route: authenticate, rate limit, store reads, snapshot
hop, total (the existing telemetry binding and `docs/cloud-observability.md`).

| Question | Why it matters | Decides |
|---|---|---|
| Idle requests per minute and SSE connects per minute, 5 minutes, no touch | Confirms or kills the reconcile-chain prediction (3.4) | whether O3/O8 come before anything else |
| Fraction of time the SSE is established | Value of any push work | O8 versus O10 |
| Touch-up to job-start wait, distribution | Head-of-line blocking size | O3 |
| `enqueueUiNetworkJob` rejections during normal use | Dropped taps | O2 |
| H split: TCP, TLS CPU, TLS network | Resumption benefit | O5 |
| `internal_largest` at `foreground.begin`, `events.begin`, with and without PSRAM allocator | 17 KB versus 34 KB binding, headroom for two sessions | O6, O7 |
| Whether `ticket_len > 0` after a handshake; whether a second connect resumes; ticket lifetime | Cloudflare and mbedTLS behaviour | O5 |
| Which chain the edge serves (cross-signed R4, P-384 or RSA verification) | CPU share, root list trimming | O11 |
| Server time for `thread-output`, `config/thread`, `threads`, `actions/run` | How much is cloud and connector, not the device | O4 |
| Wi-Fi RTT to the edge, packet loss | Round-trip share of H | everything |

Not determinable by reading: any latency figure; whether the SSE reconcile chain actually repeats; the
cipher suite and chain served; ticket support; PSRAM-resident TLS behaviour under flash writes and
radio load; whether a WebSocket Upgrade passes the Worker, service binding and Container path; Cloudflare's
WebSocket idle period; hosted capacity for long-lived device sockets. Also unverified: that fixing
transport removes "does not respond"; if O2's rejection counter is non-zero that symptom has a separate
cause.

## 7. Recommended sequence

Cheapest first, each step gated by a number from section 6.

**Now (no transport change, low risk):**
1. **O1 + O2.** Seed the Threads screen from the warm `gw->thread()` list instead of clearing it
   (`GatewayClient::refreshThreads` can retain the `destinationSelection`/`environmentId`/`projectId`
   the gateway already returns at `app.mjs:3697-3703`, so a commit is permitted before revalidation;
   the commit still validates against the live snapshot server-side and 404s a vanished thread). Keep
   the last Reply per thread and render it with an age while revalidating. Make writes paint a pending
   state and bind only on confirmation. Queue or visibly refuse a tap instead of dropping it. Do not
   clear `threads_` in `clearContextBinding`.
2. **O3.** Defer scheduled polls near a touch; stop turning a deliberate preemption into a five-resource
   reconcile.
3. **Instrumentation** (section 6) lands with these; it is what makes the rest decidable.

**Next (gated on the measurements):**
4. **O4**, server-only and additive: snapshot single-flight cache and the select-response bundle. Gate:
   server timings show the T3 trips or the three follow-ups are a meaningful share.
5. **O5**, resumption. Gate: H's CPU-plus-extra-round-trip share is large enough (a rough threshold
   is 150 ms saved per handshake) and tickets are issued. **O6** as an experiment in the same build,
   behind a compile flag, measuring only; do not relax the TLS gate yet.

**Only if needed:**
6. **O8 + O7** (poll-only persistent session) if O5 and O6 leave per-request cost dominant and owners
   accept bounded staleness; or relax the gate to two sessions if O6 shows safe headroom, keeping SSE up.
7. **O9/O10** (WebSocket and content-carrying push) only if sub-second console-to-device latency is a
   product requirement that O6-with-SSE cannot meet, after a staging spike proves the Upgrade path and
   capacity for long-lived device sockets.

## 8. The single first change

Make the Threads screen and the Reply screen local-first, and stop dropping taps (step 1).

It is the change that most directly answers the report, because the screens the owner names are blank
or "loading" for the entire cost of the slowest components (two to seven handshakes, up to five cloud and
connector trips), and the data to paint them is already on the device. It is independent of every open
question in section 6, touches no TLS code, cannot worsen the memory constraint, preserves the
confirm-before-bind rule for writes, and the generation guards it depends on already exist. Resumption
(O5) is the best *transport* change and the best second step; it is only worth building once the H split
shows the CPU share, which is one afternoon of logging away.
