import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, downloadJson, requestJson, uploadBinary, type ApiOptions } from "./api";
import { connectorFailureFromMetadata, connectorForEnvironment } from "./connectorHealth";
import { useLocalNotifications } from "./notifications";
import type {
  ProviderApprovalDecision,
  ProviderApprovalLocalDecision,
} from "./providerApprovals";
import type { UserInputAnswers, UserInputLocalAnswer } from "./userInput";
import { useThreadWatch } from "./useThreadWatch";
import { clearDurableMutationRequest, durableMutationRequest } from "./requestId";
import {
  projectScope,
  threadScope,
  useResourceOrdering,
  environmentScope,
} from "./resourceOrder";
import type {
  AuditEvent,
  BackgroundLiveness,
  AuthConfig,
  ClerkBridge,
  Command,
  CommandEvent,
  ConnectionState,
  Connector,
  ConnectSession,
  ConnectSessionMint,
  Device,
  DeviceConfig,
  DeviceProfile,
  DeviceSecret,
  DisplayState,
  Environment,
  EnvironmentFailure,
  EnvironmentFailureReason,
  HardwareBoard,
  JsonRecord,
  Macro,
  MediaItem,
  MediaJob,
  ModelRecovery,
  ModelSelection,
  OnboardingReadiness,
  OnboardingResponse,
  OnboardingState,
  RemoteAccessStatus,
  T3HarnessCatalogue,
  T3CapabilityManifest,
  T3Project,
  T3Thread,
  T3ThreadMessage,
  SavedAction,
  UserNotification,
  GatewayProfile,
} from "./types";
import { createFrameBatcher } from "./frameBatcher";

interface Notice {
  tone: "success" | "danger" | "info";
  message: string;
}

interface ControllerApiOptions extends ApiOptions {
  /** Background warming should not replace the operator's current notice or connection state. */
  silent?: boolean;
}

export interface MediaUploadProgress {
  stage: "creating" | "uploading" | "finalizing";
  loaded: number;
  total: number;
}

export interface MediaUploadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: MediaUploadProgress) => void;
}

interface MediaUploadSessionResponse {
  session: {
    id: string;
    status: string;
    upload: { url: string; contentType: string; sizeBytes: number };
    finalizeUrl: string;
  };
}

export interface WorkspaceRecovery {
  environmentId: string;
  /** The gateway's classification of the failure, never inferred from the message text. */
  failure: EnvironmentFailure;
}

export const T3_SNAPSHOT_UNAVAILABLE_MESSAGE = "T3 snapshot is unavailable.";

const ENVIRONMENT_FAILURE_REASONS: readonly EnvironmentFailureReason[] = [
  "connector_offline",
  "connector_revoked",
  "connector_incompatible",
  "process_not_running",
  "network_unreachable",
  "timeout",
  "tls_error",
  "token_expired",
  "authentication_failed",
  "contract_incompatible",
  "unknown",
];

export function isT3SnapshotUnavailableError(error: unknown): error is Error {
  return error instanceof Error && error.message === T3_SNAPSHOT_UNAVAILABLE_MESSAGE;
}

/** The fallback for a gateway that classified nothing: retry is still worth offering. */
export function genericEnvironmentFailure(): EnvironmentFailure {
  return { reason: "unknown", message: T3_SNAPSHOT_UNAVAILABLE_MESSAGE, retryable: true };
}

/** Reads the `failure` envelope off an error body. An unrecognised reason is treated as absent. */
export function parseEnvironmentFailure(details: unknown): EnvironmentFailure | null {
  if (!details || typeof details !== "object") return null;
  const envelope = (details as { failure?: unknown }).failure;
  if (!envelope || typeof envelope !== "object") return null;
  const record = envelope as Record<string, unknown>;
  const reason = record.reason;
  if (typeof reason !== "string") return null;
  if (!ENVIRONMENT_FAILURE_REASONS.includes(reason as EnvironmentFailureReason)) return null;
  return {
    reason: reason as EnvironmentFailureReason,
    message: typeof record.message === "string" && record.message
      ? record.message
      : T3_SNAPSHOT_UNAVAILABLE_MESSAGE,
    retryable: record.retryable !== false,
    baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : null,
    installedVersion: typeof record.installedVersion === "string" ? record.installedVersion : null,
    minimumVersion: typeof record.minimumVersion === "string" ? record.minimumVersion : null,
    maximumTestedVersion: typeof record.maximumTestedVersion === "string"
      ? record.maximumTestedVersion
      : null,
  };
}

interface UseControllerOptions {
  authConfig: AuthConfig;
  clerk: ClerkBridge | null;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const record = part as JsonRecord;
    return typeof record.text === "string"
      ? record.text
      : typeof record.content === "string" ? record.content : "";
  }).filter(Boolean).join("\n").trim();
}

export function normalizeThread(thread: JsonRecord, projects: T3Project[]): T3Thread | null {
  const idValue = thread.id ?? thread.threadId ?? thread.sessionId;
  if (typeof idValue !== "string" || !idValue) return null;
  const projectValue = thread.projectId
    ?? (typeof thread.project === "object" && thread.project
      ? (thread.project as JsonRecord).id
      : null);
  const projectId = typeof projectValue === "string" ? projectValue : null;
  const titleValue = thread.title ?? thread.name ?? thread.label;
  const title = typeof titleValue === "string" && titleValue ? titleValue : idValue;
  const statusValue = thread.status ?? thread.state;
  const rawModelSelection = thread.modelSelection;
  const modelSelection = rawModelSelection && typeof rawModelSelection === "object"
    && typeof (rawModelSelection as JsonRecord).instanceId === "string"
    && typeof (rawModelSelection as JsonRecord).model === "string"
    ? {
        instanceId: (rawModelSelection as JsonRecord).instanceId as string,
        model: (rawModelSelection as JsonRecord).model as string,
        ...(Array.isArray((rawModelSelection as JsonRecord).options)
          ? { options: (rawModelSelection as JsonRecord).options as unknown[] }
          : {}),
      }
    : null;
  const messages = Array.isArray(thread.messages) ? thread.messages.flatMap((message, index) => {
    if (!message || typeof message !== "object") return [];
    const record = message as JsonRecord;
    const text = messageText(record.text ?? record.content ?? record.message);
    if (!text) return [];
    const rawRole = typeof record.role === "string" ? record.role.toLowerCase() : "system";
    const role: T3ThreadMessage["role"] = rawRole === "user" || rawRole === "assistant" || rawRole === "tool"
      ? rawRole
      : "system";
    const id = typeof record.id === "string"
      ? record.id
      : typeof record.messageId === "string" ? record.messageId : `${idValue}-message-${index}`;
    return [{
      id,
      role,
      text,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
      streaming: record.streaming === true,
    }];
  }) : [];
  return {
    id: idValue,
    title,
    label: threadLabel(title, projectId, projects),
    projectId,
    modelSelection,
    status: typeof statusValue === "string" ? statusValue : null,
    messages,
  };
}

function threadLabel(title: string, projectId: string | null | undefined, projects: T3Project[]): string {
  const project = projects.find((candidate) => candidate.id === projectId);
  const suffix = project?.title ?? project?.name ?? projectId ?? "";
  return suffix ? `${title} — ${suffix}` : title;
}

export type PendingThreadMutation =
  | { kind: "remove" }
  | { kind: "rename"; title: string };

/**
 * Keeps an accepted T3 mutation visible while its read projection catches up.
 *
 * T3 acknowledges orchestration dispatch before `/snapshot` necessarily reflects the event. An
 * immediate refresh can therefore contain the just-deleted thread or its previous title. Pending
 * mutations mask that stale read; once a snapshot agrees, the matching entry can be forgotten.
 */
export function applyPendingThreadMutations(
  threads: T3Thread[],
  projects: T3Project[],
  pending: ReadonlyMap<string, PendingThreadMutation>,
): { threads: T3Thread[]; settledIds: string[] } {
  const visible = [...threads];
  const settledIds: string[] = [];
  for (const [threadId, mutation] of pending) {
    const index = visible.findIndex((thread) => thread.id === threadId);
    if (index < 0) {
      settledIds.push(threadId);
      continue;
    }
    if (mutation.kind === "remove") {
      visible.splice(index, 1);
      continue;
    }
    const thread = visible[index];
    if (thread.title === mutation.title) {
      settledIds.push(threadId);
      continue;
    }
    visible[index] = {
      ...thread,
      title: mutation.title,
      label: threadLabel(mutation.title, thread.projectId, projects),
    };
  }
  return { threads: visible, settledIds };
}

const WORKSPACE_CACHE_TTL_MS = 30_000;
const WORKSPACE_PREFETCH_CONCURRENCY = 2;
const WORKSPACE_PREFETCH_LIMIT = 3;
const WORKSPACE_CACHE_MAX_ENTRIES = 8;

interface WorkspaceSnapshotResponse {
  environment: Environment;
  snapshot?: { projects?: JsonRecord[]; threads?: JsonRecord[] };
  screen?: unknown;
}

interface CachedWorkspace {
  result: WorkspaceSnapshotResponse;
  projects: T3Project[];
  threads: T3Thread[];
  loadedAt: number;
}

