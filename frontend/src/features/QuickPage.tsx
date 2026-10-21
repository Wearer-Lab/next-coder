/**
 * The phone surface: send something, then clear whatever is waiting on a decision.
 *
 * The composer here is the shared one from `Composer.tsx`, deliberately not a fork — a message sent
 * from a phone must take the same intent path and the same policy screening as one sent from
 * Operate. It is kept compact on purpose: approvals are why someone opens this page in a hurry, so
 * the composer must never grow tall enough to push the attention queue past the fold.
 */

import { ArrowRight, Check, CheckCircle2, CircleAlert, Mic, Play, RefreshCw, Send, X, Zap } from "lucide-react";
import { useState } from "react";

import type { Controller } from "../controller";
import { clearDurableMutationRequest, durableMutationRequest } from "../requestId";
import { commandSummary, commandType, formatRelativeTime } from "../format";
import { LiveFrame } from "../motion";
import type { Command, PageId, SavedAction } from "../types";
import { Button, StatusBadge, useConfirm } from "../ui";
import { useWorkspaceLoader } from "../useWorkspaceLoader";
import { composerAvailability } from "../t3CapabilityAvailability";
import {
  AttachmentChips,
  AttachmentSourceMenu,
  ComposerShell,
  buildComposerIntent,
  sendComposerIntent,
  useComposerDraft,
  useFileAttachment,
} from "./Composer";
import { MediaCaptureDialog } from "./MediaCapture";
import "./intelligence-dashboard.css";

interface QuickPageProps {
  controller: Controller;
  onNavigate: (page: PageId) => void;
}

/**
 * One field, one attachment button, one push-to-talk button, Send. No project, model or shell
 * controls — this composer only ever adds to the thread that is already selected, and says so
 * plainly when there is not one yet.
 */
function QuickComposer({
  controller: c,
  onNavigate,
}: {
  controller: Controller;
  onNavigate: (page: PageId) => void;
}) {
  const draft = useComposerDraft(c.media ?? []);
  const attachFiles = useFileAttachment({ controller: c, draft });
  const [recording, setRecording] = useState(false);

  const ready = Boolean(c.selectedEnvironmentId && c.selectedThreadId);
  const hasRequest = Boolean(draft.prompt.trim()) || draft.attachmentIds.length > 0;
  const capability = composerAvailability(c.selectedEnvironment, draft.attachments);
  const canSend = ready && hasRequest && capability.enabled;
  const blockedReason = !c.selectedEnvironmentId
    ? "Pair a T3 environment first."
    : !c.selectedThreadId
      ? "Choose a thread above to send from here."
      : capability.reason ?? "Write a message or attach context.";

  const submit = async () => {
    if (!canSend) return;
    const result = await sendComposerIntent(
      c,
      buildComposerIntent({ mode: "prompt", text: draft.prompt, attachments: draft.attachments }),
      "Message sent.",
    );
    if (result !== undefined) draft.reset();
  };

  return (
    <div className="dashboard-composer">
      <ComposerShell
        compact
        rows={2}
        textareaId="quick-prompt"
        label="Message this thread"
        value={draft.prompt}
        onChange={draft.setPrompt}
        placeholder={ready
          ? "Send a message to this thread…"
          : "Choose a thread above to send from here"}
        canSend={canSend}
        onSubmit={() => void submit()}
        onFiles={ready && capability.enabled ? (files) => void attachFiles(files) : undefined}
        attachments={
          <AttachmentChips
            attachments={draft.attachments}
            onRemove={draft.removeAttachment}
            onMove={draft.moveAttachment}
          />
        }
        actions={
          <>
            <AttachmentSourceMenu
              controller={c}
              draft={draft}
              disabled={!ready || !capability.enabled}
              disabledReason={blockedReason}
            />
            <button
              type="button"
              className="composer-inline-action"
              disabled={!ready || !capability.enabled || draft.atLimit}
              aria-label="Record voice"
              title={ready ? "Record a voice message" : blockedReason}
              onClick={() => setRecording(true)}
            >
              <Mic className="size-3.5" aria-hidden="true" /> Voice
            </button>
          </>
        }
        send={
          <Button
            variant="primary"
            size="icon"
            busy={c.busyAction === "send-intent"}
            disabled={!canSend}
            aria-label="Send message"
            onClick={() => void submit()}
          >
            <Send className="size-4" aria-hidden="true" />
          </Button>
        }
      />

      {ready && capability.enabled ? null : (
        <p className="dashboard-composer__blocked">
          <span>{blockedReason}</span>
          {c.selectedEnvironmentId ? (
            <Button size="sm" variant="ghost" onClick={() => onNavigate("operate")}>
              Open Operations
            </Button>
          ) : null}
        </p>
      )}

      {recording ? (
        <MediaCaptureDialog
          controller={c}
          initialSource="audio"
          title="Record a voice message"
          description="The clip is stored in your media library and attached to this message."
          onClose={() => setRecording(false)}
          onUploaded={(media) => {
            draft.addAttachment(media.id);
            setRecording(false);
          }}
        />
      ) : null}
    </div>
  );
}

