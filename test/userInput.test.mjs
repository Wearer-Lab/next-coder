import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { buildT3Command, pendingThreadInteractions } from "../src/t3Client.mjs";
import { normalizeIntent } from "../src/intent.mjs";
import { capabilitiesForProfile } from "../src/profiles.mjs";
import { evaluateIntentPolicy } from "../src/policy.mjs";
import {
  collectUserInputRequests,
  deviceUserInputView,
  isDeviceAnswerableUserInput,
  isStaleUserInputRequestDetail,
  userInputAnswersFingerprint,
  validateUserInputAnswers,
} from "../src/userInput.mjs";

// ---------------------------------------------------------------------------------------------
// The contract, as a test rather than a comment.
// ---------------------------------------------------------------------------------------------

/** A single-choice question, T3's shape verbatim (providerRuntime.ts:450-459). */
function choiceQuestion(overrides = {}) {
  return {
    id: "Which database should I migrate?",
    header: "Database",
    question: "Which database should I migrate?",
    options: [
      { label: "staging", description: "The shared staging database" },
      { label: "production", description: "The live database" },
    ],
    multiSelect: false,
    ...overrides,
  };
}

function userInputRequested(requestId, questions, overrides = {}) {
  return {
    id: `act_${requestId}_req`,
    // NOT tone "approval" — ProviderRuntimeIngestion.ts:508 stamps these "info", which is one
    // reason an approval-shaped reader never saw them.
    tone: "info",
    kind: "user-input.requested",
    summary: "User input requested",
    payload: { requestId, questions },
    turnId: "turn_1",
    sequence: 1,
    createdAt: "2026-08-24T10:00:00.000Z",
    ...overrides,
  };
}

test("the three shapes are derived from options and multiSelect, never guessed", () => {
  const [request] = collectUserInputRequests({
    id: "thread_1",
    activities: [userInputRequested("req_1", [
      choiceQuestion(),
      choiceQuestion({ id: "q_multi", multiSelect: true }),
      // T3's contract makes `options` a required array with no minimum, so an empty one is
      // expressible and Claude produces it when the SDK supplies none (ClaudeAdapter.ts:3796).
      { id: "q_text", header: "Branch", question: "Name the branch", options: [] },
    ])],
  });

  assert.equal(request.kind, "question");
  assert.equal(request.status, "pending");
  assert.equal(request.threadId, "thread_1");
  assert.deepEqual(
    request.questions.map((question) => question.shape),
    ["single-choice", "multi-choice", "free-text"],
  );
  assert.equal(request.questions[0].options[0].label, "staging");
});

