# T3-native agents and work

Next Coder does not run, name, or coordinate subagents. It projects the task lifecycle that
T3 Code already publishes on a thread and keeps T3 authoritative for identity, hierarchy, status,
usage, and output.

## Verified contract

The implementation was verified against the source content shipped with T3 Code 0.0.32 at
`/opt/homebrew/lib/node_modules/t3/dist/bin.mjs.map`, not against guessed provider payloads or live
user data:

- `packages/contracts/src/providerRuntime.ts:177-180,471-646` defines `task.started`,
  `task.progress`, `task.updated`, and `task.completed`, including `taskId`, the status vocabulary,
  typed usage, and the optional agent-linkage bundle.
- `src/orchestration/Layers/ProviderRuntimeIngestion.ts:315-357,539-739` shows which fields survive
  into `OrchestrationThreadActivity.payload`. Progress and usage use separate stable activity IDs,
  and the task identity fields are repeated so a retained progress/terminal row can reconstruct a
  task after its start row leaves the activity window.
- `packages/contracts/src/orchestration.ts:316-325,1243-1425` defines the persisted activity and
  the snapshot/event stream that carries it.

The deterministic fixture in
`test/fixtures/t3-work-activities-contract.json` records those verified shapes and provenance. It
contains no live T3, provider, project, prompt, or user data.

## Projection rules

`frontend/src/workGraph.ts` folds one latest-state node per `payload.taskId`:

- `agentKind: agent|background` is trusted because T3 stamps it at ingestion. An older row without
  that stamp is labeled `task`; Next Coder does not infer an agent from `taskType`, prose,
  tool names, timing, or model output.
- `parentAgentId` is the preferred parent edge. `agentId` is used only when T3 explicitly identifies
  the owning agent and no `parentAgentId` is present. A missing parent stays visible as “outside
  this retained window.” No temporal or name-based edge is synthesized.
- `OrchestrationThreadActivity.turnId` is retained as exact turn attribution. A task is never linked
  to a request/command merely because their timestamps are close.
- T3 statuses map mechanically: `pending → queued`, `running → working`, `waiting|idle → waiting`,
  `completed → completed`, `failed → failed`, and `cancelled|interrupted|stopped → stopped`.
  T3 explicitly treats an `idle` resumable child as not live, so it remains visible under Waiting
  but does not increment the active count or pin background liveness.
- A `task.progress` row with `usageSnapshot: true` updates usage without resurrecting a completed
  task. Stable activity IDs replace their previous row rather than adding history indefinitely.
- `tool.progress.payload.taskId` and `tool.*.payload.agentId` re-home only explicitly attributed tool
  activity into the matching task. An unattributed tool stays in the parent thread feed.
- A snapshot replaces the entire work projection. Live events fold after the snapshot and inherit
  the thread reducer's bounded sequence/event-ID deduplication. An unfillable resume gap therefore
  replaces both transcript and work; it never appends a second graph.

The console labels a linked projection as a tree. If no retained node has an explicit parent edge,
it labels the same data an activity roster. This is intentional evidence-limited behavior rather
than a degraded attempt to guess a hierarchy.

## Status and controls

The `Agents & work` disclosure stays next to the live thread status. It covers loading, empty,
live, reconnecting/stale, stopped/error, missing-parent, failed-task, and truncated states. A task
row may show T3-provided role, model, effort, workflow/phase, path, current tool, typed usage, and its
bounded activity timeline.

T3 0.0.32 exposes thread/session commands but no certified stable per-task input, stop, or resume
command. The inspector therefore has no per-agent buttons. The composer and Stop control continue
to target the parent thread, and the UI says so instead of implying a private child-agent channel.

Background liveness is `working` while any agent or unclassified task is active and `monitoring`
when only T3-stamped background tasks remain. A settled foreground turn with active native work
continues to present as in flight. During reconnect or after a stopped watch, retained work is
explicitly labeled potentially stale or last synchronized.

## Resource budgets and privacy

- At most 64 task nodes are retained per open console thread. Active nodes are retained ahead of
  the oldest terminal nodes; omission count and truncation are shown.
- At most 16 activity rows are retained per node. Stable activity IDs update in place.
- The existing live transcript stays capped at 512 rows and the event dedup ring at 512 keys.
- Agent-owned task/tool rows are re-homed instead of rendered twice in both the parent feed and the
  inspector.
- The device route returns only version/source and counts (`total`, status counts, liveness,
  truncation). It never returns task IDs, titles, paths, roles, models, summaries, errors, output, or
  usage. When no newer assistant reply exists, its three-line response can show active/done/failed
  counts, each still within the existing 31-character line budget.

The server compact fold is independently bounded to 64 tasks. Its contract is covered by
`test/t3Work.test.mjs`; snapshot/SSE preservation by `test/threadStream.test.mjs`; snapshot,
replay, dedup, and live folding by `frontend/src/liveThread.test.ts`; projection bounds by
`frontend/src/workGraph.test.ts`; and UI states by `frontend/src/features/WorkGraphPanel.test.tsx`
plus `OperatePage.live.test.tsx`.

No live T3 instance, WAN reconnect, browser performance trace, or physical controller was used for
this implementation. Those remain separate qualification evidence.
