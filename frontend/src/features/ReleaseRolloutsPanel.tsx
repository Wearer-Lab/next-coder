import { AlertTriangle, ChevronDown, ChevronUp, Pause, Play, Plus, RefreshCw, RotateCcw, Square, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Controller } from "../controller";
import { formatRelativeTime } from "../format";
import { Button, Field, Panel, SectionHeader, StatusBadge } from "../ui";
import "./intelligence-control.css";

type TargetKind = "firmware" | "connector";
type RolloutState = "draft" | "running" | "paused" | "completed" | "cancelled" | "rolling_back" | "rolled_back";

interface FirmwareRelease {
  id: string;
  version: string;
  channel: "stable" | "beta";
  hardwareModel: string;
  releaseNotes?: string;
}

interface ReleaseRollout {
  id: string;
  name: string;
  targetKind: TargetKind;
  targetVersion: string;
  rollbackVersion: string | null;
  releaseId: string | null;
  channel: "stable" | "beta";
  cohort: { type: "percentage"; percentage: number } | { type: "allowlist"; targetIds: string[] };
  minimumProtocolVersion: number;
  requiredCapabilities: string[];
  state: RolloutState;
  evidenceRef: string | null;
  progress: { total: number; counts: Record<string, number> };
  updatedAt: string;
}

interface RolloutAssignment {
  id: string;
  targetId: string;
  status: string;
  reasonCode: string | null;
  observedVersion: string | null;
  progress: number | null;
  attempts: number;
  updatedAt: string;
}

const STATE_TONE: Record<string, "neutral" | "info" | "warning" | "success" | "danger"> = {
  draft: "neutral", running: "info", paused: "warning", completed: "success",
  cancelled: "neutral", rolling_back: "warning", rolled_back: "success",
};

