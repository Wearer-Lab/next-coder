import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeBindings } from "../src/env";
import { CONNECTOR_PROTOCOL_VERSION, type CloudRequestFrame, type CloudWelcomeFrame } from "../src/protocol";

const bindings = env as unknown as RuntimeBindings;
const origin = "https://nextcoder.test";

afterEach(async () => {
  await reset();
});

describe("Cloudflare connector runtime", () => {
  it("routes scoped ASR privately, strips diagnostics, and loses only ephemeral text when transient memory is discarded", async () => {
    const { socket, welcome } = await connectSocket("connector_asr", "environment_asr", ["t3:proxy", "media.transcribe"]);
    const request = { connectorId: "connector_asr", requestId: "request_asr_12345", idempotencyKey: "media-transcribe:job_fixture:1",
      method: "media.transcribe", payload: { jobId: "job_fixture", mediaId: "media_fixture" } };
    const routedPromise = nextMessage(socket);
    expect((await internalFetch("environment_asr", "/requests", { method: "POST", body: JSON.stringify(request) })).status).toBe(202);
    const routed = await routedPromise as CloudRequestFrame;
    expect(routed.body.payload).toEqual(request.payload);
    const pendingResult = internalFetch("environment_asr", `/requests/${request.requestId}?waitMs=1000`);
    socket.send(JSON.stringify({ protocolVersion: 1, type: "response.completed", connectionId: welcome.connectionId,
      body: { requestId: request.requestId, completedAt: new Date().toISOString(),
        result: { text: "fixture private ASR text", model: "parakeet-local", language: "en", durationMs: 1200,
          debug: "private provider diagnostics", token: "private-token", timings: { raw: "private" } } } }));
    await expect((await pendingResult).json()).resolves.toMatchObject({ status: "completed",
      result: { text: "fixture private ASR text", model: "parakeet-local", language: "en", durationMs: 1200 } });
    const duplicate = await (await internalFetch("environment_asr", "/requests", { method: "POST", body: JSON.stringify(request) })).json() as { result: unknown };
    expect(duplicate.result).toEqual({ text: "fixture private ASR text", model: "parakeet-local", language: "en", durationMs: 1200 });
    expect((await internalFetch("environment_other", `/requests/${request.requestId}`)).status).toBe(404);
    const hub = bindings.ENVIRONMENT_CONNECTOR_HUB.get(bindings.ENVIRONMENT_CONNECTOR_HUB.idFromName("environment_asr"));
    const durable = await runInDurableObject(hub, async (instance, state) => {
      const stored = await state.storage.list();
      (instance as unknown as { mediaResults: Map<string, unknown> }).mediaResults.clear();
      return JSON.stringify([...stored]);
    });
    expect(durable).not.toContain("fixture private ASR text");
    expect(durable).not.toContain("private provider diagnostics");
    const lost = await (await internalFetch("environment_asr", `/requests/${request.requestId}`)).json();
    expect(lost).toMatchObject({ status: "failed", failure: { code: "connector_transcription_result_unavailable", retryable: true } });
    expect(JSON.stringify(lost)).not.toContain("fixture private ASR text");
    expect(JSON.stringify(lost)).not.toContain("private provider diagnostics");
    socket.close();
  }, 15_000);

  it("requires ASR capability and exact IDs, rejects another connector, and expires abandoned ASR", async () => {
    const first = await connectSocket("connector_no_asr", "environment_no_asr");
    const base = { connectorId: "connector_no_asr", requestId: "request_asr_blocked", idempotencyKey: "idempotency_asr_blocked",
      method: "media.transcribe", payload: { jobId: "job_fixture", mediaId: "media_fixture" } };
    expect((await internalFetch("environment_no_asr", "/requests", { method: "POST", body: JSON.stringify(base) })).status).toBe(503);
    for (const payload of [{ ...base.payload, url: "http://private.test" }, { jobId: "job_fixture", mediaId: "../private" }]) {
      expect((await internalFetch("environment_no_asr", "/requests", { method: "POST", body: JSON.stringify({ ...base, payload }) })).status).toBe(400);
    }
    first.socket.close();
    const second = await connectSocket("connector_asr_timeout", "environment_asr_timeout", ["media.transcribe"]);
    expect((await internalFetch("environment_asr_timeout", "/requests", { method: "POST", body: JSON.stringify(base) })).status).toBe(403);
    const routed = nextMessage(second.socket);
    const timed = { ...base, connectorId: "connector_asr_timeout", deadlineMs: 1000 };
    expect((await internalFetch("environment_asr_timeout", "/requests", { method: "POST", body: JSON.stringify(timed) })).status).toBe(202);
    await routed;
    await new Promise((resolve) => setTimeout(resolve, 1050));
    await runDurableObjectAlarm(bindings.ENVIRONMENT_CONNECTOR_HUB.get(bindings.ENVIRONMENT_CONNECTOR_HUB.idFromName("environment_asr_timeout")));
    await expect((await internalFetch("environment_asr_timeout", `/requests/${base.requestId}`)).json()).resolves.toMatchObject({ failure: { code: "connector_timeout", retryable: true } });
    second.socket.close();
  });

  it("reports that the Node control-plane adapter is not yet integrated", async () => {
    const response = await workerFetch("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      runtime: "cloudflare-workers",
      controlPlaneAdapterIntegrated: false,
    });
  });

  it("serves the console shell for an extensionless client route", async () => {
    const response = await workerFetch("/environments/example", { headers: { accept: "text/html" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("permissions-policy")).toContain("microphone=(self)");
    expect(response.headers.get("content-security-policy")).toContain("https://*.clerk.accounts.dev");
  });

  it("consumes a ticket once and routes a terminal connector response", async () => {
    const { ticket } = await issueTicket("connector_test", "environment_test");
    const upgrade = await workerFetch(`/v1/connectors/socket?ticket=${encodeURIComponent(ticket)}`, {
      headers: { upgrade: "websocket" },
    });
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();

    socket?.send(
      JSON.stringify({
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        type: "hello",
        connectionId: "provisional_test_connection",
        body: {
          connectorId: "connector_test",
          environmentId: "environment_test",
          connectorVersion: "0.1.0",
          platform: "darwin-arm64",
          t3Version: "0.9.0",
          capabilities: ["t3:proxy"],
        },
      }),
    );
    const welcome = (await nextMessage(socket!)) as CloudWelcomeFrame;
    expect(welcome).toMatchObject({ type: "welcome", body: { maxInFlight: 32 } });
    expect(welcome.connectionId).toBe("provisional_test_connection");

    const hub = bindings.ENVIRONMENT_CONNECTOR_HUB.get(
      bindings.ENVIRONMENT_CONNECTOR_HUB.idFromName("environment_test"),
    );
    await evictDurableObject(hub);

    const requestPromise = nextMessage(socket!);
    const dispatch = await internalFetch("environment_test", "/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "request_12345678",
        idempotencyKey: "idempotency_12345678",
        method: "environment.snapshot",
        payload: {},
      }),
    });
    expect(dispatch.status).toBe(202);
    const routed = (await requestPromise) as CloudRequestFrame;
    expect(routed).toMatchObject({ type: "request", body: { requestId: "request_12345678" } });

    socket?.send(
      JSON.stringify({
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        type: "response.completed",
        connectionId: welcome.connectionId,
        body: {
          requestId: routed.body.requestId,
          result: { projects: 2 },
          completedAt: new Date().toISOString(),
        },
      }),
    );

    await eventually(async () => {
      const response = await internalFetch("environment_test", `/requests/${routed.body.requestId}`);
      if (!response.ok || response.status === 202) return false;
      const result = (await response.json()) as { status?: string; result?: unknown };
      return result.status === "completed" && JSON.stringify(result.result) === JSON.stringify({ projects: 2 });
    });

    const replay = await internalFetch("environment_test", "/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "different_request_1234",
        idempotencyKey: "idempotency_12345678",
        method: "environment.snapshot",
        payload: { shouldNotDispatch: true },
      }),
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ requestId: routed.body.requestId, status: "completed" });

    const reused = await workerFetch(`/v1/connectors/socket?ticket=${encodeURIComponent(ticket)}`, {
      headers: { upgrade: "websocket" },
    });
    expect(reused.status).toBe(401);
    socket?.close(1000, "test_complete");
  });

  it("fails a mutating request immediately when the connector is offline", async () => {
    const response = await internalFetch("environment_offline", "/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "request_offline_1",
        idempotencyKey: "idempotency_offline_1",
        method: "command.dispatch",
        payload: { prompt: "private input is not logged" },
      }),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "connector_offline", retryable: true });
  });

  it("holds one bounded result read and wakes it immediately on terminal delivery", async () => {
    const environmentId = "environment_result_wait";
    const { socket, welcome } = await connectSocket("connector_result_wait", environmentId);
    const routedPromise = nextMessage(socket);
    const dispatch = await internalFetch(environmentId, "/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "request_result_wait",
        idempotencyKey: "idempotency_result_wait",
        method: "snapshot",
        payload: {},
      }),
    });
    expect(dispatch.status).toBe(202);
    await routedPromise;

    const startedAt = performance.now();
    const waiting = internalFetch(environmentId, "/requests/request_result_wait?waitMs=1000");
    await new Promise((resolve) => setTimeout(resolve, 15));
    socket.send(JSON.stringify({
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "response.completed",
      connectionId: welcome.connectionId,
      body: { requestId: "request_result_wait", result: { woke: true }, completedAt: new Date().toISOString() },
    }));
    const terminal = await waiting;
    expect(terminal.status).toBe(200);
    await expect(terminal.json()).resolves.toMatchObject({ status: "completed", result: { woke: true } });
    expect(performance.now() - startedAt).toBeLessThan(900);
    socket.close(1000, "test_complete");
  });

  it("returns an unchanged pending result only when its bounded wait expires", async () => {
    const environmentId = "environment_idle_wait";
    const { socket } = await connectSocket("connector_idle_wait", environmentId);
    const routedPromise = nextMessage(socket);
    await internalFetch(environmentId, "/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "request_idle_wait",
        idempotencyKey: "idempotency_idle_wait",
        method: "snapshot",
        payload: {},
      }),
    });
    await routedPromise;
    const startedAt = performance.now();
    const pending = await internalFetch(environmentId, "/requests/request_idle_wait?waitMs=30");
    expect(pending.status).toBe(202);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(20);
    socket.close(1000, "test_complete");
  });

  it("expires a pending request through a Durable Object alarm", async () => {
    const { socket } = await connectSocket("connector_timeout", "environment_timeout");
    const requestPromise = nextMessage(socket);
    const dispatch = await internalFetch("environment_timeout", "/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "request_timeout_1",
        idempotencyKey: "idempotency_timeout_1",
        method: "command.dispatch",
        payload: {},
        deadlineMs: 1_000,
      }),
    });
    expect(dispatch.status).toBe(202);
    await requestPromise;
    await new Promise((resolve) => setTimeout(resolve, 1_050));

    const hub = bindings.ENVIRONMENT_CONNECTOR_HUB.get(
      bindings.ENVIRONMENT_CONNECTOR_HUB.idFromName("environment_timeout"),
    );
    expect(await runDurableObjectAlarm(hub)).toBe(true);
    const result = await internalFetch("environment_timeout", "/requests/request_timeout_1");
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({
      status: "failed",
      failure: { code: "connector_timeout", retryable: true },
    });
    socket.close(1000, "test_complete");
  });

  it("routes CLI-shaped subscription frames and durably polls snapshot/event items", async () => {
    const { socket, welcome } = await connectSocket("connector_stream", "environment_stream");
    const subscribePromise = nextMessage(socket);
    const opened = await internalFetch("environment_stream", "/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectorId: "connector_stream",
        leaseId: "lease_stream_123",
        threadId: "thread_stream_123",
        cursor: 41,
        turnLimit: 20,
        expiresAt: Date.now() + 60_000,
      }),
    });
    expect(opened.status).toBe(200);
    await expect(subscribePromise).resolves.toMatchObject({
      type: "subscribe",
      connectionId: welcome.connectionId,
      body: { leaseId: "lease_stream_123", threadId: "thread_stream_123", cursor: 41, turnLimit: 20 },
    });

    socket.send(JSON.stringify({
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "snapshot",
      connectionId: welcome.connectionId,
      body: {
        environmentId: "environment_stream",
        threadId: "thread_stream_123",
        leaseId: "lease_stream_123",
        cursor: "42",
        resetReason: "initial",
        snapshot: { thread: { id: "thread_stream_123" } },
      },
    }));
    socket.send(JSON.stringify({
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "event",
      connectionId: welcome.connectionId,
      body: {
        environmentId: "environment_stream",
        threadId: "thread_stream_123",
        leaseId: "lease_stream_123",
        eventId: "event_43",
        cursor: "43",
        payload: { kind: "event", event: { sequence: 43, type: "thread.message-sent" } },
      },
    }));
    await eventually(async () => {
      const response = await internalFetch("environment_stream", "/subscriptions/lease_stream_123?after=0");
      const body = await response.json() as { items?: unknown[] };
      return body.items?.length === 2;
    });
    const page = await internalFetch("environment_stream", "/subscriptions/lease_stream_123?after=0");
    await expect(page.json()).resolves.toMatchObject({ items: [
      { sequence: 1, value: { kind: "snapshot", snapshot: { thread: { id: "thread_stream_123" } } } },
      { sequence: 2, value: { kind: "event", event: { sequence: 43 } } },
    ] });

    const unsubscribePromise = nextMessage(socket);
    const closed = await internalFetch("environment_stream", "/subscriptions/lease_stream_123", { method: "DELETE" });
    expect(closed.status).toBe(200);
    await expect(unsubscribePromise).resolves.toMatchObject({ type: "unsubscribe", body: { leaseId: "lease_stream_123" } });
    socket.close(1000, "test_complete");
  });

  it("wakes a subscription wait without losing back-to-back durable deliveries", async () => {
    const environmentId = "environment_stream_wait";
    const { socket, welcome } = await connectSocket("connector_stream_wait", environmentId);
    const subscribe = nextMessage(socket);
    await internalFetch(environmentId, "/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectorId: "connector_stream_wait",
        leaseId: "lease_stream_wait",
        threadId: "thread_stream_wait",
        expiresAt: Date.now() + 60_000,
      }),
    });
    await subscribe;
    const firstPagePromise = internalFetch(environmentId, "/subscriptions/lease_stream_wait?after=0&waitMs=1000");
    await new Promise((resolve) => setTimeout(resolve, 15));
    for (const sequence of [51, 52]) {
      socket.send(JSON.stringify({
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        type: "event",
        connectionId: welcome.connectionId,
        body: {
          environmentId,
          threadId: "thread_stream_wait",
          leaseId: "lease_stream_wait",
          eventId: `event_${sequence}`,
          cursor: String(sequence),
          payload: { kind: "event", event: { sequence } },
        },
      }));
    }
    const firstPage = await firstPagePromise;
    const first = await firstPage.json() as { items: Array<{ sequence: number; value: unknown }> };
    const after = first.items.at(-1)?.sequence ?? 0;
    await eventually(async () => {
      const replay = await (await internalFetch(environmentId, `/subscriptions/lease_stream_wait?after=${after}`)).json() as { items?: unknown[] };
      return first.items.length + (replay.items?.length ?? 0) === 2;
    });
    const replay = await (await internalFetch(environmentId, `/subscriptions/lease_stream_wait?after=${after}`)).json() as { items: Array<{ sequence: number }> };
    expect([...first.items, ...replay.items].map((item) => item.sequence)).toEqual([1, 2]);
    socket.close(1000, "test_complete");
  });

  it("supersedes the old environment socket and supports revocation", async () => {
    const first = await connectSocket("connector_first", "environment_single");
    const shutdownPromise = nextMessage(first.socket);
    const second = await connectSocket("connector_second", "environment_single");
    await expect(shutdownPromise).resolves.toMatchObject({ type: "shutdown", body: { reason: "superseded" } });

    const revokedPromise = nextMessage(second.socket);
    const revoke = await internalFetch("environment_single", "/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId: "connector_second", reason: "owner_revoked" }),
    });
    expect(revoke.status).toBe(200);
    await expect(revokedPromise).resolves.toMatchObject({ type: "shutdown", body: { reason: "revoked" } });
  });

  it("propagates revocation immediately, terminalizes pending work, and rejects revoked reconnects idempotently", async () => {
    const { socket } = await connectSocket("connector_revoke_live", "environment_revoke_live");
    const requestPromise = nextMessage(socket);
    await internalFetch("environment_revoke_live", "/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId: "connector_revoke_live", requestId: "request_revoke_live", idempotencyKey: "idempotency_revoke_live", method: "snapshot", payload: {} }),
    });
    await requestPromise;
    const shutdownPromise = nextMessage(socket);
    const first = await internalFetch("environment_revoke_live", "/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId: "connector_revoke_live", reason: "owner_revoked" }),
    });
    expect(first.status).toBe(200);
    await expect(shutdownPromise).resolves.toMatchObject({ type: "shutdown", body: { reason: "revoked" } });
    const terminal = await internalFetch("environment_revoke_live", "/requests/request_revoke_live");
    await expect(terminal.json()).resolves.toMatchObject({ status: "failed", failure: { code: "connector_revoked", retryable: false } });
    const repeated = await internalFetch("environment_revoke_live", "/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId: "connector_revoke_live", reason: "owner_revoked" }),
    });
    expect(repeated.status).toBe(200);
    const { ticket } = await issueTicket("connector_revoke_live", "environment_revoke_live");
    const reconnect = await workerFetch(`/v1/connectors/socket?ticket=${encodeURIComponent(ticket)}`, { headers: { upgrade: "websocket" } });
    expect(reconnect.status).toBe(403);
  });

  it("does not let revocation of an old connector terminate its replacement", async () => {
    const old = await connectSocket("connector_old_owner", "environment_replaced_owner");
    const replacement = await connectSocket("connector_new_owner", "environment_replaced_owner");
    const revoke = await internalFetch("environment_replaced_owner", "/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId: "connector_old_owner", reason: "old_credential_revoked" }),
    });
    expect(revoke.status).toBe(200);
    const status = await internalFetch("environment_replaced_owner", "/status");
    await expect(status.json()).resolves.toMatchObject({ connectorId: "connector_new_owner", status: "online" });
    const routedPromise = nextMessage(replacement.socket);
    const routed = await internalFetch("environment_replaced_owner", "/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId: "connector_new_owner", requestId: "request_new_owner", idempotencyKey: "idempotency_new_owner", method: "snapshot", payload: {} }),
    });
    expect(routed.status).toBe(202);
    await expect(routedPromise).resolves.toMatchObject({ type: "request", body: { requestId: "request_new_owner" } });
    old.socket.close(1000, "test_complete");
    replacement.socket.close(1000, "test_complete");
  });

  it("replays live requests and subscription leases after sleep using their original identities", async () => {
    const first = await connectSocket("connector_recover", "environment_recover");
    const requestPromise = nextMessage(first.socket);
    await internalFetch("environment_recover", "/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId: "connector_recover", requestId: "request_recover_1", idempotencyKey: "idempotency_recover_1", method: "snapshot", payload: { marker: "preserved" }, deadlineMs: 30_000 }),
    });
    const original = await requestPromise as CloudRequestFrame;
    const subscribePromise = nextMessage(first.socket);
    await internalFetch("environment_recover", "/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId: "connector_recover", leaseId: "lease_recover_1", threadId: "thread_recover_1", cursor: 17, expiresAt: Date.now() + 60_000 }),
    });
    await subscribePromise;
    first.socket.close(1001, "machine_sleep");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const recovered = await connectSocketCollecting("connector_recover", "environment_recover");
    await eventually(async () => recovered.messages.some((item) => item.type === "request") && recovered.messages.some((item) => item.type === "subscribe"));
    const replay = recovered.messages.find((item) => item.type === "request") as CloudRequestFrame;
    expect(replay).toMatchObject({
      connectionId: recovered.welcome.connectionId,
      body: { requestId: original.body.requestId, idempotencyKey: original.body.idempotencyKey, method: "snapshot", payload: { marker: "preserved" } },
    });
    expect(recovered.messages.find((item) => item.type === "subscribe")).toMatchObject({
      connectionId: recovered.welcome.connectionId,
      body: { leaseId: "lease_recover_1", threadId: "thread_recover_1", cursor: 17 },
    });
    recovered.socket.send(JSON.stringify({
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "response.completed",
      connectionId: recovered.welcome.connectionId,
      body: { requestId: replay.body.requestId, result: { recovered: true }, completedAt: new Date().toISOString() },
    }));
    await eventually(async () => (await (await internalFetch("environment_recover", "/requests/request_recover_1")).json() as { status?: string }).status === "completed");
    recovered.socket.close(1000, "test_complete");
  });

  it("does not replay cancelled or expired work during reconnect recovery", async () => {
    const first = await connectSocket("connector_recovery_filter", "environment_recovery_filter");
    for (const [requestId, deadlineMs] of [["request_cancelled_1", 30_000], ["request_expired_1", 1_000]] as const) {
      const routed = nextMessage(first.socket);
      await internalFetch("environment_recovery_filter", "/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectorId: "connector_recovery_filter", requestId, idempotencyKey: `idempotency_${requestId}`, method: "snapshot", payload: {}, deadlineMs }),
      });
      await routed;
    }
    await internalFetch("environment_recovery_filter", "/requests/request_cancelled_1/cancel", { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    first.socket.close(1001, "machine_sleep");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const recovered = await connectSocketCollecting("connector_recovery_filter", "environment_recovery_filter");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(recovered.messages.filter((item) => item.type === "request")).toHaveLength(0);
    await expect((await internalFetch("environment_recovery_filter", "/requests/request_cancelled_1")).json()).resolves.toMatchObject({ failure: { code: "connector_cancelled" } });
    await expect((await internalFetch("environment_recovery_filter", "/requests/request_expired_1")).json()).resolves.toMatchObject({ failure: { code: "connector_timeout" } });
    recovered.socket.close(1000, "test_complete");
  });

  it("rejects duplicate hello and frames carrying a stale connection identity", async () => {
    const duplicate = await connectSocket("connector_duplicate", "environment_duplicate");
    const duplicateClose = nextClose(duplicate.socket);
    duplicate.socket.send(JSON.stringify({
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "hello",
      connectionId: duplicate.welcome.connectionId,
      body: { connectorId: "connector_duplicate", environmentId: "environment_duplicate", connectorVersion: "0.1.0", platform: "test", capabilities: ["t3:proxy"] },
    }));
    await expect(duplicateClose).resolves.toMatchObject({ code: 4002 });

    const stale = await connectSocket("connector_stale", "environment_stale");
    const staleClose = nextClose(stale.socket);
    stale.socket.send(JSON.stringify({
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "heartbeat",
      connectionId: "superseded_connection_id",
      body: { sequence: 1, sentAt: new Date().toISOString(), activeRequests: 0, queueDepth: 0 },
    }));
    await expect(staleClose).resolves.toMatchObject({ code: 4002 });
  });

  it("bounds recovered subscription delivery buffers", async () => {
    const { socket, welcome } = await connectSocket("connector_buffer", "environment_buffer");
    const subscribePromise = nextMessage(socket);
    await internalFetch("environment_buffer", "/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectorId: "connector_buffer", leaseId: "lease_buffer_1", threadId: "thread_buffer_1", expiresAt: Date.now() + 60_000 }),
    });
    await subscribePromise;
    for (let index = 1; index <= 260; index += 1) {
      socket.send(JSON.stringify({
        protocolVersion: CONNECTOR_PROTOCOL_VERSION,
        type: "event",
        connectionId: welcome.connectionId,
        body: { environmentId: "environment_buffer", threadId: "thread_buffer_1", leaseId: "lease_buffer_1", eventId: `event_${index}`, cursor: index, payload: { kind: "event", event: { sequence: index } } },
      }));
    }
    await eventually(async () => {
      const response = await internalFetch("environment_buffer", "/subscriptions/lease_buffer_1?after=0");
      const body = await response.json() as { items?: Array<{ sequence: number }> };
      return body.items?.length === 256 && body.items.at(-1)?.sequence === 260;
    });
    const response = await internalFetch("environment_buffer", "/subscriptions/lease_buffer_1?after=0");
    const body = await response.json() as { items: Array<{ sequence: number }> };
    expect(body.items).toHaveLength(256);
    expect(body.items[0]?.sequence).toBe(5);
    socket.close(1000, "test_complete");
  });
});

