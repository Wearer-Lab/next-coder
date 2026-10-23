import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import { deviceJobStatus, milestoneForJob } from "../src/deviceAudio.mjs";

// The device audio loop end to end: a controller records, uploads, and gets back one identifier it
// can poll until a word appears on its screen. Everything here drives the real HTTP surface with a
// real device credential, because the point of the loop is that the hardware needs no other route.

const AUDIO = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString("base64");
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * A gateway with a claimed controller, a paired environment, and the mock ASR provider.
 *
 * The worker is never started — `mediaJobRunner.runOnce()` is called explicitly, so no assertion
 * here depends on a timer firing.
 */
async function setupLoop(t, { profile = "next-coder", scheduleMediaProcessing = null } = {}) {
  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-device-audio-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ status: "accepted" }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const appConfig = { mediaDir, maxMediaBytes: 4096, transcriptionProvider: "mock", demoMode: false };
  const { server, mediaJobRunner, store } = createApp({ config: appConfig, scheduleMediaProcessing });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = (path, input = {}) => requestJson(originalFetch, baseUrl, path, input);

  const auth = await call("/v1/users/dev", {
    method: "POST",
    headers: {},
    body: { userId: "user_dev", email: "dev@example.local" },
  });
  const authToken = auth.apiToken.secret;
  const authHeaders = { authorization: `Bearer ${authToken}` };
  const environment = await call("/v1/t3/environments", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Mock T3", baseUrl: "https://mock-t3.example", accessToken: "mock-token" },
  });
  const created = await call("/v1/devices", {
    method: "POST",
    headers: authHeaders,
    body: { label: "Kitchen controller", profile },
  });
  const deviceHeaders = { "x-device-id": created.device.id, "x-device-secret": created.secret };

  await call(`/v1/devices/${created.device.id}/config`, {
    method: "PUT",
    headers: authHeaders,
    body: { environmentId: environment.environment.id, threadId: "thread_voice" },
  });

  const upload = (body = {}) => call("/v1/device/media", {
    method: "POST",
    headers: deviceHeaders,
    body: { kind: "audio", contentType: "audio/webm", dataBase64: AUDIO, originalName: "note.webm", ...body },
  });

  const readMedia = async (mediaId) => {
    const listed = await call("/v1/media", { headers: authHeaders });
    return listed.media.find((item) => item.id === mediaId) ?? null;
  };

  return {
    call,
    readMedia,
    baseUrl,
    authToken,
    rawFetch: originalFetch,
    authHeaders,
    deviceHeaders,
    device: created.device,
    environment: environment.environment,
    mediaJobRunner,
    store,
    appConfig,
    dispatches,
    upload,
    enableAutoSend: (enabled = true) => call(`/v1/devices/${created.device.id}/voice-auto-send`, {
      method: "PUT",
      headers: authHeaders,
      body: { enabled },
    }),
    readAutoSend: () => call(`/v1/devices/${created.device.id}/voice-auto-send`, { headers: authHeaders }),
    // What the hardware declares about itself, which is the only evidence the default is allowed
    // to act on.
    heartbeat: (features = ["display", "buttons"]) => call("/v1/device/heartbeat", {
      method: "POST",
      headers: deviceHeaders,
      body: { status: { features, firmwareVersion: "1.0.0" } },
    }),
  };
}

test("device audio is queued for transcription without anyone asking", async (t) => {
  const loop = await setupLoop(t);

  const uploaded = await loop.upload();

  // The whole contract the firmware needs: one id, one word, and whether to keep polling.
  assert.equal(uploaded.media.kind, "audio");
  assert.equal(typeof uploaded.job.jobId, "string");
  assert.equal(uploaded.job.mediaId, uploaded.media.id);
  assert.equal(uploaded.job.milestone, "transcribing");
  assert.equal(uploaded.job.done, false);
  assert.equal(uploaded.job.transcript, null);
  assert.equal(uploaded.media.processing.transcriptionStatus, "processing");

  // The owner-facing view agrees, and knows which controller recorded it.
  const owned = await loop.call(`/v1/media/jobs/${uploaded.job.jobId}`, { headers: loop.authHeaders });
  assert.equal(owned.job.deviceId, loop.device.id);
  assert.equal(owned.job.stage, "queued");
  assert.equal(owned.job.environmentId, loop.environment.id);
  assert.equal(owned.job.threadId, "thread_voice");
});

