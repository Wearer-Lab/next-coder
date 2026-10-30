import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import {
  DEVICE_RESPONSE_STREAM_CHUNK,
  DEVICE_RESPONSE_STREAM_FINGERPRINT_LENGTH,
  buildDeviceThreadOutput,
  fingerprintStreamText,
  normalizeResponseText,
  stripFollowUpMarkers,
  wrapResponseText,
} from "../src/deviceThreadOutput.mjs";

// --- Harness: a device that follows the cursor protocol exactly ----------------------------------
//
// The device model below is the CONTRACT, not a convenience: it holds the text it has accumulated,
// the message id, and the last fingerprint it was given, echoes all three, discards on `reset`, and
// appends only at the offset it was told. Nothing here looks at server internals, so a fuzz failure
// is a protocol failure.

const AT = "2026-10-30T10:00:00.000Z";

function thread(text, { streaming, messageId = "m1" }) {
  return { id: "t1", messages: [{ id: messageId, role: "assistant", text, streaming, createdAt: AT }] };
}

function newDevice({ echoFingerprint = true } = {}) {
  return { held: "", messageId: null, fingerprint: undefined, echoFingerprint, resets: 0, polls: 0 };
}

/** One poll: send the cursor, apply the reply. Returns the stream block it received. */
function poll(device, raw, { streaming }) {
  const cursor = device.messageId
    ? {
        messageId: device.messageId,
        offset: device.held.length,
        ...(device.echoFingerprint && device.fingerprint !== undefined ? { fingerprint: device.fingerprint } : {}),
      }
    : null;
  const { stream } = buildDeviceThreadOutput({ thread: thread(raw, { streaming }), streamCursor: cursor }).response;
  device.polls += 1;
  if (stream.reset) {
    device.held = "";
    device.resets += 1;
  }
  // A reply that does not start where the device is would have it append at the wrong place.
  assert.equal(stream.offset, device.held.length, `reply offset ${stream.offset} != held ${device.held.length}`);
  assert.ok(stream.appended.length <= DEVICE_RESPONSE_STREAM_CHUNK, "chunk bound exceeded");
  device.held += stream.appended;
  device.messageId = stream.messageId;
  device.fingerprint = stream.fingerprint;
  return stream;
}

/**
 * Polls the same raw text until the device has everything the server would expose for it. A
 * reset may legitimately happen on the first poll of a new text; a second one on the SAME text
 * would be the loop the protocol must rule out, so it is asserted here rather than tolerated.
 */
function catchUp(device, raw, { streaming }) {
  const bound = Math.ceil(raw.length / DEVICE_RESPONSE_STREAM_CHUNK) + 3;
  let resetsOnThisText = 0;
  for (let attempt = 0; attempt < bound; attempt += 1) {
    const stream = poll(device, raw, { streaming });
    if (stream.reset) resetsOnThisText += 1;
    assert.ok(resetsOnThisText <= 1, `reset loop on unchanged text ${JSON.stringify(raw.slice(0, 80))}`);
    if (device.held.length >= stream.total) return stream;
  }
  assert.fail(`device never caught up on ${JSON.stringify(raw.slice(0, 80))}`);
}

// The text a settled reply exposes is, by definition, its follow-up-stripped normalization.
const settledText = (raw) => normalizeResponseText(stripFollowUpMarkers(raw));

// --- Seeded generator ----------------------------------------------------------------------------

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every construct the normalizer rewrites, plus the characters that merely LOOK like them.
const TOKENS = [
  "[", "]", "(", ")", "`", "``", "```", "<", ">", "!", "-", "- ", "* ", "> ", "# ", "## ",
  "\n", "\n\n", " ", "  ", "\t", "a", "b", "docs", "http://x", "x < 5", "y > 3", "<b>", "</b>", "<br>",
  "<!--", "-->", "<!-- c -->", "![alt](u)", "[t](u)", "`code`", "<div class=\"a\">", "AC", "<!--AC_FOLLOWUPS:[\"x\"]-->",
  "😀", "é", "\r",
];

