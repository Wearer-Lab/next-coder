#!/usr/bin/env node
// Unattended device-latency measurement for the Hosyond ESP32-S3 controller.
//
// It replaces "ask the owner to tap the screen while serial is captured" - unrepeatable, N=3, needs a
// human - with the firmware's own qualification harness: this script opens the board's USB serial
// port, issues ONE `NCQUAL LATENCY <scenario> <iterations> <delay_ms>` command, and the board then
// drives its real UI entry point (uiQualificationStep) N times by itself, timing each on its own
// clock. The host's job is to read the result and split it.
//
// WHAT NEEDS THE BENCH BUILD. Nothing here works against a release image. The harness is compiled in
// only by `NEXT_CODER_QUALIFICATION_BENCH=1 pio run -e hosyond-es3c28p-bench` (scripts/build_overrides.py
// refuses it in any other environment, and that gate is deliberately untouched). That build also turns
// on TLS_SESSION_DIAGNOSTICS, which is what prints the [tls-heap] foreground.begin/end lines this script
// uses to find the network inside each iteration. See --help for the flashing sequence.
//
// WHAT IT SEPARATES, per iteration, using the device clock end to end:
//
//   accept   inject -> the UI step returned (the tap decoded and the gateway job queued)
//   queue    accept -> first TLS-gate acquisition (network task wake-up + waiting behind other traffic)
//   network  time the TLS gate was held inside the window (the request itself: DNS, TCP, TLS, HTTP)
//   between  gate released between two requests of the same iteration (sequential requests)
//   tail     last gate release -> UI settled (completion callback, repaint, loop-pass quantisation)
//
// The device cannot timestamp the request boundaries (GatewayTls prints them bare), so each line is
// stamped with the host's arrival time and mapped onto the device clock using the `t_ms` field that
// every [ncqual] event carries: the minimum of (arrival - t_ms) is the offset, because transport delay
// is never negative. The residual error is the USB-CDC delivery jitter, reported as `clock.jitter_ms`
// (a few ms against a 1,700 ms request). `settle` is the first loop pass after uiTick() ran the
// completion and repainted - exact to one pass (~30 ms), not to the SPI flush; see the report notes.
//
// Exit codes (so it can gate a change):
//   0 measured, every threshold met      3 port / connect / device-not-ready failure
//   1 a --max-* / --min-* threshold failed  4 the device refused or did not understand the command
//   2 usage                              5 device aborted, timed out, or the batch did not complete
//                                        6 ran, but nothing in it touched the network (no measurement)
//
// Node built-ins only. Serial is read through a raw-mode tty stream and written with fs; there is no
// serial library in this repository and none is added. Opening the port is not supposed to reset a
// native-USB ESP32-S3, but if the host's driver pulses DTR/RTS the board reboots - the connect phase
// simply keeps asking for STATUS until the harness answers, so that costs time, not correctness.