test("device polling stays active while T3 dispatch is pending, then receives Sent and its reply cursor", { timeout: 10000 }, async (t) => {
  const loop = await setupLoop(t);
  await loop.enableAutoSend(true);
  const uploaded = await loop.upload();
  let releaseDispatch;
  let dispatchStarted;
  const dispatchGate = new Promise((resolve) => { releaseDispatch = resolve; });
  const started = new Promise((resolve) => { dispatchStarted = resolve; });
  const mockFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (new URL(String(url)).pathname === "/api/orchestration/dispatch") {
      dispatchStarted();
      await dispatchGate;
    }
    return await mockFetch(url, init);
  };
  t.after(() => releaseDispatch());
  const running = loop.mediaJobRunner.runOnce();
  await started;
  try {
    const stored = await loop.store.getMediaJobForUser("user_dev", uploaded.job.jobId);
    assert.equal(stored.stage, "dispatching");
    // This used to report terminal Ready, causing the firmware to stop before Sent existed.
    const pending = await loop.call(`/v1/device/media/jobs/${uploaded.job.jobId}`, { headers: loop.deviceHeaders });
    assert.equal(pending.job.milestone, "transcribing");
    assert.equal(pending.job.done, false);
    assert.equal(pending.job.commandId, null);
    assert.equal(pending.job.responseAfter, undefined);
  } finally {
    releaseDispatch();
    await running;
  }
  const sent = await loop.call(`/v1/device/media/jobs/${uploaded.job.jobId}`, { headers: loop.deviceHeaders });
  assert.equal(sent.job.milestone, "sent");
  assert.equal(sent.job.done, true);
  assert.equal(typeof sent.job.commandId, "string");
  const receipt = await loop.call(`/v1/commands/${sent.job.commandId}/events`, { headers: loop.authHeaders });
  assert.equal(sent.job.responseAfter, receipt.command.metrics.dispatchStartedAt);
  assert.equal(loop.dispatches.length, 1);
});