function generate(random) {
  const count = 1 + Math.floor(random() * 40);
  let text = "";
  for (let index = 0; index < count; index += 1) text += TOKENS[Math.floor(random() * TOKENS.length)];
  // A minority of strings straddle the chunk bound, with an astral character right on it, so the
  // surrogate-pair rule and multi-poll catch-up are exercised and not just short replies.
  if (random() < 0.04) {
    const filler = "w".repeat(DEVICE_RESPONSE_STREAM_CHUNK - 1 - Math.floor(random() * 2));
    text = filler + "😀 " + text + " [" + "z".repeat(Math.floor(random() * 700)) + "](u) tail";
  }
  return text;
}

/** Growing prefixes at random cut points, occasionally mid-surrogate, ending at the full text. */
function cutPoints(random, length) {
  const cuts = [];
  let at = 0;
  while (at < length) {
    at = Math.min(length, at + 1 + Math.floor(random() * (random() < 0.2 ? 60 : 6)));
    cuts.push(at);
  }
  return cuts;
}

// --- Fingerprint contract ------------------------------------------------------------------------

test("the fingerprint is fixed-length lowercase hex, well under the 128 bytes firmware reserved", () => {
  assert.equal(DEVICE_RESPONSE_STREAM_FINGERPRINT_LENGTH, 16);
  assert.ok(DEVICE_RESPONSE_STREAM_FINGERPRINT_LENGTH < 128);
  for (const text of ["", "a", "Check docs now", "x".repeat(5000), "\ud83d"]) {
    const digest = fingerprintStreamText(text);
    assert.match(digest, /^[0-9a-f]{16}$/u);
  }
  const stream = buildDeviceThreadOutput({ thread: thread("hello", { streaming: true }) }).response.stream;
  assert.match(stream.fingerprint, /^[0-9a-f]{16}$/u);
  assert.equal(stream.fingerprint, fingerprintStreamText("hello"), "digest covers the text held AFTER this response");
});

test("the digest distinguishes prefixes that differ only by a lone surrogate or by length", () => {
  const digests = new Set(["", "\ud83d", "�", "a", "a\u0000", "aa", "a ", "😀"].map(fingerprintStreamText));
  assert.equal(digests.size, 8);
});

test("a matching fingerprint continues, a mismatched one resets and resends from zero", () => {
  const raw = "Hello there, more text";
  const base = { messageId: "m1", offset: 5 };
  const good = buildDeviceThreadOutput({
    thread: thread(raw, { streaming: true }),
    streamCursor: { ...base, fingerprint: fingerprintStreamText("Hello") },
  }).response.stream;
  assert.equal(good.reset, false);
  assert.equal(good.offset, 5);
  assert.equal(good.appended, " there, more text");
  assert.equal(good.fingerprint, fingerprintStreamText(raw));

  const stale = buildDeviceThreadOutput({
    thread: thread(raw, { streaming: true }),
    streamCursor: { ...base, fingerprint: fingerprintStreamText("Hellx") },
  }).response.stream;
  assert.equal(stale.reset, true);
  assert.equal(stale.offset, 0);
  assert.equal(stale.appended, raw);
});

test("a malformed, oversized, empty or foreign fingerprint is a reset, never trusted", () => {
  const raw = "Hello there";
  for (const fingerprint of [
    "",
    "not-a-digest",
    "ABCDEF0123456789", // right length, wrong alphabet
    "0123456789abcde", // one short
    "0123456789abcdef0", // one long
    "0".repeat(5000),
    "undefined",
  ]) {
    const stream = buildDeviceThreadOutput({
      thread: thread(raw, { streaming: true }),
      streamCursor: { messageId: "m1", offset: 5, fingerprint },
    }).response.stream;
    assert.equal(stream.reset, true, `${JSON.stringify(fingerprint).slice(0, 40)} was trusted`);
    assert.equal(stream.appended, raw);
  }
  // Nothing held and nothing claimed is not a mismatch; it is simply the first read.
  const first = buildDeviceThreadOutput({
    thread: thread(raw, { streaming: true }),
    streamCursor: { messageId: "m1", offset: 0, fingerprint: "" },
  }).response.stream;
  assert.equal(first.reset, false);
  assert.equal(first.appended, raw);
});

