import {
  CheckCircle2,
  Globe2,
  Network,
  Pencil,
  Plus,
  Save,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";

import type { Controller } from "../controller";
import type { GatewayProfile, GatewayProfileMode, RemoteAccessStatus } from "../types";
import { Button, Field, Panel, SectionHeader, StatusBadge, useConfirm } from "../ui";
import "./intelligence-control.css";

interface GatewayProfileDraft {
  id?: string;
  label: string;
  mode: GatewayProfileMode;
  baseUrl: string;
}

const emptyDraft = (): GatewayProfileDraft => ({ label: "", mode: "lan", baseUrl: "" });

function privateLanHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host.endsWith(".local")) return true;
  if (/^10\./u.test(host) || /^192\.168\./u.test(host) || /^169\.254\./u.test(host)) return true;
  const second = Number(host.split(".")[1]);
  if (host.startsWith("172.") && second >= 16 && second <= 31) return true;
  return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

/** Mirrors the gateway's origin-only allow-list without ever parsing or retaining credentials. */
export function gatewayProfileUrlError(mode: GatewayProfileMode, value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Enter a valid gateway origin.";
  }
  if (url.username || url.password) return "Credentials are not allowed in gateway URLs.";
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Gateway URLs must use HTTP or HTTPS.";
  if (url.pathname !== "/" || url.search || url.hash) return "Use the gateway origin only, without a path, query, or fragment.";
  if (mode === "tailnet") {
    if (url.protocol !== "https:" || !url.hostname.toLowerCase().endsWith(".ts.net")) {
      return "Tailnet profiles require a private HTTPS .ts.net origin.";
    }
  }
  if (mode === "custom" && url.protocol !== "https:") return "Custom profiles require HTTPS.";
  if (mode === "lan" && url.protocol === "http:" && !privateLanHost(url.hostname)) {
    return "Plain HTTP is only allowed for private LAN, link-local, or .local hosts.";
  }
  return null;
}

function profileCopy(mode: GatewayProfileMode) {
  if (mode === "tailnet") return { label: "Private Tailnet", tone: "success" as const, icon: ShieldCheck, risk: "Reachable only by authorized Tailnet members." };
  if (mode === "custom") return { label: "External HTTPS", tone: "warning" as const, icon: Globe2, risk: "Confirm authentication and firewall policy on this public or routed origin." };
  return { label: "Local network", tone: "neutral" as const, icon: Network, risk: "Only controllers on a network that can route to this host will connect." };
}

function displayProfileOrigin(profile: GatewayProfile) {
  if (gatewayProfileUrlError(profile.mode, profile.baseUrl)) return "Invalid origin hidden";
  try { return new URL(profile.baseUrl).origin; } catch { return "Invalid origin hidden"; }
}

function reachability(profile: GatewayProfile, remote: RemoteAccessStatus | null) {
  if (profile.mode === "tailnet") {
    return remote?.tailscale.connected && remote.tailscale.serve.active
      ? { label: "Serve active", tone: "success" as const }
      : { label: "Serve needed", tone: "warning" as const };
  }
  if (profile.mode === "lan") {
    return remote?.gateway.lanUrls.length
      ? { label: "LAN detected", tone: "success" as const }
      : { label: "LAN unverified", tone: "neutral" as const };
  }
  return { label: "Externally routed", tone: "warning" as const };
}

