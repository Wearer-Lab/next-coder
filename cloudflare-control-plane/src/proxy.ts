const PUBLIC_PREFIX = "/v1/";
const INTERNAL_PATHS = new Set([
  "/v1/internal/connectors/tickets/consume",
  "/v1/internal/connector-events",
  "/v1/internal/background/run",
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
]);

export type ProxyTarget = "public" | "internal" | "health" | "reject";

export function classifyRequest(request: Request): ProxyTarget {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return "health";
  if (INTERNAL_PATHS.has(url.pathname) && request.method === "POST") return "internal";
  if (url.pathname.startsWith("/v1/internal/")) return "reject";
  if (url.pathname.startsWith(PUBLIC_PREFIX)) return "public";
  return "reject";
}

export function prepareContainerRequest(request: Request, target: Exclude<ProxyTarget, "reject">): Request {
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  headers.delete("host");
  headers.delete("content-length");
  for (const name of [...headers.keys()]) {
    if (name.startsWith("x-next-coder-internal-")) headers.delete(name);
  }
  headers.set("x-next-coder-container-proxy", "1");
  if (target === "internal") headers.set("x-next-coder-internal-capability", "1");

  const method = request.method;
  return new Request(request.url, {
    method,
    headers,
    redirect: "manual",
    signal: request.signal,
    ...(method === "GET" || method === "HEAD" ? {} : { body: request.body, duplex: "half" }),
  });
}

export async function withResponseHeaderTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  incomingSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abortFromIncoming = () => controller.abort(incomingSignal?.reason);
  if (incomingSignal?.aborted) abortFromIncoming();
  else incomingSignal?.addEventListener("abort", abortFromIncoming, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("container_response_header_timeout")), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
    incomingSignal?.removeEventListener("abort", abortFromIncoming);
  }
}

export function jsonError(error: string, status: number): Response {
  return Response.json({ error }, {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });
}
