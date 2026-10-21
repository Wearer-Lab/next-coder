// What the agent is *doing*, derived from real T3 evidence — never guessed.
//
// The controller's orb renders nine animations, one per verb. Five were driven; four
// (searching / solving / weaving / shaping) had no gateway signal behind them at all.
// This module is that signal, and it is deliberately conservative: a wrong animation is a
// lie about what the agent is doing, so every predicate below names the T3 field it reads
// and returns null the moment the evidence runs out.
//
// ---------------------------------------------------------------------------------------
// WHERE THE EVIDENCE COMES FROM
// ---------------------------------------------------------------------------------------
//
// `GET /api/orchestration/snapshot` cannot answer this. Verified against the installed
// T3 Code 0.0.32 contract (source map at /opt/homebrew/lib/node_modules/t3/dist/bin.mjs.map,
// `sourcesContent` for packages/contracts/src/*.ts and src/orchestration/*.ts):
//
//   src/orchestration/http.ts, handler "snapshot":
//     "Serve the lightweight command read model (thread bodies empty) instead of the fully
//      hydrated snapshot. Hydrating every message and activity payload in the database has
//      OOM-killed servers […] UI clients load the shell and per-thread snapshots instead."
//
//   test/fixtures/t3-snapshot.json confirms it live: every thread carries exactly
//   {id, projectId, title, modelSelection, latestTurn, session} — no messages, no activities.
//
// The hydrated route is `GET /api/orchestration/threads/:threadId` (contract:
// packages/contracts/src/environmentHttp.ts, endpoint "threadSnapshot", success
// `OrchestrationThreadDetailSnapshot`, optional `?turnLimit=` query window). Its
// `thread.activities[]` is the work log, and it is what this module reads.
//
// Each activity (packages/contracts/src/orchestration.ts, `OrchestrationThreadActivity`) is
//   { id, tone: info|tool|approval|error, kind, summary, payload, turnId, sequence, createdAt }
// and the tool rows are emitted by src/orchestration/Layers/ProviderRuntimeIngestion.ts as
//   kind: "tool.started" | "tool.updated" | "tool.completed"   (tone "tool")
//   summary: the provider's tool title ("Read file", "Terminal", "Grep", …)
//   payload: { itemType, status?, detail?, data? }
// where `itemType` is one of TOOL_LIFECYCLE_ITEM_TYPES (packages/contracts/src/providerRuntime.ts):
//   command_execution | file_change | mcp_tool_call | dynamic_tool_call |
//   collab_agent_tool_call | web_search | image_view
//
// `payload.data` is slimmed server-side before it ships (src/orchestration/ActivityPayloadProjection.ts,
// `projectActivityPayload`), and the slimming keeps exactly: item.command, command, files[].path,
// toolCallId, `kind`, rawOutput. So `data.kind` and `data.files` are on the wire; `data.rawInput`
// is NOT, and nothing here may depend on it.
//
// ---------------------------------------------------------------------------------------
// THE CLASSIFIER
// ---------------------------------------------------------------------------------------
//
// classifyToolActivity() is a port of T3's own `classifyToolAction`
// (packages/shared/src/toolActivity.ts) — the function T3's web and mobile clients use to
// label the same rows. Reusing T3's rule rather than inventing one means the gateway and the
// T3 UI cannot disagree about what a tool call was, and it means the vocabulary tracks a
// contract that is checked in rather than a guess about tool names.

export const AGENT_VERBS = Object.freeze(["searching", "solving", "weaving", "shaping"]);

// Activity kinds that are evidence of the agent *doing* something. Everything else in the
// work log — context-window.updated, task.*, approval.*, runtime.* — is bookkeeping about
// the turn rather than an action within it, and must not shadow the newest real action.
const EVIDENTIAL_KINDS = new Set(["tool.started", "tool.updated", "tool.completed", "turn.plan.updated"]);

const TOOL_KINDS = new Set(["tool.started", "tool.updated", "tool.completed"]);

// Sub-kinds of a file change, from `data.kind`. `write` creates or replaces a whole file and
// `move`/`delete` restructure the tree; `edit` alters a file that already exists.
const STRUCTURAL_FILE_KINDS = new Set(["write", "move", "delete"]);

/**
 * A single tool row, reduced to T3's own five-way action vocabulary.
 *
 * Port of `classifyToolAction` in packages/shared/src/toolActivity.ts. The one deliberate
 * addition is that the caller passes `summary` as the title, because ProviderRuntimeIngestion
 * puts the provider's tool title in `activity.summary` and only sometimes in `payload.title`
 * — T3's own `toolLifecycleIdentity` reads `payload.title ?? activity.summary` for the same
 * reason.
 */
export function classifyToolActivity(activity) {
  if (!TOOL_KINDS.has(activity?.kind)) return "other";
  const payload = asRecord(activity?.payload);
  const data = asRecord(payload?.data);
  const itemType = trimmedLower(payload?.itemType);
  const dataKind = trimmedLower(data?.kind);
  // "Grep started" / "Read file complete" are the same tool as "Grep" / "Read file".
  const title = trimmedLower(payload?.title ?? activity?.summary)
    ?.replace(/\s+(?:complete|completed|started)$/u, "")
    .trim();

  if (itemType === "command_execution" || dataKind === "execute" || title === "terminal") return "command";
  if (dataKind === "read" || title === "read file") return "read";
  if (itemType === "file_change" || dataKind === "edit" || dataKind === "move"
    || dataKind === "delete" || dataKind === "write") return "file_change";
  if (itemType === "web_search" || dataKind === "search" || title === "find" || title === "grep") return "search";
  return "other";
}

