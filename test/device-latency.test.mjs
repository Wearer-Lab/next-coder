import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  EXIT, analyze, detectPort, estimateClock, foregroundSpans, formatReport, parseArgs, parseLine, percentile,
  shapePath, splitIteration, summarize, verdict,
} from "../scripts/measure-device-latency.mjs";

const SCRIPT = resolve("scripts/measure-device-latency.mjs");

/* ---------------------------------------------------------------------- pure: parsing + stats --- */

test("serial lines of every kind the report uses parse, and noise is ignored without throwing", () => {
  assert.deepEqual(parseLine('[ncqual] {"event":"status","uptime_ms":12,"gateway":"claimed"}').body, { event: "status", uptime_ms: 12, gateway: "claimed" });
  assert.equal(parseLine("[ncqual] {oops").kind, "ncqual_garbled");
  assert.deepEqual(parseLine("[tls-heap] phase=foreground.begin internal_free=81000 internal_largest=45000"), { kind: "tls", phase: "foreground.begin", internal_free: 81000, internal_largest: 45000 });

  const gw = parseLine("[gw-timing] GET /v1/device/threads/0123456789ab code=200 conn=fresh gate=3ms dns=8ms tcp_probe=21ms connect_incl_tls=1500ms req=40ms body=2ms end=1ms total=1580ms");
  assert.equal(gw.kind, "gw");
  assert.equal(gw.path, "/v1/device/threads/:id", "ids are normalised out of the report");
  assert.equal(gw.values.conn, "fresh");
  assert.equal(gw.values.connect_incl_tls, 1500);
  const reused = parseLine("[gw-timing] GET /v1/device/threads code=200 conn=reused gate=0ms req=28ms body=1ms end=0ms total=29ms");
  assert.equal(reused.values.conn, "reused");
  assert.equal(reused.values.dns, undefined, "a reused connection has no connect stages");

  const frame = parseLine("[frame-split] frames=60 period=33.3(max 41.0) tick=5.0(max 20.5) sleep=20.0 rest=1.0 | pre=1.0(max 2.0) logic=0.1 content=2.0(max 6.0)[10] orb=3.0(max 5.0)[60] status=0.0");
  assert.equal(frame.values.frames, 60);
  assert.equal(frame.values.period_max, 41);
  assert.equal(frame.values.content_max, 6);
  const funnel = parseLine("[touch-funnel] win_ms=5000 ticks=150 painted=100 lock_skips=3 dispatched=2 age_avg_ms=1 age_max_ms=4 tick_gap_max_ms=40.0 (prev tick 10.0 [paint] + sleep 20.0 + loop-rest 10.0)");
  assert.equal(funnel.values.age_max_ms, 4);
  assert.equal(funnel.values.tick_gap_max_ms, 40);
  const blit = parseLine("[blit-split] rows_per_window=8 reach_clip=1 disc_r=40.0 frames=30 windows/frame=5.0 px/frame=9000 | blit_ms=1.50 = convert 0.50 + window 0.40 + push 0.50 + other 0.10  (wire time at 80 MHz would be 1.80)");
  assert.equal(blit.values.blit_ms, 1.5);
  assert.equal(blit.values.push_ms, 0.5);

  for (const noise of ["", "ESP-ROM:esp32s3-20210327", "[unknown] x=1", "[ncqual]"]) assert.doesNotThrow(() => parseLine(noise));
  assert.equal(parseLine("ESP-ROM:esp32s3-20210327"), null);
  assert.equal(shapePath("/v1/x?token=abc123456789"), "/v1/x", "query strings never reach a report");
});

test("percentiles are nearest-rank so they are always a value some iteration produced", () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(sorted, 0.5), 5);
  assert.equal(percentile(sorted, 0.95), 10);
  assert.equal(percentile(sorted, 0.99), 10);
  assert.equal(percentile([], 0.95), null);
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(twenty, 0.95), 19);
  const stats = summarize([1700, 2000, 1900, Number.NaN, 1800]);
  assert.deepEqual({ count: stats.count, min: stats.min, max: stats.max, mean: stats.mean, p50: stats.p50 }, { count: 4, min: 1700, max: 2000, mean: 1850, p50: 1800 });
  assert.equal(summarize([]).count, 0);
});

