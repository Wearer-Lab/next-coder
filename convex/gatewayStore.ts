import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { providerCatalogueValidator } from "./schema";

const defaultConfig = {
  gatewayAccessMode: "local",
  gatewayUrl: null,
  defaultPrompt: "Continue the current task, inspect progress, and run relevant tests.",
  shellCommand: "npm test",
  menu: ["status", "prompt", "shell", "macro", "thread", "media", "stop"],
};

const defaultStatus = {
  lastHeartbeatAt: null,
  firmwareVersion: null,
  hardwareModel: null,
  ipAddress: null,
  wifiRssi: null,
  freeHeap: null,
  uptimeMs: null,
  batteryMv: null,
  batteryPercent: null,
  protocolVersion: 1,
  features: [],
  limits: {},
};
const defaultFirmwarePolicy = {
  channel: "stable",
  updateMode: "manual",
  desiredVersion: null,
  lastUpdateStatus: null,
  lastUpdateAt: null,
  lastUpdateError: null,
  updateProgress: null,
  targetVersion: null,
};
const deviceOnlineThresholdMs = 90_000;
const DEVICE_CREDENTIAL_ROTATION_TTL_MS = 10 * 60 * 1000;
// Mirrors ENVIRONMENT_REMOVED_REASON in src/actions.mjs. Convex functions cannot import from src/,
// so the literal is duplicated here; change both together.
const ENVIRONMENT_REMOVED_REASON = "environment_removed";
// Mirrors src/requestEnvelope.mjs. Convex functions cannot import Node-domain modules.
const COMMAND_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const COMMAND_REQUEST_MAX_PER_OWNER = 1000;
const NOTIFICATION_MAX_PER_OWNER = 1000;
const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const notificationKinds = new Set([
  "turn.completed", "turn.failed", "gateway.approval_required", "provider.approval_required",
  "user_input.required", "connector.offline", "connector.recovered", "t3.offline", "t3.recovered",
]);
const notificationSeverities = new Set(["info", "attention", "error"]);

const defaultEnvironmentHealth = {
  lastCheckedAt: null,
  lastReachableAt: null,
  lastError: null,
  failureReason: null,
  snapshot: null,
    compatibility: null,
    capabilities: null,
};

// Mirrors ENVIRONMENT_FAILURE_REASONS in src/environmentFailure.mjs.
const environmentFailureReasons = new Set([
  "process_not_running",
  "network_unreachable",
  "timeout",
  "tls_error",
  "token_expired",
  "authentication_failed",
  "contract_incompatible",
  "unknown",
]);

const defaultPrivacySettings = {
  mediaRetentionDays: 30,
};

const subscriptionTiers = new Set(["free", "starter", "pro", "team", "enterprise"]);
const subscriptionStatuses = new Set(["active", "trialing", "past_due", "canceled"]);

const defaultSubscriptionTier = "free";
const defaultSubscriptionStatus = "active";

const defaultOnboarding = {
  version: 2,
  status: "not_started",
  currentStep: "welcome",
  networkMode: null,
  networkUrl: null,
  provider: { harness: null, instanceId: null, model: null },
  workspace: { path: null, title: null, projectId: null },
  environmentId: null,
  firstThreadId: null,
  device: { mode: null, deviceId: null, credentialConfirmed: false },
  startedAt: null,
  pausedAt: null,
  completedAt: null,
  updatedAt: null,
};

function gatewayQuery(definition: any) {
  return query({
    ...definition,
    args: { gatewaySecret: v.string(), ...definition.args },
    handler: async (ctx, args) => {
      requireGatewaySecret((args as { gatewaySecret: string }).gatewaySecret);
      return await definition.handler(ctx, args);
    },
  });
}

function gatewayMutation(definition: any) {
  return mutation({
    ...definition,
    args: { gatewaySecret: v.string(), ...definition.args },
    handler: async (ctx, args) => {
      requireGatewaySecret((args as { gatewaySecret: string }).gatewaySecret);
      return await definition.handler(ctx, args);
    },
  });
}

function requireGatewaySecret(value: string) {
  const expected = process.env.GATEWAY_CONVEX_SECRET;
  if (!expected || value !== expected) {
    throw new Error("Unauthorized gateway store access");
  }
}

export const ensureUser = gatewayMutation({
  args: {
    userId: v.optional(v.string()),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return publicUser(await ensureUserRecord(
      ctx,
      args.userId ?? "user_dev",
      args.email ?? "dev@example.local",
      args.name,
    ));
  },
});

export const createUserToken = gatewayMutation({
  args: {
    userId: v.string(),
    label: v.optional(v.string()),
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    await ensureUserRecord(ctx, args.userId);
    const id = await ctx.db.insert("apiTokens", {
      userExternalId: args.userId,
      label: args.label ?? "Platform API token",
      tokenHash: args.tokenHash,
      createdAt: nowIso(),
    });
    const token = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "user_token.created",
      targetId: id,
      metadata: { label: args.label ?? "Platform API token" },
    });
    return publicUserToken(token);
  },
});

export const authenticateUserToken = gatewayMutation({
  args: {
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const token = await ctx.db
      .query("apiTokens")
      .withIndex("byTokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .first();
    if (!token || token.revokedAt) return null;
    await ctx.db.patch(token._id, { lastUsedAt: nowIso() });
    const user = await findUser(ctx, token.userExternalId);
    return user ? publicUser(user) : null;
  },
});

export const getUserPrivacySettings = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await findUser(ctx, args.userId);
    return normalizePrivacySettings(user?.privacy);
  },
});

export const updateUserPrivacySettings = gatewayMutation({
  args: {
    userId: v.string(),
    privacy: v.object({
      mediaRetentionDays: v.union(v.number(), v.null()),
    }),
  },
  handler: async (ctx, args) => {
    const user = await ensureUserRecord(ctx, args.userId);
    const privacy = normalizePrivacySettings(args.privacy, user?.privacy);
    await ctx.db.patch(user._id, { privacy, updatedAt: nowIso() });
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "user.privacy_updated",
      targetId: args.userId,
      metadata: privacy,
    });
    return privacy;
  },
});

export const getUserSubscription = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await findUser(ctx, args.userId);
    if (!user) return null;
    return normalizeSubscription(user.subscription, user.createdAt);
  },
});

export const updateUserSubscription = gatewayMutation({
  args: {
    userId: v.string(),
    tier: v.optional(v.string()),
    status: v.optional(v.string()),
    provider: v.optional(v.union(v.string(), v.null())),
    externalId: v.optional(v.union(v.string(), v.null())),
    currentPeriodEnd: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const user = await findUser(ctx, args.userId);
    if (!user) return null;
    const previous = normalizeSubscription(user.subscription, user.createdAt);
    const subscription = { ...previous, updatedAt: nowIso() };

    if (args.tier !== undefined) subscription.tier = requireSubscriptionTier(args.tier);
    if (args.status !== undefined) subscription.status = requireSubscriptionStatus(args.status);
    if (args.provider !== undefined) subscription.provider = normalizeNullableString(args.provider);
    if (args.externalId !== undefined) subscription.externalId = normalizeNullableString(args.externalId);
    if (args.currentPeriodEnd !== undefined) {
      subscription.currentPeriodEnd = normalizeNullableString(args.currentPeriodEnd);
    }

    await ctx.db.patch(user._id, { subscription, updatedAt: nowIso() });
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "user.subscription_updated",
      targetId: args.userId,
      metadata: subscription,
    });
    return subscription;
  },
});

export const getUserOnboarding = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await findUser(ctx, args.userId);
    return normalizeOnboarding(user?.onboarding);
  },
});

export const updateUserOnboarding = gatewayMutation({
  args: {
    userId: v.string(),
    onboarding: v.any(),
  },
  handler: async (ctx, args) => {
    const user = await ensureUserRecord(ctx, args.userId);
    const previous = normalizeOnboarding(user?.onboarding);
    const onboarding = normalizeOnboardingInput(args.onboarding, previous);
    await ctx.db.patch(user._id, { onboarding, updatedAt: nowIso() });
    const action = onboarding.status === "completed"
      ? "user.onboarding_completed"
      : onboarding.status === "paused"
        ? "user.onboarding_paused"
        : previous.status === "not_started"
          ? "user.onboarding_started"
          : "user.onboarding_updated";
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action,
      targetId: args.userId,
      metadata: {
        status: onboarding.status,
        currentStep: onboarding.currentStep,
      },
    });
    return onboarding;
  },
});

export const createDevice = gatewayMutation({
  args: {
    userId: v.string(),
    label: v.string(),
    profile: v.optional(v.string()),
    secretHash: v.string(),
  },
  handler: async (ctx, args) => {
    await ensureUserRecord(ctx, args.userId);
    const id = await ctx.db.insert("devices", {
      userExternalId: args.userId,
      label: args.label,
      profile: args.profile ?? "next-coder",
      secretHash: args.secretHash,
      credentialVersion: 1,
      claimedAt: nowIso(),
      status: defaultStatus,
      config: defaultConfig,
      firmwarePolicy: defaultFirmwarePolicy,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const device = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device.created",
      targetId: id,
      metadata: { label: args.label, profile: args.profile ?? "next-coder" },
    });
    return publicDevice(device);
  },
});

export const preprovisionDevice = gatewayMutation({
  args: {
    label: v.string(),
    profile: v.optional(v.string()),
    hardwareModel: v.optional(v.union(v.string(), v.null())),
    secretHash: v.string(),
    claimCodeHash: v.string(),
    claimCodeExpiresAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("devices", {
      label: args.label,
      profile: args.profile ?? "next-coder",
      // A property of the physical unit, stamped at pre-provision: an OTA release targets it and
      // the console uses it to name which firmware image belongs on this board.
      hardwareModel: args.hardwareModel ?? null,
      secretHash: args.secretHash,
      credentialVersion: 1,
      claimCodeHash: args.claimCodeHash,
      claimCodeExpiresAt: args.claimCodeExpiresAt,
      status: defaultStatus,
      config: defaultConfig,
      firmwarePolicy: defaultFirmwarePolicy,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const device = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: "system",
      actorType: "system",
      action: "device.preprovisioned",
      targetId: id,
      metadata: { label: args.label, profile: args.profile ?? "next-coder" },
    });
    return publicDevice(device);
  },
});

export const claimDevice = gatewayMutation({
  args: {
    userId: v.string(),
    claimCodeHash: v.string(),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ensureUserRecord(ctx, args.userId);
    const device = await ctx.db
      .query("devices")
      .withIndex("byClaimCodeHash", (q) => q.eq("claimCodeHash", args.claimCodeHash))
      .first();
    if (!device || device.revokedAt || device.claimedAt || !device.claimCodeHash) return null;
    if (device.rotationPurpose === "transfer" && !device.rotationCompletedAt) return null;
    // Matched but expired is refused here rather than treated as "no such code", so the caller can
    // report the difference. A code with no recorded expiry predates expiry tracking and stays live.
    if (device.claimCodeExpiresAt && Date.parse(device.claimCodeExpiresAt) <= Date.now()) return null;
    await ctx.db.patch(device._id, {
      userExternalId: args.userId,
      claimCodeHash: undefined,
      claimCodeExpiresAt: undefined,
      claimedAt: nowIso(),
      ...(args.label ? { label: args.label } : {}),
      updatedAt: nowIso(),
    });
    const claimed = await ctx.db.get(device._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device.claimed",
      targetId: device._id,
      metadata: { label: claimed?.label, profile: claimed?.profile },
    });
    return publicDevice(claimed);
  },
});

export const revokeDevice = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device) return null;
    await ctx.db.patch(device._id, {
      revokedAt: nowIso(),
      pendingSecretHash: null,
      pendingCredentialVersion: null,
      rotationId: null,
      rotationPurpose: null,
      rotationStartedAt: null,
      rotationExpiresAt: null,
      rotationCompletedAt: null,
      updatedAt: nowIso(),
    });
    const revoked = await ctx.db.get(device._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device.revoked",
      targetId: device._id,
      metadata: { label: device.label },
    });
    return publicDevice(revoked);
  },
});

/**
 * Permanently removes a device record. Only a revoked device qualifies — see deleteDevice() in
 * src/store.mjs, which is the reference implementation. Commands and audit entries reference the
 * device by id and are intentionally left in place.
 */
export const deleteDevice = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device) return null;
    if (!device.revokedAt) return { device: null, reason: "not_revoked" };
    const removed = publicDevice(device);
    const controls = await ctx.db
      .query("deviceControls")
      .withIndex("byDeviceId", (q) => q.eq("deviceId", device._id))
      .first();
    if (controls) await ctx.db.delete(controls._id);
    await ctx.db.delete(device._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device.deleted",
      targetId: device._id,
      metadata: { label: device.label, profile: device.profile, revokedAt: device.revokedAt },
    });
    return { device: removed, reason: null };
  },
});

export const rotateDeviceSecret = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
    restart: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    const existing = publicDeviceCredentialRotation(device);
    if (!args.restart && existing.state === "pending" && existing.purpose === "rotate") {
      return { device: publicDevice(device), rotation: existing, created: false };
    }
    const startedAt = nowIso();
    const pendingCredentialVersion = (device.credentialVersion ?? 1) + 1;
    await ctx.db.patch(device._id, {
      pendingSecretHash: null,
      pendingCredentialVersion,
      rotationId: `dcr_${crypto.randomUUID()}`,
      rotationPurpose: "rotate",
      rotationStartedAt: startedAt,
      rotationExpiresAt: new Date(Date.parse(startedAt) + DEVICE_CREDENTIAL_ROTATION_TTL_MS).toISOString(),
      rotationCompletedAt: null,
      updatedAt: startedAt,
    });
    const rotated = await ctx.db.get(device._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device.secret_rotation_started",
      targetId: device._id,
      metadata: {
        label: device.label,
        purpose: "rotate",
        credentialVersion: device.credentialVersion ?? 1,
        pendingCredentialVersion,
        expiresAt: rotated?.rotationExpiresAt,
      },
    });
    return { device: publicDevice(rotated), rotation: publicDeviceCredentialRotation(rotated), created: true };
  },
});

export const updateDeviceProfile = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
    profile: v.string(),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    await ctx.db.patch(device._id, { profile: args.profile, updatedAt: nowIso() });
    const updated = await ctx.db.get(device._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device.profile_updated",
      targetId: device._id,
      metadata: {
        label: device.label,
        previousProfile: device.profile,
        profile: args.profile,
      },
    });
    return publicDevice(updated);
  },
});

export const resetDeviceForTransfer = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    const startedAt = nowIso();
    const pendingCredentialVersion = (device.credentialVersion ?? 1) + 1;
    await ctx.db.patch(device._id, {
      userExternalId: undefined,
      ...(args.label ? { label: args.label } : {}),
      claimCodeHash: undefined,
      claimCodeExpiresAt: undefined,
      claimedAt: undefined,
      lastSeenAt: undefined,
      status: defaultStatus,
      config: defaultConfig,
      firmwarePolicy: defaultFirmwarePolicy,
      pendingSecretHash: null,
      pendingCredentialVersion,
      rotationId: `dcr_${crypto.randomUUID()}`,
      rotationPurpose: "transfer",
      rotationStartedAt: startedAt,
      rotationExpiresAt: new Date(Date.parse(startedAt) + DEVICE_CREDENTIAL_ROTATION_TTL_MS).toISOString(),
      rotationCompletedAt: null,
      updatedAt: startedAt,
    });
    const reset = await ctx.db.get(device._id);
    const controls = await ctx.db
      .query("deviceControls")
      .withIndex("byDeviceId", (q) => q.eq("deviceId", device._id))
      .first();
    if (controls) await ctx.db.delete(controls._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device.transfer_reset",
      targetId: device._id,
      metadata: {
        previousLabel: device.label,
        label: reset?.label,
        profile: device.profile,
        credentialVersion: device.credentialVersion ?? 1,
        pendingCredentialVersion,
        expiresAt: reset?.rotationExpiresAt,
      },
    });
    return { device: publicDevice(reset), rotation: publicDeviceCredentialRotation(reset) };
  },
});

export const stageDeviceSecret = gatewayMutation({
  args: {
    deviceId: v.id("devices"),
    secretHash: v.string(),
    rotationId: v.string(),
    credentialVersion: v.number(),
    authenticatedCredentialVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db.get(args.deviceId);
    if (!device || device.revokedAt) return { device: null, rotation: null, reason: "revoked" };
    const activeVersion = device.credentialVersion ?? 1;
    if (args.authenticatedCredentialVersion !== activeVersion) {
      return { device: publicDevice(device), rotation: publicDeviceCredentialRotation(device), reason: "active_credential_required" };
    }
    if (!device.rotationId || args.rotationId !== device.rotationId
        || args.credentialVersion !== device.pendingCredentialVersion) {
      return { device: publicDevice(device), rotation: publicDeviceCredentialRotation(device), reason: "rotation_mismatch" };
    }
    const expired = Date.parse(device.rotationExpiresAt ?? "") <= Date.now();
    if (expired && device.rotationPurpose !== "transfer") {
      return { device: publicDevice(device), rotation: publicDeviceCredentialRotation(device), reason: "expired" };
    }
    const patch: any = { updatedAt: nowIso() };
    if (expired) {
      patch.pendingSecretHash = null;
      patch.rotationStartedAt = patch.updatedAt;
      patch.rotationExpiresAt = new Date(Date.parse(patch.updatedAt) + DEVICE_CREDENTIAL_ROTATION_TTL_MS).toISOString();
    }
    const currentHash = expired ? null : device.pendingSecretHash;
    if (currentHash && currentHash !== args.secretHash) {
      return { device: publicDevice(device), rotation: publicDeviceCredentialRotation(device), reason: "candidate_conflict" };
    }
    if (!currentHash) {
      patch.pendingSecretHash = args.secretHash;
      await ctx.db.patch(device._id, patch);
      const staged = await ctx.db.get(device._id);
      await audit(ctx, {
        userExternalId: device.userExternalId ?? "system",
        actorType: "device",
        actorId: device._id,
        action: "device.secret_rotation_staged",
        targetId: device._id,
        metadata: {
          purpose: device.rotationPurpose,
          credentialVersion: activeVersion,
          pendingCredentialVersion: device.pendingCredentialVersion,
          expiresAt: staged?.rotationExpiresAt,
        },
      });
      return { device: publicDevice(staged), rotation: publicDeviceCredentialRotation(staged), reason: null };
    }
    return { device: publicDevice(device), rotation: publicDeviceCredentialRotation(device), reason: null };
  },
});

export const acknowledgeDeviceSecret = gatewayMutation({
  args: {
    deviceId: v.id("devices"),
    rotationId: v.string(),
    credentialVersion: v.number(),
    authenticatedCredentialVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db.get(args.deviceId);
    if (!device || device.revokedAt) return { device: null, rotation: null, reason: "revoked" };
    const activeVersion = device.credentialVersion ?? 1;
    if (args.authenticatedCredentialVersion === activeVersion
        && args.credentialVersion === activeVersion
        && args.rotationId === device.rotationId
        && device.rotationCompletedAt) {
      return { device: publicDevice(device), rotation: publicDeviceCredentialRotation(device), promoted: true, replayed: true, reason: null };
    }
    if (args.authenticatedCredentialVersion !== device.pendingCredentialVersion
        || args.credentialVersion !== device.pendingCredentialVersion
        || args.rotationId !== device.rotationId
        || !device.pendingSecretHash) {
      return { device: publicDevice(device), rotation: publicDeviceCredentialRotation(device), reason: "pending_credential_required" };
    }
    if (Date.parse(device.rotationExpiresAt ?? "") <= Date.now()) {
      return { device: publicDevice(device), rotation: publicDeviceCredentialRotation(device), reason: "expired" };
    }
    const timestamp = nowIso();
    await ctx.db.patch(device._id, {
      secretHash: device.pendingSecretHash,
      credentialVersion: device.pendingCredentialVersion,
      pendingSecretHash: null,
      pendingCredentialVersion: null,
      rotationCompletedAt: timestamp,
      updatedAt: timestamp,
    });
    const promoted = await ctx.db.get(device._id);
    await audit(ctx, {
      userExternalId: device.userExternalId ?? "system",
      actorType: "device",
      actorId: device._id,
      action: "device.secret_rotation_completed",
      targetId: device._id,
      metadata: {
        purpose: device.rotationPurpose,
        previousCredentialVersion: activeVersion,
        credentialVersion: promoted?.credentialVersion,
      },
    });
    return { device: publicDevice(promoted), rotation: publicDeviceCredentialRotation(promoted), promoted: true, replayed: false, reason: null };
  },
});

// The candidate hash is only written when a new code is actually needed. When the existing code is
// still live the caller's plaintext is discarded unused, which is what stops a device's first-403
// setup-code request from invalidating the label printed at manufacture.
export const ensureUnclaimedDeviceClaimCode = gatewayMutation({
  args: {
    deviceId: v.id("devices"),
    rotate: v.optional(v.boolean()),
    claimCodeHash: v.string(),
    claimCodeExpiresAt: v.string(),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db.get(args.deviceId);
    if (!device || device.revokedAt || device.claimedAt) return null;
    const live = Boolean(device.claimCodeHash)
      && (!device.claimCodeExpiresAt || Date.parse(device.claimCodeExpiresAt) > Date.now());
    if (!args.rotate && live) {
      return { device: publicDevice(device), rotated: false };
    }
    await ctx.db.patch(device._id, {
      claimCodeHash: args.claimCodeHash,
      claimCodeExpiresAt: args.claimCodeExpiresAt,
      updatedAt: nowIso(),
    });
    const updated = await ctx.db.get(device._id);
    await audit(ctx, {
      userExternalId: "system",
      actorType: "device",
      actorId: device._id,
      action: "device.setup_code_rotated",
      targetId: device._id,
      metadata: { label: device.label, profile: device.profile, rotate: args.rotate === true },
    });
    return { device: publicDevice(updated), rotated: true };
  },
});

export const authenticateDevice = gatewayMutation({
  args: {
    // Device credentials arrive before trust is established. Treat a malformed
    // external id as an authentication miss rather than allowing Convex's id
    // validator to turn attacker-controlled input into an HTTP 500.
    deviceId: v.string(),
    secretHash: v.string(),
  },
  handler: async (ctx, args) => {
    const deviceId = ctx.db.normalizeId("devices", args.deviceId);
    if (!deviceId) return null;
    const device = await ctx.db.get(deviceId);
    if (!device || device.revokedAt) return null;
    const activeVersion = device.credentialVersion ?? 1;
    let credentialState = "active";
    let authenticatedCredentialVersion = activeVersion;
    if (device.secretHash !== args.secretHash) {
      const pendingIsLive = device.pendingSecretHash === args.secretHash
        && Date.parse(device.rotationExpiresAt ?? "") > Date.now();
      if (!pendingIsLive) return null;
      credentialState = "pending";
      authenticatedCredentialVersion = device.pendingCredentialVersion ?? activeVersion + 1;
    }
    await ctx.db.patch(device._id, { lastSeenAt: nowIso(), updatedAt: nowIso() });
    return deviceForGateway(await ctx.db.get(device._id), authenticatedCredentialVersion, credentialState);
  },
});

export const recordDeviceHeartbeat = gatewayMutation({
  args: {
    deviceId: v.id("devices"),
    status: v.any(),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db.get(args.deviceId);
    if (!device || device.revokedAt) return null;
    const heartbeatAt = nowIso();
    await ctx.db.patch(device._id, {
      lastSeenAt: heartbeatAt,
      status: normalizeDeviceStatus(args.status, device.status, heartbeatAt),
      updatedAt: heartbeatAt,
    });
    return publicDevice(await ctx.db.get(device._id));
  },
});

export const listDevices = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const devices = await ctx.db
      .query("devices")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return devices.map(publicDevice);
  },
});

export const getDeviceForUser = gatewayQuery({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
  },
  handler: async (ctx, args) => {
    return publicDevice(await getDeviceForOwner(ctx, args.userId, args.deviceId));
  },
});

export const updateDeviceConfig = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
    config: v.any(),
    // A device setting its own thread passes "device", so the audit trail does not
    // credit the owner with something the hardware did on its own.
    actorType: v.optional(v.string()),
    actorId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    const config = normalizeDeviceConfig(args.config, device.config);
    const label = Object.hasOwn(args.config, "label")
      ? normalizeNullableString(args.config.label) ?? device.label
      : device.label;
    await ctx.db.patch(device._id, { label, config, updatedAt: nowIso() });
    const updated = await ctx.db.get(device._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: args.actorType ?? "user",
      ...(args.actorId ? { actorId: args.actorId } : {}),
      action: "device.config_updated",
      targetId: device._id,
      metadata: {
        label,
        previousLabel: device.label,
        environmentId: config.environmentId ?? null,
        projectId: config.projectId ?? null,
        threadId: config.threadId ?? null,
        gatewayAccessMode: config.gatewayAccessMode ?? "local",
        gatewayUrl: config.gatewayUrl ?? null,
        menu: config.menu,
      },
    });
    return publicDevice(updated);
  },
});

/**
 * Grants or revokes this device's licence to auto-send a finished voice transcript.
 *
 * Mirrors setDeviceVoiceAutoSend() in src/store.mjs. Scoped to one device on purpose: an
 * account-wide switch would silently extend the grant to the next controller the owner claims.
 */
