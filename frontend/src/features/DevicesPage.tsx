import {
  ArrowLeft,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  AlertTriangle,
  Battery,
  Check,
  CheckCircle2,
  CircleOff,
  Clipboard,
  Clock3,
  Cpu,
  Fingerprint,
  Gauge,
  Globe2,
  HardDriveDownload,
  KeyRound,
  Laptop,
  Network,
  Plus,
  Radio,
  RefreshCw,
  RotateCcwKey,
  Save,
  ShieldCheck,
  Smartphone,
  Unplug,
  Undo2,
  Wifi,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import type { Controller } from "../controller";
import {
  buildControllerActionsDisplay,
  buildControllerResponseDisplay,
  buildControllerRootDisplay,
  buildControllerThreadsDisplay,
} from "../deviceDisplayModel";
import { formatMetric, formatRelativeTime, formatUptime } from "../format";
import { buildGatewayTunnelSetupCommand } from "../remoteAccess";
import type {
  Device,
  DeviceConfig,
  DeviceControlItem,
  DeviceControls,
  DeviceFirmwarePolicy,
  DeviceGatewaySwitch,
  DeviceProfile,
  GatewayProfile,
  HardwareBoard,
  SavedAction,
} from "../types";
import {
  Button,
  Field,
  StatusBadge,
  cn,
  type StatusTone,
  useConfirm,
} from "../ui";
import { ProfilePicker } from "./ProfilePicker";
import {
  DeviceActionCluster,
  type DeviceOnboardingFlow,
} from "./FeatureActionClusters";
// The fleet half of the "intelligence design" system: hairline glass cards, the pixel display
// face and the metric strip, scoped to the Devices workspace.
import "./intelligence-fleet.css";

export type { DeviceOnboardingFlow } from "./FeatureActionClusters";
type DeviceGatewayAccessMode = "local" | "tailscale" | "online";

interface DevicesPageProps {
  controller: Controller;
  onboardingFlow?: DeviceOnboardingFlow | null;
  onOnboardingFlowChange?: (flow: DeviceOnboardingFlow | null) => void;
}

interface CredentialResult {
  device: Device;
  secret?: string;
  claimCode?: string;
  /**
   * Returned by POST /v1/factory/devices. A correct NVS seed still produces a dead device when the
   * wrong image is on it, and there is now one firmware image per board — so the completion screen
   * has to name which one.
   */
  board?: HardwareBoard;
}

const FALLBACK_PROFILES: DeviceProfile[] = [
  {
    id: "agent-controller",
    label: "Agent controller",
    description: "Prompts, media, approvals, session control, and policy-screened shell input.",
    capabilities: ["status", "agent_prompt", "media_prompt", "session_control", "approval_response", "shell_input"],
  },
  {
    id: "read-only",
    label: "Read only",
    description: "Status inspection only. Every command intent is blocked.",
    capabilities: ["status"],
  },
  {
    id: "power-controller",
    label: "Power controller",
    description: "High-trust control with policy-screened dangerous shell input, and the only built-in profile that may grant an agent a permission for a whole session.",
    capabilities: ["status", "agent_prompt", "media_prompt", "session_control", "approval_response", "approval_response_persistent", "shell_input"],
  },
];

const FLOW_COPY: Record<DeviceOnboardingFlow, {
  title: string;
  eyebrow: string;
  introTitle: string;
  intro: string;
  accent: string;
  steps: string[];
}> = {
  preprovision: {
    title: "Pre-provision hardware",
    eyebrow: "Factory workflow",
    introTitle: "Create an identity before the device ships",
    intro: "Issue a hardware credential and single-use claim code. The controller stays unowned until its recipient claims it.",
    accent: "Factory identity",
    steps: ["Purpose", "Board", "Identity", "Review"],
  },
  register: {
    title: "Register a controller",
    eyebrow: "Development workflow",
    introTitle: "Bring developer hardware online",
    intro: "Create an owned controller and a one-time secret for a simulator, bench unit, or locally flashed device.",
    accent: "Owned immediately",
    steps: ["Purpose", "Identity", "Defaults", "Review"],
  },
  claim: {
    title: "Claim a controller",
    eyebrow: "Owner workflow",
    introTitle: "Attach physical hardware to this account",
    intro: "Use the code on the controller or its claim card, then choose where its actions should run by default.",
    accent: "Claim code required",
    steps: ["Prepare", "Claim code", "Defaults", "Review"],
  },
};

function deviceStatus(device: Device | null | undefined): { label: string; tone: StatusTone } {
  if (!device) return { label: "offline", tone: "neutral" };
  if (device.revokedAt) return { label: "revoked", tone: "danger" };
  if (device.credentialRotation?.state === "pending") return { label: "rotating", tone: "warning" };
  if (device.credentialRotation?.state === "expired") return { label: "rotation expired", tone: "danger" };
  const state = device.presence?.state
    ?? (device.lastSeenAt && Date.now() - Date.parse(device.lastSeenAt) <= 90_000 ? "online" : "offline");
  return {
    label: state,
    tone: state === "online" ? "success" : state === "stale" ? "warning" : "neutral",
  };
}

function defaultDeviceConfig(device?: Device | null): DeviceConfig {
  const gatewayAccessMode = device?.config?.gatewayAccessMode
    ?? inferDeviceGatewayAccessMode(device?.config?.gatewayUrl ?? "");
  return {
    environmentId: device?.config?.environmentId ?? null,
    threadId: device?.config?.threadId ?? null,
    gatewayAccessMode,
    gatewayUrl: device?.config?.gatewayUrl ?? null,
    defaultPrompt: device?.config?.defaultPrompt ?? "",
    shellCommand: device?.config?.shellCommand ?? "npm test",
    menu: device?.config?.menu ?? ["status", "prompt", "shell", "macro", "thread", "media", "stop"],
  };
}

function inferDeviceGatewayAccessMode(gatewayUrl: string): DeviceGatewayAccessMode {
  try {
    const parsed = new URL(gatewayUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname.endsWith(".ts.net")) return "tailscale";
    if (
      hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname.endsWith(".local")
      || /^10\./u.test(hostname)
      || /^192\.168\./u.test(hostname)
      || /^172\.(1[6-9]|2\d|3[01])\./u.test(hostname)
    ) return "local";
    return parsed.protocol === "https:" ? "online" : "local";
  } catch {
    return "local";
  }
}

function deviceGatewayUrlValid(config: DeviceConfig) {
  const mode = config.gatewayAccessMode ?? "local";
  const value = config.gatewayUrl?.trim() ?? "";
  if (!value) return mode === "local";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return mode === "local" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function DevicesPage({
  controller: c,
  onboardingFlow = null,
  onOnboardingFlowChange,
}: DevicesPageProps) {
  const confirm = useConfirm();
  const [internalFlow, setInternalFlow] = useState<DeviceOnboardingFlow | null>(null);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editProfile, setEditProfile] = useState("agent-controller");
  const [editConfig, setEditConfig] = useState<DeviceConfig>(() => defaultDeviceConfig());
  const profiles = c.deviceProfiles.length ? c.deviceProfiles : FALLBACK_PROFILES;
  const activeFlow = onboardingFlow ?? internalFlow;

  const setFlow = (flow: DeviceOnboardingFlow | null) => {
    if (onOnboardingFlowChange) onOnboardingFlowChange(flow);
    else setInternalFlow(flow);
  };

  const can = (device: Device, action: keyof NonNullable<Device["actions"]>) =>
    device.actions?.[action] ?? true;

  const openDevice = (device: Device) => {
    c.setSelectedDeviceId(device.id);
    setEditLabel(device.label);
    setEditProfile(device.profile);
    setEditConfig(defaultDeviceConfig(device));
    setEditingDevice(device);
  };

  const rotateSecret = async (device: Device) => {
    const restart = device.credentialRotation?.state === "pending"
      || device.credentialRotation?.state === "expired";
    const accepted = await confirm({
      title: `${restart ? "Restart" : "Rotate"} ${device.label}’s secret?`,
      description: "The controller will generate and persist its replacement locally. Its current credential remains valid until the controller proves the replacement and acknowledges promotion.",
      confirmLabel: restart ? "Restart rotation" : "Queue rotation",
    });
    if (!accepted) return;
    await c.run("rotate-device-secret", "Credential rotation queued for controller acknowledgement.", async () => {
      const result = await c.api<{ device: Device; rotation: NonNullable<Device["credentialRotation"]>; created: boolean }>(
        `/v1/devices/${encodeURIComponent(device.id)}/rotate-secret`,
        { method: "POST", body: { restart } },
      );
      await c.refreshAll();
      return result;
    });
  };

  const transferReset = async (device: Device) => {
    const accepted = await confirm({
      title: `Reset ${device.label} for transfer?`,
      description: "Ownership is removed immediately. The controller keeps only a restricted rotation channel until it installs and acknowledges a new local credential, then clears owner Wi-Fi/config and returns to provisioning for the recipient.",
      confirmLabel: "Reset for transfer",
    });
    if (!accepted) return;
    await c.run("transfer-reset-device", "Transfer reset queued; the controller will finish securely when it reconnects.", async () => {
      const result = await c.api<{ device: Device; rotation: NonNullable<Device["credentialRotation"]> }>(
        `/v1/devices/${encodeURIComponent(device.id)}/transfer-reset`,
        { method: "POST", body: {} },
      );
      setEditingDevice(null);
      await c.refreshAll();
      return result;
    });
  };

  const revokeDevice = async (device: Device) => {
    const accepted = await confirm({
      title: `Revoke ${device.label}?`,
      description: "This disables the current hardware credential. The controller will no longer authenticate.",
      confirmLabel: "Revoke device",
    });
    if (!accepted) return;
    await c.run("revoke-device", "Device revoked.", async () => {
      const result = await c.api(`/v1/devices/${encodeURIComponent(device.id)}/revoke`, {
        method: "POST",
        body: {},
      });
      setEditingDevice(null);
      await c.refreshAll();
      return result;
    });
  };

  const saveDevice = async () => {
    if (!editingDevice || !editLabel.trim() || !deviceGatewayUrlValid(editConfig)) return;
    const result = await c.run("save-device-details", "Device details updated.", async () => {
      const configResult = await c.api(`/v1/devices/${encodeURIComponent(editingDevice.id)}/config`, {
        method: "PUT",
        body: {
          label: editLabel.trim(),
          environmentId: editConfig.environmentId || null,
          threadId: editConfig.threadId?.trim() || null,
          gatewayAccessMode: editConfig.gatewayAccessMode ?? "local",
          gatewayUrl: editConfig.gatewayUrl?.trim() || null,
          defaultPrompt: editConfig.defaultPrompt?.trim() ?? "",
          shellCommand: editConfig.shellCommand?.trim() ?? "",
          menu: editConfig.menu ?? [],
        },
      });
      if (editProfile !== editingDevice.profile) {
        await c.api(`/v1/devices/${encodeURIComponent(editingDevice.id)}/profile`, {
          method: "PUT",
          body: { profile: editProfile },
        });
      }
      await c.refreshAll();
      return configResult;
    });
    if (result) setEditingDevice(null);
  };

  return (
    <div className="devices-workspace ac-fleet">
      <section className="devices-overview" aria-labelledby="devices-heading">
        <div>
          <p className="ac-eyebrow">Hardware fleet</p>
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="devices-heading" className="ac-display-title">
              {c.devices.length ? "Your controllers" : "Connect your first controller"}
            </h2>
            {c.devices.length ? <StatusBadge label={`${c.devices.length} total`} /> : null}
          </div>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            {c.devices.length
              ? "Presence, health, and credentials across every controller attached to this account."
              : "Choose the path that matches the hardware in front of you."}
          </p>
        </div>
      </section>

      <DeviceActionCluster className="devices-mobile-actions" onOpen={setFlow} />

      {c.deviceSecret ? (
        <CredentialBanner controller={c} />
      ) : null}

      {c.devices.length ? (
        <section aria-label="Controller inventory" className="device-grid">
          {c.devices.map((device) => (
            <DeviceTile
              key={device.id}
              device={device}
              selected={device.id === c.selectedDeviceId}
              can={can}
              onOpen={() => openDevice(device)}
              onRotate={() => void rotateSecret(device)}
              onTransfer={() => void transferReset(device)}
              onRevoke={() => void revokeDevice(device)}
            />
          ))}
        </section>
      ) : (
        <section className="devices-empty" aria-labelledby="empty-devices-title">
          <div className="devices-empty__signal" aria-hidden="true">
            <span />
            <Radio className="size-6" />
          </div>
          <p className="ac-eyebrow">No devices reporting</p>
          <h3 id="empty-devices-title" className="ac-display-title">How is this controller arriving?</h3>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-ink-muted">
            Factory hardware starts unowned, developer hardware needs a credential, and retail hardware arrives with a claim code.
          </p>
          <div className="devices-empty__actions">
            <EmptyAction
              icon={Fingerprint}
              title="Pre-provision"
              detail="Factory identity + claim card"
              onClick={() => setFlow("preprovision")}
            />
            <EmptyAction
              icon={Laptop}
              title="Register"
              detail="Local or simulated hardware"
              onClick={() => setFlow("register")}
            />
            <EmptyAction
              icon={KeyRound}
              title="Claim"
              detail="Code from a physical device"
              onClick={() => setFlow("claim")}
            />
          </div>
        </section>
      )}

      <OnboardingDialog
        controller={c}
        flow={activeFlow}
        profiles={profiles}
        onClose={() => setFlow(null)}
      />

      <DeviceEditorDialog
        controller={c}
        device={editingDevice}
        profiles={profiles}
        label={editLabel}
        profile={editProfile}
        config={editConfig}
        onLabelChange={setEditLabel}
        onProfileChange={setEditProfile}
        onConfigChange={setEditConfig}
        onClose={() => setEditingDevice(null)}
        onSave={() => void saveDevice()}
        onRotate={() => editingDevice && void rotateSecret(editingDevice)}
        onTransfer={() => editingDevice && void transferReset(editingDevice)}
        onRevoke={() => editingDevice && void revokeDevice(editingDevice)}
      />
    </div>
  );
}

function CredentialBanner({ controller: c }: { controller: Controller }) {
  const copy = () => {
    const value = [c.deviceSecret?.id, c.deviceSecret?.secret, c.deviceSecret?.claimCode].filter(Boolean).join("\n");
    void navigator.clipboard.writeText(value);
    c.setNotice({ tone: "success", message: "Credential copied to clipboard." });
  };
  return (
    <section className="credential-banner" aria-label="One-time device credential">
      <div className="credential-banner__icon"><KeyRound className="size-4" /></div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="ac-display text-sm">{c.deviceSecret?.title}</p>
          <StatusBadge tone="warning" label="Visible once" />
        </div>
        <p className="mt-1 truncate font-mono text-xs text-ink-muted">
          {[c.deviceSecret?.id, c.deviceSecret?.claimCode].filter(Boolean).join(" · ")}
        </p>
      </div>
      <Button size="sm" onClick={copy}><Clipboard className="size-3.5" /> Copy credential</Button>
    </section>
  );
}

function EmptyAction({
  icon: Icon,
  title,
  detail,
  onClick,
}: {
  icon: typeof Fingerprint;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="devices-empty__action" onClick={onClick}>
      <span className="devices-empty__action-icon"><Icon className="size-4.5" /></span>
      <span className="min-w-0 text-left">
        <span className="block ac-display text-sm text-ink">{title}</span>
        <span className="mt-0.5 block text-xs text-ink-faint">{detail}</span>
      </span>
      <ArrowRight className="ml-auto size-4 text-ink-faint" />
    </button>
  );
}

function DeviceTile({
  device,
  selected = false,
  can,
  onOpen,
  onRotate,
  onTransfer,
  onRevoke,
}: {
  device: Device;
  selected?: boolean;
  can: (device: Device, action: keyof NonNullable<Device["actions"]>) => boolean;
  onOpen: () => void;
  onRotate: () => void;
  onTransfer: () => void;
  onRevoke: () => void;
}) {
  const state = deviceStatus(device);
  const status = device.status;
  const stop = (callback: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    callback();
  };
  return (
    <article
      className="device-tile"
      data-revoked={device.revokedAt ? true : undefined}
      data-selected={selected || undefined}
      data-tone={state.tone}
      onClick={onOpen}
    >
      <button
        type="button"
        className="device-tile__header"
        aria-label={`Edit ${device.label}`}
        onClick={stop(onOpen)}
      >
        <div className="device-tile__glyph">
          {device.revokedAt ? <CircleOff className="size-5" /> : <Smartphone className="size-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate ac-display text-[1.0625rem]">{device.label}</h3>
            <StatusBadge tone={state.tone} label={state.label} pulse={state.label === "online"} />
          </div>
          <p className="mt-1 truncate font-mono text-[10px] text-ink-faint">{device.id}</p>
        </div>
        <ArrowRight className="device-tile__open size-4" aria-hidden="true" />
      </button>

      <dl className="device-tile__metrics">
        <TileMetric icon={Clock3} label="Last seen" value={formatRelativeTime(status?.lastHeartbeatAt ?? device.lastSeenAt)} />
        <TileMetric icon={Gauge} label="Uptime" value={formatUptime(status?.uptimeMs)} />
        <TileMetric icon={Radio} label="Firmware" value={status?.firmwareVersion ?? "unknown"} />
        <TileMetric
          icon={Cpu}
          label="Hardware"
          value={status?.hardwareModel ?? device.hardwareModel ?? "unknown"}
        />
        <TileMetric icon={Wifi} label="IP address" value={status?.ipAddress ?? "unknown"} />
        <TileMetric
          icon={Battery}
          label="Battery"
          value={status?.batteryPercent != null
            ? formatMetric(status.batteryPercent, "%")
            : formatMetric(status?.batteryMv, "mV")}
        />
      </dl>

      <div className="device-tile__context">
        <span>{device.config?.environmentId ?? "No environment"}</span>
        <span>{device.credentialRotation?.state === "pending"
          ? `credential v${device.credentialRotation.pendingCredentialVersion ?? "next"} awaiting controller`
          : device.credentialRotation?.state === "expired"
            ? "credential rotation needs retry"
            : device.profile}</span>
      </div>
      <div className="device-tile__actions" aria-label={`Credential actions for ${device.label}`}>
        <Button size="sm" disabled={!can(device, "rotateSecret")} onClick={stop(onRotate)}>
          <RotateCcwKey className="size-3.5" /> Rotate
        </Button>
        <Button size="sm" variant="danger-ghost" disabled={!can(device, "transferReset")} onClick={stop(onTransfer)}>
          <Unplug className="size-3.5" /> Transfer reset
        </Button>
        <Button size="sm" variant="danger-ghost" disabled={!can(device, "revoke")} onClick={stop(onRevoke)}>
          <CircleOff className="size-3.5" /> Revoke
        </Button>
      </div>
    </article>
  );
}

function TileMetric({ icon: Icon, label, value }: { icon: typeof Clock3; label: string; value: ReactNode }) {
  return (
    <div className="device-tile__metric ac-stat">
      <dt className="ac-stat__label"><Icon className="size-3" /> {label}</dt>
      <dd className="ac-stat__value">{value}</dd>
    </div>
  );
}

function OnboardingDialog({
  controller: c,
  flow,
  profiles,
  onClose,
}: {
  controller: Controller;
  flow: DeviceOnboardingFlow | null;
  profiles: DeviceProfile[];
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [label, setLabel] = useState("Desk controller");
  const [profile, setProfile] = useState("agent-controller");
  const [claimCode, setClaimCode] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [threadId, setThreadId] = useState("");
  // Empty means "whatever the gateway calls the default". The catalogue arrives asynchronously, so
  // holding an explicit pick separately from the default keeps a late response from clobbering a
  // choice the operator already made.
  const [boardChoice, setBoardChoice] = useState("");
  const [result, setResult] = useState<CredentialResult | null>(null);

  useEffect(() => {
    if (!flow) return;
    setStep(0);
    setLabel(flow === "claim" ? "" : "Desk controller");
    setProfile("agent-controller");
    setClaimCode("");
    setEnvironmentId(c.selectedEnvironmentId ?? "");
    setThreadId(c.selectedThreadId ?? "");
    setBoardChoice("");
    setResult(null);
  }, [flow]);

  if (!flow) return null;
  const copy = FLOW_COPY[flow];
  const boards = c.hardwareBoards ?? [];
  const boardId = boardChoice || c.defaultHardwareBoard || boards[0]?.id || "";
  const selectedBoard = boards.find((board) => board.id === boardId) ?? null;
  const stepName = copy.steps[step];
  const isLastStep = step === copy.steps.length - 1;
  const valid = stepName === "Identity"
    ? Boolean(label.trim())
    : stepName === "Claim code" ? Boolean(claimCode.trim()) : true;

  const configure = async (deviceId: string) => {
    if (!environmentId && !threadId) return;
    await c.api(`/v1/devices/${encodeURIComponent(deviceId)}/config`, {
      method: "PUT",
      body: { environmentId: environmentId || null, threadId: threadId.trim() || null },
    });
  };

  const complete = async () => {
    const action = flow === "preprovision" ? "preprovision-device" : flow === "register" ? "register-device" : "claim-device";
    const success = flow === "preprovision"
      ? "Factory device pre-provisioned."
      : flow === "register" ? "Device registered. Copy the new secret now." : "Device claimed to this account.";
    const created = await c.run(action, success, async () => {
      let next: CredentialResult;
      if (flow === "preprovision") {
        const response = await c.api<{
          device: Device;
          secret: string;
          claimCode: string;
          board?: HardwareBoard;
        }>("/v1/factory/devices", {
          method: "POST",
          auth: false,
          body: boardId
            ? { label: label.trim(), profile, hardwareModel: boardId }
            : { label: label.trim(), profile },
        });
        next = response;
      } else if (flow === "register") {
        const response = await c.api<{ device: Device; secret: string }>("/v1/devices", {
          method: "POST",
          body: { label: label.trim(), profile },
        });
        await configure(response.device.id);
        next = response;
      } else {
        const response = await c.api<{ device: Device }>("/v1/devices/claim", {
          method: "POST",
          body: { claimCode: claimCode.trim(), label: label.trim() || undefined },
        });
        await configure(response.device.id);
        next = response;
      }
      if (next.secret || next.claimCode) {
        c.setDeviceSecret({
          title: flow === "preprovision" ? "Factory device" : "New device secret",
          id: next.device.id,
          secret: next.secret,
          claimCode: next.claimCode,
        });
      }
      if (flow !== "preprovision") await c.refreshAll();
      return next;
    });
    if (created) setResult(created);
  };

  return (
    <ModalShell
      open
      title={result ? "Controller ready" : copy.title}
      eyebrow={result ? "Workflow complete" : copy.eyebrow}
      description={result ? result.device.label : copy.intro}
      onClose={onClose}
      footer={result ? (
        <Button variant="primary" onClick={onClose}><Check className="size-4" /> Done</Button>
      ) : (
        <>
          <Button variant="ghost" onClick={step === 0 ? onClose : () => setStep((current) => current - 1)}>
            {step === 0 ? "Cancel" : <><ArrowLeft className="size-4" /> Back</>}
          </Button>
          <Button
            variant="primary"
            busy={c.busyAction === "preprovision-device" || c.busyAction === "register-device" || c.busyAction === "claim-device"}
            disabled={!valid}
            onClick={() => isLastStep ? void complete() : setStep((current) => current + 1)}
          >
            {isLastStep ? flow === "claim" ? "Claim controller" : flow === "register" ? "Register controller" : "Create factory identity" : "Continue"}
            {!isLastStep ? <ArrowRight className="size-4" /> : null}
          </Button>
        </>
      )}
    >
      {result ? (
        <WorkflowResult flow={flow} result={result} controller={c} />
      ) : (
        <>
          <FlowStepper steps={copy.steps} current={step} />
          <div className="device-flow__body">
            {stepName === "Purpose" || stepName === "Prepare" ? <FlowIntro flow={flow} copy={copy} /> : null}
            {stepName === "Board" ? (
              <BoardFields
                boards={boards}
                value={boardId}
                defaultBoardId={c.defaultHardwareBoard ?? null}
                onChange={setBoardChoice}
              />
            ) : null}
            {stepName === "Claim code" ? (
              <ClaimFields claimCode={claimCode} label={label} onClaimCode={setClaimCode} onLabel={setLabel} />
            ) : null}
            {stepName === "Identity" ? (
              <IdentityFields label={label} profile={profile} profiles={profiles} onLabel={setLabel} onProfile={setProfile} />
            ) : null}
            {stepName === "Defaults" ? (
              <DefaultFields
                controller={c}
                environmentId={environmentId}
                threadId={threadId}
                onEnvironment={setEnvironmentId}
                onThread={setThreadId}
              />
            ) : null}
            {isLastStep ? (
              <FlowReview
                flow={flow}
                label={label}
                profile={profile}
                claimCode={claimCode}
                environmentId={environmentId}
                threadId={threadId}
                board={selectedBoard}
                boardId={boardId}
              />
            ) : null}
          </div>
        </>
      )}
    </ModalShell>
  );
}

function FlowStepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="device-flow__steps" aria-label="Workflow progress">
      {steps.map((label, index) => (
        <li key={label} data-active={index === current || undefined} data-complete={index < current || undefined}>
          <span>{index < current ? <Check className="size-3" /> : index + 1}</span>
          <small>{label}</small>
        </li>
      ))}
    </ol>
  );
}

function FlowIntro({
  flow,
  copy,
}: {
  flow: DeviceOnboardingFlow;
  copy: (typeof FLOW_COPY)[DeviceOnboardingFlow];
}) {
  const Icon = flow === "preprovision" ? Fingerprint : flow === "register" ? Laptop : KeyRound;
  const checks = flow === "preprovision"
    ? ["Creates an unowned hardware identity", "Issues a claim code for the recipient", "Shows the device secret once"]
    : flow === "register"
      ? ["Attaches the controller to this account", "Issues a one-time hardware secret", "Optionally assigns runtime defaults"]
      : ["Requires the code shown on the controller", "Moves ownership to this account", "Keeps the existing hardware credential"];
  return (
    <div className="device-flow__intro">
      <div className="device-flow__hero-icon"><Icon className="size-6" /></div>
      <StatusBadge tone={flow === "claim" ? "info" : "neutral"} label={copy.accent} />
      <h3>{copy.introTitle}</h3>
      <p>{copy.intro}</p>
      <ul>{checks.map((item) => <li key={item}><CheckCircle2 className="size-4" /> {item}</li>)}</ul>
    </div>
  );
}

/**
 * How honest to be about each board. Only the CrowPanel has a firmware validated end to end; the
 * other three ship as bring-up or scaffold, and an operator stamping a unit that will be flashed
 * with an unproven image has to be told so before the identity is minted, not after.
 */
const BOARD_MATURITY: Record<string, { label: string; tone: StatusTone; note: string }> = {
  complete: {
    label: "Proven",
    tone: "success",
    note: "Firmware is complete and validated on this board end to end.",
  },
  "bring-up": {
    label: "Bring-up",
    tone: "warning",
    note: "Firmware exists but has not been validated on hardware. Expect to debug the unit.",
  },
  scaffold: {
    label: "Scaffold",
    tone: "danger",
    note: "Only a firmware skeleton exists. This board is not ready to ship to an owner.",
  },
  unknown: {
    label: "Unknown",
    tone: "neutral",
    note: "This gateway has no catalogue entry for the board.",
  },
};

function boardMaturity(board: HardwareBoard) {
  return BOARD_MATURITY[board.maturity ?? "unknown"] ?? BOARD_MATURITY.unknown;
}

const DISPLAY_KIND_LABELS: Record<string, string> = {
  epaper: "E-paper",
  ips: "IPS",
  amoled: "AMOLED",
  tft: "TFT",
};

/** The one-line answer to "what can this thing actually do?" */
function describeBoardAbilities(board: HardwareBoard): string[] {
  const abilities: string[] = [];
  const display = board.display;
  if (display?.width && display?.height) {
    const kind = DISPLAY_KIND_LABELS[display.kind ?? ""] ?? display.kind ?? "Display";
    const colors = display.colors === 2 ? "monochrome" : display.colors ? `${display.colors} colors` : null;
    abilities.push([`${kind} ${display.width}x${display.height}`, colors].filter(Boolean).join(", "));
  }
  const keys = board.input?.keys ?? 0;
  if (board.input?.touch) abilities.push(keys ? `Touch + ${keys} key${keys === 1 ? "" : "s"}` : "Touch input");
  else abilities.push(keys ? `${keys} key${keys === 1 ? "" : "s"}, no touch` : "No touch, no keys");
  abilities.push(board.audio?.microphone ? "Microphone" : "No microphone");
  if (board.audio?.speaker) abilities.push("Speaker");
  if (board.camera) abilities.push("Camera");
  return abilities;
}

function BoardFields({
  boards,
  value,
  defaultBoardId,
  onChange,
}: {
  boards: readonly HardwareBoard[];
  value: string;
  defaultBoardId: string | null;
  onChange: (boardId: string) => void;
}) {
  if (boards.length === 0) {
    return (
      <div className="mx-auto grid w-full max-w-lg gap-3 py-6">
        <p className="ac-display text-base">Board catalogue unavailable</p>
        <p className="text-sm leading-relaxed text-ink-muted">
          This gateway did not return a hardware catalogue, so the identity will be stamped with its
          own default board. Continue only if you know which image this unit will be flashed with.
        </p>
      </div>
    );
  }
  return (
    <fieldset className="min-w-0">
      <legend className="text-xs font-semibold text-ink-muted">Hardware board</legend>
      <p className="mt-1 text-xs leading-relaxed text-ink-faint">
        The board is stamped into the identity and the NVS seed. These four are not interchangeable
        — they differ in display, input, and whether they can capture audio at all.
      </p>
      <div className="mt-2 grid gap-2">
        {boards.map((board) => {
          const selected = board.id === value;
          const maturity = boardMaturity(board);
          return (
            <label
              key={board.id}
              className={cn("profile-card", selected && "profile-card--selected")}
              data-selected={selected || undefined}
            >
              <input
                type="radio"
                name="flow-hardware-board"
                value={board.id}
                checked={selected}
                onChange={() => onChange(board.id)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-sm font-semibold">{board.label}</span>
                  <StatusBadge tone={maturity.tone} label={maturity.label} />
                  {board.id === defaultBoardId ? <StatusBadge tone="info" label="Default" /> : null}
                </span>
                <span className="mt-0.5 block text-xs text-ink-faint">
                  {board.vendor ? `${board.vendor} · ` : ""}
                  <span className="font-mono">{board.id}</span>
                </span>
                <span className="mt-2 flex flex-wrap gap-1.5">
                  {describeBoardAbilities(board).map((ability) => (
                    <span key={ability} className="rounded-md border border-control bg-surface-inset px-1.5 py-0.5 text-[10px] text-ink-muted">
                      {ability}
                    </span>
                  ))}
                </span>
                <span className="mt-2 flex items-start gap-1.5 text-xs leading-snug text-ink-muted">
                  {board.maturity === "complete"
                    ? <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-success" aria-hidden="true" />
                    : <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden="true" />}
                  <span>{maturity.note}</span>
                </span>
                {board.firmwareEnv ? (
                  <span className="mt-1.5 block font-mono text-[10px] text-ink-faint">
                    pio run -e {board.firmwareEnv}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function IdentityFields({
  label,
  profile,
  profiles,
  onLabel,
  onProfile,
}: {
  label: string;
  profile: string;
  profiles: DeviceProfile[];
  onLabel: (value: string) => void;
  onProfile: (value: string) => void;
}) {
  return (
    <div className="grid gap-5">
      <Field label="Device label" htmlFor="flow-device-label" hint="Use a name operators can recognize in alerts and audit logs.">
        <input id="flow-device-label" autoFocus value={label} onChange={(event) => onLabel(event.target.value)} />
      </Field>
      <ProfilePicker
        name="flow-device-profile"
        legend="Policy profile"
        description="This capability boundary takes effect before the controller can issue a command."
        profiles={profiles}
        value={profile}
        onChange={onProfile}
      />
    </div>
  );
}

function ClaimFields({
  claimCode,
  label,
  onClaimCode,
  onLabel,
}: {
  claimCode: string;
  label: string;
  onClaimCode: (value: string) => void;
  onLabel: (value: string) => void;
}) {
  return (
    <div className="mx-auto grid w-full max-w-md gap-5 py-6">
      <div className="rounded-lg border border-info/20 bg-info/8 p-3 text-xs leading-relaxed text-info-strong">
        Power on the controller and connect it to Wi-Fi first. Enter the code on its display or printed claim card.
      </div>
      <Field label="Claim code" htmlFor="flow-claim-code" hint="Codes are single-use and are not case-sensitive.">
        <input
          id="flow-claim-code"
          autoFocus
          className="font-mono uppercase tracking-[0.14em]"
          value={claimCode}
          onChange={(event) => onClaimCode(event.target.value)}
          placeholder="ABCDE-23456"
        />
      </Field>
      <Field label="Controller label" htmlFor="flow-claim-label" hint="Optional — keep the existing factory label by leaving this blank.">
        <input id="flow-claim-label" value={label} onChange={(event) => onLabel(event.target.value)} placeholder="Studio controller" />
      </Field>
    </div>
  );
}

function DefaultFields({
  controller: c,
  environmentId,
  threadId,
  onEnvironment,
  onThread,
}: {
  controller: Controller;
  environmentId: string;
  threadId: string;
  onEnvironment: (value: string) => void;
  onThread: (value: string) => void;
}) {
  return (
    <div className="mx-auto grid w-full max-w-lg gap-5 py-6">
      <div>
        <p className="ac-display text-base">Choose its default destination</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-muted">You can skip this now and configure it from the device tile later.</p>
      </div>
      <Field label="Default environment" htmlFor="flow-environment">
        <select id="flow-environment" value={environmentId} onChange={(event) => onEnvironment(event.target.value)}>
          <option value="">No environment</option>
          {c.environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.label}</option>)}
        </select>
      </Field>
      <Field label="Default thread ID" htmlFor="flow-thread" hint="Optional. The controller can select a thread later.">
        <input id="flow-thread" className="font-mono" value={threadId} onChange={(event) => onThread(event.target.value)} placeholder="thread_…" />
      </Field>
    </div>
  );
}

function FlowReview({
  flow,
  label,
  profile,
  claimCode,
  environmentId,
  threadId,
  board,
  boardId,
}: {
  flow: DeviceOnboardingFlow;
  label: string;
  profile: string;
  claimCode: string;
  environmentId: string;
  threadId: string;
  board?: HardwareBoard | null;
  boardId?: string;
}) {
  return (
    <div className="device-flow__review">
      <div>
        <p className="ac-eyebrow">Confirm operation</p>
        <h3 className="ac-display text-lg">{FLOW_COPY[flow].title}</h3>
        <p className="mt-1 text-sm text-ink-muted">Review the ownership and execution context before continuing.</p>
      </div>
      <dl>
        <ReviewRow label="Label" value={label || "Keep factory label"} />
        {flow === "claim" ? <ReviewRow label="Claim code" value={claimCode.toUpperCase()} mono /> : <ReviewRow label="Policy" value={profile} mono />}
        {flow === "preprovision" ? <ReviewRow label="Board" value={board?.label ?? boardId ?? "Gateway default"} /> : null}
        {flow === "preprovision" && board?.firmwareEnv ? <ReviewRow label="Firmware image" value={board.firmwareEnv} mono /> : null}
        {flow !== "preprovision" ? <ReviewRow label="Environment" value={environmentId || "Not assigned"} mono /> : null}
        {flow !== "preprovision" ? <ReviewRow label="Thread" value={threadId || "Not assigned"} mono /> : null}
        <ReviewRow label="Ownership" value={flow === "preprovision" ? "Unowned until claimed" : "This account"} />
      </dl>
      {flow !== "claim" ? (
        <p className="rounded-lg border border-warning/20 bg-warning/8 p-3 text-xs leading-relaxed text-warning-strong">
          The hardware secret is shown once. Store it before leaving the completed screen.
        </p>
      ) : null}
    </div>
  );
}

function ReviewRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? "font-mono" : undefined}>{value}</dd></div>;
}

function WorkflowResult({
  flow,
  result,
  controller: c,
}: {
  flow: DeviceOnboardingFlow;
  result: CredentialResult;
  controller: Controller;
}) {
  const copyCredential = () => {
    const value = [result.device.id, result.secret, result.claimCode].filter(Boolean).join("\n");
    void navigator.clipboard.writeText(value);
    c.setNotice({ tone: "success", message: "Credential copied to clipboard." });
  };
  return (
    <div className="device-flow__result">
      <div className="device-flow__result-check"><Check className="size-6" /></div>
      <h3>{flow === "claim" ? "Controller claimed" : "Identity created"}</h3>
      <p>{flow === "preprovision" ? "Package the claim code with the device and install the hardware secret securely." : "The controller is now part of this account."}</p>
      <dl>
        <ReviewRow label="Device ID" value={result.device.id} mono />
        {result.secret ? <ReviewRow label="Secret" value={result.secret} mono /> : null}
        {result.claimCode ? <ReviewRow label="Claim code" value={result.claimCode} mono /> : null}
        {result.board ? <ReviewRow label="Board" value={result.board.label} /> : null}
        {result.board?.firmwareEnv ? <ReviewRow label="Firmware image" value={result.board.firmwareEnv} mono /> : null}
        {result.board?.firmwareDir ? <ReviewRow label="Firmware source" value={result.board.firmwareDir} mono /> : null}
      </dl>
      {result.board?.firmwareEnv ? (
        <p className="rounded-lg border border-warning/20 bg-warning/8 p-3 text-left text-xs leading-relaxed text-warning-strong">
          Flash this unit with <code className="font-mono">{result.board.firmwareEnv}</code>. There is one
          image per board — a correct seed on the wrong image still produces a dead device.
          {result.board.firmwareDir ? (
            <> Build it from <code className="font-mono">{result.board.firmwareDir}</code> with{" "}
              <code className="font-mono">pio run -e {result.board.firmwareEnv}</code>.</>
          ) : null}
        </p>
      ) : null}
      {(result.secret || result.claimCode) ? <Button onClick={copyCredential}><Clipboard className="size-4" /> Copy credential</Button> : null}
    </div>
  );
}

function normalizeControlsResponse(value: unknown): DeviceControls {
  const response = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const layout = response.layout && typeof response.layout === "object" && !Array.isArray(response.layout)
    ? response.layout as Record<string, unknown>
    : {};
  const nested = response.controls && typeof response.controls === "object" && !Array.isArray(response.controls)
    ? response.controls as Record<string, unknown>
    : Object.keys(layout).length ? layout : response;
  const array = Array.isArray(response.controls)
    ? response.controls
    : Array.isArray(nested.items) ? nested.items : [];
  return {
    revision: typeof nested.revision === "number" ? nested.revision : typeof response.revision === "number" ? response.revision : 0,
    acknowledgedRevision: typeof nested.acknowledgedRevision === "number"
      ? nested.acknowledgedRevision
      : typeof nested.appliedRevision === "number" ? nested.appliedRevision : null,
    appliedRevision: typeof nested.appliedRevision === "number" ? nested.appliedRevision : null,
    appliedAt: typeof nested.appliedAt === "string" ? nested.appliedAt : null,
    lastAckStatus: typeof nested.lastAckStatus === "string" ? nested.lastAckStatus : null,
    lastAckError: typeof nested.lastAckError === "string" ? nested.lastAckError : null,
    capacity: typeof nested.capacity === "number" ? nested.capacity : undefined,
    items: array as DeviceControlItem[],
  };
}

function normalizeFirmwareResponse(value: unknown, device: Device): DeviceFirmwarePolicy {
  const response = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const nested = (response.policy ?? response.firmwarePolicy) as Record<string, unknown> | undefined;
  // Release discovery belongs to the owner response while mutable rollout fields live under
  // `policy`. Merge both so selecting the policy object does not discard latestVersion or notes.
  const source = { ...response, ...(nested ?? {}) };
  return {
    channel: source.channel === "beta" ? "beta" : "stable",
    updateMode: source.updateMode === "automatic" || source.updateMode === "notify" ? source.updateMode : "manual",
    desiredVersion: typeof source.desiredVersion === "string" ? source.desiredVersion : null,
    currentVersion: typeof source.currentVersion === "string" ? source.currentVersion : device.status?.firmwareVersion ?? null,
    latestVersion: typeof source.latestVersion === "string" ? source.latestVersion : null,
    availableVersions: Array.isArray(source.availableVersions) ? source.availableVersions.filter((item): item is string => typeof item === "string") : [],
    status: typeof (source.status ?? source.lastUpdateStatus) === "string" ? String(source.status ?? source.lastUpdateStatus) : null,
    lastUpdateStatus: typeof source.lastUpdateStatus === "string" ? source.lastUpdateStatus : null,
    lastUpdateAt: typeof source.lastUpdateAt === "string" ? source.lastUpdateAt : null,
    lastError: typeof (source.lastError ?? source.lastUpdateError) === "string" ? String(source.lastError ?? source.lastUpdateError) : null,
    lastUpdateError: typeof source.lastUpdateError === "string" ? source.lastUpdateError : null,
    updateProgress: typeof source.updateProgress === "number" ? source.updateProgress : null,
    targetVersion: typeof source.targetVersion === "string" ? source.targetVersion : null,
    releaseNotes: typeof source.releaseNotes === "string" ? source.releaseNotes : null,
  };
}

function DeviceEditorDialog({
  controller: c,
  device,
  profiles,
  label,
  profile,
  config,
  onLabelChange,
  onProfileChange,
  onConfigChange,
  onClose,
  onSave,
  onRotate,
  onTransfer,
  onRevoke,
}: {
  controller: Controller;
  device: Device | null;
  profiles: DeviceProfile[];
  label: string;
  profile: string;
  config: DeviceConfig;
  onLabelChange: (value: string) => void;
  onProfileChange: (value: string) => void;
  onConfigChange: (value: DeviceConfig) => void;
  onClose: () => void;
  onSave: () => void;
  onRotate: () => void;
  onTransfer: () => void;
  onRevoke: () => void;
}) {
  const [tab, setTab] = useState<"overview" | "configuration" | "gateway" | "controls" | "policy" | "firmware">("overview");
  const [controls, setControls] = useState<DeviceControls>({ revision: 0, acknowledgedRevision: null, items: [] });
  const [controlsLoading, setControlsLoading] = useState(false);
  const [actionToAdd, setActionToAdd] = useState("");
  const [firmware, setFirmware] = useState<DeviceFirmwarePolicy>({ channel: "stable", updateMode: "manual" });
  const [firmwareLoading, setFirmwareLoading] = useState(false);
  const [flashGuideOpen, setFlashGuideOpen] = useState(false);
  const actions = c.actions ?? [];

  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    setTab("overview");
    setFlashGuideOpen(false);
    setControlsLoading(true);
    setFirmwareLoading(true);
    void Promise.allSettled([
      c.api<unknown>(`/v1/devices/${encodeURIComponent(device.id)}/controls`),
      c.api<unknown>(`/v1/devices/${encodeURIComponent(device.id)}/firmware-policy`),
    ]).then(([controlsResult, firmwareResult]) => {
      if (cancelled) return;
      if (controlsResult.status === "fulfilled") setControls(normalizeControlsResponse(controlsResult.value));
      else setControls({ revision: 0, acknowledgedRevision: null, items: [] });
      if (firmwareResult.status === "fulfilled") setFirmware(normalizeFirmwareResponse(firmwareResult.value, device));
      else setFirmware(normalizeFirmwareResponse({}, device));
      setControlsLoading(false);
      setFirmwareLoading(false);
    });
    return () => { cancelled = true; };
  }, [device?.id]);
  if (!device) return null;
  const state = deviceStatus(device);
  const stampedBoard = device.hardwareModel
    ? (c.hardwareBoards ?? []).find((board) => board.id === device.hardwareModel) ?? null
    : null;
  const allowedToSave = (device.actions?.updateConfig ?? true)
    && (profile === device.profile || (device.actions?.updateProfile ?? true))
    && !device.revokedAt
    && Boolean(label.trim())
    && deviceGatewayUrlValid(config);
  const tabHasLocalActions = tab === "gateway" || tab === "controls" || tab === "firmware";
  if (flashGuideOpen) {
    return (
      <FirmwareFlashGuideModal
        device={device}
        currentVersion={firmware.currentVersion ?? device.status?.firmwareVersion ?? null}
        onBack={() => setFlashGuideOpen(false)}
      />
    );
  }
  return (
    <ModalShell
      open
      size="large"
      title={device.label}
      eyebrow="Controller details"
      description={device.id}
      onClose={onClose}
      headerAction={<StatusBadge tone={state.tone} label={state.label} />}
      footer={tabHasLocalActions ? null : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={c.busyAction === "save-device-details"} disabled={!allowedToSave} onClick={onSave}>
            <Save className="size-4" /> Save changes
          </Button>
        </>
      )}
    >
      <div className="device-editor">
        <nav className="device-editor__tabs" aria-label="Device settings" role="tablist">
          {(["overview", "configuration", "gateway", "controls", "policy", "firmware"] as const).map((item) => (
            <button
              key={item}
              id={`device-tab-${item}`}
              type="button"
              role="tab"
              aria-controls="device-editor-panel"
              aria-selected={tab === item}
              data-active={tab === item || undefined}
              onClick={() => setTab(item)}
            >
              {item}
            </button>
          ))}
        </nav>
        <div
          id="device-editor-panel"
          className="device-editor__body"
          role="tabpanel"
          aria-labelledby={`device-tab-${tab}`}
        >
          {tab === "overview" ? (
            <div className="grid gap-5">
              <Field label="Device label" htmlFor="edit-device-label" hint="Shown in fleet health, alerts, commands, and audit history.">
                <input id="edit-device-label" value={label} onChange={(event) => onLabelChange(event.target.value)} />
              </Field>
              <dl className="device-editor__facts">
                <ReviewRow label="Device ID" value={device.id} mono />
                <ReviewRow
                  label="Hardware"
                  value={device.status?.hardwareModel ?? device.hardwareModel ?? "unknown"}
                  mono
                />
                {/* Only shown when the record actually carries one — devices stamped before the
                    board catalogue existed have none, and inventing a value would be a lie. */}
                {device.hardwareModel ? (
                  <ReviewRow label="Board" value={stampedBoard?.label ?? device.hardwareModel} />
                ) : null}
                {stampedBoard?.firmwareEnv ? (
                  <ReviewRow label="Firmware image" value={stampedBoard.firmwareEnv} mono />
                ) : null}
                <ReviewRow label="Firmware" value={device.status?.firmwareVersion ?? "unknown"} mono />
                <ReviewRow label="Last seen" value={formatRelativeTime(device.status?.lastHeartbeatAt ?? device.lastSeenAt)} />
                <ReviewRow
                  label="Credential"
                  value={device.credentialRotation?.state === "pending"
                    ? `v${device.credentialVersion ?? 1} active · v${device.credentialRotation.pendingCredentialVersion ?? "next"} awaiting controller ACK`
                    : device.credentialRotation?.state === "expired"
                      ? `v${device.credentialVersion ?? 1} active · rotation expired`
                      : `v${device.credentialVersion ?? 1} active`}
                />
              </dl>
              <section className="device-editor__danger" aria-labelledby="credential-actions-title">
                <div>
                  <p id="credential-actions-title" className="ac-display text-sm text-danger">Credential actions</p>
                  <p className="mt-1 text-xs text-ink-muted">Rotation keeps the active credential until the controller acknowledges its replacement. Transfer removes ownership immediately and finishes on the controller.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={!(device.actions?.rotateSecret ?? true)} onClick={onRotate}><RotateCcwKey className="size-3.5" /> {device.credentialRotation?.state === "pending" || device.credentialRotation?.state === "expired" ? "Restart rotation" : "Rotate"}</Button>
                  <Button size="sm" variant="danger-ghost" disabled={!(device.actions?.transferReset ?? true)} onClick={onTransfer}><Unplug className="size-3.5" /> Transfer reset</Button>
                  <Button size="sm" variant="danger-ghost" disabled={!(device.actions?.revoke ?? true)} onClick={onRevoke}><CircleOff className="size-3.5" /> Revoke</Button>
                </div>
              </section>
            </div>
          ) : null}
          {tab === "configuration" ? (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Default environment" htmlFor="edit-device-environment">
                <select
                  id="edit-device-environment"
                  value={config.environmentId ?? ""}
                  onChange={(event) => onConfigChange({ ...config, environmentId: event.target.value || null })}
                >
                  <option value="">No environment</option>
                  {c.environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.label}</option>)}
                </select>
              </Field>
              <Field label="Default thread ID" htmlFor="edit-device-thread">
                <input id="edit-device-thread" className="font-mono" value={config.threadId ?? ""} onChange={(event) => onConfigChange({ ...config, threadId: event.target.value })} />
              </Field>
              <div className="device-target-note sm:col-span-2">
                Prompts, shell commands, media captures, and macros now live in the Actions library. This target is inherited by actions that do not pin their own destination.
              </div>
              <DeviceGatewayAccessEditor controller={c} config={config} onChange={onConfigChange} />
            </div>
          ) : null}
          {tab === "gateway" ? <DeviceGatewaySwitchEditor controller={c} device={device} /> : null}
          {tab === "controls" ? (
            <DeviceControlsEditor
              controller={c}
              device={device}
              actions={actions}
              controls={controls}
              firmware={firmware}
              loading={controlsLoading}
              actionToAdd={actionToAdd}
              onActionToAdd={setActionToAdd}
              onChange={setControls}
            />
          ) : null}
          {tab === "policy" ? (
            <ProfilePicker
              name="edit-device-profile"
              legend="Assigned policy profile"
              description="Profiles bound which intents this controller may issue. Changes take effect on its next command."
              profiles={profiles}
              value={profile}
              onChange={onProfileChange}
              assignedProfileId={device.profile}
              cardsClassName="lg:grid-cols-3"
            />
          ) : null}
          {tab === "firmware" ? (
            <DeviceFirmwareEditor
              controller={c}
              device={device}
              policy={firmware}
              loading={firmwareLoading}
              onChange={setFirmware}
              onOpenFlashGuide={() => setFlashGuideOpen(true)}
            />
          ) : null}
        </div>
      </div>
    </ModalShell>
  );
}

function normalizeGatewaySwitch(value: unknown, deviceId: string): DeviceGatewaySwitch {
  const response = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const source = response.gateway && typeof response.gateway === "object"
    ? response.gateway as Record<string, unknown>
    : response;
  const profile = (key: string): GatewayProfile | null => {
    const candidate = source[key];
    if (!candidate || typeof candidate !== "object") return null;
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.label !== "string" || typeof item.baseUrl !== "string") return null;
    const mode = item.mode === "tailnet" || item.mode === "custom" ? item.mode : "lan";
    return { id: item.id, label: item.label, baseUrl: item.baseUrl, mode };
  };
  const state = source.state === "pending" || source.state === "failed" ? source.state : "stable";
  return {
    deviceId: typeof source.deviceId === "string" ? source.deviceId : deviceId,
    revision: typeof source.revision === "number" ? source.revision : 0,
    state,
    activeProfile: profile("activeProfile"),
    pendingProfile: profile("pendingProfile"),
    previousProfile: profile("previousProfile"),
    lastError: typeof source.lastError === "string" ? source.lastError : null,
    requestedAt: typeof source.requestedAt === "string" ? source.requestedAt : null,
    appliedAt: typeof source.appliedAt === "string" ? source.appliedAt : null,
  };
}

