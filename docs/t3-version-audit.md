# T3 Code contract audit: 0.0.32 → 0.1.1 → 0.1.5

Audit date: 2026-10-30. Scope: every T3 Code assumption written down in [CLAUDE.md](../CLAUDE.md),
[the capability manifest](t3-capability-manifest.md), [the work graph](t3-work-graph.md), and the
code in [`src/t3Ws.mjs`](../src/t3Ws.mjs), [`src/t3Client.mjs`](../src/t3Client.mjs),
[`packages/connector/src/t3.mjs`](../packages/connector/src/t3.mjs) and
[`packages/connector/src/t3v2.mjs`](../packages/connector/src/t3v2.mjs).

The verdict tables (sections 2 to 4) describe the contracts and this repository **as audited on
2026-10-30**. Code changes made in response are tracked in section 8, not retro-fitted into the
tables.

Every finding here is read from shipped artifacts. **No T3 server was started or called, and no
0.1.5 server has been observed at all.** "The bundle says" is never "the server does". Section 7
lists exactly what that leaves unproven.

## 0. Headline findings

1. **The source-map method is dead, but the contract is still readable, and better than before.**
   The 160 MB `t3` executable embeds the server's whole JavaScript bundle as one plain, unminified,
   comment-bearing text blob (identifiers, `//` source-path markers, and TypeScript doc comments
   survive). That is the server's schemas *and handlers*, not just the client's view of them. Section
   5 gives the exact extraction command. This replaces both the source map and the minified client
   assets as the primary evidence source.
2. **`ProviderApprovalDecision` is five values, not four.** `acceptAlways` exists in 0.1.1 and 0.1.5
   (absent in 0.0.32). Approval requests also now carry their own `options[]` naming which decisions
   that provider accepts. [`PROVIDER_APPROVAL_DECISIONS`](../src/providerApprovals.mjs) could express
   neither when audited; the response is in progress (section 8).
3. **`thread.activities[]` does not exist on the protocol-2 wire.** The `task.*` / `tool.*` activity
   lifecycle that [`src/agentVerb.mjs`](../src/agentVerb.mjs) and `frontend/src/workGraph.ts` read is
   replaced by `nodes[]`, `subagents[]` and typed `turnItems[]`. The connector's `v2Thread()` only
   synthesises approval and user-input activities, so under protocol 2 those consumers have no
   input. (Inferred by reading `v2Thread`; not run.)
4. **The direct (non-connector) transport cannot work against 0.1.x.** `POST
   /api/orchestration/dispatch` and `GET /api/orchestration/snapshot` are not in the 0.1.1 or 0.1.5
   route tables, and `/ws` answers `426 orchestration_protocol_incompatible` to any client that does
   not send `orchestrationProtocol=2`. [`src/t3Ws.mjs`](../src/t3Ws.mjs) never did. The compatibility
   gate in [`src/t3Compatibility.mjs`](../src/t3Compatibility.mjs) said
   `maximumTestedVersion: "0.0.32"`. Both have since been changed (section 8).
5. **No removal affects the two RPCs we call**, `orchestration.dispatchCommand` and
   `orchestration.subscribeThread`, between 0.1.1 and 0.1.5. One method was removed
   (`orchestration.subscribeArchivedShell`, unused by us), three were added, and
   `ModelSelectionWire` / `optionDescriptors` are byte-for-byte unchanged apart from a new `fx`
   driver kind and a changed default Claude model slug.

## 1. Evidence base

| Version | What was read | Fidelity |
|---|---|---|
| 0.0.32 | `/opt/homebrew/lib/node_modules/t3/dist/bin.mjs.map` (`sourcesContent`, 397 non-vendored files incl. `packages/contracts/src/*.ts`) and the bundled `node_modules/effect` (4.0.0-beta.103) | Original TypeScript |
| 0.1.1 | Server bundle embedded in `~/.t3/runtime/versions/0.1.1/t3`; `client/assets/*.js` (755 files) | Compiled, unminified server; minified client |
| 0.1.5 | Same layout under `~/.t3/runtime/versions/0.1.5/` (installed 2026-10-30 15:38; 936 client JS files) | Same |

SHA-256 of what was read, so the audit can be reproduced against the same bytes:

| File | SHA-256 |
|---|---|
| `0.1.1/t3` | `6d83d2947ed0190e34b428a17ccf87c086fbc81eee3c7588a73d6ebdc0ba0e70` |
| `0.1.5/t3` | `e9e35177eced3386395d5a833bb634795f5d9b5765fe0651d985b9cae2955084` |
| extracted bundle 0.1.1 | `ab1bf45226f3eaa3b653829f0afa73b68a71c0547f299eea4bfb548b6d403bf6` |
| extracted bundle 0.1.5 | `7bbfd926e3de295dd34bc9c029355c1a7240a6c1c5cc3ddf708c4efb53b3c222` |
| 0.0.32 `bin.mjs.map` | `1b6d331a16389865061c54dbfc143bf37c7c5d59541c5c3c1eb3c9f4e2731d71` |

Citation format: `bundle-0.1.5.js:408440` is a line in the file produced by the section 5.2 script
(deterministic: the hashes above are of that output). `0.0.32:orchestration.ts:134` is a file and
line inside the source map. Contract citations point at the schema definition in the bundle, not at
a generated file name: the bundler hoists `var` declarations, so region markers attribute some
contracts to the wrong source file (for example `ProviderApprovalDecision` sits under a
`threadPullRequest.ts` marker). Grep the whole bundle; do not trust the file split for ownership.

`orchestration.execute`, which the client references, is **not** an RPC tag. It is a span label in
`client/assets/queries-*.js` (`label: ...orchestration:thread-transcript, execute: ...`). It is in
neither server method table.

## 2. Assumption verdicts

Verdicts: **HOLDS**, **BROKEN**, **CHANGED** (still works, but the documented statement is no longer
accurate), **UNDETERMINED**. Unless a version is named, 0.1.1 and 0.1.5 were both checked and agree.

### 2.1 Transport and envelope

