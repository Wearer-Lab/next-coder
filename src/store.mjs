import { createHash, timingSafeEqual } from "node:crypto";

import { ENVIRONMENT_REMOVED_REASON } from "./actions.mjs";
import { defaultSubscription, normalizeSubscription } from "./billing.mjs";
import { CONNECT_SESSION_TTL_MS, normalizeConnectAccessMode } from "./connectSession.mjs";
import {
  CONNECTOR_PROTOCOL_VERSION,
  CONNECTOR_ROTATION_TTL_MS,
  CONNECTOR_TICKET_AUDIENCE,
  CONNECTOR_TICKET_TTL_MS,
} from "./connectorProtocol.mjs";
import { ENVIRONMENT_FAILURE_REASONS } from "./environmentFailure.mjs";
import { createId, createSecret, nowIso } from "./ids.mjs";
import { normalizeOnboarding, normalizeStoredOnboarding } from "./onboarding.mjs";
import {
  COMMAND_REQUEST_MAX_PER_OWNER,
  COMMAND_REQUEST_TTL_MS,
  commandRequestKey,
  commandRequestOwnerKey,
  publicCommandRequest,
} from "./requestEnvelope.mjs";
import { createSecretBox } from "./secretBox.mjs";

const DEFAULT_PRIVACY_SETTINGS = {
  mediaRetentionDays: 30,
};

// The media processing job state machine. `queued` and the three working stages are driven by the
// worker; `review_required` waits on a person; `dispatched` and `failed` are terminal and never
// re-claimed, which is what stops a restart from dispatching the same transcript twice.
export const MEDIA_JOB_STAGES = [
  "queued",
  "transcribing",
  "normalizing",
  "review_required",
  "ready",
  "dispatching",
  "dispatched",
  "failed",
];
const MEDIA_JOB_STAGE_SET = new Set(MEDIA_JOB_STAGES);
export const MEDIA_JOB_TERMINAL_STAGES = new Set(["dispatched", "failed"]);
// Mirrors TRANSCRIPTION_FAILURE_CAUSES in src/transcription.mjs. Spelled out here rather than
// imported so the Convex copy of this file has one list to mirror, and so the store validates what
// it stores instead of trusting a caller.
const MEDIA_JOB_FAILURE_CAUSES = ["configuration", "input", "provider", "unknown"];
const DEFAULT_MEDIA_JOB_MAX_ATTEMPTS = 3;
const DEVICE_ONLINE_THRESHOLD_MS = 90_000;
const NOTIFICATION_MAX_PER_OWNER = 1000;
const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const NOTIFICATION_KIND_SET = new Set([
  "turn.completed",
  "turn.failed",
  "gateway.approval_required",
  "provider.approval_required",
  "user_input.required",
  "connector.offline",
  "connector.recovered",
  "t3.offline",
  "t3.recovered",
]);
const NOTIFICATION_SEVERITY_SET = new Set(["info", "attention", "error"]);
// A claim code has to outlive warehouse-to-customer transit, because the printed label is issued at
// manufacture and read by the owner weeks later. Units that sit in inventory past this refresh from
// the device menu (`rotate: true`) rather than silently on every boot.
const CLAIM_CODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEVICE_CREDENTIAL_ROTATION_TTL_MS = 10 * 60 * 1000;

function claimCodeExpiryFrom(issuedAtMs) {
  return new Date(issuedAtMs + CLAIM_CODE_TTL_MS).toISOString();
}

function claimCodeIsLive(device, now = Date.now()) {
  if (!device.claimCodeHash) return false;
  const expiresAt = Date.parse(device.claimCodeExpiresAt ?? "");
  // A code minted before expiry tracking existed has no recorded end date. Treating it as live
  // keeps already-shipped labels working instead of invalidating them on deploy.
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt > now;
}

function hashSecret(secret) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

// The shape every store implementation reports back from deleteEnvironment, and the shape the
// dependency preview answers with. Kept here so memory, file, and Convex stores cannot drift.
export function emptyEnvironmentRemoval() {
  return { devices: [], actions: [], macros: [], onboarding: false };
}