test("replaying device finalize after auto-send returns the original job and never dispatches the capture twice", async (t) => {
  const loop = await setupLoop(t);
  await loop.heartbeat(["display", "buttons", "microphone"]);
  const bytes = Buffer.from(AUDIO, "base64");
  const created = await loop.call("/v1/device/media/uploads", {
    method: "POST", headers: loop.deviceHeaders,
    body: { clientRequestId: "device:voice-finalize-replay", kind: "audio", contentType: "audio/webm",
      sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
  });
  const put = await loop.rawFetch(new URL(created.session.upload.url, loop.baseUrl), {
    method: "PUT", headers: { ...loop.deviceHeaders, "content-type": "audio/webm" }, body: bytes,
  });
  assert.equal(put.status, 200);
  const finalize = () => loop.call(created.session.finalizeUrl, { method: "POST", headers: loop.deviceHeaders, body: {} });
  const first = await finalize();
  await loop.mediaJobRunner.runOnce();
  const completed = await loop.call(`/v1/device/media/jobs/${first.job.jobId}`, { headers: loop.deviceHeaders });
  assert.equal(completed.job.milestone, "sent");
  assert.equal(loop.dispatches.length, 1);
  const replay = await finalize();
  assert.equal(replay.job.jobId, first.job.jobId);
  assert.equal(replay.job.commandId, completed.job.commandId);
  assert.equal(replay.job.milestone, "sent");
  assert.equal(replay.media.processing.transcriptionStatus, "ready");
  await loop.mediaJobRunner.runOnce();
  assert.equal(loop.dispatches.length, 1);
  const owned = await loop.call(`/v1/commands/${completed.job.commandId}/events`, { headers: loop.authHeaders });
  assert.equal(completed.job.responseAfter, owned.command.metrics.dispatchStartedAt);
});

test("raw voice upload freezes its target before bytes arrive and refuses stale capture context", async (t) => {
  const loop = await setupLoop(t);
  const bytes = Buffer.from(AUDIO, "base64");
  const descriptor = { clientRequestId: "device:pinned-voice-target", kind: "audio", contentType: "audio/webm",
    environmentId: loop.environment.id, threadId: "thread_voice", sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
  const created = await loop.call("/v1/device/media/uploads", { method: "POST", headers: loop.deviceHeaders, body: descriptor });
  await loop.call(`/v1/devices/${loop.device.id}/config`, {
    method: "PUT", headers: loop.authHeaders, body: { environmentId: loop.environment.id, threadId: "thread_changed" },
  });
  const stale = await loop.rawFetch(new URL("/v1/device/media/uploads", loop.baseUrl), {
    method: "POST", headers: { ...loop.deviceHeaders, "content-type": "application/json" }, body: JSON.stringify(descriptor),
  });
  assert.equal(stale.status, 409);
  const put = await loop.rawFetch(new URL(created.session.upload.url, loop.baseUrl), {
    method: "PUT", headers: { ...loop.deviceHeaders, "content-type": "audio/webm" }, body: bytes,
  });
  assert.equal(put.status, 200);
  const finalized = await loop.call(created.session.finalizeUrl, {
    method: "POST", headers: loop.deviceHeaders,
    body: { environmentId: loop.environment.id, threadId: "thread_voice" },
  });
  const job = await loop.call(`/v1/media/jobs/${finalized.job.jobId}`, { headers: loop.authHeaders });
  assert.equal(job.job.threadId, "thread_voice");
  assert.equal(job.job.environmentId, loop.environment.id);
  const conflict = await loop.rawFetch(new URL("/v1/device/media/uploads", loop.baseUrl), {
    method: "POST", headers: { ...loop.deviceHeaders, "content-type": "application/json" },
    body: JSON.stringify({ ...descriptor, threadId: "thread_changed" }),
  });
  assert.equal(conflict.status, 409, "one receipt cannot be rebound to a different thread");
  const distinct = await loop.call("/v1/device/media/uploads", {
    method: "POST", headers: loop.deviceHeaders,
    body: { ...descriptor, clientRequestId: "device:new-voice-capture", threadId: "thread_changed" },
  });
  assert.notEqual(distinct.session.id, created.session.id, "identical bytes in a new recording remain a new intent");
});

test("an unbound recording cannot inherit a later device target", async (t) => {
  const loop = await setupLoop(t);
  const unbound = await loop.call("/v1/devices", { method: "POST", headers: loop.authHeaders,
    body: { label: "Unbound microphone", profile: "next-coder" } });
  const headers = { "x-device-id": unbound.device.id, "x-device-secret": unbound.secret };
  await loop.call("/v1/device/heartbeat", { method: "POST", headers, body: { status: { features: ["microphone"] } } });
  const bytes = Buffer.from(AUDIO, "base64");
  const refused = await loop.rawFetch(new URL("/v1/device/media/uploads", loop.baseUrl), {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: "device:unbound-capture", kind: "audio", contentType: "audio/webm",
      sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }),
  });
  assert.equal(refused.status, 409);
  const legacy = await loop.call("/v1/device/media", { method: "POST", headers,
    body: { kind: "audio", contentType: "audio/webm", dataBase64: AUDIO } });
  await loop.call(`/v1/devices/${unbound.device.id}/config`, { method: "PUT", headers: loop.authHeaders,
    body: { environmentId: loop.environment.id, threadId: "later_thread" } });
  await loop.mediaJobRunner.runOnce();
  assert.equal(loop.dispatches.length, 0);
  const result = await loop.call(`/v1/device/media/jobs/${legacy.job.jobId}`, { headers });
  assert.equal(result.job.milestone, "failed");
});

test("an image from a device is stored without inventing a transcription job", async (t) => {
  const loop = await setupLoop(t);

  const uploaded = await loop.call("/v1/device/media", {
    method: "POST",
    headers: loop.deviceHeaders,
    body: {
      kind: "image",
      contentType: "image/png",
      dataBase64: PNG_BASE64,
    },
  });

  assert.equal(uploaded.media.kind, "image");
  assert.equal(uploaded.job, null);
});