export function GatewayProfilesPanel({ controller: c }: { controller: Controller }) {
  const confirm = useConfirm();
  const profiles = c.gatewayProfiles ?? [];
  const [draft, setDraft] = useState<GatewayProfileDraft | null>(null);
  const urlError = draft ? gatewayProfileUrlError(draft.mode, draft.baseUrl) : null;
  const serveActive = Boolean(c.remoteAccess?.tailscale.serve.active);

  const save = async () => {
    if (!draft?.label.trim() || urlError) return;
    const result = await c.run(draft.id ? `update-gateway-profile-${draft.id}` : "create-gateway-profile", draft.id ? "Gateway profile updated." : "Gateway profile created.", async () => {
      const response = await c.api(draft.id ? `/v1/gateway-profiles/${encodeURIComponent(draft.id)}` : "/v1/gateway-profiles", {
        method: draft.id ? "PUT" : "POST",
        body: { label: draft.label.trim(), mode: draft.mode, baseUrl: new URL(draft.baseUrl.trim()).origin },
      });
      await c.refreshAll();
      return response;
    });
    if (result) setDraft(null);
  };

  const remove = async (profile: GatewayProfile) => {
    const accepted = await confirm({
      title: `Delete “${profile.label}”?`,
      description: "A profile currently active or pending on a controller cannot be deleted until that controller switches away.",
      confirmLabel: "Delete profile",
    });
    if (!accepted) return;
    await c.run(`delete-gateway-profile-${profile.id}`, "Gateway profile deleted.", async () => {
      const response = await c.api(`/v1/gateway-profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
      await c.refreshAll();
      return response;
    });
  };

  const setServe = async (enabled: boolean) => {
    if (!enabled) {
      const accepted = await confirm({
        title: "Disable private Tailscale Serve?",
        description: "Controllers using a Tailnet profile may lose gateway access until another route is applied.",
        confirmLabel: "Disable Serve",
      });
      if (!accepted) return;
    }
    await c.run("configure-private-serve", enabled ? "Private Tailscale Serve enabled." : "Private Tailscale Serve disabled.", async () => {
      const response = await c.api<{ remoteAccess: RemoteAccessStatus }>("/v1/settings/remote-access/serve", {
        method: "POST",
        body: { enabled },
      });
      await c.loadRemoteAccess(true);
      return response;
    });
  };

  return (
    <Panel elevated className="gateway-profiles-panel ic-panel overflow-hidden">
      <SectionHeader
        eyebrow="Controller routing"
        title="Gateway profiles"
        description="Save trusted gateway origins, then stage a rollback-safe switch from each controller. URLs never contain device credentials."
        action={<Button size="sm" variant="primary" onClick={() => setDraft(emptyDraft())}><Plus className="size-3.5" /> Add profile</Button>}
      />
      <div className="gateway-profile-network">
        <div>
          <span className="gateway-profile-network__icon"><ShieldCheck className="size-4" /></span>
          <div>
            <strong>Private Tailscale Serve</strong>
            <p>{c.remoteAccess?.tailscale.connected ? "This gateway is connected to Tailscale." : "Connect this gateway to Tailscale before enabling Serve."}</p>
          </div>
        </div>
        <StatusBadge tone={serveActive ? "success" : "neutral"} label={serveActive ? "private route active" : "not configured"} pulse={serveActive} />
        <Button
          size="sm"
          variant={serveActive ? "danger-ghost" : "primary"}
          busy={c.busyAction === "configure-private-serve"}
          disabled={!serveActive && !c.remoteAccess?.tailscale.connected}
          onClick={() => void setServe(!serveActive)}
        >{serveActive ? "Disable Serve" : "Enable private Serve"}</Button>
      </div>

      <div className="gateway-profile-grid">
        {profiles.map((profile) => {
          const copy = profileCopy(profile.mode);
          const Icon = copy.icon;
          const reachable = reachability(profile, c.remoteAccess);
          return (
            <article key={profile.id} className="gateway-profile-card">
              <div className="gateway-profile-card__heading">
                <span><Icon className="size-4" /></span>
                <div><h3>{profile.label}</h3><p>{profile.mode}</p></div>
                <StatusBadge tone={reachable.tone} label={reachable.label} />
              </div>
              <code>{displayProfileOrigin(profile)}</code>
              <div className="gateway-profile-card__risk"><ShieldAlert className="size-3.5" /><span>{copy.risk}</span></div>
              <div className="gateway-profile-card__footer">
                <StatusBadge tone={copy.tone} label={copy.label} />
                <Button size="icon" variant="ghost" aria-label={`Edit ${profile.label}`} onClick={() => setDraft({ id: profile.id, label: profile.label, mode: profile.mode, baseUrl: profile.baseUrl })}><Pencil className="size-3.5" /></Button>
                <Button size="icon" variant="danger-ghost" aria-label={`Delete ${profile.label}`} onClick={() => void remove(profile)}><Trash2 className="size-3.5" /></Button>
              </div>
            </article>
          );
        })}
        {!profiles.length ? (
          <div className="gateway-profile-empty">
            <Network className="size-5" /><strong>No gateway profiles yet</strong><p>Add a LAN, private Tailnet, or custom HTTPS origin for your controllers.</p>
          </div>
        ) : null}
      </div>

      {draft ? (
        <div className="gateway-profile-form" role="dialog" aria-modal="true" aria-labelledby="gateway-profile-form-title">
          <header><div><p className="ac-eyebrow">Trusted origin</p><h3 id="gateway-profile-form-title" className="ic-title">{draft.id ? "Edit gateway profile" : "Add gateway profile"}</h3></div><Button size="icon" variant="ghost" aria-label="Close gateway profile editor" onClick={() => setDraft(null)}><X className="size-4" /></Button></header>
          <div className="gateway-profile-form__body">
            <Field label="Profile label" htmlFor="gateway-profile-label"><input id="gateway-profile-label" autoFocus value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="Studio LAN" /></Field>
            <Field label="Access mode" htmlFor="gateway-profile-mode"><select id="gateway-profile-mode" value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as GatewayProfileMode })}><option value="lan">LAN</option><option value="tailnet">Private Tailnet</option><option value="custom">Custom HTTPS</option></select></Field>
            <Field label="Gateway origin" htmlFor="gateway-profile-url" error={urlError}><input id="gateway-profile-url" type="url" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder={draft.mode === "tailnet" ? "https://gateway.example.ts.net" : draft.mode === "lan" ? "http://192.168.1.25:3996" : "https://gateway.example.com"} /></Field>
            <div className="gateway-profile-form__note ic-note"><CheckCircle2 className="size-4" /><span>Only an origin is stored. Credentials, paths, query strings, fragments, and unsafe URL schemes are rejected.</span></div>
          </div>
          <footer><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" disabled={!draft.label.trim() || Boolean(urlError)} busy={c.busyAction === (draft.id ? `update-gateway-profile-${draft.id}` : "create-gateway-profile")} onClick={() => void save()}><Save className="size-4" /> Save profile</Button></footer>
        </div>
      ) : null}
    </Panel>
  );
}
