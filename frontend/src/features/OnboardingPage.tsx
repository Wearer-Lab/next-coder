import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Circle,
  Clipboard,
  CloudCog,
  Code2,
  KeyRound,
  Laptop,
  Monitor,
  Network,
  PackagePlus,
  Play,
  Radio,
  Rocket,
  Server,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { Controller } from "../controller";
import { connectorForEnvironment } from "../connectorHealth";
import { buildGatewayTunnelSetupCommand, type RemoteAccessMode } from "../remoteAccess";
import {
  firstIncompleteStep,
  harnessOptions,
  onboardingSteps,
} from "../onboarding";
import type {
  Device,
  Environment,
  OnboardingDeviceMode,
  OnboardingNetworkMode,
  OnboardingStep,
  PageId,
  T3Project,
} from "../types";
import {
  Button,
  EmptyState,
  Field,
  Metric,
  Panel,
  StatusBadge,
  cn,
} from "../ui";
import {
  RemoteAccessReadiness,
  remoteAccessReady,
} from "./RemoteAccessReadiness";
import { ConnectEnvironmentDialog, EnvironmentHealthStack } from "./EnvironmentsPage";
// The wizard's half of the "intelligence design" system: the black canvas,
// hairline glass cards, the pixel display face and the glowing white pill.
import "./intelligence-onboarding.css";

interface OnboardingPageProps {
  controller: Controller;
  onNavigate: (page: PageId) => void;
}

