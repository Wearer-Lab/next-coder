import { buildBackgroundLiveness } from "./notifications.mjs";

const BACKGROUND_TASK_VERSION = 1;
const MAX_QUEUE_BATCH = 100;
const MAX_TASK_BYTES = 256 * 1024;
const MAX_SNAPSHOT_USERS = 100;

export const BACKGROUND_TASK_KINDS = Object.freeze([
  "media.process",
  "media.retention",
  "environment.retention",
  "snapshot.reconcile",
  "connector.project",
  "maintenance.targets",
  "rollout.reconcile",
  "scheduler.heartbeat",
  "push.deliver",
]);

const KIND_SET = new Set(BACKGROUND_TASK_KINDS);

/**
 * Runtime-neutral background boundary. Cloudflare Queue, Workflow and Cron handlers can delegate
 * here without importing domain state machines into the Worker. The same runOnce() drives tests
 * and the private container capability endpoint.
 */
export function createCloudBackgroundWork({
  mediaJobRunner,
  mediaRetentionRunner,
  environmentRetentionRunner,
  snapshotPoller,
  connectorInternalService,
  releaseRolloutRunner,
  webPushDeliveryRunner,
  store = null,
  events = null,
  scheduledTasks = [{ version: BACKGROUND_TASK_VERSION, kind: "media.process", payload: {} }],
  logger = console,
} = {}) {
  let running = false;

  async function runOnce(input) {
    const task = normalizeTask(input);
    switch (task.kind) {
      case "media.process": {
        requireRunner(mediaJobRunner, task.kind);
        const result = await mediaJobRunner.runOnce();
        // Concurrent uploads each carry a wakeup. A busy runner has not consumed this one;
        // acknowledging it could strand another user's queued recording until the Cron sweep.
        if (result?.skipped) throw Object.assign(new Error("Media processor is busy."), {
          code: "media_processor_busy", retryable: true,
        });
        return taskResult(task, result);
      }
      case "media.retention":
        requireRunner(mediaRetentionRunner, task.kind);
        return taskResult(task, await mediaRetentionRunner.runOnce({
          userId: requireText(task.payload.userId, "userId"),
          ...(typeof task.payload.checkedAt === "string" ? { checkedAt: task.payload.checkedAt } : {}),
        }));
      case "environment.retention":
        requireRunner(environmentRetentionRunner, task.kind);
        return taskResult(task, await environmentRetentionRunner.runOnce({
          userId: requireText(task.payload.userId, "userId"),
          ...(typeof task.payload.checkedAt === "string" ? { checkedAt: task.payload.checkedAt } : {}),
        }));
      case "snapshot.reconcile": {
        requireRunner(snapshotPoller, task.kind);
        const userIds = normalizeUserIds(task.payload);
        return taskResult(task, await snapshotPoller.runOnce({ userIds }));
      }
      case "connector.project":
        requireRunner(connectorInternalService, task.kind, "fetch");
        return taskResult(task, await projectConnectorEvent(connectorInternalService, task.payload.event));
      case "maintenance.targets":
        requireRunner(store, task.kind, "listBackgroundWorkUsers");
        return taskResult(task, await store.listBackgroundWorkUsers({
          afterUserId: typeof task.payload.cursor === "string" ? task.payload.cursor : null,
          limit: 100,
        }));
      case "rollout.reconcile":
        requireRunner(releaseRolloutRunner, task.kind);
        return taskResult(task, await releaseRolloutRunner.runOnce({ limit: 25 }));
      case "push.deliver":
        requireRunner(webPushDeliveryRunner, task.kind);
        return taskResult(task, await webPushDeliveryRunner.runOnce());
      case "scheduler.heartbeat": {
        const scheduledAt = Number(task.payload.scheduledAt);
        const attemptedAt = new Date(Number.isFinite(scheduledAt) ? scheduledAt : Date.now()).toISOString();
        // The queue may acknowledge this task only after the heartbeat is durable. Otherwise a
        // storage outage would consume the sole proof that Cron reached the private worker.
        await recordScheduledLiveness({ attemptedAt, failure: null, throwOnFailure: true });
        return taskResult(task, { recorded: true, attemptedAt });
      }
      default:
        throw terminal(`Unsupported background task kind: ${task.kind}`, "background_task_unsupported");
    }
  }

  async function handleQueueBatch(batch) {
    const messages = Array.isArray(batch?.messages) ? batch.messages.slice(0, MAX_QUEUE_BATCH) : [];
    for (const deferred of Array.isArray(batch?.messages) ? batch.messages.slice(MAX_QUEUE_BATCH) : []) deferred.retry?.();
    const outcomes = [];
    for (const message of messages) {
      try {
        const result = await runOnce(message.body);
        message.ack?.();
        outcomes.push({ id: message.id ?? null, status: "acked", result });
      } catch (error) {
        const failure = classifyBackgroundFailure(error);
        if (failure.retryable) message.retry?.();
        else message.ack?.();
        logger?.warn?.(`background queue task ${message.id ?? "unknown"} ${failure.code}`);
        outcomes.push({ id: message.id ?? null, status: failure.retryable ? "retried" : "rejected", failure });
      }
    }
    return { processed: outcomes.length, outcomes, truncated: (batch?.messages?.length ?? 0) > messages.length };
  }

  async function handleWorkflowEvent(event) {
    return await runOnce(event?.payload ?? event);
  }

  async function handleScheduledTick({ tasks = scheduledTasks } = {}) {
    if (running) return { skipped: true, results: [] };
    running = true;
    const attemptedAt = new Date().toISOString();
    try {
      const results = [];
      for (const task of tasks.slice(0, MAX_QUEUE_BATCH)) {
        try {
          results.push(await runOnce(task));
        } catch (error) {
          results.push({ kind: task?.kind ?? null, failure: classifyBackgroundFailure(error) });
        }
      }
      const failure = results.find((result) => result?.failure)?.failure ?? null;
      await recordScheduledLiveness({ attemptedAt, failure });
      return { skipped: false, results };
    } catch (error) {
      await recordScheduledLiveness({ attemptedAt, failure: classifyBackgroundFailure(error) });
      throw error;
    } finally {
      running = false;
    }
  }

  async function recordScheduledLiveness({ attemptedAt, failure, throwOnFailure = false }) {
    if (typeof store?.recordBackgroundLiveness !== "function") {
      if (throwOnFailure) throw terminal("scheduler heartbeat storage is not configured.", "background_task_unconfigured");
      return;
    }
    try {
      const record = await store.recordBackgroundLiveness({
        scope: "scheduled-worker",
        attemptedAt,
        succeeded: !failure,
        failureCode: failure?.code ?? null,
      });
      events?.broadcastToAll?.("background.liveness.changed", {
        scheduledWorker: buildBackgroundLiveness({ record, configured: true }),
        observedAt: new Date().toISOString(),
      });
    } catch (error) {
      logger?.warn?.(`background liveness record failed ${classifyBackgroundFailure(error).code}`);
      if (throwOnFailure) throw error;
    }
  }

  async function fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/internal/background/run") return Response.json({ error: "not_found" }, { status: 404 });
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_TASK_BYTES) {
      return Response.json({ error: "background_task_too_large" }, { status: 413 });
    }
    let task;
    try { task = JSON.parse(text); }
    catch { return Response.json({ error: "invalid_background_task" }, { status: 400 }); }
    try {
      return Response.json(await runOnce(task));
    } catch (error) {
      const failure = classifyBackgroundFailure(error);
      return Response.json({ error: failure.code, retryable: failure.retryable }, {
        status: failure.retryable ? 503 : 400,
      });
    }
  }

  return { runOnce, handleQueueBatch, handleWorkflowEvent, handleScheduledTick, fetch };
}