/**
 * The verb for a thread, or null when the evidence does not support one.
 *
 * `thread` is the hydrated thread from `GET /api/orchestration/threads/:threadId` — the
 * bodiless snapshot thread never produces a verb, which is correct: it carries no activities
 * and therefore no knowledge of what the agent is doing.
 */
export function deriveAgentVerb(thread) {
  // 1. A verb is a claim about work happening NOW. A settled turn's last tool call would
  //    otherwise light an animation forever, so nothing is derived unless the turn is live.
  //    Both discriminators are checked because `session.status` reads "stopped" for success
  //    and failure alike (see CLAUDE.md, "Command reconciliation") and cannot carry this alone.
  const turnState = trimmedLower(thread?.latestTurn?.state);
  const sessionStatus = trimmedLower(thread?.session?.status);
  if (turnState !== "running" && sessionStatus !== "running") return null;

  // 2. Attribution. An activity is only about this turn if T3 stamped it with this turn's id.
  //    With no id to compare against there is no way to prove an activity is current, so the
  //    honest answer is no verb rather than the newest row in the log.
  const turnId = optional(thread?.session?.activeTurnId) ?? optional(thread?.latestTurn?.turnId);
  if (!turnId) return null;

  const activities = turnActivities(thread, turnId);
  if (!activities.length) return null;

  // 3. The newest action in the turn is the best available proxy for "now". Note the honest
  //    limitation: a `tool.completed` with nothing after it means the agent has finished that
  //    tool and is thinking again, and this still reports the tool. T3 publishes no
  //    "the model is generating" activity, so that gap is not closeable from here.
  const latest = activities.at(-1);
  if (!latest) return null;

  // A plan being published or revised is the agent reasoning about how to proceed — the
  // firmware's own vocabulary already treats "planning" and "solving" as one animation
  // (orbModeForAgentState in firmware/shared/NextCoderCore/src/ThinkingOrb.cpp).
  if (latest.kind === "turn.plan.updated") return "solving";

  switch (classifyToolActivity(latest)) {
    // Grep / Glob / Read / WebSearch. T3 labels these "Searched files" and "Read file": the
    // agent is looking through the codebase or the web, which is exactly what the verb means.
    case "search":
    case "read":
      return "searching";

    // A shell command in flight is the build/test/run cycle — the agent has handed work to
    // the machine and is waiting on the result to decide what to do next.
    case "command":
      return "solving";

    case "file_change": {
      const dataKind = trimmedLower(asRecord(asRecord(latest.payload)?.data)?.kind);
      // Creating or replacing a whole file, or moving/deleting one, is making something new
      // or restructuring what exists.
      if (STRUCTURAL_FILE_KINDS.has(dataKind)) return "shaping";
      // An edit only earns "weaving" when the turn has actually touched more than one file:
      // the verb means *coordinated* edits across multiple files, and a single-file edit is
      // not that. Falling through to null leaves the honest, already-correct "running".
      return distinctChangedFiles(activities).size >= 2 ? "weaving" : null;
    }

    default:
      // mcp_tool_call, dynamic_tool_call, image_view and anything else T3 grows later. The
      // gateway knows a tool ran and does not know what kind. That is not one of the nine.
      return null;
  }
}

/**
 * Refines a device-facing thread status with a verb, or returns it unchanged.
 *
 * Refinement only ever applies to `running`: the other words the device already understands
 * (starting / streaming / completed / error / stopped / idle) are facts about the session and
 * the turn, not about the work, and a verb must never overwrite one of them.
 */
export function refineThreadStatus(status, thread) {
  if (status !== "running") return status;
  return deriveAgentVerb(thread) ?? status;
}

// Activities belonging to one turn, oldest first. T3 orders the work log by `sequence` when
// the adapter supplies one and falls back to `createdAt`; `sequence` is optionalKey in the
// contract, so both are needed and neither alone is enough.
function turnActivities(thread, turnId) {
  return (Array.isArray(thread?.activities) ? thread.activities : [])
    .filter((activity) => optional(activity?.turnId) === turnId)
    .filter((activity) => EVIDENTIAL_KINDS.has(activity?.kind))
    .map((activity, index) => ({ activity, index }))
    .sort((left, right) => compareActivities(left, right))
    .map(({ activity }) => activity);
}

function compareActivities(left, right) {
  const leftSequence = Number(left.activity?.sequence);
  const rightSequence = Number(right.activity?.sequence);
  if (Number.isFinite(leftSequence) && Number.isFinite(rightSequence) && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  const leftAt = Date.parse(left.activity?.createdAt ?? "");
  const rightAt = Date.parse(right.activity?.createdAt ?? "");
  if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return leftAt - rightAt;
  return left.index - right.index;
}

// Distinct paths touched by file-change rows in this turn. `data.files[].path` is what
// survives ActivityPayloadProjection's slimming (`collectChangedFiles` rewrites every
// path-like key into that one shape), so it is the only file evidence on the wire.
function distinctChangedFiles(activities) {
  const paths = new Set();
  for (const activity of activities) {
    if (classifyToolActivity(activity) !== "file_change") continue;
    const files = asRecord(asRecord(activity?.payload)?.data)?.files;
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      const path = optional(asRecord(file)?.path);
      if (path) paths.add(path);
    }
  }
  return paths;
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function optional(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function trimmedLower(value) {
  const text = optional(value);
  return text ? text.toLowerCase() : null;
}