export function OnboardingPage({ controller: c, onNavigate }: OnboardingPageProps) {
  const [activeStep, setActiveStep] = useState<OnboardingStep>("welcome");
  const [harness, setHarness] = useState("auto");
  const [instanceId, setInstanceId] = useState("");
  const [model, setModel] = useState("");
  const [networkMode, setNetworkMode] = useState<OnboardingNetworkMode>("local");
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceTitle, setWorkspaceTitle] = useState("");
  const [connectionMode, setConnectionMode] = useState<"new" | "existing">("new");
  const [environmentId, setEnvironmentId] = useState("");
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [firstPrompt, setFirstPrompt] = useState(
    "Confirm this workspace is ready, identify the project, and report the current branch.",
  );
  const [deviceMode, setDeviceMode] = useState<OnboardingDeviceMode>("browser_only");
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("Desk controller");
  const [deviceProfile, setDeviceProfile] = useState("next-coder");
  const [claimCode, setClaimCode] = useState("");
  const [registeredDeviceId, setRegisteredDeviceId] = useState("");
  const [deviceCredentialCopied, setDeviceCredentialCopied] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  const snapshotRequestedRef = useRef("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!c.onboarding || hydratedRef.current) return;
    hydratedRef.current = true;
    const resumeStep = c.onboarding.status === "completed"
      ? "ready"
      : firstIncompleteStep(c.onboarding, c.onboardingReadiness);
    setActiveStep(resumeStep);
    setHarness(c.onboarding.provider.harness ?? "auto");
    setInstanceId(c.onboarding.provider.instanceId ?? "");
    setModel(c.onboarding.provider.model ?? "");
    setNetworkMode(c.onboarding.networkMode ?? "local");
    setWorkspacePath(c.onboarding.workspace.path ?? "");
    setWorkspaceTitle(c.onboarding.workspace.title ?? "");
    setProjectId(c.onboarding.workspace.projectId ?? "");
    setEnvironmentId(c.onboarding.environmentId ?? c.environments[0]?.id ?? "");
    setConnectionMode(c.onboarding.environmentId || c.environments.length ? "existing" : "new");
    setDeviceMode(c.onboarding.device.mode ?? (c.devices.length ? "existing" : "browser_only"));
    setSelectedDeviceId(c.onboarding.device.deviceId ?? c.devices[0]?.id ?? "");
    setRegisteredDeviceId(
      c.onboarding.device.mode === "register" ? c.onboarding.device.deviceId ?? "" : "",
    );
    setDeviceCredentialCopied(c.onboarding.device.credentialConfirmed);
  }, [c.devices, c.environments, c.onboarding, c.onboardingReadiness]);

  useEffect(() => {
    if (activeStep !== "workspace" || !c.onboarding?.environmentId || c.projects.length) return;
    if (snapshotRequestedRef.current === c.onboarding.environmentId) return;
    snapshotRequestedRef.current = c.onboarding.environmentId;
    c.setSelectedEnvironmentId(c.onboarding.environmentId);
    void c.loadSnapshot(c.onboarding.environmentId).catch(() => {
      snapshotRequestedRef.current = "";
    });
  }, [activeStep, c]);

  useEffect(() => {
    if (!c.projects.length) return;
    const selected = c.projects.find((project) => project.id === projectId) ?? c.projects[0];
    if (!projectId) setProjectId(selected.id);
    if ((!instanceId || !model) && selected.defaultModelSelection) {
      setInstanceId(selected.defaultModelSelection.instanceId);
      setModel(selected.defaultModelSelection.model);
    }
  }, [c.projects, instanceId, model, projectId]);

  const stepIndex = onboardingSteps.findIndex((step) => step.id === activeStep);
  const resumeStep = c.onboarding
    ? firstIncompleteStep(c.onboarding, c.onboardingReadiness)
    : "welcome";
  const resumeStepIndex = onboardingSteps.findIndex((step) => step.id === resumeStep);
  const persistedStepIndex = onboardingSteps.findIndex(
    (step) => step.id === c.onboarding?.currentStep,
  );
  const unlockedStepIndex = c.onboarding?.status === "completed"
    ? onboardingSteps.length - 1
    : Math.max(0, resumeStepIndex, persistedStepIndex);
  const progress = Math.max(
    0,
    Math.round((resumeStepIndex / (onboardingSteps.length - 1)) * 100),
  );
  const selectedProject = c.projects.find((project) => project.id === projectId) ?? null;
  const selectedHarness = harnessOptions.find((option) => option.id === harness) ?? harnessOptions[0];
  const registeredSecretAvailable = Boolean(
    registeredDeviceId
    && c.deviceSecret?.id === registeredDeviceId
    && c.deviceSecret.secret,
  );
  const gatewayRemoteMode: RemoteAccessMode = c.remoteAccess?.tailscale.mode ?? "serve";
  const gatewayRemoteReady = remoteAccessReady(c.remoteAccess, gatewayRemoteMode);
  const gatewayTunnelCommand = buildGatewayTunnelSetupCommand(gatewayRemoteMode);
  const reportStepError = (message: string) => {
    setStepError(message);
    c.setNotice({ tone: "danger", message });
  };

  const withStepError = async <T,>(task: () => Promise<T>) => {
    setStepError(null);
    try {
      return await task();
    } catch (error) {
      setStepError(error instanceof Error ? error.message : "Setup could not continue.");
      throw error;
    }
  };

  const moveTo = (step: OnboardingStep) => {
    setStepError(null);
    setActiveStep(step);
    window.requestAnimationFrame(() => headingRef.current?.focus());
  };

  const saveAndMove = async (
    step: OnboardingStep,
    input: Parameters<Controller["saveOnboarding"]>[0],
    successMessage: string,
  ) => {
    const result = await c.run(`onboarding-${step}`, successMessage, () => withStepError(
      () => c.saveOnboarding({
        ...input,
        status: "in_progress",
        currentStep: step,
      }),
    ));
    if (result) moveTo(step);
    return result;
  };

  const startSetup = async () => {
    await saveAndMove("host", {}, "Setup started.");
  };

  const saveHostPlan = async () => {
    if (!workspacePath.trim()) {
      reportStepError("Enter the workspace path on the T3 host.");
      return;
    }
    if (harness === "custom" && (!instanceId.trim() || !model.trim())) {
      reportStepError("Enter the custom provider instance and model.");
      return;
    }
    await saveAndMove("connect", {
      networkMode,
      networkUrl: null,
      provider: {
        harness,
        instanceId: instanceId.trim() || null,
        model: model.trim() || null,
      },
      workspace: {
        path: workspacePath.trim(),
        title: workspaceTitle.trim() || workspaceName(workspacePath),
        projectId: c.onboarding?.workspace.projectId ?? null,
      },
    }, "T3 host plan saved.");
  };

  const connectEnvironment = async () => {
    if (connectionMode === "new") {
      setConnectDialogOpen(true);
      return;
    }
    if (!environmentId) {
      reportStepError("Select an existing T3 environment.");
      return;
    }
    const result = await c.run("onboarding-connect", "T3 Code is reachable.", () => withStepError(
      async () => {
        const nextEnvironmentId = environmentId;

        const checked = await c.api<{ environment: Environment }>(
          `/v1/t3/environments/${encodeURIComponent(nextEnvironmentId)}/check`,
          { method: "POST", body: {} },
        );
        if (checked.environment.status !== "reachable") {
          throw new Error(
            checked.environment.health?.lastError
              ?? "T3 Code is not reachable from this gateway.",
          );
        }
        c.setSelectedEnvironmentId(nextEnvironmentId);
        const snapshot = await c.loadSnapshot(nextEnvironmentId);
        await c.refreshAll();
        const firstProject = snapshot.snapshot?.projects?.find(
          (project): project is Record<string, unknown> => typeof project?.id === "string",
        );
        await c.saveOnboarding({
          status: "in_progress",
          currentStep: "workspace",
          networkUrl: checked.environment.baseUrl ?? null,
          environmentId: nextEnvironmentId,
          workspace: {
            path: c.onboarding?.workspace.path ?? workspacePath.trim(),
            title: c.onboarding?.workspace.title ?? workspaceTitle.trim(),
            projectId: typeof firstProject?.id === "string" ? firstProject.id : null,
          },
        });
        return { checked, snapshot };
      },
    ));
    if (result) moveTo("workspace");
  };

  const loadWorkspace = async () => {
    const activeEnvironmentId = c.onboarding?.environmentId ?? environmentId;
    if (!activeEnvironmentId) {
      reportStepError("Connect a T3 environment before refreshing projects.");
      return;
    }
    await c.run(
      "onboarding-snapshot",
      "T3 workspace refreshed.",
      () => withStepError(() => c.loadSnapshot(activeEnvironmentId)),
    );
  };

  const selectProject = (nextProjectId: string) => {
    setProjectId(nextProjectId);
    const project = c.projects.find((candidate) => candidate.id === nextProjectId);
    if (project?.defaultModelSelection && (harness === "auto" || !instanceId || !model)) {
      setInstanceId(project.defaultModelSelection.instanceId);
      setModel(project.defaultModelSelection.model);
    }
  };

  const launchFirstRun = async () => {
    const activeEnvironmentId = c.onboarding?.environmentId ?? environmentId;
    if (!activeEnvironmentId || !projectId) {
      reportStepError("Select a T3 project first.");
      return;
    }
    if (!instanceId.trim() || !model.trim()) {
      reportStepError("Select a provider instance and model.");
      return;
    }
    const result = await c.run("onboarding-first-run", "First T3 thread dispatched.", () => withStepError(
      async () => {
        const launched = await c.api<{ threadId: string }>(
          `/v1/t3/environments/${encodeURIComponent(activeEnvironmentId)}/threads`,
          {
            method: "POST",
            body: {
              projectId,
              text: firstPrompt.trim() || "Confirm this workspace is ready.",
              modelSelection: {
                instanceId: instanceId.trim(),
                model: model.trim(),
              },
            },
          },
        );
        await c.saveOnboarding({
          status: "in_progress",
          currentStep: "device",
          environmentId: activeEnvironmentId,
          provider: {
            harness,
            instanceId: instanceId.trim(),
            model: model.trim(),
          },
          workspace: {
            path: c.onboarding?.workspace.path ?? workspacePath.trim(),
            title: c.onboarding?.workspace.title ?? workspaceTitle.trim(),
            projectId,
          },
          firstThreadId: launched.threadId,
        });
        await c.loadSnapshot(activeEnvironmentId);
        c.setSelectedProjectId(projectId);
        c.setSelectedThreadId(launched.threadId);
        await c.refreshCommands();
        return launched;
      },
    ));
    if (result) moveTo("device");
  };

  const configureDevice = async (deviceId: string) => {
    await c.api(`/v1/devices/${encodeURIComponent(deviceId)}/config`, {
      method: "PUT",
      body: {
        environmentId: c.onboarding?.environmentId,
        threadId: c.onboarding?.firstThreadId,
        defaultPrompt: "Continue the current task, inspect progress, and run relevant tests.",
        shellCommand: "npm test",
        menu: ["status", "prompt", "shell", "macro", "media", "stop"],
      },
    });
  };

  const finishDevice = async () => {
    if (deviceMode === "browser_only") {
      await saveAndMove("ready", {
        device: { mode: "browser_only", deviceId: null, credentialConfirmed: false },
      }, "Browser-only operation selected.");
      return;
    }

    if (deviceMode === "register" && registeredDeviceId) {
      if (!deviceCredentialCopied) {
        reportStepError(
          "Confirm that the one-time device credential is saved before continuing.",
        );
        return;
      }
      await saveAndMove("ready", {
        device: {
          mode: "register",
          deviceId: registeredDeviceId,
          credentialConfirmed: true,
        },
      }, "Controller setup complete.");
      return;
    }

    const result = await c.run(
      "onboarding-device",
      "Controller connected to the first thread.",
      () => withStepError(async () => {
        let device: Device;
        if (deviceMode === "existing") {
          const existing = c.devices.find((candidate) => candidate.id === selectedDeviceId);
          if (!existing) throw new Error("Select an existing controller.");
          device = existing;
        } else if (deviceMode === "claim") {
          if (!claimCode.trim()) {
            throw new Error("Enter the claim code shown on the controller.");
          }
          const claimed = await c.api<{ device: Device }>("/v1/devices/claim", {
            method: "POST",
            body: {
              claimCode: claimCode.trim(),
              label: deviceLabel.trim() || undefined,
            },
          });
          device = claimed.device;
          setClaimCode("");
        } else {
          const registered = await c.api<{ device: Device; secret: string }>("/v1/devices", {
            method: "POST",
            body: {
              label: deviceLabel.trim() || "Controller",
              profile: deviceProfile,
            },
          });
          device = registered.device;
          setRegisteredDeviceId(device.id);
          setDeviceCredentialCopied(false);
          c.setDeviceSecret({
            title: "New device secret",
            id: device.id,
            secret: registered.secret,
          });
        }
        await configureDevice(device.id);
        await c.refreshAll();
        await c.saveOnboarding({
          status: "in_progress",
          currentStep: deviceMode === "register" ? "device" : "ready",
          device: {
            mode: deviceMode,
            deviceId: device.id,
            credentialConfirmed: false,
          },
        });
        return device;
      }),
    );
    if (result && deviceMode !== "register") moveTo("ready");
  };

  const completeSetup = async () => {
    const result = await c.run(
      "onboarding-complete",
      "Next Coder is ready.",
      () => withStepError(() => c.saveOnboarding({
        status: "completed",
        currentStep: "ready",
      })),
    );
    if (!result) return;
    const activeEnvironmentId = result.onboarding.environmentId;
    if (activeEnvironmentId) {
      c.setSelectedEnvironmentId(activeEnvironmentId);
      await c.loadSnapshot(activeEnvironmentId).catch(() => undefined);
      if (result.onboarding.workspace.projectId) c.setSelectedProjectId(result.onboarding.workspace.projectId);
      if (result.onboarding.firstThreadId) c.setSelectedThreadId(result.onboarding.firstThreadId);
    }
    onNavigate("operate");
  };

  const pauseSetup = async () => {
    const result = await c.run(
      "onboarding-pause",
      "Setup paused.",
      () => withStepError(() => c.saveOnboarding({
        status: "paused",
        currentStep: activeStep,
      })),
    );
    if (result) onNavigate("operate");
  };

  if (!c.authenticated) {
    return (
      <div className="onboarding-auth-gate">
        <EmptyState
          icon={ShieldCheck}
          title="Sign in to configure Next Coder"
          description="Setup progress, T3 environments, and controllers are scoped to your Clerk account."
          action={
            <Button variant="primary" onClick={() => c.clerk?.openSignIn()}>
              <KeyRound className="size-4" /> Sign in
            </Button>
          }
        />
      </div>
    );
  }

  if (!c.onboardingLoaded || !c.onboarding) {
    return (
      <div className="onboarding-auth-gate" aria-live="polite">
        <EmptyState icon={CloudCog} title="Loading setup" description="Checking your T3 and controller readiness." />
      </div>
    );
  }

  return (
    <>
    <div className="onboarding-workspace">
      <aside className="onboarding-rail" aria-label="Setup progress">
        <div className="onboarding-rail__intro">
          <p className="ac-eyebrow">Initial setup</p>
          <h2 className="ac-display-title">Get to first run</h2>
          <p>Connect the T3 host, prove the workspace, then choose how you’ll operate it.</p>
        </div>
        <div
          className="onboarding-progress"
          role="progressbar"
          aria-label="Onboarding progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
        <ol className="onboarding-steps">
          {onboardingSteps.map((step, index) => {
            const complete = index < resumeStepIndex || c.onboarding?.status === "completed";
            const active = step.id === activeStep;
            return (
              <li key={step.id}>
                <button
                  type="button"
                  data-active={active || undefined}
                  data-complete={complete || undefined}
                  aria-current={active ? "step" : undefined}
                  disabled={index > unlockedStepIndex}
                  onClick={() => moveTo(step.id)}
                >
                  <span className="onboarding-step__marker">
                    {complete ? <Check className="size-3.5" /> : <span>{index + 1}</span>}
                  </span>
                  <span>
                    <strong>{step.label}</strong>
                    <small>{stepDescription(step.id)}</small>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {c.onboarding.status !== "completed" ? (
          <Button className="mt-auto w-full" size="sm" variant="ghost" onClick={() => void pauseSetup()}>
            Exit for now
          </Button>
        ) : null}
      </aside>

      <section className="onboarding-stage">
        <header className="onboarding-stage__header">
          <div>
            <p className="ac-eyebrow">Step {stepIndex + 1} of {onboardingSteps.length}</p>
            <h1 className="ac-display-title" ref={headingRef} tabIndex={-1}>{onboardingSteps[stepIndex]?.label}</h1>
          </div>
          <StatusBadge
            tone={c.onboardingReadiness?.ready ? "success" : "info"}
            label={c.onboardingReadiness?.ready ? "Ready" : `${progress}% complete`}
          />
        </header>

        <div className={cn("onboarding-stage__body", activeStep === "welcome" && "onboarding-stage__body--center")}>
          {activeStep === "welcome" ? (
            <WelcomeStep
              error={stepError}
              onStart={() => void startSetup()}
              onExit={() => void pauseSetup()}
            />
          ) : null}

          {activeStep === "host" ? (
            <div className="onboarding-step-pane">
              <StepLead
                icon={Laptop}
                title="Plan the T3 host"
                description="Choose the provider, computer, and workspace that T3 Code will use. Authentication stays on the host."
              />

              <div className="onboarding-section">
                <SectionLabel number="01" title="Provider harness" />
                <div className="onboarding-choice-grid">
                  {harnessOptions.map((option) => (
                    <ChoiceCard
                      key={option.id}
                      selected={harness === option.id}
                      title={option.label}
                      description={option.description}
                      icon={Code2}
                      onClick={() => {
                        setHarness(option.id);
                        setInstanceId(option.instanceId);
                        setModel(option.model);
                      }}
                    />
                  ))}
                </div>
                {harness !== "auto" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Provider instance" htmlFor="onboarding-provider-instance">
                      <input
                        id="onboarding-provider-instance"
                        value={instanceId}
                        onChange={(event) => setInstanceId(event.target.value)}
                        placeholder="codex"
                      />
                    </Field>
                    <Field label="Model" htmlFor="onboarding-provider-model">
                      <input
                        id="onboarding-provider-model"
                        value={model}
                        onChange={(event) => setModel(event.target.value)}
                        placeholder="gpt-5.4"
                      />
                    </Field>
                  </div>
                ) : null}
              </div>

              <div className="onboarding-section">
                <SectionLabel number="02" title="Computer" />
                <div className="onboarding-choice-grid">
                  <ChoiceCard
                    selected={networkMode === "local"}
                    title="Connect this computer"
                    description="Run the connector command in a terminal on the computer where this console is open."
                    icon={Monitor}
                    onClick={() => setNetworkMode("local")}
                  />
                  <ChoiceCard
                    selected={networkMode === "lan"}
                    title="Connect another computer"
                    description="Copy the enrollment command to the Mac or Linux computer that runs T3 Code."
                    icon={Laptop}
                    onClick={() => setNetworkMode("lan")}
                  />
                </div>
                <div className="onboarding-note">
                  <ShieldCheck className="size-4" />
                  <span>Both choices use the same outbound connector. You do not need an inbound port, Tailnet, tunnel, or public T3 URL.</span>
                </div>
              </div>

              <div className="onboarding-section">
                <SectionLabel number="03" title="Workspace" />
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.55fr)]">
                  <Field label="Project path on the T3 host" htmlFor="onboarding-workspace-path">
                    <input
                      id="onboarding-workspace-path"
                      className="font-mono"
                      value={workspacePath}
                      onChange={(event) => setWorkspacePath(event.target.value)}
                      placeholder="/Users/you/Projects/app"
                    />
                  </Field>
                  <Field label="Project name" htmlFor="onboarding-workspace-title">
                    <input
                      id="onboarding-workspace-title"
                      value={workspaceTitle}
                      onChange={(event) => setWorkspaceTitle(event.target.value)}
                      placeholder={workspaceName(workspacePath)}
                    />
                  </Field>
                </div>
              </div>

              <StepError message={stepError} />
              <StepActions
                onBack={() => moveTo("welcome")}
                primaryLabel="I’m ready to connect"
                primaryIcon={ArrowRight}
                busy={c.busyAction === "onboarding-connect"}
                onPrimary={() => void saveHostPlan()}
              />
            </div>
          ) : null}

          {activeStep === "connect" ? (
            <div className="onboarding-step-pane">
              <StepLead
                icon={Network}
                title="Connect and verify this computer"
                description="Enroll the outbound connector, then verify each layer from cloud to local T3."
              />

              {c.environments.length ? (
                <div className="intent-switcher self-start" aria-label="Connection source">
                  <button
                    type="button"
                    className="intent-switcher__item"
                    data-active={connectionMode === "existing" || undefined}
                    onClick={() => setConnectionMode("existing")}
                  >
                    Connected computer
                  </button>
                  <button
                    type="button"
                    className="intent-switcher__item"
                    data-active={connectionMode === "new" || undefined}
                    onClick={() => setConnectionMode("new")}
                  >
                    Connect another computer
                  </button>
                </div>
              ) : null}

              {connectionMode === "existing" && c.environments.length ? (
                <>
                  <Field label="T3 computer" htmlFor="onboarding-existing-environment">
                    <select
                      id="onboarding-existing-environment"
                      value={environmentId}
                      onChange={(event) => setEnvironmentId(event.target.value)}
                    >
                      {c.environments.map((environment) => (
                        <option key={environment.id} value={environment.id}>
                          {environment.label} · {(environment.transportMode ?? "direct") === "connector" ? "connector" : "advanced direct"}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {c.environments.find((environment) => environment.id === environmentId) ? (
                    <EnvironmentHealthStack
                      environment={c.environments.find((environment) => environment.id === environmentId) as Environment}
                      connector={connectorForEnvironment(c.connectors, c.environments.find((environment) => environment.id === environmentId))}
                      cloudConnection={c.connection}
                      proofReady={Boolean(c.onboardingReadiness?.checks.firstRunCompleted)}
                    />
                  ) : null}
                </>
              ) : (
                <div className="rounded-lg border border-control bg-surface-inset p-4">
                  <p className="font-display text-base font-semibold">Enroll the T3 computer</p>
                  <p className="mt-1 text-sm text-ink-muted">Next Coder will create a short-lived command and wait for the connector to redeem it.</p>
                  <Button className="mt-3" variant="primary" onClick={() => setConnectDialogOpen(true)}>
                    <Laptop className="size-4" /> {networkMode === "local" ? "Connect this computer" : "Connect another computer"}
                  </Button>
                </div>
              )}

              <div className="onboarding-note">
                <Radio className="size-4" />
                <span>Health stays layered: an online connector does not imply T3, a provider, or the first-run proof is ready.</span>
              </div>

              <StepError message={stepError} />
              <StepActions
                onBack={() => moveTo("host")}
                primaryLabel={connectionMode === "new" ? "Create connect command" : "Verify and continue"}
                primaryIcon={ShieldCheck}
                busy={c.busyAction === "onboarding-connect"}
                onPrimary={() => void connectEnvironment()}
              />
            </div>
          ) : null}

          {activeStep === "workspace" ? (
            <div className="onboarding-step-pane">
              <StepLead
                icon={Rocket}
                title="Launch the first working thread"
                description="This is the readiness proof: T3, the workspace, provider authentication, and model must all work together."
                action={
                  <Button size="sm" onClick={() => void loadWorkspace()} busy={c.busyAction === "onboarding-snapshot"}>
                    Refresh projects
                  </Button>
                }
              />

              {c.projects.length ? (
                <>
                  <Field label="T3 project" htmlFor="onboarding-project">
                    <select
                      id="onboarding-project"
                      value={projectId}
                      onChange={(event) => selectProject(event.target.value)}
                    >
                      {c.projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.title ?? project.name ?? project.workspaceRoot ?? project.id}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <ProjectSummary project={selectedProject} />

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Provider instance" htmlFor="onboarding-launch-instance">
                      <input
                        id="onboarding-launch-instance"
                        value={instanceId}
                        onChange={(event) => setInstanceId(event.target.value)}
                        placeholder="codex"
                      />
                    </Field>
                    <Field label="Model" htmlFor="onboarding-launch-model">
                      <input
                        id="onboarding-launch-model"
                        value={model}
                        onChange={(event) => setModel(event.target.value)}
                        placeholder="gpt-5.4"
                      />
                    </Field>
                  </div>

                  <Field label="First task" htmlFor="onboarding-first-prompt">
                    <textarea
                      id="onboarding-first-prompt"
                      rows={4}
                      value={firstPrompt}
                      onChange={(event) => setFirstPrompt(event.target.value)}
                    />
                  </Field>
                </>
              ) : (
                <Panel className="overflow-hidden">
                  <EmptyState
                    icon={Server}
                    title="No projects returned by T3"
                    description="Add the workspace on the T3 host, then refresh this snapshot."
                    action={<Button onClick={() => moveTo("host")}>Review host command</Button>}
                  />
                </Panel>
              )}

              <StepError message={stepError} />
              <StepActions
                onBack={() => moveTo("connect")}
                primaryLabel="Launch first thread"
                primaryIcon={Play}
                primaryDisabled={!c.projects.length}
                busy={c.busyAction === "onboarding-first-run"}
                onPrimary={() => void launchFirstRun()}
              />
            </div>
          ) : null}

          {activeStep === "device" ? (
            <div className="onboarding-step-pane">
              <StepLead
                icon={Radio}
                title="Choose how you’ll operate"
                description="Connect a controller to the activated environment and thread, or deliberately continue with the browser."
              />

              <div className="onboarding-choice-grid onboarding-choice-grid--four">
                {c.devices.length ? (
                  <ChoiceCard
                    selected={deviceMode === "existing"}
                    title="Existing controller"
                    description="Use a controller already claimed by this account."
                    icon={Radio}
                    onClick={() => setDeviceMode("existing")}
                  />
                ) : null}
                <ChoiceCard
                  selected={deviceMode === "claim"}
                  title="Claim hardware"
                  description="Enter the claim code displayed by a physical controller."
                  icon={KeyRound}
                  onClick={() => setDeviceMode("claim")}
                />
                <ChoiceCard
                  selected={deviceMode === "register"}
                  title="Development device"
                  description="Create a device ID and one-time secret for local hardware."
                  icon={PackagePlus}
                  onClick={() => setDeviceMode("register")}
                />
                <ChoiceCard
                  selected={deviceMode === "browser_only"}
                  title="Browser only"
                  description="Operate T3 from the web app without controller hardware."
                  icon={Monitor}
                  onClick={() => setDeviceMode("browser_only")}
                />
              </div>

              {deviceMode === "existing" ? (
                <Field label="Controller" htmlFor="onboarding-existing-device">
                  <select
                    id="onboarding-existing-device"
                    value={selectedDeviceId}
                    onChange={(event) => setSelectedDeviceId(event.target.value)}
                  >
                    {c.devices.map((device) => (
                      <option key={device.id} value={device.id}>{device.label} · {device.presence?.state ?? "offline"}</option>
                    ))}
                  </select>
                </Field>
              ) : null}

              {deviceMode === "claim" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Claim code" htmlFor="onboarding-claim-code">
                    <input
                      id="onboarding-claim-code"
                      className="font-mono uppercase tracking-[0.12em]"
                      value={claimCode}
                      onChange={(event) => setClaimCode(event.target.value)}
                      placeholder="ABCDE-23456"
                    />
                  </Field>
                  <Field label="Controller label" htmlFor="onboarding-claimed-label">
                    <input
                      id="onboarding-claimed-label"
                      value={deviceLabel}
                      onChange={(event) => setDeviceLabel(event.target.value)}
                    />
                  </Field>
                </div>
              ) : null}

              {deviceMode === "register" ? (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Controller label" htmlFor="onboarding-device-label">
                      <input
                        id="onboarding-device-label"
                        value={deviceLabel}
                        onChange={(event) => setDeviceLabel(event.target.value)}
                      />
                    </Field>
                    <Field label="Policy profile" htmlFor="onboarding-device-profile">
                      <select
                        id="onboarding-device-profile"
                        value={deviceProfile}
                        onChange={(event) => setDeviceProfile(event.target.value)}
                      >
                        {c.deviceProfiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>{profile.label ?? profile.id}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  {registeredSecretAvailable ? (
                    <div className="onboarding-secret">
                      <div>
                        <p className="ac-eyebrow">One-time credential</p>
                        <dl className="grid gap-3 sm:grid-cols-2">
                          <Metric label="Device ID" value={c.deviceSecret?.id} />
                          <Metric label="Secret" value={c.deviceSecret?.secret} />
                        </dl>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => {
                          const value = [c.deviceSecret?.id, c.deviceSecret?.secret].filter(Boolean).join("\n");
                          void navigator.clipboard.writeText(value);
                          setDeviceCredentialCopied(true);
                          c.setNotice({ tone: "success", message: "Device credential copied." });
                        }}
                      >
                        <Clipboard className="size-3.5" /> Copy credential
                      </Button>
                    </div>
                  ) : null}
                  {registeredDeviceId
                    && !registeredSecretAvailable
                    && !deviceCredentialCopied ? (
                      <div className="onboarding-recovery">
                        <div>
                          <strong>One-time credential is no longer visible</strong>
                          <p>
                            If you saved it before reloading, confirm below. Otherwise register a
                            replacement so the controller is not left without credentials.
                          </p>
                        </div>
                        <label>
                          <input
                            type="checkbox"
                            checked={deviceCredentialCopied}
                            onChange={(event) => setDeviceCredentialCopied(event.target.checked)}
                          />
                          I saved the credential
                        </label>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setRegisteredDeviceId("");
                            setDeviceCredentialCopied(false);
                            setStepError(null);
                          }}
                        >
                          Register replacement
                        </Button>
                      </div>
                    ) : null}
                </>
              ) : null}

              {deviceMode === "browser_only" ? (
                <div className="onboarding-note">
                  <Monitor className="size-4" />
                  <span>You can claim a controller later from Devices without repeating T3 setup.</span>
                </div>
              ) : null}

              <StepError message={stepError} />
              <StepActions
                onBack={() => moveTo("workspace")}
                primaryLabel={deviceMode === "register" && registeredDeviceId
                  ? "I copied it — continue"
                  : deviceMode === "browser_only"
                    ? "Continue browser-only"
                    : deviceMode === "register"
                      ? "Register controller"
                      : "Connect controller"}
                primaryIcon={ArrowRight}
                primaryDisabled={
                  deviceMode === "register"
                  && Boolean(registeredDeviceId)
                  && !deviceCredentialCopied
                }
                busy={c.busyAction === "onboarding-device" || c.busyAction === "onboarding-ready"}
                onPrimary={() => void finishDevice()}
              />
            </div>
          ) : null}

          {activeStep === "ready" ? (
            <div className="onboarding-step-pane onboarding-step-pane--ready">
              <StepLead
                icon={Sparkles}
                title={c.onboardingReadiness?.ready ? "Everything is connected" : "A setup item needs attention"}
                description={c.onboardingReadiness?.ready
                  ? "Your first T3 thread produced an agent reply and Next Coder has the context it needs."
                  : "Review the readiness checks below before completing setup."}
              />

              <div className="onboarding-readiness">
                <ReadinessRow label="Clerk account" ready={Boolean(c.onboardingReadiness?.checks.account)} detail={c.clerk?.userLabel ?? "Signed in"} />
                <ReadinessRow
                  label="T3 host plan"
                  ready={Boolean(c.onboardingReadiness?.checks.hostPlan)}
                  detail={[
                    networkLabel(c.onboarding?.networkMode),
                    c.onboarding?.networkUrl ?? c.onboardingReadiness?.environment?.baseUrl,
                  ].filter(Boolean).join(" · ")}
                />
                <ReadinessRow label="Reachable environment" ready={Boolean(c.onboardingReadiness?.checks.environmentReachable)} detail={c.onboardingReadiness?.environment?.label ?? "Not connected"} />
                <ReadinessRow label="Workspace project" ready={Boolean(c.onboardingReadiness?.checks.workspaceSelected)} detail={c.onboarding?.workspace.title ?? c.onboarding?.workspace.projectId ?? "Not selected"} />
                <ReadinessRow label="Provider and model" ready={Boolean(c.onboardingReadiness?.checks.providerConfigured)} detail={[c.onboarding?.provider.instanceId, c.onboarding?.provider.model].filter(Boolean).join(" · ") || "Not configured"} />
                <ReadinessRow label="First agent reply" ready={Boolean(c.onboardingReadiness?.checks.firstRunCompleted)} detail={c.onboarding?.firstThreadId ?? "No completed proof thread"} mono />
                <ReadinessRow label="Operating mode" ready={Boolean(c.onboardingReadiness?.checks.deviceReady)} detail={c.onboarding?.device.mode === "browser_only" ? "Browser only" : c.onboardingReadiness?.device?.label ?? "No controller"} />
              </div>

              {c.authConfig?.deploymentMode !== "cloud" ? <div className="onboarding-section space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="ac-eyebrow">Optional remote console</p>
                    <h2 className="mt-1 font-display text-base font-semibold text-ink">
                      {gatewayRemoteReady ? "Remote access is ready" : "Finish tunnel setup on this machine"}
                    </h2>
                    <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                      This is separate from the T3 environment connection. It controls whether you can open Next Coder from another phone or computer.
                    </p>
                  </div>
                  <StatusBadge
                    tone={gatewayRemoteReady ? "success" : "warning"}
                    label={gatewayRemoteReady ? "Configured" : "Optional setup"}
                  />
                </div>
                <RemoteAccessReadiness
                  status={c.remoteAccess}
                  mode={gatewayRemoteMode}
                  compact
                  refreshing={c.busyAction === "refresh-remote-access"}
                  onRefresh={() => void c.run(
                    "refresh-remote-access",
                    "Remote access status refreshed.",
                    () => c.loadRemoteAccess(true),
                  )}
                />
                {gatewayRemoteReady && c.remoteAccess?.tailscale.httpsUrl ? (
                  <a
                    className="inline-flex min-h-9 items-center justify-center gap-2 self-start rounded-md border border-success/25 bg-success/10 px-3 text-xs font-semibold text-success outline-none hover:bg-success/15 focus-visible:ring-2 focus-visible:ring-focus"
                    href={c.remoteAccess.tailscale.httpsUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open remote console <ArrowRight className="size-3.5" />
                  </a>
                ) : (
                  <div className="onboarding-command">
                    <div>
                      <p className="ac-eyebrow">Run on the Next Coder host</p>
                      <code>{gatewayTunnelCommand}</code>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard.writeText(gatewayTunnelCommand);
                        c.setNotice({ tone: "success", message: "Tunnel setup command copied." });
                      }}
                    >
                      <Clipboard className="size-3.5" /> Copy
                    </Button>
                  </div>
                )}
              </div> : null}

              {c.onboardingReadiness?.ready ? (
                <div className="onboarding-activation">
                  <CheckCircle2 className="size-5" />
                  <div>
                    <strong>Activation proven</strong>
                    <p>A matching agent reply completed the first command in the selected workspace with the selected model.</p>
                  </div>
                </div>
              ) : null}

              <StepError message={stepError} />
              <div className="onboarding-final-actions">
                {!c.onboardingReadiness?.ready ? (
                  <Button
                    onClick={() => moveTo(firstIncompleteStep(c.onboarding!, c.onboardingReadiness))}
                  >
                    Review missing step
                  </Button>
                ) : null}
                <Button
                  className="onboarding-cta"
                  variant="primary"
                  disabled={!c.onboardingReadiness?.ready}
                  busy={c.busyAction === "onboarding-complete"}
                  onClick={() => void completeSetup()}
                >
                  Open Next Coder <ArrowRight className="size-4" />
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
    <ConnectEnvironmentDialog
      controller={c}
      open={connectDialogOpen}
      onClose={() => setConnectDialogOpen(false)}
      onConnected={(environment) => {
        setEnvironmentId(environment.id);
        setConnectionMode("existing");
        setConnectDialogOpen(false);
      }}
    />
    </>
  );
}

function WelcomeStep({
  error,
  onStart,
  onExit,
}: {
  error: string | null;
  onStart: () => void;
  onExit: () => void;
}) {
  return (
    <div className="onboarding-welcome">
      <div className="onboarding-welcome__mark">
        <Rocket className="size-7" />
      </div>
      <p className="ac-eyebrow">Next Coder setup</p>
      <h2 className="ac-display-title">From sign-in to a working agent thread</h2>
      <p className="onboarding-welcome__copy">
        We’ll configure the T3 host, verify its network path, select a workspace and model,
        launch the first thread, and connect a controller if you use one.
      </p>
      <div className="onboarding-outcomes">
        <Outcome icon={Server} title="T3 Code" description="Installed, reachable, and paired" />
        <Outcome icon={Code2} title="LLM" description="Provider and model proven by a real run" />
        <Outcome icon={Radio} title="Controller" description="Claimed, configured, or intentionally skipped" />
      </div>
      <StepError message={error} />
      <div className="flex flex-wrap justify-center gap-2">
        <Button className="onboarding-cta" variant="primary" size="lg" onClick={onStart}>
          Start setup <ArrowRight className="size-4" />
        </Button>
        <Button size="lg" variant="ghost" onClick={onExit}>Exit for now</Button>
      </div>
    </div>
  );
}

function StepError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="onboarding-step-error" role="alert">
      <AlertTriangle className="size-4" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function StepLead({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof Server;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="onboarding-step-lead">
      <div className="onboarding-step-lead__icon"><Icon className="size-5" /></div>
      <div>
        <h2 className="ac-display-title">{title}</h2>
        <p>{description}</p>
      </div>
      {action ? <div className="onboarding-step-lead__action">{action}</div> : null}
    </div>
  );
}

function SectionLabel({ number, title }: { number: string; title: string }) {
  return (
    <div className="onboarding-section-label">
      <span>{number}</span>
      <h3>{title}</h3>
    </div>
  );
}

function ChoiceCard({
  selected,
  title,
  description,
  icon: Icon,
  onClick,
}: {
  selected: boolean;
  title: string;
  description: string;
  icon: typeof Server;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="onboarding-choice"
      data-selected={selected || undefined}
      aria-pressed={selected}
      onClick={onClick}
    >
      <span className="onboarding-choice__icon"><Icon className="size-4" /></span>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className="onboarding-choice__check">
        {selected ? <Check className="size-3" /> : <Circle className="size-3" />}
      </span>
    </button>
  );
}

function StepActions({
  onBack,
  onPrimary,
  primaryLabel,
  primaryIcon: PrimaryIcon,
  primaryDisabled = false,
  busy = false,
}: {
  onBack: () => void;
  onPrimary: () => void;
  primaryLabel: string;
  primaryIcon: typeof ArrowRight;
  primaryDisabled?: boolean;
  busy?: boolean;
}) {
  return (
    <div className="onboarding-step-actions">
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft className="size-4" /> Back
      </Button>
      <Button className="onboarding-cta" variant="primary" disabled={primaryDisabled} busy={busy} onClick={onPrimary}>
        {primaryLabel} <PrimaryIcon className="size-4" />
      </Button>
    </div>
  );
}

function Outcome({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Server;
  title: string;
  description: string;
}) {
  return (
    <div>
      <Icon className="size-4" />
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}

function ProjectSummary({ project }: { project: T3Project | null }) {
  if (!project) return null;
  return (
    <div className="onboarding-project-summary">
      <div>
        <p className="ac-eyebrow">Live workspace</p>
        <strong>{project.title ?? project.name ?? project.id}</strong>
        <code>{project.workspaceRoot ?? project.id}</code>
      </div>
      {project.defaultModelSelection ? (
        <StatusBadge
          tone="info"
          label={`${project.defaultModelSelection.instanceId} · ${project.defaultModelSelection.model}`}
        />
      ) : (
        <StatusBadge label="No project default" />
      )}
    </div>
  );
}

function ReadinessRow({
  label,
  ready,
  detail,
  mono = false,
}: {
  label: string;
  ready: boolean;
  detail: string;
  mono?: boolean;
}) {
  return (
    <div className="onboarding-readiness__row">
      <span className={cn("onboarding-readiness__icon", ready && "onboarding-readiness__icon--ready")}>
        {ready ? <Check className="size-3.5" /> : <Circle className="size-3.5" />}
      </span>
      <strong>{label}</strong>
      <span className={cn("truncate text-ink-muted", mono && "font-mono text-[11px]")}>{detail}</span>
    </div>
  );
}

function workspaceName(path: string) {
  return path.trim().split(/[\\/]/u).filter(Boolean).at(-1) ?? "My project";
}

function networkLabel(mode?: OnboardingNetworkMode | null) {
  if (mode === "local") return "This computer";
  if (mode === "lan") return "Another computer";
  if (mode === "tailscale" || mode === "custom") return "Advanced direct setup";
  return "Not selected";
}

function stepDescription(step: OnboardingStep) {
  switch (step) {
    case "welcome": return "Setup outcome";
    case "host": return "LLM, network, workspace";
    case "connect": return "Pair and verify";
    case "workspace": return "Prove the first thread";
    case "device": return "Controller or browser";
    case "ready": return "Review readiness";
  }
}
