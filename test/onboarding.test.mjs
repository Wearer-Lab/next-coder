import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOnboardingReadiness,
  normalizeOnboarding,
  normalizeStoredOnboarding,
} from "../src/onboarding.mjs";

test("onboarding progress merges nested values and records lifecycle timestamps", () => {
  const started = normalizeOnboarding({
    status: "in_progress",
    currentStep: "host",
    networkMode: "tailscale",
    networkUrl: "https://machine.tailnet.ts.net",
    provider: { harness: "openai", instanceId: "codex", model: "gpt-5.4" },
  }, null, "2026-01-01T00:00:00.000Z");

  const resumed = normalizeOnboarding({
    currentStep: "connect",
    workspace: { path: "/work/next-coder", title: "Next Coder" },
  }, started, "2026-01-01T00:05:00.000Z");

  assert.equal(resumed.startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(resumed.currentStep, "connect");
  assert.equal(resumed.networkMode, "tailscale");
  assert.equal(resumed.networkUrl, "https://machine.tailnet.ts.net");
  assert.equal(resumed.provider.instanceId, "codex");
  assert.equal(resumed.workspace.path, "/work/next-coder");
  assert.equal(resumed.updatedAt, "2026-01-01T00:05:00.000Z");
});

test("onboarding readiness requires operational evidence and accepts browser-only mode", () => {
  const onboarding = normalizeStoredOnboarding({
    status: "in_progress",
    currentStep: "ready",
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
    device: { mode: "browser_only", deviceId: null, credentialConfirmed: false },
  });
  const readiness = buildOnboardingReadiness({
    onboarding,
    environments: [{
      id: "env_1",
      status: "reachable",
      health: { lastReachableAt: "2026-01-01T00:00:00.000Z" },
    }],
    devices: [],
    commands: [{
      id: "cmd_1",
      environmentId: "env_1",
      threadId: "thread_1",
      normalized: {
        type: "thread.launch",
        createThread: { projectId: "project_1" },
        startTurn: {
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        },
      },
      status: "completed",
    }],
  });

  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.checks, {
    account: true,
    hostPlan: true,
    environmentPaired: true,
    environmentReachable: true,
    workspaceSelected: true,
    providerConfigured: true,
    firstRunCompleted: true,
    firstRunDispatched: true,
    deviceReady: true,
  });

  const acceptedButUnanswered = buildOnboardingReadiness({
    onboarding,
    environments: [{
      id: "env_1",
      status: "reachable",
      health: { lastReachableAt: "2026-01-01T00:00:00.000Z" },
    }],
    commands: [{
      ...readiness.firstRunCommand,
      status: "dispatched",
    }],
  });
  assert.equal(acceptedButUnanswered.checks.firstRunCompleted, false);
  assert.equal(acceptedButUnanswered.checks.firstRunDispatched, false);
  assert.equal(acceptedButUnanswered.ready, false);

  const mismatchedActivation = buildOnboardingReadiness({
    onboarding,
    environments: [{
      id: "env_1",
      status: "reachable",
      health: { lastReachableAt: "2026-01-01T00:00:00.000Z" },
    }],
    commands: [{
      id: "cmd_wrong_model",
      environmentId: "env_1",
      threadId: "thread_1",
      normalized: {
        type: "thread.launch",
        createThread: { projectId: "project_1" },
        startTurn: {
          modelSelection: { instanceId: "codex", model: "different-model" },
        },
      },
      status: "completed",
    }],
  });
  assert.equal(mismatchedActivation.checks.firstRunCompleted, false);
  assert.equal(mismatchedActivation.ready, false);
});

test("registered-device readiness requires matching configuration and credential confirmation", () => {
  const onboarding = normalizeStoredOnboarding({
    status: "in_progress",
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
    device: { mode: "register", deviceId: "device_1", credentialConfirmed: false },
  });
  const evidence = {
    onboarding,
    environments: [{
      id: "env_1",
      status: "reachable",
      health: { lastReachableAt: "2026-01-01T00:00:00.000Z" },
    }],
    devices: [{
      id: "device_1",
      revokedAt: null,
      config: { environmentId: "env_1", threadId: "thread_1" },
      presence: { latestActivityAt: "2026-01-01T00:05:00.000Z", online: false },
    }],
    commands: [{
      id: "cmd_1",
      environmentId: "env_1",
      threadId: "thread_1",
      normalized: {
        type: "thread.launch",
        createThread: { projectId: "project_1" },
        startTurn: {
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        },
      },
      status: "dispatched",
    }],
  };
  const confirmed = {
    ...evidence,
    onboarding: {
      ...onboarding,
      device: { ...onboarding.device, credentialConfirmed: true },
    },
  };

  assert.equal(buildOnboardingReadiness(evidence).checks.deviceReady, false);
  assert.equal(buildOnboardingReadiness(confirmed).checks.deviceReady, true);
  assert.equal(buildOnboardingReadiness({
    ...confirmed,
    devices: [{
      id: "device_1",
      revokedAt: null,
      config: { environmentId: "env_other", threadId: "thread_1" },
      presence: { latestActivityAt: "2026-01-01T00:05:00.000Z", online: false },
    }],
  }).checks.deviceReady, false);

  // Break 6: a device row can be created and configured without the hardware ever powering on.
  // Readiness is operational evidence everywhere else and must be here too.
  assert.equal(buildOnboardingReadiness({
    ...confirmed,
    devices: [{
      id: "device_1",
      revokedAt: null,
      config: { environmentId: "env_1", threadId: "thread_1" },
      presence: { latestActivityAt: null, online: false },
    }],
  }).checks.deviceReady, false);

  // ...but a controller that has since been unplugged stays ready. Offline is not "never worked".
  assert.equal(buildOnboardingReadiness({
    ...confirmed,
    devices: [{
      id: "device_1",
      revokedAt: null,
      config: { environmentId: "env_1", threadId: "thread_1" },
      presence: { latestActivityAt: "2020-01-01T00:00:00.000Z", online: false, ageMs: 9e11 },
    }],
  }).checks.deviceReady, true);

  // browser_only carries no hardware to observe and is unaffected.
  assert.equal(buildOnboardingReadiness({
    ...confirmed,
    onboarding: { ...onboarding, device: { mode: "browser_only", deviceId: null, credentialConfirmed: false } },
    devices: [],
  }).checks.deviceReady, true);
});

test("custom network plans remain incomplete until their endpoint is persisted", () => {
  const base = normalizeStoredOnboarding({
    status: "in_progress",
    currentStep: "host",
    networkMode: "custom",
    provider: { harness: "openai", instanceId: "codex", model: "gpt-5.4" },
    workspace: { path: "/work/app", title: "App", projectId: null },
  });

  assert.equal(buildOnboardingReadiness({ onboarding: base }).checks.hostPlan, false);
  assert.equal(buildOnboardingReadiness({
    onboarding: { ...base, networkUrl: "https://t3.example" },
  }).checks.hostPlan, true);
});