| # | Assumption (where stated) | Verdict | Evidence |
|---|---|---|---|
| T1 | `GET /api/orchestration/snapshot`, `POST /api/orchestration/dispatch` exist (CLAUDE.md "Agent harnesses"; `src/t3Client.mjs:66,130`) | **BROKEN** | 0.1.5 orchestration HTTP table is exactly `shell`, `threads/:threadId`, `threads/:threadId/transcript`, `/bounded`, `/history` (`bundle-0.1.5.js:42414-42437`; 0.1.1 `bundle-0.1.1.js:37605-37630`). No `snapshot`, no `dispatch`. Every route declares header `x-t3-orchestration-protocol: "2"` (`bundle-0.1.5.js:42084`) |
| T2 | `GET /api/orchestration/threads/:threadId?turnLimit=N` returns `{thread}` with `activities[]` (`src/t3Client.mjs:103`, `src/agentVerb.mjs:25`) | **BROKEN** | The route survives but returns `OrchestrationV2ThreadDetailSnapshot` (`{snapshotSequence, projection, ...}`), declares no query schema (so `turnLimit` has no meaning), and the projection has no `activities` field (`bundle-0.1.5.js:38821-38840`) |
| T3 | `POST /api/auth/websocket-ticket` returns `{ticket}`; `ws://host/ws?wsTicket=...` (CLAUDE.md "T3 WebSocket API") | **HOLDS** for the ticket; **BROKEN** for the upgrade unless `orchestrationProtocol=2` is added | Ticket route `bundle-0.1.5.js:42340`. Upgrade handler returns HTTP 426 `orchestration_protocol_incompatible` when the query param is not `2` (`bundle-0.1.5.js:406750-406752`, `408438-408442`; 0.1.1 `bundle-0.1.1.js:394726`, `396309`). The check runs before authentication. The connector's `t3SocketUrl()` adds the param for protocol 2 (`packages/connector/src/t3.mjs`); `src/t3Ws.mjs:58-63` does not |
| T3b | Tickets carry no audience | **CHANGED** | 0.1.5 adds `POST /api/auth/websocket-ticket/:use` with `use` in `rpc \| media` (`bundle-0.1.5.js:29459`). The un-suffixed route still issues an audience-less ticket, and `authenticateWebSocketUpgrade` only rejects when `session.audience !== undefined && !== use` (`bundle-0.1.5.js:145559-145565`), so the old call keeps working. DPoP-bound tickets additionally need a proof |
| T4 | RPC messages are `Request`/`Exit`/`Chunk`/`Defect` with `Ack`, `Interrupt`, `Ping`/`Pong`, `Eof` (CLAUDE.md; `src/t3Ws.mjs` header) | **HOLDS** | Effect 4.0.5 in both (`bundle-0.1.5.js:184690-184705` message constants; `185450` `RpcServer.js`). The `/ws` handler provides `layerJson` (`bundle-0.1.5.js:408460`): one JSON message per frame, as the gateway sends it |
| T5 | Every streamed `Chunk` must be `Ack`ed or the stream stalls | **HOLDS** | Per-request latch is closed after each `Chunk` write and awaited (`bundle-0.1.5.js:185697-185706`; 0.1.1 `177382-177391`); `Ack` opens it (`bundle-0.1.5.js:185532`). Citation drift: CLAUDE.md cites `effect/dist/unstable/rpc/RpcServer.js:271-291`, which is the 0.0.32 / effect `4.0.0-beta.103` path. 0.1.x bundles `effect@4.0.5` and the module is `effect/dist/rpc/RpcServer.js` |
| T6 | `Ping` is answered with `Pong` | **HOLDS** | `bundle-0.1.5.js:185890`; 0.1.1 `177575` |
| T7 | An unknown tag arrives as `{_tag:"Defect","defect":"Unknown request tag: …"}` (CLAUDE.md) | **CHANGED, and imprecise at every version** | An unknown *method* tag is answered per request through `sendRequestDefect` (an `Exit` carrying a die cause): `bundle-0.1.5.js:185881`, and in 0.0.32 `effect/dist/unstable/rpc/RpcServer.js:469`. Only an unknown *message* `_tag` produces the top-level `Defect` (`185553`). `callRpc` treats a non-`Success` `Exit` as `T3_RPC_FAILED`, so removed methods (M5) surface as failures, not defects |

### 2.2 Streaming and resume

| # | Assumption | Verdict | Evidence |
|---|---|---|---|
| S1 | The resume cursor is the event's global `sequence` | **HOLDS** | `latestAgentSequence` is `MAX(sequence)` over `orchestration_events` for the thread's stream (`bundle-0.1.5.js:64620-64627`); stream items carry `sequence` (`OrchestrationV2ThreadStreamItem`, `bundle-0.1.5.js:40285+`) |
| S2 | `THREAD_RESUME_MAX_GAP = 1000` bounds replay (`src/ws.ts:307`; CLAUDE.md) | **BROKEN** | The identifier does not exist in 0.1.1 or 0.1.5. Thread replay is now decided by: cursor ahead of head, or more than **128** events, or more than **1 MiB** raw payload (`THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES = 1048576`), or a recreated thread, each of which yields a fresh snapshot (`bundle-0.1.5.js:407152-407176`, `decideThreadResume` `370513`; 0.1.1 `395124-395139`, `378690`). `SHELL_RESUME_MAX_GAP = 1e3` survives for the **shell** stream, plus an 8 MiB replay budget (`bundle-0.1.5.js:407045-407046`) |
| S3 | An unfillable gap is answered with a snapshot, not an error | **HOLDS** | `snapshotThenLive()` in every branch above |
| S4 | The live subscription overlaps the replay by design | **UNDETERMINED** | `withLiveDedupe` and `coalesceLiveUpdatedEvents` exist (`bundle-0.1.5.js:407152+`), so the overlap is handled, but the attach-then-drain ordering was not traced. Note that replay now *coalesces* repeated `*.updated` events, so a replayed stream can omit intermediate message states |
| S5 | `streaming: true` messages are a delta (CLAUDE.md "live thread stream") | **CHANGED** | Protocol 2 messages are absolute text with a `streaming` flag; `t3v2.mjs` already converts to a suffix delta and rejects non-prefix updates as `T3_STREAM_RESET_REQUIRED`. Not re-verified live on 0.1.5 |
| S6 | `afterSequence` resume is exercised | **Moot on the connector path** | `openThreadStream()` for protocol 2 passes `afterSequence: undefined` and so always takes the snapshot branch (`packages/connector/src/t3.mjs`). The contract still accepts the field |

### 2.3 Approvals, questions, work

