import { describe, expect, test } from "vitest";

import {
  applyThreadEvent,
  applyThreadSnapshot,
  createLiveThreadState,
} from "./liveThread";
import {
  PROVIDER_APPROVAL_DECISION_CATALOGUE,
  collectProviderApprovals,
  foldApprovalActivity,
  isProviderApprovalDecision,
  isStaleProviderRequestDetail,
  mergeProviderApprovalDecisions,
  offeredProviderApprovalDecisions,
  pendingProviderApprovals,
  providerApprovalTitle,
} from "./providerApprovals";

const TARGET = { environmentId: "env_1", threadId: "thread_1" };

function requested(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `act_${requestId}`,
    tone: "approval",
    kind: "approval.requested",
    summary: "File-change approval requested",
    payload: {
      requestId,
      requestKind: "file-change",
      requestType: "file_change_approval",
      detail: "src/app.mjs",
    },
    turnId: "turn_1",
    sequence: 1,
    createdAt: "2026-08-24T12:00:00.000Z",
    ...overrides,
  };
}

function snapshotPayload(activities: unknown[]) {
  return {
    ...TARGET,
    reset: true,
    gap: false,
    snapshotSequence: 100,
    page: null,
    thread: { id: "thread_1", messages: [], activities, session: null },
  };
}

function activityEvent(sequence: number, activity: unknown) {
  return {
    ...TARGET,
    sequence,
    eventId: `evt_${sequence}`,
    type: "thread.activity-appended",
    occurredAt: "2026-08-24T12:00:01.000Z",
    event: {
      sequence,
      eventId: `evt_${sequence}`,
      type: "thread.activity-appended",
      occurredAt: "2026-08-24T12:00:01.000Z",
      payload: { threadId: "thread_1", activity },
    },
  };
}

describe("the decision vocabulary", () => {
  test("offers T3's five decisions in catalogue order, two of which leave a standing grant", () => {
    expect(PROVIDER_APPROVAL_DECISION_CATALOGUE.map((entry) => entry.decision)).toEqual([
      "accept",
      "acceptForSession",
      "acceptAlways",
      "decline",
      "cancel",
    ]);
    expect(
      PROVIDER_APPROVAL_DECISION_CATALOGUE.filter((entry) => entry.persistent)
        .map((entry) => entry.decision),
    ).toEqual(["acceptForSession", "acceptAlways"]);
    expect(isProviderApprovalDecision("acceptForSession")).toBe(true);
    expect(isProviderApprovalDecision("acceptAlways")).toBe(true);
    expect(isProviderApprovalDecision("approve")).toBe(false);
  });

  test("only acceptAlways is withheld from the default offered set", () => {
    expect(
      PROVIDER_APPROVAL_DECISION_CATALOGUE.filter((entry) => !entry.offeredByDefault)
        .map((entry) => entry.decision),
    ).toEqual(["acceptAlways"]);
  });

  test("only offers what the gateway said this actor may give", () => {
    // A controller: allow-always is withheld, the other three stand.
    expect(
      offeredProviderApprovalDecisions(["accept", "decline", "cancel"]).map((entry) => entry.decision),
    ).toEqual(["accept", "decline", "cancel"]);
    // A read-only actor: an empty list is a real answer, not a loading state.
    expect(offeredProviderApprovalDecisions([])).toEqual([]);
  });

  test("with nothing stated, offers T3's default four and never acceptAlways", () => {
    const defaults = offeredProviderApprovalDecisions(undefined).map((entry) => entry.decision);
    expect(defaults).toEqual(["accept", "acceptForSession", "decline", "cancel"]);
    expect(defaults).not.toContain("acceptAlways");
    expect(offeredProviderApprovalDecisions(null).map((entry) => entry.decision)).toEqual(defaults);
  });

  test("a request that lists acceptAlways gets it offered, in catalogue order", () => {
    expect(
      offeredProviderApprovalDecisions(["cancel", "acceptAlways", "accept"]).map((entry) => entry.decision),
    ).toEqual(["accept", "acceptAlways", "cancel"]);
  });
});