export function ReleaseRolloutsPanel({ controller: c }: { controller: Controller }) {
  const [rollouts, setRollouts] = useState<ReleaseRollout[]>([]);
  const [releases, setReleases] = useState<FirmwareRelease[]>([]);
  const [assignments, setAssignments] = useState<Record<string, RolloutAssignment[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [evidenceRef, setEvidenceRef] = useState("");
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<TargetKind>("connector");
  const [name, setName] = useState("");
  const [targetVersion, setTargetVersion] = useState("");
  const [releaseId, setReleaseId] = useState("");
  const [rollbackVersion, setRollbackVersion] = useState("");
  const [channel, setChannel] = useState<"stable" | "beta">("stable");
  const [cohortType, setCohortType] = useState<"percentage" | "allowlist">("percentage");
  const [percentage, setPercentage] = useState(10);
  const [targetIds, setTargetIds] = useState<string[]>([]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [rolloutResult, releaseResult] = await Promise.all([
        c.api<{ rollouts: ReleaseRollout[] }>("/v1/release-rollouts"),
        c.api<{ releases: FirmwareRelease[] }>("/v1/firmware/releases"),
      ]);
      setRollouts(rolloutResult.rollouts);
      setReleases(releaseResult.releases);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Release controls could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const compatibleReleases = useMemo(
    () => releases.filter((release) => release.channel === channel),
    [releases, channel],
  );
  const selectedRelease = compatibleReleases.find((release) => release.id === releaseId) ?? null;
  const rollbackReleases = selectedRelease
    ? compatibleReleases.filter((release) => release.hardwareModel === selectedRelease.hardwareModel && release.id !== selectedRelease.id)
    : [];
  const targets = kind === "connector"
    ? c.connectors.filter((target) => !target.revokedAt).map((target) => ({ id: target.id, label: target.label }))
    : c.devices.filter((target) => !target.revokedAt).map((target) => ({ id: target.id, label: target.label }));

  const create = async () => {
    const version = kind === "firmware" ? selectedRelease?.version ?? "" : targetVersion.trim();
    if (!name.trim() || !version || (kind === "firmware" && !releaseId) || (cohortType === "allowlist" && targetIds.length === 0)) return;
    await c.run("create-release-rollout", "Release rollout draft created.", async () => {
      const result = await c.api<{ rollout: ReleaseRollout }>("/v1/release-rollouts", {
        method: "POST",
        body: {
          name: name.trim(), targetKind: kind, targetVersion: version,
          releaseId: kind === "firmware" ? releaseId : null,
          rollbackVersion: rollbackVersion || null, channel,
          cohort: cohortType === "percentage" ? { type: "percentage", percentage } : { type: "allowlist", targetIds },
          minimumProtocolVersion: 1,
          requiredCapabilities: kind === "firmware" ? ["ota_confirm"] : [],
        },
      });
      setRollouts((current) => [result.rollout, ...current]);
      setCreating(false); setName(""); setTargetVersion(""); setReleaseId(""); setRollbackVersion(""); setTargetIds([]);
      return result;
    });
  };

  const act = async (rollout: ReleaseRollout, action: string, extra: Record<string, unknown> = {}) => {
    if (!evidenceRef.trim()) {
      setError("Enter a non-secret evidence reference before changing rollout state.");
      return;
    }
    setError(null);
    await c.run(`rollout-${action}-${rollout.id}`, `Rollout ${action.replaceAll("_", " ")} recorded.`, async () => {
      const result = await c.api<{ rollout: ReleaseRollout; assignments: RolloutAssignment[] }>(`/v1/release-rollouts/${encodeURIComponent(rollout.id)}/actions`, {
        method: "POST", body: { action, evidenceRef: evidenceRef.trim(), ...extra },
      });
      setRollouts((current) => current.map((candidate) => candidate.id === rollout.id ? result.rollout : candidate));
      setAssignments((current) => ({ ...current, [rollout.id]: result.assignments }));
      setEvidenceRef("");
      return result;
    });
  };

  const toggleDetails = async (rollout: ReleaseRollout) => {
    if (expanded === rollout.id) { setExpanded(null); return; }
    setExpanded(rollout.id);
    if (assignments[rollout.id]) return;
    try {
      const result = await c.api<{ rollout: ReleaseRollout; assignments: RolloutAssignment[] }>(`/v1/release-rollouts/${encodeURIComponent(rollout.id)}`);
      setAssignments((current) => ({ ...current, [rollout.id]: result.assignments }));
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : "Rollout targets could not be loaded.");
    }
  };

  return (
    <Panel elevated className="ic-panel overflow-hidden">
      <SectionHeader
        eyebrow="Release safety"
        title="Staged fleet rollouts"
        description="Cohorts never expand or promote on a timer. Every state change requires an operator evidence reference; target status comes from device or connector observations."
        action={<div className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw className="size-3.5" /> Refresh</Button><Button size="sm" onClick={() => setCreating((value) => !value)}><Plus className="size-3.5" /> New rollout</Button></div>}
      />
      <div className="space-y-4 border-t border-control p-5">
        {creating ? <div className="ic-card grid gap-3 md:grid-cols-2">
          <Field label="Rollout name" htmlFor="rollout-name"><input id="rollout-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></Field>
          <Field label="Target" htmlFor="rollout-kind"><select id="rollout-kind" value={kind} onChange={(event) => { setKind(event.target.value as TargetKind); setTargetIds([]); }}><option value="connector">Connector CLI</option><option value="firmware">Controller firmware</option></select></Field>
          <Field label="Channel" htmlFor="rollout-channel"><select id="rollout-channel" value={channel} onChange={(event) => { setChannel(event.target.value as "stable" | "beta"); setReleaseId(""); setRollbackVersion(""); }}><option value="stable">Stable</option><option value="beta">Beta</option></select></Field>
          {kind === "firmware" ? <Field label="Signed release" htmlFor="rollout-release"><select id="rollout-release" value={releaseId} onChange={(event) => { setReleaseId(event.target.value); setRollbackVersion(""); }}><option value="">Select a release</option>{compatibleReleases.map((release) => <option key={release.id} value={release.id}>{release.version} · {release.hardwareModel}</option>)}</select></Field>
            : <Field label="Target version" htmlFor="rollout-version"><input id="rollout-version" value={targetVersion} onChange={(event) => setTargetVersion(event.target.value)} placeholder="0.2.0" /></Field>}
          <Field label="Rollback version" htmlFor="rollout-rollback" hint="Required before rollback can be authorized.">{kind === "firmware" ? <select id="rollout-rollback" value={rollbackVersion} onChange={(event) => setRollbackVersion(event.target.value)}><option value="">No rollback release</option>{rollbackReleases.map((release) => <option key={release.id} value={release.version}>{release.version}</option>)}</select> : <input id="rollout-rollback" value={rollbackVersion} onChange={(event) => setRollbackVersion(event.target.value)} placeholder="0.1.9" />}</Field>
          <Field label="Cohort" htmlFor="rollout-cohort"><select id="rollout-cohort" value={cohortType} onChange={(event) => { setCohortType(event.target.value as "percentage" | "allowlist"); setTargetIds([]); }}><option value="percentage">Stable percentage</option><option value="allowlist">Explicit allowlist</option></select></Field>
          {cohortType === "percentage" ? <Field label="Initial percentage" htmlFor="rollout-percentage"><input id="rollout-percentage" type="number" min={1} max={100} value={percentage} onChange={(event) => setPercentage(Number(event.target.value))} /></Field>
            : <fieldset className="space-y-2 md:col-span-2"><legend className="ac-eyebrow">Targets</legend>{targets.length ? targets.map((target) => <label key={target.id} className="flex items-center gap-2 text-sm text-ink-muted"><input type="checkbox" checked={targetIds.includes(target.id)} onChange={(event) => setTargetIds((current) => event.target.checked ? [...current, target.id] : current.filter((id) => id !== target.id))} /> {target.label} <code>{target.id}</code></label>) : <p className="text-sm text-ink-muted">No eligible targets are enrolled.</p>}</fieldset>}
          <div className="flex gap-2 md:col-span-2"><Button variant="primary" disabled={!name.trim()} busy={c.busyAction === "create-release-rollout"} onClick={() => void create()}>Create draft</Button><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button></div>
        </div> : null}

        <Field label="Evidence reference" htmlFor="rollout-evidence" hint="A ticket, test-run, or incident identifier only. Do not paste logs, prompts, paths, or secrets."><input id="rollout-evidence" value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="test-run:staging-2026-08-27" maxLength={128} /></Field>
        {error ? <div role="alert" className="ic-note flex items-start gap-2 border border-danger/25 bg-danger/8 p-3 text-sm text-danger"><AlertTriangle className="mt-0.5 size-4" /><span>{error}</span><Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw className="size-3.5" /> Retry</Button></div> : null}
        {loading ? <div role="status" className="flex items-center gap-2 text-sm text-ink-muted"><RefreshCw className="size-4 animate-spin" /> Loading release rollouts…</div>
          : rollouts.length === 0 ? <p className="ic-card text-sm text-ink-muted">No staged rollout exists. Create a draft, verify its cohort and compatibility gates, then start it with evidence.</p>
            : rollouts.map((rollout) => {
              const rows = assignments[rollout.id] ?? [];
              const completeCount = (rollout.progress.counts.succeeded ?? 0) + (rollout.progress.counts.rolled_back ?? 0);
              return <article key={rollout.id} className="rollout-card">
                <div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="ic-title text-sm">{rollout.name}</strong><StatusBadge tone={STATE_TONE[rollout.state] ?? "neutral"} label={rollout.state.replaceAll("_", " ")} /><StatusBadge tone="neutral" label={`${rollout.targetKind} ${rollout.targetVersion}`} /></div><p className="mt-1 text-xs text-ink-muted">{rollout.cohort.type === "percentage" ? `${rollout.cohort.percentage}% stable cohort` : `${rollout.cohort.targetIds.length} explicitly selected`} · {completeCount}/{rollout.progress.total} terminal · updated {formatRelativeTime(rollout.updatedAt)}</p>{rollout.evidenceRef ? <p className="mt-1 font-mono text-[11px] text-ink-faint">evidence {rollout.evidenceRef}</p> : null}</div><button type="button" className="ic-toggle inline-flex items-center gap-1" onClick={() => void toggleDetails(rollout)}>{expanded === rollout.id ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />} Targets</button></div>
                <div className="mt-3 flex flex-wrap gap-2">{rollout.state === "draft" ? <Button size="sm" variant="primary" onClick={() => void act(rollout, "start")}><Play className="size-3.5" /> Start</Button> : null}{rollout.state === "running" ? <Button size="sm" onClick={() => void act(rollout, "pause")}><Pause className="size-3.5" /> Pause</Button> : null}{rollout.state === "paused" ? <Button size="sm" variant="primary" onClick={() => void act(rollout, "resume")}><Play className="size-3.5" /> Resume</Button> : null}{["draft", "running", "paused"].includes(rollout.state) ? <Button size="sm" variant="danger-ghost" onClick={() => void act(rollout, "cancel")}><X className="size-3.5" /> Cancel</Button> : null}{["running", "paused", "completed"].includes(rollout.state) && rollout.rollbackVersion ? <Button size="sm" onClick={() => void act(rollout, "rollback")}><RotateCcw className="size-3.5" /> Roll back</Button> : null}{["running", "rolling_back"].includes(rollout.state) ? <Button size="sm" onClick={() => void act(rollout, "complete")}><Square className="size-3.5" /> Complete</Button> : null}{["running", "paused"].includes(rollout.state) && rollout.cohort.type === "percentage" && rollout.cohort.percentage < 100 ? <Button size="sm" onClick={() => void act(rollout, "expand", { percentage: Math.min(100, rollout.cohort.type === "percentage" ? rollout.cohort.percentage + 10 : 100) })}>Expand +10%</Button> : null}</div>
                {expanded === rollout.id ? <div className="rollout-detail mt-3 space-y-2">{rows.length ? rows.map((row) => <div key={row.id} className="flex flex-wrap items-center gap-2 text-xs"><code>{row.targetId}</code><StatusBadge tone={row.status === "failed" || row.status === "blocked" ? "danger" : row.status === "succeeded" || row.status === "rolled_back" ? "success" : "info"} label={row.status.replaceAll("_", " ")} /><span className="text-ink-muted">observed {row.observedVersion ?? "unknown"}{row.progress !== null ? ` · ${row.progress}%` : ""}</span>{row.reasonCode ? <span className="text-danger">{row.reasonCode.replaceAll("_", " ")}</span> : null}{row.reasonCode === "connector_update_requires_local_cli" ? <code>npx @wearer-haitch/connector update --apply --yes --restart-service --version {rollout.state === "rolling_back" ? rollout.rollbackVersion : rollout.targetVersion}</code> : null}</div>) : <p className="text-xs text-ink-muted">No target has been selected or observed yet.</p>}</div> : null}
              </article>;
            })}
      </div>
    </Panel>
  );
}