| # | Assumption | Verdict | Evidence |
|---|---|---|---|
| A1 | `ProviderApprovalDecision` has four values (CLAUDE.md "Two kinds of approval"; `src/providerApprovals.mjs:102`) | **BROKEN** | `accept, acceptForSession, acceptAlways, decline, cancel` (`bundle-0.1.5.js:36665-36671`; 0.1.1 `31403`). 0.0.32 had four (`0.0.32:orchestration.ts:134-139`). **No sixth value appeared in 0.1.5.** `acceptAlways` is first present in 0.1.1 |
| A2 | `acceptForSession` is "allow always" and the only persistent decision (`PERSISTENT_PROVIDER_APPROVAL_DECISIONS`) | **CHANGED, per provider** | Codex v2 folds `acceptAlways` into `acceptForSession` when it answers the provider (`bundle-0.1.5.js:307973,308022`) and maps both to `approved_for_session` (`304680-304681`). Muse maps scope `session` to `acceptForSession` and `localPersistent` to `acceptAlways` (`345629`). Codex MCP elicitation offers `acceptAlways` only when the elicitation allows persistence (`304372`). So `acceptAlways` is the durable grant for providers that distinguish it, and the policy capability split (`approval_response_persistent`) must cover it. Whether Claude v2 treats `acceptForSession` as a durable permission rule was not re-read for v2 |
| A3 | The provider approves/declines only from a fixed set of four | **BROKEN** | A pending approval now carries `options: [{decision, label, warning?}]` (`ProviderApprovalOption`), `fullAccessOverride: ask_rule \| provider_check` (new in 0.1.5), `reason`, `appName` and `requestKind` (`bundle-0.1.5.js:36673+`; turn item `38519`). `t3v2.mjs:v2RequestActivities` forwards none of them |
| A4 | `requestKind` is `command \| file-read \| file-change` (`src/providerApprovals.mjs:185`) | **BROKEN** | `ProviderRequestKind` is five values in 0.1.1/0.1.5: adds `mcp-elicitation` and `permission` (`bundle-0.1.5.js:36658-36664`). 0.0.32 had three (`0.0.32:orchestration.ts:130`) |
| A5 | Pending approvals are derived from `activities[]`: `approval.requested` opens, `approval.resolved`/stale-`respond.failed` closes | **BROKEN on protocol 2** | No `activities` on the wire. Pending state is `runtimeRequests[].status` in `pending \| resolved \| expired \| cancelled` (`bundle-0.1.5.js:38103`). The adapter re-synthesises legacy activities and treats any non-`pending`, non-`resolved` status as stale. The stale-phrase matching in CLAUDE.md is moot on this path |
| A6 | T3 accepts a response to a dead request and fails later | **UNDETERMINED** | Protocol 2 adds `responseCapability: live \| message \| not_resumable` on each runtime request and `commandType runtime-request.delivery.fail` (new in 0.1.5). The adapter ignores `responseCapability`; a `not_resumable` or `message`-only request may not be answerable through `runtime-request.respond`. Server behaviour on answer was not traced |
| U1 | `tool_user_input` is separate from approvals | **HOLDS** | Distinct runtime-request `kind: "user_input"`, distinct turn item `user_input_request`, distinct dismiss command `thread.user-input.dismiss` (`bundle-0.1.5.js:38103`, turn item `38476`, `thread.user-input.dismiss` in the command set) |
| U2 | Question shape is `options` (possibly empty) + `multiSelect` (CLAUDE.md "Three things can block a turn") | **CHANGED** | Questions add `allowCustomAnswer`, `initialAnswer`, `required`, and per-option `value` and `preview` (`bundle-0.1.5.js:38226-38240`). Which of `label` / `value` the server accepts as the answer token, and whether `allowCustomAnswer: false` rejects free text, was not determined. `src/userInput.mjs` validates against `label` only. A turn item may also carry `responseMode: "message"` |
| W1 | Work is observed through `task.started \| progress \| updated \| completed` activities (CLAUDE.md "T3-native agents"; `docs/t3-work-graph.md`) | **BROKEN on protocol 2** | 0.1.1 still defines the four literals in the provider-runtime schema (`bundle-0.1.1.js:32079-32082`); 0.1.5 no longer does (the strings survive only as `task.progress` in a logger allow-list, `bundle-0.1.5.js:272869`). Neither wire carries activities. The replacement is first-class: `subagents[]` (status `idle \| pending \| running \| waiting \| completed \| failed \| cancelled \| interrupted`, `progress`, `workflow`, `parentNodeId`, `childThreadId`, `nativeTaskRef`; `bundle-0.1.5.js:37843`) and `nodes[]` (`kind: root_turn \| assistant_message \| reasoning \| plan \| todo_list \| tool_call \| approval_request \| user_input_request \| subagent \| hook \| system`), with `subagent.updated` stream events. `t3v2.mjs:v2Thread` maps neither, so `agentVerb` and the work graph are empty/`running` under protocol 2 (inference from the code, not a run) |
| W2 | `classifyToolActivity()` mirrors T3's `classifyToolAction` over `tool.*` activities | **UNDETERMINED / likely dead** | `tool.started` etc. do not exist as wire rows in 0.1.x. Protocol 2 exposes typed `turnItems` (`command_execution`, `file_change`, `file_search`, `web_search`, `todo_list`, ...). A port would be a new classifier over those, not a patch |

### 2.4 Models, providers, scopes

| # | Assumption | Verdict | Evidence |
|---|---|---|---|
| M1 | `ModelSelectionWire = {instanceId, model, options?: [{id, value}]}` | **HOLDS in all three** | `0.0.32:orchestration.ts:66-70`; `bundle-0.1.1.js:30147`; `bundle-0.1.5.js:35783`. The decoder still accepts a legacy `provider` key and a legacy options object |
| M2 | A model declares switches via `capabilities.optionDescriptors` | **HOLDS in all three** | `0.0.32:model.ts:126`; `bundle-0.1.1.js:23152`; `bundle-0.1.5.js:28453`. `ProviderOptionDescriptor` is `select` (`options[{id,label,description?,isDefault?}]`, `currentValue?`, `promptInjectedValues?`) or `boolean` (`currentValue?`); `ProviderOptionSelection` is `{id, value: string \| boolean}`. A normalised diff of `model.ts` between 0.1.1 and 0.1.5 differs only in the `fx` driver (`FX_DRIVER_KIND = "fx"`, default model `"default"`) and in the default Claude slug |
| M3 | (not previously written down) default Claude slug | **CHANGED** | `claude-fable-5-1` in 0.1.1 (`bundle-0.1.1.js:23178`) → `claude-opus-5-5` in 0.1.5 (`bundle-0.1.5.js:28480`). Any code that relies on T3's default model rather than sending `modelSelection` will move |
| M4 | `server.getConfig` returns the authoritative `providers` catalogue with readiness, enabled/installed, auth | **HOLDS** | `ServerProvider` still has `enabled`, `installed`, `status` (`ready \| warning \| error \| disabled`), `auth.status` (`authenticated \| unauthenticated \| unknown`), `availability`, `unavailableReason`, `models[]` (`bundle-0.1.5.js`, `ServerProvider` struct). `requiresNewThreadForModelChange` was dropped in 0.1.5; nothing in this repo reads it |
| M5 | `server.getSettings` exists (`T3_WS_METHODS.serverGetSettings` in both `t3Ws.mjs` and `connector/src/t3.mjs`) | **BROKEN, harmless** | Present in 0.1.1 (`serverGetSettings: "server.getSettings"`), absent in 0.1.5. Nothing calls the constant. Delete it before something does |
| M6 | Scopes `orchestration:read`, `orchestration:operate`, `terminal:operate` | **HOLDS** | `bundle-0.1.5.js:29303`; required scope per RPC at `RPC_REQUIRED_SCOPES` (`bundle-0.1.5.js:401644`): `dispatchCommand`, `launchThread`, `stopWorkflow` need `operate`; `subscribeShell/Thread/CommandOutput`, `getThreadProjection`, `getTurnItem`, `server.getConfig`, `server.refreshProviders` need `read`; `terminal.open` needs `terminal:operate` (`bundle-0.1.5.js:401776`) |
| M7 | The v1 connector branch requests `orchestration:write` (`packages/connector/src/t3.mjs`, `exchangePairingToken`) | **BROKEN at every version** | `orchestration:write` is not a scope in 0.0.32 (`0.0.32:auth.ts:76-88`), 0.1.1 or 0.1.5. 0.0.32 rejects the whole exchange with `invalid_scope` (`0.0.32:packages/shared/src/oauthScope.ts:63-75`, `src/auth/http.ts:261-277`); 0.1.x silently drops unknown scopes (`bundle-0.1.5.js`, `.filter(is(AuthGrantScope))` in the `token` handler), so a v1 token would lack `operate`. CLAUDE.md's phrase "the v1 `orchestration:write` scope" named something T3 never defined. The protocol-2 branch asked for `operate` and was correct. **Fixed 2026-10-30, section 8** |
| M8 | `terminal.open` / `terminal.write` payloads | **HOLDS** | `{threadId, terminalId, cwd, worktreePath?, cols?, rows?, env?, providerInstanceId?}` and `{threadId, terminalId, data ≤ 65536}`; additive only. `terminal.restart` was removed in 0.1.5, unused here |

