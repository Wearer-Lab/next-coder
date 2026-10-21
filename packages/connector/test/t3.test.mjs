import "./support/closeEvent.mjs";

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createT3Client } from "../src/t3.mjs";

test("local T3 HTTP client handles metadata, snapshot, detail, and dispatch", async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/.well-known/t3/environment") response.end(JSON.stringify({ version: "0.0.32" }));
    else if (request.url === "/api/orchestration/snapshot") response.end(JSON.stringify({ snapshotSequence: 7, threads: [] }));
    else if (request.url === "/api/orchestration/threads/thr_1?turnLimit=1") response.end(JSON.stringify({ thread: { id: "thr_1" } }));
    else if (request.url === "/api/orchestration/dispatch") response.end(JSON.stringify({ sequence: 8 }));
    else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = createT3Client({ baseUrl, accessToken: "local-token" });
  assert.equal((await client.environmentInfo()).version, "0.0.32");
  assert.equal((await client.snapshot()).snapshotSequence, 7);
  assert.equal((await client.threadDetail("thr_1", { turnLimit: 1 })).id, "thr_1");
  assert.equal((await client.dispatch({ type: "thread.session.stop" })).sequence, 8);
  assert.equal(requests[0].authorization, undefined);
  assert.equal(requests[1].authorization, "Bearer local-token");
});

test("Effect RPC acknowledges chunks and thread close interrupts", async () => {
  const sockets = [];
  class MockSocket extends EventTarget {
    constructor(url) { super(); this.url = url; this.sent = []; sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send(value) {
      this.sent.push(JSON.parse(value));
      const frame = this.sent.at(-1);
      if (frame._tag === "Request" && frame.tag === "server.getConfig") {
        queueMicrotask(() => this.message({ _tag: "Chunk", requestId: "1", values: [{ providers: [] }] }));
        queueMicrotask(() => this.message({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: null } }));
      }
    }
    message(value) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
    close() { this.dispatchEvent(new CloseEvent("close", { code: 1000 })); }
  }
  const fetchImpl = async () => new Response(JSON.stringify({ ticket: "ticket" }), { status: 200 });
  const client = createT3Client({ baseUrl: "http://127.0.0.1:3773", accessToken: "token", fetchImpl, WebSocketImpl: MockSocket });
  assert.deepEqual(await client.callRpc("server.getConfig"), [{ providers: [] }]);
  assert.ok(sockets[0].sent.some((frame) => frame._tag === "Ack"));
  const stream = client.openThreadStream({ threadId: "thr" });
  await new Promise((resolve) => setImmediate(resolve));
  stream.close();
  assert.ok(sockets[1].sent.some((frame) => frame._tag === "Interrupt"));
});

test("capability probe returns only bounded contract evidence", async () => {
  class MockSocket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send(value) {
      const frame = JSON.parse(value);
      if (frame._tag === "Request") {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
          _tag: "Exit",
          requestId: "1",
          exit: { _tag: "Success", value: { providers: [], threadSnapshotPagination: true, threadResumeCompletionMarker: true } },
        }) })));
      }
    }
    close() {}
  }
  const fetchImpl = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/.well-known/t3/environment") return new Response(JSON.stringify({ serverVersion: "0.0.32", privatePath: "/Users/private" }));
    if (path === "/api/orchestration/snapshot") return new Response(JSON.stringify({ projects: [{ id: "private-project" }], threads: [{ id: "private-thread" }] }));
    if (path === "/api/orchestration/threads/private-thread") return new Response(JSON.stringify({ thread: { id: "private-thread", messages: [{ text: "private prompt" }] } }));
    if (path === "/api/auth/websocket-ticket") return new Response(JSON.stringify({ ticket: "private-ticket" }));
    return new Response("{}", { status: 404 });
  };
  const client = createT3Client({ baseUrl: "http://127.0.0.1:3773", accessToken: "private-token", fetchImpl, WebSocketImpl: MockSocket });
  const probe = await client.capabilityProbe();
  assert.equal(probe.schema, "next-coder.t3-probe.v1");
  assert.equal(probe.installedVersion, "0.0.32");
  assert.equal(probe.probes.threadDetail, "passed");
  assert.equal(probe.serverCapabilities.threadSnapshotPagination, true);
  assert.doesNotMatch(JSON.stringify(probe), /private-project|private-thread|private prompt|private-ticket|private-token|Users/u);
});
