import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// HOSYOND_UI_PROFILE (firmware/shared/NextCoderCore/src/UiProfile.h) is the one switch for every
// piece of UI/render measurement: [frame-split], [touch-funnel], [content-split], [blit-split] and
// [orb-split], their accounting as well as their printing. It must be OFF in a release image, and
// it must come on by itself with TLS_SESSION_DIAGNOSTICS (the bench image) so
// scripts/measure-device-latency.mjs keeps every line it parses.
//
// HOW THIS GUARD WORKS, and why it is not "build the firmware and run strings":
// the release ELF is the thing that matters, but producing it needs PlatformIO and a ~300 MB
// toolchain download, which this repository's credential-free test run does not have (and a stale
// .pio/ ELF would make the verdict depend on whatever someone built last). So this runs the REAL
// C preprocessor, at the default settings, over the REAL sources -- ui.cpp, display.cpp,
// ui_content_job.h, OrbPainter.cpp, ThinkingOrb.cpp -- with their #include lines removed (the
// Arduino/ESP-IDF headers are not on a host) and the shared UiProfile/OrbProfile headers
// prepended. Whatever survives preprocessing is exactly what the compiler would see, so a marker
// or an accumulator that reaches it WOULD reach the image. A control run with the flag on proves
// the check is not vacuous. Then the shared sources are compiled to host objects and their symbol
// tables inspected, which is the same question asked of real object code.
//
// An optional third layer inspects an actual binary: set NEXT_CODER_RELEASE_ELF to the path of a
// built `hosyond-es3c28p-controller` firmware.elf (or .bin) and it must contain no marker.
//
//   pio run -e hosyond-es3c28p-controller &&
//   NEXT_CODER_RELEASE_ELF=firmware/Hosyond-ESP32-S3-2.8-Touchscreen/.pio/build/hosyond-es3c28p-controller/firmware.elf \
//     node --test test/firmware-ui-profile.test.mjs

const BOARD = resolve("firmware/Hosyond-ESP32-S3-2.8-Touchscreen/src");
const CORE = resolve("firmware/shared/NextCoderCore/src");
const compiler = process.env.CXX || "c++";
const haveCompiler = spawnSync(compiler, ["--version"]).error?.code !== "ENOENT";

const MARKERS = ["frame-split", "orb-split", "blit-split", "touch-funnel", "content-split"];
// Identifiers that exist only to feed those lines. If one survives preprocessing, a release frame
// is still paying for accounting nobody reads, even with every printf gone.
const ACCOUNTING = ["FrameSplit", "TouchFunnel", "touchFunnel", "BlitProbe", "blitProbe", "reportFrameSplit",
  "sampleTouchFunnel", "lastTickDurUs", "lastSleepUs", "tickExit", "lapUs", "gOrbProfile", "pendingContentCause",
  "spentUs"];

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), "next-coder-ui-profile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Just enough of the Arduino core for OrbProfile.h to be included.
  await writeFile(join(dir, "Arduino.h"), "#pragma once\n#include <stdint.h>\ninline uint32_t micros() { return 0; }\n");
  return dir;
}