export const setDeviceVoiceAutoSend = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
    // `null` withdraws the decision and hands the device back to its default; it is a third answer,
    // not a missing one.
    enabled: v.union(v.boolean(), v.null()),
    actorId: v.optional(v.union(v.string(), v.null())),
    actorType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    const ownerChoice = args.enabled === true ? true : args.enabled === false ? false : null;
    const voiceAutoSend = normalizeVoiceAutoSend(
      {
        ownerChoice,
        enabledBy: ownerChoice === true ? args.actorId ?? args.userId : null,
        enabledAt: ownerChoice === true ? nowIso() : null,
      },
      deviceReportsMicrophone(device),
    );
    await ctx.db.patch(device._id, { voiceAutoSend, updatedAt: nowIso() });
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: args.actorType ?? "user",
      ...(args.actorId ? { actorId: args.actorId } : {}),
      action: ownerChoice === true
        ? "device.voice_auto_send_enabled"
        : ownerChoice === false
          ? "device.voice_auto_send_disabled"
          : "device.voice_auto_send_reset",
      targetId: device._id,
      metadata: voiceAutoSend,
    });
    return publicDevice(await ctx.db.get(device._id));
  },
});

export const createGatewayProfile = gatewayMutation({
  args: { userId: v.string(), label: v.string(), mode: v.string(), url: v.string() },
  handler: async (ctx, args) => {
    await ensureUserRecord(ctx, args.userId);
    const createdAt = nowIso();
    const id = await ctx.db.insert("gatewayProfiles", { userExternalId: args.userId, label: args.label,
      mode: args.mode, url: args.url, createdAt, updatedAt: createdAt });
    await audit(ctx, { userExternalId: args.userId, actorType: "user", action: "gateway_profile.created",
      targetId: id, metadata: { label: args.label, mode: args.mode, origin: args.url } });
    return publicGatewayProfile(await ctx.db.get(id));
  },
});

export const listGatewayProfiles = gatewayQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => (await ctx.db.query("gatewayProfiles").withIndex("byUserExternalId",
    (q) => q.eq("userExternalId", args.userId)).collect()).map(publicGatewayProfile)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
});

export const getGatewayProfileForUser = gatewayQuery({
  args: { userId: v.string(), profileId: v.id("gatewayProfiles") },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.profileId);
    return profile?.userExternalId === args.userId ? publicGatewayProfile(profile) : null;
  },
});

export const updateGatewayProfile = gatewayMutation({
  args: { userId: v.string(), profileId: v.id("gatewayProfiles"), label: v.string(), mode: v.string(), url: v.string() },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.profileId);
    if (!profile || profile.userExternalId !== args.userId) return null;
    const assigned = (await ctx.db.query("devices").withIndex("byUserExternalId",
      (q) => q.eq("userExternalId", args.userId)).collect()).filter((device) =>
      [device.gatewaySelection?.activeProfileId, device.gatewaySelection?.pendingProfileId].includes(String(profile._id)));
    if (assigned.length && (profile.url !== args.url || profile.mode !== args.mode)) {
      return { conflict: true, deviceIds: assigned.map((device) => String(device._id)) };
    }
    await ctx.db.patch(profile._id, { label: args.label, mode: args.mode, url: args.url, updatedAt: nowIso() });
    await audit(ctx, { userExternalId: args.userId, actorType: "user", action: "gateway_profile.updated",
      targetId: profile._id, metadata: { label: args.label, mode: args.mode, origin: args.url } });
    return { ...publicGatewayProfile(await ctx.db.get(profile._id)), conflict: false };
  },
});

export const deleteGatewayProfile = gatewayMutation({
  args: { userId: v.string(), profileId: v.id("gatewayProfiles") },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.profileId);
    if (!profile || profile.userExternalId !== args.userId) return null;
    const assigned = (await ctx.db.query("devices").withIndex("byUserExternalId",
      (q) => q.eq("userExternalId", args.userId)).collect()).filter((device) =>
      [device.gatewaySelection?.activeProfileId, device.gatewaySelection?.pendingProfileId].includes(String(profile._id)));
    if (assigned.length) return { conflict: true, deviceIds: assigned.map((device) => String(device._id)) };
    await ctx.db.delete(profile._id);
    await audit(ctx, { userExternalId: args.userId, actorType: "user", action: "gateway_profile.deleted",
      targetId: profile._id, metadata: { label: profile.label, mode: profile.mode } });
    return { conflict: false, profile: publicGatewayProfile(profile) };
  },
});

export const getDeviceGatewaySelection = gatewayQuery({
  args: { userId: v.string(), deviceId: v.id("devices") },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    return device ? normalizeGatewaySelection(device.gatewaySelection) : null;
  },
});

export const stageDeviceGatewaySwitch = gatewayMutation({
  args: { userId: v.string(), deviceId: v.id("devices"), profileId: v.id("gatewayProfiles"),
    actorType: v.optional(v.string()), actorId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    const profile = await ctx.db.get(args.profileId);
    if (!device || device.revokedAt || !profile || profile.userExternalId !== args.userId) return null;
    const previous = normalizeGatewaySelection(device.gatewaySelection);
    const selection = { ...previous, revision: previous.revision + 1, state: "pending",
      previousProfileId: previous.activeProfileId, pendingProfileId: String(profile._id), requestedAt: nowIso(), lastError: null };
    await ctx.db.patch(device._id, { gatewaySelection: selection, updatedAt: nowIso() });
    await audit(ctx, { userExternalId: args.userId, actorType: args.actorType ?? "user", actorId: args.actorId,
      action: "device.gateway_switch_requested", targetId: device._id,
      metadata: { revision: selection.revision, profileId: String(profile._id) } });
    return selection;
  },
});

export const reportDeviceGatewaySwitch = gatewayMutation({
  args: { userId: v.string(), deviceId: v.id("devices"), revision: v.number(),
    profileId: v.id("gatewayProfiles"), status: v.string(), detail: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    const profile = await ctx.db.get(args.profileId);
    if (!device || device.revokedAt || !profile || profile.userExternalId !== args.userId) return null;
    const previous = normalizeGatewaySelection(device.gatewaySelection);
    if (args.revision !== previous.revision) return { conflict: true, selection: previous };
    if (args.status === "requested") {
      const selection = { ...previous, revision: previous.revision + 1, state: "pending",
        previousProfileId: previous.activeProfileId, pendingProfileId: String(profile._id), requestedAt: nowIso(), lastError: null };
      await ctx.db.patch(device._id, { gatewaySelection: selection, updatedAt: nowIso() });
      return { conflict: false, selection };
    }
    if (previous.pendingProfileId && previous.pendingProfileId !== String(profile._id)) {
      return { conflict: true, selection: previous };
    }
    const selection = args.status === "applied"
      ? { ...previous, revision: previous.pendingProfileId ? previous.revision : previous.revision + 1,
          state: "stable", previousProfileId: previous.activeProfileId, activeProfileId: String(profile._id),
          pendingProfileId: null, appliedAt: nowIso(), lastError: null }
      : { ...previous, state: "failed", pendingProfileId: null, lastError: args.detail ?? "Gateway probe failed." };
    await ctx.db.patch(device._id, { gatewaySelection: selection, updatedAt: nowIso() });
    await audit(ctx, { userExternalId: args.userId, actorType: "device", actorId: String(device._id),
      action: args.status === "applied" ? "device.gateway_switch_applied" : "device.gateway_switch_failed",
      targetId: device._id, metadata: { revision: selection.revision, profileId: String(profile._id), detail: args.detail } });
    return { conflict: false, selection };
  },
});

export const rollbackDeviceGatewaySwitch = gatewayMutation({
  args: { userId: v.string(), deviceId: v.id("devices") },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    const previous = normalizeGatewaySelection(device.gatewaySelection);
    const selection = { ...previous, revision: previous.revision + 1, state: "stable", pendingProfileId: null, lastError: null };
    await ctx.db.patch(device._id, { gatewaySelection: selection, updatedAt: nowIso() });
    return selection;
  },
});

export const upsertEnvironment = gatewayMutation({
  args: {
    id: v.optional(v.id("environments")),
    userId: v.string(),
    label: v.string(),
    baseUrl: v.optional(v.union(v.string(), v.null())),
    accessToken: v.optional(v.string()),
    transportMode: v.optional(v.union(v.literal("direct"), v.literal("connector"))),
    connectorId: v.optional(v.union(v.id("connectors"), v.null())),
    accessTokenExpiresAt: v.optional(v.union(v.string(), v.null())),
    scopes: v.array(v.string()),
    status: v.optional(v.string()),
    health: v.optional(v.any()),
    createdAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ensureUserRecord(ctx, args.userId);
    const transportMode = args.transportMode === "connector" ? "connector" : "direct";
    let existing: any = null;
    if (args.id) {
      existing = await ctx.db.get(args.id);
      if (!existing || existing.userExternalId !== args.userId) return null;
    } else {
      const normalizedBaseUrl = String(args.baseUrl ?? "").replace(/\/+$/u, "");
      const matches = (await ctx.db
        .query("environments")
        .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
        .collect())
        .filter((environment) => (environment.transportMode ?? "direct") === "direct"
          && transportMode === "direct"
          && environment.baseUrl === normalizedBaseUrl)
        .sort((left, right) => left._creationTime - right._creationTime);
      existing = matches[0] ?? null;
    }
    const input = {
      userExternalId: args.userId,
      label: args.label,
      baseUrl: transportMode === "direct" ? String(args.baseUrl ?? "").replace(/\/+$/u, "") : null,
      transportMode,
      connectorId: transportMode === "connector" ? (args.connectorId ?? existing?.connectorId ?? null) : null,
      ...(transportMode === "direct" ? { accessToken: args.accessToken } : { accessToken: undefined }),
      // Pairing the same host again restores an archived row instead of creating a duplicate.
      archivedAt: undefined,
      deletedAt: undefined,
      purgeAfter: undefined,
      accessTokenExpiresAt: normalizeNullableString(args.accessTokenExpiresAt) ?? null,
      scopes: args.scopes,
      status: args.status ?? "unknown",
      health: normalizeEnvironmentHealth(args.health, existing?.health),
      updatedAt: nowIso(),
    };
    const id = existing?._id ?? await ctx.db.insert("environments", {
      ...input,
      createdAt: args.createdAt ?? nowIso(),
    });
    if (existing) await ctx.db.patch(existing._id, input);
    const environment = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "environment.upserted",
      targetId: id,
      metadata: { label: input.label, baseUrl: input.baseUrl, transportMode, scopes: input.scopes },
    });
    return publicEnvironment(environment);
  },
});

async function disconnectEnvironmentReferences(ctx: any, args: { userId: string; environmentId: string }) {
  const removed: {
    devices: string[];
    actions: string[];
    macros: string[];
    onboarding: boolean;
  } = { devices: [], actions: [], macros: [], onboarding: false };
  const timestamp = nowIso();

  const devices = await ctx.db
    .query("devices")
    .withIndex("byUserExternalId", (q: any) => q.eq("userExternalId", args.userId))
    .collect();
  for (const device of devices) {
    if (device.config?.environmentId !== args.environmentId) continue;
    await ctx.db.patch(device._id, {
      config: normalizeDeviceConfig(
        { ...device.config, environmentId: null, projectId: null, threadId: null },
        device.config,
      ),
      updatedAt: timestamp,
    });
    removed.devices.push(String(device._id));
  }

  const actions = await ctx.db
    .query("actions")
    .withIndex("byUserExternalId", (q: any) => q.eq("userExternalId", args.userId))
    .collect();
  for (const action of actions) {
    if (String(action.environmentId ?? "") !== args.environmentId) continue;
    await ctx.db.patch(action._id, {
      environmentId: undefined,
      threadId: undefined,
      targetMode: "device-current",
      disabled: true,
      disabledReason: ENVIRONMENT_REMOVED_REASON,
      updatedAt: timestamp,
    });
    removed.actions.push(String(action._id));
  }

  const macros = await ctx.db
    .query("macros")
    .withIndex("byUserExternalId", (q: any) => q.eq("userExternalId", args.userId))
    .collect();
  for (const macro of macros) {
    if (String(macro.environmentId ?? "") !== args.environmentId) continue;
    await ctx.db.patch(macro._id, {
      environmentId: undefined,
      threadId: undefined,
      disabled: true,
      disabledReason: ENVIRONMENT_REMOVED_REASON,
      updatedAt: timestamp,
    });
    removed.macros.push(String(macro._id));
  }

  const user = await findUser(ctx, args.userId);
  const onboarding = normalizeOnboarding(user?.onboarding);
  if (user && onboarding.environmentId === args.environmentId) {
    await ctx.db.patch(user._id, {
      onboarding: { ...onboarding, environmentId: null, firstThreadId: null, updatedAt: timestamp },
      updatedAt: timestamp,
    });
    removed.onboarding = true;
  }
  return removed;
}

export const archiveEnvironment = gatewayMutation({
  args: {
    userId: v.string(),
    environmentId: v.id("environments"),
    retentionDays: v.optional(v.number()),
    at: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const environment = await ctx.db.get(args.environmentId);
    if (!environment || environment.userExternalId !== args.userId) return null;
    if (environment.archivedAt) {
      return {
        environment: publicEnvironment(environment),
        removed: { devices: [], actions: [], macros: [], onboarding: false },
        alreadyArchived: true,
      };
    }
    const removed = await disconnectEnvironmentReferences(ctx, {
      userId: args.userId,
      environmentId: String(environment._id),
    });
    const archivedAt = args.at ?? nowIso();
    const purgeAfter = new Date(Date.parse(archivedAt) + Math.max(1, args.retentionDays ?? 30) * 86_400_000).toISOString();
    await ctx.db.patch(environment._id, {
      accessToken: undefined,
      accessTokenExpiresAt: null,
      archivedAt,
      deletedAt: archivedAt,
      purgeAfter,
      status: "archived",
      providerCatalogue: undefined,
      updatedAt: archivedAt,
    });
    const revokedConnectorIds: string[] = [];
    const connectors = await ctx.db
      .query("connectors")
      .withIndex("byUserExternalId", (q: any) => q.eq("userExternalId", args.userId))
      .collect();
    for (const connector of connectors) {
      if (String(connector.environmentId) !== String(environment._id) || connector.revokedAt) continue;
      await ctx.db.patch(connector._id, {
        revokedAt: archivedAt,
        updatedAt: archivedAt,
        status: "revoked",
        lastDisconnectReason: "environment_removed",
        secretHash: null,
        pendingSecretHash: null,
        pendingSecretPrefix: null,
        pendingCredentialVersion: null,
        rotationId: null,
        rotationExpiresAt: null,
      });
      const tickets = await ctx.db
        .query("connectorTickets")
        .withIndex("byConnectorId", (q: any) => q.eq("connectorId", connector._id))
        .collect();
      for (const ticket of tickets) {
        if (!ticket.consumedAt) await ctx.db.patch(ticket._id, { consumedAt: archivedAt });
      }
      revokedConnectorIds.push(String(connector._id));
    }
    const archived = await ctx.db.get(environment._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "environment.archived",
      targetId: environment._id,
      metadata: {
        label: environment.label,
        retentionUntil: purgeAfter,
        revokedConnectorIds,
        clearedDeviceIds: removed.devices,
        disabledActionIds: removed.actions,
        disabledMacroIds: removed.macros,
        clearedOnboarding: removed.onboarding,
      },
    });
    return { environment: publicEnvironment(archived), removed, revokedConnectorIds, alreadyArchived: false };
  },
});

export const restoreEnvironment = gatewayMutation({
  args: { userId: v.string(), environmentId: v.id("environments"), at: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const environment = await ctx.db.get(args.environmentId);
    if (!environment || environment.userExternalId !== args.userId) return null;
    if (!environment.archivedAt) return { expired: false, alreadyRestored: true, environment: publicEnvironment(environment) };
    const at = args.at ?? nowIso();
    if (Date.parse(environment.purgeAfter ?? "") <= Date.parse(at)) return { expired: true, environment: publicEnvironment(environment) };
    await ctx.db.patch(environment._id, {
      archivedAt: undefined,
      deletedAt: undefined,
      purgeAfter: undefined,
      connectorId: null,
      status: "needs_repair",
      freshness: "unknown",
      updatedAt: at,
    });
    const restored = await ctx.db.get(environment._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "environment.restored",
      targetId: environment._id,
      metadata: { label: environment.label, requiresRepair: true },
    });
    return { expired: false, alreadyRestored: false, environment: publicEnvironment(restored) };
  },
});

export const listExpiredEnvironments = gatewayQuery({
  args: { userId: v.string(), now: v.string() },
  handler: async (ctx, args) => (await ctx.db
    .query("environments")
    .withIndex("byUserExternalId", (q: any) => q.eq("userExternalId", args.userId))
    .collect())
    .filter((environment: any) => environment.archivedAt && Date.parse(environment.purgeAfter ?? "") <= Date.parse(args.now))
    .map(publicEnvironment),
});

export const purgeEnvironment = gatewayMutation({
  args: { userId: v.string(), environmentId: v.id("environments"), now: v.string(), force: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const environment = await ctx.db.get(args.environmentId);
    if (!environment || environment.userExternalId !== args.userId || !environment.archivedAt) return null;
    if (!args.force && Date.parse(environment.purgeAfter ?? "") > Date.parse(args.now)) {
      return { notDue: true, environment: publicEnvironment(environment) };
    }
    await ctx.db.delete(environment._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "system",
      action: "environment.purged",
      targetId: environment._id,
      metadata: { label: environment.label, retentionExpired: !args.force },
    });
    return { notDue: false, environment: publicEnvironment(environment) };
  },
});

export const deleteEnvironment = gatewayMutation({
  args: {
    userId: v.string(),
    environmentId: v.id("environments"),
  },
  // Mirror of deleteEnvironment in src/store.mjs: nothing may keep pointing at a removed
  // environment, and a fixed-target action or macro left without one is disabled with a reason
  // rather than silently retargeted. The two copies must stay in step.
  handler: async (ctx, args) => {
    const environment = await ctx.db.get(args.environmentId);
    if (!environment || environment.userExternalId !== args.userId) return null;
    const environmentId = String(environment._id);
    await ctx.db.delete(environment._id);
    const removed = await disconnectEnvironmentReferences(ctx, { userId: args.userId, environmentId });

    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "environment.deleted",
      targetId: environment._id,
      metadata: {
        label: environment.label,
        baseUrl: environment.baseUrl,
        clearedDeviceIds: removed.devices,
        disabledActionIds: removed.actions,
        disabledMacroIds: removed.macros,
        clearedOnboarding: removed.onboarding,
      },
    });
    return { environment: publicEnvironment(environment), removed };
  },
});

export const updateEnvironmentHealth = gatewayMutation({
  args: {
    userId: v.string(),
    environmentId: v.id("environments"),
    status: v.optional(v.string()),
    health: v.any(),
  },
  handler: async (ctx, args) => {
    const environment = await ctx.db.get(args.environmentId);
    if (!environment || environment.userExternalId !== args.userId || environment.archivedAt) return null;
    const health = normalizeEnvironmentHealth(args.health, environment.health);
    await ctx.db.patch(environment._id, {
      ...(args.status ? { status: args.status } : {}),
      health,
      updatedAt: nowIso(),
    });
    const updated = await ctx.db.get(environment._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "environment.health_checked",
      targetId: environment._id,
      metadata: {
        label: environment.label,
        status: updated?.status,
        lastError: health.lastError,
      },
    });
    return publicEnvironment(updated);
  },
});

export const updateEnvironmentCatalogue = gatewayMutation({
  args: {
    userId: v.string(),
    environmentId: v.id("environments"),
    catalogue: providerCatalogueValidator,
  },
  handler: async (ctx, args) => {
    const environment = await ctx.db.get(args.environmentId);
    if (!environment || environment.userExternalId !== args.userId || environment.archivedAt) return null;
    const catalogue = args.catalogue;
    await ctx.db.patch(environment._id, {
      providerCatalogue: catalogue,
      updatedAt: nowIso(),
    });
    const updated = await ctx.db.get(environment._id);
    const instanceIds = catalogue.instances.map((instance: any) => instance.instanceId);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "environment.catalogue_updated",
      targetId: environment._id,
      metadata: {
        label: environment.label,
        source: catalogue.source,
        instanceCount: instanceIds.length,
        instanceIds,
      },
    });
    return publicEnvironment(updated);
  },
});

export const getEnvironmentForUser = gatewayQuery({
  args: {
    userId: v.string(),
    environmentId: v.id("environments"),
  },
  handler: async (ctx, args) => {
    const environment = await ctx.db.get(args.environmentId);
    if (!environment || environment.userExternalId !== args.userId || environment.archivedAt) return null;
    return environmentForGateway(environment);
  },
});

export const listEnvironments = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const environments = await ctx.db
      .query("environments")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    const uniqueByTransportTarget = new Map<string, any>();
    for (const environment of environments
      .filter((item) => !item.archivedAt)
      .sort((left, right) => left._creationTime - right._creationTime)) {
      const key = (environment.transportMode ?? "direct") === "connector"
        ? `connector:${String(environment._id)}`
        : `direct:${environment.baseUrl}`;
      if (!uniqueByTransportTarget.has(key)) uniqueByTransportTarget.set(key, environment);
    }
    return [...uniqueByTransportTarget.values()].map(publicEnvironment);
  },
});

export const listArchivedEnvironments = gatewayQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const environments = await ctx.db
      .query("environments")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return environments
      .filter((environment) => Boolean(environment.archivedAt))
      .sort((left, right) => Date.parse(right.archivedAt ?? "") - Date.parse(left.archivedAt ?? ""))
      .map(publicEnvironment);
  },
});

// Console-first pairing. Mirrors createConnectSession/getConnectSession/claimConnectSession/
// completeConnectSession in src/store.mjs; the plaintext code is generated in Node and never
// reaches Convex, so only its hash is stored here.
export const createConnectSession = gatewayMutation({
  args: {
    userId: v.string(),
    label: v.string(),
    accessMode: v.string(),
    purpose: v.optional(v.string()),
    environmentId: v.optional(v.union(v.id("environments"), v.null())),
    codeHash: v.string(),
    expiresAt: v.string(),
  },
  handler: async (ctx, args) => {
    await ensureUserRecord(ctx, args.userId);
    const timestamp = nowIso();
    const id = await ctx.db.insert("connectSessions", {
      userExternalId: args.userId,
      label: args.label,
      accessMode: args.accessMode,
      purpose: args.purpose ?? "t3_enrollment",
      environmentId: args.environmentId ?? null,
      status: "pending",
      codeHash: args.codeHash,
      expiresAt: args.expiresAt,
      baseUrl: null,
      error: null,
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "connect_session.created",
      targetId: id,
      metadata: { label: args.label, accessMode: args.accessMode, environmentId: args.environmentId ?? null },
    });
    return publicConnectSession(await ctx.db.get(id));
  },
});

export const getConnectSession = gatewayQuery({
  args: {
    userId: v.string(),
    sessionId: v.id("connectSessions"),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.userExternalId !== args.userId) return null;
    // A query cannot patch, so expiry is reported without being written back; the next claim or
    // completion persists it.
    return publicConnectSession(expiredConnectSessionView(session));
  },
});

export const claimConnectSession = gatewayMutation({
  args: {
    codeHash: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("connectSessions")
      .withIndex("byCodeHash", (q) => q.eq("codeHash", args.codeHash))
      .first();
    if (!session) return { session: null, reason: "unknown" };
    if (session.status === "pending" && Date.parse(session.expiresAt) <= Date.now()) {
      await ctx.db.patch(session._id, { status: "expired", updatedAt: nowIso() });
      return { session: null, reason: "expired" };
    }
    if (session.status !== "pending") return { session: null, reason: "used" };
    await ctx.db.patch(session._id, { status: "redeeming", updatedAt: nowIso() });
    return { session: publicConnectSession(await ctx.db.get(session._id)), reason: null };
  },
});

export const completeConnectSession = gatewayMutation({
  args: {
    sessionId: v.id("connectSessions"),
    environmentId: v.optional(v.union(v.id("environments"), v.null())),
    baseUrl: v.optional(v.union(v.string(), v.null())),
    error: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    const completedAt = nowIso();
    await ctx.db.patch(session._id, {
      status: args.error ? "failed" : "completed",
      environmentId: args.environmentId ?? session.environmentId ?? null,
      baseUrl: args.baseUrl ?? session.baseUrl ?? null,
      error: args.error ?? null,
      // Clearing the hash is what makes the code single-use at the credential level, not merely
      // at the status level.
      codeHash: null,
      completedAt,
      updatedAt: completedAt,
    });
    await audit(ctx, {
      userExternalId: session.userExternalId,
      actorType: "user",
      action: args.error ? "connect_session.failed" : "connect_session.completed",
      targetId: session._id,
      metadata: {
        environmentId: args.environmentId ?? session.environmentId ?? null,
        baseUrl: args.baseUrl ?? session.baseUrl ?? null,
        error: args.error ?? null,
      },
    });
    return publicConnectSession(await ctx.db.get(session._id));
  },
});