test("arguments are bounded and a threshold or window cannot be left unvalidated", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.scenario, "THREADS");
  assert.equal(defaults.iterations, 20);
  assert.equal(defaults.delayMs, 3000, "the scenario sets the default delay");
  assert.equal(parseArgs(["--scenario", "reply"]).delayMs, 6000);
  assert.equal(parseArgs(["--scenario", "local"]).delayMs, 500);
  assert.equal(parseArgs(["--delay", "0"]).delayMs, 0);
  for (const bad of [["--iterations", "0"], ["--iterations", "201"], ["--iterations", "1.5"], ["--iterations", "-3"], ["--delay", "60001"],
    ["--scenario", "stress"], ["--bogus"], ["--port"], ["--warmup", "20"], ["--iterations", "5", "--warmup", "5"], ["--min-reuse-ratio", "2"]]) {
    assert.throws(() => parseArgs(bad), (error) => error.exitCode === EXIT.USAGE, bad.join(" "));
  }
});

test("a port is chosen only when it is unambiguous", () => {
  assert.equal(detectPort(() => ["tty.x", "cu.usbmodem11101", "cu.Bluetooth-Incoming-Port"], () => true), "/dev/cu.usbmodem11101");
  assert.equal(detectPort(() => ["ttyACM0", "null"], () => true), "/dev/ttyACM0");
  assert.throws(() => detectPort(() => ["cu.usbmodem1", "cu.usbmodem2"], () => true), /--port/u);
  assert.throws(() => detectPort(() => ["null"], () => true), (error) => error.exitCode === EXIT.CONNECT);
});

/* ----------------------------------------------------------- pure: clock mapping and the split --- */

const OFFSET = 987_654.25; // arbitrary: the host clock is not the device clock
const record = (deviceMs, line, delay = 0) => ({ hostMs: deviceMs + OFFSET + delay, line, parsed: parseLine(line) });
const ncqual = (deviceMs, body, delay = 0) => record(deviceMs, `[ncqual] ${JSON.stringify({ ...body, t_ms: deviceMs })}`, delay);
const span = (begin, end, gw) => [
  record(begin, "[tls-heap] phase=foreground.begin internal_free=1 internal_largest=1", 1),
  ...(gw ? [record(end - 1, gw, 1)] : []),
  record(end, "[tls-heap] phase=foreground.end internal_free=1 internal_largest=1", 1),
];
const GW_FRESH = "[gw-timing] GET /v1/device/threads code=200 conn=fresh gate=0ms dns=10ms tcp_probe=30ms connect_incl_tls=1500ms req=40ms body=2ms end=1ms total=1600ms";
const GW_REUSED = "[gw-timing] GET /v1/device/threads code=200 conn=reused gate=0ms req=30ms body=1ms end=0ms total=31ms";
const iter = (i, inject, accept, settle, extra = {}) => ncqual(settle, {
  event: "latency_iter", i, scenario: "THREADS", t_inject_ms: inject, t_accept_ms: accept, t_busy_ms: accept, t_settle_ms: settle,
  accept_ms: accept - inject, busy_ms: settle - accept, total_ms: settle - inject, network: true, retries: 0, timeout: false, tick_gap_max_ms: 35, heap: 150000, screen: "Threads", ...extra,
});

