export type PageId =
  | "quick"
  | "operate"
  | "actions"
  | "devices"
  | "environments"
  | "media"
  | "activity"
  | "settings"
  | "onboarding";
export type ConnectionState =
  | "signed-out"
  | "connecting"
  | "connected"
  | "live"
  | "reconnecting"
  | "error";

export type JsonRecord = Record<string, unknown>;

export interface AuthConfig {
  authProvider?: string;
  demoMode?: boolean;
  /** Lets the console omit host-only controls when served by the managed cloud runtime. */
  deploymentMode?: "cloud" | "self-hosted";
  developmentTokens?: { enabled?: boolean };
  clerk?: {
    enabled?: boolean;
    publishableKey?: string | null;
  };
  /**
   * Console-only. The gateway never sends this: the bootstrap fetch sets it.
   *
   * `false` means the console could not get an answer out of the gateway at all — a 5xx, a
   * network failure, or a timeout. That is a different fact from "the gateway answered and
   * Clerk is switched off", and the signed-out pages have to say so in different words.
   * Absent means the gateway answered and the copy may speak about its configuration.
   */
  gatewayReachable?: boolean;
}

export interface RemoteAccessStatus {
  checkedAt: string;
  gateway: {
    host: string;
    port: number;
    loopbackUrl: string;
    lanUrls: string[];
    publicBaseUrl: string | null;
  };
  tailscale: {
    installed: boolean;
    connected: boolean;
    backendState: string;
    dnsName: string | null;
    ips: string[];
    httpsUrl: string | null;
    serve: { active: boolean; statusAvailable: boolean };
    funnel: { active: boolean; statusAvailable: boolean };
    mode: "serve" | "funnel" | null;
    publicBaseUrlConfigured: boolean;
    ready: boolean;
    error: string | null;
    nextStep: "install" | "connect" | "enable" | "restart" | "ready";
  };
}

export type GatewayProfileMode = "lan" | "tailnet" | "custom";

