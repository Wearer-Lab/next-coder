import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

import type { EnvironmentFailure } from "../types";
import { WorkspaceRecoveryDialog } from "./WorkspaceRecoveryDialog";

function renderDialog(
  failure: EnvironmentFailure | null,
  overrides: Partial<Parameters<typeof WorkspaceRecoveryDialog>[0]> = {},
) {
  const handlers = {
    onClose: vi.fn(),
    onRetry: vi.fn(),
    onOpenEnvironments: vi.fn(),
  };
  render(<WorkspaceRecoveryDialog open failure={failure} {...handlers} {...overrides} />);
  return handlers;
}

test("falls back to the generic restart copy when the gateway classified nothing", () => {
  renderDialog(null);

  expect(screen.getByRole("dialog", { name: /Restart and reconnect T3 Code/u })).toBeVisible();
  expect(screen.getByText("T3 snapshot is unavailable.")).toBeVisible();
  expect(screen.getByText("npm run setup:t3")).toBeVisible();
  expect(screen.getByRole("button", { name: /Connection settings/u })).toBeVisible();
  expect(screen.getByRole("button", { name: /Try again/u })).toHaveFocus();
  expect(screen.getByRole("status")).toHaveTextContent("Operations will reload as soon as T3 Code is available.");
});

test("process_not_running tells the owner to start T3 and keeps watching", () => {
  renderDialog({
    reason: "process_not_running",
    message: "T3 Code is not accepting connections on its saved address.",
    retryable: true,
    baseUrl: "http://127.0.0.1:4000",
  });

  expect(screen.getByRole("dialog", { name: /Start T3 Code on the workspace computer/u })).toBeVisible();
  expect(screen.getByText("T3 Code is not accepting connections on its saved address.")).toBeVisible();
  expect(screen.getByText("npm run setup:t3")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Operations will reload as soon as T3 Code is available.");
});

test("token_expired explains re-pairing and links to the credential settings", () => {
  const handlers = renderDialog({
    reason: "token_expired",
    message: "T3 access token has expired. Re-pair this environment.",
    retryable: false,
    baseUrl: "https://t3.example.test",
  });

  expect(screen.getByRole("dialog", { name: /Re-pair this T3 environment/u })).toBeVisible();
  expect(screen.getByText(/Get a fresh pairing token/u)).toBeVisible();
  expect(screen.getByText("npm run setup:t3")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: /Open credential settings/u }));
  expect(handlers.onOpenEnvironments).toHaveBeenCalledOnce();

  expect(screen.getByRole("status")).toHaveTextContent("Automatic checks are paused");
});