test("the device status endpoint reports each milestone in turn", async (t) => {
  const loop = await setupLoop(t);
  const uploaded = await loop.upload();
  const poll = () => loop.call(`/v1/device/media/jobs/${uploaded.job.jobId}`, { headers: loop.deviceHeaders });

  const queued = await poll();
  assert.equal(queued.job.milestone, "transcribing");
  assert.equal(queued.job.label, "Transcribing");
  assert.equal(queued.job.done, false);

  await loop.mediaJobRunner.runOnce();

  const finished = await poll();
  // Auto-send is off by default, so the capture stops here and waits for a person.
  assert.equal(finished.job.milestone, "ready");
  assert.equal(finished.job.label, "Ready to send");
  assert.equal(finished.job.done, true);
  assert.equal(finished.job.ok, true);
  assert.match(finished.job.transcript, /Mock transcript/u);
  assert.equal(finished.job.commandId, null);

  // Bookkeeping the screen cannot render stays on the owner-facing route.
  for (const field of ["attempts", "maxAttempts", "leaseOwner", "timings", "stage", "rawTranscript"]) {
    assert.equal(Object.hasOwn(finished.job, field), false, `${field} does not belong on the device view`);
  }
});

test("auto-send off leaves the transcript ready and dispatches nothing", async (t) => {
  const loop = await setupLoop(t);
  const uploaded = await loop.upload();

  await loop.mediaJobRunner.runOnce();

  assert.deepEqual(loop.dispatches, []);
  const status = await loop.call(`/v1/device/media/jobs/${uploaded.job.jobId}`, { headers: loop.deviceHeaders });
  assert.equal(status.job.milestone, "ready");
  assert.equal(status.job.autoSend, false);

  // Waiting is not the same as losing the work: the transcript is on the media record and any
  // later prompt can use it.
  const owned = await loop.call(`/v1/media/jobs/${uploaded.job.jobId}`, { headers: loop.authHeaders });
  assert.equal(owned.job.stage, "dispatched");
  assert.equal(owned.job.dispatchStatus, null);
  const media = await loop.readMedia(uploaded.media.id);
  assert.match(media.transcript, /Mock transcript/u);
  assert.equal(media.processing.transcriptionStatus, "ready");
});

test("a device that has never claimed a microphone gets no default grant", async (t) => {
  const loop = await setupLoop(t);

  // Never heartbeated at all: nothing has told the gateway this unit can hear anything.
  const silent = await loop.readAutoSend();
  assert.equal(silent.voiceAutoSend.enabled, false);
  assert.equal(silent.voiceAutoSend.source, "default");
  assert.equal(silent.voiceAutoSend.ownerChoice, null);
  assert.equal(silent.voiceAutoSend.audioCapable, false);

  // And a heartbeat that declares a screen and buttons is still not a microphone. The default is
  // built on evidence, not on the hardware model's datasheet.
  await loop.heartbeat(["display", "buttons", "ota"]);
  const after = await loop.readAutoSend();
  assert.equal(after.voiceAutoSend.enabled, false);
  assert.equal(after.voiceAutoSend.audioCapable, false);

  const uploaded = await loop.upload();
  await loop.mediaJobRunner.runOnce();
  assert.deepEqual(loop.dispatches, []);
  const status = await loop.call(`/v1/device/media/jobs/${uploaded.job.jobId}`, { headers: loop.deviceHeaders });
  assert.equal(status.job.milestone, "ready");
  assert.equal(status.job.autoSend, false);
});

test("a controller that reports a microphone auto-sends by default, with nobody credited", async (t) => {
  const loop = await setupLoop(t);
  await loop.heartbeat(["display", "buttons", "microphone"]);

  const grant = await loop.readAutoSend();
  assert.equal(grant.voiceAutoSend.enabled, true);
  assert.equal(grant.voiceAutoSend.source, "default");
  assert.equal(grant.voiceAutoSend.ownerChoice, null);
  assert.equal(grant.voiceAutoSend.audioCapable, true);
  // A default has no human behind it. Filling these in would forge a grant nobody issued.
  assert.equal(grant.voiceAutoSend.enabledBy, null);
  assert.equal(grant.voiceAutoSend.enabledAt, null);

  const uploaded = await loop.upload();
  await loop.mediaJobRunner.runOnce();

  assert.equal(loop.dispatches.length, 1);
  const status = await loop.call(`/v1/device/media/jobs/${uploaded.job.jobId}`, { headers: loop.deviceHeaders });
  assert.equal(status.job.milestone, "sent");
  assert.equal(status.job.autoSend, true);
});