### 2.5 Statements in the capability-manifest doc that no longer hold

[`t3-capability-manifest.md`](t3-capability-manifest.md) records 0.0.32 as certifying "image
attachments only, at most 8 and 10 MiB each; audio and generic file attachments remain off". By
0.1.1 the contract has `ChatFileAttachment` (up to 50 MiB, `PROVIDER_SEND_TURN_MAX_FILE_BYTES =
52428800`), up to 100 attachments per message, images up to 10 MiB each and 80 MiB total, and
capability flags `attachmentUploads`, `questionAttachments`, `fileAttachments.maxUploadBytes`
(`bundle-0.1.5.js:27800-27817`, `ChatFileAttachment` `27898`, `ChatUnknownAttachment` `27907`). Audio is still absent, but unknown
attachment types are now accepted by the decoder (`ChatUnknownAttachment`), so "absent from the
schema" no longer implies "rejected". The doc's *design* (features are inferred from evidence, never
from the version string) is validated by this: the descriptor's `capabilities` object grew by about
ten optional flags between 0.1.1 and 0.1.5 (`peerLinks`, `linkFence`, `mcpModeLimitHeader`,
`triage`, `providerWorkspaceSnapshotsOnDemand`, `threadProjectFromScratch`,
`desktopAppChannelSwitch`, `localServerStop`, `databaseMigration`, `remoteUrl`).

## 3. RPC surface delta

Server method tables: `ORCHESTRATION_V2_WS_METHODS` (`bundle-0.1.1.js:35438`, `bundle-0.1.5.js:40161`)
and `WS_METHODS` (`bundle-0.1.1.js:49470`, `bundle-0.1.5.js:54590`, 186 tags in 0.1.5). The one-line
diff is reproducible with the command in section 5.2.

### 3.1 Orchestration methods

| Method | 0.1.1 | 0.1.5 | Ours | What it does | Matters here? |
|---|---|---|---|---|---|
| `dispatchCommand` | yes | yes | **yes** | Applies one `OrchestrationV2Command`; returns `{sequence}`. Requires `orchestration:operate` | Core. Command set is additive 0.1.1→0.1.5 (adds `delegated_task.remote.*`, `link_request.record`, `queued-run.start`, `runtime-request.delivery.fail`, `thread.guest-*`, `thread.project.adopt-folder`); every command `t3v2.mjs` emits still exists |
| `subscribeThread` | yes | yes | **yes** | Stream of `snapshot`, `event`, `synchronized`. New opt-in inputs in 0.1.5: `acceptDeferredWork`, `acceptDedupedBodies`, `acceptCompactIds` (plus `acceptCompactTurnItems`, `acceptBoundedSnapshot` from 0.1.1). Servers only apply them when sent, and the connector sends none beyond `acceptBoundedSnapshot` | Core. Removed in 0.1.5: the `payloadBudgetExceeded` snapshot field (unused here) |
| `subscribeShell` | yes | yes | via raw `callRpc` in `fetchSnapshot` | Project/thread shell stream. 0.1.5 adds opt-in `omitIdleSubagents`, `omitOlderSettled` | Used. Because we send neither flag, a 0.1.5 shell still lists every thread. Do not start sending them without also calling the methods below |
| `getThreadProjection` | yes | yes | no | **Unary** request/response returning one thread's `OrchestrationV2ThreadProjection` as a bounded window (`rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT`, `bundle-0.1.5.js:407820`). Needs `read` | **Yes.** `fetchThreadDetail()` currently opens `subscribeThread`, waits for the first snapshot, then sends `Interrupt` (`packages/connector/src/t3.mjs`). A unary call removes the subscription setup/teardown, the live dedupe, and the interrupt race. Equivalence of the two payloads was not diffed |
| `subscribeCommandOutput` | yes | yes | no | Live **shell-command output** for one `command_execution` turn item, input `{threadId, itemId}`, frames `{kind: replace \| append, text, truncated, running}`; 100 ms frame interval, 500 ms after overflow, 16 384-char append cap, 64 live / 16 finished tails (`bundle-0.1.5.js:159313-159319` onward). Advertised by capability `commandOutputStreaming`. Needs `read` | Narrower than it looks. It streams a Bash-style tool's stdout, **not** the assistant's reply: reply text streams as `message.updated` events on `subscribeThread`. Relevant only to a "what is the agent's command printing" view; not needed for reply streaming |
| `launchThread` | yes | yes | no | Atomic create-thread-and-send-first-message with `commandId`, `reuseExistingThread`, `workspaceStrategy`, `initialMessage`; result has `resumed` and (0.1.5) the commit `sequence`. Needs `operate` | Plausibly **yes** for `POST /v1/device/threads`: it is idempotent by `commandId` and removes the separate create-then-select race that CLAUDE.md describes. Not evaluated against our titling rules |
| `getTurnItem` | yes | yes | no | Fetch one turn item by `{threadId, itemId, revision?}`; needed because large `command_execution.output` is withheld (`outputOmitted`) | Needed if tool output is ever shown |
| `getTurnDiff`, `getFullThreadDiff` | yes | yes | no | Checkpoint diffs | Not needed |
| `searchThreads`, `searchThread`, `searchThreadStream` | yes | yes | no | Thread/message search | Not needed |
| `getWorkflowScript`, `stopWorkflow` | yes | yes | no | Read / stop a provider-native workflow (`stopWorkflow` needs `operate`; error reasons `not-running \| unsupported \| unavailable \| stop-failed`) | `stopWorkflow` is the first **per-task stop** control T3 publishes. [`t3-capability-manifest.md`](t3-capability-manifest.md) says no such control exists; for workflow children that is now false. Scope of "workflow" vs ordinary subagents not established |
| `getArchivedShellSnapshot` | yes | yes | no | Archived thread shell | Not needed |
| `subscribeArchivedShell` | yes | **removed** | no | Archived shell stream | Removed 0.1.5. Not used |
| `getThreadFamily`, `getWorktreeThreadIds`, `getOlderSettledThreads` | no | **added** | no | Companions to the shell's `omitIdleSubagents` / `omitOlderSettled` (capabilities `shellThreadFamilies`, `shellOlderSettled`) | Only if we adopt those opt-ins |

