import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { inspectVoiceRuntime, prepareVoiceRuntime, setupVoiceRuntime } from "../src/voiceRuntime.mjs";

const good = { status: "ok", model: "nvidia/parakeet-tdt-0.6b-v2", precision: "int8" };
async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-voice-test-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const commands = []; const children = [];
  let ready = false;
  const options = { stateDir, platform: "linux", env: { PATH: "/usr/bin", CLOUD_SECRET: "never-forward", PARAKEET_MODEL_DIR: "/wrong" },
    ensureManagedPython: async () => ({ pythonPath: "/managed/python", uvPath: "/managed/uv" }),
    fetchImpl: async () => Response.json(ready ? good : { status: "starting" }),
    spawn(command, args, config) {
      const child = new EventEmitter();
      child.exitCode = null; child.signalCode = null; child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = (signal) => { child.signalCode = signal; ready = false; queueMicrotask(() => child.emit("exit", null)); return true; };
      commands.push({ command, args, config }); children.push(child);
      if (args.some((arg) => arg.endsWith("parakeet-sidecar.py"))) ready = true;
      else queueMicrotask(() => { child.exitCode = 0; child.emit("exit", 0); });
      return child;
    },
  };
  return { options, commands, children, setReady(value) { ready = value; } };
}

test("only exact Parakeet model and precision health can be reused", async () => {
  for (const patch of [{ model: "unrelated" }, { precision: "fp32" }, { status: "starting" }]) {
    assert.equal((await inspectVoiceRuntime({ fetchImpl: async () => Response.json({ ...good, ...patch }) })).ready, false);
  }
  assert.equal((await inspectVoiceRuntime({ fetchImpl: async () => Response.json(good) })).ready, true);
  assert.equal((await inspectVoiceRuntime({ fetchImpl: async () => new Response("x".repeat(8193)) })).ready, false);
});

test("validated external sidecar is never installed, stopped or mutated", async () => {
  const runtime = await prepareVoiceRuntime({ url: "http://127.0.0.1:8977/v1/transcribe", fetchImpl: async () => Response.json(good),
    spawn() { assert.fail("external process must not be touched"); },
    ensureManagedPython() { assert.fail("no setup needed"); } });
  assert.equal(runtime.reused, true);
  await runtime.ensureReady(); await runtime.close();
});

test("installer pins dependencies, confines assets to state directory and excludes secrets", async (t) => {
  const { options, commands } = await fixture(t);
  const runtime = await setupVoiceRuntime(options);
  assert.equal(runtime.modelDir, join(options.stateDir, "voice/models/parakeet-tdt-0.6b-v2-onnx"));
  assert.deepEqual(commands[1].args.slice(-3), ["onnx-asr==0.12.0", "onnxruntime==1.31.0", "numpy==2.5.4"]);
  assert.equal(commands[2].config.env.PARAKEET_MODEL_DIR, runtime.modelDir);
  assert.ok(commands.every(({ config }) => !config.env.CLOUD_SECRET));
  // A verified installation reuses the private venv; model verification remains resumable.
  await mkdir(join(options.stateDir, "voice/venv/bin"), { recursive: true });
  await writeFile(runtime.pythonPath, "fixture");
  const prior = commands.length;
  await setupVoiceRuntime(options);
  assert.equal(commands.length - prior, 2);
});

test("owned sidecar starts once for concurrent callers, restarts within a bounded budget and closes only owned child", async (t) => {
  const { options, commands, children, setReady } = await fixture(t);
  const runtime = await prepareVoiceRuntime(options);
  assert.equal(runtime.reused, false);
  const owned = commands.find(({ args }) => args.some((arg) => arg.endsWith("parakeet-sidecar.py")));
  assert.ok(owned.args.includes("--watch-stdin"));
  assert.equal(owned.config.stdio[0], "pipe");
  let last = children.at(-1);
  last.exitCode = 1; setReady(false);
  await Promise.all([runtime.ensureReady(), runtime.ensureReady()]);
  assert.equal(commands.filter(({ args }) => args.some((arg) => arg.endsWith("parakeet-sidecar.py"))).length, 2);
  last = children.at(-1); last.exitCode = 1; setReady(false);
  await runtime.ensureReady();
  last = children.at(-1); last.exitCode = 1; setReady(false);
  await assert.rejects(runtime.ensureReady(), { code: "TRANSCRIPTION_UNAVAILABLE" });
  await runtime.close();
  await assert.rejects(runtime.ensureReady(), { code: "TRANSCRIPTION_UNAVAILABLE" });
});

test("aborted startup cleans up its owned process and never publishes ready", async (t) => {
  const { options, children } = await fixture(t);
  const controller = new AbortController();
  const spawn = options.spawn;
  await assert.rejects(prepareVoiceRuntime({ ...options, signal: controller.signal,
    spawn(command, args, config) {
      const child = spawn(command, args, config);
      if (args.some((arg) => arg.endsWith("parakeet-sidecar.py"))) controller.abort();
      return child;
    } }), { name: "AbortError" });
  assert.equal(children.at(-1).signalCode, "SIGTERM");
});
