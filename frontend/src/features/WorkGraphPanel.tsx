import { Activity, Bot, CircleAlert, GitFork, MonitorCog } from "lucide-react";

import { formatRelativeTime } from "../format";
import type { LiveThreadState, LiveThreadStatus } from "../liveThread";
import type { WorkNode, WorkStatus } from "../workGraph";
import { StatusBadge } from "../ui";
import "./intelligence-control.css";

export interface WorkGraphPanelProps {
  state: LiveThreadState | null;
  status: LiveThreadStatus;
}

/**
 * An evidence viewer, not an orchestration surface. T3's streamed task ids and linkage are shown;
 * no per-agent input/stop control exists because the certified command contract exposes none.
 */
export function WorkGraphPanel({ state, status }: WorkGraphPanelProps) {
  if (!state) return null;

  const connection = connectionLabel(status, state.hasSnapshot);
  const summary = state.work.summary;
  const rows = flattenWorkNodes(state.work.nodes);
  const noNodes = summary.total === 0;
  const activeLabel = summary.active === 1 ? "1 active" : `${summary.active} active`;
  const completedLabel = summary.completed === 1 ? "1 complete" : `${summary.completed} complete`;
  const failedLabel = summary.failed === 1 ? "1 failed" : `${summary.failed} failed`;

  return (
    <details
      className="work-inspector ic-scope ic-work"
      data-connection={connection.tone}
      aria-label="Agents and work inspector"
    >
      <summary>
        <span className="work-inspector__icon" aria-hidden="true">
          {summary.background > 0 && summary.agents === 0
            ? <MonitorCog className="size-4" />
            : <GitFork className="size-4" />}
        </span>
        <span className="work-inspector__summary">
          <strong className="ic-title">Agents &amp; work</strong>
          <small>
            {!state.hasSnapshot
              ? "Waiting for the authoritative task snapshot"
              : noNodes
                ? "No structured T3 task activity in this window"
                : `${summary.total} shown · ${activeLabel} · ${completedLabel}${summary.failed ? ` · ${failedLabel}` : ""}`}
          </small>
        </span>
        <StatusBadge tone={connection.badgeTone} label={connection.label} />
      </summary>

      <div className="work-inspector__body" aria-live="polite">
        {!state.hasSnapshot ? (
          <div className="work-inspector__state">
            <Activity className="size-4" aria-hidden="true" />
            <p>
              {status === "stopped"
                ? state.statusError ?? "The thread watch stopped before T3 supplied a snapshot."
                : "Task activity will appear after the thread snapshot is synchronized."}
            </p>
          </div>
        ) : noNodes ? (
          <div className="work-inspector__state">
            <Bot className="size-4" aria-hidden="true" />
            <p>
              This thread window contains no <code>task.*</code> activities. Next Coder does
              not infer agents from tool names, messages, or timing.
            </p>
          </div>
        ) : (
          <>
            {status !== "live" ? (
              <div className="work-inspector__notice" role="note">
                <CircleAlert className="size-4" aria-hidden="true" />
                <div>
                  <p>
                    {status === "stopped"
                      ? "This is the last synchronized task state. It is not live."
                      : "The task roster may be stale while the thread stream reconnects."}
                  </p>
                  {status === "stopped" && state.statusError ? (
                    <code>{state.statusError}</code>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="work-inspector__facts">
              <span>{summary.agents} {summary.agents === 1 ? "agent" : "agents"}</span>
              <span>{summary.background} background</span>
              {summary.waiting ? <span>{summary.waiting} waiting</span> : null}
              {summary.stopped ? <span>{summary.stopped} stopped</span> : null}
              {state.backgroundLiveness ? (
                <span>Background {state.backgroundLiveness}</span>
              ) : null}
            </div>

            <p className="work-inspector__provenance">
              {state.work.relationshipMode === "tree"
                ? "Hierarchy uses only parentAgentId/agentId links supplied by T3."
                : "T3 supplied no parent links in this window, so this is an activity roster, not an inferred tree."}
            </p>

            <ol className="work-tree" aria-label="T3 task activity">
              {rows.map(({ node, depth, missingParent }) => (
                <li key={node.id} style={{ paddingInlineStart: `${Math.min(depth, 5) * 14}px` }}>
                  <WorkNodeRow node={node} missingParent={missingParent} />
                </li>
              ))}
            </ol>

            {state.work.truncated ? (
              <p className="work-inspector__bounded" role="note">
                Showing the newest {state.work.nodes.length} tasks; {state.work.omittedNodes} older
                {state.work.omittedNodes === 1 ? " task was" : " tasks were"} omitted to keep the live view bounded.
              </p>
            ) : null}

            <p className="work-inspector__controls">
              T3 exposes no stable per-task input, stop, or resume command in this contract. The
              composer and Stop control continue to target the parent thread.
            </p>
          </>
        )}
      </div>
    </details>
  );
}

function WorkNodeRow({ node, missingParent }: { node: WorkNode; missingParent: boolean }) {
  const metadata = [
    node.role,
    node.model,
    node.effort ? `${node.effort} effort` : null,
    node.taskType,
  ].filter(Boolean).join(" · ");
  return (
    <details className="work-node" data-status={node.status}>
      <summary>
        <span className="work-node__rail" aria-hidden="true" />
        <span className="work-node__copy">
          <strong className="ic-title">{node.label}</strong>
          <small>{metadata || kindLabel(node.kind)}</small>
        </span>
        <StatusBadge tone={workStatusTone(node.status)} label={workStatusLabel(node.status)} />
      </summary>
      <div className="work-node__detail">
        {missingParent ? (
          <p className="work-node__missing-parent">
            Parent <code>{node.parentId}</code> is outside this retained thread window.
          </p>
        ) : null}
        {node.workflowName || node.phaseTitle || node.agentPath ? (
          <dl>
            {node.workflowName ? <><dt>Workflow</dt><dd>{node.workflowName}</dd></> : null}
            {node.phaseTitle ? <><dt>Phase</dt><dd>{node.phaseTitle}</dd></> : null}
            {node.agentPath ? <><dt>Path</dt><dd><code>{node.agentPath}</code></dd></> : null}
          </dl>
        ) : null}
        {node.turnId ? <p className="work-node__turn">Turn <code>{node.turnId}</code></p> : null}
        {node.currentTool ? <p><strong>Current tool</strong> {node.currentTool}</p> : null}
        {node.summary ? <p>{node.summary}</p> : null}
        {node.failure ? <p className="work-node__failure">{node.failure}</p> : null}
        {node.usage ? (
          <p className="work-node__usage">
            {node.usage.totalTokens.toLocaleString()} tokens
            {node.usage.toolUses !== null ? ` · ${node.usage.toolUses} tool uses` : ""}
            {node.usage.durationMs !== null ? ` · ${formatDuration(node.usage.durationMs)}` : ""}
          </p>
        ) : null}
        {node.activities.length > 0 ? (
          <ol className="work-node__timeline" aria-label={`${node.label} activity`}>
            {node.activities.map((activity) => (
              <li key={activity.id} data-tone={activity.tone}>
                <span>{activity.kind}</span>
                <p>{activity.summary}</p>
                {activity.at ? <time>{formatRelativeTime(activity.at)}</time> : null}
              </li>
            ))}
          </ol>
        ) : null}
        {node.activitiesTruncated ? (
          <p className="work-node__truncated">Older task activity is not retained in this view.</p>
        ) : null}
      </div>
    </details>
  );
}

interface FlatNode {
  node: WorkNode;
  depth: number;
  missingParent: boolean;
}

function flattenWorkNodes(nodes: readonly WorkNode[]): FlatNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, WorkNode[]>();
  for (const node of nodes) {
    if (!node.parentId || !byId.has(node.parentId) || node.parentId === node.id) continue;
    const rows = children.get(node.parentId) ?? [];
    rows.push(node);
    children.set(node.parentId, rows);
  }
  const ordered = [...nodes].sort((left, right) => left.order - right.order);
  const output: FlatNode[] = [];
  const seen = new Set<string>();
  const visit = (node: WorkNode, depth: number) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    output.push({ node, depth, missingParent: Boolean(node.parentId && !byId.has(node.parentId)) });
    for (const child of (children.get(node.id) ?? []).sort((left, right) => left.order - right.order)) {
      visit(child, depth + 1);
    }
  };
  for (const node of ordered) {
    if (!node.parentId || !byId.has(node.parentId) || node.parentId === node.id) visit(node, 0);
  }
  // A malformed/cyclic upstream link stays visible as a root; it is never followed recursively.
  for (const node of ordered) visit(node, 0);
  return output;
}

function connectionLabel(status: LiveThreadStatus, hasSnapshot: boolean) {
  if (status === "live" && hasSnapshot) return { label: "Live", tone: "live", badgeTone: "success" as const };
  if (status === "stopped") return { label: "Unavailable", tone: "error", badgeTone: "danger" as const };
  if (status === "reconnecting") return { label: "Reconnecting", tone: "stale", badgeTone: "warning" as const };
  if (status === "resuming") return { label: "Resuming", tone: "stale", badgeTone: "warning" as const };
  if (status === "connecting") return { label: "Connecting", tone: "loading", badgeTone: "neutral" as const };
  return { label: hasSnapshot ? "Snapshot" : "Loading", tone: "loading", badgeTone: "neutral" as const };
}

function workStatusTone(status: WorkStatus) {
  if (status === "completed") return "success" as const;
  if (status === "failed") return "danger" as const;
  if (status === "waiting" || status === "queued") return "warning" as const;
  if (status === "working") return "live" as const;
  return "neutral" as const;
}

function workStatusLabel(status: WorkStatus): string {
  return status === "queued" ? "Queued"
    : status === "working" ? "Working"
      : status === "waiting" ? "Waiting"
        : status === "completed" ? "Complete"
          : status === "failed" ? "Failed"
            : "Stopped";
}

function kindLabel(kind: WorkNode["kind"]): string {
  return kind === "agent" ? "Agent"
    : kind === "background" ? "Background task"
      : "Task (legacy activity)";
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 100) / 10} s`;
  return `${Math.round(milliseconds / 6000) / 10} min`;
}
