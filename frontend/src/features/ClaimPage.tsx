import { CheckCircle2, CircleAlert, KeyRound, LogIn, ScanLine } from "lucide-react";
import { useState } from "react";

import { type ClaimLink, consumeClaimUrl, normalizeClaimCode } from "../claimLink";
import type { Controller } from "../controller";
import type { Device } from "../types";
import { Button, Field, Panel } from "../ui";
// The claim landing is a standalone arrival, so it carries the marketing
// pages' own language: black canvas, glass card, white disc, glowing pill.
import "./intelligence-onboarding.css";

interface ClaimPageProps {
  controller: Controller;
  link: ClaimLink;
  /** Called once the link is resolved, so the host can drop back to normal routing. */
  onDone: (outcome: { device: Device | null }) => void;
}

type Phase = "ready" | "claiming" | "claimed" | "rejected";

/**
 * The landing a scanned controller QR arrives at. It exists so the code the owner just scanned is
 * used, rather than discarded by the hash router — and so an expired or already-used code says so
 * instead of surfacing as a generic toast on a page that gives no hint of what failed.
 */
export function ClaimPage({ controller: c, link, onDone }: ClaimPageProps) {
  const [label, setLabel] = useState("");
  const [phase, setPhase] = useState<Phase>("ready");
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<Device | null>(null);

  const claim = async () => {
    setPhase("claiming");
    setError(null);
    try {
      const result = await c.api<{ device: Device }>("/v1/devices/claim", {
        method: "POST",
        body: { claimCode: link.code, label: label.trim() || undefined },
      });
      setDevice(result.device);
      setPhase("claimed");
      // The code is single-use and now spent; take it out of the address bar so it cannot be
      // re-shared in a screenshot or a copied URL.
      consumeClaimUrl("#/devices");
    } catch (cause) {
      const status = (cause as { status?: number })?.status;
      const message = cause instanceof Error ? cause.message : "Claiming this controller failed.";
      // 404 is the server's answer for invalid, expired, and already-claimed alike — a dead end
      // the owner cannot retry out of, so it gets its own screen rather than an inline error.
      if (status === 404) setPhase("rejected");
      else setPhase("ready");
      setError(message);
    }
  };

  if (!c.authenticated) {
    return (
      <ClaimShell
        icon={LogIn}
        title="Sign in to claim this controller"
        subtitle={`Controller ${link.deviceId}`}
      >
        <p className="text-sm text-ink-muted">
          Your claim code is saved for this tab and will be filled in as soon as you are signed in.
        </p>
        <CodeReadout code={link.code} />
        <Button
          className="claim-landing__cta w-full"
          variant="primary"
          onClick={() => {
            if (c.clerk) c.clerk.openSignIn();
            else onDone({ device: null });
          }}
        >
          <LogIn className="size-4" /> Sign in to continue
        </Button>
      </ClaimShell>
    );
  }

  if (phase === "claimed" && device) {
    return (
      <ClaimShell
        icon={CheckCircle2}
        tone="success"
        title="Controller claimed"
        subtitle={device.label ?? device.id}
      >
        <p className="text-sm text-ink-muted">
          This controller now belongs to your account. Point it at an environment and thread to
          finish setup.
        </p>
        <Button className="claim-landing__cta w-full" variant="primary" onClick={() => onDone({ device })}>
          Continue setup
        </Button>
      </ClaimShell>
    );
  }

  if (phase === "rejected") {
    return (
      <ClaimShell
        icon={CircleAlert}
        tone="danger"
        title="This code cannot be used"
        subtitle={`Controller ${link.deviceId}`}
      >
        <p className="text-sm text-ink-muted">
          {error ?? "The claim code is invalid, expired, or already used."}
        </p>
        <p className="text-sm text-ink-muted">
          If the controller is still unclaimed, use its menu to issue a fresh setup code, then enter
          that code on the Devices page.
        </p>
        <Button
          className="claim-landing__cta w-full"
          variant="primary"
          onClick={() => {
            consumeClaimUrl("#/devices");
            onDone({ device: null });
          }}
        >
          Enter a code manually
        </Button>
      </ClaimShell>
    );
  }

  return (
    <ClaimShell icon={ScanLine} title="Claim this controller" subtitle={`Controller ${link.deviceId}`}>
      <CodeReadout code={link.code} />
      <Field label="Name this controller" htmlFor="claim-label" hint="Optional. You can rename it later.">
        <input
          id="claim-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Desk controller"
          disabled={phase === "claiming"}
        />
      </Field>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button className="claim-landing__cta w-full" variant="primary" onClick={() => void claim()} disabled={phase === "claiming"}>
        <KeyRound className="size-4" />
        {phase === "claiming" ? "Claiming…" : "Claim this controller"}
      </Button>
      <button
        type="button"
        className="text-xs text-ink-muted underline"
        onClick={() => {
          consumeClaimUrl("#/devices");
          onDone({ device: null });
        }}
      >
        Not now
      </button>
    </ClaimShell>
  );
}

function CodeReadout({ code }: { code: string }) {
  return (
    <div className="claim-code" aria-label="Claim code">
      {/* Read-only: it came from the QR, and letting it be edited invites typos into a value the
          owner never had to type. Manual entry lives on the Devices page. */}
      <code>{normalizeClaimCode(code)}</code>
    </div>
  );
}

function ClaimShell({
  icon: Icon,
  title,
  subtitle,
  tone = "default",
  children,
}: {
  icon: typeof ScanLine;
  title: string;
  subtitle: string;
  tone?: "default" | "success" | "danger";
  children: React.ReactNode;
}) {
  return (
    <div className="claim-landing">
      <Panel className="claim-landing__card" elevated>
        <div className="claim-landing__icon" data-tone={tone}>
          <Icon className="size-6" aria-hidden="true" />
        </div>
        <h1 className="ac-display-title claim-landing__title">{title}</h1>
        <p className="ac-eyebrow claim-landing__subtitle">{subtitle}</p>
        <div className="claim-landing__body">{children}</div>
      </Panel>
    </div>
  );
}