test("a resolution closes the request, and ordering is by sequence not array order", () => {
  const requests = collectUserInputRequests({
    id: "thread_1",
    activities: [
      {
        id: "act_2",
        kind: "user-input.resolved",
        summary: "User input submitted",
        payload: { requestId: "req_1", answers: { "Which database should I migrate?": "staging" } },
        sequence: 2,
        createdAt: "2026-08-24T10:00:01.000Z",
      },
      userInputRequested("req_1", [choiceQuestion()]),
    ],
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, "resolved");
  assert.equal(requests[0].answers["Which database should I migrate?"], "staging");
});

test("the four user-input stale phrases are not the approval phrases", () => {
  // src/orchestration/decider.ts:49-52, built by ProviderCommandReactor.ts:283-287.
  const stale = "Stale pending user-input request: req_1. Provider callback state does not survive "
    + "app restarts or recovered sessions. Restart the turn to continue.";
  assert.equal(isStaleUserInputRequestDetail(stale), true);
  assert.equal(isStaleUserInputRequestDetail("Unknown pending codex user input request: req_1"), true);
  // The approval wording must NOT match here, or the two matchers would be interchangeable and
  // the distinction T3 draws would be lost.
  assert.equal(isStaleUserInputRequestDetail("Stale pending approval request: req_1."), false);
  assert.equal(isStaleUserInputRequestDetail("No active provider session is bound to this thread."), false);
});

test("a stale respond-failure closes the request; any other failure leaves it open", () => {
  const failed = (detail) => collectUserInputRequests({
    id: "thread_1",
    activities: [
      userInputRequested("req_1", [choiceQuestion()]),
      {
        id: "act_fail",
        tone: "error",
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        payload: { requestId: "req_1", detail },
        sequence: 2,
        createdAt: "2026-08-24T10:00:02.000Z",
      },
    ],
  })[0];

  const stale = "Stale pending user-input request: req_1. Provider callback state does not survive "
    + "app restarts or recovered sessions. Restart the turn to continue.";
  assert.equal(failed(stale).status, "stale");
  // ProviderCommandReactor.ts:1262-1270 — the provider is still waiting, so it stays open.
  assert.equal(failed("No active provider session is bound to this thread.").status, "pending");
  assert.equal(failed("Connection reset by peer").failure, "Connection reset by peer");
});

test("a request with no requestId is skipped, because nothing could ever answer it", () => {
  // ProviderRuntimeIngestion.ts:511 makes requestId optional on the wire, and
  // ThreadUserInputRespondCommand requires one (orchestration.ts:830-837).
  assert.deepEqual(
    collectUserInputRequests({ id: "t", activities: [{ kind: "user-input.requested", payload: { questions: [] } }] }),
    [],
  );
  assert.deepEqual(collectUserInputRequests({ id: "thread_1" }), []);
  assert.deepEqual(collectUserInputRequests(null), []);
});

test("pendingThreadInteractions now agrees with the stale rule it used to ignore", () => {
  const thread = {
    id: "thread_1",
    activities: [
      userInputRequested("req_1", [choiceQuestion()]),
      {
        id: "act_stale",
        kind: "provider.user-input.respond.failed",
        payload: {
          requestId: "req_1",
          detail: "Stale pending user-input request: req_1. Provider callback state does not "
            + "survive app restarts or recovered sessions. Restart the turn to continue.",
        },
        sequence: 2,
        createdAt: "2026-08-24T10:00:02.000Z",
      },
    ],
  };
  // Before delegation this counted 1 forever and the screen said "1 answer waiting" for the rest
  // of the session.
  assert.deepEqual(pendingThreadInteractions(thread), { approvals: 0, userInput: 0 });
});

// ---------------------------------------------------------------------------------------------
// Validation — the whole point
// ---------------------------------------------------------------------------------------------

test("a single-choice question accepts an exact option label and nothing else", () => {
  const questions = collectUserInputRequests({
    id: "t", activities: [userInputRequested("r", [choiceQuestion()])],
  })[0].questions;
  const key = "Which database should I migrate?";

  const ok = validateUserInputAnswers(questions, { [key]: "staging" });
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.answers, { [key]: "staging" });

  // Free text where an enumeration was offered. The failure it prevents is silent on two of the
  // three providers, which is why it must be loud here.
  const freeText = validateUserInputAnswers(questions, { [key]: "the one in eu-west" });
  assert.equal(freeText.valid, false);
  assert.match(freeText.reason, /"staging", "production"/u);
  assert.equal(freeText.questionId, key);

  // Near misses are not near misses: consumers match on the exact label.
  assert.equal(validateUserInputAnswers(questions, { [key]: "Staging" }).valid, false);
  assert.equal(validateUserInputAnswers(questions, { [key]: ["staging"] }).valid, false);
});