export interface GatewayProfile {
  id: string;
  label: string;
  mode: GatewayProfileMode;
  baseUrl: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DeviceGatewaySwitch {
  deviceId: string;
  revision: number;
  state: "stable" | "pending" | "failed";
  activeProfile?: GatewayProfile | null;
  pendingProfile?: GatewayProfile | null;
  previousProfile?: GatewayProfile | null;
  lastError?: string | null;
  requestedAt?: string | null;
  appliedAt?: string | null;
}

export interface DeviceGatewaySelection {
  revision: number;
  state: "stable" | "pending" | "failed";
  activeProfileId?: string | null;
  pendingProfileId?: string | null;
  previousProfileId?: string | null;
  lastError?: string | null;
  requestedAt?: string | null;
  appliedAt?: string | null;
}

export interface DeviceProfile {
  id: string;
  label?: string;
  description?: string;
  /** Intent types the profile grants, as returned by GET /v1/device-profiles. */
  capabilities?: string[];
}

/** Why an environment is not answering, as returned by the gateway. Never inferred from copy. */
export type EnvironmentFailureReason =
  | "connector_offline"
  | "connector_revoked"
  | "connector_incompatible"
  | "process_not_running"
  | "network_unreachable"
  | "timeout"
  | "tls_error"
  | "token_expired"
  | "authentication_failed"
  | "contract_incompatible"
  | "unknown";

/** The failure envelope on a /check response and on a snapshot error's details. */
export interface EnvironmentFailure {
  reason: EnvironmentFailureReason;
  message: string;
  /** False when retrying cannot help until the owner replaces a credential or upgrades T3. */
  retryable: boolean;
  baseUrl?: string | null;
  installedVersion?: string | null;
  minimumVersion?: string | null;
  maximumTestedVersion?: string | null;
}

export interface EnvironmentHealth {
  lastCheckedAt?: string | null;
  lastReachableAt?: string | null;
  lastError?: string | null;
  failureReason?: EnvironmentFailureReason | null;
  snapshot?: {
    title?: string;
    state?: string;
    line1?: string;
    line2?: string;
  } | null;
  compatibility?: T3CompatibilityResult | null;
  capabilities?: T3CapabilityManifest | null;
}

export type T3CapabilityState = "supported" | "unsupported" | "unknown";

export interface T3CapabilityManifest {
  schema: "next-coder.t3-capabilities.v1";
  contractVersion: string;
  installedVersion: string | null;
  probedAt: string;
  freshUntil: string;
  freshness: "fresh" | "stale";
  source: "direct_probe" | "connector_probe" | "cache";
  probes: Record<string, "passed" | "failed" | "not_exercised">;
  features: Record<string, { state: T3CapabilityState; evidence: string }>;
  attachments: {
    image: { state: T3CapabilityState; evidence: string };
    audio: { state: T3CapabilityState; evidence: string };
    file: { state: T3CapabilityState; evidence: string };
    maxCount: number;
    maxImageBytes: number;
  };
  runtimeModes: string[];
  interactionModes: string[];
  approvalDecisions: string[];
  recovery: { code: string; action: string } | null;
}

export type T3CompatibilityStatus =
  | "unchecked"
  | "compatible"
  | "update_recommended"
  | "review_required"
  | "incompatible"
  | "unknown";

export interface T3CompatibilityCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface T3CompatibilityFinding {
  level: "danger" | "warning" | "info";
  code: string;
  message: string;
}

export interface T3CompatibilityResult {
  environmentId: string;
  environmentLabel: string;
  checkedAt: string | null;
  installedVersion: string | null;
  previousVersion?: string | null;
  versionChanged?: boolean;
  status: T3CompatibilityStatus;
  compatible: boolean;
  breakingRisk: boolean;
  latestVersion: string | null;
  recommendedVersion: string;
  minimumVersion: string;
  maximumTestedVersion: string;
  recommendation: string;
  checks: T3CompatibilityCheck[];
  findings: T3CompatibilityFinding[];
  capabilities?: T3CapabilityManifest | null;
}

export interface T3ReleaseCompatibility {
  packageName: string;
  latestVersion: string | null;
  latestError: string | null;
  minimumVersion: string;
  maximumTestedVersion: string;
  recommendedVersion: string;
  status: "supported" | "review_required" | "unavailable";
  alert: string | null;
  checkedAt?: string;
}

export interface T3CompatibilityOverview {
  release: T3ReleaseCompatibility;
  results: T3CompatibilityResult[];
  summary: {
    environments: number;
    breakingRisks: number;
    incompatible: number;
    reviewRequired: number;
    updatesRecommended: number;
    unchecked: number;
    needsAttention: boolean;
  };
}

export interface Environment {
  id: string;
  label: string;
  status?: string;
  /** Null for connector-mode environments: the cloud never dials the private T3 host. */
  baseUrl: string | null;
  transportMode?: "direct" | "connector";
  connectorId?: string | null;
  accessTokenExpiresAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** Set when the credential has been destroyed and all dependent runtime state detached. */
  archivedAt?: string | null;
  deletedAt?: string | null;
  purgeAfter?: string | null;
  /** Freshness of the cached cloud projection, not a synonym for connector presence. */
  freshness?: "unknown" | "live" | "stale" | string;
  lastProjectionAt?: string | null;
  lastConnectorSeenAt?: string | null;
  providerCatalogue?: JsonRecord | null;
  health?: EnvironmentHealth;
}

export type ConnectorStatus =
  | "enrolled"
  | "waiting"
  | "online"
  | "reconnecting"
  | "sleeping"
  | "offline"
  | "revoked"
  | "incompatible";

/** Public connector metadata. Standing credentials are deliberately never returned to the console. */
export interface Connector {
  id: string;
  environmentId: string;
  label: string;
  secretPrefix?: string;
  scopes?: string[];
  status: ConnectorStatus | string;
  protocolVersion?: number;
  connectorVersion?: string | null;
  platform?: string | null;
  capabilities?: string[];
  createdAt?: string;
  updatedAt?: string;
  lastSeenAt?: string | null;
  lastConnectedAt?: string | null;
  revokedAt?: string | null;
  lastDisconnectReason?: string | null;
  lastT3Health?: "unknown" | "starting" | "ready" | "stopped" | "auth_failed" | "incompatible" | "error" | string | null;
  lastT3HealthAt?: string | null;
}

export type ConnectSessionStatus = "pending" | "redeeming" | "completed" | "failed" | "expired";

/**
 * A console-first pairing intent. The console mints one, shows the command it comes with, and polls
 * until the T3 host redeems it. `environmentId` is set from the start when re-pairing, which is what
 * keeps a re-pair updating the existing environment instead of adding a second row for the host.
 */
export interface ConnectSession {
  id: string;
  userId?: string;
  label: string;
  accessMode: string;
  environmentId: string | null;
  status: ConnectSessionStatus;
  baseUrl: string | null;
  error: string | null;
  expiresAt: string;
  completedAt: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** The mint response. `code` is shown once and is unrecoverable afterwards. */
export interface ConnectSessionMint {
  session: ConnectSession;
  code: string;
  gatewayUrl: string;
  command: string;
}

/** What still points at an environment, as returned by GET /v1/t3/environments/:id/dependencies. */
export interface EnvironmentDependencyRef {
  id: string;
  label: string;
}

export interface EnvironmentDependencyCounts {
  devices: number;
  actions: number;
  macros: number;
  onboarding: number;
}

export interface EnvironmentDependencies {
  environmentId: string;
  dependencies: {
    devices: EnvironmentDependencyRef[];
    actions: EnvironmentDependencyRef[];
    macros: EnvironmentDependencyRef[];
    onboarding: boolean;
  };
  counts: EnvironmentDependencyCounts;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: unknown[];
}

export interface ModelRecovery {
  requested: ModelSelection | null;
  selected: ModelSelection;
  reason: string;
  catalogueSource: "live" | "registered" | "snapshot-only";
}

export interface T3ModelOptionChoice {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface T3ModelOption {
  id: string;
  label: string;
  type: string;
  currentValue: string | null;
  choices: T3ModelOptionChoice[];
}

export interface T3HarnessModel {
  slug: string;
  name: string;
  isCustom: boolean;
  options: T3ModelOption[];
  /** True when the model was only inferred from usage, not from a registered catalogue. */
  observed?: boolean;
}

export interface T3Harness {
  instanceId: string;
  label: string;
  badge?: string | null;
  version?: string | null;
  status?: string;
  available?: boolean;
  unavailableReason?: string | null;
  auth?: { status: string; type: string | null; label: string | null };
  models: T3HarnessModel[];
}

export interface T3SessionFailure {
  threadId: string | null;
  title: string | null;
  status: string;
  instanceId: string | null;
  model: string | null;
  message: string;
  code: string | null;
  updatedAt: string | null;
}

export interface T3HarnessCatalogue {
  harnesses: T3Harness[];
  usable: string[];
  modelSelection: ModelSelection | null;
  sessionFailures: T3SessionFailure[];
  catalogueSource: "live" | "registered" | "snapshot-only";
}

export interface T3Project {
  id: string;
  title?: string;
  name?: string;
  workspaceRoot?: string;
  defaultModelSelection?: ModelSelection | null;
}

export interface T3ThreadMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  createdAt?: string | null;
  streaming?: boolean;
}

export interface T3Thread {
  id: string;
  /** The title reported by T3, without the project suffix used by compact pickers. */
  title?: string;
  label: string;
  projectId?: string | null;
  modelSelection?: ModelSelection | null;
  status?: string | null;
  messages?: T3ThreadMessage[];
}

export interface DeviceConfig {
  environmentId?: string | null;
  threadId?: string | null;
  gatewayAccessMode?: "local" | "tailscale" | "online";
  gatewayUrl?: string | null;
  defaultPrompt?: string;
  shellCommand?: string;
  menu?: string[];
}

/**
 * One entry from `GET /v1/hardware/boards`. The four supported boards are not interchangeable —
 * they differ in display, input, and whether they have a microphone at all — so pre-provisioning
 * has to say which one it is stamping, and the operator flashing the unit needs its firmware
 * environment. `maturity` is deliberately part of the shape: only one board has a firmware
 * validated end to end, and hiding that from whoever is stamping hardware would be dishonest.
 */
export interface HardwareBoard {
  id: string;
  label: string;
  vendor?: string | null;
  firmwareEnv?: string | null;
  firmwareDir?: string | null;
  display?: {
    kind?: string | null;
    width?: number | null;
    height?: number | null;
    colors?: number | null;
  } | null;
  input?: {
    touch?: boolean;
    keys?: number | null;
  } | null;
  audio?: {
    microphone?: boolean;
    speaker?: boolean;
  } | null;
  camera?: boolean;
  maturity?: "complete" | "bring-up" | "scaffold" | "unknown" | string;
}

export interface DeviceStatus {
  lastHeartbeatAt?: string | null;
  firmwareVersion?: string | null;
  hardwareModel?: string | null;
  ipAddress?: string | null;
  wifiRssi?: number | null;
  freeHeap?: number | null;
  uptimeMs?: number | null;
  batteryPercent?: number | null;
  batteryMv?: number | null;
  protocolVersion?: number | null;
  features?: string[];
  limits?: {
    menuItems?: number;
    labelCharacters?: number;
  };
}

export interface Device {
  id: string;
  label: string;
  profile: string;
  /**
   * The board this unit was stamped as at pre-provision. Absent on devices created before the
   * catalogue existed, which is why nothing here invents a value when it is missing.
   */
  hardwareModel?: string | null;
  claimed?: boolean;
  revokedAt?: string | null;
  lastSeenAt?: string | null;
  credentialVersion?: number;
  credentialRotation?: {
    id?: string | null;
    state?: "idle" | "pending" | "expired" | "completed" | string;
    purpose?: "rotate" | "transfer" | null | string;
    pendingCredentialVersion?: number | null;
    startedAt?: string | null;
    expiresAt?: string | null;
    completedAt?: string | null;
  };
  presence?: {
    state?: string;
    online?: boolean;
    staleAfterMs?: number;
  };
  /**
   * Which owner operations the gateway will currently accept for this device. Server-declared so
   * the console does not have to re-derive it from revokedAt and drift out of sync with the guards
   * in the store. Absent on an older gateway, which callers should treat as permitted.
   */
  actions?: {
    rotateSecret?: boolean;
    transferReset?: boolean;
    updateConfig?: boolean;
    updateProfile?: boolean;
    revoke?: boolean;
    delete?: boolean;
  };
  status?: DeviceStatus;
  config?: DeviceConfig;
  gatewaySelection?: DeviceGatewaySelection;
}

export interface Command {
  id: string;
  status: string;
  risk?: string;
  threadId?: string | null;
  environmentId?: string | null;
  deviceId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  intent?: JsonRecord;
  result?: JsonRecord | string | null;
  metrics?: JsonRecord;
}

export interface CommandEvent {
  id: string;
  status: string;
  previousStatus?: string | null;
  risk?: string;
  actorType?: string;
  actorId?: string | null;
  result?: JsonRecord | string | null;
  createdAt?: string;
}

export interface Macro {
  id: string;
  label: string;
  environmentId?: string | null;
  threadId?: string | null;
  intent?: JsonRecord;
  disabled?: boolean;
  disabledReason?: string | null;
}

export type SavedActionType = "prompt" | "shell" | "media" | "macro";

export interface SavedActionStep {
  actionId: string;
  position?: number;
  continueOnFailure?: boolean;
}

/** A reusable operation. Payloads remain in the gateway; devices only receive opaque action IDs. */
export interface SavedAction {
  id: string;
  label: string;
  type: SavedActionType;
  intent?: JsonRecord | null;
  payload?: JsonRecord;
  targetMode?: "device-current" | "fixed";
  steps?: SavedActionStep[];
  environmentId?: string | null;
  threadId?: string | null;
  disabled?: boolean;
  disabledReason?: string | null;
  createdAt?: string;
  updatedAt?: string;
  deviceIds?: string[];
}

export interface DeviceControlItem {
  id?: string;
  kind?: "system" | "status" | "stop" | "remote_action" | string;
  actionId?: string;
  label?: string;
  enabled?: boolean;
  reason?: string | null;
  requiresThread?: boolean;
  requiresConfirmation?: boolean;
}

export interface DeviceControls {
  revision: number;
  acknowledgedRevision?: number | null;
  appliedRevision?: number | null;
  appliedAt?: string | null;
  lastAckStatus?: string | null;
  lastAckError?: string | null;
  items: DeviceControlItem[];
  capacity?: number;
}

export interface DeviceFirmwarePolicy {
  channel: "stable" | "beta";
  updateMode: "manual" | "notify" | "automatic";
  desiredVersion?: string | null;
  currentVersion?: string | null;
  latestVersion?: string | null;
  availableVersions?: string[];
  status?: string | null;
  lastUpdateStatus?: string | null;
  lastUpdateAt?: string | null;
  lastError?: string | null;
  lastUpdateError?: string | null;
  updateProgress?: number | null;
  targetVersion?: string | null;
  releaseNotes?: string | null;
}

/**
 * Where a capture came from and where it was headed, derived by the gateway on read.
 *
 * Not stored anywhere: a device gets relabelled and a thread gets retitled, so the server rebuilds
 * this from the live records every time it hands a media row out.
 */
export interface MediaOrigin {
  source:
    | "controller_capture"
    | "browser_recording"
    | "browser_camera"
    | "companion_recording"
    | "companion_camera"
    | "upload"
    | string;
  deviceId?: string | null;
  deviceLabel?: string | null;
  environmentId?: string | null;
  threadId?: string | null;
  threadTitle?: string | null;
  capturedAt?: string | null;
}

export interface MediaItem {
  id: string;
  kind: "audio" | "image" | string;
  contentType: string;
  sizeBytes?: number;
  /**
   * The name every surface shows: "Hosyond Touch screen · Verify workspace · 24 Aug 19:32".
   * Server-derived, so the library, the composer's picker and an attachment chip cannot disagree.
   */
  displayName?: string | null;
  origin?: MediaOrigin;
  /** Exactly what the client uploaded. Kept, never overwritten by the derived name. */
  originalName?: string | null;
  transcript?: string | null;
  description?: string | null;
  createdAt?: string;
  expiresAt?: string | null;
  processing?: {
    transcriptionStatus?: string;
    transcriptSource?: string | null;
    visionStatus?: string;
    descriptionSource?: string | null;
    lastError?: string | null;
  };
}

export interface CompanionHandoff {
  id: string;
  deviceId?: string | null;
  environmentId: string;
  threadId: string;
  action: "record_audio" | "capture_image";
  status: "waiting" | "claimed" | "completed" | "expired" | "cancelled";
  createdAt: string;
  expiresAt: string;
  claimedAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
}

/**
 * A durable media processing job. Transcription runs on the gateway's worker, not inside the
 * request, so the client watches a stage rather than awaiting a response.
 *
 * The three transcript fields are versions, not alternatives to each other: `rawTranscript` is
 * exactly what the ASR provider returned and never changes, `normalizedTranscript` is the
 * punctuation cleanup, and `userEditedTranscript` is the reviewed value when someone corrected it.
 */
export interface MediaJob {
  id: string;
  mediaId: string;
  kind: string;
  stage:
    | "queued"
    | "transcribing"
    | "normalizing"
    | "review_required"
    | "ready"
    | "dispatching"
    | "dispatched"
    | "failed"
    | string;
  provider?: string | null;
  model?: string | null;
  language?: string | null;
  rawTranscript?: string | null;
  normalizedTranscript?: string | null;
  userEditedTranscript?: string | null;
  attempts?: number;
  maxAttempts?: number;
  reviewRequired?: boolean;
  lastError?: string | null;
  failureKind?: "retryable" | "terminal" | null;
  /**
   * Why a terminal failure was terminal, which is a different question from `failureKind`.
   *
   * `failureKind` only says whether another identical attempt was worth making at the time.
   * This says what would have to change for the clip to succeed: `configuration` is the gateway's
   * deployment (no provider, a missing credential, a sidecar that was down) and is the only cause
   * the retry endpoint will requeue; `input` is about the audio and no setting fixes it.
   */
  failureCause?: "configuration" | "input" | "provider" | "unknown" | null;
  /** How many times an owner has explicitly put this job back in the queue. */
  requeueCount?: number;
  requeuedAt?: string | null;
  requeuedBy?: string | null;
  timings?: Record<string, string | number | null>;
  /**
   * What the cleanup did to the raw transcript, computed by the gateway on every read.
   *
   * `contentPreserved: false` means normalisation moved letters rather than only spacing,
   * punctuation and case. The job then parks at `review_required` whatever the configuration
   * says, and the change is shown as a diff rather than applied on the speaker's behalf.
   */
  transcriptChange?: {
    changed: boolean;
    contentPreserved: boolean;
    rawLength: number;
    normalizedLength: number;
    firstDivergenceIndex: number | null;
  } | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface AuditEvent {
  id?: string;
  action: string;
  actorType?: string;
  actorId?: string | null;
  targetId?: string | null;
  createdAt: string;
}

export type NotificationKind =
  | "turn.completed"
  | "turn.failed"
  | "gateway.approval_required"
  | "provider.approval_required"
  | "user_input.required"
  | "connector.offline"
  | "connector.recovered"
  | "t3.offline"
  | "t3.recovered";

/**
 * A durable, privacy-minimal attention record. User content and upstream request ids never belong
 * in this projection; the linked command/thread can be loaded through its separately authorized
 * route when the operator deliberately opens it.
 */
export interface UserNotification {
  id: string;
  kind: NotificationKind;
  severity: "info" | "attention" | "error";
  title: string;
  environmentId: string | null;
  threadId: string | null;
  commandId: string | null;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  dismissedAt: string | null;
  cursor: string;
}

export interface NotificationPage {
  notifications: UserNotification[];
  nextCursor: string | null;
  hasMore: boolean;
  unreadCount: number;
}

export type ScheduledWorkerStatus =
  | "healthy"
  | "degraded"
  | "stale"
  | "not_configured"
  | "unknown";

/** Scheduler execution evidence only. Connector/T3/provider liveness has separate projections. */
export interface BackgroundLiveness {
  scheduledWorker: {
    status: ScheduledWorkerStatus;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    nextExpectedBy: string | null;
    failureCode: string | null;
    expectedIntervalMs: number;
  };
  observedAt: string;
}

export interface DisplayState extends JsonRecord {
  title?: string;
  state?: string;
  line1?: string;
  line2?: string;
  latestAction?: string | null;
  counts?: Record<string, number>;
}

export interface DeviceSecret {
  title: string;
  id?: string;
  secret?: string;
  claimCode?: string;
}

export interface ClerkBridge {
  loaded: boolean;
  signedIn: boolean;
  userLabel: string | null;
  getToken: () => Promise<string | null>;
  openSignIn: () => void;
  openSignUp: () => void;
  openUserProfile: () => void;
  signOut: () => Promise<void>;
}

export type OnboardingStep = "welcome" | "host" | "connect" | "workspace" | "device" | "ready";
export type OnboardingStatus = "not_started" | "in_progress" | "paused" | "completed";
export type OnboardingNetworkMode = "local" | "lan" | "tailscale" | "custom";
export type OnboardingDeviceMode = "existing" | "claim" | "register" | "browser_only";

export interface OnboardingState {
  version: number;
  status: OnboardingStatus;
  currentStep: OnboardingStep;
  networkMode: OnboardingNetworkMode | null;
  networkUrl: string | null;
  provider: {
    harness: string | null;
    instanceId: string | null;
    model: string | null;
  };
  workspace: {
    path: string | null;
    title: string | null;
    projectId: string | null;
  };
  environmentId: string | null;
  firstThreadId: string | null;
  device: {
    mode: OnboardingDeviceMode | null;
    deviceId: string | null;
    credentialConfirmed: boolean;
  };
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

export interface OnboardingReadiness {
  checks: {
    account: boolean;
    hostPlan: boolean;
    environmentPaired: boolean;
    environmentReachable: boolean;
    workspaceSelected: boolean;
    providerConfigured: boolean;
    firstRunCompleted: boolean;
    /** @deprecated Compatibility alias; true only after completion, not dispatch acknowledgement. */
    firstRunDispatched?: boolean;
    deviceReady: boolean;
  };
  ready: boolean;
  environment: Environment | null;
  device: Device | null;
}

export interface OnboardingResponse {
  onboarding: OnboardingState;
  readiness: OnboardingReadiness;
}