export const createConnector = gatewayMutation({
  args: {
    userId: v.string(),
    environmentId: v.id("environments"),
    label: v.string(),
    secretHash: v.string(),
    secretPrefix: v.string(),
    scopes: v.array(v.string()),
    protocolVersion: v.number(),
    connectorVersion: v.optional(v.union(v.string(), v.null())),
    platform: v.optional(v.union(v.string(), v.null())),
    capabilities: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const environment = await ctx.db.get(args.environmentId);
    if (!environment || environment.userExternalId !== args.userId || environment.archivedAt) return null;
    const timestamp = nowIso();
    const existingConnectors = await ctx.db.query("connectors")
      .withIndex("byEnvironmentId", (q) => q.eq("environmentId", args.environmentId))
      .collect();
    for (const existingConnector of existingConnectors) {
      if (existingConnector.revokedAt) continue;
      await ctx.db.patch(existingConnector._id, {
        secretHash: null,
        pendingSecretHash: null,
        pendingSecretPrefix: null,
        pendingCredentialVersion: null,
        rotationId: null,
        rotationExpiresAt: null,
        status: "revoked",
        revokedAt: timestamp,
        updatedAt: timestamp,
        lastDisconnectReason: "superseded_by_reenrollment",
      });
      const tickets = await ctx.db.query("connectorTickets")
        .withIndex("byConnectorId", (q) => q.eq("connectorId", existingConnector._id))
        .collect();
      for (const ticket of tickets) {
        if (!ticket.consumedAt) await ctx.db.patch(ticket._id, { consumedAt: timestamp });
      }
    }
    const id = await ctx.db.insert("connectors", {
      userExternalId: args.userId,
      environmentId: args.environmentId,
      label: args.label,
      secretHash: args.secretHash,
      secretPrefix: args.secretPrefix,
      credentialVersion: 1,
      pendingSecretHash: null,
      pendingSecretPrefix: null,
      pendingCredentialVersion: null,
      rotationId: null,
      rotationStartedAt: null,
      rotationExpiresAt: null,
      rotationCompletedAt: null,
      scopes: [...new Set(args.scopes)],
      status: "enrolled",
      protocolVersion: args.protocolVersion,
      connectorVersion: args.connectorVersion ?? null,
      t3Version: null,
      platform: args.platform ?? null,
      capabilities: [...new Set(args.capabilities)],
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSeenAt: null,
      lastConnectedAt: null,
      revokedAt: null,
      lastDisconnectReason: null,
      lastT3Health: null,
      lastT3HealthAt: null,
      activeRequests: 0,
      queueDepth: 0,
      lastPresenceEventAt: null,
      lastPresenceEventKey: null,
      lastConnectionId: null,
    });
    await ctx.db.patch(environment._id, {
      transportMode: "connector",
      connectorId: id,
      accessToken: undefined,
      baseUrl: null,
      lastConnectorSeenAt: null,
      freshness: "unknown",
      updatedAt: timestamp,
    });
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "connector.enrolled",
      targetId: id,
      metadata: { environmentId: args.environmentId, protocolVersion: args.protocolVersion, scopes: args.scopes },
    });
    return publicConnector(await ctx.db.get(id));
  },
});

// A mutation avoids Convex query caching across the pending-credential expiry
// boundary. The function does not write, but authentication must observe time.
export const authenticateConnector = gatewayMutation({
  args: { connectorId: v.id("connectors"), secretHash: v.string() },
  handler: async (ctx, args) => {
    const connector = await ctx.db.get(args.connectorId);
    if (!connector || connector.revokedAt) return null;
    const activeVersion = connector.credentialVersion ?? 1;
    if (connector.secretHash === args.secretHash) {
      return { ...connectorForGateway(connector), authenticatedCredentialVersion: activeVersion, credentialState: "active", authenticatedRotationId: null };
    }
    const pendingIsLive = connector.pendingSecretHash === args.secretHash
      && connector.pendingCredentialVersion === activeVersion + 1
      && Date.parse(connector.rotationExpiresAt ?? "") > Date.now();
    if (!pendingIsLive) return null;
    return { ...connectorForGateway(connector), authenticatedCredentialVersion: connector.pendingCredentialVersion, credentialState: "pending", authenticatedRotationId: connector.rotationId };
  },
});

// This verifier is intentionally narrower than ordinary authentication: after
// revocation it authorizes only an idempotent repeat of self-revocation.
export const authenticateConnectorForRevocation = gatewayMutation({
  args: { connectorId: v.id("connectors"), secretHash: v.string() },
  handler: async (ctx, args) => {
    const connector = await ctx.db.get(args.connectorId);
    if (!connector) return null;
    const activeVersion = connector.credentialVersion ?? 1;
    if (connector.secretHash === args.secretHash) {
      return { ...connectorForGateway(connector), authenticatedCredentialVersion: activeVersion, credentialState: "active", authenticatedRotationId: null };
    }
    if (connector.revokedAt) return null;
    const pendingIsLive = connector.pendingSecretHash === args.secretHash
      && connector.pendingCredentialVersion === activeVersion + 1
      && Date.parse(connector.rotationExpiresAt ?? "") > Date.now();
    if (!pendingIsLive) return null;
    return { ...connectorForGateway(connector), authenticatedCredentialVersion: connector.pendingCredentialVersion, credentialState: "pending", authenticatedRotationId: connector.rotationId };
  },
});

export const beginConnectorCredentialRotation = gatewayMutation({
  args: {
    userId: v.string(),
    connectorId: v.id("connectors"),
    pendingSecretHash: v.string(),
    pendingSecretPrefix: v.string(),
    rotationId: v.string(),
    expiresAt: v.string(),
  },
  handler: async (ctx, args) => {
    const connector = await ctx.db.get(args.connectorId);
    if (!connector || connector.userExternalId !== args.userId || connector.revokedAt) return null;
    const timestamp = nowIso();
    const activeVersion = connector.credentialVersion ?? 1;
    const tickets = await ctx.db.query("connectorTickets")
      .withIndex("byConnectorId", (q) => q.eq("connectorId", connector._id))
      .collect();
    for (const ticket of tickets) {
      if ((ticket.credentialVersion ?? 1) !== activeVersion && !ticket.consumedAt) {
        await ctx.db.patch(ticket._id, { consumedAt: timestamp });
      }
    }
    await ctx.db.patch(connector._id, {
      pendingSecretHash: args.pendingSecretHash,
      pendingSecretPrefix: args.pendingSecretPrefix,
      pendingCredentialVersion: activeVersion + 1,
      rotationId: args.rotationId,
      rotationStartedAt: timestamp,
      rotationExpiresAt: args.expiresAt,
      rotationCompletedAt: null,
      updatedAt: timestamp,
    });
    await audit(ctx, {
      userExternalId: connector.userExternalId,
      actorType: "user",
      action: "connector.rotation-started",
      targetId: connector._id,
      metadata: { rotationId: args.rotationId, expiresAt: args.expiresAt },
    });
    return {
      connector: publicConnector(await ctx.db.get(connector._id)),
      rotation: { id: args.rotationId, expiresAt: args.expiresAt },
    };
  },
});

export const listConnectors = gatewayQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const connectors = await ctx.db.query("connectors")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return connectors.sort((left, right) => left._creationTime - right._creationTime).map(publicConnector);
  },
});

export const listBackgroundWorkUsers = gatewayQuery({
  args: {
    afterUserId: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Number.isSafeInteger(args.limit) ? Math.max(1, Math.min(100, args.limit as number)) : 100;
    const rows = await ctx.db.query("users")
      .withIndex("byExternalId", (q: any) => args.afterUserId ? q.gt("externalId", args.afterUserId) : q)
      .order("asc")
      .take(limit + 1);
    const page = rows.slice(0, limit).map((row: any) => row.externalId);
    return { userIds: page, nextCursor: rows.length > limit ? page.at(-1) ?? null : null };
  },
});

export const getConnectorForUser = gatewayQuery({
  args: { userId: v.string(), connectorId: v.id("connectors") },
  handler: async (ctx, args) => {
    const connector = await ctx.db.get(args.connectorId);
    return connector?.userExternalId === args.userId ? publicConnector(connector) : null;
  },
});

export const revokeConnector = gatewayMutation({
  args: { userId: v.string(), connectorId: v.id("connectors"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const connector = await ctx.db.get(args.connectorId);
    if (!connector || connector.userExternalId !== args.userId) return null;
    if (!connector.revokedAt) {
      const timestamp = nowIso();
      await ctx.db.patch(connector._id, {
        secretHash: null,
        pendingSecretHash: null,
        pendingSecretPrefix: null,
        pendingCredentialVersion: null,
        rotationId: null,
        rotationExpiresAt: null,
        status: "revoked",
        revokedAt: timestamp,
        updatedAt: timestamp,
        lastDisconnectReason: args.reason ?? "revoked_by_user",
      });
      const tickets = await ctx.db.query("connectorTickets")
        .withIndex("byConnectorId", (q) => q.eq("connectorId", connector._id))
        .collect();
      for (const ticket of tickets) {
        if (!ticket.consumedAt) await ctx.db.patch(ticket._id, { consumedAt: timestamp });
      }
      await audit(ctx, { userExternalId: args.userId, actorType: "user", action: "connector.revoked", targetId: connector._id, metadata: { reason: args.reason ?? "revoked_by_user" } });
    }
    return publicConnector(await ctx.db.get(connector._id));
  },
});

export const revokeConnectorByCredential = gatewayMutation({
  args: { connectorId: v.id("connectors"), secretHash: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const connector = await ctx.db.get(args.connectorId);
    if (!connector) return null;
    const activeVersion = connector.credentialVersion ?? 1;
    const activeMatches = connector.secretHash === args.secretHash;
    const pendingMatches = !connector.revokedAt
      && connector.pendingSecretHash === args.secretHash
      && connector.pendingCredentialVersion === activeVersion + 1
      && Date.parse(connector.rotationExpiresAt ?? "") > Date.now();
    if (!activeMatches && !pendingMatches) return null;
    if (!connector.revokedAt) {
      const timestamp = nowIso();
      const reason = args.reason ?? "revoked_by_connector";
      await ctx.db.patch(connector._id, {
        // Retain only the authorizing hash so a lost response can be retried.
        // All ordinary auth paths reject revoked rows before hash comparison.
        secretHash: args.secretHash,
        pendingSecretHash: null,
        pendingSecretPrefix: null,
        pendingCredentialVersion: null,
        rotationId: null,
        rotationExpiresAt: null,
        status: "revoked",
        revokedAt: timestamp,
        updatedAt: timestamp,
        lastDisconnectReason: reason,
      });
      const tickets = await ctx.db.query("connectorTickets")
        .withIndex("byConnectorId", (q) => q.eq("connectorId", connector._id))
        .collect();
      for (const ticket of tickets) {
        if (!ticket.consumedAt) await ctx.db.patch(ticket._id, { consumedAt: timestamp });
      }
      await audit(ctx, { userExternalId: connector.userExternalId, actorType: "connector", action: "connector.self-revoked", targetId: connector._id, metadata: { reason } });
    }
    return publicConnector(await ctx.db.get(connector._id));
  },
});

export const createConnectorTicket = gatewayMutation({
  args: {
    connectorId: v.id("connectors"),
    tokenHash: v.string(),
    audience: v.string(),
    expiresAt: v.string(),
    credentialVersion: v.optional(v.union(v.number(), v.null())),
    rotationId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const connector = await ctx.db.get(args.connectorId);
    if (!connector || connector.revokedAt) return null;
    const activeVersion = connector.credentialVersion ?? 1;
    const requestedVersion = args.credentialVersion ?? activeVersion;
    const validPending = requestedVersion === connector.pendingCredentialVersion
      && args.rotationId === connector.rotationId
      && Date.parse(connector.rotationExpiresAt ?? "") > Date.now();
    if ((requestedVersion !== activeVersion || args.rotationId != null) && !validPending) return null;
    const createdAt = nowIso();
    await ctx.db.insert("connectorTickets", {
      connectorId: connector._id,
      environmentId: connector.environmentId,
      tokenHash: args.tokenHash,
      credentialVersion: requestedVersion,
      rotationId: validPending ? connector.rotationId : null,
      audience: args.audience,
      createdAt,
      expiresAt: args.expiresAt,
      consumedAt: null,
    });
    await ctx.db.patch(connector._id, { lastSeenAt: createdAt, updatedAt: createdAt });
    return { expiresAt: args.expiresAt };
  },
});

export const consumeConnectorTicket = gatewayMutation({
  args: {
    tokenHash: v.string(),
    audience: v.optional(v.union(v.string(), v.null())),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.query("connectorTickets")
      .withIndex("byTokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .first();
    if (!ticket) return { connector: null, reason: "unknown" };
    if (ticket.consumedAt) return { connector: null, reason: "used" };
    if (Date.parse(ticket.expiresAt) <= (args.now ?? Date.now())) return { connector: null, reason: "expired" };
    if (args.audience !== null && args.audience !== undefined && ticket.audience !== args.audience) {
      return { connector: null, reason: "audience" };
    }
    const connector = await ctx.db.get(ticket.connectorId);
    if (!connector || connector.revokedAt) return { connector: null, reason: "revoked" };
    const timestamp = nowIso();
    const activeVersion = connector.credentialVersion ?? 1;
    const ticketVersion = ticket.credentialVersion ?? 1;
    const commitsRotation = Boolean(ticketVersion === connector.pendingCredentialVersion
      && ticket.rotationId === connector.rotationId
      && connector.pendingSecretHash
      && Date.parse(connector.rotationExpiresAt ?? "") > (args.now ?? Date.now()));
    if (ticketVersion !== activeVersion && !commitsRotation) {
      return { connector: null, reason: "stale_credential" };
    }
    await ctx.db.patch(ticket._id, { consumedAt: timestamp });
    if (commitsRotation) {
      await ctx.db.patch(connector._id, {
        secretHash: connector.pendingSecretHash,
        secretPrefix: connector.pendingSecretPrefix ?? connector.secretPrefix,
        credentialVersion: ticketVersion,
        pendingSecretHash: null,
        pendingSecretPrefix: null,
        pendingCredentialVersion: null,
        rotationCompletedAt: timestamp,
        rotationExpiresAt: null,
        rotationId: null,
      });
      const tickets = await ctx.db.query("connectorTickets")
        .withIndex("byConnectorId", (q) => q.eq("connectorId", connector._id))
        .collect();
      for (const other of tickets) {
        if (other._id !== ticket._id && (other.credentialVersion ?? 1) === activeVersion && !other.consumedAt) {
          await ctx.db.patch(other._id, { consumedAt: timestamp });
        }
      }
      await audit(ctx, {
        userExternalId: connector.userExternalId,
        actorType: "connector",
        action: "connector.rotation-completed",
        targetId: connector._id,
        metadata: { credentialVersion: ticketVersion },
      });
    }
    await ctx.db.patch(connector._id, {
      lastConnectedAt: timestamp,
      lastSeenAt: timestamp,
      status: "online",
      updatedAt: timestamp,
    });
    await ctx.db.patch(ticket.environmentId, {
      lastConnectorSeenAt: timestamp,
      freshness: "live",
      updatedAt: timestamp,
    });
    return {
      connector: {
        ...connectorForGateway(await ctx.db.get(connector._id)),
        authenticatedCredentialVersion: ticketVersion,
        credentialState: commitsRotation ? "rotated" : "active",
      },
      ticket: {
        id: ticket._id,
        connectorId: ticket.connectorId,
        environmentId: ticket.environmentId,
        audience: ticket.audience ?? "agent-controller-connectors",
        credentialVersion: ticketVersion,
        rotationId: ticket.rotationId ?? null,
        expiresAt: ticket.expiresAt,
      },
      reason: null,
    };
  },
});

export const recordConnectorPresence = gatewayMutation({
  args: {
    connectorId: v.id("connectors"),
    environmentId: v.optional(v.union(v.id("environments"), v.null())),
    connectorVersion: v.optional(v.union(v.string(), v.null())),
    t3Version: v.optional(v.union(v.string(), v.null())),
    platform: v.optional(v.union(v.string(), v.null())),
    capabilities: v.optional(v.array(v.string())),
    t3Health: v.optional(v.any()),
    activeRequests: v.optional(v.union(v.number(), v.null())),
    queueDepth: v.optional(v.union(v.number(), v.null())),
    providerCatalogue: v.optional(v.union(providerCatalogueValidator, v.null())),
    connectionId: v.optional(v.union(v.string(), v.null())),
    occurredAt: v.optional(v.union(v.number(), v.null())),
    eventKey: v.optional(v.union(v.string(), v.null())),
    connected: v.optional(v.boolean()),
    disconnectReason: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const connector = await ctx.db.get(args.connectorId);
    if (!connector || connector.revokedAt || (args.environmentId && connector.environmentId !== args.environmentId)) return null;
    if (typeof args.occurredAt === "number") {
      if (typeof connector.lastPresenceEventAt === "number" && args.occurredAt < connector.lastPresenceEventAt) {
        return publicConnector(connector);
      }
      if (args.eventKey && connector.lastPresenceEventKey === args.eventKey) return publicConnector(connector);
    }
    const previousStatus = connector.status;
    const timestamp = nowIso();
    const connected = args.connected !== false;
    await ctx.db.patch(connector._id, {
      connectorVersion: args.connectorVersion ?? connector.connectorVersion ?? null,
      t3Version: args.t3Version ?? connector.t3Version ?? null,
      platform: args.platform ?? connector.platform ?? null,
      capabilities: args.capabilities ? [...new Set(args.capabilities)] : connector.capabilities,
      lastSeenAt: timestamp,
      lastConnectedAt: connected ? (connector.lastConnectedAt ?? timestamp) : connector.lastConnectedAt,
      status: connected ? "online" : "offline",
      lastDisconnectReason: args.disconnectReason ?? null,
      lastT3Health: args.t3Health ?? null,
      lastT3HealthAt: args.t3Health ? timestamp : connector.lastT3HealthAt,
      activeRequests: args.activeRequests ?? connector.activeRequests ?? 0,
      queueDepth: args.queueDepth ?? connector.queueDepth ?? 0,
      lastPresenceEventAt: args.occurredAt ?? connector.lastPresenceEventAt ?? null,
      lastPresenceEventKey: args.eventKey ?? connector.lastPresenceEventKey ?? null,
      lastConnectionId: args.connectionId ?? connector.lastConnectionId ?? null,
      updatedAt: timestamp,
    });
    await ctx.db.patch(connector.environmentId, {
      ...(args.providerCatalogue ? { providerCatalogue: args.providerCatalogue } : {}),
      lastConnectorSeenAt: timestamp,
      freshness: connected ? "live" : "stale",
      updatedAt: timestamp,
    });
    return { ...publicConnector(await ctx.db.get(connector._id)), _previousStatus: previousStatus };
  },
});

export const createFirmwareRelease = gatewayMutation({
  args: {
    version: v.string(),
    channel: v.optional(v.string()),
    hardwareModel: v.string(),
    url: v.string(),
    sha256: v.string(),
    sizeBytes: v.number(),
    mandatory: v.boolean(),
    releaseNotes: v.optional(v.string()),
    artifactKey: v.optional(v.string()),
    artifactProvider: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("firmwareReleases", {
      version: args.version,
      channel: args.channel ?? "stable",
      hardwareModel: args.hardwareModel,
      url: args.url,
      sha256: args.sha256,
      sizeBytes: args.sizeBytes,
      mandatory: args.mandatory,
      releaseNotes: args.releaseNotes ?? "",
      ...(args.artifactKey ? { artifactKey: args.artifactKey } : {}),
      ...(args.artifactProvider ? { artifactProvider: args.artifactProvider } : {}),
      createdAt: nowIso(),
    });
    const release = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: "system",
      actorType: "system",
      action: "firmware.release_created",
      targetId: id,
      metadata: {
        version: args.version,
        channel: args.channel ?? "stable",
        hardwareModel: args.hardwareModel,
        mandatory: args.mandatory,
      },
    });
    return { ...publicFirmwareRelease(release), artifactKey: release.artifactKey ?? null,
      artifactProvider: release.artifactProvider ?? null };
  },
});

export const deleteFirmwareRelease = gatewayMutation({
  args: { releaseId: v.string() },
  handler: async (ctx, args) => {
    const releaseId = ctx.db.normalizeId("firmwareReleases", args.releaseId);
    if (!releaseId) return null;
    const release = await ctx.db.get(releaseId);
    if (!release) return null;
    await ctx.db.delete(releaseId);
    await audit(ctx, {
      userExternalId: "system",
      actorType: "system",
      action: "firmware.release_deleted",
      targetId: releaseId,
      metadata: {
        version: release.version,
        channel: release.channel ?? "stable",
        hardwareModel: release.hardwareModel,
      },
    });
    return { ...publicFirmwareRelease(release), artifactKey: release.artifactKey ?? null,
      artifactProvider: release.artifactProvider ?? null };
  },
});

export const listFirmwareReleases = gatewayQuery({
  args: {
    hardwareModel: v.optional(v.string()),
    channel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const releases = args.hardwareModel
      ? await ctx.db
        .query("firmwareReleases")
        .withIndex("byHardwareModel", (q) => q.eq("hardwareModel", args.hardwareModel!))
        .collect()
      : await ctx.db.query("firmwareReleases").collect();
    return releases
      .filter((release) => !args.channel || (release.channel ?? "stable") === args.channel)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(publicFirmwareRelease);
  },
});

export const getLatestFirmwareRelease = gatewayQuery({
  args: {
    hardwareModel: v.string(),
    channel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const releases = await ctx.db
      .query("firmwareReleases")
      .withIndex("byHardwareModel", (q) => q.eq("hardwareModel", args.hardwareModel))
      .collect();
    return publicFirmwareRelease(releases
      .filter((release) => !args.channel || (release.channel ?? "stable") === args.channel)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1));
  },
});

export const getFirmwareArtifact = gatewayQuery({
  args: { sha256: v.string(), hardwareModel: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const releases = await ctx.db.query("firmwareReleases").collect();
    const release = releases.find((candidate) => candidate.sha256 === args.sha256 && candidate.artifactKey
      && (!args.hardwareModel || candidate.hardwareModel === args.hardwareModel));
    if (!release) return null;
    return { ...publicFirmwareRelease(release), artifactKey: release.artifactKey,
      artifactProvider: release.artifactProvider ?? "disk" };
  },
});

export const createReleaseRollout = gatewayMutation({
  args: {
    userId: v.string(), name: v.string(), targetKind: v.string(), targetVersion: v.string(),
    rollbackVersion: v.optional(v.union(v.string(), v.null())),
    releaseId: v.optional(v.union(v.string(), v.null())), channel: v.string(), cohort: v.any(),
    minimumProtocolVersion: v.number(), requiredCapabilities: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const timestamp = nowIso();
    const id = await ctx.db.insert("releaseRollouts", {
      userExternalId: args.userId,
      name: args.name,
      targetKind: args.targetKind,
      targetVersion: args.targetVersion,
      rollbackVersion: args.rollbackVersion ?? null,
      releaseId: args.releaseId ?? null,
      channel: args.channel,
      cohort: args.cohort,
      minimumProtocolVersion: args.minimumProtocolVersion,
      requiredCapabilities: [...new Set(args.requiredCapabilities)],
      state: "draft",
      evidenceRef: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      completedAt: null,
    });
    await audit(ctx, {
      userExternalId: args.userId, actorType: "user", action: "release_rollout.created", targetId: id,
      metadata: { targetKind: args.targetKind, targetVersion: args.targetVersion,
        channel: args.channel, cohortType: args.cohort?.type ?? null },
    });
    return await publicReleaseRolloutWithProgress(ctx, await ctx.db.get(id));
  },
});

export const listReleaseRollouts = gatewayQuery({
  args: { userId: v.string(), states: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("releaseRollouts")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId)).collect();
    const filtered = args.states ? rows.filter((row) => args.states!.includes(row.state)) : rows;
    return await Promise.all(filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((row) => publicReleaseRolloutWithProgress(ctx, row)));
  },
});

export const listRunnableReleaseRollouts = gatewayQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(100, args.limit ?? 25));
    const rows = await ctx.db.query("releaseRollouts").collect();
    return rows.filter((row) => ["running", "rolling_back"].includes(row.state))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, limit).map(publicReleaseRolloutRecord);
  },
});

export const getReleaseRolloutForUser = gatewayQuery({
  args: { userId: v.string(), rolloutId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("releaseRollouts", args.rolloutId);
    const row = id ? await ctx.db.get(id) : null;
    return row?.userExternalId === args.userId ? await publicReleaseRolloutWithProgress(ctx, row) : null;
  },
});

export const transitionReleaseRollout = gatewayMutation({
  args: { userId: v.string(), rolloutId: v.string(), action: v.string(), evidenceRef: v.string(),
    percentage: v.optional(v.union(v.number(), v.null())) },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("releaseRollouts", args.rolloutId);
    const rollout = id ? await ctx.db.get(id) : null;
    if (!rollout || rollout.userExternalId !== args.userId) return null;
    const transitions: Record<string, { from: string[]; to: string }> = {
      start: { from: ["draft", "paused"], to: "running" }, resume: { from: ["paused"], to: "running" },
      pause: { from: ["running"], to: "paused" }, cancel: { from: ["draft", "running", "paused"], to: "cancelled" },
      rollback: { from: ["running", "paused", "completed"], to: "rolling_back" },
      complete: { from: ["running", "rolling_back"], to: rollout.state === "rolling_back" ? "rolled_back" : "completed" },
      expand: { from: ["running", "paused"], to: rollout.state },
    };
    const transition = transitions[args.action];
    if (!transition || !transition.from.includes(rollout.state)) {
      return { conflict: true, rollout: await publicReleaseRolloutWithProgress(ctx, rollout) };
    }
    if (args.action === "rollback" && !rollout.rollbackVersion) {
      return { conflict: true, reason: "rollback_version_required", rollout: await publicReleaseRolloutWithProgress(ctx, rollout) };
    }
    let cohort = rollout.cohort;
    if (args.action === "expand") {
      if (cohort?.type !== "percentage" || !Number.isInteger(args.percentage)
        || Number(args.percentage) <= Number(cohort.percentage) || Number(args.percentage) > 100) {
        return { conflict: true, reason: "percentage_must_increase", rollout: await publicReleaseRolloutWithProgress(ctx, rollout) };
      }
      cohort = { type: "percentage", percentage: args.percentage };
    }
    const timestamp = nowIso();
    await ctx.db.patch(rollout._id, {
      state: transition.to, cohort, evidenceRef: args.evidenceRef, updatedAt: timestamp,
      ...(["start", "resume"].includes(args.action) && !rollout.startedAt ? { startedAt: timestamp } : {}),
      ...(args.action === "complete" ? { completedAt: timestamp } : {}),
    });
    await audit(ctx, {
      userExternalId: args.userId, actorType: "user", action: `release_rollout.${args.action}`, targetId: rollout._id,
      metadata: { state: transition.to, targetKind: rollout.targetKind,
        targetVersion: rollout.targetVersion, evidenceRef: args.evidenceRef,
        ...(args.action === "expand" ? { percentage: args.percentage } : {}) },
    });
    return { conflict: false, rollout: await publicReleaseRolloutWithProgress(ctx, await ctx.db.get(rollout._id)) };
  },
});