test("an owner's explicit off is never undone by the default", async (t) => {
  const loop = await setupLoop(t);
  await loop.heartbeat(["microphone"]);

  const off = await loop.enableAutoSend(false);
  assert.equal(off.voiceAutoSend.enabled, false);
  assert.equal(off.voiceAutoSend.ownerChoice, false);
  assert.equal(off.voiceAutoSend.source, "owner");
  // The device is audio-capable and the default would say yes; the owner said no and that wins.
  assert.equal(off.voiceAutoSend.audioCapable, true);

  // A firmware update that re-declares the microphone is exactly the event that would flip a
  // two-state model back on. The decision is stored separately from the capability, so it cannot.
  await loop.heartbeat(["display", "microphone", "camera"]);
  const stillOff = await loop.readAutoSend();
  assert.equal(stillOff.voiceAutoSend.enabled, false);
  assert.equal(stillOff.voiceAutoSend.ownerChoice, false);

  const uploaded = await loop.upload();
  await loop.mediaJobRunner.runOnce();
  assert.deepEqual(loop.dispatches, []);
  const status = await loop.call(`/v1/device/media/jobs/${uploaded.job.jobId}`, { headers: loop.deviceHeaders });
  assert.equal(status.job.milestone, "ready");
  assert.equal(status.job.autoSend, false);
});

test("the owner's decision can be withdrawn, which restores the default rather than a value", async (t) => {
  const loop = await setupLoop(t);
  await loop.heartbeat(["microphone"]);
  await loop.enableAutoSend(false);

  const cleared = await loop.enableAutoSend(null);
  assert.equal(cleared.voiceAutoSend.ownerChoice, null);
  assert.equal(cleared.voiceAutoSend.source, "default");
  // Back to what the hardware says, which for this unit is on.
  assert.equal(cleared.voiceAutoSend.enabled, true);

  const audit = await loop.call("/v1/audit", { headers: loop.authHeaders });
  const actions = audit.events.map((event) => event.action);
  assert.ok(actions.includes("device.voice_auto_send_disabled"));
  assert.ok(actions.includes("device.voice_auto_send_reset"));
});

test("an explicit grant records who made it, and an unreadable answer is refused", async (t) => {
  const loop = await setupLoop(t);

  const granted = await loop.enableAutoSend(true);
  assert.equal(granted.voiceAutoSend.enabled, true);
  assert.equal(granted.voiceAutoSend.source, "owner");
  assert.equal(granted.voiceAutoSend.ownerChoice, true);
  assert.equal(granted.voiceAutoSend.enabledBy, "user_dev");
  assert.match(granted.voiceAutoSend.enabledAt, /^\d{4}-\d{2}-\d{2}T/u);

  // Revoking clears the grant rather than leaving a name on a permission nobody holds.
  const revoked = await loop.enableAutoSend(false);
  assert.equal(revoked.voiceAutoSend.enabledBy, null);
  assert.equal(revoked.voiceAutoSend.enabledAt, null);

  await assert.rejects(
    () => loop.call(`/v1/devices/${loop.device.id}/voice-auto-send`, {
      method: "PUT",
      headers: loop.authHeaders,
      body: { enabled: "yes" },
    }),
    /400/u,
  );
  // An omitted field is a malformed request, not a third state expressed by silence.
  await assert.rejects(
    () => loop.call(`/v1/devices/${loop.device.id}/voice-auto-send`, {
      method: "PUT",
      headers: loop.authHeaders,
      body: {},
    }),
    /400/u,
  );
});

