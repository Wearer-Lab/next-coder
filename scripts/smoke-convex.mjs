import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { createConfiguredStore } from "../src/storage.mjs";

const rootDir = new URL("..", import.meta.url);
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const WEBM_BASE64 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString("base64");

async function main() {
  const env = {
    ...process.env,
    ...await readEnvLocal(),
    STORAGE_PROVIDER: "convex",
    DEMO_MODE: "0",
    AUTH_PROVIDER: "dev",
    TRANSCRIPTION_PROVIDER: "mock",
    MEDIA_DIR: await mkdtemp(join(tmpdir(), "next-coder-convex-media-")),
  };

  const mockT3 = createMockT3Server();
  await listen(mockT3);
  const mockT3Url = `http://127.0.0.1:${mockT3.address().port}`;

  const config = loadConfig(env);
  const store = await createConfiguredStore(config);
  const { server, mediaJobRunner, releaseRolloutRunner } = createApp({ config, store });
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const authHeaders = await createDevAuthHeaders(baseUrl);
    const { device, secret } = await post(baseUrl, "/v1/devices", {
      label: `Convex smoke controller ${Date.now()}`,
      profile: "next-coder",
    }, authHeaders);
    const { environment } = await post(baseUrl, "/v1/t3/environments", {
      label: "Convex smoke T3",
      baseUrl: mockT3Url,
      accessToken: "mock-t3-token",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }, authHeaders);
    // A direct environment is unique by owner + normalized base URL. Use a distinct URL for the
    // disposable lifecycle row so this smoke test does not update and delete the primary row it
    // needs below. `localhost` reaches the same local mock if a future assertion probes it.
    const disposableT3Url = mockT3Url.replace("127.0.0.1", "localhost");
    const environmentHealth = await post(baseUrl, `/v1/t3/environments/${environment.id}/check`, {}, authHeaders);
    const environmentSnapshot = await get(baseUrl, `/v1/t3/environments/${environment.id}/snapshot`, authHeaders);
    const selectedThreadId = environmentSnapshot.snapshot.threads[0]?.id ?? "thread_convex_smoke";
    const { environment: disposableEnvironment } = await post(baseUrl, "/v1/t3/environments", {
      label: "Convex disposable T3",
      baseUrl: disposableT3Url,
      accessToken: "convex-disposable-token",
    }, authHeaders);
    const { environment: updatedEnvironment } = await put(
      baseUrl,
      `/v1/t3/environments/${disposableEnvironment.id}`,
      { label: "Convex updated disposable T3", baseUrl: disposableT3Url, accessToken: "convex-updated-disposable-token" },
      authHeaders,
    );
    const deletedEnvironment = await del(baseUrl, `/v1/t3/environments/${updatedEnvironment.id}`, authHeaders);
    const environmentList = await get(baseUrl, "/v1/t3/environments", authHeaders);
    const connectorList = await get(baseUrl, "/v1/connectors", authHeaders);
    const notifications = await get(baseUrl, "/v1/notifications?limit=1", authHeaders);
    const backgroundLiveness = await get(baseUrl, "/v1/background/liveness", authHeaders);
    const rolloutRun = await releaseRolloutRunner.runOnce({ limit: 1 });
    const privacy = await put(baseUrl, "/v1/settings/privacy", { mediaRetentionDays: 7 }, authHeaders);

    await put(baseUrl, `/v1/devices/${device.id}/config`, {
      environmentId: environment.id,
      threadId: selectedThreadId,
      defaultPrompt: "Convex smoke configured prompt.",
      menu: ["status", "prompt", "media", "stop"],
    }, authHeaders);

    const heartbeat = await post(baseUrl, "/v1/device/heartbeat", {
      firmwareVersion: "0.1.7",
      hardwareModel: "e213-esp32-s3r8",
      ipAddress: "192.168.4.20",
      wifiRssi: -61,
      freeHeap: 184320,
      uptimeMs: 120000,
    }, deviceHeaders(device.id, secret));

    const { media } = await post(baseUrl, "/v1/device/media", {
      kind: "image",
      contentType: "image/png",
      dataBase64: PNG_BASE64,
      originalName: "convex-smoke.png",
    }, deviceHeaders(device.id, secret));
    const { media: audioMedia } = await post(baseUrl, "/v1/media", {
      kind: "audio",
      contentType: "audio/webm",
      dataBase64: WEBM_BASE64,
      originalName: "convex-smoke.webm",
      transcript: "Use this Convex smoke audio transcript to continue the task.",
    }, authHeaders);
    const queuedTranscription = await post(
      baseUrl,
      `/v1/media/${audioMedia.id}/transcribe`,
      {},
      authHeaders,
    );
    await mediaJobRunner.runOnce();
    const transcribedAudio = (await get(baseUrl, "/v1/media", authHeaders)).media
      .find((item) => item.id === audioMedia.id);

    const disposableMedia = await post(baseUrl, "/v1/media", {
      kind: "image",
      contentType: "image/png",
      dataBase64: PNG_BASE64,
      originalName: "convex-delete-smoke.png",
    }, authHeaders);
    const deletedMedia = await del(baseUrl, `/v1/media/${disposableMedia.media.id}`, authHeaders);

    const fetchedMedia = await fetch(new URL(`/v1/media/${media.id}`, baseUrl), {
      headers: authHeaders,
    });
    if (!fetchedMedia.ok) throw new Error(`/v1/media/${media.id} failed with ${fetchedMedia.status}`);
    const fetchedMediaBase64 = Buffer.from(await fetchedMedia.arrayBuffer()).toString("base64");

    const prompt = await post(baseUrl, "/v1/device/intents", {
      intent: { type: "agent_prompt", text: "Convex smoke prompt." },
    }, deviceHeaders(device.id, secret));
    const shell = await post(baseUrl, "/v1/device/intents", {
      intent: { type: "shell_input", command: "npm test" },
    }, deviceHeaders(device.id, secret));
    const status = await post(baseUrl, "/v1/device/intents", {
      intent: { type: "status" },
    }, deviceHeaders(device.id, secret));
    const macro = await post(baseUrl, "/v1/macros", {
      label: "Convex smoke macro",
      environmentId: environment.id,
      threadId: selectedThreadId,
      intent: { type: "agent_prompt", text: "Convex smoke macro prompt." },
    }, authHeaders);
    const macroRun = await post(baseUrl, `/v1/macros/${macro.macro.id}/run`, {}, authHeaders);
    const deviceMacros = await get(baseUrl, "/v1/device/macros", deviceHeaders(device.id, secret));
    const deviceMacroRun = await post(
      baseUrl,
      `/v1/device/macros/${macro.macro.id}/run`,
      {},
      deviceHeaders(device.id, secret),
    );
    const camera = await post(baseUrl, "/v1/device/intents", {
      intent: {
        type: "camera_prompt",
        mediaUploadId: media.id,
        prompt: "Use this Convex smoke image as context.",
      },
    }, deviceHeaders(device.id, secret));
    const audio = await post(baseUrl, "/v1/intents", {
      environmentId: environment.id,
      threadId: selectedThreadId,
      intent: {
        type: "audio_prompt",
        mediaUploadId: audioMedia.id,
      },
    }, authHeaders);
    const dangerousShell = await post(baseUrl, "/v1/device/intents", {
      intent: { type: "shell_input", command: "rm -rf build" },
    }, deviceHeaders(device.id, secret));
    const approvalQueue = await get(baseUrl, "/v1/device/approvals", deviceHeaders(device.id, secret));
    const approvedShell = await post(
      baseUrl,
      `/v1/device/approvals/${dangerousShell.command.id}/approve`,
      {},
      deviceHeaders(device.id, secret),
    );
    const approvedShellEvents = await get(baseUrl, `/v1/commands/${dangerousShell.command.id}/events`, authHeaders);

    const devices = await get(baseUrl, "/v1/devices", authHeaders);
    const commandList = await get(baseUrl, "/v1/commands", authHeaders);
    const mediaList = await get(baseUrl, "/v1/media", authHeaders);
    const audit = await get(baseUrl, "/v1/audit", authHeaders);
    const display = await get(baseUrl, "/v1/display", authHeaders);
    const observability = await get(baseUrl, "/v1/observability/summary", authHeaders);
    const diagnostics = await get(baseUrl, "/v1/support/diagnostics", authHeaders);
    const transferDevice = await post(baseUrl, "/v1/devices", {
      label: `Convex transfer smoke controller ${Date.now()}`,
      profile: "next-coder",
    }, authHeaders);
    const profileUpdate = await put(
      baseUrl,
      `/v1/devices/${transferDevice.device.id}/profile`,
      { profile: "read-only" },
      authHeaders,
    );
    const transferReset = await post(
      baseUrl,
      `/v1/devices/${transferDevice.device.id}/transfer-reset`,
      {},
      authHeaders,
    );
    const transferSecret = "convex_smoke_transfer_secret_0123456789abcdef";
    await post(
      baseUrl,
      "/v1/device/credentials/stage",
      {
        rotationId: transferReset.rotation.id,
        credentialVersion: transferReset.rotation.pendingCredentialVersion,
        secret: transferSecret,
      },
      deviceHeaders(transferDevice.device.id, transferDevice.secret),
    );
    const transferAck = await post(
      baseUrl,
      "/v1/device/credentials/ack",
      {
        rotationId: transferReset.rotation.id,
        credentialVersion: transferReset.rotation.pendingCredentialVersion,
      },
      deviceHeaders(transferDevice.device.id, transferSecret),
    );
    const setupCode = await post(
      baseUrl,
      "/v1/device/setup-code",
      { rotate: true },
      deviceHeaders(transferReset.device.id, transferSecret),
    );

    assertEqual(prompt.command.status, "dispatched", "prompt command status");
    assertEqual(shell.command.status, "dispatched", "shell command status");
    assertEqual(status.command.status, "completed", "status command status");
    assertEqual(macroRun.command.status, "dispatched", "macro command status");
    assertEqual(deviceMacros.macros.length, 1, "device macro count");
    assertEqual(deviceMacroRun.command.status, "dispatched", "device macro command status");
    assertEqual(camera.command.status, "dispatched", "camera command status");
    assertEqual(audio.command.status, "dispatched", "audio command status");
    assertEqual(queuedTranscription.media.processing.transcriptionStatus, "processing", "queued transcription status");
    assertEqual(transcribedAudio.processing.transcriptionStatus, "ready", "transcription status");
    assertEqual(transcribedAudio.processing.transcriptSource, "mock", "transcription source");
    assertEqual(dangerousShell.command.status, "approval_required", "dangerous shell command status");
    assertEqual(approvalQueue.commands.length, 1, "device approval queue count");
    assertEqual(approvedShell.command.status, "dispatched", "approved shell command status");
    assertEqual(approvedShellEvents.events.length, 2, "approved shell event count");
    assertEqual(approvedShellEvents.events[0].status, "approval_required", "approved shell first event");
    assertEqual(approvedShellEvents.events[1].status, "dispatched", "approved shell second event");
    assertEqual(heartbeat.device.status.firmwareVersion, "0.1.7", "heartbeat firmware version");
    assertEqual(environmentHealth.environment.status, "reachable", "environment health status");
    assertEqual(updatedEnvironment.label, "Convex updated disposable T3", "updated environment label");
    assertEqual(deletedEnvironment.environment.id, updatedEnvironment.id, "deleted environment id");
    assertEqual(environmentList.environments.some((item) => item.id === environment.id), true, "primary environment retained");
    assertEqual(
      environmentList.environments.some((item) => item.id === updatedEnvironment.id && Boolean(item.archivedAt)),
      true,
      "archived environment list",
    );
    assertEqual(Array.isArray(connectorList.connectors), true, "connector list");
    assertEqual(Array.isArray(notifications.notifications), true, "notification list");
    assertEqual(typeof backgroundLiveness.scheduledWorker, "object", "background liveness");
    assertEqual(rolloutRun.skipped, false, "release rollout runner");
    assertEqual(privacy.privacy.mediaRetentionDays, 7, "privacy media retention");
    assertEqual(fetchedMediaBase64, PNG_BASE64, "downloaded media body");
    if (!media.expiresAt) throw new Error("uploaded media did not include expiresAt");
    assertEqual(deletedMedia.media.id, disposableMedia.media.id, "deleted media id");
    assertEqual(diagnostics.counts.devices, 1, "diagnostic device count");
    assertEqual(observability.summary.devices.online, 1, "observability online device count");
    assertEqual(diagnostics.observability.devices.online, observability.summary.devices.online, "diagnostic observability device count");
    assertEqual(profileUpdate.device.profile, "read-only", "updated device profile");
    assertEqual(transferReset.device.claimed, false, "transfer reset claimed state");
    assertEqual(transferReset.secret, undefined, "transfer reset secret is not exposed to the owner");
    assertEqual(transferReset.claimCode, undefined, "transfer reset claim code is not exposed to the former owner");
    assertEqual(transferAck.promoted, true, "transfer credential promoted");
    assertEqual(transferAck.resetForTransfer, true, "transfer credential reset purpose");
    if (!setupCode.setup.claimCode) throw new Error("setup code rotation did not return a claimCode");
    if (JSON.stringify(diagnostics).includes("rm -rf build")) {
      throw new Error("diagnostics bundle leaked raw shell command");
    }

    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      convexUrl: config.convexUrl,
      mockT3Url,
      deviceId: device.id,
      environmentId: environment.id,
      environmentTokenExpiresAt: environment.accessTokenExpiresAt,
      environmentHealth: environmentHealth.environment.health,
      environmentSnapshot: {
        projects: environmentSnapshot.snapshot.projects.length,
        threads: environmentSnapshot.snapshot.threads.length,
        selectedThreadId,
      },
      environmentLifecycle: {
        updated: updatedEnvironment.label,
        deleted: deletedEnvironment.environment.id,
      },
      mediaId: media.id,
      mediaExpiresAt: media.expiresAt,
      deletedMediaId: deletedMedia.media.id,
      privacy: privacy.privacy,
      heartbeat: heartbeat.device.status,
      commands: {
        prompt: prompt.command.status,
        shell: shell.command.status,
        status: status.command.status,
        macro: macroRun.command.status,
        deviceMacro: deviceMacroRun.command.status,
        camera: camera.command.status,
        audio: audio.command.status,
        transcription: transcribedAudio.processing.transcriptionStatus,
        dangerousShell: dangerousShell.command.status,
        approvedShell: approvedShell.command.status,
      },
      approvedShellEvents: approvedShellEvents.events.map((event) => event.status),
      transferReset: {
        deviceId: transferReset.device.id,
        profile: profileUpdate.device.profile,
        claimed: transferReset.device.claimed,
        ownerClaimCodeExposed: Boolean(transferReset.claimCode),
        setupCodeReady: Boolean(setupCode.setup.claimCode),
      },
      counts: {
        devices: devices.devices.length,
        commands: commandList.commands.length,
        media: mediaList.media.length,
        audit: audit.events.length,
      },
      diagnostics: {
        devices: diagnostics.counts.devices,
        commands: diagnostics.counts.commands,
        audit: diagnostics.counts.audit,
      },
      observability: {
        onlineDevices: observability.summary.devices.online,
        failedCommands: observability.summary.commands.failed,
        failedMediaProcessing: observability.summary.media.failedProcessing,
      },
      display: display.display,
    }, null, 2));
  } finally {
    server.close();
    mockT3.close();
    await rm(config.mediaDir, { recursive: true, force: true });
  }
}

