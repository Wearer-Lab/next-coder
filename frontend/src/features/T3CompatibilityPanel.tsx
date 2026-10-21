import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clipboard,
  RefreshCw,
  Server,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { Controller } from "../controller";
import { formatRelativeTime } from "../format";
import type {
  T3CompatibilityOverview,
  T3CompatibilityResult,
  T3CompatibilityStatus,
} from "../types";
import { Button, EmptyState, Metric, Panel, SectionHeader, StatusBadge } from "../ui";
import "./intelligence-control.css";

const STATUS_LABELS: Record<T3CompatibilityStatus, string> = {
  unchecked: "Not checked",
  compatible: "Compatible",
  update_recommended: "Update recommended",
  review_required: "Review required",
  incompatible: "Could break",
  unknown: "Version unknown",
};

function statusTone(status: T3CompatibilityStatus) {
  if (status === "compatible") return "success" as const;
  if (status === "update_recommended" || status === "review_required" || status === "unknown") {
    return "warning" as const;
  }
  if (status === "incompatible") return "danger" as const;
  return "neutral" as const;
}

export function T3CompatibilityPanel({ controller: c }: { controller: Controller }) {
  const [overview, setOverview] = useState<T3CompatibilityOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    c.api<T3CompatibilityOverview>("/v1/settings/t3-compatibility")
      .then((result) => {
        if (!cancelled && result) setOverview(result);
      })
      .catch(() => {
        // The controller already presents request failures globally.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [c.api]);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2200);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const runChecks = async () => {
    const result = await c.run(
      "t3-compatibility-check",
      "T3 Code compatibility checks completed.",
      () => c.api<T3CompatibilityOverview>("/v1/settings/t3-compatibility", {
        method: "POST",
        body: {},
      }),
    );
    if (!result) return;
    setOverview(result);
    await c.refreshAll();
  };

  const copyUpdateCommand = async () => {
    if (!overview?.release.recommendedVersion) return;
    try {
      await navigator.clipboard.writeText(
        `npm install --global t3@${overview.release.recommendedVersion}`,
      );
      setCopied(true);
    } catch {
      c.setNotice({
        tone: "danger",
        message: "Clipboard access was blocked. Select and copy the update command manually.",
      });
    }
  };

  const summaryTone = overview?.summary.breakingRisks || overview?.summary.incompatible
    ? "danger"
    : overview?.summary.needsAttention
      ? "warning"
      : overview?.results.length && overview.summary.unchecked === 0
        ? "success"
        : "neutral";
  const summaryLabel = loading
    ? "Checking releases"
    : overview?.summary.breakingRisks
      ? "Breaking risk"
      : overview?.summary.needsAttention
        ? "Review needed"
        : overview?.results.length && overview.summary.unchecked === 0
          ? "Compatible"
          : "Not checked";

  return (
    <Panel elevated className="ic-panel overflow-hidden">
      <SectionHeader
        eyebrow="Compatibility"
        title="T3 Code versions"
        description="Read each host’s installed version, validate the live API contract, and compare it with the latest supported release. Checks are read-only."
        action={<StatusBadge tone={summaryTone} label={summaryLabel} />}
      />

      {overview?.release.alert ? (
        <div className="ic-note mx-5 mt-1 flex items-start gap-3 border border-warning/25 bg-warning/8 p-3 text-sm text-warning" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold">New T3 Code release needs review</p>
            <p className="mt-1 text-xs leading-relaxed text-warning-strong">
              {overview.release.alert} Keep using {overview.release.recommendedVersion} for certified compatibility until a newer release passes these checks.
            </p>
          </div>
        </div>
      ) : null}

      <div className="mt-4 border-t border-control">
        {loading && !overview ? (
          <EmptyState
            compact
            icon={RefreshCw}
            title="Loading T3 version status"
            description="Checking the supported release policy and saved host results."
          />
        ) : overview?.results.length ? (
          <div className="divide-y divide-control">
            {overview.results.map((result) => (
              <CompatibilityRow key={result.environmentId} result={result} />
            ))}
          </div>
        ) : (
          <EmptyState
            compact
            icon={Server}
            title="No T3 environments"
            description="Pair a T3 Code host before running version and compatibility checks."
          />
        )}
      </div>

      <div className="ic-metrics-band grid gap-4 border-t border-control p-5 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <dl className="ic-metrics grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Metric label="Latest release" value={overview?.release.latestVersion ?? "Unavailable"} />
            <Metric label="Minimum supported" value={overview?.release.minimumVersion ?? "0.0.28"} />
            <Metric label="Recommended" value={overview?.release.recommendedVersion ?? "0.0.28"} />
          </dl>
          {overview?.release.latestError ? (
            <p className="mt-3 text-xs text-warning" role="status">
              Latest-release lookup failed: {overview.release.latestError}
            </p>
          ) : null}
          {overview?.release.recommendedVersion ? (
            <div className="ic-console ic-console--inline mt-4 flex max-w-xl items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs text-console-ink">
                npm install --global t3@{overview.release.recommendedVersion}
              </code>
              <Button size="sm" variant="ghost" className="border-control-strong text-console-ink" onClick={() => void copyUpdateCommand()}>
                {copied
                  ? <Check className="size-3.5 text-success" aria-hidden="true" />
                  : <Clipboard className="size-3.5" aria-hidden="true" />}
                <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
              </Button>
            </div>
          ) : null}
        </div>
        <Button
          variant="primary"
          busy={c.busyAction === "t3-compatibility-check"}
          disabled={c.environments.length === 0}
          onClick={() => void runChecks()}
        >
          <ShieldCheck className="size-4" aria-hidden="true" /> Run compatibility checks
        </Button>
      </div>
    </Panel>
  );
}

function CompatibilityRow({ result }: { result: T3CompatibilityResult }) {
  const capabilityEntries = Object.values(result.capabilities?.features ?? {});
  const supportedCapabilities = capabilityEntries.filter((entry) => entry.state === "supported").length;
  return (
    <article className="px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Server className="size-4 text-ink-muted" aria-hidden="true" />
            <h3 className="ic-title text-sm">{result.environmentLabel}</h3>
            <StatusBadge tone={statusTone(result.status)} label={STATUS_LABELS[result.status]} />
          </div>
          <p className="mt-2 font-mono text-xs text-ink-muted">
            Installed: {result.installedVersion ?? "not reported"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">{result.recommendation}</p>
          {result.capabilities ? (
            <p className="mt-1 text-xs text-ink-muted">
              Adapter {result.capabilities.contractVersion} · {supportedCapabilities}/{capabilityEntries.length} probed features available
              {result.capabilities.freshness === "stale" ? " · cached result is stale" : ""}
            </p>
          ) : null}
        </div>
        <span className="shrink-0 font-mono text-[10px] text-ink-faint">
          {result.checkedAt ? `Checked ${formatRelativeTime(result.checkedAt)}` : "Never checked"}
        </span>
      </div>

      {result.versionChanged ? (
        <div
          className={`mt-3 flex items-start gap-2 rounded-md border p-3 text-xs ${
            result.breakingRisk
              ? "border-danger/25 bg-danger/8 text-danger"
              : "border-info/20 bg-info/8 text-info-strong"
          }`}
          role={result.breakingRisk ? "alert" : "status"}
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          T3 Code changed from {result.previousVersion} to {result.installedVersion}.
          {result.breakingRisk ? " This change could break Agent Controller." : " The compatibility contract still passes."}
        </div>
      ) : null}

      {result.findings.length ? (
        <div className="mt-3 grid gap-2">
          {result.findings.filter((finding) => finding.code !== "version_changed").map((finding) => (
            <p
              key={finding.code}
              className={finding.level === "danger" ? "text-xs text-danger" : finding.level === "warning" ? "text-xs text-warning" : "text-xs text-info-strong"}
            >
              {finding.message}
            </p>
          ))}
        </div>
      ) : null}

      {result.checks.length ? (
        <details className="t3-compat-detail mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-focus">
            {result.checks.filter((check) => check.passed).length}/{result.checks.length} read-only contract checks passed
          </summary>
          <div className="mt-2 grid gap-2 border-t border-control pt-2">
            {result.checks.map((check) => (
              <div key={check.id} className="grid grid-cols-[16px_1fr] gap-2 text-xs">
                {check.passed
                  ? <CheckCircle2 className="mt-0.5 size-3.5 text-success" aria-hidden="true" />
                  : <XCircle className="mt-0.5 size-3.5 text-danger" aria-hidden="true" />}
                <p>
                  <strong className="text-ink">{check.label}</strong>
                  <span className="ml-1 text-ink-muted">{check.detail}</span>
                </p>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}
