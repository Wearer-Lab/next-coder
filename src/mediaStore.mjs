import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { HttpError, requireString } from "./http.mjs";
import { buildSignedMediaUrl } from "./mediaLinks.mjs";
import { normalizeClientRequestId } from "./requestEnvelope.mjs";
import { createS3Client, isNotFound } from "./s3.mjs";
import { validateMediaBytes } from "./mediaValidation.mjs";

const ALLOWED_MEDIA = {
  audio: new Set(["audio/wav", "audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg"]),
  image: new Set(["image/jpeg", "image/png", "image/webp"]),
};
const OWNER_CAPTURE_SOURCES = new Set(["upload", "browser_recording", "browser_camera"]);

export const MAX_MEDIA_ATTACHMENTS = 8;

export function assertSupportedMediaKind(kind) {
  if (!ALLOWED_MEDIA[kind]) {
    throw new HttpError(415, `Unsupported media kind: ${kind}.`);
  }
}

const EXTENSIONS = new Map([
  ["audio/wav", "wav"],
  ["audio/mpeg", "mp3"],
  ["audio/mp4", "m4a"],
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

// Media lives on local disk for development and in S3-compatible object storage for production
// (roadmap Phase 1). `storagePath` holds the object key in both cases, so the record shape and the
// Convex schema are identical either way.
let cachedS3Client = null;
let cachedS3Key = null;

function objectStoreFor(config) {
  if (config?.mediaStorageProvider !== "s3") return null;
  const key = [config.s3Endpoint, config.s3Region, config.s3Bucket, config.s3AccessKeyId].join("|");
  if (cachedS3Client && cachedS3Key === key) return cachedS3Client;
  cachedS3Client = createS3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    bucket: config.s3Bucket,
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
    ...(config.s3SessionToken ? { sessionToken: config.s3SessionToken } : {}),
    ...(config.s3ForcePathStyle === undefined ? {} : { forcePathStyle: config.s3ForcePathStyle }),
    ...(config.s3TimeoutMs ? { timeoutMs: config.s3TimeoutMs } : {}),
  });
  cachedS3Key = key;
  return cachedS3Client;
}

export async function createMediaUploadIntent({ store, config, actor, payload }) {
  const descriptor = validateUploadDescriptor(payload, config);
  let companion = null;
  if (actor.type === "user" && typeof payload?.companionHandoffId === "string") {
    companion = await store.getCompanionHandoffForUser(actor.userId, payload.companionHandoffId);
    if (!companion) throw new HttpError(404, "Companion handoff not found.");
    if (companion.status !== "claimed") {
      throw new HttpError(409, `Companion handoff is ${companion.status}.`);
    }
    const expectedKind = companion.action === "record_audio" ? "audio" : "image";
    if (descriptor.kind !== expectedKind) {
      throw new HttpError(409, `This companion handoff only accepts ${expectedKind}.`);
    }
  }
  const clientRequestId = normalizeClientRequestId(payload?.clientRequestId);
  if (!clientRequestId) throw new HttpError(400, "clientRequestId must be 8-128 URL-safe characters.");
  const ownerKey = createHash("sha256").update(actor.userId, "utf8").digest("hex").slice(0, 24);
  const requestKey = createHash("sha256")
    .update(`${actor.type}:${actor.id}:${clientRequestId}`, "utf8")
    .digest("hex");
  const extension = EXTENSIONS.get(descriptor.contentType) ?? "bin";
  const storagePath = objectStoreFor(config)
    ? `staging/${ownerKey}/${requestKey}.${extension}`
    : join(config.mediaDir, ".staging", ownerKey, `${requestKey}.${extension}`);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (config.mediaUploadSessionTtlMs ?? 15 * 60 * 1000)).toISOString();
  const result = await store.createMediaUploadSession({
    userId: actor.userId,
    deviceId: actor.type === "device" ? actor.id : null,
    clientRequestId,
    ...descriptor,
    storagePath,
    originalName: typeof payload.originalName === "string" ? payload.originalName.slice(0, 240) : undefined,
    transcript: descriptor.kind === "audio" && typeof payload.transcript === "string"
      ? normalizeTranscript(payload.transcript)
      : undefined,
    captureSource: actor.type === "device"
      ? "controller_capture"
      : companion
        ? (companion.action === "record_audio" ? "companion_recording" : "companion_camera")
        : normalizeOwnerCaptureSource(payload?.captureSource, descriptor.kind),
    environmentId: companion?.environmentId ?? (actor.type === "device" ? actor.environmentId ?? null : null),
    threadId: companion?.threadId ?? (actor.type === "device" ? actor.threadId ?? null : null),
    companionHandoffId: companion?.id ?? null,
    createdAt,
    expiresAt,
    ownerByteLimit: config.maxOwnerMediaBytes ?? 64 * 1024 * 1024,
  });
  if (result?.conflict) {
    throw new HttpError(409, "clientRequestId is already bound to a different media upload.");
  }
  if (result?.limitExceeded) {
    throw new HttpError(429, "Too many unfinished media uploads. Retry after existing sessions expire.");
  }
  if (result?.byteLimitExceeded) {
    throw new HttpError(413, "Media storage quota exceeded.");
  }
  return result;
}

