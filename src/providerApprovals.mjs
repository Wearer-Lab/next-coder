// Provider approvals: the questions T3 asks on the agent's behalf.
//
// There are TWO approval concepts in this system and they are not the same question.
//
//   GATEWAY APPROVAL   `evaluateIntentPolicy()` refused to dispatch something the owner asked
//                      for — "you tried to run `rm -rf`". It is a `command` row with status
//                      `approval_required`, answered at POST /v1/commands/:id/approve|reject.
//                      Nothing has left the gateway; declining means the intent is never sent.
//
//   PROVIDER APPROVAL  a turn is ALREADY RUNNING inside T3 and the provider has stopped mid-turn
//                      to ask permission — "Claude wants to edit src/app.mjs". It is not a
//                      gateway record at all: it lives in T3, it is holding a live provider
//                      callback open, and it expires with the session. Declining does not undo a
//                      dispatch, it answers a question the agent is blocked on.
//
// Collapsing those into one list would be a correctness bug, not a cosmetic one: the buttons mean
// different things, the consequences differ, and one of the two has a timeout the gateway does not
// control. Every record this module produces is stamped `kind: "provider"`, and gateway approvals
// are stamped `kind: "gateway"` where the two are surfaced side by side.
//
// ---------------------------------------------------------------------------------------------
// T3 0.1.x SUPERSEDES THE 0.0.32 CONTRACT BELOW — read this block first
// ---------------------------------------------------------------------------------------------
//
// Everything after this block was established against T3 Code 0.0.32. The owner now runs 0.1.1
// and 0.1.5 is installed. Both are readable as plain text: docs/t3-version-audit.md section 5 is
// the extraction (the `t3` executable embeds the server bundle verbatim). Citations in this block
// are LINE NUMBERS INTO THAT EXTRACTED BUNDLE, per version, never into a source tree — "0.1.5 :N"
// means line N of the 0.1.5 bundle. Identifiers are given so a grep survives line drift.
//
//   * THE DECISION SET IS FIVE, in this order (0.1.5 :36665-36671 `ProviderApprovalDecision`;
//     0.1.1 :31403-31409; absent from 0.0.32):
//         accept, acceptForSession, acceptAlways, decline, cancel
//     `runtime-request.respond` takes any of the five (0.1.5 :39908-39917), and a runtime
//     request's resolved `decision` is typed the same (`OrchestrationV2RuntimeRequest`,
//     0.1.5 :38103-38135).
//
//   * `acceptForSession` AND `acceptAlways` ARE NOT SYNONYMS, AND NOT UNIFORM ACROSS PROVIDERS.
//     What each adapter does with them is the whole story, so it is recorded here rather than
//     inferred from the names:
//       Claude v2   `permissionResultFromDecision` (0.1.5 :274105-274123; 0.1.1 :265743): accept
//                   and acceptForSession ALLOW, acceptForSession additionally returns
//                   `updatedPermissions` with `destination: "session"` (`toSessionPermissionUpdates`, :274121-274134) — a rule
//                   that lives for the session. EVERYTHING ELSE, `acceptAlways` included, falls
//                   to `behavior: "deny"`. Claude has no "always" concept here: sending it
//                   silently DENIES what the owner meant to allow.
//       Codex v2    command / file-change approvals FOLD acceptAlways into acceptForSession
//                   before answering (0.1.5 :307972-307973, :308021-308022); a permissions
//                   request answers acceptAlways with an EMPTY grant (`permissionsResponseFromDecision`
//                   :304691-304699 — only accept / acceptForSession grant anything). So for
//                   Codex "always" is session-scoped or a refusal, never forever.
//                   The one place Codex offers a real forever is an MCP elicitation
//                   (`requestKind: "mcp-elicitation"`, :308089): `describeMcpElicitation`
//                   (:304363-304405) lists acceptAlways ONLY when the elicitation's own
//                   `_meta.persist` / `allowPersistentApproval` / a persistence form field says
//                   so, and `toMcpElicitationResponse` (:304407-304427) sends `_meta.persist:
//                   "session"` for one and `"always"` for the other.
//       ACP         `selectPermissionOptionId` (0.1.5 :191154-191157): acceptForSession ->
//                   `allow_always`, accept -> `allow_once`, EVERYTHING ELSE -> `reject_once`.
//                   acceptAlways is a rejection on the generic ACP adapter.
//       OpenCode    both persist the same grant rule (`respondToRuntimeRequest` :342513) and
//                   both map to "always" (`toOpenCodePermissionReply` :336263-336269): here the
//                   two are the same act.
//       Muse        the two are different: `museApprovalDecision` (:345625-345633) maps a policy
//                   amendment with scope `session` to acceptForSession and `localPersistent` to
//                   acceptAlways.
//     Net: acceptAlways is meaningful only where a provider SAYS it offers it. A request that
//     states no `options` must therefore never be answered with it — see
//     DEFAULT_OFFERED_PROVIDER_APPROVAL_DECISIONS.
//
//   * REQUESTS CARRY THEIR OWN `options[]`. An `approval_request` turn item has
//     `options?: ProviderApprovalOption[]`, each `{decision, label, warning?}` (0.1.5 :36673-36677
//     and :38519-38527; the field is already in 0.1.1 :33949-33955). Providers use it to narrow:
//     Claude 0.1.5 sends only decline+accept when its CLI says not to offer a standing rule
//     (`CLAUDE_NO_STANDING_GRANT_OPTIONS` :275580, `claudeApprovalPresentation` :274096;
//     0.1.1 reads the flag at :254769 but never forwards it), Codex MCP builds the list above,
//     Grok and Antigravity derive theirs from the ACP option kinds (:321147, :205360).
//     T3's server does NOT enforce it: `dispatchRuntimeRequestRespond` (0.1.5 :366820-366860)
//     checks only that the request exists, is `pending`, and is not `not_resumable`. The
//     gateway's narrowing (`offeredDecisions`) is therefore the only guard — and the reason a
//     request's list is forwarded rather than ignored.
//
//   * WHEN `options` IS ABSENT T3's OWN UI OFFERS EXACTLY FOUR: cancel, decline,
//     acceptForSession ("Always allow this session"), accept ("Approve"). It is the fallback
//     constant in the web client (0.1.5 client asset `useTimelineFollow-*.js`, identifier `Rd`;
//     0.1.1 `_chat-*.js`, identifier `KF`) — acceptAlways is NOT in it. That is the evidence for
//     the default set below.
//
//   * REQUEST KINDS ARE FIVE (0.1.5 :36658-36664 `ProviderRequestKind`; 0.1.1 :31395):
//         command, file-read, file-change, mcp-elicitation, permission
//     `mcp-elicitation` is Codex (above). `permission` is the generic bucket for a provider that
//     asks about something that is neither a shell command nor a file (Muse, 0.1.5 :346812).
//     A runtime request's own `kind` additionally admits `dynamic_tool_call | user_input |
//     auth_refresh` (:38108-38112); only the five above are approvals, and only those have an
//     `approval_request` turn item.
//
//   * PENDING STATE IS NOT `activities[]` ON THE PROTOCOL-2 WIRE. It is
//     `runtimeRequests[].status` = pending | resolved | expired | cancelled (0.1.5 :38113-38118)
//     joined to its `approval_request` turn item by request id. `collectProviderApprovals()` is
//     still the right reader, but only because `packages/connector/src/t3v2.mjs` re-synthesises
//     the legacy `approval.requested|resolved` / `provider.approval.respond.failed` activities
//     from that join; the adapter owns the translation and this module owns the meaning. T3 now
//     refuses a response to a dead request AT DISPATCH, synchronously (`Runtime request … is
//     expired.`, :366828-366832) and every `not_resumable` request is already non-pending
//     (0.1.5 :360140-360155, :368040-368055, :381875-381888), so the 0.0.32 "accepts, then fails
//     later" behaviour no longer applies on protocol 2 — the stale-phrase matching below still
//     holds because the adapter writes the phrase itself.
//
// ---------------------------------------------------------------------------------------------
// THE 0.0.32 CONTRACT, ESTABLISHED FROM T3'S OWN SOURCE
// ---------------------------------------------------------------------------------------------
//
// Verified against T3 Code 0.0.32 (`/opt/homebrew/lib/node_modules/t3/package.json` said 0.0.32);
// its source map at `/opt/homebrew/lib/node_modules/t3/dist/bin.mjs.map` shipped
// `sourcesContent` for every one of its own packages. Line numbers below are into those sources.
// Still correct for a 0.0.x environment (protocol 1); superseded where the block above says so.
//
// THE DECISION SET — four values in 0.0.32 (five from 0.1.1, see above), not two:
//
//   packages/contracts/src/orchestration.ts:134-140
//     export const ProviderApprovalDecision = Schema.Literals([
//       "accept", "acceptForSession", "decline", "cancel",
//     ]);
//
//   What each one MEANS is settled by the adapters, not guessed:
//     src/provider/acp/AcpAdapterSupport.ts:46-56 maps them to the ACP permission outcomes
//       acceptForSession -> "allow-always"   accept -> "allow-once"   decline -> "reject-once"
//     src/provider/Layers/ClaudeAdapter.ts:4033-4050 maps them to the Claude SDK PermissionResult
//       accept/acceptForSession -> {behavior:"allow"}, and acceptForSession additionally returns
//       `updatedPermissions: [...pendingApproval.suggestions]` — i.e. it WRITES A RULE, which is
//       exactly why it is treated as a distinct capability by the policy engine.
//       decline -> {behavior:"deny", message:"User declined tool execution."}
//       cancel  -> {behavior:"deny", message:"User cancelled tool execution."} and is also what
//                  the adapter resolves a pending decision to when the turn is torn down
//                  (ClaudeAdapter.ts:3604, :3998).
//
// SUBMITTING A DECISION:
//
//   packages/contracts/src/orchestration.ts:821-828
//     ThreadApprovalRespondCommand = {type:"thread.approval.respond", commandId, threadId,
//                                     requestId, decision, createdAt}
//   It is a member of ClientOrchestrationCommand (:898), which is the payload of
//   POST /api/orchestration/dispatch (packages/contracts/src/environmentHttp.ts:495-499). So no
//   new transport: the same dispatch the gateway already speaks.
//
// DISCOVERING A PENDING APPROVAL:
//
//   NOT from `GET /api/orchestration/snapshot`. That route serves the *shell* read model with
//   "thread bodies empty" (src/orchestration/http.ts:35-38) — test/fixtures/t3-snapshot.json
//   confirms no `activities` on any thread. `hasPendingApprovals` exists but only on
//   OrchestrationThreadShell (orchestration.ts:440), which that route does not return either.
//
//   The evidence is `thread.activities[]`, served by `GET /api/orchestration/threads/:threadId`
//   and by the live stream (`thread.activity-appended` events, and the subscribeThread snapshot).
//   src/orchestration/Layers/ProviderRuntimeIngestion.ts:371-415 builds them:
//
//     kind "approval.requested"  tone "approval"
//       payload {requestId, requestKind?, requestType, detail?}
//     kind "approval.resolved"   tone "approval"
//       payload {requestId, requestKind?, requestType, decision?}
//
//   `requestKind` is command | file-read | file-change, derived from the canonical request type
//   at :296-311. `tool_user_input` requests are deliberately excluded there (:372) — those are
//   structured user input, a different feature, and they are excluded here too.
//
//   These payloads survive the wire: `projectActivityPayload`
//   (src/orchestration/ActivityPayloadProjection.ts) slims only payloads that carry a `data`
//   object, and an approval payload has none, so it is returned untouched.
//
// A REQUEST THAT WAS ABANDONED:
//
//   T3 does NOT reject a response to a dead request at dispatch time. The decider only checks the
//   thread exists (src/orchestration/decider.ts:1001-1005); the failure happens asynchronously in
//   the reactor, which appends an activity instead:
//
//     src/orchestration/Layers/ProviderCommandReactor.ts:1210-1249
//       kind "provider.approval.respond.failed", tone "error",
//       payload {detail, requestId}
//
//   and when the provider no longer knows the request, `detail` is the sentence built at :281-287:
//     "Stale pending approval request: <id>. Provider callback state does not survive app
//      restarts or recovered sessions. Restart the turn to continue."
//
//   T3's own decider treats such a failure as CLEARING the open request
//   (decider.ts:42-86, `hasOpenBlockingRequest` + `isStaleRequestFailureDetail`) — but only when
//   the detail marks it stale/unknown; an ordinary failure leaves the request open, because the
//   provider is still waiting. `collectProviderApprovals()` below is a port of that rule, with the
//   same clearing conditions, so the gateway and T3 cannot disagree about what is still pending.

