/**
 * The order the operator has put their environments, folders and threads in.
 *
 * This is a **client preference, not gateway state**, and deliberately so. Environments are rows
 * the gateway owns, but projects and threads are a mirror of a paired T3 instance's snapshot — the
 * gateway has no authority over them and T3's orchestration HTTP API exposes no ordering to write
 * back to. Persisting only the third of the tree the gateway happens to own would make one branch
 * behave differently from the other two, so all three are kept here, together, in local storage.
 *
 * The consequence is honest and worth knowing: a reordering follows the browser, not the account.
 *
 * Every list is addressed by a **scope key** so one storage shape covers all three levels:
 *
 *   environments                  every environment on the account
 *   projects:<environmentId>      the folders inside one environment
 *   threads:<projectId>           the threads inside one folder
 *   threads:                      threads the snapshot reported without a folder
 */

import { useCallback, useMemo, useState } from "react";

const STORAGE_KEY = "nextCoderResourceOrder";

/** Scope key → the ids of that list, in the order the operator arranged them. */
export type ResourceOrder = Record<string, string[]>;

export const environmentScope = () => "environments";
export const projectScope = (environmentId: string) => `projects:${environmentId}`;
export const threadScope = (projectId: string | null | undefined) => `threads:${projectId ?? ""}`;

export function readResourceOrder(): ResourceOrder {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const order: ResourceOrder = {};
    for (const [scope, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(ids)) order[scope] = ids.filter((id): id is string => typeof id === "string");
    }
    return order;
  } catch {
    // A preference is never worth failing a render over.
    return {};
  }
}

export function writeResourceOrder(order: ResourceOrder): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Private browsing, a full quota — the session still works, it just will not remember.
  }
}

/**
 * Sort `items` by a saved arrangement.
 *
 * A saved id that no longer exists is ignored rather than reserving a gap, and an item the
 * arrangement has never seen — a thread created since — lands at the end in the order the source
 * gave it, rather than jumping to the top or being dropped. Nothing here can invent or lose an
 * item: the result is always a permutation of the input.
 */
export function applyResourceOrder<T>(
  items: readonly T[],
  getId: (item: T) => string,
  savedIds: readonly string[] | undefined,
): T[] {
  if (!savedIds?.length) return [...items];
  const rank = new Map(savedIds.map((id, index) => [id, index]));
  // `Array.prototype.sort` is stable, so items the arrangement does not know keep their relative
  // source order instead of being shuffled against each other.
  return [...items].sort((left, right) => {
    const leftRank = rank.get(getId(left));
    const rightRank = rank.get(getId(right));
    if (leftRank === undefined && rightRank === undefined) return 0;
    if (leftRank === undefined) return 1;
    if (rightRank === undefined) return -1;
    return leftRank - rightRank;
  });
}

/**
 * Move `sourceId` to where `targetId` sits.
 *
 * Direction decides which side it lands on, which is what makes a drag feel like it did what the
 * pointer said: dragging something downward puts it *after* the row it was dropped on, dragging it
 * upward puts it *before*. Returns the input unchanged when the move is a no-op or either id is
 * absent, so a caller can compare by identity to skip a write.
 */
export function moveResource(
  ids: readonly string[],
  sourceId: string,
  targetId: string,
): string[] {
  const sourceIndex = ids.indexOf(sourceId);
  const targetIndex = ids.indexOf(targetId);
  if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) return [...ids];
  const remaining = ids.filter((id) => id !== sourceId);
  const insertAt = remaining.indexOf(targetId) + (sourceIndex < targetIndex ? 1 : 0);
  remaining.splice(insertAt, 0, sourceId);
  return remaining;
}

/** Keyboard reordering: one step up or down, stopping at the ends rather than wrapping. */
export function nudgeResource(
  ids: readonly string[],
  id: string,
  delta: number,
): string[] {
  const index = ids.indexOf(id);
  if (index === -1) return [...ids];
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= ids.length) return [...ids];
  const next = [...ids];
  next.splice(index, 1);
  next.splice(nextIndex, 0, id);
  return next;
}

export interface ResourceOrdering {
  /** Sort one list by its saved arrangement. */
  order: <T>(scope: string, items: readonly T[], getId: (item: T) => string) => T[];
  /** Drop `sourceId` onto `targetId`. `ids` is the list as currently displayed. */
  reorder: (scope: string, ids: readonly string[], sourceId: string, targetId: string) => void;
  /** Move one row a single step. `delta` is -1 for up, 1 for down. */
  nudge: (scope: string, ids: readonly string[], id: string, delta: number) => void;
}

export function useResourceOrdering(): ResourceOrdering {
  const [savedOrder, setSavedOrder] = useState<ResourceOrder>(readResourceOrder);

  const order = useCallback(
    <T,>(scope: string, items: readonly T[], getId: (item: T) => string) =>
      applyResourceOrder(items, getId, savedOrder[scope]),
    [savedOrder],
  );

  // The whole displayed list is written, not just the moved id, so ids the arrangement had never
  // seen are pinned the moment the operator touches that list.
  const commit = useCallback((scope: string, nextIds: string[]) => {
    setSavedOrder((current) => {
      const next = { ...current, [scope]: nextIds };
      writeResourceOrder(next);
      return next;
    });
  }, []);

  const reorder = useCallback(
    (scope: string, ids: readonly string[], sourceId: string, targetId: string) => {
      const nextIds = moveResource(ids, sourceId, targetId);
      if (nextIds.every((id, index) => id === ids[index])) return;
      commit(scope, nextIds);
    },
    [commit],
  );

  const nudge = useCallback(
    (scope: string, ids: readonly string[], id: string, delta: number) => {
      const nextIds = nudgeResource(ids, id, delta);
      if (nextIds.every((entry, index) => entry === ids[index])) return;
      commit(scope, nextIds);
    },
    [commit],
  );

  return useMemo(() => ({ order, reorder, nudge }), [nudge, order, reorder]);
}
