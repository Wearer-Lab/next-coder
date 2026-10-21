/**
 * Evidence-limited projection of T3's native task lifecycle.
 *
 * This is deliberately not a Next Coder orchestrator. T3 remains authoritative and the
 * projection consumes only fields in T3's shipped provider-runtime/activity contract:
 *
 *   task.started | task.progress | task.updated | task.completed
 *   payload.taskId, agentKind, agentId, parentAgentId, taskType, title, role, model, ...
 *
 * T3's stable task-progress/activity ids make the fold a latest-state projection. Parent links are
 * shown only when T3 supplied parentAgentId/agentId; a missing parent in a window stays explicitly
 * missing rather than being inferred from names, timing, or prose.
 */

export const WORK_NODE_LIMIT = 64;
export const WORK_NODE_ACTIVITY_LIMIT = 16;

const TASK_KINDS = new Set([
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
]);

const ACTIVE_STATUSES = new Set<WorkStatus>(["queued", "working", "waiting"]);

export type WorkStatus =
  | "queued"
  | "working"
  | "waiting"
  | "completed"
  | "failed"
  | "stopped";

/** `task` is the honest legacy fallback when a row predates T3's agentKind stamp. */
export type WorkKind = "agent" | "background" | "task";

export interface WorkUsage {
  totalTokens: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
}

export interface WorkActivity {
  id: string;
  kind: string;
  summary: string;
  at: string | null;
  tone: "info" | "tool" | "error";
}

export interface WorkNode {
  id: string;
  /** T3 turn attribution from OrchestrationThreadActivity, never inferred from arrival time. */
  turnId: string | null;
  parentId: string | null;
  parentSource: "parentAgentId" | "agentId" | null;
  kind: WorkKind;
  taskType: string | null;
  label: string;
  role: string | null;
  model: string | null;
  effort: string | null;
  workflowName: string | null;
  phaseTitle: string | null;
  agentPath: string | null;
  status: WorkStatus;
  /** Exact optional T3 runtime status; notably, `idle` is visible but does not count as live. */
  runtimeStatus: string | null;
  summary: string | null;
  currentTool: string | null;
  failure: string | null;
  usage: WorkUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  activities: WorkActivity[];
  activitiesTruncated: boolean;
  order: number;
}

export interface WorkSummary {
  total: number;
  active: number;
  queued: number;
  working: number;
  waiting: number;
  completed: number;
  failed: number;
  stopped: number;
  agents: number;
  background: number;
}

export interface WorkProjection {
  version: 1;
  nodes: WorkNode[];
  summary: WorkSummary;
  relationshipMode: "tree" | "roster";
  truncated: boolean;
  omittedNodes: number;
  nextOrder: number;
}

export function createWorkProjection(): WorkProjection {
  return {
    version: 1,
    nodes: [],
    summary: summarize([]),
    relationshipMode: "roster",
    truncated: false,
    omittedNodes: 0,
    nextOrder: 0,
  };
}

/** Snapshot semantics: callers replace their old projection with this result. */
export function collectWorkProjection(activities: unknown): WorkProjection {
  let projection = createWorkProjection();
  for (const activity of asArray(activities)) projection = foldWorkActivity(projection, activity);
  return projection;
}

/**
 * Applies one T3 activity. Duplicate stable activity ids update their row instead of appending it;
 * the outer live-thread reducer additionally deduplicates replay/live event overlap by sequence.
 */
export function foldWorkActivity(
  projection: WorkProjection,
  activity: unknown,
): WorkProjection {
  const row = asRecord(activity);
  const activityKind = stringOrNull(row?.kind);
  const payload = asRecord(row?.payload);
  if (!row || !activityKind || !payload) return projection;

  if (TASK_KINDS.has(activityKind)) {
    const taskId = stringOrNull(payload.taskId);
    if (!taskId) return projection;
    return foldTaskActivity(projection, row, payload, activityKind, taskId);
  }

  const ownerId = activityKind === "tool.progress"
    ? stringOrNull(payload.taskId)
    : activityKind === "tool.started"
      || activityKind === "tool.updated"
      || activityKind === "tool.completed"
      || activityKind === "tool.denied"
      ? stringOrNull(payload.agentId)
      : null;
  if (!ownerId) return projection;
  const index = projection.nodes.findIndex((node) => node.id === ownerId);
  if (index < 0) return projection;

  const existing = projection.nodes[index];
  const at = stringOrNull(row.createdAt);
  const summary = clip(
    stringOrNull(payload.toolName)
      ?? stringOrNull(row.summary)
      ?? activityKind,
    160,
  );
  const terminalTool = activityKind === "tool.completed" || activityKind === "tool.denied";
  const timelineActivity = workActivity(row, activityKind, summary);
  const node: WorkNode = {
    ...existing,
    summary,
    currentTool: terminalTool ? null : summary,
    updatedAt: at ?? existing.updatedAt,
    activities: upsertActivity(existing.activities, timelineActivity),
    activitiesTruncated: existing.activitiesTruncated
      || activityWouldTruncate(existing.activities, timelineActivity),
  };
  return replaceNode(projection, index, node);
}

