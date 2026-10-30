/**
 * Policy engine.
 *
 * `evaluateIntentPolicy()` answers one question: may this intent execute right now, and if so how
 * risky is it? The answer is assembled from eight independent **dimensions**, evaluated in a fixed
 * order (see `DIMENSION_ORDER`). Every dimension is data-driven: the rule tables below are the
 * policy, and the evaluator is a small generic loop over them.
 *
 * Dimensions:
 *
 * | dimension           | source                                   | shape                                         |
 * |---------------------|------------------------------------------|-----------------------------------------------|
 * | `subscription_tier` | `subscriptionTier`                       | `SUBSCRIPTION_TIER_RULES`                     |
 * | `device`            | `device.profile`                         | profile capability set (`src/profiles.mjs`)   |
 * | `user`              | `user.role`, `user.policy`               | `USER_ROLE_RULES` + inline constraint spec    |
 * | `environment`       | `environment.policy`, `environment.readOnly` | inline constraint spec                    |
 * | `network_location`  | `networkLocation`                        | `NETWORK_LOCATION_RULES`                      |
 * | `time_window`       | `allowedHours` (top level, user, env)    | time window spec, evaluated against `now`     |
 * | `command_type`      | `intent`                                 | `SHELL_RISK_RULES` + `BASELINE_RULES`         |
 * | `risk_level`        | `maxAutoRisk` on any constraint          | risk ceiling, escalates instead of blocking   |
 *
 * **One deliberate exception to "inert when absent":** the `acceptAlways` provider-approval
 * decision (a standing grant, see src/providerApprovals.mjs) is refused unless the caller says the
 * actor is the signed-in owner (`actorType: "user"`). It is the one decision that must fail CLOSED
 * when a caller forgets the argument — an omitted `actorType` would otherwise let a controller
 * give a grant it cannot read the detail of. Nothing else reads `actorType`.
 *
 * **Backward compatibility contract:** every dimension other than `device` and `command_type` is
 * inert when its context is absent. `evaluateIntentPolicy({ device, intent })` therefore behaves
 * exactly as it did before this file grew the other six dimensions.
 *
 * Result shape: `{ allowed, risk, reason?, requiresApproval?, matchedRule, dimension }` where
 * `matchedRule` identifies the rule that decided and `dimension` names its dimension.
 */

import { DEVICE_CAPABILITIES, capabilitiesForProfile, resolveDeviceProfile } from "./profiles.mjs";
import {
  capabilityForProviderApprovalDecision,
  isAlwaysProviderApprovalDecision,
  isPersistentProviderApprovalDecision,
} from "./providerApprovals.mjs";

/** Policy dimension identifiers, in evaluation order. */
export const POLICY_DIMENSIONS = Object.freeze({
  SUBSCRIPTION_TIER: "subscription_tier",
  DEVICE: "device",
  USER: "user",
  ENVIRONMENT: "environment",
  NETWORK_LOCATION: "network_location",
  TIME_WINDOW: "time_window",
  COMMAND_TYPE: "command_type",
  RISK_LEVEL: "risk_level",
});

const DIMENSION_ORDER = Object.freeze([
  POLICY_DIMENSIONS.SUBSCRIPTION_TIER,
  POLICY_DIMENSIONS.DEVICE,
  POLICY_DIMENSIONS.USER,
  POLICY_DIMENSIONS.ENVIRONMENT,
  POLICY_DIMENSIONS.NETWORK_LOCATION,
  POLICY_DIMENSIONS.TIME_WINDOW,
  POLICY_DIMENSIONS.COMMAND_TYPE,
  POLICY_DIMENSIONS.RISK_LEVEL,
]);

/** Ordered risk ladder. `blocked` is only ever produced by a hard deny. */
const RISK_ORDER = Object.freeze(["low", "medium", "high", "blocked"]);

function riskRank(risk) {
  const index = RISK_ORDER.indexOf(risk);
  return index === -1 ? 0 : index;
}

/** `"*"` in a capability list means "every capability". */
const ALL_CAPABILITIES = "*";

// ---------------------------------------------------------------------------
// Dimension: command_type — shell screening
// ---------------------------------------------------------------------------

/**
 * Shell risk rules, evaluated top to bottom; the **first** match decides. Order matters: the
 * broad `rm`/file-deletion rule is listed after `rm -rf` so the destructive variant keeps its
 * higher risk classification.
 *
 * Every rule here is confirmation-gated rather than blocked outright: the command becomes an
 * `approval_required` command that an owner resolves via `/v1/commands/:id/approve|reject`.
 */
