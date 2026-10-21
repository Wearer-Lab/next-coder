import { AlertTriangle, Cable, Check, Clipboard, LoaderCircle, PauseCircle, RefreshCw, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { Connector, Environment, EnvironmentFailure, EnvironmentFailureReason } from "../types";
import { Button } from "../ui";
// The recovery dialog speaks the same language as the rest of the console
// now: a hairline glass card, a pixel title and a glowing white pill.
import "./intelligence-onboarding.css";

const T3_SETUP_COMMAND = "npm run setup:t3";

interface RecoveryStep {
  title: string;
  body: ReactNode;
  /** Rendered as a copyable command block under the step body. */
  command?: string;
}

interface RecoveryContent {
  eyebrow: string;
  title: string;
  summary: string;
  steps: RecoveryStep[];
}

interface WorkspaceRecoveryDialogProps {
  open: boolean;
  /** The gateway's classification. Null falls back to the generic unreachable copy. */
  failure: EnvironmentFailure | null;
  environment?: Environment | null;
  connector?: Connector | null;
  retrying?: boolean;
  checking?: boolean;
  onClose: () => void;
  onRetry: () => void;
  onOpenEnvironments: () => void;
}

function versionLabel(value: string | null | undefined): string {
  return value && value.trim() ? value : "unknown";
}

// The failure envelope never carries a token, and nothing here may add one: the dialog is the
// screen an owner is most likely to screenshot when asking for help.
function recoveryContent(
  failure: EnvironmentFailure | null,
  onOpenEnvironments: () => void,
  environment: Environment | null,
  connector: Connector | null,
): RecoveryContent {
  const reason: EnvironmentFailureReason = failure?.reason ?? "unknown";
  const summary = failure?.message ?? "T3 snapshot is unavailable.";
  const address = failure?.baseUrl ?? null;

  if ((environment?.transportMode ?? "direct") === "connector") {
    const revoked = reason === "connector_revoked" || connector?.status === "revoked" || Boolean(connector?.revokedAt);
    const incompatible = reason === "connector_incompatible" || connector?.status === "incompatible";
    if (revoked) {
      return {
        eyebrow: "Connector revoked",
        title: "Create a new connector enrollment",
        summary,
        steps: [
          {
            title: "Open this environment's enrollment settings",
            body: (
              <>
                <span>The revoked secret cannot be displayed or reused. Generate a new single-use command for this environment.</span>
                <span className="mt-2 block">
                  <Button size="sm" onClick={onOpenEnvironments}><Cable className="size-4" aria-hidden="true" /> Create new enrollment</Button>
                </span>
              </>
            ),
          },
          {
            title: "Run the new command on the workspace computer",
            body: "Keep it running until the console reports a current connector heartbeat and local T3 health.",
          },
        ],
      };
    }
    if (incompatible) {
      return {
        eyebrow: "Connector incompatible",
        title: "Update the connector on the workspace computer",
        summary,
        steps: [
          {
            title: "Inspect the installed connector",
            body: `This connector reports ${versionLabel(connector?.connectorVersion)} using protocol ${versionLabel(connector?.protocolVersion == null ? null : String(connector.protocolVersion))}.`,
            command: "npx @agent-controller/connector status",
          },
          {
            title: "Install a current published release",
            body: "Use your normal npm or npx update workflow, then create a new enrollment if the connector says its credential is no longer valid.",
            command: "npm view @agent-controller/connector version",
          },
        ],
      };
    }

    const t3Health = connector?.lastT3Health;
    const t3Problem = t3Health === "stopped" || t3Health === "auth_failed" || t3Health === "error";
    return {
      eyebrow: t3Problem ? "Local T3 needs attention" : "Connector offline",
      title: t3Problem ? "Repair T3 on the workspace computer" : "Bring the connector back online",
      summary,
      steps: [
        {
          title: t3Problem ? "Check T3 and connector health locally" : "Wake the workspace computer and check the connector",
          body: t3Health === "stopped"
            ? "T3 is stopped on the workspace computer. Start it there, then confirm the connector is still running."
            : t3Health === "auth_failed"
              ? "The connector reached T3 but its local credential was rejected. Refresh that credential on the workspace computer; do not paste it into this console."
              : "The cloud has no current connector heartbeat. Wake the computer, restore its network, and inspect the local process.",
          command: "npx @agent-controller/connector status",
        },
        {
          title: "Run local diagnostics",
          body: "Doctor checks the outbound cloud route and local T3 access without sending T3 or provider credentials to Agent Controller.",
          command: "npx @agent-controller/connector doctor",
        },
      ],
    };
  }

  const credentialSteps: RecoveryStep[] = [
    {
      title: "Get a fresh pairing token",
      body: "Run the guided setup on the workspace computer and copy the pairing token it prints. Tokens are single-use and short-lived, so mint a new one rather than reusing an old note.",
      command: T3_SETUP_COMMAND,
    },
    {
      title: "Paste it into this environment's credential",
      body: (
        <>
          <span>
            Open the connection editor for this environment and replace the stored credential. The
            workspace reloads on its own once the new token is accepted.
          </span>
          <span className="mt-2 block">
            <Button size="sm" onClick={onOpenEnvironments}>
              <Cable className="size-4" aria-hidden="true" /> Open credential settings
            </Button>
          </span>
        </>
      ),
    },
  ];

  switch (reason) {
    case "process_not_running":
      return {
        eyebrow: "T3 Code is not running",
        title: "Start T3 Code on the workspace computer",
        summary,
        steps: [
          {
            title: "Start T3 Code on the workspace computer",
            body: "Nothing is listening on the saved address. From the Agent Controller project on that machine, run the guided setup again:",
            command: T3_SETUP_COMMAND,
          },
          {
            title: "Leave it running",
            body: "Keep the terminal open until setup reports that T3 Code is listening and paired. Agent Controller reconnects on its own.",
          },
        ],
      };
    case "token_expired":
      return {
        eyebrow: "Credential expired",
        title: "Re-pair this T3 environment",
        summary,
        steps: credentialSteps,
      };
    case "authentication_failed":
      return {
        eyebrow: "Credential rejected",
        title: "Replace this environment's credential",
        summary,
        steps: [
          {
            title: "Check the credential is still valid",
            body: "The T3 host answered but refused the stored credential. It was most likely rotated or revoked on that machine.",
          },
          ...credentialSteps,
        ],
      };
    case "network_unreachable":
      return {
        eyebrow: "Host unreachable",
        title: "Check the route to the T3 host",
        summary,
        steps: [
          {
            title: "Confirm the saved address",
            body: address
              ? "Agent Controller is dialling this address:"
              : "No address is saved for this environment. Add one in the connection settings.",
            command: address ?? undefined,
          },
          {
            title: "Check the host and the path to it",
            body: "Make sure the workspace computer is awake and on the network, that the port is open, and that any tunnel (Tailscale, ngrok) in front of it is still up.",
          },
        ],
      };
    case "tls_error":
      return {
        eyebrow: "TLS not verified",
        title: "Fix the T3 host certificate",
        summary,
        steps: [
          {
            title: "Confirm the saved address",
            body: address
              ? "Agent Controller is dialling this address:"
              : "No address is saved for this environment. Add one in the connection settings.",
            command: address ?? undefined,
          },
          {
            title: "Check the certificate",
            body: "The certificate could not be verified. Confirm it is issued for this hostname, that its chain is complete and unexpired, and prefer the HTTPS address your tunnel provides over a self-signed one.",
          },
        ],
      };
    case "contract_incompatible":
      return {
        eyebrow: "Version not supported",
        title: "Update T3 Code on the workspace computer",
        summary,
        steps: [
          {
            title: "Compare versions",
            body: (
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-ink-faint">Installed</dt>
                <dd className="font-mono text-ink">{versionLabel(failure?.installedVersion)}</dd>
                <dt className="text-ink-faint">Minimum supported</dt>
                <dd className="font-mono text-ink">{versionLabel(failure?.minimumVersion)}</dd>
                <dt className="text-ink-faint">Highest tested</dt>
                <dd className="font-mono text-ink">{versionLabel(failure?.maximumTestedVersion)}</dd>
              </dl>
            ),
          },
          {
            title: "Update, then re-check compatibility",
            body: "Install a supported T3 Code release on the workspace computer, then run the guided setup so this environment re-registers its version:",
            command: T3_SETUP_COMMAND,
          },
        ],
      };
    default:
      return {
        eyebrow: "Connection interrupted",
        title: "Restart and reconnect T3 Code",
        summary,
        steps: [
          {
            title: "Restart T3 Code on the workspace computer",
            body: "From the Agent Controller project, run the guided setup again:",
            command: T3_SETUP_COMMAND,
          },
          {
            title: "Confirm the connection",
            body: "Wait until setup reports that T3 Code is listening and paired. If its URL or credential changed, update the environment connection before trying again.",
          },
        ],
      };
  }
}

export function WorkspaceRecoveryDialog({
  open,
  failure,
  environment = null,
  connector = null,
  retrying = false,
  checking = false,
  onClose,
  onRetry,
  onOpenEnvironments,
}: WorkspaceRecoveryDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(command);
      setCopyFailed(false);
    } catch {
      setCopied(null);
      setCopyFailed(true);
    }
  };

  useEffect(() => {
    if (!open) {
      setCopied(null);
      setCopyFailed(false);
    }
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(null), 2200);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    retryButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
  }, [onClose, open]);

  if (!open) return null;

  const content = recoveryContent(failure, onOpenEnvironments, environment, connector);
  const retryable = ((environment?.transportMode ?? "direct") === "connector" && (connector?.status === "revoked" || connector?.revokedAt))
    ? false
    : failure?.retryable ?? true;

  return (
    <div
      className="workspace-recovery fixed inset-0 z-[110] grid place-items-center overflow-y-auto bg-black/65 p-4 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-recovery-title"
        aria-describedby="workspace-recovery-description"
        className="workspace-recovery__dialog w-full max-w-lg rounded-xl border border-control-strong bg-surface-raised shadow-raised"
      >
        <div className="workspace-recovery__header flex items-start gap-3 border-b border-control px-5 py-4">
          <div className="workspace-recovery__icon grid size-10 shrink-0 place-items-center rounded-lg border border-warning/20 bg-warning/10 text-warning">
            <AlertTriangle className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="ac-eyebrow workspace-recovery__eyebrow">{content.eyebrow}</p>
            <h2 id="workspace-recovery-title" className="ac-display-title workspace-recovery__title">
              {content.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid size-9 shrink-0 place-items-center rounded-md text-ink-muted outline-none hover:bg-surface-inset hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
            aria-label="Close recovery instructions"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="workspace-recovery__body px-5 py-4">
          <p
            id="workspace-recovery-description"
            className="workspace-recovery__summary rounded-md border border-danger/20 bg-danger/8 px-3 py-2 font-mono text-xs text-danger"
            role="alert"
          >
            {content.summary}
          </p>
          <ol className="workspace-recovery__steps mt-4 grid gap-4 text-sm">
            {content.steps.map((step, index) => (
              <li key={step.title} className="grid grid-cols-[1.5rem_1fr] gap-2">
                <span className="font-mono text-xs text-ink-faint">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <p className="font-semibold text-ink">{step.title}</p>
                  <div className="mt-1 leading-relaxed text-ink-muted">{step.body}</div>
                  {step.command ? (
                    <div className="workspace-recovery__command mt-2 flex items-center gap-2 rounded-md border border-control bg-console p-1.5 pl-3">
                      <code className="min-w-0 flex-1 overflow-x-auto text-xs text-console-ink">
                        {step.command}
                      </code>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="border-control-strong text-console-ink"
                        onClick={() => void copyCommand(step.command as string)}
                        aria-label={copied === step.command
                          ? `${step.command} copied`
                          : `Copy ${step.command}`}
                      >
                        {copied === step.command
                          ? <Check className="size-3.5 text-success" aria-hidden="true" />
                          : <Clipboard className="size-3.5" aria-hidden="true" />}
                        <span aria-live="polite">
                          {copied === step.command ? "Copied" : copyFailed ? "Try copy again" : "Copy"}
                        </span>
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          {retryable ? (
            <div
              className="workspace-recovery__status mt-4 flex items-start gap-3 rounded-md border border-info/20 bg-info/8 px-3 py-2.5"
              role="status"
              aria-busy={checking}
            >
              {checking
                ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-info motion-reduce:animate-none" aria-hidden="true" />
                : <RefreshCw className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />}
              <div>
                <p className="text-sm font-semibold text-ink">Checking automatically</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                  Operations will reload as soon as T3 Code is available.
                </p>
              </div>
            </div>
          ) : (
            <div
              className="workspace-recovery__status mt-4 flex items-start gap-3 rounded-md border border-control bg-surface-inset px-3 py-2.5"
              role="status"
              aria-busy={false}
            >
              <PauseCircle className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              <div>
                <p className="text-sm font-semibold text-ink">Automatic checks are paused</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                  Retrying cannot help until this is fixed on the workspace computer. Checks resume
                  once the credential changes.
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="workspace-recovery__footer flex flex-col-reverse gap-2 border-t border-control px-5 py-4 sm:flex-row sm:justify-end">
          <Button onClick={onOpenEnvironments}>
            <Cable className="size-4" aria-hidden="true" /> Connection settings
          </Button>
          <Button
            ref={retryButtonRef}
            className="workspace-recovery__cta"
            variant="primary"
            busy={retrying}
            disabled={checking}
            onClick={onRetry}
          >
            <RotateCcw className="size-4" aria-hidden="true" /> Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
