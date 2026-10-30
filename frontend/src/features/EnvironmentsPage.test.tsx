import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import type { ConnectSession, Environment } from "../types";
import { ConfirmProvider } from "../ui";
import { EnvironmentsPage } from "./EnvironmentsPage";

const connected: Environment = {
  id: "env_new",
  label: "Mac T3 Code",
  baseUrl: "https://mac.tailnet.ts.net",
  status: "paired",
};
const connectorConnected: Environment = {
  id: "env_new",
  label: "Mac T3 Code",
  baseUrl: null,
  transportMode: "connector",
  connectorId: "con_1",
  freshness: "unknown",
  status: "unchecked",
};

function controller(environments: Environment[] = []): Controller {
  return {
    environments,
    archivedEnvironments: [],
    connectors: [],
    connection: "connected",
    selectedEnvironmentId: environments[0]?.id ?? "",
    selectedEnvironment: environments[0] ?? null,
    setSelectedEnvironmentId: vi.fn(),
    markEnvironmentCredentialChanged: vi.fn(),
    projects: [],
    threads: [],
    busyAction: null,
    setNotice: vi.fn(),
    refreshAll: vi.fn(async () => undefined),
    loadSnapshot: vi.fn(async () => ({ environment: environments[0] ?? connected })),
    // Console-first pairing: the dialog mints a session, then polls it. The default stub keeps the
    // session pending so the waiting state is what renders unless a test says otherwise.
    createConnectSession: vi.fn(async () => ({
      session: pendingSession,
      code: "ABCDE-FGHIJ",
      gatewayUrl: "https://gateway.example",
      command: "npx @wearer-haitch/connector connect --server 'https://gateway.example' --code 'ABCDE-FGHIJ'",
    })),
    fetchConnectSession: vi.fn(async () => ({ session: pendingSession, environment: null })),
    api: vi.fn(async (path: string, options?: { method?: string }) => {
      if (path === "/v1/t3/environments" && options?.method === "POST") return { environment: connected };
      return { environment: environments[0] ?? connected };
    }),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
  } as unknown as Controller;
}

const pendingSession: ConnectSession = {
  id: "cxn_1",
  label: "Mac T3 Code",
  accessMode: "local",
  environmentId: null,
  status: "pending",
  baseUrl: null,
  error: null,
  expiresAt: "2026-09-01T18:15:00.000Z",
  completedAt: null,
};

function renderPage(c: Controller) {
  return render(<ConfirmProvider><EnvironmentsPage controller={c} /></ConfirmProvider>);
}

