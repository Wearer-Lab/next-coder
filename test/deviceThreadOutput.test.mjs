import assert from "node:assert/strict";
import test from "node:test";

import {
  appendDeviceFollowUpInstruction,
  buildDeviceFollowUpInstruction,
  buildDeviceThreadOutput,
  extractFollowUpIds,
  stripFollowUpMarkers,
  wrapResponseText,
  stableVisibleText,
  DEVICE_RESPONSE_STREAM_CHUNK,
} from "../src/deviceThreadOutput.mjs";

const controls = [
  { actionId: "action_continue", label: "Continue task", kind: "remote_action", enabled: true, requiresConfirmation: true },
  { actionId: "action_test", label: "Run tests", kind: "remote_action", enabled: true, requiresConfirmation: true },
  { actionId: "action_locked", label: "Locked", kind: "remote_action", enabled: false },
  { actionId: "system_stop", label: "Stop", kind: "stop", enabled: true },
];

test("device follow-up instructions expose only eligible opaque action ids", () => {
  const instruction = buildDeviceFollowUpInstruction(controls, "action_continue");
  assert.match(instruction, /action_test/u);
  assert.doesNotMatch(instruction, /action_continue/u);
  assert.doesNotMatch(instruction, /action_locked|system_stop/u);
  assert.match(appendDeviceFollowUpInstruction("Run it", instruction), /^Run it\n\n<!--/u);
});

test("response output pages text and validates at most two suggested assigned actions", () => {
  const thread = {
    id: "thread_1",
    title: "Device work",
    messages: [{
      id: "message_1",
      role: "assistant",
      createdAt: "2026-08-08T20:00:00.000Z",
      text: "Implemented the response reader and verified the firmware build. More details follow here.\n<!--AC_FOLLOWUPS:[\"action_test\",\"invented\",\"action_continue\",\"action_test\"]-->",
    }],
  };
  const output = buildDeviceThreadOutput({ thread, controls, page: 1 });
  assert.equal(output.response.messageId, "message_1");
  assert.equal(output.response.page, 1);
  assert.ok(output.response.lines.every((line) => line.length <= 31));
  assert.deepEqual(output.suggestions.map((action) => action.actionId), ["action_test", "action_continue"]);
  assert.doesNotMatch(output.response.lines.join(" "), /AC_FOLLOWUPS/u);
});

test("waiting output never reuses an assistant response older than the dispatched action", () => {
  const output = buildDeviceThreadOutput({
    thread: {
      id: "thread_1",
      session: { status: "running" },
      messages: [{ role: "assistant", text: "Stale", createdAt: "2026-08-08T19:00:00.000Z" }],
    },
    controls,
    after: "2026-08-08T20:00:00.000Z",
  });
  assert.equal(output.response.state, "waiting");
  assert.equal(output.response.messageId, null);
  assert.match(output.response.lines[0], /Waiting/u);
});

test("waiting output carries a bounded content-free summary of T3 native task work", () => {
  const output = buildDeviceThreadOutput({
    thread: {
      id: "thread_1",
      session: { status: "stopped" },
      activities: [
        {
          kind: "task.started",
          summary: "Private repository audit",
          payload: {
            taskId: "agent_private",
            agentKind: "agent",
            title: "Private repository audit",
          },
        },
        {
          kind: "task.completed",
          summary: "Task failed",
          payload: {
            taskId: "agent_failed",
            agentKind: "agent",
            status: "failed",
            summary: "Secret provider output",
          },
        },
      ],
    },
    controls,
    after: "2026-08-08T20:00:00.000Z",
  });

  assert.deepEqual(output.work, {
    version: 1,
    source: "t3-task-activities",
    total: 2,
    active: 1,
    queued: 0,
    working: 1,
    waiting: 0,
    completed: 0,
    failed: 1,
    stopped: 0,
    backgroundLiveness: "working",
    truncated: false,
    omitted: 0,
  });
  assert.deepEqual(output.response.lines, ["1 active task", "0 done · 1 failed", "EXIT returns to actions"]);
  assert.ok(output.response.lines.every((line) => line.length <= 31));
  assert.doesNotMatch(JSON.stringify(output.work), /Private repository|Secret provider|agent_private/u);
});

test("malformed and untrusted follow-up markers fail closed", () => {
  assert.deepEqual(extractFollowUpIds('Done <!--AC_FOLLOWUPS:not-json-->'), []);
  assert.deepEqual(extractFollowUpIds('Done <!--AC_FOLLOWUPS:["a"]-->'), ["a"]);
  assert.equal(stripFollowUpMarkers('Done <!--AC_FOLLOWUPS:["a"]-->'), "Done");
  assert.deepEqual(wrapResponseText("abcdefghijklmnopqrstuvwxyz0123456789", 12), ["abcdefghijkl", "mnopqrstuvwx", "yz0123456789"]);
});

// --- Incremental response reads -----------------------------------------------------------------
//
// A controller watching a running agent re-received the whole reply on every poll. These pin the
// additive cursor that lets it ask only for the tail, and the two cases where appending would show
// the owner something the agent never said.