### 3.2 Non-orchestration tags used by this repo

`server.getConfig`, `server.refreshProviders`, `subscribeServerConfig`, `terminal.open`,
`terminal.write`, `terminal.attach`, `terminal.close`: all present in 0.1.5. `server.getSettings`:
removed (M5). The 0.1.1→0.1.5 `WS_METHODS` diff also removes `projects.add/list/remove`,
`scheduledTasks.list`, `server.getBackgroundPolicy`, `server.reportHostPowerState`,
`subscribeBackgroundPolicy`, `subscribeTerminalEvents`, `terminal.restart`, `preview.navigate`,
`preview.refresh`, and `provider.codex.auth-callback.subscribe`, and adds `peerLinks.*`,
`sourceControl.signIn*`, `guestShare.create`, `server.prepareTriage`, `projects.createFromThread`,
`device.simlockIdentity`, `pullRequests.filterOptions`, `preview.stopLocalServer`,
`sourceControl.appAccess`. None is referenced by this repo (grep of `src/`, `packages/connector/src`,
`scripts/`).

### 3.3 Why "the client uses 17" and "we implement 2" understates the dependency

The connector also reaches `orchestration.subscribeShell` through `callRpc` rather than a named
constant, so the real set in use is **three**: `subscribeShell`, `subscribeThread`,
`dispatchCommand`. The constant table in both `T3_WS_METHODS` objects does not list
`subscribeShell`; a rename would not be caught by a constants check.

## 4. Orchestration protocol version

| Fact | Evidence |
|---|---|
| Server advertises `orchestrationProtocolVersion: 2` in `/.well-known/t3/environment` in 0.1.1 and 0.1.5 | Descriptor schema `orchestrationProtocolVersion: optionalKey(Int)` (`ExecutionEnvironmentDescriptor`) and the served value `2` (`bundle-0.1.5.js:140431`); the field is optional, and **an absent field means 1** |
| The shipped client treats exactly `2` as compatible, `>2` as "not supported by this server", absent/`1` as needing an older client | 0.1.5 `client/assets/utils-Z26bPbM5.js`: `function lq(e){let t=e.orchestrationProtocolVersion??1;return t===2?null:t>2?...unsupported...}` |
| The client puts `orchestrationProtocol=2` on the WebSocket URL and `x-t3-orchestration-protocol: 2` on HTTP | `utils-Z26bPbM5.js`: `t.searchParams.set(Pme,`2`)` with `Pme=`orchestrationProtocol``; header constant `eE=`x-t3-orchestration-protocol`` |
| The T3 CLI itself refuses mismatches: "speaks protocol N, but this CLI speaks protocol 2" | `bundle-0.1.5.js:156588` |
| Our connector reads `orchestrationProtocolVersion ?? 1`, accepts `1` or `2`, throws `T3_PROTOCOL_UNSUPPORTED` otherwise, and appends `orchestrationProtocol=2` only for 2 | `fetchEnvironmentInfo`, `t3SocketUrl` in `packages/connector/src/t3.mjs` |

Conclusion: the negotiated `orchestrationProtocol=2` is **still correct for 0.1.1 and 0.1.5**, the
connector fails closed on a future protocol 3, and the protocol-1 branch can only talk to 0.0.x.
`databaseMigration` (new descriptor field, 72 in the 0.1.5 launcher's `package.json`) is an
independent compatibility signal that nothing here reads yet.

## 5. Replacement for the source-map method

### 5.1 Why it works

`t3` on npm is now a launcher (`bin/t3.mjs`, `dist/bin.mjs` is 101 bytes). It downloads
`t3-<version>-<platform>.tar.gz` (`.zip` on Windows) from
`https://github.com/pingdotgg/t3code/releases/download/v<version>/`, verifies it against that
release's `SHA256SUMS`, unpacks it to `~/.t3/runtime/versions/<version>/` (override with
`T3CODE_HOME`), marks it with `.install-complete`, and spawns `t3` there. That `t3` is a Node
single-executable application whose embedded script is the server's bundled ESM, stored verbatim
(shebang `#!/usr/bin/env node` to a trailing `export {};`) with no NUL bytes inside. The first
NUL-free run containing `ORCHESTRATION_V2_WS_METHODS = {` is the whole bundle. 0.1.5 additionally
shows `node-v26.12.1` source URLs inside the binary; 0.1.1's embedded Node version was not read.

### 5.2 Procedure

1. Get the runtime on disk **without starting a server.** Preferred, executes nothing:
   download `v<ver>/SHA256SUMS` and `t3-<ver>-<platform>.tar.gz` from the release URL above, compare
   the archive's SHA-256 with its `SHA256SUMS` line, then `tar -xf <archive> -C <new empty dir>
   --strip-components=1`. (This route is derived from reading `bin/t3.mjs`; it was not exercised by
   this audit, because both runtimes were already present.) Alternative that was used: `npx --yes
   t3@<ver> --version`, which runs the launcher and then the downloaded binary once.
2. Save the script below as `t3-extract.py` **outside** the extracted directory, and run it with
   `python3 -I` against the binary. It writes the bundle and optionally splits it by source-file
   marker comment.

   ```python
   #!/usr/bin/env python3
   """Usage: python3 -I t3-extract.py <path-to-t3-binary> <out.js> [<split-dir>]"""
   import os, re, sys

   ANCHOR = b"ORCHESTRATION_V2_WS_METHODS = {"   # any identifier unique to the server bundle works
   data = open(sys.argv[1], "rb").read()
   at = data.index(ANCHOR)                          # ValueError means the anchor was renamed; pick another
   start = data.rfind(b"\x00", 0, at) + 1           # the bundle is one NUL-free text blob inside the binary
   end = data.find(b"\x00", at)
   bundle = data[start:end]
   assert bundle.startswith(b"#!/usr/bin/env node") and bundle.rstrip().endswith(b"export {};"), "unexpected bundle bounds"
   open(sys.argv[2], "wb").write(bundle)
   print(f"{len(bundle)} bytes, {bundle.count(chr(10).encode())} lines")

   if len(sys.argv) > 3:                            # optional: split by source-file marker comments
       marker = re.compile(r"^(?://#region |// )((?:\.\./)*(?:src|packages)/[\w@./+-]+\.(?:ts|tsx|js|mjs))$")
       current, buf = None, []
       def flush():
           if current and buf:
               path = os.path.join(sys.argv[3], current.replace("../", ""))
               os.makedirs(os.path.dirname(path), exist_ok=True)
               with open(path, "a", encoding="utf-8") as handle:
                   handle.write("\n".join(buf) + "\n")
       for line in bundle.decode("utf-8").split("\n"):
           found = marker.match(line)
           if found:
               flush(); current, buf = found.group(1), []
           else:
               buf.append(line)
       flush()
   ```

   ```bash
   V=0.1.5
   python3 -I t3-extract.py ~/.t3/runtime/versions/$V/t3 ./bundle-$V.js ./src-$V
   shasum -a 256 ./bundle-$V.js            # 0.1.1 and 0.1.5 must match section 1
   ```

   Verified: this script reproduces the section 1 hashes for 0.1.1 (413 499 lines) and 0.1.5
   (426 818 lines). Marker format differs by version (`//#region <path>` in 0.1.1, `// <path>` in
   0.1.5), which the regex above covers; expect a third form eventually, and fall back to grepping
   the unsplit bundle. If the assertion fires, the executable layout changed: run
   `strings -n 8 <binary> | grep -c ORCHESTRATION_V2_WS_METHODS` and, if non-zero, find the bundle
   bounds by hand.