test("a multi-choice question takes a non-empty, duplicate-free subset in option order", () => {
  const questions = collectUserInputRequests({
    id: "t",
    activities: [userInputRequested("r", [choiceQuestion({
      id: "q_multi",
      multiSelect: true,
      options: [
        { label: "lint", description: "eslint" },
        { label: "test", description: "vitest" },
        { label: "build", description: "tsc" },
      ],
    })])],
  })[0].questions;

  // Click order does not matter: the answer is a set, and two owners picking the same boxes must
  // produce the same fingerprint.
  const a = validateUserInputAnswers(questions, { q_multi: ["build", "lint"] });
  const b = validateUserInputAnswers(questions, { q_multi: ["lint", "build"] });
  assert.deepEqual(a.answers, { q_multi: ["lint", "build"] });
  assert.deepEqual(a.answers, b.answers);
  assert.equal(userInputAnswersFingerprint(a.answers), userInputAnswersFingerprint(b.answers));

  assert.equal(validateUserInputAnswers(questions, { q_multi: [] }).valid, false);
  assert.equal(validateUserInputAnswers(questions, { q_multi: ["lint", "lint"] }).valid, false);
  assert.equal(validateUserInputAnswers(questions, { q_multi: ["deploy"] }).valid, false);
  assert.equal(validateUserInputAnswers(questions, { q_multi: "lint" }).valid, false);
});

test("a free-text question takes a bounded non-empty string", () => {
  const questions = collectUserInputRequests({
    id: "t",
    activities: [userInputRequested("r", [
      { id: "q_text", header: "Branch", question: "Name the branch", options: [] },
    ])],
  })[0].questions;

  assert.deepEqual(
    validateUserInputAnswers(questions, { q_text: "feat/migrate" }).answers,
    { q_text: "feat/migrate" },
  );
  assert.equal(validateUserInputAnswers(questions, { q_text: "  " }).valid, false);
  assert.equal(validateUserInputAnswers(questions, { q_text: "x".repeat(4001) }).valid, false);
});

test("every question must be answered and nothing else may be", () => {
  const questions = collectUserInputRequests({
    id: "t",
    activities: [userInputRequested("r", [
      choiceQuestion(),
      { id: "q_text", header: "Branch", question: "Name the branch", options: [] },
    ])],
  })[0].questions;
  const key = "Which database should I migrate?";

  const missing = validateUserInputAnswers(questions, { [key]: "staging" });
  assert.equal(missing.valid, false);
  assert.match(missing.reason, /No answer supplied for question "q_text"/u);

  // A mistyped question id would otherwise drop the real answer silently.
  const extra = validateUserInputAnswers(questions, { [key]: "staging", q_text: "x", q_typo: "y" });
  assert.equal(extra.valid, false);
  assert.match(extra.reason, /"q_typo".*not a question on this request/u);
});

test("the fingerprint distinguishes a repeat from a different answer, and holds nothing readable", () => {
  const one = userInputAnswersFingerprint({ q: "staging" });
  assert.equal(one, userInputAnswersFingerprint({ q: "staging" }));
  assert.notEqual(one, userInputAnswersFingerprint({ q: "production" }));
  // Key order cannot make one answer look like two.
  assert.equal(
    userInputAnswersFingerprint({ a: "1", b: "2" }),
    userInputAnswersFingerprint({ b: "2", a: "1" }),
  );
  assert.match(one, /^[0-9a-f]{64}$/u);
});

// ---------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------

test("answering a question is its own capability, and read-only does not have it", () => {
  assert.equal(capabilitiesForProfile("next-coder").has("user_input_response"), true);
  assert.equal(capabilitiesForProfile("power-controller").has("user_input_response"), true);
  assert.equal(capabilitiesForProfile("read-only").has("user_input_response"), false);

  const decide = (profile) => evaluateIntentPolicy({
    device: { profile },
    intent: { type: "user_input_response", requestId: "req_1", answers: { q: "a" } },
  });
  assert.equal(decide("next-coder").allowed, true);
  // Not a permission grant and not an execution — the same baseline as agent_prompt.
  assert.equal(decide("next-coder").risk, "low");
  assert.equal(decide("next-coder").matchedRule, "baseline.user-input-response");
  assert.equal(decide("power-controller").allowed, true);
  assert.equal(decide("read-only").allowed, false);
});