function safeGatewayDisplayUrl(profile: GatewayProfile) {
  try {
    const url = new URL(profile.baseUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return "Origin hidden";
    if (url.pathname !== "/" || url.search || url.hash) return "Origin hidden";
    if (profile.mode === "custom" && url.protocol !== "https:") return "Origin hidden";
    if (profile.mode === "tailnet" && (url.protocol !== "https:" || !url.hostname.toLowerCase().endsWith(".ts.net"))) return "Origin hidden";
    return url.origin;
  } catch {
    return "Origin hidden";
  }
}

function DeviceGatewaySwitchEditor({ controller: c, device }: { controller: Controller; device: Device }) {
  const confirm = useConfirm();
  const profiles = c.gatewayProfiles ?? [];
  const [gateway, setGateway] = useState<DeviceGatewaySwitch | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestedProfileId, setRequestedProfileId] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const result = await c.api<unknown>(`/v1/devices/${encodeURIComponent(device.id)}/gateway`);
      const next = normalizeGatewaySwitch(result, device.id);
      setGateway(next);
      setRequestedProfileId(next.pendingProfile?.id ?? next.activeProfile?.id ?? "");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [device.id]);

  const selected = profiles.find((profile) => profile.id === requestedProfileId) ?? null;
  const stageSwitch = async () => {
    if (!selected || selected.id === gateway?.activeProfile?.id && gateway.state === "stable") return;
    if (selected.mode === "custom") {
      const accepted = await confirm({
        title: `Switch ${device.label} to ${selected.label}?`,
        description: "This is an externally routed HTTPS profile. Confirm its authentication and firewall policy before switching.",
        confirmLabel: "Stage switch",
      });
      if (!accepted) return;
    }
    await c.run(`switch-device-gateway-${device.id}`, "Gateway switch staged. Waiting for the controller.", async () => {
      const result = await c.api<unknown>(`/v1/devices/${encodeURIComponent(device.id)}/gateway`, {
        method: "PUT",
        body: { profileId: selected.id },
      });
      setGateway(normalizeGatewaySwitch(result, device.id));
      return result;
    });
  };

  const rollback = async () => {
    const accepted = await confirm({
      title: "Cancel this gateway switch?",
      description: "The controller will keep its last confirmed gateway profile. Any late acknowledgement for this request will be ignored.",
      confirmLabel: "Cancel switch",
    });
    if (!accepted) return;
    await c.run(`rollback-device-gateway-${device.id}`, "Gateway switch cancelled.", async () => {
      const result = await c.api<unknown>(`/v1/devices/${encodeURIComponent(device.id)}/gateway/rollback`, { method: "POST", body: {} });
      const next = normalizeGatewaySwitch(result, device.id);
      setGateway(next);
      setRequestedProfileId(next.activeProfile?.id ?? "");
      return result;
    });
  };

  if (loading) return <div className="device-settings-loading" role="status"><RefreshCw className="size-4 animate-spin" /> Loading gateway state…</div>;
  if (!profiles.length) return (
    <div className="device-gateway-empty">
      <Network className="size-5" /><h3>No gateway profiles</h3><p>Create a trusted LAN, Tailnet, or custom HTTPS profile in Settings before switching this controller.</p><a href="#settings">Open gateway profiles</a>
    </div>
  );
  const statusTone = gateway?.state === "failed" ? "danger" : gateway?.state === "pending" ? "warning" : "success";
  return (
    <div className="device-gateway-switch">
      <header>
        <div><div className="flex flex-wrap items-center gap-2"><h3>Controller gateway</h3><StatusBadge tone={statusTone} label={gateway?.state ?? "stable"} pulse={gateway?.state === "pending"} /></div><p>Switches are revisioned. The active route changes only after this controller acknowledges the exact request.</p></div>
        <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw className="size-3.5" /> Refresh</Button>
      </header>

      <div className="gateway-switch-status">
        <GatewaySwitchProfile label="Current" profile={gateway?.activeProfile ?? null} tone="success" />
        {gateway?.state !== "stable" ? <ArrowRight className="size-4 text-ink-faint" /> : null}
        {gateway?.state === "pending" ? <GatewaySwitchProfile label="Requested" profile={gateway.pendingProfile ?? null} tone="warning" /> : null}
        {gateway?.state === "failed" ? <GatewaySwitchProfile label="Failed request" profile={gateway.pendingProfile ?? gateway.previousProfile ?? null} tone="danger" /> : null}
      </div>

      {gateway?.state === "failed" ? <div className="gateway-switch-error" role="alert"><AlertTriangle className="size-4" /><div><strong>Controller kept the previous route</strong><p>{gateway.lastError ?? "The gateway switch failed without an error message."}</p></div></div> : null}
      {gateway?.state === "pending" ? <p className="gateway-switch-pending">Revision {gateway.revision} is waiting for this controller. It continues using {gateway.activeProfile?.label ?? "its current gateway"} until acknowledgement.</p> : null}

      <div className="gateway-switch-request">
        <Field label="Requested profile" htmlFor="device-gateway-profile">
          <select id="device-gateway-profile" value={requestedProfileId} onChange={(event) => setRequestedProfileId(event.target.value)}>
            <option value="">Choose a gateway profile</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label} · {profile.mode}</option>)}
          </select>
        </Field>
        <Button variant="primary" disabled={!selected || selected.id === gateway?.activeProfile?.id && gateway?.state === "stable"} busy={c.busyAction === `switch-device-gateway-${device.id}`} onClick={() => void stageSwitch()}>Stage switch</Button>
        {gateway?.state !== "stable" ? <Button variant="danger-ghost" busy={c.busyAction === `rollback-device-gateway-${device.id}`} onClick={() => void rollback()}><Undo2 className="size-3.5" /> Keep current</Button> : null}
      </div>
      {selected ? <div className="gateway-switch-risk" data-mode={selected.mode}><ShieldCheck className="size-4" /><div><strong>{selected.mode === "tailnet" ? "Private Tailnet route" : selected.mode === "custom" ? "External HTTPS route" : "Local network route"}</strong><code>{safeGatewayDisplayUrl(selected)}</code><p>{selected.mode === "tailnet" ? "The controller network must route into the Tailnet; ESP32 hardware does not run Tailscale directly." : selected.mode === "custom" ? "This origin may be internet reachable. Keep device authentication and upstream access controls enabled." : "The controller must remain on a LAN that can reach this private origin."}</p></div></div> : null}
    </div>
  );
}

