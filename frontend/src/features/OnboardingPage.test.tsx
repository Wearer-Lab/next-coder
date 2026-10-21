import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import type { OnboardingReadiness, OnboardingState } from "../types";
import { OnboardingPage } from "./OnboardingPage";

const baseOnboarding: OnboardingState = {
  version: 2,
  status: "in_progress",
  currentStep: "host",
  networkMode: "local",
  networkUrl: null,
  provider: { harness: "auto", instanceId: null, model: null },
  workspace: { path: null, title: null, projectId: null },
  environmentId: null,
  firstThreadId: null,
  device: { mode: null, deviceId: null, credentialConfirmed: false },
  startedAt: "2026-07-24T10:00:00.000Z",
  pausedAt: null,
  completedAt: null,
  updatedAt: "2026-07-24T10:00:00.000Z",
};

const baseReadiness: OnboardingReadiness = {
  checks: {
    account: true,
    hostPlan: false,
    environmentPaired: false,
    environmentReachable: false,
    workspaceSelected: false,
    providerConfigured: false,
    firstRunCompleted: false,
    deviceReady: false,
  },
  ready: false,
  environment: null,
  device: null,
};

function controller(overrides: Record<string, unknown> = {}) {
  const saveOnboarding = vi.fn(async () => ({
    onboarding: baseOnboarding,
    readiness: baseReadiness,
  }));
  return {
    authenticated: true,
    onboardingLoaded: true,
    onboarding: baseOnboarding,
    onboardingReadiness: baseReadiness,
    environments: [],
    connectors: [],
    connection: "connected",
    projects: [],
    devices: [],
    deviceProfiles: [{ id: "next-coder", label: "Next Coder" }],
    deviceSecret: null,
    busyAction: null,
    clerk: { userLabel: "person@example.test" },
    setNotice: vi.fn(),
    setDeviceSecret: vi.fn(),
    setSelectedEnvironmentId: vi.fn(),
    setSelectedProjectId: vi.fn(),
    setSelectedThreadId: vi.fn(),
    api: vi.fn(),
    refreshAll: vi.fn(),
    refreshCommands: vi.fn(),
    loadSnapshot: vi.fn(),
    saveOnboarding,
    remoteAccess: null,
    loadRemoteAccess: vi.fn(),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
    ...overrides,
  } as unknown as Controller;
}

test("keeps host validation errors inline and does not discard the current step", async () => {
  const c = controller();
  render(<OnboardingPage controller={c} onNavigate={vi.fn()} />);

  const continueButton = await screen.findByRole("button", { name: /ready to connect/i });
  fireEvent.click(continueButton);

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Enter the workspace path on the T3 host.",
  );
  expect(c.saveOnboarding).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "T3 host" })).toBeVisible();
});

test("uses computer-first connector choices without asking for a network tunnel", async () => {
  const c = controller();
  render(<OnboardingPage controller={c} onNavigate={vi.fn()} />);

  expect(await screen.findByRole("button", { name: /Connect this computer/i })).toBeVisible();
  expect(screen.getByRole("button", { name: /Connect another computer/i })).toBeVisible();
  expect(screen.getByText(/do not need an inbound port, Tailnet, tunnel, or public T3 URL/i)).toBeVisible();
  expect(screen.queryByLabelText(/Public T3 URL/i)).toBeNull();
});

test("does not send cloud users back to a nonexistent Next Coder host for tunnel setup", async () => {
  const onboarding: OnboardingState = {
    ...baseOnboarding,
    currentStep: "ready",
    environmentId: "env_1",
    firstThreadId: "thread_1",
    workspace: { path: "/work/app", title: "App", projectId: "project_1" },
    provider: { harness: "codex", instanceId: "codex", model: "gpt-5" },
    device: { mode: "browser_only", deviceId: null, credentialConfirmed: false },
  };
  const readiness: OnboardingReadiness = {
    checks: {
      account: true,
      hostPlan: true,
      environmentPaired: true,
      environmentReachable: true,
      workspaceSelected: true,
      providerConfigured: true,
      firstRunCompleted: true,
      deviceReady: true,
    },
    ready: true,
    environment: { id: "env_1", label: "Studio Mac", baseUrl: null },
    device: null,
  };
  const c = controller({
    onboarding,
    onboardingReadiness: readiness,
    authConfig: { deploymentMode: "cloud", clerk: { enabled: true } },
  });

  render(<OnboardingPage controller={c} onNavigate={vi.fn()} />);

  expect(await screen.findByText("Everything is connected")).toBeVisible();
  expect(screen.getByText("A matching agent reply completed the first command in the selected workspace with the selected model.")).toBeVisible();
  expect(screen.queryByText(/first agent command was accepted by T3/u)).toBeNull();
  expect(screen.queryByText("Optional remote console")).toBeNull();
  expect(screen.queryByText("Finish tunnel setup on this machine")).toBeNull();
  expect(screen.queryByText("Run on the Next Coder host")).toBeNull();
});

test("recovers a pending one-time device registration without silently duplicating it", async () => {
  const pendingRegistration: OnboardingState = {
    ...baseOnboarding,
    currentStep: "device",
    networkMode: "local",
    networkUrl: "http://127.0.0.1:3773",
    provider: { harness: "openai", instanceId: "codex", model: "gpt-5.4" },
    workspace: {
      path: "/work/next-coder",
      title: "Next Coder",
      projectId: "project_1",
    },
    environmentId: "env_1",
    firstThreadId: "thread_1",
    device: {
      mode: "register",
      deviceId: "device_1",
      credentialConfirmed: false,
    },
  };
  const readiness: OnboardingReadiness = {
    ...baseReadiness,
    checks: {
      account: true,
      hostPlan: true,
      environmentPaired: true,
      environmentReachable: true,
      workspaceSelected: true,
      providerConfigured: true,
      firstRunCompleted: true,
      deviceReady: false,
    },
  };
  const saveOnboarding = vi.fn(async (input: Partial<OnboardingState>) => ({
    onboarding: {
      ...pendingRegistration,
      ...input,
      device: input.device ?? pendingRegistration.device,
    },
    readiness: { ...readiness, checks: { ...readiness.checks, deviceReady: true }, ready: true },
  }));
  const c = controller({
    onboarding: pendingRegistration,
    onboardingReadiness: readiness,
    devices: [{
      id: "device_1",
      label: "Desk controller",
      profile: "next-coder",
      config: { environmentId: "env_1", threadId: "thread_1" },
    }],
    saveOnboarding,
  });

  render(<OnboardingPage controller={c} onNavigate={vi.fn()} />);

  expect(await screen.findByText("One-time credential is no longer visible")).toBeVisible();
  const continueButton = screen.getByRole("button", { name: /copied it/i });
  expect(continueButton).toBeDisabled();

  fireEvent.click(screen.getByRole("checkbox", { name: /saved the credential/i }));
  expect(continueButton).toBeEnabled();
  fireEvent.click(continueButton);

  await waitFor(() => expect(saveOnboarding).toHaveBeenCalledWith(expect.objectContaining({
    currentStep: "ready",
    device: {
      mode: "register",
      deviceId: "device_1",
      credentialConfirmed: true,
    },
  })));
});
