import assert from "node:assert/strict";
import test from "node:test";
import { createCloudMediaQueuePublisher } from "../src/cloudMediaQueue.mjs";
import { loadConfig } from "../src/config.mjs";

const url = "http://background.internal/v1/media/process";
test("media wakeups use only the fixed private capability and bounded opaque metadata", async () => {
  const calls = [];
  const publish = createCloudMediaQueuePublisher({ url, fetchImpl: async (...args) => { calls.push(args); return new Response(null, { status: 202 }); } });
  assert.equal(await publish({ jobId: "job_123", delaySeconds: 1.2, transcript: "private", audio: "private" }), true);
  assert.equal(calls[0][0], url);
  assert.equal(calls[0][1].redirect, "error");
  assert.deepEqual(JSON.parse(calls[0][1].body), { jobId: "job_123", delaySeconds: 2 });
  assert.deepEqual(calls[0][1].headers, { "content-type": "application/json" });
  await publish({ jobId: "job_123", delaySeconds: 99999 });
  assert.equal(JSON.parse(calls[1][1].body).delaySeconds, 900);
  assert.equal(await publish({ jobId: "bad/id" }), false);
  assert.equal(calls.length, 2);
  assert.throws(() => createCloudMediaQueuePublisher({ url: "https://external.example/v1/media/process" }), /private capability/u);
  assert.equal(loadConfig({ CLOUD_MEDIA_QUEUE_URL: url }).cloudMediaQueueUrl, url);
});

test("queue outage and a stalled publisher retain durable work with bounded redacted failure", async () => {
  const logs = [];
  const logger = { warn: (line) => logs.push(line) };
  const rejected = createCloudMediaQueuePublisher({ url, logger, fetchImpl: async () => { throw new Error("private transcript/token"); } });
  assert.equal(await rejected({ jobId: "job_123" }), false);
  const stalled = createCloudMediaQueuePublisher({ url, logger, timeoutMs: 20, fetchImpl: async () => new Promise(() => {}) });
  assert.equal(await stalled({ jobId: "job_123" }), false);
  assert.equal(logs.length, 2);
  assert.equal(logs.some((line) => /transcript|token|job_123/u.test(line)), false);
});