function transcript({ iterations = 3, withSpans = true, finishPhase = "finished", dropLine = false } = {}) {
  const records = [ncqual(1000, { event: "latency", phase: "started", accepted: true })];
  const rows = [];
  let clock = 2000;
  for (let n = 1; n <= iterations; n += 1) {
    const inject = clock; const accept = inject + 2; const settle = accept + 40 + 1500 + 60;
    if (withSpans) records.push(...span(accept + 40, accept + 1540, n === 1 ? GW_FRESH : GW_REUSED));
    const row = iter(n, inject, accept, settle);
    rows.push(row);
    if (!(dropLine && n === 2)) records.push(row);
    clock = settle + 3000;
  }
  const totals = rows.map((row) => row.parsed.body.total_ms);
  records.push(ncqual(clock, {
    event: "latency", phase: finishPhase, reason: finishPhase === "finished" ? "completed" : "timeout", accepted: true, scenario: "THREADS",
    requested: iterations, completed: iterations, network_iterations: iterations, local_iterations: 0, step_retries: 0, elapsed_ms: clock - 1000, heap_min: 90000, tick_gap_max_ms: 40,
    total_ms: { count: iterations, min: Math.min(...totals), max: Math.max(...totals), mean: Math.round(totals.reduce((a, b) => a + b, 0) / iterations) },
    busy_ms: { count: iterations, min: 0, max: 0, mean: 0 },
  }));
  return records;
}
const OPTIONS = { scenario: "THREADS", iterations: 3, delayMs: 3000, warmup: 1, maxP95Ms: null, maxMeanMs: null, minReuseRatio: null };

test("host/device clock offset is the minimum arrival delta, and jitter above it is reported", () => {
  const records = [ncqual(100, { event: "x" }, 7), ncqual(200, { event: "x" }, 2), ncqual(300, { event: "x" }, 4)];
  const clock = estimateClock(records);
  assert.equal(clock.offset, OFFSET + 2);
  assert.equal(clock.samples, 3);
  assert.equal(clock.jitterMs, 2);
  assert.equal(clock.worstMs, 5);
  const status = [{ hostMs: 5100, parsed: parseLine('[ncqual] {"event":"status","uptime_ms":100}') }];
  assert.equal(estimateClock(status).offset, 5000, "STATUS carries the same clock as uptime_ms");
  assert.equal(estimateClock([]), null);
});

test("nested gate acquisition is one span, and gw-timing lines belong to the open span", () => {
  const records = [
    record(100, "[tls-heap] phase=foreground.begin internal_free=1 internal_largest=1"),
    record(110, "[tls-heap] phase=foreground.begin internal_free=1 internal_largest=1"), // recursive re-take
    record(150, GW_REUSED),
    record(160, "[tls-heap] phase=foreground.end internal_free=1 internal_largest=1"),
    record(180, "[tls-heap] phase=foreground.end internal_free=1 internal_largest=1"),
    record(190, GW_FRESH), // outside any span: ignored
    record(300, "[tls-heap] phase=foreground.begin internal_free=1 internal_largest=1"), // never ends: dropped
  ];
  const spans = foregroundSpans(records, { offset: OFFSET });
  assert.equal(spans.length, 1);
  assert.equal(spans[0].beginMs, 100);
  assert.equal(spans[0].endMs, 180);
  assert.equal(spans[0].requests.length, 1);
});

test("the split partitions every iteration exactly: accept + queue + network + between + tail = total", () => {
  const row = iter(1, 1000, 1003, 3000).parsed.body;
  const spans = [
    { beginMs: 900, endMs: 1100, requests: [] },        // began before the step returned: clipped to the window
    { beginMs: 1500, endMs: 2000, requests: [parseLine(GW_FRESH)] },
    { beginMs: 2200, endMs: 2800, requests: [parseLine(GW_REUSED)] },
  ];
  const split = splitIteration(row, spans);
  assert.equal(split.split, true);
  assert.equal(split.accept_ms + split.queue_ms + split.network_ms + split.between_ms + split.tail_ms, row.total_ms);
  assert.equal(split.queue_ms, 0, "the gate was already held when the step returned");
  assert.equal(split.network_ms, 97 + 500 + 600);
  assert.equal(split.between_ms, 600, "1100-1500 and 2000-2200: the gate was free while the next request was prepared");
  assert.equal(split.tail_ms, 200);
  assert.equal(split.reused, 1);
  assert.equal(split.fresh, 1);
  assert.equal(splitIteration(row, []).split, false);
});

