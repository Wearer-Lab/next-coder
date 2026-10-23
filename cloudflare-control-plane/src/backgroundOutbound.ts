import type { RuntimeBindings } from "./env";

const MAX_BODY_BYTES = 1024;
const TIMEOUT_MS = 5000;

/** A Container-only wakeup. Durable job ownership/leases remain in the gateway Store. */
export async function handleBackgroundOutbound(request: Request, env: RuntimeBindings): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || url.host !== "background.internal" || url.pathname !== "/v1/media/process"
      || url.search || url.username || url.password) return failure("not_found", 404);
  if (request.method !== "POST") return failure("method_not_allowed", 405, { allow: "POST" });
  if (!env.BACKGROUND_TASKS) return failure("background_queue_unconfigured", 503);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const incomingAbort = () => controller.abort();
  request.signal.addEventListener("abort", incomingAbort, { once: true });
  if (request.signal.aborted) incomingAbort();
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new BoundaryError("background_queue_timeout", 504)); }, TIMEOUT_MS);
    });
    return await Promise.race([enqueue(request, env.BACKGROUND_TASKS, controller.signal), deadline]);
  } catch (error) {
    return error instanceof BoundaryError ? failure(error.code, error.status) : failure("background_queue_unavailable", 502);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", incomingAbort);
  }
}

async function enqueue(request: Request, queue: Queue, signal: AbortSignal): Promise<Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new BoundaryError("invalid_request", 415);
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new BoundaryError("invalid_request_size", Number(declared) > MAX_BODY_BYTES ? 413 : 400);
  }
  if (!request.body) throw new BoundaryError("invalid_request", 400);
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new BoundaryError("request_aborted", 499);
      const { done, value } = await reader.read();
      if (signal.aborted) throw new BoundaryError("request_aborted", 499);
      if (done) break;
      if (value.length > MAX_BODY_BYTES - size) { cancel(); throw new BoundaryError("request_too_large", 413); }
      size += value.length;
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new BoundaryError("invalid_request", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BoundaryError("invalid_request", 400);
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "jobId" && key !== "delaySeconds")
      || typeof value.jobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.jobId)) {
    throw new BoundaryError("invalid_request", 400);
  }
  const delaySeconds = value.delaySeconds ?? 0;
  if (typeof delaySeconds !== "number" || !Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 900) {
    throw new BoundaryError("invalid_delay", 400);
  }
  if (signal.aborted) throw new BoundaryError("request_aborted", 499);
  // Do not place audio, transcript, user or job identifiers in Queue data. Its consumer already
  // claims the next due job atomically; this message only removes the scheduled-cron delay.
  await queue.send({ version: 1, taskId: crypto.randomUUID(), kind: "media.process", payload: {} }, { delaySeconds });
  return Response.json({ accepted: true }, { status: 202, headers: { "cache-control": "no-store" } });
}

function failure(code: string, status: number, headers: Record<string, string> = {}): Response {
  return Response.json({ error: code, retryable: status === 429 || status >= 500 }, {
    status, headers: { "cache-control": "no-store", ...headers },
  });
}

class BoundaryError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
