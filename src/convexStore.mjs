import { createHash, randomBytes } from "node:crypto";

import { CONNECT_SESSION_TTL_MS, normalizeConnectAccessMode } from "./connectSession.mjs";
import { CONNECTOR_TICKET_AUDIENCE, CONNECTOR_TICKET_TTL_MS } from "./connectorProtocol.mjs";
import { createSecretBox } from "./secretBox.mjs";

const DEFAULT_FUNCTIONS = {
  ensureUser: { type: "mutation", name: "gatewayStore:ensureUser" },
  getUserPrivacySettings: { type: "query", name: "gatewayStore:getUserPrivacySettings" },
  updateUserPrivacySettings: { type: "mutation", name: "gatewayStore:updateUserPrivacySettings" },
  getUserSubscription: { type: "query", name: "gatewayStore:getUserSubscription" },
  updateUserSubscription: { type: "mutation", name: "gatewayStore:updateUserSubscription" },
  getUserOnboarding: { type: "query", name: "gatewayStore:getUserOnboarding" },
  updateUserOnboarding: { type: "mutation", name: "gatewayStore:updateUserOnboarding" },
  createUserToken: { type: "mutation", name: "gatewayStore:createUserToken" },
  authenticateUserToken: { type: "mutation", name: "gatewayStore:authenticateUserToken" },
  createDevice: { type: "mutation", name: "gatewayStore:createDevice" },
  preprovisionDevice: { type: "mutation", name: "gatewayStore:preprovisionDevice" },
  claimDevice: { type: "mutation", name: "gatewayStore:claimDevice" },
  revokeDevice: { type: "mutation", name: "gatewayStore:revokeDevice" },
  deleteDevice: { type: "mutation", name: "gatewayStore:deleteDevice" },
  rotateDeviceSecret: { type: "mutation", name: "gatewayStore:rotateDeviceSecret" },
  stageDeviceSecret: { type: "mutation", name: "gatewayStore:stageDeviceSecret" },
  acknowledgeDeviceSecret: { type: "mutation", name: "gatewayStore:acknowledgeDeviceSecret" },
  updateDeviceProfile: { type: "mutation", name: "gatewayStore:updateDeviceProfile" },
  resetDeviceForTransfer: { type: "mutation", name: "gatewayStore:resetDeviceForTransfer" },
  ensureUnclaimedDeviceClaimCode: { type: "mutation", name: "gatewayStore:ensureUnclaimedDeviceClaimCode" },
  authenticateDevice: { type: "mutation", name: "gatewayStore:authenticateDevice" },
  recordDeviceHeartbeat: { type: "mutation", name: "gatewayStore:recordDeviceHeartbeat" },
  listDevices: { type: "query", name: "gatewayStore:listDevices" },
  getDeviceForUser: { type: "query", name: "gatewayStore:getDeviceForUser" },
  updateDeviceConfig: { type: "mutation", name: "gatewayStore:updateDeviceConfig" },
  setDeviceVoiceAutoSend: { type: "mutation", name: "gatewayStore:setDeviceVoiceAutoSend" },
  createGatewayProfile: { type: "mutation", name: "gatewayStore:createGatewayProfile" },
  listGatewayProfiles: { type: "query", name: "gatewayStore:listGatewayProfiles" },
  getGatewayProfileForUser: { type: "query", name: "gatewayStore:getGatewayProfileForUser" },
  updateGatewayProfile: { type: "mutation", name: "gatewayStore:updateGatewayProfile" },
  deleteGatewayProfile: { type: "mutation", name: "gatewayStore:deleteGatewayProfile" },
  getDeviceGatewaySelection: { type: "query", name: "gatewayStore:getDeviceGatewaySelection" },
  stageDeviceGatewaySwitch: { type: "mutation", name: "gatewayStore:stageDeviceGatewaySwitch" },
  reportDeviceGatewaySwitch: { type: "mutation", name: "gatewayStore:reportDeviceGatewaySwitch" },
  rollbackDeviceGatewaySwitch: { type: "mutation", name: "gatewayStore:rollbackDeviceGatewaySwitch" },
  upsertEnvironment: { type: "mutation", name: "gatewayStore:upsertEnvironment" },
  archiveEnvironment: { type: "mutation", name: "gatewayStore:archiveEnvironment" },
  restoreEnvironment: { type: "mutation", name: "gatewayStore:restoreEnvironment" },
  listExpiredEnvironments: { type: "query", name: "gatewayStore:listExpiredEnvironments" },
  purgeEnvironment: { type: "mutation", name: "gatewayStore:purgeEnvironment" },
  deleteEnvironment: { type: "mutation", name: "gatewayStore:deleteEnvironment" },
  updateEnvironmentHealth: { type: "mutation", name: "gatewayStore:updateEnvironmentHealth" },
  updateEnvironmentCatalogue: { type: "mutation", name: "gatewayStore:updateEnvironmentCatalogue" },
  getEnvironmentForUser: { type: "query", name: "gatewayStore:getEnvironmentForUser" },
  listEnvironments: { type: "query", name: "gatewayStore:listEnvironments" },
  listArchivedEnvironments: { type: "query", name: "gatewayStore:listArchivedEnvironments" },
  createConnectSession: { type: "mutation", name: "gatewayStore:createConnectSession" },
  getConnectSession: { type: "query", name: "gatewayStore:getConnectSession" },
  claimConnectSession: { type: "mutation", name: "gatewayStore:claimConnectSession" },
  completeConnectSession: { type: "mutation", name: "gatewayStore:completeConnectSession" },
  createConnector: { type: "mutation", name: "gatewayStore:createConnector" },
  // Authentication evaluates rotation expiry, so it must not be query-cached.
  authenticateConnector: { type: "mutation", name: "gatewayStore:authenticateConnector" },
  authenticateConnectorForRevocation: { type: "mutation", name: "gatewayStore:authenticateConnectorForRevocation" },
  beginConnectorCredentialRotation: { type: "mutation", name: "gatewayStore:beginConnectorCredentialRotation" },
  listConnectors: { type: "query", name: "gatewayStore:listConnectors" },
  listBackgroundWorkUsers: { type: "query", name: "gatewayStore:listBackgroundWorkUsers" },
  getConnectorForUser: { type: "query", name: "gatewayStore:getConnectorForUser" },
  revokeConnector: { type: "mutation", name: "gatewayStore:revokeConnector" },
  revokeConnectorByCredential: { type: "mutation", name: "gatewayStore:revokeConnectorByCredential" },
  createConnectorTicket: { type: "mutation", name: "gatewayStore:createConnectorTicket" },
  consumeConnectorTicket: { type: "mutation", name: "gatewayStore:consumeConnectorTicket" },
  recordConnectorPresence: { type: "mutation", name: "gatewayStore:recordConnectorPresence" },
  createFirmwareRelease: { type: "mutation", name: "gatewayStore:createFirmwareRelease" },
  deleteFirmwareRelease: { type: "mutation", name: "gatewayStore:deleteFirmwareRelease" },
  listFirmwareReleases: { type: "query", name: "gatewayStore:listFirmwareReleases" },
  getLatestFirmwareRelease: { type: "query", name: "gatewayStore:getLatestFirmwareRelease" },
  getFirmwareArtifact: { type: "query", name: "gatewayStore:getFirmwareArtifact" },
  createReleaseRollout: { type: "mutation", name: "gatewayStore:createReleaseRollout" },
  listReleaseRollouts: { type: "query", name: "gatewayStore:listReleaseRollouts" },
  listRunnableReleaseRollouts: { type: "query", name: "gatewayStore:listRunnableReleaseRollouts" },
  getReleaseRolloutForUser: { type: "query", name: "gatewayStore:getReleaseRolloutForUser" },
  transitionReleaseRollout: { type: "mutation", name: "gatewayStore:transitionReleaseRollout" },
  upsertRolloutAssignment: { type: "mutation", name: "gatewayStore:upsertRolloutAssignment" },
  listRolloutAssignments: { type: "query", name: "gatewayStore:listRolloutAssignments" },
  createCompanionHandoff: { type: "mutation", name: "gatewayStore:createCompanionHandoff" },
  getCompanionHandoffForUser: { type: "query", name: "gatewayStore:getCompanionHandoffForUser" },
  getCompanionHandoffForDevice: { type: "query", name: "gatewayStore:getCompanionHandoffForDevice" },
  claimCompanionHandoff: { type: "mutation", name: "gatewayStore:claimCompanionHandoff" },
  cancelCompanionHandoff: { type: "mutation", name: "gatewayStore:cancelCompanionHandoff" },
  completeCompanionHandoff: { type: "mutation", name: "gatewayStore:completeCompanionHandoff" },
  createMediaUploadSession: { type: "mutation", name: "gatewayStore:createMediaUploadSession" },
  getMediaUploadSessionForActor: { type: "query", name: "gatewayStore:getMediaUploadSessionForActor" },
  markMediaUploadSessionUploaded: { type: "mutation", name: "gatewayStore:markMediaUploadSessionUploaded" },
  finalizeMediaUploadSession: { type: "mutation", name: "gatewayStore:finalizeMediaUploadSession" },
  abortMediaUploadSession: { type: "mutation", name: "gatewayStore:abortMediaUploadSession" },
  listExpiredMediaUploadSessions: { type: "query", name: "gatewayStore:listExpiredMediaUploadSessions" },
  createMediaUpload: { type: "mutation", name: "gatewayStore:createMediaUpload" },
  getMediaForUser: { type: "query", name: "gatewayStore:getMediaForUser" },
  updateMediaTranscript: { type: "mutation", name: "gatewayStore:updateMediaTranscript" },
  updateMediaDescription: { type: "mutation", name: "gatewayStore:updateMediaDescription" },
  createDeviceProfile: { type: "mutation", name: "gatewayStore:createDeviceProfile" },
  listUserDeviceProfiles: { type: "query", name: "gatewayStore:listDeviceProfiles" },
  // Named to avoid colliding with updateDeviceProfile, which assigns a profile to a device.
  updateDeviceProfileDefinition: { type: "mutation", name: "gatewayStore:updateDeviceProfileDefinition" },
  deleteDeviceProfile: { type: "mutation", name: "gatewayStore:deleteDeviceProfile" },
  updateMediaProcessing: { type: "mutation", name: "gatewayStore:updateMediaProcessing" },
  listMediaUploads: { type: "query", name: "gatewayStore:listMediaUploads" },
  listExpiredMediaUploads: { type: "query", name: "gatewayStore:listExpiredMediaUploads" },
  deleteMediaUpload: { type: "mutation", name: "gatewayStore:deleteMediaUpload" },
  createMediaJob: { type: "mutation", name: "gatewayStore:createMediaJob" },
  getMediaJobForUser: { type: "query", name: "gatewayStore:getMediaJobForUser" },
  listMediaJobs: { type: "query", name: "gatewayStore:listMediaJobs" },
  claimMediaJobs: { type: "mutation", name: "gatewayStore:claimMediaJobs" },
  updateMediaJob: { type: "mutation", name: "gatewayStore:updateMediaJob" },
  requeueMediaJob: { type: "mutation", name: "gatewayStore:requeueMediaJob" },
  createAction: { type: "mutation", name: "gatewayStore:createAction" },
  getActionForUser: { type: "query", name: "gatewayStore:getActionForUser" },
  listActions: { type: "query", name: "gatewayStore:listActions" },
  updateAction: { type: "mutation", name: "gatewayStore:updateAction" },
  deleteAction: { type: "mutation", name: "gatewayStore:deleteAction" },
  recordActionRun: { type: "mutation", name: "gatewayStore:recordActionRun" },
  createMacroRun: { type: "mutation", name: "gatewayStore:createMacroRun" },
  getMacroRunForApproval: { type: "query", name: "gatewayStore:getMacroRunForApproval" },
  claimMacroRunForResume: { type: "mutation", name: "gatewayStore:claimMacroRunForResume" },
  updateMacroRun: { type: "mutation", name: "gatewayStore:updateMacroRun" },
  getDeviceControls: { type: "query", name: "gatewayStore:getDeviceControls" },
  updateDeviceControls: { type: "mutation", name: "gatewayStore:updateDeviceControls" },
  acknowledgeDeviceControls: { type: "mutation", name: "gatewayStore:acknowledgeDeviceControls" },
  getDeviceFirmwarePolicy: { type: "query", name: "gatewayStore:getDeviceFirmwarePolicy" },
  updateDeviceFirmwarePolicy: { type: "mutation", name: "gatewayStore:updateDeviceFirmwarePolicy" },
  createMacro: { type: "mutation", name: "gatewayStore:createMacro" },
  getMacroForUser: { type: "query", name: "gatewayStore:getMacroForUser" },
  listMacros: { type: "query", name: "gatewayStore:listMacros" },
  deleteMacro: { type: "mutation", name: "gatewayStore:deleteMacro" },
  createCommand: { type: "mutation", name: "gatewayStore:createCommand" },
  claimCommandRequest: { type: "mutation", name: "gatewayStore:claimCommandRequest" },
  settleCommandRequest: { type: "mutation", name: "gatewayStore:settleCommandRequest" },
  getCommandRequest: { type: "query", name: "gatewayStore:getCommandRequest" },
  getCommandForUser: { type: "query", name: "gatewayStore:getCommandForUser" },
  claimCommandApproval: { type: "mutation", name: "gatewayStore:claimCommandApproval" },
  claimProviderApprovalDecision: { type: "mutation", name: "gatewayStore:claimProviderApprovalDecision" },
  updateProviderApprovalDecision: { type: "mutation", name: "gatewayStore:updateProviderApprovalDecision" },
  listProviderApprovalDecisions: { type: "query", name: "gatewayStore:listProviderApprovalDecisions" },
  claimProviderUserInputAnswer: { type: "mutation", name: "gatewayStore:claimProviderUserInputAnswer" },
  updateProviderUserInputAnswer: { type: "mutation", name: "gatewayStore:updateProviderUserInputAnswer" },
  listProviderUserInputAnswers: { type: "query", name: "gatewayStore:listProviderUserInputAnswers" },
  createNotification: { type: "mutation", name: "gatewayStore:createNotification" },
  listNotifications: { type: "query", name: "gatewayStore:listNotifications" },
  markNotificationRead: { type: "mutation", name: "gatewayStore:markNotificationRead" },
  dismissNotification: { type: "mutation", name: "gatewayStore:dismissNotification" },
  dismissNotificationByDedupe: { type: "mutation", name: "gatewayStore:dismissNotificationByDedupe" },
  markAllNotificationsRead: { type: "mutation", name: "gatewayStore:markAllNotificationsRead" },
  recordBackgroundLiveness: { type: "mutation", name: "gatewayStore:recordBackgroundLiveness" },
  getBackgroundLiveness: { type: "query", name: "gatewayStore:getBackgroundLiveness" },
  upsertPushSubscription: { type: "mutation", name: "gatewayStore:upsertPushSubscription" },
  listPushSubscriptions: { type: "query", name: "gatewayStore:listPushSubscriptions" },
  revokePushSubscription: { type: "mutation", name: "gatewayStore:revokePushSubscription" },
  revokePushSubscriptionByEndpoint: { type: "mutation", name: "gatewayStore:revokePushSubscriptionByEndpoint" },
  enqueuePushDeliveries: { type: "mutation", name: "gatewayStore:enqueuePushDeliveries" },
  claimPushDeliveries: { type: "mutation", name: "gatewayStore:claimPushDeliveries" },
  settlePushDelivery: { type: "mutation", name: "gatewayStore:settlePushDelivery" },
  updateCommand: { type: "mutation", name: "gatewayStore:updateCommand" },
  listCommands: { type: "query", name: "gatewayStore:listCommands" },
  listCommandEvents: { type: "query", name: "gatewayStore:listCommandEvents" },
  listAuditLogs: { type: "query", name: "gatewayStore:listAuditLogs" },
  getDisplaySummary: { type: "query", name: "gatewayStore:getDisplaySummary" },
};