test("analysis separates warmup, reports the split and reuse, and cross-checks the device's own totals", () => {
  const result = analyze(transcript(), OPTIONS);
  assert.equal(result.iterations.length, 3);
  assert.equal(result.iterations[0].warmup, true);
  assert.equal(result.stats.network_iterations, 2);
  assert.equal(result.stats.total_ms.min, 1602);
  assert.equal(result.stats.total_ms.max, 1602);
  assert.equal(result.stats.split_iterations, 2);
  // queue/network/tail are recovered through the clock map to within the 1 ms delivery delay injected
  for (const part of ["accept_ms", "queue_ms", "network_ms", "tail_ms"]) assert.ok(result.stats[part].count === 2, part);
  assert.ok(Math.abs(result.stats.queue_ms.mean - 40) <= 2, `queue ${result.stats.queue_ms.mean}`);
  assert.ok(Math.abs(result.stats.network_ms.mean - 1500) <= 3, `network ${result.stats.network_ms.mean}`);
  assert.ok(Math.abs(result.stats.tail_ms.mean - 60) <= 3, `tail ${result.stats.tail_ms.mean}`);
  assert.equal(result.transport.reuse_ratio, 1, "both measured iterations were served on a reused connection");
  assert.equal(result.cross_check.ok, true);
  assert.equal(result.clock.samples > 3, true);
  const text = formatReport(result, { port: "/dev/test" });
  assert.match(text, /Where it goes/u);
  assert.match(text, /reuse ratio 1/u);
});

test("a lost serial line is detected rather than silently skewing the percentiles", () => {
  const result = analyze(transcript({ iterations: 4, dropLine: true }), { ...OPTIONS, iterations: 4 });
  assert.equal(result.cross_check.ok, false);
  const decision = verdict(result, { ...OPTIONS, maxP95Ms: 100_000 });
  assert.equal(decision.code, EXIT.ABORTED);
  assert.match(formatReport(result), /serial lines were lost/u);
});

test("without request boundaries the totals stand and the split is withheld, with a reason", () => {
  const result = analyze(transcript({ withSpans: false }), OPTIONS);
  assert.equal(result.stats.total_ms.count, 2);
  assert.equal(result.stats.split_iterations, 0);
  assert.equal(result.transport.reuse_ratio, null);
  assert.ok(result.notes.some((note) => /TLS_SESSION_DIAGNOSTICS/u.test(note)));
  const decision = verdict(result, { ...OPTIONS, minReuseRatio: 0.5 });
  assert.equal(decision.code, EXIT.THRESHOLD, "an unprovable reuse claim must not pass a reuse gate");
});

test("exit status: thresholds gate, an aborted batch never passes, and a run with no network is not a measurement", () => {
  const good = analyze(transcript(), OPTIONS);
  assert.equal(verdict(good, OPTIONS).code, EXIT.OK);
  assert.equal(verdict(good, { ...OPTIONS, maxP95Ms: 2000, maxMeanMs: 2000, minReuseRatio: 0.9 }).code, EXIT.OK);
  const slow = verdict(good, { ...OPTIONS, maxP95Ms: 1000 });
  assert.equal(slow.code, EXIT.THRESHOLD);
  assert.match(slow.failures[0], /p95/u);
  assert.equal(verdict(good, { ...OPTIONS, maxMeanMs: 1000 }).code, EXIT.THRESHOLD);

  const aborted = analyze(transcript({ finishPhase: "aborted" }), OPTIONS);
  assert.equal(verdict(aborted, { ...OPTIONS, maxP95Ms: 100_000 }).code, EXIT.ABORTED);
  assert.equal(verdict(analyze([ncqual(1, { event: "status" })], OPTIONS), OPTIONS).code, EXIT.ABORTED, "no summary at all");

  const local = transcript().map((entry) => (entry.parsed?.body?.event === "latency_iter" ? { ...entry, parsed: { kind: "ncqual", body: { ...entry.parsed.body, network: false } } } : entry));
  assert.equal(verdict(analyze(local, OPTIONS), OPTIONS).code, EXIT.NO_MEASUREMENT);
});