export const upsertRolloutAssignment = gatewayMutation({
  args: { userId: v.string(), rolloutId: v.string(), targetId: v.string(), patch: v.any() },
  handler: async (ctx, args) => {
    const rolloutId = ctx.db.normalizeId("releaseRollouts", args.rolloutId);
    const rollout = rolloutId ? await ctx.db.get(rolloutId) : null;
    if (!rollout || rollout.userExternalId !== args.userId) return null;
    const existing = await ctx.db.query("rolloutAssignments")
      .withIndex("byRolloutTarget", (q) => q.eq("rolloutId", rollout._id).eq("targetId", args.targetId)).unique();
    const timestamp = nowIso();
    const status = args.patch.status ?? existing?.status ?? "pending";
    const values = {
      status,
      reasonCode: args.patch.reasonCode ?? null,
      observedVersion: args.patch.observedVersion ?? existing?.observedVersion ?? null,
      progress: Number.isFinite(args.patch.progress) ? Math.max(0, Math.min(100, args.patch.progress)) : existing?.progress ?? null,
      attempts: (existing?.attempts ?? 0) + (args.patch.attempted ? 1 : 0),
      previousDesiredVersion: existing?.previousDesiredVersion ?? args.patch.previousDesiredVersion ?? null,
      updatedAt: timestamp,
      completedAt: ["succeeded", "failed", "cancelled", "rolled_back"].includes(status)
        ? timestamp : existing?.completedAt ?? null,
    };
    let id;
    if (existing) {
      await ctx.db.patch(existing._id, values);
      id = existing._id;
    } else {
      id = await ctx.db.insert("rolloutAssignments", {
        userExternalId: args.userId, rolloutId: rollout._id, targetId: args.targetId,
        targetKind: rollout.targetKind, createdAt: timestamp, ...values,
      });
    }
    await ctx.db.patch(rollout._id, { updatedAt: timestamp });
    if (!existing || existing.status !== status || existing.reasonCode !== values.reasonCode) {
      await audit(ctx, { userExternalId: args.userId, actorType: "system",
        action: "release_rollout.assignment_changed", targetId: id,
        metadata: { rolloutId: rollout._id, targetId: args.targetId, status, reasonCode: values.reasonCode } });
    }
    const row = await ctx.db.get(id);
    return row ? publicRolloutAssignment(row) : null;
  },
});

export const listRolloutAssignments = gatewayQuery({
  args: { userId: v.string(), rolloutId: v.string() },
  handler: async (ctx, args) => {
    const rolloutId = ctx.db.normalizeId("releaseRollouts", args.rolloutId);
    const rollout = rolloutId ? await ctx.db.get(rolloutId) : null;
    if (!rollout || rollout.userExternalId !== args.userId) return [];
    const rows = await ctx.db.query("rolloutAssignments")
      .withIndex("byRolloutId", (q) => q.eq("rolloutId", rollout._id)).collect();
    return rows.sort((a, b) => a.targetId.localeCompare(b.targetId)).map(publicRolloutAssignment);
  },
});

export const createCompanionHandoff = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.union(v.id("devices"), v.null()),
    environmentId: v.id("environments"),
    threadId: v.string(),
    action: v.string(),
    codeHash: v.string(),
    expiresAt: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows = await ctx.db.query("companionHandoffs")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId)).take(257);
    for (const row of rows) {
      if (row.status === "waiting" && Date.parse(row.expiresAt) <= now) {
        await ctx.db.patch(row._id, { status: "expired", codeHash: null });
      }
    }
    rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    while (rows.length >= 256) {
      const terminalIndex = rows.findIndex((row) => ["completed", "expired", "cancelled"].includes(row.status)
        || (row.status === "waiting" && Date.parse(row.expiresAt) <= now));
      if (terminalIndex === -1) return { limitExceeded: true, handoff: null };
      const [terminal] = rows.splice(terminalIndex, 1);
      await ctx.db.delete(terminal._id);
    }
    const active = rows.filter((row) => ["waiting", "claimed"].includes(row.status)
      && !(row.status === "waiting" && Date.parse(row.expiresAt) <= now));
    if (active.length >= 32) return { limitExceeded: true, handoff: null };
    const id = await ctx.db.insert("companionHandoffs", {
      userExternalId: args.userId,
      deviceId: args.deviceId,
      environmentId: args.environmentId,
      threadId: args.threadId,
      action: args.action,
      status: "waiting",
      codeHash: args.codeHash,
      createdAt: nowIso(),
      expiresAt: args.expiresAt,
      claimedAt: null,
      completedAt: null,
      cancelledAt: null,
    });
    const handoff = await ctx.db.get(id);
    await audit(ctx, { userExternalId: args.userId, actorType: args.deviceId ? "device" : "user",
      actorId: args.deviceId ?? undefined, action: "companion_handoff.created", targetId: id,
      metadata: { action: args.action, expiresAt: args.expiresAt } });
    return { limitExceeded: false, handoff: publicCompanionHandoff(handoff) };
  },
});

export const getCompanionHandoffForUser = gatewayQuery({
  args: { userId: v.string(), handoffId: v.id("companionHandoffs") },
  handler: async (ctx, args) => {
    const handoff = await ctx.db.get(args.handoffId);
    if (!handoff || handoff.userExternalId !== args.userId) return null;
    return publicCompanionHandoff(handoff);
  },
});

export const getCompanionHandoffForDevice = gatewayQuery({
  args: { userId: v.string(), deviceId: v.id("devices"), handoffId: v.id("companionHandoffs") },
  handler: async (ctx, args) => {
    const handoff = await ctx.db.get(args.handoffId);
    if (!handoff || handoff.userExternalId !== args.userId || handoff.deviceId !== args.deviceId) return null;
    return publicCompanionHandoff(handoff);
  },
});

export const claimCompanionHandoff = gatewayMutation({
  args: { userId: v.string(), codeHash: v.string(), claimedAt: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const handoff = await ctx.db.query("companionHandoffs")
      .withIndex("byCodeHash", (q) => q.eq("codeHash", args.codeHash)).unique();
    if (!handoff || handoff.userExternalId !== args.userId) return null;
    const claimedAt = args.claimedAt ?? nowIso();
    if (handoff.status !== "waiting" || Date.parse(handoff.expiresAt) <= Date.parse(claimedAt)) {
      if (handoff.status === "waiting") await ctx.db.patch(handoff._id, { status: "expired", codeHash: null });
      return publicCompanionHandoff(await ctx.db.get(handoff._id));
    }
    await ctx.db.patch(handoff._id, { status: "claimed", claimedAt, codeHash: null });
    await audit(ctx, { userExternalId: args.userId, actorType: "user",
      action: "companion_handoff.claimed", targetId: handoff._id,
      metadata: { action: handoff.action } });
    return publicCompanionHandoff(await ctx.db.get(handoff._id));
  },
});

export const cancelCompanionHandoff = gatewayMutation({
  args: { userId: v.string(), handoffId: v.id("companionHandoffs"), deviceId: v.union(v.id("devices"), v.null()), cancelledAt: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const handoff = await ctx.db.get(args.handoffId);
    if (!handoff || handoff.userExternalId !== args.userId) return null;
    if (args.deviceId !== null && handoff.deviceId !== args.deviceId) return null;
    if (["waiting", "claimed"].includes(handoff.status)) {
      await ctx.db.patch(handoff._id, { status: "cancelled", codeHash: null,
        cancelledAt: args.cancelledAt ?? nowIso() });
    }
    return publicCompanionHandoff(await ctx.db.get(handoff._id));
  },
});

export const completeCompanionHandoff = gatewayMutation({
  args: { userId: v.string(), handoffId: v.id("companionHandoffs"), completedAt: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const handoff = await ctx.db.get(args.handoffId);
    if (!handoff || handoff.userExternalId !== args.userId) return null;
    if (handoff.status === "claimed") {
      await ctx.db.patch(handoff._id, { status: "completed", completedAt: args.completedAt ?? nowIso() });
    }
    return publicCompanionHandoff(await ctx.db.get(handoff._id));
  },
});

export const createMediaUploadSession = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.union(v.id("devices"), v.null()),
    clientRequestId: v.string(),
    kind: v.string(),
    contentType: v.string(),
    expectedSizeBytes: v.number(),
    expectedSha256: v.string(),
    ownerByteLimit: v.number(),
    storagePath: v.string(),
    originalName: v.optional(v.string()),
    transcript: v.optional(v.string()),
    captureSource: v.optional(v.string()),
    environmentId: v.optional(v.union(v.id("environments"), v.null())),
    threadId: v.optional(v.union(v.string(), v.null())),
    companionHandoffId: v.optional(v.union(v.id("companionHandoffs"), v.null())),
    expiresAt: v.string(),
    createdAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("mediaUploadSessions")
      .withIndex("byOwnerRequest", (q: any) => q
        .eq("userExternalId", args.userId)
        .eq("clientRequestId", args.clientRequestId))
      .collect();
    const existing = rows.find((session: any) => (session.deviceId ?? null) === args.deviceId);
    if (existing) {
      const conflict = existing.kind !== args.kind
        || existing.contentType !== args.contentType
        || existing.expectedSizeBytes !== args.expectedSizeBytes
        || existing.expectedSha256 !== args.expectedSha256;
      return { created: false, conflict, session: publicMediaUploadSession(existing) };
    }
    const usage = await ensureMediaOwnerUsage(ctx, args.userId);
    if (usage.committedBytes + usage.reservedBytes + args.expectedSizeBytes > args.ownerByteLimit) {
      return { created: false, conflict: false, byteLimitExceeded: true, session: null };
    }
    const ownerSessions = await ctx.db
      .query("mediaUploadSessions")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .take(257);
    if (args.companionHandoffId && ownerSessions.some((session) => (
      session.companionHandoffId === args.companionHandoffId
      && ["pending", "uploaded", "finalized"].includes(session.status)
    ))) {
      return { created: false, conflict: true, session: null };
    }
    while (ownerSessions.length >= 256) {
      const terminalIndex = ownerSessions.findIndex((session) => (
        ["finalized", "aborted", "expired"].includes(session.status)
      ));
      if (terminalIndex === -1) {
        return { created: false, conflict: false, limitExceeded: true, session: null };
      }
      const [terminal] = ownerSessions.splice(terminalIndex, 1);
      await ctx.db.delete(terminal._id);
    }
    const id = await ctx.db.insert("mediaUploadSessions", {
      userExternalId: args.userId,
      deviceId: args.deviceId,
      clientRequestId: args.clientRequestId,
      kind: args.kind,
      contentType: args.contentType,
      expectedSizeBytes: args.expectedSizeBytes,
      expectedSha256: args.expectedSha256,
      storagePath: args.storagePath,
      originalName: args.originalName ?? null,
      transcript: args.kind === "audio" ? normalizeTranscript(args.transcript) ?? null : null,
      captureSource: args.captureSource ?? undefined,
      environmentId: args.environmentId ?? null,
      threadId: args.threadId ?? null,
      companionHandoffId: args.companionHandoffId ?? null,
      status: "pending",
      mediaId: null,
      createdAt: args.createdAt ?? nowIso(),
      expiresAt: args.expiresAt,
      uploadedAt: null,
      finalizedAt: null,
      abortedAt: null,
    });
    const session = await ctx.db.get(id);
    await ctx.db.patch(usage._id, {
      reservedBytes: usage.reservedBytes + args.expectedSizeBytes,
      updatedAt: nowIso(),
    });
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: args.deviceId ? "device" : "user",
      actorId: args.deviceId ?? undefined,
      action: "media.upload_session_created",
      targetId: id,
      metadata: {
        kind: args.kind,
        contentType: args.contentType,
        expectedSizeBytes: args.expectedSizeBytes,
        expiresAt: args.expiresAt,
      },
    });
    return { created: true, conflict: false, session: publicMediaUploadSession(session) };
  },
});

export const getMediaUploadSessionForActor = gatewayQuery({
  args: {
    userId: v.string(),
    deviceId: v.union(v.id("devices"), v.null()),
    sessionId: v.id("mediaUploadSessions"),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.userExternalId !== args.userId) return null;
    if (args.deviceId !== null && (session.deviceId ?? null) !== args.deviceId) return null;
    return mediaUploadSessionForGateway(session);
  },
});

export const markMediaUploadSessionUploaded = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.union(v.id("devices"), v.null()),
    sessionId: v.id("mediaUploadSessions"),
    uploadedAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.userExternalId !== args.userId) return null;
    if (args.deviceId !== null && (session.deviceId ?? null) !== args.deviceId) return null;
    if (session.status === "pending") {
      await ctx.db.patch(session._id, { status: "uploaded", uploadedAt: args.uploadedAt ?? nowIso() });
    }
    return publicMediaUploadSession(await ctx.db.get(session._id));
  },
});

export const finalizeMediaUploadSession = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.union(v.id("devices"), v.null()),
    sessionId: v.id("mediaUploadSessions"),
    storagePath: v.string(),
    mediaExpiresAt: v.union(v.string(), v.null()),
    finalizedAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.userExternalId !== args.userId) return null;
    if (args.deviceId !== null && (session.deviceId ?? null) !== args.deviceId) return null;
    if (session.status === "finalized" && session.mediaId) {
      return {
        session: publicMediaUploadSession(session),
        media: publicMediaUpload(await ctx.db.get(session.mediaId)),
      };
    }
    if (session.status !== "uploaded") {
      return { session: publicMediaUploadSession(session), media: null };
    }
    let media = (await ctx.db
      .query("mediaUploads")
      .withIndex("byUploadSessionId", (q: any) => q.eq("uploadSessionId", session._id))
      .unique()) as any;
    if (!media) {
      const transcript = session.kind === "audio" ? session.transcript ?? null : null;
      const mediaId = await ctx.db.insert("mediaUploads", {
        userExternalId: session.userExternalId,
        ...(session.deviceId ? { deviceId: session.deviceId } : {}),
        kind: session.kind,
        contentType: session.contentType,
        sizeBytes: session.expectedSizeBytes,
        sha256: session.expectedSha256,
        storagePath: args.storagePath,
        uploadSessionId: session._id,
        ...(session.originalName ? { originalName: session.originalName } : {}),
        transcript,
        captureSource: session.captureSource ?? undefined,
        environmentId: session.environmentId ?? null,
        threadId: session.threadId ?? null,
        companionHandoffId: session.companionHandoffId ?? null,
        processing: normalizeMediaProcessing(null, session.kind, transcript),
        expiresAt: args.mediaExpiresAt,
        createdAt: nowIso(),
      });
      media = await ctx.db.get(mediaId);
      const usage = await ensureMediaOwnerUsage(ctx, session.userExternalId);
      await ctx.db.patch(usage._id, {
        committedBytes: usage.committedBytes + session.expectedSizeBytes,
        reservedBytes: Math.max(0, usage.reservedBytes - session.expectedSizeBytes),
        updatedAt: nowIso(),
      });
      await audit(ctx, {
        userExternalId: session.userExternalId,
        actorType: session.deviceId ? "device" : "user",
        actorId: session.deviceId ?? undefined,
        action: "media.uploaded",
        targetId: mediaId,
        metadata: {
          kind: session.kind,
          contentType: session.contentType,
          sizeBytes: session.expectedSizeBytes,
          sha256: session.expectedSha256,
          transcriptLength: transcript?.length ?? 0,
          expiresAt: args.mediaExpiresAt,
        },
      });
    }
    await ctx.db.patch(session._id, {
      status: "finalized",
      mediaId: media._id,
      finalizedAt: args.finalizedAt ?? nowIso(),
    });
    return {
      session: publicMediaUploadSession(await ctx.db.get(session._id)),
      media: publicMediaUpload(media),
    };
  },
});

export const abortMediaUploadSession = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.union(v.id("devices"), v.null()),
    sessionId: v.id("mediaUploadSessions"),
    status: v.optional(v.string()),
    at: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.userExternalId !== args.userId) return null;
    if (args.deviceId !== null && (session.deviceId ?? null) !== args.deviceId) return null;
    if (session.status === "finalized") return publicMediaUploadSession(session);
    if (session.status !== "aborted" && session.status !== "expired") {
      const usage = await ensureMediaOwnerUsage(ctx, args.userId);
      await ctx.db.patch(usage._id, {
        reservedBytes: Math.max(0, usage.reservedBytes - session.expectedSizeBytes),
        updatedAt: nowIso(),
      });
      await ctx.db.patch(session._id, {
        status: args.status === "expired" ? "expired" : "aborted",
        abortedAt: args.at ?? nowIso(),
      });
    }
    return publicMediaUploadSession(await ctx.db.get(session._id));
  },
});

export const listExpiredMediaUploadSessions = gatewayQuery({
  args: { userId: v.string(), now: v.string() },
  handler: async (ctx, args) => {
    const sessions = await ctx.db
      .query("mediaUploadSessions")
      .withIndex("byUserExternalId", (q: any) => q.eq("userExternalId", args.userId))
      .collect();
    return sessions
      .filter((session: any) => ["pending", "uploaded"].includes(session.status)
        && session.expiresAt <= args.now)
      .map(mediaUploadSessionForGateway);
  },
});

export const createMediaUpload = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.union(v.id("devices"), v.null()),
    kind: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
    sha256: v.string(),
    storagePath: v.string(),
    uploadSessionId: v.optional(v.union(v.id("mediaUploadSessions"), v.null())),
    originalName: v.optional(v.string()),
    transcript: v.optional(v.string()),
    captureSource: v.optional(v.string()),
    environmentId: v.optional(v.union(v.id("environments"), v.null())),
    threadId: v.optional(v.union(v.string(), v.null())),
    companionHandoffId: v.optional(v.union(v.id("companionHandoffs"), v.null())),
    expiresAt: v.optional(v.union(v.string(), v.null())),
    ownerByteLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.uploadSessionId) {
      const existing = await ctx.db
        .query("mediaUploads")
        .withIndex("byUploadSessionId", (q: any) => q.eq("uploadSessionId", args.uploadSessionId))
        .unique();
      if (existing) return publicMediaUpload(existing);
    }
    const usage = await ensureMediaOwnerUsage(ctx, args.userId);
    if (args.ownerByteLimit !== undefined
      && usage.committedBytes + usage.reservedBytes + args.sizeBytes > args.ownerByteLimit) {
      return { byteLimitExceeded: true };
    }
    const transcript = args.kind === "audio" ? normalizeTranscript(args.transcript) ?? null : null;
    const id = await ctx.db.insert("mediaUploads", {
      userExternalId: args.userId,
      ...(args.deviceId ? { deviceId: args.deviceId } : {}),
      kind: args.kind,
      contentType: args.contentType,
      sizeBytes: args.sizeBytes,
      sha256: args.sha256,
      storagePath: args.storagePath,
      ...(args.uploadSessionId ? { uploadSessionId: args.uploadSessionId } : {}),
      ...(args.originalName ? { originalName: args.originalName } : {}),
      captureSource: args.captureSource ?? undefined,
      environmentId: args.environmentId ?? null,
      threadId: args.threadId ?? null,
      companionHandoffId: args.companionHandoffId ?? null,
      transcript,
      processing: normalizeMediaProcessing(null, args.kind, transcript),
      expiresAt: args.expiresAt ?? null,
      createdAt: nowIso(),
    });
    const media = await ctx.db.get(id);
    await ctx.db.patch(usage._id, {
      committedBytes: usage.committedBytes + args.sizeBytes,
      updatedAt: nowIso(),
    });
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: args.deviceId ? "device" : "user",
      actorId: args.deviceId ?? undefined,
      action: "media.uploaded",
      targetId: id,
      metadata: {
        kind: args.kind,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        sha256: args.sha256,
        transcriptLength: transcript?.length ?? 0,
        transcriptionStatus: normalizeMediaProcessing(null, args.kind, transcript).transcriptionStatus,
        expiresAt: args.expiresAt ?? null,
      },
    });
    return publicMediaUpload(media);
  },
});

export const updateMediaTranscript = gatewayMutation({
  args: {
    userId: v.string(),
    mediaId: v.id("mediaUploads"),
    transcript: v.string(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    if (!media || media.userExternalId !== args.userId || media.kind !== "audio") return null;
    const transcript = normalizeTranscript(args.transcript) ?? null;
    await ctx.db.patch(media._id, {
      transcript,
      processing: normalizeMediaProcessing({
        transcriptionStatus: transcript ? "ready" : "pending",
        transcriptSource: args.source ?? "manual",
        lastError: null,
      }, media.kind, transcript),
    });
    const updated = await ctx.db.get(media._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "media.transcript_updated",
      targetId: media._id,
      metadata: {
        previousLength: media.transcript?.length ?? 0,
        transcriptLength: transcript?.length ?? 0,
      },
    });
    return publicMediaUpload(updated);
  },
});

export const updateMediaDescription = gatewayMutation({
  args: {
    userId: v.string(),
    mediaId: v.id("mediaUploads"),
    description: v.string(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    if (!media || media.userExternalId !== args.userId || media.kind !== "image") return null;
    const description = normalizeTranscript(args.description) ?? null;
    await ctx.db.patch(media._id, {
      description,
      processing: normalizeMediaProcessing({
        visionStatus: description ? "ready" : "pending",
        descriptionSource: args.source ?? "manual",
        lastError: null,
      }, media.kind, media.transcript ?? null, description),
    });
    const updated = await ctx.db.get(media._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "media.description_updated",
      targetId: media._id,
      metadata: {
        previousLength: media.description?.length ?? 0,
        descriptionLength: description?.length ?? 0,
        source: args.source ?? "manual",
      },
    });
    return publicMediaUpload(updated);
  },
});

export const updateMediaProcessing = gatewayMutation({
  args: {
    userId: v.string(),
    mediaId: v.id("mediaUploads"),
    processing: v.any(),
  },
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    if (!media || media.userExternalId !== args.userId) return null;
    if (media.kind !== "audio" && media.kind !== "image") return null;
    const processing = normalizeMediaProcessing(
      args.processing,
      media.kind,
      media.transcript ?? null,
      media.description ?? null,
    );
    await ctx.db.patch(media._id, { processing });
    const updated = await ctx.db.get(media._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "system",
      action: "media.processing_updated",
      targetId: media._id,
      metadata: processing,
    });
    return publicMediaUpload(updated);
  },
});

export const getMediaForUser = gatewayQuery({
  args: {
    userId: v.string(),
    mediaId: v.id("mediaUploads"),
  },
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    if (!media || media.userExternalId !== args.userId) return null;
    return mediaForGateway(media);
  },
});

export const listMediaUploads = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const media = await ctx.db
      .query("mediaUploads")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return media.map(publicMediaUpload);
  },
});

export const listExpiredMediaUploads = gatewayQuery({
  args: {
    userId: v.string(),
    now: v.string(),
  },
  handler: async (ctx, args) => {
    const media = await ctx.db
      .query("mediaUploads")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return media
      .filter((item) => item.expiresAt && item.expiresAt <= args.now)
      .map(mediaForGateway);
  },
});

export const deleteMediaUpload = gatewayMutation({
  args: {
    userId: v.string(),
    mediaId: v.id("mediaUploads"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    if (!media || media.userExternalId !== args.userId) return null;
    const usage = await ensureMediaOwnerUsage(ctx, args.userId);
    await ctx.db.delete(media._id);
    await ctx.db.patch(usage._id, {
      committedBytes: Math.max(0, usage.committedBytes - media.sizeBytes),
      updatedAt: nowIso(),
    });
    // A job whose media is gone can never finish; leaving it queued would make the worker
    // rediscover it on every tick until the retry budget burned out.
    const orphaned = await ctx.db
      .query("mediaJobs")
      .withIndex("byMediaId", (q: any) => q.eq("mediaId", args.mediaId))
      .collect();
    for (const job of orphaned) await ctx.db.delete(job._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "media.deleted",
      targetId: media._id,
      metadata: {
        kind: media.kind,
        contentType: media.contentType,
        sizeBytes: media.sizeBytes,
        sha256: media.sha256,
        reason: args.reason ?? "manual",
      },
    });
    return publicMediaUpload(media);
  },
});

// --- Durable media processing jobs -----------------------------------------------------------
//
// Mirrors createMediaJob/claimMediaJobs/updateMediaJob in src/store.mjs. Convex cannot import from
// src/, so normalizeMediaJobStage() and resumeStageFor() are duplicated here; test/storeParity
// fails the moment the two copies disagree.

const mediaJobStages = [
  "queued",
  "transcribing",
  "normalizing",
  "review_required",
  "ready",
  "dispatching",
  "dispatched",
  "failed",
];
const mediaJobTerminalStages = new Set(["dispatched", "failed"]);
// Mirrors MEDIA_JOB_FAILURE_CAUSES in src/store.mjs, itself a mirror of the transcription layer's
// list. Validated here so the store never persists a category nothing understands.
const mediaJobFailureCauses = ["configuration", "input", "provider", "unknown"];
const defaultMediaJobMaxAttempts = 3;

