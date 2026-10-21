/**
 * Device profiles map a device (or a signed-in web client acting as one) to a capability set.
 *
 * There are two kinds of profile:
 *
 * - **Built-in profiles** — the three shipped defaults below, addressed by string id. These are
 *   the only ids `isKnownDeviceProfile()` accepts, so they remain the only values persisted on a
 *   device record.
 * - **Custom profiles** — a caller-supplied plain object `{ id, capabilities }` passed straight to
 *   `capabilitiesForProfile()` / `resolveDeviceProfile()`. Nothing is stored: the caller owns the
 *   lifetime of the object (config file, per-request override, future org policy document). This is
 *   deliberately database-free.
 */

/** Every capability the policy engine knows how to gate. Keep in sync with `capabilityForIntent()`. */
export const DEVICE_CAPABILITIES = Object.freeze([
  "status",
  "agent_prompt",
  "media_prompt",
  "session_control",
  "approval_response",
  // Answering a provider approval with `acceptForSession` — T3's "allow-always" (see
  // src/providerApprovals.mjs for the adapter citations). Split out from `approval_response`
  // because it is not the same decision: allow-once answers one question, while allow-always
  // writes a standing permission rule into the provider session that outlives the moment it was
  // granted in. A durable grant made by tapping a button on a 240x320 panel — where the request
  // detail is clipped to a line and a half — is not the same act as making it in the console with
  // the full diff on screen, so the built-in hardware profile does not carry it.
  "approval_response_persistent",
  // Answering a QUESTION the agent asked — "which database?", "pick a branch name". A third,
  // separate thing from either approval: the answer is a value, not a verdict, and the legal
  // values are supplied by the agent itself (src/userInput.mjs).
  //
  // ONE capability, not two, and deliberately not split the way `approval_response` was. The
  // split there existed because `acceptForSession` writes a standing permission rule that
  // outlives the moment it was granted in — a genuinely different act. Nothing here does that:
  // an answer is consumed by the turn that asked and leaves nothing behind. The most powerful
  // shape, free text, is exactly as powerful as sending the agent a message, and every profile
  // below that carries `user_input_response` already carries `agent_prompt`. A second capability
  // would gate nothing that is not already gated.
  //
  // What IS restricted is where an answer may be given from, and that is a transport rule rather
  // than a policy one: the device realm accepts only a single short multiple-choice question,
  // because a 240x320 panel with five keys cannot take dictation. See
  // `isDeviceAnswerableUserInput()`.
  "user_input_response",
  "shell_input",
  // Creating a thread in the bound project, from hardware that has no keyboard. A write to the
  // owner's T3 environment, so it is a capability rather than a selection: `read-only` browses,
  // it does not create.
  "thread_create",
  // Direct terminal write (roadmap Phase 9 stage 3). Deliberately granted by NO built-in profile:
  // the roadmap keeps terminal:operate separate and opt-in, so it is reachable only through a
  // custom profile on an environment that was paired with the terminal:operate scope.
  "terminal_input",
]);

const CAPABILITY_SET = new Set(DEVICE_CAPABILITIES);

const DEVICE_PROFILES = [
  {
    id: "next-coder",
    label: "Next Coder",
    description: "Full remote agent control for prompts, media, status, approvals, agent questions, session control, thread creation, and policy-screened shell input. Provider approvals may be allowed once, declined or cancelled; \"allow for this session\" is reserved for the console.",
    capabilities: [
      "status",
      "agent_prompt",
      "media_prompt",
      "session_control",
      "approval_response",
      "user_input_response",
      "shell_input",
      "thread_create",
    ],
  },
  {
    id: "read-only",
    label: "Read only",
    description: "Status inspection only. Pending approvals and agent questions are visible, but answering them — like prompts, media, session control, thread creation, and shell input — is blocked.",
    capabilities: ["status"],
  },
  {
    id: "power-controller",
    label: "Power controller",
    description: "High-trust control profile used by signed-in web clients and advanced devices; dangerous shell input still requires approval. The only built-in profile that may grant a provider permission for a whole session.",
    capabilities: [
      "status",
      "agent_prompt",
      "media_prompt",
      "session_control",
      "approval_response",
      "approval_response_persistent",
      "user_input_response",
      "shell_input",
      "thread_create",
    ],
  },
];

