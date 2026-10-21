import { ApiError } from "./api";
import {
  T3_SNAPSHOT_UNAVAILABLE_MESSAGE,
  applyPendingThreadMutations,
  dedupeEnvironments,
  genericEnvironmentFailure,
  isT3SnapshotUnavailableError,
  normalizeThread,
  parseEnvironmentFailure,
  runWithConcurrency,
  selectWorkspacePrefetchIds,
  setBoundedCacheEntry,
} from "./controller";

const projects = [{ id: "project_1", title: "Next Coder" }];

test("does not resurrect a deleted thread from a stale T3 snapshot", () => {
  const staleThreads = [
    { id: "thread_deleted", title: "Old task", label: "Old task — Next Coder", projectId: "project_1" },
    { id: "thread_keep", title: "Current task", label: "Current task — Next Coder", projectId: "project_1" },
  ];
  const pending = new Map([["thread_deleted", { kind: "remove" as const }]]);

  const stale = applyPendingThreadMutations(staleThreads, projects, pending);
  expect(stale.threads.map((thread) => thread.id)).toEqual(["thread_keep"]);
  expect(stale.settledIds).toEqual([]);

  const caughtUp = applyPendingThreadMutations([staleThreads[1]], projects, pending);
  expect(caughtUp.threads.map((thread) => thread.id)).toEqual(["thread_keep"]);
  expect(caughtUp.settledIds).toEqual(["thread_deleted"]);
});

test("keeps an accepted rename until T3 reports the new title", () => {
  const staleThread = {
    id: "thread_1",
    title: "Old title",
    label: "Old title — Next Coder",
    projectId: "project_1",
  };
  const pending = new Map([["thread_1", { kind: "rename" as const, title: "New title" }]]);

  const stale = applyPendingThreadMutations([staleThread], projects, pending);
  expect(stale.threads[0]).toMatchObject({ title: "New title", label: "New title — Next Coder" });
  expect(stale.settledIds).toEqual([]);

  const caughtUp = applyPendingThreadMutations([
    { ...staleThread, title: "New title", label: "New title — Next Coder" },
  ], projects, pending);
  expect(caughtUp.settledIds).toEqual(["thread_1"]);
});

test("identifies only the T3 snapshot failure that needs recovery guidance", () => {
  expect(isT3SnapshotUnavailableError(
    new ApiError(502, T3_SNAPSHOT_UNAVAILABLE_MESSAGE),
  )).toBe(true);
  expect(isT3SnapshotUnavailableError(new ApiError(502, "T3 dispatch failed."))).toBe(false);
  expect(isT3SnapshotUnavailableError(new Error("Request failed with HTTP 500."))).toBe(false);
});

test("deduplicates repeated pairings while preserving the original environment identity", () => {
  const environments = dedupeEnvironments([
    {
      id: "env_duplicate",
      label: "Macbook Air T3 Code",
      baseUrl: "http://127.0.0.1:3773/",
      status: "paired",
      createdAt: "2026-08-08T17:39:00.000Z",
    },
    {
      id: "env_original",
      label: "Macbook Air T3 Code",
      baseUrl: "http://127.0.0.1:3773",
      status: "reachable",
      createdAt: "2026-07-24T12:00:00.000Z",
    },
  ]);

  expect(environments).toHaveLength(1);
  expect(environments[0]?.id).toBe("env_original");
});

test("keeps connector environments distinct without requiring a direct URL", () => {
  const environments = dedupeEnvironments([
    { id: "env_a", label: "Studio Mac", baseUrl: null, transportMode: "connector", connectorId: "con_a" },
    { id: "env_b", label: "Build Mac", baseUrl: null, transportMode: "connector", connectorId: "con_b" },
  ]);

  expect(environments.map((environment) => environment.id)).toEqual(["env_a", "env_b"]);
});