export const createMediaJob = gatewayMutation({
  args: {
    userId: v.string(),
    mediaId: v.id("mediaUploads"),
    kind: v.optional(v.string()),
    provider: v.optional(v.union(v.string(), v.null())),
    model: v.optional(v.union(v.string(), v.null())),
    language: v.optional(v.union(v.string(), v.null())),
    maxAttempts: v.optional(v.number()),
    reviewRequired: v.optional(v.boolean()),
    deviceId: v.optional(v.union(v.id("devices"), v.null())),
    environmentId: v.optional(v.union(v.id("environments"), v.null())),
    threadId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const media = await ctx.db.get(args.mediaId);
    if (!media || media.userExternalId !== args.userId) return null;
    const kind = args.kind ?? "transcription";

    // Enqueue is idempotent. Two clicks on "Transcribe" must not produce two workers racing to
    // write the same transcript.
    const existing = await ctx.db
      .query("mediaJobs")
      .withIndex("byMediaId", (q: any) => q.eq("mediaId", args.mediaId))
      .collect();
    const active = existing.find((job: any) => job.userExternalId === args.userId
      && job.kind === kind
      && !mediaJobTerminalStages.has(job.stage));
    if (active) return mediaJobForGateway(active);

    const id = await ctx.db.insert("mediaJobs", {
      userExternalId: args.userId,
      mediaId: args.mediaId,
      kind,
      stage: "queued",
      // Where the capture came from, and where a finished transcript would be sent. Recorded at
      // enqueue because the worker runs long after the request that created the job is gone.
      deviceId: args.deviceId ?? null,
      environmentId: args.environmentId ?? null,
      threadId: args.threadId ?? null,
      autoSend: false,
      dispatchStatus: null,
      dispatchError: null,
      commandId: null,
      provider: args.provider ?? null,
      model: args.model ?? null,
      language: args.language ?? null,
      rawTranscript: null,
      normalizedTranscript: null,
      userEditedTranscript: null,
      attempts: 0,
      maxAttempts: normalizeAttemptLimit(args.maxAttempts),
      reviewRequired: args.reviewRequired === true,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      failureKind: null,
      // Why a terminal failure was terminal, and the bookkeeping for the owner-driven retry path.
      failureCause: null,
      requeueCount: 0,
      requeuedAt: null,
      requeuedBy: null,
      timings: { queuedAt: nowIso() },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const job = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "media_job.queued",
      targetId: id,
      metadata: {
        mediaId: args.mediaId,
        kind,
        provider: args.provider ?? null,
        maxAttempts: normalizeAttemptLimit(args.maxAttempts),
        deviceId: args.deviceId ?? null,
      },
    });
    return mediaJobForGateway(job);
  },
});

export const getMediaJobForUser = gatewayQuery({
  args: { userId: v.string(), jobId: v.id("mediaJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.userExternalId !== args.userId) return null;
    return mediaJobForGateway(job);
  },
});

export const listMediaJobs = gatewayQuery({
  args: {
    userId: v.string(),
    mediaId: v.optional(v.union(v.id("mediaUploads"), v.null())),
    stage: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const jobs = await ctx.db
      .query("mediaJobs")
      .withIndex("byUserExternalId", (q: any) => q.eq("userExternalId", args.userId))
      .collect();
    return jobs
      .filter((job: any) => (!args.mediaId || job.mediaId === args.mediaId)
        && (!args.stage || job.stage === args.stage))
      .sort((left: any, right: any) => left.createdAt.localeCompare(right.createdAt))
      .map(mediaJobForGateway);
  },
});

/**
 * Takes a lease on runnable jobs, across every user — the worker is not user-scoped.
 *
 * The lease is what makes a crashed worker survivable: it holds the job for `leaseMs`, and once
 * that expires any worker may pick it up again. Resumption reads the stage back off the evidence
 * already stored, so nothing is redone. `review_required` waits on a person, not a worker.
 */
export const claimMediaJobs = gatewayMutation({
  args: {
    owner: v.optional(v.union(v.string(), v.null())),
    leaseMs: v.optional(v.number()),
    limit: v.optional(v.number()),
    now: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const leaseMs = args.leaseMs ?? 60_000;
    const limit = args.limit ?? 4;
    const now = args.now ?? nowIso();
    const nowMs = Date.parse(now);

    const runnable: any[] = [];
    for (const stage of mediaJobStages) {
      if (mediaJobTerminalStages.has(stage) || stage === "review_required") continue;
      const rows = await ctx.db
        .query("mediaJobs")
        .withIndex("byStage", (q: any) => q.eq("stage", stage))
        .collect();
      runnable.push(...rows);
    }
    runnable.sort((left: any, right: any) => left.createdAt.localeCompare(right.createdAt));

    const claimed: any[] = [];
    for (const job of runnable) {
      if (claimed.length >= limit) break;
      const leaseExpiresAtMs = Date.parse(job.leaseExpiresAt ?? "");
      if (Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs > nowMs) continue;

      if (job.attempts >= job.maxAttempts) {
        // The budget is spent. Failing here rather than handing the job out again keeps an
        // exhausted job from being rediscovered on every single tick.
        await ctx.db.patch(job._id, {
          stage: "failed",
          failureKind: "terminal",
          // The cause of the last attempt is the cause of the abandonment; re-labelling it here
          // would hide a configuration failure from the only retry path that could fix it.
          failureCause: job.failureCause ?? "unknown",
          lastError: job.lastError ?? `Media job abandoned after ${job.attempts} attempts.`,
          leaseOwner: null,
          leaseExpiresAt: null,
          timings: { ...(job.timings ?? {}), failedAt: nowIso() },
          updatedAt: nowIso(),
        });
        continue;
      }

      await ctx.db.patch(job._id, {
        attempts: job.attempts + 1,
        leaseOwner: args.owner ?? null,
        leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
        stage: resumeStageFor(job),
        timings: { ...(job.timings ?? {}), startedAt: job.timings?.startedAt ?? nowIso() },
        updatedAt: nowIso(),
      });
      claimed.push(mediaJobForGateway(await ctx.db.get(job._id)));
    }
    return claimed;
  },
});

export const updateMediaJob = gatewayMutation({
  args: {
    jobId: v.id("mediaJobs"),
    userId: v.optional(v.union(v.string(), v.null())),
    stage: v.optional(v.string()),
    rawTranscript: v.optional(v.union(v.string(), v.null())),
    normalizedTranscript: v.optional(v.union(v.string(), v.null())),
    userEditedTranscript: v.optional(v.union(v.string(), v.null())),
    provider: v.optional(v.union(v.string(), v.null())),
    model: v.optional(v.union(v.string(), v.null())),
    language: v.optional(v.union(v.string(), v.null())),
    lastError: v.optional(v.union(v.string(), v.null())),
    failureKind: v.optional(v.union(v.string(), v.null())),
    failureCause: v.optional(v.union(v.string(), v.null())),
    autoSend: v.optional(v.boolean()),
    dispatchStatus: v.optional(v.union(v.string(), v.null())),
    dispatchError: v.optional(v.union(v.string(), v.null())),
    commandId: v.optional(v.union(v.id("commands"), v.null())),
    timings: v.optional(v.any()),
    releaseLease: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    if (args.userId !== undefined && args.userId !== null && job.userExternalId !== args.userId) return null;

    const patch: any = { updatedAt: nowIso() };
    // rawTranscript and normalizedTranscript are versions, not a field to overwrite: once the ASR
    // output is recorded it is the immutable record of what the provider actually heard. Only the
    // user-edited version stays writable.
    if (args.rawTranscript !== undefined && (job.rawTranscript ?? null) === null) {
      patch.rawTranscript = normalizeRawTranscript(args.rawTranscript);
    }
    if (args.normalizedTranscript !== undefined && (job.normalizedTranscript ?? null) === null) {
      patch.normalizedTranscript = normalizeTranscript(args.normalizedTranscript) ?? null;
    }
    if (args.userEditedTranscript !== undefined) {
      patch.userEditedTranscript = normalizeTranscript(args.userEditedTranscript) ?? null;
    }
    for (const key of ["provider", "model", "language", "dispatchStatus", "dispatchError", "commandId"]) {
      if ((args as any)[key] !== undefined) patch[key] = (args as any)[key] ?? null;
    }
    if (args.autoSend !== undefined) patch.autoSend = args.autoSend === true;
    if (args.stage !== undefined && mediaJobStages.includes(args.stage)) patch.stage = args.stage;
    if (args.lastError !== undefined) patch.lastError = args.lastError ?? null;
    if (args.failureKind !== undefined) {
      patch.failureKind = ["retryable", "terminal"].includes(args.failureKind as string)
        ? args.failureKind
        : null;
    }
    if (args.failureCause !== undefined) {
      patch.failureCause = mediaJobFailureCauses.includes(args.failureCause as string)
        ? args.failureCause
        : null;
    }
    if (args.timings !== undefined) patch.timings = { ...(job.timings ?? {}), ...(args.timings ?? {}) };
    if (args.releaseLease === true) {
      patch.leaseOwner = null;
      patch.leaseExpiresAt = null;
    }
    await ctx.db.patch(job._id, patch);
    return mediaJobForGateway(await ctx.db.get(job._id));
  },
});

/**
 * Mirrors requeueMediaJob() in src/store.mjs.
 *
 * Only a `failed` job whose recorded cause is `configuration`, only at an owner's explicit request,
 * with the attempt budget reset because the previous attempts were spent on a fault that no longer
 * exists — and always with `reviewRequired` forced on, which is not a parameter. A transcript is
 * dispatched to a coding agent as an instruction, and a capture recorded before an incident was
 * fixed must not send itself hours later on the strength of an auto-send grant that meant "send
 * what I say as I say it".
 */
export const requeueMediaJob = gatewayMutation({
  args: {
    userId: v.string(),
    jobId: v.id("mediaJobs"),
    actorId: v.optional(v.union(v.string(), v.null())),
    actorType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.userExternalId !== args.userId) return null;
    if (job.stage !== "failed" || job.failureCause !== "configuration") return null;

    const previousError = job.lastError ?? null;
    const requeueCount = (job.requeueCount ?? 0) + 1;
    await ctx.db.patch(job._id, {
      stage: "queued",
      attempts: 0,
      lastError: null,
      failureKind: null,
      failureCause: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      autoSend: false,
      dispatchStatus: null,
      dispatchError: null,
      commandId: null,
      reviewRequired: true,
      requeueCount,
      requeuedAt: nowIso(),
      requeuedBy: args.actorId ?? args.userId,
      timings: { ...(job.timings ?? {}), requeuedAt: nowIso() },
      updatedAt: nowIso(),
    });
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: args.actorType ?? "user",
      ...(args.actorId ? { actorId: args.actorId } : {}),
      action: "media_job.requeued",
      targetId: job._id,
      metadata: {
        mediaId: job.mediaId,
        deviceId: job.deviceId ?? null,
        previousError,
        requeueCount,
        holdForReview: true,
      },
    });
    return mediaJobForGateway(await ctx.db.get(job._id));
  },
});

export const createAction = gatewayMutation({
  args: {
    userId: v.string(),
    type: v.string(),
    label: v.string(),
    payload: v.any(),
    targetMode: v.string(),
    environmentId: v.union(v.id("environments"), v.null()),
    threadId: v.union(v.string(), v.null()),
    steps: v.array(v.object({ actionId: v.id("actions"), continueOnFailure: v.boolean() })),
    disabled: v.optional(v.boolean()),
    disabledReason: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const timestamp = nowIso();
    const id = await ctx.db.insert("actions", {
      userExternalId: args.userId,
      type: args.type,
      label: args.label,
      payload: args.payload,
      targetMode: args.targetMode,
      ...(args.environmentId ? { environmentId: args.environmentId } : {}),
      ...(args.threadId ? { threadId: args.threadId } : {}),
      steps: args.steps,
      disabled: args.disabled === true,
      disabledReason: args.disabled === true ? (args.disabledReason ?? null) : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const action = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "action.created",
      targetId: id,
      metadata: { label: args.label, type: args.type, stepCount: args.steps.length },
    });
    return publicAction(action);
  },
});

export const getActionForUser = gatewayQuery({
  args: { userId: v.string(), actionId: v.id("actions") },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    return action?.userExternalId === args.userId ? publicAction(action) : null;
  },
});

export const listActions = gatewayQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const actions = await ctx.db
      .query("actions")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return actions.map(publicAction);
  },
});

export const updateAction = gatewayMutation({
  args: {
    userId: v.string(),
    actionId: v.id("actions"),
    type: v.optional(v.string()),
    label: v.optional(v.string()),
    payload: v.optional(v.any()),
    targetMode: v.optional(v.string()),
    environmentId: v.optional(v.union(v.id("environments"), v.null())),
    threadId: v.optional(v.union(v.string(), v.null())),
    steps: v.optional(v.array(v.object({ actionId: v.id("actions"), continueOnFailure: v.boolean() }))),
    disabled: v.optional(v.boolean()),
    disabledReason: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action || action.userExternalId !== args.userId) return null;
    const patch: any = { updatedAt: nowIso() };
    for (const key of ["type", "label", "payload", "targetMode", "steps", "disabled", "disabledReason"]) {
      if ((args as any)[key] !== undefined) patch[key] = (args as any)[key];
    }
    if (args.environmentId !== undefined) patch.environmentId = args.environmentId ?? undefined;
    if (args.threadId !== undefined) patch.threadId = args.threadId ?? undefined;
    await ctx.db.patch(action._id, patch);
    const updated = await ctx.db.get(action._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "action.updated",
      targetId: action._id,
      metadata: { label: updated?.label, type: updated?.type, stepCount: updated?.steps?.length ?? 0 },
    });
    return publicAction(updated);
  },
});

export const deleteAction = gatewayMutation({
  args: { userId: v.string(), actionId: v.id("actions") },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action || action.userExternalId !== args.userId) return null;
    const layouts = await ctx.db
      .query("deviceControls")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    const unassignedDeviceIds: string[] = [];
    for (const layout of layouts) {
      const items = (layout.items ?? []).filter((item: any) => String(item.actionId ?? "") !== String(action._id));
      if (items.length === (layout.items ?? []).length) continue;
      await ctx.db.patch(layout._id, { items, revision: layout.revision + 1, updatedAt: nowIso() });
      unassignedDeviceIds.push(String(layout.deviceId));
    }
    await ctx.db.delete(action._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "action.deleted",
      targetId: action._id,
      metadata: { label: action.label, type: action.type, unassignedDeviceIds },
    });
    return { action: publicAction(action), unassignedDeviceIds };
  },
});

export const recordActionRun = gatewayMutation({
  args: {
    userId: v.string(),
    actionId: v.string(),
    actorType: v.string(),
    actorId: v.optional(v.string()),
    status: v.string(),
    intentType: v.optional(v.union(v.string(), v.null())),
    commandIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: args.actorType,
      ...(args.actorId ? { actorId: args.actorId } : {}),
      action: `action.run_${args.status}`,
      targetId: args.actionId,
      metadata: { intentType: args.intentType ?? null, commandIds: args.commandIds ?? [] },
    });
    return true;
  },
});

export const createMacroRun = gatewayMutation({
  args: {
    userId: v.string(), actionId: v.id("actions"), approvalCommandId: v.id("commands"),
    nextStepIndex: v.number(), runtime: v.any(), actor: v.any(), policyContext: v.any(),
    baseUrl: v.optional(v.union(v.string(), v.null())), executions: v.any(),
  },
  handler: async (ctx, args) => {
    const timestamp = nowIso();
    const id = await ctx.db.insert("macroRuns", {
      userExternalId: args.userId,
      actionId: args.actionId,
      approvalCommandId: args.approvalCommandId,
      nextStepIndex: args.nextStepIndex,
      runtime: args.runtime,
      actor: args.actor,
      policyContext: args.policyContext,
      baseUrl: args.baseUrl ?? null,
      executions: args.executions,
      status: "waiting_approval",
      resumeAttempts: 0,
      resumeClaimedAt: null,
      result: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const run = await ctx.db.get(id);
    return run ? { ...run, id: run._id, userId: run.userExternalId } : null;
  },
});

export const getMacroRunForApproval = gatewayQuery({
  args: { userId: v.string(), commandId: v.id("commands") },
  handler: async (ctx, args) => {
    const run = await ctx.db.query("macroRuns")
      .withIndex("byApprovalCommandId", (q) => q.eq("approvalCommandId", args.commandId))
      .first();
    return run?.userExternalId === args.userId ? { ...run, id: run._id, userId: run.userExternalId } : null;
  },
});

export const claimMacroRunForResume = gatewayMutation({
  args: { userId: v.string(), runId: v.id("macroRuns"), leaseMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.userExternalId !== args.userId) return null;
    const claimedAt = Date.parse(run.resumeClaimedAt ?? "");
    if (run.status === "resuming" && Number.isFinite(claimedAt)
      && Date.now() - claimedAt < (args.leaseMs ?? 30_000)) return null;
    if (!["waiting_approval", "resuming"].includes(run.status)) return null;
    const timestamp = nowIso();
    await ctx.db.patch(run._id, {
      status: "resuming",
      resumeAttempts: run.resumeAttempts + 1,
      resumeClaimedAt: timestamp,
      updatedAt: timestamp,
    });
    const updated = await ctx.db.get(run._id);
    return updated ? { ...updated, id: updated._id, userId: updated.userExternalId } : null;
  },
});

export const updateMacroRun = gatewayMutation({
  args: {
    userId: v.string(), runId: v.id("macroRuns"), approvalCommandId: v.optional(v.id("commands")),
    nextStepIndex: v.optional(v.number()), status: v.optional(v.string()), executions: v.optional(v.any()),
    result: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.userExternalId !== args.userId) return null;
    const patch: any = { updatedAt: nowIso() };
    for (const key of ["approvalCommandId", "nextStepIndex", "status", "executions", "result"]) {
      if ((args as any)[key] !== undefined) patch[key] = (args as any)[key];
    }
    if (args.status === "waiting_approval") patch.resumeClaimedAt = null;
    await ctx.db.patch(run._id, patch);
    const updated = await ctx.db.get(run._id);
    return updated ? { ...updated, id: updated._id, userId: updated.userExternalId } : null;
  },
});

export const getDeviceControls = gatewayQuery({
  args: { userId: v.string(), deviceId: v.id("devices") },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device) return null;
    const controls = await ctx.db
      .query("deviceControls")
      .withIndex("byDeviceId", (q) => q.eq("deviceId", args.deviceId))
      .first();
    return publicDeviceControls(controls ?? defaultDeviceControls(device));
  },
});

export const updateDeviceControls = gatewayMutation({
  args: { userId: v.string(), deviceId: v.id("devices"), items: v.any() },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    const existing = await ctx.db
      .query("deviceControls")
      .withIndex("byDeviceId", (q) => q.eq("deviceId", args.deviceId))
      .first();
    const revision = (existing?.revision ?? 1) + 1;
    const timestamp = nowIso();
    const patch = { items: args.items, revision, updatedAt: timestamp };
    let controls;
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      controls = await ctx.db.get(existing._id);
    } else {
      const id = await ctx.db.insert("deviceControls", {
        userExternalId: args.userId,
        deviceId: args.deviceId,
        ...patch,
        createdAt: timestamp,
      });
      controls = await ctx.db.get(id);
    }
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device.controls_updated",
      targetId: args.deviceId,
      metadata: { revision, itemCount: args.items.length },
    });
    return publicDeviceControls(controls);
  },
});

export const acknowledgeDeviceControls = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
    revision: v.number(),
    status: v.optional(v.string()),
    error: v.optional(v.union(v.string(), v.null())),
    appliedCount: v.optional(v.union(v.number(), v.null())),
    expectedCount: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    const existing = await ctx.db
      .query("deviceControls")
      .withIndex("byDeviceId", (q) => q.eq("deviceId", args.deviceId))
      .first();
    const current = existing ?? defaultDeviceControls(device);
    if (!existing) return { controls: publicDeviceControls(current), reason: "no_explicit_layout" };
    let reason: string | null = null;
    if (args.revision > current.revision) reason = "future_revision";
    else if (args.revision < current.revision) reason = "stale_revision";
    else if (args.appliedCount !== null && args.appliedCount !== undefined
      && args.expectedCount !== null && args.expectedCount !== undefined
      && args.appliedCount !== args.expectedCount) reason = "count_mismatch";
    const timestamp = nowIso();
    const patch = reason ? {
      lastAckStatus: "rejected",
      lastAckError: reason === "count_mismatch"
        ? `Device applied ${args.appliedCount} controls; gateway resolved ${args.expectedCount}.`
        : `Device acknowledged revision ${args.revision}; current revision is ${current.revision}.`,
    } : {
      appliedRevision: Math.max(existing.appliedRevision ?? 0, args.revision),
      appliedAt: timestamp,
      lastAckStatus: args.status ?? "applied",
      lastAckError: args.error ?? null,
    };
    let controls;
    await ctx.db.patch(existing._id, patch);
    controls = await ctx.db.get(existing._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "device",
      actorId: args.deviceId,
      action: "device.controls_acknowledged",
      targetId: args.deviceId,
      metadata: {
        revision: args.revision,
        status: reason ? "rejected" : args.status ?? "applied",
        error: reason ?? args.error ?? null,
        appliedCount: args.appliedCount ?? null,
        expectedCount: args.expectedCount ?? null,
      },
    });
    return { controls: publicDeviceControls(controls), reason };
  },
});

export const getDeviceFirmwarePolicy = gatewayQuery({
  args: { userId: v.string(), deviceId: v.id("devices") },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    return device ? normalizeFirmwarePolicy({}, device.firmwarePolicy) : null;
  },
});

export const updateDeviceFirmwarePolicy = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.id("devices"),
    policy: v.any(),
    actorType: v.optional(v.string()),
    actorId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const device = await getDeviceForOwner(ctx, args.userId, args.deviceId);
    if (!device || device.revokedAt) return null;
    const firmwarePolicy = normalizeFirmwarePolicy(args.policy, device.firmwarePolicy);
    await ctx.db.patch(device._id, { firmwarePolicy, updatedAt: nowIso() });
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: args.actorType ?? "user",
      ...(args.actorId ? { actorId: args.actorId } : {}),
      action: args.actorType === "device" ? "device.firmware_reported" : "device.firmware_policy_updated",
      targetId: args.deviceId,
      metadata: firmwarePolicy,
    });
    return firmwarePolicy;
  },
});

export const createMacro = gatewayMutation({
  args: {
    userId: v.string(),
    label: v.string(),
    environmentId: v.union(v.id("environments"), v.null()),
    threadId: v.union(v.string(), v.null()),
    intent: v.any(),
    disabled: v.optional(v.boolean()),
    disabledReason: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("macros", {
      userExternalId: args.userId,
      label: args.label,
      ...(args.environmentId ? { environmentId: args.environmentId } : {}),
      ...(args.threadId ? { threadId: args.threadId } : {}),
      intent: args.intent,
      disabled: args.disabled === true,
      disabledReason: args.disabled === true ? (args.disabledReason ?? null) : null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const macro = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "macro.created",
      targetId: id,
      metadata: {
        label: args.label,
        intentType: args.intent?.type,
        environmentId: args.environmentId,
      },
    });
    return publicMacro(macro);
  },
});

export const getMacroForUser = gatewayQuery({
  args: {
    userId: v.string(),
    macroId: v.id("macros"),
  },
  handler: async (ctx, args) => {
    const macro = await ctx.db.get(args.macroId);
    if (!macro || macro.userExternalId !== args.userId) return null;
    return macroForGateway(macro);
  },
});

export const listMacros = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const macros = await ctx.db
      .query("macros")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return macros.map(publicMacro);
  },
});

export const deleteMacro = gatewayMutation({
  args: {
    userId: v.string(),
    macroId: v.id("macros"),
  },
  handler: async (ctx, args) => {
    const macro = await ctx.db.get(args.macroId);
    if (!macro || macro.userExternalId !== args.userId) return null;
    await ctx.db.delete(macro._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "macro.deleted",
      targetId: macro._id,
      metadata: {
        label: macro.label,
        intentType: macro.intent?.type,
      },
    });
    return publicMacro(macro);
  },
});

// User-defined device profiles. Built-in profiles live in src/profiles.mjs and are never stored.
// Capability *values* are validated on the Node side against DEVICE_CAPABILITIES — only shape,
// type, and non-emptiness are enforced here so the two never drift.
export const createDeviceProfile = gatewayMutation({
  args: {
    userId: v.string(),
    profileId: v.string(),
    label: v.string(),
    description: v.string(),
    capabilities: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const profileId = requireProfileSlug(args.profileId);
    const label = requireProfileLabel(args.label);
    const description = normalizeProfileDescription(args.description);
    const capabilities = normalizeProfileCapabilities(args.capabilities);
    // Conflict convention matches the rest of this file (see claimDevice): null, not a throw.
    // create has exactly one null path, so null here always means "profileId already taken".
    const existing = await findDeviceProfile(ctx, args.userId, profileId);
    if (existing) return null;
    const id = await ctx.db.insert("deviceProfiles", {
      userExternalId: args.userId,
      profileId,
      label,
      description,
      capabilities,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const profile = await ctx.db.get(id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device_profile.created",
      targetId: id,
      metadata: { profileId, label, capabilities },
    });
    return publicDeviceProfile(profile);
  },
});

// NOTE: named *Definition because `updateDeviceProfile` above is already taken — it assigns a
// profile to a device. This one edits a stored custom profile record.
export const updateDeviceProfileDefinition = gatewayMutation({
  args: {
    userId: v.string(),
    profileId: v.string(),
    label: v.optional(v.string()),
    description: v.optional(v.string()),
    capabilities: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const profileId = requireProfileSlug(args.profileId);
    const profile = await findDeviceProfile(ctx, args.userId, profileId);
    if (!profile || profile.userExternalId !== args.userId) return null;
    const patch: Record<string, unknown> = { updatedAt: nowIso() };
    if (args.label !== undefined) patch.label = requireProfileLabel(args.label);
    if (args.description !== undefined) patch.description = normalizeProfileDescription(args.description);
    if (args.capabilities !== undefined) patch.capabilities = normalizeProfileCapabilities(args.capabilities);
    await ctx.db.patch(profile._id, patch);
    const updated = await ctx.db.get(profile._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device_profile.updated",
      targetId: profile._id,
      metadata: {
        profileId,
        label: updated?.label,
        previousCapabilities: profile.capabilities,
        capabilities: updated?.capabilities,
      },
    });
    return publicDeviceProfile(updated);
  },
});

