import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { requestJson } from "./api";
import { useController } from "./controller";
import type { AuthConfig, ClerkBridge } from "./types";

vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), requestJson: vi.fn() }));

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

test("loads selected capabilities once rather than feeding health updates back into workspace reads", async () => {
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
  const environment = { id: "env_fixture", label: "Mac", transportMode: "connector", status: "reachable" };
  vi.mocked(requestJson).mockImplementation(async (path) => {
    if (path.endsWith("/capabilities")) return { capabilities: { version: 1 } };
    if (path.endsWith("/snapshot")) return { environment, snapshot: { projects: [], threads: [] } };
    if (path === "/v1/t3/environments") return { environments: [environment] };
    return {
      devices: [], commands: [], macros: [], media: [], jobs: [], events: [], profiles: [], connectors: [],
      actions: [], notifications: [], boards: [], privacy: { mediaRetentionDays: 30 },
      onboarding: null, readiness: null, display: null, remoteAccess: null,
    };
  });
  const clerk = { loaded: true, signedIn: true, getToken: async () => "fixture-token" } as ClerkBridge;
  const { result, rerender } = renderHook(() => useController({ authConfig: {} as AuthConfig, clerk }));
  await waitFor(() => expect(result.current.environments[0]?.health?.capabilities).toBeDefined());
  const capabilityReads = () => vi.mocked(requestJson).mock.calls.filter(([path]) => path.endsWith("/capabilities")).length;
  expect(capabilityReads()).toBe(1);
  await act(async () => {
    await result.current.refreshAll();
  });
  rerender();
  await act(async () => { await Promise.resolve(); });
  expect(capabilityReads()).toBe(1);
});
