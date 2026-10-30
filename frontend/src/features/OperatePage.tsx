import {
  Activity,
  ArrowUpRight,
  Bot,
  Braces,
  Check,
  ChevronRight,
  CircleStop,
  FolderKanban,
  Gauge,
  History,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Send,
  ShieldAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  commandActivity,
  streamingActivity,
  workspaceSyncActivity,
} from "../activity";
import type { Controller } from "../controller";
import { clearDurableMutationRequest, durableMutationRequest } from "../requestId";
import { commandSummary, commandType, formatRelativeTime, renderEventResult } from "../format";
import {
  liveThreadTurnInFlight,
  type LiveThreadEntry,
  type LiveThreadState,
  type LiveThreadStatus,
} from "../liveThread";
import { ActivityOrb, ActivityStatus, LiveFrame } from "../motion";
import {
  mergeProviderApprovalDecisions,
  offeredProviderApprovalDecisions,
  pendingProviderApprovals,
  providerApprovalTitle,
  type ProviderApproval,
  type ProviderApprovalDecision,
} from "../providerApprovals";
import {
  describeDraftGap,
  draftAnswers,
  draftToAnswers,
  mergeUserInputAnswers,
  pendingUserInputRequests,
  setDraftChoice,
  setDraftText,
  type UserInputAnswers,
  type UserInputDraft,
  type UserInputRequest,
} from "../userInput";
import type { Command, JsonRecord, SavedAction, T3ModelOption, T3SessionFailure } from "../types";
import { useWorkspaceLoader } from "../useWorkspaceLoader";
import { composerAvailability } from "../t3CapabilityAvailability";
import {
  Button,
  EmptyState,
  Field,
  Metric,
  Panel,
  SectionHeader,
  StatusBadge,
  useConfirm,
} from "../ui";
import {
  AttachmentChips,
  AttachmentSourceMenu,
  ComposerShell,
  ShellModeToggle,
  buildComposerIntent,
  sendComposerIntent,
  useComposerDraft,
  useFileAttachment,
  type ComposerMode,
} from "./Composer";
import { WorkGraphPanel } from "./WorkGraphPanel";
import { DirectAgentControls } from "./DirectAgentControls";
// The Operations workspace speaks the console's "intelligence design" language: a black
// canvas, hairline glass cards, a pixel display face and glowing pill calls to action.
import "./intelligence-operate.css";

function statusTone(status?: string) {
  if (status === "approval_required") return "warning" as const;
  if (status === "failed" || status === "rejected") return "danger" as const;
  if (status === "completed" || status === "approved") return "success" as const;
  if (status === "dispatched" || status === "running") return "live" as const;
  return "neutral" as const;
}

function isRecoverableModelFailure(failure: T3SessionFailure) {
  return failure.code === "invalid_request_error"
    && /(model.+not supported|unknown model)/iu.test(failure.message);
}