function streamingThread(text, { streaming = true, messageId = "m1" } = {}) {
  return {
    id: "thread_1",
    messages: [{ id: messageId, role: "assistant", text, streaming, createdAt: "2026-10-30T10:00:00.000Z" }],
  };
}

test("a device with no cursor still receives the whole response, exactly as before", () => {
  const output = buildDeviceThreadOutput({ thread: streamingThread("Hello there") });
  assert.equal(output.response.stream.offset, 0);
  assert.equal(output.response.stream.appended, "Hello there");
  assert.equal(output.response.stream.reset, false);
  // The paged contract the current firmware reads must be untouched by the cursor work.
  assert.deepEqual(output.response.lines, ["Hello there"]);
  assert.equal(output.response.state, "streaming");
});

test("a cursor returns only the text generated since the last poll", () => {
  const output = buildDeviceThreadOutput({
    thread: streamingThread("Hello there, more now"),
    streamCursor: { messageId: "m1", offset: 11 },
  });
  assert.equal(output.response.stream.appended, ", more now");
  assert.equal(output.response.stream.offset, 11);
  assert.equal(output.response.stream.total, 21);
  assert.equal(output.response.stream.complete, false);
});

test("complete means the device holds every character and the turn has settled", () => {
  const caughtUpButRunning = buildDeviceThreadOutput({
    thread: streamingThread("All of it"),
    streamCursor: { messageId: "m1", offset: 9 },
  });
  assert.equal(caughtUpButRunning.response.stream.appended, "");
  assert.equal(caughtUpButRunning.response.stream.complete, false, "a settled cursor on a live turn is not complete");

  const settled = buildDeviceThreadOutput({
    thread: streamingThread("All of it", { streaming: false }),
    streamCursor: { messageId: "m1", offset: 9 },
  });
  assert.equal(settled.response.stream.complete, true);

  // Settled turn the device has not caught up with yet: more to fetch, so not complete.
  const behind = buildDeviceThreadOutput({
    thread: streamingThread("All of it", { streaming: false }),
    streamCursor: { messageId: "m1", offset: 4 },
  });
  assert.equal(behind.response.stream.complete, true);
  assert.equal(behind.response.stream.appended, "of it");
});

test("a new message resets rather than appending to the previous one", () => {
  const output = buildDeviceThreadOutput({
    thread: streamingThread("A different answer", { messageId: "m2" }),
    streamCursor: { messageId: "m1", offset: 5 },
  });
  assert.equal(output.response.stream.reset, true);
  assert.equal(output.response.stream.offset, 0);
  assert.equal(output.response.stream.appended, "A different answer");
});

test("text that shrank is a replacement, not an extension, and resets", () => {
  // T3 sends absolute text for a native v2 message update; only its streaming suffix is a delta.
  // A device that appended here would show the owner a sentence the agent never wrote.
  const output = buildDeviceThreadOutput({
    thread: streamingThread("Short"),
    streamCursor: { messageId: "m1", offset: 99 },
  });
  assert.equal(output.response.stream.reset, true);
  assert.equal(output.response.stream.offset, 0);
  assert.equal(output.response.stream.appended, "Short");
});

test("one poll never carries an unbounded payload", () => {
  const long = "x".repeat(DEVICE_RESPONSE_STREAM_CHUNK * 3);
  const output = buildDeviceThreadOutput({ thread: streamingThread(long), streamCursor: { messageId: "m1", offset: 0 } });
  assert.equal(output.response.stream.appended.length, DEVICE_RESPONSE_STREAM_CHUNK);
  assert.equal(output.response.stream.total, long.length);
  assert.equal(output.response.stream.complete, false, "a bounded chunk must not claim the device is caught up");
});

test("a cursor held against an empty thread is told to reset instead of stalling", () => {
  const output = buildDeviceThreadOutput({ thread: { id: "thread_1", messages: [] }, streamCursor: { messageId: "m1", offset: 20 } });
  assert.equal(output.response.stream.reset, true);
  assert.equal(output.response.stream.total, 0);
  assert.equal(output.response.stream.messageId, null);
});

// --- Prefix stability of incremental reads -------------------------------------------------------
//
// The append protocol rests on one property: the text a device accumulates must equal the text it
// would have received in one shot. That held until normalization entered the picture — it rewrites
// paired markdown, so normalizing a partial stream could REWRITE an earlier prefix rather than
// extend it, and the device appended onto characters that no longer existed.

test("streaming a markdown link never leaves the device holding corrupted text", () => {
  // The exact reported failure: `Check [do` then the completed link displayed `Check [dos now`.
  const polls = ["Check [do", "Check [docs", "Check [docs](http", "Check [docs](http://x) now"];
  let held = "";
  let offset = 0;
  for (const raw of polls) {
    const stream = buildDeviceThreadOutput({
      thread: { id: "t1", messages: [{ id: "m1", role: "assistant", text: raw, streaming: true, createdAt: "2026-10-30T10:00:00.000Z" }] },
      streamCursor: { messageId: "m1", offset },
    }).response.stream;
    if (stream.reset) { held = ""; offset = 0; }
    held += stream.appended;
    offset = stream.offset + stream.appended.length;
  }
  assert.equal(held, "Check docs now");
});