import { closeSync, constants, createWriteStream, existsSync, openSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { ReadStream as TtyReadStream } from "node:tty";
import { pathToFileURL } from "node:url";

export const SCHEMA = "next-coder.device-latency.v1";
export const EXIT = Object.freeze({ OK: 0, THRESHOLD: 1, USAGE: 2, CONNECT: 3, REFUSED: 4, ABORTED: 5, NO_MEASUREMENT: 6 });

// Mirrors qualification.h. The firmware, not this table, is the authority; these are for defaults and
// for the host to warn before spending a run on a configuration that cannot measure anything.
export const SCENARIOS = Object.freeze({
  LOCAL: { step: 4, network: false, defaultDelayMs: 500, note: "no gateway request; noise floor of the harness itself" },
  THREADS: { step: 1, network: true, defaultDelayMs: 3000, note: "one gateway read per iteration" },
  REPLY: { step: 8, network: true, defaultDelayMs: 6000, note: "one gateway read, suppressed by the UI inside ~5 s of the last one" },
});
export const MAX_ITERATIONS = 200;
export const MAX_DELAY_MS = 60_000;
const REPLY_FRESH_MS = 5000; // kReplyFreshMs in ui.cpp
const WARM_IDLE_MS = 8000; // GATEWAY_WARM_IDLE_MS in GatewayWarm.h: past this the warm session is closed
const DEVICE_ITERATION_TIMEOUT_MS = 30_000; // kLatencyIterationTimeoutMs in qualification.cpp

/* ------------------------------------------------------------------------------ arguments --- */

export const HELP = `Usage: node scripts/measure-device-latency.mjs [options]

Drives the board's own UI through the qualification harness and reports end-to-end latency.
Requires the bench build (see below). Does not flash anything.

Options
  --port PATH          serial device. Default: the only /dev/cu.usbmodem* (macOS) or /dev/ttyACM* (Linux)
  --scenario NAME      THREADS (default) | REPLY | LOCAL
                         THREADS  open the thread list: one gateway read each time
                         REPLY    open the reply: one read, but the UI skips it inside ~5 s of the last
                         LOCAL    open Actions: no network at all - the harness's own noise floor
  --iterations N       1..${MAX_ITERATIONS} (default 20). The first --warmup of them are reported but not counted.
  --delay MS           idle time between iterations, 0..${MAX_DELAY_MS}. Default per scenario (THREADS 3000,
                       REPLY 6000, LOCAL 500). It is the experiment: below ~${WARM_IDLE_MS} ms a warm connection (if the
                       firmware keeps one) is still open; above it the session has been closed, so every
                       iteration pays a fresh handshake. Run both to see the reuse effect.
  --warmup K           iterations excluded from statistics (default 1: the first request is always cold)
  --max-p95-ms N       exit 1 if network-iteration p95 of total latency exceeds N
  --max-mean-ms N      exit 1 if network-iteration mean of total latency exceeds N
  --min-reuse-ratio R  exit 1 if fewer than R (0..1) of the requests in the measured iterations were
                       served on a reused connection (needs [gw-timing] lines in the firmware)
  --json               print the ${SCHEMA} record on stdout instead of the text report
  --out FILE           also write the JSON record to FILE
  --log FILE           write every serial line with its host arrival time to FILE (may contain thread ids)
  --connect-timeout S  seconds to wait for the harness to answer STATUS (default 30)
  --ready-timeout S    seconds to wait for Wi-Fi + a claimed gateway link (default 90)
  --stall-timeout S    abort (exit 5, sending CANCEL) after S seconds with no event from the board.
                       Default: the device's 30 s per-iteration limit + --delay + 10 s
  --help

Build and flash the bench image first (the qualification gate is in scripts/build_overrides.py and is
deliberately not weakened):
  cd firmware/Hosyond-ESP32-S3-2.8-Touchscreen
  NEXT_CODER_QUALIFICATION_BENCH=1 pio run -e hosyond-es3c28p-bench -t upload
Close any serial monitor first: two readers on one port each see only part of the stream.
Reflash the controller environment afterwards; the bench image is never a product build.

Exit codes: 0 ok, 1 threshold failed, 2 usage, 3 connect/ready, 4 refused, 5 aborted/timed out, 6 no network measured.
`;

export function parseArgs(argv) {
  const options = {
    port: null, scenario: "THREADS", iterations: 20, delayMs: null, warmup: 1,
    maxP95Ms: null, maxMeanMs: null, minReuseRatio: null,
    json: false, out: null, log: null, connectTimeoutS: 30, readyTimeoutS: 90, stallTimeoutS: null, help: false,
  };
  const integer = (name, value, min, max) => {
    if (!/^(0|[1-9][0-9]{0,8})$/u.test(value ?? "")) throw usage(`${name} needs a whole number`);
    const number = Number(value);
    if (number < min || number > max) throw usage(`${name} must be ${min}..${max}`);
    return number;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw usage(`${flag} needs a value`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--help": case "-h": options.help = true; break;
      case "--json": options.json = true; break;
      case "--port": options.port = value(); break;
      case "--scenario": {
        const name = value().toUpperCase();
        if (!Object.hasOwn(SCENARIOS, name)) throw usage(`--scenario must be one of ${Object.keys(SCENARIOS).join(", ")}`);
        options.scenario = name;
        break;
      }
      case "--iterations": options.iterations = integer(flag, value(), 1, MAX_ITERATIONS); break;
      case "--delay": options.delayMs = integer(flag, value(), 0, MAX_DELAY_MS); break;
      case "--warmup": options.warmup = integer(flag, value(), 0, MAX_ITERATIONS - 1); break;
      case "--max-p95-ms": options.maxP95Ms = integer(flag, value(), 1, 600_000); break;
      case "--max-mean-ms": options.maxMeanMs = integer(flag, value(), 1, 600_000); break;
      case "--min-reuse-ratio": {
        const ratio = Number(value());
        if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw usage("--min-reuse-ratio must be 0..1");
        options.minReuseRatio = ratio;
        break;
      }
      case "--out": options.out = value(); break;
      case "--log": options.log = value(); break;
      case "--connect-timeout": options.connectTimeoutS = integer(flag, value(), 1, 600); break;
      case "--ready-timeout": options.readyTimeoutS = integer(flag, value(), 1, 3600); break;
      case "--stall-timeout": options.stallTimeoutS = integer(flag, value(), 1, 3600); break;
      default: throw usage(`unknown option ${flag}`);
    }
  }
  if (options.warmup >= options.iterations && !options.help) throw usage("--warmup must be smaller than --iterations");
  if (options.delayMs === null) options.delayMs = SCENARIOS[options.scenario].defaultDelayMs;
  return options;
}

function usage(message) {
  const error = new Error(message);
  error.exitCode = EXIT.USAGE;
  return error;
}

/* ----------------------------------------------------------------------------- line parsing --- */

// Normalises ids out of request paths so a report or JSON record carries the shape, not the thread.
export function shapePath(path) {
  return String(path).split("?")[0].split("/").map((segment) => (segment.length >= 8 && /[0-9]/u.test(segment) ? ":id" : segment)).join("/");
}

const NUMBER = String.raw`-?\d+(?:\.\d+)?`;

function keyValues(text) {
  const values = {};
  for (const match of text.matchAll(new RegExp(String.raw`([a-z_/]+)=(${NUMBER})(?:\(max (${NUMBER})\))?`, "gu"))) {
    values[match[1]] = Number(match[2]);
    if (match[3] !== undefined) values[`${match[1]}_max`] = Number(match[3]);
  }
  return values;
}

// One serial line -> a typed record, or null for anything this script has no use for. Never throws:
// boot ROM noise and half-lines from a reset are normal on this port.
export function parseLine(raw) {
  const line = String(raw).replace(/\r$/u, "");
  const tag = /^\[([a-z0-9-]+)\]\s?(.*)$/u.exec(line);
  if (!tag) return null;
  const [, name, rest] = tag;
  switch (name) {
    case "ncqual": {
      try {
        const body = JSON.parse(rest);
        return body && typeof body === "object" ? { kind: "ncqual", body } : null;
      } catch {
        return { kind: "ncqual_garbled" };
      }
    }
    case "tls-heap": {
      const phase = /phase=([a-z.]+)/u.exec(rest)?.[1];
      return phase ? { kind: "tls", phase, ...pickNumbers(keyValues(rest), ["internal_free", "internal_largest"]) } : null;
    }
    case "gw-timing": {
      // [gw-timing] GET /v1/device/threads code=200 conn=fresh gate=0ms dns=12ms tcp_probe=30ms connect_incl_tls=1500ms req=40ms ...
      const head = /^(\S+)\s+(\S+)\s+(.*)$/u.exec(rest);
      if (!head) return null;
      const values = {};
      for (const match of head[3].matchAll(/([a-z_]+)=([^\s]+)/gu)) {
        const number = /^(-?\d+(?:\.\d+)?)(?:ms)?$/u.exec(match[2]);
        values[match[1]] = number ? Number(number[1]) : match[2];
      }
      return { kind: "gw", method: head[1], path: shapePath(head[2]), values };
    }
    case "frame-split": return { kind: "frame_split", values: keyValues(rest) };
    case "touch-funnel": return { kind: "touch_funnel", values: keyValues(rest.replace(/\(.*$/u, "")) };
    case "blit-split": {
      const values = keyValues(rest.split("|")[0]);
      const tail = rest.split("|")[1] ?? "";
      for (const part of ["convert", "window", "push", "other"]) {
        const found = new RegExp(String.raw`${part} (${NUMBER})`, "u").exec(tail);
        if (found) values[`${part}_ms`] = Number(found[1]);
      }
      const blit = new RegExp(String.raw`blit_ms=(${NUMBER})`, "u").exec(tail);
      if (blit) values.blit_ms = Number(blit[1]);
      return { kind: "blit_split", values };
    }
    default: return null;
  }
}

function pickNumbers(values, keys) {
  return Object.fromEntries(keys.filter((key) => key in values).map((key) => [key, values[key]]));
}

/* ----------------------------------------------------------------------------------- stats --- */

// Nearest-rank percentile: the smallest sample with at least p of the data at or below it. Chosen over
// interpolation because with n ~ 20 an interpolated "p95" is a number that no iteration produced.
export function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

export function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, min: null, p50: null, mean: null, p95: null, p99: null, max: null, stdev: null };
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;
  return {
    count: sorted.length, min: sorted[0], p50: percentile(sorted, 0.5), mean: round(mean, 1),
    p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: sorted.at(-1), stdev: round(Math.sqrt(variance), 1),
  };
}

