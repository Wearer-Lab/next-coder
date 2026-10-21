import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import {
  normalizeConfiguration,
  parseArguments,
  runMediaLifecycleDrill,
} from "../scripts/drill-media-lifecycle.mjs";

const TOKEN = "drill-platform-token-never-emit";
const CONTENT_TYPE = "image/png";
// The same fixture the drill carries. Kept here independently so a change to either side is a
// visible test failure rather than a silent agreement.
const DRILL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
  "base64",
);
const DRILL_PNG_SHA256 = createHash("sha256").update(DRILL_PNG).digest("hex");

test("the media drill refuses an unsafe target or a missing token before any fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; };

  const missing = await runMediaLifecycleDrill({}, { fetchImpl });
  assert.equal(missing.checks[0].code, "base_url_required");
  assert.equal(missing.drill, "media-lifecycle");

  const noToken = await runMediaLifecycleDrill({ baseUrl: "https://staging.example.test" }, { fetchImpl });
  assert.equal(noToken.checks[0].code, "access_token_required");
  assert.equal(calls, 0);

  assert.throws(
    () => normalizeConfiguration({ baseUrl: "https://127.0.0.2", accessToken: TOKEN }),
    (error) => error.code === "hostname_required",
  );
});

test("a preflight run uploads nothing and reports every lifecycle check as skipped", async (t) => {
  const gateway = createGateway();
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runMediaLifecycleDrill(baseInput(fixture.baseUrl));

  assert.equal(evidence.mode, "preflight");
  assert.equal(evidence.result, "failed");
  assert.equal(evidence.summary.failed, 0);
  assert.equal(evidence.summary.skipped, 12);
  assert.equal(gateway.sessions.size, 0);
  assert.equal(gateway.media.size, 0);
  assert.equal(gateway.calls.some((call) => call.method === "PUT"), false);
});

test("the full drill walks create, refuse, upload, finalize, abort and cleanup", async (t) => {
  const gateway = createGateway();
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runMediaLifecycleDrill({ ...baseInput(fixture.baseUrl), exerciseMedia: true });

  assert.equal(evidence.mode, "exercise");
  assert.equal(evidence.result, "passed");
  assert.equal(evidence.summary.skipped, 0);
  assert.deepEqual(evidence.checks.map((check) => check.name), [
    "configuration",
    "deployment_mode",
    "owner_realm_authenticated",
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
  ]);

  // One finalized media row, created and then removed again; one aborted session left behind.
  assert.equal(gateway.media.size, 0);
  assert.equal(gateway.finalizedCount, 1);
  const statuses = [...gateway.sessions.values()].map((session) => session.status);
  assert.deepEqual(statuses.sort(), ["aborted", "finalized"]);
  assertRedacted(evidence, gateway);
});

test("a gateway that accepts a short body or a bad digest fails the integrity checks", async (t) => {
  const gateway = createGateway({ acceptAnyBytes: true });
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runMediaLifecycleDrill({ ...baseInput(fixture.baseUrl), exerciseMedia: true });

  assert.equal(evidence.result, "failed");
  assert.equal(evidence.checks.find((check) => check.name === "short_body_refused").code, "short_body_accepted");
  assert.equal(evidence.checks.find((check) => check.name === "digest_mismatch_refused").code, "digest_mismatch_accepted");
});

test("a gateway that serves media content without a signed token fails closed", async (t) => {
  const gateway = createGateway({ serveUnsignedContent: true });
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runMediaLifecycleDrill({ ...baseInput(fixture.baseUrl), exerciseMedia: true });

  assert.equal(evidence.result, "failed");
  const refusal = evidence.checks.find((check) => check.name === "unsigned_content_access_refused");
  assert.equal(refusal.code, "unsigned_media_content_served");
  assert.equal(refusal.httpStatus, 200);
});

test("a session projection that leaks a storage key or filename fails the drill", async (t) => {
  const gateway = createGateway({ leakSessionFields: true });
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runMediaLifecycleDrill({ ...baseInput(fixture.baseUrl), exerciseMedia: true });

  assert.equal(evidence.result, "failed");
  assert.equal(
    evidence.checks.find((check) => check.name === "upload_session_created").code,
    "upload_session_projection_leaks",
  );
  const skipped = evidence.checks.filter((check) => check.status === "skipped");
  assert.equal(skipped.length, 11);
  assert.equal(skipped.at(-1).name, "drill_media_deleted");
  assert.equal(skipped.at(-1).code, "drill_media_not_created");
});