async function readEnvLocal() {
  try {
    const text = await readFile(new URL(".env.local", rootDir), "utf8");
    return Object.fromEntries(
      text.split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const [key, ...rest] = line.split("=");
          return [key.trim(), stripInlineComment(rest.join("=").trim())];
        }),
    );
  } catch {
    return {};
  }
}

function stripInlineComment(value) {
  const commentIndex = value.indexOf(" #");
  return commentIndex >= 0 ? value.slice(0, commentIndex).trim() : value;
}

async function createDevAuthHeaders(baseUrl) {
  const created = await post(baseUrl, "/v1/users/dev", {
    userId: `convex_smoke_${Date.now()}`,
    email: "convex-smoke@example.local",
    tokenLabel: "Convex smoke script",
  });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}

function createMockT3Server() {
  const dispatches = [];
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/orchestration/snapshot") {
      return sendJson(res, 200, { projects: [{ id: "project_smoke" }], threads: [{ id: "thread_convex_smoke" }] });
    }
    if (req.method === "POST" && url.pathname === "/api/orchestration/dispatch") {
      const body = await readRequestJson(req);
      dispatches.push(body);
      return sendJson(res, 200, { status: "accepted", dispatchCount: dispatches.length, type: body.type });
    }
    return sendJson(res, 404, { error: "not found" });
  });
}

function deviceHeaders(deviceId, secret) {
  return {
    "x-device-id": deviceId,
    "x-device-secret": secret,
  };
}

async function get(baseUrl, path, headers = {}) {
  const response = await fetch(new URL(path, baseUrl), { headers });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function post(baseUrl, path, body, headers = {}) {
  return jsonWithBody(baseUrl, path, "POST", body, headers);
}

async function put(baseUrl, path, body, headers = {}) {
  return jsonWithBody(baseUrl, path, "PUT", body, headers);
}

async function del(baseUrl, path, headers = {}) {
  const response = await fetch(new URL(path, baseUrl), { method: "DELETE", headers });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function jsonWithBody(baseUrl, path, method, body, headers = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