async function connectSocket(connectorId: string, environmentId: string, capabilities = ["t3:proxy"]): Promise<{ socket: WebSocket; welcome: CloudWelcomeFrame }> {
  const { ticket } = await issueTicket(connectorId, environmentId);
  const upgrade = await workerFetch(`/v1/connectors/socket?ticket=${encodeURIComponent(ticket)}`, {
    headers: { upgrade: "websocket" },
  });
  expect(upgrade.status).toBe(101);
  const socket = upgrade.webSocket;
  if (!socket) throw new Error("Missing WebSocket on upgrade response.");
  socket.accept();
  socket.send(
    JSON.stringify({
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      type: "hello",
      connectionId: `provisional_${connectorId}`,
      body: {
        connectorId,
        environmentId,
        connectorVersion: "0.1.0",
        platform: "darwin-arm64",
        capabilities,
      },
    }),
  );
  const welcome = (await nextMessage(socket)) as CloudWelcomeFrame;
  expect(welcome.type).toBe("welcome");
  expect(welcome.connectionId).toBe(`provisional_${connectorId}`);
  return { socket, welcome };
}

async function connectSocketCollecting(connectorId: string, environmentId: string): Promise<{ socket: WebSocket; welcome: CloudWelcomeFrame; messages: any[] }> {
  const { ticket } = await issueTicket(connectorId, environmentId);
  const upgrade = await workerFetch(`/v1/connectors/socket?ticket=${encodeURIComponent(ticket)}`, { headers: { upgrade: "websocket" } });
  const socket = upgrade.webSocket;
  if (!socket) throw new Error("Missing WebSocket on upgrade response.");
  socket.accept();
  const messages: any[] = [];
  socket.addEventListener("message", (event) => { messages.push(JSON.parse(String(event.data))); });
  socket.send(JSON.stringify({
    protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    type: "hello",
    connectionId: `recovered_${connectorId}`,
    body: { connectorId, environmentId, connectorVersion: "0.1.0", platform: "darwin-arm64", capabilities: ["t3:proxy"] },
  }));
  await eventually(async () => messages.some((item) => item.type === "welcome"));
  return { socket, welcome: messages.find((item) => item.type === "welcome") as CloudWelcomeFrame, messages };
}

async function issueTicket(connectorId: string, environmentId: string): Promise<{ ticket: string }> {
  const response = await workerFetch("/__dev/tickets", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bindings.DEV_TICKET_ISSUER_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ connectorId, environmentId }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { ticket: string };
}

async function internalFetch(environmentId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bindings.ROUTER_SHARED_SECRET}`);
  return await workerFetch(`/internal/environments/${encodeURIComponent(environmentId)}/connector${path}`, { ...init, headers });
}

async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  const module = await import("../src/index");
  return await module.default.fetch(new Request(`${origin}${path}`, init), bindings);
}

async function nextMessage(socket: WebSocket): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message.")), 2_000);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(String(event.data)) as unknown);
      },
      { once: true },
    );
  });
}

async function nextClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket close.")), 2_000);
    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      resolve({ code: event.code, reason: event.reason });
    }, { once: true });
  });
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met.");
}