test("a fingerprint for a message the server is not streaming resets without consulting it", () => {
  const stream = buildDeviceThreadOutput({
    thread: thread("Another answer", { streaming: true, messageId: "m2" }),
    streamCursor: { messageId: "m1", offset: 4, fingerprint: fingerprintStreamText("Some") },
  }).response.stream;
  assert.equal(stream.reset, true);
  assert.equal(stream.messageId, "m2");
  assert.equal(stream.appended, "Another answer");
  // No selected message at all: the fingerprint has nothing to describe.
  const empty = buildDeviceThreadOutput({
    thread: { id: "t1", messages: [] },
    streamCursor: { messageId: "m1", offset: 0, fingerprint: fingerprintStreamText("Some") },
  }).response.stream;
  assert.equal(empty.reset, true);
  assert.equal(empty.messageId, null);
});

test("a device that sends no fingerprint keeps the length-based behaviour", () => {
  const raw = "Hello there, more text";
  const old = buildDeviceThreadOutput({
    thread: thread(raw, { streaming: true }),
    streamCursor: { messageId: "m1", offset: 5 },
  }).response.stream;
  assert.equal(old.reset, false);
  assert.equal(old.appended, " there, more text");
  const shrunk = buildDeviceThreadOutput({
    thread: thread("Hi", { streaming: true }),
    streamCursor: { messageId: "m1", offset: 40 },
  }).response.stream;
  assert.equal(shrunk.reset, true);
});

test("a chunk bound never splits a surrogate pair", () => {
  const raw = "w".repeat(DEVICE_RESPONSE_STREAM_CHUNK - 1) + "😀 end";
  const first = buildDeviceThreadOutput({
    thread: thread(raw, { streaming: false }),
    streamCursor: { messageId: "m1", offset: 0 },
  }).response.stream;
  assert.equal(first.appended.length, DEVICE_RESPONSE_STREAM_CHUNK - 1);
  assert.equal(first.complete, false);
  const device = newDevice();
  const settled = catchUp(device, raw, { streaming: false });
  assert.equal(settled.complete, true);
  assert.equal(device.held, raw);
});

// --- The reported failure, through the fingerprint echo ------------------------------------------

test("streaming `Check [do` then the completed link leaves the device holding `Check docs now`", () => {
  const device = newDevice();
  for (const raw of ["Check [do", "Check [docs", "Check [docs](http", "Check [docs](http://x) now"]) {
    catchUp(device, raw, { streaming: true });
  }
  assert.equal(device.held, "Check docs now");
  catchUp(device, "Check [docs](http://x) now", { streaming: false });
  assert.equal(device.held, "Check docs now");
});

test("a prefix the withholding rules MISS is repaired by the fingerprint instead of corrupting the device", () => {
  // Two unclosed openers: the withholding rules only examine the last `[`, so the first link is
  // exposed as `a [b` while its closer is still hidden behind the second opener. When the closers
  // arrive the exposed prefix is rewritten. Length alone cannot see that; the digest does.
  const polls = ["a [b [c", "a [b [c](u) tail", "a [b [c](u)](v) tail"];
  const device = newDevice();
  for (const raw of polls) catchUp(device, raw, { streaming: true });
  catchUp(device, polls.at(-1), { streaming: false });
  assert.equal(device.held, settledText(polls.at(-1)));
});

// --- Task 2: the tag rule ------------------------------------------------------------------------