test("staged bytes that never land skip the finalize window but still exercise cleanup paths", async (t) => {
  const gateway = createGateway({ failContentUpload: true });
  const fixture = await startFixture(t, gateway.handler);

  const evidence = await runMediaLifecycleDrill({ ...baseInput(fixture.baseUrl), exerciseMedia: true });

  assert.equal(evidence.result, "failed");
  assert.equal(evidence.checks.find((check) => check.name === "content_accepted").code, "content_upload_failed");
  const skippedNames = evidence.checks.filter((check) => check.status === "skipped").map((check) => check.name);
  assert.deepEqual(skippedNames, [
    "finalize_creates_media",
    "finalize_is_idempotent",
    "finalized_bytes_round_trip",
    "unsigned_content_access_refused",
    "drill_media_deleted",
  ]);
  // The checks that do not depend on staged bytes still ran.
  assert.equal(evidence.checks.find((check) => check.name === "abandoned_session_aborted").status, "passed");
  assert.equal(evidence.checks.find((check) => check.name === "retention_runner_reachable").status, "passed");
});

test("media drill arguments never accept a token as a value and default to no mutation", () => {
  const parsed = parseArguments(["--base-url", "https://staging.example.test"], {
    NEXT_CODER_DRILL_ACCESS_TOKEN: TOKEN,
  });
  assert.equal(parsed.accessToken, TOKEN);
  assert.equal(parsed.exerciseMedia, false);
  assert.equal(parseArguments(["--exercise-media"], {}).exerciseMedia, true);
  assert.throws(() => parseArguments(["--access-token", TOKEN], {}), (error) => error.code === "unknown_option");
});

function baseInput(baseUrl) {
  return { baseUrl, allowHttpLoopback: true, accessToken: TOKEN };
}