test("normalizes the messages that belong to a T3 thread", () => {
  const thread = normalizeThread({
    id: "thread_1",
    title: "Review branch",
    projectId: "project_1",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    messages: [
      { id: "message_1", role: "user", text: "Review this branch", createdAt: "2026-08-08T19:00:00.000Z" },
      { id: "message_2", role: "assistant", content: [{ type: "text", text: "The branch is ready." }] },
    ],
  }, [{ id: "project_1", title: "Tacs" }]);

  expect(thread?.label).toBe("Review branch — Tacs");
  expect(thread?.modelSelection).toEqual({ instanceId: "codex", model: "gpt-5.4" });
  expect(thread?.messages).toEqual([
    expect.objectContaining({ id: "message_1", role: "user", text: "Review this branch" }),
    expect.objectContaining({ id: "message_2", role: "assistant", text: "The branch is ready." }),
  ]);
});

test("reads the gateway failure envelope off a snapshot error", () => {
  const failure = parseEnvironmentFailure({
    cause: "fetch failed",
    reason: "token_expired",
    failure: {
      reason: "token_expired",
      message: "T3 access token has expired. Re-pair this environment.",
      retryable: false,
      baseUrl: "https://t3.example.test",
    },
  });

  expect(failure).toEqual({
    reason: "token_expired",
    message: "T3 access token has expired. Re-pair this environment.",
    retryable: false,
    baseUrl: "https://t3.example.test",
    installedVersion: null,
    minimumVersion: null,
    maximumTestedVersion: null,
  });
});

test("keeps the compatibility versions a contract failure carries", () => {
  const failure = parseEnvironmentFailure({
    failure: {
      reason: "contract_incompatible",
      message: "The T3 host does not expose the orchestration contract this gateway requires.",
      retryable: false,
      baseUrl: "https://t3.example.test",
      installedVersion: "0.0.19",
      minimumVersion: "0.0.24",
      maximumTestedVersion: "0.0.28",
    },
  });

  expect(failure?.installedVersion).toBe("0.0.19");
  expect(failure?.minimumVersion).toBe("0.0.24");
  expect(failure?.maximumTestedVersion).toBe("0.0.28");
});

test("refuses a reason the console does not model, so copy is never chosen from junk", () => {
  expect(parseEnvironmentFailure({ failure: { reason: "teapot", message: "no" } })).toBeNull();
  expect(parseEnvironmentFailure({ failure: { message: "no reason at all" } })).toBeNull();
  expect(parseEnvironmentFailure({ reason: "token_expired" })).toBeNull();
  expect(parseEnvironmentFailure(undefined)).toBeNull();
});

test("falls back to a generic retryable failure when nothing was classified", () => {
  expect(genericEnvironmentFailure()).toEqual({
    reason: "unknown",
    message: T3_SNAPSHOT_UNAVAILABLE_MESSAGE,
    retryable: true,
  });
});

test("caps background workspace prefetch concurrency", async () => {
  let active = 0;
  let peak = 0;
  const completed: string[] = [];

  await runWithConcurrency(["env_1", "env_2", "env_3", "env_4", "env_5"], 2, async (id) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    completed.push(id);
    active -= 1;
  });

  expect(peak).toBe(2);
  expect(completed).toHaveLength(5);
  expect(new Set(completed).size).toBe(5);
});

test("bounds speculative workspace reads independently of account size", () => {
  expect(selectWorkspacePrefetchIds([
    "env_1",
    "env_2",
    "env_2",
    "env_3",
    "env_4",
    "env_5",
  ], 3)).toEqual(["env_1", "env_2", "env_3"]);
  expect(selectWorkspacePrefetchIds(["env_1"], 0)).toEqual([]);
});

test("evicts least-recently-used workspace projections", () => {
  const cache = new Map<string, number>();
  setBoundedCacheEntry(cache, "env_1", 1, 2);
  setBoundedCacheEntry(cache, "env_2", 2, 2);
  setBoundedCacheEntry(cache, "env_1", 10, 2);
  setBoundedCacheEntry(cache, "env_3", 3, 2);

  expect([...cache.entries()]).toEqual([["env_1", 10], ["env_3", 3]]);
});