test("auto-send on dispatches the transcript through the ordinary policy path", async (t) => {
  const loop = await setupLoop(t);
  await loop.enableAutoSend(true);

  const uploaded = await loop.upload();
  await loop.mediaJobRunner.runOnce();

  assert.equal(loop.dispatches.length, 1);
  assert.equal(loop.dispatches[0].type, "thread.turn.start");
  assert.match(loop.dispatches[0].message.text, /Mock transcript/u);
  // The certified T3 adapter accepts the reviewed transcript, not private raw audio bytes.
  assert.deepEqual(loop.dispatches[0].message.attachments, []);

  const status = await loop.call(`/v1/device/media/jobs/${uploaded.job.jobId}`, { headers: loop.deviceHeaders });
  assert.equal(status.job.milestone, "sent");
  assert.equal(status.job.label, "Sent");
  assert.equal(status.job.autoSend, true);
  assert.equal(status.job.done, true);
  assert.equal(typeof status.job.commandId, "string");

  // It is a real command on the ordinary timeline, credited to the device that recorded it.
  const commands = await loop.call("/v1/commands", { headers: loop.authHeaders });
  const command = commands.commands.find((entry) => entry.id === status.job.commandId);
  assert.equal(command.status, "dispatched");
  assert.equal(command.deviceId, loop.device.id);
  assert.equal(command.threadId, "thread_voice");
});

test("policy is applied at dispatch, so a tightened profile stops a queued capture", async (t) => {
  const loop = await setupLoop(t);
  await loop.enableAutoSend(true);

  // Recorded and queued while the controller was still allowed to drive the agent...
  const uploaded = await loop.upload();

  // ...and demoted before the worker gets to it. The newer rule has to win, which is the whole
  // reason policy is evaluated at dispatch rather than captured at enqueue.
  await loop.call(`/v1/devices/${loop.device.id}/profile`, {
    method: "PUT",
    headers: loop.authHeaders,
    body: { profile: "read-only" },
  });

  await loop.mediaJobRunner.runOnce();

  assert.deepEqual(loop.dispatches, []);
  const status = await loop.call(`/v1/device/media/jobs/${uploaded.job.jobId}`, { headers: loop.deviceHeaders });
  assert.equal(status.job.milestone, "failed");
  assert.equal(status.job.ok, false);
  assert.match(status.job.error, /policy/iu);

  // The refusal is about the send. What the controller heard was still transcribed and kept.
  const media = await loop.readMedia(uploaded.media.id);
  assert.match(media.transcript, /Mock transcript/u);
  const owned = await loop.call(`/v1/media/jobs/${uploaded.job.jobId}`, { headers: loop.authHeaders });
  assert.equal(owned.job.dispatchStatus, "blocked");
  assert.equal(owned.job.stage, "dispatched");
});

test("revoking auto-send while a capture is queued stops it from being sent", async (t) => {
  const loop = await setupLoop(t);
  await loop.enableAutoSend(true);
  const uploaded = await loop.upload();
  await loop.enableAutoSend(false);

  await loop.mediaJobRunner.runOnce();

  assert.deepEqual(loop.dispatches, []);
  const status = await loop.call(`/v1/device/media/jobs/${uploaded.job.jobId}`, { headers: loop.deviceHeaders });
  assert.equal(status.job.milestone, "ready");
  assert.equal(status.job.autoSend, false);
});

test("revoking the device while a capture is queued stops the send", async (t) => {
  const loop = await setupLoop(t);
  await loop.enableAutoSend(true);
  const uploaded = await loop.upload();

  // getDeviceForUser still answers for a revoked device, so the worker has to check: the grant
  // died with the pairing, and a capture recorded before the revocation must not outlive it.
  await loop.call(`/v1/devices/${loop.device.id}/revoke`, {
    method: "POST",
    headers: loop.authHeaders,
    body: {},
  });

  await loop.mediaJobRunner.runOnce();

  assert.deepEqual(loop.dispatches, []);
  const owned = await loop.call(`/v1/media/jobs/${uploaded.job.jobId}`, { headers: loop.authHeaders });
  assert.equal(owned.job.dispatchStatus, null);
  assert.equal(owned.job.autoSend, false);
  // The transcript is still the owner's to read; only the send was withdrawn.
  assert.match(owned.job.normalizedTranscript, /Mock transcript/u);
});

