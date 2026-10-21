import { describe, expect, it } from "vitest";

import type { RuntimeBindings } from "../src/env";
import { edgeOperation, emitTelemetry } from "../src/telemetry";

describe("privacy-safe cloud telemetry", () => {
  it("samples successful events before writing or logging", () => {
    const points: unknown[] = [];
    const lines: string[] = [];
    const emitted = emitTelemetry(bindings(points), {
      kind: "edge_request",
      operation: "health",
      outcome: "success",
      status: 200,
    }, { random: () => 0.99, log: (line) => lines.push(line) });

    expect(emitted).toBe(false);
    expect(points).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("bounds ordinary rejection volume independently of forced failure signals", () => {
    const points: Array<{ doubles: number[] }> = [];
    const event = { kind: "edge_request", operation: "static_asset", outcome: "rejected" as const, status: 404 };
    expect(emitTelemetry(bindings(points), event, { random: () => 0.5, log: () => {} })).toBe(false);
    expect(emitTelemetry(bindings(points), event, { random: () => 0.05, log: () => {} })).toBe(true);
    expect(points[0]?.doubles[6]).toBe(0.1);
  });

  it("forces failures while bucketing untrusted dimensions and bounding numbers", () => {
    const points: Array<{ blobs: string[]; doubles: number[] }> = [];
    const lines: string[] = [];
    const privateValue = "private/path?ticket=secret";
    expect(emitTelemetry(bindings(points), {
      kind: "queue_dlq_risk",
      operation: "background",
      outcome: "failure",
      status: 503,
      errorCode: privateValue,
      bucket: "gte_5m",
      count: Number.MAX_SAFE_INTEGER,
      durationMs: Number.POSITIVE_INFINITY,
    }, { random: () => 0.99, log: (line) => lines.push(line) })).toBe(true);

    expect(points).toHaveLength(1);
    expect(points[0]?.blobs).toEqual([
      "next-coder.cloud-telemetry.v1", "edge", "production", "queue_dlq_risk",
      "background", "failure", "5xx", "other", "gte_5m",
    ]);
    expect(points[0]?.doubles[0]).toBe(0);
    expect(points[0]?.doubles[1]).toBe(86_400_000);
    expect(points[0]?.doubles[6]).toBe(1);
    expect(lines.join("\n")).not.toContain(privateValue);
  });

  it("allowlists every categorical dimension instead of accepting identifier-shaped input", () => {
    const points: Array<{ blobs: string[] }> = [];
    const privateValue = "customer_12345";
    emitTelemetry(bindings(points), {
      kind: privateValue,
      operation: privateValue,
      outcome: "failure",
      bucket: privateValue,
      force: true,
    }, { log: () => {} });
    expect(points[0]?.blobs[3]).toBe("invalid");
    expect(points[0]?.blobs[4]).toBe("invalid");
    expect(points[0]?.blobs[8]).toBe("none");
    expect(JSON.stringify(points)).not.toContain(privateValue);
  });

  it("reduces arbitrary request paths to fixed route classes", () => {
    expect(edgeOperation(new Request("https://example.test/v1/private-user-path?ticket=secret"))).toBe("control_plane_api");
    expect(edgeOperation(new Request("https://example.test/users/private-user-path"))).toBe("static_asset");
  });
});

function bindings(points: unknown[]): RuntimeBindings {
  return {
    DEPLOYMENT_ENVIRONMENT: "production",
    CONNECTOR_AUTH_MODE: "control-plane",
    CONNECTOR_TICKET_AUDIENCE: "agent-controller-connectors",
    TELEMETRY_SUCCESS_SAMPLE_RATE: "0.05",
    TELEMETRY: { writeDataPoint(point: unknown) { points.push(point); } } as AnalyticsEngineDataset,
  } as RuntimeBindings;
}