export function OperatePage({ controller }: { controller: Controller }) {
  const c = controller;
  const confirm = useConfirm();
  // Shared with the Dashboard: whichever page the operator lands on pulls the workspace, and
  // `loadSnapshot` picks a thread out of what comes back.
  const { status: workspaceStatus, loadWorkspace } = useWorkspaceLoader(c);
  // Shell stays an explicit secondary mode: its policy screening and approval path differ, so it
  // must never be something a request falls into by accident.
  const [composerMode, setComposerMode] = useState<ComposerMode>("prompt");
  const draft = useComposerDraft(c.media);
  const { prompt, attachmentIds } = draft;
  const attachFiles = useFileAttachment({ controller: c, draft });
  const [providerInstance, setProviderInstance] = useState("");
  const [model, setModel] = useState("");
  const [modelSelectionMode, setModelSelectionMode] = useState<"automatic" | "manual">("automatic");
  // Per-model switches the provider itself declares — reasoning effort, service tier, fast mode.
  // Keyed by descriptor id because the ids are the provider's own: Codex calls its reasoning
  // control `reasoningEffort` and Claude calls it `effort`, so nothing here may name one.
  const [modelOptions, setModelOptions] = useState<Record<string, string | boolean>>({});
  const [actionLabel, setActionLabel] = useState("");
  const [editingActionId, setEditingActionId] = useState<string | null>(null);
  const savedActions = c.actions ?? [];

  const usableHarnesses = c.harnesses.filter((harness) => harness.available !== false);
  const activeHarness = c.harnesses.find((harness) => harness.instanceId === providerInstance) ?? null;
  const availableModels = activeHarness?.models ?? [];
  const activeModel = availableModels.find((entry) => entry.slug === model) ?? null;
  const optionDescriptors = activeModel?.options ?? [];
  // A descriptor the owner has not touched falls back to the provider's own current value, then to
  // the choice it marked default. Mirrors how T3's own client resolves them.
  const optionValue = (descriptor: T3ModelOption): string | boolean | null => {
    const chosen = modelOptions[descriptor.id];
    if (chosen !== undefined) return chosen;
    if (descriptor.currentValue !== null && descriptor.currentValue !== undefined) return descriptor.currentValue;
    if (descriptor.type === "boolean") return false;
    return descriptor.choices.find((choice) => choice.isDefault)?.id ?? descriptor.choices[0]?.id ?? null;
  };
  // Only what the owner actually chose is sent. Echoing the provider's current values back on
  // every turn would make an unchanged selection look like a deliberate change.
  const selectedModelOptions = optionDescriptors
    .filter((descriptor) => modelOptions[descriptor.id] !== undefined)
    .map((descriptor) => ({ id: descriptor.id, value: modelOptions[descriptor.id] }));
  const selectedThread = c.threads.find((thread) => thread.id === c.selectedThreadId) ?? null;
  const projectThreads = useMemo(
    () => c.selectedProjectId
      ? c.threads.filter((thread) => thread.projectId === c.selectedProjectId)
      : c.threads,
    [c.selectedProjectId, c.threads],
  );
  const threadMessages = selectedThread?.messages ?? [];

  // A watch is a lease against T3's socket, so it is registered because a thread is ON SCREEN —
  // not because one is selected — and released the moment this view goes away.
  useEffect(() => {
    if (!c.selectedEnvironmentId || !c.selectedThreadId) {
      c.watchThread(null);
      return;
    }
    c.watchThread({ environmentId: c.selectedEnvironmentId, threadId: c.selectedThreadId });
    return () => c.watchThread(null);
  }, [c.selectedEnvironmentId, c.selectedThreadId, c.watchThread]);

  // Only the live state for the thread actually on screen counts. A payload that arrived a moment
  // before the operator switched threads must never be drawn over the new one.
  const live = c.liveThread
    && c.liveThread.environmentId === c.selectedEnvironmentId
    && c.liveThread.threadId === c.selectedThreadId
    ? c.liveThread
    : null;
  // The thread subscription rides the same SSE connection as everything else, so a broker that is
  // reconnecting means this transcript may already be behind — whatever the last status said.
  const streamDegraded = c.connection === "reconnecting" || c.connection === "error";
  const liveStatus: LiveThreadStatus = !live
    ? "idle"
    : streamDegraded && live.status === "live" ? "reconnecting" : live.status;
  // An empty snapshot is a real answer ("this thread has nothing in it"), but it is not something
  // to render over the polled view, so the fallback below still applies.
  // T3-attributed task/tool rows are re-homed into Agents & work. They remain in the reducer's
  // bounded transcript projection for replay/snapshot correctness, but do not splice child work
  // into the parent conversation.
  const parentLiveEntries = live?.hasSnapshot
    ? live.entries.filter((entry) => entry.kind !== "activity" || !entry.workNodeId)
    : [];
  const liveEntries = parentLiveEntries.length > 0 ? parentLiveEntries : null;

  const threadPendingApprovals = useMemo(
    () => c.pendingApprovals.filter((command) =>
      command.threadId === c.selectedThreadId
      && (!command.environmentId || command.environmentId === c.selectedEnvironmentId)
    ),
    [c.pendingApprovals, c.selectedEnvironmentId, c.selectedThreadId],
  );
  // The OTHER kind of approval: T3 stopped mid-turn and the agent is waiting on an answer. Derived
  // from the live stream's activity rows rather than fetched, because the stream already carries
  // them and a poll would show a stale question. Rendered as its own block, never merged into the
  // gateway approval list above — see frontend/src/providerApprovals.ts.
  const threadProviderApprovals = useMemo(
    () => pendingProviderApprovals(
      mergeProviderApprovalDecisions(
        live?.approvals ?? [],
        // A controller assembled without this map (older callers, test fixtures) has decided
        // nothing, which is exactly what an empty map means.
        Object.values(c.providerApprovalDecisions ?? {}),
      ),
    ).filter((approval) => !approval.localDecision),
    [c.providerApprovalDecisions, live],
  );
  // The THIRD blocking kind: the agent is not asking permission, it is asking a question. Kept in
  // its own list, rendered in its own card, and answered on its own route — see
  // frontend/src/userInput.ts for why collapsing any two of the three would be a correctness bug.
  const threadUserInputRequests = useMemo(
    () => pendingUserInputRequests(
      mergeUserInputAnswers(
        live?.userInputRequests ?? [],
        Object.values(c.userInputAnswers ?? {}),
      ),
    ).filter((request) => !request.localAnswer),
    [c.userInputAnswers, live],
  );
  const threadCommands = useMemo(
    () => c.recentCommands.filter((command) =>
      command.threadId === c.selectedThreadId
      && (!command.environmentId || command.environmentId === c.selectedEnvironmentId)
    ),
    [c.recentCommands, c.selectedEnvironmentId, c.selectedThreadId],
  );
  // A turn is in flight while T3 holds a command it has not answered, or an assistant message is
  // still arriving. `dispatched` is explicitly included: it means T3 accepted the command, not that
  // the agent replied, and that gap is exactly the interval the composer should look occupied.
  const turnInFlight = useMemo(
    () => liveThreadTurnInFlight(live)
      || threadMessages.some((message) => message.streaming)
      || threadCommands.some((command) =>
        command.status === "dispatched" || command.status === "running"),
    [live, threadCommands, threadMessages],
  );
  const threadFailures = useMemo(
    () => c.sessionFailures.filter((failure) => failure.threadId === c.selectedThreadId),
    [c.sessionFailures, c.selectedThreadId],
  );
  const latestModelSelection = useMemo(() => {
    const preferredInstanceId = c.selectedProject?.defaultModelSelection?.instanceId
      ?? c.suggestedModelSelection?.instanceId
      ?? null;
    const launchable = c.harnesses.filter((harness) =>
      harness.available !== false && harness.models.length > 0
    );
    const harness = launchable.find((entry) => entry.instanceId === preferredInstanceId)
      ?? launchable[0];
    const latestModel = harness?.models[0];
    return harness && latestModel
      ? { instanceId: harness.instanceId, model: latestModel.slug }
      : null;
  }, [c.harnesses, c.selectedProject, c.suggestedModelSelection]);
  const recoveryModelSelection = latestModelSelection;

  // Existing threads keep a valid provider/model pair. New threads use the first model in T3's
  // ordered live catalogue for the project's provider, which is T3's current preferred model.
  useEffect(() => {
    const threadSelection = selectedThread?.modelSelection ?? null;
    const isOffered = (instanceId?: string, slug?: string) =>
      Boolean(instanceId && slug && c.harnesses
        .find((harness) => harness.instanceId === instanceId && harness.available !== false)
        ?.models.some((entry) => entry.slug === slug));

    if (threadSelection && isOffered(threadSelection.instanceId, threadSelection.model)) {
      setProviderInstance(threadSelection.instanceId);
      setModel(threadSelection.model);
      setModelSelectionMode("automatic");
      return;
    }
    if (modelSelectionMode === "manual" && isOffered(providerInstance, model)) return;
    if (latestModelSelection) {
      setProviderInstance(latestModelSelection.instanceId);
      setModel(latestModelSelection.model);
      return;
    }
    setProviderInstance("");
    setModel("");
  }, [
    c.harnesses,
    latestModelSelection,
    model,
    modelSelectionMode,
    providerInstance,
    selectedThread,
  ]);

  const selectHarness = (instanceId: string) => {
    setModelSelectionMode("manual");
    if (c.selectedThreadId) c.setSelectedThreadId("");
    setProviderInstance(instanceId);
    const harness = c.harnesses.find((entry) => entry.instanceId === instanceId);
    const models = harness?.models ?? [];
    setModel(models.some((entry) => entry.slug === model) ? model : models[0]?.slug ?? "");
    setModelOptions({});
  };

  const selectModel = (slug: string) => {
    setModelSelectionMode("manual");
    if (c.selectedThreadId) c.setSelectedThreadId("");
    setModel(slug);
    // Descriptor ids are per model, so carrying a previous choice across a model change would
    // send an option the new model never declared and the gateway would refuse the dispatch.
    setModelOptions({});
  };

  const selectModelOption = (id: string, value: string | boolean) => {
    setModelSelectionMode("manual");
    setModelOptions((current) => ({ ...current, [id]: value }));
  };

  const selectEnvironment = (environmentId: string) => {
    setModelSelectionMode("automatic");
    setProviderInstance("");
    setModel("");
    setModelOptions({});
    setComposerMode("prompt");
    draft.clearAttachments();
    c.setSelectedEnvironmentId(environmentId);
    void loadWorkspace(environmentId);
  };

  const selectProject = (projectId: string) => {
    setModelSelectionMode("automatic");
    const nextThread = c.threads.find((thread) => thread.projectId === projectId) ?? null;
    c.setSelectedProjectId(projectId);
    c.setSelectedThreadId(nextThread?.id ?? "");
    setComposerMode("prompt");
    draft.clearAttachments();
  };

  const selectThread = (threadId: string) => {
    setModelSelectionMode("automatic");
    const nextThread = c.threads.find((thread) => thread.id === threadId) ?? null;
    if (nextThread?.projectId && nextThread.projectId !== c.selectedProjectId) {
      c.setSelectedProjectId(nextThread.projectId);
    }
    c.setSelectedThreadId(threadId);
    if (!threadId) {
      setComposerMode("prompt");
      draft.clearAttachments();
    }
  };

  const composerIntent = () => buildComposerIntent({
    mode: composerMode,
    text: prompt,
    attachments: draft.attachments,
  });

  // Shell input is never dispatched with attachments, so switching modes drops them rather than
  // silently discarding them at dispatch time.
  const selectComposerMode = (mode: ComposerMode) => {
    setComposerMode(mode);
    if (mode === "shell") draft.clearAttachments();
  };

  const hasRequest = Boolean(prompt.trim())
    || (composerMode === "prompt" && attachmentIds.length > 0);
  const composerCapability = composerAvailability(c.selectedEnvironment, draft.attachments, !c.selectedThreadId);
  const canSendFollowUp = Boolean(c.selectedEnvironmentId && c.selectedThreadId)
    && hasRequest && composerCapability.enabled;
  const canStartThread = Boolean(
    c.selectedEnvironmentId
    && c.selectedProjectId
    && composerMode === "prompt"
    && hasRequest
    && model
    && activeHarness?.available !== false
    && composerCapability.enabled
  );
  const canSend = c.selectedThreadId ? canSendFollowUp : canStartThread;

  const sendIntent = async (intent: JsonRecord, successMessage: string) =>
    sendComposerIntent(c, intent, successMessage);

  const saveAction = async () => {
    const intent = composerIntent();
    const actionType = composerMode === "shell"
      ? "shell"
      : attachmentIds.length > 0 ? "media" : "prompt";
    const payload = actionType === "shell"
      ? { command: prompt.trim() }
      : actionType === "media"
        ? { mediaKind: intent.type === "audio_prompt" ? "audio" : "image", prompt: prompt.trim() }
        : { text: prompt.trim() };
    await c.run(editingActionId ? `update-action-${editingActionId}` : "create-action", editingActionId ? "Action updated." : "Action saved.", async () => {
      const result = await c.api(editingActionId ? `/v1/actions/${encodeURIComponent(editingActionId)}` : "/v1/actions", {
        method: editingActionId ? "PUT" : "POST",
        body: {
          label: actionLabel.trim() || prompt.trim().slice(0, 32)
            || (composerMode === "shell" ? "Shell" : "Prompt"),
          type: actionType,
          payload,
          targetMode: c.selectedEnvironmentId ? "fixed" : "device-current",
          environmentId: c.selectedEnvironmentId || null,
          threadId: c.selectedThreadId || null,
          intent,
        },
      });
      setActionLabel("");
      setEditingActionId(null);
      await c.refreshAll();
      return result;
    });
  };

  const runSavedAction = async (action: SavedAction) => {
    if (action.type === "media") {
      c.setNotice({ tone: "info", message: "Choose a compatible upload from the Actions library to run this media action." });
      return;
    }
    const actionId = action.id;
    await c.run(`action-${actionId}`, "Action dispatched.", async () => {
      const pending = await durableMutationRequest({
        operation: "action.run",
        actionId,
        environmentId: c.selectedEnvironmentId || null,
        threadId: c.selectedThreadId || null,
      });
      const result = await c.api(`/v1/actions/${encodeURIComponent(actionId)}/run`, {
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

  const deleteSavedAction = async (actionId: string, label: string) => {
    const accepted = await confirm({
      title: `Delete “${label}”?`,
      description: "The saved action will be removed from the library and claimed controllers.",
      confirmLabel: "Delete action",
    });
    if (!accepted) return;
    await c.run(`delete-action-${actionId}`, "Action deleted.", async () => {
      const result = await c.api(`/v1/actions/${encodeURIComponent(actionId)}`, { method: "DELETE" });
      await c.refreshAll();
      return result;
    });
  };

  const editSavedAction = (action: SavedAction) => {
    const content = action.payload?.text ?? action.payload?.prompt ?? action.payload?.command
      ?? action.intent?.text ?? action.intent?.prompt ?? action.intent?.transcript ?? action.intent?.command;
    // A saved media action carries only the kind it expects, not the uploads themselves, so the
    // draft comes back as text and the user re-attaches from the source menu.
    const isShell = action.type === "shell" || action.intent?.type === "shell_input";
    setComposerMode(isShell ? "shell" : "prompt");
    draft.clearAttachments();
    draft.setPrompt(typeof content === "string" ? content : "");
    setActionLabel(action.label);
    setEditingActionId(action.id);
  };

  const decideCommand = async (command: Command, decision: "approve" | "reject") => {
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

  const launchProject = async () => {
    if (!c.selectedProjectId) {
      c.setNotice({ tone: "danger", message: "Load sessions and select a project first." });
      return;
    }
    if ((providerInstance && !model) || (!providerInstance && model)) {
      c.setNotice({
        tone: "danger",
        message: "Provider instance and model must either both be set or both be empty.",
      });
      return;
    }
    const result = await c.run("launch-project", "Project session launched.", async () =>
      c.launchProject({
        projectId: c.selectedProjectId,
        text: prompt.trim()
          || (attachmentIds.length > 0
            ? "Use the attached context."
            : "Open this project and report that the remote session is ready."),
        ...(attachmentIds.length > 0 ? { mediaUploadIds: attachmentIds } : {}),
        ...(providerInstance && model
          ? {
            modelSelection: {
              instanceId: providerInstance,
              model,
              ...(selectedModelOptions.length > 0 ? { options: selectedModelOptions } : {}),
            },
          }
          : {}),
      })
    );
    if (result?.modelRecovery) {
      const { requested, selected } = result.modelRecovery;
      const unavailable = requested
        ? `${requested.instanceId}/${requested.model}`
        : "The selected model";
      c.setNotice({
        tone: "info",
        message: `${unavailable} is unavailable. Started this thread with ${selected.instanceId}/${selected.model} instead.`,
      });
    }
    return result;
  };

  const prepareFailureRecovery = (failure: T3SessionFailure) => {
    if (!recoveryModelSelection) return;
    setModelSelectionMode("manual");
    setProviderInstance(recoveryModelSelection.instanceId);
    setModel(recoveryModelSelection.model);
    setComposerMode("prompt");
    draft.clearAttachments();
    draft.setPrompt(failure.title ?? selectedThread?.label ?? "Continue this task.");
    c.setSelectedThreadId("");
    c.setNotice({
      tone: "info",
      message: `A replacement is ready with ${recoveryModelSelection.instanceId}/${recoveryModelSelection.model}. Review the prompt, then start the new thread.`,
    });
  };

  const submitComposer = async () => {
    const result = c.selectedThreadId
      ? await sendIntent(composerIntent(), "Message sent.")
      : await launchProject();
    if (result !== undefined) draft.reset();
  };

  const counts = c.display?.counts ?? {};
  const selectedEnvironmentLabel = c.environments.find(
    (environment) => environment.id === c.selectedEnvironmentId,
  )?.label ?? "the selected T3 environment";
  // Not yet reported for this environment means the fetch has not settled, which reads as loading.
  const selectedWorkspaceLoadState = workspaceStatus ?? "loading";
  const contextToolbar = (
    <div className="thread-context-toolbar context-strip" aria-label="Command context">
      <label className="thread-context-control">
        <span className="ac-eyebrow">Environment</span>
        <select
          aria-label="Environment"
          value={c.selectedEnvironmentId}
          onChange={(event) => selectEnvironment(event.target.value)}
        >
          {c.environments.length === 0 ? <option value="">No environments paired</option> : null}
          {c.environments.map((environment) => (
            <option key={environment.id} value={environment.id}>{environment.label}</option>
          ))}
        </select>
      </label>
      <label className="thread-context-control">
        <span className="ac-eyebrow">Project</span>
        <select
          aria-label="Project"
          value={c.selectedProjectId}
          onChange={(event) => selectProject(event.target.value)}
          disabled={c.projects.length === 0}
        >
          {c.projects.length === 0 ? <option value="">No projects loaded</option> : null}
          {c.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title ?? project.name ?? project.workspaceRoot ?? project.id}
            </option>
          ))}
        </select>
      </label>
      <label className="thread-context-control">
        <span className="ac-eyebrow">Thread</span>
        <select
          aria-label="Thread"
          value={c.selectedThreadId}
          onChange={(event) => selectThread(event.target.value)}
          disabled={!c.selectedProjectId}
        >
          <option value="">New thread…</option>
          {projectThreads.map((thread) => (
            <option key={thread.id} value={thread.id}>{thread.label}</option>
          ))}
        </select>
      </label>
      <label className="thread-context-control">
        <span className="ac-eyebrow">Harness</span>
        <select
          aria-label="Agent harness"
          value={providerInstance}
          onChange={(event) => selectHarness(event.target.value)}
          disabled={!c.selectedProjectId || c.harnesses.length === 0}
        >
          {c.harnesses.length === 0 ? <option value="">No harnesses reported</option> : null}
          {usableHarnesses.map((harness) => (
            <option key={harness.instanceId} value={harness.instanceId}>
              {harness.label}
              {harness.models.length ? ` (${harness.models.length})` : ""}
            </option>
          ))}
          {c.harnesses
            .filter((harness) => harness.available === false)
            .map((harness) => (
              <option key={harness.instanceId} value={harness.instanceId} disabled>
                {harness.label} — {harness.unavailableReason ?? "unavailable"}
              </option>
            ))}
        </select>
      </label>
      <label className="thread-context-control">
        <span className="ac-eyebrow">Model</span>
        <select
          aria-label="Model"
          value={model}
          onChange={(event) => selectModel(event.target.value)}
          disabled={!c.selectedProjectId || availableModels.length === 0}
        >
          {availableModels.length === 0 ? <option value="">No models reported</option> : null}
          {availableModels.map((entry) => (
            <option key={entry.slug} value={entry.slug}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      {/*
        Rendered from the provider's own declared descriptors, not from a list of switches this
        console knows about. That is the only way one control serves Codex's `reasoningEffort`
        (low…ultra) and Claude's `effort` (low…ultrathink) without naming either, and the only way
        a switch T3 adds later appears here without a frontend change.
      */}
      {optionDescriptors.map((descriptor) => {
        const value = optionValue(descriptor);
        const controlId = `model-option-${descriptor.id}`;
        if (descriptor.type === "boolean") {
          return (
            <label className="thread-context-control thread-context-control--switch" key={descriptor.id}>
              <span className="ac-eyebrow">{descriptor.label}</span>
              <input
                id={controlId}
                type="checkbox"
                aria-label={descriptor.label}
                checked={value === true}
                disabled={!c.selectedProjectId}
                onChange={(event) => selectModelOption(descriptor.id, event.target.checked)}
              />
            </label>
          );
        }
        return (
          <label className="thread-context-control" key={descriptor.id}>
            <span className="ac-eyebrow">{descriptor.label}</span>
            <select
              id={controlId}
              aria-label={descriptor.label}
              value={typeof value === "string" ? value : ""}
              disabled={!c.selectedProjectId || descriptor.choices.length === 0}
              onChange={(event) => selectModelOption(descriptor.id, event.target.value)}
            >
              {descriptor.choices.length === 0 ? <option value="">Not reported</option> : null}
              {descriptor.choices.map((choice) => (
                <option key={choice.id} value={choice.id} title={choice.description ?? undefined}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        );
      })}
      <div className="thread-context-actions">
        {selectedWorkspaceLoadState === "loading" ? (
          <ActivityStatus
            className="thread-context-sync"
            activity={workspaceSyncActivity("loading")}
            label="Syncing…"
          />
        ) : selectedWorkspaceLoadState === "failed" ? (
          <span className="thread-context-sync" data-error="true" aria-live="polite">Sync failed</span>
        ) : null}
        {c.selectedThreadId && c.projects.length ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setModelSelectionMode("automatic");
              c.setSelectedThreadId("");
              setComposerMode("prompt");
              draft.clearAttachments();
            }}
          >
            <Plus className="size-3.5" /> New thread
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          busy={selectedWorkspaceLoadState === "loading"}
          disabled={!c.selectedEnvironmentId}
          onClick={() => void loadWorkspace(c.selectedEnvironmentId)}
        >
          <RefreshCw className="size-3.5" /> Refresh
        </Button>
      </div>
    </div>
  );

  if (!c.selectedEnvironmentId || (!c.selectedThreadId && c.threads.length === 0 && c.projects.length === 0)) {
    const workspaceFailed = c.selectedEnvironmentId && selectedWorkspaceLoadState === "failed";
    const workspaceLoaded = c.selectedEnvironmentId && selectedWorkspaceLoadState === "loaded";
    return (
      <div className="thread-workspace">
        <div className="thread-feed">
          <div className="thread-empty-state">
          <h2 className="ac-display-title">
            {!c.selectedEnvironmentId
              ? "Connect an environment to begin"
              : workspaceFailed
                ? "Workspace unavailable"
                : workspaceLoaded
                  ? "Workspace is empty"
                  : "Loading workspace"}
          </h2>
          <p>
            {!c.selectedEnvironmentId
              ? "Pair a T3 Code environment from the sidebar to start operating an agent."
              : workspaceFailed
                ? `Could not fetch projects and threads from ${selectedEnvironmentLabel}.`
                : workspaceLoaded
                  ? `${selectedEnvironmentLabel} did not report any projects or threads.`
                  : `Fetching projects and threads from ${selectedEnvironmentLabel}.`}
          </p>
          {c.selectedEnvironmentId && !workspaceFailed && !workspaceLoaded ? (
            <div className="thread-empty-loading">
              <ActivityStatus
                announce
                activity={workspaceSyncActivity("loading")}
                size={64}
                label="Loading workspace…"
              />
            </div>
          ) : null}
          {c.selectedEnvironmentId && (workspaceFailed || workspaceLoaded) ? (
            <Button
              variant="secondary"
              onClick={() => void loadWorkspace(c.selectedEnvironmentId)}
            >
              <RefreshCw className="size-4" /> {workspaceFailed ? "Retry" : "Refresh workspace"}
            </Button>
          ) : null}
          </div>
        </div>
        <div className="thread-composer-dock">{contextToolbar}</div>
      </div>
    );
  }

  return (
    <div className="thread-workspace">
      <div className="thread-feed">
        <div className="thread-feed__inner">
          {threadFailures.length > 0 ? (
            <section className="thread-failure-notice" role="status" aria-label="Session failures">
              <header>
                <span className="thread-failure-notice__icon" aria-hidden="true">
                  <ShieldAlert className="size-4" />
                </span>
                <span>
                  <strong>Session issues</strong>
                  <small>Provider errors from recent launches</small>
                </span>
                <StatusBadge
                  tone="danger"
                  label={`${threadFailures.length} failed`}
                />
              </header>
              <div className="thread-failure-notice__list">
                {threadFailures.map((failure) => (
                  <article key={`${failure.threadId}-${failure.updatedAt}`}>
                    <p>
                      <strong>{failure.title ?? failure.threadId}</strong>
                      <span>
                        Stopped{failure.model ? ` on ${failure.instanceId}/${failure.model}` : ""}
                      </span>
                    </p>
                    <div className="thread-failure-notice__detail">
                      <small>{failure.message}</small>
                      {recoveryModelSelection
                        && isRecoverableModelFailure(failure)
                        && (failure.instanceId !== recoveryModelSelection.instanceId
                          || failure.model !== recoveryModelSelection.model) ? (
                          <div className="thread-failure-notice__recovery">
                            <span>
                              Available: {recoveryModelSelection.instanceId}/{recoveryModelSelection.model}
                            </span>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => prepareFailureRecovery(failure)}
                            >
                              <Play className="size-3.5" /> Prepare replacement
                            </Button>
                          </div>
                        ) : null}
                    </div>
                  </article>
                ))}
              </div>
              </section>
          ) : null}

          {c.harnessCatalogueSource === "snapshot-only" && c.projects.length ? (
            <div className="thread-catalogue-notice" role="note">
              <Braces className="size-4" aria-hidden="true" />
              <p>
                Only harnesses already in use are listed. Run <code>npm run setup:t3</code> on the T3 host
                to register its full harness and model catalogue.
              </p>
            </div>
          ) : null}

          <LiveThreadBanner state={live} status={liveStatus} />

          <WorkGraphPanel state={live} status={liveStatus} />

          {live?.historyGap ? (
            <div className="thread-gap-notice" role="note">
              <History className="size-4" aria-hidden="true" />
              <p>
                The live connection came back after a gap T3 could not replay. This is the thread in
                full as it stands now — the individual steps in between were never recorded.
              </p>
            </div>
          ) : null}

          {live?.historyTruncated ? (
            <div className="thread-gap-notice" role="note">
              <History className="size-4" aria-hidden="true" />
              <p>Older messages in this thread are not loaded. This view starts partway in.</p>
            </div>
          ) : null}

          {threadPendingApprovals.map((command) => (
            <LiveFrame
              key={command.id}
              active
              tone="attention"
              className="live-frame live-frame--approval"
            >
              <section className="thread-approval">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone="warning" label="Approval required" />
                    <span className="font-mono text-[10px] text-ink-faint">{command.id}</span>
                  </div>
                  <p className="mt-3 text-sm font-semibold capitalize">{commandType(command)}</p>
                  <pre>{commandSummary(command)}</pre>
                  <p className="mt-2 text-xs text-ink-muted">
                    Risk: <span className="capitalize text-warning-strong">{command.risk ?? "unknown"}</span>
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    busy={c.busyAction === `approve-${command.id}`}
                    onClick={() => void decideCommand(command, "approve")}
                  >
                    <Check className="size-4" /> Approve
                  </Button>
                  <Button variant="danger-ghost" size="sm" onClick={() => void decideCommand(command, "reject")}>
                    <X className="size-4" /> Reject
                  </Button>
                </div>
            </section>
            </LiveFrame>
          ))}

          {threadProviderApprovals.map((approval) => (
            <ProviderApprovalCard
              key={approval.requestId}
              approval={approval}
              busyAction={c.busyAction}
              // Same grant as the question card below: the console acts as `power-controller`,
              // which carries `approval_response` (src/profiles.mjs).
              canAnswer
              onDecide={(decision) => {
                if (!c.selectedEnvironmentId || !c.selectedThreadId) return;
                void c.answerProviderApproval?.(
                  { environmentId: c.selectedEnvironmentId, threadId: c.selectedThreadId },
                  approval.requestId,
                  decision,
                );
              }}
            />
          ))}

          {threadUserInputRequests.map((request) => (
            <UserInputCard
              key={request.requestId}
              request={request}
              busyAction={c.busyAction}
              // The console always acts as `power-controller`, which carries `user_input_response`
              // (src/profiles.mjs) — the route hardcodes that actor. The prop exists because the
              // card is also the thing a read-only surface would render, and it must be able to
              // show a question it cannot answer rather than hide it.
              canAnswer
              onAnswer={(answers) => {
                if (!c.selectedEnvironmentId || !c.selectedThreadId) return;
                void c.answerUserInput?.(
                  { environmentId: c.selectedEnvironmentId, threadId: c.selectedThreadId },
                  request.requestId,
                  answers,
                );
              }}
            />
          ))}

          {liveEntries ? (
            <div className="thread-message-list" aria-label="Thread messages" data-live="true">
              {liveEntries.map((entry) => (
                <LiveThreadEntryView key={entry.key} entry={entry} />
              ))}
            </div>
          ) : threadMessages.length ? (
            <div className="thread-message-list" aria-label="Thread messages">
              {threadMessages.map((message) => (
                <article key={message.id} className="thread-message" data-role={message.role}>
                  <header>
                    <span className="ac-eyebrow">
                      {message.role === "user" ? "You" : message.role === "assistant" ? "Agent" : message.role}
                    </span>
                    <span>
                      <ActivityOrb activity={streamingActivity(message.streaming)} />
                      {message.createdAt ? <time>{formatRelativeTime(message.createdAt)}</time> : null}
                    </span>
                  </header>
                  <p>{message.text}</p>
                </article>
              ))}
            </div>
          ) : threadCommands.length ? (
            <div className="thread-command-list">
              {threadCommands.slice(0, 16).reverse().map((command) => (
                <article key={command.id} className="thread-command">
                  <div className="thread-command__meta">
                    <span className="capitalize">{commandType(command)}</span>
                    <time>{formatRelativeTime(command.createdAt)}</time>
                  </div>
                  <button
                    type="button"
                    onClick={() => void c.run(`timeline-${command.id}`, "Timeline loaded.", () => c.loadCommandTimeline(command))}
                  >
                    <p>{commandSummary(command)}</p>
                    <StatusBadge tone={statusTone(command.status)} label={command.status.replaceAll("_", " ")} />
                    <ActivityOrb
                      activity={commandActivity(command.status, command.intent?.type as string | undefined)}
                    />
                    <ChevronRight className="size-4 text-ink-faint" />
                  </button>
                  {c.timelineCommand?.id === command.id && c.commandEvents.length ? (
                    <div className="thread-events">
                      {c.commandEvents.map((event) => (
                        <div key={event.id}>
                          <span className="thread-events__dot" />
                          <p>
                            <strong>{event.status.replaceAll("_", " ")}</strong>
                            <span>{renderEventResult(event.result)}</span>
                          </p>
                          <time>{formatRelativeTime(event.createdAt)}</time>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <div className="thread-feed__empty">
              <Bot className="size-5" />
              <p className="ac-display-title">{c.selectedThreadId ? "This thread is ready" : "Start a new thread"}</p>
              <span>
                {c.selectedThreadId
                  ? "Send the next instruction from the composer below."
                  : "Write the first message below. Future messages will stay in this thread."}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="thread-composer-dock">
        {contextToolbar}
        <DirectAgentControls controller={c} runtimeId={providerInstance} model={model} />

        <LiveFrame active={turnInFlight} tone="live" variant="line" className="live-frame">
          <ComposerShell
            textareaId="operate-prompt"
            label="Command or prompt"
            value={prompt}
            onChange={draft.setPrompt}
            placeholder={composerMode === "shell"
              ? "Enter a shell command, for example: npm test"
              : c.selectedThreadId
                ? "Ask for follow-up changes, or paste, drop, and attach context…"
                : "Describe the first task for this new thread…"}
            canSend={canSend}
            onSubmit={() => void submitComposer()}
            onFiles={composerMode === "shell" || !composerCapability.enabled
              ? undefined
              : (files) => void attachFiles(files)}
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
                disabled={composerMode === "shell" || !composerCapability.enabled}
                disabledReason={composerMode === "shell"
                  ? "Shell commands cannot carry attachments."
                  : composerCapability.reason ?? undefined}
              />
              <ShellModeToggle mode={composerMode} onChange={selectComposerMode} />
            </>
          }
          send={
            <>
              <span className="hidden font-mono text-[10px] text-ink-faint sm:inline">⌘↵</span>
              <Button
                variant="primary"
                size="icon"
                busy={c.busyAction === (c.selectedThreadId ? "send-intent" : "launch-project")}
                disabled={!canSend}
                aria-label={c.selectedThreadId ? "Send message" : "Start new thread"}
                onClick={() => void submitComposer()}
              >
                {c.selectedThreadId ? <Send className="size-4" /> : <Play className="size-4" />}
              </Button>
            </>
          }
          />
        </LiveFrame>

        <div className="thread-composer-meta">
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => void sendIntent({ type: "status" }, "Status requested.")}>
              <Gauge className="size-3.5" /> Status
            </Button>
            <Button
              size="sm"
              variant="danger-ghost"
              onClick={() => void sendIntent({ type: "session_control", action: "stop" }, "Stop requested.")}
            >
              <CircleStop className="size-3.5" /> Stop
            </Button>
          </div>
          <details className="thread-tools">
            <summary><Braces className="size-3.5" /> Saved actions ({savedActions.length})</summary>
            <div className="thread-tools__panel">
              <div className="grid grid-cols-[1fr_auto] gap-2 p-3">
                <input
                  aria-label="Action label"
                  value={actionLabel}
                  onChange={(event) => setActionLabel(event.target.value)}
                  placeholder="Action label"
                />
                <Button size="sm" disabled={!prompt.trim()} onClick={() => void saveAction()}><Save className="size-3.5" /> {editingActionId ? "Update" : "Save"}</Button>
              </div>
              {editingActionId ? (
                <button type="button" className="thread-tools__cancel-edit" onClick={() => { setEditingActionId(null); setActionLabel(""); }}>
                  <X className="size-3" /> Editing saved action — cancel
                </button>
              ) : null}
              {savedActions.length ? savedActions.slice(0, 8).map((action) => (
                <div key={action.id} className="thread-tool-row">
                  <span className="thread-tool-row__copy">
                    <span>{action.label}</span>
                    {action.type === "media" ? <small>Choose media in Actions</small> : null}
                  </span>
                  <Button size="icon" variant="ghost" aria-label={`Edit ${action.label}`} onClick={() => editSavedAction(action)}><Pencil className="size-3.5" /></Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={action.type === "media"}
                    title={action.type === "media" ? "Choose a compatible upload from the Actions library" : undefined}
                    onClick={() => void runSavedAction(action)}
                  >Run</Button>
                  <Button size="sm" variant="danger-ghost" onClick={() => void deleteSavedAction(action.id, action.label)}>Delete</Button>
                </div>
              )) : <p className="p-4 text-xs text-ink-muted">No saved actions yet.</p>}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------------------------
// The live transcript
//
// Two rules govern everything below. First, the view never claims to be current unless the gateway
// said `live`: `connecting` and `resuming` are catch-up, and `reconnecting` means the reader is
// looking at the last state received and has to be able to tell. Second, a streaming message body
// is whatever the reducer has ACCUMULATED — the component never sees a delta, because a component
// that did would be one refactor away from rendering it as the whole reply.
// -----------------------------------------------------------------------------------------------

interface LiveStatusDescriptor {
  tone: "neutral" | "live" | "warning" | "danger";
  label: string;
  detail: string;
}

export function describeLiveThreadStatus(
  state: LiveThreadState,
  status: LiveThreadStatus,
): LiveStatusDescriptor | null {
  switch (status) {
    case "connecting":
      return {
        tone: "neutral",
        label: "Connecting",
        detail: "Opening a live connection to this thread.",
      };
    case "resuming":
      return {
        tone: "neutral",
        label: "Catching up",
        detail: "Replaying what happened while this view was away.",
      };
    case "live":
      return {
        tone: "live",
        label: "Live",
        detail: "Messages and tool activity appear as the agent works.",
      };
    case "reconnecting":
      return {
        tone: "warning",
        label: "Reconnecting",
        detail: `${state.statusError ?? "The live connection dropped."} Showing the last state received — it may be out of date.`
          + (state.attempt > 0 ? ` Attempt ${state.attempt}.` : ""),
      };
    case "stopped":
      return {
        tone: "danger",
        label: "Not live",
        detail: state.stoppedReason === "environment-missing"
          ? "This environment is no longer paired, so the thread cannot be streamed."
          : `${state.statusError ?? "Live updates stopped."} The polled workspace view still refreshes.`,
      };
    default:
      return null;
  }
}

function LiveThreadBanner({
  state,
  status,
}: {
  state: LiveThreadState | null;
  status: LiveThreadStatus;
}) {
  if (!state) return null;
  const descriptor = describeLiveThreadStatus(state, status);
  if (!descriptor) return null;
  return (
    <div
      className="thread-live-status"
      role="status"
      aria-label="Live thread stream"
      data-state={status}
    >
      <StatusBadge tone={descriptor.tone} label={descriptor.label} pulse={status === "live"} />
      <span>{descriptor.detail}</span>
      {state.sessionError ? (
        <small className="thread-live-status__error">{state.sessionError}</small>
      ) : null}
    </div>
  );
}

/**
 * A question the AGENT is asking, mid-turn.
 *
 * Deliberately labelled and styled apart from the gateway approval card above it. That one says
 * "the gateway refused to send this"; this one says "the agent is stopped and waiting on you", and
 * the answers are T3's four, not two. `acceptForSession` is set apart because it is the only
 * decision that leaves a standing rule behind — the console says so rather than hiding it behind
 * a button that reads like the one next to it.
 */
export function ProviderApprovalCard({
  approval,
  busyAction,
  canAnswer,
  allowedDecisions,
  onDecide,
}: {
  approval: ProviderApproval;
  busyAction: string | null;
  /** False when the acting profile lacks `approval_response`. It still sees the request. */
  canAnswer: boolean;
  allowedDecisions?: readonly string[];
  onDecide: (decision: ProviderApprovalDecision) => void;
}) {
  const busy = busyAction === `provider-approval-${approval.requestId}`;
  // A request may carry its own list: a direct native agent offers a subset and refuses the rest,
  // so this request's buttons must not promise more than it accepts. The top-level list is the
  // fallback for a request that did not state one.
  const offered = canAnswer
    ? offeredProviderApprovalDecisions(approval.allowedDecisions ?? allowedDecisions)
    : [];
  // Two different reasons for no buttons, and only one of them is the owner's profile. The
  // profile check wins: a read-only controller is not told the agent is at fault.
  const agentOfferedNothing = canAnswer && approval.allowedDecisions !== undefined && offered.length === 0;
  return (
    <LiveFrame active tone="attention" className="live-frame live-frame--approval">
      <section className="thread-approval" data-approval-kind="provider">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="warning" label="Agent is waiting" />
            <span className="font-mono text-[10px] text-ink-faint">{approval.requestId}</span>
          </div>
          <p className="mt-3 text-sm font-semibold">{providerApprovalTitle(approval)}</p>
          {approval.detail ? <pre>{approval.detail}</pre> : null}
          <p className="mt-2 text-xs text-ink-muted">
            The agent stopped mid-turn to ask. It stays stopped until you answer.
          </p>
        </div>
        {offered.length === 0 ? (
          <p className="text-xs text-ink-muted">
            {agentOfferedNothing
              ? "The agent offered no decision this console can send, so answer it where the agent is running."
              : "This profile can see approvals but not answer them."}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {offered.map((entry) => (
              <Button
                key={entry.decision}
                variant={entry.decision === "accept"
                  ? "primary"
                  : entry.allows ? "ghost" : "danger-ghost"}
                size="sm"
                busy={busy}
                title={entry.description}
                onClick={() => onDecide(entry.decision)}
              >
                {entry.allows ? <Check className="size-4" /> : <X className="size-4" />}
                {entry.label}
                {entry.persistent ? (
                  <span className="text-[10px] uppercase tracking-wide text-ink-faint">
                    stays on
                  </span>
                ) : null}
              </Button>
            ))}
          </div>
        )}
      </section>
    </LiveFrame>
  );
}

/**
 * A QUESTION the agent is asking — the third blocking kind, and the only one answered with a value.
 *
 * The shape of each question decides the control, and nothing here ever falls back to a text box
 * for a question the agent enumerated. That is not a style choice: an answer that is not an exact
 * option label is silently dropped by OpenCode (opencodeRuntime.ts:376), silently relabelled as an
 * "Other" note by xAI (XAiAcpExtension.ts:133-155), and a hard failure on Codex — so a free-text
 * box next to a three-option question would be the console inviting an answer that quietly does
 * not arrive.
 *
 *   single-choice   radio group over the agent's own labels
 *   multi-choice    checkbox group over the same
 *   free-text       a textarea, and only when the agent supplied no options at all
 *
 * Nothing is preselected. A question exists because the agent could not decide; a console that
 * pre-picks an option is answering on the owner's behalf in exactly the worst place to do it.
 */
export function UserInputCard({
  request,
  busyAction,
  canAnswer,
  onAnswer,
}: {
  request: UserInputRequest;
  busyAction: string | null;
  canAnswer: boolean;
  onAnswer: (answers: UserInputAnswers) => void;
}) {
  const [draft, setDraft] = useState<UserInputDraft>(() => draftAnswers(request));
  // A repeated request id means the agent is asking again; the old draft belongs to the old
  // question and must not be submitted against the new one.
  const [draftFor, setDraftFor] = useState(request.requestId);
  if (draftFor !== request.requestId) {
    setDraftFor(request.requestId);
    setDraft(draftAnswers(request));
  }

  const busy = busyAction === `user-input-${request.requestId}`;
  const gap = describeDraftGap(request, draft);

  return (
    <LiveFrame active tone="attention" className="live-frame live-frame--approval">
      <section className="thread-approval" data-approval-kind="question">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="warning" label="Agent has a question" />
            <span className="font-mono text-[10px] text-ink-faint">{request.requestId}</span>
          </div>
          {!request.answerable ? (
            <p className="mt-3 text-sm text-ink-muted">
              The agent asked something this gateway cannot render. Answer it in T3 directly.
            </p>
          ) : (
            <div className="mt-3 flex flex-col gap-4">
              {request.questions.map((question) => (
                <fieldset key={question.id} className="flex flex-col gap-2">
                  <legend className="text-sm font-semibold">{question.header}</legend>
                  <p className="text-xs text-ink-muted">{question.question}</p>

                  {question.shape === "free-text" ? (
                    <textarea
                      className="w-full rounded border border-line bg-surface p-2 text-sm"
                      rows={3}
                      value={typeof draft[question.id] === "string" ? draft[question.id] as string : ""}
                      disabled={!canAnswer || busy}
                      aria-label={question.question}
                      onChange={(event) =>
                        setDraft((current) => setDraftText(current, question, event.target.value))}
                    />
                  ) : (
                    question.options.map((option) => {
                      const value = draft[question.id];
                      const checked = question.shape === "multi-choice"
                        ? Array.isArray(value) && value.includes(option.label)
                        : value === option.label;
                      return (
                        <label key={option.label} className="flex items-start gap-2 text-sm">
                          <input
                            type={question.shape === "multi-choice" ? "checkbox" : "radio"}
                            name={`user-input-${request.requestId}-${question.id}`}
                            value={option.label}
                            checked={checked}
                            disabled={!canAnswer || busy}
                            onChange={() =>
                              setDraft((current) => setDraftChoice(current, question, option.label))}
                          />
                          <span>
                            <span className="font-medium">{option.label}</span>
                            {option.description && option.description !== option.label ? (
                              <span className="block text-xs text-ink-muted">{option.description}</span>
                            ) : null}
                          </span>
                        </label>
                      );
                    })
                  )}
                </fieldset>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-ink-muted">
            The agent stopped mid-turn to ask. It stays stopped until you answer.
          </p>
        </div>
        {!canAnswer ? (
          <p className="text-xs text-ink-muted">
            This profile can see the agent&apos;s questions but not answer them.
          </p>
        ) : request.answerable ? (
          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              size="sm"
              busy={busy}
              disabled={gap !== null}
              onClick={() => onAnswer(draftToAnswers(request, draft))}
            >
              <Check className="size-4" /> Send answer
            </Button>
            {gap ? <p className="text-xs text-ink-muted">{gap}</p> : null}
          </div>
        ) : null}
      </section>
    </LiveFrame>
  );
}

function LiveThreadEntryView({ entry }: { entry: LiveThreadEntry }) {
  if (entry.kind === "message") {
    return (
      <article
        className="thread-message"
        data-role={entry.role}
        data-streaming={entry.streaming ? "true" : undefined}
      >
        <header>
          <span className="ac-eyebrow">
            {entry.role === "user" ? "You" : entry.role === "assistant" ? "Agent" : entry.role}
          </span>
          <span>
            <ActivityOrb activity={streamingActivity(entry.streaming)} />
            {entry.at ? <time>{formatRelativeTime(entry.at)}</time> : null}
          </span>
        </header>
        <p>{entry.text}</p>
      </article>
    );
  }

  if (entry.kind === "activity") {
    return (
      <div className="thread-activity" data-tone={entry.tone}>
        <span className="thread-activity__kind ac-eyebrow">{entry.activityKind}</span>
        <p>{entry.summary}</p>
        {entry.at ? <time>{formatRelativeTime(entry.at)}</time> : null}
      </div>
    );
  }

  if (entry.kind === "turn") {
    const additions = entry.files.reduce((total, file) => total + file.additions, 0);
    const deletions = entry.files.reduce((total, file) => total + file.deletions, 0);
    return (
      <div className="thread-turn" data-status={entry.status}>
        <span className="thread-turn__label">Turn finished</span>
        <p>
          {entry.files.length === 0
            ? "No files changed"
            : `${entry.files.length} ${entry.files.length === 1 ? "file" : "files"} changed · +${additions} −${deletions}`}
        </p>
        {entry.at ? <time>{formatRelativeTime(entry.at)}</time> : null}
      </div>
    );
  }

  if (entry.kind === "plan") {
    return (
      <div className="thread-plan">
        <span className="thread-plan__label">Proposed plan</span>
        <pre>{entry.planMarkdown}</pre>
      </div>
    );
  }

  return (
    <div className="thread-note">
      <p>{entry.summary}</p>
    </div>
  );
}
