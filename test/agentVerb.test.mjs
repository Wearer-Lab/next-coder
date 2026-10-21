import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { AGENT_VERBS, classifyToolActivity, deriveAgentVerb, refineThreadStatus } from "../src/agentVerb.mjs";

// Payload shapes here are the ones T3 Code 0.0.32 actually puts on the wire, read from its
// own contract in /opt/homebrew/lib/node_modules/t3/dist/bin.mjs.map:
//
//   src/orchestration/Layers/ProviderRuntimeIngestion.ts builds every tool row as
//     { id, createdAt, tone: "tool", kind: "tool.updated"|"tool.completed"|"tool.started",
//       summary: <provider tool title>, payload: { itemType, status?, detail?, data? },
//       turnId, sequence? }
//   src/orchestration/ActivityPayloadProjection.ts then slims `payload.data` down to
//     { item?, command?, files: [{path}], toolCallId?, kind?, rawOutput? }
//   packages/contracts/src/providerRuntime.ts fixes the itemType vocabulary as
//     command_execution | file_change | mcp_tool_call | dynamic_tool_call |
//     collab_agent_tool_call | web_search | image_view

const TURN = "turn_9f2c";

function toolActivity(sequence, { itemType, summary, kind = "tool.completed", data, turnId = TURN }) {
  return {
    id: `evt_${sequence}`,
    tone: "tool",
    kind,
    summary,
    payload: { itemType, ...(data === undefined ? {} : { data }) },
    turnId,
    sequence,
    createdAt: new Date(Date.UTC(2026, 7, 24, 12, 0, sequence)).toISOString(),
  };
}

function runningThread(activities, overrides = {}) {
  return {
    id: "thread_verb",
    title: "Verb thread",
    latestTurn: { turnId: TURN, state: "running" },
    session: { status: "running", activeTurnId: TURN, lastError: null },
    activities,
    ...overrides,
  };
}

// --- classification -------------------------------------------------------

test("tool rows classify with T3's own five-way action vocabulary", () => {
  assert.equal(
    classifyToolActivity(toolActivity(1, { itemType: "command_execution", summary: "Terminal" })),
    "command",
  );
  assert.equal(
    classifyToolActivity(toolActivity(1, { itemType: "dynamic_tool_call", summary: "Read file", data: { kind: "read" } })),
    "read",
  );
  assert.equal(
    classifyToolActivity(toolActivity(1, { itemType: "web_search", summary: "Web search" })),
    "search",
  );
  assert.equal(
    classifyToolActivity(toolActivity(1, { itemType: "dynamic_tool_call", summary: "Grep" })),
    "search",
  );
  assert.equal(
    classifyToolActivity(toolActivity(1, { itemType: "file_change", summary: "Edit", data: { kind: "edit" } })),
    "file_change",
  );
  // An MCP call the gateway cannot name is honestly "other", not a guessed verb.
  assert.equal(
    classifyToolActivity(toolActivity(1, { itemType: "mcp_tool_call", summary: "linear.createIssue" })),
    "other",
  );
  // A completion's title may carry a "started"/"complete" suffix the update lacks.
  assert.equal(
    classifyToolActivity(toolActivity(1, { itemType: "dynamic_tool_call", summary: "Grep started", kind: "tool.started" })),
    "search",
  );
  // Non-tool rows never classify as a tool action.
  assert.equal(classifyToolActivity({ kind: "context-window.updated", summary: "Grep" }), "other");
});

// --- the four verbs -------------------------------------------------------

test("searching: the newest action in the live turn is a read or a search", () => {
  assert.equal(
    deriveAgentVerb(runningThread([
      toolActivity(1, { itemType: "command_execution", summary: "Terminal" }),
      toolActivity(2, { itemType: "dynamic_tool_call", summary: "Grep", data: { kind: "search" } }),
    ])),
    "searching",
  );
  assert.equal(
    deriveAgentVerb(runningThread([
      toolActivity(3, { itemType: "dynamic_tool_call", summary: "Read file", data: { kind: "read", files: [{ path: "src/app.mjs" }] } }),
    ])),
    "searching",
  );
  assert.equal(
    deriveAgentVerb(runningThread([toolActivity(1, { itemType: "web_search", summary: "Web search" })])),
    "searching",
  );
});