3. Read the contract from the **bundle**, by identifier. Commands used for this audit (tabs matter
   in the bundle, so match on `[[:space:]]`):

   ```bash
   B=bundle-0.1.5.js
   # RPC method tables, then the cross-version diff in one line each
   grep -nE -A20 '^[[:space:]]ORCHESTRATION_V2_WS_METHODS = \{' $B
   diff <(grep -E '^[[:space:]]+[A-Za-z]+: "orchestration\.' bundle-0.1.1.js | sed 's/^[[:space:]]*//' | sort) \
        <(grep -E '^[[:space:]]+[A-Za-z]+: "orchestration\.' bundle-0.1.5.js | sed 's/^[[:space:]]*//' | sort)
   # enums and schemas
   grep -nE 'ProviderApprovalDecision = Literals' -A7 $B
   grep -nE 'ModelSelectionWire = Struct|ModelCapabilities = Struct|OrchestrationV2SubscribeThreadInput = Struct' -A6 $B
   # protocol gate, scopes, resume policy, ack latch
   grep -n 'orchestration_protocol_incompatible' $B
   grep -n 'RPC_REQUIRED_SCOPES = {' $B
   grep -n 'function decideThreadResume' -A8 $B
   awk 'NR>185450 && NR<185800 && /latch\.(closeUnsafe|await)/ {print NR": "$0}' $B
   ```

   Handlers are in the same bundle: search for the RPC table key, e.g.
   `grep -n 'ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput\]' $B`, and read outward. Effect
   itself (RPC server, serialization) is bundled too, under `// ../../node_modules/.pnpm/effect@<v>/...`.
4. For the client's view (what the shipped UI sends or requires), grep the minified
   `~/.t3/runtime/versions/<ver>/client/assets/*.js` for the quoted identifier, for example `grep -o
   '.\{120\}orchestrationProtocol.\{200\}' utils-*.js`. Use it only to learn what *clients* assume.
   It cannot show server behaviour.
5. Write the result into this document: the verdict table, the section 1 hashes, and the date.

### 5.3 Do not

- Do not run the downloaded binary to "see what it says". Reading never needs it, and
  `t3 serve` opens ports and writes under `~/.t3`.
- Do not trust the `strings` output as a substitute: it drops lines shorter than the minimum length
  (all closing braces) and all indentation. It is fine for `grep -c`, not for reading. The
  extraction above is exact.
- Do not infer feature support from the version string. Read the capability flag or the schema.
- Do not cite line numbers without naming the version and the extraction.

### 5.4 Checks that would fail loudly on the next version (candidates for a script)

A future `npm run audit:t3` could extract a given version and assert, in about twenty lines: the
`ORCHESTRATION_V2_WS_METHODS` set contains `dispatchCommand`, `subscribeThread`, `subscribeShell`;
`ModelSelectionWire` has keys `instanceId, model, options`; `ProviderApprovalDecision` equals the
set this repo handles; the `/ws` handler still reads `orchestrationProtocol`; `orchestrationProtocolVersion`
is `2`; `RPC_REQUIRED_SCOPES` maps those three methods to `operate`/`read`/`read`. This audit did
not implement it.

## 6. Platform support matrix