test("the intent rejects an answer shape no T3 adapter accepts", async () => {
  const ok = await normalizeIntent({
    type: "user_input_response",
    requestId: "req_1",
    answers: { q: "a", r: ["b", "c"] },
  });
  assert.equal(ok.type, "user_input_response");

  const rejects = async (answers) => {
    await assert.rejects(
      () => normalizeIntent({ type: "user_input_response", requestId: "req_1", answers }),
      /answer/u,
    );
  };
  await rejects(undefined);
  await rejects([]);
  await rejects({});
  // The Codex-only `{answers: […]}` object form. Claude hands the record to its SDK verbatim and
  // would not understand it, so the gateway never emits or accepts it.
  await rejects({ q: { answers: ["a"] } });
  await rejects({ q: 3 });
});

test("the intent becomes T3's own thread.user-input.respond", () => {
  const command = buildT3Command({
    intent: { type: "user_input_response", requestId: "req_1", answers: { q: "staging" } },
    threadId: "thread_1",
  });
  assert.equal(command.type, "thread.user-input.respond");
  assert.equal(command.requestId, "req_1");
  assert.deepEqual(command.answers, { q: "staging" });
});

// ---------------------------------------------------------------------------------------------
// The device
// ---------------------------------------------------------------------------------------------

test("a controller may answer one short multiple-choice question, and nothing else", () => {
  const build = (questions) => collectUserInputRequests({
    id: "t", activities: [userInputRequested("r", questions)],
  })[0];

  assert.equal(isDeviceAnswerableUserInput(build([choiceQuestion()])), true);

  // No keyboard.
  assert.equal(
    isDeviceAnswerableUserInput(build([{ id: "q", header: "h", question: "q?", options: [] }])),
    false,
  );
  // Two arrow keys cannot build a subset.
  assert.equal(isDeviceAnswerableUserInput(build([choiceQuestion({ multiSelect: true })])), false);
  // A form is not a controller interaction.
  assert.equal(isDeviceAnswerableUserInput(build([choiceQuestion(), choiceQuestion({ id: "b" })])), false);
  // Too many options for five keys, and a label too long for one line.
  assert.equal(isDeviceAnswerableUserInput(build([choiceQuestion({
    options: ["a", "b", "c", "d", "e"].map((label) => ({ label, description: label })),
  })])), false);
  assert.equal(isDeviceAnswerableUserInput(build([choiceQuestion({
    options: [{ label: "x".repeat(25), description: "d" }, { label: "y", description: "d" }],
  })])), false);
});

test("an unanswerable question still reaches the device, with the sentence to put on screen", () => {
  const request = collectUserInputRequests({
    id: "thread_1",
    activities: [userInputRequested("req_1", [
      { id: "q_text", header: "Branch name", question: "What should I call the branch?", options: [] },
    ])],
  })[0];
  const view = deviceUserInputView(request);

  assert.equal(view.kind, "question");
  assert.equal(view.answerable, false);
  assert.equal(view.hint, "Answer this in the console.");
  assert.equal(view.title, "Branch name");
  assert.equal(view.prompt, "What should I call the branch?");
  // No buttons offered for something the device would have to refuse.
  assert.equal(view.options, null);
  assert.equal(view.questionId, null);
});

test("an answerable question carries its labels and the key the answer is filed under", () => {
  const request = collectUserInputRequests({
    id: "thread_1", activities: [userInputRequested("req_1", [choiceQuestion()])],
  })[0];
  const view = deviceUserInputView(request);
  assert.equal(view.answerable, true);
  assert.deepEqual(view.options, ["staging", "production"]);
  assert.equal(view.questionId, "Which database should I migrate?");
  assert.equal(view.hint, null);
});

// ---------------------------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------------------------

const THREAD_ID = "thread_live";

