#!/usr/bin/env node

// Phase 4.6 — raw media upload session lifecycle drill (owner realm).
//
// WHAT THIS EXERCISES
// The three-step raw session (create -> PUT -> finalize) with a fixed 1x1 PNG the drill carries
// itself, plus the refusals that make the session safe: a short body, a body whose SHA-256 does not
// match the declared digest, and a mismatched request content type. It then proves the finalized
// bytes round-trip byte-identically, that finalize is idempotent, that `/v1/media/:id/content` is
// closed to an unsigned or forged access token, that an abandoned session can be aborted and is
// then unwritable, and that the owner-facing retention runner is reachable. The drill deletes the
// media it created.
//
// WHAT THIS DOES NOT EXERCISE — see docs/staging-drills.md
// It does not wait out `MEDIA_UPLOAD_SESSION_TTL_MS`, so TTL-driven expiry and the retention
// runner's staged-object sweep are not observed, only the runner's reachability and its abort path.
// It cannot mint a genuine signed media URL — the gateway only ever mints one into a T3 dispatch
// payload, and strips it before persistence — so real signed-URL *expiry* is not proven, only that
// unsigned and forged tokens are refused. It performs no transcription, no voice auto-send, no
// notification replay, no Web Push, and asserts nothing about which storage backend served the
// bytes.

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  ACCESS_TOKEN_FILE_OPTION,
  DrillError,
  boundedInteger,
  configurationFailureEvidence,
  createRequester,
  drillId,
  emitEvidence,
  finishEvidence,
  loadAccessTokenFile,
  nonEmpty,
  normalizeBaseUrl,
  oneOf,
  opaqueRef,
  parseDrillArguments,
  requireCondition,
  requireIdentifier,
  requireRecord,
  requireStatus,
  runCheck,
  skipped,
} from "./drill-common.mjs";

const DRILL = "media-lifecycle";

// A minimal, valid, opaque 1x1 greyscale PNG. It is drill content, not user content: the gateway
// validates the magic bytes and IHDR dimensions (src/mediaValidation.mjs), so a random blob would
// be refused at finalization for the wrong reason.
const DRILL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const DRILL_PNG = Buffer.from(DRILL_PNG_BASE64, "base64");
const DRILL_PNG_SHA256 = createHash("sha256").update(DRILL_PNG).digest("hex");
const CONTENT_TYPE = "image/png";

const MUTATING_CHECKS = [
  "upload_session_created",
  "short_body_refused",
  "digest_mismatch_refused",
  "content_type_mismatch_refused",
  "content_accepted",
  "finalize_creates_media",
  "finalize_is_idempotent",
  "finalized_bytes_round_trip",
  "unsigned_content_access_refused",
  "abandoned_session_aborted",
  "retention_runner_reachable",
  "drill_media_deleted",
];

// The window that only runs once bytes are staged. Named rather than sliced by index so a future
// insertion cannot silently mark a check skipped that in fact ran.
const FINALIZE_CHECKS = [
  "finalize_creates_media",
  "finalize_is_idempotent",
  "finalized_bytes_round_trip",
  "unsigned_content_access_refused",
];