export function QuickPage({ controller: c, onNavigate }: QuickPageProps) {
  const confirm = useConfirm();
  // The dashboard is the page people land on, so it pulls the selected environment's workspace
  // itself instead of sending them to Operations to do it. `loadSnapshot` selects a thread out of
  // what it finds, which is why arriving here is now enough to start typing.
  const { status: workspaceStatus, loadWorkspace } = useWorkspaceLoader(c);
  const selectedEnvironment = c.environments.find(
    (environment) => environment.id === c.selectedEnvironmentId,
  ) ?? null;
  const selectedThread = c.threads.find((thread) => thread.id === c.selectedThreadId) ?? null;
  const savedActions = (c.actions ?? []).slice(0, 5);

  const decide = async (command: Command, decision: "approve" | "reject") => {
    if (decision === "reject") {
      const accepted = await confirm({
        title: "Reject this command?",
        description: commandSummary(command),
        confirmLabel: "Reject command",
      });
      if (!accepted) return;
    }
    await c.run(`${decision}-${command.id}`, `Command ${decision}d.`, async () => {
      const result = await c.api(`/v1/commands/${encodeURIComponent(command.id)}/${decision}`, {
        method: "POST",
        body: {},
      });
      await c.refreshAll();
      return result;
    });
  };

  const runAction = async (action: SavedAction) => {
    await c.run(`action-${action.id}`, "Action dispatched.", async () => {
      const pending = await durableMutationRequest({
        operation: "action.run",
        actionId: action.id,
        environmentId: c.selectedEnvironmentId || null,
        threadId: c.selectedThreadId || null,
      });
      const result = await c.api(`/v1/actions/${encodeURIComponent(action.id)}/run`, {
        method: "POST",
        body: {
          environmentId: c.selectedEnvironmentId || undefined,
          threadId: c.selectedThreadId || undefined,
          clientRequestId: pending.clientRequestId,
        },
      });
      clearDurableMutationRequest(pending.storageKey);
      await c.refreshAll();
      return result;
    });
  };

  const loading = workspaceStatus === "loading";
  const failed = workspaceStatus === "failed";

  const workspaceTitle = !selectedEnvironment
    ? "Connect T3 Code to begin"
    : selectedThread?.label
      ?? (loading
        ? "Loading workspace"
        : failed
          ? "Workspace unavailable"
          : "Choose a thread to continue");
  const workspaceDescription = !selectedEnvironment
    ? "Pair a workspace once, then resume agent work from this dashboard."
    : selectedThread
      ? `${selectedEnvironment.label} · ${selectedThread.messages?.length ?? 0} messages`
      : loading
        ? `Fetching projects and threads from ${selectedEnvironment.label}.`
        : failed
          ? `Could not reach ${selectedEnvironment.label}. Retry, or pick another environment.`
          : `${selectedEnvironment.label} reported no threads yet.`;

  return (
    <div className="dashboard-home">
      {/*
        The metric strip. The signed-out pages put their numbers between the hero and the
        features, and the dashboard reads the same way: the four counts that describe the whole
        surface — how many environments are paired, how many threads the selected one reported, how
        many commands are waiting for a decision, and how many actions are saved — in one
        glanceable band, before the working panels.
      */}
      <div className="dashboard-home__summary ac-glass-strong">
        <div className="ac-stat">
          <span className="ac-stat__glyph" aria-hidden="true">#</span>
          <span className="ac-stat__value">{c.environments.length}</span>
          <span className="ac-stat__label">environments</span>
        </div>
        <div className="ac-stat">
          <span className="ac-stat__glyph" aria-hidden="true">&gt;</span>
          <span className="ac-stat__value">{c.threads.length}</span>
          <span className="ac-stat__label">threads</span>
        </div>
        <div className="ac-stat">
          <span className="ac-stat__glyph" aria-hidden="true">%</span>
          <span className="ac-stat__value">{c.pendingApprovals.length}</span>
          <span className="ac-stat__label">awaiting decision</span>
        </div>
        <div className="ac-stat">
          <span className="ac-stat__glyph" aria-hidden="true">*</span>
          <span className="ac-stat__value">{c.actions?.length ?? 0}</span>
          <span className="ac-stat__label">saved actions</span>
        </div>
      </div>

      <section className="dashboard-home__workspace ac-glass" aria-labelledby="dashboard-workspace-title">
        <div className="dashboard-home__section-heading">
          <div>
            <p className="eyebrow ac-eyebrow">Current workspace</p>
            <h2 className="ac-display-title" id="dashboard-workspace-title">{workspaceTitle}</h2>
          </div>
          <StatusBadge
            tone={!selectedEnvironment ? "warning" : selectedThread?.status === "running" ? "live" : "success"}
            label={!selectedEnvironment ? "not connected" : selectedThread?.status ?? (selectedThread ? "ready" : "no thread")}
          />
        </div>
        <p className="dashboard-home__description">{workspaceDescription}</p>

        {/*
          Environment and thread are chosen here rather than only in Operations. They are the two
          things every send on this page depends on, and bouncing to another workspace to set them
          was the reason the composer spent most of its life disabled.
        */}
        {c.environments.length ? (
          <div className="dashboard-home__pickers">
            <label>
              <span>Environment</span>
              <select
                aria-label="Environment"
                value={c.selectedEnvironmentId}
                onChange={(event) => {
                  c.setSelectedEnvironmentId(event.target.value);
                  void loadWorkspace(event.target.value);
                }}
              >
                {c.environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>{environment.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Thread</span>
              <select
                aria-label="Thread"
                value={c.selectedThreadId}
                disabled={!c.threads.length}
                onChange={(event) => c.setSelectedThreadId(event.target.value)}
              >
                {c.threads.length
                  ? null
                  : <option value="">{loading ? "Loading…" : "No threads reported"}</option>}
                {c.threads.map((thread) => (
                  <option key={thread.id} value={thread.id}>{thread.label}</option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              variant="ghost"
              busy={loading}
              disabled={!c.selectedEnvironmentId}
              aria-label="Reload workspace"
              onClick={() => void loadWorkspace(c.selectedEnvironmentId)}
            >
              <RefreshCw className="size-3.5" aria-hidden="true" /> {failed ? "Retry" : "Reload"}
            </Button>
          </div>
        ) : null}

        <QuickComposer controller={c} onNavigate={onNavigate} />
        <div className="dashboard-home__workspace-actions">
          <Button
            variant="ghost"
            onClick={() => onNavigate(selectedEnvironment ? "operate" : "environments")}
          >
            {selectedEnvironment ? "Open Operations" : "Pair an environment"}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
          {selectedEnvironment && selectedThread ? (
            <span className="dashboard-home__context">
              Follow-up messages stay in this thread.
            </span>
          ) : null}
        </div>
      </section>

      <section className="dashboard-home__attention ac-glass" aria-labelledby="dashboard-attention-title">
        <div className="dashboard-home__section-heading">
          <div>
            <p className="eyebrow ac-eyebrow">Needs attention</p>
            <h2 className="ac-display-title" id="dashboard-attention-title">
              {c.pendingApprovals.length
                ? `${c.pendingApprovals.length} ${c.pendingApprovals.length === 1 ? "approval" : "approvals"}`
                : "All clear"}
            </h2>
          </div>
          {c.pendingApprovals.length
            ? <CircleAlert className="size-5 text-warning" aria-hidden="true" />
            : <CheckCircle2 className="size-5 text-success" aria-hidden="true" />}
        </div>

        {c.pendingApprovals.length ? (
          <div className="dashboard-approval-list">
            {c.pendingApprovals.slice(0, 4).map((command) => (
              <LiveFrame key={command.id} active tone="attention" className="live-frame">
                <article className="dashboard-approval-row">
                  <div className="dashboard-approval-row__copy">
                    <div>
                      <StatusBadge tone="warning" label={command.risk ?? "review"} />
                      <span>{commandType(command)}</span>
                      <time>{formatRelativeTime(command.createdAt)}</time>
                    </div>
                    <p>{commandSummary(command)}</p>
                  </div>
                  <div className="dashboard-approval-row__actions">
                    <Button
                      size="sm"
                      variant="primary"
                      busy={c.busyAction === `approve-${command.id}`}
                      onClick={() => void decide(command, "approve")}
                    >
                      <Check className="size-3.5" aria-hidden="true" /> Approve
                    </Button>
                    <Button size="sm" variant="danger-ghost" onClick={() => void decide(command, "reject")}>
                      <X className="size-3.5" aria-hidden="true" /> Reject
                    </Button>
                  </div>
                </article>
              </LiveFrame>
            ))}
            {c.pendingApprovals.length > 4 ? (
              <Button variant="ghost" onClick={() => onNavigate("activity")}>
                View all approvals <ArrowRight className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="dashboard-home__empty-row">
            <span>No commands are waiting for a decision.</span>
            <Button variant="ghost" onClick={() => onNavigate("activity")}>Open Activity</Button>
          </div>
        )}
      </section>

      <section className="dashboard-home__actions ac-glass" aria-labelledby="dashboard-actions-title">
        <div className="dashboard-home__section-heading">
          <div>
            <p className="eyebrow ac-eyebrow">Quick actions</p>
            <h2 className="ac-display-title" id="dashboard-actions-title">Saved actions</h2>
          </div>
        </div>

        {savedActions.length ? (
          <div className="dashboard-action-list">
            {savedActions.map((action) => {
              const requiresMedia = action.type === "media";
              const enabled = Boolean(c.selectedEnvironmentId && c.selectedThreadId && !requiresMedia);
              return (
                <div key={action.id} className="dashboard-action-row">
                  <span className="dashboard-action-row__icon" aria-hidden="true"><Zap className="size-4" /></span>
                  <span>
                    <strong>{action.label}</strong>
                    <small>{requiresMedia ? "Choose media from Actions" : action.type}</small>
                  </span>
                  <Button
                    size="sm"
                    busy={c.busyAction === `action-${action.id}`}
                    disabled={!enabled}
                    aria-label={`Run ${action.label}`}
                    onClick={() => void runAction(action)}
                  >
                    <Play className="size-3.5" aria-hidden="true" /> Run
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="dashboard-home__empty-row">
            <span>Create reusable prompts and commands for one-click access.</span>
            <Button onClick={() => onNavigate("actions")}>Create an action</Button>
          </div>
        )}
      </section>
    </div>
  );
}
