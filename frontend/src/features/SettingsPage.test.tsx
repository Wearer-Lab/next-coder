import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import { ConfirmProvider } from "../ui";
import { SettingsPage } from "./SettingsPage";

function controller(overrides: Record<string, unknown> = {}) {
  return {
    authenticated: true,
    authConfig: { clerk: { enabled: true } },
    clerk: {
      loaded: true,
      signedIn: true,
      userLabel: "owner@example.test",
      openUserProfile: vi.fn(),
      openSignIn: vi.fn(),
    },
    busyAction: null,
    environments: [],
    connectors: [],
    privacyDays: 30,
    setPrivacyDays: vi.fn(),
    media: [],
    localNotificationsEnabled: false,
    notificationSupport: "default",
    enableLocalNotifications: vi.fn(async () => "granted"),
    disableLocalNotifications: vi.fn(),
    setNotice: vi.fn(),
    api: vi.fn(async () => undefined),
    refreshAll: vi.fn(),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
    onboarding: { status: "completed" },
    downloadDiagnostics: vi.fn(),
    connection: "connected",
    lastResult: { message: "ready" },
    signOut: vi.fn(),
    remoteAccess: null,
    loadRemoteAccess: vi.fn(),
    ...overrides,
  } as unknown as Controller;
}

function renderSettings(c = controller()) {
  render(
    <ConfirmProvider>
      <SettingsPage controller={c} />
    </ConfirmProvider>,
  );
  return c;
}

test("recommends private Serve and gives a runnable setup command", () => {
  renderSettings();

  expect(screen.getByRole("heading", { name: "Open this console from another device" })).toBeVisible();
  expect(screen.getByRole("button", { name: /Tailscale Serve/i })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("npm run setup:tunnel -- --mode serve --write-env")).toBeVisible();
  expect(screen.getByText(/trusted private network/i)).toBeVisible();
});

test("shows connector fleet evidence and revokes a standing connector secret", async () => {
  const c = renderSettings(controller({
    environments: [{ id: "env_1", label: "Studio Mac", baseUrl: null, transportMode: "connector" }],
    connectors: [{
      id: "con_1",
      environmentId: "env_1",
      label: "Studio connector",
      status: "online",
      connectorVersion: "0.2.0",
      platform: "darwin-arm64",
      lastSeenAt: "2026-08-27T12:00:00Z",
    }],
  }));

  expect(screen.getByRole("heading", { name: "Workspace computers" })).toBeVisible();
  expect(screen.getByText("Studio connector")).toBeVisible();
  expect(screen.getByText(/v0.2.0 · darwin-arm64/u)).toBeVisible();
  expect(screen.getByText("npx @wearer-haitch/connector doctor")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  fireEvent.click(await screen.findByRole("button", { name: "Revoke connector" }));
  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/connectors/con_1", { method: "DELETE" }));
});

test("makes public Funnel exposure explicit before showing its command", () => {
  renderSettings();

  fireEvent.click(screen.getByRole("button", { name: /Tailscale Funnel/i }));

  expect(screen.getByRole("button", { name: /Tailscale Funnel/i })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("npm run setup:tunnel -- --mode funnel --write-env")).toBeVisible();
  expect(screen.getByRole("note")).toHaveTextContent(/public internet/i);
  expect(screen.getByRole("note")).toHaveTextContent(/Clerk/i);
});

test("omits host-only tunnel controls in an explicitly cloud deployment", () => {
  renderSettings(controller({ authConfig: { clerk: { enabled: true }, deploymentMode: "cloud" } }));

  expect(screen.queryByRole("heading", { name: "Open this console from another device" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Workspace computers" })).toBeVisible();
});

test("describes opt-in browser delivery truthfully without claiming Web Push", async () => {
  const c = renderSettings();

  expect(screen.getByRole("heading", { name: "Local system notifications" })).toBeVisible();
  expect(screen.getByText(/Nothing is sent to a push service/u)).toBeVisible();
  expect(screen.getByText(/delivery stops when this browser and its installed PWA are closed/u)).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Enable local notifications" }));
  await waitFor(() => expect(c.enableLocalNotifications).toHaveBeenCalledOnce());
});

test("recognizes an existing tunnel and stops presenting setup as unfinished", () => {
  renderSettings(controller({
    remoteAccess: {
      checkedAt: "2026-08-08T17:00:00.000Z",
      gateway: {
        host: "0.0.0.0",
        port: 3996,
        loopbackUrl: "http://127.0.0.1:3996",
        lanUrls: ["http://192.168.1.162:3996"],
        publicBaseUrl: "https://studio.example.ts.net",
      },
      tailscale: {
        installed: true,
        connected: true,
        backendState: "Running",
        dnsName: "studio.example.ts.net",
        ips: ["100.64.0.4"],
        httpsUrl: "https://studio.example.ts.net",
        serve: { active: true, statusAvailable: true },
        funnel: { active: false, statusAvailable: true },
        mode: "serve",
        publicBaseUrlConfigured: true,
        ready: true,
        error: null,
        nextStep: "ready",
      },
    },
  }));

  expect(screen.getByText("Remote access is configured")).toBeVisible();
  expect(screen.getByRole("link", { name: /Open remote console/i })).toHaveAttribute(
    "href",
    "https://studio.example.ts.net",
  );
  expect(screen.queryByText("npm run setup:tunnel -- --mode serve --write-env")).toBeNull();
});