export const listDeviceProfiles = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const profiles = await ctx.db
      .query("deviceProfiles")
      .withIndex("byUserExternalIdAndProfileId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return profiles.map(publicDeviceProfile);
  },
});

export const deleteDeviceProfile = gatewayMutation({
  args: {
    userId: v.string(),
    profileId: v.string(),
  },
  handler: async (ctx, args) => {
    const profileId = requireProfileSlug(args.profileId);
    const profile = await findDeviceProfile(ctx, args.userId, profileId);
    if (!profile || profile.userExternalId !== args.userId) return null;
    await ctx.db.delete(profile._id);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: "user",
      action: "device_profile.deleted",
      targetId: profile._id,
      metadata: {
        profileId,
        label: profile.label,
        capabilities: profile.capabilities,
      },
    });
    return publicDeviceProfile(profile);
  },
});

export const createCommand = gatewayMutation({
  args: {
    userId: v.string(),
    deviceId: v.union(v.id("devices"), v.null()),
    environmentId: v.id("environments"),
    threadId: v.union(v.string(), v.null()),
    intent: v.any(),
    normalized: v.any(),
    status: v.string(),
    risk: v.string(),
    result: v.any(),
    metrics: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("commands", {
      userExternalId: args.userId,
      ...(args.deviceId ? { deviceId: args.deviceId } : {}),
      environmentId: args.environmentId,
      ...(args.threadId ? { threadId: args.threadId } : {}),
      intent: args.intent,
      normalized: args.normalized,
      status: args.status,
      risk: args.risk,
      result: args.result,
      metrics: normalizeCommandMetrics(args.metrics),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const command = await ctx.db.get(id);
    await createCommandEvent(ctx, {
      userExternalId: args.userId,
      commandId: id,
      deviceId: args.deviceId ?? undefined,
      actorType: args.deviceId ? "device" : "user",
      actorId: args.deviceId ?? undefined,
      status: args.status,
      risk: args.risk,
      result: args.result,
      metrics: normalizeCommandMetrics(args.metrics),
    });
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: args.deviceId ? "device" : "user",
      actorId: args.deviceId ?? undefined,
      action: `command.${args.status}`,
      targetId: id,
      metadata: { intentType: args.intent?.type, risk: args.risk },
    });
    return publicCommand(command);
  },
});

export const claimCommandRequest = gatewayMutation({
  args: {
    userId: v.string(),
    actorType: v.string(),
    actorId: v.string(),
    operation: v.string(),
    clientRequestId: v.string(),
    requestHash: v.string(),
  },
  handler: async (ctx, args) => {
    const nowMs = Date.now();
    const exact = await ctx.db
      .query("commandRequests")
      .withIndex("byOwnerOperationRequest", (q: any) => q
        .eq("userExternalId", args.userId)
        .eq("actorType", args.actorType)
        .eq("actorId", args.actorId)
        .eq("operation", args.operation)
        .eq("clientRequestId", args.clientRequestId))
      .unique();
    if (exact && Date.parse(exact.expiresAt) > nowMs) {
      return {
        claimed: false,
        conflict: exact.requestHash !== args.requestHash,
        capacity: false,
        request: publicCommandRequest(exact),
      };
    }
    if (exact) await ctx.db.delete(exact._id);

    // The exact-index fast path above keeps normal retries O(1). Only a genuinely new claim pays
    // the bounded owner scan needed for TTL cleanup and terminal oldest-first eviction.
    const owned = await ctx.db
      .query("commandRequests")
      .withIndex("byOwnerCreatedAt", (q: any) => q
        .eq("userExternalId", args.userId)
        .eq("actorType", args.actorType)
        .eq("actorId", args.actorId))
      .collect();
    const live: any[] = [];
    for (const request of owned) {
      if (Date.parse(request.expiresAt) <= nowMs) await ctx.db.delete(request._id);
      else live.push(request);
    }

    live.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    while (live.length >= COMMAND_REQUEST_MAX_PER_OWNER) {
      const index = live.findIndex((request) => request.status !== "processing");
      if (index < 0) return { claimed: false, conflict: false, capacity: true, request: null };
      const [evicted] = live.splice(index, 1);
      await ctx.db.delete(evicted._id);
    }

    const now = new Date(nowMs).toISOString();
    const id = await ctx.db.insert("commandRequests", {
      userExternalId: args.userId,
      actorType: args.actorType,
      actorId: args.actorId,
      operation: args.operation,
      clientRequestId: args.clientRequestId,
      requestHash: args.requestHash,
      status: "processing",
      commandId: null,
      httpStatus: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(nowMs + COMMAND_REQUEST_TTL_MS).toISOString(),
    });
    return {
      claimed: true,
      conflict: false,
      capacity: false,
      request: publicCommandRequest(await ctx.db.get(id)),
    };
  },
});

export const settleCommandRequest = gatewayMutation({
  args: {
    userId: v.string(),
    actorType: v.string(),
    actorId: v.string(),
    operation: v.string(),
    clientRequestId: v.string(),
    requestHash: v.string(),
    status: v.string(),
    commandId: v.union(v.id("commands"), v.null()),
    httpStatus: v.number(),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("commandRequests")
      .withIndex("byOwnerOperationRequest", (q: any) => q
        .eq("userExternalId", args.userId)
        .eq("actorType", args.actorType)
        .eq("actorId", args.actorId)
        .eq("operation", args.operation)
        .eq("clientRequestId", args.clientRequestId))
      .unique();
    if (!request || request.requestHash !== args.requestHash) return null;
    if (request.status !== "processing") return publicCommandRequest(request);
    const status = [
      "approval_required", "blocked", "dispatched", "completed", "failed", "rejected", "cancelled",
    ].includes(args.status) ? args.status : "failed";
    await ctx.db.patch(request._id, {
      status,
      commandId: args.commandId,
      httpStatus: args.httpStatus,
      updatedAt: nowIso(),
    });
    return publicCommandRequest(await ctx.db.get(request._id));
  },
});

export const getCommandRequest = gatewayQuery({
  args: {
    userId: v.string(),
    actorType: v.string(),
    actorId: v.string(),
    operation: v.string(),
    clientRequestId: v.string(),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("commandRequests")
      .withIndex("byOwnerOperationRequest", (q: any) => q
        .eq("userExternalId", args.userId)
        .eq("actorType", args.actorType)
        .eq("actorId", args.actorId)
        .eq("operation", args.operation)
        .eq("clientRequestId", args.clientRequestId))
      .unique();
    if (!request || Date.parse(request.expiresAt) <= Date.now()) return null;
    return publicCommandRequest(request);
  },
});

export const getCommandForUser = gatewayQuery({
  args: {
    userId: v.string(),
    commandId: v.id("commands"),
  },
  handler: async (ctx, args) => {
    const command = await ctx.db.get(args.commandId);
    if (!command || command.userExternalId !== args.userId) return null;
    return publicCommand(command);
  },
});

export const claimCommandApproval = gatewayMutation({
  args: { userId: v.string(), commandId: v.id("commands"), leaseMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const command = await ctx.db.get(args.commandId);
    if (!command || command.userExternalId !== args.userId || command.status !== "approval_required") return null;
    const claimedAt = Date.parse(command.approvalClaimedAt ?? "");
    if (Number.isFinite(claimedAt) && Date.now() - claimedAt < (args.leaseMs ?? 30_000)) return null;
    await ctx.db.patch(command._id, { approvalClaimedAt: nowIso() });
    return publicCommand(await ctx.db.get(command._id));
  },
});

// Provider approval decisions. See the long note on claimProviderApprovalDecision() in
// src/store.mjs — this is the same check-and-set, and the two must not diverge: an owner whose
// deployment runs on Convex must get the same "already answered" answer as one running on memory.
export const claimProviderApprovalDecision = gatewayMutation({
  args: {
    userId: v.string(),
    environmentId: v.string(),
    threadId: v.string(),
    requestId: v.string(),
    decision: v.string(),
    actorType: v.optional(v.string()),
    actorId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const actorType = args.actorType ?? "user";
    const existing = await providerApprovalRow(ctx, args);
    if (existing && existing.status !== "failed") {
      return {
        claimed: false,
        conflict: existing.decision !== args.decision,
        decision: publicProviderApprovalDecision(existing),
      };
    }
    const patch = {
      userExternalId: args.userId,
      environmentId: args.environmentId,
      threadId: args.threadId,
      requestId: args.requestId,
      decision: args.decision,
      status: "claimed",
      actorType,
      actorId: args.actorId ?? null,
      commandId: null,
      error: null,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    const id = existing ? existing._id : await ctx.db.insert("providerApprovalDecisions", patch);
    if (existing) await ctx.db.patch(existing._id, patch);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType,
      actorId: args.actorId ?? undefined,
      action: "provider_approval.claimed",
      targetId: args.requestId,
      metadata: { environmentId: args.environmentId, threadId: args.threadId, decision: args.decision },
    });
    return {
      claimed: true,
      conflict: false,
      decision: publicProviderApprovalDecision(await ctx.db.get(id)),
    };
  },
});

export const updateProviderApprovalDecision = gatewayMutation({
  args: {
    userId: v.string(),
    environmentId: v.string(),
    threadId: v.string(),
    requestId: v.string(),
    status: v.optional(v.string()),
    commandId: v.optional(v.union(v.string(), v.null())),
    error: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const existing = await providerApprovalRow(ctx, args);
    if (!existing) return null;
    const patch: any = { updatedAt: nowIso() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.commandId !== undefined) patch.commandId = args.commandId;
    if (args.error !== undefined) patch.error = args.error;
    await ctx.db.patch(existing._id, patch);
    return publicProviderApprovalDecision(await ctx.db.get(existing._id));
  },
});

export const listProviderApprovalDecisions = gatewayQuery({
  args: {
    userId: v.string(),
    environmentId: v.optional(v.union(v.string(), v.null())),
    threadId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("providerApprovalDecisions")
      .withIndex("byUserExternalId", (q: any) => q.eq("userExternalId", args.userId))
      .collect();
    return rows
      .filter((row: any) =>
        (!args.environmentId || row.environmentId === args.environmentId)
        && (!args.threadId || row.threadId === args.threadId))
      .map(publicProviderApprovalDecision);
  },
});

// Provider user-input answers. See the long note on claimProviderUserInputAnswer() in
// src/store.mjs — this is the same check-and-set, and the same deliberate omission: the row holds
// a fingerprint of the answers, never the answers.
export const claimProviderUserInputAnswer = gatewayMutation({
  args: {
    userId: v.string(),
    environmentId: v.string(),
    threadId: v.string(),
    requestId: v.string(),
    answersHash: v.string(),
    actorType: v.optional(v.string()),
    actorId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const actorType = args.actorType ?? "user";
    const existing = await providerUserInputRow(ctx, args);
    if (existing && existing.status !== "failed") {
      return {
        claimed: false,
        conflict: existing.answersHash !== args.answersHash,
        answer: publicProviderUserInputAnswer(existing),
      };
    }
    const patch = {
      userExternalId: args.userId,
      environmentId: args.environmentId,
      threadId: args.threadId,
      requestId: args.requestId,
      answersHash: args.answersHash,
      status: "claimed",
      actorType,
      actorId: args.actorId ?? null,
      commandId: null,
      error: null,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    const id = existing ? existing._id : await ctx.db.insert("providerUserInputAnswers", patch);
    if (existing) await ctx.db.patch(existing._id, patch);
    await audit(ctx, {
      userExternalId: args.userId,
      actorType,
      actorId: args.actorId ?? undefined,
      action: "provider_user_input.claimed",
      targetId: args.requestId,
      metadata: {
        environmentId: args.environmentId,
        threadId: args.threadId,
        answersHash: args.answersHash,
      },
    });
    return {
      claimed: true,
      conflict: false,
      answer: publicProviderUserInputAnswer(await ctx.db.get(id)),
    };
  },
});

export const updateProviderUserInputAnswer = gatewayMutation({
  args: {
    userId: v.string(),
    environmentId: v.string(),
    threadId: v.string(),
    requestId: v.string(),
    status: v.optional(v.string()),
    commandId: v.optional(v.union(v.string(), v.null())),
    error: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const existing = await providerUserInputRow(ctx, args);
    if (!existing) return null;
    const patch: any = { updatedAt: nowIso() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.commandId !== undefined) patch.commandId = args.commandId;
    if (args.error !== undefined) patch.error = args.error;
    await ctx.db.patch(existing._id, patch);
    return publicProviderUserInputAnswer(await ctx.db.get(existing._id));
  },
});

export const listProviderUserInputAnswers = gatewayQuery({
  args: {
    userId: v.string(),
    environmentId: v.optional(v.union(v.string(), v.null())),
    threadId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("providerUserInputAnswers")
      .withIndex("byUserExternalId", (q: any) => q.eq("userExternalId", args.userId))
      .collect();
    return rows
      .filter((row: any) =>
        (!args.environmentId || row.environmentId === args.environmentId)
        && (!args.threadId || row.threadId === args.threadId))
      .map(publicProviderUserInputAnswer);
  },
});

export const createNotification = gatewayMutation({
  args: {
    userId: v.string(),
    dedupeKey: v.string(),
    kind: v.string(),
    severity: v.string(),
    title: v.string(),
    environmentId: v.optional(v.union(v.string(), v.null())),
    threadId: v.optional(v.union(v.string(), v.null())),
    commandId: v.optional(v.union(v.string(), v.null())),
    occurredAt: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    if (!(await findUser(ctx, args.userId))) return null;
    if (!notificationKinds.has(args.kind)) throw new Error("Unsupported notification kind.");
    if (!notificationSeverities.has(args.severity)) throw new Error("Unsupported notification severity.");
    const dedupeKey = normalizeNotificationText(args.dedupeKey, 128, "dedupeKey");
    await pruneNotifications(ctx, args.userId);
    const existing = await ctx.db
      .query("notifications")
      .withIndex("byUserDedupeKey", (q: any) =>
        q.eq("userExternalId", args.userId).eq("dedupeKey", dedupeKey))
      .unique();
    if (existing) return { created: false, notification: publicNotification(existing) };

    const latest = await ctx.db
      .query("notifications")
      .withIndex("byUserSequence", (q: any) => q.eq("userExternalId", args.userId))
      .order("desc")
      .first();
    const timestamp = nowIso();
    const id = await ctx.db.insert("notifications", {
      userExternalId: args.userId,
      sequence: (latest?.sequence ?? 0) + 1,
      dedupeKey,
      kind: args.kind,
      severity: args.severity,
      title: normalizeNotificationText(args.title, 120, "title"),
      environmentId: normalizeNullableNotificationText(args.environmentId, 160),
      threadId: normalizeNullableNotificationText(args.threadId, 240),
      commandId: normalizeNullableNotificationText(args.commandId, 160),
      createdAt: normalizeNotificationTimestamp(args.occurredAt, Date.now()),
      updatedAt: timestamp,
      readAt: null,
      dismissedAt: null,
    });
    await pruneNotifications(ctx, args.userId);
    return { created: true, notification: publicNotification(await ctx.db.get(id)) };
  },
});

export const listNotifications = gatewayQuery({
  args: {
    userId: v.string(),
    afterCursor: v.optional(v.union(v.string(), v.null())),
    beforeCursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    includeDismissed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const limit = Number.isSafeInteger(args.limit) ? Math.min(100, Math.max(1, args.limit!)) : 50;
    const after = parseNotificationCursor(args.afterCursor);
    const before = parseNotificationCursor(args.beforeCursor);
    if (after !== null && before !== null) throw new Error("Notification cursors are mutually exclusive.");
    const all = await ctx.db
      .query("notifications")
      .withIndex("byUserSequence", (q: any) => q.eq("userExternalId", args.userId))
      .collect();
    const rows = all.filter((row: any) =>
      (args.includeDismissed || !row.dismissedAt)
      && (after === null || row.sequence > after)
      && (before === null || row.sequence < before));
    rows.sort(after !== null
      ? (left: any, right: any) => left.sequence - right.sequence
      : (left: any, right: any) => right.sequence - left.sequence);
    const page = rows.slice(0, limit);
    return {
      notifications: page.map(publicNotification),
      nextCursor: before === null && page.length > 0
        ? String(Math.max(...page.map((row: any) => row.sequence)))
        : (args.afterCursor ?? null),
      oldestCursor: page.length > 0
        ? String(Math.min(...page.map((row: any) => row.sequence)))
        : (args.beforeCursor ?? null),
      hasMore: rows.length > page.length,
      hasMoreBefore: before !== null || after === null ? rows.length > page.length : false,
      hasMoreAfter: after !== null ? rows.length > page.length : false,
      unreadCount: all.filter((row: any) => !row.readAt && !row.dismissedAt).length,
    };
  },
});

export const markNotificationRead = gatewayMutation({
  args: { userId: v.string(), notificationId: v.id("notifications") },
  handler: async (ctx, args) => {
    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.userExternalId !== args.userId) return null;
    const duplicate = Boolean(notification.readAt);
    if (!duplicate) {
      const timestamp = nowIso();
      await ctx.db.patch(notification._id, { readAt: timestamp, updatedAt: timestamp });
    }
    return { notification: publicNotification(await ctx.db.get(notification._id)), duplicate };
  },
});

export const dismissNotification = gatewayMutation({
  args: { userId: v.string(), notificationId: v.id("notifications") },
  handler: async (ctx, args) => {
    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.userExternalId !== args.userId) return null;
    const duplicate = Boolean(notification.dismissedAt);
    if (!duplicate) {
      const timestamp = nowIso();
      await ctx.db.patch(notification._id, {
        dismissedAt: timestamp,
        readAt: notification.readAt ?? timestamp,
        updatedAt: timestamp,
      });
    }
    return { notification: publicNotification(await ctx.db.get(notification._id)), duplicate };
  },
});

export const dismissNotificationByDedupe = gatewayMutation({
  args: {
    userId: v.string(),
    dedupeKey: v.string(),
    resolvedAt: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const dedupeKey = normalizeNotificationText(args.dedupeKey, 128, "dedupeKey");
    const notification = await ctx.db
      .query("notifications")
      .withIndex("byUserDedupeKey", (q: any) =>
        q.eq("userExternalId", args.userId).eq("dedupeKey", dedupeKey))
      .unique();
    if (!notification) return null;
    const duplicate = Boolean(notification.dismissedAt);
    if (!duplicate) {
      const timestamp = normalizeNotificationTimestamp(args.resolvedAt, Date.now());
      await ctx.db.patch(notification._id, {
        dismissedAt: timestamp,
        readAt: notification.readAt ?? timestamp,
        updatedAt: timestamp,
      });
    }
    return { notification: publicNotification(await ctx.db.get(notification._id)), duplicate };
  },
});

export const markAllNotificationsRead = gatewayMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("notifications")
      .withIndex("byUserSequence", (q: any) => q.eq("userExternalId", args.userId))
      .collect();
    const updatedAt = nowIso();
    let count = 0;
    for (const row of rows) {
      if (row.readAt || row.dismissedAt) continue;
      await ctx.db.patch(row._id, { readAt: updatedAt, updatedAt });
      count += 1;
    }
    return { updatedAt, count };
  },
});

export const upsertPushSubscription = gatewayMutation({
  args: {
    userId: v.string(), endpoint: v.string(), endpointHash: v.string(), p256dh: v.string(),
    auth: v.string(), vapidKeyId: v.string(), userAgent: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    if (!(await findUser(ctx, args.userId))) return null;
    const previous = await ctx.db.query("pushSubscriptions")
      .withIndex("byUserEndpointHash", (q: any) => q.eq("userExternalId", args.userId).eq("endpointHash", args.endpointHash))
      .unique();
    const timestamp = nowIso();
    const values: any = {
      userExternalId: args.userId, endpoint: args.endpoint, endpointHash: args.endpointHash,
      p256dh: args.p256dh, auth: args.auth, vapidKeyId: args.vapidKeyId,
      updatedAt: timestamp, revokedAt: null, lastFailureCode: null,
    };
    if (previous) {
      await ctx.db.patch(previous._id, values);
      return { subscription: publicPushSubscription(await ctx.db.get(previous._id)), created: false };
    }
    const id = await ctx.db.insert("pushSubscriptions", { ...values, createdAt: timestamp, lastAcceptedAt: null });
    return { subscription: publicPushSubscription(await ctx.db.get(id)), created: true };
  },
});

export const listPushSubscriptions = gatewayQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => (await ctx.db.query("pushSubscriptions")
    .withIndex("byUser", (q: any) => q.eq("userExternalId", args.userId)).collect())
    .filter((row: any) => !row.revokedAt).map(publicPushSubscription),
});

export const revokePushSubscription = gatewayMutation({
  args: { userId: v.string(), subscriptionId: v.id("pushSubscriptions"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.subscriptionId);
    if (!row || row.userExternalId !== args.userId) return null;
    const duplicate = Boolean(row.revokedAt);
    if (!duplicate) {
      const timestamp = nowIso();
      await ctx.db.patch(row._id, { revokedAt: timestamp, updatedAt: timestamp, lastFailureCode: args.reason ?? "user_revoked" });
    }
    return { subscription: publicPushSubscription(await ctx.db.get(row._id)), duplicate };
  },
});

export const revokePushSubscriptionByEndpoint = gatewayMutation({
  args: { userId: v.string(), endpointHash: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("pushSubscriptions")
      .withIndex("byUserEndpointHash", (q: any) => q.eq("userExternalId", args.userId).eq("endpointHash", args.endpointHash))
      .unique();
    if (!row) return null;
    const duplicate = Boolean(row.revokedAt);
    if (!duplicate) {
      const timestamp = nowIso();
      await ctx.db.patch(row._id, { revokedAt: timestamp, updatedAt: timestamp, lastFailureCode: args.reason ?? "user_revoked" });
    }
    return { subscription: publicPushSubscription(await ctx.db.get(row._id)), duplicate };
  },
});

export const enqueuePushDeliveries = gatewayMutation({
  args: { userId: v.string(), notificationId: v.id("notifications") },
  handler: async (ctx, args) => {
    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.userExternalId !== args.userId) return [];
    const subscriptions = (await ctx.db.query("pushSubscriptions")
      .withIndex("byUser", (q: any) => q.eq("userExternalId", args.userId)).collect())
      .filter((row: any) => !row.revokedAt);
    const created: string[] = [];
    const timestamp = nowIso();
    for (const subscription of subscriptions) {
      const dedupeKey = `${subscription._id}:${notification._id}`;
      const existing = await ctx.db.query("pushDeliveries")
        .withIndex("byDedupeKey", (q: any) => q.eq("dedupeKey", dedupeKey)).unique();
      if (existing) continue;
      created.push(await ctx.db.insert("pushDeliveries", {
        userExternalId: args.userId, subscriptionId: subscription._id, notificationId: notification._id,
        dedupeKey, status: "queued", attempts: 0, nextAttemptAt: timestamp, leaseUntil: null,
        lastFailureCode: null, acceptedAt: null, createdAt: timestamp, updatedAt: timestamp,
      }));
    }
    return created;
  },
});

export const claimPushDeliveries = gatewayMutation({
  args: { limit: v.optional(v.number()), leaseMs: v.optional(v.number()), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const limit = Math.max(1, Math.min(args.limit ?? 10, 50));
    const all = await ctx.db.query("pushDeliveries").collect();
    const candidates = all.filter((row: any) => (row.status === "queued" || row.status === "retry")
      && Date.parse(row.nextAttemptAt) <= now && (!row.leaseUntil || Date.parse(row.leaseUntil) <= now))
      .sort((a: any, b: any) => a.nextAttemptAt.localeCompare(b.nextAttemptAt)).slice(0, limit);
    const claims: any[] = [];
    for (const delivery of candidates) {
      const subscription = await ctx.db.get(delivery.subscriptionId);
      const notification = await ctx.db.get(delivery.notificationId);
      if (!subscription || subscription.revokedAt || !notification || notification.dismissedAt) {
        await ctx.db.patch(delivery._id, { status: "cancelled", leaseUntil: null, updatedAt: nowIso() });
        continue;
      }
      const patch = { status: "sending", attempts: delivery.attempts + 1, leaseUntil: new Date(now + (args.leaseMs ?? 30_000)).toISOString(), updatedAt: nowIso() };
      await ctx.db.patch(delivery._id, patch);
      claims.push({
        delivery: { id: delivery._id, ...delivery, ...patch },
        subscription: { id: subscription._id, endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth }, vapidKeyId: subscription.vapidKeyId },
        notification: publicNotification(notification),
      });
    }
    return claims;
  },
});

export const settlePushDelivery = gatewayMutation({
  args: { deliveryId: v.id("pushDeliveries"), outcome: v.string(), failureCode: v.optional(v.union(v.string(), v.null())), retryAt: v.optional(v.union(v.number(), v.null())) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.deliveryId);
    if (!row || row.status !== "sending") return null;
    const timestamp = nowIso();
    let status = args.outcome === "accepted" ? "accepted" : args.outcome === "gone" ? "gone" : "failed";
    const patch: any = { status, leaseUntil: null, lastFailureCode: args.failureCode ?? null, updatedAt: timestamp };
    if (args.outcome === "accepted") patch.acceptedAt = timestamp;
    if (args.outcome === "retry" && row.attempts < 5) {
      status = "retry";
      patch.status = status;
      patch.nextAttemptAt = new Date(args.retryAt ?? Date.now() + Math.min(60_000, 1_000 * (2 ** row.attempts))).toISOString();
    }
    await ctx.db.patch(row._id, patch);
    const subscription = await ctx.db.get(row.subscriptionId);
    if (subscription) {
      await ctx.db.patch(subscription._id, {
        updatedAt: timestamp,
        lastFailureCode: args.outcome === "accepted" ? null : (args.failureCode ?? null),
        ...(args.outcome === "accepted" ? { lastAcceptedAt: timestamp } : {}),
        ...(args.outcome === "gone" ? { revokedAt: timestamp } : {}),
      });
    }
    return { id: row._id, ...row, ...patch };
  },
});