// The preprocessed text of `file` as the compiler would see it, with `defines` applied.
async function preprocess(dir, file, defines) {
  const source = (await readFile(file, "utf8")).split("\n")
    .map((line) => (/^\s*#\s*include\b/u.test(line) ? "" : line)).join("\n");
  const prelude = '#include "OrbProfile.h"\n';
  const run = spawnSync(compiler, ["-E", "-P", "-std=c++17", ...defines, "-I", dir, "-I", CORE, "-x", "c++", "-"],
    { input: prelude + source, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${file}: ${run.stderr}`);
  return run.stdout;
}

const has = (text, word) => new RegExp(`(?<![A-Za-z0-9_])${word.replace(/[-]/gu, "\\-")}(?![A-Za-z0-9_])`, "u").test(text);

const RELEASE_DEFINES = [];                                      // what `pio run -e hosyond-es3c28p-controller` passes
const SOURCES = [
  [join(BOARD, "ui.cpp"), ["frame-split", "touch-funnel", "content-split", "orb-split"]],
  [join(BOARD, "display.cpp"), ["blit-split"]],
];

test("the switch resolves: off by default, on with TLS_SESSION_DIAGNOSTICS or by hand, and ORB_PROFILE follows it", async (t) => {
  if (!haveCompiler) return t.skip("Native C++ compiler unavailable");
  const dir = await workspace(t);
  const probe = `#include "OrbProfile.h"
#include <cstdio>
#define S2(x) #x
#define S(x) S2(x)
int main() {
  printf("%d %d [%s] [%s]\\n", HOSYOND_UI_PROFILE, ORB_PROFILE, S(UI_PROFILE(boom;)), S(ORB_PROBE(t0)));
}
`;
  await writeFile(join(dir, "probe.cpp"), probe);
  const resolveWith = (defines) => {
    const exe = join(dir, `probe-${defines.join("").replace(/[^A-Za-z0-9]/gu, "")}`);
    const built = spawnSync(compiler, ["-std=c++17", ...defines, "-I", dir, "-I", CORE, join(dir, "probe.cpp"), "-o", exe], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    return spawnSync(exe, [], { encoding: "utf8" }).stdout.trim();
  };
  // Default: nothing. UI_PROFILE(...) and ORB_PROBE(...) expand to no statement at all.
  assert.equal(resolveWith(RELEASE_DEFINES), "0 0 [] [((void)0)]");
  // The bench image's switch lights the whole family, the way GATEWAY_REQUEST_TIMING already does.
  assert.equal(resolveWith(["-DTLS_SESSION_DIAGNOSTICS=1"]), "1 1 [boom;] [const uint32_t t0 = micros()]");
  // By hand.
  assert.equal(resolveWith(["-DHOSYOND_UI_PROFILE=1"]), "1 1 [boom;] [const uint32_t t0 = micros()]");
  // An explicit 0 beats the bench switch, and the orb may still be overridden alone.
  assert.equal(resolveWith(["-DTLS_SESSION_DIAGNOSTICS=1", "-DHOSYOND_UI_PROFILE=0"]).slice(0, 3), "0 0");
  assert.equal(resolveWith(["-DTLS_SESSION_DIAGNOSTICS=1", "-DORB_PROFILE=0"]).slice(0, 3), "1 0");
  assert.equal(resolveWith(["-DORB_PROFILE=1"]).slice(0, 3), "0 1");
});

test("a release build's sources contain no measurement marker and no accounting after preprocessing", async (t) => {
  if (!haveCompiler) return t.skip("Native C++ compiler unavailable");
  const dir = await workspace(t);
  for (const [file] of SOURCES) {
    const out = await preprocess(dir, file, RELEASE_DEFINES);
    assert.ok(out.length > 20000, `${file}: preprocessing produced suspiciously little (${out.length} bytes)`);
    for (const marker of MARKERS) assert.ok(!out.includes(marker), `${file}: [${marker}] reaches the release image`);
    for (const word of ACCOUNTING) assert.ok(!has(out, word), `${file}: accounting \`${word}\` reaches the release image`);
  }
  // The pure header and the shared orb sources, which four boards compile.
  for (const file of [join(BOARD, "ui_content_job.h"), join(CORE, "OrbPainter.cpp"), join(CORE, "ThinkingOrb.cpp")]) {
    const out = await preprocess(dir, file, RELEASE_DEFINES);
    for (const word of ["gOrbProfile", "spentUs", "orbProfileTake"]) {
      // ORB_PROBE() and the inline `return false` stub are fine; storage and accumulation are not.
      if (word === "orbProfileTake" && !/OrbPainter/u.test(file)) continue;
      assert.ok(!has(out.replace(/inline bool orbProfileTake\(OrbProfile&\) \{ return false; \}/u, ""), word),
        `${file}: \`${word}\` reaches the release image`);
    }
    assert.ok(!/micros\s*\(\s*\)/u.test(out.replace(/inline uint32_t micros\(\) \{ return 0; \}/u, "")),
      `${file}: reads the clock for measurement in a release build`);
  }
});

test("the same preprocessing with the flag on keeps every marker, so the release check is not vacuous", async (t) => {
  if (!haveCompiler) return t.skip("Native C++ compiler unavailable");
  const dir = await workspace(t);
  for (const defines of [["-DHOSYOND_UI_PROFILE=1"], ["-DTLS_SESSION_DIAGNOSTICS=1"]]) {
    for (const [file, expected] of SOURCES) {
      const out = await preprocess(dir, file, defines);
      for (const marker of expected) assert.ok(out.includes(marker), `${defines}: ${file} lost [${marker}]`);
    }
    const ui = await preprocess(dir, join(BOARD, "ui.cpp"), defines);
    for (const word of ["FrameSplit", "TouchFunnel", "reportFrameSplit", "sampleTouchFunnel"]) assert.ok(has(ui, word), `${defines}: ui.cpp lost ${word}`);
    const orb = await preprocess(dir, join(CORE, "OrbPainter.cpp"), defines);
    assert.ok(has(orb, "gOrbProfile"), `${defines}: OrbPainter lost its accumulators`);
  }
});

test("turning measurement off keeps the optimisations and the product's [fps] line", async (t) => {
  if (!haveCompiler) return t.skip("Native C++ compiler unavailable");
  const dir = await workspace(t);
  const display = await preprocess(dir, join(BOARD, "display.cpp"), RELEASE_DEFINES);
  // ORB_BLIT_ROWS_PER_WINDOW=4 and ORB_BLIT_REACH_CLIP=1 are performance wins, not instrumentation.
  assert.match(display, /while \(n < 4 && row \+ n < drawDim\)/u, "rows-per-window default of 4 is still compiled in");
  assert.ok(has(display, "reachMemo") && display.includes("memo->reachPx = curReach"), "the reach clip is still compiled in");
  const ui = await preprocess(dir, join(BOARD, "ui.cpp"), RELEASE_DEFINES);
  assert.ok(ui.includes("[fps]"), "the pre-existing [fps] line stays unconditional");
  // The content job still budgets from the tick start: one clock read per strip boundary remains.
  assert.ok(ui.includes("tickEnterUs, kPaintBudgetUs"), "the content job's frame budget is intact");
});

test("the shared orb compiles to objects with no profile storage by default, and with it when asked", async (t) => {
  if (!haveCompiler) return t.skip("Native C++ compiler unavailable");
  if (spawnSync("nm", ["--version"]).error?.code === "ENOENT") return t.skip("nm unavailable");
  const dir = await workspace(t);
  // The host stand-in for the Arduino core that the orb A/B test already uses (it has String).
  const shim = resolve("test/fixtures/orb-ab");
  const symbols = (defines) => {
    const names = [];
    for (const name of ["OrbPainter", "ThinkingOrb"]) {
      const object = join(dir, `${name}-${defines.join("").replace(/[^A-Za-z0-9]/gu, "") || "default"}.o`);
      const built = spawnSync(compiler, ["-std=c++17", "-O2", "-c", ...defines, "-I", shim, "-I", CORE, join(CORE, `${name}.cpp`), "-o", object], { encoding: "utf8" });
      assert.equal(built.status, 0, built.stderr);
      names.push(spawnSync("nm", [object], { encoding: "utf8" }).stdout);
    }
    return names.join("\n");
  };
  // Fine as-is for any board that never sets a flag: this is what Vision Master and CrowPanel see.
  const release = symbols(RELEASE_DEFINES);
  assert.doesNotMatch(release, /gOrbProfile|orbProfileTake/u, "release orb objects carry profile symbols");
  assert.match(release, /paintOrbCoverage/u, "the painter itself is still there (the check is not vacuous)");
  assert.match(symbols(["-DHOSYOND_UI_PROFILE=1"]), /gOrbProfile/u);
});

test("an actual release binary, when one is supplied, contains no measurement marker", async (t) => {
  const elf = process.env.NEXT_CODER_RELEASE_ELF;
  if (!elf) return t.skip("set NEXT_CODER_RELEASE_ELF to a built hosyond-es3c28p-controller firmware.elf to inspect it");
  const bytes = await readFile(resolve(elf));
  assert.ok(bytes.length > 100000, "that does not look like a firmware image");
  assert.ok(bytes.includes("[fps]"), "the image should still carry the product's [fps] line (wrong file?)");
  for (const marker of MARKERS) assert.ok(!bytes.includes(marker), `${elf} contains "${marker}"`);
});
