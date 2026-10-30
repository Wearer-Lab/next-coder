// Incremental response text: the firmware side of `response.stream` (GET /v1/device/thread-output).
//
// Two layers, and the difference matters when reading a failure:
//
//   1. The retained-text state machine (`applyResponseStream`, OperateModel.h) is compiled from the
//      REAL header and driven with hand-written blocks, so the edge cases (reset, mismatched
//      cursor, UTF-8 units, buffer ceiling) are each pinned on their own.
//
//   2. The real `fetchResponsePage` / `openResponse` / `closeResponse` / `copyResponseStream` /
//      `responseInFlight` bodies are sliced out of GatewayOperate.cpp, compiled against the real
//      ArduinoJson, and driven over a pipe by the REAL gateway builder (`buildDeviceThreadOutput`
//      from src/deviceThreadOutput.mjs). The C++ prints the request path it built; this file parses
//      the query exactly as the route in src/app.mjs does and answers with the builder's output. So
//      the cursor the firmware sends and the block the gateway returns are never restated here.
//
// What this is NOT: the transport (`request()`, TLS gate, watchdog) is a pipe, not a socket, and
// there is no silicon. Lock and yield behaviour of the real request body is covered by
// firmware-request-locks.test.mjs; nothing here claims anything about hardware.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import {
  DEVICE_RESPONSE_LINE_LENGTH,
  DEVICE_RESPONSE_LINES_PER_PAGE,
  DEVICE_RESPONSE_MAX_PAGES,
  DEVICE_RESPONSE_STREAM_CHUNK,
  DEVICE_RESPONSE_STREAM_FINGERPRINT_LENGTH,
  buildDeviceThreadOutput,
  fingerprintStreamText,
} from "../src/deviceThreadOutput.mjs";

const CORE = resolve("firmware/shared/NextCoderCore/src");
const CAP_BYTES = DEVICE_RESPONSE_LINES_PER_PAGE * DEVICE_RESPONSE_MAX_PAGES * DEVICE_RESPONSE_LINE_LENGTH;
const compiler = process.env.CXX || "c++";
const haveCompiler = spawnSync(compiler, ["--version"]).error?.code !== "ENOENT";

// A String facade rich enough for both the model header and the sliced firmware: it derives from
// std::string like the one in firmware-response.test.mjs, plus the Arduino `String + int` the real
// request path uses.
const ARDUINO_H = `#pragma once
#include <string>
#include <cstdint>
#include <cstdio>
#include <algorithm>
using std::max;
class String: public std::string {
public: using std::string::string; using std::string::operator=;
 String(const std::string& value):std::string(value){}
};
inline String operator+(const String& a,int b){return String(static_cast<const std::string&>(a)+std::to_string(b));}
`;

async function compile(code, { arduinoJson = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "next-coder-stream-"));
  // Removed at process exit: the harness executable is shared by every test in this file.
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "Arduino.h"), ARDUINO_H);
  await writeFile(join(directory, "check.cpp"), code);
  const executable = join(directory, "check");
  const flags = ["-std=c++17", "-Wall", "-I", directory, "-I", CORE];
  if (arduinoJson) flags.push("-DARDUINOJSON_ENABLE_STD_STRING=1", "-I", arduinoJson);
  const compiled = spawnSync(compiler, [...flags, join(directory, "check.cpp"), "-o", executable], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  return { directory, executable };
}

