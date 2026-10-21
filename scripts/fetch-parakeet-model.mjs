#!/usr/bin/env node
// Fetches the Parakeet ASR weights the local sidecar runs on.
//
// Why ONNX rather than the .nemo checkpoint published by NVIDIA: nvidia/parakeet-tdt-0.6b-v2 ships
// a 2.4 GB NeMo artefact that only nemo_toolkit can open, and nemo_toolkit drags in PyTorch,
// Lightning, Hydra and a build toolchain — a multi-gigabyte install to run 600M parameters of
// inference. istupakov/parakeet-tdt-0.6b-v2-onnx is that exact checkpoint exported to ONNX for the
// onnx-asr runner, and its int8 export is ~660 MB served by onnxruntime alone. Same weights, same
// English-only model, a fraction of the dependency surface, and it runs on a CPU Mac unmodified.
//
// Everything here is deliberately dependency-free (`node:` builtins only) and safe to re-run:
// a file whose digest already matches is skipped, a half-downloaded one resumes from where it
// stopped, and a digest mismatch is deleted rather than left to fail later as a confusing
// onnxruntime protobuf error.
//
//   node scripts/fetch-parakeet-model.mjs              # int8, ~660 MB (default)
//   node scripts/fetch-parakeet-model.mjs --precision fp32
//   node scripts/fetch-parakeet-model.mjs --check      # report only, download nothing
//   PARAKEET_MODEL_DIR=/opt/models/parakeet node scripts/fetch-parakeet-model.mjs

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const DEFAULT_REPO = "istupakov/parakeet-tdt-0.6b-v2-onnx";
const DEFAULT_MODEL_DIR = ".data/models/parakeet-tdt-0.6b-v2-onnx";
const HF_ENDPOINT = process.env.HF_ENDPOINT ?? "https://huggingface.co";

// The artefacts onnx_asr asks for, per precision. `nemo128.onnx` is the log-mel front end, not the
// acoustic model, and is shared by both.
const SHARED_FILES = ["config.json", "vocab.txt", "nemo128.onnx"];
const PRECISION_FILES = {
  int8: ["encoder-model.int8.onnx", "decoder_joint-model.int8.onnx"],
  // The fp32 encoder keeps its weights in a sidecar .data file; onnxruntime will not load the
  // graph without it, so it is listed explicitly rather than discovered.
  fp32: ["encoder-model.onnx", "encoder-model.onnx.data", "decoder_joint-model.onnx"],
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const modelDir = resolve(process.env.PARAKEET_MODEL_DIR ?? DEFAULT_MODEL_DIR);
  const repo = process.env.PARAKEET_MODEL_REPO ?? DEFAULT_REPO;

  console.log(`Parakeet model  : ${repo}`);
  console.log(`Precision       : ${options.precision}`);
  console.log(`Destination     : ${modelDir}`);
  console.log("");

  const wanted = new Set([...SHARED_FILES, ...PRECISION_FILES[options.precision]]);
  const entries = (await listRepoFiles(repo)).filter((entry) => wanted.has(entry.path));

  const missing = [...wanted].filter((path) => !entries.some((entry) => entry.path === path));
  if (missing.length > 0) {
    fail(
      `${repo} does not contain ${missing.join(", ")}.\n`
      + "The repository layout changed, or PARAKEET_MODEL_REPO points at a different export.\n"
      + `Inspect it at ${HF_ENDPOINT}/${repo}/tree/main`,
    );
  }

  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  console.log(`${entries.length} files, ${formatBytes(totalBytes)} total\n`);

  await mkdir(modelDir, { recursive: true });

  let downloaded = 0;
  let skipped = 0;
  for (const entry of entries) {
    const destination = join(modelDir, entry.path);
    const state = await verifyExisting(destination, entry);
    if (state === "ok") {
      console.log(`  ok       ${entry.path} (${formatBytes(entry.size)})`);
      skipped += 1;
      continue;
    }
    if (state === "corrupt") {
      console.log(`  corrupt  ${entry.path} — digest mismatch, re-downloading`);
      await rm(destination, { force: true });
    }
    if (options.check) {
      console.log(`  missing  ${entry.path} (${formatBytes(entry.size)})`);
      continue;
    }
    await download(repo, entry, destination);
    downloaded += 1;
  }

  console.log("");
  if (options.check) {
    console.log(`Check complete: ${skipped}/${entries.length} files present and verified.`);
    if (skipped < entries.length) {
      console.log("Run without --check to fetch the rest.");
      process.exitCode = 1;
    }
    return;
  }

  console.log(`Done: ${downloaded} downloaded, ${skipped} already present and verified.`);
  console.log("");
  console.log("Next:");
  console.log("  1. npm run parakeet:sidecar          # starts the ASR sidecar on :8977");
  console.log("  2. set TRANSCRIPTION_PROVIDER=parakeet in .env and restart the gateway");
}