export const SHELL_RISK_RULES = Object.freeze([
  // -- destructive / privilege escalation -----------------------------------
  {
    id: "shell.destructive.rm-rf",
    category: "destructive",
    pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r)\b/u,
    risk: "high",
    reason: "Recursive force delete requires an explicit higher-trust confirmation path.",
  },
  {
    id: "shell.destructive.sudo",
    category: "destructive",
    pattern: /\bsudo\b/u,
    risk: "high",
    reason: "Privilege escalation requires an explicit higher-trust confirmation path.",
  },
  {
    id: "shell.destructive.chmod-777",
    category: "destructive",
    pattern: /\bchmod\s+777\b/u,
    risk: "high",
    reason: "World-writable permission changes require an explicit higher-trust confirmation path.",
  },
  {
    id: "shell.destructive.disk",
    category: "destructive",
    pattern: /\b(chown|mkfs|dd)\b/u,
    risk: "high",
    reason: "Direct dangerous shell input requires an explicit higher-trust confirmation path.",
  },
  // -- version control / deployment -----------------------------------------
  {
    id: "shell.vcs.git-push",
    category: "version_control",
    pattern: /\bgit\s+push\b/u,
    risk: "high",
    reason: "Pushing code to a remote requires an explicit higher-trust confirmation path.",
  },
  {
    id: "shell.deploy.infra",
    category: "deployment",
    pattern: /\b(kubectl|terraform)\s+(apply|destroy)\b/u,
    risk: "high",
    reason: "Infrastructure deployment requires an explicit higher-trust confirmation path.",
  },
  {
    id: "shell.deploy.vercel",
    category: "deployment",
    pattern: /\bvercel\s+deploy\b/u,
    risk: "high",
    reason: "Deployment requires an explicit higher-trust confirmation path.",
  },
  {
    id: "shell.deploy.npm-publish",
    category: "deployment",
    pattern: /\bnpm\s+publish\b/u,
    risk: "high",
    reason: "Publishing a package requires an explicit higher-trust confirmation path.",
  },
  // -- credential access -----------------------------------------------------
  {
    id: "shell.credentials.ssh-dir",
    category: "credential_access",
    pattern: /(^|[\s"'=:(/])~?\/?\.ssh(\/|\b)/u,
    risk: "high",
    reason: "Reading SSH material requires an explicit higher-trust confirmation path.",
  },
  {
    id: "shell.credentials.private-key",
    category: "credential_access",
    pattern: /(\bid_(rsa|dsa|ecdsa|ed25519)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\.pem\b|\.p12\b|\.pfx\b)/u,
    risk: "high",
    reason: "Reading private key material requires an explicit higher-trust confirmation path.",
  },
  {
    id: "shell.credentials.dotenv",
    category: "credential_access",
    pattern: /(^|[\s"'=:(/])\.env(\.[\w-]+)?(\b|$)/u,
    risk: "high",
    reason: "Reading environment secret files requires an explicit higher-trust confirmation path.",
  },
  {
    id: "shell.credentials.cloud-config",
    category: "credential_access",
    pattern: /(\.aws\/credentials|\.config\/gcloud|\.kube\/config|\.docker\/config\.json|\.netrc\b|\.npmrc\b|\.pypirc\b|\.git-credentials\b)/u,
    risk: "high",
    reason: "Reading stored cloud or registry credentials requires an explicit higher-trust confirmation path.",
  },
  {
    id: "shell.credentials.env-dump",
    category: "credential_access",
    pattern: /(\bprintenv\b|(^|[;&|]\s*)env\s*($|[|>;&]))/u,
    risk: "high",
    reason: "Dumping the process environment requires an explicit higher-trust confirmation path.",
  },
  {
    id: "shell.credentials.token-env-var",
    category: "credential_access",
    // Both `$GITHUB_TOKEN`-style references and bare well-known secret variable names.
    pattern: /\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)*_(TOKEN|SECRET|SECRETS|API_KEY|APIKEY|ACCESS_KEY|SECRET_KEY|PASSWORD|CREDENTIALS|PRIVATE_KEY)\b/u,
    risk: "high",
    reason: "Referencing credential environment variables requires an explicit higher-trust confirmation path.",
  },
  {
    id: "shell.credentials.keychain",
    category: "credential_access",
    pattern: /(\bsecurity\s+find-(generic|internet)-password\b|\bgcloud\s+auth\s+print-(access|identity)-token\b|\baws\s+configure\s+get\b)/u,
    risk: "high",
    reason: "Reading a credential store requires an explicit higher-trust confirmation path.",
  },
  // -- file deletion ---------------------------------------------------------
  {
    id: "shell.file-deletion.remove",
    category: "file_deletion",
    pattern: /\b(rm|rmdir|unlink|shred|truncate)\b/u,
    risk: "high",
    reason: "File deletion requires an explicit higher-trust confirmation path.",
  },
  {
    id: "shell.file-deletion.find-delete",
    category: "file_deletion",
    pattern: /\bfind\b[\s\S]*\s-(delete|exec\s+rm)\b/u,
    risk: "high",
    reason: "Bulk file deletion requires an explicit higher-trust confirmation path.",
  },
  {
    id: "shell.file-deletion.redirect-truncate",
    category: "file_deletion",
    pattern: /(^|[;&|]\s*)>\s*\S/u,
    risk: "high",
    reason: "Truncating a file by redirection requires an explicit higher-trust confirmation path.",
  },
  // -- remote code execution / package install ------------------------------
  {
    id: "shell.remote-exec.pipe-to-shell",
    category: "remote_execution",
    pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?\S*\b(ba|z|k|da)?sh\b/u,
    risk: "high",
    reason: "Piping a downloaded script into a shell requires an explicit higher-trust confirmation path.",
  },
  {
    id: "shell.package-install.node",
    category: "package_install",
    pattern: /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b/u,
    risk: "medium",
    reason: "Installing packages requires an explicit confirmation.",
  },
  {
    id: "shell.package-install.language",
    category: "package_install",
    pattern: /\b(pip3?|pipx|gem|cargo|go|composer|poetry|uv)\s+(install|add|get)\b/u,
    risk: "medium",
    reason: "Installing packages requires an explicit confirmation.",
  },
  {
    id: "shell.package-install.system",
    category: "package_install",
    pattern: /\b(apt|apt-get|yum|dnf|apk|pacman|brew|choco|winget)\s+(install|add|-S)\b/u,
    risk: "medium",
    reason: "Installing system packages requires an explicit confirmation.",
  },
]);

/**
 * Baseline risk for an intent when nothing dangerous matched. First match wins.
 */
const BASELINE_RULES = Object.freeze([
  {
    // A raw terminal write is unscreened by definition — no pattern matching can make it safe,
    // so it is always high risk and always confirmed.
    id: "baseline.terminal-input",
    risk: "high",
    approval: true,
    reason: "Direct terminal input is unscreened and always requires an explicit confirmation.",
    matches: (intent) => intent.type === "terminal_input",
  },
  {
    id: "baseline.shell-input",
    risk: "medium",
    matches: (intent) => intent.type === "shell_input",
  },
  {
    // `acceptAlways`: a grant meant to outlive the session, at least as durable as the one below,
    // so it is judged at least as hard — same `high` risk, and therefore the same escalation to
    // an owner confirmation under any `maxAutoRisk` ceiling of medium or below. It is its own rule
    // (and rule id) rather than a widened predicate on the next one so an audit row says which of
    // the two grants was held for confirmation. It MUST precede the session rule, which matches
    // every persistent decision.
    id: "baseline.approval-accept-always",
    risk: "high",
    matches: (intent) => intent.type === "approval_response"
      && isAlwaysProviderApprovalDecision(intent.decision),
  },
  {
    // Granting a provider a permission that outlives the question is a higher-risk act than
    // answering the question. Under any `maxAutoRisk` ceiling of medium or below — the free tier,
    // an untrusted network, a time window that is closing — it escalates to an owner confirmation
    // instead of dispatching, which is the point: a standing grant is the one approval decision
    // that should be hard to make by accident. (Id kept: it is recorded on stored command rows.)
    id: "baseline.approval-accept-for-session",
    risk: "high",
    matches: (intent) => intent.type === "approval_response"
      && isPersistentProviderApprovalDecision(intent.decision),
  },
  {
    // Allowing one request. Declining and cancelling fall through to `baseline.default` (low):
    // refusing an agent is never the risky direction.
    id: "baseline.approval-accept",
    risk: "medium",
    matches: (intent) => intent.type === "approval_response" && intent.decision === "accept",
  },
  {
    // Answering a question is not granting a permission: the agent asked, the owner replied, and
    // the turn continues with a value it was already waiting for. Nothing is executed and no rule
    // is written. Free text is the most powerful shape and is exactly as powerful as
    // `agent_prompt`, which is `baseline.default` too — so this is stated explicitly rather than
    // left to fall through, precisely so that it is a decision on the record.
    id: "baseline.user-input-response",
    risk: "low",
    matches: (intent) => intent.type === "user_input_response",
  },
  { id: "baseline.default", risk: "low", matches: () => true },
]);

// ---------------------------------------------------------------------------
// Dimension: subscription_tier
// ---------------------------------------------------------------------------

/**
 * Entitlements per billing tier.
 *
 * - `deny` — capability is unavailable on this tier; the intent is blocked outright.
 * - `approval` — capability is available but always requires owner confirmation.
 * - `maxAutoRisk` — the highest risk level that may dispatch without confirmation.
 *
 * An **unrecognised** tier string resolves to `UNKNOWN_TIER_FALLBACK` (deny-by-default): a typo in
 * billing metadata must not silently grant shell access. An **absent** tier applies no rule at all,
 * which is what keeps `evaluateIntentPolicy({ device, intent })` unchanged.
 */
export const SUBSCRIPTION_TIER_RULES = Object.freeze({
  free: { id: "tier.free", deny: ["shell_input"], approval: [], maxAutoRisk: "medium" },
  starter: { id: "tier.starter", deny: [], approval: [], maxAutoRisk: "low" },
  pro: { id: "tier.pro", deny: [], approval: [], maxAutoRisk: "medium" },
  team: { id: "tier.team", deny: [], approval: [], maxAutoRisk: "medium" },
  enterprise: { id: "tier.enterprise", deny: [], approval: [], maxAutoRisk: "medium" },
});

const UNKNOWN_TIER_FALLBACK = "free";

// ---------------------------------------------------------------------------
// Dimension: user
// ---------------------------------------------------------------------------

/**
 * Restrictions layered on top of the device profile by the acting user's role. An absent or
 * unrecognised role adds no restriction — roles narrow, they never widen.
 */
export const USER_ROLE_RULES = Object.freeze({
  owner: { id: "user.role.owner", deny: [], approval: [] },
  admin: { id: "user.role.admin", deny: [], approval: [] },
  operator: { id: "user.role.operator", deny: [], approval: ["shell_input"] },
  member: { id: "user.role.member", deny: [], approval: ["shell_input"] },
  viewer: {
    id: "user.role.viewer",
    deny: [
      "agent_prompt",
      "media_prompt",
      "shell_input",
      "session_control",
      "approval_response",
      "approval_response_persistent",
      "approval_response_always",
      "thread_create",
    ],
    approval: [],
  },
});

// ---------------------------------------------------------------------------
// Dimension: network_location
// ---------------------------------------------------------------------------

/**
 * Classification of where the request originated.
 *
 * Accepted input: the string `"trusted"` / `"untrusted"` / `"blocked"`, or an object carrying
 * `{ trusted: boolean }` or `{ classification: string }`. Anything present but unrecognised is
 * treated as `untrusted`. Absent means no rule applies.
 */
export const NETWORK_LOCATION_RULES = Object.freeze({
  trusted: { id: "network.trusted", deny: [], approval: [] },
  untrusted: {
    id: "network.untrusted",
    deny: [],
    approval: ["shell_input"],
    maxAutoRisk: "low",
  },
  blocked: { id: "network.blocked", deny: ALL_CAPABILITIES, approval: [] },
});

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {{ profile: string | object }} options.device      required — the acting device/profile.
 * @param {object} options.intent                            required — a normalized intent.
 * @param {{ role?: string, policy?: object }} [options.user] optional user dimension.
 * @param {{ policy?: object, readOnly?: boolean }} [options.environment] optional environment dimension.
 * @param {Date | number | string} [options.now]             optional clock for time windows.
 * @param {string | { trusted?: boolean, classification?: string }} [options.networkLocation]
 * @param {string | { tier?: string, id?: string }} [options.subscriptionTier]
 * @param {object | object[] | number[]} [options.allowedHours] optional top-level time window.
 * @param {"user" | "device" | null} [options.actorType]     who is acting. Only read for the
 *   `acceptAlways` decision, which requires `"user"`; see the module header for why that one
 *   fails closed.
 * @returns {{ allowed: boolean, risk: string, reason?: string, requiresApproval?: boolean,
 *             matchedRule: string, dimension: string }}
 */
export function evaluateIntentPolicy(options = {}) {
  const {
    device = {},
    intent = {},
    user = null,
    environment = null,
    now = null,
    networkLocation = null,
    subscriptionTier = null,
    allowedHours = null,
    actorType = null,
  } = options;

  const capability = capabilityForIntent(intent);
  const constraints = collectConstraints({
    device,
    user,
    environment,
    networkLocation,
    subscriptionTier,
    allowedHours,
    now,
  });

  // 1. Hard denies win, in dimension order.
  for (const constraint of constraints) {
    if (deniesCapability(constraint, capability)) {
      return {
        allowed: false,
        risk: "blocked",
        reason: constraint.denyReason(capability),
        matchedRule: constraint.rule,
        dimension: constraint.dimension,
      };
    }
  }

  // 1b. A standing "from now on" grant is the owner's to give, from the console, with the whole
  // request in front of them. A controller's profile may legitimately carry every OTHER
  // capability, including `approval_response_persistent`, so this cannot be left to the profile
  // dimension: `power-controller` is both the console's profile and an "advanced device" one.
  // Fails closed — an absent `actorType` is not "user".
  if (capability === "approval_response_always" && actorType !== "user") {
    return {
      allowed: false,
      risk: "blocked",
      reason: "An open-ended \"always allow\" grant can only be given from the signed-in console, not from a controller.",
      matchedRule: "realm.standing-grant-owner-only",
      dimension: POLICY_DIMENSIONS.COMMAND_TYPE,
    };
  }

  // 2. Command-type screening: dangerous shell input is confirmation-gated, not blocked.
  const shellRule = matchShellRiskRule(intent);

  // 3. Confirmation escalations from context dimensions.
  const escalations = constraints.filter((constraint) => escalatesCapability(constraint, capability));

  if (shellRule || escalations.length > 0) {
    const candidates = [
      ...(shellRule
        ? [{
          risk: shellRule.risk,
          reason: shellRule.reason,
          rule: shellRule.id,
          dimension: POLICY_DIMENSIONS.COMMAND_TYPE,
        }]
        : []),
      ...escalations.map((constraint) => ({
        risk: constraint.escalationRisk ?? "high",
        reason: constraint.approvalReason(capability),
        rule: constraint.rule,
        dimension: constraint.dimension,
      })),
    ];
    const winner = candidates.reduce((best, candidate) => (
      riskRank(candidate.risk) > riskRank(best.risk) ? candidate : best
    ), candidates[0]);
    return {
      allowed: false,
      requiresApproval: true,
      risk: winner.risk,
      reason: winner.reason,
      matchedRule: winner.rule,
      dimension: winner.dimension,
    };
  }

  // 4. Baseline risk for the intent, then the risk-level ceiling.
  const baseline = BASELINE_RULES.find((rule) => rule.matches(intent));
  const ceiling = lowestRiskCeiling(constraints);
  if (ceiling && riskRank(baseline.risk) > riskRank(ceiling.risk)) {
    return {
      allowed: false,
      requiresApproval: true,
      risk: baseline.risk,
      reason: `${ceiling.label} allows automatic dispatch up to ${ceiling.risk} risk; this intent is ${baseline.risk} risk.`,
      matchedRule: ceiling.rule,
      dimension: POLICY_DIMENSIONS.RISK_LEVEL,
    };
  }

  // Some intents are inherently confirm-always regardless of which dimension allowed them.
  if (baseline.approval === true) {
    return {
      allowed: false,
      requiresApproval: true,
      risk: baseline.risk,
      reason: baseline.reason
        ?? "This intent always requires an explicit confirmation before dispatch.",
      matchedRule: baseline.id,
      dimension: POLICY_DIMENSIONS.COMMAND_TYPE,
    };
  }

  return {
    allowed: true,
    risk: baseline.risk,
    matchedRule: baseline.id,
    dimension: POLICY_DIMENSIONS.COMMAND_TYPE,
  };
}

// ---------------------------------------------------------------------------
// Constraint model
// ---------------------------------------------------------------------------

/**
 * A constraint is the normalized, dimension-tagged form every rule table is compiled into.
 *
 * @typedef {object} Constraint
 * @property {string} dimension    one of `POLICY_DIMENSIONS`
 * @property {string} rule         rule identifier surfaced as `matchedRule`
 * @property {Set<string>|"*"} deny        capabilities blocked outright
 * @property {Set<string>|"*"} approval    capabilities requiring confirmation
 * @property {string|null} maxAutoRisk     risk ceiling for automatic dispatch
 */
function makeConstraint({ dimension, rule, spec, label, escalationRisk = "high" }) {
  const deny = normalizeCapabilityList(spec.deny ?? spec.deniedCapabilities);
  const approval = normalizeCapabilityList(spec.approval ?? spec.approvalCapabilities);
  const maxAutoRisk = RISK_ORDER.includes(spec.maxAutoRisk) ? spec.maxAutoRisk : null;
  const name = label ?? rule;
  return {
    dimension,
    rule,
    label: name,
    deny,
    approval,
    maxAutoRisk,
    escalationRisk,
    denyReason: (capability) => `${name} does not permit ${capability}.`,
    approvalReason: (capability) => `${name} requires explicit confirmation for ${capability}.`,
  };
}

function normalizeCapabilityList(value) {
  if (value === ALL_CAPABILITIES) return ALL_CAPABILITIES;
  if (!Array.isArray(value)) return new Set();
  if (value.includes(ALL_CAPABILITIES)) return ALL_CAPABILITIES;
  return new Set(value.filter((entry) => typeof entry === "string"));
}

function deniesCapability(constraint, capability) {
  if (constraint.deny === ALL_CAPABILITIES) return true;
  return constraint.deny.has(capability);
}

function escalatesCapability(constraint, capability) {
  if (constraint.approval === ALL_CAPABILITIES) return true;
  return constraint.approval.has(capability);
}

function lowestRiskCeiling(constraints) {
  let winner = null;
  for (const constraint of constraints) {
    if (!constraint.maxAutoRisk) continue;
    if (!winner || riskRank(constraint.maxAutoRisk) < riskRank(winner.risk)) {
      winner = { risk: constraint.maxAutoRisk, rule: constraint.rule, label: constraint.label };
    }
  }
  return winner;
}

/**
 * Compile every present context source into constraints, ordered by `DIMENSION_ORDER`.
 * Sources whose context is absent contribute nothing.
 */
function collectConstraints(context) {
  const byDimension = new Map(DIMENSION_ORDER.map((dimension) => [dimension, []]));
  const push = (constraint) => {
    if (constraint) byDimension.get(constraint.dimension).push(constraint);
  };

  push(subscriptionTierConstraint(context.subscriptionTier));
  push(deviceConstraint(context.device));
  for (const constraint of userConstraints(context.user)) push(constraint);
  for (const constraint of environmentConstraints(context.environment)) push(constraint);
  push(networkLocationConstraint(context.networkLocation));
  for (const constraint of timeWindowConstraints(context)) push(constraint);

  return DIMENSION_ORDER.flatMap((dimension) => byDimension.get(dimension));
}

// -- subscription_tier -------------------------------------------------------

function subscriptionTierConstraint(subscriptionTier) {
  const tier = normalizeTier(subscriptionTier);
  if (!tier) return null;
  const spec = SUBSCRIPTION_TIER_RULES[tier] ?? SUBSCRIPTION_TIER_RULES[UNKNOWN_TIER_FALLBACK];
  return makeConstraint({
    dimension: POLICY_DIMENSIONS.SUBSCRIPTION_TIER,
    rule: spec.id,
    spec,
    label: `Subscription tier "${tier}"`,
  });
}

function normalizeTier(subscriptionTier) {
  if (typeof subscriptionTier === "string" && subscriptionTier.trim()) {
    return subscriptionTier.trim().toLowerCase();
  }
  if (subscriptionTier && typeof subscriptionTier === "object") {
    const raw = subscriptionTier.tier ?? subscriptionTier.id ?? subscriptionTier.plan;
    if (typeof raw === "string" && raw.trim()) return raw.trim().toLowerCase();
  }
  return null;
}

// -- device ------------------------------------------------------------------

/**
 * The device dimension is the original capability check: whatever the profile does not list is
 * denied. `device.profile` may be a built-in profile id or a custom profile object.
 */
function deviceConstraint(device) {
  const profileRef = device?.profile;
  const capabilities = capabilitiesForProfile(profileRef);
  const resolved = resolveDeviceProfile(profileRef);
  const profileId = resolved?.id ?? (typeof profileRef === "string" ? profileRef : "unknown");
  // Deny-by-default: anything the profile does not list — including the `unknown` capability an
  // unrecognised intent type maps to — is denied.
  const denied = [...ALL_KNOWN_CAPABILITIES, "unknown"].filter((capability) => !capabilities.has(capability));
  const constraint = makeConstraint({
    dimension: POLICY_DIMENSIONS.DEVICE,
    rule: `device.profile.${profileId}`,
    spec: { deny: denied },
    label: `Device profile "${profileId}"`,
  });
  // Preserve the original wording so existing consumers/log scrapers keep working.
  constraint.denyReason = (capability) => `Device profile "${profileId}" cannot perform ${capability}.`;
  return constraint;
}

// Derived, never duplicated: a hardcoded copy silently stops gating any capability added to
// profiles.mjs, which would let a new intent type bypass the device dimension entirely.
const ALL_KNOWN_CAPABILITIES = Object.freeze([...DEVICE_CAPABILITIES]);

// -- user --------------------------------------------------------------------

function userConstraints(user) {
  if (!user || typeof user !== "object") return [];
  const constraints = [];
  const role = typeof user.role === "string" ? user.role.trim().toLowerCase() : null;
  const roleSpec = role ? USER_ROLE_RULES[role] : null;
  if (roleSpec) {
    constraints.push(makeConstraint({
      dimension: POLICY_DIMENSIONS.USER,
      rule: roleSpec.id,
      spec: roleSpec,
      label: `User role "${role}"`,
    }));
  }
  if (user.policy && typeof user.policy === "object") {
    constraints.push(makeConstraint({
      dimension: POLICY_DIMENSIONS.USER,
      rule: "user.policy",
      spec: user.policy,
      label: "User policy",
    }));
  }
  return constraints;
}

// -- environment -------------------------------------------------------------

function environmentConstraints(environment) {
  if (!environment || typeof environment !== "object") return [];
  const constraints = [];
  if (environment.readOnly === true) {
    constraints.push(makeConstraint({
      dimension: POLICY_DIMENSIONS.ENVIRONMENT,
      rule: "environment.read-only",
      spec: { deny: ALL_KNOWN_CAPABILITIES.filter((capability) => capability !== "status") },
      label: "Read-only environment",
    }));
  }
  if (environment.policy && typeof environment.policy === "object") {
    constraints.push(makeConstraint({
      dimension: POLICY_DIMENSIONS.ENVIRONMENT,
      rule: "environment.policy",
      spec: environment.policy,
      label: "Environment policy",
    }));
  }
  return constraints;
}

// -- network_location --------------------------------------------------------

function networkLocationConstraint(networkLocation) {
  const classification = normalizeNetworkLocation(networkLocation);
  if (!classification) return null;
  const spec = NETWORK_LOCATION_RULES[classification];
  return makeConstraint({
    dimension: POLICY_DIMENSIONS.NETWORK_LOCATION,
    rule: spec.id,
    spec,
    label: `${classification === "trusted" ? "Trusted" : classification === "blocked" ? "Blocked" : "Untrusted"} network location`,
  });
}

function normalizeNetworkLocation(networkLocation) {
  if (networkLocation === null || networkLocation === undefined) return null;
  if (typeof networkLocation === "string") {
    const value = networkLocation.trim().toLowerCase();
    if (!value) return null;
    return Object.hasOwn(NETWORK_LOCATION_RULES, value) ? value : "untrusted";
  }
  if (typeof networkLocation === "object") {
    if (typeof networkLocation.classification === "string") {
      return normalizeNetworkLocation(networkLocation.classification);
    }
    if (typeof networkLocation.trusted === "boolean") {
      return networkLocation.trusted ? "trusted" : "untrusted";
    }
    return "untrusted";
  }
  return "untrusted";
}

// -- time_window -------------------------------------------------------------

/**
 * Time windows come from three optional places, all using the same `allowedHours` shape and all
 * ANDed together:
 *
 *   `options.allowedHours`, `user.policy.allowedHours`, `environment.policy.allowedHours`
 *
 * Accepted shapes:
 *   `[9, 18]`                                        → 09:00–18:00, all days, all capabilities
 *   `{ start: 22, end: 6 }`                          → wraps past midnight
 *   `{ start, end, days: [1,2,3,4,5] }`              → 0 = Sunday
 *   `{ start, end, capabilities: ["shell_input"] }`  → window only gates those capabilities
 *   `{ start, end, outside: "approval" }`            → outside the window, confirm instead of block
 *   `{ start, end, timeZone: "America/New_York" }`   → evaluated in that IANA zone (default: local)
 *   `[{ start, end }, { start, end }]`               → multiple windows; inside ANY of them passes
 */
function timeWindowConstraints(context) {
  const sources = [
    { value: context.allowedHours, rule: "time.allowed-hours", label: "Allowed hours" },
    { value: context.user?.policy?.allowedHours, rule: "time.user.allowed-hours", label: "User allowed hours" },
    {
      value: context.environment?.policy?.allowedHours,
      rule: "time.environment.allowed-hours",
      label: "Environment allowed hours",
    },
  ];
  const at = toDate(context.now);
  const constraints = [];

  for (const source of sources) {
    const windows = normalizeAllowedHours(source.value);
    if (windows.length === 0) continue;
    const applicable = windows.filter((window) => window.capabilities === ALL_CAPABILITIES || window.capabilities.size > 0);
    if (applicable.length === 0) continue;

    // Group by the capability scope so a window that only gates shell_input does not gate status.
    const gated = new Map();
    for (const window of applicable) {
      const inside = isInsideWindow(window, at);
      const scope = window.capabilities === ALL_CAPABILITIES ? ALL_KNOWN_CAPABILITIES : [...window.capabilities];
      for (const capability of scope) {
        const current = gated.get(capability);
        gated.set(capability, {
          inside: (current?.inside ?? false) || inside,
          outside: window.outside,
          label: window.label ?? source.label,
        });
      }
    }

    const denied = [];
    const approval = [];
    let label = source.label;
    for (const [capability, state] of gated) {
      if (state.inside) continue;
      label = state.label;
      if (state.outside === "approval") approval.push(capability);
      else denied.push(capability);
    }
    if (denied.length === 0 && approval.length === 0) continue;

    const constraint = makeConstraint({
      dimension: POLICY_DIMENSIONS.TIME_WINDOW,
      rule: source.rule,
      spec: { deny: denied, approval },
      label,
    });
    constraint.denyReason = (capability) => `${label}: ${capability} is outside the permitted time window.`;
    constraint.approvalReason = (capability) => `${label}: ${capability} is outside the permitted time window and needs confirmation.`;
    constraints.push(constraint);
  }

  return constraints;
}

function normalizeAllowedHours(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    if (value.length === 2 && value.every((entry) => typeof entry === "number")) {
      return normalizeAllowedHours({ start: value[0], end: value[1] });
    }
    return value.flatMap((entry) => normalizeAllowedHours(entry));
  }
  if (typeof value !== "object") return [];
  const start = toHour(value.start);
  const end = toHour(value.end);
  if (start === null || end === null) return [];
  const days = Array.isArray(value.days)
    ? new Set(value.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))
    : null;
  const capabilities = Array.isArray(value.capabilities)
    ? new Set(value.capabilities.filter((entry) => typeof entry === "string"))
    : ALL_CAPABILITIES;
  return [{
    start,
    end,
    days,
    capabilities,
    outside: value.outside === "approval" ? "approval" : "deny",
    timeZone: typeof value.timeZone === "string" ? value.timeZone : null,
    label: typeof value.label === "string" ? value.label : null,
  }];
}

