import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGzip } from "node:zlib";

import { readEnv } from "../../scripts/environment.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..");
const defaultImage = "next-coder-control-plane:local-smoke";
const targetPlatform = "linux/amd64";
const emulatedStartupTimeoutMs = 90_000;
// Budget for the image as a gzip-compressed `docker save` archive. Neither `docker image inspect
// .Size` nor the raw archive is comparable across hosts: the classic overlay2 store reports and
// exports uncompressed layers (~227 MiB for this image, most of it the pinned
// node:22-bookworm-slim base) while Docker Desktop's containerd snapshotter reports and exports
// the compressed blobs (~78 MiB), so a budget on either passed locally and failed on the CI
// runner. Compressing the archive here yields the same number everywhere, within a few percent.
const maxImageArchiveBytes = 100 * 1024 * 1024;
const forbiddenEnvironmentName = /(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|CLERK|CONVEX|S3_)/u;
const allowedContextEntries = new Set([
  "!src/",
  "!src/**",
  "!cloudflare-control-plane/",
  "!cloudflare-control-plane/Dockerfile",
  "!cloudflare-control-plane/container-runtime/",
  "!cloudflare-control-plane/container-runtime/package.json",
  "!cloudflare-control-plane/container-runtime/package-lock.json",
]);

export async function validateReleaseFiles() {
  const [dockerfile, dockerignore, runtimePackageText, runtimeLockText, rootPackageText, rootLockText] = await Promise.all([
    readFile(resolve(packageRoot, "Dockerfile"), "utf8"),
    readFile(resolve(packageRoot, "Dockerfile.dockerignore"), "utf8"),
    readFile(resolve(packageRoot, "container-runtime/package.json"), "utf8"),
    readFile(resolve(packageRoot, "container-runtime/package-lock.json"), "utf8"),
    readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    readFile(resolve(repositoryRoot, "package-lock.json"), "utf8"),
  ]);
  const ignoreLines = dockerignore.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  assert.equal(ignoreLines[0], "**", "the build context must begin denied and opt files in explicitly");
  assert.deepEqual(new Set(ignoreLines.filter((line) => line.startsWith("!"))), allowedContextEntries);
  assert.match(dockerfile, /USER node/u);
  assert.match(dockerfile, /STOPSIGNAL SIGTERM/u);
  assert.match(dockerfile, /node:22\.21\.1-bookworm-slim@sha256:[a-f0-9]{64}/u);
  assert.doesNotMatch(dockerfile, /\b(?:ARG|ENV)\s+[^\n]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)/iu);
  assert.doesNotMatch(dockerfile, /COPY\s+(?:\.\s|\.\/|\*|package\.json|package-lock\.json)/u);

  const runtimePackage = JSON.parse(runtimePackageText);
  const runtimeLock = JSON.parse(runtimeLockText);
  const rootPackage = JSON.parse(rootPackageText);
  const rootLock = JSON.parse(rootLockText);
  const expectedRuntimeDependencies = ["@clerk/backend", "web-push"];
  assert.deepEqual(Object.keys(runtimePackage.dependencies ?? {}), expectedRuntimeDependencies);
  assert.deepEqual(Object.keys(runtimeLock.packages?.[""]?.dependencies ?? {}), expectedRuntimeDependencies);
  const runtimeClerkVersion = runtimeLock.packages?.["node_modules/@clerk/backend"]?.version;
  const rootClerkVersion = rootLock.packages?.["node_modules/@clerk/backend"]?.version;
  const runtimeWebPushVersion = runtimeLock.packages?.["node_modules/web-push"]?.version;
  const rootWebPushVersion = rootLock.packages?.["node_modules/web-push"]?.version;
  assert.equal(runtimeClerkVersion, rootClerkVersion, "container and application Clerk versions must stay aligned");
  assert.equal(runtimePackage.dependencies["@clerk/backend"], runtimeClerkVersion);
  assert.equal(rootPackage.dependencies["@clerk/backend"].replace(/^[~^]/u, ""), runtimeClerkVersion);
  assert.equal(runtimeWebPushVersion, rootWebPushVersion, "container and application Web Push versions must stay aligned");
  assert.equal(runtimePackage.dependencies["web-push"], runtimeWebPushVersion);
  assert.equal(rootPackage.dependencies["web-push"].replace(/^[~^]/u, ""), runtimeWebPushVersion);
  const runtimePackageCount = Object.keys(runtimeLock.packages ?? {}).filter(Boolean).length;
  assert.ok(runtimePackageCount <= 30, `runtime dependency closure grew to ${runtimePackageCount} packages`);
  return {
    runtimeDependencies: Object.keys(runtimePackage.dependencies),
    runtimeClerkVersion,
    runtimeWebPushVersion,
    runtimePackageCount,
  };
}