test("authentication_failed says the credential was refused and offers a replacement", () => {
  renderDialog({
    reason: "authentication_failed",
    message: "The T3 host rejected the stored credential.",
    retryable: false,
  });

  expect(screen.getByRole("dialog", { name: /Replace this environment's credential/u })).toBeVisible();
  expect(screen.getByText(/rotated or revoked/u)).toBeVisible();
  expect(screen.getByRole("button", { name: /Open credential settings/u })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Automatic checks are paused");
});

test("network_unreachable shows the saved address and never a credential", () => {
  renderDialog({
    reason: "network_unreachable",
    message: "The T3 host could not be reached over the network.",
    retryable: true,
    baseUrl: "https://workspace.tailnet.test:7000",
  });

  expect(screen.getByRole("dialog", { name: /Check the route to the T3 host/u })).toBeVisible();
  expect(screen.getByText("https://workspace.tailnet.test:7000")).toBeVisible();
  expect(screen.getByText(/tunnel \(Tailscale, ngrok\)/u)).toBeVisible();
  expect(screen.getByRole("dialog").textContent ?? "").not.toMatch(/token|secret/iu);
  expect(screen.getByRole("status")).toHaveTextContent("Operations will reload as soon as T3 Code is available.");
});

test("tls_error points at the certificate and shows the address it dialled", () => {
  renderDialog({
    reason: "tls_error",
    message: "The T3 host presented a TLS certificate that could not be verified.",
    retryable: true,
    baseUrl: "https://t3.local:8443",
  });

  expect(screen.getByRole("dialog", { name: /Fix the T3 host certificate/u })).toBeVisible();
  expect(screen.getByText("https://t3.local:8443")).toBeVisible();
  expect(screen.getByText(/chain is complete and unexpired/u)).toBeVisible();
});

test("contract_incompatible compares installed and supported versions", () => {
  renderDialog({
    reason: "contract_incompatible",
    message: "The T3 host does not expose the orchestration contract this gateway requires.",
    retryable: false,
    installedVersion: "0.0.19",
    minimumVersion: "0.0.24",
    maximumTestedVersion: "0.0.28",
  });

  expect(screen.getByRole("dialog", { name: /Update T3 Code on the workspace computer/u })).toBeVisible();
  expect(screen.getByText("0.0.19")).toBeVisible();
  expect(screen.getByText("0.0.24")).toBeVisible();
  expect(screen.getByText("0.0.28")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Automatic checks are paused");
});

test("contract_incompatible tolerates a host that never reported a version", () => {
  renderDialog({
    reason: "contract_incompatible",
    message: "The T3 host does not expose the orchestration contract this gateway requires.",
    retryable: false,
    installedVersion: null,
    minimumVersion: "0.0.24",
    maximumTestedVersion: "0.0.28",
  });

  expect(screen.getByText("unknown")).toBeVisible();
});

test("connector offline recovery keeps credentials local and uses status plus doctor", () => {
  renderDialog({
    reason: "connector_offline",
    message: "No current connector heartbeat.",
    retryable: true,
  }, {
    environment: { id: "env_1", label: "Studio Mac", baseUrl: null, transportMode: "connector" },
    connector: { id: "con_1", environmentId: "env_1", label: "Studio Mac", status: "offline" },
  });

  expect(screen.getByRole("dialog", { name: /Bring the connector back online/u })).toBeVisible();
  expect(screen.getByText("npx @next-coder/connector status")).toBeVisible();
  expect(screen.getByText("npx @next-coder/connector doctor")).toBeVisible();
  expect(screen.getByText(/without sending T3 or provider credentials/u)).toBeVisible();
});

test("revoked connector requires new enrollment and pauses futile retries", () => {
  const handlers = renderDialog({
    reason: "connector_revoked",
    message: "Connector credential is revoked.",
    retryable: true,
  }, {
    environment: { id: "env_1", label: "Studio Mac", baseUrl: null, transportMode: "connector" },
    connector: { id: "con_1", environmentId: "env_1", label: "Studio Mac", status: "revoked", revokedAt: "2026-08-27T12:00:00Z" },
  });

  expect(screen.getByRole("dialog", { name: /Create a new connector enrollment/u })).toBeVisible();
  expect(screen.getByText(/cannot be displayed or reused/u)).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Automatic checks are paused");
  fireEvent.click(screen.getByRole("button", { name: /Create new enrollment/u }));
  expect(handlers.onOpenEnvironments).toHaveBeenCalledOnce();
});

test("shows the active automatic check and prevents an overlapping manual retry", () => {
  renderDialog(null, { checking: true });

  expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("button", { name: /Try again/u })).toBeDisabled();
});

test("copies a step command and confirms success", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  renderDialog(null);

  fireEvent.click(screen.getByRole("button", { name: "Copy npm run setup:t3" }));

  expect(writeText).toHaveBeenCalledWith("npm run setup:t3");
  expect(await screen.findByRole("button", { name: "npm run setup:t3 copied" })).toHaveTextContent("Copied");
});

test("supports retry, settings, and keyboard dismissal", () => {
  const handlers = renderDialog(null);

  fireEvent.click(screen.getByRole("button", { name: /Try again/u }));
  fireEvent.click(screen.getByRole("button", { name: /Connection settings/u }));
  fireEvent.keyDown(window, { key: "Escape" });

  expect(handlers.onRetry).toHaveBeenCalledOnce();
  expect(handlers.onOpenEnvironments).toHaveBeenCalledOnce();
  expect(handlers.onClose).toHaveBeenCalledOnce();
});