function GatewaySwitchProfile({ label, profile, tone }: { label: string; profile: GatewayProfile | null; tone: "success" | "warning" | "danger" }) {
  return <div className="gateway-switch-profile"><span>{label}</span><strong>{profile?.label ?? "Not assigned"}</strong><code>{profile ? safeGatewayDisplayUrl(profile) : "—"}</code><StatusBadge tone={tone} label={profile?.mode ?? "none"} /></div>;
}

const deviceGatewayAccessOptions: Array<{
  id: DeviceGatewayAccessMode;
  label: string;
  description: string;
  icon: typeof Wifi;
}> = [
  {
    id: "local",
    label: "Local / LAN",
    description: "Direct access to the gateway on the controller's trusted network.",
    icon: Wifi,
  },
  {
    id: "tailscale",
    label: "Tailscale",
    description: "Advanced private routing into the gateway's Tailnet.",
    icon: ShieldCheck,
  },
  {
    id: "online",
    label: "Online HTTPS",
    description: "Public HTTPS through Funnel or another secured reverse proxy.",
    icon: Globe2,
  },
];

function deviceGatewayUrlPlaceholder(mode: DeviceGatewayAccessMode) {
  if (mode === "tailscale") return "https://gateway.tailnet.ts.net";
  if (mode === "online") return "https://gateway.example.com";
  return "http://192.168.1.25:3996";
}