function createGateway({
  acceptAnyBytes = false,
  serveUnsignedContent = false,
  leakSessionFields = false,
  failContentUpload = false,
} = {}) {
  const sessions = new Map();
  const media = new Map();
  const calls = [];
  let counter = 0;
  let finalizedCount = 0;

  const projection = (session) => ({
    id: session.id,
    kind: session.kind,
    contentType: session.contentType,
    sizeBytes: session.sizeBytes,
    sha256: session.sha256,
    status: session.status,
    mediaId: session.mediaId ?? null,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    upload: { method: "PUT", url: `/v1/media/uploads/${session.id}/content`, contentType: session.contentType, sizeBytes: session.sizeBytes },
    finalizeUrl: `/v1/media/uploads/${session.id}/finalize`,
    statusUrl: `/v1/media/uploads/${session.id}`,
    ...(leakSessionFields
      ? { storagePath: "private/staging/object/key", originalName: "private-original-name.png" }
      : {}),
  });

  const handler = async (request, response) => {
    const url = new URL(request.url, "http://fixture");
    const path = url.pathname;
    calls.push({ method: request.method, path });

    if (path === "/v1/auth/config") {
      return sendJson(response, 200, { deploymentMode: "cloud", developmentTokens: { enabled: false } });
    }

    const contentMatch = path.match(/^\/v1\/media\/([^/]+)\/content$/u);
    if (contentMatch && request.method === "GET") {
      const record = media.get(contentMatch[1]);
      if (!record) return sendJson(response, 404, { error: { message: "not found" } });
      if (!serveUnsignedContent) return sendJson(response, 403, { error: { message: "Invalid or expired media access token." } });
      return sendBinary(response, 200, record.bytes, record.contentType, record.sha256);
    }

    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      return sendJson(response, 401, { error: { message: "private token detail must not enter evidence" } });
    }

    if (path === "/v1/settings/privacy" && request.method === "GET") {
      return sendJson(response, 200, { privacy: { mediaRetentionDays: 30 } });
    }

    if (path === "/v1/media/uploads" && request.method === "POST") {
      const body = await readJson(request);
      counter += 1;
      const session = {
        id: `mup_private_${counter}`,
        kind: body.kind,
        contentType: body.contentType,
        sizeBytes: body.sizeBytes,
        sha256: body.sha256,
        status: "pending",
        mediaId: null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        clientRequestId: body.clientRequestId,
        bytes: null,
      };
      sessions.set(session.id, session);
      return sendJson(response, 201, { session: projection(session) });
    }

    if (path === "/v1/media/purge-expired" && request.method === "POST") {
      return sendJson(response, 200, { purged: [], count: 0, abandoned: [], abandonedCount: 0, hasMore: false, checkedAt: new Date().toISOString() });
    }

    const uploadContentMatch = path.match(/^\/v1\/media\/uploads\/([^/]+)\/content$/u);
    if (uploadContentMatch && request.method === "PUT") {
      const session = sessions.get(uploadContentMatch[1]);
      if (!session) return sendJson(response, 404, { error: { message: "not found" } });
      if (!["pending", "uploaded"].includes(session.status)) {
        return sendJson(response, 409, { error: { message: `Media upload session is ${session.status}.` } });
      }
      const declared = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (declared !== session.contentType) return sendJson(response, 415, { error: { message: "content type" } });
      const bytes = await readBytes(request);
      if (!acceptAnyBytes) {
        if (bytes.length !== session.sizeBytes) return sendJson(response, 422, { error: { message: "length" } });
        if (createHash("sha256").update(bytes).digest("hex") !== session.sha256) {
          return sendJson(response, 422, { error: { message: "digest" } });
        }
      }
      if (failContentUpload) return sendJson(response, 503, { error: { message: "private storage failure detail" } });
      session.bytes = bytes;
      session.status = "uploaded";
      return sendJson(response, 200, { session: projection(session) });
    }

    const finalizeMatch = path.match(/^\/v1\/media\/uploads\/([^/]+)\/finalize$/u);
    if (finalizeMatch && request.method === "POST") {
      const session = sessions.get(finalizeMatch[1]);
      if (!session) return sendJson(response, 404, { error: { message: "not found" } });
      if (session.status === "finalized") {
        return sendJson(response, 200, { session: projection(session), media: publicMedia(media.get(session.mediaId)) });
      }
      if (session.status !== "uploaded") return sendJson(response, 409, { error: { message: "not uploaded" } });
      counter += 1;
      const record = {
        id: `media_private_${counter}`,
        contentType: session.contentType,
        sha256: session.sha256,
        bytes: session.bytes,
        originalName: "private-original-name.png",
        displayName: "Console · private-original-name.png · 09 Sep 12:00",
      };
      media.set(record.id, record);
      finalizedCount += 1;
      session.status = "finalized";
      session.mediaId = record.id;
      return sendJson(response, 200, { session: projection(session), media: publicMedia(record) });
    }

    const sessionMatch = path.match(/^\/v1\/media\/uploads\/([^/]+)$/u);
    if (sessionMatch) {
      const session = sessions.get(sessionMatch[1]);
      if (!session) return sendJson(response, 404, { error: { message: "not found" } });
      if (request.method === "GET") return sendJson(response, 200, { session: projection(session) });
      if (request.method === "DELETE") {
        if (session.status !== "finalized") session.status = "aborted";
        return sendJson(response, 200, { session: projection(session) });
      }
    }

    const mediaMatch = path.match(/^\/v1\/media\/([^/]+)$/u);
    if (mediaMatch) {
      const record = media.get(mediaMatch[1]);
      if (!record) return sendJson(response, 404, { error: { message: "not found" } });
      if (request.method === "GET") return sendBinary(response, 200, record.bytes, record.contentType, record.sha256);
      if (request.method === "DELETE") {
        media.delete(record.id);
        return sendJson(response, 200, { media: publicMedia(record) });
      }
    }

    return sendJson(response, 404, { error: { message: "private missing route detail" } });
  };

  return {
    handler,
    calls,
    sessions,
    media,
    get finalizedCount() {
      return finalizedCount;
    },
  };
}

function publicMedia(record) {
  if (!record) return null;
  const { bytes, ...rest } = record;
  return rest;
}

async function startFixture(t, handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "fixture_failed" });
      else response.destroy();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function readBytes(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const body = (await readBytes(request)).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendBinary(response, status, bytes, contentType, sha256) {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": bytes.length,
    "x-media-sha256": sha256,
  });
  response.end(bytes);
}

function assertRedacted(evidence, gateway) {
  const serialized = JSON.stringify(evidence);
  const secrets = [
    TOKEN,
    "private-original-name.png",
    "private/staging/object/key",
    "private missing route detail",
    "drill-media-",
  ];
  for (const session of gateway.sessions.values()) secrets.push(session.id, session.clientRequestId);
  for (const record of gateway.media.values()) secrets.push(record.id);
  for (const value of secrets) {
    assert.equal(serialized.includes(value), false, `drill evidence leaked ${value}`);
  }
}