function findArduinoJson() {
  const candidates = [process.env.ARDUINOJSON_DIR, join(homedir(), ".platformio/lib/ArduinoJson/src")];
  const firmware = resolve("firmware");
  for (const board of existsSync(firmware) ? readdirSync(firmware) : []) {
    const libdeps = join(firmware, board, ".pio/libdeps");
    if (!existsSync(libdeps)) continue;
    for (const env of readdirSync(libdeps)) candidates.push(join(libdeps, env, "ArduinoJson/src"));
  }
  return candidates.find((candidate) => candidate && existsSync(join(candidate, "ArduinoJson.h"))) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Layer 1: the state machine, from the real header
// ---------------------------------------------------------------------------------------------

test("stream state machine appends, resets, rejects and bounds retained text", async (t) => {
  if (!haveCompiler) return t.skip("Native C++ compiler unavailable");
  const { executable } = await compile(`
#include <cassert>
#include <cstring>
#include "OperateModel.h"
static_assert(kMaxResponseStreamBytes == ${CAP_BYTES}, "retention must equal the gateway display ceiling");
// 512 characters per poll fill the 1,116-byte buffer in three reads; the loop budget must cover them.
static_assert((kMaxResponseStreamBytes + ${DEVICE_RESPONSE_STREAM_CHUNK} - 1) / ${DEVICE_RESPONSE_STREAM_CHUNK} + 1 <= kMaxResponseStreamReads, "catch-up budget");
static_assert(kMaxResponseStreamFingerprintBytes == ${DEVICE_RESPONSE_STREAM_FINGERPRINT_LENGTH}, "buffer must match the gateway's fixed fingerprint length");
static_assert(sizeof(ResponseStream::fingerprint) == ${DEVICE_RESPONSE_STREAM_FINGERPRINT_LENGTH} + 1, "17 bytes with the terminator");

static ResponseStreamBlock block(const char* id, uint32_t offset, uint32_t total, const char* appended, bool complete = false, bool reset = false, const char* fingerprint = "") {
  ResponseStreamBlock b; b.present = true; b.messageId = id; b.offset = offset; b.total = total;
  b.appended = appended; b.complete = complete; b.reset = reset; b.fingerprint = fingerprint; return b;
}
static bool is(const ResponseStream& s, const char* text) { return std::strcmp(s.text, text) == 0 && s.textBytes == std::strlen(text); }

int main() {
  { // append advances the cursor by what was RECEIVED, not by the gateway's total
    ResponseStream s;
    assert(!s.hasCursor());
    auto u = applyResponseStream(s, block("m1", 0, 1000, "Hello"));
    assert(u.outcome == ResponseStreamOutcome::Replaced && s.hasCursor());   // first block starts the message
    assert(is(s, "Hello") && s.consumed == 5 && !s.complete && u.more);     // 995 more exist
    u = applyResponseStream(s, block("m1", 5, 1000, " world"));
    assert(u.outcome == ResponseStreamOutcome::Appended && is(s, "Hello world") && s.consumed == 11);
    u = applyResponseStream(s, block("m1", 11, 11, "", true));
    assert(is(s, "Hello world") && s.consumed == 11 && s.complete && !u.more); // caught up and settled
  }
  { // reset discards: this is the branch that would otherwise print a sentence nobody wrote
    ResponseStream s;
    applyResponseStream(s, block("m1", 0, 20, "OLD OLD OLD"));
    auto u = applyResponseStream(s, block("m1", 0, 3, "new", true, true));
    assert(u.outcome == ResponseStreamOutcome::Replaced);
    assert(is(s, "new") && s.consumed == 3 && s.complete);                   // not "OLD OLD OLDnew"
  }
  { // a different message id replaces even when the gateway forgot to say reset
    ResponseStream s;
    applyResponseStream(s, block("m1", 0, 20, "first reply"));
    auto u = applyResponseStream(s, block("m2", 0, 6, "second"));
    assert(u.outcome == ResponseStreamOutcome::Replaced && is(s, "second") && s.messageId == "m2");
  }
  { // reset that does not start at zero cannot be spliced onto anything: drop, do not guess
    ResponseStream s;
    applyResponseStream(s, block("m1", 0, 20, "held"));
    auto u = applyResponseStream(s, block("m1", 4, 20, "tail", false, true));
    assert(u.outcome == ResponseStreamOutcome::Rejected && s.textBytes == 0 && s.consumed == 0 && !s.hasCursor());
  }
  { // a block that does not begin at the cursor is rejected, never appended
    ResponseStream s;
    applyResponseStream(s, block("m1", 0, 20, "held"));
    auto u = applyResponseStream(s, block("m1", 9, 20, "wrong"));
    assert(u.outcome == ResponseStreamOutcome::Rejected && s.textBytes == 0 && !u.more);
    applyResponseStream(s, block("m1", 0, 20, "held"));
    u = applyResponseStream(s, block("m1", 2, 20, "ld"));                   // behind the cursor, equally unusable
    assert(u.outcome == ResponseStreamOutcome::Rejected && s.consumed == 0);
  }
  { // an older gateway (no stream object) and "no message" both drop retained text
    ResponseStream s;
    applyResponseStream(s, block("m1", 0, 5, "hello"));
    ResponseStreamBlock none;
    auto u = applyResponseStream(s, none);
    assert(u.outcome == ResponseStreamOutcome::Absent && s.textBytes == 0 && !s.hasCursor() && !u.more);
    applyResponseStream(s, block("m1", 0, 5, "hello"));
    u = applyResponseStream(s, block("", 0, 0, ""));
    assert(u.outcome == ResponseStreamOutcome::Cleared && s.textBytes == 0 && s.messageId.length() == 0);
    ResponseStreamBlock nullId = block("", 0, 0, ""); nullId.messageId = nullptr;  // defensive: a null pointer is "no message"
    assert(applyResponseStream(s, nullId).outcome == ResponseStreamOutcome::Cleared);
    ResponseStreamBlock nullText = block("m1", 0, 0, ""); nullText.appended = nullptr;
    assert(applyResponseStream(s, nullText).outcome == ResponseStreamOutcome::Replaced && s.textBytes == 0);
  }
  { // the cursor counts UTF-16 units: 2-byte and 3-byte characters are one, 4-byte is two
    ResponseStream s;
    applyResponseStream(s, block("m1", 0, 99, "a\\xC3\\xA9\\xE2\\x82\\xAC\\xF0\\x9F\\x98\\x80"));   // a e-acute euro grinning-face
    assert(s.consumed == 1 + 1 + 1 + 2 && s.textBytes == 1 + 2 + 3 + 4);
    auto u = applyResponseStream(s, block("m1", 5, 99, "z"));
    assert(u.outcome == ResponseStreamOutcome::Appended && s.consumed == 6);
    u = applyResponseStream(s, block("m1", 9, 99, "z"));                     // a byte-count cursor (9) must not be accepted
    assert(u.outcome == ResponseStreamOutcome::Rejected);
  }
  { // the buffer ends on a character boundary and the cursor keeps counting HONESTLY past it
    ResponseStream s;
    std::string ascii(kMaxResponseStreamBytes - 1, 'a');
    applyResponseStream(s, block("m1", 0, 5000, ascii.c_str()));
    assert(s.textBytes == kMaxResponseStreamBytes - 1 && !s.truncated);
    auto u = applyResponseStream(s, block("m1", s.consumed, 5000, "\\xC3\\xA9\\xC3\\xA9"));  // one byte of room, two bytes needed
    assert(s.truncated && s.textBytes == kMaxResponseStreamBytes - 1 && s.text[s.textBytes] == 0);
    assert(s.consumed == kMaxResponseStreamBytes - 1 + 2);                   // received units, NOT the gateway's total
    assert(!u.more && s.hasCursor());                                        // no chasing text it cannot keep
    // text arriving after truncation is counted and dropped, never retained
    const uint32_t before = s.consumed;
    u = applyResponseStream(s, block("m1", before, 5000, "more"));
    assert(s.consumed == before + 4 && s.textBytes == kMaxResponseStreamBytes - 1 && s.truncated);
    u = applyResponseStream(s, block("m1", s.consumed, 5000, "", true));
    assert(s.complete && s.truncated && !u.more);
  }
  { // replacing after truncation starts clean
    ResponseStream s;
    std::string big(kMaxResponseStreamBytes + 10, 'q');
    applyResponseStream(s, block("m1", 0, 2000, big.c_str()));
    assert(s.truncated);
    applyResponseStream(s, block("m2", 0, 2, "ok"));
    assert(is(s, "ok") && !s.truncated && s.consumed == 2);
  }
  { // a count past what the gateway accepts is "no cursor", not a clamped wrong number
    ResponseStream s;
    applyResponseStream(s, block("m1", 0, 99, "ab"));
    s.consumed = kMaxResponseStreamOffset;
    assert(s.hasCursor());
    applyResponseStream(s, block("m1", kMaxResponseStreamOffset, 99, "xy"));
    assert(s.consumed == kMaxResponseStreamOffset + 1 && !s.hasCursor());
    auto u = applyResponseStream(s, block("m1", 0, 3, "new"));   // the refetch is sent without a cursor
    assert(u.outcome == ResponseStreamOutcome::Replaced && is(s, "new") && s.hasCursor());
  }
  { // no progress, no loop: an empty block never asks for another read
    ResponseStream s;
    auto u = applyResponseStream(s, block("m1", 0, 40, ""));
    assert(!u.more);
  }
  { // the fingerprint is stored verbatim with the text it describes and replaced by every block
    ResponseStream s;
    applyResponseStream(s, block("m1", 0, 9, "Hello", false, false, "fp-1"));
    assert(s.hasCursor() && s.sendsFingerprint() && !std::strcmp(s.fingerprint, "fp-1"));
    applyResponseStream(s, block("m1", 5, 9, " wor", false, false, "fp-2+/="));
    assert(is(s, "Hello wor") && !std::strcmp(s.fingerprint, "fp-2+/=") && s.fingerprintBytes == 7);
    // an empty block still carries the digest of the text as it stands
    applyResponseStream(s, block("m1", 9, 9, "", true, false, "fp-3"));
    assert(!std::strcmp(s.fingerprint, "fp-3") && s.complete);
  }
  { // a reset (the gateway found the held prefix rewritten) discards text AND fingerprint together
    ResponseStream s;
    applyResponseStream(s, block("m1", 0, 20, "ABCDEFGHIJ", false, false, "old"));
    auto u = applyResponseStream(s, block("m1", 0, 12, "ABCXEFGHIJKL", false, true, "new"));
    assert(u.outcome == ResponseStreamOutcome::Replaced);
    assert(is(s, "ABCXEFGHIJKL") && s.consumed == 12 && !std::strcmp(s.fingerprint, "new"));
  }
  { // rejection, absence and "no message" clear the fingerprint with everything else
    ResponseStream s;
    applyResponseStream(s, block("m1", 0, 20, "held", false, false, "fp"));
    applyResponseStream(s, block("m1", 9, 20, "wrong", false, false, "fp2"));
    assert(s.textBytes == 0 && s.fingerprintBytes == 0 && !s.fingerprintSeen && !s.hasCursor());
    applyResponseStream(s, block("m1", 0, 4, "held", false, false, "fp"));
    ResponseStreamBlock none; applyResponseStream(s, none);
    assert(s.fingerprintBytes == 0 && s.fingerprint[0] == 0);
    applyResponseStream(s, block("m1", 0, 4, "held", false, false, "fp"));
    applyResponseStream(s, block("", 0, 0, ""));
    assert(s.fingerprintBytes == 0 && s.fingerprint[0] == 0);
  }
  { // too long to hold: text is kept, but with no fingerprint to echo there is NO cursor
    ResponseStream s;
    std::string huge(kMaxResponseStreamFingerprintBytes + 1, 'f');
    auto u = applyResponseStream(s, block("m1", 0, 50, "Hello", false, false, huge.c_str()));
    assert(is(s, "Hello") && s.consumed == 5 && s.fingerprintSeen && s.fingerprintBytes == 0);
    assert(!s.hasCursor() && !s.sendsFingerprint() && !u.more);              // never truncated, never sent
    u = applyResponseStream(s, block("m1", 0, 50, "Hello w", false, false, huge.c_str()));  // refetch from zero
    assert(u.outcome == ResponseStreamOutcome::Replaced && is(s, "Hello w") && !s.hasCursor());
    { // a PREVIOUSLY good fingerprint must not survive a block whose digest cannot be held
      ResponseStream t;
      applyResponseStream(t, block("m1", 0, 50, "Hello", false, false, "good"));
      assert(t.sendsFingerprint());
      applyResponseStream(t, block("m1", 5, 50, " more", false, false, huge.c_str()));
      assert(is(t, "Hello more") && t.fingerprintBytes == 0 && t.fingerprint[0] == 0 && !t.hasCursor() && !t.sendsFingerprint());
    }
    std::string exact(kMaxResponseStreamFingerprintBytes, 'f');              // the cap itself is fine
    applyResponseStream(s, block("m1", 0, 50, "Hi", false, false, exact.c_str()));
    assert(s.hasCursor() && s.fingerprintBytes == kMaxResponseStreamFingerprintBytes);
  }
  { // a gateway that was fingerprinting and stops is not trusted to extend the text
    ResponseStream s;
    applyResponseStream(s, block("m1", 0, 20, "Hello", false, false, "fp"));
    auto u = applyResponseStream(s, block("m1", 5, 20, " more"));
    assert(u.outcome == ResponseStreamOutcome::Rejected && s.textBytes == 0 && !s.hasCursor());
    // ...and one that never fingerprinted keeps working exactly as before
    ResponseStream plain;
    applyResponseStream(plain, block("m1", 0, 20, "Hello"));
    assert(plain.hasCursor() && !plain.sendsFingerprint());
    u = applyResponseStream(plain, block("m1", 5, 20, " more"));
    assert(u.outcome == ResponseStreamOutcome::Appended && is(plain, "Hello more"));
    // ...and may START fingerprinting mid-message; from then on it must keep doing so
    applyResponseStream(plain, block("m1", 10, 20, "!", false, false, "fp"));
    assert(plain.sendsFingerprint());
  }
  { // a read sent without a cursor is answered from zero without reset: a fresh start, not a mismatch
    ResponseStream s;
    std::string huge(kMaxResponseStreamFingerprintBytes + 1, 'f');
    applyResponseStream(s, block("m1", 0, 50, "Hello", false, false, huge.c_str()));
    auto u = applyResponseStream(s, block("m1", 0, 50, "Hello", false, false, "short"));
    assert(u.outcome == ResponseStreamOutcome::Replaced && is(s, "Hello") && s.hasCursor());
  }
  { char out[12]; formatResponseStreamOffset(out, sizeof(out), 0); assert(!std::strcmp(out, "0"));
    formatResponseStreamOffset(out, sizeof(out), 9999999); assert(!std::strcmp(out, "9999999"));
    formatResponseStreamOffset(out, sizeof(out), 4294967295u); assert(!std::strcmp(out, "4294967295"));
    char tiny[3]; formatResponseStreamOffset(tiny, sizeof(tiny), 12345); assert(tiny[2] == 0 && tiny[0] == '1'); }
  return 0;
}
`);
  const checked = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
});

// ---------------------------------------------------------------------------------------------
// Layer 2: the real fetch path against the real gateway builder
// ---------------------------------------------------------------------------------------------

let harness; // one compile for the whole file
async function buildHarness(t) {
  if (!haveCompiler) return t.skip("Native C++ compiler unavailable"), null;
  const arduinoJson = findArduinoJson();
  if (!arduinoJson) return t.skip("ArduinoJson headers not found (set ARDUINOJSON_DIR or run pio once)"), null;
  harness ??= (async () => {
    const source = await readFile(join(CORE, "GatewayOperate.cpp"), "utf8");
    const slice = (from, to, inclusiveEnd = false) => {
      const start = source.indexOf(from);
      assert.notEqual(start, -1, `missing ${from}`);
      const end = source.indexOf(to, start);
      assert.notEqual(end, -1, `missing ${to}`);
      return source.slice(start, end + (inclusiveEnd ? to.length : 0));
    };
    const encode = slice("String encodePathSegment(", "\nbool ok(");
    const okFn = slice("bool ok(int code)", "\n", true);
    const remedy = slice("String remedyFor(int code) {", "\n}\n", true);
    const stateLock = slice("struct StateLock {", "\n};", true);
    const methods = slice("bool GatewayClient::responseInFlight() const {", "// ---------------------------------------------------------------------------------------------\n// Approvals");
    const code = `
#include <cassert>
#include <cstdio>
#include <iostream>
#include <sstream>
#include <ArduinoJson.h>
#include "OperateModel.h"

static uint32_t gNow = 1000;
uint32_t millis() { return gNow; }
${okFn}
${remedy}
${encode}

struct GatewayClient {
  struct { String environmentId = "env"; String threadId = "thread"; } context_;
  ThreadResponse response_;
  ResponseStream responseStream_;
  bool responseOpen_ = false;
  uint32_t responseGeneration_ = 0;
  String responseAfter_;
  uint32_t nextDisplayAt_ = 0;
  int lockDepth = 0;
  std::string hook;
  void lockState() { ++lockDepth; }
  void unlockState() { assert(lockDepth > 0); --lockDepth; }
  void touch() {}
  int request(const char* method, const char* path, const String& body, String& response);
  bool responseInFlight() const;
  void openResponse(const String& after);
  void closeResponse();
  size_t copyResponseStream(char* out, size_t capacity, bool* complete = nullptr, bool* truncated = nullptr);
  bool fetchResponsePage(int page);
};
${stateLock}

// The wire. The gateway answers over the pipe; the reply is read BEFORE the hook runs and the hook
// runs BEFORE the caller sees it, which is exactly the window in which the real request() has
// released the state lock and the console or a dispatch can change the response under it.
int GatewayClient::request(const char* method, const char* path, const String& body, String& response) {
  assert(std::string(method) == "GET");
  assert(lockDepth > 0);
  std::printf("REQ %s\\n", path); std::fflush(stdout);
  std::string reply;
  std::getline(std::cin, reply);
  std::istringstream parse(reply);
  std::string tag; int status = 0; parse >> tag >> status;
  assert(tag == "RES");
  std::string json; parse.get(); std::getline(parse, json);
  response = String(json);
  const std::string pending = hook; hook.clear();
  if (pending == "close") closeResponse();
  if (pending == "reopen") { closeResponse(); openResponse(""); }
  return status;
}
${methods}

static std::string hex(const std::string& value) {
  if (value.empty()) return "-";
  static const char* digits = "0123456789abcdef"; std::string out;
  for (unsigned char c : value) { out += digits[c >> 4]; out += digits[c & 15]; }
  return out;
}

static void report(GatewayClient& c, int ok, const char* copyLabel = nullptr, size_t copyCapacity = 0) {
  if (copyLabel) {
    char small[64]; bool dc = false, dt = false;
    const size_t n = c.copyResponseStream(small, copyCapacity, &dc, &dt);
    std::printf("COPY n=%zu truncated=%d text=%s terminator=%d\\n", n, dt ? 1 : 0, hex(std::string(small, n)).c_str(), small[n] == 0 ? 1 : 0);
  }
  char text[4096]; bool complete = false, truncated = false;
  const size_t bytes = c.copyResponseStream(text, sizeof(text), &complete, &truncated);
  std::string joined;
  for (size_t i = 0; i < c.response_.lineCount; ++i) { if (i) joined += '\\n'; joined += c.response_.lines[i]; }
  std::printf("STATE ok=%d open=%d inflight=%d state=%s retryPending=%d retryPage=%d nextAt=%u consumed=%u bytes=%zu truncated=%d complete=%d id=%s text=%s lines=%s generation=%u\\n",
    ok, c.responseOpen_ ? 1 : 0, c.responseInFlight() ? 1 : 0, c.response_.state.c_str(), c.response_.retryPending ? 1 : 0,
    c.response_.retryPage, (unsigned)c.nextDisplayAt_, (unsigned)c.responseStream_.consumed, bytes, truncated ? 1 : 0, complete ? 1 : 0,
    hex(c.responseStream_.messageId.c_str()).c_str(), hex(std::string(text, bytes)).c_str(), hex(joined).c_str(), (unsigned)c.responseGeneration_);
  std::fflush(stdout);
}

int main() {
  GatewayClient c;
  std::string line;
  while (std::getline(std::cin, line)) {
    std::istringstream in(line); std::string cmd; in >> cmd;
    if (cmd == "OPEN") { std::string after, hook; in >> after >> hook; if (after == "-") after.clear(); c.hook = hook == "-" ? "" : hook; c.openResponse(String(after)); report(c, 1); }
    else if (cmd == "FETCH") { int page = 0; std::string hook; in >> page >> hook; c.hook = hook == "-" ? "" : hook; const bool ok = c.fetchResponsePage(page); report(c, ok ? 1 : 0); }
    else if (cmd == "CLOSE") { c.closeResponse(); report(c, 1); }
    else if (cmd == "ADVANCE") { unsigned ms = 0; in >> ms; gNow += ms; }
    else if (cmd == "COPY") { size_t cap = 0; in >> cap; report(c, 1, "copy", cap); }
    else if (cmd == "QUIT") break;
  }
  assert(c.lockDepth == 0); // every exit of every read released the state lock it took
  return 0;
}
`;
    return (await compile(code, { arduinoJson })).executable;
  })();
  return harness;
}

function unhex(value) {
  return value === "-" ? "" : Buffer.from(value, "hex").toString("utf8");
}

function parseFields(rest) {
  const fields = Object.fromEntries(rest.split(" ").map((pair) => {
    const at = pair.indexOf("=");
    return [pair.slice(0, at), pair.slice(at + 1)];
  }));
  const state = {};
  for (const [key, value] of Object.entries(fields)) {
    state[key] = ["id", "text", "lines"].includes(key) ? unhex(value) : /^\d+$/u.test(value) ? Number(value) : value;
  }
  return state;
}

// Spawns the compiled firmware and plays the gateway for it.
async function session(t, serve) {
  const executable = await buildHarness(t);
  if (!executable) return null;
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const requests = [];
  let waiting = null;
  const pending = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line.startsWith("REQ ")) {
      const path = line.slice(4);
      const result = serve(path, requests.length);
      requests.push({ path, params: new URL(path, "http://gateway").searchParams, result });
      const body = typeof result.body === "string" ? result.body : JSON.stringify(result.body ?? {});
      child.stdin.write(`RES ${result.status ?? 200} ${body}\n`);
    } else if (line.startsWith("STATE ")) {
      const state = parseFields(line.slice(6));
      if (waiting) { const resolve = waiting; waiting = null; resolve(state); } else pending.push(state);
    } else if (line.startsWith("COPY ")) {
      pending.copy = parseFields(line.slice(5));
    }
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const driver = {
    requests,
    async send(command) {
      const answer = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no STATE for "${command}" (stderr: ${stderr})`)), 10_000);
        waiting = (state) => { clearTimeout(timer); resolve(state); };
      });
      const before = requests.length;
      child.stdin.write(`${command}\n`);
      const state = await answer;
      state.reads = requests.length - before;
      if (command.startsWith("COPY")) state.copy = pending.copy;
      return state;
    },
    async finish() {
      child.stdin.write("QUIT\n");
      const code = await exited;
      assert.equal(code, 0, `firmware harness failed: ${stderr}`);
    },
  };
  return driver;
}

const MESSAGE_AT = "2026-10-30T10:00:00.000Z";
function threadOf(id, text, streaming = false, extra = {}) {
  return { id: "thread", status: streaming ? "running" : "idle", messages: [{ id, role: "assistant", text, streaming, createdAt: MESSAGE_AT, ...extra }] };
}

// The query handling of GET /v1/device/thread-output in src/app.mjs, restated only as far as the
// parameters go (the route is not importable); everything they feed is the real builder, including
// the fingerprint comparison. The first test below pins this restatement to the route's source so it
// cannot drift unnoticed.
//
// `mutate(body, index, path)` lets a test make the gateway behave like an older or misbehaving one.
function gateway(current, { mutate } = {}) {
  return (path, index) => {
    const params = new URL(path, "http://gateway").searchParams;
    const page = Number.parseInt(params.get("page") ?? "0", 10);
    const after = params.get("after") || null;
    const streamMessageId = params.get("streamMessageId") || null;
    const offsetText = params.get("streamOffset");
    if (offsetText !== null && !/^\d{1,7}$/u.test(offsetText)) return { status: 400, body: { error: "streamOffset must be a non-negative integer." } };
    const fingerprintText = params.get("streamFingerprint");
    const streamCursor = streamMessageId
      ? {
          messageId: streamMessageId,
          offset: offsetText ? Number.parseInt(offsetText, 10) : 0,
          ...(fingerprintText !== null ? { fingerprint: fingerprintText.slice(0, DEVICE_RESPONSE_STREAM_FINGERPRINT_LENGTH + 1) } : {}),
        }
      : null;
    const body = buildDeviceThreadOutput({ thread: current(), page, after, streamCursor });
    mutate?.(body, index, path);
    return { status: 200, body };
  };
}

// What an older gateway sends: a stream block with no fingerprint.
const withoutFingerprint = (body) => { delete body.response.stream.fingerprint; };

const ascii = (length, seed = "abcdefghij") => Array.from({ length }, (_, i) => seed[i % seed.length]).join("");
const streamParams = (request) => [request.params.get("streamMessageId"), request.params.get("streamOffset")];

test("first read sends no cursor, then only the tail is requested and received", async (t) => {
  let thread = threadOf("a:b/c d", "Hello", true);
  const d = await session(t, gateway(() => thread));
  if (!d) return;
  const after = "2026-10-30T09:00:00.000Z";

  let state = await d.send(`OPEN ${after}`);
  assert.equal(d.requests[0].path, `/v1/device/thread-output?page=0&after=${encodeURIComponent(after)}`, "a first read is byte-identical to the pre-stream request");
  assert.equal(state.text, "Hello");
  assert.equal(state.consumed, 5);
  assert.equal(state.id, "a:b/c d");
  assert.equal(state.complete, 0);
  assert.equal(state.inflight, 1);

  thread = threadOf("a:b/c d", "Hello wor", true);
  state = await d.send("FETCH 0");
  assert.equal(state.reads, 1);
  assert.deepEqual(streamParams(d.requests[1]), ["a:b/c d", "5"], "message id round-trips percent-encoding and the cursor is the held count");
  assert.match(d.requests[1].path, /&after=.*&streamMessageId=a%3Ab%2Fc%20d&streamOffset=5&streamFingerprint=[0-9a-f]{16}$/u);
  assert.equal(d.requests[1].params.get("streamFingerprint"), fingerprintStreamText("Hello"));
  assert.equal(d.requests[1].result.body.response.stream.appended, " wor", "the gateway sent only the new text");
  assert.equal(state.text, "Hello wor");
  assert.equal(state.consumed, 9);

  thread = threadOf("a:b/c d", "Hello world", false);
  state = await d.send("FETCH 0");
  assert.equal(d.requests[2].result.body.response.stream.appended, "ld");
  assert.equal(state.text, "Hello world");
  assert.equal(state.complete, 1);
  assert.equal(state.inflight, 0, "polling stops once the gateway says the turn settled");
  assert.match(state.lines, /Hello world/u, "the paged lines are untouched");
  const transferred = d.requests.reduce((sum, r) => sum + r.result.body.response.stream.appended.length, 0);
  assert.equal(transferred, "Hello world".length, "every character crossed the wire exactly once");
  await d.finish();
});

test("a device several polls behind catches up in bounded reads and advances by what it received", async (t) => {
  const full = ascii(900);
  let thread = threadOf("m1", full, true);
  const d = await session(t, gateway(() => thread));
  if (!d) return;

  let state = await d.send("OPEN -");
  assert.equal(state.reads, 2, "512 then 388: one call catches up instead of waiting for another poll");
  assert.deepEqual(d.requests.map(streamParams), [[null, null], ["m1", "512"]]);
  assert.deepEqual(d.requests.map((r) => r.result.body.response.stream.appended.length), [512, 388], "each poll is bounded to 512 characters, the cursor advanced by 512 not by total");
  assert.equal(state.text, full);
  assert.equal(state.consumed, 900);
  assert.equal(state.complete, 0, "caught up but the turn is still streaming");

  thread = threadOf("m1", full, false);
  state = await d.send("FETCH 0");
  assert.equal(state.reads, 1);
  assert.equal(state.complete, 1);
  assert.equal(state.inflight, 0);
  await d.finish();
});

test("retention is bounded at the display ceiling and the cursor stays honest past it, each character downloaded once", async (t) => {
  const full = ascii(2000);
  let thread = threadOf("m1", full, true);
  const d = await session(t, gateway(() => thread));
  if (!d) return;

  let state = await d.send("OPEN -");
  assert.equal(state.reads, 3, "three chunks fill the buffer; the read loop stops rather than chasing text it cannot keep");
  assert.deepEqual(d.requests.map(streamParams), [[null, null], ["m1", "512"], ["m1", "1024"]]);
  assert.equal(state.bytes, CAP_BYTES);
  assert.equal(state.text, full.slice(0, CAP_BYTES));
  assert.equal(state.truncated, 1);
  assert.equal(state.consumed, 1536, "the cursor is what was received, never the gateway total (the fingerprint could not match a jump)");
  assert.equal(state.complete, 0);

  thread = threadOf("m1", full, false);
  state = await d.send("FETCH 0");
  assert.equal(state.reads, 1);
  assert.deepEqual(streamParams(d.requests[3]), ["m1", "1536"]);
  assert.equal(state.consumed, 2000);
  assert.equal(state.text, full.slice(0, CAP_BYTES), "retained text is still just the bounded prefix");
  assert.equal(state.complete, 1);
  assert.equal(state.inflight, 0);
  const downloaded = d.requests.reduce((sum, r) => sum + r.result.body.response.stream.appended.length, 0);
  assert.equal(downloaded, 2000, "every character crossed the wire exactly once, including the ones discarded");
  await d.finish();
});

test("reset replaces: a different message never inherits the previous message's text", async (t) => {
  let thread = threadOf("m1", "The first reply is long enough to matter", true);
  const d = await session(t, gateway(() => thread));
  if (!d) return;
  let state = await d.send("OPEN -");
  assert.equal(state.text, "The first reply is long enough to matter");

  thread = threadOf("m2", "Fresh", true);
  state = await d.send("FETCH 0");
  assert.deepEqual(streamParams(d.requests[1]), ["m1", "40"]);
  assert.equal(d.requests[1].result.body.response.stream.reset, true, "precondition: the real gateway flagged the reset");
  assert.equal(state.text, "Fresh");
  assert.equal(state.id, "m2");
  assert.equal(state.consumed, 5);
  assert.ok(!state.text.includes("first"));
  await d.finish();
});

test("reset replaces: a same-id rewrite that shrinks is not appended to", async (t) => {
  let thread = threadOf("m1", "ABCDEFGHIJ", true);
  const d = await session(t, gateway(() => thread));
  if (!d) return;
  await d.send("OPEN -");

  // T3 sends absolute text for a native v2 update: the message was rewritten shorter.
  thread = threadOf("m1", "XYZ", true);
  const state = await d.send("FETCH 0");
  assert.equal(d.requests[1].result.body.response.stream.reset, true);
  assert.equal(state.text, "XYZ");
  assert.notEqual(state.text, "ABCDEFGHIJXYZ");
  assert.equal(state.consumed, 3);

  // ...and the stream carries on appending from the rewritten text afterwards.
  thread = threadOf("m1", "XYZ more", true);
  const next = await d.send("FETCH 0");
  assert.deepEqual(streamParams(d.requests[2]), ["m1", "3"]);
  assert.equal(next.text, "XYZ more");
  await d.finish();
});

test("a gateway with no stream object keeps working exactly as before", async (t) => {
  const thread = threadOf("m1", "Hello there", true);
  const d = await session(t, gateway(() => thread, { mutate: (body) => { delete body.response.stream; } }));
  if (!d) return;

  let state = await d.send("OPEN -");
  assert.equal(state.ok, 1);
  assert.match(state.lines, /Hello there/u);
  assert.equal(state.bytes, 0, "nothing retained without a stream block");
  assert.equal(state.consumed, 0);
  assert.equal(state.inflight, 1);
  state = await d.send("FETCH 0");
  assert.equal(state.reads, 1);
  assert.ok(d.requests.every((r) => r.path === "/v1/device/thread-output?page=0"), "no stream parameters are ever sent to it");
  await d.finish();
});

test("a non-object stream, a null message and a gateway downgrade drop retained text instead of trusting it", async (t) => {
  let mode = "real";
  const thread = threadOf("m1", "Hello there", true);
  const real = gateway(() => thread);
  const d = await session(t, (path, index) => {
    const result = real(path, index);
    if (mode === "string") result.body.response.stream = "nope";
    if (mode === "null") result.body.response.stream = { messageId: null, offset: 0, total: 0, appended: "", complete: false, reset: true };
    return result;
  });
  if (!d) return;
  let state = await d.send("OPEN -");
  assert.equal(state.text, "Hello there");
  mode = "string";
  state = await d.send("FETCH 0");
  assert.equal(state.ok, 1);
  assert.equal(state.bytes, 0);
  assert.equal(state.consumed, 0);
  mode = "real";
  state = await d.send("FETCH 0");
  assert.equal(state.text, "Hello there", "recovers by starting from zero");
  mode = "null";
  state = await d.send("FETCH 0");
  assert.equal(state.bytes, 0);
  assert.equal(state.id, "");
  await d.finish();
});

test("copyResponseStream never hands back half a character", async (t) => {
  const thread = threadOf("m1", "a\u00e9\u20ac", false); // 1 + 2 + 3 bytes
  const d = await session(t, gateway(() => thread));
  if (!d) return;
  await d.send("OPEN -");
  for (const [capacity, expected] of [[64, "aé€"], [7, "aé€"], [6, "aé"], [5, "aé"], [4, "aé"], [3, "a"], [2, "a"], [1, ""]]) {
    const state = await d.send(`COPY ${capacity}`);
    assert.equal(state.copy.text, expected, `capacity ${capacity}`);
    assert.equal(state.copy.terminator, 1);
    assert.equal(state.copy.truncated, capacity < 7 ? 1 : 0);
  }
  await d.finish();
});

test("a transient failure keeps the retained text and cursor, backs off, and resumes from the same offset", async (t) => {
  let thread = threadOf("m1", ascii(100), true);
  let failNext = 0;
  const real = gateway(() => thread);
  const d = await session(t, (path, index) => (failNext ? { status: failNext, body: { error: "x" } } : real(path, index)));
  if (!d) return;
  await d.send("OPEN -");

  for (const status of [503, 429]) {
    failNext = status;
    thread = threadOf("m1", ascii(150), true);
    let state = await d.send("FETCH 0");
    assert.equal(state.ok, 0);
    assert.equal(state.state, "error");
    assert.equal(state.retryPending, 1, `${status} is retried`);
    assert.equal(state.nextAt, 1000 + 3000, "the existing 3 s backoff is untouched");
    assert.equal(state.inflight, 1, "an unresolved transient failure keeps the poll alive");
    assert.equal(state.text, ascii(100), "the last good text survives");
    assert.equal(state.consumed, 100);
    failNext = 0;
    state = await d.send("FETCH 0");
    assert.equal(state.ok, 1);
    assert.deepEqual(streamParams(d.requests.at(-1)), ["m1", "100"], "resumes from the held offset");
    assert.equal(state.text, ascii(150));
    assert.equal(state.retryPending, 0);
    // reset the fixture for the next status
    thread = threadOf("m1", ascii(100), true);
    await d.send("CLOSE");
    await d.send("OPEN -");
  }

  // 400 is not transient: visibly an error, no retry loop, stream still intact.
  failNext = 400;
  const bad = await d.send("FETCH 0");
  assert.equal(bad.ok, 0);
  assert.equal(bad.retryPending, 0);
  assert.equal(bad.text, ascii(100));
  await d.finish();
});

test("a failure part-way through catching up keeps what was received and resumes at that offset", async (t) => {
  const full = ascii(1000);
  const thread = threadOf("m1", full, true);
  const real = gateway(() => thread);
  const d = await session(t, (path, index) => (index === 1 ? { status: 503, body: {} } : real(path, index)));
  if (!d) return;

  let state = await d.send("OPEN -");
  assert.equal(state.reads, 2);
  assert.equal(state.ok, 1, "openResponse has no return value; the failure is in the model");
  assert.equal(state.state, "error");
  assert.equal(state.retryPending, 1);
  assert.equal(state.text, full.slice(0, 512));
  assert.equal(state.consumed, 512);
  assert.equal(state.nextAt, 4000);

  state = await d.send("FETCH 0");
  assert.deepEqual(streamParams(d.requests.at(-1)), ["m1", "512"]);
  assert.equal(state.text, full);
  assert.equal(state.state, "streaming");
  await d.finish();
});

test("a late reply cannot touch a response that was closed or reselected while the socket was away", async (t) => {
  let reselected = false;
  const serveA = gateway(() => threadOf("mA", ascii(400), true));
  const serveB = gateway(() => threadOf("mB", "from the new thread", true));
  // A request carrying a cursor was built for the old selection; once reselected, a fresh one is B's.
  const d = await session(t, (path, index) => (new URL(path, "http://g").searchParams.has("streamMessageId") || !reselected ? serveA : serveB)(path, index));
  if (!d) return;
  let state = await d.send("OPEN -");
  assert.equal(state.consumed, 400);
  const generation = state.generation;

  // The reply (a valid extension of A) arrives after the response was closed.
  state = await d.send("FETCH 0 close");
  assert.equal(state.ok, 0);
  assert.equal(state.open, 0);
  assert.equal(state.bytes, 0, "the stale block did not repopulate a closed response");
  assert.equal(state.consumed, 0);
  assert.equal(state.id, "");
  assert.ok(state.generation > generation);

  // The reply arrives after the device moved to another thread and opened its response.
  await d.send("OPEN -");
  state = await d.send("FETCH 0");
  assert.equal(state.consumed, 400, "A is held again");
  reselected = true;
  const before = d.requests.length;
  state = await d.send("FETCH 0 reopen");
  assert.equal(state.ok, 0, "the superseded read reports failure to its caller");
  assert.equal(state.open, 1);
  assert.deepEqual(streamParams(d.requests[before]), ["mA", "400"], "precondition: the in-flight read carried A's cursor");
  assert.equal(d.requests[before + 1].params.has("streamMessageId"), false, "the reselected response starts without a cursor");
  assert.equal(state.id, "mB");
  assert.equal(state.text, "from the new thread", "B holds only B: nothing from A was appended, replaced or reset onto it");
  assert.equal(state.consumed, "from the new thread".length);
  await d.finish();
});

test("opening, closing and the state lock stay balanced across every path above", async (t) => {
  // The harness asserts lockDepth == 0 when it exits; this drives the failure exits explicitly.
  const real = gateway(() => threadOf("m1", ascii(50), true));
  let mode = "ok";
  const d = await session(t, (path, index) => (mode === "garbage" ? { status: 200, body: "not json" } : mode === "empty" ? { status: 200, body: {} } : real(path, index)));
  if (!d) return;
  await d.send("OPEN -");
  mode = "garbage";
  let state = await d.send("FETCH 0");
  assert.equal(state.ok, 0);
  assert.equal(state.retryPending, 1);
  assert.equal(state.text, ascii(50), "undecodable bodies do not disturb retained text");
  mode = "empty";
  state = await d.send("FETCH 0");
  assert.equal(state.ok, 0);
  assert.equal(state.text, ascii(50));
  mode = "ok";
  state = await d.send("FETCH 0");
  assert.equal(state.ok, 1);
  assert.equal(state.text, ascii(50));
  await d.finish();
});

// ---------------------------------------------------------------------------------------------
// Fingerprint echo, against the real builder
// ---------------------------------------------------------------------------------------------

test("the route restatement above still matches src/app.mjs", async () => {
  const route = await readFile("src/app.mjs", "utf8");
  assert.match(route, /url\.searchParams\.get\("streamFingerprint"\)/u);
  assert.match(route, /streamFingerprintText\.slice\(0, DEVICE_RESPONSE_STREAM_FINGERPRINT_LENGTH \+ 1\)/u);
  assert.match(route, /\/\^\\d\{1,7\}\$\/u\.test\(streamOffsetText\)/u);
});

test("the fingerprint is stored with the text, echoed, and replaced by every block", async (t) => {
  let thread = threadOf("m1", "Hello", true);
  const d = await session(t, gateway(() => thread));
  if (!d) return;

  await d.send("OPEN -");
  assert.equal(d.requests[0].params.has("streamFingerprint"), false, "nothing is held yet, so nothing is claimed");
  assert.match(d.requests[0].result.body.response.stream.fingerprint, new RegExp(`^[0-9a-f]{${DEVICE_RESPONSE_STREAM_FINGERPRINT_LENGTH}}$`, "u"));

  thread = threadOf("m1", "Hello wor", true);
  let state = await d.send("FETCH 0");
  assert.equal(d.requests[1].params.get("streamFingerprint"), fingerprintStreamText("Hello"), "the digest the gateway gave for the text now held");
  assert.equal(d.requests[1].result.body.response.stream.reset, false, "the real gateway verified it and agreed");
  assert.equal(state.text, "Hello wor");

  thread = threadOf("m1", "Hello world", false);
  state = await d.send("FETCH 0");
  assert.equal(d.requests[2].params.get("streamFingerprint"), fingerprintStreamText("Hello wor"), "the LATEST digest, not the first");
  assert.equal(d.requests[2].result.body.response.stream.reset, false);
  assert.equal(state.text, "Hello world");
  assert.equal(state.complete, 1);
  await d.finish();
});

test("a rewritten prefix comes back as reset and is replaced, never appended to", async (t) => {
  let thread = threadOf("m1", "ABCDEFGHIJ", true);
  const d = await session(t, gateway(() => thread));
  if (!d) return;
  await d.send("OPEN -");

  // Same id, same-or-greater length, different characters inside what the device holds: length
  // cannot see this. Only the fingerprint can.
  thread = threadOf("m1", "ABCXEFGHIJKL", true);
  const state = await d.send("FETCH 0");
  assert.equal(d.requests[1].result.body.response.stream.reset, true, "precondition: the real gateway found the held prefix rewritten");
  assert.equal(d.requests[1].result.body.response.stream.offset, 0);
  assert.equal(state.text, "ABCXEFGHIJKL");
  assert.notEqual(state.text, "ABCDEFGHIJKL", "old prefix + new suffix is exactly the corruption this prevents");
  assert.equal(state.consumed, 12);

  thread = threadOf("m1", "ABCXEFGHIJKL more", true);
  await d.send("FETCH 0");
  assert.equal(d.requests[2].params.get("streamFingerprint"), fingerprintStreamText("ABCXEFGHIJKL"), "the new digest is what is echoed next");
  assert.equal(d.requests[2].result.body.response.stream.reset, false);
  await d.finish();
});

test("CONTROL: with the echo removed the same rewrite is spliced, so the previous test is not passing by accident", async (t) => {
  let thread = threadOf("m1", "ABCDEFGHIJ", true);
  const inner = gateway(() => thread);
  // The request is edited on its way to the real gateway: everything else about it is identical.
  const d = await session(t, (path, index) => inner(path.replace(/&streamFingerprint=[^&]*/u, ""), index));
  if (!d) return;
  await d.send("OPEN -");
  thread = threadOf("m1", "ABCXEFGHIJKL", true);
  const state = await d.send("FETCH 0");
  assert.equal(d.requests[1].result.body.response.stream.reset, false, "without the digest the real gateway cannot see the rewrite");
  assert.equal(state.text, "ABCDEFGHIJKL", "old prefix + new suffix: the corruption");
  await d.finish();
});

test("an older gateway that sends no fingerprint still works, unverified, exactly as before", async (t) => {
  let thread = threadOf("m1", "Hello", true);
  const d = await session(t, gateway(() => thread, { mutate: withoutFingerprint }));
  if (!d) return;
  await d.send("OPEN -");
  thread = threadOf("m1", "Hello world", true);
  const state = await d.send("FETCH 0");
  assert.deepEqual(streamParams(d.requests[1]), ["m1", "5"]);
  assert.equal(d.requests[1].params.has("streamFingerprint"), false, "nothing to echo, so nothing sent");
  assert.equal(state.text, "Hello world");
  await d.finish();
});

test("a fingerprint that cannot be held means no cursor: the device refetches instead of sending a stale or truncated one", async (t) => {
  const thread = threadOf("m1", ascii(900), true);
  const d = await session(t, gateway(() => thread, { mutate: (body) => { body.response.stream.fingerprint = "f".repeat(DEVICE_RESPONSE_STREAM_FINGERPRINT_LENGTH + 4); } }));
  if (!d) return;

  let state = await d.send("OPEN -");
  assert.equal(state.reads, 1, "no cursor, so no catch-up loop that would restart from zero");
  assert.equal(state.text, ascii(512), "what was received is kept");
  state = await d.send("FETCH 0");
  for (const request of d.requests) {
    assert.equal(request.params.has("streamMessageId"), false);
    assert.equal(request.params.has("streamOffset"), false);
    assert.equal(request.params.has("streamFingerprint"), false, "never a stale, empty or truncated fingerprint");
  }
  assert.equal(state.text, ascii(512), "the refetch replaced the text from this response; it did not splice onto it");
  assert.equal(state.consumed, 512);
  await d.finish();
});

test("a gateway that stops fingerprinting mid-message is not trusted to extend the text", async (t) => {
  let thread = threadOf("m1", "Hello", true);
  const d = await session(t, gateway(() => thread, { mutate: (body, index) => { if (index >= 1) withoutFingerprint(body); } }));
  if (!d) return;
  await d.send("OPEN -");
  thread = threadOf("m1", "Hello there", true);
  let state = await d.send("FETCH 0");
  assert.equal(state.bytes, 0, "held text dropped rather than extended by an unverified block");
  assert.equal(state.consumed, 0);
  state = await d.send("FETCH 0");
  assert.equal(d.requests.at(-1).params.has("streamMessageId"), false, "the next read starts clean");
  assert.equal(state.text, "Hello there", "a block read from zero needs nothing to be verified against, so it is accepted as a fresh start");
  assert.equal(d.requests.at(-1).params.has("streamFingerprint"), false);
  await d.finish();
});

test("fingerprint survives catch-up reads and a failure part-way through, and resumes with the last good digest", async (t) => {
  const full = ascii(1000);
  const thread = threadOf("m1", full, true);
  const inner = gateway(() => thread);
  const d = await session(t, (path, index) => (index === 1 ? { status: 503, body: {} } : inner(path, index)));
  if (!d) return;

  let state = await d.send("OPEN -");
  assert.equal(state.consumed, 512);
  state = await d.send("FETCH 0");
  assert.equal(d.requests[2].params.get("streamFingerprint"), fingerprintStreamText(full.slice(0, 512)), "the failed read changed nothing, so the same digest is resent");
  assert.equal(d.requests[2].result.body.response.stream.reset, false);
  assert.equal(state.text, full);
  await d.finish();
});

test("the empty-thread response carries a fingerprint and clears what was held", async (t) => {
  let thread = threadOf("m1", "Hello", true);
  const d = await session(t, gateway(() => thread));
  if (!d) return;
  await d.send("OPEN -");
  thread = { id: "thread", status: "idle", messages: [] };
  const state = await d.send("FETCH 0");
  assert.equal(d.requests[1].result.body.response.stream.fingerprint, fingerprintStreamText(""));
  assert.equal(d.requests[1].result.body.response.stream.reset, true);
  assert.equal(state.bytes, 0);
  assert.equal(state.id, "");
  await d.finish();
});

// ---------------------------------------------------------------------------------------------
// Chunk boundaries and termination, against the real builder
// ---------------------------------------------------------------------------------------------

test("the real gateway backs a chunk off a surrogate pair, so the device counts and stores it whole", async (t) => {
  const text = `${"\u00e9".repeat(150)}a${"\u{1F600}".repeat(200)}tail`;
  assert.equal(text.charCodeAt(511) >= 0xd800 && text.charCodeAt(511) < 0xdc00, true, "precondition: unit 511 is a high surrogate");
  const thread = threadOf("m1", text, false);
  const d = await session(t, gateway(() => thread));
  if (!d) return;
  const state = await d.send("OPEN -");
  assert.equal(d.requests[0].result.body.response.stream.appended.length, 511, "a chunk may be 511 characters, never more than 512");
  assert.equal(d.requests[1].params.get("streamOffset"), "511");
  assert.equal(state.text, text, "byte-for-byte equal");
  assert.equal(state.consumed, text.length, "the cursor is in UTF-16 units, not bytes");
  assert.ok(Buffer.byteLength(text) > text.length);
  assert.equal(state.complete, 1);
  await d.finish();
});

test("DEFENSIVE: an older gateway that DOES split a pair is still counted correctly (the dangling half is not stored)", async (t) => {
  // The real builder no longer produces this chunk, so it is manufactured: an older gateway with no
  // fingerprint, whose first chunk runs to the full 512 units and ends on a high surrogate.
  const text = `${"\u00e9".repeat(150)}a${"\u{1F600}".repeat(200)}tail`;
  const thread = threadOf("m1", text, false);
  const d = await session(t, gateway(() => thread, {
    mutate: (body, index) => {
      withoutFingerprint(body);
      if (index === 0) {
        body.response.stream.appended = text.slice(0, 512);
        assert.equal(body.response.stream.appended.charCodeAt(511) >= 0xd800 && body.response.stream.appended.charCodeAt(511) < 0xdc00, true);
      }
    },
  }));
  if (!d) return;
  const state = await d.send("OPEN -");
  assert.equal(d.requests[0].result.body.response.stream.appended.length, 512, "precondition: the split chunk really was sent");
  assert.equal(d.requests[1].params.get("streamOffset"), "511", "the decoder dropped the dangling half, so the device did not count it and asks for the whole pair again");
  assert.equal(state.text, text);
  assert.equal(state.consumed, text.length);
  await d.finish();
});

test("a long reply terminates: polls driven like runCycle stop when the turn settles, each character crosses the wire once, and the prefix is verified against the final text", async (t) => {
  const finalText = ascii(4200);
  let grown = 0;
  let settled = false;
  const thread = () => threadOf("m1", finalText.slice(0, grown), !settled);
  const d = await session(t, gateway(thread));
  if (!d) return;

  grown = 700;
  let state = await d.send("OPEN -");
  let polls = 0;
  while (state.inflight && polls < 40) {
    polls += 1;
    grown = Math.min(finalText.length, grown + 700);
    settled = grown === finalText.length;
    state = await d.send("FETCH 0");
  }
  assert.ok(polls < 40, "the poll loop ended");
  assert.equal(state.inflight, 0);
  assert.equal(state.state, "complete");
  assert.equal(state.text, finalText.slice(0, CAP_BYTES), "the retained prefix equals the final reply's prefix");
  assert.equal(state.truncated, 1);

  // Each character at most once: every request starts exactly where the previous block ended.
  let expectedOffset = 0;
  for (const request of d.requests) {
    const stream = request.result.body.response.stream;
    assert.equal(stream.reset, false, "no spurious resets");
    assert.equal(stream.offset, expectedOffset);
    expectedOffset = stream.offset + stream.appended.length;
    assert.ok(stream.appended.length <= DEVICE_RESPONSE_STREAM_CHUNK);
  }
  const downloaded = d.requests.reduce((sum, r) => sum + r.result.body.response.stream.appended.length, 0);
  assert.equal(downloaded, expectedOffset);
  assert.ok(downloaded <= finalText.length);
  assert.deepEqual(d.requests.map((r) => r.result.body.response.state).filter((x) => x !== "streaming" && x !== "complete"), []);
  assert.equal(d.requests.at(-1).result.body.response.state, "complete", "the last poll is the one that saw the turn settle");
  assert.ok(d.requests.slice(0, -1).every((r) => r.result.body.response.state === "streaming"), "no request was made after it");
  await d.finish();
});

test("a settled reply far longer than the buffer stops after one catch-up call with a verified prefix and no endless polling", async (t) => {
  const finalText = ascii(6000);
  const thread = threadOf("m1", finalText, false);
  const d = await session(t, gateway(() => thread));
  if (!d) return;
  const state = await d.send("OPEN -");
  assert.equal(state.reads, 3, "the buffer fills on the third read and the loop stops");
  assert.equal(state.inflight, 0, "the turn is settled, so the existing rule stops polling");
  assert.equal(state.text, finalText.slice(0, CAP_BYTES));
  assert.equal(state.truncated, 1);
  assert.equal(state.consumed, 1536);
  assert.equal(state.complete, 0, "complete means every character is held; a truncated stream never claims that");
  await d.finish();
});