export const recordBackgroundLiveness = gatewayMutation({
  args: {
    scope: v.optional(v.string()),
    attemptedAt: v.optional(v.union(v.string(), v.null())),
    succeeded: v.optional(v.boolean()),
    failureCode: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const scope = normalizeNotificationText(args.scope ?? "scheduled-worker", 80, "scope");
    const timestamp = normalizeNotificationTimestamp(args.attemptedAt, Date.now());
    const previous = await ctx.db
      .query("backgroundLiveness")
      .withIndex("byScope", (q: any) => q.eq("scope", scope))
      .unique();
    const patch: any = {
      scope,
      lastAttemptAt: timestamp,
      ...(args.succeeded ? { lastSuccessAt: timestamp, failureCode: null } : {}),
      ...(args.failureCode
        ? {
            lastFailureAt: timestamp,
            failureCode: normalizeBackgroundFailureCode(args.failureCode),
          }
        : {}),
      updatedAt: nowIso(),
    };
    if (previous) {
      await ctx.db.patch(previous._id, patch);
      return publicBackgroundLiveness(await ctx.db.get(previous._id));
    }
    const id = await ctx.db.insert("backgroundLiveness", patch);
    return publicBackgroundLiveness(await ctx.db.get(id));
  },
});

export const getBackgroundLiveness = gatewayQuery({
  args: { scope: v.optional(v.string()) },
  handler: async (ctx, args) => publicBackgroundLiveness(await ctx.db
    .query("backgroundLiveness")
    .withIndex("byScope", (q: any) => q.eq("scope", args.scope ?? "scheduled-worker"))
    .unique()),
});

export const updateCommand = gatewayMutation({
  args: {
    userId: v.string(),
    commandId: v.id("commands"),
    status: v.optional(v.string()),
    normalized: v.optional(v.any()),
    result: v.optional(v.any()),
    risk: v.optional(v.string()),
    metrics: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const command = await ctx.db.get(args.commandId);
    if (!command || command.userExternalId !== args.userId) return null;
    const previousStatus = command.status;
    const patch: any = { updatedAt: nowIso() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.normalized !== undefined) patch.normalized = args.normalized;
    if (args.result !== undefined) patch.result = args.result;
    if (args.risk !== undefined) patch.risk = args.risk;
    if (args.metrics !== undefined) patch.metrics = normalizeCommandMetrics(args.metrics);
    await ctx.db.patch(command._id, patch);
    const updated = await ctx.db.get(command._id);
    await createCommandEvent(ctx, {
      userExternalId: args.userId,
      commandId: command._id,
      deviceId: command.deviceId ?? undefined,
      actorType: command.deviceId ? "device" : "user",
      actorId: command.deviceId ?? undefined,
      status: updated?.status ?? command.status,
      previousStatus,
      risk: updated?.risk ?? command.risk,
      result: updated?.result ?? null,
      metrics: updated?.metrics ?? null,
    });
    await audit(ctx, {
      userExternalId: args.userId,
      actorType: command.deviceId ? "device" : "user",
      actorId: command.deviceId ?? undefined,
      action: `command.${updated?.status}`,
      targetId: command._id,
      metadata: {
        intentType: command.intent?.type,
        risk: updated?.risk,
        previousStatus,
      },
    });
    return publicCommand(updated);
  },
});

export const listCommands = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const commands = await ctx.db
      .query("commands")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return commands.map(publicCommand);
  },
});

export const listCommandEvents = gatewayQuery({
  args: {
    userId: v.string(),
    commandId: v.id("commands"),
  },
  handler: async (ctx, args) => {
    const command = await ctx.db.get(args.commandId);
    if (!command || command.userExternalId !== args.userId) return [];
    const events = await ctx.db
      .query("commandEvents")
      .withIndex("byCommandId", (q) => q.eq("commandId", args.commandId))
      .collect();
    return events
      .filter((event) => event.userExternalId === args.userId)
      .map(publicCommandEvent);
  },
});

export const listAuditLogs = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const events = await ctx.db
      .query("auditLogs")
      .withIndex("byUserExternalId", (q) => q.eq("userExternalId", args.userId))
      .collect();
    return events.map(publicAuditLog);
  },
});

/**
 * Mirrors getDisplaySummary() in src/store.mjs — the fixed-size answer behind the display poll.
 *
 * Deliberately one query rather than a count/latest function per collection: the adapter turns each
 * store method into its own HTTP call, and this route is polled every five seconds by hardware that
 * was already timing out. One call, one constant-size response.
 *
 * Every read below is an index range over this user's rows — never a table scan — and the rows stay
 * inside the deployment: only the numbers cross to the gateway, which is the transfer that grew
 * without bound before. The Convex base API has no count aggregate, so `commands` and `auditLogs`
 * still read the user's own rows here to size them. A maintained counter would remove that read,
 * but it would have to be patched by every audit write on the account, which turns one document
 * into an OCC contention point for every mutation the account makes; the read is the cheaper
 * trade until this needs @convex-dev/aggregate.
 */
export const getDisplaySummary = gatewayQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const byUser = (table: string) =>
      ctx.db
        .query(table as any)
        .withIndex("byUserExternalId", (q: any) => q.eq("userExternalId", args.userId));

    const [devices, environments, media, macros, commands, auditLogs, latestCommand, latestAudit] =
      await Promise.all([
        byUser("devices").collect(),
        byUser("environments").collect(),
        byUser("mediaUploads").collect(),
        byUser("macros").collect(),
        byUser("commands").collect(),
        byUser("auditLogs").collect(),
        byUser("commands").order("desc").first(),
        byUser("auditLogs").order("desc").first(),
      ]);

    let onlineDevices = 0;
    for (const device of devices) {
      if (buildDevicePresence(device).online) onlineDevices += 1;
    }

    // listEnvironments() collapses duplicate baseUrls, so a raw row count would report a number
    // the environments list never shows.
    const environmentUrls = new Set<string>();
    for (const environment of environments) {
      if (!environment.archivedAt) environmentUrls.add(environment.baseUrl);
    }

    return {
      counts: {
        environments: environmentUrls.size,
        devices: devices.length,
        media: media.length,
        macros: macros.length,
        commands: commands.length,
        audit: auditLogs.length,
        onlineDevices,
        offlineDevices: Math.max(0, devices.length - onlineDevices),
      },
      latestCommand: latestCommand
        ? {
          id: latestCommand._id,
          status: latestCommand.status,
          intentType: latestCommand.intent?.type ?? null,
          createdAt: latestCommand.createdAt ?? null,
        }
        : null,
      latestAudit: latestAudit
        ? {
          id: latestAudit._id,
          action: latestAudit.action,
          createdAt: latestAudit.createdAt ?? null,
        }
        : null,
    };
  },
});

async function ensureUserRecord(ctx: any, userId: string, email?: string, name?: string) {
  const existing = await findUser(ctx, userId);
  if (existing) {
    const patch: Record<string, unknown> = {};
    if (!existing.privacy) patch.privacy = defaultPrivacySettings;
    if (!existing.onboarding) patch.onboarding = defaultOnboarding;
    if (email && existing.email !== email) patch.email = email;
    if (name && existing.name !== name) patch.name = name;
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = nowIso();
      await ctx.db.patch(existing._id, patch);
      return await ctx.db.get(existing._id);
    }
    return existing;
  }
  const id = await ctx.db.insert("users", {
    externalId: userId,
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    privacy: defaultPrivacySettings,
    onboarding: defaultOnboarding,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  await audit(ctx, {
    userExternalId: userId,
    actorType: "system",
    action: "user.created",
    targetId: userId,
    metadata: { email },
  });
  return await ctx.db.get(id);
}

async function findUser(ctx: any, userId: string) {
  return await ctx.db
    .query("users")
    .withIndex("byExternalId", (q: any) => q.eq("externalId", userId))
    .unique();
}

async function getDeviceForOwner(ctx: any, userId: string, deviceId: any) {
  const device = await ctx.db.get(deviceId);
  if (!device || device.userExternalId !== userId) return null;
  return device;
}

// Scoped by user in the index range itself, so one user's slug can never reach another's record.
async function findDeviceProfile(ctx: any, userId: string, profileId: string) {
  return await ctx.db
    .query("deviceProfiles")
    .withIndex("byUserExternalIdAndProfileId", (q: any) =>
      q.eq("userExternalId", userId).eq("profileId", profileId))
    .unique();
}

function requireProfileSlug(value: any) {
  const slug = normalizeNullableString(value);
  if (!slug) throw new Error("Device profile requires a non-empty profileId");
  if (slug.length > 64) throw new Error("Device profile profileId exceeds 64 characters");
  return slug;
}

function requireProfileLabel(value: any) {
  const label = normalizeNullableString(value);
  if (!label) throw new Error("Device profile requires a non-empty label");
  return label.slice(0, 120);
}

function normalizeProfileDescription(value: any) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("Device profile description must be a string");
  return value.trim().slice(0, 2000);
}

// Deliberately no capability whitelist: DEVICE_CAPABILITIES lives in src/profiles.mjs and is
// enforced there. Here we only guarantee a deduped array of non-empty strings.
function normalizeProfileCapabilities(value: any) {
  if (!Array.isArray(value)) throw new Error("Device profile capabilities must be an array");
  if (value.length > 32) throw new Error("Device profile lists too many capabilities");
  const capabilities: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error("Device profile capabilities must be strings");
    const capability = entry.trim();
    if (!capability) throw new Error("Device profile capabilities must be non-empty strings");
    if (!capabilities.includes(capability)) capabilities.push(capability);
  }
  return capabilities;
}

async function providerApprovalRow(ctx: any, args: any) {
  return await ctx.db
    .query("providerApprovalDecisions")
    .withIndex("byRequest", (q: any) =>
      q
        .eq("userExternalId", args.userId)
        .eq("environmentId", args.environmentId)
        .eq("threadId", args.threadId)
        .eq("requestId", args.requestId))
    .unique();
}

async function providerUserInputRow(ctx: any, args: any) {
  return await ctx.db
    .query("providerUserInputAnswers")
    .withIndex("byRequest", (q: any) =>
      q
        .eq("userExternalId", args.userId)
        .eq("environmentId", args.environmentId)
        .eq("threadId", args.threadId)
        .eq("requestId", args.requestId))
    .unique();
}

function publicProviderUserInputAnswer(row: any) {
  if (!row) return null;
  return {
    id: row._id,
    userId: row.userExternalId,
    environmentId: row.environmentId,
    threadId: row.threadId,
    requestId: row.requestId,
    answersHash: row.answersHash,
    status: row.status,
    actorType: row.actorType,
    actorId: row.actorId ?? null,
    commandId: row.commandId ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publicProviderApprovalDecision(row: any) {
  if (!row) return null;
  return {
    id: row._id,
    userId: row.userExternalId,
    environmentId: row.environmentId,
    threadId: row.threadId,
    requestId: row.requestId,
    decision: row.decision,
    status: row.status,
    actorType: row.actorType,
    actorId: row.actorId ?? null,
    commandId: row.commandId ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function audit(ctx: any, input: any) {
  await ctx.db.insert("auditLogs", {
    userExternalId: input.userExternalId,
    actorType: input.actorType,
    ...(input.actorId ? { actorId: String(input.actorId) } : {}),
    action: input.action,
    ...(input.targetId ? { targetId: String(input.targetId) } : {}),
    metadata: input.metadata ?? {},
    createdAt: nowIso(),
  });
}

function nowIso() {
  return new Date(Date.now()).toISOString();
}

function normalizeDeviceConfig(input: any = {}, existing: any = null) {
  const base = {
    ...defaultConfig,
    ...(existing ?? {}),
  };
  const next = { ...base };

  if (Object.hasOwn(input, "environmentId")) {
    next.environmentId = normalizeNullableString(input.environmentId) ?? undefined;
  }
  if (Object.hasOwn(input, "projectId")) {
    next.projectId = normalizeNullableString(input.projectId) ?? undefined;
  }
  if (Object.hasOwn(input, "threadId")) {
    next.threadId = normalizeNullableString(input.threadId) ?? undefined;
  }
  if (Object.hasOwn(input, "gatewayAccessMode") && ["local", "tailscale", "online"].includes(input.gatewayAccessMode)) {
    next.gatewayAccessMode = input.gatewayAccessMode;
  }
  if (Object.hasOwn(input, "gatewayUrl")) {
    next.gatewayUrl = normalizeNullableString(input.gatewayUrl)?.replace(/\/+$/u, "") ?? null;
  }
  if (Object.hasOwn(input, "defaultPrompt")) {
    const value = normalizeNullableString(input.defaultPrompt);
    next.defaultPrompt = value || defaultConfig.defaultPrompt;
  }
  if (Object.hasOwn(input, "shellCommand")) {
    const value = normalizeNullableString(input.shellCommand);
    next.shellCommand = value || defaultConfig.shellCommand;
  }
  if (Object.hasOwn(input, "menu")) {
    const allowed = new Set(["status", "prompt", "shell", "macro", "approve", "reject", "media", "stop", "thread", "reset"]);
    const menu = Array.isArray(input.menu)
      ? input.menu
        .map((item: any) => normalizeNullableString(item))
        .filter((item: string | null) => item && allowed.has(item))
      : [];
    // 8 matches kMaxMenuItems in the firmware. Anything beyond it is dropped here
    // silently, so this cap must not be tighter than what the hardware can render.
    next.menu = [...new Set(menu)].slice(0, 8);
    if (next.menu.length === 0) next.menu = defaultConfig.menu;
  }

  return next;
}

function normalizeDeviceStatus(input: any = {}, existing: any = null, heartbeatAt: string | null = nowIso()) {
  const base = {
    ...defaultStatus,
    ...(existing ?? {}),
  };
  const next = {
    ...base,
    lastHeartbeatAt: heartbeatAt,
  };

  if (Object.hasOwn(input, "firmwareVersion")) next.firmwareVersion = normalizeNullableString(input.firmwareVersion);
  if (Object.hasOwn(input, "hardwareModel")) next.hardwareModel = normalizeNullableString(input.hardwareModel);
  if (Object.hasOwn(input, "ipAddress")) next.ipAddress = normalizeNullableString(input.ipAddress);
  if (Object.hasOwn(input, "wifiRssi")) next.wifiRssi = normalizeOptionalNumber(input.wifiRssi);
  if (Object.hasOwn(input, "freeHeap")) next.freeHeap = normalizeOptionalNumber(input.freeHeap);
  if (Object.hasOwn(input, "uptimeMs")) next.uptimeMs = normalizeOptionalNumber(input.uptimeMs);
  if (Object.hasOwn(input, "batteryMv")) next.batteryMv = normalizeOptionalNumber(input.batteryMv);
  if (Object.hasOwn(input, "batteryPercent")) next.batteryPercent = normalizeOptionalNumber(input.batteryPercent);
  if (Object.hasOwn(input, "protocolVersion")) {
    const protocolVersion = Number(input.protocolVersion);
    if (Number.isInteger(protocolVersion) && protocolVersion >= 1) next.protocolVersion = protocolVersion;
  }
  if (Object.hasOwn(input, "features")) {
    next.features = Array.isArray(input.features)
      ? [...new Set(input.features.filter((feature: any) => typeof feature === "string" && feature.trim()).map((feature: string) => feature.trim()))].slice(0, 32)
      : [];
  }
  if (Object.hasOwn(input, "limits")) {
    next.limits = input.limits && typeof input.limits === "object" && !Array.isArray(input.limits)
      ? Object.fromEntries(Object.entries(input.limits).filter(([, value]) => Number.isFinite(Number(value))))
      : {};
  }
  if (Object.hasOwn(input, "gateway") && input.gateway && typeof input.gateway === "object" && !Array.isArray(input.gateway)) {
    next.gateway = normalizeGatewayTelemetry(input.gateway);
  }

  return next;
}

function normalizeGatewayTelemetry(input: any) {
  const reportedStatus = input.switchStatus ?? input.state;
  const switchStatus = reportedStatus === "stable" ? "active"
    : reportedStatus === "pending" ? "probing"
      : ["active", "probing", "failed"].includes(reportedStatus) ? reportedStatus : "active";
  return {
    activeProfileId: normalizeNullableString(input.activeProfileId),
    activeUrl: normalizeNullableString(input.activeUrl),
    pendingProfileId: normalizeNullableString(input.pendingProfileId),
    pendingUrl: normalizeNullableString(input.pendingUrl),
    switchStatus,
    detail: normalizeNullableString(input.detail),
  };
}

function normalizeFirmwarePolicy(input: any = {}, existing: any = null) {
  const next: any = { ...defaultFirmwarePolicy, ...(existing ?? {}) };
  if (Object.hasOwn(input, "channel") && ["stable", "beta"].includes(input.channel)) next.channel = input.channel;
  if (Object.hasOwn(input, "updateMode") && ["manual", "notify", "automatic"].includes(input.updateMode)) {
    next.updateMode = input.updateMode;
  }
  for (const key of ["desiredVersion", "lastUpdateStatus", "lastUpdateAt", "lastUpdateError", "targetVersion"]) {
    if (Object.hasOwn(input, key)) next[key] = normalizeNullableString(input[key]);
  }
  if (Object.hasOwn(input, "updateProgress")) {
    const progress = Number(input.updateProgress);
    next.updateProgress = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null;
  }
  return next;
}

function normalizeNullableString(value: any) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalNumber(value: any) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeEnvironmentHealth(input: any = {}, existing: any = null) {
  const base = {
    ...defaultEnvironmentHealth,
    ...(existing ?? {}),
  };
  return {
    ...base,
    ...(Object.hasOwn(input, "lastCheckedAt") ? { lastCheckedAt: normalizeNullableString(input.lastCheckedAt) } : {}),
    ...(Object.hasOwn(input, "lastReachableAt") ? { lastReachableAt: normalizeNullableString(input.lastReachableAt) } : {}),
    ...(Object.hasOwn(input, "lastError") ? { lastError: normalizeNullableString(input.lastError) } : {}),
    ...(Object.hasOwn(input, "failureReason")
      ? { failureReason: environmentFailureReasons.has(input.failureReason) ? input.failureReason : null }
      : {}),
    ...(Object.hasOwn(input, "snapshot") ? { snapshot: input.snapshot ?? null } : {}),
    ...(Object.hasOwn(input, "compatibility") ? { compatibility: input.compatibility ?? null } : {}),
    ...(Object.hasOwn(input, "capabilities") ? { capabilities: input.capabilities ?? null } : {}),
  };
}

function normalizeCommandMetrics(input: any = {}) {
  const metrics = input && typeof input === "object" ? input : {};
  return {
    acknowledgementDurationMs: normalizeOptionalNumber(metrics.acknowledgementDurationMs),
    dispatchDurationMs: normalizeOptionalNumber(metrics.dispatchDurationMs),
    ...(typeof metrics.dispatchStartedAt === "string" ? { dispatchStartedAt: normalizeNullableString(metrics.dispatchStartedAt) } : {}),
    completedAt: normalizeNullableString(metrics.completedAt),
    failureAt: normalizeNullableString(metrics.failureAt),
  };
}

function normalizePrivacySettings(input: any = {}, existing: any = defaultPrivacySettings) {
  const base = {
    ...defaultPrivacySettings,
    ...(existing ?? {}),
  };
  if (!input || typeof input !== "object") return base;
  const next = { ...base };
  if (Object.hasOwn(input, "mediaRetentionDays")) {
    const value = input.mediaRetentionDays;
    if (value === null) {
      next.mediaRetentionDays = null;
    } else {
      const days = Number(value);
      if (Number.isInteger(days) && days >= 1 && days <= 365) {
        next.mediaRetentionDays = days;
      }
    }
  }
  return next;
}

function defaultSubscription(updatedAt: string) {
  return {
    tier: defaultSubscriptionTier,
    status: defaultSubscriptionStatus,
    provider: null as string | null,
    externalId: null as string | null,
    currentPeriodEnd: null as string | null,
    updatedAt,
  };
}

function normalizeSubscription(existing: any, fallbackUpdatedAt: any = null) {
  const base = defaultSubscription(normalizeNullableString(fallbackUpdatedAt) ?? nowIso());
  if (!existing || typeof existing !== "object") return base;
  const tier = normalizeSubscriptionEnum(existing.tier);
  const status = normalizeSubscriptionEnum(existing.status);
  return {
    ...base,
    tier: tier && subscriptionTiers.has(tier) ? tier : base.tier,
    status: status && subscriptionStatuses.has(status) ? status : base.status,
    provider: normalizeNullableString(existing.provider),
    externalId: normalizeNullableString(existing.externalId),
    currentPeriodEnd: normalizeNullableString(existing.currentPeriodEnd),
    updatedAt: normalizeNullableString(existing.updatedAt) ?? base.updatedAt,
  };
}

function normalizeSubscriptionEnum(value: any) {
  const normalized = normalizeNullableString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function requireSubscriptionTier(value: any) {
  const tier = normalizeSubscriptionEnum(value);
  if (!tier || !subscriptionTiers.has(tier)) {
    throw new Error(`Unsupported subscription tier: ${String(value)}`);
  }
  return tier;
}

function requireSubscriptionStatus(value: any) {
  const status = normalizeSubscriptionEnum(value);
  if (!status || !subscriptionStatuses.has(status)) {
    throw new Error(`Unsupported subscription status: ${String(value)}`);
  }
  return status;
}

function normalizeTranscript(value: any) {
  if (typeof value !== "string") return undefined;
  const transcript = value.trim();
  return transcript.length > 0 ? transcript.slice(0, 12000) : undefined;
}

// The raw ASR version is kept verbatim — leading and trailing whitespace included — because the
// point of storing it is to be able to see exactly what the provider returned. Only the length is
// bounded, and only so one runaway response cannot bloat the row.
const mediaProcessingStatuses = new Set(["pending", "processing", "ready", "failed", "unavailable"]);

function normalizeRawTranscript(value: any) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, 12000);
}

function normalizeAttemptLimit(value: any) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return defaultMediaJobMaxAttempts;
  return Math.min(parsed, 10);
}

/**
 * Where a claimed job picks back up.
 *
 * Derived from what is already stored rather than from the stage it crashed in, so a worker that
 * died after writing the raw transcript does not pay for the ASR call twice.
 */
function resumeStageFor(job: any) {
  if (job.rawTranscript === null) return "transcribing";
  if (job.normalizedTranscript === null) return "normalizing";
  return "dispatching";
}

function normalizeMediaProcessing(input: any = null, kind = "image", transcript: any = null, description: any = null) {
  const now = nowIso();
  if (kind === "image") {
    const status = mediaProcessingStatuses.has(input?.visionStatus)
      ? input.visionStatus
      : (description ? "ready" : "pending");
    return {
      transcriptionStatus: "not_applicable",
      transcriptSource: null,
      visionStatus: status,
      descriptionSource: input?.descriptionSource ?? (description ? "upload" : null),
      lastError: input?.lastError ?? null,
      updatedAt: input?.updatedAt ?? now,
    };
  }
  if (kind !== "audio") {
    return {
      transcriptionStatus: "not_applicable",
      transcriptSource: null,
      lastError: null,
      updatedAt: input?.updatedAt ?? now,
    };
  }
  const allowed = mediaProcessingStatuses;
  const status = allowed.has(input?.transcriptionStatus)
    ? input.transcriptionStatus
    : (transcript ? "ready" : "pending");
  return {
    transcriptionStatus: status,
    transcriptSource: input?.transcriptSource ?? (transcript ? "upload" : null),
    lastError: input?.lastError ?? null,
    updatedAt: input?.updatedAt ?? now,
  };
}

function publicUser(user: any) {
  if (!user) return null;
  return {
    id: user.externalId,
    email: user.email,
    name: user.name ?? null,
    privacy: normalizePrivacySettings(user.privacy),
    onboarding: normalizeOnboarding(user.onboarding),
    createdAt: user.createdAt,
  };
}

function normalizeOnboarding(value: any) {
  const input = value && typeof value === "object" ? value : {};
  const provider = input.provider && typeof input.provider === "object" ? input.provider : {};
  const workspace = input.workspace && typeof input.workspace === "object" ? input.workspace : {};
  const device = input.device && typeof input.device === "object" ? input.device : {};
  return {
    ...defaultOnboarding,
    ...input,
    version: 2,
    provider: { ...defaultOnboarding.provider, ...provider },
    workspace: { ...defaultOnboarding.workspace, ...workspace },
    device: { ...defaultOnboarding.device, ...device },
  };
}

function normalizeOnboardingInput(value: any, previous: any) {
  const input = value && typeof value === "object" ? value : {};
  const now = nowIso();
  const onboarding = normalizeOnboarding({
    ...previous,
    ...input,
    provider: { ...previous.provider, ...(input.provider ?? {}) },
    workspace: { ...previous.workspace, ...(input.workspace ?? {}) },
    device: { ...previous.device, ...(input.device ?? {}) },
    updatedAt: now,
  });
  if (onboarding.status !== "not_started" && !onboarding.startedAt) onboarding.startedAt = now;
  if (onboarding.status === "paused") onboarding.pausedAt = now;
  if (onboarding.status === "in_progress") onboarding.pausedAt = null;
  if (onboarding.status === "completed") {
    onboarding.currentStep = "ready";
    onboarding.completedAt = onboarding.completedAt ?? now;
    onboarding.pausedAt = null;
  }
  return onboarding;
}

function publicUserToken(token: any) {
  if (!token) return null;
  return {
    id: token._id,
    userId: token.userExternalId,
    label: token.label,
    revokedAt: token.revokedAt ?? null,
    lastUsedAt: token.lastUsedAt ?? null,
    createdAt: token.createdAt,
  };
}

function publicDevice(device: any) {
  if (!device) return null;
  return {
    id: device._id,
    userId: device.userExternalId ?? null,
    label: device.label,
    profile: device.profile,
    // Stamped at pre-provision. Absent on devices created before the board catalogue existed, so
    // it is null rather than a guessed default — the console must not invent a board.
    hardwareModel: device.hardwareModel ?? null,
    credentialVersion: device.credentialVersion ?? 1,
    credentialRotation: publicDeviceCredentialRotation(device),
    claimedAt: device.claimedAt ?? null,
    claimCodeExpiresAt: device.claimCodeExpiresAt ?? null,
    revokedAt: device.revokedAt ?? null,
    lastSeenAt: device.lastSeenAt ?? null,
    status: normalizeDeviceStatus({}, device.status, device.status?.lastHeartbeatAt ?? null),
    firmwarePolicy: normalizeFirmwarePolicy({}, device.firmwarePolicy),
    presence: buildDevicePresence(device),
    config: publicDeviceConfig(device.config),
    gatewaySelection: normalizeGatewaySelection(device.gatewaySelection),
    actions: deviceActions(device),
    voiceAutoSend: normalizeVoiceAutoSend(device.voiceAutoSend, deviceReportsMicrophone(device)),
    createdAt: device.createdAt,
    claimed: Boolean(device.claimedAt),
  };
}

function publicDeviceCredentialRotation(device: any, now = Date.now()) {
  if (!device?.rotationId) {
    return {
      id: null,
      state: "idle",
      purpose: null,
      pendingCredentialVersion: null,
      startedAt: null,
      expiresAt: null,
      completedAt: null,
    };
  }
  const completed = Boolean(device.rotationCompletedAt);
  const expired = !completed && Date.parse(device.rotationExpiresAt ?? "") <= now;
  return {
    id: device.rotationId,
    state: completed ? "completed" : expired ? "expired" : "pending",
    purpose: device.rotationPurpose ?? "rotate",
    pendingCredentialVersion: device.pendingCredentialVersion ?? null,
    startedAt: device.rotationStartedAt ?? null,
    expiresAt: device.rotationExpiresAt ?? null,
    completedAt: device.rotationCompletedAt ?? null,
  };
}

function deviceForGateway(device: any, authenticatedCredentialVersion: number, credentialState: string) {
  return {
    ...publicDevice(device),
    authenticatedCredentialVersion,
    credentialState,
  };
}

/**
 * Mirrors normalizeVoiceAutoSend() in src/store.mjs.
 *
 * Three states: the owner's explicit choice wins in either direction, and only in its absence does
 * the hardware decide — a device that has declared a microphone auto-sends by default, one that
 * never has does not. `enabledBy`/`enabledAt` stay reserved for a real grant, because a default has
 * nobody behind it. test/storeParity fails the moment this drifts from the memory store.
 */
function normalizeVoiceAutoSend(input: any = null, audioCapable = false) {
  const ownerChoice = normalizeVoiceAutoSendChoice(input);
  const capable = audioCapable === true;
  const enabled = ownerChoice === null ? capable : ownerChoice;
  const granted = ownerChoice === true;
  return {
    enabled,
    ownerChoice,
    source: ownerChoice === null ? "default" : "owner",
    audioCapable: capable,
    enabledBy: granted ? normalizeNullableString(input?.enabledBy) : null,
    enabledAt: granted ? normalizeNullableString(input?.enabledAt) : null,
  };
}

/**
 * Mirrors normalizeVoiceAutoSendChoice() in src/store.mjs. A legacy row stored only `enabled` and
 * cleared the grant on disable, so its `false` cannot be told from "never touched" and is read as
 * the latter; a legacy grant is preserved exactly.
 */
function normalizeVoiceAutoSendChoice(input: any) {
  if (input?.ownerChoice === true) return true;
  if (input?.ownerChoice === false) return false;
  if (input?.ownerChoice === undefined && input?.enabled === true) return true;
  return null;
}

/**
 * Mirrors deviceReportsMicrophone() in src/store.mjs. Evidence, not inference: what the firmware
 * declared on a heartbeat it actually sent, never what the hardware model is supposed to have.
 */
function deviceReportsMicrophone(device: any) {
  const features = device?.status?.features;
  return Array.isArray(features) && features.includes("microphone");
}

/**
 * Which owner operations this device can currently accept. Mirrors deviceActions() in
 * src/store.mjs — the memory store is the reference implementation, and a client that trusts this
 * field must get the same answer from either backend.
 */
function deviceActions(device: any) {
  const revoked = Boolean(device.revokedAt);
  return {
    rotateSecret: !revoked,
    transferReset: !revoked,
    updateConfig: !revoked,
    updateProfile: !revoked,
    revoke: !revoked,
    delete: revoked,
  };
}

function buildDevicePresence(device: any, now = Date.now()) {
  const lastSeenAt = normalizeNullableString(device.lastSeenAt);
  const lastHeartbeatAt = normalizeNullableString(device.status?.lastHeartbeatAt);
  const latestActivityAt = latestIso(lastSeenAt, lastHeartbeatAt);
  const ageMs = latestActivityAt ? Math.max(0, now - Date.parse(latestActivityAt)) : null;
  const online = ageMs !== null && ageMs <= deviceOnlineThresholdMs;
  return {
    state: online ? "online" : "offline",
    online,
    lastSeenAt,
    lastHeartbeatAt,
    latestActivityAt,
    ageMs,
    staleAfterMs: deviceOnlineThresholdMs,
  };
}

function latestIso(...values: any[]) {
  let latest = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > latestTime) {
      latest = value;
      latestTime = parsed;
    }
  }
  return latest;
}