export async function writeMediaUploadSession({ store, config, actor, sessionId, buffer }) {
  const session = await requireUploadSession(store, actor, sessionId);
  assertUploadSessionWritable(session);
  if (!Buffer.isBuffer(buffer)) throw new HttpError(400, "Media upload body is required.");
  if (buffer.length !== session.expectedSizeBytes) {
    throw new HttpError(422, `Uploaded media must be exactly ${session.expectedSizeBytes} bytes.`);
  }
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (sha256 !== session.expectedSha256) {
    throw new HttpError(422, "Uploaded media SHA-256 does not match the upload intent.");
  }
  const objectStore = objectStoreFor(config);
  if (objectStore) {
    await objectStore.putObject({ key: session.storagePath, body: buffer, contentType: session.contentType });
  } else {
    await mkdir(dirname(session.storagePath), { recursive: true });
    await writeFile(session.storagePath, buffer);
  }
  return await store.markMediaUploadSessionUploaded({
    userId: actor.userId,
    deviceId: actor.type === "device" ? actor.id : null,
    sessionId,
  });
}

export async function finalizeMediaUpload({ store, config, actor, sessionId }) {
  const session = await requireUploadSession(store, actor, sessionId);
  if (session.status === "finalized" && session.mediaId) {
    const media = await store.getMediaForUser(actor.userId, session.mediaId);
    return { session: publicUploadSession(session), media };
  }
  if (Date.parse(session.expiresAt) <= Date.now()) {
    await deleteStagedMedia(session, config);
    await store.abortMediaUploadSession({
      userId: actor.userId,
      deviceId: actor.type === "device" ? actor.id : null,
      sessionId,
      status: "expired",
    });
    throw new HttpError(410, "Media upload session has expired.");
  }
  if (session.status !== "uploaded") {
    throw new HttpError(409, "Media bytes must be uploaded before finalization.");
  }
  const extension = EXTENSIONS.get(session.contentType) ?? "bin";
  const ownerKey = createHash("sha256").update(actor.userId, "utf8").digest("hex").slice(0, 24);
  // A digest proves integrity; it is not a record identity. Including the durable upload-session
  // id prevents two equal uploads from sharing a blob that one record can later delete.
  const finalName = `${session.expectedSha256}-${session.id}.${extension}`;
  const finalPath = objectStoreFor(config)
    ? `${ownerKey}/${finalName}`
    : join(config.mediaDir, ownerKey, finalName);
  // Moving the bytes and committing the Store row cannot be one cross-adapter transaction. A retry
  // after a process failure therefore accepts the already-moved private object, but still rechecks
  // its digest and length before making the media record visible.
  const { buffer, alreadyFinal } = await readStagedOrFinalMedia(session, finalPath, config);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (buffer.length !== session.expectedSizeBytes || sha256 !== session.expectedSha256) {
    await deleteStagedMedia(alreadyFinal ? { storagePath: finalPath } : session, config);
    await store.abortMediaUploadSession({
      userId: actor.userId,
      deviceId: actor.type === "device" ? actor.id : null,
      sessionId,
    });
    throw new HttpError(422, "Staged media failed final integrity verification.");
  }
  validateMediaBytes(buffer, { kind: session.kind, contentType: session.contentType, config });
  const objectStore = objectStoreFor(config);
  if (objectStore && !alreadyFinal) {
    await objectStore.putObject({ key: finalPath, body: buffer, contentType: session.contentType });
    await objectStore.deleteObject({ key: session.storagePath });
  } else if (!alreadyFinal) {
    await mkdir(join(config.mediaDir, ownerKey), { recursive: true });
    await rename(session.storagePath, finalPath);
  }
  const privacy = await store.getUserPrivacySettings?.(actor.userId);
  const retentionDays = privacy?.mediaRetentionDays ?? config.defaultMediaRetentionDays ?? 30;
  const mediaExpiresAt = retentionDays === null
    ? null
    : new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await store.finalizeMediaUploadSession({
    userId: actor.userId,
    deviceId: actor.type === "device" ? actor.id : null,
    sessionId,
    storagePath: finalPath,
    mediaExpiresAt,
  });
  if (result?.media && session.companionHandoffId) {
    await store.completeCompanionHandoff({ userId: actor.userId, handoffId: session.companionHandoffId });
  }
  return result;
}

