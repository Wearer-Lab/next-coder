/**
 * Provider approvals in the console.
 *
 * Two different things in this product are called an approval, and the console must never let a
 * reader confuse them:
 *
 *   GATEWAY APPROVAL   a `Command` with status `approval_required`. The gateway refused to
 *                      dispatch something *you* asked for — "you tried to run `rm -rf`" — and is
 *                      holding it. Answered at POST /v1/commands/:id/approve|reject. Two buttons,
 *                      and declining means the command is never sent.
 *
 *   PROVIDER APPROVAL  a turn is already running inside T3 and the agent has stopped mid-turn to
 *                      ask permission — "Claude wants to edit src/app.mjs". It is not a gateway
 *                      record at all: it is a live callback in T3, it expires with the session,
 *                      and it has FIVE answers, not two. Answered at
 *                      POST /v1/t3/environments/:id/threads/:threadId/approvals/:requestId.
 *
 * They are rendered as separate blocks with different labels for that reason, and everything in
 * this file is stamped `kind: "provider"`.
 *
 * The decision vocabulary is T3's own `ProviderApprovalDecision` (five values in T3 0.1.x, four in
 * 0.0.32) and is mirrored from `src/providerApprovals.mjs`, which carries the full contract
 * evidence. Offering only approve/reject would be the console lying about the choice T3 gives the
 * owner — in particular about "allow for this session", which writes a standing permission rule
 * rather than answering one question.
 *
 * `acceptAlways` is in the vocabulary but NOT in the default offered set. Only a request that lists
 * it in its own `options` may be answered with it: on Claude it is treated as a denial, so offering
 * it speculatively would turn "always allow" into a silent refusal.
 */

export const PROVIDER_APPROVAL_DECISIONS = [
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
] as const;

export type ProviderApprovalDecision = typeof PROVIDER_APPROVAL_DECISIONS[number];

export type ProviderApprovalStatus = "pending" | "resolved" | "stale";

export const PROVIDER_REQUEST_KINDS = [
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
] as const;

export type ProviderRequestKind = typeof PROVIDER_REQUEST_KINDS[number];

/**
 * What a request is read as offering when it states no `options` of its own: exactly T3's own
 * web-UI fallback (cancel, decline, acceptForSession, accept). `acceptAlways` is deliberately absent.
 */
export const DEFAULT_OFFERED_PROVIDER_APPROVAL_DECISIONS: readonly ProviderApprovalDecision[] = [
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
];

export interface ProviderApprovalDecisionDescriptor {
  decision: ProviderApprovalDecision;
  label: string;
  description: string;
  /** True for the decisions that leave a standing rule behind rather than answering once. */
  persistent: boolean;
  allows: boolean;
  /** Whether a request that states no options of its own is offered this decision. */
  offeredByDefault: boolean;
}

export const PROVIDER_APPROVAL_DECISION_CATALOGUE: readonly ProviderApprovalDecisionDescriptor[] = [
  {
    decision: "accept",
    label: "Allow once",
    description: "Run this one request. The agent asks again next time.",
    persistent: false,
    allows: true,
    offeredByDefault: true,
  },
  {
    decision: "acceptForSession",
    label: "Allow for this session",
    description: "Run it, and stop asking for the same thing until the session ends.",
    persistent: true,
    allows: true,
    offeredByDefault: true,
  },
  {
    decision: "acceptAlways",
    label: "Always allow",
    // Honest about the per-provider split rather than promising "forever": Codex folds it into the
    // session grant for commands and edits, Claude and ACP do not support it at all, and it only
    // appears on a request whose provider listed it.
    description: "Run it and keep allowing it beyond this session, where the provider supports a standing grant. Offered only when the request itself offers it.",
    persistent: true,
    allows: true,
    offeredByDefault: false,
  },
  {
    decision: "decline",
    label: "Decline",
    description: "Refuse this request. The agent is told and keeps working.",
    persistent: false,
    allows: false,
    offeredByDefault: true,
  },
  {
    decision: "cancel",
    label: "Cancel the turn",
    description: "Refuse and stop what the agent was doing.",
    persistent: false,
    allows: false,
    offeredByDefault: true,
  },
];

/** What the gateway itself did about this request, which is not what T3 reports. */
export interface ProviderApprovalLocalDecision {
  requestId: string;
  decision: ProviderApprovalDecision | string;
  /** claimed | dispatched | held | failed. `held` waits on a gateway policy confirmation. */
  status: string;
  actorType: string;
  commandId: string | null;
  error: string | null;
  decidedAt: string | null;
}

