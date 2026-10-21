import { describe, expect, it } from "vitest";

import { buildT3SetupCommand, firstIncompleteStep } from "./onboarding";
import type { OnboardingReadiness, OnboardingState } from "./types";

const setup: OnboardingState = {
  version: 2,
  status: "in_progress",
  currentStep: "host",
  networkMode: "tailscale",
  networkUrl: null,
  provider: { harness: "openai", instanceId: "codex", model: "gpt-5.4" },
  workspace: { path: "/work/Next Coder", title: "Next Coder", projectId: null },
  environmentId: null,
  firstThreadId: null,
  device: { mode: null, deviceId: null, credentialConfirmed: false },
  startedAt: null,
  pausedAt: null,
  completedAt: null,
  updatedAt: null,
};

const readiness: OnboardingReadiness = {
  checks: {
    account: true,
    hostPlan: true,
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

describe("onboarding helpers", () => {
  it("builds a shell-safe host setup command", () => {
    expect(buildT3SetupCommand({
      workspacePath: "/work/Next Coder",
      workspaceTitle: "Owner's app",
      harness: "openai",
      instanceId: "codex",
      model: "gpt-5.4",
      networkMode: "tailscale",
    })).toBe(
      "npm run setup:t3 -- --project '/work/Next Coder' --title 'Owner'\"'\"'s app' --provider 'openai' --tunnel 'tailscale' --instance-id 'codex' --model 'gpt-5.4'",
    );
  });

  it("resumes at the first operationally incomplete step", () => {
    expect(firstIncompleteStep(setup, readiness)).toBe("connect");
    expect(firstIncompleteStep(
      { ...setup, status: "not_started" },
      readiness,
    )).toBe("welcome");
  });
});