/* -------------------------------------------------------------- end to end over a real tty (pty) --- */

// A fake board behind a pseudo-terminal, so the REAL serial path (open, raw mode, line framing, fs
// writes, CANCEL, exit codes) is exercised without hardware. The pty also catches the failure that
// matters most on the real port: if the script left the terminal in cooked mode, the line discipline
// would echo the board's own output back to it and the fake board reports ECHO on stderr.
const BOARD = String.raw`
import os, pty, sys, time, json, select
mode = sys.argv[1]
try:
    master, slave = pty.openpty()
except Exception:
    print("SKIP", flush=True); sys.exit(0)
print(os.ttyname(slave), flush=True)
T0 = time.monotonic()
def millis(): return int((time.monotonic() - T0) * 1000) + 7000
def out(text): os.write(master, (text + "\n").encode())
def nc(body):
    body["t_ms"] = millis()
    out("[ncqual] " + json.dumps(body, separators=(",", ":")))
batch = None
buf = b""
def status():
    nc({"event": "status", "uptime_ms": millis(), "heap": 150000, "wifi_connected": True, "gateway": "claimed", "ui_busy": False, "stress_active": False})
def run_iteration():
    global batch
    batch["i"] += 1
    local = batch["scenario"] == "LOCAL"
    inject = millis(); time.sleep(0.002); accept = millis()
    if not local:
        time.sleep(0.04)
        out("[tls-heap] phase=foreground.begin internal_free=100000 internal_largest=60000")
        time.sleep(0.30)
        conn = "fresh" if batch["i"] == 1 else "reused"
        out("[gw-timing] GET /v1/device/threads/0123456789ab code=200 conn=%s gate=0ms req=20ms body=3ms end=1ms total=300ms" % conn)
        out("[tls-heap] phase=foreground.end internal_free=100000 internal_largest=60000")
    time.sleep(0.02)
    settle = millis()
    if batch["i"] == 2:
        out("[frame-split] frames=60 period=33.3(max 41.0) tick=5.0(max 20.0) sleep=20.0 rest=1.0 | pre=1.0(max 2.0) content=2.0(max 6.0)[10]")
        out("[touch-funnel] win_ms=5000 ticks=150 painted=100 lock_skips=3 dispatched=2 age_avg_ms=1 age_max_ms=4 tick_gap_max_ms=40.0 (prev tick 1.0)")
        out("[blit-split] rows_per_window=8 reach_clip=1 disc_r=40.0 frames=30 windows/frame=5.0 px/frame=9000 | blit_ms=1.50 = convert 0.50 + window 0.40 + push 0.50 + other 0.10")
    total = settle - inject
    batch["totals"].append(total)
    nc({"event": "latency_iter", "i": batch["i"], "scenario": batch["scenario"], "t_inject_ms": inject, "t_accept_ms": accept, "t_busy_ms": 0 if local else accept,
        "t_settle_ms": settle, "accept_ms": accept - inject, "busy_ms": settle - accept, "total_ms": total, "network": not local, "retries": 0, "timeout": False,
        "tick_gap_max_ms": 33, "heap": 140000, "screen": "Home"})
    if mode == "stall" and batch["i"] >= 2:
        batch["frozen"] = True
        return
    if batch["i"] >= batch["n"]:
        t = batch["totals"]
        nc({"event": "latency", "phase": "finished", "reason": "completed", "accepted": True, "scenario": batch["scenario"], "requested": batch["n"], "completed": batch["n"],
            "network_iterations": 0 if local else batch["n"], "local_iterations": batch["n"] if local else 0, "step_retries": 0, "elapsed_ms": 1, "heap_min": 90000, "tick_gap_max_ms": 33,
            "total_ms": {"count": len(t), "min": min(t), "max": max(t), "mean": int(round(sum(t) / len(t)))}, "busy_ms": {"count": len(t), "min": 0, "max": 0, "mean": 0}})
        batch = None
    else:
        batch["next"] = time.monotonic() + batch["delay"]
def handle(line):
    global batch
    if line.startswith("["):
        sys.stderr.write("ECHO\n"); sys.stderr.flush(); return
    if mode in ("silent", "notbench"):
        return
    if line == "NCQUAL STATUS": status()
    elif line == "NCQUAL CANCEL":
        sys.stderr.write("CANCELLED\n"); sys.stderr.flush()
        batch = None; nc({"event": "latency", "phase": "aborted", "reason": "cancelled", "accepted": True})
    elif line.startswith("NCQUAL LATENCY "):
        _, _, scenario, n, delay = line.split()
        if mode == "old": nc({"event": "input", "phase": "invalid", "accepted": False}); return
        if mode == "refuse": nc({"event": "latency", "phase": "refused", "reason": "gateway_not_claimed", "accepted": False}); return
        nc({"event": "latency", "phase": "started", "accepted": True, "scenario": scenario, "iterations": int(n), "delay_ms": int(delay)})
        batch = {"scenario": scenario, "n": int(n), "delay": int(delay) / 1000.0, "next": time.monotonic(), "i": 0, "totals": [], "frozen": False}
last_noise = 0
while True:
    ready, _, _ = select.select([master], [], [], 0.02)
    if ready:
        try: data = os.read(master, 4096)
        except OSError: break
        if not data: break
        buf += data
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            handle(line.rstrip(b"\r").decode(errors="replace"))
    if mode == "notbench" and time.monotonic() - last_noise > 0.3:
        out("I (1234) wifi: station connected"); last_noise = time.monotonic()
    if batch and not batch["frozen"] and time.monotonic() >= batch["next"]:
        run_iteration()
`;