export interface ProviderApproval {
  kind: "provider";
  requestId: string;
  threadId: string | null;
  requestKind: ProviderRequestKind | null;
  /** The provider's own words about what it wants to do. Code and user content — render as-is. */
  detail: string | null;
  summary: string;
  turnId: string | null;
  requestedAt: string | null;
  status: ProviderApprovalStatus;
  /** The decision T3 recorded, once it resolves. */
  decision: string | null;
  resolvedAt: string | null;
  /** A `provider.approval.respond.failed` detail, when one was reported. */
  failure: string | null;
  localDecision: ProviderApprovalLocalDecision | null;
  /**
   * The decisions THIS request accepts, when the runtime stated them. `undefined` means the request
   * did not say, so the card falls back to the top-level list. An empty array means the request
   * named only decisions this console does not recognise, so it offers nothing rather than
   * silently widening back to all four. Capability filtering is not applied here; the card does it.
   */
  allowedDecisions?: readonly ProviderApprovalDecision[];
}

const REQUEST_KIND_LABELS: Record<ProviderRequestKind, string> = {
  command: "Run a command",
  "file-read": "Read a file",
  "file-change": "Change a file",
  // Deliberately vague, as in src/providerApprovals.mjs: an MCP elicitation is a connected tool
  // asking to be approved, and `permission` is a catch-all for a grant that is neither a command
  // nor a file.
  "mcp-elicitation": "Approve a connected tool",
  permission: "Grant a permission",
};

export function providerApprovalTitle(approval: ProviderApproval): string {
  return approval.requestKind
    ? REQUEST_KIND_LABELS[approval.requestKind]
    : approval.summary || "Approval requested";
}

export function isProviderApprovalDecision(value: unknown): value is ProviderApprovalDecision {
  return typeof value === "string"
    && (PROVIDER_APPROVAL_DECISIONS as readonly string[]).includes(value);
}

export function describeProviderApprovalDecision(
  decision: string | null,
): ProviderApprovalDecisionDescriptor | null {
  if (!decision) return null;
  return PROVIDER_APPROVAL_DECISION_CATALOGUE
    .find((entry) => entry.decision === decision) ?? null;
}

/**
 * The decisions to render as buttons.
 *
 * `allowedDecisions` comes from the gateway and already reflects the acting profile's
 * capabilities — notably that `acceptForSession` and `acceptAlways` are separate capabilities.
 * An empty list is a real answer, not a loading state: a read-only actor SEES the request and is
 * offered nothing.
 *
 * `null` or `undefined` means the request stated no set, and is read as the DEFAULT four — never
 * as the whole vocabulary, which would offer `acceptAlways` where the provider did not say it
 * exists.
 */
export function offeredProviderApprovalDecisions(
  allowedDecisions: readonly string[] | null | undefined,
): ProviderApprovalDecisionDescriptor[] {
  const allowed = new Set(allowedDecisions ?? DEFAULT_OFFERED_PROVIDER_APPROVAL_DECISIONS);
  return PROVIDER_APPROVAL_DECISION_CATALOGUE.filter((entry) => allowed.has(entry.decision));
}

// ---------------------------------------------------------------------------------------------
// Deriving pending approvals from the live thread stream
// ---------------------------------------------------------------------------------------------
//
// Port of `collectProviderApprovals()` in src/providerApprovals.mjs, which is itself a port of
// T3's own `hasOpenBlockingRequest` (src/orchestration/decider.ts:64-86). The clearing rules have
// to match on all three or the console will show a card for a request nothing is waiting on:
//
//   approval.requested                 opens (or re-opens) the request
//   approval.resolved                  closes it
//   provider.approval.respond.failed   closes it ONLY when the detail says the provider no longer
//                                      knows the request. Any other failure leaves it open,
//                                      because something is still blocked on an answer.

export function isStaleProviderRequestDetail(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  const lowered = detail.toLowerCase();
  return lowered.includes("stale pending approval request")
    || lowered.includes("unknown pending approval request")
    || lowered.includes("unknown pending permission request");
}

/**
 * Fold one T3 activity into an approval map. Returns a NEW map only when something changed, so a
 * reducer can keep its previous state identity for the overwhelmingly common irrelevant activity.
 */
