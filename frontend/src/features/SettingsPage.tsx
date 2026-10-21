import {
  BellOff,
  BellRing,
  Cable,
  CheckCircle2,
  Clipboard,
  Download,
  ExternalLink,
  Globe2,
  LogIn,
  LogOut,
  Network,
  Save,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
  UserRound,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { Controller } from "../controller";
import { formatRelativeTime } from "../format";
import {
  buildGatewayTunnelDisableCommand,
  buildGatewayTunnelSetupCommand,
  remoteAccessOptions,
  type RemoteAccessMode,
} from "../remoteAccess";
import {
  RemoteAccessReadiness,
  remoteAccessReady,
} from "./RemoteAccessReadiness";
import {
  Button,
  Field,
  Metric,
  Panel,
  SectionHeader,
  StatusBadge,
  useConfirm,
} from "../ui";
import { T3CompatibilityPanel } from "./T3CompatibilityPanel";
import { GatewayProfilesPanel } from "./GatewayProfilesPanel";
import { ReleaseRolloutsPanel } from "./ReleaseRolloutsPanel";
import {
  currentWebPushSubscription,
  serializeWebPushSubscription,
  subscribeWebPush,
  webPushSupported,
  type WebPushConfig,
} from "../webPush";
import "./intelligence-control.css";

const NOTIFICATION_HINTS: Record<string, string> = {
  unsupported: "This browser cannot raise notifications. Install the console to your home screen, or use a desktop browser.",
  denied: "Notifications are blocked for this site. Re-enable them in your browser's site settings, then try again.",
  default: "Notification permission was dismissed. Choose Allow when the browser asks.",
};

export function SettingsPage({ controller: c }: { controller: Controller }) {
  const confirm = useConfirm();
  const [retentionDraft, setRetentionDraft] = useState(
    c.privacyDays === null ? "" : String(c.privacyDays),
  );
  const [notificationHint, setNotificationHint] = useState<string | null>(null);
  const [webPushConfig, setWebPushConfig] = useState<WebPushConfig | null>(null);
  const [webPushEnabled, setWebPushEnabled] = useState(false);
  const [webPushBusy, setWebPushBusy] = useState(false);
  const [webPushError, setWebPushError] = useState<string | null>(null);
  const [remoteAccessMode, setRemoteAccessMode] = useState<RemoteAccessMode>("serve");

  useEffect(() => {
    setRetentionDraft(c.privacyDays === null ? "" : String(c.privacyDays));
  }, [c.privacyDays]);

  useEffect(() => {
    if (c.remoteAccess?.tailscale.mode) setRemoteAccessMode(c.remoteAccess.tailscale.mode);
  }, [c.remoteAccess?.tailscale.mode]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await c.api<WebPushConfig>("/v1/push/config", { silent: true });
        const current = await currentWebPushSubscription();
        if (!cancelled) {
          setWebPushConfig(config);
          setWebPushEnabled(Boolean(current));
          setWebPushError(null);
        }
      } catch (error) {
        if (!cancelled) setWebPushError(error instanceof Error ? error.message : "Web Push status is unavailable.");
      }
    })();
    return () => { cancelled = true; };
  }, [c.api]);

  const toggleLocalNotifications = async () => {
    if (c.localNotificationsEnabled) {
      c.disableLocalNotifications();
      setNotificationHint(null);
      c.setNotice({ tone: "info", message: "Local system notifications turned off." });
      return;
    }
    const result = await c.enableLocalNotifications();
    if (result === "granted") {
      setNotificationHint(null);
      c.setNotice({ tone: "success", message: "Local system notifications enabled." });
      return;
    }
    setNotificationHint(NOTIFICATION_HINTS[result] ?? NOTIFICATION_HINTS.default);
  };

  const toggleWebPush = async () => {
    if (!webPushConfig?.supported || !webPushConfig.publicKey || webPushBusy) return;
    setWebPushBusy(true);
    setWebPushError(null);
    try {
      if (webPushEnabled) {
        const current = await currentWebPushSubscription();
        if (current) {
          await c.api("/v1/push/subscriptions/revoke", {
            method: "POST",
            body: { endpoint: current.endpoint },
          });
          await current.unsubscribe();
        }
        setWebPushEnabled(false);
        c.setNotice({ tone: "info", message: "Web Push turned off for this browser." });
      } else {
        const subscription = await subscribeWebPush(webPushConfig.publicKey);
        await c.api("/v1/push/subscriptions", {
          method: "POST",
          body: { subscription: serializeWebPushSubscription(subscription) },
        });
        setWebPushEnabled(true);
        c.setNotice({ tone: "success", message: "Web Push enabled for this browser." });
      }
    } catch (error) {
      setWebPushError(error instanceof Error ? error.message : "Web Push could not be updated.");
    } finally {
      setWebPushBusy(false);
    }
  };

  const saveRetention = async () => {
    const value = retentionDraft.trim();
    const mediaRetentionDays = value === "" ? null : Number(value);
    if (
      mediaRetentionDays !== null
      && (!Number.isInteger(mediaRetentionDays) || mediaRetentionDays < 1 || mediaRetentionDays > 365)
    ) {
      c.setNotice({ tone: "danger", message: "Retention must be an integer from 1 to 365 days." });
      return;
    }
    await c.run("save-retention", "Media retention policy saved.", async () => {
      const result = await c.api<{ privacy: { mediaRetentionDays: number | null } }>("/v1/settings/privacy", {
        method: "PUT",
        body: { mediaRetentionDays },
      });
      c.setPrivacyDays(result.privacy.mediaRetentionDays);
      return result;
    });
  };

  const purgeExpired = async () => {
    const accepted = await confirm({
      title: "Purge expired media?",
      description: "All captures past the configured retention window will be permanently deleted.",
      confirmLabel: "Purge expired media",
    });
    if (!accepted) return;
    await c.run("purge-media", "Expired media purged.", async () => {
      const result = await c.api("/v1/media/purge-expired", { method: "POST", body: {} });
      await c.refreshAll();
      return result;
    });
  };

  const revokeConnector = async (connectorId: string, label: string) => {
    const accepted = await confirm({
      title: `Revoke ${label}?`,
      description: "The connector will be disconnected immediately. Its standing secret cannot be recovered or reused; reconnecting requires a new enrollment command.",
      confirmLabel: "Revoke connector",
    });
    if (!accepted) return;
    await c.run(`revoke-connector-${connectorId}`, "Connector revoked.", async () => {
      const result = await c.api(`/v1/connectors/${encodeURIComponent(connectorId)}`, { method: "DELETE" });
      await c.refreshAll();
      return result;
    });
  };

  const copyRemoteAccessCommand = async (command: string, label: string) => {
    try {
      await navigator.clipboard.writeText(command);
      c.setNotice({ tone: "success", message: `${label} copied.` });
    } catch {
      c.setNotice({ tone: "danger", message: "Clipboard access was blocked. Select and copy the command manually." });
    }
  };

  const tunnelCommand = buildGatewayTunnelSetupCommand(remoteAccessMode);
  const disableCommand = buildGatewayTunnelDisableCommand(remoteAccessMode);
  const tunnelReady = remoteAccessReady(c.remoteAccess, remoteAccessMode);

  return (
    <div className="page-stack ic-scope ic-settings">
      <T3CompatibilityPanel controller={c} />

      <GatewayProfilesPanel controller={c} />

      <ReleaseRolloutsPanel controller={c} />

      <Panel elevated className="ic-panel overflow-hidden">
        <SectionHeader
          eyebrow="Connector fleet"
          title="Workspace computers"
          description="Outbound connectors keep T3 and provider credentials on each workspace computer. Status is based on the most recent heartbeat, not a generic environment flag."
          action={<StatusBadge tone={c.connectors.some((connector) => connector.status === "online") ? "success" : "neutral"} label={`${c.connectors.length} enrolled`} />}
        />
        <div className="space-y-3 border-t border-control p-5">
          {c.connectors.length ? c.connectors.map((connector) => {
            const environment = c.environments.find((candidate) => candidate.id === connector.environmentId);
            const revoked = connector.status === "revoked" || Boolean(connector.revokedAt);
            const tone = revoked || connector.status === "offline" || connector.status === "incompatible"
              ? "danger"
              : connector.status === "online" ? "success" : "warning";
            return (
              <article key={connector.id} className="ic-card">
                <div className="flex flex-wrap items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-raised text-ink-muted"><Cable className="size-4" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="ic-title text-sm text-ink">{connector.label}</strong>
                      <StatusBadge tone={tone} label={connector.status} />
                    </div>
                    <p className="mt-1 text-xs text-ink-muted">{environment?.label ?? connector.environmentId} · Last seen {formatRelativeTime(connector.lastSeenAt ?? connector.lastConnectedAt)}</p>
                    <p className="mt-1 font-mono text-[11px] text-ink-faint">{[connector.connectorVersion ? `v${connector.connectorVersion}` : "version unknown", connector.platform ?? "platform unknown", connector.secretPrefix].filter(Boolean).join(" · ")}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    disabled={revoked}
                    busy={c.busyAction === `revoke-connector-${connector.id}`}
                    onClick={() => void revokeConnector(connector.id, connector.label)}
                  >
                    <Trash2 className="size-3.5" /> {revoked ? "Revoked" : "Revoke"}
                  </Button>
                </div>
              </article>
            );
          }) : (
            <p className="ic-card text-sm text-ink-muted">No connector has enrolled yet. Connect a computer from Environments or Initial setup.</p>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            {["npx @agent-controller/connector status", "npx @agent-controller/connector doctor"].map((command) => (
              <button key={command} type="button" className="ic-command" onClick={() => void copyRemoteAccessCommand(command, "Connector command")}>{command}</button>
            ))}
          </div>
          <p className="text-xs text-ink-muted">Run status or doctor on the workspace computer. These checks do not reveal the standing connector secret or local T3/provider credentials.</p>
        </div>
      </Panel>

      {c.authConfig.deploymentMode !== "cloud" ? <Panel elevated className="ic-panel overflow-hidden">
        <SectionHeader
          eyebrow="Advanced self-hosted gateway access"
          title="Open this console from another device"
          description="Optional for self-hosted Agent Controller gateways. This controls console access only; connector-mode T3 computers do not require Tailscale, an inbound port, or a public URL."
          action={
            <StatusBadge
              tone={tunnelReady ? "success" : c.remoteAccess ? "warning" : "neutral"}
              label={tunnelReady ? "Remote access ready" : c.remoteAccess ? "Setup needed" : "Checking"}
            />
          }
        />
        <div className="grid gap-5 border-t border-control p-5 xl:grid-cols-[minmax(0,0.82fr)_minmax(360px,1.18fr)]">
          <div className="space-y-3">
            <p className="ac-eyebrow">Choose visibility</p>
            {remoteAccessOptions.map((option) => {
              const selected = remoteAccessMode === option.id;
              const Icon = option.id === "serve" ? Network : Globe2;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={selected}
                  className="ic-option flex w-full items-start gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  data-selected={selected || undefined}
                  onClick={() => setRemoteAccessMode(option.id)}
                >
                  <span className={`grid size-9 shrink-0 place-items-center rounded-full ${selected ? "text-ink" : "text-ink-muted"}`}>
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <strong className="ic-title text-sm">{option.label}</strong>
                      <StatusBadge tone={option.id === "serve" ? "success" : "warning"} label={option.visibility} />
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-ink-muted">{option.description}</span>
                  </span>
                </button>
              );
            })}
            {remoteAccessMode === "funnel" ? (
              <div className="ic-note border border-warning/25 bg-warning/8 p-3 text-xs leading-relaxed text-warning" role="note">
                Funnel exposes the gateway to the public internet. The setup script refuses to enable it unless Clerk is configured, unless you explicitly acknowledge another production authentication layer.
              </div>
            ) : (
              <p className="ic-note border border-success/20 bg-success/7 p-3 text-xs leading-relaxed text-ink-muted">
                Serve follows T3 Code’s recommended remote-access model: a trusted private network, stable MagicDNS address, HTTPS, and Tailnet access controls.
              </p>
            )}
          </div>

          <div className="space-y-4">
            <RemoteAccessReadiness
              status={c.remoteAccess}
              mode={remoteAccessMode}
              refreshing={c.busyAction === "refresh-remote-access"}
              onRefresh={() => void c.run(
                "refresh-remote-access",
                "Remote access status refreshed.",
                () => c.loadRemoteAccess(true),
              )}
            />

            {tunnelReady && c.remoteAccess?.tailscale.httpsUrl ? (
              <div className="ic-note border border-success/25 bg-success/8 p-4">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="ic-title text-sm text-ink">Remote access is configured</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-ink-muted">{c.remoteAccess.tailscale.httpsUrl}</p>
                    <a
                      className="ic-pill-link mt-3 inline-flex min-h-8 items-center gap-2 px-3 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      href={c.remoteAccess.tailscale.httpsUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open remote console <ExternalLink className="size-3.5" />
                    </a>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {!c.remoteAccess?.tailscale.installed ? (
                  <a
                    className="ic-cta inline-flex min-h-9 w-full items-center justify-center gap-2 px-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    href="https://tailscale.com/download"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Install Tailscale <ExternalLink className="size-3.5" />
                  </a>
                ) : null}
                <div className="ic-console p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2 text-xs font-semibold text-console-ink">
                      <SquareTerminal className="size-3.5" aria-hidden="true" /> Run on the gateway host
                    </span>
                    <Button size="sm" onClick={() => void copyRemoteAccessCommand(tunnelCommand, "Tunnel setup command")}>
                      <Clipboard className="size-3.5" /> Copy
                    </Button>
                  </div>
                  <code className="mt-3 block select-all overflow-x-auto whitespace-nowrap font-mono text-xs text-console-ink">{tunnelCommand}</code>
                </div>
              </>
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
              <button
                type="button"
                className="text-ink-muted underline decoration-control-strong underline-offset-4 hover:text-ink"
                onClick={() => void copyRemoteAccessCommand(disableCommand, "Disable command")}
              >
                Copy disable command
              </button>
              <a className="text-primary hover:underline" href="https://tailscale.com/download" target="_blank" rel="noreferrer">
                Install Tailscale <ExternalLink className="ml-1 inline size-3" />
              </a>
              <a className="text-primary hover:underline" href="https://tailscale.com/docs/features/tailscale-serve" target="_blank" rel="noreferrer">
                Tailscale Serve docs <ExternalLink className="ml-1 inline size-3" />
              </a>
              <a className="text-primary hover:underline" href="https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md" target="_blank" rel="noreferrer">
                T3 Code remote access <ExternalLink className="ml-1 inline size-3" />
              </a>
            </div>

            <p className="border-t border-control pt-4 text-xs leading-relaxed text-ink-muted">
              This tunnel exposes the Agent Controller console only. Connector-mode T3 computers continue to dial out independently and keep their credentials local.
            </p>
          </div>
        </div>
      </Panel> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel className="ic-panel ic-panel--flat overflow-hidden">
          <SectionHeader
            eyebrow="Access"
            title="Gateway session"
            description="Clerk manages your identity and refreshes secure gateway sessions automatically."
            action={
              <StatusBadge
                tone={c.authenticated ? "success" : "warning"}
                label={c.authenticated ? "authenticated" : "signed out"}
              />
            }
          />
          <div className="space-y-5 border-t border-control p-5">
            {c.authConfig.clerk?.enabled && c.clerk ? (
              <div className="ic-card">
                <div className="flex items-start gap-3">
                  <div className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-raised text-ink-muted">
                    <UserRound className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="ic-title text-sm">
                      {c.clerk.signedIn ? c.clerk.userLabel ?? "Signed-in Clerk user" : "Clerk account"}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                      {c.clerk.signedIn
                        ? "Your active Clerk session is securing gateway requests and live updates."
                        : "Sign in with Clerk to access environments, devices, media, and activity."}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {!c.clerk.loaded ? (
                        <Button disabled>Checking session…</Button>
                      ) : !c.clerk.signedIn ? (
                        <Button onClick={c.clerk.openSignIn}>
                          <LogIn className="size-4" /> Sign in
                        </Button>
                      ) : (
                        <>
                          <Button onClick={c.clerk.openUserProfile}>
                            <ShieldCheck className="size-4" /> Manage account
                          </Button>
                          <Button variant="danger-ghost" onClick={() => void c.signOut()}>
                            <LogOut className="size-4" /> Sign out
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="ic-note border border-danger/20 bg-danger/8 p-4 text-sm text-danger">
                <p className="font-semibold">Clerk authentication is not configured.</p>
                <p className="mt-1 text-xs leading-relaxed">
                  Add the Clerk publishable and secret keys to the gateway environment, then restart the service.
                </p>
              </div>
            )}
          </div>
        </Panel>

        <Panel className="ic-panel ic-panel--flat overflow-hidden">
          <SectionHeader
            eyebrow="Privacy"
            title="Media retention"
            description="Choose how long images and audio remain available to prompts and support tooling."
          />
          <div className="space-y-4 border-t border-control p-5">
            <Field
              label="Retention days"
              htmlFor="retention-days"
              hint="Leave blank to retain media until manual deletion. Range: 1–365 days."
            >
              <input
                id="retention-days"
                type="number"
                min={1}
                max={365}
                value={retentionDraft}
                onChange={(event) => setRetentionDraft(event.target.value)}
                placeholder="Manual deletion"
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => void saveRetention()} busy={c.busyAction === "save-retention"}>
                <Save className="size-4" /> Save retention
              </Button>
              <Button variant="danger-ghost" onClick={() => void purgeExpired()}>
                <Trash2 className="size-4" /> Purge expired
              </Button>
            </div>
            <div className="ic-card">
              <dl className="ic-metrics grid grid-cols-2 gap-4">
                <Metric label="Current policy" value={c.privacyDays === null ? "Manual deletion" : `${c.privacyDays} days`} />
                <Metric label="Stored captures" value={c.media.length} />
              </dl>
            </div>
          </div>
        </Panel>
      </div>

      <Panel className="ic-panel ic-panel--flat overflow-hidden">
        <SectionHeader
          eyebrow="Alerts"
          title="Local system notifications"
          description="Raise an OS notification for new approvals, questions, completed or failed turns, and connection changes while this console is open in the background. Permission is requested only when you turn this on."
          action={
            <StatusBadge
              tone={c.localNotificationsEnabled
                ? "success"
                : c.notificationSupport === "denied" || c.notificationSupport === "unsupported"
                  ? "danger"
                  : "neutral"}
              label={c.localNotificationsEnabled ? "on" : c.notificationSupport}
            />
          }
        />
        <div className="space-y-3 border-t border-control p-5">
          <p className="text-xs leading-relaxed text-ink-muted">
            Notification bodies contain only a content-free event summary. Nothing is sent to a
            push service unless Web Push is enabled separately below. Local delivery stops when
            this browser and its installed PWA are closed.
          </p>
          {notificationHint ? (
            <p className="text-xs text-danger" role="alert">{notificationHint}</p>
          ) : null}
          <Button
            variant={c.localNotificationsEnabled ? "danger-ghost" : "primary"}
            disabled={c.notificationSupport === "unsupported"}
            onClick={() => void toggleLocalNotifications()}
          >
            {c.localNotificationsEnabled
              ? <><BellOff className="size-4" /> Turn off local notifications</>
              : <><BellRing className="size-4" /> Enable local notifications</>}
          </Button>
          <div className="border-t border-control pt-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="ic-title text-sm text-ink">Web Push</p>
                <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
                  Optional encrypted delivery through your browser's push service, including while
                  this console is closed. Payloads contain only a static event label and an opaque
                  notification id—never prompts, paths, provider output, questions, or answers.
                  “Accepted” means the push service accepted a request; it does not prove display.
                </p>
              </div>
              <StatusBadge
                tone={webPushEnabled ? "success" : webPushConfig?.supported ? "neutral" : "warning"}
                label={webPushEnabled ? "on" : webPushConfig?.supported ? "off" : "unavailable"}
              />
            </div>
            {webPushError ? <p className="mt-3 text-xs text-danger" role="alert">{webPushError}</p> : null}
            {!webPushConfig?.supported && webPushConfig ? (
              <p className="mt-3 text-xs text-ink-muted">
                Server delivery is disabled: {webPushConfig.reason?.replaceAll("_", " ") ?? "not configured"}.
              </p>
            ) : null}
            <Button
              className="mt-3"
              variant={webPushEnabled ? "danger-ghost" : "primary"}
              busy={webPushBusy}
              disabled={!webPushConfig?.supported || !webPushSupported()}
              onClick={() => void toggleWebPush()}
            >
              {webPushEnabled
                ? <><BellOff className="size-4" /> Turn off Web Push</>
                : <><BellRing className="size-4" /> Enable Web Push</>}
            </Button>
          </div>
        </div>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
        <Panel className="ic-panel ic-panel--flat overflow-hidden">
          <SectionHeader
            eyebrow="Support"
            title="Diagnostics"
            description="Export a redacted bundle for troubleshooting without exposing tokens, transcripts, or raw commands."
          />
          <div className="space-y-3 border-t border-control p-5">
            <a
              href="#onboarding"
              className="ic-pill-link inline-flex min-h-9 w-full items-center justify-center gap-2 px-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Sparkles className="size-4" />
              {c.onboarding?.status === "completed" ? "Review setup and readiness" : "Continue initial setup"}
            </a>
            <Button className="w-full" onClick={() => void c.downloadDiagnostics()}>
              <Download className="size-4" /> Download redacted diagnostics
            </Button>
            <a
              href="/legacy/"
              className="ic-pill-link ic-pill-link--quiet inline-flex min-h-9 w-full items-center justify-center gap-2 px-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Wrench className="size-4" /> Open legacy dashboard <ExternalLink className="size-3.5" />
            </a>
          </div>
        </Panel>

        <Panel className="ic-panel ic-panel--flat overflow-hidden">
          <SectionHeader
            eyebrow="Developer console"
            title="Latest operation"
            description="Raw API output remains available for development and support inspection."
            action={<StatusBadge tone={c.connection === "error" ? "danger" : "neutral"} label={c.connection} />}
          />
          <pre className="ic-console ic-console--flush max-h-[420px] overflow-auto p-4 text-xs leading-relaxed">
            {JSON.stringify(c.lastResult, null, 2)}
          </pre>
        </Panel>
      </div>
    </div>
  );
}
