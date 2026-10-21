import { Check, Circle, LoaderCircle, RefreshCw } from "lucide-react";

import type { RemoteAccessMode } from "../remoteAccess";
import type { RemoteAccessStatus } from "../types";
import { Button, cn } from "../ui";
// The hairline glass surfaces of the "intelligence design" system.
import "./intelligence-fleet.css";

export interface RemoteAccessReadinessStep {
  id: "install" | "connect" | "enable" | "restart";
  label: string;
  detail: string;
  ready: boolean;
}

export function remoteAccessReadinessSteps(
  status: RemoteAccessStatus | null,
  mode: RemoteAccessMode,
): RemoteAccessReadinessStep[] {
  const tailscale = status?.tailscale;
  const mappingActive = mode === "serve"
    ? Boolean(tailscale?.serve.active)
    : Boolean(tailscale?.funnel.active);
  const otherMode = mode === "serve" ? "Funnel" : "Serve";
  const otherActive = mode === "serve"
    ? Boolean(tailscale?.funnel.active)
    : Boolean(tailscale?.serve.active);

  return [
    {
      id: "install",
      label: "Tailscale installed",
      ready: Boolean(tailscale?.installed),
      detail: !status
        ? "Checking this gateway host…"
        : tailscale?.installed
          ? "Tailscale CLI found on this machine."
          : "Install Tailscale on the machine running Next Coder.",
    },
    {
      id: "connect",
      label: "Machine signed in",
      ready: Boolean(tailscale?.connected),
      detail: tailscale?.connected
        ? tailscale.dnsName ?? tailscale.ips[0] ?? "Connected to a Tailnet."
        : tailscale?.installed
          ? `Open Tailscale and sign in. Current state: ${tailscale.backendState}.`
          : "This becomes available after Tailscale is installed.",
    },
    {
      id: "enable",
      label: mode === "serve" ? "Private HTTPS enabled" : "Public Funnel enabled",
      ready: mappingActive,
      detail: mappingActive
        ? `${mode === "serve" ? "Serve" : "Funnel"} is proxying this gateway.`
        : otherActive
          ? `${otherMode} is active instead. Select it above or reconfigure the tunnel.`
          : tailscale?.connected
            ? "Run the setup command below on the gateway host."
            : "The tunnel can be enabled after this machine joins a Tailnet.",
    },
    {
      id: "restart",
      label: "Gateway URL loaded",
      ready: Boolean(mappingActive && tailscale?.publicBaseUrlConfigured),
      detail: mappingActive && tailscale?.publicBaseUrlConfigured
        ? tailscale.httpsUrl ?? "The HTTPS origin is active."
        : mappingActive
          ? "Restart Next Coder after the setup command updates .env."
          : "Setup will update PUBLIC_BASE_URL and Clerk authorized parties.",
    },
  ];
}

export function remoteAccessReady(status: RemoteAccessStatus | null, mode: RemoteAccessMode) {
  return remoteAccessReadinessSteps(status, mode).every((step) => step.ready);
}

export function RemoteAccessReadiness({
  status,
  mode,
  refreshing = false,
  onRefresh,
  compact = false,
}: {
  status: RemoteAccessStatus | null;
  mode: RemoteAccessMode;
  refreshing?: boolean;
  onRefresh?: () => void;
  compact?: boolean;
}) {
  const steps = remoteAccessReadinessSteps(status, mode);
  return (
    <div className="ac-readiness" aria-live="polite">
      <div className="ac-readiness__head">
        <div>
          <p className="ac-readiness__title">This gateway host</p>
          <p className="ac-readiness__meta">
            {status ? `Checked ${new Date(status.checkedAt).toLocaleTimeString()}` : "Checking tunnel readiness…"}
          </p>
        </div>
        {onRefresh ? (
          <Button size="sm" variant="ghost" busy={refreshing} onClick={onRefresh}>
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        ) : null}
      </div>
      <ol className={cn("ac-readiness__list", compact ? "text-xs" : "text-sm")}>
        {steps.map((step) => (
          <li key={step.id} className="ac-readiness__step">
            <span className={cn(
              "ac-readiness__mark",
              step.ready
                ? "border-success/30 bg-success/10 text-success"
                : "border-control-strong bg-surface-raised text-ink-faint",
            )}>
              {!status && step.id === "install"
                ? <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
                : step.ready
                  ? <Check className="size-3" />
                  : <Circle className="size-2.5" />}
            </span>
            <span className="min-w-0">
              <strong className="ac-readiness__label">{step.label}</strong>
              <span className="ac-readiness__detail">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