function stubT3({ activities }) {
  const dispatches = [];
  const state = { activities, dispatchStatus: 200 };
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse(
        state.dispatchStatus === 200 ? { sequence: 42 } : { error: "unavailable" },
        state.dispatchStatus,
      );
    }
    if (parsed.pathname === `/api/orchestration/threads/${THREAD_ID}`) {
      return jsonResponse({
        snapshotSequence: 7,
        thread: { id: THREAD_ID, activities: state.activities, messages: [], session: null },
      }, 200);
    }
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({
        snapshotSequence: 7,
        projects: [{ id: "project_1", title: "app" }],
        threads: [{ id: THREAD_ID, projectId: "project_1", title: "Live", session: null }],
        updatedAt: "2026-08-24T10:00:00.000Z",
      }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  return { dispatches, state };
}

async function harness(t, {
  activities = [userInputRequested("req_1", [choiceQuestion()])],
  profile = "next-coder",
} = {}) {
  const originalFetch = globalThis.fetch;
  const stub = stubT3({ activities });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = await createAuthHeaders(originalFetch, baseUrl);

  const environment = await requestJson(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });
  const environmentId = environment.environment.id;

  const created = await requestJson(originalFetch, baseUrl, "/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Controller", profile },
  });
  await requestJson(originalFetch, baseUrl, `/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: { environmentId, threadId: THREAD_ID, projectId: "project_1" },
  });

  const deviceHeaders = {
    "x-device-id": created.device.id,
    "x-device-secret": created.secret,
  };

  const call = (path, input) => requestJson(originalFetch, baseUrl, path, input);
  const raw = (path, input = {}) => originalFetch(new URL(path, baseUrl), {
    method: input.method ?? "GET",
    headers: { "content-type": "application/json", ...input.headers },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });

  return {
    ...stub,
    baseUrl,
    authHeaders,
    deviceHeaders,
    deviceId: created.device.id,
    environmentId,
    call,
    raw,
    path: `/v1/t3/environments/${environmentId}/threads/${THREAD_ID}/user-input`,
  };
}

const DB_KEY = "Which database should I migrate?";

test("a pending question surfaces to the owner with its own shape intact", async (t) => {
  const h = await harness(t);
  const listed = await h.call(h.path, { method: "GET", headers: h.authHeaders });

  assert.equal(listed.requests.length, 1);
  assert.equal(listed.requests[0].kind, "question");
  assert.equal(listed.requests[0].status, "pending");
  assert.equal(listed.requests[0].questions[0].shape, "single-choice");
  assert.deepEqual(
    listed.requests[0].questions[0].options.map((option) => option.label),
    ["staging", "production"],
  );
  assert.equal(listed.requests[0].localAnswer, null);
  assert.equal(listed.canAnswer, true);
});

test("each question shape round-trips to T3 as thread.user-input.respond", async (t) => {
  const cases = [
    {
      name: "single-choice",
      questions: [choiceQuestion()],
      answers: { [DB_KEY]: "staging" },
      expected: { [DB_KEY]: "staging" },
    },
    {
      name: "multi-choice",
      questions: [choiceQuestion({
        id: "q_multi",
        multiSelect: true,
        options: [
          { label: "lint", description: "eslint" },
          { label: "test", description: "vitest" },
        ],
      })],
      answers: { q_multi: ["test", "lint"] },
      expected: { q_multi: ["lint", "test"] },
    },
    {
      name: "free-text",
      questions: [{ id: "q_text", header: "Branch", question: "Name the branch", options: [] }],
      answers: { q_text: "feat/migrate" },
      expected: { q_text: "feat/migrate" },
    },
    {
      name: "several questions at once",
      questions: [
        choiceQuestion(),
        { id: "q_text", header: "Branch", question: "Name the branch", options: [] },
      ],
      answers: { [DB_KEY]: "production", q_text: "hotfix" },
      expected: { [DB_KEY]: "production", q_text: "hotfix" },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async (subtest) => {
      const h = await harness(subtest, {
        activities: [userInputRequested("req_1", testCase.questions)],
      });
      const answered = await h.call(`${h.path}/req_1`, {
        method: "POST",
        headers: h.authHeaders,
        body: { answers: testCase.answers },
      });

      assert.equal(answered.duplicate, false);
      assert.equal(answered.answer.status, "dispatched");
      assert.equal(answered.command.status, "dispatched");
      assert.equal(h.dispatches.length, 1);
      assert.equal(h.dispatches[0].type, "thread.user-input.respond");
      assert.equal(h.dispatches[0].requestId, "req_1");
      assert.deepEqual(h.dispatches[0].answers, testCase.expected);
    });
  }
});

test("a malformed answer is refused BEFORE dispatch, naming the options", async (t) => {
  const h = await harness(t);
  const response = await h.raw(`${h.path}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { answers: { [DB_KEY]: "the one in eu-west" } },
  });

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.match(body.error.message, /"staging", "production"/u);
  assert.equal(body.error.details.questionId, DB_KEY);
  // T3 would have accepted this dispatch and let the provider drop, relabel or fail on it —
  // asynchronously, as an error activity nobody is reading.
  assert.equal(h.dispatches.length, 0, "nothing may leave the gateway");
});

