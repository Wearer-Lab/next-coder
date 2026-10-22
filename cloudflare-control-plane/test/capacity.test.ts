import { describe, expect, it } from "vitest";

import type { RuntimeBindings } from "../src/env";
import { handleControlPlaneRequest, type ContainerStubBoundary } from "../src/handler";

const QUALIFICATION_CONCURRENCY = 48;

describe("CG-08 singleton Container request boundary", () => {
  it("does not serialize forty-eight concurrent request bodies at the Worker proxy", async () => {
    let active = 0;
    let maxActive = 0;
    let starts = 0;
    let releaseBarrier = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const stub: ContainerStubBoundary = {
      async startGateway() {
        starts += 1;
      },
      async fetch(request) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await barrier;
        const body = await request.text();
        active -= 1;
        return Response.json({ body });
      },
    };

    const requests = Array.from({ length: QUALIFICATION_CONCURRENCY }, async (_, index) => {
      const response = await handleControlPlaneRequest(
        new Request(`https://console.example/v1/capacity/${index}`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: `capacity-${index}`,
        }),
        localBindings(),
        () => stub,
        (request) => request,
      );
      return { response, completedAt: performance.now() };
    });
    await eventually(() => active === QUALIFICATION_CONCURRENCY);

    const releasedAt = performance.now();
    releaseBarrier();
    const outcomes = await Promise.all(requests);
    const releaseToCompleteMs = performance.now() - releasedAt;
    const completionMs = outcomes.map((outcome) => outcome.completedAt - releasedAt);
    expect(starts).toBe(QUALIFICATION_CONCURRENCY);
    expect(maxActive).toBe(QUALIFICATION_CONCURRENCY);
    expect(outcomes.every(({ response }) => response.status === 200)).toBe(true);
    expect(releaseToCompleteMs).toBeLessThanOrEqual(500);
    console.info(`CAPACITY_CONTAINER_PROXY_RESULT ${JSON.stringify({
      concurrentRequests: QUALIFICATION_CONCURRENCY,
      maxActive,
      successfulResponses: outcomes.length,
      releaseToCompleteMs: round(releaseToCompleteMs),
      releaseToResponseMs: distribution(completionMs),
    })}`);
  });
});

function localBindings(): RuntimeBindings {
  return {
    DEPLOYMENT_ENVIRONMENT: "local",
    CONNECTOR_TICKET_AUDIENCE: "agent-controller-connectors",
    CONTAINER_STARTUP_TIMEOUT_MS: "20000",
    CONTAINER_RESPONSE_HEADER_TIMEOUT_MS: "30000",
    AGENT_CONTROLLER_GATEWAY: {} as RuntimeBindings["AGENT_CONTROLLER_GATEWAY"],
    CONNECTOR_ROUTER: {} as RuntimeBindings["CONNECTOR_ROUTER"],
  };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Container proxy concurrency was not reached.");
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function distribution(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? Number.POSITIVE_INFINITY;
  return {
    count: values.length,
    min: round(sorted[0] ?? Number.POSITIVE_INFINITY),
    p50: round(at(0.50)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted.at(-1) ?? Number.POSITIVE_INFINITY),
  };
}
