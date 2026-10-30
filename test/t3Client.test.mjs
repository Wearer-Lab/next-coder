import assert from "node:assert/strict";
import test from "node:test";

import {
  buildT3Command,
  buildT3ProjectLaunchCommands,
  compressSnapshot,
  fetchT3Snapshot,
  pendingThreadInteractions,
} from "../src/t3Client.mjs";

test("agent prompts map to T3 turn start commands with approval-required runtime", () => {
  const command = buildT3Command({
    threadId: "thread_123",
    intent: { type: "agent_prompt", text: "Continue the implementation." },
  });

  assert.equal(command.type, "thread.turn.start");
  assert.equal(command.threadId, "thread_123");
  assert.equal(command.runtimeMode, "approval-required");
  assert.equal(command.interactionMode, "default");
  assert.equal(command.message.text, "Continue the implementation.");
});

test("approval responses map to T3 approval commands", () => {
  const command = buildT3Command({
    threadId: "thread_123",
    intent: { type: "approval_response", requestId: "approval_1", decision: "approve" },
  });

  assert.equal(command.type, "thread.approval.respond");
  assert.equal(command.requestId, "approval_1");
  assert.equal(command.decision, "accept");
});

test("selected thread status preserves T3 session and pending interaction state", () => {
  const thread = {
    id: "thread_123",
    title: "Implement the device session controls with a very long title",
    interactionMode: "default",
    latestTurn: { state: "running" },
    session: { status: "running", runtimeMode: "approval-required" },
    activities: [
      { sequence: 1, kind: "approval.requested", payload: { requestId: "approval_1" } },
      { sequence: 2, kind: "user-input.requested", payload: { requestId: "input_1" } },
      { sequence: 3, kind: "user-input.resolved", payload: { requestId: "input_1" } },
    ],
  };
  assert.deepEqual(pendingThreadInteractions(thread), { approvals: 1, userInput: 0 });
  const screen = compressSnapshot({ projects: [{}], threads: [thread] }, thread.id);
  assert.equal(screen.state, "running");
  assert.equal(screen.line2, "1 approval waiting");
  assert.equal(screen.thread.id, thread.id);
  assert.equal(screen.thread.pendingApprovals, 1);
  assert.ok(screen.line1.length <= 28);
});

test("project launch builds a T3 bootstrap turn using the selected harness", () => {
  const launch = buildT3ProjectLaunchCommands({
    project: {
      id: "project_123",
      defaultModelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5" },
    },
    text: "Inspect this project and report its current state.",
    threadId: "thread_123",
  });

  assert.equal(launch.createThread.type, "thread.create");
  assert.equal(launch.startTurn.type, "thread.turn.start");
  assert.equal(launch.threadId, "thread_123");
  assert.deepEqual(launch.startTurn.modelSelection, {
    instanceId: "claudeAgent",
    model: "claude-sonnet-5",
  });
  assert.equal(launch.createThread.projectId, "project_123");
  assert.equal(launch.createThread.runtimeMode, "approval-required");
  assert.equal(launch.startTurn.message.text, "Inspect this project and report its current state.");
  assert.deepEqual(launch.startTurn.message.attachments, []);
});

test("a project launch puts attachments on the bootstrap turn, not the thread creation", () => {
  const attachments = [{ type: "image", mediaId: "media_1", contentType: "image/png" }];
  const launch = buildT3ProjectLaunchCommands({
    project: {
      id: "project_123",
      defaultModelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5" },
    },
    text: "Explain this screenshot.",
    threadId: "thread_123",
    attachments,
  });

  assert.deepEqual(launch.startTurn.message.attachments, attachments);
  assert.equal(launch.createThread.message, undefined);
});

// --- Protocol 1 reached against a protocol 2 server -------------------------------------------
//
// Observed against the running T3 0.1.1 on 2026-10-30, not assumed: the removed snapshot route
// answers 200 with the single-page application, while the dispatch route answers 404. A 200 of
// HTML passes `response.ok`, so the only symptom used to be a JSON parse error naming neither the
// version nor the protocol.

test("a web page on the snapshot route is refused as a protocol mismatch, not parsed", async () => {
  const fetchImpl = async () => new Response(
    "<!doctype html><html lang=\"en\"><head><title>T3</title></head></html>",
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
  await assert.rejects(
    () => fetchT3Snapshot({ baseUrl: "http://127.0.0.1:3774", accessToken: "token" }, { fetchImpl }),
    (error) => {
      assert.equal(error.code, "T3_PROTOCOL_MISMATCH");
      // The message has to name the cause: this is the error an operator reads first.
      assert.match(error.message, /protocol 2/u);
      assert.match(error.message, /0\.1\.0 or newer/u);
      return true;
    },
  );
});

test("a genuine protocol 1 JSON snapshot is still parsed", async () => {
  const snapshot = { snapshotSequence: 7, projects: [], threads: [], updatedAt: "2026-10-30T00:00:00.000Z" };
  const fetchImpl = async () => new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  assert.deepEqual(
    await fetchT3Snapshot({ baseUrl: "http://127.0.0.1:3773", accessToken: "token" }, { fetchImpl }),
    snapshot,
  );
});

test("JSON under an unusual content type is still parsed, so older servers keep working", async () => {
  // Only HTML is refused. A stricter "must be JSON" rule would break a 0.0.x server or proxy that
  // labels its body oddly, to catch a case that cannot arise there.
  const fetchImpl = async () => new Response(JSON.stringify({ projects: [], threads: [] }), {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
  const result = await fetchT3Snapshot({ baseUrl: "http://127.0.0.1:3773", accessToken: "token" }, { fetchImpl });
  assert.deepEqual(result.threads, []);
});
