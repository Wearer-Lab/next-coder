import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// A/B guard for the shared orb (ThinkingOrb + OrbPainter), which four boards compile and which
// exists so that they cannot diverge. The REAL firmware sources are built on the host next to a
// frozen copy of the pre-optimisation sources (test/fixtures/orb-baseline, from git HEAD before the
// speed work) and both render every mode at four size/budget combinations and eight timestamps.
//
// Tolerances are constants here on purpose. An optimisation that is bit-identical needs none; one
// that approximates (a polynomial sin, a coarser falloff) must RAISE them in a reviewed diff, with
// the number it measured, instead of drifting the shared look silently.
const MAX_ABS_DIFF = 0;        // largest per-pixel coverage difference allowed, 0..255
const MAX_DIFF_PIXELS = 0;     // fraction of pixels allowed to differ at all, 0..1
const MAX_MEAN_ABS_DIFF = 0;   // mean absolute coverage difference over a whole buffer

const DIMS = [148, 44, 148, 64];
const MODES = ["working", "searching", "solving", "listening", "connecting", "weaving", "composing", "breathing", "shaping"];

function run(compiler, args, what) {
  const r = spawnSync(compiler, args, { encoding: "utf8" });
  assert.equal(r.status, 0, `${what}: ${r.stderr}`);
}

test("shared orb renders the same pixels as the frozen baseline in every mode and size", async (t) => {
  const compiler = process.env.CXX || "c++";
  if (spawnSync(compiler, ["--version"]).error?.code === "ENOENT") return t.skip("Native C++ compiler unavailable");
  const dir = await mkdtemp(join(tmpdir(), "next-coder-orb-ab-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ab = resolve("test/fixtures/orb-ab");
  const base = resolve("test/fixtures/orb-baseline");
  const live = resolve("firmware/shared/NextCoderCore/src");

  run(compiler, ["-std=c++17", "-O2", "-Wall", "-I", ab, "-I", base, join(base, "ThinkingOrb.cpp"), join(base, "OrbPainter.cpp"), join(ab, "dump.cpp"), "-o", join(dir, "base")], "baseline build");
  // The candidate also builds with the libm call counter, which changes no arithmetic.
  run(compiler, ["-std=c++17", "-O2", "-Wall", "-DOPCOUNT", "-include", join(ab, "opcount.h"), "-I", ab, "-I", live, join(live, "ThinkingOrb.cpp"), join(live, "OrbPainter.cpp"), join(ab, "dump.cpp"), "-o", join(dir, "cand")], "candidate build");
  run(join(dir, "base"), [join(dir, "base.bin"), join(dir, "base.txt")], "baseline run");
  run(join(dir, "cand"), [join(dir, "cand.bin"), join(dir, "cand.txt")], "candidate run (it also fails on a stale byte left by the painter)");

  const a = await readFile(join(dir, "base.bin"));
  const b = await readFile(join(dir, "cand.bin"));
  assert.equal(a.length, b.length, "same number of frames rendered");

  let off = 0, frames = 0;
  const perMode = new Map();
  while (off < a.length) {
    const hdrA = [0, 1, 2, 3, 4].map((i) => a.readInt32LE(off + 4 * i));
    const hdrB = [0, 1, 2, 3, 4].map((i) => b.readInt32LE(off + 4 * i));
    const [cfg, mode, at, dotsA] = hdrA;
    // The geometry itself must match, not just the picture: same dot and line counts.
    assert.deepEqual(hdrA, hdrB, `frame header cfg=${cfg} mode=${MODES[mode]} t=${at}`);
    const n = DIMS[cfg] * DIMS[cfg];
    off += 20;
    let maxDiff = 0, differing = 0, sum = 0, ink = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(a[off + i] - b[off + i]);
      if (d) differing++;
      if (d > maxDiff) maxDiff = d;
      sum += d;
      if (b[off + i]) ink++;
    }
    off += n;
    ++frames;
    const key = `${cfg}/${MODES[mode]}`;
    const m = perMode.get(key) || { maxDiff: 0, differing: 0, pixels: 0, sum: 0, minInk: Infinity };
    m.maxDiff = Math.max(m.maxDiff, maxDiff); m.differing += differing; m.pixels += n; m.sum += sum;
    m.minInk = Math.min(m.minInk, ink);
    perMode.set(key, m);
    assert.ok(sum / n <= MAX_MEAN_ABS_DIFF, `${key} t=${at}: mean abs diff ${sum / n}`);
    // A blank orb is a failure even if the baseline were blank too.
    assert.ok(ink > 0 && dotsA > 0, `${key} t=${at}: nothing drawn`);
  }
  assert.equal(frames, 4 * 9 * 8);
  for (const [key, m] of perMode) {
    assert.ok(m.maxDiff <= MAX_ABS_DIFF, `${key}: max coverage diff ${m.maxDiff} > ${MAX_ABS_DIFF}`);
    assert.ok(m.differing / m.pixels <= MAX_DIFF_PIXELS, `${key}: ${m.differing} differing pixels`);
  }

  // Not assertions: the per-frame work the candidate does, so a change can be judged by how much
  // of it disappears before anyone flashes a board. `home` is the Hosyond's 104 px / 640-dot orb.
  const table = (await readFile(join(dir, "cand.txt"), "utf8")).split("\n").filter((l) => l.startsWith("home "));
  t.diagnostic("per-frame averages, home orb (libm calls and splat pixels):\n" + table.join("\n"));
});