function normalizeOwnerCaptureSource(value, kind) {
  if (typeof value === "string" && OWNER_CAPTURE_SOURCES.has(value)) return value;
  return kind === "audio" ? "upload" : "upload";
}

export async function abortMediaUpload({ store, config, actor, sessionId, expired = false }) {
  const session = await requireUploadSession(store, actor, sessionId);
  if (session.status !== "finalized") await deleteStagedMedia(session, config);
  return await store.abortMediaUploadSession({
    userId: actor.userId,
    deviceId: actor.type === "device" ? actor.id : null,
    sessionId,
    status: expired ? "expired" : "aborted",
  });
}

export async function deleteStagedMedia(session, config = null) {
  if (!session?.storagePath) return;
  const objectStore = objectStoreFor(config);
  if (objectStore) {
    try {
      await objectStore.deleteObject({ key: session.storagePath });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return;
  }
  await rm(session.storagePath, { force: true });
}

function validateUploadDescriptor(payload, config) {
  const kind = requireString(payload?.kind, "kind");
  if (!ALLOWED_MEDIA[kind]) throw new HttpError(400, "kind must be audio or image.");
  const contentType = requireString(payload?.contentType, "contentType").toLowerCase();
  if (!ALLOWED_MEDIA[kind].has(contentType)) {
    throw new HttpError(415, `Unsupported ${kind} content type: ${contentType}.`);
  }
  const expectedSizeBytes = payload?.sizeBytes;
  if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 1) {
    throw new HttpError(400, "sizeBytes must be a positive integer.");
  }
  if (expectedSizeBytes > config.maxMediaBytes) {
    throw new HttpError(413, `Uploaded media exceeds ${config.maxMediaBytes} bytes.`);
  }
  const expectedSha256 = requireString(payload?.sha256, "sha256");
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new HttpError(400, "sha256 must be a 64-character lowercase hexadecimal digest.");
  }
  return { kind, contentType, expectedSizeBytes, expectedSha256 };
}

async function requireUploadSession(store, actor, sessionId) {
  const session = await store.getMediaUploadSessionForActor({
    userId: actor.userId,
    deviceId: actor.type === "device" ? actor.id : null,
    sessionId,
  });
  if (!session) throw new HttpError(404, "Media upload session not found.");
  return session;
}

function assertUploadSessionWritable(session) {
  if (Date.parse(session.expiresAt) <= Date.now()) throw new HttpError(410, "Media upload session has expired.");
  if (!['pending', 'uploaded'].includes(session.status)) {
    throw new HttpError(409, `Media upload session is ${session.status}.`);
  }
}