function toHour(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const hour = Math.trunc(value);
    return hour >= 0 && hour <= 24 ? hour : null;
  }
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?$/u);
    if (match) return toHour(Number(match[1]));
  }
  return null;
}

function toDate(now) {
  if (now instanceof Date) return now;
  if (typeof now === "number") return new Date(now);
  if (typeof now === "string" && now.trim()) {
    const parsed = new Date(now);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function isInsideWindow(window, at) {
  const { hour, day } = clockParts(at, window.timeZone);
  if (window.days && !window.days.has(day)) return false;
  if (window.start === window.end) return true; // full-day window
  if (window.start < window.end) return hour >= window.start && hour < window.end;
  return hour >= window.start || hour < window.end; // wraps past midnight
}

const WEEKDAY_INDEX = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });

function clockParts(at, timeZone) {
  if (!timeZone) return { hour: at.getHours(), day: at.getDay() };
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
      weekday: "short",
    }).formatToParts(at);
    const hourPart = parts.find((part) => part.type === "hour");
    const weekdayPart = parts.find((part) => part.type === "weekday");
    return {
      hour: hourPart ? Number(hourPart.value) : at.getHours(),
      day: weekdayPart ? WEEKDAY_INDEX[weekdayPart.value] ?? at.getDay() : at.getDay(),
    };
  } catch {
    return { hour: at.getHours(), day: at.getDay() };
  }
}