const SAFE_REMOTE_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "INVALID_ARGUMENT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export async function createConvexStore(config = {}, options = {}) {
  if (!config.convexUrl) {
    throw new Error("CONVEX_URL is required when STORAGE_PROVIDER=convex.");
  }
  const gatewaySecret = options.gatewaySecret ?? config.convexGatewaySecret;
  if (!gatewaySecret) {
    throw new Error("GATEWAY_CONVEX_SECRET is required when STORAGE_PROVIDER=convex.");
  }

  const client = options.client ?? await createConvexHttpClient(config.convexUrl, options);
  return createConvexStoreAdapter({
    client,
    functions: options.functions ?? DEFAULT_FUNCTIONS,
    gatewaySecret,
    t3TokenEncryptionKey: options.t3TokenEncryptionKey ?? config.t3TokenEncryptionKey ?? gatewaySecret,
    pushEncryptionKey: options.pushEncryptionKey ?? config.webPushEncryptionKey ?? gatewaySecret,
  });
}

export function createConvexStoreAdapter({
  client,
  functions = DEFAULT_FUNCTIONS,
  gatewaySecret = null,
  t3TokenEncryptionKey = null,
  pushEncryptionKey = null,
}) {
  if (!client || typeof client.query !== "function" || typeof client.mutation !== "function") {
    throw new Error("Convex store adapter requires a client with query() and mutation() methods.");
  }
  if (!gatewaySecret) {
    throw new Error("Convex store adapter requires a gatewaySecret.");
  }
  const t3TokenBox = createSecretBox(t3TokenEncryptionKey);
  const pushSecretBox = createSecretBox(pushEncryptionKey ?? t3TokenEncryptionKey);
  const listeners = new Set();

  function notify(change) {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        // A broken subscriber must never fail the store write that triggered it.
      }
    }
  }

  async function call(method, args) {
    const fn = functions[method];
    const input = { ...(args ?? {}), gatewaySecret };
    if (!fn) {
      throw new Error(`Convex Store API function mapping is missing for ${method}.`);
    }
    if (fn.type === "query") {
      try {
        return await client.query(fn.name, input);
      } catch (error) {
        throw remoteCallError(method, error);
      }
    }
    if (fn.type === "mutation") {
      let result;
      try {
        result = await client.mutation(fn.name, input);
      } catch (error) {
        throw remoteCallError(method, error);
      }
      // Convex holds the state, so there is no local store to diff. Emitting the affected user
      // on every mutation is what keeps live dashboard updates working under STORAGE_PROVIDER=convex.
      const userId = affectedUserId(args, result);
      if (userId) notify({ userId, action: method });
      return result;
    }
    throw new Error(`Convex Store API function ${method} has unsupported type ${fn.type}.`);
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exportState: emptyState,
    ensureUser: (args) => call("ensureUser", args),
    getUserPrivacySettings: (userId) => call("getUserPrivacySettings", { userId }),
    updateUserPrivacySettings: (args) => call("updateUserPrivacySettings", args),
    getUserSubscription: (userId) => call("getUserSubscription", { userId }),
    updateUserSubscription: (args) => call("updateUserSubscription", args),
    getUserOnboarding: (userId) => call("getUserOnboarding", { userId }),
    updateUserOnboarding: (args) => call("updateUserOnboarding", args),
    createUserToken: async (args) => {
      const secret = createSecret();
      const token = await call("createUserToken", {
        ...args,
        tokenHash: hashSecret(secret),
      });
      return { token, secret };
    },
    authenticateUserToken: (secret) => call("authenticateUserToken", {
      tokenHash: hashSecret(secret),
    }),
    createDevice: async (args) => {
      const secret = createSecret();
      const device = await call("createDevice", {
        ...args,
        secretHash: hashSecret(secret),
      });
      return { device, secret };
    },
    preprovisionDevice: async (args) => {
      const secret = createSecret();
      const claimCode = createHumanCode();
      const device = await call("preprovisionDevice", {
        ...args,
        secretHash: hashSecret(secret),
        claimCodeHash: hashSecret(normalizeClaimCode(claimCode)),
        claimCodeExpiresAt: claimCodeExpiryFrom(Date.now()),
      });
      return { device, secret, claimCode };
    },
    claimDevice: (args) => call("claimDevice", {
      userId: args.userId,
      label: args.label,
      claimCodeHash: hashSecret(normalizeClaimCode(args.claimCode)),
    }),
    revokeDevice: (args) => call("revokeDevice", args),
    deleteDevice: (args) => call("deleteDevice", args),
    updateDeviceProfile: (args) => call("updateDeviceProfile", args),
    rotateDeviceSecret: (args) => call("rotateDeviceSecret", args),
    resetDeviceForTransfer: (args) => call("resetDeviceForTransfer", args),
    stageDeviceSecret: ({ secret, ...args }) => call("stageDeviceSecret", {
      ...args,
      secretHash: hashSecret(secret),
    }),
    acknowledgeDeviceSecret: (args) => call("acknowledgeDeviceSecret", args),
    // The candidate code is minted here and only its hash crosses to Convex, matching
    // `preprovisionDevice`. Convex decides whether the existing code is still live; when it is, it
    // ignores the candidate and reports `rotated: false`, so the plaintext is discarded unused.
    ensureUnclaimedDeviceClaimCode: async ({ deviceId, rotate = false }) => {
      const claimCode = createHumanCode();
      const result = await call("ensureUnclaimedDeviceClaimCode", {
        deviceId,
        rotate,
        claimCodeHash: hashSecret(normalizeClaimCode(claimCode)),
        claimCodeExpiresAt: claimCodeExpiryFrom(Date.now()),
      });
      if (!result) return null;
      return {
        device: result.device,
        claimCode: result.rotated ? claimCode : null,
        rotated: result.rotated,
        claimCodeExpiresAt: result.device?.claimCodeExpiresAt ?? null,
      };
    },
    authenticateDevice: (deviceId, secret) => call("authenticateDevice", {
      deviceId,
      secretHash: hashSecret(secret),
    }),
    recordDeviceHeartbeat: (args) => call("recordDeviceHeartbeat", args),
    listDevices: (userId) => call("listDevices", { userId }),
    getDeviceForUser: (userId, deviceId) => call("getDeviceForUser", { userId, deviceId }),
    updateDeviceConfig: (args) => call("updateDeviceConfig", args),
    setDeviceVoiceAutoSend: (args) => call("setDeviceVoiceAutoSend", args),
    createGatewayProfile: (args) => call("createGatewayProfile", args),
    listGatewayProfiles: (userId) => call("listGatewayProfiles", { userId }),
    getGatewayProfileForUser: (userId, profileId) => call("getGatewayProfileForUser", { userId, profileId }),
    updateGatewayProfile: (args) => call("updateGatewayProfile", args),
    deleteGatewayProfile: (args) => call("deleteGatewayProfile", args),
    getDeviceGatewaySelection: (args) => call("getDeviceGatewaySelection", args),
    stageDeviceGatewaySwitch: (args) => call("stageDeviceGatewaySwitch", args),
    reportDeviceGatewaySwitch: (args) => call("reportDeviceGatewaySwitch", args),
    rollbackDeviceGatewaySwitch: (args) => call("rollbackDeviceGatewaySwitch", args),
    upsertEnvironment: (args) => call("upsertEnvironment", {
      ...args,
      ...(args.transportMode === "connector" || !args.accessToken
        ? { accessToken: undefined }
        : { accessToken: t3TokenBox.seal(args.accessToken) }),
    }),
    archiveEnvironment: (args) => call("archiveEnvironment", args),
    restoreEnvironment: (args) => call("restoreEnvironment", args),
    listExpiredEnvironments: (args) => call("listExpiredEnvironments", args),
    purgeEnvironment: (args) => call("purgeEnvironment", args),
    deleteEnvironment: (args) => call("deleteEnvironment", args),
    updateEnvironmentHealth: (args) => call("updateEnvironmentHealth", args),
    updateEnvironmentCatalogue: (args) => call("updateEnvironmentCatalogue", args),
    getEnvironmentForUser: async (userId, environmentId) => {
      const environment = await call("getEnvironmentForUser", { userId, environmentId });
      if (!environment) return null;
      return {
        ...environment,
        accessToken: environment.accessToken ? t3TokenBox.open(environment.accessToken) : undefined,
      };
    },
    listEnvironments: (userId) => call("listEnvironments", { userId }),
    listArchivedEnvironments: (userId) => call("listArchivedEnvironments", { userId }),
    // The code is generated in Node and only its hash crosses the wire, so Convex never holds
    // enough to reconstruct a usable enrollment credential.
    createConnectSession: async (args) => {
      const code = createHumanCode();
      const session = await call("createConnectSession", {
        userId: args.userId,
        label: args.label ?? "T3 Code",
        accessMode: normalizeConnectAccessMode(args.accessMode),
        environmentId: args.environmentId ?? null,
        purpose: args.purpose ?? "t3_enrollment",
        codeHash: hashSecret(normalizeClaimCode(code)),
        expiresAt: new Date(Date.now() + CONNECT_SESSION_TTL_MS).toISOString(),
      });
      return { session, code };
    },
    getConnectSession: (args) => call("getConnectSession", args),
    claimConnectSession: (args) => call("claimConnectSession", {
      codeHash: hashSecret(normalizeClaimCode(args.code)),
    }),
    completeConnectSession: (args) => call("completeConnectSession", {
      sessionId: args.sessionId,
      environmentId: args.environmentId ?? null,
      baseUrl: args.baseUrl ?? null,
      error: args.error ?? null,
    }),
    createConnector: async (args) => {
      const secret = createSecret();
      const connector = await call("createConnector", {
        ...args,
        secretHash: hashSecret(secret),
        secretPrefix: secret.slice(0, 8),
        connectorVersion: args.connectorVersion ?? null,
        platform: args.platform ?? null,
      });
      return connector ? { connector, secret } : null;
    },
    authenticateConnector: (connectorId, secret) => call("authenticateConnector", {
      connectorId,
      secretHash: hashSecret(secret),
    }),
    authenticateConnectorForRevocation: (connectorId, secret) => call("authenticateConnectorForRevocation", {
      connectorId,
      secretHash: hashSecret(secret),
    }),
    beginConnectorCredentialRotation: async ({ userId, connectorId, expiresAt = null }) => {
      const secret = createSecret();
      const rotationId = `crt_${randomBytes(16).toString("hex")}`;
      const boundedExpiresAt = new Date(Math.min(
        Number.isFinite(Date.parse(expiresAt ?? "")) ? Date.parse(expiresAt) : Date.now() + 10 * 60_000,
        Date.now() + 10 * 60_000,
      )).toISOString();
      const result = await call("beginConnectorCredentialRotation", {
        userId,
        connectorId,
        pendingSecretHash: hashSecret(secret),
        pendingSecretPrefix: secret.slice(0, 8),
        rotationId,
        expiresAt: boundedExpiresAt,
      });
      return result ? { connector: result.connector, rotation: result.rotation, secret } : null;
    },
    listConnectors: (userId) => call("listConnectors", { userId }),
    listBackgroundWorkUsers: (args = {}) => call("listBackgroundWorkUsers", args),
    getConnectorForUser: (userId, connectorId) => call("getConnectorForUser", { userId, connectorId }),
    revokeConnector: (args) => call("revokeConnector", args),
    revokeConnectorByCredential: ({ connectorId, secret, reason }) => call("revokeConnectorByCredential", {
      connectorId,
      secretHash: hashSecret(secret),
      ...(reason ? { reason } : {}),
    }),
    createConnectorTicket: async ({ connectorId, audience = CONNECTOR_TICKET_AUDIENCE, credentialVersion = null, rotationId = null }) => {
      const ticket = createSecret();
      const expiresAt = new Date(Date.now() + CONNECTOR_TICKET_TTL_MS).toISOString();
      const result = await call("createConnectorTicket", {
        connectorId,
        tokenHash: hashSecret(ticket),
        audience,
        expiresAt,
        credentialVersion,
        rotationId,
      });
      return result ? { ticket, expiresAt: result.expiresAt } : null;
    },
    consumeConnectorTicket: ({ ticket, audience = null, now = Date.now() }) => call("consumeConnectorTicket", {
      tokenHash: hashSecret(ticket),
      audience,
      now,
    }),
    recordConnectorPresence: (args) => call("recordConnectorPresence", args),
    createFirmwareRelease: (args) => call("createFirmwareRelease", args),
    deleteFirmwareRelease: (releaseId) => call("deleteFirmwareRelease", { releaseId }),
    listFirmwareReleases: (args) => call("listFirmwareReleases", args ?? {}),
    getLatestFirmwareRelease: (args) => call("getLatestFirmwareRelease", args),
    getFirmwareArtifact: (args) => call("getFirmwareArtifact", args),
    createReleaseRollout: (args) => call("createReleaseRollout", args),
    listReleaseRollouts: (userId, args = {}) => call("listReleaseRollouts", { userId, states: args.states }),
    listRunnableReleaseRollouts: (args = {}) => call("listRunnableReleaseRollouts", args),
    getReleaseRolloutForUser: (userId, rolloutId) => call("getReleaseRolloutForUser", { userId, rolloutId }),
    transitionReleaseRollout: (args) => call("transitionReleaseRollout", args),
    upsertRolloutAssignment: (args) => call("upsertRolloutAssignment", args),
    listRolloutAssignments: (args) => call("listRolloutAssignments", args),
    createCompanionHandoff: ({ code, ...args }) => call("createCompanionHandoff", {
      ...args,
      deviceId: args.deviceId ?? null,
      codeHash: hashSecret(code),
    }),
    getCompanionHandoffForUser: (userId, handoffId) => call("getCompanionHandoffForUser", { userId, handoffId }),
    getCompanionHandoffForDevice: (args) => call("getCompanionHandoffForDevice", args),
    claimCompanionHandoff: ({ code, ...args }) => call("claimCompanionHandoff", {
      ...args,
      codeHash: hashSecret(code),
    }),
    cancelCompanionHandoff: (args) => call("cancelCompanionHandoff", {
      ...args,
      deviceId: args.deviceId ?? null,
    }),
    completeCompanionHandoff: (args) => call("completeCompanionHandoff", args),
    createMediaUploadSession: (args) => call("createMediaUploadSession", args),
    getMediaUploadSessionForActor: (args) => call("getMediaUploadSessionForActor", {
      ...args,
      deviceId: args.deviceId ?? null,
    }),
    markMediaUploadSessionUploaded: (args) => call("markMediaUploadSessionUploaded", {
      ...args,
      deviceId: args.deviceId ?? null,
    }),
    finalizeMediaUploadSession: (args) => call("finalizeMediaUploadSession", {
      ...args,
      deviceId: args.deviceId ?? null,
      mediaExpiresAt: args.mediaExpiresAt ?? null,
    }),
    abortMediaUploadSession: (args) => call("abortMediaUploadSession", {
      ...args,
      deviceId: args.deviceId ?? null,
    }),
    listExpiredMediaUploadSessions: (args) => call("listExpiredMediaUploadSessions", args),
    createMediaUpload: (args) => call("createMediaUpload", args),
    getMediaForUser: (userId, mediaId) => call("getMediaForUser", { userId, mediaId }),
    updateMediaTranscript: (args) => call("updateMediaTranscript", args),
    updateMediaDescription: (args) => call("updateMediaDescription", args),
    createDeviceProfile: (args) => call("createDeviceProfile", args),
    listUserDeviceProfiles: (userId) => call("listUserDeviceProfiles", { userId }),
    getUserDeviceProfile: async (userId, profileId) => {
      const profiles = await call("listUserDeviceProfiles", { userId });
      return (profiles ?? []).find((profile) => profile.profileId === profileId) ?? null;
    },
    updateDeviceProfileDefinition: (args) => call("updateDeviceProfileDefinition", args),
    deleteDeviceProfile: (args) => call("deleteDeviceProfile", args),
    updateMediaProcessing: (args) => call("updateMediaProcessing", args),
    listMediaUploads: (userId) => call("listMediaUploads", { userId }),
    listExpiredMediaUploads: (args) => call("listExpiredMediaUploads", args),
    deleteMediaUpload: (args) => call("deleteMediaUpload", args),
    createMediaJob: (args) => call("createMediaJob", args),
    getMediaJobForUser: (userId, jobId) => call("getMediaJobForUser", { userId, jobId }),
    listMediaJobs: (args) => call("listMediaJobs", {
      userId: args.userId,
      mediaId: args.mediaId ?? null,
      stage: args.stage ?? null,
    }),
    claimMediaJobs: (args) => call("claimMediaJobs", args ?? {}),
    updateMediaJob: (args) => call("updateMediaJob", args),
    requeueMediaJob: (args) => call("requeueMediaJob", args),
    createAction: (args) => call("createAction", args),
    getActionForUser: (userId, actionId) => call("getActionForUser", { userId, actionId }),
    listActions: (userId) => call("listActions", { userId }),
    updateAction: (args) => call("updateAction", args),
    deleteAction: (args) => call("deleteAction", args),
    recordActionRun: (args) => call("recordActionRun", args),
    createMacroRun: (args) => call("createMacroRun", args),
    getMacroRunForApproval: (args) => call("getMacroRunForApproval", args),
    claimMacroRunForResume: (args) => call("claimMacroRunForResume", args),
    updateMacroRun: (args) => call("updateMacroRun", args),
    getDeviceControls: (args) => call("getDeviceControls", args),
    updateDeviceControls: (args) => call("updateDeviceControls", args),
    acknowledgeDeviceControls: (args) => call("acknowledgeDeviceControls", args),
    getDeviceFirmwarePolicy: (args) => call("getDeviceFirmwarePolicy", args),
    updateDeviceFirmwarePolicy: (args) => call("updateDeviceFirmwarePolicy", args),
    createMacro: (args) => call("createMacro", args),
    getMacroForUser: (userId, macroId) => call("getMacroForUser", { userId, macroId }),
    listMacros: (userId) => call("listMacros", { userId }),
    deleteMacro: (args) => call("deleteMacro", args),
    createCommand: (args) => call("createCommand", args),
    claimCommandRequest: (args) => call("claimCommandRequest", args),
    settleCommandRequest: (args) => call("settleCommandRequest", args),
    getCommandRequest: (args) => call("getCommandRequest", args),
    getCommandForUser: (userId, commandId) => call("getCommandForUser", { userId, commandId }),
    claimCommandApproval: (args) => call("claimCommandApproval", args),
    claimProviderApprovalDecision: (args) => call("claimProviderApprovalDecision", args),
    updateProviderApprovalDecision: (args) => call("updateProviderApprovalDecision", args),
    listProviderApprovalDecisions: (args) => call("listProviderApprovalDecisions", args),
    claimProviderUserInputAnswer: (args) => call("claimProviderUserInputAnswer", args),
    updateProviderUserInputAnswer: (args) => call("updateProviderUserInputAnswer", args),
    listProviderUserInputAnswers: (args) => call("listProviderUserInputAnswers", args),
    createNotification: (args) => call("createNotification", args),
    listNotifications: (args) => call("listNotifications", args),
    markNotificationRead: (args) => call("markNotificationRead", args),
    dismissNotification: (args) => call("dismissNotification", args),
    dismissNotificationByDedupe: (args) => call("dismissNotificationByDedupe", args),
    markAllNotificationsRead: (args) => call("markAllNotificationsRead", args),
    recordBackgroundLiveness: (args) => call("recordBackgroundLiveness", args),
    getBackgroundLiveness: (scope = "scheduled-worker") => call("getBackgroundLiveness", { scope }),
    upsertPushSubscription: (args) => call("upsertPushSubscription", {
      userId: args.userId,
      endpointHash: createHash("sha256").update(args.endpoint, "utf8").digest("hex"),
      endpoint: pushSecretBox.seal(args.endpoint),
      p256dh: pushSecretBox.seal(args.keys.p256dh),
      auth: pushSecretBox.seal(args.keys.auth),
      vapidKeyId: args.vapidKeyId,
    }),
    listPushSubscriptions: (args) => call("listPushSubscriptions", args),
    revokePushSubscription: (args) => call("revokePushSubscription", args),
    revokePushSubscriptionByEndpoint: (args) => call("revokePushSubscriptionByEndpoint", {
      userId: args.userId,
      endpointHash: createHash("sha256").update(args.endpoint, "utf8").digest("hex"),
      reason: args.reason,
    }),
    enqueuePushDeliveries: (args) => call("enqueuePushDeliveries", args),
    claimPushDeliveries: async (args) => (await call("claimPushDeliveries", args)).map((claim) => ({
      ...claim,
      subscription: {
        ...claim.subscription,
        endpoint: pushSecretBox.open(claim.subscription.endpoint),
        keys: {
          p256dh: pushSecretBox.open(claim.subscription.keys.p256dh),
          auth: pushSecretBox.open(claim.subscription.keys.auth),
        },
      },
    })),
    settlePushDelivery: (args) => call("settlePushDelivery", args),
    updateCommand: (args) => call("updateCommand", args),
    listCommands: (userId) => call("listCommands", { userId }),
    listCommandEvents: (args) => call("listCommandEvents", args),
    listAuditLogs: (userId) => call("listAuditLogs", { userId }),
    // The display poll's whole surface, in one round trip. Splitting this into per-collection
    // count/latest methods would cost one HTTP call to Convex each, on the route a controller
    // hits every five seconds.
    getDisplaySummary: (userId) => call("getDisplaySummary", { userId }),
  };
}