test("prose containing `<` and `>` is not mistaken for an HTML tag", () => {
  assert.equal(normalizeResponseText("if x < 5 and y > 3 then"), "if x < 5 and y > 3 then");
  assert.deepEqual(wrapResponseText("if x < 5 and y > 3 then"), ["if x < 5 and y > 3 then"]);
  const out = buildDeviceThreadOutput({
    thread: thread("if x < 5 and y > 3 then", { streaming: false }),
  }).response;
  assert.deepEqual(out.lines, ["if x < 5 and y > 3 then"]);
  assert.equal(out.stream.appended, "if x < 5 and y > 3 then");
  // Real tags and comments are still dropped.
  assert.equal(normalizeResponseText("A <b>bold</b> <br/> and <!-- note --> done"), "A bold and done");
  assert.equal(normalizeResponseText("a <div class=\"x\">b</div>"), "a b");
});

// --- Task 3: the property --------------------------------------------------------------------------

const FUZZ_CASES = 6000;

test(`fuzz: a device following the cursor protocol always ends holding exactly the settled text (${FUZZ_CASES} strings)`, () => {
  const random = mulberry32(0x5eed1234);
  let polls = 0;
  let resets = 0;
  let repaired = 0;
  let withoutFingerprintCorrupt = 0;
  let multiChunk = 0;

  for (let caseIndex = 0; caseIndex < FUZZ_CASES; caseIndex += 1) {
    const raw = generate(random);
    const label = `case ${caseIndex} ${JSON.stringify(raw.length > 200 ? `${raw.slice(0, 100)}...` : raw)}`;
    const cuts = cutPoints(random, raw.length);
    const device = newDevice();
    const legacy = newDevice({ echoFingerprint: false });

    try {
      for (const cut of cuts) {
        // A device does not poll on every token: skip some intermediate texts.
        if (cut !== raw.length && random() < 0.35) continue;
        catchUp(device, raw.slice(0, cut), { streaming: true });
        catchUp(legacy, raw.slice(0, cut), { streaming: true });
      }
      catchUp(device, raw, { streaming: false });
      catchUp(legacy, raw, { streaming: false });

      const expected = settledText(raw);
      assert.equal(device.held, expected, `corrupted device text`);
      // The settled poll must also report itself complete, or firmware would poll forever.
      const final = poll(device, raw, { streaming: false });
      assert.equal(final.complete, true, "settled poll not complete");
      assert.equal(final.reset, false, "settled steady-state poll reset");
      assert.equal(final.appended, "", "settled steady-state poll resent text");
      assert.equal(device.held, expected, "steady-state poll changed the device text");
    } catch (error) {
      error.message = `${label}: ${error.message}`;
      throw error;
    }

    polls += device.polls;
    resets += device.resets;
    if (device.resets > 0) repaired += 1;
    // Control: the same replay with the fingerprint withheld, i.e. today's length-only protocol.
    if (legacy.held !== settledText(raw)) withoutFingerprintCorrupt += 1;
    if (settledText(raw).length > DEVICE_RESPONSE_STREAM_CHUNK) multiChunk += 1;
  }

  // The fuzz has to have teeth: it must exercise resets, multi-chunk replies, and demonstrably
  // catch corruption that length-based detection alone lets through.
  assert.ok(multiChunk > 50, `only ${multiChunk} multi-chunk cases`);
  assert.ok(repaired > 0, "no case ever needed the fingerprint");
  assert.ok(
    withoutFingerprintCorrupt > 0,
    "the control never corrupted, so this fuzz would not have caught the original bug",
  );
  console.log(
    `fuzz: ${FUZZ_CASES} strings, ${polls} polls, ${resets} resets across ${repaired} strings, `
    + `${multiChunk} multi-chunk, length-only control corrupted ${withoutFingerprintCorrupt}`,
  );
});