async function readStagedOrFinalMedia(session, finalPath, config) {
  const objectStore = objectStoreFor(config);
  if (objectStore) {
    try {
      return { buffer: (await objectStore.getObject({ key: session.storagePath, maxBytes: session.expectedSizeBytes })).body, alreadyFinal: false };
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        return { buffer: (await objectStore.getObject({ key: finalPath, maxBytes: session.expectedSizeBytes })).body, alreadyFinal: true };
      } catch (finalError) {
        if (isNotFound(finalError)) throw new HttpError(409, "Uploaded media bytes are not available.");
        throw finalError;
      }
    }
  }
  try {
    return { buffer: await readFile(session.storagePath), alreadyFinal: false };
  } catch (error) {
    if (error?.code === "ENOENT") {
      try {
        return { buffer: await readFile(finalPath), alreadyFinal: true };
      } catch (finalError) {
        if (finalError?.code === "ENOENT") throw new HttpError(409, "Uploaded media bytes are not available.");
        throw finalError;
      }
    }
    throw error;
  }
}

function publicUploadSession(session) {
  const { storagePath, userId, deviceId, clientRequestId, originalName, transcript, ...publicFields } = session;
  return publicFields;
}

export async function storeUploadedMedia({ store, config, actor, payload }) {
  const kind = requireString(payload.kind, "kind");
  if (!["audio", "image"].includes(kind)) {
    throw new HttpError(400, "kind must be audio or image.");
  }

  const contentType = requireString(payload.contentType, "contentType").toLowerCase();
  if (!ALLOWED_MEDIA[kind].has(contentType)) {
    throw new HttpError(415, `Unsupported ${kind} content type: ${contentType}.`);
  }

  const dataBase64 = requireString(payload.dataBase64, "dataBase64");
  const buffer = decodeBase64(dataBase64);
  if (buffer.length === 0) throw new HttpError(400, "Uploaded media cannot be empty.");
  if (buffer.length > config.maxMediaBytes) {
    throw new HttpError(413, `Uploaded media exceeds ${config.maxMediaBytes} bytes.`);
  }
  validateMediaBytes(buffer, { kind, contentType, config });

  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const extension = EXTENSIONS.get(contentType) ?? "bin";
  const objectStore = objectStoreFor(config);
  let storagePath;
  // Keep every logical upload independently deletable. Content hashes remain in metadata for
  // integrity and diagnostics, while the random suffix prevents accidental blob aliasing.
  const objectName = `${sha256}-${randomUUID()}.${extension}`;
  if (objectStore) {
    storagePath = `${actor.userId}/${objectName}`;
    await objectStore.putObject({ key: storagePath, body: buffer, contentType });
  } else {
    storagePath = join(config.mediaDir, actor.userId, objectName);
    await mkdir(join(config.mediaDir, actor.userId), { recursive: true });
    await writeFile(storagePath, buffer);
  }

  const privacy = await store.getUserPrivacySettings?.(actor.userId);
  const retentionDays = privacy?.mediaRetentionDays ?? config.defaultMediaRetentionDays ?? 30;
  const expiresAt = retentionDays === null
    ? null
    : new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const stored = await store.createMediaUpload({
    userId: actor.userId,
    deviceId: actor.type === "device" ? actor.id : null,
    kind,
    contentType,
    sizeBytes: buffer.length,
    sha256,
    storagePath,
    originalName: typeof payload.originalName === "string" ? payload.originalName : undefined,
    transcript: kind === "audio" && typeof payload.transcript === "string"
      ? normalizeTranscript(payload.transcript)
      : undefined,
    expiresAt,
    ownerByteLimit: config.maxOwnerMediaBytes ?? 64 * 1024 * 1024,
  });
  if (stored?.byteLimitExceeded) {
    await deleteStoredMedia({ storagePath }, config);
    throw new HttpError(413, "Media storage quota exceeded.");
  }
  return stored;
}

export async function readStoredMedia(media, config = null) {
  const objectStore = objectStoreFor(config);
  if (objectStore) return (await objectStore.getObject({ key: media.storagePath })).body;
  return readFile(media.storagePath);
}