export async function runContainerSmoke({
  image = readEnv(process.env, "NEXT_CODER_CONTAINER_IMAGE") ?? defaultImage,
  build = readEnv(process.env, "NEXT_CODER_CONTAINER_SKIP_BUILD") !== "1",
} = {}) {
  const releaseFiles = await validateReleaseFiles();
  await capture("docker", ["version", "--format", "{{.Server.Arch}}"]);
  if (build) {
    await inherit("docker", [
      "build",
      "--platform", targetPlatform,
      "--progress=plain",
      "--tag", image,
      "--file", resolve(packageRoot, "Dockerfile"),
      repositoryRoot,
    ]);
  }

  const inspected = JSON.parse(await capture("docker", ["image", "inspect", image]));
  assert.equal(inspected.length, 1);
  const metadata = inspected[0];
  assert.equal(metadata.Os, "linux");
  assert.equal(metadata.Architecture, "amd64", "Cloudflare Containers require linux/amd64 images");
  assert.equal(metadata.Config?.User, "node");
  assert.equal(metadata.Config?.StopSignal, "SIGTERM");
  const archiveBytes = await measureImageArchive(image);
  assert.ok(archiveBytes <= maxImageArchiveBytes, `compressed image archive grew beyond 100 MiB: ${archiveBytes} bytes`);
  assert.ok(metadata.Config?.ExposedPorts?.["3996/tcp"]);
  assert.ok(metadata.Config?.ExposedPorts?.["3998/tcp"]);
  for (const entry of metadata.Config?.Env ?? []) {
    const name = entry.split("=", 1)[0] ?? "";
    assert.equal(forbiddenEnvironmentName.test(name), false, `secret-like image environment: ${name}`);
  }
  const history = await capture("docker", ["history", "--no-trunc", "--format", "{{.CreatedBy}}", image]);
  assert.doesNotMatch(history, /(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)=[^\s]+/iu);

  const imageContents = JSON.parse(await containerNode(image, `
    const fs = await import("node:fs");
    const packageJson = JSON.parse(fs.readFileSync("/app/package.json", "utf8"));
    await import("@clerk/backend");
    await import("web-push");
    process.stdout.write(JSON.stringify({
      appFiles: fs.readdirSync("/app").sort(),
      runtimeDependencies: Object.keys(packageJson.dependencies ?? {}),
    }));
  `));
  assert.deepEqual(imageContents.appFiles, ["node_modules", "package-lock.json", "package.json", "src"]);
  assert.deepEqual(imageContents.runtimeDependencies, releaseFiles.runtimeDependencies);

  const containerName = `next-coder-container-smoke-${process.pid}`;
  let created = false;
  const startupStartedAt = Date.now();
  try {
    await capture("docker", [
      "run", "--detach", "--name", containerName,
      "--platform", targetPlatform,
      "--publish", "127.0.0.1::3996",
      "--publish", "127.0.0.1::3998",
      "--env", "DEPLOYMENT_ENVIRONMENT=local",
      "--env", "STORAGE_PROVIDER=memory",
      "--env", "AUTH_PROVIDER=dev",
      "--env", "ENABLE_DEV_TOKENS=0",
      "--env", "DISCOVERY_ENABLED=0",
      "--env", "SNAPSHOT_POLL_ENABLED=0",
      "--env", "THREAD_STREAM_ENABLED=0",
      "--env", "TRANSCRIPTION_WORKER_ENABLED=0",
      image,
    ]);
    created = true;
    const publicPort = await publishedPort(containerName, "3996/tcp");
    const privatePort = await publishedPort(containerName, "3998/tcp");
    // Cloudflare runs amd64 natively. Apple Silicon Docker Desktop uses emulation and can spend
    // tens of seconds translating Node on a cold local run, so this is a local proof timeout rather
    // than a production startup SLO.
    const health = await waitForJson(`http://127.0.0.1:${publicPort}/health`, {}, emulatedStartupTimeoutMs);
    const startupMs = Date.now() - startupStartedAt;
    assert.equal(health.response.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(await capture("docker", ["exec", containerName, "id", "-u"]), "1000\n");
    assert.equal(await capture("docker", ["exec", containerName, "id", "-g"]), "1000\n");

    const privateResult = await waitForJson(`http://127.0.0.1:${privatePort}/v1/internal/background/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, taskId: "container_smoke", kind: "maintenance.targets", payload: {} }),
    }, 5_000);
    assert.equal(privateResult.response.status, 200);
    assert.deepEqual(privateResult.body.result, { userIds: [], nextCursor: null });
    const publicInternal = await fetch(`http://127.0.0.1:${publicPort}/v1/internal/background/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, taskId: "must_not_route", kind: "maintenance.targets", payload: {} }),
    });
    assert.equal(publicInternal.status, 404);
    await publicInternal.arrayBuffer();

    const stopStartedAt = Date.now();
    await capture("docker", ["stop", "--time", "10", containerName]);
    const stopMs = Date.now() - stopStartedAt;
    const state = JSON.parse(await capture("docker", ["container", "inspect", "--format", "{{json .State}}", containerName]));
    assert.equal(state.ExitCode, 0);
    assert.equal(state.OOMKilled, false);
    assert.equal(state.Running, false);
    assert.ok(stopMs < 10_000, `graceful stop took ${stopMs}ms`);
    const summary = {
      image,
      imageId: metadata.Id,
      platform: `${metadata.Os}/${metadata.Architecture}`,
      archiveBytes,
      reportedSizeBytes: metadata.Size,
      runtimeUser: metadata.Config.User,
      runtimeDependencies: releaseFiles.runtimeDependencies,
      runtimePackageCount: releaseFiles.runtimePackageCount,
      startupMs,
      stopMs,
      publicHealth: 200,
      privateBackground: 200,
      publicInternal: 404,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  } catch (error) {
    if (created) {
      const logs = await capture("docker", ["logs", containerName], { allowFailure: true, includeStderr: true });
      if (logs) process.stderr.write(`container logs:\n${logs}`);
    }
    throw error;
  } finally {
    if (created) await capture("docker", ["rm", "--force", containerName], { allowFailure: true });
  }
}

async function containerNode(image, source) {
  return await capture("docker", [
    "run", "--rm", "--platform", targetPlatform,
    "--entrypoint", "node", image,
    "--input-type=module", "--eval", source,
  ]);
}

async function publishedPort(containerName, containerPort) {
  const output = (await capture("docker", ["port", containerName, containerPort])).trim();
  const match = /:(\d+)$/u.exec(output);
  assert.ok(match?.[1], `missing published port for ${containerPort}`);
  return Number.parseInt(match[1], 10);
}

async function waitForJson(url, init, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, init);
      const body = await response.json();
      return { response, body };
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
  }
  throw new Error(`Timed out waiting for ${url}`, { cause: lastError });
}