test("an answer to a question that is not on this request never reaches T3", async (t) => {
  const h = await harness(t);
  const response = await h.raw(`${h.path}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { answers: { "Which cloud?": "aws" } },
  });
  assert.equal(response.status, 422);
  assert.equal(h.dispatches.length, 0);
});

test("answering twice with the same answers is idempotent and dispatches once", async (t) => {
  const h = await harness(t);
  const body = { answers: { [DB_KEY]: "staging" } };
  const first = await h.call(`${h.path}/req_1`, { method: "POST", headers: h.authHeaders, body });
  const second = await h.call(`${h.path}/req_1`, { method: "POST", headers: h.authHeaders, body });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.command.id, first.command.id);
  assert.equal(second.answer.answersHash, first.answer.answersHash);
  assert.equal(h.dispatches.length, 1, "the provider must not be answered twice");
});

test("a second client answering differently is refused rather than overriding the first", async (t) => {
  const h = await harness(t);
  await h.call(`${h.path}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { answers: { [DB_KEY]: "staging" } },
  });
  const response = await h.raw(`${h.path}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { answers: { [DB_KEY]: "production" } },
  });

  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /already answered differently/u);
  assert.equal(h.dispatches.length, 1);
});

test("a question T3 has already resolved cannot be answered", async (t) => {
  const h = await harness(t, {
    activities: [
      userInputRequested("req_1", [choiceQuestion()]),
      {
        id: "act_resolved",
        kind: "user-input.resolved",
        summary: "User input submitted",
        payload: { requestId: "req_1", answers: { [DB_KEY]: "staging" } },
        sequence: 2,
        createdAt: "2026-08-24T10:00:05.000Z",
      },
    ],
  });
  const response = await h.raw(`${h.path}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { answers: { [DB_KEY]: "production" } },
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /already resolved/u);
  assert.equal(h.dispatches.length, 0);
});

