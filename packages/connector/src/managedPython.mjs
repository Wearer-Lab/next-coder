import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, chmod, rename, rm, copyFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

// Reviewed official release digests. No remotely supplied installer script is executed.
export const UV_VERSION = "0.13.5";
export const PYTHON_VERSION = "3.12.12";
const TARGETS = {
  "darwin:arm64": ["aarch64-apple-darwin", "743f85035a1996ecb350659e01cd9faea9709829be09b1b4b03c73eaf3c9cd73"],
  "darwin:x64": ["x86_64-apple-darwin", "b0f52b0e3945b4107d89024ea38e625683011fbfc05a0d98f9fa2d6dcee28c66"],
  "linux:arm64": ["aarch64-unknown-linux-gnu", "4bb69cf95ed13f23713bb7bc09f241896ea0c75b7c557e615a20604b82f9c403"],
  "linux:x64": ["x86_64-unknown-linux-gnu", "f68d291c75783122dad58ab77def0e13f3233f358731db5d6d7e8715603b928f"],
  "win32:arm64": ["aarch64-pc-windows-msvc", "09f47edf90726084a70f9426f6e3ca4f46e9bf7cbf23b1716ec64d60b055fae3"],
  "win32:x64": ["x86_64-pc-windows-msvc", "a38b8d1902b7cfbc76b423ba1bb456f623f42064cdc72628b6075b89afd1019a"],
};
const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failure = (message) => Object.assign(new Error(message), { code: "VOICE_RUNTIME_SETUP_FAILED" });

export function managedPythonTarget(platform = process.platform, arch = process.arch) {
  const value = TARGETS[`${platform}:${arch}`];
  if (!value) throw failure("Local voice requires macOS, Windows, or a glibc Linux computer with an x64 or arm64 processor.");
  return { target: value[0], sha256: value[1], extension: platform === "win32" ? "zip" : "tar.gz" };
}

export async function downloadVerifiedArchive(url, expectedHash, { fetchImpl = globalThis.fetch, maxBytes = MAX_ARCHIVE_BYTES, signal } = {}) {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(180_000);
  const activeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const response = await fetchImpl(url, { signal: activeSignal });
  if (!response.ok || !response.body) throw failure("The local voice runtime download failed. Check this computer's network connection and retry.");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) { await response.body.cancel(); throw failure("Local voice runtime download exceeded its size limit."); }
  const chunks = []; let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      activeSignal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length > maxBytes - size) { await reader.cancel(); throw failure("Local voice runtime download exceeded its size limit."); }
      size += value.length; chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, size);
  if (digest(bytes) !== expectedHash) throw failure("Local voice runtime checksum verification failed; nothing was executed.");
  return bytes;
}

export async function runVoiceSetupCommand(command, args, { env = process.env, timeoutMs = 600_000, maxOutputBytes = 64 * 1024, signal } = {}) {
  signal?.throwIfAborted();
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let output = ""; let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolvePromise(result); };
    const abort = () => { child.kill(); finish(signal.reason ?? failure("Local voice setup was cancelled.")); };
    const timer = setTimeout(() => { child.kill(); finish(failure("Local voice setup timed out. Retry setup when this computer is connected.")); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk) => { if (Buffer.byteLength(output) + chunk.length <= maxOutputBytes) output += chunk.toString(); });
    // Dependency tooling may print paths or URLs: never copy its raw stderr into support logs.
    child.stderr.resume();
    child.on("error", () => finish(failure("Local voice setup could not start its runtime tool.")));
    child.on("close", (code) => finish(code === 0 ? null : failure("Local voice runtime installation failed. Check network, available disk space, and supported operating system, then retry."), { stdout: output }));
  });
}

export async function ensureManagedPython({ stateDir, platform = process.platform, arch = process.arch,
  fetchImpl = globalThis.fetch, run = runVoiceSetupCommand, progress = () => {}, signal } = {}) {
  signal?.throwIfAborted();
  if (!stateDir) throw failure("A dedicated connector state directory is required for local voice.");
  const { target, sha256, extension } = managedPythonTarget(platform, arch);
  const root = resolve(stateDir, "voice", "runtime");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const uvPath = join(root, platform === "win32" ? "uv.exe" : "uv");
  const receiptPath = join(root, "uv-receipt.json");
  let verified = false;
  try {
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    const info = await stat(uvPath);
    verified = info.size <= MAX_ARCHIVE_BYTES * 4 && receipt.version === UV_VERSION && receipt.target === target
      && receipt.archiveSha256 === sha256 && digest(await readFile(uvPath)) === receipt.binarySha256;
  } catch {}
  if (!verified) {
    progress("Downloading and verifying the local voice runtime.");
    const bytes = await downloadVerifiedArchive(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${target}.${extension}`, sha256, { fetchImpl, signal });
    const temporary = join(root, `install-${randomUUID()}`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      const archive = join(temporary, `uv.${extension}`);
      await writeFile(archive, bytes, { mode: 0o600 });
      let extracted;
      if (platform === "win32") {
        extracted = join(temporary, "uv.exe");
        const quote = (value) => `'${value.replaceAll("'", "''")}'`;
        const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead(${quote(archive)}); try { $e=@($z.Entries | Where-Object { $_.FullName -eq 'uv.exe' -or $_.FullName -eq 'uv-${target}/uv.exe' }); if($e.Count -ne 1){throw 'invalid archive'}; [IO.Compression.ZipFileExtensions]::ExtractToFile($e[0],${quote(extracted)},$true) } finally { $z.Dispose() }`;
        await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { signal });
      } else {
        await run("tar", ["-xzf", archive, "-C", temporary, `uv-${target}/uv`], { signal });
        extracted = join(temporary, `uv-${target}`, "uv");
      }
      const binary = await readFile(extracted);
      const pending = `${uvPath}.${randomUUID()}.tmp`;
      await copyFile(extracted, pending); await chmod(pending, 0o700); await rename(pending, uvPath);
      await writeFile(receiptPath, JSON.stringify({ version: UV_VERSION, target, archiveSha256: sha256, binarySha256: digest(binary) }), { mode: 0o600 });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const pythonRoot = join(root, "python");
  const inherited = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR"]
    .filter((key) => typeof process.env[key] === "string").map((key) => [key, process.env[key]]));
  const env = { ...inherited, UV_PYTHON_INSTALL_DIR: pythonRoot, UV_CACHE_DIR: join(root, "cache"), UV_NO_PROGRESS: "1", UV_NO_CONFIG: "1" };
  progress("Preparing Python for local voice transcription.");
  await run(uvPath, ["python", "install", PYTHON_VERSION], { env, signal });
  const result = await run(uvPath, ["python", "find", "--managed-python", PYTHON_VERSION], { env, signal });
  const pythonPath = result.stdout.trim();
  if (!pythonPath || !resolve(pythonPath).startsWith(resolve(pythonRoot) + sep)) throw failure("Local voice Python installation returned an invalid runtime path.");
  return { pythonPath, uvPath };
}