export async function runMediaLifecycleDrill(input, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const now = dependencies.now ?? (() => Date.now());
  const newId = dependencies.newId ?? (() => drillId("drill-media"));
  const startedAtMs = now();
  const checks = [];
  let configuration;

  try {
    configuration = normalizeConfiguration(input);
    checks.push({
      name: "configuration",
      status: "passed",
      durationMs: 0,
      mode: configuration.exercise ? "exercise" : "preflight",
      fixtureBytes: DRILL_PNG.length,
    });
  } catch (error) {
    return finishEvidence({
      drill: DRILL,
      mode: "preflight",
      checks: [{ name: "configuration", status: "failed", durationMs: 0, code: error instanceof DrillError ? error.code : "invalid_configuration" }],
      startedAtMs,
      now,
      target: null,
    });
  }

  const mode = configuration.exercise ? "exercise" : "preflight";
  const { request, requestBinary } = createRequester({
    baseUrl: configuration.baseUrl,
    fetchImpl,
    requestTimeoutMs: configuration.requestTimeoutMs,
  });
  const owner = { authorization: `Bearer ${configuration.accessToken}` };
  const finish = () => finishEvidence({ drill: DRILL, mode, checks, startedAtMs, now, target: configuration.baseUrl.origin });

  const deploymentReady = await runCheck(checks, "deployment_mode", now, async () => {
    const response = await request("/v1/auth/config");
    requireStatus(response, 200, "auth_config_unavailable");
    const body = requireRecord(response.body, "invalid_auth_config_contract");
    requireCondition(body.deploymentMode === configuration.expectedDeploymentMode, "unexpected_deployment_mode");
    return { httpStatus: response.status, deploymentMode: configuration.expectedDeploymentMode };
  });

  const ownerReady = await runCheck(checks, "owner_realm_authenticated", now, async () => {
    // A small owner-realm read that also records the retention policy the finalized drill media
    // will inherit. The media list is deliberately not used: it is unbounded.
    const response = await request("/v1/settings/privacy", { headers: owner });
    requireStatus(response, 200, "privacy_settings_unavailable");
    const privacy = requireRecord(response.body?.privacy, "invalid_privacy_settings_contract");
    const retentionDays = privacy.mediaRetentionDays ?? null;
    requireCondition(retentionDays === null || Number.isInteger(retentionDays), "invalid_privacy_settings_contract");
    return { httpStatus: response.status, mediaRetentionDays: retentionDays };
  });

  if (!configuration.exercise) {
    for (const name of MUTATING_CHECKS) checks.push(skipped(name, "exercise_flag_required"));
    return finish();
  }
  if (!deploymentReady || !ownerReady) {
    for (const name of MUTATING_CHECKS) checks.push(skipped(name, "preflight_check_failed"));
    return finish();
  }

  const state = { sessionId: null, mediaId: null, abandonedId: null };
  const createSession = async () => await request("/v1/media/uploads", {
    method: "POST",
    headers: owner,
    body: {
      kind: "image",
      contentType: CONTENT_TYPE,
      sizeBytes: DRILL_PNG.length,
      sha256: DRILL_PNG_SHA256,
      clientRequestId: newId(),
      originalName: "staging-drill.png",
      captureSource: "upload",
    },
  });
  const putContent = async (sessionId, body, contentType = CONTENT_TYPE) => await request(
    `/v1/media/uploads/${encodeURIComponent(sessionId)}/content`,
    { method: "PUT", headers: owner, rawBody: body, contentType },
  );

  try {
    const created = await runCheck(checks, "upload_session_created", now, async () => {
      const response = await createSession();
      requireStatus(response, 201, "upload_session_create_failed");
      const session = requireRecord(response.body?.session, "invalid_upload_session_contract");
      state.sessionId = requireIdentifier(session.id, "invalid_upload_session_contract");
      requireCondition(session.status === "pending", "upload_session_not_pending");
      requireCondition(session.sizeBytes === DRILL_PNG.length, "upload_session_size_mismatch");
      requireCondition(session.sha256 === DRILL_PNG_SHA256, "upload_session_digest_mismatch");
      requireCondition(session.upload?.method === "PUT", "invalid_upload_session_contract");
      // The projection must not carry storage keys, filenames, transcripts or the client id.
      requireCondition(
        session.storagePath === undefined
        && session.originalName === undefined
        && session.transcript === undefined
        && session.clientRequestId === undefined,
        "upload_session_projection_leaks",
      );
      return { httpStatus: response.status, sessionRef: opaqueRef(state.sessionId), sessionStatus: "pending" };
    });

    if (created) {
      await runCheck(checks, "short_body_refused", now, async () => {
        const response = await putContent(state.sessionId, DRILL_PNG.subarray(0, DRILL_PNG.length - 1));
        requireStatus(response, 422, "short_body_accepted");
        return { httpStatus: response.status, accepted: false };
      });

      await runCheck(checks, "digest_mismatch_refused", now, async () => {
        const tampered = Buffer.from(DRILL_PNG);
        tampered[tampered.length - 1] ^= 0xff;
        requireCondition(tampered.length === DRILL_PNG.length, "drill_fixture_invalid");
        const response = await putContent(state.sessionId, tampered);
        requireStatus(response, 422, "digest_mismatch_accepted");
        return { httpStatus: response.status, accepted: false };
      });

      await runCheck(checks, "content_type_mismatch_refused", now, async () => {
        const response = await putContent(state.sessionId, DRILL_PNG, "application/octet-stream");
        requireStatus(response, 415, "content_type_mismatch_accepted");
        return { httpStatus: response.status, accepted: false };
      });

      const uploaded = await runCheck(checks, "content_accepted", now, async () => {
        const response = await putContent(state.sessionId, DRILL_PNG);
        requireStatus(response, 200, "content_upload_failed");
        const session = requireRecord(response.body?.session, "invalid_upload_session_contract");
        requireCondition(session.status === "uploaded", "upload_session_not_uploaded");
        return { httpStatus: response.status, sessionStatus: "uploaded" };
      });

      if (!uploaded) {
        for (const name of FINALIZE_CHECKS) checks.push(skipped(name, "content_not_staged"));
      } else {
        await runCheck(checks, "finalize_creates_media", now, async () => {
          const response = await request(`/v1/media/uploads/${encodeURIComponent(state.sessionId)}/finalize`, {
            method: "POST",
            headers: owner,
          });
          requireStatus(response, 200, "finalize_failed");
          const session = requireRecord(response.body?.session, "invalid_upload_session_contract");
          const media = requireRecord(response.body?.media, "invalid_media_contract");
          state.mediaId = requireIdentifier(media.id, "invalid_media_contract");
          requireCondition(session.status === "finalized", "upload_session_not_finalized");
          requireCondition(media.sha256 === DRILL_PNG_SHA256, "finalized_media_digest_mismatch");
          requireCondition(media.contentType === CONTENT_TYPE, "finalized_media_content_type_mismatch");
          return { httpStatus: response.status, mediaRef: opaqueRef(state.mediaId), sessionStatus: "finalized" };
        });

        await runCheck(checks, "finalize_is_idempotent", now, async () => {
          requireCondition(Boolean(state.mediaId), "finalized_media_missing");
          const response = await request(`/v1/media/uploads/${encodeURIComponent(state.sessionId)}/finalize`, {
            method: "POST",
            headers: owner,
          });
          requireStatus(response, 200, "finalize_replay_failed");
          const media = requireRecord(response.body?.media, "invalid_media_contract");
          requireCondition(media.id === state.mediaId, "finalize_replay_created_second_media");
          return { httpStatus: response.status, duplicateMedia: false };
        });

        await runCheck(checks, "finalized_bytes_round_trip", now, async () => {
          requireCondition(Boolean(state.mediaId), "finalized_media_missing");
          const response = await requestBinary(`/v1/media/${encodeURIComponent(state.mediaId)}`, { headers: owner });
          requireStatus(response, 200, "media_content_unavailable");
          requireCondition(response.length === DRILL_PNG.length, "media_content_length_mismatch");
          requireCondition(response.sha256 === DRILL_PNG_SHA256, "media_content_digest_mismatch");
          requireCondition(response.contentType === CONTENT_TYPE, "media_content_type_mismatch");
          requireCondition(response.declaredSha256 === DRILL_PNG_SHA256, "media_content_digest_header_mismatch");
          return { httpStatus: response.status, bytes: response.length, digestMatches: true };
        });

        await runCheck(checks, "unsigned_content_access_refused", now, async () => {
          requireCondition(Boolean(state.mediaId), "finalized_media_missing");
          const path = `/v1/media/${encodeURIComponent(state.mediaId)}/content`;
          // Read as bytes, not JSON: a gateway that wrongly serves the image must be reported as
          // having served it, not as having returned unparseable JSON.
          const bare = await requestBinary(path);
          requireStatus(bare, 403, "unsigned_media_content_served");
          // A structurally valid, unexpired, wrongly-signed token: it must fail HMAC verification
          // rather than be rejected for its shape (src/mediaLinks.mjs verifyMediaAccessToken).
          const forged = await requestBinary(`${path}?token=${encodeURIComponent(forgedMediaToken(state.mediaId, now()))}`);
          requireStatus(forged, 403, "forged_media_token_accepted");
          return { unsignedStatus: bare.status, forgedStatus: forged.status, served: false };
        });
      }

      await runCheck(checks, "abandoned_session_aborted", now, async () => {
        const response = await createSession();
        requireStatus(response, 201, "abandoned_session_create_failed");
        const session = requireRecord(response.body?.session, "invalid_upload_session_contract");
        state.abandonedId = requireIdentifier(session.id, "invalid_upload_session_contract");
        const aborted = await request(`/v1/media/uploads/${encodeURIComponent(state.abandonedId)}`, {
          method: "DELETE",
          headers: owner,
        });
        requireStatus(aborted, 200, "abandoned_session_abort_failed");
        requireCondition(aborted.body?.session?.status === "aborted", "abandoned_session_not_aborted");
        const reread = await request(`/v1/media/uploads/${encodeURIComponent(state.abandonedId)}`, { headers: owner });
        requireStatus(reread, 200, "abandoned_session_unreadable");
        requireCondition(reread.body?.session?.status === "aborted", "abandoned_session_status_unstable");
        const rewrite = await putContent(state.abandonedId, DRILL_PNG);
        requireStatus(rewrite, 409, "aborted_session_still_writable");
        return { sessionRef: opaqueRef(state.abandonedId), sessionStatus: "aborted", rewriteStatus: rewrite.status };
      });

      await runCheck(checks, "retention_runner_reachable", now, async () => {
        const response = await request("/v1/media/purge-expired", { method: "POST", headers: owner });
        requireStatus(response, 200, "retention_runner_unavailable");
        const body = requireRecord(response.body, "invalid_retention_contract");
        requireCondition(Number.isInteger(body.count), "invalid_retention_contract");
        requireCondition(Number.isInteger(body.abandonedCount), "invalid_retention_contract");
        requireCondition(typeof body.checkedAt === "string", "invalid_retention_contract");
        // Counts are recorded, not asserted: this drill does not wait out the session TTL, so an
        // expiry sweep of zero rows is the expected and honest outcome.
        return { httpStatus: response.status, purgedCount: body.count, abandonedCount: body.abandonedCount };
      });
    } else {
      // Nothing downstream can run without a staged session, and a check that did not run is
      // never reported as anything but skipped.
      for (const name of MUTATING_CHECKS.slice(1, -1)) checks.push(skipped(name, "upload_session_unavailable"));
    }
  } finally {
    if (state.mediaId) {
      await runCheck(checks, "drill_media_deleted", now, async () => {
        const response = await request(`/v1/media/${encodeURIComponent(state.mediaId)}`, {
          method: "DELETE",
          headers: owner,
        });
        requireStatus(response, 200, "drill_media_delete_failed");
        return { httpStatus: response.status, mediaRef: opaqueRef(state.mediaId), deleted: true };
      });
    } else {
      checks.push(skipped("drill_media_deleted", "drill_media_not_created"));
    }
  }

  return finish();
}