/**
 * The five decisions T3 0.1.x accepts, in T3's own declaration order (`ProviderApprovalDecision`,
 * 0.1.5 bundle :36665-36671). Order is the order a UI should offer them.
 *
 * A vocabulary entry says "the wire accepts this", NOT "every request may be answered with it":
 * see DEFAULT_OFFERED_PROVIDER_APPROVAL_DECISIONS for why `acceptAlways` is not in the default.
 */
export const PROVIDER_APPROVAL_DECISIONS = Object.freeze([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
]);

/**
 * What a request is read as offering when it states no `options` of its own.
 *
 * Exactly T3's own web-UI fallback (0.1.5 client constant `Rd`, 0.1.1 `KF`): cancel, decline,
 * acceptForSession, accept. `acceptAlways` is deliberately absent. Claude's adapter turns it into
 * a DENY and ACP into a rejection (see the contract block above), so offering it where the
 * provider has not said it exists would turn the owner's "always allow" into a silent refusal.
 * Only a request that LISTS it can be answered with it.
 */
export const DEFAULT_OFFERED_PROVIDER_APPROVAL_DECISIONS = Object.freeze([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);

/**
 * Decisions that leave a standing rule behind rather than answering one question.
 *
 * Both do, on the providers that honour them: Claude's acceptForSession returns
 * `updatedPermissions` with `destination: "session"` (0.1.5 :274121-274134), OpenCode writes the
 * grant for either (:342513), Codex MCP sends `_meta.persist` for either (:304407-304427). A
 * durable grant is a different decision from a one-off yes, so the policy engine gates the pair
 * above `accept` — and gates them from each other, see ALWAYS_PROVIDER_APPROVAL_DECISIONS.
 */
export const PERSISTENT_PROVIDER_APPROVAL_DECISIONS = Object.freeze([
  "acceptForSession",
  "acceptAlways",
]);

/**
 * The stronger half of the persistent pair: a grant meant to outlive the session.
 *
 * Session scope and "forever" are different acts with different blast radii — Muse draws exactly
 * that line (`session` vs `localPersistent`, 0.1.5 :345629) and Codex MCP does too (`persist:
 * "session"` vs `"always"`) — so they are separate capabilities rather than one. An owner may
 * reasonably allow a profile to say "for this session" and still refuse "from now on".
 */
export const ALWAYS_PROVIDER_APPROVAL_DECISIONS = Object.freeze(["acceptAlways"]);

/**
 * The binary vocabulary that existed before the full set was established.
 *
 * Firmware in the field posts `approve` / `reject` and cannot be changed from here, so both keep
 * working — as ALIASES onto the canonical values, never as a separate wire vocabulary.
 */
export const LEGACY_PROVIDER_APPROVAL_DECISIONS = Object.freeze({
  approve: "accept",
  reject: "decline",
});

const DECISION_SET = new Set(PROVIDER_APPROVAL_DECISIONS);
const PERSISTENT_SET = new Set(PERSISTENT_PROVIDER_APPROVAL_DECISIONS);
const ALWAYS_SET = new Set(ALWAYS_PROVIDER_APPROVAL_DECISIONS);

/** Human-facing description of each decision, for a console that must not lie about the choice. */
export const PROVIDER_APPROVAL_DECISION_CATALOGUE = Object.freeze([
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
    // Honest about the per-provider split rather than promising "forever": Codex folds it into
    // the session grant for commands and edits, Claude and ACP do not support it at all, and it
    // only appears on a request whose provider listed it.
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
]);

export function isProviderApprovalDecision(value) {
  return typeof value === "string" && DECISION_SET.has(value);
}

export function isPersistentProviderApprovalDecision(value) {
  return typeof value === "string" && PERSISTENT_SET.has(value);
}

/** True for the standing "from now on" grant, which is gated more tightly than the session one. */
export function isAlwaysProviderApprovalDecision(value) {
  return typeof value === "string" && ALWAYS_SET.has(value);
}

/**
 * The capability that answering with this decision requires. One place, so the policy engine and
 * the per-request button list cannot drift apart (they once did, for `approval_response_persistent`
 * in the other direction: a hardcoded copy un-gated a new capability).
 */
export function capabilityForProviderApprovalDecision(decision) {
  if (isAlwaysProviderApprovalDecision(decision)) return "approval_response_always";
  if (isPersistentProviderApprovalDecision(decision)) return "approval_response_persistent";
  return "approval_response";
}

/**
 * Canonicalize a decision from any accepted spelling.
 *
 * @returns {string|null} one of PROVIDER_APPROVAL_DECISIONS, or null when unrecognised.
 */
export function normalizeProviderApprovalDecision(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (DECISION_SET.has(trimmed)) return trimmed;
  // `hasOwn`, not a bare lookup: "constructor" and "__proto__" are properties of every object and
  // a bare index would hand back a function as though it were a decision.
  return Object.hasOwn(LEGACY_PROVIDER_APPROVAL_DECISIONS, trimmed)
    ? LEGACY_PROVIDER_APPROVAL_DECISIONS[trimmed]
    : null;
}

/**
 * The five request kinds T3 0.1.x classifies an approval into (`ProviderRequestKind`, 0.1.5
 * bundle :36658-36664), plus null for anything else. 0.0.32 had the first three.
 */
export const PROVIDER_REQUEST_KINDS = Object.freeze([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
]);

// Titles only say WHAT KIND of thing is being asked; the specifics are the request's own `detail`.
// The two newer kinds are deliberately vague: an MCP elicitation is a connected tool asking the
// owner to approve use of itself, and `permission` is a provider's catch-all for a grant that is
// neither a command nor a file.
const REQUEST_KIND_LABELS = Object.freeze({
  command: "Run a command",
  "file-read": "Read a file",
  "file-change": "Change a file",
  "mcp-elicitation": "Approve a connected tool",
  permission: "Grant a permission",
});

/**
 * Port of T3's `isStaleRequestFailureDetail` (src/orchestration/decider.ts:42-54).
 *
 * A `provider.approval.respond.failed` clears the open request ONLY when the provider no longer
 * knows about it. Any other failure — a transport error, a dead session — leaves it open, because
 * something is still blocked on an answer.
 */
export function isStaleProviderRequestDetail(detail) {
  if (typeof detail !== "string") return false;
  const lowered = detail.toLowerCase();
  return lowered.includes("stale pending approval request")
    || lowered.includes("unknown pending approval request")
    || lowered.includes("unknown pending permission request");
}

/**
 * Every provider approval this thread's work log knows about, newest activity last.
 *
 * Ordering matters and is not the array order: activities carry an optional per-turn `sequence`
 * (orchestration.ts:323) and a `createdAt`, and a resolution must be applied after the request it
 * resolves. Sorted on (sequence, createdAt) exactly like `pendingThreadInteractions()` already
 * does in src/t3Client.mjs.
 *
 * @param {object|null} thread a hydrated thread from GET /api/orchestration/threads/:threadId,
 *   or the `thread` of a live-stream snapshot. A thread with no `activities` yields nothing —
 *   which is the correct answer for the bodiless shell snapshot, not an error.
 * @returns {Array<object>} one record per requestId, in request order.
 */
export function collectProviderApprovals(thread, { threadId = null } = {}) {
  const activities = Array.isArray(thread?.activities) ? [...thread.activities] : [];
  activities.sort((left, right) => {
    const bySequence = (Number(left?.sequence) || 0) - (Number(right?.sequence) || 0);
    if (bySequence !== 0) return bySequence;
    return String(left?.createdAt ?? "").localeCompare(String(right?.createdAt ?? ""));
  });

  const resolvedThreadId = stringOrNull(threadId) ?? stringOrNull(thread?.id);
  /** @type {Map<string, object>} */
  const byRequestId = new Map();

  for (const activity of activities) {
    const payload = asRecord(activity?.payload);
    const requestId = stringOrNull(payload?.requestId);
    if (!requestId) continue;
    const kind = stringOrNull(activity?.kind);

    if (kind === "approval.requested") {
      // A repeated request id restarts the record: the provider is asking again.
      byRequestId.set(requestId, {
        kind: "provider",
        requestId,
        threadId: resolvedThreadId,
        activityId: stringOrNull(activity?.id),
        requestKind: normalizeRequestKind(payload?.requestKind),
        requestType: stringOrNull(payload?.requestType),
        // The provider's own words about what it wants to do. User content and code: never
        // persisted by the gateway, only relayed live.
        detail: stringOrNull(payload?.detail),
        summary: stringOrNull(activity?.summary) ?? "Approval requested",
        // Which decisions THIS request accepts.
        //
        // Two sources state it, and both arrive here as `payload.decisions`:
        //   * a direct Codex/Claude/ACP runtime offers whatever the native agent exposed, records
        //     that list on the activity, and refuses anything outside it (AGENT_DECISION_UNSUPPORTED);
        //   * T3 0.1.x puts `options[]` on the approval itself, and the connector's protocol-2
        //     adapter maps it into the same field (packages/connector/src/t3v2.mjs). T3's server
        //     does NOT enforce that list when it is answered, so this is the only place it bites.
        // Without reading it back, the console drew every button for every request and some of
        // them failed (or, worse, were silently turned into a denial) in ways the owner could do
        // nothing about. Absent means "unstated": read as DEFAULT_OFFERED_PROVIDER_APPROVAL_DECISIONS
        // — T3's own fallback — NOT as the whole vocabulary, which would include `acceptAlways`.
        // The record keeps `null` for "unstated" so a client can still tell it from "offers four".
        offeredDecisions: normalizeOfferedDecisions(payload?.decisions),
        turnId: stringOrNull(activity?.turnId),
        requestedAt: stringOrNull(activity?.createdAt),
        status: "pending",
        decision: null,
        resolvedAt: null,
        failure: null,
      });
      continue;
    }

    const existing = byRequestId.get(requestId);
    if (!existing) continue;

    if (kind === "approval.resolved") {
      existing.status = "resolved";
      existing.decision = normalizeProviderApprovalDecision(payload?.decision)
        ?? stringOrNull(payload?.decision);
      existing.resolvedAt = stringOrNull(activity?.createdAt);
      continue;
    }

    if (kind === "provider.approval.respond.failed") {
      const detail = stringOrNull(payload?.detail);
      existing.failure = detail;
      // T3's own rule: only a stale/unknown failure closes the request.
      if (isStaleProviderRequestDetail(detail)) {
        existing.status = "stale";
        existing.resolvedAt = stringOrNull(activity?.createdAt);
      }
    }
  }

  return [...byRequestId.values()];
}

/** Just the ones still blocking the agent. */
export function pendingProviderApprovals(thread, options = {}) {
  return collectProviderApprovals(thread, options).filter((approval) => approval.status === "pending");
}

export function findProviderApproval(thread, requestId, options = {}) {
  const wanted = stringOrNull(requestId);
  if (!wanted) return null;
  return collectProviderApprovals(thread, options)
    .find((approval) => approval.requestId === wanted) ?? null;
}

/**
 * The decisions a request is actually open to, whoever is asking: its own list when it stated
 * one, otherwise T3's default four.
 */
export function offeredProviderApprovalDecisions(approval = null) {
  return normalizeOfferedDecisions(approval?.offeredDecisions) ?? DEFAULT_OFFERED_PROVIDER_APPROVAL_DECISIONS;
}

/**
 * Whether this request is open to this decision, independent of who is asking. This is the check
 * the answer route should make before it claims anything: T3 itself does not (see the contract
 * block), and the same decision means "deny" on some providers and "grant" on others.
 */
export function providerApprovalOffers(approval, decision) {
  const canonical = normalizeProviderApprovalDecision(decision);
  return canonical !== null && offeredProviderApprovalDecisions(approval).includes(canonical);
}

/**
 * How much of the request's detail a controller screen can show. Shared with
 * `deviceProviderApprovalView` so the clip and the rule that depends on it cannot disagree.
 */
export const DEVICE_APPROVAL_DETAIL_LIMIT = 160;

/**
 * The decisions this actor may actually give, in catalogue order.
 *
 * Three independent gates, all of which must pass for a decision to be listed:
 *   1. CAPABILITY. `acceptForSession` and `acceptAlways` are separate durable grants, each with
 *      its own capability (see src/profiles.mjs). An actor without `approval_response` at all
 *      gets an empty list — it may still SEE the approval, which is a read, but every button is
 *      refused.
 *   2. THE REQUEST. A request that stated its own decision set narrows the list; one that did not
 *      is read as T3's default four, so `acceptAlways` is never offered speculatively.
 *   3. THE REALM. Pass `realm` to say who is asking. `acceptAlways` is listed to `"user"` only —
 *      omitting `realm` is "unknown", which is treated as not-the-owner, so a forgotten argument
 *      withholds the standing grant rather than leaking it to hardware. A `"device"` is
 *      additionally refused any durable grant whose full request it cannot display: a 240x320
 *      panel shows `DEVICE_APPROVAL_DETAIL_LIMIT` characters, and a rule written on the strength
 *      of a clipped (or absent) description is not a rule the person read.
 */
export function allowedProviderApprovalDecisions(capabilities, approval = null, { realm = null } = {}) {
  const set = capabilities instanceof Set ? capabilities : new Set(capabilities ?? []);
  if (!set.has("approval_response")) return [];
  const offered = offeredProviderApprovalDecisions(approval);
  const deviceCanShowDetail = realm !== "device" || deviceCanShowFullDetail(approval);
  return PROVIDER_APPROVAL_DECISIONS.filter((decision) => {
    if (!offered.includes(decision)) return false;
    if (!set.has(capabilityForProviderApprovalDecision(decision))) return false;
    if (isAlwaysProviderApprovalDecision(decision) && realm !== "user") return false;
    if (isPersistentProviderApprovalDecision(decision) && !deviceCanShowDetail) return false;
    return true;
  });
}

function deviceCanShowFullDetail(approval) {
  const detail = stringOrNull(approval?.detail);
  return detail !== null && detail.replace(/\s+/gu, " ").trim().length <= DEVICE_APPROVAL_DETAIL_LIMIT;
}

/**
 * Keep only decisions that are both well-formed and ones T3's contract defines.
 *
 * Returns null for "the request did not say", which is not the same as "the request offers
 * nothing": an empty list after filtering means every decision it named was unrecognised, and
 * that must not silently widen back to the default set. (The T3 connector adapter makes sure it
 * never forwards such a list — see `v2OfferedDecisions` — but native runtimes and older
 * connectors are not bound by that.)
 */
function normalizeOfferedDecisions(value) {
  if (!Array.isArray(value)) return null;
  const normalized = [];
  for (const entry of value) {
    const decision = normalizeProviderApprovalDecision(entry);
    if (decision && !normalized.includes(decision)) normalized.push(decision);
  }
  return normalized;
}

/**
 * What a controller with a few square centimetres of screen needs, and nothing else.
 *
 * Deliberately smaller than the console record: no activity id, no request type, no failure text,
 * and — since the decision set grew to five — still no decision list. Which buttons to draw is
 * `allowedProviderApprovalDecisions(…, { realm: "device" })`, computed server-side per request,
 * so a new decision cannot widen what a controller displays or renders by accident.
 * `detail` is clipped because a provider can describe a file change in a paragraph and a 240x320
 * panel cannot render one.
 */
export function deviceProviderApprovalView(approval, { detailLimit = DEVICE_APPROVAL_DETAIL_LIMIT } = {}) {
  return {
    kind: "provider",
    requestId: approval.requestId,
    threadId: approval.threadId,
    requestKind: approval.requestKind,
    title: REQUEST_KIND_LABELS[approval.requestKind] ?? approval.summary,
    detail: clip(approval.detail, detailLimit),
    requestedAt: approval.requestedAt,
  };
}

function normalizeRequestKind(value) {
  const kind = stringOrNull(value);
  return kind && PROVIDER_REQUEST_KINDS.includes(kind) ? kind : null;
}

function clip(value, limit) {
  const text = stringOrNull(value);
  if (!text) return null;
  const compact = text.replace(/\s+/gu, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