test("one controller cannot read another controller's capture", async (t) => {
  const loop = await setupLoop(t);
  const uploaded = await loop.upload();

  // A second controller on the same account. Same owner, different microphone, different room.
  const sibling = await loop.call("/v1/devices", {
    method: "POST",
    headers: loop.authHeaders,
    body: { label: "Study controller", profile: "next-coder" },
  });

  await assert.rejects(
    () => loop.call(`/v1/device/media/jobs/${uploaded.job.jobId}`, {
      headers: { "x-device-id": sibling.device.id, "x-device-secret": sibling.secret },
    }),
    /404/u,
  );

  // And the device that did record it still can.
  const mine = await loop.call(`/v1/device/media/jobs/${uploaded.job.jobId}`, { headers: loop.deviceHeaders });
  assert.equal(mine.job.jobId, uploaded.job.jobId);
});

test("a capture made by the console carries no device and never auto-sends", async (t) => {
  const loop = await setupLoop(t);
  await loop.enableAutoSend(true);

  const uploaded = await loop.call("/v1/media", {
    method: "POST",
    headers: loop.authHeaders,
    body: { kind: "audio", contentType: "audio/webm", dataBase64: AUDIO, originalName: "typed.webm" },
  });
  const queued = await loop.call(`/v1/media/${uploaded.media.id}/transcribe`, {
    method: "POST",
    headers: loop.authHeaders,
    body: {},
  });
  await loop.mediaJobRunner.runOnce();

  assert.deepEqual(loop.dispatches, []);
  const job = await loop.call(`/v1/media/jobs/${queued.job.id}`, { headers: loop.authHeaders });
  assert.equal(job.job.deviceId, null);
  assert.equal(job.job.dispatchStatus, null);
  assert.equal(job.job.autoSend, false);

  // The device grant is a grant for that device, not for the account.
  await assert.rejects(
    () => loop.call(`/v1/device/media/jobs/${queued.job.id}`, { headers: loop.deviceHeaders }),
    /404/u,
  );
});

test("progress reaches the console over the existing event stream", async (t) => {
  const loop = await setupLoop(t);
  await loop.enableAutoSend(true);
  const controller = new AbortController();
  t.after(() => controller.abort());

  const stream = await loop.rawFetch(
    new URL(`/v1/events?token=${encodeURIComponent(loop.authToken)}`, loop.baseUrl),
    { signal: controller.signal },
  );
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();

  // Queued the moment the upload lands, rather than on the worker's next tick — a console that
  // waited for the tick would show nothing for seconds after someone spoke.
  const uploaded = await loop.upload();
  const queued = await readStreamUntil(reader, '"milestone":"transcribing"');
  assert.match(queued, /event: media\.job/u);
  assert.match(queued, new RegExp(`"jobId":"${uploaded.job.jobId}"`, "u"));
  assert.match(queued, new RegExp(`"deviceId":"${loop.device.id}"`, "u"));

  await loop.mediaJobRunner.runOnce();

  const sent = await readStreamUntil(reader, '"milestone":"sent"');
  assert.match(sent, /"dispatchStatus":"sent"/u);
  assert.match(sent, /"autoSend":true/u);
  // The stream carries the state, not the words: a transcript belongs to the media record.
  assert.doesNotMatch(sent, /Mock transcript/u);
  await reader.cancel();
});