// Never a real token: the payload is well formed but the signature is a constant the gateway's
// signing key cannot have produced.
function forgedMediaToken(mediaId, nowMs) {
  const payload = Buffer.from(JSON.stringify({
    v: "m1",
    m: mediaId,
    u: "staging-drill-not-a-real-owner",
    e: nowMs + 60_000,
  }), "utf8").toString("base64url");
  return `${payload}.${Buffer.alloc(32, 0).toString("base64url")}`;
}

export function normalizeConfiguration(input = {}) {
  const baseUrl = normalizeBaseUrl(input);
  const accessToken = nonEmpty(input.accessToken);
  if (!accessToken) throw new DrillError("access_token_required");
  return {
    baseUrl,
    accessToken,
    exercise: input.exerciseMedia === true,
    expectedDeploymentMode: oneOf(nonEmpty(input.expectedDeploymentMode) ?? "cloud", ["cloud", "self-hosted"], "expected_deployment_mode_invalid"),
    requestTimeoutMs: boundedInteger(input.requestTimeoutMs, 20_000, 1_000, 60_000, "request_timeout_invalid"),
  };
}

export function parseArguments(argv, environment = process.env) {
  return parseDrillArguments(argv, {
    environment,
    envDefaults: {
      baseUrl: "NEXT_CODER_DRILL_URL",
      accessToken: "NEXT_CODER_DRILL_ACCESS_TOKEN",
      expectedDeploymentMode: "NEXT_CODER_DRILL_DEPLOYMENT_MODE",
      requestTimeoutMs: "NEXT_CODER_DRILL_REQUEST_TIMEOUT_MS",
    },
    valueOptions: {
      "--base-url": "baseUrl",
      "--expected-deployment-mode": "expectedDeploymentMode",
      "--request-timeout-ms": "requestTimeoutMs",
    },
    flagOptions: {
      "--exercise-media": "exerciseMedia",
      "--allow-http-loopback": "allowHttpLoopback",
    },
    fileOptions: ACCESS_TOKEN_FILE_OPTION,
  });
}