test("a question T3 abandoned is refused before any dispatch", async (t) => {
  const h = await harness(t, {
    activities: [
      userInputRequested("req_1", [choiceQuestion()]),
      {
        id: "act_stale",
        tone: "error",
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        payload: {
          requestId: "req_1",
          detail: "Stale pending user-input request: req_1. Provider callback state does not "
            + "survive app restarts or recovered sessions. Restart the turn to continue.",
        },
        sequence: 2,
        createdAt: "2026-08-24T10:00:06.000Z",
      },
    ],
  });

  const listed = await h.call(h.path, { method: "GET", headers: h.authHeaders });
  assert.equal(listed.requests[0].status, "stale");

  const response = await h.raw(`${h.path}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { answers: { [DB_KEY]: "staging" } },
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /abandoned/u);
  assert.equal(h.dispatches.length, 0);
});

test("a failed dispatch releases the claim so the owner can retry", async (t) => {
  const h = await harness(t);
  h.state.dispatchStatus = 503;
  const failed = await h.raw(`${h.path}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { answers: { [DB_KEY]: "staging" } },
  });
  assert.equal(failed.status, 502);

  h.state.dispatchStatus = 200;
  const retried = await h.call(`${h.path}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { answers: { [DB_KEY]: "staging" } },
  });
  assert.equal(retried.duplicate, false, "a transient outage must not lock the question forever");
  assert.equal(retried.answer.status, "dispatched");
});

test("the answers are never persisted, and never reach a support bundle", async (t) => {
  const h = await harness(t, {
    activities: [userInputRequested("req_1", [
      { id: "q_text", header: "Branch", question: "Name the branch", options: [] },
    ])],
  });
  const answered = await h.call(`${h.path}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { answers: { q_text: "feat/secret-project-atlas" } },
  });

  // The dispatched command row records that a question was answered, and how many.
  assert.equal(answered.command.normalized.type, "thread.user-input.respond");
  assert.equal(answered.command.normalized.answers, undefined);
  assert.equal(answered.command.normalized.answerCount, 1);
  // The durable answer row holds a digest, not the words.
  assert.match(answered.answer.answersHash, /^[0-9a-f]{64}$/u);
  assert.equal(answered.answer.answers, undefined);

  const diagnostics = await h.call("/v1/support/diagnostics", {
    method: "GET",
    headers: h.authHeaders,
  });
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes("secret-project-atlas"), false);
  assert.equal(serialized.includes("Name the branch"), false);
});

// ---------------------------------------------------------------------------------------------
// The three blocking kinds, side by side
// ---------------------------------------------------------------------------------------------

test("the device poll keeps all three blocking kinds apart", async (t) => {
  const h = await harness(t, {
    activities: [
      userInputRequested("req_q", [choiceQuestion()]),
      {
        id: "act_approval",
        tone: "approval",
        kind: "approval.requested",
        summary: "Command approval requested",
        payload: {
          requestId: "req_a",
          requestKind: "command",
          requestType: "command_execution_approval",
          detail: "npm test",
        },
        turnId: "turn_1",
        sequence: 2,
        createdAt: "2026-08-24T10:00:01.000Z",
      },
    ],
  });

  const held = await h.call("/v1/device/intents", {
    method: "POST",
    headers: h.deviceHeaders,
    body: {
      environmentId: h.environmentId,
      threadId: THREAD_ID,
      intent: { type: "shell_input", command: "sudo rm -rf /" },
    },
  });
  assert.equal(held.command.status, "approval_required");

  const listed = await h.call("/v1/device/approvals", { method: "GET", headers: h.deviceHeaders });

  // Three questions, three keys, three id spaces, three answer routes. Never one list.
  assert.equal(listed.commands.length, 1);
  assert.equal(listed.commands[0].kind, "gateway");
  assert.equal(listed.providerApprovals.length, 1);
  assert.equal(listed.providerApprovals[0].kind, "provider");
  assert.equal(listed.providerApprovals[0].requestId, "req_a");
  assert.equal(listed.userInputRequests.length, 1);
  assert.equal(listed.userInputRequests[0].kind, "question");
  assert.equal(listed.userInputRequests[0].requestId, "req_q");
  assert.equal(listed.canAnswerUserInput, true);
  // A provider approval has decisions; a question has options. They are not the same field.
  assert.deepEqual(listed.allowedDecisions, ["accept", "decline", "cancel"]);
  assert.deepEqual(listed.userInputRequests[0].options, ["staging", "production"]);
});

