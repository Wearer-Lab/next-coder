import type { RuntimeBindings } from "./env";

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export function controlPlaneBindingRequired(env: RuntimeBindings): boolean {
  return env.DEPLOYMENT_ENVIRONMENT === "staging" || env.DEPLOYMENT_ENVIRONMENT === "production";
}

export function hasRequiredControlPlaneBinding(env: RuntimeBindings): boolean {
  return !controlPlaneBindingRequired(env) || (env.CONNECTOR_AUTH_MODE === "control-plane" && Boolean(env.CONTROL_PLANE));
}

/**
 * Forward the same-origin API request over Cloudflare's private Service
 * Binding. The target URL is reconstructed on an internal hostname; public
 * socket ticket URLs are handled before this boundary and are never forwarded.
 */
export async function forwardControlPlaneRequest(request: Request, env: RuntimeBindings): Promise<Response> {
  if (!env.CONTROL_PLANE) {
    return json(
      {
        error: controlPlaneBindingRequired(env) ? "control_plane_unconfigured" : "local_control_plane_not_bound",
        message: "The same-origin control-plane Service Binding is not configured.",
      },
      controlPlaneBindingRequired(env) ? 503 : 501,
    );
  }

  const publicUrl = new URL(request.url);
  const targetUrl = new URL(`${publicUrl.pathname}${publicUrl.search}`, "https://control-plane.internal");
  const headers = new Headers(request.headers);
  for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("x-next-coder-edge", "cloudflare");
  headers.set("x-forwarded-host", publicUrl.host);
  headers.set("x-forwarded-proto", "https");
  headers.delete("x-forwarded-for");
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) headers.set("x-forwarded-for", clientIp);

  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;

  try {
    const downstream = await env.CONTROL_PLANE.fetch(new Request(targetUrl, init));
    const responseHeaders = new Headers(downstream.headers);
    if (isCredentialBearingPath(publicUrl.pathname)) {
      responseHeaders.set("cache-control", "no-store");
      responseHeaders.set("referrer-policy", "no-referrer");
    }
    return new Response(downstream.body, {
      status: downstream.status,
      statusText: downstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return json({ error: "control_plane_unavailable", message: "The control-plane service is unavailable." }, 502);
  }
}

function isCredentialBearingPath(pathname: string): boolean {
  return pathname === "/v1/connectors/enroll" || pathname === "/v1/connectors/ticket" || pathname.startsWith("/v1/t3/connect-sessions");
}

function json(value: unknown, status: number): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}