const round = (value, digits = 1) => (value === null || !Number.isFinite(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits);

/* ------------------------------------------------------------------------- clock + analysis --- */

// Maps host arrival times onto the device's millis() clock. Every [ncqual] event carries `t_ms`, and
// (arrival - t_ms) = offset + delivery delay, with delivery delay >= 0, so the minimum is the best
// estimate and the spread above it is the uncertainty to report.
export function estimateClock(records) {
  const deltas = [];
  for (const record of records) {
    // STATUS reports the same clock as uptime_ms; every other event as t_ms.
    const deviceMs = record.parsed?.kind === "ncqual" ? (record.parsed.body.t_ms ?? record.parsed.body.uptime_ms) : undefined;
    if (Number.isFinite(deviceMs)) deltas.push(record.hostMs - deviceMs);
  }
  if (!deltas.length) return null;
  deltas.sort((a, b) => a - b);
  return { offset: deltas[0], samples: deltas.length, jitterMs: round(percentile(deltas, 0.5) - deltas[0], 1), worstMs: round(deltas.at(-1) - deltas[0], 1) };
}

// Gate-held spans from the bare [tls-heap] boundaries. The gate is a recursive mutex and traceSessionHeap
// prints on every take and every give, so nesting is counted and only the outermost span is kept.
// A [gw-timing] line is printed inside the request, i.e. while a span is open: it belongs to that span.
export function foregroundSpans(records, clock) {
  const spans = [];
  let depth = 0;
  let open = null;
  for (const record of records) {
    const parsed = record.parsed;
    if (!parsed) continue;
    const at = record.hostMs - clock.offset;
    if (parsed.kind === "tls" && parsed.phase === "foreground.begin") {
      if (depth === 0) open = { beginMs: at, endMs: null, requests: [] };
      depth += 1;
    } else if (parsed.kind === "tls" && parsed.phase === "foreground.end") {
      if (depth > 0) depth -= 1;
      if (depth === 0 && open) { open.endMs = at; spans.push(open); open = null; }
    } else if (parsed.kind === "gw" && open) {
      open.requests.push(parsed);
    }
  }
  // A span still open at the end of the capture (the batch finished mid-request) has no end; drop it
  // rather than invent one.
  return spans;
}

const GW_STAGES = ["gate", "dns", "tcp_probe", "connect_incl_tls", "req", "body", "end"];

// Splits one iteration against the gate spans that overlap [accept, settle]. Parts sum to total by
// construction - accept + queue + network + between + tail - because inject..accept is the UI step
// itself and everything after it is partitioned by the spans, each clipped to that window. A request
// that held the gate before the step returned is therefore counted as part of accept, not twice.
export function splitIteration(iteration, spans) {
  const inject = iteration.t_accept_ms;
  const settle = iteration.t_settle_ms;
  const inside = [];
  for (const span of spans) {
    const begin = Math.max(span.beginMs, inject);
    const end = Math.min(span.endMs, settle);
    if (end > begin) inside.push({ begin, end, span });
  }
  const requests = inside.flatMap((entry) => entry.span.requests);
  const reused = requests.filter((request) => request.values.conn === "reused").length;
  const fresh = requests.filter((request) => request.values.conn === "fresh" || request.values.conn === "retried").length;
  const stages = Object.fromEntries(GW_STAGES.map((stage) => [stage, requests.reduce((sum, request) => sum + (typeof request.values[stage] === "number" ? request.values[stage] : 0), 0)]));
  const base = {
    spans: inside.length, requests: requests.length, reused, fresh, stages,
    paths: [...new Set(requests.map((request) => `${request.method} ${request.path}`))],
  };
  if (!inside.length) return { ...base, split: false };
  const first = inside[0].begin;
  const last = inside.at(-1).end;
  const network = inside.reduce((sum, entry) => sum + (entry.end - entry.begin), 0);
  return {
    ...base, split: true,
    accept_ms: iteration.accept_ms,
    queue_ms: Math.max(0, first - iteration.t_accept_ms),
    network_ms: round(network, 0),
    between_ms: round(Math.max(0, last - first - network), 0),
    tail_ms: Math.max(0, settle - last),
  };
}

// Aggregates the periodic UI-health lines that arrived while the batch ran. They are windowed (2-5 s)
// and cannot be assigned to one iteration, so they are batch-level evidence that the UI was not
// starved while the request was in flight.
export function summarizeDiagnostics(records, fromHostMs, toHostMs) {
  const within = records.filter((record) => record.parsed && record.hostMs >= fromHostMs && record.hostMs <= toHostMs);
  const of = (kind) => within.filter((record) => record.parsed.kind === kind).map((record) => record.parsed.values);
  const frames = of("frame_split");
  const funnel = of("touch_funnel");
  const blits = of("blit_split");
  const weighted = (rows, key, weightKey) => {
    const weight = rows.reduce((sum, row) => sum + (row[weightKey] ?? 0), 0);
    return weight ? round(rows.reduce((sum, row) => sum + (row[key] ?? 0) * (row[weightKey] ?? 0), 0) / weight, 2) : null;
  };
  const maxOf = (rows, key) => (rows.length ? Math.max(...rows.map((row) => row[key] ?? 0)) : null);
  const sumOf = (rows, key) => rows.reduce((sum, row) => sum + (row[key] ?? 0), 0);
  return {
    frame_split: frames.length ? {
      windows: frames.length, frames: sumOf(frames, "frames"),
      period_ms: weighted(frames, "period", "frames"), period_max_ms: maxOf(frames, "period_max"),
      tick_ms: weighted(frames, "tick", "frames"), tick_max_ms: maxOf(frames, "tick_max"),
      content_ms: weighted(frames, "content", "frames"), content_max_ms: maxOf(frames, "content_max"),
    } : null,
    touch_funnel: funnel.length ? {
      windows: funnel.length, age_avg_ms: weighted(funnel, "age_avg_ms", "dispatched"), age_max_ms: maxOf(funnel, "age_max_ms"),
      tick_gap_max_ms: maxOf(funnel, "tick_gap_max_ms"), lock_skips: sumOf(funnel, "lock_skips"),
      dropped: sumOf(funnel, "overflow") + sumOf(funnel, "stale") + sumOf(funnel, "lost") + sumOf(funnel, "refused"),
    } : null,
    blit_split: blits.length ? { windows: blits.length, blit_ms: round(blits.reduce((sum, row) => sum + (row.blit_ms ?? 0), 0) / blits.length, 2), blit_ms_max: maxOf(blits, "blit_ms") } : null,
  };
}

// The whole post-processing step, pure so a recorded transcript can be re-analysed and tested.
// `records`: [{hostMs, line, parsed}] in arrival order.
export function analyze(records, options) {
  const events = records.filter((record) => record.parsed?.kind === "ncqual").map((record) => ({ ...record.parsed.body, _hostMs: record.hostMs }));
  const started = events.find((event) => event.event === "latency" && event.phase === "started");
  const finish = events.find((event) => event.event === "latency" && (event.phase === "finished" || event.phase === "aborted"));
  const rows = events.filter((event) => event.event === "latency_iter");
  const clock = estimateClock(records);
  const spans = clock ? foregroundSpans(records, clock) : [];
  const warmup = options.warmup ?? 0;

  const iterations = rows.map((row, position) => {
    const parts = clock ? splitIteration(row, spans) : { split: false, spans: 0, requests: 0, reused: 0, fresh: 0, stages: {}, paths: [] };
    return {
      i: row.i, warmup: position < warmup, network: row.network === true, timeout: row.timeout === true,
      total_ms: row.total_ms, accept_ms: row.accept_ms, busy_ms: row.busy_ms,
      retries: row.retries, tick_gap_max_ms: row.tick_gap_max_ms, heap: row.heap, screen: row.screen,
      t_inject_ms: row.t_inject_ms, t_accept_ms: row.t_accept_ms, t_settle_ms: row.t_settle_ms,
      ...parts,
    };
  });
  const measured = iterations.filter((row) => !row.warmup && !row.timeout);
  const networkRows = measured.filter((row) => row.network);
  const localRows = measured.filter((row) => !row.network);
  const splitRows = networkRows.filter((row) => row.split);
  // LOCAL has no network rows by design; its own total is then the headline figure.
  const primaryRows = SCENARIOS[options.scenario].network ? networkRows : measured;
  const column = (rows2, key) => summarize(rows2.map((row) => row[key]));

  const requests = networkRows.reduce((sum, row) => sum + row.requests, 0);
  const reusedRequests = networkRows.reduce((sum, row) => sum + row.reused, 0);
  const stageTotals = Object.fromEntries(GW_STAGES.map((stage) => [stage, networkRows.length ? round(networkRows.reduce((sum, row) => sum + (row.stages[stage] ?? 0), 0) / networkRows.length, 1) : null]));

  const hostMsOf = (event) => event?._hostMs ?? null;
  const diagnostics = started && finish ? summarizeDiagnostics(records, hostMsOf(started), hostMsOf(finish)) : null;

  return {
    schema: SCHEMA,
    scenario: options.scenario,
    requested: options.iterations,
    delay_ms: options.delayMs,
    warmup,
    device: finish ? {
      phase: finish.phase, reason: finish.reason, completed: finish.completed, requested: finish.requested,
      network_iterations: finish.network_iterations, local_iterations: finish.local_iterations,
      step_retries: finish.step_retries, elapsed_ms: finish.elapsed_ms, heap_min: finish.heap_min,
      tick_gap_max_ms: finish.tick_gap_max_ms, total_ms: finish.total_ms, busy_ms: finish.busy_ms,
    } : null,
    clock: clock ? { samples: clock.samples, jitter_ms: clock.jitterMs, worst_ms: clock.worstMs } : null,
    iterations,
    stats: {
      total_ms: column(primaryRows, "total_ms"),
      accept_ms: column(splitRows, "accept_ms"),
      queue_ms: column(splitRows, "queue_ms"),
      network_ms: column(splitRows, "network_ms"),
      between_ms: column(splitRows, "between_ms"),
      tail_ms: column(splitRows, "tail_ms"),
      local_total_ms: column(localRows, "total_ms"),
      split_iterations: splitRows.length,
      network_iterations: networkRows.length,
      local_iterations: localRows.length,
      timeouts: iterations.filter((row) => row.timeout).length,
    },
    transport: {
      requests, reused: reusedRequests, fresh: networkRows.reduce((sum, row) => sum + row.fresh, 0),
      reuse_ratio: requests ? round(reusedRequests / requests, 3) : null,
      mean_stage_ms_per_iteration: stageTotals,
      paths: [...new Set(networkRows.flatMap((row) => row.paths))],
    },
    ui_health: diagnostics,
    cross_check: crossCheck(finish, rows),
    notes: notesFor({ options, iterations, networkRows, localRows, splitRows, clock, started }),
  };
}

// The device sums its own series; the host recomputes from the lines it received. A mismatch means a
// dropped serial line, which would silently skew every percentile.
function crossCheck(finish, rows) {
  if (!finish?.total_ms) return { ok: null, detail: "no device summary" };
  // A timed-out iteration is reported but never added to the device's own series.
  const counted = rows.filter((row) => row.timeout !== true);
  const received = counted.length;
  const sum = counted.reduce((total, row) => total + row.total_ms, 0);
  const deviceCount = finish.total_ms.count;
  const ok = received === deviceCount && (!deviceCount || Math.abs(Math.round(sum / received) - finish.total_ms.mean) <= 1);
  return { ok, lines_received: received, device_count: deviceCount, host_mean_ms: received ? Math.round(sum / received) : null, device_mean_ms: finish.total_ms.mean };
}

function notesFor({ options, iterations, networkRows, localRows, splitRows, clock, started }) {
  const notes = [];
  const scenario = SCENARIOS[options.scenario];
  if (scenario.network && localRows.length) notes.push(`${localRows.length} of ${localRows.length + networkRows.length} measured iterations made no gateway request and are excluded from the network statistics.`);
  if (options.scenario === "REPLY" && options.delayMs <= REPLY_FRESH_MS) notes.push(`REPLY with --delay ${options.delayMs} ms: the UI suppresses a reply read within ${REPLY_FRESH_MS} ms of the last one, so most iterations measure nothing. Use --delay ${REPLY_FRESH_MS + 1000} or more.`);
  if (!clock) notes.push("No timestamped [ncqual] events: request boundaries cannot be placed on the device clock, so no split is available.");
  else if (networkRows.length && splitRows.length < networkRows.length) notes.push(`${networkRows.length - splitRows.length} network iteration(s) had no [tls-heap] foreground.* span inside their window; the build may lack TLS_SESSION_DIAGNOSTICS, or the lines were lost. Total latency is still valid, the split is not.`);
  if (clock && clock.jitterMs > 20) notes.push(`Clock mapping jitter is ${clock.jitterMs} ms (median above minimum): the queue/network/tail split is only good to about that.`);
  if (options.delayMs < WARM_IDLE_MS && scenario.network) notes.push(`--delay ${options.delayMs} ms is under the ${WARM_IDLE_MS} ms warm-session idle limit: a reusable connection, if the firmware keeps one, should be open for every iteration after the first.`);
  if (options.delayMs >= WARM_IDLE_MS && scenario.network) notes.push(`--delay ${options.delayMs} ms is at or past the ${WARM_IDLE_MS} ms warm-session idle limit: every iteration is expected to pay a fresh handshake. Compare with a short --delay to see the reuse effect.`);
  const rowCount = networkRows.length;
  if (rowCount && rowCount < 20) notes.push(`n=${rowCount}: p95 is the ${rowCount === 1 ? "only sample" : "maximum or near it"}; use --iterations 40 or more for a tail you can gate on.`);
  if (started && iterations.length && !iterations.some((row) => row.network) && scenario.network) notes.push("No iteration touched the network.");
  notes.push("settle = first loop pass after uiTick() ran the job completion and repainted (exact to one pass, ~30 ms). It does not include SPI flush to the glass or any panel-side response; ui.cpp exposes no committed-frame counter.");
  return notes;
}

/* ------------------------------------------------------------------------------- reporting --- */

const pad = (value, width) => String(value ?? "-").padStart(width);
const ms = (value) => (value === null || value === undefined ? "-" : Number.isInteger(value) ? String(value) : value.toFixed(1));

export function formatReport(result, meta = {}) {
  const lines = [];
  lines.push(`Device latency  scenario=${result.scenario} iterations=${result.requested} delay=${result.delay_ms}ms warmup=${result.warmup}${meta.port ? `  port=${meta.port}` : ""}`);
  if (result.device) lines.push(`device: ${result.device.phase} (${result.device.reason}), ${result.device.completed}/${result.device.requested} done in ${result.device.elapsed_ms} ms, heap_min=${result.device.heap_min}, loop gap max=${result.device.tick_gap_max_ms} ms, step retries=${result.device.step_retries}`);
  if (result.clock) lines.push(`clock map: ${result.clock.samples} samples, jitter ${result.clock.jitter_ms} ms (worst ${result.clock.worst_ms} ms)`);
  lines.push("");
  lines.push("  #  total accept queue  net between tail | reqs reuse fresh   dns   tcp   tls   req | gap   note");
  for (const row of result.iterations) {
    const stage = row.stages ?? {};
    const note = [row.warmup ? "warmup" : null, row.timeout ? "TIMEOUT" : null, !row.network ? "local" : null, row.network && !row.split ? "no-split" : null, row.retries ? `retries=${row.retries}` : null].filter(Boolean).join(" ");
    lines.push(`${pad(row.i, 3)} ${pad(row.total_ms, 6)} ${pad(row.accept_ms, 6)} ${pad(row.split ? row.queue_ms : "-", 5)} ${pad(row.split ? row.network_ms : "-", 5)} ${pad(row.split ? row.between_ms : "-", 7)} ${pad(row.split ? row.tail_ms : "-", 4)} | ${pad(row.requests, 4)} ${pad(row.reused, 5)} ${pad(row.fresh, 5)} ${pad(stage.dns ?? "-", 5)} ${pad(stage.tcp_probe ?? "-", 5)} ${pad(stage.connect_incl_tls ?? "-", 5)} ${pad(stage.req ?? "-", 5)} | ${pad(row.tick_gap_max_ms, 3)}   ${note}`);
  }
  lines.push("");
  const stats = result.stats;
  lines.push(SCENARIOS[result.scenario].network
    ? `Distribution of total latency, network iterations only (n=${stats.network_iterations}, warmup and timeouts excluded), ms`
    : `Distribution of total latency (n=${stats.total_ms.count}, warmup excluded), ms`);
  lines.push("                 min    p50   mean    p95    p99    max  stdev");
  const row = (label, summary) => lines.push(`${label.padEnd(14)} ${pad(ms(summary.min), 6)} ${pad(ms(summary.p50), 6)} ${pad(ms(summary.mean), 6)} ${pad(ms(summary.p95), 6)} ${pad(ms(summary.p99), 6)} ${pad(ms(summary.max), 6)} ${pad(ms(summary.stdev), 6)}`);
  row("total", stats.total_ms);
  if (stats.split_iterations) {
    lines.push(`Where it goes (${stats.split_iterations} iterations with request boundaries):`);
    row("  accept (UI)", stats.accept_ms);
    row("  queue", stats.queue_ms);
    row("  network", stats.network_ms);
    row("  between reqs", stats.between_ms);
    row("  tail (UI)", stats.tail_ms);
    const mean = stats.total_ms.mean;
    if (mean) {
      const share = (summary) => `${Math.round(((summary.mean ?? 0) / mean) * 100)}%`;
      lines.push(`  share of mean: UI ${Math.round((((stats.accept_ms.mean ?? 0) + (stats.tail_ms.mean ?? 0)) / mean) * 100)}%  queue ${share(stats.queue_ms)}  network ${share(stats.network_ms)}  between ${share(stats.between_ms)}`);
    }
  }
  if (stats.local_iterations) {
    lines.push("Iterations that made no gateway request (UI-only, reflects the harness floor):");
    row("  local total", stats.local_total_ms);
  }
  const transport = result.transport;
  if (transport.requests) {
    lines.push("");
    lines.push(`Transport: ${transport.requests} request(s) in measured iterations, ${transport.reused} reused / ${transport.fresh} fresh connection (reuse ratio ${transport.reuse_ratio}).`);
    const stageText = Object.entries(transport.mean_stage_ms_per_iteration).filter(([, value]) => value).map(([name, value]) => `${name}=${value}`).join(" ");
    if (stageText) lines.push(`  mean per iteration from [gw-timing] (ms): ${stageText}`);
    if (transport.paths.length) lines.push(`  requests: ${transport.paths.join(", ")}`);
  }
  const health = result.ui_health;
  if (health) {
    lines.push("");
    lines.push("UI health while the batch ran (windowed lines; not per-iteration):");
    if (health.frame_split) lines.push(`  [frame-split] ${health.frame_split.windows} windows, ${health.frame_split.frames} frames: period ${ms(health.frame_split.period_ms)} ms (max ${ms(health.frame_split.period_max_ms)}), tick ${ms(health.frame_split.tick_ms)} ms (max ${ms(health.frame_split.tick_max_ms)}), content ${ms(health.frame_split.content_ms)} ms (max ${ms(health.frame_split.content_max_ms)})`);
    if (health.touch_funnel) lines.push(`  [touch-funnel] ${health.touch_funnel.windows} windows: age avg ${ms(health.touch_funnel.age_avg_ms)} ms max ${ms(health.touch_funnel.age_max_ms)} ms, loop gap max ${ms(health.touch_funnel.tick_gap_max_ms)} ms, lock skips ${health.touch_funnel.lock_skips}, dropped ${health.touch_funnel.dropped}`);
    if (health.blit_split) lines.push(`  [blit-split] ${health.blit_split.windows} windows: ${ms(health.blit_split.blit_ms)} ms per orb frame (max ${ms(health.blit_split.blit_ms_max)})`);
    if (!health.frame_split && !health.touch_funnel && !health.blit_split) lines.push("  none of the three lines appeared during the run (windows are 2-5 s; short batches can miss them).");
  }
  if (result.cross_check.ok === false) lines.push("", `WARNING: serial lines were lost: received ${result.cross_check.lines_received} iteration lines, device counted ${result.cross_check.device_count}. Statistics are unreliable.`);
  if (result.notes.length) {
    lines.push("", "Notes");
    for (const note of result.notes) lines.push(`  - ${note}`);
  }
  return lines.join("\n");
}

// Decides the exit status from a finished analysis. Order matters: an aborted batch is a failed
// measurement and must never be reported as a threshold pass.
export function verdict(result, options) {
  const failures = [];
  if (!result.device) return { code: EXIT.ABORTED, failures: ["no batch summary from the device"] };
  if (result.device.phase !== "finished") return { code: EXIT.ABORTED, failures: [`device aborted the batch: ${result.device.reason}`] };
  if (result.cross_check.ok === false) return { code: EXIT.ABORTED, failures: ["serial lines were lost; refusing to gate on partial data"] };
  const scenario = SCENARIOS[options.scenario];
  if (scenario.network && result.stats.network_iterations === 0) return { code: EXIT.NO_MEASUREMENT, failures: ["no measured iteration touched the network"] };
  const total = result.stats.total_ms;
  if (options.maxP95Ms !== null && (total.p95 === null || total.p95 > options.maxP95Ms)) failures.push(`p95 ${total.p95} ms > ${options.maxP95Ms} ms`);
  if (options.maxMeanMs !== null && (total.mean === null || total.mean > options.maxMeanMs)) failures.push(`mean ${total.mean} ms > ${options.maxMeanMs} ms`);
  if (options.minReuseRatio !== null) {
    const ratio = result.transport.reuse_ratio;
    if (ratio === null) failures.push("reuse ratio unavailable: no [gw-timing] lines (firmware without request timing)");
    else if (ratio < options.minReuseRatio) failures.push(`reuse ratio ${ratio} < ${options.minReuseRatio}`);
  }
  return { code: failures.length ? EXIT.THRESHOLD : EXIT.OK, failures };
}

/* -------------------------------------------------------------------------------- serial --- */

export function detectPort(listing = () => readdirSync("/dev"), exists = existsSync) {
  const names = listing();
  const candidates = names.filter((name) => /^cu\.usbmodem/u.test(name) || /^ttyACM\d+$/u.test(name)).map((name) => `/dev/${name}`).filter((path) => exists(path));
  if (candidates.length === 1) return candidates[0];
  const error = new Error(candidates.length ? `several serial devices found (${candidates.join(", ")}); choose one with --port` : "no /dev/cu.usbmodem* or /dev/ttyACM* device found; connect the board or pass --port");
  error.exitCode = EXIT.CONNECT;
  throw error;
}

// Raw-mode tty read stream + fs writes. Raw mode is not cosmetic: in cooked mode the line discipline
// echoes the board's own output back to it, and the harness would parse its own log as commands.
export function openSerial(path, { onLine, now = () => Number(process.hrtime.bigint()) / 1e6 }) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK);
  } catch (error) {
    const failure = new Error(`cannot open ${path}: ${error.code ?? error.message}${error.code === "EBUSY" ? " (another program holds it)" : ""}`);
    failure.exitCode = EXIT.CONNECT;
    throw failure;
  }
  let stream;
  try {
    stream = new TtyReadStream(fd);
    stream.setRawMode(true);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed by the failed stream */ }
    const failure = new Error(`${path} is not a usable terminal device (${error.code ?? error.message})`);
    failure.exitCode = EXIT.CONNECT;
    throw failure;
  }
  let pending = "";
  stream.on("data", (chunk) => {
    const hostMs = now();
    pending += chunk.toString("utf8");
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/u, "");
      pending = pending.slice(newline + 1);
      if (line.length) onLine(line, hostMs);
    }
    if (pending.length > 8192) pending = ""; // a runaway partial line is noise, not a record
  });
  stream.on("error", () => { /* surfaced as a timeout by the caller; an EIO on unplug must not throw here */ });
  return {
    write(text) {
      const buffer = Buffer.from(text, "utf8");
      let offset = 0;
      for (let attempt = 0; offset < buffer.length && attempt < 200; attempt += 1) {
        try {
          offset += writeSync(fd, buffer, offset);
        } catch (error) {
          if (error.code !== "EAGAIN") throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
      if (offset < buffer.length) throw new Error("serial write did not complete");
    },
    close() {
      try { stream.destroy(); } catch { /* ignore */ }
    },
  };
}

/* ---------------------------------------------------------------------------------- driver --- */

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function failure(message, exitCode) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

// Runs one measurement against `link` ({write, close}, plus the caller feeding lines through `feed`).
// Split from main() so a test can drive it with a fake device and no port.
export async function measure({ link, records, waitFor, options, log = () => {} }) {
  const send = (command) => link.write(`${command}\n`);
  const lastNcqual = (predicate) => records.findLast((record) => record.parsed?.kind === "ncqual" && predicate(record.parsed.body))?.parsed.body;

  // 1. Is the harness there at all? Ask until it answers; the board may be mid-reboot.
  log("waiting for the qualification harness to answer STATUS");
  const connectDeadline = Date.now() + options.connectTimeoutS * 1000;
  let statusEvent = null;
  while (Date.now() < connectDeadline && !statusEvent) {
    const before = records.length;
    send("NCQUAL STATUS");
    statusEvent = await waitFor((record) => record.parsed?.kind === "ncqual" && record.parsed.body.event === "status", 700, before);
  }
  if (!statusEvent) {
    const sawAnything = records.length > 0;
    const sawNcqual = records.some((record) => record.parsed?.kind === "ncqual");
    throw failure(sawAnything && !sawNcqual
      ? "the board is talking but the qualification harness is not: this is not the bench image. Build it with NEXT_CODER_QUALIFICATION_BENCH=1 pio run -e hosyond-es3c28p-bench and flash that."
      : "no answer from the board: check the port, the cable, and that no serial monitor holds it", EXIT.CONNECT);
  }

  // 2. Is it in a state worth measuring? A dead link yields timeouts, not latency.
  const needsNetwork = SCENARIOS[options.scenario].network;
  const readyDeadline = Date.now() + options.readyTimeoutS * 1000;
  let status = statusEvent.parsed.body;
  const ready = (body) => !body.ui_busy && !body.stress_active && (!needsNetwork || (body.wifi_connected && body.gateway === "claimed"));
  while (!ready(status)) {
    if (Date.now() > readyDeadline) {
      throw failure(`device not ready after ${options.readyTimeoutS}s: wifi=${status.wifi_connected} gateway=${status.gateway} ui_busy=${status.ui_busy} stress_active=${status.stress_active}`, EXIT.CONNECT);
    }
    await sleep(1000);
    const before = records.length;
    send("NCQUAL STATUS");
    const next = await waitFor((record) => record.parsed?.kind === "ncqual" && record.parsed.body.event === "status", 1500, before);
    if (next) status = next.parsed.body;
  }
  log(`ready: wifi=${status.wifi_connected} gateway=${status.gateway} heap=${status.heap}`);

  // 3. Issue the batch and require an explicit acceptance.
  const before = records.length;
  send(`NCQUAL LATENCY ${options.scenario} ${options.iterations} ${options.delayMs}`);
  const answer = await waitFor((record) => record.parsed?.kind === "ncqual" && ((record.parsed.body.event === "latency" && (record.parsed.body.phase === "started" || record.parsed.body.phase === "refused")) || record.parsed.body.event === "input"), 5000, before);
  if (!answer) throw failure("the board did not answer the LATENCY command within 5 s", EXIT.REFUSED);
  const body = answer.parsed.body;
  if (body.event === "input") {
    throw failure(body.phase === "invalid"
      ? "the board does not understand LATENCY: it is running an older bench image. Rebuild and reflash hosyond-es3c28p-bench."
      : `the board refused: ${body.phase}`, EXIT.REFUSED);
  }
  if (body.phase === "refused") throw failure(`the board refused the batch: ${body.reason}`, EXIT.REFUSED);
  log(`batch accepted: ${options.scenario} x${options.iterations}, ${options.delayMs} ms apart`);

  // 4. Collect. The watchdog is progress-based: the device bounds each iteration at 30 s itself, so
  //    silence for longer than that plus the delay means the device or the link is gone.
  const silenceLimit = options.stallTimeoutS === null ? DEVICE_ITERATION_TIMEOUT_MS + options.delayMs + 10_000 : options.stallTimeoutS * 1000;
  let lastProgress = Date.now();
  let seen = records.length;
  let done = null;
  while (!done) {
    done = lastNcqual((event) => event.event === "latency" && (event.phase === "finished" || event.phase === "aborted"));
    if (done) break;
    if (records.length !== seen) { if (records.slice(seen).some((record) => record.parsed?.kind === "ncqual")) lastProgress = Date.now(); seen = records.length; }
    if (Date.now() - lastProgress > silenceLimit) {
      try { send("NCQUAL CANCEL"); } catch { /* port may be gone */ }
      throw failure(`no progress from the board for ${Math.round(silenceLimit / 1000)} s; sent CANCEL`, EXIT.ABORTED);
    }
    await sleep(100);
  }

  // 5. One last STATUS for the batch-level heap and loop-gap figures, then a short drain so the
  //    final periodic lines are in the transcript.
  const tail = records.length;
  send("NCQUAL STATUS");
  await waitFor((record) => record.parsed?.kind === "ncqual" && record.parsed.body.event === "status", 1500, tail);
  return true;
}

export async function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`${error.message}\n\n${HELP}`);
    return error.exitCode ?? EXIT.USAGE;
  }
  if (options.help) { io.stdout.write(HELP); return EXIT.OK; }

  const progress = (message) => { if (!options.json) io.stderr.write(`[measure] ${message}\n`); };
  const records = [];
  const waiters = new Set();
  const transcript = options.log ? createWriteStream(options.log, { flags: "w", mode: 0o600 }) : null;
  const feed = (line, hostMs) => {
    const record = { hostMs, line, parsed: parseLine(line) };
    records.push(record);
    transcript?.write(`${hostMs.toFixed(1)}\t${line}\n`);
    for (const waiter of [...waiters]) waiter(record);
  };
  // Resolves with the first record AFTER index `from` that satisfies the predicate, or null on timeout.
  const waitFor = (predicate, timeoutMs, from) => new Promise((resolveWait) => {
    for (let index = from; index < records.length; index += 1) {
      if (predicate(records[index])) { resolveWait(records[index]); return; }
    }
    const waiter = (record) => {
      if (!predicate(record)) return;
      clearTimeout(timer);
      waiters.delete(waiter);
      resolveWait(record);
    };
    const timer = setTimeout(() => { waiters.delete(waiter); resolveWait(null); }, timeoutMs);
    waiters.add(waiter);
  });

  let link = null;
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    try { link?.write("NCQUAL CANCEL\n"); } catch { /* ignore */ }
    setTimeout(() => process.exit(130), 300).unref();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let code = EXIT.OK;
  try {
    const port = options.port ?? detectPort();
    link = openSerial(port, { onLine: feed });
    options.portResolved = port;
    progress(`port ${port}`);
    await measure({ link, records, waitFor, options, log: progress });
    const result = analyze(records, options);
    const decision = verdict(result, options);
    result.verdict = { exit_code: decision.code, failures: decision.failures };
    if (options.out) writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    io.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatReport(result, { port })}\n`);
    for (const failed of decision.failures) io.stderr.write(`FAIL: ${failed}\n`);
    code = decision.code;
  } catch (error) {
    code = error.exitCode ?? EXIT.ABORTED;
    io.stderr.write(`error: ${error.message}\n`);
    // A refused or timed-out run may still have partial iterations worth seeing, but it is a failure.
    if (options.out && records.length) {
      try { writeFileSync(options.out, `${JSON.stringify({ schema: SCHEMA, error: error.message, exit_code: code, ...analyze(records, options) }, null, 2)}\n`, { mode: 0o600 }); } catch { /* best effort */ }
    }
  } finally {
    link?.close();
    transcript?.end();
  }
  return interrupted ? 130 : code;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => process.exit(code), (error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(EXIT.ABORTED); });
}