describe("deriving approvals from the live stream", () => {
  test("a snapshot carries the pending approval, with the requestId needed to answer it", () => {
    const state = applyThreadSnapshot(createLiveThreadState(TARGET), snapshotPayload([requested("req_1")]));
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0].requestId).toBe("req_1");
    expect(state.approvals[0].status).toBe("pending");
    expect(state.approvals[0].detail).toBe("src/app.mjs");
    expect(providerApprovalTitle(state.approvals[0])).toBe("Change a file");
  });

  test("an approval arriving live is picked up from the activity event", () => {
    let state = applyThreadSnapshot(createLiveThreadState(TARGET), snapshotPayload([]));
    expect(state.approvals).toEqual([]);
    state = applyThreadEvent(state, activityEvent(101, requested("req_live")));
    expect(pendingProviderApprovals(state.approvals).map((entry) => entry.requestId))
      .toEqual(["req_live"]);
    // The row is still in the transcript too — the approval card and the work log are both true.
    expect(state.entries.some((entry) => entry.kind === "activity" && entry.tone === "approval"))
      .toBe(true);
  });

  test("a resolution closes it, so the card stops being offered", () => {
    let state = applyThreadSnapshot(createLiveThreadState(TARGET), snapshotPayload([requested("req_1")]));
    state = applyThreadEvent(state, activityEvent(101, {
      id: "act_resolved",
      tone: "approval",
      kind: "approval.resolved",
      summary: "Approval resolved",
      payload: { requestId: "req_1", decision: "accept" },
      turnId: "turn_1",
      createdAt: "2026-08-24T12:00:02.000Z",
    }));
    expect(pendingProviderApprovals(state.approvals)).toEqual([]);
    expect(state.approvals[0].status).toBe("resolved");
  });

  test("a stale failure closes it; any other failure leaves the agent still waiting", () => {
    const stale = "Stale pending approval request: req_1. Provider callback state does not survive "
      + "app restarts or recovered sessions. Restart the turn to continue.";
    expect(isStaleProviderRequestDetail(stale)).toBe(true);
    expect(isStaleProviderRequestDetail("socket hang up")).toBe(false);

    const after = (detail: string) => {
      let state = applyThreadSnapshot(createLiveThreadState(TARGET), snapshotPayload([requested("req_1")]));
      state = applyThreadEvent(state, activityEvent(101, {
        id: "act_failed",
        tone: "error",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        payload: { requestId: "req_1", detail },
        turnId: null,
        createdAt: "2026-08-24T12:00:03.000Z",
      }));
      return state.approvals[0];
    };

    expect(after(stale).status).toBe("stale");
    expect(after("socket hang up").status).toBe("pending");
    expect(after("socket hang up").failure).toBe("socket hang up");
  });

  test("a snapshot replaces the approval list rather than appending to it", () => {
    let state = applyThreadSnapshot(createLiveThreadState(TARGET), snapshotPayload([requested("req_old")]));
    state = applyThreadSnapshot(state, snapshotPayload([requested("req_new")]));
    expect(state.approvals.map((entry) => entry.requestId)).toEqual(["req_new"]);
  });

  test("a duplicate event does not duplicate the approval", () => {
    let state = applyThreadSnapshot(createLiveThreadState(TARGET), snapshotPayload([]));
    state = applyThreadEvent(state, activityEvent(101, requested("req_1")));
    state = applyThreadEvent(state, activityEvent(101, requested("req_1")));
    expect(state.approvals).toHaveLength(1);
  });

  test("collectProviderApprovals orders by sequence, not array order", () => {
    const approvals = collectProviderApprovals({
      activities: [
        {
          id: "act_resolved",
          kind: "approval.resolved",
          payload: { requestId: "req_1", decision: "decline" },
          sequence: 2,
          createdAt: "2026-08-24T12:00:02.000Z",
        },
        requested("req_1"),
      ],
    }, "thread_1");
    expect(approvals[0].status).toBe("resolved");
    expect(approvals[0].decision).toBe("decline");
  });
});

