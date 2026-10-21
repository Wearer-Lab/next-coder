import { readEnv } from "./environment.mjs";

const baseUrl = readEnv(process.env, "NEXT_CODER_URL") ?? "http://127.0.0.1:8877";
const t3BaseUrl = process.env.MOCK_T3_URL ?? "http://127.0.0.1:3999";
const userId = readEnv(process.env, "NEXT_CODER_USER_ID") ?? "user_dev";

async function main() {
  await get("/health");
  const authHeaders = await createDevAuthHeaders();

  const { device, secret } = await post(
    "/v1/devices",
    { label: "Smoke test controller", profile: "next-coder" },
    authHeaders,
  );

  const { environment } = await post(
    "/v1/t3/environments",
    { label: "Mock T3", baseUrl: t3BaseUrl, pairingToken: "smoke" },
    authHeaders,
  );
  const environmentHealth = await post(`/v1/t3/environments/${environment.id}/check`, {}, authHeaders);
  const environmentSnapshot = await get(`/v1/t3/environments/${environment.id}/snapshot`, authHeaders);
  const selectedThreadId = environmentSnapshot.snapshot.threads[0]?.id ?? "thread_mock";
  const { environment: disposableEnvironment } = await post(
    "/v1/t3/environments",
    { label: "Disposable T3", baseUrl: t3BaseUrl, accessToken: "disposable-token" },
    authHeaders,
  );
  const { environment: updatedEnvironment } = await put(
    `/v1/t3/environments/${disposableEnvironment.id}`,
    { label: "Updated disposable T3", baseUrl: t3BaseUrl, accessToken: "updated-disposable-token" },
    authHeaders,
  );
  const deletedEnvironment = await del(`/v1/t3/environments/${updatedEnvironment.id}`, authHeaders);
  const privacy = await put("/v1/settings/privacy", { mediaRetentionDays: 7 }, authHeaders);

  const heartbeat = await post(
    "/v1/device/heartbeat",
    {
      firmwareVersion: "0.1.7",
      hardwareModel: "e213-esp32-s3r8",
      ipAddress: "192.168.4.20",
      wifiRssi: -61,
      freeHeap: 184320,
      uptimeMs: 120000,
    },
    deviceHeaders(device.id, secret),
  );

  const { media } = await post(
    "/v1/device/media",
    {
      kind: "image",
      contentType: "image/png",
      dataBase64: Buffer.from("smoke-image").toString("base64"),
      originalName: "smoke.png",
    },
    deviceHeaders(device.id, secret),
  );
  const { media: audioMedia } = await post(
    "/v1/media",
    {
      kind: "audio",
      contentType: "audio/webm",
      dataBase64: Buffer.from("smoke-audio").toString("base64"),
      originalName: "smoke.webm",
      transcript: "Use this smoke audio transcript to continue the task.",
    },
    authHeaders,
  );
  const transcribedAudio = await post(`/v1/media/${audioMedia.id}/transcribe`, {}, authHeaders);

  const disposableMedia = await post(
    "/v1/media",
    {
      kind: "image",
      contentType: "image/png",
      dataBase64: Buffer.from("delete-smoke-image").toString("base64"),
      originalName: "delete-smoke.png",
    },
    authHeaders,
  );
  const deletedMedia = await del(`/v1/media/${disposableMedia.media.id}`, authHeaders);

  const promptResult = await post(
    "/v1/device/intents",
    {
      environmentId: environment.id,
      threadId: selectedThreadId,
      intent: { type: "agent_prompt", text: "Smoke test prompt." },
    },
    deviceHeaders(device.id, secret),
  );

  const statusResult = await post(
    "/v1/device/intents",
    {
      environmentId: environment.id,
      intent: { type: "status" },
    },
    deviceHeaders(device.id, secret),
  );

  const macro = await post(
    "/v1/macros",
    {
      label: "Smoke macro",
      environmentId: environment.id,
      threadId: selectedThreadId,
      intent: { type: "agent_prompt", text: "Smoke test macro prompt." },
    },
    authHeaders,
  );
  const macroRun = await post(`/v1/macros/${macro.macro.id}/run`, {}, authHeaders);
  const deviceMacros = await get("/v1/device/macros", deviceHeaders(device.id, secret));
  const deviceMacroRun = await post(
    `/v1/device/macros/${macro.macro.id}/run`,
    {},
    deviceHeaders(device.id, secret),
  );

  const cameraPromptResult = await post(
    "/v1/device/intents",
    {
      environmentId: environment.id,
      threadId: selectedThreadId,
      intent: {
        type: "camera_prompt",
        mediaUploadId: media.id,
        prompt: "Use this smoke-test image as context.",
      },
    },
    deviceHeaders(device.id, secret),
  );
  const audioPromptResult = await post(
    "/v1/intents",
    {
      environmentId: environment.id,
      threadId: selectedThreadId,
      intent: {
        type: "audio_prompt",
        mediaUploadId: audioMedia.id,
      },
    },
    authHeaders,
  );

  const dangerousShell = await post(
    "/v1/device/intents",
    {
      environmentId: environment.id,
      threadId: selectedThreadId,
      intent: { type: "shell_input", command: "rm -rf build" },
    },
    deviceHeaders(device.id, secret),
  );
  const approvalQueue = await get("/v1/device/approvals", deviceHeaders(device.id, secret));
  const approvedShell = await post(
    `/v1/device/approvals/${dangerousShell.command.id}/approve`,
    {},
    deviceHeaders(device.id, secret),
  );
  const approvedShellEvents = await get(`/v1/commands/${dangerousShell.command.id}/events`, authHeaders);

  const displayResult = await get("/v1/display", authHeaders);
  const observability = await get("/v1/observability/summary", authHeaders);
  const diagnostics = await get("/v1/support/diagnostics", authHeaders);
  const transferDevice = await post(
    "/v1/devices",
    { label: "Transfer smoke controller", profile: "next-coder" },
    authHeaders,
  );
  const profileUpdate = await put(
    `/v1/devices/${transferDevice.device.id}/profile`,
    { profile: "read-only" },
    authHeaders,
  );
  const transferReset = await post(
    `/v1/devices/${transferDevice.device.id}/transfer-reset`,
    {},
    authHeaders,
  );
  const setupCode = await post(
    "/v1/device/setup-code",
    {},
    deviceHeaders(transferReset.device.id, transferReset.secret),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
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
        dispatchedCommandStatus: promptResult.command.status,
        macroCommandStatus: macroRun.command.status,
        deviceMacroCount: deviceMacros.macros.length,
        deviceMacroCommandStatus: deviceMacroRun.command.status,
        cameraCommandStatus: cameraPromptResult.command.status,
        audioCommandStatus: audioPromptResult.command.status,
        transcription: {
          provider: transcribedAudio.provider,
          status: transcribedAudio.media.processing.transcriptionStatus,
          source: transcribedAudio.media.processing.transcriptSource,
        },
        approvalQueueCount: approvalQueue.commands.length,
        approvedShellStatus: approvedShell.command.status,
        approvedShellEvents: approvedShellEvents.events.map((event) => event.status),
        transferReset: {
          deviceId: transferReset.device.id,
          profile: profileUpdate.device.profile,
          claimed: transferReset.device.claimed,
          claimCode: transferReset.claimCode,
          setupCode: setupCode.setup.claimCode,
        },
        screen: statusResult.screen,
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
        display: displayResult.display,
      },
      null,
      2,
    ),
  );
}

async function createDevAuthHeaders() {
  const created = await post("/v1/users/dev", {
    userId,
    email: "dev@example.local",
    tokenLabel: "Local smoke script",
  });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}

function deviceHeaders(deviceId, secret) {
  return {
    "x-device-id": deviceId,
    "x-device-secret": secret,
  };
}

async function get(path, headers = {}) {
  const response = await fetch(new URL(path, baseUrl), { headers });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  return data;
}

async function post(path, body, headers = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  return data;
}

async function put(path, body, headers = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method: "PUT",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  return data;
}

async function del(path, headers = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method: "DELETE",
    headers,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  return data;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
