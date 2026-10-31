import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { COMMAND_TIMEOUT_MS } from "../src/credentialStore.mjs";
import { VOICE_STARTUP_TIMEOUT_MS } from "../src/voiceRuntime.mjs";
import {
  DEFAULT_T3_START_TIMEOUT_MS,
  T3_FIRST_RUN_ALLOWANCE_MS,
  T3_PAIRING_COMMAND_TIMEOUT_MS,
  WINDOWS_CONTROL_TIMEOUT_MS,
  WINDOWS_INSPECTION_TIMEOUT_MS,
} from "../src/t3Process.mjs";

// Every budget here gates onboarding and every one of them fails CLOSED. Sizing one to a fast
// developer machine is how a slow or loaded host gets told it is broken when it is only busy:
// a cold `powershell.exe` running Add-Type measured 13.4s against a 5s budget, and an installed
// T3 took 93s to bind against a 60s budget. Both were reported to the owner as hard failures.
// A real fault does not need a short budget to surface: an exited process, a non-zero status or
// an explicit error is detected directly and returns immediately.
const FLOORS = {
  "credentialStore COMMAND_TIMEOUT_MS": [COMMAND_TIMEOUT_MS, 15_000],
  "t3Process DEFAULT_T3_START_TIMEOUT_MS": [DEFAULT_T3_START_TIMEOUT_MS, 120_000],
  "t3Process T3_FIRST_RUN_ALLOWANCE_MS": [T3_FIRST_RUN_ALLOWANCE_MS, 120_000],
  "t3Process WINDOWS_INSPECTION_TIMEOUT_MS": [WINDOWS_INSPECTION_TIMEOUT_MS, 15_000],
  "t3Process WINDOWS_CONTROL_TIMEOUT_MS": [WINDOWS_CONTROL_TIMEOUT_MS, 15_000],
  "t3Process T3_PAIRING_COMMAND_TIMEOUT_MS": [T3_PAIRING_COMMAND_TIMEOUT_MS, 60_000],
  "voiceRuntime VOICE_STARTUP_TIMEOUT_MS": [VOICE_STARTUP_TIMEOUT_MS, 180_000],
};

test("every onboarding budget clears its floor and stays bounded", () => {
  for (const [name, [value, floor]] of Object.entries(FLOORS)) {
    assert.ok(Number.isFinite(value), `${name} must be a finite bound, never an unbounded wait`);
    assert.ok(value >= floor, `${name} is ${value}ms; a loaded host needs at least ${floor}ms`);
    assert.ok(value <= 600_000, `${name} is ${value}ms; an owner should not wait ten minutes`);
  }
});

// The floors above only protect constants someone remembered to name. This catches the other
// half: a bare number written straight into a child-process call, which is how every budget in
// this file started life.
test("no connector subprocess carries a bare short timeout literal", async () => {
  // fileURLToPath, never URL.pathname: the latter stays percent-encoded and breaks on any
  // checkout under a path containing a space.
  const dir = fileURLToPath(new URL("../src/", import.meta.url));
  const offenders = [];
  for (const entry of await readdir(dir)) {
    // `._*` are macOS AppleDouble sidecars on filesystems without native extended attributes.
    if (!entry.endsWith(".mjs") || entry.startsWith("._")) continue;
    const source = await readFile(join(dir, entry), "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      if (!/execFile|spawn|exec\(/u.test(line)) continue;
      const match = line.match(/\btimeout:\s*([0-9_]+)/u);
      if (!match) continue;
      const value = Number(match[1].replace(/_/gu, ""));
      if (value < 15_000) offenders.push(`${entry}:${index + 1} timeout: ${value}`);
    }
  }
  assert.deepEqual(offenders, [], `name these as budgets and size them for a loaded host:\n${offenders.join("\n")}`);
});