const PROFILE_BY_ID = new Map(DEVICE_PROFILES.map((profile) => [profile.id, profile]));

// Devices provisioned before the rename carry the legacy profile id on their record. It is not a
// listed profile and is never offered to an owner, but it has to keep resolving to the same
// capability set: dropping it to the deny-by-default fallback would silently strip a deployed
// device of the capabilities it was sold with.
const LEGACY_PROFILE_IDS = new Map([["agent-controller", "next-coder"]]);

/** Profile used whenever a profile reference cannot be resolved. Deny-by-default. */
export const FALLBACK_PROFILE_ID = "read-only";

export function listDeviceProfiles() {
  return DEVICE_PROFILES.map((profile) => ({
    ...profile,
    capabilities: [...profile.capabilities],
  }));
}

export function getDeviceProfile(profileId) {
  const resolved = typeof profileId === "string" ? LEGACY_PROFILE_IDS.get(profileId) ?? profileId : profileId;
  return PROFILE_BY_ID.get(resolved) ?? null;
}

export function isKnownDeviceProfile(profileId) {
  return getDeviceProfile(profileId) !== null;
}

export function normalizeDeviceProfile(profileId, fallback = "next-coder") {
  const profile = typeof profileId === "string" && profileId.trim() ? profileId.trim() : fallback;
  return profile;
}

/**
 * Validate a caller-supplied custom profile object.
 *
 * Shape: `{ id: string, capabilities: string[], label?: string, description?: string }`.
 * Unknown capability names are rejected so a typo silently granting nothing (or, worse, appearing
 * to grant something) surfaces at the call site.
 *
 * @returns {{ valid: true, profile: object } | { valid: false, reason: string }}
 */
export function validateCustomProfile(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { valid: false, reason: "Custom profile must be an object." };
  }
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  if (!id) return { valid: false, reason: "Custom profile requires a non-empty string id." };
  if (!Array.isArray(candidate.capabilities)) {
    return { valid: false, reason: `Custom profile "${id}" requires a capabilities array.` };
  }
  const capabilities = [];
  for (const capability of candidate.capabilities) {
    if (typeof capability !== "string" || !CAPABILITY_SET.has(capability)) {
      return { valid: false, reason: `Custom profile "${id}" lists unknown capability ${JSON.stringify(capability)}.` };
    }
    if (!capabilities.includes(capability)) capabilities.push(capability);
  }
  return {
    valid: true,
    profile: {
      id,
      label: typeof candidate.label === "string" && candidate.label.trim() ? candidate.label.trim() : id,
      description: typeof candidate.description === "string" ? candidate.description : "Custom profile supplied by the caller.",
      capabilities,
      custom: true,
    },
  };
}

/**
 * Resolve either a built-in profile id or a custom profile object to a profile record.
 *
 * @param {string | object | null | undefined} profileRef
 * @returns {object | null} the resolved profile, or `null` when it cannot be resolved.
 */
export function resolveDeviceProfile(profileRef) {
  if (typeof profileRef === "string") {
    const builtIn = getDeviceProfile(profileRef);
    return builtIn ? { ...builtIn, capabilities: [...builtIn.capabilities], custom: false } : null;
  }
  const custom = validateCustomProfile(profileRef);
  return custom.valid ? custom.profile : null;
}

/**
 * Capability set for a profile reference.
 *
 * Accepts a built-in id (existing behaviour) or a custom profile object. Anything unresolvable
 * falls back to the deny-by-default `read-only` capability set — never to an open one.
 */
export function capabilitiesForProfile(profileRef) {
  const resolved = resolveDeviceProfile(profileRef) ?? getDeviceProfile(FALLBACK_PROFILE_ID);
  return new Set(resolved.capabilities);
}