test("solving: a shell command in flight, or a plan being revised", () => {
  assert.equal(
    deriveAgentVerb(runningThread([
      toolActivity(1, { itemType: "file_change", summary: "Edit", data: { kind: "edit", files: [{ path: "a.mjs" }] } }),
      toolActivity(2, {
        itemType: "command_execution",
        summary: "Terminal",
        kind: "tool.updated",
        data: { item: { command: "npm test" } },
      }),
    ])),
    "solving",
  );
  assert.equal(
    deriveAgentVerb(runningThread([
      toolActivity(1, { itemType: "dynamic_tool_call", summary: "Grep", data: { kind: "search" } }),
      {
        id: "evt_plan",
        tone: "info",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        payload: { plan: [{ step: "Port the classifier", status: "in_progress" }] },
        turnId: TURN,
        sequence: 2,
        createdAt: "2026-08-24T12:00:02.000Z",
      },
    ])),
    "solving",
  );
});

test("weaving: an edit, once the turn has touched more than one file", () => {
  const activities = [
    toolActivity(1, { itemType: "file_change", summary: "Edit", data: { kind: "edit", files: [{ path: "src/app.mjs" }] } }),
    toolActivity(2, { itemType: "file_change", summary: "Edit", data: { kind: "edit", files: [{ path: "src/store.mjs" }] } }),
  ];
  assert.equal(deriveAgentVerb(runningThread(activities)), "weaving");
});

test("weaving is refused for a single-file edit — one file is not coordination", () => {
  const activities = [
    toolActivity(1, { itemType: "file_change", summary: "Edit", data: { kind: "edit", files: [{ path: "src/app.mjs" }] } }),
    toolActivity(2, { itemType: "file_change", summary: "Edit", data: { kind: "edit", files: [{ path: "src/app.mjs" }] } }),
  ];
  assert.equal(deriveAgentVerb(runningThread(activities)), null);
  assert.equal(refineThreadStatus("running", runningThread(activities)), "running");
});

test("shaping: a whole file written, or the tree restructured", () => {
  for (const kind of ["write", "move", "delete"]) {
    assert.equal(
      deriveAgentVerb(runningThread([
        toolActivity(1, { itemType: "file_change", summary: "Write", data: { kind, files: [{ path: "src/agentVerb.mjs" }] } }),
      ])),
      "shaping",
      `data.kind ${kind} should shape`,
    );
  }
});

// --- the refusals ---------------------------------------------------------

test("no verb is derived once the turn has settled", () => {
  const activities = [toolActivity(1, { itemType: "dynamic_tool_call", summary: "Grep", data: { kind: "search" } })];
  const settled = runningThread(activities, {
    latestTurn: { turnId: TURN, state: "completed" },
    session: { status: "stopped", activeTurnId: null },
  });
  assert.equal(deriveAgentVerb(settled), null);
});

test("activities from an earlier turn never speak for the live one", () => {
  const thread = runningThread([
    toolActivity(1, { itemType: "dynamic_tool_call", summary: "Grep", data: { kind: "search" }, turnId: "turn_previous" }),
  ]);
  assert.equal(deriveAgentVerb(thread), null);
});

test("an unattributable turn yields no verb", () => {
  const thread = runningThread([toolActivity(1, { itemType: "web_search", summary: "Web search" })], {
    latestTurn: { turnId: null, state: "running" },
    session: { status: "running", activeTurnId: null },
  });
  assert.equal(deriveAgentVerb(thread), null);
});

test("bookkeeping rows never shadow the newest real action", () => {
  const thread = runningThread([
    toolActivity(1, { itemType: "web_search", summary: "Web search" }),
    {
      id: "evt_ctx",
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: { usedTokens: 41_233 },
      turnId: TURN,
      sequence: 2,
      createdAt: "2026-08-24T12:00:02.000Z",
    },
  ]);
  assert.equal(deriveAgentVerb(thread), "searching");
});

test("a tool the gateway cannot name stays at running rather than inventing a verb", () => {
  const thread = runningThread([
    toolActivity(1, { itemType: "mcp_tool_call", summary: "linear.createIssue", data: { toolName: "createIssue" } }),
  ]);
  assert.equal(deriveAgentVerb(thread), null);
  assert.equal(refineThreadStatus("running", thread), "running");
});

test("the bodiless orchestration snapshot thread produces no verb at all", async () => {
  const { default: snapshot } = await import("./fixtures/t3-snapshot.json", { with: { type: "json" } });
  for (const thread of snapshot.threads) {
    assert.equal(deriveAgentVerb(thread), null);
  }
});