// Convex validation errors can include the complete function argument object in their message and
// stack. Every Store call carries the shared gateway credential, and some carry private user data,
// so neither the remote Error nor its cause may cross the adapter boundary. Retain only the local
// method plus primitive fields used by retry/status classification.
function remoteCallError(method, error) {
  const wrapped = new Error(`Convex Store call failed (${method}).`);
  wrapped.name = "ConvexStoreRemoteError";
  wrapped.code = safeRemoteCode(error?.code) ?? "convex_store_call_failed";
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) {
    wrapped.status = error.status;
  }
  if (typeof error?.retryable === "boolean") wrapped.retryable = error.retryable;
  return wrapped;
}

function safeRemoteCode(value) {
  return SAFE_REMOTE_ERROR_CODES.has(value) ? value : null;
}

async function createConvexHttpClient(convexUrl, options = {}) {
  const client = new ConvexHttpGatewayClient(convexUrl, options.clientOptions ?? {});
  if (options.authToken) client.setAuth(options.authToken);
  if (options.adminAuth) client.setAdminAuth(options.adminAuth);
  return client;
}

// Mutations name their owner in different places: most take it directly, device and token
// mutations only reveal it in the result.
function affectedUserId(args, result) {
  if (typeof args?.userId === "string" && args.userId) return args.userId;
  if (typeof result?.userId === "string" && result.userId) return result.userId;
  if (typeof result?.device?.userId === "string" && result.device.userId) return result.device.userId;
  if (typeof result?.user?.id === "string" && result.user.id) return result.user.id;
  if (typeof result?.id === "string" && typeof result?.email === "string") return result.id;
  return null;
}