export async function deleteStoredMedia(media, config = null) {
  if (!media?.storagePath) return;
  const objectStore = objectStoreFor(config);
  if (objectStore) {
    try {
      await objectStore.deleteObject({ key: media.storagePath });
    } catch (error) {
      // Mirrors `rm --force` on disk: an already-absent object is not an error.
      if (!isNotFound(error)) throw error;
    }
    return;
  }
  await rm(media.storagePath, { force: true });
}

/**
 * Old releases used owner/{sha256}.{ext}, so equal uploads could reference one blob. Preserve that
 * blob until the final legacy record is removed. New suffixed paths are unique and can be deleted
 * directly without a read-before-delete race.
 */
export async function deleteStoredMediaRecord({ store, userId, media, config = null }) {
  if (!media?.storagePath) return;
  const extension = EXTENSIONS.get(media.contentType) ?? "bin";
  const legacyName = `${media.sha256}.${extension}`;
  if (basename(media.storagePath) === legacyName && typeof store?.listMediaUploads === "function") {
    const records = await store.listMediaUploads(userId);
    const shared = records.some((candidate) => candidate.id !== media.id
      && candidate.sha256 === media.sha256
      && candidate.contentType === media.contentType);
    if (shared) return;
  }
  await deleteStoredMedia(media, config);
}

// Builds the payload T3 receives in message.attachments. Includes a signed callback URL and,
// for small files, the bytes inline so an environment that cannot reach the gateway still
// gets the content.
export async function buildMediaAttachment({ media, config, baseUrl, now = Date.now() }) {
  const attachment = {
    type: media.kind,
    mediaId: media.id,
    contentType: media.contentType,
    sizeBytes: media.sizeBytes,
    sha256: media.sha256,
    ...(media.originalName ? { name: media.originalName } : {}),
    ...(media.kind === "audio" && media.transcript ? { transcript: media.transcript } : {}),
    // A vision description reaches the agent even when it cannot fetch or see the image itself.
    ...(media.kind === "image" && media.description ? { description: media.description } : {}),
  };

  if (config.mediaSigningKey && baseUrl) {
    const signed = buildSignedMediaUrl({
      media,
      baseUrl,
      secret: config.mediaSigningKey,
      ttlSeconds: config.mediaLinkTtlSeconds,
      now,
    });
    attachment.url = signed.url;
    attachment.urlExpiresAt = signed.expiresAt;
  }

  if (media.sizeBytes <= config.mediaInlineMaxBytes) {
    try {
      attachment.dataBase64 = (await readStoredMedia(media, config)).toString("base64");
    } catch {
      // A missing or unreadable file must not block dispatch; the signed URL still stands.
    }
  }

  return attachment;
}

// Every referenced upload must resolve for the calling user. Skipping an unknown or foreign id
// would dispatch a turn whose text talks about media the agent never received.
export async function buildMediaAttachments({ store, userId, mediaUploadIds, config, baseUrl, now }) {
  const ids = [...new Set((mediaUploadIds ?? []).filter((id) => typeof id === "string" && id))];
  if (ids.length === 0) return [];
  if (ids.length > MAX_MEDIA_ATTACHMENTS) {
    throw new HttpError(400, `A turn can carry at most ${MAX_MEDIA_ATTACHMENTS} media attachments.`);
  }

  const attachments = [];
  for (const mediaId of ids) {
    const media = await store.getMediaForUser(userId, mediaId);
    if (!media) throw new HttpError(404, "Media upload not found.");
    assertSupportedMediaKind(media.kind);
    attachments.push(await buildMediaAttachment({ media, config, baseUrl, now }));
  }
  return attachments;
}

export function mediaToPromptContext(media) {
  return [
    "Media attachment:",
    `id=${media.id}`,
    `kind=${media.kind}`,
    `contentType=${media.contentType}`,
    `sizeBytes=${media.sizeBytes}`,
    `sha256=${media.sha256}`,
  ].join(" ");
}

function decodeBase64(value) {
  try {
    return Buffer.from(value, "base64");
  } catch {
    throw new HttpError(400, "dataBase64 must be valid base64.");
  }
}

function normalizeTranscript(value) {
  const transcript = value.trim();
  return transcript.length > 0 ? transcript.slice(0, 12000) : undefined;
}