/** The repo's file list with the digest the Hub says each file should have. */
async function listRepoFiles(repo) {
  const url = `${HF_ENDPOINT}/api/models/${repo}/tree/main?recursive=1`;
  let response;
  try {
    response = await fetch(url, { headers: hubHeaders() });
  } catch (error) {
    fail(
      `Could not reach the Hugging Face Hub at ${HF_ENDPOINT}: ${error.message}\n`
      + "Check network access, or set HF_ENDPOINT to a mirror.",
    );
  }
  if (response.status === 401 || response.status === 403) {
    fail(
      `${repo} refused the request (HTTP ${response.status}).\n`
      + "This model is CC-BY-4.0 and needs no token, so this is most likely a proxy or a stale\n"
      + "HF_TOKEN in the environment. Unset HF_TOKEN and retry.",
    );
  }
  if (response.status === 404) {
    fail(`${repo} does not exist on ${HF_ENDPOINT}. Check PARAKEET_MODEL_REPO.`);
  }
  if (!response.ok) {
    fail(`Hugging Face Hub returned HTTP ${response.status} listing ${repo}.`);
  }

  const tree = await response.json();
  return tree
    .filter((entry) => entry.type === "file")
    .map((entry) => ({
      path: entry.path,
      // An LFS pointer carries the real content sha256; a plain git blob carries a sha1 over
      // "blob <size>\0<content>". Both are checkable, so neither kind is taken on trust.
      size: entry.lfs?.size ?? entry.size,
      digest: entry.lfs?.oid ?? entry.oid,
      algorithm: entry.lfs ? "sha256" : "git-sha1",
    }));
}

/** "ok" when the file on disk matches the Hub digest, "missing", or "corrupt". */
async function verifyExisting(destination, entry) {
  let info;
  try {
    info = await stat(destination);
  } catch {
    return "missing";
  }
  if (info.size !== entry.size) return "corrupt";
  const actual = await digestFile(destination, entry);
  return actual === entry.digest ? "ok" : "corrupt";
}

