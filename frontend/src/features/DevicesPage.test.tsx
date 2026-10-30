import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import type { Device, HardwareBoard } from "../types";
import { ConfirmProvider } from "../ui";
import { DevicesPage } from "./DevicesPage";

const BOARDS: HardwareBoard[] = [
  {
    id: "e213-esp32-s3r8",
    label: "CrowPanel 2.13\" e-paper",
    vendor: "Elecrow",
    firmwareEnv: "crowpanel-esp32-213-epaper",
    firmwareDir: "firmware/CrowPanel-ESP32-2.13-E-paper",
    display: { kind: "epaper", width: 122, height: 250, colors: 2 },
    input: { touch: false, keys: 5 },
    audio: { microphone: false, speaker: false },
    camera: false,
    maturity: "complete",
  },
  {
    id: "ips28-esp32-s3r8",
    label: "Hosyond 2.8\" IPS touch",
    vendor: "Hosyond / LCDWIKI",
    firmwareEnv: "hosyond-es3c28p-display",
    firmwareDir: "firmware/Hosyond-ESP32-S3-2.8-Touchscreen",
    display: { kind: "ips", width: 240, height: 320, colors: 65536 },
    input: { touch: true, keys: 1 },
    audio: { microphone: true, speaker: true },
    camera: false,
    maturity: "bring-up",
  },
];

function controller(devices: Device[] = []): Controller {
  const api = vi.fn(async (path: string) => {
    if (path === "/v1/devices") {
      return {
        device: { id: "dev_new", label: "Desk controller", profile: "next-coder" },
        secret: "secret-once",
      };
    }
    return {};
  });
  return {
    devices,
    deviceProfiles: [],
    hardwareBoards: BOARDS,
    defaultHardwareBoard: "e213-esp32-s3r8",
    environments: [{ id: "env_1", label: "Studio Mac" }],
    threads: [],
    selectedEnvironmentId: "env_1",
    selectedThreadId: "thread_1",
    selectedDeviceId: devices[0]?.id ?? "",
    setSelectedDeviceId: vi.fn(),
    deviceSecret: null,
    setDeviceSecret: vi.fn(),
    setNotice: vi.fn(),
    busyAction: null,
    api,
    refreshAll: vi.fn(async () => undefined),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
  } as unknown as Controller;
}

function renderPage(c: Controller) {
  return render(<ConfirmProvider><DevicesPage controller={c} /></ConfirmProvider>);
}