The launcher's `SUPPORTED` list is exactly `darwin-arm64, linux-arm64, linux-x64, win32-arm64,
win32-x64` (`bin/t3.mjs`, 0.1.5), and any other `${process.platform}-${process.arch}` throws "no T3
Code CLI build is available". The connector mirrors it as `T3_CLI_PLATFORMS`
([`packages/connector/src/t3Process.mjs`](../packages/connector/src/t3Process.mjs)) and refuses with
`T3_PLATFORM_UNSUPPORTED` before touching ownership state.

| Platform key | T3 ≥ 0.1.x CLI | 0.0.32 (npm JS package) | Connector start-T3 | Consequence |
|---|---|---|---|---|
| darwin-arm64 | yes | node ≥ 22.16 + native `node-pty` | yes | Reference platform for this audit |
| **darwin-x64** (Intel Mac) | **no** | ran on any supported Node (`engines`: `^22.16 \|\| ^23.11 \|\| >=24.10`) | refused | An Intel Mac owner cannot run T3 ≥ 0.1.0 through the connector or `npx t3`. The T3 desktop app is the launcher's only suggested alternative. Whether a desktop build exists for Intel was not checked |
| linux-x64 | yes | yes | yes | |
| linux-arm64 | yes | yes | yes | Matches the packaged ARM64 voice qualification |
| win32-x64, win32-arm64 | yes | yes | yes | Windows launch path is bespoke (`npx-cli.js` + `node.exe`, no shell) |
| linux-arm (32-bit), ia32, freebsd, others | no | possible | refused | No path |

Consequences for this product:

- **Intel Mac owners have no managed T3.** The only fallback is a hand-started T3 plus
  `--no-start-t3`, and the only T3 an Intel Mac can run from npm is the 0.0.x JavaScript line, which
  is protocol 1. That path then hits M7: the connector's protocol-1 pairing requests a scope
  0.0.32 rejects outright. So, as audited, an Intel Mac could not enrol a pairing at all (source reading; not
  run); the scope was fixed afterwards (section 8) and that path is now unblocked in source and
  unproven in practice. The honest product statement is "Apple Silicon, x64/ARM64 Linux, x64/ARM64 Windows".
- The direct agents path ([direct-agents.md](direct-agents.md)) does not need T3 and is the natural
  answer for unsupported hardware. It is not a T3 substitute for the console's T3 features.
- **The connector now pins the T3 version it launches** (this was unpinned when first audited).
  [`packages/connector/src/t3Process.mjs`](../packages/connector/src/t3Process.mjs) exports
  `DEFAULT_T3_VERSION = "0.1.5"` and starts `npx --yes t3@0.1.5 serve ...`. An operator may set
  `NEXT_CODER_T3_VERSION` to one exact version (`0.1.4`, or a prerelease such as
  `0.1.6-nightly.20261029`); `latest`, ranges and URLs are refused with `T3_VERSION_INVALID`, so an
  override cannot float. The pin is resolved only on the launch path and for `auth pairing create`
  (which shares the launch's base directory, so it must be the same version). Reusing a T3 someone
  else is already running never consults it, so a hand-started or older T3 on the machine is still
  accepted and is judged by its own advertised protocol, not by the pin.
  Why it matters: this audit found that the contract moved materially inside the 0.1.x line. Between
  0.1.1 and 0.1.5 the thread-resume policy, the subscribe opt-ins, the descriptor capabilities and the
  default Claude slug all changed, and `orchestration.subscribeArchivedShell` and `server.getSettings`
  were removed, while 0.1.5 itself was published on 2026-10-29 with 0.1.6 nightlies already
  circulating (per the maintainer; not independently checked here). With no pin, a fresh install would
  have taken whatever release npx resolved that day, against a gateway qualified only on the versions
  in section 1. **An override is an unaudited T3**: only 0.1.1 and 0.1.5 were read, so 0.1.2 to 0.1.4
  and every nightly are unexamined, and changing `DEFAULT_T3_VERSION` should be done together with
  re-running section 5 against the new bundle. The pin makes the launched version deterministic; it
  does not make 0.1.5 verified (section 7).
- A first start downloads ~160 MB from github.com (checksummed), so offline or proxy-restricted
  hosts fail at first run, not at install. The connector already extends its ready timeout for that.

## 7. What is NOT verified

1. **No live observation of any version in this audit, and none of 0.1.5 at all.** The running
   server is 0.1.1 (reported by the maintainer; PID 1351 serving `127.0.0.1:3774`). 0.1.5 is
   installed and not serving. Every 0.1.5 statement is "the shipped bundle says".
2. **Bundle ≠ released artifact.** The extracted code is what is inside the files on this disk. That
   they equal what GitHub serves for those tags was not checked; the launcher verifies a SHA-256, but
   this audit did not re-verify the archive.
3. **Schema ≠ behaviour.** That a field exists says nothing about when the server fills it. In
   particular not determined: the answer token for questions (U2); whether `runtime-request.respond`
   works for `not_resumable` / `message`-only requests (A6); how the server treats a decision not in a
   request's `options`; whether `acceptAlways` and `acceptForSession` are distinguishable for
   Claude v2; whether `message.updated` text is still strictly prefix-extending at 0.1.5; the
   replay/live ordering (S4); whether `start_immediately` while a run is active only queues (the
   0.1.5 and 0.1.1 handlers set `shouldQueue = queueBehindRun !== undefined`, so the new message is
   queued behind the active run, `bundle-0.1.5.js:364645-364652`) and what the user-visible
   latency is; whether queued runs created with `creationSource: "server"` are ever released.
4. **The 0.1.1→0.1.5 contract diff was sampled, not read in full.** `orchestrationV2.ts` differs by
   669 normalised lines. Sampled and confirmed additive for the commands, domain events, thread
   projection and `message.dispatch` this repo touches; not read: the remaining ~600 lines (guest
   sharing, delegated tasks, link requests, secrets, scheduled tasks). The domain-event literal set
   compared equal between the two versions by a mechanical extraction; command sets differ only by
   the additions listed in section 3.1.
5. **Client assets were used only to learn client assumptions** (protocol gate, `execute` label,
   which methods the UI calls). The 755 / 936 minified files were grepped by identifier, not read.
6. **Platform.** Only darwin-arm64 binaries were opened. Linux and Windows builds were not
   downloaded; their parity with the darwin bundle is assumed from the launcher's single code path.
   Intel Mac behaviour of 0.0.x was not run.
7. **Code written in response to this audit is not evidence about T3.** The connector pin, the
   `src/t3Ws.mjs` protocol-2 negotiation and resume-limit change, the `acceptAlways` decision, the
   forwarding of per-request `options[]`, the `orchestration:operate` pairing scope and the
   tested/audited split in `src/t3Compatibility.mjs` were all made *because of* static findings in this
   document. Their tests run against stubs and captured fixtures, so a passing test shows the code
   matches our reading of the bundle, not that a running T3 behaves that way. **Superseded in part
   on 2026-10-30 by the live run recorded in section 9**; the limits stated there are what remains
   unobserved.
8. **Not re-examined:** firmware, Convex, the cloud connector hub (it relays whatever the connector
   projects), and the real effect of the `fx` driver or the default-Claude-model change on a
   production workspace.

## 8. Response status and remaining follow-ups

Status below was last updated 2026-10-30 from what was observable in the shared, moving working
tree (files read, not exercised against any T3). Re-check before relying on a "landed" line: it means
"present in the tree and covered by stub-based tests", never "proven against a running T3".

| Finding | Response | Status |
|---|---|---|
| Unpinned `npx t3` (section 6) | `DEFAULT_T3_VERSION = "0.1.5"`, `NEXT_CODER_T3_VERSION` exact-version override, `T3_VERSION_INVALID`; launch and pairing creation pinned, reuse path unpinned | **Landed** (read in `t3Process.mjs`) |
| T3 (direct WS), S2, T3 row | `src/t3Ws.mjs` negotiates `orchestrationProtocol=2` and exports `T3_THREAD_RESUME_LIMITS` (1000 events at protocol 1; 128 events / 1 MiB at protocol 2). `src/t3Transport.mjs` and `src/t3Client.mjs` select protocol 1 (HTTP) or 2 (WebSocket) per call from `/.well-known/t3/environment` and project protocol 2 through `src/t3Protocol2.mjs`, a deliberate copy of the connector's `t3v2.mjs` guarded by a parity test. `src/threadStream.mjs` comments now cite each bound by version | **Landed** (read in the tree). Tests use a fake T3 and fixtures; no live protocol-2 run of the direct path is recorded. This closes "Direct transport" in the follow-ups below |
| A1, A3, A4 | `acceptAlways` as the fifth decision, with its own capability (`approval_response_always`); T3's per-request `options[]` forwarded by `t3v2.mjs` into the gateway's per-request narrowing (`offeredDecisions`); the five request kinds | **Landed** (read in `src/providerApprovals.mjs`, `src/policy.mjs`, `src/profiles.mjs`). `fullAccessOverride`, `reason`, `appName` and `responseCapability` are still not mentioned in the stated scope (A6 stays open) |
| M7: `orchestration:write` pairing scope | `exchangePairingToken` in `packages/connector/src/t3.mjs` now requests `orchestration:read orchestration:operate terminal:operate` (`T3_PAIRING_SCOPES`) on both protocols. Evidence: `operate` is the only scope that guards dispatch at every version (0.0.32 `src/orchestration/http.ts` `dispatch` handler; `RPC_REQUIRED_SCOPES`, `bundle-0.1.5.js:401644`); 0.0.32 rejects unknown scopes with `invalid_scope` (`src/auth/http.ts:261-277`); a `t3 auth pairing create` credential carries `AuthStandardClientScopes`, a superset of the request, and the exchange demands a subset (`src/cli/auth.ts:98`, `src/auth/EnvironmentAuth.ts:697-700`); the remaining form fields (`client_device_type: "bot"`, grant and token types) are valid in 0.0.32. The gateway's own direct pairing already used read + operate | **Landed**, covered by a request-shape test. This was a scope-only fix; nothing else in the exchange needed changing. Protocol-1 pairing is still **unproven against a running 0.0.x**, and 0.0.28, the declared minimum, was not read at all (not installed) |
| `maximumTestedVersion` (section 0 item 4) | `src/t3Compatibility.mjs` splits the ceiling in two: `maximumTestedVersion` **0.1.1** (run live through the connector, and the production T3) and a new `maximumAuditedVersion` **0.1.5** (bundle read, never run). A release in between reports `review_required` worded "read, never run"; the recommended version stays 0.1.1. Why not 0.1.5 as "tested": the value gates the console's `review_required` alert and its "install this version" recommendation, and nothing has ever served 0.1.5 to this product. Why not leave 0.0.32: it would raise a permanent false alarm on the owner's production 0.1.1. Caveats: 0.1.1 was exercised through the connector adapter only (not the direct transport, approvals, user input, terminal input or the work graph); 0.0.33 to 0.1.0 were examined by no one but fall under the ceiling | **Landed.** Two existing assertions that hard-coded 0.0.33 and 0.0.34 as "newer than tested" were updated to 0.1.6 and 0.1.7 |
| Attachment limits in the capability manifest (section 2.5) | None in this pass | **Outstanding.** `docs/t3-capability-manifest.md` still records images-only, 8 attachments, 10 MiB; 0.1.x allows files up to 50 MiB and up to 100 attachments. That file was deliberately not edited |

Still open, ordered by blast radius:

1. **Work graph and agent verbs under protocol 2 (W1, W2).** CLAUDE.md now says plainly that both are
   inert in production (they have no input at 0.1.x). Either project `subagents[]`, `nodes[]`
   and typed turn items into the legacy work-activity shape inside `t3v2.mjs`, or state in
   [t3-work-graph.md](t3-work-graph.md) that those surfaces are protocol-1-only.
2. **Approval semantics (A2, A6).** Re-read `acceptForSession` versus `acceptAlways` for Claude v2
   before touching copy that says "allow always", and decide what the gateway does with a request
   whose `responseCapability` is `not_resumable` or `message`.
3. ~~**Direct transport.**~~ Done in the tree: protocol 2 was implemented rather than the transport
   being marked unsupported, and `maximumTestedVersion` moved (table above). Remaining: a live run of
   the direct protocol-2 path against 0.1.1 and 0.1.5.
4. ~~**Connector v1 scope (M7).**~~ Fixed. Remaining: one real protocol-1 pairing against a 0.0.x
   server (and 0.0.28, the declared minimum) before the Intel Mac fallback is called working.
5. **Surface `serverVersion` and `databaseMigration`** next to the capability manifest, so a pinned
   connector next to an unpinned, user-managed T3 is visible.
6. **Evaluate** `getThreadProjection` (replace subscribe-then-interrupt) and `launchThread`
   (idempotent device thread creation). Both exist in 0.1.1, so neither needs a 0.1.5 gate.
7. **Correct the CLAUDE.md statements** marked BROKEN or CHANGED above, and the attachment lines in
   [t3-capability-manifest.md](t3-capability-manifest.md). CLAUDE.md is done (2026-10-30): the
   orchestration HTTP routes, `/ws` 426, five decisions and request kinds, `options[]`, the dead
   `THREAD_RESUME_MAX_GAP`, the inert `agentVerb` and work-graph sections, the version pin, the
   `t3Protocol2.mjs` copy and the Intel Mac limit are all stated per version. The attachment lines in
   `t3-capability-manifest.md` and the manifest code remain outstanding.

## 9. Live observation of T3 0.1.5, 2026-10-30

The audit above was written from shipped bundles. On 2026-10-30 the maintainer's production T3 was
moved from 0.1.1 to 0.1.5 (the launchd job `com.next-coder.production.t3` pinned the 0.1.1 binary by
absolute path, so the version only changes when that path does), and the claims below were measured
against the running server on `127.0.0.1:3774`. The plist and the 116 MB `userdata` directory were
copied first, because a new release may migrate stored state irreversibly.

| Claim | Section | Observed on live 0.1.5 |
|---|---|---|
| `orchestrationProtocolVersion` is 2 | 4 | **Confirmed** — descriptor reports `2` |
| `/ws` refuses a client that does not ask for protocol 2 | 2 | **Confirmed** — HTTP **426** without the parameter |
| `/ws` accepts the parameter | 2 | **Confirmed** — HTTP **401**, i.e. it proceeds to ticket authentication |
| An unknown protocol is refused | 4 | **Confirmed** — `orchestrationProtocol=3` also returns **426**, so failing closed on a future protocol is correct |
| `POST /api/orchestration/dispatch` is gone | 2 | **Confirmed** — HTTP **404** |
| `GET /api/orchestration/snapshot` is gone | 2 | **Refined** — HTTP **200** with `text/html`, the single-page application, *not* a 404. A caller checking `response.ok` sees success and fails later parsing HTML as JSON. `src/t3Client.mjs` now refuses an HTML body with `T3_PROTOCOL_MISMATCH` naming the version and protocol |
| File attachments up to 50 MiB | 2 | **Confirmed** — `fileAttachments.maxUploadBytes` is `52428800`. `docs/t3-capability-manifest.md` still records the 0.0.32 image-only limits and remains outstanding |
| `orchestration:write` is not a T3 scope | 0, 8 | **Confirmed** — a pairing token minted by 0.1.5 lists eleven scopes and `orchestration:write` is not among them |
| The corrected pairing scopes are accepted | 8 | **Confirmed** — `exchangePairingToken` succeeded and the server echoed `orchestration:read orchestration:operate terminal:operate` |
| The direct transport works on protocol 2 | 8 | **Confirmed** — `DirectT3Transport.snapshot()` returned `{projects, snapshotSequence, threads}` over the WebSocket, with 1 project and 1 thread |

### Still not observed on 0.1.5

Dispatching a turn, approval answering (including whether `acceptAlways` behaves per provider as the
bundles indicate), structured user input, terminal input, the work graph, thread streaming and resume,
and anything through the **connector** path rather than the direct one. `maximumTestedVersion`
therefore stays at **0.1.1**: the run above exercises pairing and a snapshot read, not a completed
command, and it used the direct transport rather than the connector the ceiling describes.
