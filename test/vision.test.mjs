import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createStore } from "../src/store.mjs";
import {
  buildVisionRequest,
  describeStoredImage,
  extractVisionDescription,
  visionToPromptContext,
} from "../src/vision.mjs";

// A 1x1 PNG. Small enough to inline, real enough to round-trip byte for byte.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const USER_ID = "user_dev";

test("the mock provider returns a deterministic description and persists it", async (t) => {
  const { store, media, calls } = await seedImage(t);

  const result = await describeStoredImage({
    store,
    config: { visionProvider: "mock" },
    userId: USER_ID,
    mediaId: media.id,
  });

  assert.equal(result.provider, "mock");
  assert.match(result.description, /^Mock description for image snapshot\.png \(image\/png, \d+ bytes, sha256 [0-9a-f]{12}\)\.$/u);
  assert.equal(result.media.description, result.description);
  assert.equal(result.media.storagePath, undefined, "the storage path must never be returned");

  // Deterministic: same record in, same description out.
  const again = await describeStoredImage({
    store,
    config: { visionProvider: "mock" },
    userId: USER_ID,
    mediaId: media.id,
  });
  assert.equal(again.description, result.description);

  // Processing state is announced before the provider runs, then the description is persisted.
  assert.deepEqual(calls.processing[0].processing, {
    visionStatus: "processing",
    descriptionSource: "mock",
    lastError: null,
  });
  assert.equal(calls.description[0].source, "mock");
  assert.equal(calls.description[0].mediaId, media.id);
  assert.equal(calls.description[0].userId, USER_ID);
});

test("the mock provider still works against a store with no description support", async (t) => {
  const { store, media } = await seedImage(t, { withVisionMethods: false });

  const result = await describeStoredImage({
    store,
    config: { visionProvider: "mock" },
    userId: USER_ID,
    mediaId: media.id,
  });

  assert.equal(result.provider, "mock");
  assert.ok(result.description.startsWith("Mock description for image"));
  assert.equal(result.media.id, media.id);
  assert.equal(result.media.processing.visionStatus, "ready");
  assert.equal(result.media.storagePath, undefined);
});

test("the disabled provider refuses with 409 and marks the media unavailable", async (t) => {
  const { store, media, calls } = await seedImage(t);

  await assert.rejects(
    () => describeStoredImage({ store, config: {}, userId: USER_ID, mediaId: media.id }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /No vision provider is configured\./u);
      assert.equal(error.details.media.id, media.id);
      return true;
    },
  );

  assert.deepEqual(calls.processing.at(-1).processing, {
    visionStatus: "unavailable",
    descriptionSource: null,
    lastError: "No vision provider is configured.",
  });
  assert.equal(calls.description.length, 0, "a refused request must not persist a description");
});

test("the openai provider posts the image as a data URL and extracts the text", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return jsonResponse({
      choices: [{ message: { role: "assistant", content: "  A serial number label reading AC-1042.  " } }],
    }, 200);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { store, media } = await seedImage(t);

  const result = await describeStoredImage({
    store,
    config: {
      visionProvider: "openai",
      visionApiKey: "sk-vision-test",
      visionUrl: "https://vision.example/v1/chat/completions",
      visionModel: "gpt-4o-mini",
      visionTimeoutMs: 5000,
      visionMaxTokens: 256,
    },
    userId: USER_ID,
    mediaId: media.id,
  });

  assert.equal(result.provider, "openai");
  assert.equal(result.description, "A serial number label reading AC-1042.");
  assert.equal(result.media.description, "A serial number label reading AC-1042.");

  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.url, "https://vision.example/v1/chat/completions");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.authorization, "Bearer sk-vision-test");
  assert.equal(request.init.headers["content-type"], "application/json");

  const body = JSON.parse(request.init.body);
  assert.equal(body.model, "gpt-4o-mini");
  assert.equal(body.max_tokens, 256);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");

  const [textPart, imagePart] = body.messages[0].content;
  assert.equal(textPart.type, "text");
  assert.ok(textPart.text.length > 0, "the instruction text must not be empty");
  assert.equal(imagePart.type, "image_url");
  assert.equal(
    imagePart.image_url.url,
    `data:image/png;base64,${PNG_BASE64}`,
    "the image must travel as a base64 data URL of the stored bytes",
  );
});

test("a non-2xx vision response surfaces as 502 and records the failure", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ error: "rate limited" }, 429);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { store, media, calls } = await seedImage(t);

  await assert.rejects(
    () => describeStoredImage({
      store,
      config: { visionProvider: "openai", visionApiKey: "sk-test", visionTimeoutMs: 5000 },
      userId: USER_ID,
      mediaId: media.id,
    }),
    (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.message, "Image description failed.");
      assert.match(error.details.cause, /HTTP 429/u);
      return true;
    },
  );

  const failure = calls.processing.at(-1).processing;
  assert.equal(failure.visionStatus, "failed");
  assert.equal(failure.descriptionSource, "openai");
  assert.match(failure.lastError, /HTTP 429/u);
  assert.equal(calls.description.length, 0);
});

test("a hung vision provider aborts on the configured timeout", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    // Never settles on its own: only the AbortController can end this call.
    init.signal?.addEventListener("abort", () => {
      reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
    });
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { store, media, calls } = await seedImage(t);

  await assert.rejects(
    () => describeStoredImage({
      store,
      config: { visionProvider: "openai", visionApiKey: "sk-test", visionTimeoutMs: 25 },
      userId: USER_ID,
      mediaId: media.id,
    }),
    (error) => {
      assert.equal(error.status, 502);
      assert.match(error.details.cause, /timed out after 25ms/u);
      return true;
    },
  );

  assert.equal(calls.processing.at(-1).processing.visionStatus, "failed");
});