test("a decision this account already made is folded onto the approval", () => {
  const approvals = collectProviderApprovals({ activities: [requested("req_1")] }, "thread_1");
  const merged = mergeProviderApprovalDecisions(approvals, [{
    requestId: "req_1",
    decision: "accept",
    status: "dispatched",
    actorType: "device",
    commandId: "cmd_1",
    error: null,
    decidedAt: "2026-08-24T12:00:04.000Z",
  }]);
  expect(merged[0].localDecision?.decision).toBe("accept");
  // Still "pending" as far as T3 is concerned — the provider has not acted on it yet. The two
  // facts are separate on purpose, and the console suppresses the buttons on the local one.
  expect(merged[0].status).toBe("pending");
});

describe("the decisions a request states", () => {
  const ALL_FOUR = ["accept", "acceptForSession", "decline", "cancel"];
  const derive = (activity: unknown) =>
    collectProviderApprovals({ activities: [activity] }, "thread_1")[0];

  test("absent from the payload, the request has no set of its own, not an empty one", () => {
    expect(derive(requested("req_1")).allowedDecisions).toBeUndefined();
  });

  test("a payload that is not an array is treated the same as absent", () => {
    expect(derive(requested("req_1", { payload: { requestId: "req_1", decisions: "accept" } }))
      .allowedDecisions).toBeUndefined();
    expect(derive(requested("req_1", { payload: { requestId: "req_1", decisions: { accept: true } } }))
      .allowedDecisions).toBeUndefined();
    expect(derive(requested("req_1", { payload: { requestId: "req_1", decisions: null } }))
      .allowedDecisions).toBeUndefined();
  });

  test("an array keeps only recognised decisions, de-duplicated, in catalogue order", () => {
    const approval = derive(requested("req_1", {
      payload: { requestId: "req_1", decisions: ["decline", "accept", "bogus", "decline", 42] },
    }));
    expect(approval.allowedDecisions).toEqual(["accept", "decline"]);
  });

  test("the gateway's legacy names and surrounding whitespace are read as the decisions they mean", () => {
    const approval = derive(requested("req_1", {
      payload: { requestId: "req_1", decisions: [" approve ", "reject"] },
    }));
    expect(approval.allowedDecisions).toEqual(["accept", "decline"]);
  });

  test("a list naming only unrecognised decisions is empty, not absent, so it cannot widen to four", () => {
    const approval = derive(requested("req_1", {
      payload: { requestId: "req_1", decisions: ["teleport", "constructor", "toString"] },
    }));
    expect(approval.allowedDecisions).toEqual([]);
    expect(approval.allowedDecisions).not.toBeUndefined();
  });

  test("an explicitly empty list is also empty, not absent", () => {
    expect(derive(requested("req_1", { payload: { requestId: "req_1", decisions: [] } }))
      .allowedDecisions).toEqual([]);
  });

  test("the derivation does not intersect with capabilities; the card owns that", () => {
    const approval = derive(requested("req_1", {
      payload: { requestId: "req_1", decisions: ALL_FOUR },
    }));
    expect(approval.allowedDecisions).toEqual(ALL_FOUR);
  });

  test("an unrelated activity kind does not produce the field, or an approval at all", () => {
    const toolRow = {
      id: "act_tool",
      tone: "tool",
      kind: "tool.started",
      summary: "Tool started",
      payload: { requestId: "req_1", decisions: ["accept"] },
      turnId: "turn_1",
      sequence: 1,
      createdAt: "2026-08-24T12:00:00.000Z",
    };
    expect(foldApprovalActivity([], toolRow, "thread_1")).toEqual([]);
  });

  test("a resolution carrying its own decisions does not rewrite the request's set", () => {
    const approvals = collectProviderApprovals({
      activities: [
        requested("req_1", { payload: { requestId: "req_1", decisions: ["accept", "decline"] } }),
        {
          id: "act_resolved",
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: { requestId: "req_1", decision: "accept", decisions: ["cancel"] },
          turnId: "turn_1",
          sequence: 2,
          createdAt: "2026-08-24T12:00:02.000Z",
        },
      ],
    }, "thread_1");
    expect(approvals[0].status).toBe("resolved");
    expect(approvals[0].allowedDecisions).toEqual(["accept", "decline"]);
  });

  test("a repeated approval.requested for the same id replaces the decision list", () => {
    const first = requested("req_1", { payload: { requestId: "req_1", decisions: ALL_FOUR } });
    const asked = requested("req_1", {
      id: "act_req_1_again",
      sequence: 2,
      payload: { requestId: "req_1", decisions: ["decline"] },
    });
    const approvals = collectProviderApprovals({ activities: [first, asked] }, "thread_1");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe("pending");
    expect(approvals[0].allowedDecisions).toEqual(["decline"]);
  });

  test("a set arriving live on the activity event reaches the approval, not just a snapshot", () => {
    let state = applyThreadSnapshot(createLiveThreadState(TARGET), snapshotPayload([]));
    state = applyThreadEvent(state, activityEvent(101, requested("req_live", {
      payload: { requestId: "req_live", decisions: ["cancel"] },
    })));
    expect(pendingProviderApprovals(state.approvals)[0].allowedDecisions).toEqual(["cancel"]);
  });

  test("a repeated request that states no set drops the earlier one rather than keeping it", () => {
    const first = requested("req_1", { payload: { requestId: "req_1", decisions: ["accept"] } });
    const asked = requested("req_1", { id: "act_req_1_again", sequence: 2 });
    const approvals = collectProviderApprovals({ activities: [first, asked] }, "thread_1");
    expect(approvals[0].allowedDecisions).toBeUndefined();
  });
});

