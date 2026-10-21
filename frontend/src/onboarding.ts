import type {
  OnboardingNetworkMode,
  OnboardingReadiness,
  OnboardingState,
  OnboardingStep,
} from "./types";

export interface HarnessOption {
  id: string;
  label: string;
  description: string;
  instanceId: string;
  model: string;
}

export const harnessOptions: HarnessOption[] = [
  {
    id: "auto",
    label: "Use project default",
    description: "Use the provider and model already configured in T3 Code.",
    instanceId: "",
    model: "",
  },
  {
    id: "openai",
    label: "Codex / OpenAI",
    description: "Use the Codex provider harness.",
    instanceId: "codex",
    model: "gpt-5.4",
  },
  {
    id: "anthropic",
    label: "Claude Code",
    description: "Use the Claude Agent provider harness.",
    instanceId: "claudeAgent",
    model: "claude-sonnet-5",
  },
  {
    id: "cursor",
    label: "Cursor",
    description: "Use the Cursor provider configured in T3.",
    instanceId: "cursor",
    model: "auto",
  },
  {
    id: "opencode",
    label: "OpenCode",
    description: "Use the OpenCode provider harness.",
    instanceId: "opencode",
    model: "openai/gpt-5",
  },
  {
    id: "grok",
    label: "Grok",
    description: "Use the Grok build provider.",
    instanceId: "grok",
    model: "grok-build",
  },
  {
    id: "custom",
    label: "Custom provider",
    description: "Enter an existing T3 provider instance and model.",
    instanceId: "",
    model: "",
  },
];

export const networkOptions: Array<{
  id: OnboardingNetworkMode;
  label: string;
  description: string;
}> = [
  {
    id: "local",
    label: "This computer",
    description: "T3 and Next Coder run on the same machine.",
  },
  {
    id: "lan",
    label: "Local network",
    description: "Reach T3 from another device on the same trusted network.",
  },
  {
    id: "tailscale",
    label: "Tailscale Serve",
    description: "Recommended private HTTPS access across your Tailnet.",
  },
  {
    id: "custom",
    label: "Custom URL",
    description: "Use an existing HTTPS tunnel or reverse proxy.",
  },
];

export const onboardingSteps: Array<{
  id: OnboardingStep;
  label: string;
  shortLabel: string;
}> = [
  { id: "welcome", label: "Welcome", shortLabel: "Start" },
  { id: "host", label: "T3 host", shortLabel: "Host" },
  { id: "connect", label: "Connect", shortLabel: "Connect" },
  { id: "workspace", label: "First run", shortLabel: "Run" },
  { id: "device", label: "Controller", shortLabel: "Device" },
  { id: "ready", label: "Ready", shortLabel: "Ready" },
];

export function firstIncompleteStep(
  onboarding: OnboardingState,
  readiness: OnboardingReadiness | null,
): OnboardingStep {
  if (onboarding.status === "not_started") return "welcome";
  if (!readiness?.checks.hostPlan) return "host";
  if (!readiness.checks.environmentReachable) return "connect";
  if (!readiness.checks.firstRunCompleted) return "workspace";
  if (!readiness.checks.deviceReady) return "device";
  return "ready";
}

export function buildT3SetupCommand(input: {
  workspacePath: string;
  workspaceTitle: string;
  harness: string;
  instanceId?: string;
  model?: string;
  networkMode: OnboardingNetworkMode;
  publicUrl?: string;
}) {
  const args = [
    "npm run setup:t3 --",
    "--project",
    shellQuote(input.workspacePath),
    "--title",
    shellQuote(input.workspaceTitle),
    "--provider",
    shellQuote(input.harness),
    "--tunnel",
    shellQuote(input.networkMode),
  ];
  if (input.instanceId) args.push("--instance-id", shellQuote(input.instanceId));
  if (input.model) args.push("--model", shellQuote(input.model));
  if (input.networkMode === "custom" && input.publicUrl) {
    args.push("--public-url", shellQuote(input.publicUrl));
  }
  return args.join(" ");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}