test("offers all three empty-fleet jobs and guides registration through distinct stages", async () => {
  const c = controller();
  renderPage(c);

  expect(screen.getByRole("heading", { name: "How is this controller arriving?" })).toBeVisible();
  expect(screen.getAllByRole("button", { name: /Pre-provision/u }).length).toBeGreaterThan(0);
  expect(screen.getAllByRole("button", { name: /Register/u }).length).toBeGreaterThan(0);
  expect(screen.getAllByRole("button", { name: /Claim/u }).length).toBeGreaterThan(0);

  fireEvent.click(screen.getAllByRole("button", { name: /^Register$/u })[0]);
  expect(screen.getByRole("dialog", { name: "Register a controller" })).toBeVisible();
  expect(screen.getByText("Bring developer hardware online")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  expect(screen.getByLabelText("Device label")).toHaveValue("Desk controller");
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  expect(screen.getByLabelText("Default environment")).toHaveValue("env_1");
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  fireEvent.click(screen.getByRole("button", { name: "Register controller" }));

  await screen.findByText("Identity created");
  expect(c.api).toHaveBeenCalledWith("/v1/devices", {
    method: "POST",
    body: { label: "Desk controller", profile: "next-coder" },
  });
  expect(c.setDeviceSecret).toHaveBeenCalledWith(expect.objectContaining({ secret: "secret-once" }));
});

test("renders health tiles and saves label and runtime configuration from the device modal", async () => {
  const device: Device = {
    id: "dev_42",
    label: "Studio dial",
    profile: "next-coder",
    lastSeenAt: "2026-08-08T12:00:00.000Z",
    presence: { state: "online" },
    status: {
      lastHeartbeatAt: "2026-08-08T12:00:00.000Z",
      uptimeMs: 3_600_000,
      firmwareVersion: "1.4.2",
      hardwareModel: "T190",
      ipAddress: "192.168.1.42",
      batteryPercent: 82,
    },
    config: {
      environmentId: "env_1",
      threadId: "thread_1",
      defaultPrompt: "Review changes",
      shellCommand: "npm test",
      menu: ["status", "prompt"],
    },
  };
  const c = controller([device]);
  renderPage(c);

  for (const label of ["Last seen", "Uptime", "Firmware", "Hardware", "IP address", "Battery"]) {
    expect(screen.getByText(label)).toBeVisible();
  }
  expect(screen.getByText("192.168.1.42")).toBeVisible();
  expect(screen.getByRole("button", { name: "Rotate" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Transfer reset" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Revoke" })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Edit Studio dial" }));
  const dialog = screen.getByRole("dialog", { name: "Studio dial" });
  expect(dialog).toBeVisible();
  expect(dialog.parentElement?.parentElement).toBe(document.body);
  fireEvent.change(screen.getByLabelText("Device label"), { target: { value: "Editing bay" } });
  fireEvent.click(screen.getByRole("tab", { name: "configuration" }));
  fireEvent.change(screen.getByLabelText("Default thread ID"), { target: { value: "thread_2" } });
  fireEvent.click(screen.getByRole("radio", { name: /Tailscale/u }));
  expect(screen.getByText(/ESP32 controllers do not join Tailscale directly/u)).toBeVisible();
  fireEvent.click(screen.getByRole("radio", { name: /Online HTTPS/u }));
  fireEvent.change(screen.getByLabelText("Controller gateway URL"), { target: { value: "https://gateway.example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/devices/dev_42/config", {
    method: "PUT",
    body: expect.objectContaining({
      label: "Editing bay",
      environmentId: "env_1",
      threadId: "thread_2",
      gatewayAccessMode: "online",
      gatewayUrl: "https://gateway.example.com",
    }),
  }));
  expect(c.refreshAll).toHaveBeenCalled();
});

test("orders reusable controls and saves the device layout", async () => {
  const device: Device = {
    id: "dev_controls",
    label: "Workshop controller",
    profile: "next-coder",
    config: { threadId: "thread_1" },
    status: { firmwareVersion: "2.0.0", hardwareModel: "E213", limits: { menuItems: 4, labelCharacters: 14 } },
  };
  const c = controller([device]);
  c.threads.push({ id: "thread_1", label: "Firmware navigation", status: "idle" });
  c.actions = [
    { id: "action_review", label: "Review branch", type: "prompt", intent: { type: "agent_prompt", text: "Review" } },
  ];
  vi.mocked(c.api).mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path.endsWith("/controls") && options?.method === "PUT") {
      return { controls: { revision: 4, acknowledgedRevision: 3, items: [{ kind: "status", label: "Status" }, { kind: "remote_action", actionId: "action_review", label: "Review branch" }] } };
    }
    if (path.endsWith("/controls")) return { controls: { revision: 3, acknowledgedRevision: 3, items: [{ kind: "status", label: "Status" }] } };
    if (path.endsWith("/firmware-policy")) return { policy: { channel: "stable", updateMode: "manual" } };
    return {};
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Edit Workshop controller" }));
  fireEvent.click(screen.getByRole("tab", { name: "controls" }));
  await screen.findByText("Physical controls");
  expect(screen.getByText("3 root items")).toBeVisible();
  expect(screen.getByText("1 thread actions")).toBeVisible();
  expect(screen.getByText("AC//MENU 1/3")).toBeVisible();
  expect(screen.getByRole("button", { name: "Preview Threads, 1" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Preview Gateway, NET" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Preview Firmware, CHECK" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Preview Threads, 1" }));
  expect(screen.getByText("AC//THREADS 1/1")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Preview Firmware navigation, ACTIVE" }));
  expect(screen.getByText("T//ACTIONS 1/2")).toBeVisible();
  expect(screen.getByRole("button", { name: "Preview Status, VIEW" })).toBeVisible();
  fireEvent.change(screen.getByLabelText("Action to add to opened threads"), { target: { value: "action_review" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(screen.getByText("2 thread actions")).toBeVisible();
  expect(screen.getByText("Unsaved")).toBeVisible();
  expect(screen.getByText("T//ACTIONS 1/3")).toBeVisible();
  expect(screen.getByRole("button", { name: "Preview Review branch, CONFIRM" })).toBeVisible();
  expect(screen.getAllByText("Review branch").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Save layout" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/devices/dev_controls/controls", {
    method: "PUT",
    body: { items: expect.arrayContaining([expect.objectContaining({ actionId: "action_review" })]) },
  }));
  expect(await screen.findByText("Waiting for device")).toBeVisible();
});

test("updates firmware channel, update mode, and desired release", async () => {
  const device: Device = {
    id: "dev_firmware",
    label: "Release controller",
    profile: "next-coder",
    status: { firmwareVersion: "1.0.0", hardwareModel: "E213", protocolVersion: 2 },
  };
  const c = controller([device]);
  vi.mocked(c.api).mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    if (path.endsWith("/firmware-policy") && options?.method === "PUT") return { policy: { ...(options.body as object), currentVersion: "1.0.0", latestVersion: "1.2.0", availableVersions: ["1.2.0"] } };
    if (path.endsWith("/firmware-policy")) return {
      policy: { channel: "stable", updateMode: "manual" },
      currentVersion: "1.0.0",
      latestVersion: "1.2.0",
      availableVersions: ["1.2.0"],
      releaseNotes: "Signed stable release.",
    };
    if (path.endsWith("/controls")) return { controls: { revision: 1, items: [] } };
    return {};
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Edit Release controller" }));
  fireEvent.click(screen.getByRole("tab", { name: "firmware" }));
  await screen.findByText("Installed release");
  expect(screen.getByText("Signed stable release.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Queue update" })).toBeEnabled();
  expect(screen.getByText("Queues 1.2.0; the controller installs it on its next firmware check.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Flash a local build/u }));
  expect(screen.getByRole("dialog", { name: "Flash a local build" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Compile the OTA-enabled image" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Add the binary to the stable catalog" })).toBeVisible();
  expect(screen.getByText(/One-time USB bootstrap may be required/u)).toBeVisible();
  expect(screen.getAllByText(/NEXT_CODER_FIRMWARE_VERSION=1.0.1/u)).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Back to firmware" }));
  await screen.findByText("Installed release");
  fireEvent.change(screen.getByLabelText("Release channel"), { target: { value: "beta" } });
  fireEvent.change(screen.getByLabelText("Update mode"), { target: { value: "automatic" } });
  fireEvent.change(screen.getByLabelText("Desired version"), { target: { value: "1.2.0" } });
  fireEvent.click(screen.getByRole("button", { name: "Save policy" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/devices/dev_firmware/firmware-policy", {
    method: "PUT",
    body: { channel: "beta", updateMode: "automatic", desiredVersion: "1.2.0" },
  }));
});

test("the device policy editor lists the always-allow capability on the power-controller profile", () => {
  const device: Device = { id: "dev_policy", label: "Policy bench", profile: "next-coder" };
  renderPage(controller([device]));

  fireEvent.click(screen.getByRole("button", { name: "Edit Policy bench" }));
  fireEvent.click(screen.getByRole("tab", { name: "policy" }));

  expect(screen.getByText(/from now on, not just for one session/)).toBeVisible();
  expect(screen.getByText(/for the whole session/)).toBeVisible();
  expect(screen.queryByText("approval_response_always")).toBeNull();
});

test("treats a never-acknowledged control revision as waiting for the device", async () => {
  const device: Device = { id: "dev_pending", label: "Offline controller", profile: "next-coder" };
  const c = controller([device]);
  vi.mocked(c.api).mockImplementation(async (path: string) => {
    if (path.endsWith("/controls")) return {
      controls: [{ id: "system_status", kind: "status", label: "Status", enabled: true }],
      layout: { revision: 2, appliedRevision: null, items: [{ id: "system_status", kind: "status", label: "Status" }] },
    };
    if (path.endsWith("/firmware-policy")) return { policy: { channel: "stable", updateMode: "manual" } };
    return {};
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Edit Offline controller" }));
  fireEvent.click(screen.getByRole("tab", { name: "controls" }));
  expect(await screen.findByText("Waiting for device")).toBeVisible();
  expect(screen.queryByText("Applied r2")).not.toBeInTheDocument();
});

test("stages a revisioned gateway profile switch and keeps the current route pending acknowledgement", async () => {
  const device: Device = { id: "dev_gateway", label: "Field controller", profile: "next-coder" };
  const c = controller([device]);
  c.gatewayProfiles = [
    { id: "gateway_lan", label: "Studio LAN", mode: "lan", baseUrl: "http://192.168.1.25:3996" },
    { id: "gateway_tailnet", label: "Private Tailnet", mode: "tailnet", baseUrl: "https://gateway.example.ts.net" },
  ];
  vi.mocked(c.api).mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path.endsWith("/gateway") && options?.method === "PUT") return {
      deviceId: "dev_gateway",
      revision: 3,
      state: "pending",
      activeProfile: c.gatewayProfiles[0],
      pendingProfile: c.gatewayProfiles[1],
      requestedAt: "2026-08-08T10:00:00.000Z",
    };
    if (path.endsWith("/gateway")) return { deviceId: "dev_gateway", revision: 2, state: "stable", activeProfile: c.gatewayProfiles[0] };
    if (path.endsWith("/controls")) return { controls: [], layout: { revision: 1, appliedRevision: 1, items: [] } };
    if (path.endsWith("/firmware-policy")) return { policy: { channel: "stable", updateMode: "manual" } };
    return {};
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Edit Field controller" }));
  fireEvent.click(screen.getByRole("tab", { name: "gateway" }));
  await screen.findByText("Controller gateway");
  expect(screen.getByText("Studio LAN")).toBeVisible();
  fireEvent.change(screen.getByLabelText("Requested profile"), { target: { value: "gateway_tailnet" } });
  fireEvent.click(screen.getByRole("button", { name: "Stage switch" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/devices/dev_gateway/gateway", {
    method: "PUT",
    body: { profileId: "gateway_tailnet" },
  }));
  expect(screen.getByText(/Revision 3 is waiting/u)).toBeVisible();
  expect(screen.getByText("Keep current")).toBeVisible();
});

test("surfaces a failed gateway switch and allows rollback to the confirmed profile", async () => {
  const device: Device = { id: "dev_failed_gateway", label: "Remote controller", profile: "next-coder" };
  const c = controller([device]);
  const active = { id: "gateway_lan", label: "Office LAN", mode: "lan" as const, baseUrl: "http://10.0.0.8:3996" };
  const failed = { id: "gateway_custom", label: "External gateway", mode: "custom" as const, baseUrl: "https://gateway.example.com" };
  c.gatewayProfiles = [active, failed];
  vi.mocked(c.api).mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path.endsWith("/gateway/rollback")) return { deviceId: device.id, revision: 5, state: "stable", activeProfile: active };
    if (path.endsWith("/gateway")) return { deviceId: device.id, revision: 5, state: "failed", activeProfile: active, pendingProfile: failed, lastError: "TLS certificate verification failed." };
    if (path.endsWith("/controls")) return { controls: [], layout: { revision: 1, appliedRevision: 1, items: [] } };
    if (path.endsWith("/firmware-policy")) return { policy: { channel: "stable", updateMode: "manual" } };
    return {};
  });
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Edit Remote controller" }));
  fireEvent.click(screen.getByRole("tab", { name: "gateway" }));
  expect(await screen.findByText("TLS certificate verification failed.")).toBeVisible();
  expect(screen.getByText("Controller kept the previous route")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Keep current" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel switch" }));
  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/devices/dev_failed_gateway/gateway/rollback", { method: "POST", body: {} }));
});

function preprovisionController() {
  const c = controller();
  vi.mocked(c.api).mockImplementation(async (path: string, options?: { body?: unknown }) => {
    if (path === "/v1/factory/devices") {
      const body = (options?.body ?? {}) as { hardwareModel?: string };
      const board = BOARDS.find((candidate) => candidate.id === body.hardwareModel) ?? BOARDS[0];
      return {
        device: { id: "dev_factory", label: "Desk controller", profile: "next-coder", hardwareModel: board.id },
        secret: "secret-once",
        claimCode: "ABCDE-23456",
        board,
      };
    }
    return {};
  });
  return c;
}

test("makes the operator choose a board, defaulting to the one proven board", async () => {
  const c = preprovisionController();
  renderPage(c);

  fireEvent.click(screen.getAllByRole("button", { name: /^Pre-provision$/u })[0]);
  const dialog = screen.getByRole("dialog", { name: "Pre-provision hardware" });
  // Purpose -> Board -> Identity -> Review: the board step is inserted second, before identity.
  expect(within(dialog).getByText("Board")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  const crowpanel = screen.getByRole("radio", { name: /CrowPanel/u });
  expect(crowpanel).toBeChecked();
  // The four boards are not interchangeable, so the picker says what each one can actually do.
  expect(screen.getByText("E-paper 122x250, monochrome")).toBeVisible();
  expect(screen.getByText("5 keys, no touch")).toBeVisible();
  expect(screen.getAllByText("No microphone").length).toBeGreaterThan(0);
  expect(screen.getByText("IPS 240x320, 65536 colors")).toBeVisible();
  expect(screen.getByText("Touch + 1 key")).toBeVisible();
  expect(screen.getByText("Microphone")).toBeVisible();
  // Maturity is stated honestly: only the default board has a validated firmware.
  expect(screen.getByText("Proven")).toBeVisible();
  expect(screen.getByText("Bring-up")).toBeVisible();
  expect(screen.getByText(/has not been validated on hardware/u)).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  expect(screen.getByLabelText("Device label")).toHaveValue("Desk controller");
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  fireEvent.click(screen.getByRole("button", { name: "Create factory identity" }));

  await screen.findByText("Identity created");
  expect(c.api).toHaveBeenCalledWith("/v1/factory/devices", {
    method: "POST",
    auth: false,
    body: { label: "Desk controller", profile: "next-coder", hardwareModel: "e213-esp32-s3r8" },
  });
  // A correct seed on the wrong image is still a dead device, so the image is named on completion.
  expect(screen.getAllByText("crowpanel-esp32-213-epaper").length).toBeGreaterThan(0);
  expect(screen.getAllByText("firmware/CrowPanel-ESP32-2.13-E-paper").length).toBeGreaterThan(0);
});

test("stamps the board the operator picked and names its firmware image", async () => {
  const c = preprovisionController();
  renderPage(c);

  fireEvent.click(screen.getAllByRole("button", { name: /^Pre-provision$/u })[0]);
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  fireEvent.click(screen.getByRole("radio", { name: /Hosyond/u }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  fireEvent.click(screen.getByRole("button", { name: /Continue/u }));
  // The review restates the board before the identity is minted.
  expect(screen.getByText("Hosyond 2.8\" IPS touch")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Create factory identity" }));

  await screen.findByText("Identity created");
  expect(c.api).toHaveBeenCalledWith("/v1/factory/devices", {
    method: "POST",
    auth: false,
    body: { label: "Desk controller", profile: "next-coder", hardwareModel: "ips28-esp32-s3r8" },
  });
  expect(screen.getAllByText("hosyond-es3c28p-display").length).toBeGreaterThan(0);
});

test("shows a stamped board on the device tile and editor, and invents nothing when absent", async () => {
  const stamped: Device = {
    id: "dev_stamped",
    label: "Bench controller",
    profile: "next-coder",
    hardwareModel: "ips28-esp32-s3r8",
  };
  const c = controller([stamped]);
  renderPage(c);

  // No heartbeat yet, so the tile falls back to the model the factory stamped.
  expect(screen.getByText("ips28-esp32-s3r8")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Edit Bench controller" }));
  expect(await screen.findByText("Hosyond 2.8\" IPS touch")).toBeVisible();
  expect(screen.getByText("hosyond-es3c28p-display")).toBeVisible();
});

test("leaves the board blank for a device stamped before the catalogue existed", async () => {
  const legacy: Device = { id: "dev_legacy", label: "Legacy controller", profile: "next-coder" };
  const c = controller([legacy]);
  renderPage(c);

  fireEvent.click(screen.getByRole("button", { name: "Edit Legacy controller" }));
  await screen.findByText("Device ID");
  expect(screen.queryByText("Board")).not.toBeInTheDocument();
  expect(screen.queryByText("Firmware image")).not.toBeInTheDocument();
  expect(screen.getAllByText("unknown").length).toBeGreaterThan(0);
});