function emptyState() {
  return {
    version: 1,
    users: [],
    apiTokens: [],
    devices: [],
    environments: [],
    firmwareReleases: [],
    releaseRollouts: [],
    rolloutAssignments: [],
    gatewayProfiles: [],
    mediaUploads: [],
    macros: [],
    actions: [],
    deviceControls: [],
    macroRuns: [],
    commands: [],
    // Present in the memory store's exportState(); omitting them here handed callers `undefined`
    // where every other collection gives an empty array.
    connectSessions: [],
    mediaJobs: [],
    deviceProfiles: [],
    commandEvents: [],
    auditLogs: [],
  };
}

class ConvexHttpGatewayClient {
  constructor(address, options = {}) {
    this.address = address.replace(/\/+$/u, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.authToken = options.authToken ?? null;
    this.adminAuth = options.adminAuth ?? null;
  }

  setAuth(token) {
    this.authToken = token;
    this.adminAuth = null;
  }

  setAdminAuth(token) {
    this.adminAuth = token;
    this.authToken = null;
  }

  query(name, args = {}) {
    return this.call("query", name, args);
  }

  mutation(name, args = {}) {
    return this.call("mutation", name, args);
  }

  async call(endpoint, name, args) {
    const headers = {
      "content-type": "application/json",
      "convex-client": "next-coder-gateway",
    };
    if (this.adminAuth) headers.authorization = `Convex ${this.adminAuth}`;
    if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;

    const response = await this.fetch(`${this.address}/api/${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        path: name,
        format: "convex_encoded_json",
        args: [encodeConvexJson(args)],
      }),
    });
    if (!response.ok && response.status !== 560) {
      throw new Error(await response.text());
    }

    const payload = await response.json();
    if (payload.status === "success") return decodeConvexJson(payload.value);
    if (payload.status === "error") throw new Error(payload.errorMessage ?? "Convex function failed.");
    throw new Error(`Invalid Convex response: ${JSON.stringify(payload)}`);
  }
}

function encodeConvexJson(value) {
  if (Array.isArray(value)) return value.map(encodeConvexJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, encodeConvexJson(entryValue)]),
    );
  }
  return value;
}

function decodeConvexJson(value) {
  if (Array.isArray(value)) return value.map(decodeConvexJson);
  if (value && typeof value === "object") {
    if (typeof value.$integer === "string") return Number.parseInt(value.$integer, 10);
    if (typeof value.$float === "string") return Number.parseFloat(value.$float);
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, decodeConvexJson(entryValue)]),
    );
  }
  return value;
}

function hashSecret(secret) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function createSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
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

// Mirrors CLAIM_CODE_TTL_MS in store.mjs. Kept local because convexStore.mjs deliberately does not
// import the memory store, and the expiry is computed in Node so Convex never mints a timestamp.
function claimCodeExpiryFrom(issuedAtMs) {
  return new Date(issuedAtMs + 30 * 24 * 60 * 60 * 1000).toISOString();
}
