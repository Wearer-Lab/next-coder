import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { requestJson } from "./api";
import { useController } from "./controller";
import type { AuthConfig, ClerkBridge, T3CapabilityManifest } from "./types";

vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), requestJson: vi.fn() }));

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

test("loads selected capabilities once rather than feeding health updates back into workspace reads", async () => {
  const listeners = new Map<string, (event: { data: string }) => void>();
  vi.stubGlobal("EventSource", class {
    addEventListener(name: string, handler: (event: { data: string }) => void) { listeners.set(name, handler); }
    close() {}
  });
  const environment = { id: "env_fixture", label: "Mac", transportMode: "connector", status: "reachable", health: { capabilities: undefined as T3CapabilityManifest | undefined } };
  vi.mocked(requestJson).mockImplementation(async (path) => {
    if (path.endsWith("/capabilities")) {
      const manifest: T3CapabilityManifest = {
        schema: "next-coder.t3-capabilities.v1", contractVersion: "t3-adapter.v1", installedVersion: "0.1.1",
        probedAt: new Date().toISOString(), freshness: "fresh", source: "connector_probe",
        freshUntil: new Date(Date.now() + 2500).toISOString(), probes: {},
        features: { dispatch: { state: "supported", evidence: "fixture" } },
        attachments: { image: { state: "supported", evidence: "fixture" }, audio: { state: "unsupported", evidence: "fixture" }, file: { state: "unsupported", evidence: "fixture" }, maxCount: 8, maxImageBytes: 1024 },
        runtimeModes: [], interactionModes: [], approvalDecisions: [], recovery: null,
      };
      environment.health.capabilities = manifest;
      return { manifest, capabilities: { orchestrationOperate: true } };
    }
    if (path.endsWith("/snapshot")) return { environment, snapshot: { projects: [], threads: [] } };
    if (path === "/v1/t3/environments") return { environments: [environment] };
    return {
      devices: [], commands: [], macros: [], media: [], jobs: [], events: [], profiles: [], connectors: [],
      actions: [], notifications: [], boards: [], privacy: { mediaRetentionDays: 30 },
      onboarding: null, readiness: null, display: null, remoteAccess: null,
    };
  });
  const clerk = { loaded: true, signedIn: true, getToken: async () => "fixture-token" } as ClerkBridge;
  const { result, rerender, unmount } = renderHook(() => useController({ authConfig: {} as AuthConfig, clerk }));
  await waitFor(() => expect(result.current.environments[0]?.health?.capabilities).toBeDefined());
  expect(result.current.environments[0]?.health?.capabilities?.features.dispatch.state).toBe("supported");
  const capabilityReads = () => vi.mocked(requestJson).mock.calls.filter(([path]) => path.endsWith("/capabilities")).length;
  expect(capabilityReads()).toBe(1);
  const readsBeforeAuth = vi.mocked(requestJson).mock.calls.length;
  await act(async () => {
    for (const action of ["ensureUser", "authenticateDevice", "createConnectorTicket", "consumeConnectorTicket"]) {
      listeners.get("state.changed")?.({ data: JSON.stringify({ summary: { latestAction: action } }) });
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  });
  expect(vi.mocked(requestJson).mock.calls.length).toBe(readsBeforeAuth);
  act(() => listeners.get("state.changed")?.({ data: JSON.stringify({ summary: { latestAction: "claimDevice" } }) }));
  await waitFor(() => expect(vi.mocked(requestJson).mock.calls.length).toBeGreaterThan(readsBeforeAuth));
  await act(async () => {
    await result.current.refreshAll();
  });
  rerender();
  await act(async () => { await Promise.resolve(); });
  expect(capabilityReads()).toBe(1);
  await waitFor(() => expect(capabilityReads()).toBe(2), { timeout: 4000 });
  unmount();
});