// -- command_type ------------------------------------------------------------

/** @returns {object | null} the first shell risk rule matching the intent. */
export function matchShellRiskRule(intent) {
  if (!intent || intent.type !== "shell_input" || typeof intent.command !== "string") return null;
  const command = intent.command.trim();
  if (!command) return null;
  return SHELL_RISK_RULES.find((rule) => rule.pattern.test(command)) ?? null;
}

export function capabilityForIntent(intent) {
  switch (intent?.type) {
    case "status":
      return "status";
    case "agent_prompt":
      return "agent_prompt";
    case "audio_prompt":
    case "camera_prompt":
    case "media_prompt":
      return "media_prompt";
    case "shell_input":
      return "shell_input";
    case "terminal_input":
      return "terminal_input";
    // Three capabilities, one intent type. `acceptForSession` and `acceptAlways` each leave a
    // standing permission rule behind rather than answering one question, so each is gated
    // separately from a one-off yes — and from each other — and the built-in hardware profile
    // carries neither. The mapping lives beside the vocabulary so the two cannot drift. See
    // src/profiles.mjs.
    case "approval_response":
      return capabilityForProviderApprovalDecision(intent.decision);
    // Answering a question the agent asked. One capability, not two — see the note in
    // src/profiles.mjs for why the `approval_response` split does not apply here.
    case "user_input_response":
      return "user_input_response";
    case "session_control":
    case "runtime_switch":
      return "session_control";
    // Not a dispatchable intent — `normalizeIntent()` rejects it, so a device cannot post it to
    // /v1/device/intents. It exists so POST /v1/device/threads can ask the same eight-dimension
    // question every other write asks, instead of inventing a second, weaker check.
    case "thread_create":
    case "runtime_import":
      return "thread_create";
    default:
      return "unknown";
  }
}