function suggestedDeviceGatewayUrl(c: Controller, mode: DeviceGatewayAccessMode) {
  if (mode === "local") return c.remoteAccess?.gateway.lanUrls[0] ?? "";
  if (mode === "tailscale" && c.remoteAccess?.tailscale.mode === "serve") {
    return c.remoteAccess.tailscale.httpsUrl ?? "";
  }
  if (mode === "online") {
    const publicUrl = c.remoteAccess?.gateway.publicBaseUrl;
    if (publicUrl?.startsWith("https://")) return publicUrl;
    if (c.remoteAccess?.tailscale.mode === "funnel") return c.remoteAccess.tailscale.httpsUrl ?? "";
  }
  return "";
}

function DeviceGatewayAccessEditor({
  controller: c,
  config,
  onChange,
}: {
  controller: Controller;
  config: DeviceConfig;
  onChange: (value: DeviceConfig) => void;
}) {
  const mode = config.gatewayAccessMode ?? inferDeviceGatewayAccessMode(config.gatewayUrl ?? "");
  const urlValid = deviceGatewayUrlValid({ ...config, gatewayAccessMode: mode });
  const selectMode = (nextMode: DeviceGatewayAccessMode) => {
    if (nextMode === mode) return;
    onChange({
      ...config,
      gatewayAccessMode: nextMode,
      gatewayUrl: suggestedDeviceGatewayUrl(c, nextMode) || null,
    });
  };

  return (
    <section className="device-gateway-access sm:col-span-2" aria-labelledby="device-gateway-access-title">
      <div>
        <p id="device-gateway-access-title" className="ac-display text-sm">Gateway access</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          Choose how this controller reaches Agent Controller. The new URL is applied after the device completes its next config sync.
        </p>
      </div>

      <div className="environment-access-grid device-gateway-access__grid" role="radiogroup" aria-label="Gateway access path">
        {deviceGatewayAccessOptions.map((option) => {
          const Icon = option.icon;
          const selected = option.id === mode;
          return (
            <button
              key={option.id}
              type="button"
              className="environment-access-card"
              data-active={selected || undefined}
              role="radio"
              aria-checked={selected}
              onClick={() => selectMode(option.id)}
            >
              <span className="environment-access-card__icon"><Icon className="size-4" /></span>
              <strong>{option.label}</strong>
              <span>{option.description}</span>
            </button>
          );
        })}
      </div>

      <Field
        label="Controller gateway URL"
        htmlFor="edit-device-gateway-url"
        hint={mode === "local"
          ? "Leave empty to keep the URL already stored on the controller."
          : "Remote controller endpoints must use HTTPS."}
      >
        <input
          id="edit-device-gateway-url"
          type="url"
          value={config.gatewayUrl ?? ""}
          aria-invalid={!urlValid}
          onChange={(event) => onChange({ ...config, gatewayAccessMode: mode, gatewayUrl: event.target.value })}
          placeholder={deviceGatewayUrlPlaceholder(mode)}
        />
      </Field>

      {!urlValid ? <p className="device-gateway-access__error" role="alert">Enter a valid HTTPS gateway URL for this access path.</p> : null}
      <DeviceGatewayAccessGuide controller={c} mode={mode} />
    </section>
  );
}