async function inherit(command, args) {
  const result = await run(command, args, { stdio: "inherit" });
  if (result.timedOut) throw new Error(`${command} ${args[0] ?? ""} timed out`);
  if (result.code !== 0) throw new Error(`${command} ${args[0] ?? ""} failed (${result.code})`);
}

async function measureImageArchive(image) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("docker", ["save", image], { stdio: ["ignore", "pipe", "pipe"] });
    const gzip = createGzip();
    let bytes = 0;
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("docker save timed out"));
    }, 300_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.pipe(gzip);
    gzip.on("data", (chunk) => { bytes += chunk.length; });
    gzip.on("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.on("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.on("close", (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        rejectPromise(new Error(`docker save failed (${code}): ${stderr.trim()}`));
      }
    });
    gzip.on("end", () => { clearTimeout(timer); resolvePromise(bytes); });
  });
}

async function capture(command, args, { allowFailure = false, includeStderr = false } = {}) {
  let stdout = "";
  let stderr = "";
  const result = await run(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    onStdout: (chunk) => { stdout += chunk; },
    onStderr: (chunk) => { stderr += chunk; },
  });
  if (result.timedOut && !allowFailure) throw new Error(`${command} ${args[0] ?? ""} timed out`);
  if (result.code !== 0 && !allowFailure) {
    throw new Error(`${command} ${args[0] ?? ""} failed (${result.code}): ${stderr.trim()}`);
  }
  return includeStderr ? `${stdout}${stderr}` : stdout;
}

function run(command, args, {
  stdio,
  onStdout,
  onStderr,
  timeoutMs = args[0] === "build" ? 10 * 60_000 : 2 * 60_000,
} = {}) {
  return new Promise((resolveRun, reject) => {
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio,
      // This checkout can live in a macOS FileProvider-backed Documents directory. Buildx's
      // optional VCS label probe blocks while hydrating .git/HEAD there, before BuildKit even
      // receives the allowlisted context. Release identity comes from the resulting image ID;
      // source provenance belongs in CI attestation, not an implicit local filesystem probe.
      env: {
        ...process.env,
        BUILDX_GIT_INFO: "false",
        BUILDX_GIT_LABELS: "false",
        BUILDX_GIT_CHECK_DIRTY: "false",
      },
    });
    child.stdout?.on("data", (chunk) => onStdout?.(String(chunk)));
    child.stderr?.on("data", (chunk) => onStderr?.(String(chunk)));
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveRun({ code: code ?? (signal ? 1 : 0), signal, timedOut });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runContainerSmoke();
}
