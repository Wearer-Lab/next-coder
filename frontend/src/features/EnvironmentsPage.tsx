import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  Cable,
  Check,
  CheckCircle2,
  Clipboard,
  Clock3,
  CloudCog,
  FolderGit2,
  Globe2,
  KeyRound,
  Link2,
  Loader2,
  Laptop,
  Monitor,
  Network,
  Pencil,
  RefreshCw,
  Router,
  Save,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
  Users,
  Wifi,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { Controller } from "../controller";
import { connectorForEnvironment, environmentHealthLayers } from "../connectorHealth";
import { formatRelativeTime } from "../format";
import type {
  Connector,
  ConnectSession,
  ConnectSessionMint,
  Device,
  Environment,
  EnvironmentDependencies,
  GatewayProfile,
  RemoteAccessStatus,
} from "../types";
import { Button, Field, StatusBadge, cn, type StatusTone, useConfirm } from "../ui";
import { EnvironmentActionCluster } from "./FeatureActionClusters";
// The fleet half of the "intelligence design" system: hairline glass cards, the pixel display
// face and the metric strip, scoped to the Environments workspace.
import "./intelligence-fleet.css";

interface EnvironmentsPageProps {
  controller: Controller;
  connectOpen?: boolean;
  onConnectOpenChange?: (open: boolean) => void;
  editEnvironmentId?: string | null;
  onEditEnvironmentHandled?: () => void;
}

type CredentialType = "pairingToken" | "accessToken";
type EnvironmentTab = "connection" | "gateways" | "credential" | "health" | "workspace";
type EnvironmentAccessMode = "local" | "tailscale" | "online";
type EnvironmentComputerTarget = "this-computer" | "another-computer";

interface EnvironmentGateway {
  id: string;
  profileId: string | null;
  mode: EnvironmentAccessMode;
  label: string;
  url: string | null;
  users: Device[];
  detected: boolean;
}

const environmentAccessOptions: Array<{
  id: EnvironmentAccessMode;
  label: string;
  description: string;
  icon: typeof Network;
}> = [
  {
    id: "local",
    label: "Local / LAN",
    description: "Reach T3 on this computer or a trusted local network.",
    icon: Network,
  },
  {
    id: "tailscale",
    label: "Tailscale",
    description: "Private HTTPS access across your Tailnet. Recommended.",
    icon: ShieldCheck,
  },
  {
    id: "online",
    label: "Online HTTPS",
    description: "Connect through a secured public tunnel or reverse proxy.",
    icon: Globe2,
  },
];

function environmentAccessLabel(mode: EnvironmentAccessMode) {
  return environmentAccessOptions.find((option) => option.id === mode)?.label ?? "Local / LAN";
}

function environmentUrlPlaceholder(mode: EnvironmentAccessMode) {
  if (mode === "tailscale") return "https://machine.tailnet.ts.net";
  if (mode === "online") return "https://t3.example.com";
  return "http://127.0.0.1:3773";
}