function DeviceGatewayAccessGuide({ controller: c, mode }: { controller: Controller; mode: DeviceGatewayAccessMode }) {
  const remote = c.remoteAccess;
  const expectedTunnelMode = mode === "tailscale" ? "serve" : "funnel";
  const tunnelReady = mode !== "local"
    && remote?.tailscale.mode === expectedTunnelMode
    && remote.tailscale.ready;
  const command = mode === "local" ? null : buildGatewayTunnelSetupCommand(expectedTunnelMode);
  const copyCommand = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      c.setNotice({ tone: "success", message: "Gateway setup command copied." });
    } catch {
      c.setNotice({ tone: "danger", message: "Clipboard access was blocked. Select and copy the command manually." });
    }
  };

  if (mode === "local") {
    return (
      <div className="device-gateway-guide" data-tone="neutral">
        <Wifi className="size-4" />
        <div>
          <strong>Trusted local network</strong>
          <p>Use the gateway host's LAN address, not <code>127.0.0.1</code>. The gateway must listen on <code>0.0.0.0</code> for physical controllers.</p>
          {remote?.gateway.lanUrls[0] ? <code className="device-gateway-guide__url">{remote.gateway.lanUrls[0]}</code> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="device-gateway-guide" data-tone={mode === "online" ? "warning" : tunnelReady ? "success" : "info"} aria-live="polite">
      {mode === "online" ? <Globe2 className="size-4" /> : <ShieldCheck className="size-4" />}
      <div>
        <div className="device-gateway-guide__heading">
          <div>
            <strong>{mode === "online" ? "Public gateway access" : "Tailnet-routed access"}</strong>
            <span>{tunnelReady ? "Gateway tunnel ready" : "Gateway setup required"}</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            busy={c.busyAction === "refresh-device-remote-access"}
            onClick={() => void c.run(
              "refresh-device-remote-access",
              "Remote access status refreshed.",
              () => c.loadRemoteAccess(true),
            )}
          >
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        </div>
        {mode === "tailscale" ? (
          <p>ESP32 controllers do not join Tailscale directly. This path requires site-to-site or subnet routing from the controller's network into your Tailnet.</p>
        ) : (
          <p>Online mode is reachable from any network. Keep device authentication enabled and use Funnel or a secured HTTPS reverse proxy.</p>
        )}
        <div className="device-gateway-guide__command">
          <code>{command}</code>
          <Button size="sm" onClick={() => void copyCommand()}><Clipboard className="size-3.5" /> Copy setup</Button>
        </div>
      </div>
    </div>
  );
}

function DeviceControlsEditor({
  controller: c,
  device,
  actions,
  controls,
  firmware,
  loading,
  actionToAdd,
  onActionToAdd,
  onChange,
}: {
  controller: Controller;
  device: Device;
  actions: SavedAction[];
  controls: DeviceControls;
  firmware: DeviceFirmwarePolicy;
  loading: boolean;
  actionToAdd: string;
  onActionToAdd: (value: string) => void;
  onChange: (value: DeviceControls) => void;
}) {
  const [previewScreen, setPreviewScreen] = useState<"root" | "threads" | "thread-actions" | "response">("root");
  const [previewIndex, setPreviewIndex] = useState(0);
  const [responsePreviewPage, setResponsePreviewPage] = useState(0);
  const [previewThreadId, setPreviewThreadId] = useState(device.config?.threadId ?? "");
  const [savedLayoutSignature, setSavedLayoutSignature] = useState("");
  const capacity = controls.capacity ?? device.status?.limits?.menuItems ?? 8;
  const appliedRevision = controls.appliedRevision ?? controls.acknowledgedRevision ?? null;
  // A brand-new layout has never been acknowledged. Null is therefore pending, not equivalent to
  // the current revision; showing "Applied" here would make an offline controller look in sync.
  const pending = controls.revision > 0 && appliedRevision !== controls.revision;
  const assigned = new Set(controls.items.map((item) => item.actionId).filter(Boolean));
  const availableActions = actions.filter((action) => !assigned.has(action.id));
  const layoutSignature = JSON.stringify(controls.items.map((item) => [item.id, item.actionId, item.kind, item.label]));
  useEffect(() => {
    if (!loading) setSavedLayoutSignature(layoutSignature);
  }, [loading, controls.revision]);
  const draftChanged = Boolean(savedLayoutSignature && savedLayoutSignature !== layoutSignature);
  const labelFor = (item: DeviceControlItem) => item.label
    ?? actions.find((action) => action.id === item.actionId)?.label
    ?? (item.kind === "status" || item.id === "system_status" ? "Status" : item.kind === "stop" || item.id === "system_stop" ? "Stop run" : "Unavailable action");
  const incompatibility = (item: DeviceControlItem) => {
    if (item.enabled === false) return item.reason ?? "Unavailable for this controller";
    const action = actions.find((candidate) => candidate.id === item.actionId);
    if (action?.type !== "media") return null;
    const intentType = action.intent?.type ?? (action.payload?.mediaKind === "audio" ? "audio_prompt" : "camera_prompt");
    const features = device.status?.features ?? [];
    if (intentType === "camera_prompt" && features.length && !features.includes("camera")) return "Camera not reported by this device";
    if (intentType === "audio_prompt" && features.length && !features.includes("microphone")) return "Microphone not reported by this device";
    return null;
  };
  const move = (index: number, offset: number) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= controls.items.length) return;
    const items = [...controls.items];
    [items[index], items[nextIndex]] = [items[nextIndex], items[index]];
    onChange({ ...controls, items });
  };
  const add = () => {
    const action = actions.find((candidate) => candidate.id === actionToAdd);
    if (!action || controls.items.length >= capacity) return;
    const kind = action.type === "media"
      ? action.payload?.mediaKind === "audio" || action.intent?.type === "audio_prompt" ? "capture_audio" : "capture_image"
      : "remote_action";
    onChange({
      ...controls,
      items: [...controls.items, {
        kind,
        actionId: action.id,
        label: action.label,
        requiresThread: action.targetMode !== "fixed",
        requiresConfirmation: true,
      }],
    });
    onActionToAdd("");
  };
  const save = async () => {
    await c.run(`save-device-controls-${device.id}`, "Controller layout saved.", async () => {
      const result = await c.api<unknown>(`/v1/devices/${encodeURIComponent(device.id)}/controls`, {
        method: "PUT",
        body: { items: controls.items },
      });
      onChange(normalizeControlsResponse(result));
      await c.refreshAll();
      return result;
    });
  };
  const previewControls: DeviceControls = {
    ...controls,
    items: controls.items.map((item) => ({
      ...item,
      label: labelFor(item),
      enabled: incompatibility(item) ? false : item.enabled,
    })),
  };
  const availablePreviewThreads = (c.threads ?? []).slice(0, 12).map((thread) => ({
    id: thread.id,
    label: thread.label,
    status: thread.status,
    active: thread.id === device.config?.threadId,
  }));
  if (!availablePreviewThreads.length && device.config?.threadId) {
    availablePreviewThreads.push({
      id: device.config.threadId,
      label: `Thread ${device.config.threadId.slice(-11)}`,
      status: "idle",
      active: true,
    });
  }
  const rootPreview = buildControllerRootDisplay({
    selectedIndex: previewIndex,
    threadCount: availablePreviewThreads.length,
    firmware: {
      ...firmware,
      currentVersion: firmware.currentVersion ?? device.status?.firmwareVersion ?? null,
    },
  });
  const threadListPreview = buildControllerThreadsDisplay(availablePreviewThreads, previewIndex);
  const threadActionsPreview = buildControllerActionsDisplay({
    controls: previewControls,
    selectedIndex: previewIndex,
    threadId: previewThreadId || device.config?.threadId,
  });
  const selectedPreviewThread = (c.threads ?? []).find((thread) => thread.id === (previewThreadId || device.config?.threadId));
  const responsePreview = buildControllerResponseDisplay(selectedPreviewThread, previewControls, responsePreviewPage);
  const preview = previewScreen === "root"
    ? rootPreview
    : previewScreen === "threads" ? threadListPreview : threadActionsPreview;
  const previewThreadLabel = availablePreviewThreads.find((thread) => thread.id === previewThreadId)?.label
    ?? availablePreviewThreads.find((thread) => thread.active)?.label
    ?? "selected thread";
  useEffect(() => {
    setPreviewIndex((index) => Math.max(0, Math.min(index, preview.totalCount - 1)));
  }, [preview.totalCount, previewScreen]);
  const selectPreview = (offset: number) => {
    if (previewScreen === "response") {
      setResponsePreviewPage((page) => {
        const next = page + Math.sign(offset);
        if (next < 0) return responsePreview.pageCount - 1;
        if (next >= responsePreview.pageCount) return 0;
        return next;
      });
      return;
    }
    setPreviewIndex((index) => {
      if (!preview.totalCount) return 0;
      const next = index + offset;
      if (next < 0) return preview.totalCount - 1;
      if (next >= preview.totalCount) return 0;
      return next;
    });
  };
  const openPreviewRow = (rowId: string) => {
    const rowIndex = preview.allRows.findIndex((candidate) => candidate.id === rowId);
    if (rowIndex >= 0) setPreviewIndex(rowIndex);
    if (previewScreen === "root" && rowId === "system_threads") {
      const activeIndex = availablePreviewThreads.findIndex((thread) => thread.active);
      setPreviewIndex(activeIndex >= 0 ? activeIndex : 0);
      setPreviewScreen("threads");
    } else if (previewScreen === "threads") {
      setPreviewThreadId(rowId);
      setPreviewIndex(0);
      setPreviewScreen("thread-actions");
    } else if (previewScreen === "thread-actions" && rowId === "system_latest_response") {
      setResponsePreviewPage(0);
      setPreviewScreen("response");
    }
  };
  const previewLabelLimit = device.status?.limits?.labelCharacters ?? 18;
  const panelLabel = (value: string) => Array.from(value)
    .slice(0, previewLabelLimit)
    .map((character) => character >= " " && character <= "~" ? character : "?")
    .join("");
  const iconGlyph = { agent: "A", thread: "T", gateway: "G", action: ">", status: "S", stop: "!", firmware: "F" } as const;
  if (loading) return <div className="device-settings-loading" role="status"><RefreshCw className="size-4 animate-spin" /> Loading controller layout…</div>;
  return (
    <div className="controls-editor">
      <div className="controls-editor__heading">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3>Physical controls</h3>
            <StatusBadge label={`${controls.items.length}/${capacity} assigned`} tone={controls.items.length >= capacity ? "warning" : "neutral"} />
            <StatusBadge label="3 root items" tone="neutral" />
            <StatusBadge label={`${controls.items.length} thread actions`} tone="neutral" />
            {pending ? <StatusBadge label="Waiting for device" tone="warning" pulse /> : controls.revision > 0 ? <StatusBadge label={`Applied r${controls.revision}`} tone="success" /> : null}
          </div>
          <p>Choose the reusable actions shown after a person opens a thread. The root always contains only Threads, Gateway, and Firmware.</p>
        </div>
        <Button size="sm" variant="primary" busy={c.busyAction === `save-device-controls-${device.id}`} onClick={() => void save()}><Save className="size-3.5" /> Save layout</Button>
      </div>
      <div className="controls-editor__grid">
        <div>
          <div className="controls-add-row">
            <select aria-label="Action to add to opened threads" value={actionToAdd} onChange={(event) => onActionToAdd(event.target.value)} disabled={controls.items.length >= capacity}>
              <option value="">Choose a thread action</option>
              {availableActions.map((action) => <option key={action.id} value={action.id}>{action.label} · {action.type}</option>)}
            </select>
            <Button size="sm" disabled={!actionToAdd || controls.items.length >= capacity} onClick={add}><Plus className="size-3.5" /> Add</Button>
          </div>
          <ol className="control-list">
            {controls.items.map((item, index) => {
              const reason = incompatibility(item);
              const system = !item.actionId;
              return (
                <li key={item.id ?? item.actionId ?? `${item.kind}-${index}`} data-disabled={Boolean(reason) || undefined}>
                  <span className="control-list__position">{index + 1}</span>
                  <span className="control-list__copy"><strong>{labelFor(item)}</strong><small>{system ? "System control" : actions.find((action) => action.id === item.actionId)?.type ?? item.kind}{reason ? ` · ${reason}` : ""}</small></span>
                  <Button size="icon" variant="ghost" aria-label={`Move ${labelFor(item)} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp className="size-3.5" /></Button>
                  <Button size="icon" variant="ghost" aria-label={`Move ${labelFor(item)} down`} disabled={index === controls.items.length - 1} onClick={() => move(index, 1)}><ArrowDown className="size-3.5" /></Button>
                  <Button size="icon" variant="danger-ghost" aria-label={`Remove ${labelFor(item)}`} onClick={() => onChange({ ...controls, items: controls.items.filter((_, itemIndex) => itemIndex !== index) })}><X className="size-3.5" /></Button>
                </li>
              );
            })}
          </ol>
          {!controls.items.length ? <p className="control-list__empty">This controller has no assigned controls. Add an action, Status, or Stop.</p> : null}
        </div>
        <div className="controller-preview" aria-label="Controller display preview">
          <div className="controller-preview__heading">
            <div>
              <p className="ac-eyebrow">Physical display</p>
              <strong>{draftChanged ? "Draft preview" : pending ? "Saved preview" : "Applied preview"}</strong>
            </div>
            <StatusBadge
              label={draftChanged ? "Unsaved" : pending ? `r${controls.revision} pending` : controls.revision > 0 ? `r${controls.revision} synced` : "Not saved"}
              tone={draftChanged || pending ? "warning" : controls.revision > 0 ? "success" : "neutral"}
            />
          </div>
          <div className="controller-preview__views" role="group" aria-label="Preview screen">
            <button type="button" data-active={previewScreen === "root" || undefined} onClick={() => { setPreviewScreen("root"); setPreviewIndex(0); }}>Root</button>
            <button type="button" data-active={previewScreen === "threads" || undefined} onClick={() => { setPreviewScreen("threads"); setPreviewIndex(0); }}>Threads</button>
            <button type="button" data-active={previewScreen === "thread-actions" || undefined} onClick={() => { setPreviewScreen("thread-actions"); setPreviewIndex(0); }}>Thread actions</button>
            <button type="button" data-active={previewScreen === "response" || undefined} onClick={() => { setPreviewScreen("response"); setResponsePreviewPage(0); }}>Response</button>
          </div>
          <div className="controller-preview__screen" aria-label={previewScreen === "response" ? `${responsePreview.title}, page ${responsePreview.page} of ${responsePreview.pageCount}` : `${preview.title}, page ${preview.page} of ${preview.pageCount}`}>
            <aside className="controller-preview__rail" aria-label="Physical button rail">
              <span>MENU</span>
              <div>
                <button type="button" aria-label="Preview previous action" onClick={() => selectPreview(-1)}>^</button>
                <b>OK</b>
                <button type="button" aria-label="Preview next action" onClick={() => selectPreview(1)}>v</button>
              </div>
              <span>HOME</span>
            </aside>
            <div className="controller-preview__content">
              <header>
                <span className="controller-preview__icon" aria-hidden="true">&gt;</span>
                <strong>{previewScreen === "response" ? responsePreview.title : preview.title}</strong>
                <b>{previewScreen === "response" ? responsePreview.state : preview.state}</b>
              </header>
              {previewScreen === "response" ? (
                <div className="controller-preview__response">
                  {responsePreview.lines.map((line, index) => <p key={`${index}-${line}`}>{panelLabel(line)}</p>)}
                </div>
              ) : (
                <div className="controller-preview__rows">
                  {preview.rows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    data-selected={row.selected || undefined}
                    data-disabled={row.disabled || undefined}
                    aria-label={`Preview ${row.label}, ${row.meta}`}
                    onClick={() => openPreviewRow(row.id)}
                  >
                    <span className="controller-preview__cursor" aria-hidden="true">{row.selected ? ">" : row.disabled ? "x" : " "}</span>
                    <span className="controller-preview__icon" aria-hidden="true">{iconGlyph[row.icon]}</span>
                    <span>{panelLabel(row.label)}</span>
                    <b>{row.meta}</b>
                  </button>
                  ))}
                </div>
              )}
              <footer>{previewScreen === "response" ? (responsePreview.suggestions.length ? "ROTATE:PAGE OK:ACTIONS" : "ROTATE:PAGE OK:REFRESH") : "ROTATE:MOVE"}</footer>
            </div>
          </div>
          <div className="controller-preview__pager" aria-live="polite">
            <Button size="icon" variant="ghost" aria-label="Previous preview page" onClick={() => selectPreview(-3)}><ArrowLeft className="size-3.5" /></Button>
            <span>{previewScreen === "response" ? `Response page ${responsePreview.page}/${responsePreview.pageCount}` : `Simulated cursor ${preview.selectedIndex + 1}/${preview.totalCount} · page ${preview.page}/${preview.pageCount}`}</span>
            <Button size="icon" variant="ghost" aria-label="Next preview page" onClick={() => selectPreview(3)}><ArrowRight className="size-3.5" /></Button>
          </div>
          <small>
            {previewScreen === "root"
              ? "The root contains only Threads, Gateway, and Firmware. Reusable actions appear after a thread is opened."
              : previewScreen === "threads"
                ? "OK selects and opens a specific thread; EXIT returns to the root."
                : previewScreen === "thread-actions"
                  ? `${controls.items.length} assigned Action Library entries for ${previewThreadLabel}. Latest response is always first.`
                  : `The latest agent response is paged at 3 lines per screen. ${responsePreview.suggestions.length} validated follow-up actions are available through OK.`}
            {` The controller shows 3 rows per page and enforces its reported ${previewLabelLimit}-character label limit.`}
          </small>
        </div>
      </div>
    </div>
  );
}

function DeviceFirmwareEditor({
  controller: c,
  device,
  policy,
  loading,
  onChange,
  onOpenFlashGuide,
}: {
  controller: Controller;
  device: Device;
  policy: DeviceFirmwarePolicy;
  loading: boolean;
  onChange: (value: DeviceFirmwarePolicy) => void;
  onOpenFlashGuide: () => void;
}) {
  const save = async (next = policy, message = "Firmware policy saved.") => {
    await c.run(`save-firmware-policy-${device.id}`, message, async () => {
      const result = await c.api<unknown>(`/v1/devices/${encodeURIComponent(device.id)}/firmware-policy`, {
        method: "PUT",
        body: { channel: next.channel, updateMode: next.updateMode, desiredVersion: next.desiredVersion || null },
      });
      onChange(normalizeFirmwareResponse(result, device));
      await c.refreshAll();
      return result;
    });
  };
  if (loading) return <div className="device-settings-loading" role="status"><RefreshCw className="size-4 animate-spin" /> Loading firmware policy…</div>;
  const available = policy.availableVersions ?? [];
  const targetVersion = policy.latestVersion ?? available[0] ?? "";
  const statusTone = policy.lastError ? "danger" : policy.status === "verified" || policy.status === "current" ? "success" : policy.status ? "info" : "neutral";
  const updateHint = !targetVersion
    ? "Publish a compatible release before queueing an OTA update."
    : targetVersion === policy.currentVersion
      ? "This controller is already on the latest published release."
      : `Queues ${targetVersion}; the controller installs it on its next firmware check.`;
  return (
    <div className="firmware-editor">
      <div className="firmware-editor__hero">
        <span><HardDriveDownload className="size-5" /></span>
        <div>
          <p className="ac-eyebrow">Installed release</p>
          <h3>{policy.currentVersion ?? device.status?.firmwareVersion ?? "Unknown"}</h3>
          <p>{device.status?.hardwareModel ?? "Unreported hardware"} · protocol {device.status?.protocolVersion ?? "legacy"}</p>
        </div>
        <StatusBadge label={(policy.status ?? (targetVersion && targetVersion !== policy.currentVersion ? "update available" : "current")).replaceAll("_", " ")} tone={statusTone} pulse={policy.status === "downloading" || policy.status === "rebooting"} />
      </div>
      <button type="button" className="firmware-editor__guide" onClick={onOpenFlashGuide}>
        <Laptop className="size-5" />
        <span>
          <strong>Flash a local build</strong>
          <small>Build, sign, publish, and queue firmware from this codebase.</small>
        </span>
        <ArrowRight className="size-4" />
      </button>
      <div className="firmware-editor__fields">
        <Field label="Release channel" htmlFor="firmware-channel" hint="Beta receives pre-release builds intended for test controllers.">
          <select id="firmware-channel" value={policy.channel} onChange={(event) => onChange({ ...policy, channel: event.target.value as DeviceFirmwarePolicy["channel"] })}>
            <option value="stable">Stable</option><option value="beta">Beta</option>
          </select>
        </Field>
        <Field label="Update mode" htmlFor="firmware-mode">
          <select id="firmware-mode" value={policy.updateMode} onChange={(event) => onChange({ ...policy, updateMode: event.target.value as DeviceFirmwarePolicy["updateMode"] })}>
            <option value="manual">Manual</option><option value="notify">Notify me</option><option value="automatic">Automatic</option>
          </select>
        </Field>
        <Field label="Desired version" htmlFor="firmware-version" hint="The device verifies the signature and rolls back if its health check fails.">
          <select id="firmware-version" value={policy.desiredVersion ?? ""} onChange={(event) => onChange({ ...policy, desiredVersion: event.target.value || null })}>
            <option value="">No pinned version</option>
            {available.map((version) => <option key={version} value={version}>{version}</option>)}
            {policy.desiredVersion && !available.includes(policy.desiredVersion) ? <option value={policy.desiredVersion}>{policy.desiredVersion}</option> : null}
          </select>
        </Field>
      </div>
      {policy.releaseNotes ? <div className="firmware-editor__notes"><strong>Release notes</strong><p>{policy.releaseNotes}</p></div> : null}
      {policy.lastError ? <div className="firmware-editor__error"><strong>Last update failed</strong><p>{policy.lastError}</p></div> : null}
      <div className="firmware-editor__footer">
        <div className="firmware-editor__footer-copy">
          <span>{policy.lastUpdateAt ? `Last update ${formatRelativeTime(policy.lastUpdateAt)}` : "No update attempt reported"}</span>
          <small>{updateHint}</small>
        </div>
        <div className="firmware-editor__actions">
          <Button size="sm" onClick={() => void save()} busy={c.busyAction === `save-firmware-policy-${device.id}`}><Save className="size-3.5" /> Save policy</Button>
          <Button size="sm" variant="primary" disabled={!targetVersion || targetVersion === policy.currentVersion} onClick={() => {
            const next = { ...policy, desiredVersion: targetVersion };
            onChange(next);
            void save(next, `Firmware ${targetVersion} queued.`);
          }}><HardDriveDownload className="size-3.5" /> Queue update</Button>
        </div>
      </div>
    </div>
  );
}

function nextFirmwarePatch(currentVersion: string | null) {
  const match = currentVersion?.match(/^(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) return "0.2.1";
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function FirmwareFlashGuideModal({
  device,
  currentVersion,
  onBack,
}: {
  device: Device;
  currentVersion: string | null;
  onBack: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const releaseVersion = nextFirmwarePatch(currentVersion);
  const buildCommand = `AGENT_CONTROLLER_FIRMWARE_VERSION=${releaseVersion} \\
AGENT_CONTROLLER_OTA_VERIFY_KEY="$OTA_SIGNING_KEY" \\
pio run -d firmware/esp32-controller \\
  -e crowpanel-esp32-213-epaper-secure`;
  const publishCommand = `AGENT_CONTROLLER_URL=http://127.0.0.1:3996 \\
FIRMWARE_FILE=firmware/esp32-controller/.pio/build/crowpanel-esp32-213-epaper-secure/firmware.bin \\
FIRMWARE_VERSION=${releaseVersion} \\
FIRMWARE_CHANNEL=stable \\
node --env-file-if-exists=.env \\
  --env-file-if-exists=.env.local \\
  scripts/publish-firmware-release.mjs`;
  const usbCommand = `AGENT_CONTROLLER_FIRMWARE_VERSION=${releaseVersion} \\
AGENT_CONTROLLER_OTA_VERIFY_KEY="$OTA_SIGNING_KEY" \\
pio run -d firmware/esp32-controller \\
  -e crowpanel-esp32-213-epaper-secure -t upload`;
  const copyCommands = async () => {
    await navigator.clipboard.writeText([
      "# Build the OTA image",
      buildCommand,
      "",
      "# Publish the managed stable release",
      publishCommand,
      "",
      "# One-time USB bootstrap, only when OTA apply is unavailable",
      usbCommand,
    ].join("\n"));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  return (
    <ModalShell
      open
      size="large"
      title="Flash a local build"
      eyebrow="Firmware release guide"
      description={`${device.label} · ${device.status?.hardwareModel ?? "unreported hardware"}`}
      onClose={onBack}
      headerAction={<StatusBadge tone="info" label={`next ${releaseVersion}`} />}
      footer={(
        <>
          <Button variant="ghost" onClick={onBack}><ArrowLeft className="size-4" /> Back to firmware</Button>
          <Button onClick={() => void copyCommands()}>{copied ? <Check className="size-4" /> : <Clipboard className="size-4" />} {copied ? "Copied" : "Copy commands"}</Button>
        </>
      )}
    >
      <div className="firmware-flash-guide">
        <div className="firmware-flash-guide__intro">
          <ShieldCheck className="size-5" />
          <div>
            <strong>Release credentials stay in environment variables.</strong>
            <p>Run these commands from the repository root. Never paste the signing key or factory token into source files, command output, or the dashboard.</p>
          </div>
        </div>
        <ol className="firmware-flash-guide__steps">
          <li>
            <span>01</span>
            <div>
              <p className="eyebrow">Version</p>
              <h3>Choose a newer release</h3>
              <p>The controller is on <code>{currentVersion ?? "an unknown version"}</code>. This guide uses <code>{releaseVersion}</code>; OTA will not install a downgrade or rebuild with the same version.</p>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <p className="eyebrow">Build</p>
              <h3>Compile the OTA-enabled image</h3>
              <p>The verification key must match the gateway’s <code>OTA_SIGNING_KEY</code>. The value is read from your environment and is never shown here.</p>
              <pre><code>{buildCommand}</code></pre>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <p className="eyebrow">Publish</p>
              <h3>Add the binary to the stable catalog</h3>
              <p>The gateway stores the artifact, calculates its SHA-256 digest, and creates the signed manifest consumed by this hardware model.</p>
              <pre><code>{publishCommand}</code></pre>
            </div>
          </li>
          <li>
            <span>04</span>
            <div>
              <p className="eyebrow">Queue</p>
              <h3>Return to Firmware and queue {releaseVersion}</h3>
              <p>Select the stable channel, confirm <code>{releaseVersion}</code> appears under Desired version, then choose <strong>Queue update</strong>. This pins the release for this controller.</p>
            </div>
          </li>
          <li>
            <span>05</span>
            <div>
              <p className="eyebrow">Install</p>
              <h3>Reconnect or reboot the controller</h3>
              <p>A fresh gateway connection triggers an immediate firmware check. Otherwise, the controller checks periodically. Keep power connected through download, verification, write, and reboot.</p>
            </div>
          </li>
        </ol>
        <aside className="firmware-flash-guide__bootstrap">
          <AlertTriangle className="size-5" />
          <div>
            <strong>One-time USB bootstrap may be required</strong>
            <p>If the installed firmware was built with OTA application disabled, the dashboard cannot enable OTA remotely. Connect USB once and run:</p>
            <pre><code>{usbCommand}</code></pre>
          </div>
        </aside>
      </div>
    </ModalShell>
  );
}

function ModalShell({
  open,
  title,
  eyebrow,
  description,
  headerAction,
  footer,
  size = "default",
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  eyebrow: string;
  description?: string;
  headerAction?: ReactNode;
  footer?: ReactNode;
  size?: "default" | "large";
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal((
    <div
      className="device-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="device-modal-title"
        className="device-modal ac-fleet"
        data-size={size}
      >
        <header className="device-modal__header">
          <div className="min-w-0 flex-1">
            <p className="ac-eyebrow">{eyebrow}</p>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 id="device-modal-title" className="truncate ac-display text-lg">{title}</h2>
              {headerAction}
            </div>
            {description ? <p className="mt-1 truncate text-xs text-ink-muted">{description}</p> : null}
          </div>
          <button ref={closeRef} type="button" className="device-modal__close" aria-label="Close dialog" onClick={onClose}><X className="size-4" /></button>
        </header>
        <div className="device-modal__content">{children}</div>
        {footer ? <footer className="device-modal__footer">{footer}</footer> : null}
      </div>
    </div>
  ), document.body);
}
