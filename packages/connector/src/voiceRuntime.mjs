import { createServer } from "node:net";
import { spawn as nodeSpawn } from "node:child_process";
import * as nodeFs from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureManagedPython } from "./managedPython.mjs";
import { DEFAULT_PARAKEET_URL, validateParakeetUrl } from "./localTranscription.mjs";

// Starting the sidecar means launching Python and loading a ~660 MB speech model, on whatever
// machine the owner happens to have. A budget sized on a fast laptop reports a broken install
// to someone whose disk is simply slow. The loop already exits immediately when the child
// fails or exits, so a real fault still surfaces at once and only a slow start waits.
export const VOICE_STARTUP_TIMEOUT_MS = 300_000;

const MODEL = "nvidia/parakeet-tdt-0.6b-v2";
const VERSION = "onnx-asr==0.12.0 onnxruntime==1.31.0 numpy==2.5.4";
const assets = fileURLToPath(new URL("./voice-assets/", import.meta.url));
const error = (code, text) => Object.assign(new Error(text), { code, retryable: true });

// Do not copy connector/cloud/provider credentials into an inference subprocess.
function childEnvironment(source = process.env) {
  return Object.fromEntries(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR"]
    .filter((key) => typeof source[key] === "string").map((key) => [key, source[key]]));
}

export async function inspectVoiceRuntime({ url = DEFAULT_PARAKEET_URL, fetchImpl = globalThis.fetch, signal } = {}) {
  try {
    const endpoint = validateParakeetUrl(url);
    const response = await fetchImpl(new URL("/healthz", endpoint), { redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000) });
    if (!response.ok) return { ready: false };
    const reader = response.body?.getReader();
    if (!reader) return { ready: false };
    const chunks = []; let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 8192) { await reader.cancel(); return { ready: false }; }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const body = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
    return body.status === "ok" && body.model === MODEL && body.precision === "int8"
      ? { ready: true, model: MODEL, precision: "int8", url: endpoint } : { ready: false };
  } catch { return { ready: false }; }
}

async function run(command, args, options, stage) {
  options.signal?.throwIfAborted();
  options.onProgress?.(stage);
  const child = (options.spawn ?? nodeSpawn)(command, args, { env: childEnvironment(options.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal: options.signal });
  // Installer output contains no prompts/audio, but may echo private user paths.
  // Emit only bounded stage/progress messages, never arbitrary subprocess output.
  child.stdout?.resume(); child.stderr?.resume();
  await new Promise((resolveDone, reject) => {
    let settled = false;
    const finish = (failure) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      failure ? reject(failure) : resolveDone();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3000);
      force.unref?.();
      finish(error("VOICE_SETUP_FAILED", "Local speech setup timed out. Retry when this computer is connected."));
    }, options.installTimeoutMs ?? 20 * 60_000);
    child.once("error", () => finish(error("VOICE_SETUP_FAILED", "Local speech setup could not start.")));
    child.once("exit", (code) => finish(code === 0 ? null : error("VOICE_SETUP_FAILED", "Local speech setup failed. Retry setup after checking network access and free disk space.")));
  });
}

export async function setupVoiceRuntime(options = {}) {
  if (!options.stateDir) throw new TypeError("Voice runtime requires a state directory.");
  const fs = options.fs ?? nodeFs;
  const root = resolve(options.stateDir, "voice");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const { pythonPath, uvPath } = await (options.ensureManagedPython ?? ensureManagedPython)({ ...options, stateDir: options.stateDir, progress: options.onProgress ?? options.progress });
  const venv = join(root, "venv");
  const venvPython = join(venv, (options.platform ?? process.platform) === "win32" ? "Scripts/python.exe" : "bin/python");
  const modelDir = join(root, "models", "parakeet-tdt-0.6b-v2-onnx");
  const marker = join(root, "runtime.json");
  let installed = false;
  try { installed = JSON.parse(await fs.readFile(marker, "utf8")).version === VERSION; } catch {}
  if (installed) {
    try {
      await fs.access(venvPython);
      await run(venvPython, ["-c", "import onnx_asr, onnxruntime, numpy"], options, "Checking the installed speech runtime");
    } catch { installed = false; }
  }
  if (!installed) {
    await run(uvPath, ["venv", "--python", pythonPath, venv], options, "Preparing the private speech environment");
    await run(uvPath, ["pip", "install", "--python", venvPython, "onnx-asr==0.12.0", "onnxruntime==1.31.0", "numpy==2.5.4"], options, "Installing the speech runtime");
  }
  // The bundled downloader resumes partial files and verifies every model digest.
  await run(process.execPath, [join(assets, "fetch-parakeet-model.mjs")], {
    ...options, env: { ...childEnvironment(options.env), PARAKEET_MODEL_DIR: modelDir },
    // Keep model destination explicit below; never depend on the current directory.
    spawn: (command, args, spawnOptions) => (options.spawn ?? nodeSpawn)(command, args, {
      ...spawnOptions, env: { ...spawnOptions.env, PARAKEET_MODEL_DIR: modelDir },
    }),
  }, "Downloading and verifying the speech model (about 660 MB on first setup)");
  await fs.writeFile(marker, JSON.stringify({ version: VERSION, model: MODEL }), { mode: 0o600 });
  return { pythonPath: venvPython, modelDir };
}