export function workBackgroundLiveness(
  projection: WorkProjection,
): "working" | "monitoring" | null {
  const active = projection.nodes.filter(nodeIsLive);
  if (active.length === 0) return null;
  return active.some((node) => node.kind !== "background") ? "working" : "monitoring";
}

export function workHasActiveNodes(projection: WorkProjection): boolean {
  return projection.summary.active > 0;
}

/** Activities attributed by T3 belong in the work inspector, not the parent narration. */
export function workOwnerIdForActivity(activity: unknown): string | null {
  const row = asRecord(activity);
  const kind = stringOrNull(row?.kind);
  const payload = asRecord(row?.payload);
  if (!kind || !payload) return null;
  if (TASK_KINDS.has(kind)) return stringOrNull(payload.taskId);
  if (kind === "tool.progress") return stringOrNull(payload.taskId);
  if (
    kind === "tool.started"
    || kind === "tool.updated"
    || kind === "tool.completed"
    || kind === "tool.denied"
  ) {
    return stringOrNull(payload.agentId);
  }
  return null;
}

function foldTaskActivity(
  projection: WorkProjection,
  row: Record<string, unknown>,
  payload: Record<string, unknown>,
  activityKind: string,
  taskId: string,
): WorkProjection {
  const index = projection.nodes.findIndex((node) => node.id === taskId);
  const existing = index >= 0 ? projection.nodes[index] : null;
  const at = stringOrNull(row.createdAt);
  const usageOnly = activityKind === "task.progress" && payload.usageSnapshot === true;
  const status = usageOnly && existing
    ? existing.status
    : taskStatus(activityKind, stringOrNull(payload.status), existing?.status ?? null);
  const parentAgentId = stringOrNull(payload.parentAgentId);
  const ownerAgentId = stringOrNull(payload.agentId);
  const parentId = parentAgentId && parentAgentId !== taskId
    ? parentAgentId
    : ownerAgentId && ownerAgentId !== taskId ? ownerAgentId : existing?.parentId ?? null;
  const parentSource = parentId === parentAgentId
    ? "parentAgentId"
    : parentId === ownerAgentId ? "agentId" : existing?.parentSource ?? null;
  const label = clip(
    stringOrNull(payload.title)
      ?? stringOrNull(payload.detail)
      ?? stringOrNull(payload.description)
      ?? existing?.label
      ?? `Task ${taskId}`,
    120,
  );
  const summary = clipNullable(
    stringOrNull(payload.summary)
      ?? (!usageOnly ? stringOrNull(payload.detail) : null)
      ?? (!usageOnly ? stringOrNull(row.summary) : null)
      ?? existing?.summary
      ?? null,
    240,
  );
  const terminal = status === "completed" || status === "failed" || status === "stopped";
  const failure = status === "failed"
    ? clipNullable(stringOrNull(payload.error) ?? summary ?? "Task failed", 240)
    : terminal ? null : clipNullable(stringOrNull(payload.error) ?? existing?.failure ?? null, 240);
  const activity = workActivity(row, activityKind, summary ?? label);
  const agentKind = stringOrNull(payload.agentKind);
  const node: WorkNode = {
    id: taskId,
    turnId: stringOrNull(row.turnId) ?? existing?.turnId ?? null,
    parentId,
    parentSource,
    kind: agentKind === "agent" || agentKind === "background"
      ? agentKind
      : existing?.kind ?? "task",
    taskType: stringOrNull(payload.taskType) ?? existing?.taskType ?? null,
    label,
    role: stringOrNull(payload.role) ?? existing?.role ?? null,
    model: stringOrNull(payload.model) ?? existing?.model ?? null,
    effort: stringOrNull(payload.effort) ?? existing?.effort ?? null,
    workflowName: stringOrNull(payload.workflowName) ?? existing?.workflowName ?? null,
    phaseTitle: stringOrNull(payload.phaseTitle) ?? existing?.phaseTitle ?? null,
    agentPath: stringOrNull(payload.agentPath) ?? existing?.agentPath ?? null,
    status,
    runtimeStatus: usageOnly
      ? existing?.runtimeStatus ?? null
      : stringOrNull(payload.status) ?? existing?.runtimeStatus ?? null,
    summary,
    currentTool: terminal
      ? null
      : stringOrNull(payload.lastToolName) ?? existing?.currentTool ?? null,
    failure,
    usage: usageFrom(payload.typedUsage) ?? existing?.usage ?? null,
    startedAt: activityKind === "task.started"
      ? at ?? existing?.startedAt ?? null
      : existing?.startedAt ?? null,
    completedAt: terminal
      ? stringOrNull(payload.endedAt) ?? at ?? existing?.completedAt ?? null
      : null,
    updatedAt: at ?? existing?.updatedAt ?? null,
    activities: upsertActivity(existing?.activities ?? [], activity),
    activitiesTruncated: existing?.activitiesTruncated === true
      || activityWouldTruncate(existing?.activities ?? [], activity),
    order: existing?.order ?? projection.nextOrder,
  };

  let nodes = index < 0
    ? [...projection.nodes, node]
    : projection.nodes.map((candidate, candidateIndex) => candidateIndex === index ? node : candidate);
  let omittedNodes = projection.omittedNodes;
  let truncated = projection.truncated;
  if (nodes.length > WORK_NODE_LIMIT) {
    const victim = evictionIndex(nodes);
    nodes = nodes.filter((_, candidateIndex) => candidateIndex !== victim);
    omittedNodes += 1;
    truncated = true;
  }
  return finalize({
    ...projection,
    nodes,
    omittedNodes,
    truncated,
    nextOrder: index < 0 ? projection.nextOrder + 1 : projection.nextOrder,
  });
}

