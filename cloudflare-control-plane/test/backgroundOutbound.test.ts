import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBindings } from "../src/env";
import { handleBackgroundOutbound } from "../src/backgroundOutbound";

function queued(body: unknown, url = "http://background.internal/v1/media/process") {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("private media Queue wakeup", () => {
  it("enqueues an opaque bounded wakeup without job IDs or user content", async () => {
    const send = vi.fn(async () => {});
    const response = await handleBackgroundOutbound(queued({ jobId: "private_job_123", delaySeconds: 9 }), { BACKGROUND_TASKS: { send } } as unknown as RuntimeBindings);
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ accepted: true });
    expect(send).toHaveBeenCalledExactlyOnceWith({ version: 1, taskId: expect.stringMatching(/^[a-f0-9-]{36}$/), kind: "media.process", payload: {} }, { delaySeconds: 9 });
    expect(JSON.stringify(send.mock.calls)).not.toContain("private_job_123");
  });

  it("rejects public routes, missing binding, invalid JSON/delays/extra fields and oversized streams", async () => {
    const send = vi.fn(async () => {}); const env = { BACKGROUND_TASKS: { send } } as unknown as RuntimeBindings;
    expect((await handleBackgroundOutbound(queued({ jobId: "job" }, "https://public.example/v1/media/process"), env)).status).toBe(404);
    expect((await handleBackgroundOutbound(new Request("http://background.internal/v1/media/process"), env)).status).toBe(405);
    expect((await handleBackgroundOutbound(queued({ jobId: "job" }), {} as RuntimeBindings)).status).toBe(503);
    for (const body of [{}, [], { jobId: "job", delaySeconds: 901 }, { jobId: "job", delaySeconds: -1 }, { jobId: "job", delaySeconds: 0.5 }, { jobId: "job", audio: "PRIVATE" }]) {
      expect((await handleBackgroundOutbound(queued(body), env)).status).toBe(400);
    }
    const request = new Request("http://background.internal/v1/media/process", { method: "POST", headers: { "content-type": "application/json", "content-length": "1" }, body: "x".repeat(1025) });
    expect((await handleBackgroundOutbound(request, env)).status).toBe(413); expect(send).not.toHaveBeenCalled();
  });

  it("redacts Queue errors and bounds an unresponsive binding", async () => {
    const env = { BACKGROUND_TASKS: { send: vi.fn(async () => { throw new Error("PRIVATE_QUEUE_TOKEN"); }) } } as unknown as RuntimeBindings;
    const response = await handleBackgroundOutbound(queued({ jobId: "job" }), env); expect(response.status).toBe(502); expect(await response.text()).not.toContain("PRIVATE_QUEUE_TOKEN");
    vi.useFakeTimers(); env.BACKGROUND_TASKS!.send = vi.fn(async () => await new Promise(() => {})) as any;
    const pending = handleBackgroundOutbound(queued({ jobId: "job" }), env); await vi.advanceTimersByTimeAsync(5000); expect((await pending).status).toBe(504); expect(vi.getTimerCount()).toBe(0);
  });
});