test("a device answers a short multiple-choice question on its own route", async (t) => {
  const h = await harness(t);
  const answered = await h.call("/v1/device/user-input/req_1", {
    method: "POST",
    headers: h.deviceHeaders,
    body: { answers: { [DB_KEY]: "production" } },
  });

  assert.equal(answered.answer.actorType, "device");
  assert.equal(h.dispatches.length, 1);
  assert.equal(h.dispatches[0].type, "thread.user-input.respond");
  assert.deepEqual(h.dispatches[0].answers, { [DB_KEY]: "production" });

  // And it disappears from the device's own poll, without waiting for T3 to echo a resolution.
  const listed = await h.call("/v1/device/approvals", { method: "GET", headers: h.deviceHeaders });
  assert.deepEqual(listed.userInputRequests, []);
});

test("a device is shown a free-text question it cannot answer, and refused if it tries", async (t) => {
  const h = await harness(t, {
    activities: [userInputRequested("req_1", [
      { id: "q_text", header: "Branch", question: "What should I call the branch?", options: [] },
    ])],
  });

  const listed = await h.call("/v1/device/approvals", { method: "GET", headers: h.deviceHeaders });
  assert.equal(listed.userInputRequests.length, 1, "it must still be visible");
  assert.equal(listed.userInputRequests[0].answerable, false);
  assert.equal(listed.userInputRequests[0].hint, "Answer this in the console.");

  const refused = await h.raw("/v1/device/user-input/req_1", {
    method: "POST",
    headers: h.deviceHeaders,
    body: { answers: { q_text: "feat/x" } },
  });
  assert.equal(refused.status, 422);
  assert.match((await refused.json()).error.message, /Answer it in the console/u);
  assert.equal(h.dispatches.length, 0);

  // And the claim was never taken, so the console can still answer it.
  const answered = await h.call(`${h.path}/req_1`, {
    method: "POST",
    headers: h.authHeaders,
    body: { answers: { q_text: "feat/x" } },
  });
  assert.equal(answered.duplicate, false);
  assert.equal(h.dispatches.length, 1);
});

test("a read-only controller sees the question and is offered nothing", async (t) => {
  const h = await harness(t, { profile: "read-only" });
  const listed = await h.call("/v1/device/approvals", { method: "GET", headers: h.deviceHeaders });
  assert.equal(listed.userInputRequests.length, 1);
  assert.equal(listed.canAnswerUserInput, false);

  const refused = await h.raw("/v1/device/user-input/req_1", {
    method: "POST",
    headers: h.deviceHeaders,
    body: { answers: { [DB_KEY]: "staging" } },
  });
  assert.equal(refused.status, 403);
  assert.equal(h.dispatches.length, 0);
});

test("a revoked device is refused on the user-input route", async (t) => {
  const h = await harness(t);
  await h.call(`/v1/devices/${h.deviceId}/revoke`, {
    method: "POST",
    headers: h.authHeaders,
    body: {},
  });

  const response = await h.raw("/v1/device/user-input/req_1", {
    method: "POST",
    headers: h.deviceHeaders,
    body: { answers: { [DB_KEY]: "staging" } },
  });
  assert.ok(response.status === 401 || response.status === 403, `got ${response.status}`);
  assert.equal(h.dispatches.length, 0);
});

test("a device that cannot reach T3 still gets its gateway approvals", async (t) => {
  const h = await harness(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/api/orchestration/threads/")) throw new Error("T3 host asleep");
    return originalFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const listed = await h.call("/v1/device/approvals", { method: "GET", headers: h.deviceHeaders });
  assert.deepEqual(listed.userInputRequests, []);
  assert.match(listed.userInputError, /asleep/u);
  assert.ok(Array.isArray(listed.commands));
});

// ---------------------------------------------------------------------------------------------

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function requestJson(fetchImpl, baseUrl, path, input) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: input.method,
    headers: { "content-type": "application/json", ...input.headers },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(data)}`);
  }
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
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