export function foldApprovalActivity(
  approvals: readonly ProviderApproval[],
  activity: unknown,
  threadId: string | null,
): readonly ProviderApproval[] {
  const record = asRecord(activity);
  const payload = asRecord(record?.payload);
  const requestId = stringOrNull(payload?.requestId);
  if (!record || !requestId) return approvals;
  const kind = stringOrNull(record.kind);

  if (kind === "approval.requested") {
    const next: ProviderApproval = {
      kind: "provider",
      requestId,
      threadId,
      requestKind: normalizeRequestKind(payload?.requestKind),
      detail: stringOrNull(payload?.detail),
      summary: stringOrNull(record.summary) ?? "Approval requested",
      turnId: stringOrNull(record.turnId),
      requestedAt: stringOrNull(record.createdAt),
      status: "pending",
      decision: null,
      resolvedAt: null,
      failure: null,
      localDecision: null,
      // A repeated request id replaces the whole record, decision set included: a provider asking
      // again may offer a different set, or none stated.
      allowedDecisions: normalizeOfferedDecisions(payload?.decisions),
    };
    const index = approvals.findIndex((entry) => entry.requestId === requestId);
    if (index === -1) return [...approvals, next];
    const copy = [...approvals];
    // A repeated request id means the provider is asking again; the local decision no longer
    // applies to the question on screen.
    copy[index] = next;
    return copy;
  }

  const index = approvals.findIndex((entry) => entry.requestId === requestId);
  if (index === -1) return approvals;

  if (kind === "approval.resolved") {
    const copy = [...approvals];
    copy[index] = {
      ...copy[index],
      status: "resolved",
      decision: stringOrNull(payload?.decision),
      resolvedAt: stringOrNull(record.createdAt),
    };
    return copy;
  }

  if (kind === "provider.approval.respond.failed") {
    const detail = stringOrNull(payload?.detail);
    const copy = [...approvals];
    copy[index] = {
      ...copy[index],
      failure: detail,
      ...(isStaleProviderRequestDetail(detail)
        ? { status: "stale" as const, resolvedAt: stringOrNull(record.createdAt) }
        : {}),
    };
    return copy;
  }

  return approvals;
}

/** All approvals in a hydrated thread's work log, in request order. */
export function collectProviderApprovals(
  thread: unknown,
  threadId: string | null,
): ProviderApproval[] {
  const record = asRecord(thread);
  const activities = Array.isArray(record?.activities) ? [...record.activities] : [];
  activities.sort((left, right) => {
    const bySequence = (Number(asRecord(left)?.sequence) || 0) - (Number(asRecord(right)?.sequence) || 0);
    if (bySequence !== 0) return bySequence;
    return String(asRecord(left)?.createdAt ?? "").localeCompare(String(asRecord(right)?.createdAt ?? ""));
  });
  let approvals: readonly ProviderApproval[] = [];
  for (const activity of activities) {
    approvals = foldApprovalActivity(approvals, activity, threadId);
  }
  return [...approvals];
}

export function pendingProviderApprovals(
  approvals: readonly ProviderApproval[],
): ProviderApproval[] {
  return approvals.filter((approval) => approval.status === "pending");
}

/** Merges the gateway's decision rows onto approvals derived from the stream. */
export function mergeProviderApprovalDecisions(
  approvals: readonly ProviderApproval[],
  decisions: readonly ProviderApprovalLocalDecision[],
): ProviderApproval[] {
  if (decisions.length === 0) return [...approvals];
  const byRequestId = new Map(decisions.map((entry) => [entry.requestId, entry]));
  return approvals.map((approval) => {
    const localDecision = byRequestId.get(approval.requestId);
    return localDecision ? { ...approval, localDecision } : approval;
  });
}

/**
 * Port of `normalizeOfferedDecisions()` in src/providerApprovals.mjs. The distinction between the
 * three results is load-bearing:
 *
 *   absent or not an array        -> undefined. The request did not state a set; fall back.
 *   array                         -> the recognised decisions, de-duplicated, in catalogue order.
 *   array, none recognised        -> []. Named something, but nothing this console can safely send.
 */
function normalizeOfferedDecisions(value: unknown): ProviderApprovalDecision[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const recognised = new Set<ProviderApprovalDecision>();
  for (const entry of value) {
    const decision = normalizeDecision(entry);
    if (decision) recognised.add(decision);
  }
  return PROVIDER_APPROVAL_DECISIONS.filter((decision) => recognised.has(decision));
}

// The gateway also accepts two legacy names; a list that uses them must not be read as empty.
const LEGACY_DECISION_ALIASES: ReadonlyMap<string, ProviderApprovalDecision> = new Map([
  ["approve", "accept"],
  ["reject", "decline"],
]);

function normalizeDecision(value: unknown): ProviderApprovalDecision | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const direct = PROVIDER_APPROVAL_DECISIONS.find((decision) => decision === trimmed);
  return direct ?? LEGACY_DECISION_ALIASES.get(trimmed) ?? null;
}

function normalizeRequestKind(value: unknown): ProviderRequestKind | null {
  const kind = stringOrNull(value);
  return kind !== null && (PROVIDER_REQUEST_KINDS as readonly string[]).includes(kind)
    ? kind as ProviderRequestKind
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