test("hands an empty account a copyable connect command and waits for the host to redeem it", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const c = controller();
  renderPage(c);

  expect(screen.getByRole("heading", { name: "Where does your agent work run?" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Connect T3 Code" }));

  const dialog = screen.getByRole("dialog", { name: "Connect T3 Code" });
  expect(dialog).toBeVisible();
  expect(dialog.parentElement?.parentElement).toBe(document.body);
  expect(screen.getByText("Connect the machine where T3 Code runs")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  fireEvent.change(screen.getByLabelText("Environment label"), { target: { value: "Studio Mac" } });
  fireEvent.click(screen.getByRole("radio", { name: /Connect another computer/u }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));

  await waitFor(() => expect(c.createConnectSession).toHaveBeenCalledWith({
    label: "Studio Mac",
    environmentId: null,
  }));

  const command = "npx @wearer-haitch/connector connect --server 'https://gateway.example' --code 'ABCDE-FGHIJ'";
  expect(await screen.findByText(command)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Copy connect command" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
  expect(screen.getByRole("button", { name: "Copied connect command" })).toBeVisible();

  // Nothing is pasted back: the dialog polls until the host lands the pairing.
  expect(screen.getByText("Waiting for the connector…")).toBeVisible();
  await waitFor(() => expect(c.fetchConnectSession).toHaveBeenCalledWith("cxn_1"));
  expect(within(dialog).queryByRole("button", { name: /Connect environment/u })).toBeNull();
});

test("closes the connect flow when the polled session reports the pairing landed", async () => {
  const c = controller();
  Object.assign(c, {
    fetchConnectSession: vi.fn(async () => ({
      session: { ...pendingSession, status: "completed", environmentId: "env_new" },
      environment: connectorConnected,
    })),
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Connect T3 Code" }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));

  await screen.findByText("Connector enrolled");
  expect(c.setSelectedEnvironmentId).toHaveBeenCalledWith("env_new");
  expect(c.refreshAll).toHaveBeenCalled();
  expect(screen.getByText("Outbound connector")).toBeVisible();
  expect(screen.getByText("Enrollment complete")).toBeVisible();
  expect(screen.getByRole("button", { name: "Continue setup" })).toBeVisible();
  expect(screen.getByText(/Enrollment is only the first layer/u)).toBeVisible();
  expect(screen.queryByText("Connection ready")).toBeNull();
});

test("surfaces a pairing that failed on the host instead of spinning forever", async () => {
  const c = controller();
  Object.assign(c, {
    fetchConnectSession: vi.fn(async () => ({
      session: { ...pendingSession, status: "failed", error: "T3 token exchange failed with HTTP 400." },
      environment: null,
    })),
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Connect T3 Code" }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));

  expect(await screen.findByText(/T3 token exchange failed with HTTP 400/u)).toBeVisible();
  const retry = screen.getByRole("button", { name: "Get a new command" });
  fireEvent.click(retry);
  await waitFor(() => expect(c.createConnectSession).toHaveBeenCalledTimes(2));
});

test("keeps manual credential paste as the fallback and still requires HTTPS for online hosts", async () => {
  const c = controller();
  Object.assign(c, { authConfig: { deploymentMode: "self-hosted" } });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Connect T3 Code" }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  fireEvent.click(screen.getByRole("button", { name: /Advanced: connect directly/u }));
  fireEvent.click(screen.getByRole("radio", { name: /Online HTTPS/u }));
  expect(screen.getByText("Public internet endpoint")).toBeVisible();
  expect(screen.getByText("Never enter a plain HTTP URL for an internet-accessible host.")).toBeVisible();
  const dialog = screen.getByRole("dialog", { name: "Connect T3 Code" });

  fireEvent.change(screen.getByLabelText("T3 base URL"), { target: { value: "http://t3.example.com" } });
  fireEvent.change(screen.getByLabelText("Pairing token"), { target: { value: "pair_once" } });
  expect(within(dialog).getByRole("button", { name: "Connect environment" })).toBeDisabled();

  fireEvent.change(screen.getByLabelText("T3 base URL"), { target: { value: "https://t3.example.com" } });
  const connect = within(dialog).getByRole("button", { name: "Connect environment" });
  expect(connect).toBeEnabled();
  fireEvent.click(connect);

  await screen.findByText("Host credential saved");
  expect(c.api).toHaveBeenCalledWith("/v1/t3/environments", {
    method: "POST",
    body: {
      // The label field now starts empty so the host can name itself. On the direct path no
      // connector ever reports a name, so the URL's host is used — which still distinguishes two
      // environments, where the old hardcoded "Mac T3 Code" named every computer a Mac.
      label: "t3.example.com",
      baseUrl: "https://t3.example.com",
      pairingToken: "pair_once",
    },
  });
  expect(c.setSelectedEnvironmentId).toHaveBeenCalledWith("env_new");
});

test("keeps the rejected direct URL and token flow out of managed cloud", async () => {
  const c = controller();
  Object.assign(c, { authConfig: { deploymentMode: "cloud", clerk: { enabled: true } } });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Connect T3 Code" }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));

  await waitFor(() => expect(c.createConnectSession).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("button", { name: /Advanced: connect directly/u })).toBeNull();
  expect(screen.queryByLabelText("T3 base URL")).toBeNull();
  expect(screen.queryByLabelText("Pairing token")).toBeNull();
  expect(screen.queryByLabelText("Access token")).toBeNull();
});

test("does not remint a failed cloud enrollment on controller updates and permits an explicit retry", async () => {
  const c = controller();
  Object.assign(c, {
    authConfig: { deploymentMode: "cloud", clerk: { enabled: true } },
    createConnectSession: vi.fn().mockRejectedValue(new Error("Gateway unavailable")),
  });
  const page = renderPage(c);
  fireEvent.click(screen.getByRole("button", { name: "Connect T3 Code" }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  expect(await screen.findByText("Gateway unavailable")).toBeVisible();

  for (const connection of ["error", "reconnecting", "connected"] as const) {
    page.rerender(<ConfirmProvider><EnvironmentsPage controller={{ ...c, connection }} /></ConfirmProvider>);
  }
  expect(c.createConnectSession).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/pasting the credential/u)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(c.createConnectSession).toHaveBeenCalledTimes(2));
});

test("offers connector migration instead of URL or token edits for a legacy direct cloud record", async () => {
  const environment: Environment = {
    id: "env_legacy",
    label: "Legacy Mac",
    baseUrl: "https://legacy.example.test",
    status: "unreachable",
  };
  const c = controller([environment]);
  Object.assign(c, { authConfig: { deploymentMode: "cloud", clerk: { enabled: true } } });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Edit Legacy Mac" }));
  const dialog = screen.getByRole("dialog", { name: "Legacy Mac" });
  expect(within(dialog).getByText("Direct connection unavailable in managed cloud")).toBeVisible();
  expect(within(dialog).queryByLabelText("T3 base URL")).toBeNull();

  fireEvent.click(within(dialog).getByRole("button", { name: "credential" }));
  expect(within(dialog).getByText("Replace the legacy direct connection")).toBeVisible();
  expect(within(dialog).queryByLabelText(/Replacement .* token/u)).toBeNull();

  fireEvent.click(within(dialog).getByRole("button", { name: "connection" }));
  fireEvent.change(within(dialog).getByLabelText("Environment label"), { target: { value: "Legacy Mac renamed" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/t3/environments/env_legacy", {
    method: "PUT",
    body: { label: "Legacy Mac renamed" },
  }));
});

test("re-pairing an existing host reuses the same flow and updates it in place", async () => {
  const environment: Environment = {
    id: "env_42",
    label: "Studio Mac",
    baseUrl: "https://studio.tailnet.ts.net",
    status: "token_expired",
  };
  const c = controller([environment]);
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Edit Studio Mac" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Studio Mac" })).getByRole("button", { name: "credential" }));
  fireEvent.click(screen.getByRole("button", { name: "Re-pair from the host" }));

  const dialog = await screen.findByRole("dialog", { name: "Re-pair Studio Mac" });
  // Label and access mode are pre-filled from the environment, and the session names it so the
  // redemption updates that row rather than adding a second one for the same machine.
  await waitFor(() => expect(c.createConnectSession).toHaveBeenCalledWith({
    label: "Studio Mac",
    environmentId: "env_42",
  }));
  expect(within(dialog).getByText("Run this on this computer")).toBeVisible();

  // The manual fallback of a re-pair is a PUT, never a POST.
  fireEvent.click(within(dialog).getByRole("button", { name: /Advanced: connect directly/u }));
  fireEvent.change(within(dialog).getByLabelText("Pairing token"), { target: { value: "pair_again" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save credential" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/t3/environments/env_42", {
    method: "PUT",
    body: {
      label: "Studio Mac",
      baseUrl: "https://studio.tailnet.ts.net",
      pairingToken: "pair_again",
    },
  }));
});

test("renders environment health tiles and edits connection details in a focused modal", async () => {
  const environment: Environment = {
    id: "env_42",
    label: "Studio Mac",
    baseUrl: "https://studio.tailnet.ts.net",
    status: "reachable",
    accessTokenExpiresAt: "2026-12-01T12:00:00.000Z",
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-07T12:00:00.000Z",
    health: {
      lastCheckedAt: "2026-08-08T12:00:00.000Z",
      lastReachableAt: "2026-08-08T12:00:00.000Z",
      lastError: null,
      snapshot: { line1: "3 projects", line2: "8 threads" },
    },
  };
  const c = controller([environment]);
  renderPage(c);

  for (const label of ["Last checked", "Last reachable", "Credential", "Projection", "Projects", "Sessions"]) {
    expect(screen.getByText(label)).toBeVisible();
  }
  expect(screen.getByText("3 projects")).toBeVisible();
  expect(screen.getByRole("button", { name: "Load snapshot" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Check" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Edit Studio Mac" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Archive Studio Mac" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Delete Studio Mac" })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Edit Studio Mac" }));
  expect(screen.getByRole("dialog", { name: "Studio Mac" })).toBeVisible();
  expect(screen.getByRole("radio", { name: /Tailscale/u })).toBeChecked();
  fireEvent.change(screen.getByLabelText("Environment label"), { target: { value: "Editing Mac" } });
  fireEvent.change(screen.getByLabelText("T3 base URL"), { target: { value: "https://editing.tailnet.ts.net" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/t3/environments/env_42", {
    method: "PUT",
    body: {
      label: "Editing Mac",
      baseUrl: "https://editing.tailnet.ts.net",
    },
  }));
  expect(c.refreshAll).toHaveBeenCalled();
});

test("labels cached connector projections as stale and keeps each health layer visible", () => {
  const environment: Environment = {
    id: "env_connector",
    label: "Sleeping Mac",
    baseUrl: null,
    transportMode: "connector",
    connectorId: "con_sleeping",
    freshness: "stale",
    lastConnectorSeenAt: "2026-08-27T12:00:00.000Z",
    providerCatalogue: { instances: [{ instanceId: "codex", status: "ready", models: [{ slug: "gpt-5" }] }] },
  };
  const c = controller([environment]);
  Object.assign(c, {
    connectors: [{
      id: "con_sleeping",
      environmentId: environment.id,
      label: "Sleeping Mac",
      status: "offline",
      lastSeenAt: "2026-08-27T12:00:00.000Z",
      lastT3Health: "ready",
    }],
  });
  renderPage(c);

  expect(screen.getByText("connector offline")).toBeVisible();
  expect(screen.getByText("Cached projection")).toBeVisible();
  for (const layer of ["Cloud", "Connector", "T3", "Provider", "Proof"]) {
    expect(screen.getByText(layer)).toBeVisible();
  }
});

test("lists controller gateways, marks the active endpoint, and names its devices", () => {
  const environment: Environment = {
    id: "env_gateway",
    label: "Studio Mac",
    baseUrl: "https://studio.tailnet.ts.net",
    status: "reachable",
  };
  const c = controller([environment]);
  Object.assign(c, {
    devices: [
      {
        id: "dev_desk",
        label: "Desk Controller",
        profile: "next-coder",
        presence: { online: true, state: "online" },
        gatewaySelection: {
          revision: 3,
          state: "stable",
          activeProfileId: "gateway_tailnet",
        },
        config: {
          environmentId: environment.id,
          gatewayAccessMode: "tailscale",
          gatewayUrl: "https://gateway.tailnet.ts.net",
        },
      },
    ],
    gatewayProfiles: [
      {
        id: "gateway_lan",
        label: "Studio LAN",
        mode: "lan",
        baseUrl: "http://192.168.1.25:3996",
      },
      {
        id: "gateway_tailnet",
        label: "Private Tailnet",
        mode: "tailnet",
        baseUrl: "https://gateway.tailnet.ts.net",
      },
    ],
    remoteAccess: {
      checkedAt: "2026-08-08T18:00:00.000Z",
      gateway: {
        host: "0.0.0.0",
        port: 3996,
        loopbackUrl: "http://127.0.0.1:3996",
        lanUrls: ["http://192.168.1.25:3996"],
        publicBaseUrl: null,
      },
      tailscale: {
        installed: true,
        connected: true,
        backendState: "Running",
        dnsName: "gateway.tailnet.ts.net",
        ips: ["100.64.0.4"],
        httpsUrl: "https://gateway.tailnet.ts.net",
        serve: { active: true, statusAvailable: true },
        funnel: { active: false, statusAvailable: true },
        mode: "serve",
        publicBaseUrlConfigured: true,
        ready: true,
        error: null,
        nextStep: "ready",
      },
    },
  });
  renderPage(c);

  expect(screen.getByText("Controller gateways")).toBeVisible();
  expect(screen.getByText("1 active")).toBeVisible();
  expect(screen.getByText("Desk Controller")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Edit Studio Mac" }));
  const dialog = screen.getByRole("dialog", { name: "Studio Mac" });
  fireEvent.click(within(dialog).getByRole("button", { name: "gateways" }));

  expect(within(dialog).getByText("https://gateway.tailnet.ts.net")).toBeVisible();
  expect(within(dialog).getAllByText("Who is using it")).toHaveLength(2);
  expect(within(dialog).getByText("Desk Controller")).toBeVisible();
  expect(within(dialog).getByText("online")).toBeVisible();
});

test("archives an environment only after showing what will be disconnected", async () => {
  const environment: Environment = {
    id: "env_42",
    label: "Studio Mac",
    baseUrl: "https://studio.tailnet.ts.net",
    status: "reachable",
  };
  const c = controller([environment]);
  Object.assign(c, {
    api: vi.fn(async (path: string) => {
      if (path.endsWith("/dependencies")) {
        return {
          environmentId: "env_42",
          dependencies: {
            devices: [{ id: "dev_desk", label: "Desk Controller" }],
            actions: [{ id: "action_ship", label: "Ship it" }],
            macros: [],
            onboarding: true,
          },
          counts: { devices: 1, actions: 1, macros: 0, onboarding: 1 },
        };
      }
      return { environment };
    }),
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Archive Studio Mac" }));

  const confirmation = await screen.findByRole("alertdialog");
  expect(within(confirmation).getByText("Archive Studio Mac?")).toBeVisible();
  expect(within(confirmation).getByText(/1 device default, 1 saved action and your onboarding selection/u)).toBeVisible();
  expect(within(confirmation).getByText(/disabled until you re-save them/u)).toBeVisible();

  fireEvent.click(within(confirmation).getByRole("button", { name: "Archive environment" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/t3/environments/env_42/archive", {
    method: "POST",
    body: {},
  }));
  expect(c.run).toHaveBeenCalledWith("archive-environment", "Environment archived and disconnected.", expect.any(Function));
});

test("dependency-heavy removal requires the exact current label before the request can run", async () => {
  const environment: Environment = { id: "env_42", label: "Studio Mac", baseUrl: null, status: "reachable" };
  const c = controller([environment]);
  Object.assign(c, {
    api: vi.fn(async (path: string) => path.endsWith("/dependencies")
      ? {
          environmentId: environment.id,
          dependencies: { devices: [{ id: "dev_1", label: "Desk" }], actions: [], macros: [], onboarding: false },
          counts: { devices: 1, actions: 0, macros: 0, onboarding: 0 },
        }
      : { environment }),
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Delete Studio Mac" }));
  const confirmation = await screen.findByRole("alertdialog");
  const removeButton = within(confirmation).getByRole("button", { name: "Remove environment" });
  expect(removeButton).toBeDisabled();
  fireEvent.change(within(confirmation).getByLabelText("Confirmation label"), { target: { value: "Studio mac" } });
  expect(removeButton).toBeDisabled();
  fireEvent.change(within(confirmation).getByLabelText("Confirmation label"), { target: { value: "Studio Mac" } });
  fireEvent.click(removeButton);

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/t3/environments/env_42", {
    method: "DELETE",
    body: { confirmationLabel: "Studio Mac" },
  }));
});

test("shows removed environments separately and restores them during retention", async () => {
  const archived: Environment = {
    id: "env_archived",
    label: "Old Studio",
    baseUrl: "https://old-studio.example",
    status: "archived",
    archivedAt: "2026-08-20T12:00:00.000Z",
  };
  const c = controller();
  Object.assign(c, { archivedEnvironments: [archived] });
  renderPage(c);

  expect(screen.getByRole("heading", { name: "Archived environments" })).toBeVisible();
  expect(screen.getByText("Old Studio")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/t3/environments/env_archived/restore", {
    method: "POST",
    body: {},
  }));
  expect(c.run).toHaveBeenCalledWith(
    "restore-environment-env_archived",
    "Environment restored. Re-pair its connector to resume control.",
    expect.any(Function),
  );
});