async function withBoard(mode, argv, { timeoutMs = 40_000 } = {}) {
  const probe = spawnSync("python3", ["-c", "import pty"]);
  if (probe.status !== 0) return { skipped: "python3 with the pty module is unavailable" };
  const board = spawn("python3", ["-I", "-c", BOARD, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let boardErr = "";
  board.stderr.on("data", (chunk) => { boardErr += chunk; });
  const path = await new Promise((resolvePath) => {
    let text = "";
    board.stdout.on("data", (chunk) => { text += chunk; const line = text.split("\n")[0]; if (text.includes("\n")) resolvePath(line.trim()); });
    board.once("exit", () => resolvePath(null));
  });
  if (!path || path === "SKIP") { board.kill(); return { skipped: "pty unavailable on this host" }; }
  try {
    const directory = await mkdtemp(join(tmpdir(), "device-latency-"));
    const out = join(directory, "result.json");
    const child = spawn(process.execPath, [SCRIPT, "--port", path, "--out", out, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const code = await new Promise((resolveCode) => child.once("exit", resolveCode));
    clearTimeout(killer);
    let written = null;
    try { written = JSON.parse(await readFile(out, "utf8")); } catch { /* absent on early failures */ }
    await rm(directory, { recursive: true, force: true });
    return { code, stdout, stderr, boardErr, written };
  } finally {
    board.kill("SIGKILL");
  }
}

test("end to end over a tty: batch, split, reuse, JSON record, and no echo of the board's own output", async (t) => {
  const run = await withBoard("normal", ["--iterations", "5", "--warmup", "1", "--delay", "60", "--json", "--connect-timeout", "10"]);
  if (run.skipped) return t.skip(run.skipped);
  assert.equal(run.code, EXIT.OK, run.stderr);
  assert.doesNotMatch(run.boardErr, /ECHO/u, "the terminal must be raw: a cooked tty would echo the board's output back to it");
  const result = JSON.parse(run.stdout);
  assert.equal(result.schema, "next-coder.device-latency.v1");
  assert.equal(result.iterations.length, 5);
  assert.equal(result.device.phase, "finished");
  assert.equal(result.stats.network_iterations, 4);
  assert.equal(result.cross_check.ok, true);
  const total = result.stats.total_ms;
  assert.ok(total.min >= 340 && total.max < 600, `total ${total.min}..${total.max}`);
  assert.ok(Math.abs(result.stats.network_ms.mean - 300) < 60, `network ${result.stats.network_ms.mean}`);
  assert.ok(Math.abs(result.stats.queue_ms.mean - 40) < 40, `queue ${result.stats.queue_ms.mean}`);
  assert.ok(result.stats.accept_ms.mean < 30);
  assert.equal(result.transport.reuse_ratio, 1, "iterations after the warmup were all served on a reused connection");
  assert.deepEqual(result.transport.paths, ["GET /v1/device/threads/:id"]);
  assert.ok(result.ui_health.frame_split && result.ui_health.touch_funnel && result.ui_health.blit_split, "periodic UI lines are carried into the record");
  assert.equal(result.ui_health.touch_funnel.age_max_ms, 4);
  assert.deepEqual(run.written.verdict, { exit_code: 0, failures: [] });
});

test("end to end: the text report and a failing threshold gate the exit status", async (t) => {
  const run = await withBoard("normal", ["--iterations", "3", "--warmup", "1", "--delay", "30", "--max-p95-ms", "100", "--connect-timeout", "10"]);
  if (run.skipped) return t.skip(run.skipped);
  assert.equal(run.code, EXIT.THRESHOLD);
  assert.match(run.stdout, /Where it goes/u);
  assert.match(run.stderr, /FAIL: p95/u);
});

test("end to end: a LOCAL batch is a measurement of the harness itself and needs no network", async (t) => {
  const run = await withBoard("normal", ["--scenario", "local", "--iterations", "4", "--warmup", "1", "--delay", "20", "--json", "--connect-timeout", "10"]);
  if (run.skipped) return t.skip(run.skipped);
  assert.equal(run.code, EXIT.OK, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.stats.network_iterations, 0);
  assert.equal(result.stats.total_ms.count, 3, "LOCAL's own total is the headline figure");
});

test("end to end: a refused command, an old image, a non-bench image and a silent port each fail distinctly", async (t) => {
  const refused = await withBoard("refuse", ["--iterations", "3", "--warmup", "1", "--connect-timeout", "10"]);
  if (refused.skipped) return t.skip(refused.skipped);
  assert.equal(refused.code, EXIT.REFUSED);
  assert.match(refused.stderr, /gateway_not_claimed/u);

  const old = await withBoard("old", ["--iterations", "3", "--warmup", "1", "--connect-timeout", "10"]);
  assert.equal(old.code, EXIT.REFUSED);
  assert.match(old.stderr, /older bench image/u);

  const notBench = await withBoard("notbench", ["--connect-timeout", "2"]);
  assert.equal(notBench.code, EXIT.CONNECT);
  assert.match(notBench.stderr, /not the bench image/u);

  const silent = await withBoard("silent", ["--connect-timeout", "2"]);
  assert.equal(silent.code, EXIT.CONNECT);
  assert.match(silent.stderr, /no answer from the board/u);
});

test("end to end: a board that stops mid-batch times out, is told to CANCEL, and the run fails", async (t) => {
  const run = await withBoard("stall", ["--iterations", "6", "--warmup", "1", "--delay", "20", "--stall-timeout", "2", "--connect-timeout", "10"]);
  if (run.skipped) return t.skip(run.skipped);
  assert.equal(run.code, EXIT.ABORTED);
  assert.match(run.stderr, /no progress/u);
  assert.match(run.boardErr, /CANCELLED/u, "the harness must be told to stop rather than left stepping the UI unattended");
});