export function createStore(seed = {}, options = {}) {
  const t3TokenBox = createSecretBox(options.t3TokenEncryptionKey);
  const pushSecretBox = createSecretBox(options.pushEncryptionKey ?? options.t3TokenEncryptionKey);
  const requestNow = options.now ?? (() => Date.now());
  const deviceRotationForRequest = (device) => publicDeviceCredentialRotation(device, requestNow());
  const publicDeviceForRequest = (device) => publicDevice(device, requestNow());
  const users = new Map((seed.users ?? []).map((user) => [user.id, user]));
  const apiTokens = new Map((seed.apiTokens ?? []).map((token) => [token.id, token]));
  const devices = new Map((seed.devices ?? []).map((device) => [device.id, device]));
  const environments = new Map((seed.environments ?? []).map((environment) => [environment.id, environment]));
  const connectSessions = new Map((seed.connectSessions ?? []).map((session) => [session.id, session]));
  const connectors = new Map((seed.connectors ?? []).map((connector) => [connector.id, connector]));
  const connectorTickets = new Map((seed.connectorTickets ?? []).map((ticket) => [ticket.id, ticket]));
  const firmwareReleases = new Map((seed.firmwareReleases ?? []).map((release) => [release.id, release]));
  const releaseRollouts = new Map((seed.releaseRollouts ?? []).map((rollout) => [rollout.id, rollout]));
  const rolloutAssignments = new Map(
    (seed.rolloutAssignments ?? []).map((assignment) => [`${assignment.rolloutId}:${assignment.targetId}`, assignment]),
  );
  const gatewayProfiles = new Map((seed.gatewayProfiles ?? []).map((profile) => [profile.id, profile]));
  const companionHandoffs = new Map(
    (seed.companionHandoffs ?? []).map((handoff) => [handoff.id, handoff]),
  );
  const mediaUploadSessions = new Map(
    (seed.mediaUploadSessions ?? []).map((session) => [session.id, session]),
  );
  const mediaUploads = new Map((seed.mediaUploads ?? []).map((media) => [media.id, media]));
  const mediaJobs = new Map((seed.mediaJobs ?? []).map((job) => [job.id, job]));
  const macros = new Map((seed.macros ?? []).map((macro) => [macro.id, macro]));
  const actions = new Map((seed.actions ?? []).map((action) => [action.id, action]));
  const deviceControls = new Map(
    (seed.deviceControls ?? []).map((controls) => [
      controls.deviceId,
      { ...controls, explicit: controls.explicit !== false },
    ]),
  );
  const macroRuns = new Map((seed.macroRuns ?? []).map((run) => [run.id, run]));
  // Keyed by user + slug: a profile id is unique per user, not globally.
  const deviceProfiles = new Map(
    (seed.deviceProfiles ?? []).map((profile) => [`${profile.userId}:${profile.profileId}`, profile]),
  );
  const commands = new Map((seed.commands ?? []).map((command) => [command.id, command]));
  const commandRequests = new Map(
    (seed.commandRequests ?? []).map((request) => [commandRequestKey(request), request]),
  );
  // Keyed by user + environment + thread + T3 request id: the request id is the provider's, and
  // scoping it to the owner is what stops one account's answer from resolving another's.
  const providerApprovalDecisions = new Map(
    (seed.providerApprovalDecisions ?? []).map((decision) => [providerApprovalKey(decision), decision]),
  );
  // Keyed the same way, for the third thing that can block a turn: a question the agent asked.
  // See the note on claimProviderUserInputAnswer() — the row deliberately holds a FINGERPRINT of
  // the answers rather than the answers themselves.
  const providerUserInputAnswers = new Map(
    (seed.providerUserInputAnswers ?? []).map((answer) => [providerApprovalKey(answer), answer]),
  );
  const commandEvents = new Map((seed.commandEvents ?? []).map((event) => [event.id, event]));
  const notifications = new Map((seed.notifications ?? []).map((notification) => [notification.id, notification]));
  const notificationDedupe = new Map(
    [...notifications.values()].map((notification) => [notificationKey(notification), notification.id]),
  );
  let notificationSequence = Math.max(
    0,
    ...[...notifications.values()].map((notification) => Number(notification.sequence) || 0),
  );
  const backgroundLiveness = new Map(
    (seed.backgroundLiveness ?? []).map((record) => [record.scope, record]),
  );
  const pushSubscriptions = new Map(
    (seed.pushSubscriptions ?? []).map((subscription) => [subscription.id, subscription]),
  );
  const pushSubscriptionByOwnerEndpoint = new Map(
    [...pushSubscriptions.values()].map((subscription) => [
      `${subscription.userId}\u0000${subscription.endpointHash}`,
      subscription.id,
    ]),
  );
  const pushDeliveries = new Map(
    (seed.pushDeliveries ?? []).map((delivery) => [delivery.id, delivery]),
  );
  const pushDeliveryDedupe = new Map(
    [...pushDeliveries.values()].map((delivery) => [
      `${delivery.subscriptionId}\u0000${delivery.notificationId}`,
      delivery.id,
    ]),
  );
  const auditLogs = [...(seed.auditLogs ?? [])];
  const listeners = new Set();

  function notifyChanged() {
    for (const listener of listeners) listener(exportState());
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function exportState() {
    return {
      version: 1,
      users: [...users.values()],
      apiTokens: [...apiTokens.values()],
      devices: [...devices.values()],
      environments: [...environments.values()],
      connectSessions: [...connectSessions.values()],
      connectors: [...connectors.values()],
      connectorTickets: [...connectorTickets.values()],
      firmwareReleases: [...firmwareReleases.values()],
      releaseRollouts: [...releaseRollouts.values()],
      rolloutAssignments: [...rolloutAssignments.values()],
      gatewayProfiles: [...gatewayProfiles.values()],
      companionHandoffs: [...companionHandoffs.values()],
      mediaUploadSessions: [...mediaUploadSessions.values()],
      mediaUploads: [...mediaUploads.values()],
      mediaJobs: [...mediaJobs.values()],
      macros: [...macros.values()],
      actions: [...actions.values()],
      deviceControls: [...deviceControls.values()],
      macroRuns: [...macroRuns.values()],
      deviceProfiles: [...deviceProfiles.values()],
      commands: [...commands.values()],
      commandRequests: [...commandRequests.values()],
      providerApprovalDecisions: [...providerApprovalDecisions.values()],
      providerUserInputAnswers: [...providerUserInputAnswers.values()],
      commandEvents: [...commandEvents.values()],
      notifications: [...notifications.values()],
      backgroundLiveness: [...backgroundLiveness.values()],
      pushSubscriptions: [...pushSubscriptions.values()],
      pushDeliveries: [...pushDeliveries.values()],
      auditLogs,
    };
  }

  function ensureUser({ userId = "user_dev", email = "dev@example.local", name = null } = {}) {
    const existing = users.get(userId);
    if (existing) {
      existing.privacy = normalizePrivacySettings(existing.privacy);
      existing.onboarding = normalizeStoredOnboarding(existing.onboarding);
      if (email && existing.email !== email) existing.email = email;
      if (name && existing.name !== name) existing.name = name;
      return publicUser(existing);
    }
    const user = {
      id: userId,
      email,
      ...(name ? { name } : {}),
      privacy: DEFAULT_PRIVACY_SETTINGS,
      onboarding: normalizeStoredOnboarding(null),
      createdAt: nowIso(),
    };
    users.set(user.id, user);
    audit({
      userId: user.id,
      actorType: "system",
      action: "user.created",
      targetId: user.id,
      metadata: { email },
    });
    notifyChanged();
    return publicUser(user);
  }

  function getUserPrivacySettings(userId) {
    const user = users.get(userId);
    return normalizePrivacySettings(user?.privacy);
  }

  function updateUserPrivacySettings({ userId, privacy }) {
    const user = users.get(userId);
    if (!user) return null;
    user.privacy = normalizePrivacySettings(privacy, user.privacy);
    audit({
      userId,
      actorType: "user",
      action: "user.privacy_updated",
      targetId: userId,
      metadata: user.privacy,
    });
    notifyChanged();
    return user.privacy;
  }

  function getUserSubscription(userId) {
    const user = users.get(userId);
    if (!user) return null;
    return user.subscription
      ? normalizeSubscription(user.subscription, user.subscription, user.subscription.updatedAt)
      : defaultSubscription(user.createdAt ?? nowIso());
  }

  function updateUserSubscription({ userId, ...input }) {
    const user = users.get(userId);
    if (!user) return null;
    const previous = user.subscription ?? defaultSubscription(user.createdAt ?? nowIso());
    user.subscription = normalizeSubscription(input, previous, nowIso());
    audit({
      userId,
      actorType: "user",
      action: "user.subscription_updated",
      targetId: userId,
      metadata: {
        tier: user.subscription.tier,
        status: user.subscription.status,
        provider: user.subscription.provider,
      },
    });
    notifyChanged();
    return user.subscription;
  }

  function getUserOnboarding(userId) {
    return normalizeStoredOnboarding(users.get(userId)?.onboarding);
  }

  function updateUserOnboarding({ userId, onboarding }) {
    const user = users.get(userId);
    if (!user) return null;
    const previous = normalizeStoredOnboarding(user.onboarding);
    user.onboarding = normalizeOnboarding(onboarding, previous);
    const action = user.onboarding.status === "completed"
      ? "user.onboarding_completed"
      : user.onboarding.status === "paused"
        ? "user.onboarding_paused"
        : previous.status === "not_started"
          ? "user.onboarding_started"
          : "user.onboarding_updated";
    audit({
      userId,
      actorType: "user",
      action,
      targetId: userId,
      metadata: {
        status: user.onboarding.status,
        currentStep: user.onboarding.currentStep,
      },
    });
    notifyChanged();
    return user.onboarding;
  }

  function createUserToken({ userId, label = "Platform API token" }) {
    const user = ensureUser({ userId });
    const token = createSecret();
    const record = {
      id: createId("tok"),
      userId: user.id,
      label,
      tokenHash: hashSecret(token),
      revokedAt: null,
      lastUsedAt: null,
      createdAt: nowIso(),
    };
    apiTokens.set(record.id, record);
    audit({
      userId: user.id,
      actorType: "user",
      action: "user_token.created",
      targetId: record.id,
      metadata: { label },
    });
    notifyChanged();
    return { token: publicUserToken(record), secret: token };
  }

  function authenticateUserToken(secret) {
    const hash = hashSecret(secret);
    for (const record of apiTokens.values()) {
      if (record.revokedAt) continue;
      if (!safeEqual(record.tokenHash, hash)) continue;
      const user = users.get(record.userId);
      if (!user) return null;
      record.lastUsedAt = nowIso();
      return user;
    }
    return null;
  }

  function createDevice({ userId, label, profile = "next-coder" }) {
    const user = ensureUser({ userId });
    const secret = createSecret();
    const device = {
      id: createId("dev"),
      userId: user.id,
      label,
      profile,
      secretHash: hashSecret(secret),
      credentialVersion: 1,
      claimCodeHash: null,
      claimedAt: nowIso(),
      revokedAt: null,
      lastSeenAt: null,
      status: createDefaultDeviceStatus(),
      config: createDefaultDeviceConfig(),
      firmwarePolicy: createDefaultFirmwarePolicy(),
      createdAt: nowIso(),
    };
    devices.set(device.id, device);
    audit({
      userId: user.id,
      actorType: "user",
      action: "device.created",
      targetId: device.id,
      metadata: { label, profile },
    });
    notifyChanged();
    return { device: publicDevice(device), secret };
  }

  function preprovisionDevice({ label, profile = "next-coder", hardwareModel = null }) {
    const secret = createSecret();
    const claimCode = createHumanCode();
    const device = {
      id: createId("dev"),
      userId: null,
      label,
      profile,
      // Stamped at pre-provision because it is a property of the physical unit, not of whoever
      // ends up owning it. An OTA release targets this, and the console uses it to say which
      // firmware image to flash — of which there is now one per board.
      hardwareModel,
      secretHash: hashSecret(secret),
      credentialVersion: 1,
      claimCodeHash: hashSecret(normalizeClaimCode(claimCode)),
      claimCodeExpiresAt: claimCodeExpiryFrom(Date.now()),
      claimedAt: null,
      revokedAt: null,
      lastSeenAt: null,
      status: createDefaultDeviceStatus(),
      config: createDefaultDeviceConfig(),
      firmwarePolicy: createDefaultFirmwarePolicy(),
      createdAt: nowIso(),
    };
    devices.set(device.id, device);
    audit({
      userId: "system",
      actorType: "system",
      action: "device.preprovisioned",
      targetId: device.id,
      metadata: { label, profile, hardwareModel },
    });
    notifyChanged();
    return { device: publicDevice(device), secret, claimCode };
  }

  function claimDevice({ userId, claimCode, label }) {
    const user = ensureUser({ userId });
    const normalized = normalizeClaimCode(claimCode);
    const claimHash = hashSecret(normalized);
    for (const device of devices.values()) {
      if (device.revokedAt || device.claimedAt || !device.claimCodeHash) continue;
      if (!safeEqual(device.claimCodeHash, claimHash)) continue;
      // A transfer is ownerless immediately, but it is not safe to hand the record to a new owner
      // while the former hardware credential is still the active one. The firmware must first
      // prove its pending secret and complete promotion.
      if (device.rotationPurpose === "transfer" && !device.rotationCompletedAt) return null;
      // An expired code is matched but refused, so the caller can say "expired" rather than the
      // indistinguishable "no such code" a `continue` would produce.
      if (!claimCodeIsLive(device)) return null;
      device.userId = user.id;
      device.claimCodeHash = null;
      device.claimCodeExpiresAt = null;
      device.claimedAt = nowIso();
      if (label) device.label = label;
      audit({
        userId: user.id,
        actorType: "user",
        action: "device.claimed",
        targetId: device.id,
        metadata: { label: device.label, profile: device.profile },
      });
      notifyChanged();
      return publicDevice(device);
    }
    return null;
  }

  function beginDeviceCredentialRotation(device, purpose) {
    const timestampMs = requestNow();
    device.pendingSecretHash = null;
    device.pendingCredentialVersion = (device.credentialVersion ?? 1) + 1;
    device.rotationId = createId("dcr");
    device.rotationPurpose = purpose;
    device.rotationStartedAt = new Date(timestampMs).toISOString();
    device.rotationExpiresAt = new Date(timestampMs + DEVICE_CREDENTIAL_ROTATION_TTL_MS).toISOString();
    device.rotationCompletedAt = null;
  }

  function revokeDevice({ userId, deviceId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId) return null;
    device.revokedAt = nowIso();
    clearPendingDeviceCredential(device);
    audit({
      userId,
      actorType: "user",
      action: "device.revoked",
      targetId: device.id,
      metadata: { label: device.label },
    });
    notifyChanged();
    return publicDevice(device);
  }

  /**
   * Permanently removes a device record. Only a revoked device qualifies: revocation kills the
   * credential, so deleting afterwards cannot strand hardware that is still able to authenticate.
   * Requiring the two steps also makes the irreversible one deliberate.
   *
   * Commands and audit entries reference the device by id and are intentionally left in place —
   * deleting the controller must not erase the record of what it did.
   */
  function deleteDevice({ userId, deviceId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId) return null;
    if (!device.revokedAt) return { device: null, reason: "not_revoked" };
    const removed = publicDevice(device);
    devices.delete(deviceId);
    deviceControls.delete(deviceId);
    audit({
      userId,
      actorType: "user",
      action: "device.deleted",
      targetId: device.id,
      metadata: { label: device.label, profile: device.profile, revokedAt: device.revokedAt },
    });
    notifyChanged();
    return { device: removed, reason: null };
  }

  function rotateDeviceSecret({ userId, deviceId, restart = false }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    const existing = deviceRotationForRequest(device);
    if (!restart && existing.state === "pending" && existing.purpose === "rotate") {
      return { device: publicDeviceForRequest(device), rotation: existing, created: false };
    }
    beginDeviceCredentialRotation(device, "rotate");
    audit({
      userId,
      actorType: "user",
      action: "device.secret_rotation_started",
      targetId: device.id,
      metadata: {
        label: device.label,
        purpose: "rotate",
        credentialVersion: device.credentialVersion ?? 1,
        pendingCredentialVersion: device.pendingCredentialVersion,
        expiresAt: device.rotationExpiresAt,
      },
    });
    notifyChanged();
    return { device: publicDeviceForRequest(device), rotation: deviceRotationForRequest(device), created: true };
  }

  function updateDeviceProfile({ userId, deviceId, profile }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    const previousProfile = device.profile;
    device.profile = profile;
    audit({
      userId,
      actorType: "user",
      action: "device.profile_updated",
      targetId: device.id,
      metadata: { label: device.label, previousProfile, profile },
    });
    notifyChanged();
    return publicDevice(device);
  }

  function resetDeviceForTransfer({ userId, deviceId, label }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    const previousLabel = device.label;
    device.userId = null;
    device.label = label ?? device.label;
    device.claimCodeHash = null;
    device.claimCodeExpiresAt = null;
    device.claimedAt = null;
    device.lastSeenAt = null;
    device.status = createDefaultDeviceStatus();
    device.config = createDefaultDeviceConfig();
    device.firmwarePolicy = createDefaultFirmwarePolicy();
    beginDeviceCredentialRotation(device, "transfer");
    deviceControls.delete(device.id);
    audit({
      userId,
      actorType: "user",
      action: "device.transfer_reset",
      targetId: device.id,
      metadata: {
        previousLabel,
        label: device.label,
        profile: device.profile,
        credentialVersion: device.credentialVersion ?? 1,
        pendingCredentialVersion: device.pendingCredentialVersion,
        expiresAt: device.rotationExpiresAt,
      },
    });
    notifyChanged();
    return {
      device: publicDeviceForRequest(device),
      rotation: deviceRotationForRequest(device),
    };
  }

  function stageDeviceSecret({
    deviceId,
    secret,
    rotationId,
    credentialVersion,
    authenticatedCredentialVersion,
  }) {
    const device = devices.get(deviceId);
    if (!device || device.revokedAt) return { device: null, rotation: null, reason: "revoked" };
    const activeVersion = device.credentialVersion ?? 1;
    if (authenticatedCredentialVersion !== activeVersion) {
      return { device: publicDeviceForRequest(device), rotation: deviceRotationForRequest(device), reason: "active_credential_required" };
    }
    const expectedVersion = device.pendingCredentialVersion;
    if (!device.rotationId || rotationId !== device.rotationId || credentialVersion !== expectedVersion) {
      return { device: publicDeviceForRequest(device), rotation: deviceRotationForRequest(device), reason: "rotation_mismatch" };
    }
    const now = requestNow();
    const expired = Date.parse(device.rotationExpiresAt ?? "") <= now;
    if (expired && device.rotationPurpose !== "transfer") {
      return { device: publicDeviceForRequest(device), rotation: deviceRotationForRequest(device), reason: "expired" };
    }
    if (expired) {
      // Transfer already removed the owner, so expiry cannot strand the physical unit forever.
      // The old credential remains rotation-only and may stage a fresh locally generated candidate;
      // any candidate from the expired window is discarded first.
      device.pendingSecretHash = null;
      device.rotationStartedAt = new Date(now).toISOString();
      device.rotationExpiresAt = new Date(now + DEVICE_CREDENTIAL_ROTATION_TTL_MS).toISOString();
    }
    const candidateHash = hashSecret(secret);
    if (device.pendingSecretHash && !safeEqual(device.pendingSecretHash, candidateHash)) {
      return { device: publicDeviceForRequest(device), rotation: deviceRotationForRequest(device), reason: "candidate_conflict" };
    }
    if (!device.pendingSecretHash) {
      device.pendingSecretHash = candidateHash;
      audit({
        userId: device.userId ?? "system",
        actorType: "device",
        actorId: device.id,
        action: "device.secret_rotation_staged",
        targetId: device.id,
        metadata: {
          purpose: device.rotationPurpose,
          credentialVersion: activeVersion,
          pendingCredentialVersion: expectedVersion,
          expiresAt: device.rotationExpiresAt,
        },
      });
      notifyChanged();
    }
    return { device: publicDeviceForRequest(device), rotation: deviceRotationForRequest(device), reason: null };
  }

  function acknowledgeDeviceSecret({
    deviceId,
    rotationId,
    credentialVersion,
    authenticatedCredentialVersion,
  }) {
    const device = devices.get(deviceId);
    if (!device || device.revokedAt) return { device: null, rotation: null, reason: "revoked" };
    const activeVersion = device.credentialVersion ?? 1;
    // The firmware may lose the success response after the server commits. Retrying with the now
    // active secret returns the same terminal answer instead of failing or starting a new rotation.
    if (authenticatedCredentialVersion === activeVersion
        && credentialVersion === activeVersion
        && rotationId === device.rotationId
        && device.rotationCompletedAt) {
      return {
        device: publicDeviceForRequest(device),
        rotation: deviceRotationForRequest(device),
        promoted: true,
        replayed: true,
        reason: null,
      };
    }
    if (authenticatedCredentialVersion !== device.pendingCredentialVersion
        || credentialVersion !== device.pendingCredentialVersion
        || rotationId !== device.rotationId
        || !device.pendingSecretHash) {
      return { device: publicDeviceForRequest(device), rotation: deviceRotationForRequest(device), reason: "pending_credential_required" };
    }
    if (Date.parse(device.rotationExpiresAt ?? "") <= requestNow()) {
      return { device: publicDeviceForRequest(device), rotation: deviceRotationForRequest(device), reason: "expired" };
    }
    const previousVersion = activeVersion;
    device.secretHash = device.pendingSecretHash;
    device.credentialVersion = device.pendingCredentialVersion;
    device.pendingSecretHash = null;
    device.pendingCredentialVersion = null;
    device.rotationCompletedAt = nowIso();
    audit({
      userId: device.userId ?? "system",
      actorType: "device",
      actorId: device.id,
      action: "device.secret_rotation_completed",
      targetId: device.id,
      metadata: {
        purpose: device.rotationPurpose,
        previousCredentialVersion: previousVersion,
        credentialVersion: device.credentialVersion,
      },
    });
    notifyChanged();
    return {
      device: publicDeviceForRequest(device),
      rotation: deviceRotationForRequest(device),
      promoted: true,
      replayed: false,
      reason: null,
    };
  }

  // Rotating on every call is what invalidated the printed label the moment a unit was powered on:
  // firmware asks for a setup code on its first 403, seconds after boot. The code now survives until
  // it expires, and only an explicit `rotate` — an owner or factory action — replaces it early.
  function ensureUnclaimedDeviceClaimCode({ deviceId, rotate = false }) {
    const device = devices.get(deviceId);
    if (!device || device.revokedAt || device.claimedAt) return null;
    const now = Date.now();
    if (!rotate && claimCodeIsLive(device, now)) {
      // Codes are stored hashed, so the plaintext cannot be handed back a second time — and should
      // not be. The device caches the code it was issued; "still valid" is the whole answer.
      return {
        device: publicDevice(device),
        claimCode: null,
        rotated: false,
        claimCodeExpiresAt: device.claimCodeExpiresAt ?? null,
      };
    }
    const claimCode = createHumanCode();
    device.claimCodeHash = hashSecret(normalizeClaimCode(claimCode));
    device.claimCodeExpiresAt = claimCodeExpiryFrom(now);
    audit({
      userId: "system",
      actorType: "device",
      actorId: device.id,
      action: "device.setup_code_rotated",
      targetId: device.id,
      metadata: { label: device.label, profile: device.profile, rotate },
    });
    notifyChanged();
    return {
      device: publicDevice(device),
      claimCode,
      rotated: true,
      claimCodeExpiresAt: device.claimCodeExpiresAt,
    };
  }

  function authenticateDevice(deviceId, secret) {
    const device = devices.get(deviceId);
    if (!device || device.revokedAt) return null;
    const candidateHash = hashSecret(secret);
    const activeVersion = device.credentialVersion ?? 1;
    let credentialState = "active";
    let authenticatedCredentialVersion = activeVersion;
    if (!safeEqual(device.secretHash, candidateHash)) {
      const pendingIsLive = device.pendingSecretHash
        && safeEqual(device.pendingSecretHash, candidateHash)
        && Date.parse(device.rotationExpiresAt ?? "") > requestNow();
      if (!pendingIsLive) return null;
      credentialState = "pending";
      authenticatedCredentialVersion = device.pendingCredentialVersion;
    }
    device.lastSeenAt = nowIso();
    notifyChanged();
    return deviceForGateway(device, authenticatedCredentialVersion, credentialState, requestNow());
  }

  function recordDeviceHeartbeat({ deviceId, status = {} }) {
    const device = devices.get(deviceId);
    if (!device || device.revokedAt) return null;
    const heartbeatAt = nowIso();

    // A heartbeat arriving after the device had gone offline is a reconnect. Recording it is what
    // makes "reliable device reconnect after Wi-Fi loss" measurable rather than guessed: an
    // offline gap alone cannot distinguish a reconnect from a device that never came back.
    const previousHeartbeatAt = Date.parse(device.status?.lastHeartbeatAt ?? "");
    const gapMs = Number.isFinite(previousHeartbeatAt)
      ? Date.parse(heartbeatAt) - previousHeartbeatAt
      : null;
    const reconnected = gapMs !== null && gapMs > DEVICE_ONLINE_THRESHOLD_MS;

    device.lastSeenAt = heartbeatAt;
    device.status = normalizeDeviceStatus(status, device.status, heartbeatAt);
    device.connectivity = {
      heartbeatCount: (device.connectivity?.heartbeatCount ?? 0) + 1,
      reconnectCount: (device.connectivity?.reconnectCount ?? 0) + (reconnected ? 1 : 0),
      lastReconnectAt: reconnected ? heartbeatAt : device.connectivity?.lastReconnectAt ?? null,
      longestOfflineMs: Math.max(device.connectivity?.longestOfflineMs ?? 0, reconnected ? gapMs : 0),
    };

    notifyChanged();
    return publicDevice(device);
  }

  function listDevices(userId) {
    return [...devices.values()]
      .filter((device) => device.userId === userId)
      .map(publicDeviceForRequest);
  }

  function getDeviceForUser(userId, deviceId) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId) return null;
    return publicDeviceForRequest(device);
  }

  // actorType defaults to "user" because the owner-facing PUT is the common path.
  // A device changing its own thread passes "device", so the audit trail does not
  // credit the owner with something the hardware did on its own.
  function updateDeviceConfig({ userId, deviceId, config, actorType = "user", actorId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    const previousLabel = device.label;
    if (Object.hasOwn(config, "label")) {
      device.label = normalizeNullableString(config.label) ?? device.label;
    }
    device.config = normalizeDeviceConfig(config, device.config);
    audit({
      userId,
      actorType,
      ...(actorId ? { actorId } : {}),
      action: "device.config_updated",
      targetId: device.id,
      metadata: {
        label: device.label,
        previousLabel,
        environmentId: device.config.environmentId,
        projectId: device.config.projectId,
        threadId: device.config.threadId,
        gatewayAccessMode: device.config.gatewayAccessMode,
        gatewayUrl: device.config.gatewayUrl,
        menu: device.config.menu,
      },
    });
    notifyChanged();
    return publicDevice(device);
  }

  /**
   * Records — or clears — this device's owner decision about auto-sending a voice transcript.
   *
   * Scoped to one device on purpose. Audio is captured by a particular microphone in a particular
   * room, so the trust question is about that unit — an account-wide switch would silently extend
   * the grant to the next controller the owner claims.
   *
   * `enabled` is a boolean for a decision and `null` to withdraw the decision entirely and go back
   * to whatever the hardware's default is. Those are three different answers, and the stored row
   * keeps them apart: without the third, "off" could not be told from "nobody has said", and the
   * default would keep overriding an owner who deliberately turned this off.
   */
  function setDeviceVoiceAutoSend({ userId, deviceId, enabled, actorId = null, actorType = "user" }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    const ownerChoice = enabled === true ? true : enabled === false ? false : null;
    device.voiceAutoSend = normalizeVoiceAutoSend(
      {
        ownerChoice,
        // Only a real grant carries a name. Clearing to the default must not leave one behind,
        // because a default has nobody behind it.
        enabledBy: ownerChoice === true ? actorId ?? userId : null,
        enabledAt: ownerChoice === true ? nowIso() : null,
      },
      deviceReportsMicrophone(device),
    );
    device.updatedAt = nowIso();
    audit({
      userId,
      actorType,
      ...(actorId ? { actorId } : {}),
      action: ownerChoice === true
        ? "device.voice_auto_send_enabled"
        : ownerChoice === false
          ? "device.voice_auto_send_disabled"
          : "device.voice_auto_send_reset",
      targetId: deviceId,
      metadata: device.voiceAutoSend,
    });
    notifyChanged();
    return publicDevice(device);
  }

  function createGatewayProfile({ userId, label, mode, url }) {
    const profile = { id: createId("gateway"), userId, label, mode, url, createdAt: nowIso(), updatedAt: nowIso() };
    gatewayProfiles.set(profile.id, profile);
    audit({ userId, actorType: "user", action: "gateway_profile.created", targetId: profile.id,
      metadata: { label, mode, origin: url } });
    notifyChanged();
    return { ...profile };
  }

  function listGatewayProfiles(userId) {
    return [...gatewayProfiles.values()].filter((profile) => profile.userId === userId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map((profile) => ({ ...profile }));
  }

  function getGatewayProfileForUser(userId, profileId) {
    const profile = gatewayProfiles.get(profileId);
    return profile?.userId === userId ? { ...profile } : null;
  }

  function updateGatewayProfile({ userId, profileId, label, mode, url }) {
    const profile = gatewayProfiles.get(profileId);
    if (!profile || profile.userId !== userId) return null;
    const deviceIds = [...devices.values()].filter((device) => device.userId === userId
      && [device.gatewaySelection?.activeProfileId, device.gatewaySelection?.pendingProfileId].includes(profileId))
      .map((device) => device.id);
    if (deviceIds.length && (profile.url !== url || profile.mode !== mode)) return { conflict: true, deviceIds };
    Object.assign(profile, { label, mode, url, updatedAt: nowIso() });
    audit({ userId, actorType: "user", action: "gateway_profile.updated", targetId: profile.id,
      metadata: { label, mode, origin: url } });
    notifyChanged();
    return { ...profile, conflict: false };
  }

  function deleteGatewayProfile({ userId, profileId }) {
    const profile = gatewayProfiles.get(profileId);
    if (!profile || profile.userId !== userId) return null;
    const deviceIds = [...devices.values()].filter((device) => device.userId === userId
      && [device.gatewaySelection?.activeProfileId, device.gatewaySelection?.pendingProfileId].includes(profileId))
      .map((device) => device.id);
    if (deviceIds.length) return { conflict: true, deviceIds };
    gatewayProfiles.delete(profileId);
    audit({ userId, actorType: "user", action: "gateway_profile.deleted", targetId: profileId,
      metadata: { label: profile.label, mode: profile.mode } });
    notifyChanged();
    return { profile: { ...profile }, conflict: false };
  }

  function getDeviceGatewaySelection({ userId, deviceId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId) return null;
    return normalizeGatewaySelection(device.gatewaySelection);
  }

  function stageDeviceGatewaySwitch({ userId, deviceId, profileId, actorType = "user", actorId = null }) {
    const device = devices.get(deviceId);
    const profile = gatewayProfiles.get(profileId);
    if (!device || device.userId !== userId || device.revokedAt || !profile || profile.userId !== userId) return null;
    const previous = normalizeGatewaySelection(device.gatewaySelection);
    device.gatewaySelection = {
      ...previous,
      revision: previous.revision + 1,
      state: "pending",
      previousProfileId: previous.activeProfileId,
      pendingProfileId: profileId,
      requestedAt: nowIso(),
      lastError: null,
    };
    audit({ userId, actorType, ...(actorId ? { actorId } : {}), action: "device.gateway_switch_requested",
      targetId: deviceId, metadata: { revision: device.gatewaySelection.revision, profileId } });
    notifyChanged();
    return structuredClone(device.gatewaySelection);
  }

  function reportDeviceGatewaySwitch({ userId, deviceId, revision, profileId, status, detail = null }) {
    const device = devices.get(deviceId);
    const profile = gatewayProfiles.get(profileId);
    if (!device || device.userId !== userId || device.revokedAt || !profile || profile.userId !== userId) return null;
    const previous = normalizeGatewaySelection(device.gatewaySelection);
    if (revision !== previous.revision) return { conflict: true, selection: previous };
    if (status === "requested") {
      const selection = stageDeviceGatewaySwitch({ userId, deviceId, profileId, actorType: "device", actorId: deviceId });
      return { conflict: false, selection };
    }
    if (status === "applied") {
      if (previous.pendingProfileId && previous.pendingProfileId !== profileId) return { conflict: true, selection: previous };
      device.gatewaySelection = {
        ...previous,
        revision: previous.pendingProfileId ? previous.revision : previous.revision + 1,
        state: "stable",
        previousProfileId: previous.activeProfileId,
        activeProfileId: profileId,
        pendingProfileId: null,
        appliedAt: nowIso(),
        lastError: null,
      };
    } else {
      if (previous.pendingProfileId && previous.pendingProfileId !== profileId) return { conflict: true, selection: previous };
      device.gatewaySelection = { ...previous, state: "failed", pendingProfileId: null,
        lastError: detail ?? "Gateway probe failed." };
    }
    audit({ userId, actorType: "device", actorId: deviceId,
      action: status === "applied" ? "device.gateway_switch_applied" : "device.gateway_switch_failed",
      targetId: deviceId, metadata: { revision: device.gatewaySelection.revision, profileId, detail } });
    notifyChanged();
    return { conflict: false, selection: structuredClone(device.gatewaySelection) };
  }

  function rollbackDeviceGatewaySwitch({ userId, deviceId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    const previous = normalizeGatewaySelection(device.gatewaySelection);
    device.gatewaySelection = { ...previous, revision: previous.revision + 1, state: "stable",
      pendingProfileId: null, lastError: null };
    audit({ userId, actorType: "user", action: "device.gateway_switch_rolled_back", targetId: deviceId,
      metadata: { revision: device.gatewaySelection.revision, activeProfileId: device.gatewaySelection.activeProfileId } });
    notifyChanged();
    return structuredClone(device.gatewaySelection);
  }

  function createAction(input) {
    const action = {
      id: createId("action"),
      userId: input.userId,
      type: input.type,
      label: input.label,
      payload: structuredClone(input.payload ?? {}),
      targetMode: input.targetMode ?? "device-current",
      environmentId: input.environmentId ?? null,
      threadId: input.threadId ?? null,
      steps: structuredClone(input.steps ?? []),
      disabled: input.disabled === true,
      disabledReason: input.disabled === true ? (input.disabledReason ?? null) : null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    actions.set(action.id, action);
    audit({
      userId: input.userId,
      actorType: "user",
      action: "action.created",
      targetId: action.id,
      metadata: { label: action.label, type: action.type, stepCount: action.steps.length },
    });
    notifyChanged();
    return publicAction(action);
  }

  function getActionForUser(userId, actionId) {
    const action = actions.get(actionId);
    return action?.userId === userId ? publicAction(action) : null;
  }

  function listActions(userId) {
    return [...actions.values()]
      .filter((action) => action.userId === userId)
      .map(publicAction);
  }

  function updateAction({ userId, actionId, ...input }) {
    const action = actions.get(actionId);
    if (!action || action.userId !== userId) return null;
    for (const key of ["type", "label", "targetMode", "environmentId", "threadId", "disabled", "disabledReason"]) {
      if (input[key] !== undefined) action[key] = input[key];
    }
    if (input.payload !== undefined) action.payload = structuredClone(input.payload);
    if (input.steps !== undefined) action.steps = structuredClone(input.steps);
    action.updatedAt = nowIso();
    audit({
      userId,
      actorType: "user",
      action: "action.updated",
      targetId: action.id,
      metadata: { label: action.label, type: action.type, stepCount: action.steps.length },
    });
    notifyChanged();
    return publicAction(action);
  }

  function deleteAction({ userId, actionId }) {
    const action = actions.get(actionId);
    if (!action || action.userId !== userId) return null;
    actions.delete(actionId);
    const unassignedDeviceIds = [];
    for (const controls of deviceControls.values()) {
      if (controls.userId !== userId) continue;
      const items = controls.items.filter((item) => item.actionId !== actionId);
      if (items.length === controls.items.length) continue;
      controls.items = items;
      controls.revision += 1;
      controls.updatedAt = nowIso();
      unassignedDeviceIds.push(controls.deviceId);
    }
    audit({
      userId,
      actorType: "user",
      action: "action.deleted",
      targetId: action.id,
      metadata: { label: action.label, type: action.type, unassignedDeviceIds },
    });
    notifyChanged();
    return { action: publicAction(action), unassignedDeviceIds };
  }

  function recordActionRun({ userId, actionId, actorType, actorId, status, intentType = null, commandIds = [] }) {
    audit({
      userId,
      actorType,
      actorId,
      action: `action.run_${status}`,
      targetId: actionId,
      metadata: { intentType, commandIds: [...commandIds] },
    });
    notifyChanged();
    return true;
  }

  function createMacroRun(input) {
    const run = {
      id: createId("macrorun"),
      userId: input.userId,
      actionId: input.actionId,
      approvalCommandId: input.approvalCommandId,
      nextStepIndex: input.nextStepIndex,
      runtime: structuredClone(input.runtime),
      actor: structuredClone(input.actor),
      policyContext: structuredClone(input.policyContext ?? {}),
      baseUrl: input.baseUrl ?? null,
      executions: structuredClone(input.executions ?? []),
      status: "waiting_approval",
      resumeAttempts: 0,
      resumeClaimedAt: null,
      result: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    macroRuns.set(run.id, run);
    notifyChanged();
    return structuredClone(run);
  }

  function getMacroRunForApproval({ userId, commandId }) {
    const run = [...macroRuns.values()].find((candidate) => candidate.userId === userId
      && candidate.approvalCommandId === commandId);
    return run ? structuredClone(run) : null;
  }

  function claimMacroRunForResume({ userId, runId, leaseMs = 30_000 }) {
    const run = macroRuns.get(runId);
    if (!run || run.userId !== userId) return null;
    const claimedAt = Date.parse(run.resumeClaimedAt ?? "");
    if (run.status === "resuming" && Number.isFinite(claimedAt) && Date.now() - claimedAt < leaseMs) return null;
    if (!["waiting_approval", "resuming"].includes(run.status)) return null;
    run.status = "resuming";
    run.resumeAttempts += 1;
    run.resumeClaimedAt = nowIso();
    run.updatedAt = nowIso();
    notifyChanged();
    return structuredClone(run);
  }

  function updateMacroRun({ userId, runId, ...input }) {
    const run = macroRuns.get(runId);
    if (!run || run.userId !== userId) return null;
    for (const key of ["approvalCommandId", "nextStepIndex", "status", "result"]) {
      if (input[key] !== undefined) run[key] = structuredClone(input[key]);
    }
    if (input.executions !== undefined) run.executions = structuredClone(input.executions);
    run.resumeClaimedAt = input.status === "waiting_approval" ? null : run.resumeClaimedAt;
    run.updatedAt = nowIso();
    notifyChanged();
    return structuredClone(run);
  }

  function getDeviceControls({ userId, deviceId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId) return null;
    return publicDeviceControls(deviceControls.get(deviceId) ?? createDefaultDeviceControls(device));
  }

  function updateDeviceControls({ userId, deviceId, items }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    const existing = deviceControls.get(deviceId) ?? createDefaultDeviceControls(device);
    const controls = {
      ...existing,
      explicit: true,
      userId,
      deviceId,
      revision: existing.revision + 1,
      items: structuredClone(items),
      updatedAt: nowIso(),
    };
    deviceControls.set(deviceId, controls);
    audit({
      userId,
      actorType: "user",
      action: "device.controls_updated",
      targetId: deviceId,
      metadata: { revision: controls.revision, itemCount: controls.items.length },
    });
    notifyChanged();
    return publicDeviceControls(controls);
  }

  function acknowledgeDeviceControls({
    userId,
    deviceId,
    revision,
    status = "applied",
    error = null,
    appliedCount = null,
    expectedCount = null,
  }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    const controls = deviceControls.get(deviceId) ?? createDefaultDeviceControls(device);
    if (!controls.explicit) return { controls: publicDeviceControls(controls), reason: "no_explicit_layout" };
    let reason = null;
    if (revision > controls.revision) reason = "future_revision";
    else if (revision < controls.revision) reason = "stale_revision";
    else if (appliedCount !== null && expectedCount !== null && appliedCount !== expectedCount) reason = "count_mismatch";
    if (reason) {
      controls.lastAckStatus = "rejected";
      controls.lastAckError = reason === "count_mismatch"
        ? `Device applied ${appliedCount} controls; gateway resolved ${expectedCount}.`
        : `Device acknowledged revision ${revision}; current revision is ${controls.revision}.`;
    } else {
      controls.appliedRevision = Math.max(controls.appliedRevision ?? 0, revision);
      controls.appliedAt = nowIso();
      controls.lastAckStatus = status;
      controls.lastAckError = error;
    }
    deviceControls.set(deviceId, controls);
    audit({
      userId,
      actorType: "device",
      actorId: deviceId,
      action: "device.controls_acknowledged",
      targetId: deviceId,
      metadata: { revision, status: controls.lastAckStatus, error: controls.lastAckError, appliedCount, expectedCount },
    });
    notifyChanged();
    return { controls: publicDeviceControls(controls), reason };
  }

  function getDeviceFirmwarePolicy({ userId, deviceId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId) return null;
    return normalizeFirmwarePolicy({}, device.firmwarePolicy);
  }

  function updateDeviceFirmwarePolicy({ userId, deviceId, policy, actorType = "user", actorId }) {
    const device = devices.get(deviceId);
    if (!device || device.userId !== userId || device.revokedAt) return null;
    device.firmwarePolicy = normalizeFirmwarePolicy(policy, device.firmwarePolicy);
    audit({
      userId,
      actorType,
      ...(actorId ? { actorId } : {}),
      action: actorType === "device" ? "device.firmware_reported" : "device.firmware_policy_updated",
      targetId: deviceId,
      metadata: device.firmwarePolicy,
    });
    notifyChanged();
    return { ...device.firmwarePolicy };
  }

  function upsertEnvironment(input) {
    const user = ensureUser({ userId: input.userId });
    const transportMode = input.transportMode === "connector" ? "connector" : "direct";
    const normalizedBaseUrl = transportMode === "direct" ? String(input.baseUrl).replace(/\/+$/u, "") : null;
    const existing = input.id
      ? environments.get(input.id)
      : [...environments.values()]
        .filter((environment) => environment.userId === user.id
          && transportMode === "direct"
          && (environment.transportMode ?? "direct") === "direct"
          && environment.baseUrl === normalizedBaseUrl)
        .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0] ?? null;
    if (input.id && (!existing || existing.userId !== user.id)) return null;
    const environment = {
      id: existing?.id ?? createId("env"),
      userId: user.id,
      label: input.label,
      baseUrl: normalizedBaseUrl,
      transportMode,
      connectorId: transportMode === "connector" ? (input.connectorId ?? existing?.connectorId ?? null) : null,
      ...(transportMode === "direct"
        ? (t3TokenBox.enabled
          ? { accessTokenCiphertext: t3TokenBox.seal(input.accessToken) }
          : { accessToken: input.accessToken })
        : {}),
      scopes: input.scopes,
      accessTokenExpiresAt: normalizeNullableString(input.accessTokenExpiresAt) ?? null,
      status: input.status ?? "unknown",
      health: normalizeEnvironmentHealth(input.health, existing?.health),
      // Re-pairing must not discard the registered harness catalogue.
      ...(existing?.providerCatalogue ? { providerCatalogue: existing.providerCatalogue } : {}),
      createdAt: input.createdAt ?? existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    environments.set(environment.id, environment);
    audit({
      userId: user.id,
      actorType: "user",
      action: "environment.upserted",
      targetId: environment.id,
      metadata: {
        label: environment.label,
        baseUrl: environment.baseUrl,
        transportMode: environment.transportMode,
        scopes: environment.scopes,
      },
    });
    notifyChanged();
    return publicEnvironment(environment);
  }

  function disconnectEnvironmentReferences({ userId, environmentId }) {
    const removed = emptyEnvironmentRemoval();
    for (const device of devices.values()) {
      if (device.userId !== userId || device.config?.environmentId !== environmentId) continue;
      device.config = normalizeDeviceConfig(
        { ...device.config, environmentId: null, projectId: null, threadId: null },
        device.config,
      );
      removed.devices.push(device.id);
    }
    for (const action of actions.values()) {
      if (action.userId !== userId || action.environmentId !== environmentId) continue;
      action.environmentId = null;
      action.threadId = null;
      action.targetMode = "device-current";
      action.disabled = true;
      action.disabledReason = ENVIRONMENT_REMOVED_REASON;
      action.updatedAt = nowIso();
      removed.actions.push(action.id);
    }
    for (const macro of macros.values()) {
      if (macro.userId !== userId || macro.environmentId !== environmentId) continue;
      macro.environmentId = null;
      macro.threadId = null;
      macro.disabled = true;
      macro.disabledReason = ENVIRONMENT_REMOVED_REASON;
      macro.updatedAt = nowIso();
      removed.macros.push(macro.id);
    }
    const user = users.get(userId);
    const onboarding = user ? normalizeStoredOnboarding(user.onboarding) : null;
    if (onboarding?.environmentId === environmentId) {
      user.onboarding = {
        ...onboarding,
        environmentId: null,
        firstThreadId: null,
        updatedAt: nowIso(),
      };
      removed.onboarding = true;
    }
    return removed;
  }

  function archiveEnvironment({ userId, environmentId, retentionDays = 30, at = nowIso() }) {
    const environment = environments.get(environmentId);
    if (!environment || environment.userId !== userId) return null;
    if (environment.archivedAt) {
      return { environment: publicEnvironment(environment), removed: emptyEnvironmentRemoval(), alreadyArchived: true };
    }
    const removed = disconnectEnvironmentReferences({ userId, environmentId });
    const archivedAt = at;
    environment.archivedAt = archivedAt;
    environment.deletedAt = archivedAt;
    environment.purgeAfter = new Date(Date.parse(archivedAt) + Math.max(1, retentionDays) * 86_400_000).toISOString();
    environment.status = "archived";
    environment.accessTokenExpiresAt = null;
    environment.updatedAt = archivedAt;
    delete environment.accessToken;
    delete environment.accessTokenCiphertext;
    delete environment.providerCatalogue;
    const revokedConnectorIds = [];
    for (const connector of connectors.values()) {
      if (connector.userId !== userId || connector.environmentId !== environmentId || connector.revokedAt) continue;
      connector.revokedAt = archivedAt;
      connector.updatedAt = archivedAt;
      connector.status = "revoked";
      connector.lastDisconnectReason = "environment_removed";
      connector.secretHash = null;
      connector.pendingSecretHash = null;
      connector.pendingSecretPrefix = null;
      connector.pendingCredentialVersion = null;
      connector.rotationId = null;
      connector.rotationExpiresAt = null;
      for (const ticket of connectorTickets.values()) {
        if (ticket.connectorId === connector.id && !ticket.consumedAt) ticket.consumedAt = archivedAt;
      }
      revokedConnectorIds.push(connector.id);
    }
    audit({
      userId,
      actorType: "user",
      action: "environment.archived",
      targetId: environment.id,
      metadata: {
        label: environment.label,
        retentionUntil: environment.purgeAfter,
        revokedConnectorIds,
        clearedDeviceIds: removed.devices,
        disabledActionIds: removed.actions,
        disabledMacroIds: removed.macros,
        clearedOnboarding: removed.onboarding,
      },
    });
    notifyChanged();
    return { environment: publicEnvironment(environment), removed, revokedConnectorIds, alreadyArchived: false };
  }

  function restoreEnvironment({ userId, environmentId, at = nowIso() }) {
    const environment = environments.get(environmentId);
    if (!environment || environment.userId !== userId) return null;
    if (!environment.archivedAt) return { expired: false, alreadyRestored: true, environment: publicEnvironment(environment) };
    if (Date.parse(environment.purgeAfter ?? "") <= Date.parse(at)) return { expired: true, environment: publicEnvironment(environment) };
    delete environment.archivedAt;
    delete environment.deletedAt;
    delete environment.purgeAfter;
    environment.connectorId = null;
    environment.status = "needs_repair";
    environment.freshness = "unknown";
    environment.updatedAt = at;
    audit({
      userId,
      actorType: "user",
      action: "environment.restored",
      targetId: environment.id,
      metadata: { label: environment.label, requiresRepair: true },
    });
    notifyChanged();
    return { expired: false, alreadyRestored: false, environment: publicEnvironment(environment) };
  }

  function listExpiredEnvironments({ userId, now = nowIso() }) {
    const timestamp = Date.parse(now);
    return [...environments.values()]
      .filter((environment) => environment.userId === userId
        && Boolean(environment.archivedAt)
        && Number.isFinite(Date.parse(environment.purgeAfter ?? ""))
        && Date.parse(environment.purgeAfter) <= timestamp)
      .map(publicEnvironment);
  }

  function purgeEnvironment({ userId, environmentId, now = nowIso(), force = false }) {
    const environment = environments.get(environmentId);
    if (!environment || environment.userId !== userId || !environment.archivedAt) return null;
    if (!force && Date.parse(environment.purgeAfter ?? "") > Date.parse(now)) return { notDue: true, environment: publicEnvironment(environment) };
    environments.delete(environmentId);
    audit({
      userId,
      actorType: "system",
      action: "environment.purged",
      targetId: environment.id,
      metadata: { label: environment.label, retentionExpired: !force },
    });
    notifyChanged();
    return { notDue: false, environment: publicEnvironment(environment) };
  }

  function updateEnvironmentCatalogue({ userId, environmentId, catalogue }) {
    const environment = environments.get(environmentId);
    if (!environment || environment.userId !== userId || environment.archivedAt) return null;
    environment.providerCatalogue = catalogue;
    environment.updatedAt = nowIso();
    audit({
      userId,
      actorType: "user",
      action: "environment.catalogue_updated",
      targetId: environment.id,
      metadata: {
        source: catalogue?.source ?? null,
        instanceCount: catalogue?.instances?.length ?? 0,
        instanceIds: (catalogue?.instances ?? []).map((instance) => instance.instanceId),
      },
    });
    notifyChanged();
    return publicEnvironment(environment);
  }

  // Nothing may keep pointing at a removed environment. A fixed-target action or macro without an
  // environmentId is a row `normalizeActionInput` would refuse to create, so an orphan is disabled
  // with a reason rather than silently retargeted at whatever the device happens to be using.
  function deleteEnvironment({ userId, environmentId }) {
    const environment = environments.get(environmentId);
    if (!environment || environment.userId !== userId) return null;
    environments.delete(environmentId);
    const removed = disconnectEnvironmentReferences({ userId, environmentId });
    audit({
      userId,
      actorType: "user",
      action: "environment.deleted",
      targetId: environment.id,
      metadata: {
        label: environment.label,
        baseUrl: environment.baseUrl,
        clearedDeviceIds: removed.devices,
        disabledActionIds: removed.actions,
        disabledMacroIds: removed.macros,
        clearedOnboarding: removed.onboarding,
      },
    });
    notifyChanged();
    return { environment: publicEnvironment(environment), removed };
  }

  function updateEnvironmentHealth({ userId, environmentId, status, health }) {
    const environment = environments.get(environmentId);
    if (!environment || environment.userId !== userId || environment.archivedAt) return null;
    const nextHealth = normalizeEnvironmentHealth(health, environment.health);
    environment.status = status ?? environment.status;
    environment.health = nextHealth;
    environment.updatedAt = nowIso();
    audit({
      userId,
      actorType: "user",
      action: "environment.health_checked",
      targetId: environment.id,
      metadata: {
        label: environment.label,
        status: environment.status,
        lastError: nextHealth.lastError,
      },
    });
    notifyChanged();
    return publicEnvironment(environment);
  }

  function getEnvironmentForUser(userId, environmentId) {
    const environment = environments.get(environmentId);
    if (!environment || environment.userId !== userId || environment.archivedAt) return null;
    return environmentForGateway(environment, t3TokenBox);
  }

  function listEnvironments(userId) {
    const uniqueByTransportTarget = new Map();
    for (const environment of [...environments.values()]
      .filter((item) => item.userId === userId && !item.archivedAt)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))) {
      const key = (environment.transportMode ?? "direct") === "connector"
        ? `connector:${environment.id}`
        : `direct:${environment.baseUrl}`;
      if (!uniqueByTransportTarget.has(key)) uniqueByTransportTarget.set(key, environment);
    }
    return [...uniqueByTransportTarget.values()].map(publicEnvironment);
  }

  function listArchivedEnvironments(userId) {
    return [...environments.values()]
      .filter((item) => item.userId === userId && Boolean(item.archivedAt))
      .sort((left, right) => Date.parse(right.archivedAt) - Date.parse(left.archivedAt))
      .map(publicEnvironment);
  }

  // Console-first pairing. The console mints one of these while the user is signed in; the setup
  // script on the T3 host redeems it with no platform credential of its own. See
  // src/connectSession.mjs for why the code — not a token — is what travels.
  function createConnectSession({ userId, label, accessMode, environmentId = null, purpose = "t3_enrollment" }) {
    const user = ensureUser({ userId });
    const code = createHumanCode();
    const timestamp = nowIso();
    const session = {
      id: createId("cxn"),
      userId: user.id,
      label: label || "T3 Code",
      accessMode: normalizeConnectAccessMode(accessMode),
      purpose: purpose === "connector_rotation" ? "connector_rotation" : "t3_enrollment",
      // Set only when re-pairing. It is what keeps a re-pair updating the existing row instead of
      // adding a second one for the same host.
      environmentId: environmentId ?? null,
      status: "pending",
      codeHash: hashSecret(normalizeClaimCode(code)),
      expiresAt: new Date(Date.now() + CONNECT_SESSION_TTL_MS).toISOString(),
      baseUrl: null,
      error: null,
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    connectSessions.set(session.id, session);
    audit({
      userId: user.id,
      actorType: "user",
      action: "connect_session.created",
      targetId: session.id,
      metadata: { label: session.label, accessMode: session.accessMode, environmentId: session.environmentId },
    });
    notifyChanged();
    return { session: publicConnectSession(session), code };
  }

  function getConnectSession({ userId, sessionId }) {
    const session = connectSessions.get(sessionId);
    if (!session || session.userId !== userId) return null;
    return publicConnectSession(expireConnectSessionIfDue(session));
  }

  // Consumes the code before the caller does any network work. The exchange that follows can fail,
  // and burning the code either way is the point: a code that survives a failed attempt is a code
  // that can be replayed.
  function claimConnectSession({ code }) {
    const claimHash = hashSecret(normalizeClaimCode(code));
    for (const session of connectSessions.values()) {
      if (!session.codeHash || !safeEqual(session.codeHash, claimHash)) continue;
      if (expireConnectSessionIfDue(session).status === "expired") {
        notifyChanged();
        // Matched but refused, so the host can say "expired" rather than the indistinguishable
        // "no such code" a `continue` would produce.
        return { session: null, reason: "expired" };
      }
      if (session.status !== "pending") return { session: null, reason: "used" };
      session.status = "redeeming";
      session.updatedAt = nowIso();
      notifyChanged();
      return { session: publicConnectSession(session), reason: null };
    }
    return { session: null, reason: "unknown" };
  }

  function completeConnectSession({ sessionId, environmentId = null, baseUrl = null, error = null }) {
    const session = connectSessions.get(sessionId);
    if (!session) return null;
    session.status = error ? "failed" : "completed";
    session.environmentId = environmentId ?? session.environmentId;
    session.baseUrl = baseUrl ?? session.baseUrl;
    session.error = error ?? null;
    session.codeHash = null;
    session.completedAt = nowIso();
    session.updatedAt = session.completedAt;
    audit({
      userId: session.userId,
      actorType: "user",
      action: error ? "connect_session.failed" : "connect_session.completed",
      targetId: session.id,
      metadata: { environmentId: session.environmentId, baseUrl: session.baseUrl, error: session.error },
    });
    notifyChanged();
    return publicConnectSession(session);
  }

  function createConnector({ userId, environmentId, label = "T3 Connector", scopes = [], protocolVersion = CONNECTOR_PROTOCOL_VERSION, connectorVersion = null, platform = null, capabilities = [] }) {
    const environment = environments.get(environmentId);
    if (!environment || environment.userId !== userId || environment.archivedAt) return null;
    const secret = createSecret();
    const timestamp = nowIso();
    // Re-enrollment is rotation-by-replacement: at most one standing credential may route an
    // environment. Keeping the old connector active would let a copied secret survive repair.
    for (const existingConnector of connectors.values()) {
      if (existingConnector.environmentId !== environmentId || existingConnector.revokedAt) continue;
      existingConnector.revokedAt = timestamp;
      existingConnector.updatedAt = timestamp;
      existingConnector.status = "revoked";
      existingConnector.lastDisconnectReason = "superseded_by_reenrollment";
      existingConnector.secretHash = null;
      existingConnector.pendingSecretHash = null;
      existingConnector.pendingSecretPrefix = null;
      existingConnector.pendingCredentialVersion = null;
      existingConnector.rotationId = null;
      existingConnector.rotationExpiresAt = null;
      for (const ticket of connectorTickets.values()) {
        if (ticket.connectorId === existingConnector.id && !ticket.consumedAt) ticket.consumedAt = timestamp;
      }
    }
    const connector = {
      id: createId("ctr"),
      userId,
      environmentId,
      label,
      secretHash: hashSecret(secret),
      secretPrefix: secret.slice(0, 8),
      credentialVersion: 1,
      pendingSecretHash: null,
      pendingSecretPrefix: null,
      pendingCredentialVersion: null,
      rotationId: null,
      rotationStartedAt: null,
      rotationExpiresAt: null,
      rotationCompletedAt: null,
      scopes: [...new Set(scopes)],
      status: "enrolled",
      protocolVersion,
      connectorVersion,
      t3Version: null,
      platform,
      capabilities: [...new Set(capabilities)],
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
    };
    connectors.set(connector.id, connector);
    environment.transportMode = "connector";
    environment.connectorId = connector.id;
    environment.lastConnectorSeenAt = null;
    environment.freshness = "unknown";
    environment.updatedAt = timestamp;
    audit({
      userId,
      actorType: "user",
      action: "connector.enrolled",
      targetId: connector.id,
      metadata: { environmentId, protocolVersion, scopes: connector.scopes },
    });
    notifyChanged();
    return { connector: publicConnector(connector), secret };
  }

  function authenticateConnector(connectorId, secret) {
    const connector = connectors.get(connectorId);
    if (!connector || connector.revokedAt || !secret) return null;
    const candidateHash = hashSecret(secret);
    const activeVersion = connector.credentialVersion ?? 1;
    if (safeEqual(connector.secretHash, candidateHash)) {
      return connectorForGateway(connector, activeVersion, "active", null);
    }
    const pendingIsLive = connector.pendingSecretHash
      && connector.pendingCredentialVersion === activeVersion + 1
      && Date.parse(connector.rotationExpiresAt ?? "") > Date.now();
    if (!pendingIsLive || !safeEqual(connector.pendingSecretHash, candidateHash)) return null;
    return connectorForGateway(connector, connector.pendingCredentialVersion, "pending", connector.rotationId);
  }

  // Self-revocation is the sole operation for which a revoked credential remains a
  // verifier. Keeping the final high-entropy hash (never the secret) makes a lost
  // HTTP response safely retryable; normal connector authentication still rejects
  // revoked rows before comparing either credential generation.
  function authenticateConnectorForRevocation(connectorId, secret) {
    const connector = connectors.get(connectorId);
    if (!connector || !secret) return null;
    const candidateHash = hashSecret(secret);
    if (safeEqual(connector.secretHash, candidateHash)) {
      return connectorForGateway(connector, connector.credentialVersion ?? 1, "active", null);
    }
    if (connector.revokedAt) return null;
    const activeVersion = connector.credentialVersion ?? 1;
    const pendingIsLive = connector.pendingSecretHash
      && connector.pendingCredentialVersion === activeVersion + 1
      && Date.parse(connector.rotationExpiresAt ?? "") > Date.now();
    if (!pendingIsLive || !safeEqual(connector.pendingSecretHash, candidateHash)) return null;
    return connectorForGateway(connector, connector.pendingCredentialVersion, "pending", connector.rotationId);
  }

  function beginConnectorCredentialRotation({ userId, connectorId, expiresAt = null }) {
    const connector = connectors.get(connectorId);
    if (!connector || connector.userId !== userId || connector.revokedAt) return null;
    const secret = createSecret();
    const timestamp = nowIso();
    const requestedExpiry = Date.parse(expiresAt ?? "");
    const boundedExpiry = new Date(Math.min(
      Number.isFinite(requestedExpiry) ? requestedExpiry : Date.now() + CONNECTOR_ROTATION_TTL_MS,
      Date.now() + CONNECTOR_ROTATION_TTL_MS,
    )).toISOString();
    const activeVersion = connector.credentialVersion ?? 1;
    connector.pendingSecretHash = hashSecret(secret);
    connector.pendingSecretPrefix = secret.slice(0, 8);
    connector.pendingCredentialVersion = activeVersion + 1;
    connector.rotationId = createId("crt");
    connector.rotationStartedAt = timestamp;
    connector.rotationExpiresAt = boundedExpiry;
    connector.rotationCompletedAt = null;
    connector.updatedAt = timestamp;
    // Tickets from an abandoned staged generation are invalid. Active-generation
    // tickets remain usable until the new credential proves a socket connection.
    for (const ticket of connectorTickets.values()) {
      if (ticket.connectorId === connectorId
        && (ticket.credentialVersion ?? 1) !== activeVersion
        && !ticket.consumedAt) ticket.consumedAt = timestamp;
    }
    audit({
      userId,
      actorType: "user",
      action: "connector.rotation-started",
      targetId: connectorId,
      metadata: { rotationId: connector.rotationId, expiresAt: boundedExpiry },
    });
    notifyChanged();
    return {
      connector: publicConnector(connector),
      rotation: { id: connector.rotationId, expiresAt: boundedExpiry },
      secret,
    };
  }

  function listConnectors(userId) {
    return [...connectors.values()]
      .filter((connector) => connector.userId === userId)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .map(publicConnector);
  }

  function listBackgroundWorkUsers({ afterUserId = null, limit = 100 } = {}) {
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
    const ordered = [...users.keys()].sort();
    const remaining = afterUserId ? ordered.filter((userId) => userId > afterUserId) : ordered;
    const page = remaining.slice(0, bounded);
    return {
      userIds: page,
      nextCursor: remaining.length > bounded ? page.at(-1) : null,
    };
  }

  function getConnectorForUser(userId, connectorId) {
    const connector = connectors.get(connectorId);
    return connector?.userId === userId ? publicConnector(connector) : null;
  }

  function revokeConnector({ userId, connectorId, reason = "revoked_by_user" }) {
    const connector = connectors.get(connectorId);
    if (!connector || connector.userId !== userId) return null;
    if (!connector.revokedAt) {
      connector.revokedAt = nowIso();
      connector.updatedAt = connector.revokedAt;
      connector.status = "revoked";
      connector.lastDisconnectReason = reason;
      connector.secretHash = null;
      connector.pendingSecretHash = null;
      connector.pendingSecretPrefix = null;
      connector.pendingCredentialVersion = null;
      connector.rotationId = null;
      connector.rotationExpiresAt = null;
      for (const ticket of connectorTickets.values()) {
        if (ticket.connectorId === connectorId && !ticket.consumedAt) ticket.consumedAt = connector.revokedAt;
      }
      audit({ userId, actorType: "user", action: "connector.revoked", targetId: connectorId, metadata: { reason } });
      notifyChanged();
    }
    return publicConnector(connector);
  }

  function revokeConnectorByCredential({ connectorId, secret, reason = "revoked_by_connector" }) {
    const connector = connectors.get(connectorId);
    if (!connector || !secret) return null;
    const candidateHash = hashSecret(secret);
    const activeVersion = connector.credentialVersion ?? 1;
    const activeMatches = safeEqual(connector.secretHash, candidateHash);
    const pendingMatches = !connector.revokedAt
      && connector.pendingSecretHash
      && connector.pendingCredentialVersion === activeVersion + 1
      && Date.parse(connector.rotationExpiresAt ?? "") > Date.now()
      && safeEqual(connector.pendingSecretHash, candidateHash);
    if (!activeMatches && !pendingMatches) return null;
    if (!connector.revokedAt) {
      connector.revokedAt = nowIso();
      connector.updatedAt = connector.revokedAt;
      connector.status = "revoked";
      connector.lastDisconnectReason = reason;
      // Preserve only the credential hash that authorized this operation so the
      // exact self-revocation can be retried after an interrupted response.
      connector.secretHash = candidateHash;
      connector.pendingSecretHash = null;
      connector.pendingSecretPrefix = null;
      connector.pendingCredentialVersion = null;
      connector.rotationId = null;
      connector.rotationExpiresAt = null;
      for (const ticket of connectorTickets.values()) {
        if (ticket.connectorId === connectorId && !ticket.consumedAt) ticket.consumedAt = connector.revokedAt;
      }
      audit({ userId: connector.userId, actorType: "connector", action: "connector.self-revoked", targetId: connectorId, metadata: { reason } });
      notifyChanged();
    }
    return publicConnector(connector);
  }

  function createConnectorTicket({ connectorId, audience = CONNECTOR_TICKET_AUDIENCE, credentialVersion = null, rotationId = null }) {
    const connector = connectors.get(connectorId);
    if (!connector || connector.revokedAt) return null;
    const activeVersion = connector.credentialVersion ?? 1;
    const requestedVersion = credentialVersion ?? activeVersion;
    const validPending = requestedVersion === connector.pendingCredentialVersion
      && rotationId === connector.rotationId
      && Date.parse(connector.rotationExpiresAt ?? "") > Date.now();
    if ((requestedVersion !== activeVersion || rotationId !== null) && !validPending) return null;
    const token = createSecret();
    const createdAt = nowIso();
    const ticket = {
      id: createId("ctk"),
      connectorId,
      environmentId: connector.environmentId,
      audience,
      credentialVersion: requestedVersion,
      rotationId: validPending ? connector.rotationId : null,
      tokenHash: hashSecret(token),
      createdAt,
      expiresAt: new Date(Date.now() + CONNECTOR_TICKET_TTL_MS).toISOString(),
      consumedAt: null,
    };
    connectorTickets.set(ticket.id, ticket);
    connector.lastSeenAt = createdAt;
    connector.updatedAt = createdAt;
    notifyChanged();
    return { ticket: token, expiresAt: ticket.expiresAt };
  }

  function consumeConnectorTicket({ ticket, audience = null, now = Date.now() }) {
    const candidateHash = hashSecret(ticket ?? "");
    for (const record of connectorTickets.values()) {
      if (!safeEqual(record.tokenHash, candidateHash)) continue;
      if (record.consumedAt) return { connector: null, reason: "used" };
      if (Date.parse(record.expiresAt) <= now) return { connector: null, reason: "expired" };
      if (audience !== null && record.audience !== audience) return { connector: null, reason: "audience" };
      const connector = connectors.get(record.connectorId);
      if (!connector || connector.revokedAt) return { connector: null, reason: "revoked" };
      const activeVersion = connector.credentialVersion ?? 1;
      const ticketVersion = record.credentialVersion ?? 1;
      const commitsRotation = Boolean(ticketVersion === connector.pendingCredentialVersion
        && record.rotationId === connector.rotationId
        && connector.pendingSecretHash
        && Date.parse(connector.rotationExpiresAt ?? "") > now);
      if (ticketVersion !== activeVersion && !commitsRotation) {
        return { connector: null, reason: "stale_credential" };
      }
      record.consumedAt = nowIso();
      if (commitsRotation) {
        const previousVersion = activeVersion;
        connector.secretHash = connector.pendingSecretHash;
        connector.secretPrefix = connector.pendingSecretPrefix;
        connector.credentialVersion = connector.pendingCredentialVersion;
        connector.pendingSecretHash = null;
        connector.pendingSecretPrefix = null;
        connector.pendingCredentialVersion = null;
        connector.rotationCompletedAt = record.consumedAt;
        connector.rotationExpiresAt = null;
        const completedRotationId = connector.rotationId;
        connector.rotationId = null;
        for (const other of connectorTickets.values()) {
          if (other.id !== record.id && other.connectorId === connector.id
            && (other.credentialVersion ?? 1) === previousVersion && !other.consumedAt) {
            other.consumedAt = record.consumedAt;
          }
        }
        audit({
          userId: connector.userId,
          actorType: "connector",
          action: "connector.rotation-completed",
          targetId: connector.id,
          metadata: { rotationId: completedRotationId, credentialVersion: connector.credentialVersion },
        });
      }
      connector.lastConnectedAt = record.consumedAt;
      connector.lastSeenAt = record.consumedAt;
      connector.status = "online";
      connector.updatedAt = record.consumedAt;
      const environment = environments.get(connector.environmentId);
      if (environment) {
        environment.lastConnectorSeenAt = record.consumedAt;
        environment.freshness = "live";
        environment.updatedAt = record.consumedAt;
      }
      notifyChanged();
      return {
        connector: connectorForGateway(connector, ticketVersion, commitsRotation ? "rotated" : "active"),
        ticket: publicConnectorTicket(record),
        reason: null,
      };
    }
    return { connector: null, reason: "unknown" };
  }

  function recordConnectorPresence({
    connectorId,
    environmentId = null,
    connectorVersion,
    t3Version,
    platform,
    capabilities,
    t3Health = null,
    activeRequests = null,
    queueDepth = null,
    providerCatalogue = null,
    connectionId = null,
    occurredAt = null,
    eventKey = null,
    connected = true,
    disconnectReason = null,
  }) {
    const connector = connectors.get(connectorId);
    if (!connector || connector.revokedAt || (environmentId && connector.environmentId !== environmentId)) return null;
    if (Number.isFinite(occurredAt)) {
      if (Number.isFinite(connector.lastPresenceEventAt) && occurredAt < connector.lastPresenceEventAt) {
        return publicConnector(connector);
      }
      if (eventKey && connector.lastPresenceEventKey === eventKey) return publicConnector(connector);
    }
    const previousStatus = connector.status;
    const timestamp = nowIso();
    connector.connectorVersion = connectorVersion ?? connector.connectorVersion;
    connector.t3Version = t3Version ?? connector.t3Version;
    connector.platform = platform ?? connector.platform;
    connector.capabilities = Array.isArray(capabilities) ? [...new Set(capabilities)] : connector.capabilities;
    connector.lastSeenAt = timestamp;
    connector.status = connected ? "online" : "offline";
    if (connected) connector.lastConnectedAt ??= timestamp;
    connector.lastDisconnectReason = disconnectReason;
    connector.lastT3Health = t3Health;
    connector.lastT3HealthAt = t3Health ? timestamp : connector.lastT3HealthAt;
    if (Number.isSafeInteger(activeRequests)) connector.activeRequests = activeRequests;
    if (Number.isSafeInteger(queueDepth)) connector.queueDepth = queueDepth;
    if (Number.isFinite(occurredAt)) connector.lastPresenceEventAt = occurredAt;
    if (eventKey) connector.lastPresenceEventKey = eventKey;
    if (connectionId) connector.lastConnectionId = connectionId;
    connector.updatedAt = timestamp;
    const environment = environments.get(connector.environmentId);
    if (environment) {
      if (providerCatalogue) environment.providerCatalogue = providerCatalogue;
      environment.lastConnectorSeenAt = timestamp;
      environment.freshness = connected ? "live" : "stale";
      environment.updatedAt = timestamp;
    }
    notifyChanged();
    return { ...publicConnector(connector), _previousStatus: previousStatus };
  }

  // The hash survives an expiry so a late redeem still reports "expired" rather than "unknown"; it
  // is cleared only when the session reaches a terminal state, which is what makes a replayed code
  // indistinguishable from one that never existed.
  function expireConnectSessionIfDue(session) {
    if (session.status !== "pending") return session;
    if (Date.parse(session.expiresAt) > Date.now()) return session;
    session.status = "expired";
    session.updatedAt = nowIso();
    return session;
  }

  function createFirmwareRelease(input) {
    const release = {
      id: createId("fw"),
      version: input.version,
      channel: input.channel ?? "stable",
      hardwareModel: input.hardwareModel,
      url: input.url,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      mandatory: input.mandatory,
      releaseNotes: input.releaseNotes ?? "",
      artifactKey: input.artifactKey ?? null,
      artifactProvider: input.artifactProvider ?? null,
      createdAt: nowIso(),
    };
    firmwareReleases.set(release.id, release);
    audit({
      userId: "system",
      actorType: "system",
      action: "firmware.release_created",
      targetId: release.id,
      metadata: {
        version: release.version,
        channel: release.channel,
        hardwareModel: release.hardwareModel,
        mandatory: release.mandatory,
      },
    });
    notifyChanged();
    return release;
  }

  function listFirmwareReleases({ hardwareModel, channel } = {}) {
    return [...firmwareReleases.values()]
      .filter((release) => (!hardwareModel || release.hardwareModel === hardwareModel)
        && (!channel || (release.channel ?? "stable") === channel))
      .map(publicFirmwareRelease)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  function deleteFirmwareRelease(releaseId) {
    const release = firmwareReleases.get(releaseId);
    if (!release) return null;
    firmwareReleases.delete(releaseId);
    audit({
      userId: "system",
      actorType: "system",
      action: "firmware.release_deleted",
      targetId: releaseId,
      metadata: { version: release.version, channel: release.channel, hardwareModel: release.hardwareModel },
    });
    notifyChanged();
    return { ...release };
  }

  function getLatestFirmwareRelease({ hardwareModel, channel }) {
    return listFirmwareReleases({ hardwareModel, channel }).at(-1) ?? null;
  }

  function getFirmwareArtifact({ sha256, hardwareModel = null }) {
    const release = [...firmwareReleases.values()].find((candidate) => candidate.sha256 === sha256
      && candidate.artifactKey && (!hardwareModel || candidate.hardwareModel === hardwareModel));
    return release ? { ...release } : null;
  }

  function createReleaseRollout(input) {
    const timestamp = nowIso();
    const rollout = {
      id: createId("rol"),
      userId: input.userId,
      name: input.name,
      targetKind: input.targetKind,
      targetVersion: input.targetVersion,
      rollbackVersion: input.rollbackVersion ?? null,
      releaseId: input.releaseId ?? null,
      channel: input.channel,
      cohort: input.cohort,
      minimumProtocolVersion: input.minimumProtocolVersion ?? 1,
      requiredCapabilities: [...new Set(input.requiredCapabilities ?? [])],
      state: "draft",
      evidenceRef: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      completedAt: null,
    };
    releaseRollouts.set(rollout.id, rollout);
    audit({
      userId: input.userId,
      actorType: "user",
      action: "release_rollout.created",
      targetId: rollout.id,
      metadata: {
        targetKind: rollout.targetKind,
        targetVersion: rollout.targetVersion,
        channel: rollout.channel,
        cohortType: rollout.cohort.type,
      },
    });
    notifyChanged();
    return publicReleaseRollout(rollout, rolloutAssignments);
  }

  function listReleaseRollouts(userId, { states = null } = {}) {
    const allowed = Array.isArray(states) ? new Set(states) : null;
    return [...releaseRollouts.values()]
      .filter((rollout) => rollout.userId === userId && (!allowed || allowed.has(rollout.state)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((rollout) => publicReleaseRollout(rollout, rolloutAssignments));
  }

  function listRunnableReleaseRollouts({ limit = 25 } = {}) {
    return [...releaseRollouts.values()]
      .filter((rollout) => ["running", "rolling_back"].includes(rollout.state))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 25)))
      .map((rollout) => ({ ...rollout, cohort: cloneRolloutCohort(rollout.cohort), requiredCapabilities: [...rollout.requiredCapabilities] }));
  }

  function getReleaseRolloutForUser(userId, rolloutId) {
    const rollout = releaseRollouts.get(rolloutId);
    return rollout?.userId === userId ? publicReleaseRollout(rollout, rolloutAssignments) : null;
  }

  function transitionReleaseRollout({ userId, rolloutId, action, evidenceRef, percentage = null }) {
    const rollout = releaseRollouts.get(rolloutId);
    if (!rollout || rollout.userId !== userId) return null;
    const transitions = {
      start: { from: ["draft", "paused"], to: "running" },
      resume: { from: ["paused"], to: "running" },
      pause: { from: ["running"], to: "paused" },
      cancel: { from: ["draft", "running", "paused"], to: "cancelled" },
      rollback: { from: ["running", "paused", "completed"], to: "rolling_back" },
      complete: { from: ["running", "rolling_back"], to: action === "complete" && rollout.state === "rolling_back" ? "rolled_back" : "completed" },
      expand: { from: ["running", "paused"], to: rollout.state },
    };
    const transition = transitions[action];
    if (!transition || !transition.from.includes(rollout.state)) {
      return { conflict: true, rollout: publicReleaseRollout(rollout, rolloutAssignments) };
    }
    if (action === "rollback" && !rollout.rollbackVersion) {
      return { conflict: true, reason: "rollback_version_required", rollout: publicReleaseRollout(rollout, rolloutAssignments) };
    }
    if (action === "expand") {
      if (rollout.cohort.type !== "percentage" || !Number.isInteger(percentage)
        || percentage <= rollout.cohort.percentage || percentage > 100) {
        return { conflict: true, reason: "percentage_must_increase", rollout: publicReleaseRollout(rollout, rolloutAssignments) };
      }
      rollout.cohort = { type: "percentage", percentage };
    }
    const timestamp = nowIso();
    rollout.state = transition.to;
    rollout.evidenceRef = evidenceRef;
    rollout.updatedAt = timestamp;
    if (["start", "resume"].includes(action)) rollout.startedAt ??= timestamp;
    if (["complete"].includes(action)) rollout.completedAt = timestamp;
    audit({
      userId,
      actorType: "user",
      action: `release_rollout.${action}`,
      targetId: rollout.id,
      metadata: {
        state: rollout.state,
        targetKind: rollout.targetKind,
        targetVersion: rollout.targetVersion,
        evidenceRef,
        ...(action === "expand" ? { percentage } : {}),
      },
    });
    notifyChanged();
    return { conflict: false, rollout: publicReleaseRollout(rollout, rolloutAssignments) };
  }

  function upsertRolloutAssignment({ userId, rolloutId, targetId, patch }) {
    const rollout = releaseRollouts.get(rolloutId);
    if (!rollout || rollout.userId !== userId) return null;
    const key = `${rolloutId}:${targetId}`;
    const timestamp = nowIso();
    const existing = rolloutAssignments.get(key);
    const assignment = {
      id: existing?.id ?? createId("ras"),
      userId,
      rolloutId,
      targetId,
      targetKind: rollout.targetKind,
      status: patch.status ?? existing?.status ?? "pending",
      reasonCode: patch.reasonCode ?? null,
      observedVersion: patch.observedVersion ?? existing?.observedVersion ?? null,
      progress: Number.isFinite(patch.progress) ? Math.max(0, Math.min(100, patch.progress)) : existing?.progress ?? null,
      attempts: (existing?.attempts ?? 0) + (patch.attempted ? 1 : 0),
      previousDesiredVersion: existing?.previousDesiredVersion ?? patch.previousDesiredVersion ?? null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      completedAt: ["succeeded", "failed", "cancelled", "rolled_back"].includes(patch.status)
        ? timestamp : existing?.completedAt ?? null,
    };
    rolloutAssignments.set(key, assignment);
    rollout.updatedAt = timestamp;
    if (!existing || existing.status !== assignment.status || existing.reasonCode !== assignment.reasonCode) {
      audit({
        userId,
        actorType: "system",
        action: "release_rollout.assignment_changed",
        targetId: assignment.id,
        metadata: { rolloutId, targetId, status: assignment.status, reasonCode: assignment.reasonCode },
      });
    }
    notifyChanged();
    return { ...assignment };
  }

  function listRolloutAssignments({ userId, rolloutId }) {
    const rollout = releaseRollouts.get(rolloutId);
    if (!rollout || rollout.userId !== userId) return [];
    return [...rolloutAssignments.values()]
      .filter((assignment) => assignment.rolloutId === rolloutId && assignment.userId === userId)
      .sort((left, right) => left.targetId.localeCompare(right.targetId))
      .map((assignment) => ({ ...assignment }));
  }

  function createMediaUploadSession(input) {
    const actorDeviceId = input.deviceId ?? null;
    const existing = [...mediaUploadSessions.values()].find((session) => (
      session.userId === input.userId
      && session.deviceId === actorDeviceId
      && session.clientRequestId === input.clientRequestId
    ));
    if (existing) {
      const conflict = existing.kind !== input.kind
        || existing.contentType !== input.contentType
        || existing.expectedSizeBytes !== input.expectedSizeBytes
        || existing.expectedSha256 !== input.expectedSha256
        || (existing.environmentId ?? null) !== (input.environmentId ?? null)
        || (existing.threadId ?? null) !== (input.threadId ?? null);
      return { created: false, conflict, session: publicMediaUploadSession(existing) };
    }

    const committedBytes = [...mediaUploads.values()]
      .filter((media) => media.userId === input.userId)
      .reduce((total, media) => total + media.sizeBytes, 0);
    const reservedBytes = [...mediaUploadSessions.values()]
      .filter((session) => session.userId === input.userId && ["pending", "uploaded"].includes(session.status))
      .reduce((total, session) => total + session.expectedSizeBytes, 0);
    if (Number.isFinite(input.ownerByteLimit)
      && committedBytes + reservedBytes + input.expectedSizeBytes > input.ownerByteLimit) {
      return { created: false, conflict: false, byteLimitExceeded: true, session: null };
    }

    const ownerSessions = [...mediaUploadSessions.values()]
      .filter((session) => session.userId === input.userId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    if (input.companionHandoffId && ownerSessions.some((session) => (
      session.companionHandoffId === input.companionHandoffId
      && ["pending", "uploaded", "finalized"].includes(session.status)
    ))) {
      return { created: false, conflict: true, session: null };
    }
    while (ownerSessions.length >= 256) {
      const terminalIndex = ownerSessions.findIndex((session) => (
        ["finalized", "aborted", "expired"].includes(session.status)
      ));
      if (terminalIndex === -1) return { created: false, conflict: false, limitExceeded: true, session: null };
      const [terminal] = ownerSessions.splice(terminalIndex, 1);
      mediaUploadSessions.delete(terminal.id);
    }

    const session = {
      id: createId("mup"),
      userId: input.userId,
      deviceId: actorDeviceId,
      clientRequestId: input.clientRequestId,
      kind: input.kind,
      contentType: input.contentType,
      expectedSizeBytes: input.expectedSizeBytes,
      expectedSha256: input.expectedSha256,
      storagePath: input.storagePath,
      originalName: input.originalName ?? null,
      captureSource: input.captureSource ?? null,
      environmentId: input.environmentId ?? null,
      threadId: input.threadId ?? null,
      companionHandoffId: input.companionHandoffId ?? null,
      transcript: input.kind === "audio" ? normalizeTranscript(input.transcript) ?? null : null,
      status: "pending",
      mediaId: null,
      createdAt: input.createdAt ?? new Date(requestNow()).toISOString(),
      expiresAt: input.expiresAt,
      uploadedAt: null,
      finalizedAt: null,
      abortedAt: null,
    };
    mediaUploadSessions.set(session.id, session);
    audit({
      userId: session.userId,
      actorType: session.deviceId ? "device" : "user",
      actorId: session.deviceId,
      action: "media.upload_session_created",
      targetId: session.id,
      metadata: {
        kind: session.kind,
        contentType: session.contentType,
        expectedSizeBytes: session.expectedSizeBytes,
        expiresAt: session.expiresAt,
      },
    });
    notifyChanged();
    return { created: true, conflict: false, session: publicMediaUploadSession(session) };
  }

  function getMediaUploadSessionForActor({ userId, deviceId = null, sessionId }) {
    const session = mediaUploadSessions.get(sessionId);
    if (!session || session.userId !== userId) return null;
    if (deviceId !== null && session.deviceId !== deviceId) return null;
    return { ...session };
  }

  function markMediaUploadSessionUploaded({ userId, deviceId = null, sessionId, uploadedAt = nowIso() }) {
    const session = getMediaUploadSessionForActor({ userId, deviceId, sessionId });
    if (!session) return null;
    const stored = mediaUploadSessions.get(sessionId);
    if (stored.status === "pending") {
      stored.status = "uploaded";
      stored.uploadedAt = uploadedAt;
      notifyChanged();
    }
    return publicMediaUploadSession(stored);
  }

  function finalizeMediaUploadSession({
    userId,
    deviceId = null,
    sessionId,
    storagePath,
    mediaExpiresAt = null,
    finalizedAt = nowIso(),
  }) {
    const session = getMediaUploadSessionForActor({ userId, deviceId, sessionId });
    if (!session) return null;
    const stored = mediaUploadSessions.get(sessionId);
    if (stored.status === "finalized" && stored.mediaId) {
      const media = mediaUploads.get(stored.mediaId);
      return { session: publicMediaUploadSession(stored), media: media ? publicMediaUpload(media) : null };
    }
    if (stored.status !== "uploaded") {
      return { session: publicMediaUploadSession(stored), media: null };
    }
    let media = [...mediaUploads.values()].find((item) => item.uploadSessionId === stored.id);
    if (!media) {
      createMediaUpload({
        userId: stored.userId,
        deviceId: stored.deviceId,
        kind: stored.kind,
        contentType: stored.contentType,
        sizeBytes: stored.expectedSizeBytes,
        sha256: stored.expectedSha256,
        storagePath,
        originalName: stored.originalName ?? undefined,
        transcript: stored.transcript ?? undefined,
        captureSource: stored.captureSource ?? undefined,
        environmentId: stored.environmentId ?? undefined,
        threadId: stored.threadId ?? undefined,
        companionHandoffId: stored.companionHandoffId ?? undefined,
        expiresAt: mediaExpiresAt,
        uploadSessionId: stored.id,
      });
      media = [...mediaUploads.values()].find((item) => item.uploadSessionId === stored.id);
    }
    stored.status = "finalized";
    stored.mediaId = media?.id ?? null;
    stored.finalizedAt = finalizedAt;
    notifyChanged();
    return { session: publicMediaUploadSession(stored), media: media ? publicMediaUpload(media) : null };
  }

  function abortMediaUploadSession({
    userId,
    deviceId = null,
    sessionId,
    status = "aborted",
    at = nowIso(),
  }) {
    const session = getMediaUploadSessionForActor({ userId, deviceId, sessionId });
    if (!session) return null;
    const stored = mediaUploadSessions.get(sessionId);
    if (stored.status === "finalized") return publicMediaUploadSession(stored);
    if (stored.status !== "aborted" && stored.status !== "expired") {
      stored.status = status === "expired" ? "expired" : "aborted";
      stored.abortedAt = at;
      notifyChanged();
    }
    return publicMediaUploadSession(stored);
  }

  function listExpiredMediaUploadSessions({ userId, now = nowIso() }) {
    return [...mediaUploadSessions.values()]
      .filter((session) => session.userId === userId
        && ["pending", "uploaded"].includes(session.status)
        && session.expiresAt <= now)
      .map((session) => ({ ...session }));
  }

  function createMediaUpload(input) {
    if (input.uploadSessionId) {
      const existing = [...mediaUploads.values()].find((media) => media.uploadSessionId === input.uploadSessionId);
      if (existing) return publicMediaUpload(existing);
    }
    if (Number.isFinite(input.ownerByteLimit)) {
      const committedBytes = [...mediaUploads.values()]
        .filter((media) => media.userId === input.userId)
        .reduce((total, media) => total + media.sizeBytes, 0);
      const reservedBytes = [...mediaUploadSessions.values()]
        .filter((session) => session.userId === input.userId && ["pending", "uploaded"].includes(session.status))
        .reduce((total, session) => total + session.expectedSizeBytes, 0);
      if (committedBytes + reservedBytes + input.sizeBytes > input.ownerByteLimit) {
        return { byteLimitExceeded: true };
      }
    }
    const transcript = input.kind === "audio" ? normalizeTranscript(input.transcript) ?? null : null;
    const media = {
      id: createId("media"),
      userId: input.userId,
      deviceId: input.deviceId ?? null,
      kind: input.kind,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      storagePath: input.storagePath,
      uploadSessionId: input.uploadSessionId ?? null,
      originalName: input.originalName ?? null,
      captureSource: input.captureSource ?? null,
      environmentId: input.environmentId ?? null,
      threadId: input.threadId ?? null,
      companionHandoffId: input.companionHandoffId ?? null,
      transcript,
      processing: normalizeMediaProcessing(input.processing, input.kind, transcript),
      expiresAt: input.expiresAt ?? null,
      createdAt: nowIso(),
    };
    mediaUploads.set(media.id, media);
    audit({
      userId: input.userId,
      actorType: input.deviceId ? "device" : "user",
      actorId: input.deviceId,
      action: "media.uploaded",
      targetId: media.id,
      metadata: {
        kind: media.kind,
        contentType: media.contentType,
        sizeBytes: media.sizeBytes,
        sha256: media.sha256,
        transcriptLength: media.transcript?.length ?? 0,
        transcriptionStatus: media.processing?.transcriptionStatus ?? null,
        expiresAt: media.expiresAt,
      },
    });
    notifyChanged();
    return publicMediaUpload(media);
  }

  function createCompanionHandoff({ userId, deviceId = null, environmentId, threadId, action, code, expiresAt }) {
    const now = requestNow();
    for (const handoff of companionHandoffs.values()) {
      if (handoff.status === "waiting" && Date.parse(handoff.expiresAt) <= now) {
        handoff.status = "expired";
        handoff.codeHash = null;
      }
    }
    const ownerHandoffs = [...companionHandoffs.values()]
      .filter((handoff) => handoff.userId === userId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    while (ownerHandoffs.length >= 256) {
      const terminalIndex = ownerHandoffs.findIndex((handoff) => (
        ["completed", "expired", "cancelled"].includes(handoff.status)
      ));
      if (terminalIndex === -1) return { limitExceeded: true, handoff: null };
      const [terminal] = ownerHandoffs.splice(terminalIndex, 1);
      companionHandoffs.delete(terminal.id);
    }
    const active = ownerHandoffs.filter((handoff) => ["waiting", "claimed"].includes(handoff.status));
    if (active.length >= 32) return { limitExceeded: true, handoff: null };
    const createdAt = new Date(now).toISOString();
    const handoff = {
      id: createId("handoff"),
      userId,
      deviceId,
      environmentId,
      threadId,
      action,
      status: "waiting",
      codeHash: hashSecret(code),
      createdAt,
      expiresAt,
      claimedAt: null,
      completedAt: null,
      cancelledAt: null,
    };
    companionHandoffs.set(handoff.id, handoff);
    audit({
      userId,
      actorType: deviceId ? "device" : "user",
      actorId: deviceId,
      action: "companion_handoff.created",
      targetId: handoff.id,
      metadata: { action: handoff.action, expiresAt: handoff.expiresAt },
    });
    notifyChanged();
    return { limitExceeded: false, handoff: publicCompanionHandoff(handoff) };
  }

  function getCompanionHandoffForUser(userId, handoffId) {
    const handoff = companionHandoffs.get(handoffId);
    if (!handoff || handoff.userId !== userId) return null;
    expireCompanionHandoff(handoff, requestNow());
    return publicCompanionHandoff(handoff);
  }

  function getCompanionHandoffForDevice({ userId, deviceId, handoffId }) {
    const handoff = companionHandoffs.get(handoffId);
    if (!handoff || handoff.userId !== userId || handoff.deviceId !== deviceId) return null;
    expireCompanionHandoff(handoff, requestNow());
    return publicCompanionHandoff(handoff);
  }

  function claimCompanionHandoff({ userId, code, claimedAt = nowIso() }) {
    const codeHash = hashSecret(code);
    const handoff = [...companionHandoffs.values()].find((candidate) => (
      candidate.userId === userId && candidate.codeHash && safeEqual(candidate.codeHash, codeHash)
    ));
    if (!handoff) return null;
    expireCompanionHandoff(handoff, Date.parse(claimedAt));
    if (handoff.status !== "waiting") return publicCompanionHandoff(handoff);
    handoff.status = "claimed";
    handoff.claimedAt = claimedAt;
    // The bearer code is single use. Removing even its digest also prevents a second claim from
    // learning whether a consumed code ever existed.
    handoff.codeHash = null;
    audit({
      userId,
      actorType: "user",
      action: "companion_handoff.claimed",
      targetId: handoff.id,
      metadata: { action: handoff.action },
    });
    notifyChanged();
    return publicCompanionHandoff(handoff);
  }

  function cancelCompanionHandoff({ userId, handoffId, deviceId = null, cancelledAt = nowIso() }) {
    const handoff = companionHandoffs.get(handoffId);
    if (!handoff || handoff.userId !== userId) return null;
    if (deviceId !== null && handoff.deviceId !== deviceId) return null;
    expireCompanionHandoff(handoff, Date.parse(cancelledAt));
    if (["waiting", "claimed"].includes(handoff.status)) {
      handoff.status = "cancelled";
      handoff.cancelledAt = cancelledAt;
      handoff.codeHash = null;
      notifyChanged();
    }
    return publicCompanionHandoff(handoff);
  }

  function completeCompanionHandoff({ userId, handoffId, completedAt = nowIso() }) {
    const handoff = companionHandoffs.get(handoffId);
    if (!handoff || handoff.userId !== userId) return null;
    if (handoff.status === "claimed") {
      handoff.status = "completed";
      handoff.completedAt = completedAt;
      notifyChanged();
    }
    return publicCompanionHandoff(handoff);
  }

  function getMediaForUser(userId, mediaId) {
    const media = mediaUploads.get(mediaId);
    if (!media || media.userId !== userId) return null;
    return media;
  }

  function updateMediaTranscript({ userId, mediaId, transcript, source = "manual" }) {
    const media = mediaUploads.get(mediaId);
    if (!media || media.userId !== userId || media.kind !== "audio") return null;
    const previousLength = media.transcript?.length ?? 0;
    media.transcript = normalizeTranscript(transcript) ?? null;
    media.processing = normalizeMediaProcessing({
      transcriptionStatus: media.transcript ? "ready" : "pending",
      transcriptSource: media.transcript ? source : null,
      lastError: null,
    }, media.kind, media.transcript);
    audit({
      userId,
      actorType: "user",
      action: "media.transcript_updated",
      targetId: media.id,
      metadata: {
        previousLength,
        transcriptLength: media.transcript?.length ?? 0,
      },
    });
    notifyChanged();
    return publicMediaUpload(media);
  }

  function createDeviceProfile({ userId, profileId, label, description, capabilities }) {
    const key = `${userId}:${profileId}`;
    if (deviceProfiles.has(key)) return null;
    const profile = {
      id: createId("dprof"),
      userId,
      profileId,
      label,
      description,
      capabilities: [...capabilities],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    deviceProfiles.set(key, profile);
    audit({
      userId,
      actorType: "user",
      action: "device_profile.created",
      targetId: profileId,
      metadata: { label, capabilities: profile.capabilities },
    });
    notifyChanged();
    return { ...profile };
  }

  function listUserDeviceProfiles(userId) {
    return [...deviceProfiles.values()]
      .filter((profile) => profile.userId === userId)
      .map((profile) => ({ ...profile, capabilities: [...profile.capabilities] }));
  }

  function getUserDeviceProfile(userId, profileId) {
    const profile = deviceProfiles.get(`${userId}:${profileId}`);
    return profile ? { ...profile, capabilities: [...profile.capabilities] } : null;
  }

  function updateDeviceProfileDefinition({ userId, profileId, label, description, capabilities }) {
    const profile = deviceProfiles.get(`${userId}:${profileId}`);
    if (!profile) return null;
    if (label !== undefined) profile.label = label;
    if (description !== undefined) profile.description = description;
    if (capabilities !== undefined) profile.capabilities = [...capabilities];
    profile.updatedAt = nowIso();
    audit({
      userId,
      actorType: "user",
      action: "device_profile.updated",
      targetId: profileId,
      metadata: { label: profile.label, capabilities: profile.capabilities },
    });
    notifyChanged();
    return { ...profile, capabilities: [...profile.capabilities] };
  }

  function deleteDeviceProfile({ userId, profileId }) {
    const key = `${userId}:${profileId}`;
    const profile = deviceProfiles.get(key);
    if (!profile) return null;
    deviceProfiles.delete(key);
    audit({
      userId,
      actorType: "user",
      action: "device_profile.deleted",
      targetId: profileId,
      metadata: { label: profile.label },
    });
    notifyChanged();
    return { ...profile, capabilities: [...profile.capabilities] };
  }

  function updateMediaDescription({ userId, mediaId, description, source = "manual" }) {
    const media = mediaUploads.get(mediaId);
    if (!media || media.userId !== userId || media.kind !== "image") return null;
    const previousLength = media.description?.length ?? 0;
    media.description = normalizeTranscript(description) ?? null;
    media.processing = normalizeMediaProcessing({
      visionStatus: media.description ? "ready" : "pending",
      descriptionSource: media.description ? source : null,
      lastError: null,
    }, media.kind, media.transcript, media.description);
    audit({
      userId,
      actorType: "user",
      action: "media.description_updated",
      targetId: media.id,
      metadata: {
        previousLength,
        descriptionLength: media.description?.length ?? 0,
        source,
      },
    });
    notifyChanged();
    return publicMediaUpload(media);
  }

  function updateMediaProcessing({ userId, mediaId, processing }) {
    const media = mediaUploads.get(mediaId);
    if (!media || media.userId !== userId) return null;
    if (media.kind !== "audio" && media.kind !== "image") return null;
    media.processing = normalizeMediaProcessing(processing, media.kind, media.transcript, media.description);
    audit({
      userId,
      actorType: "system",
      action: "media.processing_updated",
      targetId: media.id,
      metadata: media.processing,
    });
    notifyChanged();
    return publicMediaUpload(media);
  }

  function listMediaUploads(userId) {
    return [...mediaUploads.values()]
      .filter((media) => media.userId === userId)
      .map(publicMediaUpload);
  }

  function listExpiredMediaUploads({ userId, now = nowIso() }) {
    return [...mediaUploads.values()]
      .filter((media) => media.userId === userId && media.expiresAt && media.expiresAt <= now);
  }

  function deleteMediaUpload({ userId, mediaId, reason = "manual" }) {
    const media = mediaUploads.get(mediaId);
    if (!media || media.userId !== userId) return null;
    mediaUploads.delete(mediaId);
    // A job whose media is gone can never finish; leaving it queued would make the worker
    // rediscover it on every tick until the retry budget burned out.
    for (const [jobId, job] of mediaJobs) {
      if (job.mediaId === mediaId) mediaJobs.delete(jobId);
    }
    audit({
      userId,
      actorType: "user",
      action: "media.deleted",
      targetId: media.id,
      metadata: {
        kind: media.kind,
        contentType: media.contentType,
        sizeBytes: media.sizeBytes,
        sha256: media.sha256,
        reason,
      },
    });
    notifyChanged();
    return publicMediaUpload(media);
  }

  // --- Durable media processing jobs -------------------------------------------------------
  //
  // Transcription used to run inside the HTTP handler, so a 30-second ASR call held a socket open
  // and died with the process. Jobs are rows now: the request enqueues one and the worker in
  // src/mediaJobs.mjs drives it, so a restart mid-flight resumes instead of losing the work.

  function createMediaJob(input) {
    const media = mediaUploads.get(input.mediaId);
    if (!media || media.userId !== input.userId) return null;
    const kind = input.kind ?? "transcription";

    // Enqueue is idempotent. Two clicks on "Transcribe" (or a retry after a flaky response) must
    // not produce two workers racing to write the same transcript. A device capture also reuses
    // its terminal job: a replayed finalize must never auto-send that recording a second time.
    const active = [...mediaJobs.values()].find((job) => job.userId === input.userId
      && job.mediaId === input.mediaId
      && job.kind === kind
      && (!MEDIA_JOB_TERMINAL_STAGES.has(job.stage)
        || (input.deviceId && job.deviceId === input.deviceId)));
    if (active) return structuredClone(active);

    const job = {
      id: createId("mjob"),
      userId: input.userId,
      mediaId: input.mediaId,
      kind,
      stage: "queued",
      // Where the capture came from, and where a finished transcript would be sent. Recorded at
      // enqueue because the worker runs long after the request that created the job is gone, and
      // a controller's configured thread can change in the meantime — the capture belongs to the
      // thread the owner was looking at when they pressed record.
      deviceId: input.deviceId ?? null,
      environmentId: input.environmentId ?? null,
      threadId: input.threadId ?? null,
      // The dispatch outcome, filled in by the worker. `autoSend` is the decision it actually
      // acted on, not the preference read at enqueue: a grant revoked while the job sat in the
      // queue has to win.
      autoSend: false,
      dispatchStatus: null,
      dispatchError: null,
      commandId: null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      language: input.language ?? null,
      rawTranscript: null,
      normalizedTranscript: null,
      userEditedTranscript: null,
      attempts: 0,
      maxAttempts: normalizeAttemptLimit(input.maxAttempts),
      reviewRequired: input.reviewRequired === true,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      failureKind: null,
      // Why a terminal failure was terminal. `failureKind` only says whether another identical
      // attempt was worth making; this says what would have to change for the job to succeed, and
      // it is the only thing the configuration-retry path is allowed to act on.
      failureCause: null,
      // Bookkeeping for that retry path, so a requeued job is visibly a second run rather than
      // looking like a capture that never failed.
      requeueCount: 0,
      requeuedAt: null,
      requeuedBy: null,
      timings: { queuedAt: nowIso() },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    mediaJobs.set(job.id, job);
    audit({
      userId: input.userId,
      actorType: "user",
      action: "media_job.queued",
      targetId: job.id,
      metadata: {
        mediaId: job.mediaId,
        kind: job.kind,
        provider: job.provider,
        maxAttempts: job.maxAttempts,
        deviceId: job.deviceId,
      },
    });
    notifyChanged();
    return structuredClone(job);
  }

  function getMediaJobForUser(userId, jobId) {
    const job = mediaJobs.get(jobId);
    if (!job || job.userId !== userId) return null;
    return structuredClone(job);
  }

  function listMediaJobs({ userId, mediaId = null, stage = null } = {}) {
    return [...mediaJobs.values()]
      .filter((job) => job.userId === userId
        && (!mediaId || job.mediaId === mediaId)
        && (!stage || job.stage === stage))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((job) => structuredClone(job));
  }

  /**
   * Takes a lease on runnable jobs.
   *
   * The lease is what makes a crashed worker survivable: it holds the job for `leaseMs`, and once
   * that expires any worker may pick it up again. Resumption reads the stage back off the evidence
   * already stored (a raw transcript means transcription is done), so nothing is redone.
   *
   * `review_required` is deliberately not runnable — it waits on a person, not a worker.
   */
  function claimMediaJobs({ owner, leaseMs = 60_000, limit = 4, now = nowIso() } = {}) {
    const nowMs = Date.parse(now);
    const claimed = [];
    let mutated = false;

    for (const job of [...mediaJobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (claimed.length >= limit) break;
      if (MEDIA_JOB_TERMINAL_STAGES.has(job.stage)) continue;
      if (job.stage === "review_required") continue;

      const leaseExpiresAtMs = Date.parse(job.leaseExpiresAt ?? "");
      if (Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs > nowMs) continue;

      if (job.attempts >= job.maxAttempts) {
        // The budget is spent. Failing here rather than handing the job out again keeps an
        // exhausted job from being rediscovered on every single tick.
        job.stage = "failed";
        job.failureKind = "terminal";
        // The cause of the last attempt is the cause of the abandonment: a job that burned its
        // budget on an unreachable sidecar failed for configuration reasons, and re-labelling it
        // here would hide it from the only retry path that could fix it.
        job.failureCause = job.failureCause ?? "unknown";
        job.lastError = job.lastError ?? `Media job abandoned after ${job.attempts} attempts.`;
        job.leaseOwner = null;
        job.leaseExpiresAt = null;
        job.timings = { ...job.timings, failedAt: nowIso() };
        job.updatedAt = nowIso();
        mutated = true;
        continue;
      }

      job.attempts += 1;
      job.leaseOwner = owner ?? null;
      job.leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
      job.stage = resumeStageFor(job);
      job.timings = { ...job.timings, startedAt: job.timings?.startedAt ?? nowIso() };
      job.updatedAt = nowIso();
      mutated = true;
      claimed.push(structuredClone(job));
    }

    if (mutated) notifyChanged();
    return claimed;
  }

  function updateMediaJob({ jobId, userId = null, ...input }) {
    const job = mediaJobs.get(jobId);
    if (!job) return null;
    if (userId !== null && job.userId !== userId) return null;

    // rawTranscript and normalizedTranscript are versions, not a field to overwrite: once the ASR
    // output is recorded it is the immutable record of what the provider actually heard. Only the
    // user-edited version stays writable.
    if (input.rawTranscript !== undefined && job.rawTranscript === null) {
      job.rawTranscript = normalizeRawTranscript(input.rawTranscript);
    }
    if (input.normalizedTranscript !== undefined && job.normalizedTranscript === null) {
      job.normalizedTranscript = normalizeTranscript(input.normalizedTranscript) ?? null;
    }
    if (input.userEditedTranscript !== undefined) {
      job.userEditedTranscript = normalizeTranscript(input.userEditedTranscript) ?? null;
    }

    for (const key of ["provider", "model", "language", "dispatchStatus", "dispatchError", "commandId"]) {
      if (input[key] !== undefined) job[key] = input[key] ?? null;
    }
    if (input.autoSend !== undefined) job.autoSend = input.autoSend === true;
    if (input.stage !== undefined && MEDIA_JOB_STAGE_SET.has(input.stage)) job.stage = input.stage;
    if (input.lastError !== undefined) job.lastError = input.lastError ?? null;
    if (input.failureKind !== undefined) {
      job.failureKind = ["retryable", "terminal"].includes(input.failureKind) ? input.failureKind : null;
    }
    if (input.failureCause !== undefined) {
      job.failureCause = MEDIA_JOB_FAILURE_CAUSES.includes(input.failureCause) ? input.failureCause : null;
    }
    if (input.timings !== undefined) job.timings = { ...job.timings, ...structuredClone(input.timings ?? {}) };
    if (input.releaseLease === true) {
      job.leaseOwner = null;
      job.leaseExpiresAt = null;
    }
    job.updatedAt = nowIso();
    notifyChanged();
    return structuredClone(job);
  }

  /**
   * Puts one configuration-failed job back in the queue, at an owner's explicit request.
   *
   * Never called by a poller, a boot path or a retry timer — only by the owner-realm endpoint. A
   * terminal stage is a promise that nothing will happen to this job on its own, and the only thing
   * allowed to break that promise is a person deciding to.
   *
   * Three rules are enforced here rather than left to the caller, because they are what make the
   * path safe rather than merely convenient:
   *
   * 1. Only `failed` + `failureCause === "configuration"`. An input failure would spend an
   *    inference to produce the same refusal, and an unknown failure is unclassified, not benign.
   * 2. The attempt budget resets. The previous attempts were spent on a fault that no longer
   *    exists, so charging the clip for them would fail it again after one bad tick.
   * 3. `reviewRequired` is forced on, and is not a parameter. A transcript is dispatched to a
   *    coding agent as an instruction; the auto-send grant means "send what I say as I say it", and
   *    a clip recorded before an incident was fixed is not that. Waking up to an agent acting on
   *    something said last Tuesday is the failure mode this whole path could otherwise create, so a
   *    requeued capture always waits for a person — who then sees the text before it goes.
   */
  function requeueMediaJob({ userId, jobId, actorId = null, actorType = "user" }) {
    const job = mediaJobs.get(jobId);
    if (!job || job.userId !== userId) return null;
    if (job.stage !== "failed" || job.failureCause !== "configuration") return null;

    const previousError = job.lastError;
    job.stage = "queued";
    job.attempts = 0;
    job.lastError = null;
    job.failureKind = null;
    job.failureCause = null;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    // The previous run never dispatched anything (it never produced a transcript), so the dispatch
    // outcome is cleared rather than carried forward as if it described this run.
    job.autoSend = false;
    job.dispatchStatus = null;
    job.dispatchError = null;
    job.commandId = null;
    job.reviewRequired = true;
    job.requeueCount = (job.requeueCount ?? 0) + 1;
    job.requeuedAt = nowIso();
    job.requeuedBy = actorId ?? userId;
    job.timings = { ...job.timings, requeuedAt: nowIso() };
    job.updatedAt = nowIso();
    audit({
      userId,
      actorType,
      ...(actorId ? { actorId } : {}),
      action: "media_job.requeued",
      targetId: job.id,
      metadata: {
        mediaId: job.mediaId,
        deviceId: job.deviceId,
        previousError,
        requeueCount: job.requeueCount,
        holdForReview: true,
      },
    });
    notifyChanged();
    return structuredClone(job);
  }

  function createMacro(input) {
    const macro = {
      id: createId("macro"),
      userId: input.userId,
      label: input.label,
      environmentId: input.environmentId ?? null,
      threadId: input.threadId ?? null,
      intent: input.intent,
      disabled: input.disabled === true,
      disabledReason: input.disabled === true ? (input.disabledReason ?? null) : null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    macros.set(macro.id, macro);
    audit({
      userId: input.userId,
      actorType: "user",
      action: "macro.created",
      targetId: macro.id,
      metadata: {
        label: macro.label,
        intentType: macro.intent?.type,
        environmentId: macro.environmentId,
      },
    });
    notifyChanged();
    return publicMacro(macro);
  }

  function getMacroForUser(userId, macroId) {
    const macro = macros.get(macroId);
    if (!macro || macro.userId !== userId) return null;
    return macro;
  }

  function listMacros(userId) {
    return [...macros.values()]
      .filter((macro) => macro.userId === userId)
      .map(publicMacro);
  }

  function deleteMacro({ userId, macroId }) {
    const macro = macros.get(macroId);
    if (!macro || macro.userId !== userId) return null;
    macros.delete(macroId);
    audit({
      userId,
      actorType: "user",
      action: "macro.deleted",
      targetId: macro.id,
      metadata: {
        label: macro.label,
        intentType: macro.intent?.type,
      },
    });
    notifyChanged();
    return publicMacro(macro);
  }

  // Durable idempotency lives beside commands rather than inside the connector transport. The
  // receipt is claimed before policy or T3 can have an effect, and stores only a SHA-256 request
  // fingerprint plus a command reference — never prompt, transcript, path, or provider output.
  function claimCommandRequest(input) {
    const nowMs = requestNow();
    const now = new Date(nowMs).toISOString();
    let changed = false;
    for (const [key, request] of commandRequests) {
      if (Date.parse(request.expiresAt) <= nowMs) {
        commandRequests.delete(key);
        changed = true;
      }
    }

    const key = commandRequestKey(input);
    const existing = commandRequests.get(key);
    if (existing) {
      if (changed) notifyChanged();
      return {
        claimed: false,
        conflict: existing.requestHash !== input.requestHash,
        capacity: false,
        request: publicCommandRequest(existing),
      };
    }

    const ownerKey = commandRequestOwnerKey(input);
    const owned = [...commandRequests.entries()]
      .filter(([, request]) => commandRequestOwnerKey(request) === ownerKey)
      .sort((left, right) => Date.parse(left[1].createdAt) - Date.parse(right[1].createdAt));
    while (owned.length >= COMMAND_REQUEST_MAX_PER_OWNER) {
      const evictIndex = owned.findIndex(([, request]) => request.status !== "processing");
      if (evictIndex < 0) {
        if (changed) notifyChanged();
        return { claimed: false, conflict: false, capacity: true, request: null };
      }
      const [[evictKey]] = owned.splice(evictIndex, 1);
      commandRequests.delete(evictKey);
      changed = true;
    }

    const request = {
      userId: input.userId,
      actorType: input.actorType,
      actorId: input.actorId ?? input.userId,
      operation: input.operation,
      clientRequestId: input.clientRequestId,
      requestHash: input.requestHash,
      status: "processing",
      commandId: null,
      httpStatus: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(nowMs + COMMAND_REQUEST_TTL_MS).toISOString(),
    };
    commandRequests.set(key, request);
    notifyChanged();
    return { claimed: true, conflict: false, capacity: false, request: publicCommandRequest(request) };
  }

  function settleCommandRequest(input) {
    const request = commandRequests.get(commandRequestKey(input));
    if (!request || request.requestHash !== input.requestHash) return null;
    const status = [
      "approval_required", "blocked", "dispatched", "completed", "failed", "rejected", "cancelled",
    ].includes(input.status) ? input.status : "failed";
    if (request.status !== "processing") return publicCommandRequest(request);
    request.status = status;
    request.commandId = input.commandId ?? null;
    request.httpStatus = Number.isInteger(input.httpStatus) ? input.httpStatus : (status === "failed" ? 500 : 200);
    request.updatedAt = new Date(requestNow()).toISOString();
    notifyChanged();
    return publicCommandRequest(request);
  }

  function getCommandRequest(input) {
    const request = commandRequests.get(commandRequestKey(input));
    if (!request || Date.parse(request.expiresAt) <= requestNow()) return null;
    return publicCommandRequest(request);
  }

  // A durable, privacy-minimal inbox. `dedupeKey` is an opaque fingerprint supplied by the
  // notification projector; it is never returned. This makes a replayed T3 activity or connector
  // presence event idempotent without retaining the provider request id that may itself contain
  // question text.
  function createNotification(input) {
    if (!users.has(input.userId)) return null;
    if (!NOTIFICATION_KIND_SET.has(input.kind)) throw new Error("Unsupported notification kind.");
    if (!NOTIFICATION_SEVERITY_SET.has(input.severity)) throw new Error("Unsupported notification severity.");
    const dedupeKey = normalizeNotificationText(input.dedupeKey, 128, "dedupeKey");
    const key = notificationKey({ userId: input.userId, dedupeKey });
    const existingId = notificationDedupe.get(key);
    const existing = existingId ? notifications.get(existingId) : null;
    if (existing) return { created: false, notification: existing };

    const createdAt = normalizeNotificationTimestamp(input.occurredAt, requestNow());
    const updatedAt = new Date(requestNow()).toISOString();
    const notification = {
      id: createId("notification"),
      userId: input.userId,
      sequence: ++notificationSequence,
      dedupeKey,
      kind: input.kind,
      severity: input.severity,
      title: normalizeNotificationText(input.title, 120, "title"),
      environmentId: normalizeNullableNotificationText(input.environmentId, 160),
      threadId: normalizeNullableNotificationText(input.threadId, 240),
      commandId: normalizeNullableNotificationText(input.commandId, 160),
      createdAt,
      updatedAt,
      readAt: null,
      dismissedAt: null,
    };
    notifications.set(notification.id, notification);
    notificationDedupe.set(key, notification.id);
    pruneNotifications(input.userId);
    notifyChanged();
    return { created: true, notification };
  }

  function listNotifications({
    userId,
    afterCursor = null,
    beforeCursor = null,
    limit = 50,
    includeDismissed = false,
  }) {
    const parsedLimit = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
    const after = parseNotificationCursor(afterCursor);
    const before = parseNotificationCursor(beforeCursor);
    if (after !== null && before !== null) throw new Error("Notification cursors are mutually exclusive.");
    pruneNotifications(userId);
    const all = [...notifications.values()].filter((notification) =>
      notification.userId === userId
      && (includeDismissed || !notification.dismissedAt));
    const rows = all.filter((notification) =>
      (after === null || notification.sequence > after)
      && (before === null || notification.sequence < before));
    // A replay cursor is chronological so advancing it can never skip a record. An initial inbox
    // read and older-page request are newest-first, which is the useful inbox order.
    rows.sort(after !== null
      ? (left, right) => left.sequence - right.sequence
      : (left, right) => right.sequence - left.sequence);
    const page = rows.slice(0, parsedLimit);
    const unreadCount = [...notifications.values()].filter((notification) =>
      notification.userId === userId && !notification.readAt && !notification.dismissedAt).length;
    return {
      notifications: page,
      nextCursor: before === null && page.length > 0
        ? String(Math.max(...page.map((row) => row.sequence)))
        : (afterCursor ?? null),
      oldestCursor: page.length > 0 ? String(Math.min(...page.map((row) => row.sequence))) : beforeCursor,
      hasMore: rows.length > page.length,
      hasMoreBefore: before !== null || after === null ? rows.length > page.length : false,
      hasMoreAfter: after !== null ? rows.length > page.length : false,
      unreadCount,
    };
  }

  function markNotificationRead({ userId, notificationId }) {
    const notification = notifications.get(notificationId);
    if (!notification || notification.userId !== userId) return null;
    const duplicate = Boolean(notification.readAt);
    if (!duplicate) {
      notification.readAt = new Date(requestNow()).toISOString();
      notification.updatedAt = notification.readAt;
      notifyChanged();
    }
    return { notification, duplicate };
  }

  function dismissNotification({ userId, notificationId }) {
    const notification = notifications.get(notificationId);
    if (!notification || notification.userId !== userId) return null;
    const duplicate = Boolean(notification.dismissedAt);
    if (!duplicate) {
      const timestamp = new Date(requestNow()).toISOString();
      notification.dismissedAt = timestamp;
      notification.readAt ??= timestamp;
      notification.updatedAt = timestamp;
      notifyChanged();
    }
    return { notification, duplicate };
  }

  function dismissNotificationByDedupe({ userId, dedupeKey, resolvedAt = null }) {
    const normalizedDedupeKey = normalizeNotificationText(dedupeKey, 128, "dedupeKey");
    const notificationId = notificationDedupe.get(notificationKey({
      userId,
      dedupeKey: normalizedDedupeKey,
    }));
    const notification = notificationId ? notifications.get(notificationId) : null;
    if (!notification || notification.userId !== userId) return null;
    const duplicate = Boolean(notification.dismissedAt);
    if (!duplicate) {
      const timestamp = normalizeNotificationTimestamp(resolvedAt, requestNow());
      notification.dismissedAt = timestamp;
      notification.readAt ??= timestamp;
      notification.updatedAt = timestamp;
      notifyChanged();
    }
    return { notification, duplicate };
  }

  function markAllNotificationsRead({ userId }) {
    const updatedAt = new Date(requestNow()).toISOString();
    let count = 0;
    for (const notification of notifications.values()) {
      if (notification.userId !== userId || notification.readAt || notification.dismissedAt) continue;
      notification.readAt = updatedAt;
      notification.updatedAt = updatedAt;
      count += 1;
    }
    if (count > 0) notifyChanged();
    return { updatedAt, count };
  }

  function recordBackgroundLiveness({
    scope = "scheduled-worker",
    attemptedAt,
    succeeded = false,
    failureCode = null,
  } = {}) {
    const normalizedScope = normalizeNotificationText(scope, 80, "scope");
    const timestamp = normalizeNotificationTimestamp(attemptedAt, requestNow());
    const previous = backgroundLiveness.get(normalizedScope) ?? { scope: normalizedScope };
    const record = {
      ...previous,
      scope: normalizedScope,
      lastAttemptAt: timestamp,
      ...(succeeded ? { lastSuccessAt: timestamp, failureCode: null } : {}),
      ...(failureCode
        ? {
            lastFailureAt: timestamp,
            failureCode: normalizeBackgroundFailureCode(failureCode),
          }
        : {}),
      updatedAt: new Date(requestNow()).toISOString(),
    };
    backgroundLiveness.set(normalizedScope, record);
    notifyChanged();
    return record;
  }

  function getBackgroundLiveness(scope = "scheduled-worker") {
    return backgroundLiveness.get(scope) ?? null;
  }

  function upsertPushSubscription({ userId, endpoint, keys, vapidKeyId, userAgent = null }) {
    const endpointHash = hashSecret(endpoint);
    const ownerKey = `${userId}\u0000${endpointHash}`;
    const existing = pushSubscriptionByOwnerEndpoint.get(ownerKey);
    const timestamp = new Date(requestNow()).toISOString();
    const subscription = existing ? pushSubscriptions.get(existing) : {
      id: createId("push_subscription"), userId, endpointHash, createdAt: timestamp,
    };
    Object.assign(subscription, {
      endpoint: pushSecretBox.seal(endpoint),
      keys: { p256dh: pushSecretBox.seal(keys.p256dh), auth: pushSecretBox.seal(keys.auth) },
      vapidKeyId,
      userAgent: typeof userAgent === "string" ? userAgent.slice(0, 160) : null,
      revokedAt: null,
      lastAcceptedAt: subscription.lastAcceptedAt ?? null,
      lastFailureCode: null,
      updatedAt: timestamp,
    });
    pushSubscriptions.set(subscription.id, subscription);
    pushSubscriptionByOwnerEndpoint.set(ownerKey, subscription.id);
    notifyChanged();
    return { subscription: publicPushSubscription(subscription), created: !existing };
  }

  function listPushSubscriptions({ userId }) {
    return [...pushSubscriptions.values()]
      .filter((subscription) => subscription.userId === userId && !subscription.revokedAt)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicPushSubscription);
  }

  function revokePushSubscription({ userId, subscriptionId, reason = "user_revoked" }) {
    const subscription = pushSubscriptions.get(subscriptionId);
    if (!subscription || subscription.userId !== userId) return null;
    const duplicate = Boolean(subscription.revokedAt);
    if (!duplicate) {
      subscription.revokedAt = new Date(requestNow()).toISOString();
      subscription.updatedAt = subscription.revokedAt;
      subscription.lastFailureCode = reason;
      notifyChanged();
    }
    return { subscription: publicPushSubscription(subscription), duplicate };
  }

  function revokePushSubscriptionByEndpoint({ userId, endpoint, reason = "user_revoked" }) {
    const subscriptionId = pushSubscriptionByOwnerEndpoint.get(`${userId}\u0000${hashSecret(endpoint)}`);
    return subscriptionId ? revokePushSubscription({ userId, subscriptionId, reason }) : null;
  }

  function enqueuePushDeliveries({ userId, notificationId }) {
    const notification = notifications.get(notificationId);
    if (!notification || notification.userId !== userId) return [];
    const timestamp = new Date(requestNow()).toISOString();
    const created = [];
    for (const subscription of pushSubscriptions.values()) {
      if (subscription.userId !== userId || subscription.revokedAt) continue;
      const dedupeKey = `${subscription.id}\u0000${notificationId}`;
      if (pushDeliveryDedupe.has(dedupeKey)) continue;
      const delivery = {
        id: createId("push_delivery"), userId, subscriptionId: subscription.id, notificationId,
        status: "queued", attempts: 0, nextAttemptAt: timestamp, leaseUntil: null,
        lastFailureCode: null, acceptedAt: null, createdAt: timestamp, updatedAt: timestamp,
      };
      pushDeliveries.set(delivery.id, delivery);
      pushDeliveryDedupe.set(dedupeKey, delivery.id);
      created.push(delivery.id);
    }
    if (created.length > 0) notifyChanged();
    return created;
  }

  function claimPushDeliveries({ limit = 10, leaseMs = 30_000, now = requestNow() } = {}) {
    const timestamp = new Date(now).toISOString();
    const candidates = [...pushDeliveries.values()]
      .filter((delivery) => (delivery.status === "queued" || delivery.status === "retry")
        && Date.parse(delivery.nextAttemptAt) <= now
        && (!delivery.leaseUntil || Date.parse(delivery.leaseUntil) <= now))
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))
      .slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)));
    const claimed = [];
    for (const delivery of candidates) {
      const subscription = pushSubscriptions.get(delivery.subscriptionId);
      const notification = notifications.get(delivery.notificationId);
      if (!subscription || subscription.revokedAt || !notification || notification.dismissedAt) {
        delivery.status = "cancelled";
        delivery.updatedAt = timestamp;
        continue;
      }
      delivery.status = "sending";
      delivery.attempts += 1;
      delivery.leaseUntil = new Date(now + leaseMs).toISOString();
      delivery.updatedAt = timestamp;
      claimed.push({
        delivery: { ...delivery },
        subscription: {
          ...subscription,
          endpoint: pushSecretBox.open(subscription.endpoint),
          keys: {
            p256dh: pushSecretBox.open(subscription.keys.p256dh),
            auth: pushSecretBox.open(subscription.keys.auth),
          },
        },
        notification: { ...notification },
      });
    }
    if (candidates.length > 0) notifyChanged();
    return claimed;
  }

  function settlePushDelivery({ deliveryId, outcome, failureCode = null, retryAt = null }) {
    const delivery = pushDeliveries.get(deliveryId);
    if (!delivery || delivery.status !== "sending") return null;
    const timestamp = new Date(requestNow()).toISOString();
    delivery.leaseUntil = null;
    delivery.updatedAt = timestamp;
    delivery.lastFailureCode = failureCode;
    if (outcome === "accepted") {
      delivery.status = "accepted";
      delivery.acceptedAt = timestamp;
      const subscription = pushSubscriptions.get(delivery.subscriptionId);
      if (subscription) {
        subscription.lastAcceptedAt = timestamp;
        subscription.lastFailureCode = null;
        subscription.updatedAt = timestamp;
      }
    } else if (outcome === "retry" && delivery.attempts < 5) {
      delivery.status = "retry";
      delivery.nextAttemptAt = new Date(retryAt ?? requestNow() + Math.min(60_000, 1_000 * (2 ** delivery.attempts))).toISOString();
    } else {
      delivery.status = outcome === "gone" ? "gone" : "failed";
      const subscription = pushSubscriptions.get(delivery.subscriptionId);
      if (subscription) {
        subscription.lastFailureCode = failureCode;
        subscription.updatedAt = timestamp;
        if (outcome === "gone") subscription.revokedAt = timestamp;
      }
    }
    notifyChanged();
    return { ...delivery };
  }

  function pruneNotifications(userId) {
    const cutoff = requestNow() - NOTIFICATION_RETENTION_MS;
    for (const notification of notifications.values()) {
      if (notification.userId === userId && Date.parse(notification.createdAt) <= cutoff) {
        removeNotification(notification);
      }
    }
    const owned = [...notifications.values()].filter((notification) => notification.userId === userId);
    if (owned.length <= NOTIFICATION_MAX_PER_OWNER) return;
    owned.sort((left, right) => {
      const leftPriority = left.dismissedAt ? 0 : left.readAt ? 1 : 2;
      const rightPriority = right.dismissedAt ? 0 : right.readAt ? 1 : 2;
      return leftPriority - rightPriority || left.sequence - right.sequence;
    });
    for (const notification of owned.slice(0, owned.length - NOTIFICATION_MAX_PER_OWNER)) {
      removeNotification(notification);
    }
  }

  function removeNotification(notification) {
    notifications.delete(notification.id);
    notificationDedupe.delete(notificationKey(notification));
  }

  function createCommand(input) {
    const command = {
      id: createId("cmd"),
      userId: input.userId,
      deviceId: input.deviceId ?? null,
      environmentId: input.environmentId,
      threadId: input.threadId ?? null,
      intent: input.intent,
      normalized: input.normalized,
      status: input.status,
      risk: input.risk,
      result: input.result ?? null,
      metrics: normalizeCommandMetrics(input.metrics),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    commands.set(command.id, command);
    recordCommandEvent({
      userId: command.userId,
      commandId: command.id,
      deviceId: command.deviceId,
      actorType: input.deviceId ? "device" : "user",
      actorId: input.deviceId,
      status: command.status,
      risk: command.risk,
      result: command.result,
      metrics: command.metrics,
    });
    audit({
      userId: input.userId,
      actorType: input.deviceId ? "device" : "user",
      actorId: input.deviceId,
      action: `command.${input.status}`,
      targetId: command.id,
      metadata: { intentType: input.intent.type, risk: input.risk },
    });
    notifyChanged();
    return command;
  }

  function getCommandForUser(userId, commandId) {
    const command = commands.get(commandId);
    if (!command || command.userId !== userId) return null;
    return command;
  }

  // -------------------------------------------------------------------------------------------
  // Provider approval decisions (src/providerApprovals.mjs)
  //
  // A pending provider approval lives in T3, not here. What lives here is the record that THIS
  // gateway answered it, and that record exists for exactly one reason: a decision cannot be
  // taken twice. Two console tabs, a console and a controller, or one impatient double-tap all
  // race for the same live provider callback, and T3 has no idempotency key of its own — a second
  // dispatch either resolves a request the first already answered or fails asynchronously with a
  // stale-request activity nobody asked for.
  //
  // So the claim is the primitive, not the write. `claimProviderApprovalDecision` is a
  // check-and-set: the first caller gets `claimed: true` and owns the dispatch; everyone after
  // gets the existing record and, when they asked for a DIFFERENT decision, `conflict: true` —
  // because the first answer has already reached the provider and cannot be taken back.
  //
  // A record whose dispatch failed is re-claimable. Otherwise a T3 outage of one second would
  // lock an approval out of reach permanently, and the owner's only recourse would be to restart
  // the turn.
  function claimProviderApprovalDecision({
    userId,
    environmentId,
    threadId,
    requestId,
    decision,
    actorType = "user",
    actorId = null,
  }) {
    const key = providerApprovalKey({ userId, environmentId, threadId, requestId });
    const existing = providerApprovalDecisions.get(key);
    if (existing && existing.status !== "failed") {
      return { claimed: false, conflict: existing.decision !== decision, decision: existing };
    }
    const record = {
      id: existing?.id ?? createId("papproval"),
      userId,
      environmentId,
      threadId,
      requestId,
      decision,
      status: "claimed",
      actorType,
      actorId: actorId ?? null,
      commandId: null,
      error: null,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    providerApprovalDecisions.set(key, record);
    audit({
      userId,
      actorType,
      actorId,
      action: "provider_approval.claimed",
      targetId: requestId,
      metadata: { environmentId, threadId, decision },
    });
    notifyChanged();
    return { claimed: true, conflict: false, decision: record };
  }

  function updateProviderApprovalDecision({
    userId,
    environmentId,
    threadId,
    requestId,
    status,
    commandId,
    error,
  }) {
    const key = providerApprovalKey({ userId, environmentId, threadId, requestId });
    const record = providerApprovalDecisions.get(key);
    if (!record) return null;
    if (status !== undefined) record.status = status;
    if (commandId !== undefined) record.commandId = commandId;
    if (error !== undefined) record.error = error;
    record.updatedAt = nowIso();
    notifyChanged();
    return record;
  }

  function listProviderApprovalDecisions({ userId, environmentId = null, threadId = null }) {
    return [...providerApprovalDecisions.values()].filter((record) =>
      record.userId === userId
      && (!environmentId || record.environmentId === environmentId)
      && (!threadId || record.threadId === threadId));
  }

  // -------------------------------------------------------------------------------------------
  // Provider user-input answers (src/userInput.mjs)
  //
  // Same primitive as claimProviderApprovalDecision() above, for the OTHER thing T3 holds open: a
  // question the agent asked. The race is identical — two console tabs, a console and a
  // controller, or one impatient double-tap all compete for the same live provider callback, and
  // T3 has no idempotency key of its own — so the claim is again the primitive, not the write.
  //
  // ONE DELIBERATE DIFFERENCE: this row does NOT hold the answers. A question id is the question
  // text (Claude requires it: ClaudeAdapter.ts:3782-3790) and a free-text answer is whatever the
  // owner typed, so both are user content, and user content in a persisted row is content a
  // support bundle has to redact. What the claim actually needs is only the ability to tell "the
  // same answer again" from "a different answer", and a SHA-256 fingerprint
  // (`userInputAnswersFingerprint()`) does that exactly. So the durable record carries ids, a
  // status and a hash, and nothing readable at all.
  //
  // A record whose dispatch failed is re-claimable, for the same reason as an approval: otherwise
  // a one-second T3 outage would lock the question out of reach until the turn was restarted.
  function claimProviderUserInputAnswer({
    userId,
    environmentId,
    threadId,
    requestId,
    answersHash,
    actorType = "user",
    actorId = null,
  }) {
    const key = providerApprovalKey({ userId, environmentId, threadId, requestId });
    const existing = providerUserInputAnswers.get(key);
    if (existing && existing.status !== "failed") {
      return { claimed: false, conflict: existing.answersHash !== answersHash, answer: existing };
    }
    const record = {
      id: existing?.id ?? createId("pinput"),
      userId,
      environmentId,
      threadId,
      requestId,
      answersHash,
      status: "claimed",
      actorType,
      actorId: actorId ?? null,
      commandId: null,
      error: null,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    providerUserInputAnswers.set(key, record);
    audit({
      userId,
      actorType,
      actorId,
      action: "provider_user_input.claimed",
      targetId: requestId,
      // `answersHash` and not the answers: an audit row is exactly the place this must not leak.
      metadata: { environmentId, threadId, answersHash },
    });
    notifyChanged();
    return { claimed: true, conflict: false, answer: record };
  }

  function updateProviderUserInputAnswer({
    userId,
    environmentId,
    threadId,
    requestId,
    status,
    commandId,
    error,
  }) {
    const key = providerApprovalKey({ userId, environmentId, threadId, requestId });
    const record = providerUserInputAnswers.get(key);
    if (!record) return null;
    if (status !== undefined) record.status = status;
    if (commandId !== undefined) record.commandId = commandId;
    if (error !== undefined) record.error = error;
    record.updatedAt = nowIso();
    notifyChanged();
    return record;
  }

  function listProviderUserInputAnswers({ userId, environmentId = null, threadId = null }) {
    return [...providerUserInputAnswers.values()].filter((record) =>
      record.userId === userId
      && (!environmentId || record.environmentId === environmentId)
      && (!threadId || record.threadId === threadId));
  }

  function claimCommandApproval({ userId, commandId, leaseMs = 30_000 }) {
    const command = commands.get(commandId);
    if (!command || command.userId !== userId || command.status !== "approval_required") return null;
    const claimedAt = Date.parse(command.approvalClaimedAt ?? "");
    if (Number.isFinite(claimedAt) && Date.now() - claimedAt < leaseMs) return null;
    command.approvalClaimedAt = nowIso();
    return command;
  }

  function updateCommand({ userId, commandId, status, normalized, result, risk, metrics }) {
    const command = commands.get(commandId);
    if (!command || command.userId !== userId) return null;
    const previousStatus = command.status;
    if (status !== undefined) command.status = status;
    if (normalized !== undefined) command.normalized = normalized;
    if (result !== undefined) command.result = result;
    if (risk !== undefined) command.risk = risk;
    if (metrics !== undefined) command.metrics = normalizeCommandMetrics(metrics);
    command.updatedAt = nowIso();
    recordCommandEvent({
      userId,
      commandId: command.id,
      deviceId: command.deviceId,
      actorType: command.deviceId ? "device" : "user",
      actorId: command.deviceId,
      status: command.status,
      previousStatus,
      risk: command.risk,
      result: command.result,
      metrics: command.metrics,
    });
    audit({
      userId,
      actorType: command.deviceId ? "device" : "user",
      actorId: command.deviceId,
      action: `command.${command.status}`,
      targetId: command.id,
      metadata: {
        intentType: command.intent.type,
        risk: command.risk,
        previousStatus,
      },
    });
    notifyChanged();
    return command;
  }

  function listCommands(userId) {
    return [...commands.values()].filter((command) => command.userId === userId);
  }

  function listCommandEvents({ userId, commandId }) {
    return [...commandEvents.values()]
      .filter((event) => event.userId === userId && (!commandId || event.commandId === commandId));
  }

  function recordCommandEvent(input) {
    const event = {
      id: createId("cmdevt"),
      userId: input.userId,
      commandId: input.commandId,
      deviceId: input.deviceId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      status: input.status,
      previousStatus: input.previousStatus ?? null,
      risk: input.risk,
      result: input.result ?? null,
      metrics: normalizeCommandMetrics(input.metrics),
      createdAt: nowIso(),
    };
    commandEvents.set(event.id, event);
    return event;
  }

  function audit(input) {
    auditLogs.push({
      id: createId("audit"),
      userId: input.userId,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? {},
      createdAt: nowIso(),
    });
  }

  function listAuditLogs(userId) {
    return auditLogs.filter((event) => event.userId === userId);
  }

  /**
   * The fixed-size answer behind the display poll (`GET /v1/device/display`, every five seconds).
   *
   * One method instead of a family of `countX()` / `latestX()` calls, for two reasons. The caller
   * always wants the whole set at once, so splitting it only creates ways to fetch a partial one;
   * and under the Convex store every store method is a network round trip, so eight small methods
   * would put eight round trips on the path a controller hits every five seconds — the same shape
   * that was already producing `HTTPClient error(-11)` on the firmware side. This is one call and
   * one response whose size does not depend on how much history the account has.
   *
   * The two latest rows come back as projections, not records. A command carries its intent
   * payload and its translated T3 command and an audit entry carries arbitrary metadata; the
   * display renders a status, an intent type and an action name, and shipping the rest would put
   * user content on a device-realm response that has no use for it.
   *
   * Counts are computed by iteration rather than by building and measuring arrays, so nothing here
   * materialises a collection. `environments` deliberately counts distinct base URLs, because
   * `listEnvironments()` collapses duplicates and a raw row count would disagree with the list the
   * console shows.
   */
  function getDisplaySummary(userId) {
    let deviceCount = 0;
    let onlineDevices = 0;
    for (const device of devices.values()) {
      if (device.userId !== userId) continue;
      deviceCount += 1;
      if (buildDevicePresence(device).online) onlineDevices += 1;
    }

    const environmentUrls = new Set();
    for (const environment of environments.values()) {
      if (environment.userId === userId && !environment.archivedAt) environmentUrls.add(environment.baseUrl);
    }

    let mediaCount = 0;
    for (const media of mediaUploads.values()) {
      if (media.userId === userId) mediaCount += 1;
    }

    let macroCount = 0;
    for (const macro of macros.values()) {
      if (macro.userId === userId) macroCount += 1;
    }

    // Insertion order is creation order for both of these — commands are keyed by id and an update
    // re-sets an existing key, which does not move it — so the last match is the newest, exactly
    // what `listCommands(userId).at(-1)` used to return.
    let commandCount = 0;
    let latestCommand = null;
    for (const command of commands.values()) {
      if (command.userId !== userId) continue;
      commandCount += 1;
      latestCommand = command;
    }

    let auditCount = 0;
    let latestAudit = null;
    for (const event of auditLogs) {
      if (event.userId !== userId) continue;
      auditCount += 1;
      latestAudit = event;
    }

    return {
      counts: {
        environments: environmentUrls.size,
        devices: deviceCount,
        media: mediaCount,
        macros: macroCount,
        commands: commandCount,
        audit: auditCount,
        onlineDevices,
        offlineDevices: Math.max(0, deviceCount - onlineDevices),
      },
      latestCommand: latestCommand
        ? {
          id: latestCommand.id,
          status: latestCommand.status,
          intentType: latestCommand.intent?.type ?? null,
          createdAt: latestCommand.createdAt ?? null,
        }
        : null,
      latestAudit: latestAudit
        ? {
          id: latestAudit.id,
          action: latestAudit.action,
          createdAt: latestAudit.createdAt ?? null,
        }
        : null,
    };
  }

  return {
    subscribe,
    exportState,
    ensureUser,
    getUserPrivacySettings,
    updateUserPrivacySettings,
    getUserSubscription,
    updateUserSubscription,
    getUserOnboarding,
    updateUserOnboarding,
    createUserToken,
    authenticateUserToken,
    createDevice,
    preprovisionDevice,
    claimDevice,
    revokeDevice,
    deleteDevice,
    rotateDeviceSecret,
    updateDeviceProfile,
    resetDeviceForTransfer,
    stageDeviceSecret,
    acknowledgeDeviceSecret,
    ensureUnclaimedDeviceClaimCode,
    authenticateDevice,
    recordDeviceHeartbeat,
    listDevices,
    getDeviceForUser,
    updateDeviceConfig,
    setDeviceVoiceAutoSend,
    upsertEnvironment,
    archiveEnvironment,
    restoreEnvironment,
    listExpiredEnvironments,
    purgeEnvironment,
    deleteEnvironment,
    updateEnvironmentHealth,
    updateEnvironmentCatalogue,
    getEnvironmentForUser,
    listEnvironments,
    listArchivedEnvironments,
    createConnectSession,
    getConnectSession,
    claimConnectSession,
    completeConnectSession,
    createConnector,
    authenticateConnector,
    authenticateConnectorForRevocation,
    beginConnectorCredentialRotation,
    listConnectors,
    listBackgroundWorkUsers,
    getConnectorForUser,
    revokeConnector,
    revokeConnectorByCredential,
    createConnectorTicket,
    consumeConnectorTicket,
    recordConnectorPresence,
    createGatewayProfile,
    listGatewayProfiles,
    getGatewayProfileForUser,
    updateGatewayProfile,
    deleteGatewayProfile,
    getDeviceGatewaySelection,
    stageDeviceGatewaySwitch,
    reportDeviceGatewaySwitch,
    rollbackDeviceGatewaySwitch,
    createFirmwareRelease,
    deleteFirmwareRelease,
    listFirmwareReleases,
    getLatestFirmwareRelease,
    getFirmwareArtifact,
    createReleaseRollout,
    listReleaseRollouts,
    listRunnableReleaseRollouts,
    getReleaseRolloutForUser,
    transitionReleaseRollout,
    upsertRolloutAssignment,
    listRolloutAssignments,
    createCompanionHandoff,
    getCompanionHandoffForUser,
    getCompanionHandoffForDevice,
    claimCompanionHandoff,
    cancelCompanionHandoff,
    completeCompanionHandoff,
    createMediaUploadSession,
    getMediaUploadSessionForActor,
    markMediaUploadSessionUploaded,
    finalizeMediaUploadSession,
    abortMediaUploadSession,
    listExpiredMediaUploadSessions,
    createMediaUpload,
    getMediaForUser,
    createDeviceProfile,
    listUserDeviceProfiles,
    getUserDeviceProfile,
    updateDeviceProfileDefinition,
    deleteDeviceProfile,
    updateMediaTranscript,
    updateMediaDescription,
    updateMediaProcessing,
    listMediaUploads,
    listExpiredMediaUploads,
    deleteMediaUpload,
    createMediaJob,
    getMediaJobForUser,
    listMediaJobs,
    claimMediaJobs,
    updateMediaJob,
    requeueMediaJob,
    createAction,
    getActionForUser,
    listActions,
    updateAction,
    deleteAction,
    recordActionRun,
    createMacroRun,
    getMacroRunForApproval,
    claimMacroRunForResume,
    updateMacroRun,
    getDeviceControls,
    updateDeviceControls,
    acknowledgeDeviceControls,
    getDeviceFirmwarePolicy,
    updateDeviceFirmwarePolicy,
    createMacro,
    getMacroForUser,
    listMacros,
    deleteMacro,
    claimCommandRequest,
    settleCommandRequest,
    getCommandRequest,
    createCommand,
    getCommandForUser,
    claimCommandApproval,
    claimProviderApprovalDecision,
    updateProviderApprovalDecision,
    listProviderApprovalDecisions,
    claimProviderUserInputAnswer,
    updateProviderUserInputAnswer,
    listProviderUserInputAnswers,
    createNotification,
    listNotifications,
    markNotificationRead,
    dismissNotification,
    dismissNotificationByDedupe,
    markAllNotificationsRead,
    recordBackgroundLiveness,
    getBackgroundLiveness,
    upsertPushSubscription,
    listPushSubscriptions,
    revokePushSubscription,
    revokePushSubscriptionByEndpoint,
    enqueuePushDeliveries,
    claimPushDeliveries,
    settlePushDelivery,
    updateCommand,
    listCommands,
    listCommandEvents,
    listAuditLogs,
    getDisplaySummary,
  };
}

function providerApprovalKey({ userId, environmentId, threadId, requestId }) {
  return [userId, environmentId, threadId, requestId].join("\u0000");
}

function notificationKey({ userId, dedupeKey }) {
  return `${userId}\u0000${dedupeKey}`;
}

function parseNotificationCursor(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeNotificationTimestamp(value, fallbackMs) {
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return new Date(Number.isFinite(parsed) ? parsed : fallbackMs).toISOString();
}

function normalizeNotificationText(value, maxLength, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim().slice(0, maxLength);
}

function normalizeNullableNotificationText(value, maxLength) {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().slice(0, maxLength);
}

function normalizeBackgroundFailureCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_.:-]{0,63}$/u.test(value)
    ? value
    : "background_task_failed";
}

function publicPushSubscription(subscription) {
  return {
    id: subscription.id,
    vapidKeyId: subscription.vapidKeyId,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
    revokedAt: subscription.revokedAt ?? null,
    lastAcceptedAt: subscription.lastAcceptedAt ?? null,
    lastFailureCode: subscription.lastFailureCode ?? null,
  };
}

function createHumanCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let output = "";
  const raw = Buffer.from(createSecret(10), "base64url");
  for (let index = 0; index < 10; index += 1) {
    output += alphabet[raw[index] % alphabet.length];
    if (index === 4) output += "-";
  }
  return output;
}

function normalizeClaimCode(claimCode) {
  return String(claimCode).trim().toUpperCase().replace(/[^A-Z0-9]/gu, "");
}

function createDefaultDeviceConfig() {
  return {
    environmentId: null,
    // The T3 project ("folder") the device is working inside. Null means the whole
    // environment: every thread the owner's environment holds stays selectable, which
    // is what firmware that predates project selection expects.
    projectId: null,
    threadId: null,
    gatewayAccessMode: "local",
    gatewayUrl: null,
    defaultPrompt: "Continue the current task, inspect progress, and run relevant tests.",
    shellCommand: "npm test",
    menu: ["status", "prompt", "shell", "macro", "thread", "media", "stop"],
  };
}

function createDefaultDeviceStatus() {
  return {
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
}

function createDefaultFirmwarePolicy() {
  return {
    channel: "stable",
    updateMode: "manual",
    desiredVersion: null,
    lastUpdateStatus: null,
    lastUpdateAt: null,
    lastUpdateError: null,
    updateProgress: null,
    targetVersion: null,
  };
}

function createDefaultDeviceControls(device) {
  return {
    userId: device.userId,
    deviceId: device.id,
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

function normalizeDeviceStatus(input = {}, existing = null, heartbeatAt = nowIso()) {
  const base = {
    ...createDefaultDeviceStatus(),
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
      ? [...new Set(input.features.filter((feature) => typeof feature === "string" && feature.trim()).map((feature) => feature.trim()))].slice(0, 32)
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

function normalizeGatewayTelemetry(input) {
  const reportedStatus = input.switchStatus ?? input.state;
  const status = reportedStatus === "stable" ? "active"
    : reportedStatus === "pending" ? "probing"
      : ["active", "probing", "failed"].includes(reportedStatus) ? reportedStatus : "active";
  return {
    activeProfileId: normalizeNullableString(input.activeProfileId),
    activeUrl: normalizeNullableString(input.activeUrl),
    pendingProfileId: normalizeNullableString(input.pendingProfileId),
    pendingUrl: normalizeNullableString(input.pendingUrl),
    switchStatus: status,
    detail: normalizeNullableString(input.detail),
  };
}

function normalizeFirmwarePolicy(input = {}, existing = null) {
  const next = { ...createDefaultFirmwarePolicy(), ...(existing ?? {}) };
  if (Object.hasOwn(input, "channel") && ["stable", "beta"].includes(input.channel)) {
    next.channel = input.channel;
  }
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

function normalizeDeviceConfig(input = {}, existing = null) {
  const base = {
    ...createDefaultDeviceConfig(),
    ...(existing ?? {}),
  };
  const next = { ...base };

  if (Object.hasOwn(input, "environmentId")) {
    next.environmentId = normalizeNullableString(input.environmentId);
  }
  if (Object.hasOwn(input, "projectId")) {
    next.projectId = normalizeNullableString(input.projectId);
  }
  if (Object.hasOwn(input, "threadId")) {
    next.threadId = normalizeNullableString(input.threadId);
  }
  if (Object.hasOwn(input, "gatewayAccessMode") && ["local", "tailscale", "online"].includes(input.gatewayAccessMode)) {
    next.gatewayAccessMode = input.gatewayAccessMode;
  }
  if (Object.hasOwn(input, "gatewayUrl")) {
    next.gatewayUrl = normalizeNullableString(input.gatewayUrl)?.replace(/\/+$/u, "") ?? null;
  }
  if (Object.hasOwn(input, "defaultPrompt")) {
    const value = normalizeNullableString(input.defaultPrompt);
    next.defaultPrompt = value || createDefaultDeviceConfig().defaultPrompt;
  }
  if (Object.hasOwn(input, "shellCommand")) {
    const value = normalizeNullableString(input.shellCommand);
    next.shellCommand = value || createDefaultDeviceConfig().shellCommand;
  }
  if (Object.hasOwn(input, "menu")) {
    const allowed = new Set(["status", "prompt", "shell", "macro", "approve", "reject", "media", "stop", "thread", "reset"]);
    const menu = Array.isArray(input.menu)
      ? input.menu
        .map((item) => normalizeNullableString(item))
        .filter((item) => item && allowed.has(item))
      : [];
    // 8 matches kMaxMenuItems in the firmware. Anything beyond it is dropped here
    // silently, so this cap must not be tighter than what the hardware can render.
    next.menu = [...new Set(menu)].slice(0, 8);
    if (next.menu.length === 0) next.menu = createDefaultDeviceConfig().menu;
  }

  return next;
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeEnvironmentHealth(input = {}, existing = null) {
  const base = {
    lastCheckedAt: null,
    lastReachableAt: null,
    lastError: null,
    failureReason: null,
    snapshot: null,
    compatibility: null,
    capabilities: null,
    ...(existing ?? {}),
  };
  return {
    ...base,
    ...(Object.hasOwn(input, "lastCheckedAt") ? { lastCheckedAt: normalizeNullableString(input.lastCheckedAt) } : {}),
    ...(Object.hasOwn(input, "lastReachableAt") ? { lastReachableAt: normalizeNullableString(input.lastReachableAt) } : {}),
    ...(Object.hasOwn(input, "lastError") ? { lastError: normalizeNullableString(input.lastError) } : {}),
    ...(Object.hasOwn(input, "failureReason") ? { failureReason: normalizeEnvironmentFailureReason(input.failureReason) } : {}),
    ...(Object.hasOwn(input, "snapshot") ? { snapshot: input.snapshot ?? null } : {}),
    ...(Object.hasOwn(input, "compatibility") ? { compatibility: input.compatibility ?? null } : {}),
    ...(Object.hasOwn(input, "capabilities") ? { capabilities: input.capabilities ?? null } : {}),
  };
}

function normalizeEnvironmentFailureReason(value) {
  return ENVIRONMENT_FAILURE_REASONS.includes(value) ? value : null;
}

function normalizeCommandMetrics(input = {}) {
  const metrics = input && typeof input === "object" ? input : {};
  return {
    acknowledgementDurationMs: normalizeOptionalNumber(metrics.acknowledgementDurationMs),
    dispatchDurationMs: normalizeOptionalNumber(metrics.dispatchDurationMs),
    ...(typeof metrics.dispatchStartedAt === "string" ? { dispatchStartedAt: normalizeNullableString(metrics.dispatchStartedAt) } : {}),
    completedAt: normalizeNullableString(metrics.completedAt),
    failureAt: normalizeNullableString(metrics.failureAt),
  };
}

function normalizePrivacySettings(input = {}, existing = DEFAULT_PRIVACY_SETTINGS) {
  const base = {
    ...DEFAULT_PRIVACY_SETTINGS,
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

export function createMemoryStore(seed) {
  return createStore(seed);
}

function normalizeTranscript(value) {
  if (typeof value !== "string") return undefined;
  const transcript = value.trim();
  return transcript.length > 0 ? transcript.slice(0, 12000) : undefined;
}

// The raw ASR version is kept verbatim — leading and trailing whitespace included — because the
// point of storing it is to be able to see exactly what the provider returned. Only the length is
// bounded, and only so one runaway response cannot bloat the row.
function normalizeRawTranscript(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, 12000);
}

function normalizeAttemptLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MEDIA_JOB_MAX_ATTEMPTS;
  return Math.min(parsed, 10);
}

/**
 * Where a claimed job picks back up.
 *
 * Derived from what is already stored rather than from the stage it crashed in, so a worker that
 * died after writing the raw transcript does not pay for the ASR call twice.
 */
function resumeStageFor(job) {
  if (job.rawTranscript === null) return "transcribing";
  if (job.normalizedTranscript === null) return "normalizing";
  return "dispatching";
}

const MEDIA_PROCESSING_STATUSES = new Set(["pending", "processing", "ready", "failed", "unavailable"]);

function normalizeMediaProcessing(input = null, kind = "image", transcript = null, description = null) {
  const now = nowIso();
  if (kind === "image") {
    // Images carry vision state instead of transcription state.
    const status = MEDIA_PROCESSING_STATUSES.has(input?.visionStatus)
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
  const allowed = MEDIA_PROCESSING_STATUSES;
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

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    privacy: normalizePrivacySettings(user.privacy),
    onboarding: normalizeStoredOnboarding(user.onboarding),
    createdAt: user.createdAt,
  };
}

function publicDevice(device, rotationNow = Date.now()) {
  const {
    secretHash,
    claimCodeHash,
    pendingSecretHash,
    pendingCredentialVersion,
    rotationId,
    rotationPurpose,
    rotationStartedAt,
    rotationExpiresAt,
    rotationCompletedAt,
    ...publicFields
  } = device;
  return {
    ...publicFields,
    credentialVersion: device.credentialVersion ?? 1,
    credentialRotation: publicDeviceCredentialRotation(device, rotationNow),
    gatewaySelection: normalizeGatewaySelection(device.gatewaySelection),
    config: normalizeDeviceConfig({}, device.config),
    status: normalizeDeviceStatus({}, device.status, device.status?.lastHeartbeatAt ?? null),
    firmwarePolicy: normalizeFirmwarePolicy({}, device.firmwarePolicy),
    presence: buildDevicePresence(device),
    actions: deviceActions(device),
    voiceAutoSend: normalizeVoiceAutoSend(device.voiceAutoSend, deviceReportsMicrophone(device)),
    claimed: Boolean(device.claimedAt),
  };
}

function clearPendingDeviceCredential(device) {
  device.pendingSecretHash = null;
  device.pendingCredentialVersion = null;
  device.rotationId = null;
  device.rotationPurpose = null;
  device.rotationStartedAt = null;
  device.rotationExpiresAt = null;
  device.rotationCompletedAt = null;
}

function publicDeviceCredentialRotation(device, now = Date.now()) {
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

function deviceForGateway(device, authenticatedCredentialVersion, credentialState, rotationNow = Date.now()) {
  return {
    ...publicDevice(device, rotationNow),
    authenticatedCredentialVersion,
    credentialState,
  };
}

/**
 * Whether this device may dispatch a finished voice transcript without a person looking at it.
 *
 * Three states, not two. `ownerChoice` is the only thing an owner writes — `true`, `false`, or
 * `null` for "never said" — and `enabled` is derived from it: an explicit choice always wins, and
 * only in its absence does the hardware decide. A controller that reports a microphone auto-sends
 * by default, because a controller whose whole purpose is to be spoken to should not transcribe
 * into a queue nobody drains; a board with no microphone is never granted a licence it could not
 * use anyway.
 *
 * Collapsing this back to one boolean is the bug the third state exists to prevent: an owner who
 * turns auto-send off would be indistinguishable from an owner who has not looked at the setting,
 * and the default would switch it back on at the next heartbeat, restart or re-claim.
 *
 * `enabledBy`/`enabledAt` stay reserved for a real grant. A default has no human behind it, so it
 * is reported as `source: "default"` with no name attached rather than forging one.
 */
function normalizeVoiceAutoSend(input = null, audioCapable = false) {
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
 * The owner's decision, read out of a row that may predate the three-state model.
 *
 * A legacy row only ever stored `enabled`, and it cleared `enabledBy`/`enabledAt` on disable — so a
 * stored `false` there is genuinely ambiguous between "the owner turned this off" and "nobody ever
 * touched it", with nothing in the record to separate them. It is read as the latter, which is what
 * lets an audio device pick up the new default; a legacy grant is preserved exactly.
 */
function normalizeVoiceAutoSendChoice(input) {
  if (input?.ownerChoice === true) return true;
  if (input?.ownerChoice === false) return false;
  if (input?.ownerChoice === undefined && input?.enabled === true) return true;
  return null;
}

/**
 * Whether this device has ever told the gateway it has a microphone.
 *
 * Evidence, not inference: `status.features` is what the firmware declared on a heartbeat it
 * actually sent. A hardware model that is *supposed* to have a microphone proves nothing about the
 * unit in the room, and a default that turns itself on for a device that never claimed one would be
 * a grant issued against a guess.
 */
function deviceReportsMicrophone(device) {
  const features = device?.status?.features;
  return Array.isArray(features) && features.includes("microphone");
}

function publicFirmwareRelease(release) {
  if (!release) return null;
  const { artifactKey, artifactProvider, ...output } = release;
  return { ...output, channel: release.channel ?? "stable" };
}

function cloneRolloutCohort(cohort) {
  return cohort?.type === "allowlist"
    ? { type: "allowlist", targetIds: [...(cohort.targetIds ?? [])] }
    : { type: "percentage", percentage: cohort?.percentage ?? 0 };
}

function publicReleaseRollout(rollout, assignments) {
  if (!rollout) return null;
  const rows = [...assignments.values()].filter((assignment) => assignment.rolloutId === rollout.id);
  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return {
    ...rollout,
    cohort: cloneRolloutCohort(rollout.cohort),
    requiredCapabilities: [...rollout.requiredCapabilities],
    progress: { total: rows.length, counts },
  };
}

function normalizeGatewaySelection(input = null) {
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

/**
 * Which owner operations this device can currently accept.
 *
 * Every store mutation below already refuses a revoked device, but a client has no way to know
 * that and had to re-derive it from `revokedAt` — so each new guard here silently produced another
 * control that looks live and returns 404. Declaring the answer keeps the UI honest without it
 * having to mirror rules it cannot see.
 */
function deviceActions(device) {
  const revoked = Boolean(device.revokedAt);
  return {
    // rotateDeviceSecret / resetDeviceForTransfer / updateDeviceConfig / updateDeviceProfile all
    // bail on device.revokedAt and return null, which the routes surface as 404.
    rotateSecret: !revoked,
    transferReset: !revoked,
    updateConfig: !revoked,
    updateProfile: !revoked,
    // revokeDevice does not check, so revoking twice succeeds while changing nothing. A no-op
    // dressed as a destructive action is worse than a refusal.
    revoke: !revoked,
    // The inverse of the rest: deleting is the one thing that only becomes available once the
    // credential is dead.
    delete: revoked,
  };
}

function buildDevicePresence(device, now = Date.now()) {
  const lastSeenAt = normalizeNullableString(device.lastSeenAt);
  const lastHeartbeatAt = normalizeNullableString(device.status?.lastHeartbeatAt);
  const latestActivityAt = latestIso(lastSeenAt, lastHeartbeatAt);
  const ageMs = latestActivityAt ? Math.max(0, now - Date.parse(latestActivityAt)) : null;
  const online = ageMs !== null && ageMs <= DEVICE_ONLINE_THRESHOLD_MS;
  return {
    state: online ? "online" : "offline",
    online,
    lastSeenAt,
    lastHeartbeatAt,
    latestActivityAt,
    ageMs,
    staleAfterMs: DEVICE_ONLINE_THRESHOLD_MS,
  };
}

function latestIso(...values) {
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

function publicUserToken(token) {
  const { tokenHash, ...publicFields } = token;
  return publicFields;
}

function publicMediaUpload(media) {
  const { storagePath, uploadSessionId, ...publicFields } = media;
  return {
    ...publicFields,
    // `description` matters: without it an image whose stored processing carries no visionStatus
    // falls back to "pending" even though a description exists. updateMediaProcessing already
    // passes it, so omitting it here made the public view disagree with the internal one about the
    // same record.
    processing: normalizeMediaProcessing(media.processing, media.kind, media.transcript, media.description),
    expiresAt: media.expiresAt ?? null,
  };
}

function publicMediaUploadSession(session) {
  return {
    id: session.id,
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

function expireCompanionHandoff(handoff, now) {
  if (handoff.status !== "waiting" || !Number.isFinite(now)) return false;
  if (Date.parse(handoff.expiresAt) > now) return false;
  handoff.status = "expired";
  handoff.codeHash = null;
  return true;
}

function publicCompanionHandoff(handoff) {
  const { codeHash, userId, ...publicFields } = handoff;
  return { ...publicFields };
}

function publicMacro(macro) {
  return {
    id: macro.id,
    userId: macro.userId,
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

function publicAction(action) {
  return {
    id: action.id,
    userId: action.userId,
    type: action.type,
    label: action.label,
    payload: structuredClone(action.payload ?? {}),
    targetMode: action.targetMode ?? "device-current",
    environmentId: action.environmentId ?? null,
    threadId: action.threadId ?? null,
    steps: structuredClone(action.steps ?? []),
    disabled: action.disabled === true,
    disabledReason: action.disabled === true ? (action.disabledReason ?? null) : null,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

function publicDeviceControls(controls) {
  return {
    deviceId: controls.deviceId,
    revision: controls.revision,
    explicit: controls.explicit === true,
    items: structuredClone(controls.items ?? []),
    appliedRevision: controls.appliedRevision ?? null,
    appliedAt: controls.appliedAt ?? null,
    lastAckStatus: controls.lastAckStatus ?? null,
    lastAckError: controls.lastAckError ?? null,
    updatedAt: controls.updatedAt,
  };
}

function publicEnvironment(environment) {
  const { accessToken, accessTokenCiphertext, ...publicFields } = environment;
  return {
    ...publicFields,
    health: normalizeEnvironmentHealth(environment.health),
  };
}

function publicConnectSession(session) {
  const { codeHash, ...publicFields } = session;
  return { purpose: session.purpose ?? "t3_enrollment", ...publicFields };
}

function publicConnector(connector) {
  const { secretHash, pendingSecretHash, pendingSecretPrefix, pendingCredentialVersion, ...publicFields } = connector;
  return {
    ...publicFields,
    rotationPending: Boolean(connector.pendingSecretHash && Date.parse(connector.rotationExpiresAt ?? "") > Date.now()),
  };
}

function connectorForGateway(connector, authenticatedCredentialVersion = connector.credentialVersion ?? 1, credentialState = "active", authenticatedRotationId = null) {
  return { ...publicConnector(connector), authenticatedCredentialVersion, credentialState, authenticatedRotationId };
}

function publicConnectorTicket(ticket) {
  return {
    id: ticket.id,
    connectorId: ticket.connectorId,
    environmentId: ticket.environmentId,
    audience: ticket.audience ?? CONNECTOR_TICKET_AUDIENCE,
    credentialVersion: ticket.credentialVersion ?? 1,
    rotationId: ticket.rotationId ?? null,
    expiresAt: ticket.expiresAt,
  };
}

function environmentForGateway(environment, tokenBox) {
  const publicFields = publicEnvironment(environment);
  const accessToken = environment.accessTokenCiphertext
    ? tokenBox.open(environment.accessTokenCiphertext)
    : environment.accessToken;
  return {
    ...publicFields,
    accessToken,
  };
}