async function download(repo, entry, destination) {
  const partial = `${destination}.part`;
  const url = `${HF_ENDPOINT}/${repo}/resolve/main/${entry.path}`;
  await mkdir(dirname(destination), { recursive: true });

  let resumeFrom = 0;
  try {
    const info = await stat(partial);
    // A .part larger than the Hub says the file is cannot be a prefix of it.
    resumeFrom = info.size < entry.size ? info.size : 0;
  } catch { /* no partial download to resume */ }

  const headers = hubHeaders();
  if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`;

  const label = resumeFrom > 0 ? `resume   ${entry.path}` : `fetch    ${entry.path}`;
  process.stdout.write(`  ${label} (${formatBytes(entry.size)})`);

  let response;
  try {
    response = await fetch(url, { headers, redirect: "follow" });
  } catch (error) {
    process.stdout.write("\n");
    fail(`Downloading ${entry.path} failed: ${error.message}`);
  }
  if (resumeFrom > 0 && response.status === 200) {
    // The server ignored the range; start over rather than appending to a prefix.
    resumeFrom = 0;
  } else if (resumeFrom > 0 && response.status !== 206) {
    process.stdout.write("\n");
    fail(`Resuming ${entry.path} failed: the server answered HTTP ${response.status}.`);
  }
  if (!response.ok) {
    process.stdout.write("\n");
    fail(`Downloading ${entry.path} failed: HTTP ${response.status} from ${url}`);
  }

  const sink = createWriteStream(partial, { flags: resumeFrom > 0 ? "a" : "w" });
  let written = resumeFrom;
  let lastReported = -1;
  const source = Readable.fromWeb(response.body);
  source.on("data", (chunk) => {
    written += chunk.length;
    const percent = Math.floor((written / entry.size) * 100 / 5) * 5;
    if (percent !== lastReported) {
      lastReported = percent;
      process.stdout.write(".");
    }
  });

  try {
    await pipeline(source, sink);
  } catch (error) {
    process.stdout.write("\n");
    if (error.code === "ENOSPC") {
      fail(
        `Ran out of disk space writing ${entry.path}.\n`
        + `The ${entry.algorithm === "sha256" ? "int8" : ""} export needs ${formatBytes(entry.size)} for this file alone;\n`
        + "free space or point PARAKEET_MODEL_DIR at a larger volume.",
      );
    }
    fail(`Writing ${entry.path} failed: ${error.message}`);
  }

  const actual = await digestFile(partial, entry);
  if (actual !== entry.digest) {
    await rm(partial, { force: true });
    process.stdout.write("\n");
    fail(
      `${entry.path} downloaded but its ${entry.algorithm} digest does not match the Hub.\n`
      + `  expected ${entry.digest}\n  actual   ${actual}\n`
      + "The partial file has been removed; re-run to try again.",
    );
  }

  await rename(partial, destination);
  process.stdout.write(" verified\n");
}

/**
 * Hashes a file the way the Hub identifies it.
 *
 * LFS objects are a plain sha256 of the content. Small files are ordinary git blobs, whose id is a
 * sha1 over the header "blob <size>\0" followed by the content — checking that costs nothing and
 * means config.json and vocab.txt are verified too, rather than assumed because they are small.
 */
async function digestFile(path, entry) {
  const hash = createHash(entry.algorithm === "sha256" ? "sha256" : "sha1");
  if (entry.algorithm === "git-sha1") {
    const info = await stat(path);
    hash.update(`blob ${info.size}\0`);
  }
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function hubHeaders() {
  const headers = { "user-agent": "next-coder-parakeet-fetch" };
  // Never required — the model is CC-BY-4.0 and ungated — but honoured if the operator has one.
  if (process.env.HF_TOKEN) headers.authorization = `Bearer ${process.env.HF_TOKEN}`;
  return headers;
}

function parseArgs(argv) {
  const options = { precision: "int8", check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--precision") options.precision = argv[index += 1];
    else if (arg.startsWith("--precision=")) options.precision = arg.slice("--precision=".length);
    else if (arg === "--help" || arg === "-h") usage(0);
    else fail(`Unknown argument ${arg}. Run with --help.`);
  }
  if (!Object.hasOwn(PRECISION_FILES, options.precision)) {
    fail(`--precision must be one of ${Object.keys(PRECISION_FILES).join(", ")}.`);
  }
  return options;
}

function usage(code) {
  console.log(`Usage: node scripts/fetch-parakeet-model.mjs [--precision int8|fp32] [--check]

  --precision int8   ~660 MB, the default; what the sidecar loads unless told otherwise
  --precision fp32   ~2.5 GB, marginally more accurate, noticeably slower on CPU
  --check            report which files are present and verified, download nothing

Environment:
  PARAKEET_MODEL_DIR    where the weights live (default ${DEFAULT_MODEL_DIR})
  PARAKEET_MODEL_REPO   Hugging Face repo (default ${DEFAULT_REPO})
  HF_ENDPOINT           Hub mirror (default https://huggingface.co)
`);
  process.exit(code);
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fail(messageText) {
  console.error(`\n${messageText}\n`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