export function helpText() {
  return `Next Coder staging drill: media upload lifecycle (completion plan 4.6)

Preflight (no mutation; every lifecycle check is reported as skipped):
  NEXT_CODER_DRILL_ACCESS_TOKEN=... npm run drill:media-lifecycle -- \\
    --base-url https://staging.example.com

Full drill (uploads a 1x1 PNG the script carries, then deletes it):
  NEXT_CODER_DRILL_ACCESS_TOKEN=... npm run drill:media-lifecycle -- \\
    --base-url https://staging.example.com --exercise-media

No user media is ever read or uploaded: the fixture is a fixed 67-byte PNG compiled into this
script. The platform token comes from NEXT_CODER_DRILL_ACCESS_TOKEN or a mode-0600
--access-token-file PATH.

This drill does not wait out the upload-session TTL, cannot mint a genuine signed media URL, and
performs no transcription, voice, notification or Web Push step. See docs/staging-drills.md.`;
}

async function main() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${helpText()}\n`);
      return;
    }
    if (parsed.accessTokenFile) parsed.accessToken = await loadAccessTokenFile(parsed.accessTokenFile);
  } catch (error) {
    await emitEvidence(configurationFailureEvidence({
      drill: DRILL,
      code: error instanceof DrillError ? error.code : "invalid_configuration",
    }));
    process.exitCode = 2;
    return;
  }
  const evidence = await emitEvidence(await runMediaLifecycleDrill(parsed));
  if (evidence.result !== "passed") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