export function classifyBackgroundFailure(error) {
  const retryable = error?.retryable !== false;
  return {
    code: typeof error?.code === "string" ? error.code : "background_task_failed",
    retryable,
    terminal: !retryable,
  };
}

function normalizeTask(input) {
  let value = input;
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_TASK_BYTES) throw terminal("Task is too large.", "background_task_too_large");
    try { value = JSON.parse(value); }
    catch { throw terminal("Task is not valid JSON.", "background_task_invalid"); }
  } else {
    let encoded;
    try { encoded = JSON.stringify(value); }
    catch { throw terminal("Task cannot be encoded.", "background_task_invalid"); }
    if (new TextEncoder().encode(encoded).byteLength > MAX_TASK_BYTES) {
      throw terminal("Task is too large.", "background_task_too_large");
    }
  }
  if (!isRecord(value) || value.version !== BACKGROUND_TASK_VERSION || !KIND_SET.has(value.kind)) {
    throw terminal("Task envelope is invalid.", "background_task_invalid");
  }
  if (value.payload !== undefined && !isRecord(value.payload)) {
    throw terminal("Task payload must be an object.", "background_task_invalid");
  }
  return { version: value.version, kind: value.kind, taskId: text(value.taskId), payload: value.payload ?? {} };
}

function normalizeUserIds(payload) {
  const input = Array.isArray(payload.userIds) ? payload.userIds : [payload.userId];
  const userIds = [...new Set(input.filter((value) => typeof value === "string" && value.length > 0))];
  if (userIds.length === 0 || userIds.length > MAX_SNAPSHOT_USERS) {
    throw terminal("snapshot.reconcile requires 1-100 user ids.", "background_snapshot_users_invalid");
  }
  return userIds;
}

async function projectConnectorEvent(service, event) {
  const response = await service.fetch(new Request("https://control-plane.internal/v1/internal/connector-events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  }));
  const body = await response.json().catch(() => null);
  if (response.ok) return body;
  const retryable = response.status >= 500 || response.status === 429;
  const error = new Error("Connector projection failed.");
  error.code = body?.error ?? "connector_projection_failed";
  error.retryable = retryable;
  throw error;
}

function taskResult(task, result) {
  return { version: BACKGROUND_TASK_VERSION, taskId: task.taskId, kind: task.kind, result };
}

function requireRunner(value, kind, method = "runOnce") {
  if (typeof value?.[method] !== "function") throw terminal(`${kind} is not configured.`, "background_task_unconfigured");
}

function requireText(value, field) {
  if (typeof value !== "string" || !value) throw terminal(`${field} is required.`, "background_task_invalid");
  return value;
}

function terminal(message, code) {
  return Object.assign(new Error(message), { code, retryable: false });
}

function text(value) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 128) : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