test("non-image media and unknown ids are rejected before any provider call", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("no provider call should be made");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { store, calls } = await seedImage(t);
  const audio = store.createMediaUpload({
    userId: USER_ID,
    kind: "audio",
    contentType: "audio/webm",
    sizeBytes: 16,
    sha256: createHash("sha256").update("audio").digest("hex"),
    storagePath: "/nonexistent/clip.webm",
  });

  await assert.rejects(
    () => describeStoredImage({
      store,
      config: { visionProvider: "openai", visionApiKey: "sk-test" },
      userId: USER_ID,
      mediaId: audio.id,
    }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /Only image media can be described\./u);
      return true;
    },
  );

  await assert.rejects(
    () => describeStoredImage({
      store,
      config: { visionProvider: "mock" },
      userId: USER_ID,
      mediaId: "media_missing",
    }),
    (error) => {
      assert.equal(error.status, 404);
      return true;
    },
  );

  assert.equal(calls.processing.length, 0, "a rejected kind must not touch processing state");
});

test("buildVisionRequest is pure and buildable without I/O", () => {
  const body = buildVisionRequest({
    media: { id: "media_1", contentType: "image/webp" },
    dataBase64: "AAAA",
    model: "custom-vlm",
    prompt: "Read the label.",
    maxTokens: 64,
  });

  assert.deepEqual(body, {
    model: "custom-vlm",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Read the label." },
          { type: "image_url", image_url: { url: "data:image/webp;base64,AAAA" } },
        ],
      },
    ],
  });

  assert.throws(() => buildVisionRequest({ media: { id: "media_1" }, dataBase64: "AAAA" }), /contentType/u);
  assert.throws(() => buildVisionRequest({ media: { contentType: "image/png" }, dataBase64: "" }), /dataBase64/u);
});

test("vision responses and prompt context normalize their text", () => {
  assert.equal(
    extractVisionDescription({ choices: [{ message: { content: [{ type: "text", text: " one " }, { type: "text", text: "two" }] } }] }),
    "one\ntwo",
  );
  assert.equal(extractVisionDescription({ choices: [{ message: { content: "   " } }] }), undefined);
  assert.equal(extractVisionDescription({}), undefined);

  const media = { id: "media_1", contentType: "image/png", originalName: "label.png" };
  assert.equal(
    visionToPromptContext(media, "  A serial label.  "),
    "Image description: id=media_1 contentType=image/png name=label.png -- A serial label.",
  );
  assert.equal(visionToPromptContext(media, "   "), "");
  assert.equal(visionToPromptContext({ id: "media_2", contentType: "image/png", description: "Cached." }), "Image description: id=media_2 contentType=image/png -- Cached.");
});

// Creates a real image on disk plus a store record for it. `withVisionMethods` adds the two
// store methods this module expects (updateMediaDescription / an image-aware
// updateMediaProcessing); without them the module must degrade gracefully.
async function seedImage(t, { withVisionMethods = true } = {}) {
  const mediaDir = await mkdtemp(join(tmpdir(), "next-coder-vision-"));
  t.after(() => rm(mediaDir, { recursive: true, force: true }));

  const buffer = Buffer.from(PNG_BASE64, "base64");
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const storagePath = join(mediaDir, `${sha256}.png`);
  await writeFile(storagePath, buffer);

  const base = createStore();
  const calls = { processing: [], description: [] };
  const media = base.createMediaUpload({
    userId: USER_ID,
    kind: "image",
    contentType: "image/png",
    sizeBytes: buffer.length,
    sha256,
    storagePath,
    originalName: "snapshot.png",
  });

  if (!withVisionMethods) {
    // The memory store's updateMediaProcessing/updateMediaTranscript both bail out on
    // non-audio media today, so this is exactly the store as it stands.
    return { store: base, media, calls };
  }

  const records = new Map();
  const store = {
    ...base,
    createMediaUpload: base.createMediaUpload,
    getMediaForUser: base.getMediaForUser,
    updateMediaProcessing(input) {
      calls.processing.push(input);
      const current = base.getMediaForUser(input.userId, input.mediaId);
      if (!current) return null;
      const { storagePath: _hidden, ...publicFields } = current;
      const next = { ...publicFields, ...records.get(input.mediaId), processing: input.processing };
      records.set(input.mediaId, next);
      return next;
    },
    updateMediaDescription(input) {
      calls.description.push(input);
      const current = base.getMediaForUser(input.userId, input.mediaId);
      if (!current) return null;
      const { storagePath: _hidden, ...publicFields } = current;
      const next = {
        ...publicFields,
        ...records.get(input.mediaId),
        description: input.description,
        processing: {
          visionStatus: "ready",
          descriptionSource: input.source,
          lastError: null,
        },
      };
      records.set(input.mediaId, next);
      return next;
    },
  };

  return { store, media, calls };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("a described image reports vision ready in the public view", () => {
  // publicMediaUpload dropped the `description` argument that updateMediaProcessing passes, so an
  // image whose stored processing carried no visionStatus read back "pending" while a description
  // existed — the public view disagreeing with the internal one about the same record.
  const store = createStore();
  const media = store.createMediaUpload({
    userId: USER_ID,
    kind: "image",
    contentType: "image/png",
    sizeBytes: 12,
    sha256: "a".repeat(64),
    storagePath: "/tmp/vision-public.png",
  });

  store.updateMediaDescription({
    userId: USER_ID,
    mediaId: media.id,
    description: "A photograph of a bench controller.",
    source: "mock",
  });

  const listed = store.listMediaUploads(USER_ID).find((item) => item.id === media.id);
  assert.equal(listed.processing.visionStatus, "ready");
  assert.equal(listed.processing.transcriptionStatus, "not_applicable");
});