function replaceNode(projection: WorkProjection, index: number, node: WorkNode): WorkProjection {
  return finalize({
    ...projection,
    nodes: projection.nodes.map((candidate, candidateIndex) => candidateIndex === index ? node : candidate),
  });
}

function finalize(projection: WorkProjection): WorkProjection {
  return {
    ...projection,
    summary: summarize(projection.nodes),
    relationshipMode: projection.nodes.some((node) => node.parentId) ? "tree" : "roster",
  };
}

function summarize(nodes: readonly WorkNode[]): WorkSummary {
  const count = (status: WorkStatus) => nodes.filter((node) => node.status === status).length;
  const queued = count("queued");
  const working = count("working");
  const waiting = count("waiting");
  return {
    total: nodes.length,
    active: nodes.filter(nodeIsLive).length,
    queued,
    working,
    waiting,
    completed: count("completed"),
    failed: count("failed"),
    stopped: count("stopped"),
    agents: nodes.filter((node) => node.kind === "agent").length,
    background: nodes.filter((node) => node.kind === "background").length,
  };
}

function taskStatus(
  activityKind: string,
  rawStatus: string | null,
  previous: WorkStatus | null,
): WorkStatus {
  if (activityKind === "task.completed") {
    if (rawStatus === "failed") return "failed";
    if (rawStatus === "stopped") return "stopped";
    return "completed";
  }
  switch (rawStatus) {
    case "pending": return "queued";
    case "running": return "working";
    case "waiting":
    case "idle": return "waiting";
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled":
    case "interrupted":
    case "stopped": return "stopped";
    default: return previous ?? "working";
  }
}

function workActivity(
  row: Record<string, unknown>,
  kind: string,
  summary: string,
): WorkActivity {
  const tone = stringOrNull(row.tone);
  return {
    id: stringOrNull(row.id) ?? `${kind}:${stringOrNull(row.createdAt) ?? summary}`,
    kind,
    summary: clip(summary, 240),
    at: stringOrNull(row.createdAt),
    tone: tone === "error" ? "error" : tone === "tool" ? "tool" : "info",
  };
}

function upsertActivity(activities: WorkActivity[], activity: WorkActivity): WorkActivity[] {
  const index = activities.findIndex((candidate) => candidate.id === activity.id);
  const next = index < 0
    ? [...activities, activity]
    : activities.map((candidate, candidateIndex) => candidateIndex === index ? activity : candidate);
  return next.slice(-WORK_NODE_ACTIVITY_LIMIT);
}

function activityWouldTruncate(activities: WorkActivity[], activity: WorkActivity): boolean {
  return activities.length >= WORK_NODE_ACTIVITY_LIMIT
    && !activities.some((candidate) => candidate.id === activity.id);
}

function usageFrom(value: unknown): WorkUsage | null {
  const record = asRecord(value);
  const totalTokens = finiteNonNegative(record?.totalTokens);
  if (!record || totalTokens === null) return null;
  return {
    totalTokens,
    inputTokens: finiteNonNegative(record.inputTokens),
    cachedInputTokens: finiteNonNegative(record.cachedInputTokens),
    outputTokens: finiteNonNegative(record.outputTokens),
    reasoningOutputTokens: finiteNonNegative(record.reasoningOutputTokens),
    toolUses: finiteNonNegative(record.toolUses),
    durationMs: finiteNonNegative(record.durationMs),
  };
}

function evictionIndex(nodes: WorkNode[]): number {
  let victim = 0;
  for (let index = 1; index < nodes.length; index += 1) {
    const current = nodes[victim];
    const candidate = nodes[index];
    const currentActive = nodeIsLive(current);
    const candidateActive = nodeIsLive(candidate);
    if (currentActive !== candidateActive) {
      if (!candidateActive) victim = index;
      continue;
    }
    if (candidate.order < current.order) victim = index;
  }
  return victim;
}

function nodeIsLive(node: WorkNode): boolean {
  return ACTIVE_STATUSES.has(node.status) && node.runtimeStatus !== "idle";
}

function clip(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1).trimEnd()}…`;
}

function clipNullable(value: string | null, maximum: number): string | null {
  return value === null ? null : clip(value, maximum);
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