function inferEnvironmentAccessMode(baseUrl: string | null | undefined): EnvironmentAccessMode {
  try {
    const parsed = new URL(baseUrl ?? "");
    const hostname = parsed.hostname.toLowerCase();
    if (hostname.endsWith(".ts.net")) return "tailscale";
    if (
      hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "::1"
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

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function environmentUrlValid(value: string, mode: EnvironmentAccessMode) {
  if (!isHttpUrl(value)) return false;
  if (mode === "local") return true;
  return new URL(value.trim()).protocol === "https:";
}

/**
 * Name a directly paired environment after the host in its URL.
 *
 * Only the direct/advanced path needs this. A connector reports the computer's own name when it
 * enrolls, but nothing on the direct path ever does, so without this every unnamed direct
 * environment would be called "T3 Code" and two of them would be indistinguishable.
 */
function hostLabelFromUrl(value: string): string | null {
  if (!isHttpUrl(value)) return null;
  const host = new URL(value.trim()).hostname.replace(/\.local$/iu, "");
  return host.length > 0 ? host : null;
}

function credentialExpired(environment: Environment): boolean {
  return Boolean(
    environment.status === "token_expired"
    || (environment.accessTokenExpiresAt && Date.parse(environment.accessTokenExpiresAt) <= Date.now()),
  );
}

function environmentStatus(environment: Environment, connector: Connector | null): { label: string; tone: StatusTone } {
  if ((environment.transportMode ?? "direct") === "connector") {
    if (connector?.revokedAt || connector?.status === "revoked") return { label: "connector revoked", tone: "danger" };
    if (connector?.status === "online" && environment.freshness !== "stale") return { label: "connector online", tone: "success" };
    if (connector?.status === "offline") return { label: "connector offline", tone: "danger" };
    if (connector?.status === "reconnecting" || environment.freshness === "stale") return { label: "stale · reconnecting", tone: "warning" };
    return { label: "waiting for connector", tone: "warning" };
  }
  if (credentialExpired(environment)) return { label: "token expired", tone: "danger" };
  if (environment.status === "reachable") return { label: "reachable", tone: "success" };
  if (environment.status === "unreachable" || environment.health?.lastError) {
    return { label: "unreachable", tone: "danger" };
  }
  if (environment.health?.lastReachableAt) return { label: "not checked", tone: "warning" };
  return { label: environment.status ?? "unchecked", tone: "neutral" };
}

function gatewayLabel(mode: EnvironmentAccessMode) {
  if (mode === "tailscale") return "Tailscale gateway";
  if (mode === "online") return "Online gateway";
  return "Local / LAN gateway";
}

function normalizeGatewayUrl(value: string | null | undefined) {
  return value?.trim().replace(/\/+$/u, "") || null;
}

function inferredDeviceGatewayMode(device: Device): EnvironmentAccessMode {
  return device.config?.gatewayAccessMode
    ?? inferEnvironmentAccessMode(device.config?.gatewayUrl ?? "");
}

function gatewayModeFromProfile(profile: GatewayProfile): EnvironmentAccessMode {
  if (profile.mode === "tailnet") return "tailscale";
  if (profile.mode === "custom") return "online";
  return "local";
}

export function environmentGatewayInventory(
  environmentId: string,
  devices: Device[],
  profiles: GatewayProfile[],
  remoteAccess: RemoteAccessStatus | null,
): EnvironmentGateway[] {
  const gateways = new Map<string, EnvironmentGateway>();
  const detectedUrls = new Set([
    ...(remoteAccess?.gateway.lanUrls ?? []),
    ...(remoteAccess?.gateway.loopbackUrl ? [remoteAccess.gateway.loopbackUrl] : []),
    ...(remoteAccess?.tailscale.ready && remoteAccess.tailscale.httpsUrl ? [remoteAccess.tailscale.httpsUrl] : []),
    ...(remoteAccess?.gateway.publicBaseUrl ? [remoteAccess.gateway.publicBaseUrl] : []),
  ].map((url) => normalizeGatewayUrl(url)?.toLowerCase()).filter(Boolean));
  const addGateway = ({
    id,
    profileId = null,
    mode,
    label,
    url,
    device,
    detected = false,
  }: {
    id?: string;
    profileId?: string | null;
    mode: EnvironmentAccessMode;
    label?: string;
    url?: string | null;
    device?: Device;
    detected?: boolean;
  }) => {
    const normalizedUrl = normalizeGatewayUrl(url);
    const gatewayId = id ?? normalizedUrl?.toLowerCase() ?? `device-managed:${mode}`;
    const existing = gateways.get(gatewayId) ?? {
      id: gatewayId,
      profileId,
      mode,
      label: label ?? gatewayLabel(mode),
      url: normalizedUrl,
      users: [],
      detected: false,
    };
    if (device && !existing.users.some((candidate) => candidate.id === device.id)) {
      existing.users.push(device);
    }
    existing.detected ||= detected;
    gateways.set(gatewayId, existing);
  };

  for (const profile of profiles) {
    const normalizedUrl = normalizeGatewayUrl(profile.baseUrl);
    addGateway({
      id: `profile:${profile.id}`,
      profileId: profile.id,
      mode: gatewayModeFromProfile(profile),
      label: profile.label,
      url: normalizedUrl,
      detected: Boolean(normalizedUrl && detectedUrls.has(normalizedUrl.toLowerCase())),
    });
  }

  for (const device of devices) {
    if (device.revokedAt || device.config?.environmentId !== environmentId) continue;
    const activeProfileId = device.gatewaySelection?.activeProfileId;
    if (activeProfileId && gateways.has(`profile:${activeProfileId}`)) {
      addGateway({
        id: `profile:${activeProfileId}`,
        profileId: activeProfileId,
        mode: gateways.get(`profile:${activeProfileId}`)?.mode ?? "local",
        device,
      });
      continue;
    }
    addGateway({
      mode: inferredDeviceGatewayMode(device),
      url: device.config?.gatewayUrl,
      device,
      label: activeProfileId ? "Unavailable gateway profile" : undefined,
    });
  }

  return [...gateways.values()].sort((left, right) => {
    const activeDifference = Number(right.users.length > 0) - Number(left.users.length > 0);
    if (activeDifference) return activeDifference;
    const modeOrder: Record<EnvironmentAccessMode, number> = { local: 0, tailscale: 1, online: 2 };
    return modeOrder[left.mode] - modeOrder[right.mode] || (left.url ?? "").localeCompare(right.url ?? "");
  });
}

export function EnvironmentsPage({
  controller: c,
  connectOpen = false,
  onConnectOpenChange,
  editEnvironmentId = null,
  onEditEnvironmentHandled,
}: EnvironmentsPageProps) {
  const confirm = useConfirm();
  const [internalConnectOpen, setInternalConnectOpen] = useState(false);
  const [editingEnvironment, setEditingEnvironment] = useState<Environment | null>(null);
  // Re-pairing reuses the connect flow rather than forking one: same command, same polling, but the
  // session carries this environment's id so the redemption updates it in place.
  const [repairEnvironment, setRepairEnvironment] = useState<Environment | null>(null);
  const activeConnectOpen = onConnectOpenChange ? connectOpen : internalConnectOpen;
  const archivedEnvironments = c.archivedEnvironments ?? [];

  useEffect(() => {
    if (!editingEnvironment) return;
    const current = c.environments.find((environment) => environment.id === editingEnvironment.id);
    if (!current) setEditingEnvironment(null);
    else if (current !== editingEnvironment) setEditingEnvironment(current);
  }, [c.environments, editingEnvironment?.id]);

  const setConnectOpen = (open: boolean) => {
    if (onConnectOpenChange) onConnectOpenChange(open);
    else setInternalConnectOpen(open);
  };

  const openEnvironment = (environment: Environment) => {
    c.setSelectedEnvironmentId(environment.id);
    setEditingEnvironment(environment);
  };

  useEffect(() => {
    if (!editEnvironmentId) return;
    const environment = c.environments.find((candidate) => candidate.id === editEnvironmentId);
    if (environment) openEnvironment(environment);
    onEditEnvironmentHandled?.();
  }, [editEnvironmentId]);

  const checkEnvironment = async (environment: Environment) => {
    await c.run(`check-environment-${environment.id}`, "Reachability check complete.", async () => {
      const result = await c.api(`/v1/t3/environments/${encodeURIComponent(environment.id)}/check`, {
        method: "POST",
        body: {},
      });
      await c.refreshAll();
      return result;
    });
  };

  const loadSnapshot = async (environment: Environment, closeEditor = false) => {
    c.setSelectedEnvironmentId(environment.id);
    if (closeEditor) setEditingEnvironment(null);
    await c.run(`environment-snapshot-${environment.id}`, "Workspace snapshot loaded.", () => c.loadSnapshot(environment.id));
  };

  const archiveEnvironment = async (environment: Environment) => {
    // Read the impact before asking: archiving also disables every saved action and
    // macro aimed at it, which the owner cannot see from this screen.
    let dependencies: EnvironmentDependencies | null = null;
    try {
      dependencies = await c.api(`/v1/t3/environments/${encodeURIComponent(environment.id)}/dependencies`) as EnvironmentDependencies;
    } catch {
      dependencies = null;
    }
    const accepted = await confirm({
      title: `Archive ${environment.label}?`,
      description: describeEnvironmentArchive(dependencies),
      confirmLabel: "Archive environment",
    });
    if (!accepted) return;
    await c.run("archive-environment", "Environment archived and disconnected.", async () => {
      const result = await c.api(`/v1/t3/environments/${encodeURIComponent(environment.id)}/archive`, {
        method: "POST",
        body: {},
      });
      setEditingEnvironment(null);
      await c.refreshAll();
      return result;
    });
  };

  const deleteEnvironment = async (environment: Environment) => {
    let dependencies: EnvironmentDependencies | null = null;
    if (!environment.archivedAt) {
      try {
        dependencies = await c.api(`/v1/t3/environments/${encodeURIComponent(environment.id)}/dependencies`) as EnvironmentDependencies;
      } catch {
        dependencies = null;
      }
    }
    const accepted = await confirm({
      title: `Remove ${environment.label}?`,
      description: describeEnvironmentDeletion(environment, dependencies),
      confirmLabel: "Remove environment",
      ...(dependencies && (dependencies.counts.devices + dependencies.counts.actions + dependencies.counts.macros + dependencies.counts.onboarding) > 0
        ? { requiredText: environment.label }
        : {}),
    });
    if (!accepted) return;
    await c.run(`delete-environment-${environment.id}`, "Environment removed. You can restore it during retention.", async () => {
      const result = await c.api(`/v1/t3/environments/${encodeURIComponent(environment.id)}`, {
        method: "DELETE",
        body: { confirmationLabel: environment.label },
      });
      setEditingEnvironment(null);
      await c.refreshAll();
      return result;
    });
  };

  const restoreEnvironment = async (environment: Environment) => {
    await c.run(`restore-environment-${environment.id}`, "Environment restored. Re-pair its connector to resume control.", async () => {
      const result = await c.api(`/v1/t3/environments/${encodeURIComponent(environment.id)}/restore`, { method: "POST", body: {} });
      await c.refreshAll();
      return result;
    });
  };

  return (
    <div className="environments-workspace ac-fleet">
      <section className="environments-overview" aria-labelledby="environments-heading">
        <div>
          <p className="ac-eyebrow">T3 control plane</p>
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="environments-heading" className="ac-display-title">
              {c.environments.length ? "Connected environments" : "Connect your first environment"}
            </h2>
            {c.environments.length ? <StatusBadge label={`${c.environments.length} paired`} /> : null}
          </div>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            {c.environments.length
              ? "Reachability, credentials, and live T3 workspace state across every paired host."
              : "Pair the workstation where T3 Code runs to load projects and dispatch agent work."}
          </p>
        </div>
      </section>

      <EnvironmentActionCluster className="environments-mobile-actions" onConnect={() => setConnectOpen(true)} />

      {c.environments.length ? (
        <section className="environment-grid" aria-label="T3 environment inventory">
          {c.environments.map((environment) => (
            <EnvironmentTile
              key={environment.id}
              environment={environment}
              connector={connectorForEnvironment(c.connectors, environment)}
              cloudConnection={c.connection}
              proofReady={Boolean(
                c.onboarding?.environmentId === environment.id
                && c.onboardingReadiness?.checks.firstRunCompleted,
              )}
              gateways={environmentGatewayInventory(environment.id, c.devices ?? [], c.gatewayProfiles ?? [], c.remoteAccess ?? null)}
              busyAction={c.busyAction}
              selected={environment.id === c.selectedEnvironmentId}
              onOpen={() => openEnvironment(environment)}
              onCheck={() => void checkEnvironment(environment)}
              onLoad={() => void loadSnapshot(environment)}
              onArchive={() => void archiveEnvironment(environment)}
              onDelete={() => void deleteEnvironment(environment)}
            />
          ))}
        </section>
      ) : (
        <section className="devices-empty environment-empty" aria-labelledby="empty-environments-title">
          <div className="devices-empty__signal environment-empty__signal" aria-hidden="true">
            <span />
            <Network className="size-6" />
          </div>
          <p className="ac-eyebrow">No T3 hosts paired</p>
          <h3 id="empty-environments-title" className="ac-display-title">Where does your agent work run?</h3>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-ink-muted">
            Run one short-lived connector command on the computer where T3 Code runs. No inbound port, public T3 URL, or cloud-stored T3 token is required.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={() => setConnectOpen(true)}><Cable className="size-4" /> Connect T3 Code</Button>
            <span className="environment-empty__hint"><ShieldCheck className="size-3.5" /> Encrypted at rest</span>
          </div>
        </section>
      )}

      {archivedEnvironments.length ? (
        <section className="environment-archive" aria-labelledby="archived-environments-heading">
          <div className="environment-archive__heading">
            <div>
              <p className="ac-eyebrow">Disconnected</p>
              <h3 id="archived-environments-heading" className="ac-display text-base">Archived environments</h3>
            </div>
            <StatusBadge label={`${archivedEnvironments.length} archived`} />
          </div>
          <div className="environment-archive__list">
            {archivedEnvironments.map((environment) => (
              <article key={environment.id} className="environment-archive__row">
                <span className="environment-archive__icon" aria-hidden="true"><Archive className="size-4" /></span>
                <span className="environment-archive__copy">
                  <strong>{environment.label}</strong>
                  <span>Removed {formatRelativeTime(environment.deletedAt ?? environment.archivedAt)} · recoverable until {formatRelativeTime(environment.purgeAfter)}</span>
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  busy={c.busyAction === `restore-environment-${environment.id}`}
                  onClick={() => void restoreEnvironment(environment)}
                >
                  <ArchiveRestore className="size-3.5" /> Restore
                </Button>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <ConnectEnvironmentDialog
        controller={c}
        open={activeConnectOpen || Boolean(repairEnvironment)}
        environment={repairEnvironment}
        onClose={() => {
          setRepairEnvironment(null);
          setConnectOpen(false);
        }}
      />

      <EnvironmentEditorDialog
        controller={c}
        environment={editingEnvironment}
        onClose={() => setEditingEnvironment(null)}
        onCheck={() => editingEnvironment && void checkEnvironment(editingEnvironment)}
        onLoad={() => editingEnvironment && void loadSnapshot(editingEnvironment, true)}
        onArchive={() => editingEnvironment && void archiveEnvironment(editingEnvironment)}
        onRemove={() => editingEnvironment && void deleteEnvironment(editingEnvironment)}
        onRepair={() => {
          setRepairEnvironment(editingEnvironment);
          setEditingEnvironment(null);
        }}
      />
    </div>
  );
}

function describeEnvironmentArchive(preview: EnvironmentDependencies | null): string {
  const credential = "Archiving permanently deletes the stored T3 credential, stops live workspace loading, and moves the environment to Archive.";
  if (!preview) return `${credential} Devices, saved actions, macros, and onboarding that point at it will be cleared or disabled.`;
  const impacts: string[] = [];
  if (preview.counts.devices) impacts.push(countLabel(preview.counts.devices, "device default", "device defaults"));
  if (preview.counts.actions) impacts.push(countLabel(preview.counts.actions, "saved action", "saved actions"));
  if (preview.counts.macros) impacts.push(countLabel(preview.counts.macros, "macro", "macros"));
  if (preview.dependencies.onboarding) impacts.push("your onboarding selection");
  if (impacts.length === 0) return `${credential} Nothing else currently points at this environment.`;
  const disabled = preview.counts.actions || preview.counts.macros
    ? " Saved actions and macros that target it are disabled until you re-save them against another environment."
    : "";
  return `${credential} It also clears ${joinList(impacts)}.${disabled}`;
}

function describeEnvironmentDeletion(environment: Environment, preview: EnvironmentDependencies | null): string {
  if (environment.archivedAt) {
    return "This environment is already removed and remains recoverable until its retention deadline.";
  }
  return `${describeEnvironmentArchive(preview)} The credential-free record is retained temporarily so you can restore and re-pair it.`;
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function EnvironmentTile({
  environment,
  connector,
  cloudConnection,
  proofReady,
  gateways,
  busyAction,
  selected = false,
  onOpen,
  onCheck,
  onLoad,
  onArchive,
  onDelete,
}: {
  environment: Environment;
  connector: Connector | null;
  cloudConnection: Controller["connection"];
  proofReady: boolean;
  gateways: EnvironmentGateway[];
  busyAction: string | null;
  selected?: boolean;
  onOpen: () => void;
  onCheck: () => void;
  onLoad: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const status = environmentStatus(environment, connector);
  const stop = (callback: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    callback();
  };
  return (
    <article
      className="device-tile environment-tile"
      data-selected={selected || undefined}
      data-tone={status.tone}
      onClick={onOpen}
    >
      <button type="button" className="device-tile__header" aria-label={`Open ${environment.label}`} onClick={stop(onOpen)}>
        <div className="device-tile__glyph environment-tile__glyph"><Server className="size-5" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate ac-display text-[1.0625rem]">{environment.label}</h3>
            <StatusBadge tone={status.tone} label={status.label} />
          </div>
          <p className="mt-1 truncate text-xs text-ink-muted">
            {(environment.transportMode ?? "direct") === "connector" ? "Outbound connector" : environment.baseUrl}
          </p>
        </div>
        <ArrowRight className="device-tile__open size-4" />
      </button>

      <dl className="device-tile__metrics environment-tile__metrics">
        <EnvironmentMetric label="Last checked" value={formatRelativeTime(environment.health?.lastCheckedAt)} />
        <EnvironmentMetric label="Last reachable" value={formatRelativeTime(environment.health?.lastReachableAt)} />
        <EnvironmentMetric
          label={(environment.transportMode ?? "direct") === "connector" ? "Connector seen" : "Credential"}
          value={(environment.transportMode ?? "direct") === "connector"
            ? formatRelativeTime(connector?.lastSeenAt ?? environment.lastConnectorSeenAt)
            : environment.accessTokenExpiresAt ? formatRelativeTime(environment.accessTokenExpiresAt) : "No known expiry"}
          tone={(environment.transportMode ?? "direct") === "direct" && credentialExpired(environment) ? "danger" : undefined}
        />
        <EnvironmentMetric label="Projection" value={`${environment.freshness ?? "unknown"} · ${formatRelativeTime(environment.lastProjectionAt ?? environment.health?.lastCheckedAt)}`} />
        <EnvironmentMetric label="Projects" value={environment.health?.snapshot?.line1 ?? "Not loaded"} />
        <EnvironmentMetric label="Sessions" value={environment.health?.snapshot?.line2 ?? "Not loaded"} />
      </dl>

      {environment.health?.lastError ? (
        <p className="environment-tile__error" title={environment.health.lastError}>{environment.health.lastError}</p>
      ) : null}

      <EnvironmentHealthStack
        environment={environment}
        connector={connector}
        cloudConnection={cloudConnection}
        proofReady={proofReady}
        compact
      />

      <EnvironmentGatewaySummary gateways={gateways} />

      <div className="device-tile__actions environment-tile__actions">
        <Button
          size="sm"
          busy={busyAction === `environment-snapshot-${environment.id}`}
          onClick={stop(onLoad)}
        >
          <CloudCog className="size-3.5" /> Load snapshot
        </Button>
        <Button
          size="sm"
          busy={busyAction === `check-environment-${environment.id}`}
          onClick={stop(onCheck)}
        >
          <RefreshCw className="size-3.5" /> Check
        </Button>
        <div className="environment-tile__management-actions">
          <Button size="sm" aria-label={`Edit ${environment.label}`} onClick={stop(onOpen)}>
            <Pencil className="size-3.5" /> Edit
          </Button>
          <Button
            size="sm"
            aria-label={`Archive ${environment.label}`}
            busy={busyAction === "archive-environment"}
            onClick={stop(onArchive)}
          >
            <Archive className="size-3.5" /> Archive
          </Button>
          <Button
            size="sm"
            variant="danger-ghost"
            aria-label={`Delete ${environment.label}`}
            busy={busyAction === `delete-environment-${environment.id}`}
            onClick={stop(onDelete)}
          >
            <Trash2 className="size-3.5" /> Delete
          </Button>
        </div>
      </div>
    </article>
  );
}

function GatewayIcon({ mode, className }: { mode: EnvironmentAccessMode; className?: string }) {
  const Icon = mode === "tailscale" ? ShieldCheck : mode === "online" ? Globe2 : Router;
  return <Icon className={className} />;
}

function gatewayUsersLabel(users: Device[]) {
  if (!users.length) return "No devices assigned";
  if (users.length === 1) return users[0].label;
  const visible = users.slice(0, 2).map((device) => device.label).join(", ");
  return users.length > 2 ? `${visible} +${users.length - 2}` : visible;
}

function EnvironmentGatewaySummary({ gateways }: { gateways: EnvironmentGateway[] }) {
  const activeCount = gateways.filter((gateway) => gateway.users.length > 0).length;
  const visibleGateways = gateways.slice(0, 3);
  return (
    <section className="environment-tile__gateways" aria-label="Controller gateways">
      <div className="environment-tile__gateways-heading">
        <span><Router className="size-3.5" /> Controller gateways</span>
        <strong>{activeCount ? `${activeCount} active` : "None active"}</strong>
      </div>
      {visibleGateways.length ? (
        <div className="environment-tile__gateway-list">
          {visibleGateways.map((gateway) => (
            <div key={gateway.id} className="environment-tile__gateway" data-active={gateway.users.length > 0 || undefined}>
              <GatewayIcon mode={gateway.mode} className="size-3.5" />
              <div>
                <strong>{gateway.label}</strong>
                <span title={gatewayUsersLabel(gateway.users)}>{gatewayUsersLabel(gateway.users)}</span>
              </div>
              <small>{gateway.users.length ? "Active" : gateway.detected ? "Available" : "Not detected"}</small>
            </div>
          ))}
          {gateways.length > visibleGateways.length ? (
            <p className="environment-tile__gateway-more">+{gateways.length - visibleGateways.length} more in details</p>
          ) : null}
        </div>
      ) : (
        <p className="environment-tile__gateway-empty">No gateway endpoints or attached devices detected.</p>
      )}
    </section>
  );
}

function EnvironmentMetric({ label, value, tone }: { label: string; value: ReactNode; tone?: "danger" }) {
  return (
    <div className="device-tile__metric ac-stat">
      <dt className="ac-stat__label">{label}</dt>
      <dd className={cn("ac-stat__value", tone === "danger" && "text-danger")}>{value}</dd>
    </div>
  );
}

export function EnvironmentHealthStack({
  environment,
  connector,
  cloudConnection,
  proofReady = false,
  compact = false,
}: {
  environment: Environment;
  connector: Connector | null;
  cloudConnection: Controller["connection"];
  proofReady?: boolean;
  compact?: boolean;
}) {
  const layers = environmentHealthLayers({ environment, connector, cloudConnection, proofReady });
  return (
    <section className={cn("environment-health-stack", compact && "environment-health-stack--compact")} aria-label="Connection health">
      <div className="environment-health-stack__heading">
        <span>Connection path</span>
        <small>{environment.freshness === "stale" ? "Cached projection" : "Layered evidence"}</small>
      </div>
      <div className="environment-health-stack__layers">
        {layers.map((item) => (
          <div key={item.key} className="environment-health-layer" data-tone={item.tone} data-stale={item.stale || undefined}>
            <span className="environment-health-layer__dot" aria-hidden="true" />
            <span>
              <strong>{item.label}</strong>
              <small>{item.state}{item.stale ? " · stale" : ""}</small>
            </span>
            {!compact ? (
              <span className="environment-health-layer__detail">
                {item.detail}
                {item.observedAt ? ` Last observed ${formatRelativeTime(item.observedAt)}.` : ""}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

// How often the console asks the gateway whether the host has redeemed the code yet. The first poll
// fires immediately after minting, so a host that was already waiting resolves without a delay.
const CONNECT_POLL_INTERVAL_MS = 2500;

/**
 * Console-first pairing.
 *
 * The old flow ended by asking the browser for a credential the user had to carry over from another
 * machine. This one never does: the console mints an enrollment code, shows the single command it
 * belongs to, and waits. Self-hosted deployments retain `POST /v1/t3/environments` as the manual
 * fallback for a T3 host with no outbound route to the gateway; managed cloud never renders it.
 *
 * Passing `environment` turns this into a re-pair. The session then carries that environment's id,
 * so redeeming updates the row in place — a host that moved to a new URL must not become a second
 * environment.
 */
export function ConnectEnvironmentDialog({
  controller: c,
  open,
  environment = null,
  onClose,
  onConnected,
}: {
  controller: Controller;
  open: boolean;
  environment?: Environment | null;
  onClose: () => void;
  onConnected?: (environment: Environment) => void;
}) {
  const repairing = Boolean(environment);
  const cloudDeployment = c.authConfig?.deploymentMode === "cloud";
  const [step, setStep] = useState(0);
  // Empty, not a guess. The previous default was the literal string "Mac T3 Code", so a Windows
  // or Linux host enrolled under a Mac's name and a second workspace was indistinguishable from
  // the first. Left blank, the connector's own host-derived name is used instead.
  const [label, setLabel] = useState("");
  const [computerTarget, setComputerTarget] = useState<EnvironmentComputerTarget>("this-computer");
  const [directAccessMode, setDirectAccessMode] = useState<EnvironmentAccessMode>("local");
  const [mint, setMint] = useState<ConnectSessionMint | null>(null);
  const [session, setSession] = useState<ConnectSession | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [credentialType, setCredentialType] = useState<CredentialType>("pairingToken");
  const [result, setResult] = useState<Environment | null>(null);
  const mintedForRef = useRef<string | null>(null);
  const steps = ["Purpose", "Computer", "Connect"];

  useEffect(() => {
    if (!open) return;
    // Re-pairing already knows the answers to the first two steps, so it starts on the command and
    // pre-fills both from the environment rather than asking again.
    setStep(repairing ? 2 : 0);
    setLabel(environment?.label ?? "");
    setComputerTarget("this-computer");
    setDirectAccessMode(environment ? inferEnvironmentAccessMode(environment.baseUrl) : "local");
    setMint(null);
    setSession(null);
    setMintError(null);
    setManual(false);
    setBaseUrl(environment?.baseUrl ?? "");
    setCredential("");
    setCredentialType("pairingToken");
    setResult(null);
    mintedForRef.current = null;
  }, [open, environment?.id]);

  const startSession = useCallback(async () => {
    const key = `${label.trim()}|${computerTarget}|${environment?.id ?? ""}`;
    mintedForRef.current = key;
    setMintError(null);
    setSession(null);
    try {
      const created = await c.createConnectSession({
        label: label.trim() || "T3 Code",
        environmentId: environment?.id ?? null,
      });
      setMint(created);
      setSession(created.session);
    } catch (error) {
      // Keep this attempt recorded across controller renders. A failed mint needs an explicit
      // retry; clearing the key here turns each error/connection update into another POST.
      setMint(null);
      // Self-hosted deployments can fall back to direct credentials. Managed cloud deliberately
      // keeps that trust boundary closed, so a mint failure remains an actionable connector error.
      setMintError(error instanceof Error ? error.message : "Could not create a connect command.");
      if (!cloudDeployment) setManual(true);
    }
  }, [c, label, computerTarget, environment?.id, cloudDeployment]);

  useEffect(() => {
    if (!open || step !== 2 || result) return;
    const key = `${label.trim()}|${computerTarget}|${environment?.id ?? ""}`;
    if (mintedForRef.current === key) return;
    void startSession();
  }, [open, step, result, label, computerTarget, environment?.id, startSession]);

  const waiting = Boolean(mint) && (session?.status === "pending" || session?.status === "redeeming");

  useEffect(() => {
    if (!open || step !== 2 || result || !mint || !waiting) return;
    let active = true;
    const poll = async () => {
      try {
        const polled = await c.fetchConnectSession(mint.session.id);
        if (!active) return;
        setSession(polled.session);
        if (polled.session.status === "completed" && polled.environment) {
          setResult(polled.environment);
          c.setSelectedEnvironmentId(polled.environment.id);
          c.markEnvironmentCredentialChanged();
          await c.refreshAll();
          onConnected?.(polled.environment);
        }
      } catch {
        // A transient poll failure is not worth surfacing; the next tick retries.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), CONNECT_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [open, step, result, mint?.session.id, waiting, onConnected]);

  if (!open) return null;

  // A blank label is a valid choice, not an incomplete form: it means "use the computer's own
  // name". The connector reports that name at enrollment; on the direct path, where no connector
  // ever speaks, the host from the URL is a better guess than a generic fallback.
  const manualValid = Boolean(environmentUrlValid(baseUrl, directAccessMode) && credential.trim());
  const canContinue = true;

  const connectManually = async () => {
    if (cloudDeployment) return;
    const saved = await c.run("pair-environment", "T3 environment connected.", async () => {
      const body = {
        label: label.trim() || hostLabelFromUrl(baseUrl) || "T3 Code",
        baseUrl: baseUrl.trim(),
        [credentialType]: credential.trim(),
      };
      // Re-pairing updates in place here too. Creating a second row for a host that already exists
      // is the one outcome this flow must never produce, whichever path the user took.
      const response = environment
        ? await c.api<{ environment: Environment }>(`/v1/t3/environments/${encodeURIComponent(environment.id)}`, { method: "PUT", body })
        : await c.api<{ environment: Environment }>("/v1/t3/environments", { method: "POST", body });
      setCredential("");
      c.markEnvironmentCredentialChanged();
      await c.refreshAll();
      c.setSelectedEnvironmentId(response.environment.id);
      return response;
    });
    if (saved) setResult(saved.environment);
  };

  const currentResultEnvironment = result
    ? c.environments.find((candidate) => candidate.id === result.id) ?? result
    : null;
  const currentResultConnector = currentResultEnvironment
    ? connectorForEnvironment(c.connectors, currentResultEnvironment)
    : null;
  const resultProofReady = Boolean(
    result
      && c.onboarding?.environmentId === result.id
      && c.onboardingReadiness?.checks.firstRunCompleted,
  );
  const resultLayers = currentResultEnvironment
    ? environmentHealthLayers({
        environment: currentResultEnvironment,
        connector: currentResultConnector,
        cloudConnection: c.connection,
        proofReady: resultProofReady,
      })
    : [];
  const resultReady = resultLayers.length > 0 && resultLayers.every((layer) => (
    !layer.stale && ["operational", "online", "direct", "ready", "complete"].includes(layer.state)
  ));
  const title = result
    ? (resultReady ? "Environment ready" : repairing ? "Environment re-enrolled" : "Connector enrolled")
    : (repairing ? `Re-pair ${environment?.label}` : "Connect T3 Code");

  return (
    <EnvironmentModalShell
      open
      title={title}
      eyebrow={result ? (resultReady ? "End-to-end proof complete" : "Enrollment complete") : repairing ? "Environment recovery" : "Environment onboarding"}
      description={result
        ? ((result.transportMode ?? "direct") === "connector" ? "Outbound connector enrolled" : result.baseUrl ?? "Direct environment connected")
        : "Pair the computer that owns your projects and agent sessions."}
      onClose={onClose}
      footer={result ? (
        <Button variant="primary" onClick={onClose}>
          {resultReady ? <Check className="size-4" /> : <ArrowRight className="size-4" />}
          {resultReady ? "Done" : "Continue setup"}
        </Button>
      ) : (
        <>
          <Button variant="ghost" onClick={step === 0 ? onClose : () => setStep((current) => current - 1)}>
            {step === 0 ? "Cancel" : <><ArrowLeft className="size-4" /> Back</>}
          </Button>
          {step === steps.length - 1 ? (
            manual && !cloudDeployment ? (
              <Button
                variant="primary"
                busy={c.busyAction === "pair-environment"}
                disabled={!manualValid}
                onClick={() => void connectManually()}
              >
                {repairing ? "Save credential" : "Connect environment"}
              </Button>
            ) : null
          ) : (
            <Button variant="primary" disabled={!canContinue} onClick={() => setStep((current) => current + 1)}>
              Continue <ArrowRight className="size-4" />
            </Button>
          )}
        </>
      )}
    >
      {result ? (
        <div className="device-flow__result">
          <div className="device-flow__result-check"><Check className="size-6" /></div>
          <h3>{resultReady
            ? "Cloud-to-agent path verified"
            : (result.transportMode ?? "direct") === "connector" ? "Connector credential enrolled" : "Host credential saved"}</h3>
          <p>{(result.transportMode ?? "direct") === "connector"
            ? (resultReady
                ? "The connector, local T3 provider, and first agent action have all supplied current evidence."
                : "Enrollment is only the first layer. Keep the command running, then verify local T3, a provider, and the first agent action before treating setup as ready.")
            : (resultReady
                ? "The direct host and first agent action have supplied current readiness evidence."
                : "The credential is saved. Verify T3, a provider, and the first agent action before treating setup as ready.")}</p>
          <dl>
            <EnvironmentReviewRow label="Environment" value={result.label} />
            <EnvironmentReviewRow label="Environment ID" value={result.id} mono />
            <EnvironmentReviewRow label="Transport" value={(result.transportMode ?? "direct") === "connector" ? "Outbound connector" : "Advanced direct mode"} />
            {result.baseUrl ? <EnvironmentReviewRow label="Endpoint" value={result.baseUrl} mono /> : null}
          </dl>
          <EnvironmentHealthStack
            environment={currentResultEnvironment ?? result}
            connector={currentResultConnector}
            cloudConnection={c.connection}
            proofReady={resultProofReady}
          />
        </div>
      ) : (
        <>
          <EnvironmentStepper steps={steps} current={step} />
          <div className="device-flow__body">
            {step === 0 ? <EnvironmentIntro /> : null}
            {step === 1 ? (
              <div className="environment-flow__access">
                <div>
                  <h3 className="ac-display text-base">Where will you run the connector?</h3>
                  <p className="mt-1 text-sm text-ink-muted">Both choices create the same secure outbound connection. Only the handoff instructions differ.</p>
                </div>
                <Field
                  label="Environment label"
                  htmlFor="connect-environment-label"
                  hint="Leave blank to use the computer's own name, which the connector reports when it enrolls."
                >
                  <input
                    id="connect-environment-label"
                    autoFocus
                    value={label}
                    placeholder="This computer's name"
                    onChange={(event) => setLabel(event.target.value)}
                  />
                </Field>
                <EnvironmentComputerSelector value={computerTarget} onChange={setComputerTarget} />
              </div>
            ) : null}
            {step === 2 ? (
              <div className="environment-flow__form">
                <ConnectHandoff
                  mint={mint}
                  session={session}
                  error={mintError}
                  repairing={repairing}
                  computerTarget={computerTarget}
                  onRetry={() => void startSession()}
                />
                {!cloudDeployment ? (
                  <ConnectManualFallback
                    controller={c}
                    open={manual}
                    onToggle={() => setManual((current) => !current)}
                    accessMode={directAccessMode}
                    onAccessModeChange={setDirectAccessMode}
                    baseUrl={baseUrl}
                    onBaseUrlChange={setBaseUrl}
                    credential={credential}
                    onCredentialChange={setCredential}
                    credentialType={credentialType}
                    onCredentialTypeChange={setCredentialType}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        </>
      )}
    </EnvironmentModalShell>
  );
}

function ConnectHandoff({
  mint,
  session,
  error,
  repairing,
  computerTarget,
  onRetry,
}: {
  mint: ConnectSessionMint | null;
  session: ConnectSession | null;
  error: string | null;
  repairing: boolean;
  computerTarget: EnvironmentComputerTarget;
  onRetry: () => void;
}) {
  const status = session?.status ?? "pending";
  const dead = status === "expired" || status === "failed";
  const [directAgents, setDirectAgents] = useState(false);
  const [agentsFile, setAgentsFile] = useState("");
  const quotePath = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

  if (error) {
    return (
      <section className="environment-connect-handoff" data-tone="danger" aria-label="Connect command">
        <div className="environment-connect-handoff__heading">
          <ShieldCheck className="size-4" />
          <div>
            <strong>Could not create a connect command</strong>
            <span>{error}</span>
          </div>
        </div>
        <p>Check the gateway connection, then request a new connect command.</p>
        <Button size="sm" onClick={onRetry}><RefreshCw className="size-3.5" /> Try again</Button>
      </section>
    );
  }

  if (!mint) {
    return (
      <section className="environment-connect-handoff" data-tone="neutral" aria-label="Connect command">
        <p role="status">Preparing your connect command…</p>
      </section>
    );
  }

  return (
    <section className="environment-connect-handoff" data-tone={dead ? "danger" : "info"} aria-label="Connect command">
      <div className="environment-connect-handoff__heading">
        <Terminal className="size-4" />
        <div>
          <strong>{computerTarget === "this-computer" ? "Run this on this computer" : "Run this on the other computer"}</strong>
          <span>
            {repairing
              ? "It replaces the revoked or stale connector binding and updates this environment in place."
              : "It enrolls the published connector and opens an outbound connection to Next Coder."}
          </span>
        </div>
      </div>
      <Field label="Agent connection" htmlFor="connect-agent-connection">
        <select id="connect-agent-connection" value={directAgents ? "direct" : "t3"} onChange={(event) => setDirectAgents(event.target.value === "direct")}>
          <option value="t3">T3 Code</option>
          <option value="direct">Codex, Claude and ACP directly</option>
        </select>
      </Field>
      {directAgents ? <Field label="Agent configuration file on that computer" htmlFor="connect-agents-file">
        <input id="connect-agents-file" value={agentsFile} onChange={(event) => setAgentsFile(event.target.value)} placeholder="/path/to/agents.json" />
        <p>Use a connector build with direct-agent support. The local JSON file selects agents and project folders; T3 is optional.</p>
      </Field> : null}
      {directAgents && !agentsFile.trim() ? <p>Enter the configuration file path to prepare the command.</p> : <CopyableSyntax value={directAgents ? `${mint.command} --agents-file ${quotePath(agentsFile.trim())}` : mint.command} label="connect command" />}
      {dead ? (
        <>
          <p role="alert">
            {status === "expired"
              ? "This connect code expired before the host used it."
              : `Pairing failed on the host: ${session?.error ?? "unknown error"}`}
          </p>
          <Button size="sm" onClick={onRetry}><RefreshCw className="size-3.5" /> Get a new command</Button>
        </>
      ) : (
        <div className="environment-connect-handoff__waiting">
          <p role="status">
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {status === "redeeming" ? "Connector found. Finishing enrollment…" : "Waiting for the connector…"}
          </p>
          <Button size="sm" variant="ghost" onClick={onRetry}><RefreshCw className="size-3.5" /> Regenerate command</Button>
        </div>
      )}
      <small>
        Enrollment code: {mint.code} · Expires {formatRelativeTime(mint.session.expiresAt)}. The code is single use;
        T3 and provider credentials stay on this computer and are never sent to Next Coder.
      </small>
    </section>
  );
}

function ConnectManualFallback({
  controller,
  open,
  onToggle,
  accessMode,
  onAccessModeChange,
  baseUrl,
  onBaseUrlChange,
  credential,
  onCredentialChange,
  credentialType,
  onCredentialTypeChange,
}: {
  controller: Controller;
  open: boolean;
  onToggle: () => void;
  accessMode: EnvironmentAccessMode;
  onAccessModeChange: (value: EnvironmentAccessMode) => void;
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  credential: string;
  onCredentialChange: (value: string) => void;
  credentialType: CredentialType;
  onCredentialTypeChange: (value: CredentialType) => void;
}) {
  return (
    <section className="environment-connect-manual">
      <button type="button" aria-expanded={open} onClick={onToggle}>
        <KeyRound className="size-3.5" /> Advanced: connect directly with a URL and token
      </button>
      {open ? (
        <div className="environment-connect-manual__body">
          <p>
            Direct mode stores a T3 credential in Next Coder and requires the gateway to reach the host.
            This compatibility path is available only for local development and deliberate self-hosting.
          </p>
          <EnvironmentAccessSelector value={accessMode} onChange={onAccessModeChange} />
          <EnvironmentAccessGuidance mode={accessMode} controller={controller} />
          <Field label="T3 base URL" htmlFor="connect-environment-url" hint={environmentEndpointHint(accessMode)}>
            <input
              id="connect-environment-url"
              type="url"
              value={baseUrl}
              onChange={(event) => onBaseUrlChange(event.target.value)}
              placeholder={environmentUrlPlaceholder(accessMode)}
            />
          </Field>
          <CredentialSwitcher value={credentialType} onChange={onCredentialTypeChange} />
          <Field
            label={credentialType === "pairingToken" ? "Pairing token" : "Access token"}
            htmlFor="connect-environment-token"
            hint="The credential is encrypted at rest and never returned by the API."
          >
            <textarea
              id="connect-environment-token"
              className="font-mono"
              rows={4}
              value={credential}
              onChange={(event) => onCredentialChange(event.target.value)}
              placeholder="Paste credential"
            />
          </Field>
        </div>
      ) : null}
    </section>
  );
}

function EnvironmentComputerSelector({
  value,
  onChange,
}: {
  value: EnvironmentComputerTarget;
  onChange: (value: EnvironmentComputerTarget) => void;
}) {
  const options: Array<{
    id: EnvironmentComputerTarget;
    label: string;
    description: string;
    icon: typeof Monitor;
  }> = [
    {
      id: "this-computer",
      label: "Connect this computer",
      description: "Run the command in a terminal on the computer where this console is open.",
      icon: Monitor,
    },
    {
      id: "another-computer",
      label: "Connect another computer",
      description: "Copy the same enrollment command to the macOS, Windows, or Linux computer that runs T3.",
      icon: Laptop,
    },
  ];
  return (
    <div className="environment-access-grid environment-access-grid--computers" role="radiogroup" aria-label="T3 computer">
      {options.map((option) => {
        const Icon = option.icon;
        const selected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            className="environment-access-card"
            data-active={selected || undefined}
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.id)}
          >
            <span className="environment-access-card__icon"><Icon className="size-4" /></span>
            <strong>{option.label}</strong>
            <span>{option.description}</span>
          </button>
        );
      })}
    </div>
  );
}

function EnvironmentAccessSelector({
  value,
  onChange,
}: {
  value: EnvironmentAccessMode;
  onChange: (value: EnvironmentAccessMode) => void;
}) {
  return (
    <div className="environment-access-grid" role="radiogroup" aria-label="Access path">
      {environmentAccessOptions.map((option) => {
        const Icon = option.icon;
        const selected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            className="environment-access-card"
            data-active={selected || undefined}
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.id)}
          >
            <span className="environment-access-card__icon"><Icon className="size-4" /></span>
            <strong>{option.label}</strong>
            <span>{option.description}</span>
          </button>
        );
      })}
    </div>
  );
}

function EnvironmentAccessGuidance({ mode, controller: c }: { mode: EnvironmentAccessMode; controller: Controller }) {
  if (mode === "tailscale") {
    const tailscale = c.remoteAccess?.tailscale;
    const gatewayReady = Boolean(tailscale?.connected);
    return (
      <section className="environment-access-guide" data-tone={gatewayReady ? "success" : "info"} aria-label="Tailscale setup">
        <div className="environment-access-guide__heading">
          <ShieldCheck className="size-4" />
          <div>
            <strong>Private Tailnet access</strong>
            <span>{gatewayReady ? `This gateway is connected${tailscale?.dnsName ? ` as ${tailscale.dnsName}` : ""}.` : "Connect this gateway and the T3 host to the same Tailnet."}</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            busy={c.busyAction === "refresh-environment-tailscale"}
            onClick={() => void c.run(
              "refresh-environment-tailscale",
              "Tailscale status refreshed.",
              () => c.loadRemoteAccess(true),
            )}
          >
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        </div>
        <p>On the T3 host, generate a private HTTPS URL and one-time pairing credential:</p>
        <CopyableSyntax value="npx t3 pair --tailscale" label="Tailscale command" />
        <small>Tailscale Serve keeps the endpoint private to authorized Tailnet members.</small>
      </section>
    );
  }

  if (mode === "online") {
    return (
      <section className="environment-access-guide" data-tone="warning" aria-label="Online access guidance">
        <div className="environment-access-guide__heading">
          <Globe2 className="size-4" />
          <div>
            <strong>Public internet endpoint</strong>
            <span>Use an existing HTTPS tunnel or reverse proxy that terminates TLS.</span>
          </div>
        </div>
        <p>Expose only the T3 endpoint, keep token authentication enabled, and restrict ingress at the tunnel or proxy whenever possible.</p>
        <CopyableSyntax value="https://t3.example.com" label="HTTPS endpoint example" />
        <small>Never enter a plain HTTP URL for an internet-accessible host.</small>
      </section>
    );
  }

  return (
    <section className="environment-access-guide" data-tone="neutral" aria-label="Local network guidance">
      <div className="environment-access-guide__heading">
        <Wifi className="size-4" />
        <div>
          <strong>Direct network access</strong>
          <span>Best when Next Coder can already reach the T3 host.</span>
        </div>
      </div>
      <p>Use loopback when both services share a computer, or the host's private IP on a trusted LAN.</p>
      <CopyableSyntax value="http://127.0.0.1:3773" label="local endpoint" />
    </section>
  );
}

function CopyableSyntax({ value, label }: { value: string; label: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    setCopyState("idle");
  }, [value]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 2200);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  const feedback = copyState === "copied" ? "Copied" : copyState === "error" ? "Try again" : "Copy";
  return (
    <div className="environment-access-guide__syntax">
      <code>{value}</code>
      <button
        type="button"
        data-state={copyState}
        aria-label={`${feedback} ${label}`}
        onClick={() => void copy()}
      >
        {copyState === "copied" ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />}
        <span aria-live="polite">{feedback}</span>
      </button>
    </div>
  );
}

function EnvironmentAccessSummary({ mode }: { mode: EnvironmentAccessMode }) {
  const Icon = mode === "tailscale" ? ShieldCheck : mode === "online" ? Globe2 : Wifi;
  return (
    <div className="environment-access-summary">
      <Icon className="size-4" />
      <div>
        <strong>{environmentAccessLabel(mode)}</strong>
        <span>{mode === "tailscale" ? "Private HTTPS over your Tailnet" : mode === "online" ? "Public HTTPS with token authentication" : "Direct host or trusted LAN connection"}</span>
      </div>
    </div>
  );
}

function environmentEndpointHint(mode: EnvironmentAccessMode) {
  if (mode === "tailscale") return "Paste the HTTPS MagicDNS URL printed by T3.";
  if (mode === "online") return "HTTPS is required for an internet-accessible endpoint.";
  return "Use loopback or a private LAN address reachable by this gateway.";
}

function EnvironmentIntro() {
  return (
    <div className="device-flow__intro">
      <div className="device-flow__hero-icon"><Server className="size-6" /></div>
      <StatusBadge tone="info" label="Outbound connector" />
      <h3>Connect the machine where T3 Code runs</h3>
      <p>Run one short-lived command on that computer. The connector dials out to Next Coder and keeps local T3 and provider credentials on the host.</p>
      <ul>
        <li><CheckCircle2 className="size-4" /> No inbound port or public T3 URL</li>
        <li><CheckCircle2 className="size-4" /> Single-use enrollment code with a visible expiry</li>
        <li><CheckCircle2 className="size-4" /> Separate cloud, connector, T3, provider, and proof health</li>
      </ul>
    </div>
  );
}

function CredentialSwitcher({ value, onChange }: { value: CredentialType; onChange: (value: CredentialType) => void }) {
  return (
    <div className="intent-switcher w-full" aria-label="Credential type">
      <button type="button" className="intent-switcher__item flex-1" data-active={value === "pairingToken" || undefined} aria-pressed={value === "pairingToken"} onClick={() => onChange("pairingToken")}>
        <Link2 className="size-3.5" /> Pairing token
      </button>
      <button type="button" className="intent-switcher__item flex-1" data-active={value === "accessToken" || undefined} aria-pressed={value === "accessToken"} onClick={() => onChange("accessToken")}>
        <KeyRound className="size-3.5" /> Access token
      </button>
    </div>
  );
}

function EnvironmentStepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="device-flow__steps" aria-label="Connection progress">
      {steps.map((label, index) => (
        <li key={label} data-active={index === current || undefined} data-complete={index < current || undefined}>
          <span>{index < current ? <Check className="size-3" /> : index + 1}</span>
          <small>{label}</small>
        </li>
      ))}
    </ol>
  );
}

function EnvironmentEditorDialog({
  controller: c,
  environment,
  onClose,
  onCheck,
  onLoad,
  onRemove,
  onArchive,
  onRepair,
}: {
  controller: Controller;
  environment: Environment | null;
  onClose: () => void;
  onCheck: () => void;
  onLoad: () => void;
  onRemove: () => void;
  onArchive: () => void;
  onRepair: () => void;
}) {
  const [tab, setTab] = useState<EnvironmentTab>("connection");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [accessMode, setAccessMode] = useState<EnvironmentAccessMode>("local");
  const [credential, setCredential] = useState("");
  const [credentialType, setCredentialType] = useState<CredentialType>("accessToken");

  useEffect(() => {
    if (!environment) return;
    setTab("connection");
    setLabel(environment.label);
    setBaseUrl(environment.baseUrl ?? "");
    setAccessMode(inferEnvironmentAccessMode(environment.baseUrl));
    setCredential("");
    setCredentialType("accessToken");
  }, [environment?.id]);

  if (!environment) return null;
  const connector = connectorForEnvironment(c.connectors, environment);
  const connectorMode = (environment.transportMode ?? "direct") === "connector";
  const cloudDeployment = c.authConfig?.deploymentMode === "cloud";
  const legacyDirectInCloud = cloudDeployment && !connectorMode;
  const status = environmentStatus(environment, connector);
  const validConnection = Boolean(label.trim() && (connectorMode || cloudDeployment || environmentUrlValid(baseUrl, accessMode)));
  const gateways = environmentGatewayInventory(environment.id, c.devices ?? [], c.gatewayProfiles ?? [], c.remoteAccess ?? null);

  const save = async () => {
    if (!validConnection) return;
    const saved = await c.run("update-environment", "Environment settings updated.", async () => {
      const result = await c.api(`/v1/t3/environments/${encodeURIComponent(environment.id)}`, {
        method: "PUT",
        body: connectorMode || cloudDeployment
          ? { label: label.trim() }
          : {
              label: label.trim(),
              baseUrl: baseUrl.trim(),
              ...(credential.trim() ? { [credentialType]: credential.trim() } : {}),
            },
      });
      setCredential("");
      if (credential.trim()) c.markEnvironmentCredentialChanged();
      await c.refreshAll();
      return result;
    });
    if (saved) onClose();
  };

  return (
    <EnvironmentModalShell
      open
      size="large"
      title={environment.label}
      eyebrow="Environment details"
      description={environment.id}
      headerAction={<StatusBadge tone={status.tone} label={status.label} />}
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={c.busyAction === "update-environment"} disabled={!validConnection} onClick={() => void save()}>
            <Save className="size-4" /> Save changes
          </Button>
        </>
      )}
    >
      <div className="device-editor environment-editor">
        <nav className="device-editor__tabs" aria-label="Environment settings">
          {(["connection", "gateways", "credential", "health", "workspace"] as const).map((item) => (
            <button key={item} type="button" data-active={tab === item || undefined} onClick={() => setTab(item)}>{item}</button>
          ))}
        </nav>
        <div className="device-editor__body">
          {tab === "connection" ? (
            <div className="grid gap-5">
              <Field label="Environment label" htmlFor="edit-environment-label" hint="Shown in the resource rail, commands, and health alerts.">
                <input id="edit-environment-label" value={label} onChange={(event) => setLabel(event.target.value)} />
              </Field>
              {connectorMode ? (
                <>
                  <div className="environment-access-guide" data-tone="info">
                    <div className="environment-access-guide__heading">
                      <Cable className="size-4" />
                      <div>
                        <strong>Outbound connector</strong>
                        <span>This environment does not expose T3 to the internet or store its token in the cloud.</span>
                      </div>
                    </div>
                  </div>
                  <EnvironmentHealthStack
                    environment={environment}
                    connector={connector}
                    cloudConnection={c.connection}
                    proofReady={Boolean(c.onboarding?.environmentId === environment.id && c.onboardingReadiness?.checks.firstRunCompleted)}
                  />
                </>
              ) : legacyDirectInCloud ? (
                <div className="environment-access-guide" data-tone="warning">
                  <div className="environment-access-guide__heading">
                    <Cable className="size-4" />
                    <div>
                      <strong>Direct connection unavailable in managed cloud</strong>
                      <span>This legacy record cannot route work. Enroll the outbound connector to replace its URL-and-token transport without exposing T3.</span>
                    </div>
                  </div>
                  <Button size="sm" onClick={onRepair}><Cable className="size-3.5" /> Enroll outbound connector</Button>
                </div>
              ) : (
                <>
                  <div className="environment-editor__access">
                    <div>
                      <p className="text-xs font-semibold text-ink">Advanced direct access path</p>
                      <p className="mt-1 text-xs text-ink-muted">Changing the path does not alter the endpoint until you save.</p>
                    </div>
                    <EnvironmentAccessSelector value={accessMode} onChange={setAccessMode} />
                    <EnvironmentAccessGuidance mode={accessMode} controller={c} />
                  </div>
                  <Field label="T3 base URL" htmlFor="edit-environment-url" hint={environmentEndpointHint(accessMode)}>
                    <input id="edit-environment-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={environmentUrlPlaceholder(accessMode)} />
                  </Field>
                </>
              )}
              <dl className="device-editor__facts">
                <EnvironmentReviewRow label="Transport" value={connectorMode ? "Outbound connector" : legacyDirectInCloud ? "Legacy direct · migration required" : `Advanced direct · ${environmentAccessLabel(accessMode)}`} />
                <EnvironmentReviewRow label="Environment ID" value={environment.id} mono />
                <EnvironmentReviewRow label="Created" value={formatRelativeTime(environment.createdAt)} />
                <EnvironmentReviewRow label="Last updated" value={formatRelativeTime(environment.updatedAt)} />
              </dl>
            </div>
          ) : null}

          {tab === "gateways" ? (
            <EnvironmentGatewayDetails gateways={gateways} />
          ) : null}

          {tab === "credential" ? connectorMode ? (
            <div className="environment-editor__section">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="ac-display text-base">Connector enrollment</p>
                  <p className="mt-1 text-sm leading-relaxed text-ink-muted">The connector secret and T3 credential stay on the workspace computer. A revoked secret cannot be displayed or reused.</p>
                </div>
                <Button size="sm" onClick={onRepair}><Cable className="size-3.5" /> Create new enrollment</Button>
              </div>
              <dl className="device-editor__facts">
                <EnvironmentReviewRow label="Connector" value={connector?.label ?? "Waiting for enrollment"} />
                <EnvironmentReviewRow label="Status" value={status.label} />
                <EnvironmentReviewRow label="Version" value={connector?.connectorVersion ? `v${connector.connectorVersion}` : "Not reported"} />
                <EnvironmentReviewRow label="Platform" value={connector?.platform ?? "Not reported"} />
                <EnvironmentReviewRow label="Last seen" value={formatRelativeTime(connector?.lastSeenAt ?? environment.lastConnectorSeenAt)} />
              </dl>
            </div>
          ) : legacyDirectInCloud ? (
            <div className="environment-editor__section">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="ac-display text-base">Replace the legacy direct connection</p>
                  <p className="mt-1 text-sm leading-relaxed text-ink-muted">Managed cloud does not accept or retain a T3 URL or token. Enroll the connector on the workspace computer to restore this environment.</p>
                </div>
                <Button size="sm" onClick={onRepair}><Cable className="size-3.5" /> Enroll outbound connector</Button>
              </div>
            </div>
          ) : (
            <div className="environment-editor__section">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="ac-display text-base">Replace the stored credential</p>
                  <p className="mt-1 text-sm leading-relaxed text-ink-muted">Leave this empty to keep the encrypted credential unchanged.</p>
                </div>
                <Button size="sm" onClick={onRepair}><Cable className="size-3.5" /> Re-pair from the host</Button>
              </div>
              <CredentialSwitcher value={credentialType} onChange={setCredentialType} />
              <Field label={credentialType === "pairingToken" ? "Replacement pairing token" : "Replacement access token"} htmlFor="edit-environment-token" hint="Saved credentials are never displayed again.">
                <textarea id="edit-environment-token" className="font-mono" rows={5} value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="Unchanged" />
              </Field>
              <dl className="device-editor__facts">
                <EnvironmentReviewRow
                  label="Credential expires"
                  value={environment.accessTokenExpiresAt ? formatRelativeTime(environment.accessTokenExpiresAt) : "No known expiry"}
                />
                <EnvironmentReviewRow label="Stored as" value="Encrypted token" />
              </dl>
            </div>
          ) : null}

          {tab === "health" ? (
            <div className="environment-editor__section">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="ac-display text-base">Connection telemetry</p>
                  <p className="mt-1 text-sm text-ink-muted">Current reachability and the last successful contact with T3.</p>
                </div>
                <Button size="sm" busy={c.busyAction === `check-environment-${environment.id}`} onClick={onCheck}><RefreshCw className="size-3.5" /> Check now</Button>
              </div>
              <dl className="device-editor__facts">
                <EnvironmentReviewRow label="Status" value={status.label} />
                <EnvironmentReviewRow label="Last checked" value={formatRelativeTime(environment.health?.lastCheckedAt)} />
                <EnvironmentReviewRow label="Last reachable" value={formatRelativeTime(environment.health?.lastReachableAt)} />
                <EnvironmentReviewRow label="Snapshot" value={environment.health?.snapshot?.line1 ?? "Not loaded"} />
                <EnvironmentReviewRow label="Sessions" value={environment.health?.snapshot?.line2 ?? "Not loaded"} />
              </dl>
              <EnvironmentHealthStack
                environment={environment}
                connector={connector}
                cloudConnection={c.connection}
                proofReady={Boolean(c.onboarding?.environmentId === environment.id && c.onboardingReadiness?.checks.firstRunCompleted)}
              />
              {environment.health?.lastError ? <p className="environment-editor__error" role="alert">{environment.health.lastError}</p> : null}
              <section className="device-editor__danger" aria-labelledby="environment-danger-title">
                <div>
                  <p id="environment-danger-title" className="ac-display text-sm text-danger">Connection danger zone</p>
                  <p className="mt-1 text-xs text-ink-muted">Archiving disconnects this host and keeps its record in Archive. Deleting removes the record permanently. Both clear attached device defaults and disable saved actions and macros that target it.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={onArchive}><Archive className="size-3.5" /> Archive environment</Button>
                  <Button size="sm" variant="danger-ghost" onClick={onRemove}><Trash2 className="size-3.5" /> Delete environment</Button>
                </div>
              </section>
            </div>
          ) : null}

          {tab === "workspace" ? (
            <div className="environment-editor__section">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="ac-display text-base">Projects and sessions</p>
                  <p className="mt-1 text-sm text-ink-muted">The live T3 snapshot for this environment.</p>
                </div>
                <Button size="sm" busy={c.busyAction === `environment-snapshot-${environment.id}`} onClick={onLoad}><RefreshCw className="size-3.5" /> Load snapshot</Button>
              </div>
              {c.projects.length || c.threads.length ? (
                <div className="environment-workspace-list">
                  <section>
                    <h4><FolderGit2 className="size-3.5" /> {c.projects.length} projects</h4>
                    <div>
                      {c.projects.map((project) => (
                        <article key={project.id}>
                          <p>{project.title ?? project.name ?? project.id}</p>
                          <code>{project.workspaceRoot ?? project.id}</code>
                        </article>
                      ))}
                    </div>
                  </section>
                  <section>
                    <h4><Clock3 className="size-3.5" /> {c.threads.length} sessions</h4>
                    <div>
                      {c.threads.map((thread) => (
                        <article key={thread.id}>
                          <p>{thread.label}</p>
                          <code>{thread.id}</code>
                        </article>
                      ))}
                    </div>
                  </section>
                </div>
              ) : (
                <div className="environment-workspace-empty">
                  <CloudCog className="size-5" />
                  <p>No workspace snapshot loaded</p>
                  <span>Fetch this host to inspect its projects and sessions.</span>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </EnvironmentModalShell>
  );
}

function EnvironmentGatewayDetails({ gateways }: { gateways: EnvironmentGateway[] }) {
  const activeGateways = gateways.filter((gateway) => gateway.users.length > 0);
  const attachedDevices = new Map(
    activeGateways.flatMap((gateway) => gateway.users.map((device) => [device.id, device] as const)),
  );

  return (
    <div className="environment-editor__section environment-gateways">
      <div className="environment-gateways__intro">
        <div>
          <p className="ac-display text-base">Controller gateways</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-muted">
            Endpoints used by physical controllers assigned to this environment. The T3 connection URL is managed separately under Connection.
          </p>
        </div>
        <dl className="environment-gateways__summary">
          <div><dt>Active</dt><dd>{activeGateways.length}</dd></div>
          <div><dt>Devices</dt><dd>{attachedDevices.size}</dd></div>
        </dl>
      </div>

      {gateways.length ? (
        <div className="environment-gateways__list">
          {gateways.map((gateway) => {
            const active = gateway.users.length > 0;
            return (
              <article key={gateway.id} className="environment-gateway-row" data-active={active || undefined}>
                <div className="environment-gateway-row__icon"><GatewayIcon mode={gateway.mode} className="size-4" /></div>
                <div className="environment-gateway-row__main">
                  <div className="environment-gateway-row__heading">
                    <div>
                      <h4>{gateway.label}</h4>
                      <StatusBadge
                        tone={active ? "success" : gateway.detected ? "info" : "neutral"}
                        label={active ? "active" : gateway.detected ? "available" : "not detected"}
                      />
                    </div>
                    <span>{gateway.users.length} {gateway.users.length === 1 ? "device" : "devices"}</span>
                  </div>
                  <code>{gateway.url ?? "Endpoint stored on device"}</code>
                  <div className="environment-gateway-row__users">
                    <p><Users className="size-3.5" /> Who is using it</p>
                    {gateway.users.length ? (
                      <ul>
                        {gateway.users.map((device) => (
                          <li key={device.id}>
                            <span className="environment-gateway-row__presence" data-online={device.presence?.online || undefined} />
                            <span>{device.label}</span>
                            <small>{device.presence?.online ? "online" : device.presence?.state ?? "offline"}</small>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span>No devices assigned to this gateway.</span>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="environment-workspace-empty environment-gateways__empty">
          <Router className="size-5" />
          <p>No controller gateways found</p>
          <span>Assign a device to this environment or configure a gateway endpoint in Device settings.</span>
        </div>
      )}
    </div>
  );
}

function EnvironmentReviewRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? "font-mono" : undefined}>{value}</dd></div>;
}

function EnvironmentModalShell({
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
  footer: ReactNode;
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
    <div className="device-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="environment-modal-title" className="device-modal ac-fleet" data-size={size}>
        <header className="device-modal__header">
          <div className="min-w-0 flex-1">
            <p className="ac-eyebrow">{eyebrow}</p>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 id="environment-modal-title" className="truncate ac-display text-lg">{title}</h2>
              {headerAction}
            </div>
            {description ? <p className="mt-1 truncate text-xs text-ink-muted">{description}</p> : null}
          </div>
          <button ref={closeRef} type="button" className="device-modal__close" aria-label="Close dialog" onClick={onClose}><X className="size-4" /></button>
        </header>
        <div className="device-modal__content">{children}</div>
        <footer className="device-modal__footer">{footer}</footer>
      </div>
    </div>
  ), document.body);
}