test("the milestone projection collapses stages the way a small screen needs", () => {
  const base = { id: "mjob_1", mediaId: "media_1", updatedAt: "2026-01-01T00:00:00.000Z" };
  const at = (fields) => milestoneForJob({ ...base, ...fields });

  assert.equal(at({ stage: "queued" }), "transcribing");
  assert.equal(at({ stage: "transcribing" }), "transcribing");
  assert.equal(at({ stage: "normalizing" }), "transcribing");
  assert.equal(at({ stage: "review_required" }), "review");
  assert.equal(at({ stage: "ready" }), "transcribing");
  assert.equal(at({ stage: "dispatching" }), "transcribing");
  assert.equal(deviceJobStatus({ ...base, stage: "ready" }).done, false);
  assert.equal(deviceJobStatus({ ...base, stage: "dispatching" }).done, false);
  assert.equal(at({ stage: "dispatched" }), "ready");
  assert.equal(at({ stage: "failed" }), "failed");

  // The dispatch outcome outranks the stage: transcription succeeding and the send being refused
  // are independent, and reporting a blocked capture as "ready" would be a lie about both.
  assert.equal(at({ stage: "dispatched", dispatchStatus: "sent" }), "sent");
  assert.equal(at({ stage: "dispatched", dispatchStatus: "approval_required" }), "review");
  assert.equal(at({ stage: "dispatched", dispatchStatus: "blocked" }), "failed");
  assert.equal(at({ stage: "dispatched", dispatchStatus: "failed" }), "failed");

  // A transcription failure reports the transcription error; a send failure reports the send one.
  const failedSend = deviceJobStatus({
    ...base,
    stage: "dispatched",
    dispatchStatus: "blocked",
    dispatchError: "Intent blocked by policy.",
    lastError: null,
    normalizedTranscript: "open the door",
  });
  assert.equal(failedSend.error, "Intent blocked by policy.");
  assert.equal(failedSend.transcript, "open the door");
  assert.equal(failedSend.ok, false);
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function requestJson(fetchImpl, baseUrl, path, input = {}) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: input.method,
    headers: { "content-type": "application/json", ...input.headers },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Reads an already-open SSE reader until a whole event containing `pattern` has arrived.
 *
 * Takes the reader rather than the body so one stream can be read across several awaits — the
 * queue event and the dispatch event arrive at different points in the same connection.
 */
async function readStreamUntil(reader, pattern) {
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    // SSE events end at a blank line. Matching mid-event would return while the data: payload
    // is still in flight.
    const boundary = output.lastIndexOf("\n\n");
    if (boundary !== -1 && output.slice(0, boundary).includes(pattern)) return output;
  }
  throw new Error(`Timed out waiting for ${pattern}. Received: ${output}`);
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("device voice enqueue schedules durable work immediately and queue failure preserves the upload", async (t) => {
  const scheduled = [];
  const loop = await setupLoop(t, { scheduleMediaProcessing: async (request) => { scheduled.push(request); throw new Error("private failure"); } });
  const uploaded = await loop.upload();
  assert.equal((await loop.store.getMediaJobForUser("user_dev", uploaded.job.jobId)).stage, "queued");
  assert.deepEqual(scheduled, [{ jobId: uploaded.job.jobId, delaySeconds: 0 }]);
  assert.equal((await loop.call(`/v1/device/media/jobs/${uploaded.job.jobId}`, { headers: loop.deviceHeaders })).job.milestone, "transcribing");
});

test("voice dispatch survives a job-settlement failure and runner restart without a second T3 turn", async (t) => {
  const scheduled = [];
  const loop = await setupLoop(t, { scheduleMediaProcessing: async (request) => { scheduled.push(request); return true; } });
  await loop.enableAutoSend(true);
  const uploaded = await loop.upload();
  const update = loop.store.updateMediaJob.bind(loop.store);
  let failSettle = true;
  loop.store.updateMediaJob = async (input) => {
    if (input.stage === "dispatched" && failSettle) { failSettle = false; throw new Error("simulated process failure after T3 acknowledged"); }
    return await update(input);
  };
  await loop.mediaJobRunner.runOnce();
  assert.equal(loop.dispatches.length, 1);
  assert.equal((await loop.store.getMediaJobForUser("user_dev", uploaded.job.jobId)).stage, "queued");
  assert.ok(scheduled.some((item) => item.jobId === uploaded.job.jobId && item.delaySeconds > 0));
  const restarted = createApp({ store: loop.store, config: loop.appConfig });
  await restarted.mediaJobRunner.runOnce();
  assert.equal(loop.dispatches.length, 1, "durable voice clientRequestId must replay the existing command");
  const final = await loop.store.getMediaJobForUser("user_dev", uploaded.job.jobId);
  assert.equal(final.stage, "dispatched");
  const receipt = await loop.store.getCommandRequest({ userId: "user_dev", actorType: "device", actorId: loop.device.id,
    operation: "intent.submit", clientRequestId: `voice:${uploaded.job.jobId}` });
  assert.equal(receipt.commandId, final.commandId);
});