test("the exposed text only ever grows, for every prefix of every sample", () => {
  // This is the proof, not the illustration. Each sample is streamed one character at a time and
  // the exposed text must always be a prefix of what came before it extended — never a rewrite.
  const samples = [
    "Check [docs](http://example.com) now",
    "Run `npm test` and then `npm start`",
    "An ![image](http://x/y.png) inline",
    "```js\nconst x = 1;\n```\ndone",
    "A <b>bold</b> tag and a <br> break",
    "# Heading\n- one\n- two\n> quote",
    "Mixed [a](b) `c` <d> ![e](f) tail",
    "Trailing spaces   and\n\nblank lines",
    "Unclosed [bracket and `tick and <tag",
    "[a](b)[c](d)[e](f)",
    "``double`` and ```triple``` runs",
  ];
  for (const sample of samples) {
    let previous = "";
    for (let length = 0; length <= sample.length; length += 1) {
      const current = stableVisibleText(sample.slice(0, length));
      assert.ok(
        current.startsWith(previous),
        `rewrote an exposed prefix at ${length} of ${JSON.stringify(sample)}: ${JSON.stringify(previous)} -> ${JSON.stringify(current)}`,
      );
      previous = current;
    }
  }
});

test("a settled message releases a tail that was withheld while it streamed", () => {
  // The hole this closes: withholding applied to settled messages too, so a reply ending in an
  // unclosed construct never showed its tail while still reporting `complete`. A `<` in ordinary
  // prose is enough to trigger it, so the lost tail could be most of the reply.
  for (const [sample, expected, withheld] of [
    // Prose `<` can no longer begin a tag (the tag rule needs a name), so it is not withheld
    // while streaming either; it still has to arrive in full when settled.
    ["Price is 5 < 6", "Price is 5 < 6", false],
    ["Use [x", "Use [x", true],
    ["if x < 5 then y", "if x < 5 then y", false],
    ["Use <b", "Use <b", true],
  ]) {
    const settled = buildDeviceThreadOutput({
      thread: { id: "t1", messages: [{ id: "m1", role: "assistant", text: sample, streaming: false, createdAt: "2026-10-30T10:00:00.000Z" }] },
      streamCursor: { messageId: "m1", offset: 0 },
    }).response.stream;
    assert.equal(settled.appended, expected, `${JSON.stringify(sample)} lost its tail`);
    assert.equal(settled.complete, true);
    // While it was still streaming the unstable tail is correctly withheld.
    if (withheld) assert.ok(stableVisibleText(sample).length < expected.length);
    else assert.equal(stableVisibleText(sample), expected);
  }
});

test("releasing the withheld tail at settle extends the streamed prefix rather than rewriting it", () => {
  // The settled exposure is a different function from the streaming one, so the grow-only
  // property has to be asserted across that boundary too, not just between polls.
  const samples = [
    "Check [docs](http://example.com) now",
    "Price is 5 < 6",
    "Run `npm test` and `npm start`",
    "An ![image](http://x/y.png) inline",
    "Unclosed [bracket and `tick and <tag",
    "# Heading\n- one\n- two\n> quote",
  ];
  for (const sample of samples) {
    for (let length = 0; length <= sample.length; length += 1) {
      const streamed = stableVisibleText(sample.slice(0, length));
      const settledOutput = buildDeviceThreadOutput({
        thread: { id: "t1", messages: [{ id: "m1", role: "assistant", text: sample, streaming: false, createdAt: "2026-10-30T10:00:00.000Z" }] },
      }).response.stream;
      assert.ok(
        settledOutput.appended.startsWith(streamed),
        `settling rewrote a streamed prefix of ${JSON.stringify(sample)} at ${length}: ${JSON.stringify(streamed)} is not a prefix of ${JSON.stringify(settledOutput.appended)}`,
      );
    }
  }
});

test("a settled message with closed markup exposes its whole normalized text", () => {
  // Withholding is only ever about markup that might still change. Once the text is final there
  // must be no open construct left, or a device would wait for characters that never arrive.
  for (const sample of [
    "Check [docs](http://example.com) now",
    "Run `npm test` first",
    "Plain text with no markup at all",
    "```js\nconst x = 1;\n```",
  ]) {
    const output = buildDeviceThreadOutput({
      thread: { id: "t1", messages: [{ id: "m1", role: "assistant", text: sample, streaming: false, createdAt: "2026-10-30T10:00:00.000Z" }] },
      streamCursor: { messageId: "m1", offset: 0 },
    });
    assert.equal(output.response.stream.complete, true, `${JSON.stringify(sample)} never completed`);
    assert.equal(output.response.stream.appended, output.response.stream.total > 0 ? stableVisibleText(sample) : "");
  }
});

test("an unterminated construct is withheld rather than shown raw", () => {
  assert.equal(stableVisibleText("Check [do"), "Check");
  assert.equal(stableVisibleText("Run `npm tes"), "Run");
  assert.equal(stableVisibleText("A <b"), "A");
  // A complete link is exposed, brackets resolved.
  assert.equal(stableVisibleText("Check [docs](http://x) now"), "Check docs now");
});