/** LRU insertion for browser-only projections; old workspaces must not accumulate forever. */
export function setBoundedCacheEntry<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
): void {
  const limit = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 1;
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Speculative workspace reads are a small optimization, never an account-sized fan-out. */
export function selectWorkspacePrefetchIds(
  environmentIds: readonly string[],
  limit = WORKSPACE_PREFETCH_LIMIT,
): string[] {
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  return [...new Set(environmentIds)].slice(0, boundedLimit);
}

/** Runs background work with a hard concurrency ceiling so large environment lists stay responsive. */
export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
}

/** SSE payloads are JSON text. A frame the gateway could not have sent is simply ignored. */
function parseEventData(data: unknown): unknown {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function dedupeEnvironments(environments: Environment[]): Environment[] {
  const unique = new Map<string, Environment>();
  for (const environment of environments) {
    const key = environment.baseUrl
      ? environment.baseUrl.trim().replace(/\/+$/u, "").toLowerCase()
      : `connector:${environment.connectorId ?? environment.id}`;
    const current = unique.get(key);
    if (!current) {
      unique.set(key, environment);
      continue;
    }

    // Legacy pairing could create a second row for the same T3 server. Keep the oldest identity so
    // device/onboarding references remain stable; when timestamps are unavailable, retain the first
    // API result (the stores return records in creation order).
    const currentCreatedAt = Date.parse(current.createdAt ?? "");
    const candidateCreatedAt = Date.parse(environment.createdAt ?? "");
    if (Number.isFinite(candidateCreatedAt)
      && (!Number.isFinite(currentCreatedAt) || candidateCreatedAt < currentCreatedAt)) {
      unique.set(key, environment);
    }
  }
  return [...unique.values()];
}

export function useController({ authConfig, clerk }: UseControllerOptions) {
  const authenticated = Boolean(clerk?.loaded && clerk.signedIn);
  const [connection, setConnection] = useState<ConnectionState>("signed-out");
  const [connectionDetail, setConnectionDetail] = useState("Authentication required");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [workspaceRecovery, setWorkspaceRecovery] = useState<WorkspaceRecovery | null>(null);
  // Bumped when the owner supplies a new T3 credential. A paused recovery watch keys off this,
  // because an environment's updatedAt also moves on every health check.
  const [environmentCredentialEpoch, setEnvironmentCredentialEpoch] = useState(0);
  const [lastResult, setLastResult] = useState<unknown>({
    message: "Console ready.",
  });

  const [deviceProfiles, setDeviceProfiles] = useState<DeviceProfile[]>([]);
  // The board catalogue is static for the life of a gateway build, so it is fetched once on mount
  // rather than joining refreshAll — that is already twelve parallel requests against a rate limit.
  const [hardwareBoards, setHardwareBoards] = useState<HardwareBoard[]>([]);
  const [defaultHardwareBoard, setDefaultHardwareBoard] = useState<string | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [archivedEnvironments, setArchivedEnvironments] = useState<Environment[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [projects, setProjects] = useState<T3Project[]>([]);
  const [threads, setThreads] = useState<T3Thread[]>([]);
  const [harnessCatalogue, setHarnessCatalogue] = useState<T3HarnessCatalogue | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [commandEvents, setCommandEvents] = useState<CommandEvent[]>([]);
  const [timelineCommand, setTimelineCommand] = useState<Command | null>(null);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [actions, setActions] = useState<SavedAction[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [mediaJobs, setMediaJobs] = useState<MediaJob[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [notifications, setNotifications] = useState<UserNotification[]>([]);
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0);
  const [notificationOldestCursor, setNotificationOldestCursor] = useState<string | null>(null);
  const [notificationsHaveMore, setNotificationsHaveMore] = useState(false);
  const [notificationsLoaded, setNotificationsLoaded] = useState(false);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  const [backgroundLiveness, setBackgroundLiveness] = useState<BackgroundLiveness | null>(null);
  const [backgroundLivenessError, setBackgroundLivenessError] = useState<string | null>(null);
  const [display, setDisplay] = useState<DisplayState | null>(null);
  const [privacyDays, setPrivacyDays] = useState<number | null>(30);
  const [remoteAccess, setRemoteAccess] = useState<RemoteAccessStatus | null>(null);
  const [gatewayProfiles, setGatewayProfiles] = useState<GatewayProfile[]>([]);
  const [deviceSecret, setDeviceSecret] = useState<DeviceSecret | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [onboardingReadiness, setOnboardingReadiness] = useState<OnboardingReadiness | null>(null);
  const [onboardingLoaded, setOnboardingLoaded] = useState(false);

  const [selectedEnvironmentId, setSelectedEnvironmentIdState] = useState("");
  const [selectedProjectId, setSelectedProjectIdState] = useState("");
  const [selectedThreadId, setSelectedThreadIdState] = useState("");
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  // Keyed per environment so a late response from one workspace can never mask a thread in the
  // workspace the operator switched to while the request was in flight.
  const pendingThreadMutationsRef = useRef(
    new Map<string, Map<string, PendingThreadMutation>>(),
  );
  // Workspace snapshots are cheap to switch between once normalized, so keep a short-lived cache
  // per environment. Network work is also shared per environment to prevent page-level loaders,
  // the sidebar, and background prefetch from issuing the same request at once.
  const workspaceCacheRef = useRef(new Map<string, CachedWorkspace>());
  const workspaceFetchesRef = useRef(new Map<string, Promise<CachedWorkspace>>());
  const workspaceLoadsRef = useRef(new Map<string, Promise<WorkspaceSnapshotResponse>>());
  const workspaceCacheEpochRef = useRef(0);
  const [deviceConfig, setDeviceConfig] = useState<DeviceConfig>({
    environmentId: null,
    threadId: null,
    gatewayAccessMode: "local",
    gatewayUrl: null,
    defaultPrompt: "",
    shellCommand: "npm test",
    menu: ["status", "prompt", "shell", "macro", "thread", "media", "stop"],
  });

  const refreshTimerRef = useRef<number | null>(null);
  const notificationRefreshTimerRef = useRef<number | null>(null);
  const notificationRefreshModeRef = useRef<"replay" | "full">("replay");
  const notificationReplayCursorRef = useRef<string | null>(null);
  const workspaceEventTimersRef = useRef(new Map<string, number>());
  const loadSnapshotRef = useRef<((environmentId: string) => Promise<unknown>) | null>(null);
  // Refresh coalescing and rate-limit backoff. Without these, one 429 feeds the next refresh and
  // the dashboard hammers the gateway until the window resets.
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const rateLimitedUntilRef = useRef(0);
  const refreshAllRef = useRef<(() => Promise<void>) | null>(null);
  const selectedEnvironmentIdRef = useRef("");
  const selectedProjectIdRef = useRef("");
  const selectedThreadIdRef = useRef("");
  const snapshotRequestRef = useRef(0);
  const harnessRequestRef = useRef(0);

  const api = useCallback(async <T,>(
    path: string,
    options: ControllerApiOptions = {},
  ): Promise<T> => {
    try {
      let requestToken = options.token;
      if (options.auth !== false && !requestToken) {
        requestToken = await clerk?.getToken() ?? undefined;
        if (!requestToken) {
          throw new ApiError(401, "Sign in to continue.");
        }
      }
      const { silent: _silent, ...requestOptions } = options;
      return await requestJson<T>(path, {
        ...requestOptions,
        token: requestToken,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected request failure.";
      if (!options.silent) {
        setConnection("error");
        setConnectionDetail(message);
        setNotice({ tone: "danger", message });
      }
      throw error;
    }
  }, [clerk]);

  const refreshNotifications = useCallback(async () => {
    if (!authenticated) return;
    try {
      const result = await api<{
        notifications: UserNotification[];
        nextCursor: string | null;
        oldestCursor: string | null;
        hasMoreBefore: boolean;
        unreadCount: number;
      }>("/v1/notifications?limit=100", { silent: true });
      setNotifications((result.notifications ?? [])
        .filter((record) => !record.dismissedAt)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)));
      notificationReplayCursorRef.current = result.nextCursor ?? null;
      setNotificationOldestCursor(result.oldestCursor ?? null);
      setNotificationsHaveMore(Boolean(result.hasMoreBefore));
      setNotificationUnreadCount(result.unreadCount ?? 0);
      setNotificationsError(null);
    } catch (error) {
      setNotificationsError(error instanceof Error ? error.message : "Notifications are unavailable.");
    } finally {
      setNotificationsLoaded(true);
    }
  }, [api, authenticated]);

  const replayNotifications = useCallback(async () => {
    if (!authenticated) return;
    const cursor = notificationReplayCursorRef.current;
    if (!cursor) return await refreshNotifications();
    try {
      let after: string | null = cursor;
      let pageCount = 0;
      let unreadCount = 0;
      const incoming: UserNotification[] = [];
      while (after && pageCount < 10) {
        const result: {
          notifications: UserNotification[];
          nextCursor: string | null;
          hasMoreAfter: boolean;
          unreadCount: number;
        } = await api(`/v1/notifications?limit=100&after=${encodeURIComponent(after)}`, { silent: true });
        incoming.push(...(result.notifications ?? []));
        unreadCount = result.unreadCount ?? 0;
        const next: string = result.nextCursor ?? after;
        pageCount += 1;
        if (!result.hasMoreAfter || next === after) {
          after = next;
          break;
        }
        after = next;
      }
      notificationReplayCursorRef.current = after;
      if (incoming.length > 0) {
        setNotifications((current) => {
          const byId = new Map(current.map((record) => [record.id, record]));
          for (const record of incoming) {
            if (record.dismissedAt) byId.delete(record.id);
            else byId.set(record.id, record);
          }
          return [...byId.values()].sort(
            (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
          );
        });
      }
      setNotificationUnreadCount(unreadCount);
      setNotificationsError(null);
      setNotificationsLoaded(true);
    } catch (error) {
      setNotificationsError(error instanceof Error ? error.message : "Notification replay failed.");
      setNotificationsLoaded(true);
    }
  }, [api, authenticated, refreshNotifications]);

  const refreshBackgroundLiveness = useCallback(async () => {
    if (!authenticated) return;
    try {
      const result = await api<BackgroundLiveness>("/v1/background/liveness", { silent: true });
      setBackgroundLiveness(result);
      setBackgroundLivenessError(null);
    } catch (error) {
      setBackgroundLivenessError(error instanceof Error ? error.message : "Scheduler status is unavailable.");
    }
  }, [api, authenticated]);

  const loadOlderNotifications = useCallback(async () => {
    if (!authenticated || !notificationsHaveMore || !notificationOldestCursor) return;
    try {
      const result = await api<{
        notifications: UserNotification[];
        nextCursor: string | null;
        oldestCursor: string | null;
        hasMoreBefore: boolean;
        unreadCount: number;
      }>(`/v1/notifications?limit=100&before=${encodeURIComponent(notificationOldestCursor)}`, { silent: true });
      setNotifications((current) => {
        const byId = new Map(current.map((record) => [record.id, record]));
        for (const record of result.notifications ?? []) {
          if (!record.dismissedAt) byId.set(record.id, record);
        }
        return [...byId.values()].sort(
          (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
        );
      });
      setNotificationOldestCursor(result.oldestCursor ?? null);
      setNotificationsHaveMore(Boolean(result.hasMoreBefore));
      setNotificationUnreadCount(result.unreadCount ?? 0);
      setNotificationsError(null);
    } catch (error) {
      setNotificationsError(error instanceof Error ? error.message : "Older notifications are unavailable.");
    }
  }, [api, authenticated, notificationOldestCursor, notificationsHaveMore]);

  const markNotificationRead = useCallback(async (id: string) => {
    const result = await api<{ notification: UserNotification; duplicate: boolean }>(
      `/v1/notifications/${encodeURIComponent(id)}/read`,
      { method: "POST", body: {} },
    );
    await refreshNotifications();
    return result;
  }, [api, refreshNotifications]);

  const dismissNotification = useCallback(async (id: string) => {
    const result = await api<{ notification: UserNotification; duplicate: boolean }>(
      `/v1/notifications/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    await refreshNotifications();
    return result;
  }, [api, refreshNotifications]);

  const markAllNotificationsRead = useCallback(async () => {
    const result = await api<{ updatedAt: string; count: number }>("/v1/notifications/read-all", {
      method: "POST",
      body: {},
    });
    await refreshNotifications();
    return result;
  }, [api, refreshNotifications]);

  const fetchWorkspaceSnapshot = useCallback(async (
    environmentId: string,
    force = false,
    silent = false,
  ): Promise<CachedWorkspace> => {
    const cached = workspaceCacheRef.current.get(environmentId);
    if (!force && cached && Date.now() - cached.loadedAt < WORKSPACE_CACHE_TTL_MS) {
      setBoundedCacheEntry(
        workspaceCacheRef.current,
        environmentId,
        cached,
        WORKSPACE_CACHE_MAX_ENTRIES,
      );
      return cached;
    }
    const inFlight = workspaceFetchesRef.current.get(environmentId);
    if (inFlight) return inFlight;

    const cacheEpoch = workspaceCacheEpochRef.current;
    const request = api<WorkspaceSnapshotResponse>(
      `/v1/t3/environments/${encodeURIComponent(environmentId)}/snapshot`,
      { silent },
    ).then((result) => {
      const projects = (result.snapshot?.projects ?? [])
        .filter((project): project is JsonRecord => typeof project?.id === "string")
        .map((project) => project as unknown as T3Project);
      const threads = (result.snapshot?.threads ?? [])
        .map((thread) => normalizeThread(thread, projects))
        .filter((thread): thread is T3Thread => Boolean(thread));
      const workspace = { result, projects, threads, loadedAt: Date.now() };
      if (cacheEpoch === workspaceCacheEpochRef.current) {
        setBoundedCacheEntry(
          workspaceCacheRef.current,
          environmentId,
          workspace,
          WORKSPACE_CACHE_MAX_ENTRIES,
        );
      }
      return workspace;
    }).finally(() => {
      if (workspaceFetchesRef.current.get(environmentId) === request) {
        workspaceFetchesRef.current.delete(environmentId);
      }
    });
    workspaceFetchesRef.current.set(environmentId, request);
    return request;
  }, [api]);

  const run = useCallback(async <T,>(
    key: string,
    successMessage: string,
    task: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (busyAction) return undefined;
    setBusyAction(key);
    try {
      const result = await task();
      setLastResult(result);
      setNotice({ tone: "success", message: successMessage });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Action failed.";
      setLastResult({ error: message });
      setNotice({ tone: "danger", message });
      return undefined;
    } finally {
      setBusyAction(null);
    }
  }, [busyAction]);

  // The live thread subscription. State and the lease timer live here with the rest of the app
  // state; the *demand* comes from whichever view is showing a thread, which is why the target is
  // set through `watchThread` rather than derived from `selectedThreadId`. Selecting a thread in
  // the sidebar is not the same as looking at it, and a watch nobody is looking at is a WebSocket
  // held open against T3 for nothing.
  // What this account has already decided about a provider approval, keyed by T3 request id.
  //
  // It is not derived from the transcript: T3 only records a resolution once the provider has
  // acted on it, and between the answer leaving here and that landing there is a window in which
  // a second tab — or an impatient second tap — would happily send a second, different decision.
  // The gateway refuses that with a 409, but the console should not offer the button at all. Fed
  // by this tab's own answers and by the `t3.approval.decided` broadcast for every other client.
  const [providerApprovalDecisions, setProviderApprovalDecisions] = useState<
    Record<string, ProviderApprovalLocalDecision>
  >({});

  // The same idea for the third blocking kind: what this account has already answered about an
  // agent question, keyed by T3 request id. Kept apart from the approval map because they are
  // different questions with different answers, and a single map keyed only by request id would
  // let one close the other's card.
  const [userInputAnswers, setUserInputAnswers] = useState<
    Record<string, UserInputLocalAnswer>
  >({});

  const threadWatch = useThreadWatch({ api, enabled: authenticated });
  const {
    liveThread,
    watchThread,
    applyThreadSnapshotEvent,
    applyThreadEventEvents,
    applyThreadStatusEvent,
  } = threadWatch;

  const refreshAll = useCallback(async () => {
    if (!authenticated) return;

    // The gateway asked us to slow down and we have not waited long enough yet. Retrying here is
    // what turns one 429 into a storm, because every failed refresh triggers another one.
    if (Date.now() < rateLimitedUntilRef.current) return;

    // A refresh is a bounded group of control-plane reads. Overlapping refreshes multiply that
    // against the rate limit for no benefit, so coalesce instead: remember that another was asked
    // for and run it once.
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;

    try {
      // allSettled, not all: one throttled endpoint must not discard the other good responses.
      const [results] = await Promise.all([
        Promise.allSettled([
          api<{ environments: Environment[] }>("/v1/t3/environments"),
          api<{ devices: Device[] }>("/v1/devices"),
          api<{ commands: Command[] }>("/v1/commands"),
          api<{ macros: Macro[] }>("/v1/macros"),
          api<{ privacy: { mediaRetentionDays: number | null } }>("/v1/settings/privacy"),
          api<{ media: MediaItem[] }>("/v1/media"),
          api<{ jobs: MediaJob[] }>("/v1/media/jobs"),
          api<{ events: AuditEvent[] }>("/v1/audit"),
          api<{ display: DisplayState }>("/v1/display"),
          api<OnboardingResponse>("/v1/onboarding"),
          api<{ actions: SavedAction[] }>("/v1/actions"),
          api<{ remoteAccess: RemoteAccessStatus }>("/v1/settings/remote-access"),
          api<{ profiles: GatewayProfile[] }>("/v1/gateway-profiles"),
          api<{ connectors: Connector[] }>("/v1/connectors"),
        ]),
        refreshNotifications(),
        refreshBackgroundLiveness(),
      ]);

      const [
        environmentResult, deviceResult, commandResult, macroResult, privacyResult,
        mediaResult, mediaJobsResult, auditResult, displayResult, onboardingResult, actionsResult,
        remoteAccessResult, gatewayProfilesResult, connectorsResult,
      ] = results;

      const valueOf = <T,>(result: PromiseSettledResult<T>): T | null =>
        result.status === "fulfilled" ? result.value : null;

      if (environmentResult.status === "fulfilled") {
        const listed = dedupeEnvironments(environmentResult.value.environments ?? []);
        setEnvironments(listed.filter((environment) => !environment.archivedAt));
        setArchivedEnvironments(listed.filter((environment) => Boolean(environment.archivedAt)));
      }
      if (deviceResult.status === "fulfilled") setDevices(deviceResult.value.devices ?? []);
      if (commandResult.status === "fulfilled") setCommands(commandResult.value.commands ?? []);
      if (macroResult.status === "fulfilled") setMacros(macroResult.value.macros ?? []);
      if (privacyResult.status === "fulfilled") {
        setPrivacyDays(privacyResult.value.privacy?.mediaRetentionDays ?? null);
      }
      if (mediaResult.status === "fulfilled") setMedia(mediaResult.value.media ?? []);
      if (mediaJobsResult.status === "fulfilled") setMediaJobs(mediaJobsResult.value.jobs ?? []);
      if (auditResult.status === "fulfilled") {
        setAudit((auditResult.value.events ?? []).slice(-120).reverse());
      }
      if (displayResult.status === "fulfilled") setDisplay(displayResult.value.display ?? null);
      if (actionsResult.status === "fulfilled") setActions(actionsResult.value.actions ?? []);
      if (remoteAccessResult.status === "fulfilled") {
        setRemoteAccess(remoteAccessResult.value.remoteAccess ?? null);
      }
      if (gatewayProfilesResult.status === "fulfilled") {
        setGatewayProfiles(gatewayProfilesResult.value.profiles ?? []);
      }
      if (connectorsResult.status === "fulfilled") {
        setConnectors(connectorsResult.value.connectors ?? []);
      }
      const onboardingValue = valueOf(onboardingResult);
      if (onboardingValue) {
        setOnboarding(onboardingValue.onboarding);
        setOnboardingReadiness(onboardingValue.readiness);
        setOnboardingLoaded(true);
      }

      const failures = results.filter((result) => result.status === "rejected");
      const throttled = failures
        .map((result) => (result as PromiseRejectedResult).reason)
        .find((reason) => reason instanceof ApiError && reason.status === 429) as ApiError | undefined;

      if (throttled) {
        // Honour retry-after; fall back to the window length the gateway uses.
        const waitMs = Math.max(1000, (throttled.retryAfterSeconds ?? 30) * 1000);
        rateLimitedUntilRef.current = Date.now() + waitMs;
        setConnection("reconnecting");
        setConnectionDetail(`Rate limited by the gateway; retrying in ${Math.ceil(waitMs / 1000)}s`);
        return;
      }

      // A session that has gone invalid must still surface, even from a partial refresh.
      const unauthorized = failures
        .map((result) => (result as PromiseRejectedResult).reason)
        .find((reason) => reason instanceof ApiError && (reason.status === 401 || reason.status === 403));
      if (unauthorized) throw unauthorized;

      if (failures.length === 0) {
        setConnection((current) => current === "live" ? "live" : "connected");
        setConnectionDetail("Gateway synchronized");
      }
    } finally {
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        // Let the current tick settle before draining the coalesced request.
        window.setTimeout(() => void refreshAllRef.current?.(), 0);
      }
    }
  }, [api, authenticated, refreshBackgroundLiveness, refreshNotifications]);

  const loadRemoteAccess = useCallback(async (force = false) => {
    const result = await api<{ remoteAccess: RemoteAccessStatus }>(
      `/v1/settings/remote-access${force ? "?refresh=1" : ""}`,
    );
    setRemoteAccess(result.remoteAccess);
    return result.remoteAccess;
  }, [api]);

  // Lets the coalescing tail call the latest refreshAll without making it a dependency of itself.
  refreshAllRef.current = refreshAll;

  const refreshCommands = useCallback(async () => {
    if (!authenticated) return;
    const result = await api<{ commands: Command[] }>("/v1/commands");
    setCommands(result.commands ?? []);
  }, [api, authenticated]);

  // Console-first pairing. Minting is a write; polling is a read the dialog runs on a timer, so it
  // deliberately bypasses `run()` — a notice per poll would bury everything else.
  const createConnectSession = useCallback(async (input: {
    label?: string;
    accessMode?: string;
    environmentId?: string | null;
  }) => api<ConnectSessionMint>("/v1/t3/connect-sessions", { method: "POST", body: input }), [api]);

  const fetchConnectSession = useCallback(async (sessionId: string) => api<{
    session: ConnectSession;
    environment: Environment | null;
  }>(`/v1/t3/connect-sessions/${encodeURIComponent(sessionId)}`), [api]);

  const refreshMedia = useCallback(async () => {
    if (!authenticated) return;
    // Transcription is a background job now, so the library and the job list move together: the
    // media row shows the stored transcript, the job shows how it got there.
    const [result, jobs] = await Promise.all([
      api<{ media: MediaItem[] }>("/v1/media"),
      api<{ jobs: MediaJob[] }>("/v1/media/jobs"),
    ]);
    setMedia(result.media ?? []);
    setMediaJobs(jobs.jobs ?? []);
  }, [api, authenticated]);

  // Every capture surface funnels through here so the library, the Operate composer and the Quick
  // composer all agree on the endpoint and on refreshing the library afterwards.
  const uploadMedia = useCallback(async (
    payload: Record<string, unknown>,
    options: MediaUploadOptions = {},
  ) => {
    const blob = mediaBlobFromPayload(payload);
    const contentType = typeof payload.contentType === "string" ? payload.contentType : blob.type;
    const kind = payload.kind;
    const sha256 = await blobSha256(blob);
    const request = await durableMutationRequest({
      operation: "media.upload",
      kind,
      contentType,
      sizeBytes: blob.size,
      sha256,
    });
    let session: MediaUploadSessionResponse["session"] | null = null;
    try {
      options.onProgress?.({ stage: "creating", loaded: 0, total: blob.size });
      const created = await api<MediaUploadSessionResponse>("/v1/media/uploads", {
        method: "POST",
        body: {
          kind,
          contentType,
          sizeBytes: blob.size,
          sha256,
          clientRequestId: request.clientRequestId,
          ...(typeof payload.originalName === "string" ? { originalName: payload.originalName } : {}),
          ...(typeof payload.transcript === "string" ? { transcript: payload.transcript } : {}),
          ...(typeof payload.captureSource === "string" ? { captureSource: payload.captureSource } : {}),
          ...(typeof payload.companionHandoffId === "string"
            ? { companionHandoffId: payload.companionHandoffId }
            : {}),
        },
      });
      session = created.session;
      const token = await clerk?.getToken();
      if (!token) throw new ApiError(401, "Sign in to continue.");
      options.onProgress?.({ stage: "uploading", loaded: 0, total: blob.size });
      await uploadBinary(session.upload.url, blob, {
        token,
        contentType: session.upload.contentType,
        signal: options.signal,
        onProgress: (loaded, total) => options.onProgress?.({ stage: "uploading", loaded, total }),
      });
      options.onProgress?.({ stage: "finalizing", loaded: blob.size, total: blob.size });
      const finalized = await api<{ media: MediaItem }>(session.finalizeUrl, { method: "POST", body: {} });
      clearDurableMutationRequest(request.storageKey);
      await refreshAll();
      return finalized.media;
    } catch (error) {
      if (options.signal?.aborted && session) {
        await api(session.upload.url.replace(/\/content$/u, ""), {
          method: "DELETE",
          body: {},
          silent: true,
        }).catch(() => undefined);
        clearDurableMutationRequest(request.storageKey);
      }
      throw error;
    }
  }, [api, clerk, refreshAll]);

  const loadMediaPreview = useCallback(async (item: MediaItem): Promise<Blob> => {
    const maxPreviewBytes = item.kind === "image" ? 8 * 1024 * 1024 : 24 * 1024 * 1024;
    if ((item.sizeBytes ?? 0) > maxPreviewBytes) {
      throw new Error(`Preview is limited to ${Math.round(maxPreviewBytes / 1024 / 1024)} MB.`);
    }
    const token = await clerk?.getToken();
    if (!token) throw new ApiError(401, "Sign in to preview media.");
    const response = await fetch(`/v1/media/${encodeURIComponent(item.id)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new ApiError(response.status, `Media preview failed with HTTP ${response.status}.`);
    const blob = await response.blob();
    if (blob.size > maxPreviewBytes) throw new Error("Media preview exceeded the local preview limit.");
    return blob;
  }, [clerk]);

  const clearSessionState = useCallback(() => {
    workspaceCacheEpochRef.current += 1;
    workspaceCacheRef.current.clear();
    workspaceFetchesRef.current.clear();
    workspaceLoadsRef.current.clear();
    pendingThreadMutationsRef.current.clear();
    snapshotRequestRef.current += 1;
    harnessRequestRef.current += 1;
    setConnection("signed-out");
    setConnectionDetail("Authentication required");
    setEnvironments([]);
    setArchivedEnvironments([]);
    setConnectors([]);
    setProjects([]);
    setThreads([]);
    setDevices([]);
    setCommands([]);
    setMacros([]);
    setActions([]);
    setMedia([]);
    setMediaJobs([]);
    setAudit([]);
    setNotifications([]);
    setNotificationUnreadCount(0);
    setNotificationOldestCursor(null);
    notificationReplayCursorRef.current = null;
    setNotificationsHaveMore(false);
    setNotificationsLoaded(false);
    setNotificationsError(null);
    setBackgroundLiveness(null);
    setBackgroundLivenessError(null);
    setDisplay(null);
    setRemoteAccess(null);
    setGatewayProfiles([]);
    setOnboarding(null);
    setOnboardingReadiness(null);
    setOnboardingLoaded(false);
    setWorkspaceRecovery(null);
  }, []);

  // The catalogue is for the console's own screens - the device editor, the onboarding wizard -
  // and nobody who is looking at the signed-out marketing pages needs it. Loading it anyway spent
  // two requests on every visitor and put a failure in the console for a gateway that is simply
  // not answering. It loads when there is a session.
  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    async function loadProfiles() {
      try {
        const result = await requestJson<{ profiles: DeviceProfile[] }>("/v1/device-profiles", {
          auth: false,
        });
        if (!cancelled) setDeviceProfiles(result.profiles ?? []);
      } catch (error) {
        if (!cancelled) {
          setNotice({
            tone: "danger",
            message: error instanceof Error ? error.message : "Device profiles unavailable.",
          });
        }
      }
    }
    void loadProfiles();
    return () => {
      cancelled = true;
    };
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    async function loadHardwareBoards() {
      try {
        const result = await requestJson<{ boards: HardwareBoard[]; defaultBoard: string | null }>(
          "/v1/hardware/boards",
          { auth: false },
        );
        if (cancelled) return;
        setHardwareBoards(result.boards ?? []);
        setDefaultHardwareBoard(result.defaultBoard ?? result.boards?.[0]?.id ?? null);
      } catch {
        // Non-fatal: the catalogue only decorates pre-provisioning. Failing loudly here would put a
        // danger banner in front of every signed-out visitor on a gateway too old to serve it.
      }
    }
    void loadHardwareBoards();
    return () => {
      cancelled = true;
    };
  }, [authenticated]);

  useEffect(() => {
    if (!clerk?.loaded) return;
    if (!clerk.signedIn) {
      clearSessionState();
      return;
    }
    let cancelled = false;
    setConnection("connecting");
    setConnectionDetail("Authenticating Clerk session");
    refreshAll().catch((error: unknown) => {
      if (cancelled) return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        clearSessionState();
        setNotice({ tone: "danger", message: "Your Clerk session is no longer valid. Sign in again." });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [clearSessionState, clerk?.loaded, clerk?.signedIn, refreshAll]);

  useEffect(() => {
    if (!authenticated) return;
    const threadEventBatcher = createFrameBatcher<unknown>((batch) => {
      applyThreadEventEvents(batch);
    });
    const stream = new EventSource("/v1/events", { withCredentials: true });
    stream.addEventListener("connected", () => {
      setConnection("live");
      setConnectionDetail("Live event stream connected");
      void replayNotifications();
    });
    stream.addEventListener("heartbeat", () => {
      setConnection("live");
      setConnectionDetail("Live event stream connected");
    });
    stream.addEventListener("state.changed", (event) => {
      try {
        const payload = JSON.parse(event.data) as { summary?: { latestAction?: string } };
        // Older cloud adapters broadcast authentication bookkeeping on ordinary reads. Ignore
        // these invalidations during rolling deployments or a refetch perpetually triggers itself.
        const action = payload.summary?.latestAction;
        if (action === "ensureUser" || action?.startsWith("authenticate")
          || action === "createConnectorTicket" || action === "consumeConnectorTicket") return;
        setConnectionDetail(payload.summary?.latestAction ?? "State updated");
      } catch {
        setConnectionDetail("State updated");
      }
      setConnection("live");
      // Each refresh is nine requests, so debounce generously. Bursts of state.changed are
      // common (a poll tick, a heartbeat, a command update) and all we need is one refetch.
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => {
        void refreshAll();
      }, 750);
    });
    const scheduleNotificationRefresh = (mode: "replay" | "full") => {
      if (mode === "full") notificationRefreshModeRef.current = "full";
      if (notificationRefreshTimerRef.current !== null) {
        window.clearTimeout(notificationRefreshTimerRef.current);
      }
      // The stream carries an invalidation, while GET owns replay and unread totals. Coalescing a
      // burst preserves that authority without turning each durable record into another request.
      notificationRefreshTimerRef.current = window.setTimeout(() => {
        notificationRefreshTimerRef.current = null;
        const refreshMode = notificationRefreshModeRef.current;
        notificationRefreshModeRef.current = "replay";
        if (refreshMode === "full") void refreshNotifications();
        else void replayNotifications();
      }, 150);
    };
    stream.addEventListener("notification.created", () => scheduleNotificationRefresh("replay"));
    // Updates retain their original creation cursor, so an `after` replay cannot see them. Re-read
    // the bounded inbox to apply cross-tab read/dismiss resolution and its exact unread total.
    stream.addEventListener("notification.updated", () => scheduleNotificationRefresh("full"));
    stream.addEventListener("background.liveness.changed", () => {
      void refreshBackgroundLiveness();
    });
    stream.addEventListener("threads.changed", (event) => {
      const payload = parseEventData(event.data) as {
        environmentId?: string;
        threadId?: string;
        action?: "created" | "renamed" | "archived" | "deleted";
        title?: string;
      } | null;
      if (!payload?.environmentId || !payload.threadId || !payload.action) return;
      const { environmentId, threadId, action } = payload;

      // T3 acknowledges a mutation before its snapshot projection necessarily catches up. Apply
      // the small delta immediately and retain it as an overlay while the forced snapshot settles.
      if (action === "renamed" && payload.title) {
        const pending = pendingThreadMutationsRef.current.get(environmentId) ?? new Map();
        pending.set(threadId, { kind: "rename", title: payload.title });
        pendingThreadMutationsRef.current.set(environmentId, pending);
        if (selectedEnvironmentIdRef.current === environmentId) {
          const title = payload.title;
          setThreads((current) => current.map((thread) => {
            if (thread.id !== threadId) return thread;
            const oldTitle = thread.title ?? thread.id;
            const oldLabel = thread.label ?? oldTitle;
            return { ...thread, title,
              label: oldLabel.startsWith(oldTitle)
                ? title + oldLabel.slice(oldTitle.length)
                : title };
          }));
        }
      } else if (action === "archived" || action === "deleted") {
        const pending = pendingThreadMutationsRef.current.get(environmentId) ?? new Map();
        pending.set(threadId, { kind: "remove" });
        pendingThreadMutationsRef.current.set(environmentId, pending);
        if (selectedEnvironmentIdRef.current === environmentId) {
          setThreads((current) => current.filter((thread) => thread.id !== threadId));
          if (selectedThreadIdRef.current === threadId) {
            selectedThreadIdRef.current = "";
            setSelectedThreadIdState("");
          }
        }
      }

      // Invalidate only this workspace. Advancing the epoch also prevents an older in-flight
      // response from putting pre-mutation data back into the cache.
      workspaceCacheEpochRef.current += 1;
      workspaceCacheRef.current.delete(environmentId);
      workspaceFetchesRef.current.delete(environmentId);
      workspaceLoadsRef.current.delete(environmentId);
      const existingTimer = workspaceEventTimersRef.current.get(environmentId);
      if (existingTimer !== undefined) window.clearTimeout(existingTimer);
      const timer = window.setTimeout(() => {
        workspaceEventTimersRef.current.delete(environmentId);
        if (selectedEnvironmentIdRef.current === environmentId) {
          void loadSnapshotRef.current?.(environmentId);
        }
      }, action === "created" ? 1500 : 350);
      workspaceEventTimersRef.current.set(environmentId, timer);
      setConnection("live");
      setConnectionDetail(`Thread ${action}`);
    });
    // The live thread stream. Three separate events on the same broker as everything above, and
    // deliberately NOT a refetch trigger: they carry the content itself, so a `t3.thread.event`
    // must not cost thirteen HTTP requests the way `state.changed` does.
    stream.addEventListener("t3.thread.snapshot", (event) => {
      // Everything queued before a snapshot happened before that reset. Apply it first so the
      // snapshot remains authoritative even for an unsequenced compatibility event.
      threadEventBatcher.flush();
      applyThreadSnapshotEvent(parseEventData(event.data));
    });
    stream.addEventListener("t3.thread.event", (event) => {
      threadEventBatcher.push(parseEventData(event.data));
    });
    stream.addEventListener("t3.thread.status", (event) => {
      applyThreadStatusEvent(parseEventData(event.data));
    });
    // Somebody answered a provider approval — this tab, another tab, or the controller on the
    // desk. Whoever it was, the question is no longer open to this account.
    stream.addEventListener("t3.approval.decided", (event) => {
      const payload = parseEventData(event.data) as {
        requestId?: string;
        decision?: string;
        status?: string;
        commandId?: string | null;
        observedAt?: string;
      } | null;
      if (!payload?.requestId || !payload.decision) return;
      const requestId = payload.requestId;
      setProviderApprovalDecisions((current) => ({
        ...current,
        [requestId]: {
          requestId,
          decision: payload.decision as string,
          status: payload.status ?? "dispatched",
          actorType: "user",
          commandId: payload.commandId ?? null,
          error: null,
          decidedAt: payload.observedAt ?? null,
        },
      }));
    });
    // Somebody answered an agent question — this tab, another tab, or the controller on the desk.
    // The payload deliberately carries a digest and not the answer: the words are user content and
    // reach this tab through the live thread, where they are relayed rather than stored.
    stream.addEventListener("t3.user-input.answered", (event) => {
      const payload = parseEventData(event.data) as {
        requestId?: string;
        answersHash?: string;
        status?: string;
        commandId?: string | null;
        observedAt?: string;
      } | null;
      if (!payload?.requestId) return;
      const requestId = payload.requestId;
      setUserInputAnswers((current) => ({
        ...current,
        [requestId]: {
          requestId,
          answersHash: payload.answersHash ?? "",
          status: payload.status ?? "dispatched",
          actorType: "user",
          commandId: payload.commandId ?? null,
          error: null,
          answeredAt: payload.observedAt ?? null,
        },
      }));
    });
    stream.onerror = () => {
      setConnection("reconnecting");
      setConnectionDetail("Live stream reconnecting");
    };
    return () => {
      threadEventBatcher.cancel();
      stream.close();
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (notificationRefreshTimerRef.current !== null) {
        window.clearTimeout(notificationRefreshTimerRef.current);
        notificationRefreshTimerRef.current = null;
      }
      for (const timer of workspaceEventTimersRef.current.values()) window.clearTimeout(timer);
      workspaceEventTimersRef.current.clear();
    };
  }, [
    applyThreadEventEvents,
    applyThreadSnapshotEvent,
    applyThreadStatusEvent,
    authenticated,
    refreshBackgroundLiveness,
    refreshAll,
    refreshNotifications,
    replayNotifications,
  ]);

  useEffect(() => {
    if (environments.length === 0) {
      selectedEnvironmentIdRef.current = "";
      setSelectedEnvironmentIdState("");
      setProjects([]);
      setThreads([]);
      return;
    }
    if (!environments.some((environment) => environment.id === selectedEnvironmentId)) {
      selectedEnvironmentIdRef.current = environments[0].id;
      selectedProjectIdRef.current = "";
      selectedThreadIdRef.current = "";
      setSelectedEnvironmentIdState(environments[0].id);
      setProjects([]);
      setThreads([]);
      setHarnessCatalogue(null);
      setSelectedProjectIdState("");
      setSelectedThreadIdState("");
    }
  }, [environments, selectedEnvironmentId]);

  useEffect(() => {
    if (devices.length === 0) {
      setSelectedDeviceId("");
      return;
    }
    if (!devices.some((device) => device.id === selectedDeviceId)) {
      setSelectedDeviceId(devices[0].id);
    }
  }, [devices, selectedDeviceId]);

  useEffect(() => {
    if (!selectedDeviceId || !authenticated) return;
    let cancelled = false;
    api<{ config: DeviceConfig }>(`/v1/devices/${encodeURIComponent(selectedDeviceId)}/config`)
      .then((result) => {
        if (!cancelled) {
          setDeviceConfig({
            environmentId: result.config.environmentId ?? null,
            threadId: result.config.threadId ?? null,
            gatewayAccessMode: result.config.gatewayAccessMode ?? "local",
            gatewayUrl: result.config.gatewayUrl ?? null,
            defaultPrompt: result.config.defaultPrompt ?? "",
            shellCommand: result.config.shellCommand ?? "npm test",
            menu: result.config.menu ?? [],
          });
        }
      })
      .catch(() => {
        // The global request surface already presents the error.
      });
    return () => {
      cancelled = true;
    };
  }, [api, authenticated, selectedDeviceId]);

  const applyWorkspaceToSelection = useCallback((
    environmentId: string,
    workspace: CachedWorkspace,
  ) => {
    if (selectedEnvironmentIdRef.current !== environmentId) return;
    const pendingMutations = pendingThreadMutationsRef.current.get(environmentId) ?? new Map();
    const reconciled = applyPendingThreadMutations(
      workspace.threads,
      workspace.projects,
      pendingMutations,
    );
    for (const threadId of reconciled.settledIds) pendingMutations.delete(threadId);
    if (pendingMutations.size === 0) pendingThreadMutationsRef.current.delete(environmentId);

    const nextProjects = workspace.projects;
    const nextThreads = reconciled.threads;
    const preservedThread = nextThreads.find(
      (thread) => thread.id === selectedThreadIdRef.current,
    ) ?? null;
    const preservedProject = nextProjects.find(
      (project) => project.id === selectedProjectIdRef.current,
    ) ?? null;
    const nextProjectId = preservedThread?.projectId
      ?? preservedProject?.id
      ?? nextProjects[0]?.id
      ?? nextThreads[0]?.projectId
      ?? "";
    const nextThreadId = preservedThread?.id
      ?? nextThreads.find((thread) => thread.projectId === nextProjectId)?.id
      ?? nextThreads[0]?.id
      ?? "";
    const synchronizedProjectId = nextThreads.find(
      (thread) => thread.id === nextThreadId,
    )?.projectId ?? nextProjectId;

    setProjects(nextProjects);
    setThreads(nextThreads);
    selectedProjectIdRef.current = synchronizedProjectId;
    selectedThreadIdRef.current = nextThreadId;
    setSelectedProjectIdState(synchronizedProjectId);
    setSelectedThreadIdState(nextThreadId);
  }, []);

  const setSelectedEnvironmentId = useCallback((environmentId: string) => {
    selectedEnvironmentIdRef.current = environmentId;
    selectedProjectIdRef.current = "";
    selectedThreadIdRef.current = "";
    snapshotRequestRef.current += 1;
    harnessRequestRef.current += 1;
    setSelectedEnvironmentIdState(environmentId);
    const cached = workspaceCacheRef.current.get(environmentId);
    if (cached) {
      applyWorkspaceToSelection(environmentId, cached);
    } else {
      setProjects([]);
      setThreads([]);
    }
    setHarnessCatalogue(null);
    if (!cached) {
      setSelectedProjectIdState("");
      setSelectedThreadIdState("");
    }
  }, [applyWorkspaceToSelection]);

  const setSelectedProjectId = useCallback((projectId: string) => {
    selectedProjectIdRef.current = projectId;
    setSelectedProjectIdState(projectId);
    const selectedThread = threads.find((thread) => thread.id === selectedThreadIdRef.current);
    if (selectedThread?.projectId === projectId) return;
    const nextThreadId = threads.find((thread) => thread.projectId === projectId)?.id ?? "";
    selectedThreadIdRef.current = nextThreadId;
    setSelectedThreadIdState(nextThreadId);
  }, [threads]);

  const setSelectedThreadId = useCallback((threadId: string) => {
    selectedThreadIdRef.current = threadId;
    setSelectedThreadIdState(threadId);
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (thread?.projectId) {
      selectedProjectIdRef.current = thread.projectId;
      setSelectedProjectIdState(thread.projectId);
    }
  }, [threads]);

  // The agent harnesses and models this environment can actually launch. Kept separate from the
  // snapshot because a failure here must not stop projects and threads from loading.
  const loadHarnesses = useCallback(async (environmentId = selectedEnvironmentId) => {
    if (!environmentId) return null;
    const requestId = ++harnessRequestRef.current;
    try {
      const result = await api<T3HarnessCatalogue>(
        `/v1/t3/environments/${encodeURIComponent(environmentId)}/harnesses`,
      );
      if (requestId === harnessRequestRef.current
        && selectedEnvironmentIdRef.current === environmentId) {
        setHarnessCatalogue(result);
      }
      return result;
    } catch {
      if (requestId === harnessRequestRef.current
        && selectedEnvironmentIdRef.current === environmentId) {
        setHarnessCatalogue(null);
      }
      return null;
    }
  }, [api, selectedEnvironmentId]);

  const loadSnapshot = useCallback(async (environmentId = selectedEnvironmentId) => {
    if (!environmentId) throw new Error("Select a T3 environment first.");
    const existing = workspaceLoadsRef.current.get(environmentId);
    if (existing) return existing;

    const requestId = ++snapshotRequestRef.current;
    const request = (async () => {
      const harnessRequest = loadHarnesses(environmentId);
      let workspace: CachedWorkspace;
      try {
        workspace = await fetchWorkspaceSnapshot(environmentId, true);
        setWorkspaceRecovery(null);
      } catch (error) {
        if (isT3SnapshotUnavailableError(error)) {
          const environment = environments.find((candidate) => candidate.id === environmentId);
          const connectorFailure = connectorFailureFromMetadata(
            environment,
            connectorForEnvironment(connectors, environment),
          );
          const failure = connectorFailure
            ?? (error instanceof ApiError ? parseEnvironmentFailure(error.details) : null)
            ?? genericEnvironmentFailure();
          setWorkspaceRecovery({ environmentId, failure });
        }
        throw error;
      }
      await harnessRequest;
      if (requestId === snapshotRequestRef.current
        && selectedEnvironmentIdRef.current === environmentId) {
        applyWorkspaceToSelection(environmentId, workspace);
      }
      return workspace.result;
    })();
    workspaceLoadsRef.current.set(environmentId, request);
    try {
      return await request;
    } finally {
      if (workspaceLoadsRef.current.get(environmentId) === request) {
        workspaceLoadsRef.current.delete(environmentId);
      }
    }
  }, [
    applyWorkspaceToSelection,
    connectors,
    environments,
    fetchWorkspaceSnapshot,
    loadHarnesses,
    selectedEnvironmentId,
  ]);

  const loadCapabilities = useCallback(async (environmentId: string) => {
    const result = await api<{ manifest: T3CapabilityManifest }>(
      `/v1/t3/environments/${encodeURIComponent(environmentId)}/capabilities`,
    );
    setEnvironments((current) => current.map((environment) => environment.id === environmentId
      ? { ...environment, health: { ...(environment.health ?? {}), capabilities: result.manifest } }
      : environment));
    return result.manifest;
  }, [api]);
  loadSnapshotRef.current = loadSnapshot;

  const capabilityFreshUntil = environments.find((environment) => environment.id === selectedEnvironmentId)
    ?.health?.capabilities?.freshUntil;
  useEffect(() => {
    const deadline = Date.parse(capabilityFreshUntil ?? "");
    if (!authenticated || !selectedEnvironmentId || !Number.isFinite(deadline)) return;
    let cancelled = false;
    let timer: number | undefined;
    const renew = () => {
      if (cancelled || document.visibilityState === "hidden") return;
      void loadCapabilities(selectedEnvironmentId).catch(() => {}).finally(() => {
        if (!cancelled) timer = window.setTimeout(renew, 30_000);
      });
    };
    const onVisible = () => {
      if (document.visibilityState !== "hidden" && Date.now() >= deadline) {
        window.clearTimeout(timer);
        renew();
      }
    };
    timer = window.setTimeout(renew, Math.max(1_000, deadline - Date.now() + 50));
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authenticated, selectedEnvironmentId, capabilityFreshUntil, loadCapabilities]);

  const prefetchWorkspaces = useCallback(async (environmentIds: readonly string[]) => {
    const uniqueIds = selectWorkspacePrefetchIds(environmentIds);
    await runWithConcurrency(uniqueIds, WORKSPACE_PREFETCH_CONCURRENCY, async (environmentId) => {
      try {
        await fetchWorkspaceSnapshot(environmentId, false, true);
      } catch {
        // Prefetch is opportunistic. A selected environment still gets the normal recovery UI.
      }
    });
  }, [fetchWorkspaceSnapshot]);

  const environmentBatchKey = environments
    .map((environment) => `${environment.id}:${environment.status ?? "unknown"}`)
    .join("|");

  useEffect(() => {
    if (!authenticated || !selectedEnvironmentId) return;
    let cancelled = false;
    let prefetchTimer: number | null = null;
    const selectedCached = workspaceCacheRef.current.get(selectedEnvironmentId);
    const selectedIsFresh = selectedCached
      && Date.now() - selectedCached.loadedAt < WORKSPACE_CACHE_TTL_MS;
    if (selectedCached) applyWorkspaceToSelection(selectedEnvironmentId, selectedCached);

    const activeLoad = Promise.all([
      selectedIsFresh
        ? loadHarnesses(selectedEnvironmentId).then(() => undefined)
        : loadSnapshotRef.current!(selectedEnvironmentId).then(() => undefined),
      loadCapabilities(selectedEnvironmentId).then(() => undefined),
    ]);

    void activeLoad.catch(() => {
      // The request surface and workspace recovery dialog already expose selected-workspace errors.
    }).finally(() => {
      if (cancelled) return;
      const backgroundIds = environments
        .filter((environment) => environment.id !== selectedEnvironmentId)
        .filter((environment) => environment.status !== "unreachable"
          && environment.status !== "token_expired")
        .map((environment) => environment.id);
      if (backgroundIds.length === 0) return;
      // Let the selected workspace paint first, then warm the remaining trees in two-wide batches.
      prefetchTimer = window.setTimeout(() => {
        if (!cancelled) void prefetchWorkspaces(backgroundIds);
      }, 120);
    });

    return () => {
      cancelled = true;
      if (prefetchTimer !== null) window.clearTimeout(prefetchTimer);
    };
  }, [
    authenticated,
    applyWorkspaceToSelection,
    environmentBatchKey,
    loadHarnesses,
    loadCapabilities,
    prefetchWorkspaces,
    selectedEnvironmentId,
  ]);

  const renameThread = useCallback(async (threadId: string, title: string) => {
    const environmentId = selectedEnvironmentId;
    if (!environmentId) throw new Error("Select a T3 environment first.");
    const result = await api<{ threadId: string; action: "renamed"; title: string; result: unknown }>(
      `/v1/t3/environments/${encodeURIComponent(environmentId)}`
        + `/threads/${encodeURIComponent(threadId)}`,
      { method: "PATCH", body: { title } },
    );
    const pending = pendingThreadMutationsRef.current.get(environmentId) ?? new Map();
    pending.set(threadId, { kind: "rename", title: result.title });
    pendingThreadMutationsRef.current.set(environmentId, pending);
    if (selectedEnvironmentIdRef.current !== environmentId) return result;
    const project = projects.find((candidate) =>
      candidate.id === threads.find((thread) => thread.id === threadId)?.projectId
    );
    const suffix = project?.title ?? project?.name ?? project?.id ?? "";
    const canonicalTitle = result.title;
    setThreads((current) => current.map((thread) => thread.id === threadId
      ? {
          ...thread,
          title: canonicalTitle,
          label: suffix ? `${canonicalTitle} — ${suffix}` : canonicalTitle,
        }
      : thread));
    // T3 projects the command asynchronously. The local update makes the action immediate while
    // this best-effort read picks up T3's normalized, authoritative title when it is ready.
    try {
      await loadSnapshot(environmentId);
    } catch {
      // The mutation already succeeded. Workspace recovery owns any subsequent snapshot failure.
    }
    return result;
  }, [api, loadSnapshot, projects, selectedEnvironmentId, threads]);

  const removeThreadFromWorkspace = useCallback((threadId: string) => {
    const removed = threads.find((thread) => thread.id === threadId) ?? null;
    const remaining = threads.filter((thread) => thread.id !== threadId);
    setThreads((current) => current.filter((thread) => thread.id !== threadId));
    if (selectedThreadIdRef.current !== threadId) return;
    const next = remaining.find((thread) => thread.projectId === removed?.projectId)
      ?? remaining[0]
      ?? null;
    const nextThreadId = next?.id ?? "";
    const nextProjectId = next?.projectId
      ?? (removed?.projectId && projects.some((project) => project.id === removed.projectId)
        ? removed.projectId
        : projects[0]?.id)
      ?? "";
    selectedThreadIdRef.current = nextThreadId;
    selectedProjectIdRef.current = nextProjectId;
    setSelectedThreadIdState(nextThreadId);
    setSelectedProjectIdState(nextProjectId);
  }, [projects, threads]);

  const archiveThread = useCallback(async (threadId: string) => {
    const environmentId = selectedEnvironmentId;
    if (!environmentId) throw new Error("Select a T3 environment first.");
    const result = await api<{ threadId: string; action: "archived"; result: unknown }>(
      `/v1/t3/environments/${encodeURIComponent(environmentId)}`
        + `/threads/${encodeURIComponent(threadId)}/archive`,
      { method: "POST" },
    );
    const pending = pendingThreadMutationsRef.current.get(environmentId) ?? new Map();
    pending.set(threadId, { kind: "remove" });
    pendingThreadMutationsRef.current.set(environmentId, pending);
    if (selectedEnvironmentIdRef.current !== environmentId) return result;
    removeThreadFromWorkspace(threadId);
    try {
      await loadSnapshot(environmentId);
    } catch {
      // The archive succeeded; keep the locally repaired selection until T3 is reachable again.
    }
    return result;
  }, [api, loadSnapshot, removeThreadFromWorkspace, selectedEnvironmentId]);

  const deleteThread = useCallback(async (threadId: string) => {
    const environmentId = selectedEnvironmentId;
    if (!environmentId) throw new Error("Select a T3 environment first.");
    const result = await api<{ threadId: string; action: "deleted"; result: unknown }>(
      `/v1/t3/environments/${encodeURIComponent(environmentId)}`
        + `/threads/${encodeURIComponent(threadId)}`,
      { method: "DELETE" },
    );
    const pending = pendingThreadMutationsRef.current.get(environmentId) ?? new Map();
    pending.set(threadId, { kind: "remove" });
    pendingThreadMutationsRef.current.set(environmentId, pending);
    if (selectedEnvironmentIdRef.current !== environmentId) return result;
    removeThreadFromWorkspace(threadId);
    try {
      await loadSnapshot(environmentId);
    } catch {
      // The delete succeeded; keep the locally repaired selection until T3 is reachable again.
    }
    return result;
  }, [api, loadSnapshot, removeThreadFromWorkspace, selectedEnvironmentId]);

  const dismissWorkspaceRecovery = useCallback(() => {
    setWorkspaceRecovery(null);
    setNotice((current) => current?.message === T3_SNAPSHOT_UNAVAILABLE_MESSAGE ? null : current);
  }, []);

  const markEnvironmentCredentialChanged = useCallback(() => {
    setEnvironmentCredentialEpoch((current) => current + 1);
  }, []);

  const launchProject = useCallback(async (input: {
    projectId: string;
    text: string;
    modelSelection?: ModelSelection;
    // The launch route accepts attachments on the very first turn, so a composer draft does not
    // have to be re-attached after the thread exists.
    mediaUploadIds?: string[];
  }) => {
    if (!selectedEnvironmentId) throw new Error("Select a T3 environment first.");
    const pending = await durableMutationRequest({
      operation: "thread.launch",
      environmentId: selectedEnvironmentId,
      ...input,
    });
    const result = await api<{
      threadId: string;
      command: Command;
      modelSelection: ModelSelection;
      modelRecovery?: ModelRecovery | null;
    }>(
      `/v1/t3/environments/${encodeURIComponent(selectedEnvironmentId)}/threads`,
      {
        method: "POST",
        body: { ...input, clientRequestId: pending.clientRequestId },
      },
    );
    clearDurableMutationRequest(pending.storageKey);
    selectedThreadIdRef.current = result.threadId;
    setSelectedThreadIdState(result.threadId);
    await loadSnapshot(selectedEnvironmentId);
    await refreshCommands();
    return result;
  }, [api, loadSnapshot, refreshCommands, selectedEnvironmentId]);

  const loadCommandTimeline = useCallback(async (command: Command) => {
    const result = await api<{ command: Command; events: CommandEvent[] }>(
      `/v1/commands/${encodeURIComponent(command.id)}/events`,
    );
    setTimelineCommand(result.command);
    setCommandEvents(result.events ?? []);
    return result;
  }, [api]);

  const saveOnboarding = useCallback(async (input: Partial<OnboardingState>) => {
    const result = await api<OnboardingResponse>("/v1/onboarding", {
      method: "PUT",
      body: input,
    });
    setOnboarding(result.onboarding);
    setOnboardingReadiness(result.readiness);
    return result;
  }, [api]);

  const signOut = useCallback(async () => {
    if (clerk?.signedIn) await clerk.signOut();
    clearSessionState();
    setNotice({ tone: "info", message: "Signed out of the gateway." });
  }, [clearSessionState, clerk]);

  const downloadDiagnostics = useCallback(async () => {
    const bundle = await api<unknown>("/v1/support/diagnostics");
    downloadJson(
      `next-coder-diagnostics-${new Date().toISOString().replaceAll(":", "-")}.json`,
      bundle,
    );
    setLastResult(bundle);
    setNotice({ tone: "success", message: "Redacted diagnostics downloaded." });
  }, [api]);

  // The operator's own arrangement of the tree. Applied to what the controller hands out rather
  // than to the state it keeps, so ordering stays a presentation concern and every consumer — the
  // sidebar, the Operations toolbar, the dashboard pickers — agrees without asking for it.
  const ordering = useResourceOrdering();

  const orderedEnvironments = useMemo(
    () => ordering.order(environmentScope(), environments, (environment) => environment.id),
    [environments, ordering],
  );

  const orderedProjects = useMemo(
    () => ordering.order(projectScope(selectedEnvironmentId), projects, (project) => project.id),
    [ordering, projects, selectedEnvironmentId],
  );

  /**
   * Threads are exposed as one flat list but arranged per folder, so a consumer that filters by
   * project gets the operator's order and one that does not gets the threads grouped by folder in
   * folder order — which is the same tree, flattened.
   */
  const orderedThreads = useMemo(() => {
    const byProject = new Map<string, T3Thread[]>();
    for (const thread of threads) {
      const key = thread.projectId ?? "";
      const bucket = byProject.get(key);
      if (bucket) bucket.push(thread);
      else byProject.set(key, [thread]);
    }
    const arranged: T3Thread[] = [];
    for (const project of orderedProjects) {
      const bucket = byProject.get(project.id);
      if (!bucket) continue;
      arranged.push(...ordering.order(threadScope(project.id), bucket, (thread) => thread.id));
      byProject.delete(project.id);
    }
    // Whatever is left is unfoldered, or belongs to a folder this snapshot did not report. Neither
    // is a reason to drop a thread from the list.
    for (const [key, bucket] of byProject) {
      arranged.push(...ordering.order(threadScope(key || null), bucket, (thread) => thread.id));
    }
    return arranged;
  }, [orderedProjects, ordering, threads]);

  const pendingApprovals = useMemo(
    () => commands.filter((command) => command.status === "approval_required").slice(-12).reverse(),
    [commands],
  );
  const recentCommands = useMemo(() => commands.slice(-24).reverse(), [commands]);
  const selectedEnvironment = useMemo(
    () => environments.find((environment) => environment.id === selectedEnvironmentId) ?? null,
    [environments, selectedEnvironmentId],
  );
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  );

  /**
   * Answer one provider approval — a question T3 is holding open, not a gateway policy hold.
   *
   * Idempotency lives in the gateway (it claims the request id before dispatching), so this does
   * not try to be clever about it. What it does do is record the answer locally the moment it
   * lands, so the buttons stop being offered without waiting for T3 to echo a resolution back
   * through the stream.
   */
  const answerProviderApproval = useCallback(async (
    target: { environmentId: string; threadId: string },
    requestId: string,
    decision: ProviderApprovalDecision,
  ) => {
    const path = `/v1/t3/environments/${encodeURIComponent(target.environmentId)}`
      + `/threads/${encodeURIComponent(target.threadId)}`
      + `/approvals/${encodeURIComponent(requestId)}`;
    return await run(
      `provider-approval-${requestId}`,
      "Answer sent to the agent.",
      async () => {
        const result = await api<{ decision?: ProviderApprovalLocalDecision }>(path, {
          method: "POST",
          body: { decision },
        });
        if (result?.decision) {
          setProviderApprovalDecisions((current) => ({
            ...current,
            [requestId]: result.decision as ProviderApprovalLocalDecision,
          }));
        }
        return result;
      },
    );
  }, [api, run]);

  /**
   * Answer one agent question — the third blocking kind, and the only one whose answer is a value.
   *
   * Validation lives in the gateway, which checks the answers against the request's own questions
   * before anything is dispatched; a 422 here means the answer did not fit the question, not that
   * something broke. Idempotency lives there too (the request id is claimed against a fingerprint
   * of the answers), so this does not try to be clever about it — it just records the answer
   * locally the moment it lands, so the form stops being offered without waiting for T3 to echo a
   * resolution back through the stream.
   */
  const answerUserInput = useCallback(async (
    target: { environmentId: string; threadId: string },
    requestId: string,
    answers: UserInputAnswers,
  ) => {
    const path = `/v1/t3/environments/${encodeURIComponent(target.environmentId)}`
      + `/threads/${encodeURIComponent(target.threadId)}`
      + `/user-input/${encodeURIComponent(requestId)}`;
    return await run(
      `user-input-${requestId}`,
      "Answer sent to the agent.",
      async () => {
        const result = await api<{ answer?: UserInputLocalAnswer }>(path, {
          method: "POST",
          body: { answers },
        });
        if (result?.answer) {
          setUserInputAnswers((current) => ({
            ...current,
            [requestId]: result.answer as UserInputLocalAnswer,
          }));
        }
        return result;
      },
    );
  }, [api, run]);

  const localNotificationControls = useLocalNotifications(notifications, notificationsLoaded);

  return {
    ...localNotificationControls,
    authConfig,
    clerk,
    authenticated,
    connection,
    connectionDetail,
    busyAction,
    notice,
    setNotice,
    workspaceRecovery,
    dismissWorkspaceRecovery,
    environmentCredentialEpoch,
    markEnvironmentCredentialChanged,
    lastResult,
    setLastResult,
    deviceProfiles,
    hardwareBoards,
    defaultHardwareBoard,
    environments: orderedEnvironments,
    archivedEnvironments,
    connectors,
    projects: orderedProjects,
    threads: orderedThreads,
    reorderResources: ordering.reorder,
    nudgeResource: ordering.nudge,
    harnesses: harnessCatalogue?.harnesses ?? [],
    harnessCatalogueSource: harnessCatalogue?.catalogueSource ?? null,
    sessionFailures: harnessCatalogue?.sessionFailures ?? [],
    suggestedModelSelection: harnessCatalogue?.modelSelection ?? null,
    loadHarnesses,
    devices,
    commands,
    pendingApprovals,
    providerApprovalDecisions,
    answerProviderApproval,
    userInputAnswers,
    answerUserInput,
    recentCommands,
    commandEvents,
    timelineCommand,
    macros,
    actions,
    media,
    mediaJobs,
    audit,
    notifications,
    notificationUnreadCount,
    notificationsHaveMore,
    notificationsLoaded,
    notificationsError,
    backgroundLiveness,
    backgroundLivenessError,
    display,
    privacyDays,
    setPrivacyDays,
    remoteAccess,
    gatewayProfiles,
    loadRemoteAccess,
    deviceSecret,
    setDeviceSecret,
    onboarding,
    onboardingReadiness,
    onboardingLoaded,
    selectedEnvironmentId,
    setSelectedEnvironmentId,
    selectedEnvironment,
    selectedProjectId,
    setSelectedProjectId,
    selectedProject,
    selectedThreadId,
    setSelectedThreadId,
    /** The live transcript for the thread currently being watched, or null when none is. */
    liveThread,
    /** Declare the thread on screen. Registers a lease, renews it, and releases it on teardown. */
    watchThread,
    selectedDeviceId,
    setSelectedDeviceId,
    selectedDevice,
    deviceConfig,
    setDeviceConfig,
    api,
    run,
    refreshAll,
    refreshCommands,
    refreshMedia,
    refreshNotifications,
    refreshBackgroundLiveness,
    loadOlderNotifications,
    markNotificationRead,
    dismissNotification,
    markAllNotificationsRead,
    createConnectSession,
    fetchConnectSession,
    uploadMedia,
    loadMediaPreview,
    loadSnapshot,
    renameThread,
    archiveThread,
    deleteThread,
    launchProject,
    loadCommandTimeline,
    saveOnboarding,
    signOut,
    clearSessionState,
    downloadDiagnostics,
  };
}

export type Controller = ReturnType<typeof useController>;

function mediaBlobFromPayload(payload: Record<string, unknown>): Blob {
  if (payload.blob instanceof Blob) return payload.blob;
  if (typeof payload.dataBase64 === "string") {
    const binary = atob(payload.dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], {
      type: typeof payload.contentType === "string" ? payload.contentType : "application/octet-stream",
    });
  }
  throw new ApiError(400, "Media bytes are required.");
}

async function blobSha256(blob: Blob): Promise<string> {
  if (!crypto.subtle) throw new ApiError(501, "This browser cannot verify media integrity.");
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
