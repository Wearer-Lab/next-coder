import type { RuntimeBindings } from "./env";
import { classifyRequest, jsonError, prepareContainerRequest, withResponseHeaderTimeout } from "./proxy";
import { resolveRuntimeConfig, RuntimeConfigurationError } from "./runtimeConfig";
import { controlPlaneOperation, emitTelemetry, startupBucket } from "./telemetry";

const INTERNAL_PORT = 3998;

export interface ContainerStubBoundary {
  startGateway(
    envVars: Record<string, string>,
    timeoutMs: number,
  ): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

export async function handleControlPlaneRequest(
  request: Request,
  env: RuntimeBindings,
  getSingleton: () => ContainerStubBoundary,
  targetPort: (request: Request, port: number) => Request,
): Promise<Response> {
  const startedAt = performance.now();
  const target = classifyRequest(request);
  const operation = controlPlaneOperation(request, target);
  const report = (response: Response, input: { errorCode?: string; startupMs?: number } = {}): Response => {
    emitTelemetry(env, {
      kind: "container_request",
      operation,
      outcome: response.status >= 500 ? "failure" : response.status >= 400 ? "rejected" : "success",
      status: response.status,
      errorCode: input.errorCode,
      bucket: input.startupMs === undefined ? "not_started" : startupBucket(input.startupMs),
      durationMs: performance.now() - startedAt,
      lagMs: input.startupMs,
    });
    return response;
  };
  if (target === "reject") return report(jsonError("not_found", 404), { errorCode: "route_rejected" });

  let runtime;
  try {
    runtime = resolveRuntimeConfig(env);
  } catch (error) {
    if (error instanceof RuntimeConfigurationError) return report(jsonError(error.code, 503), { errorCode: "runtime_configuration" });
    return report(jsonError("control_plane_runtime_failure", 500), { errorCode: "runtime_failure" });
  }

  const startupStartedAt = performance.now();
  let startupMs: number | undefined;
  let phase: "startup" | "headers" = "startup";
  try {
    const container = getSingleton();
    await container.startGateway(
      runtime.containerEnv,
      runtime.startupTimeoutMs,
    );
    startupMs = performance.now() - startupStartedAt;
    phase = "headers";

    const response = await withResponseHeaderTimeout(
      async (signal) => {
        const outbound = prepareContainerRequest(new Request(request, { signal }), target);
        return await container.fetch(target === "internal" ? targetPort(outbound, INTERNAL_PORT) : outbound);
      },
      runtime.responseHeaderTimeoutMs,
      request.signal,
    );
    return report(protectResponse(response, target), { startupMs });
  } catch (error) {
    startupMs ??= performance.now() - startupStartedAt;
    if (request.signal.aborted) return report(jsonError("request_aborted", 499), { errorCode: "request_aborted", startupMs });
    if (isTimeout(error)) {
      return report(jsonError("control_plane_timeout", 504), {
        errorCode: phase === "startup" ? "container_startup_timeout" : "container_header_timeout",
        startupMs,
      });
    }
    // Platform error fields, including names, codes and stacks, may echo secrets or request data.
    // Report only fixed classifications and counts; telemetry records the outcome and timing.
    console.log(JSON.stringify({
      kind: "container_request_failed",
      phase,
      envKeyCount: Object.keys(runtime.containerEnv).length,
    }));
    return report(jsonError("control_plane_unavailable", 503), {
      errorCode: phase === "startup" ? "container_startup_unavailable" : "container_unavailable",
      startupMs,
    });
  }
}

function protectResponse(response: Response, target: ReturnType<typeof classifyRequest>): Response {
  const headers = new Headers(response.headers);
  headers.delete("server");
  headers.delete("x-powered-by");
  if (target === "internal" || response.headers.get("content-type")?.includes("application/json")) {
    headers.set("cache-control", "no-store");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "TimeoutError"
    || error.message === "container_response_header_timeout"
  );
}