export async function prepareVoiceRuntime(options = {}) {
  let url = validateParakeetUrl(options.url ?? DEFAULT_PARAKEET_URL);
  const inspect = () => inspectVoiceRuntime({ ...options, url });
  if (options.url && (await inspect()).ready) return { url, reused: true, close: async () => {}, ensureReady: async () => {
    if (!(await inspect()).ready) throw error("TRANSCRIPTION_UNAVAILABLE", "The existing local speech runtime is unavailable.");
  } };
  const runtime = await setupVoiceRuntime(options);
  if (!options.url) {
    const port = await (options.selectPort ?? (() => new Promise((resolvePort, reject) => {
      const server = createServer();
      server.once("error", () => reject(error("TRANSCRIPTION_UNAVAILABLE", "A private speech port could not be opened.")));
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        server.close((failure) => failure ? reject(error("TRANSCRIPTION_UNAVAILABLE", "A private speech port could not be opened.")) : resolvePort(port));
      });
    })))();
    url = `http://127.0.0.1:${port}/v1/transcribe`;
  }
  const endpoint = new URL(url);
  let child = null; let closing = false; let attempts = 0; let startup = null;
  const stopChild = async () => {
    const owned = child; child = null;
    if (!owned || owned.exitCode !== null || owned.signalCode !== null) return;
    await new Promise((done) => {
      const timer = setTimeout(() => { owned.kill("SIGKILL"); done(); }, 3000);
      owned.once("exit", () => { clearTimeout(timer); done(); });
      owned.kill("SIGTERM");
    });
  };
  const launch = async ({ signal = options.signal } = {}) => {
    if (closing) throw error("TRANSCRIPTION_UNAVAILABLE", "The local speech runtime has stopped.");
    if ((await inspectVoiceRuntime({ ...options, url, signal })).ready) return;
    if (attempts >= 3) throw error("TRANSCRIPTION_UNAVAILABLE", "Local speech stopped repeatedly. Restart the connector to recover.");
    await stopChild();
    if (closing) throw error("TRANSCRIPTION_UNAVAILABLE", "The local speech runtime has stopped.");
    attempts += 1;
    options.onProgress?.("Starting local speech recognition");
    child = (options.spawn ?? nodeSpawn)(runtime.pythonPath, [join(assets, "parakeet-sidecar.py"), "--host", endpoint.hostname === "[::1]" ? "::1" : endpoint.hostname,
      "--port", endpoint.port || "80", "--model-dir", runtime.modelDir, "--precision", "int8", "--watch-stdin"], {
      env: childEnvironment(options.env), stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
    });
    let failed = false;
    child.once("error", () => { failed = true; });
    const startedAt = Date.now();
    try {
    while (Date.now() - startedAt < (options.startupTimeoutMs ?? VOICE_STARTUP_TIMEOUT_MS)) {
      signal?.throwIfAborted();
      if (closing) throw error("TRANSCRIPTION_UNAVAILABLE", "The local speech runtime has stopped.");
      if (failed || child.exitCode !== null) break;
      if ((await inspectVoiceRuntime({ ...options, url, signal })).ready) return;
      await (options.sleep ?? sleep)(250, undefined, { signal });
    }
    } catch (failure) { await stopChild(); throw failure; }
    await stopChild();
    throw error("TRANSCRIPTION_UNAVAILABLE", "Local speech recognition did not become ready. Retry after checking available memory and disk space.");
  };
  const ensureReady = (input = {}) => startup ??= launch(input).finally(() => { startup = null; });
  try { await ensureReady(); } catch (failure) { closing = true; await stopChild(); throw failure; }
  return { url, reused: false, ensureReady, close: async () => { closing = true; await stopChild(); await startup?.catch(() => {}); await stopChild(); } };
}