function publicDeviceConfig(config: any = {}) {
  return {
    environmentId: config.environmentId ?? null,
    projectId: config.projectId ?? null,
    threadId: config.threadId ?? null,
    gatewayAccessMode: config.gatewayAccessMode ?? "local",
    gatewayUrl: config.gatewayUrl ?? null,
    defaultPrompt: config.defaultPrompt ?? defaultConfig.defaultPrompt,
    shellCommand: config.shellCommand ?? defaultConfig.shellCommand,
    menu: Array.isArray(config.menu) && config.menu.length > 0 ? config.menu : defaultConfig.menu,
  };
}

function expiredConnectSessionView(session: any) {
  if (session.status !== "pending") return session;
  if (Date.parse(session.expiresAt) > Date.now()) return session;
  return { ...session, status: "expired" };
}

function publicConnectSession(session: any) {
  if (!session) return null;
  return {
    id: session._id,
    userId: session.userExternalId,
    label: session.label,
    accessMode: session.accessMode,
    purpose: session.purpose ?? "t3_enrollment",
    environmentId: session.environmentId ?? null,
    status: session.status,
    expiresAt: session.expiresAt,
    baseUrl: session.baseUrl ?? null,
    error: session.error ?? null,
    completedAt: session.completedAt ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function publicConnector(connector: any) {
  if (!connector) return null;
  const gatewayConnector = connectorForGateway(connector);
  if (!gatewayConnector) return null;
  const { secretHash: _secretHash, ...output } = gatewayConnector;
  return output;
}

function connectorForGateway(connector: any) {
  if (!connector) return null;
  return {
    id: connector._id,
    userId: connector.userExternalId,
    environmentId: connector.environmentId,
    label: connector.label,
    secretHash: connector.secretHash ?? null,
    secretPrefix: connector.secretPrefix,
    credentialVersion: connector.credentialVersion ?? 1,
    rotationId: connector.rotationId ?? null,
    rotationStartedAt: connector.rotationStartedAt ?? null,
    rotationExpiresAt: connector.rotationExpiresAt ?? null,
    rotationCompletedAt: connector.rotationCompletedAt ?? null,
    rotationPending: Boolean(connector.pendingSecretHash && Date.parse(connector.rotationExpiresAt ?? "") > Date.now()),
    scopes: connector.scopes,
    status: connector.status,
    protocolVersion: connector.protocolVersion,
    connectorVersion: connector.connectorVersion ?? null,
    t3Version: connector.t3Version ?? null,
    platform: connector.platform ?? null,
    capabilities: connector.capabilities,
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
    lastSeenAt: connector.lastSeenAt ?? null,
    lastConnectedAt: connector.lastConnectedAt ?? null,
    revokedAt: connector.revokedAt ?? null,
    lastDisconnectReason: connector.lastDisconnectReason ?? null,
    lastT3Health: connector.lastT3Health ?? null,
    lastT3HealthAt: connector.lastT3HealthAt ?? null,
    activeRequests: connector.activeRequests ?? 0,
    queueDepth: connector.queueDepth ?? 0,
    lastPresenceEventAt: connector.lastPresenceEventAt ?? null,
    lastPresenceEventKey: connector.lastPresenceEventKey ?? null,
    lastConnectionId: connector.lastConnectionId ?? null,
  };
}

function publicEnvironment(environment: any) {
  if (!environment) return null;
  const gatewayEnvironment = environmentForGateway(environment);
  if (!gatewayEnvironment) return null;
  const { accessToken, ...output } = gatewayEnvironment;
  return output;
}

function environmentForGateway(environment: any) {
  if (!environment) return null;
  return {
    id: environment._id,
    userId: environment.userExternalId,
    label: environment.label,
    baseUrl: environment.baseUrl ?? null,
    transportMode: environment.transportMode ?? "direct",
    connectorId: environment.connectorId ?? null,
    accessToken: environment.accessToken,
    accessTokenExpiresAt: environment.accessTokenExpiresAt ?? null,
    scopes: environment.scopes,
    status: environment.status,
    archivedAt: environment.archivedAt ?? null,
    deletedAt: environment.deletedAt ?? null,
    purgeAfter: environment.purgeAfter ?? null,
    health: normalizeEnvironmentHealth(environment.health),
    providerCatalogue: environment.providerCatalogue ?? null,
    lastProjectionAt: environment.lastProjectionAt ?? null,
    lastConnectorSeenAt: environment.lastConnectorSeenAt ?? null,
    freshness: environment.freshness ?? "unknown",
    createdAt: environment.createdAt,
    updatedAt: environment.updatedAt,
  };
}

function publicFirmwareRelease(release: any) {
  if (!release) return null;
  return {
    id: release._id,
    version: release.version,
    channel: release.channel ?? "stable",
    hardwareModel: release.hardwareModel,
    url: release.url,
    sha256: release.sha256,
    sizeBytes: release.sizeBytes,
    mandatory: release.mandatory,
    releaseNotes: release.releaseNotes,
    createdAt: release.createdAt,
  };
}

function publicReleaseRolloutRecord(rollout: any) {
  if (!rollout) return null;
  return {
    id: rollout._id,
    userId: rollout.userExternalId,
    name: rollout.name,
    targetKind: rollout.targetKind,
    targetVersion: rollout.targetVersion,
    rollbackVersion: rollout.rollbackVersion ?? null,
    releaseId: rollout.releaseId ?? null,
    channel: rollout.channel,
    cohort: rollout.cohort?.type === "allowlist"
      ? { type: "allowlist", targetIds: [...(rollout.cohort.targetIds ?? [])] }
      : { type: "percentage", percentage: rollout.cohort?.percentage ?? 0 },
    minimumProtocolVersion: rollout.minimumProtocolVersion,
    requiredCapabilities: [...rollout.requiredCapabilities],
    state: rollout.state,
    evidenceRef: rollout.evidenceRef ?? null,
    createdAt: rollout.createdAt,
    updatedAt: rollout.updatedAt,
    startedAt: rollout.startedAt ?? null,
    completedAt: rollout.completedAt ?? null,
  };
}

async function publicReleaseRolloutWithProgress(ctx: any, rollout: any) {
  if (!rollout) return null;
  const assignments = await ctx.db.query("rolloutAssignments")
    .withIndex("byRolloutId", (q: any) => q.eq("rolloutId", rollout._id)).collect();
  const counts: Record<string, number> = {};
  for (const assignment of assignments) counts[assignment.status] = (counts[assignment.status] ?? 0) + 1;
  return { ...publicReleaseRolloutRecord(rollout), progress: { total: assignments.length, counts } };
}

function publicRolloutAssignment(row: any) {
  return {
    id: row._id,
    userId: row.userExternalId,
    rolloutId: row.rolloutId,
    targetId: row.targetId,
    targetKind: row.targetKind,
    status: row.status,
    reasonCode: row.reasonCode ?? null,
    observedVersion: row.observedVersion ?? null,
    progress: row.progress ?? null,
    attempts: row.attempts,
    previousDesiredVersion: row.previousDesiredVersion ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? null,
  };
}

function publicGatewayProfile(profile: any) {
  if (!profile) return null;
  return { id: String(profile._id), userId: profile.userExternalId, label: profile.label,
    mode: profile.mode, url: profile.url, baseUrl: profile.url,
    createdAt: profile.createdAt, updatedAt: profile.updatedAt };
}

function normalizeGatewaySelection(input: any = null) {
  return {
    revision: Number.isInteger(input?.revision) && input.revision >= 0 ? input.revision : 0,
    state: ["stable", "pending", "failed"].includes(input?.state) ? input.state : "stable",
    activeProfileId: input?.activeProfileId ?? null,
    pendingProfileId: input?.pendingProfileId ?? null,
    previousProfileId: input?.previousProfileId ?? null,
    requestedAt: input?.requestedAt ?? null,
    appliedAt: input?.appliedAt ?? null,
    lastError: input?.lastError ?? null,
  };
}

function publicMediaUpload(media: any) {
  if (!media) return null;
  const gatewayMedia = mediaForGateway(media);
  if (!gatewayMedia) return null;
  const { storagePath, uploadSessionId, ...output } = gatewayMedia;
  return output;
}

function publicMediaUploadSession(session: any) {
  if (!session) return null;
  return {
    id: session._id,
    kind: session.kind,
    contentType: session.contentType,
    sizeBytes: session.expectedSizeBytes,
    sha256: session.expectedSha256,
    status: session.status,
    mediaId: session.mediaId ?? null,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    uploadedAt: session.uploadedAt ?? null,
    finalizedAt: session.finalizedAt ?? null,
    abortedAt: session.abortedAt ?? null,
  };
}

function publicCompanionHandoff(handoff: any) {
  if (!handoff) return null;
  const { codeHash, userExternalId, _id, _creationTime, ...rest } = handoff;
  return { id: _id, ...rest };
}

function mediaUploadSessionForGateway(session: any) {
  if (!session) return null;
  return {
    id: session._id,
    userId: session.userExternalId,
    deviceId: session.deviceId ?? null,
    clientRequestId: session.clientRequestId,
    kind: session.kind,
    contentType: session.contentType,
    expectedSizeBytes: session.expectedSizeBytes,
    expectedSha256: session.expectedSha256,
    storagePath: session.storagePath,
    originalName: session.originalName ?? null,
    transcript: session.transcript ?? null,
    captureSource: session.captureSource ?? null,
    environmentId: session.environmentId ?? null,
    threadId: session.threadId ?? null,
    companionHandoffId: session.companionHandoffId ?? null,
    status: session.status,
    mediaId: session.mediaId ?? null,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    uploadedAt: session.uploadedAt ?? null,
    finalizedAt: session.finalizedAt ?? null,
    abortedAt: session.abortedAt ?? null,
  };
}

function publicMacro(macro: any) {
  if (!macro) return null;
  return {
    id: macro._id,
    userId: macro.userExternalId,
    label: macro.label,
    environmentId: macro.environmentId ?? null,
    threadId: macro.threadId ?? null,
    intent: macro.intent,
    disabled: macro.disabled === true,
    disabledReason: macro.disabled === true ? (macro.disabledReason ?? null) : null,
    createdAt: macro.createdAt,
    updatedAt: macro.updatedAt,
  };
}

function publicAction(action: any) {
  if (!action) return null;
  return {
    id: action._id,
    userId: action.userExternalId,
    type: action.type,
    label: action.label,
    payload: action.payload ?? {},
    targetMode: action.targetMode ?? "device-current",
    environmentId: action.environmentId ?? null,
    threadId: action.threadId ?? null,
    steps: action.steps ?? [],
    disabled: action.disabled === true,
    disabledReason: action.disabled === true ? (action.disabledReason ?? null) : null,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

function defaultDeviceControls(device: any) {
  return {
    userExternalId: device.userExternalId,
    deviceId: device._id,
    revision: 1,
    explicit: false,
    items: [
      { id: "system_status", kind: "status", label: "Status" },
      { id: "system_stop", kind: "stop", label: "Stop run" },
    ],
    appliedRevision: null,
    appliedAt: null,
    lastAckStatus: null,
    lastAckError: null,
    updatedAt: device.createdAt ?? nowIso(),
  };
}

function publicDeviceControls(controls: any) {
  if (!controls) return null;
  return {
    deviceId: controls.deviceId,
    revision: controls.revision,
    explicit: controls._id ? true : controls.explicit === true,
    items: controls.items ?? [],
    appliedRevision: controls.appliedRevision ?? null,
    appliedAt: controls.appliedAt ?? null,
    lastAckStatus: controls.lastAckStatus ?? null,
    lastAckError: controls.lastAckError ?? null,
    updatedAt: controls.updatedAt,
  };
}

function publicDeviceProfile(profile: any) {
  if (!profile) return null;
  return {
    id: profile._id,
    userId: profile.userExternalId,
    profileId: profile.profileId,
    label: profile.label,
    description: profile.description,
    capabilities: Array.isArray(profile.capabilities) ? [...profile.capabilities] : [],
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function macroForGateway(macro: any) {
  return publicMacro(macro);
}

function mediaForGateway(media: any) {
  if (!media) return null;
  return {
    id: media._id,
    userId: media.userExternalId,
    deviceId: media.deviceId ?? null,
    kind: media.kind,
    contentType: media.contentType,
    sizeBytes: media.sizeBytes,
    sha256: media.sha256,
    storagePath: media.storagePath,
    uploadSessionId: media.uploadSessionId ?? null,
    originalName: media.originalName ?? null,
    captureSource: media.captureSource ?? null,
    environmentId: media.environmentId ?? null,
    threadId: media.threadId ?? null,
    companionHandoffId: media.companionHandoffId ?? null,
    transcript: media.transcript ?? null,
    description: media.description ?? null,
    processing: normalizeMediaProcessing(
      media.processing,
      media.kind,
      media.transcript ?? null,
      media.description ?? null,
    ),
    expiresAt: media.expiresAt ?? null,
    createdAt: media.createdAt,
  };
}

function mediaJobForGateway(job: any) {
  if (!job) return null;
  return {
    id: job._id,
    userId: job.userExternalId,
    mediaId: job.mediaId,
    kind: job.kind,
    stage: job.stage,
    deviceId: job.deviceId ?? null,
    environmentId: job.environmentId ?? null,
    threadId: job.threadId ?? null,
    autoSend: job.autoSend === true,
    dispatchStatus: job.dispatchStatus ?? null,
    dispatchError: job.dispatchError ?? null,
    commandId: job.commandId ?? null,
    provider: job.provider ?? null,
    model: job.model ?? null,
    language: job.language ?? null,
    rawTranscript: job.rawTranscript ?? null,
    normalizedTranscript: job.normalizedTranscript ?? null,
    userEditedTranscript: job.userEditedTranscript ?? null,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    reviewRequired: job.reviewRequired === true,
    leaseOwner: job.leaseOwner ?? null,
    leaseExpiresAt: job.leaseExpiresAt ?? null,
    lastError: job.lastError ?? null,
    failureKind: job.failureKind ?? null,
    failureCause: job.failureCause ?? null,
    requeueCount: job.requeueCount ?? 0,
    requeuedAt: job.requeuedAt ?? null,
    requeuedBy: job.requeuedBy ?? null,
    timings: job.timings ?? {},
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

async function createCommandEvent(ctx: any, input: any) {
  await ctx.db.insert("commandEvents", {
    userExternalId: input.userExternalId,
    commandId: input.commandId,
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
    actorType: input.actorType,
    ...(input.actorId ? { actorId: input.actorId } : {}),
    status: input.status,
    previousStatus: input.previousStatus ?? null,
    risk: input.risk,
    result: input.result ?? null,
    metrics: normalizeCommandMetrics(input.metrics),
    createdAt: nowIso(),
  });
}

function publicCommand(command: any) {
  if (!command) return null;
  return {
    id: command._id,
    userId: command.userExternalId,
    deviceId: command.deviceId ?? null,
    environmentId: command.environmentId,
    threadId: command.threadId ?? null,
    intent: command.intent,
    normalized: command.normalized,
    status: command.status,
    risk: command.risk,
    result: command.result ?? null,
    metrics: normalizeCommandMetrics(command.metrics),
    createdAt: command.createdAt,
    updatedAt: command.updatedAt,
  };
}

function publicCommandRequest(request: any) {
  if (!request) return null;
  return {
    clientRequestId: request.clientRequestId,
    operation: request.operation,
    status: request.status,
    commandId: request.commandId ?? null,
    httpStatus: request.httpStatus ?? null,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    expiresAt: request.expiresAt,
  };
}

function publicCommandEvent(event: any) {
  if (!event) return null;
  return {
    id: event._id,
    userId: event.userExternalId,
    commandId: event.commandId,
    deviceId: event.deviceId ?? null,
    actorType: event.actorType,
    actorId: event.actorId ?? null,
    status: event.status,
    previousStatus: event.previousStatus ?? null,
    risk: event.risk,
    result: event.result ?? null,
    metrics: normalizeCommandMetrics(event.metrics),
    createdAt: event.createdAt,
  };
}

function publicNotification(notification: any) {
  if (!notification) return null;
  return {
    id: notification._id,
    userId: notification.userExternalId,
    sequence: notification.sequence,
    kind: notification.kind,
    severity: notification.severity,
    title: notification.title,
    environmentId: notification.environmentId ?? null,
    threadId: notification.threadId ?? null,
    commandId: notification.commandId ?? null,
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt,
    readAt: notification.readAt ?? null,
    dismissedAt: notification.dismissedAt ?? null,
  };
}

function publicPushSubscription(subscription: any) {
  if (!subscription) return null;
  return {
    id: subscription._id,
    vapidKeyId: subscription.vapidKeyId,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
    revokedAt: subscription.revokedAt ?? null,
    lastAcceptedAt: subscription.lastAcceptedAt ?? null,
    lastFailureCode: subscription.lastFailureCode ?? null,
  };
}

async function ensureMediaOwnerUsage(ctx: any, userId: string) {
  const existing = await ctx.db.query("mediaOwnerUsage")
    .withIndex("byUserExternalId", (q: any) => q.eq("userExternalId", userId))
    .first();
  if (existing) return existing;
  // One-time migration for owners created before the accounting row existed. Subsequent quota
  // checks and updates are O(1) and execute atomically in the same Convex mutation.
  const [media, sessions] = await Promise.all([
    ctx.db.query("mediaUploads").withIndex("byUserExternalId", (q: any) => q.eq("userExternalId", userId)).collect(),
    ctx.db.query("mediaUploadSessions").withIndex("byUserExternalId", (q: any) => q.eq("userExternalId", userId)).collect(),
  ]);
  const id = await ctx.db.insert("mediaOwnerUsage", {
    userExternalId: userId,
    committedBytes: media.reduce((total: number, item: any) => total + item.sizeBytes, 0),
    reservedBytes: sessions.filter((session: any) => ["pending", "uploaded"].includes(session.status))
      .reduce((total: number, session: any) => total + session.expectedSizeBytes, 0),
    updatedAt: nowIso(),
  });
  return await ctx.db.get(id);
}

function publicBackgroundLiveness(record: any) {
  if (!record) return null;
  return {
    scope: record.scope,
    lastAttemptAt: record.lastAttemptAt,
    lastSuccessAt: record.lastSuccessAt ?? null,
    lastFailureAt: record.lastFailureAt ?? null,
    failureCode: record.failureCode ?? null,
    updatedAt: record.updatedAt,
  };
}

async function pruneNotifications(ctx: any, userId: string) {
  const rows = await ctx.db
    .query("notifications")
    .withIndex("byUserSequence", (q: any) => q.eq("userExternalId", userId))
    .collect();
  const cutoff = Date.now() - NOTIFICATION_RETENTION_MS;
  const retained: any[] = [];
  for (const row of rows) {
    if (Date.parse(row.createdAt) <= cutoff) await ctx.db.delete(row._id);
    else retained.push(row);
  }
  if (retained.length <= NOTIFICATION_MAX_PER_OWNER) return;
  retained.sort((left: any, right: any) => {
    const leftPriority = left.dismissedAt ? 0 : left.readAt ? 1 : 2;
    const rightPriority = right.dismissedAt ? 0 : right.readAt ? 1 : 2;
    return leftPriority - rightPriority || left.sequence - right.sequence;
  });
  for (const row of retained.slice(0, retained.length - NOTIFICATION_MAX_PER_OWNER)) {
    await ctx.db.delete(row._id);
  }
}

function parseNotificationCursor(value: any) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeNotificationTimestamp(value: any, fallbackMs: number) {
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return new Date(Number.isFinite(parsed) ? parsed : fallbackMs).toISOString();
}

function normalizeNotificationText(value: any, maxLength: number, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim().slice(0, maxLength);
}

function normalizeNullableNotificationText(value: any, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().slice(0, maxLength);
}

function normalizeBackgroundFailureCode(value: any) {
  return typeof value === "string" && /^[a-z][a-z0-9_.:-]{0,63}$/u.test(value)
    ? value
    : "background_task_failed";
}

function publicAuditLog(event: any) {
  if (!event) return null;
  return {
    id: event._id,
    userId: event.userExternalId,
    actorType: event.actorType,
    actorId: event.actorId ?? null,
    action: event.action,
    targetId: event.targetId ?? null,
    metadata: event.metadata ?? {},
    createdAt: event.createdAt,
  };
}