test("fuzz: a device that polls only once at the end, or only after settling, also converges", () => {
  const random = mulberry32(0xc0ffee);
  for (let caseIndex = 0; caseIndex < 2000; caseIndex += 1) {
    const raw = generate(random);
    const lateStart = newDevice();
    catchUp(lateStart, raw, { streaming: false });
    assert.equal(lateStart.held, settledText(raw), `late start ${JSON.stringify(raw.slice(0, 80))}`);
    assert.equal(lateStart.resets, 0, "a first read never needs a reset");

    // Hold a mid-stream prefix, then jump straight to the settled text.
    const device = newDevice();
    catchUp(device, raw.slice(0, Math.floor(random() * raw.length)), { streaming: true });
    catchUp(device, raw, { streaming: false });
    assert.equal(device.held, settledText(raw), `jump to settle ${JSON.stringify(raw.slice(0, 80))}`);
  }
});

// --- Route-level: query parameter handling ---------------------------------------------------------

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function deviceRouteFixture(t, text) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/snapshot") {
      return jsonResponse({
        projects: [{ id: "p1" }],
        threads: [{
          id: "thread_out",
          title: "Out",
          session: { status: "stopped" },
          messages: [{ id: "msg_1", role: "assistant", createdAt: AT, text }],
        }],
      }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { server } = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const send = async (path, init = {}) => {
    const response = await originalFetch(new URL(path, baseUrl), {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: response.status, body: await response.json() };
  };
  const user = await send("/v1/users/dev", { method: "POST", body: { userId: "user_dev", email: "dev@example.local" } });
  const auth = { authorization: `Bearer ${user.body.apiToken.secret}` };
  const created = (await send("/v1/devices", { method: "POST", headers: auth, body: { label: "Bezel", profile: "next-coder" } })).body;
  const environment = (await send("/v1/t3/environments", {
    method: "POST",
    headers: auth,
    body: { label: "Bound", baseUrl: "https://bound-t3.example", accessToken: "tok" },
  })).body;
  await send(`/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: auth,
    body: { environmentId: environment.environment.id, threadId: "thread_out" },
  });
  const deviceHeaders = { "x-device-id": created.device.id, "x-device-secret": created.secret };
  return (query) => send(`/v1/device/thread-output${query}`, { headers: deviceHeaders });
}

test("GET /v1/device/thread-output echoes and verifies streamFingerprint", async (t) => {
  const read = await deviceRouteFixture(t, "Check [docs](http://x) now");

  const first = await read("?streamMessageId=msg_1&streamOffset=0");
  assert.equal(first.status, 200);
  const { stream } = first.body.response;
  assert.equal(stream.appended, "Check docs now");
  assert.equal(stream.fingerprint, fingerprintStreamText("Check docs now"));
  assert.equal(stream.reset, false);

  // Echoing the fingerprint of a real 5-character prefix continues from there.
  const held = fingerprintStreamText("Check");
  const resumed = await read(`?streamMessageId=msg_1&streamOffset=5&streamFingerprint=${held}`);
  assert.equal(resumed.body.response.stream.reset, false);
  assert.equal(resumed.body.response.stream.appended, " docs now");

  // Wrong, malformed and absurdly long values reset rather than 400 or being trusted.
  for (const bad of [fingerprintStreamText("Chec"), "zz", "", "f".repeat(4000)]) {
    const answer = await read(`?streamMessageId=msg_1&streamOffset=5&streamFingerprint=${bad}`);
    assert.equal(answer.status, 200, `fingerprint ${bad.slice(0, 20)} should not be a 400`);
    assert.equal(answer.body.response.stream.reset, true);
    assert.equal(answer.body.response.stream.offset, 0);
    assert.equal(answer.body.response.stream.appended, "Check docs now");
  }

  // Older firmware: no fingerprint parameter at all.
  const legacy = await read("?streamMessageId=msg_1&streamOffset=5");
  assert.equal(legacy.body.response.stream.reset, false);
  assert.equal(legacy.body.response.stream.appended, " docs now");
});