describe("acceptAlways and the offered set", () => {
  const derive = (activity: unknown) =>
    collectProviderApprovals({ activities: [activity] }, "thread_1")[0];
  const offered = (approval: { allowedDecisions?: readonly string[] }) =>
    offeredProviderApprovalDecisions(approval.allowedDecisions).map((entry) => entry.decision);

  test("acceptAlways survives normalization when the request lists it", () => {
    const approval = derive(requested("req_1", {
      payload: { requestId: "req_1", decisions: ["decline", "acceptAlways", "accept"] },
    }));
    expect(approval.allowedDecisions).toEqual(["accept", "acceptAlways", "decline"]);
    expect(offered(approval)).toEqual(["accept", "acceptAlways", "decline"]);
  });

  test("a request that states no set is offered T3's default four, never acceptAlways", () => {
    expect(offered(derive(requested("req_1")))).toEqual(["accept", "acceptForSession", "decline", "cancel"]);
  });

  test("a request naming only unrecognised decisions offers nothing, rather than the default four", () => {
    const approval = derive(requested("req_1", {
      payload: { requestId: "req_1", decisions: ["teleport"] },
    }));
    expect(offered(approval)).toEqual([]);
  });
});

describe("request kinds", () => {
  const derive = (requestKind: unknown) =>
    collectProviderApprovals({
      activities: [requested("req_1", { payload: { requestId: "req_1", requestKind, detail: "x" } })],
    }, "thread_1")[0];

  test("the two newer kinds are kept and render their labels", () => {
    const connected = derive("mcp-elicitation");
    expect(connected.requestKind).toBe("mcp-elicitation");
    expect(providerApprovalTitle(connected)).toBe("Approve a connected tool");

    const permission = derive("permission");
    expect(permission.requestKind).toBe("permission");
    expect(providerApprovalTitle(permission)).toBe("Grant a permission");
  });

  test("an unrecognised kind is not carried as one, and titles from the summary instead", () => {
    const unknown = derive("teleport");
    expect(unknown.requestKind).toBeNull();
    expect(providerApprovalTitle(unknown)).toBe("File-change approval requested");
  });
});