test("refinement only ever touches running", () => {
  const thread = runningThread([toolActivity(1, { itemType: "web_search", summary: "Web search" })]);
  for (const status of ["starting", "streaming", "completed", "error", "stopped", "idle"]) {
    assert.equal(refineThreadStatus(status, thread), status);
  }
  assert.equal(refineThreadStatus("running", thread), "searching");
  assert.ok(AGENT_VERBS.includes("searching"));
});

// --- the device route -----------------------------------------------------

async function verbRouteFixture(t, { snapshotThreads, threadDetail, detailStatus = 200 }) {
  const originalFetch = globalThis.fetch;
  const detailRequests = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({ projects: [{ id: "p1" }], threads: snapshotThreads }, 200);
    }
    if (parsed.pathname.startsWith("/api/orchestration/threads/")) {
      detailRequests.push({ pathname: parsed.pathname, turnLimit: parsed.searchParams.get("turnLimit") });
      if (detailStatus !== 200) return jsonResponse({ error: "not found" }, detailStatus);
      return jsonResponse({ snapshotSequence: 12, thread: threadDetail }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Orb controller", profile: "next-coder" },
  });
  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Bound T3", baseUrl: "https://bound-t3.example", accessToken: "tok" },
  });
  await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: { environmentId: environment.environment.id, threadId: "thread_live" },
  });

  return {
    detailRequests,
    list: () => requestJson(originalFetch, baseUrl, "/v1/device/threads", {
      headers: { "x-device-id": created.device.id, "x-device-secret": created.secret },
    }),
  };
}

const LIVE_SNAPSHOT_THREADS = [
  { id: "thread_live", title: "Live", session: { status: "running", activeTurnId: TURN }, latestTurn: { turnId: TURN, state: "running" } },
  { id: "thread_other", title: "Other", session: { status: "running" }, latestTurn: { turnId: "turn_x", state: "running" } },
];

test("the device thread list publishes the verb for the selected running thread", async (t) => {
  const f = await verbRouteFixture(t, {
    snapshotThreads: LIVE_SNAPSHOT_THREADS,
    threadDetail: {
      id: "thread_live",
      latestTurn: { turnId: TURN, state: "running" },
      session: { status: "running", activeTurnId: TURN },
      activities: [
        toolActivity(1, { itemType: "file_change", summary: "Edit", data: { kind: "edit", files: [{ path: "src/app.mjs" }] } }),
        toolActivity(2, { itemType: "file_change", summary: "Edit", data: { kind: "edit", files: [{ path: "src/store.mjs" }] } }),
      ],
    },
  });

  const listed = await f.list();
  assert.deepEqual(listed.threads, [
    { id: "thread_live", title: "Live", status: "weaving", selected: true },
    // Unselected rows are untouched: the orb reads one row, so the rest cost nothing.
    { id: "thread_other", title: "Other", status: "running", selected: false },
  ]);
  assert.deepEqual(f.detailRequests, [
    { pathname: "/api/orchestration/threads/thread_live", turnLimit: "1" },
  ]);
});

test("a T3 without the hydrated thread route leaves the existing five words intact", async (t) => {
  const f = await verbRouteFixture(t, {
    snapshotThreads: LIVE_SNAPSHOT_THREADS,
    threadDetail: null,
    detailStatus: 404,
  });

  const listed = await f.list();
  assert.deepEqual(listed.threads, [
    { id: "thread_live", title: "Live", status: "running", selected: true },
    { id: "thread_other", title: "Other", status: "running", selected: false },
  ]);
});

test("a settled selected thread is never hydrated and never refined", async (t) => {
  const f = await verbRouteFixture(t, {
    snapshotThreads: [
      { id: "thread_live", title: "Live", session: { status: "stopped" }, latestTurn: { turnId: TURN, state: "completed" } },
    ],
    threadDetail: null,
  });

  const listed = await f.list();
  assert.deepEqual(listed.threads, [
    { id: "thread_live", title: "Live", status: "completed", selected: true },
  ]);
  assert.deepEqual(f.detailRequests, []);
});

// --- helpers (mirrors test/app.test.mjs) ----------------------------------

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function requestJson(fetchImpl, baseUrl, path, input = {}) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: input.method,
    headers: { "content-type": "application/json", ...input.headers },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function createAuthHeaders(fetchImpl, baseUrl) {
  const created = await requestJson(fetchImpl, baseUrl, "/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_dev", email: "dev@example.local" },
  });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
