import {
  ArrowDown,
  ArrowUp,
  Bot,
  Braces,
  Copy,
  Image,
  Pencil,
  Play,
  Plus,
  Save,
  Search,
  Terminal,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { Controller } from "../controller";
import { clearDurableMutationRequest, durableMutationRequest } from "../requestId";
import type { JsonRecord, SavedAction, SavedActionStep, SavedActionType } from "../types";
import { Button, EmptyState, Field, StatusBadge, cn, useConfirm } from "../ui";
import { mediaLabel } from "./MediaCapture";
import "./intelligence-control.css";

const actionKinds: Array<{
  value: SavedActionType;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  { value: "prompt", label: "Prompt", description: "A reusable instruction sent to an agent thread.", icon: Bot },
  { value: "shell", label: "Shell", description: "A policy-screened command executed through the agent.", icon: Terminal },
  { value: "media", label: "Media", description: "Capture an image or audio clip, then dispatch a prompt.", icon: Image },
  { value: "macro", label: "Macro", description: "An ordered sequence of reusable actions.", icon: Braces },
];

interface ActionDraft {
  id?: string;
  label: string;
  type: SavedActionType;
  text: string;
  mediaKind: "image" | "audio";
  environmentId: string;
  threadId: string;
  steps: SavedActionStep[];
}

function emptyDraft(type: SavedActionType = "prompt"): ActionDraft {
  return { label: "", type, text: "", mediaKind: "image", environmentId: "", threadId: "", steps: [] };
}

function actionText(action: SavedAction): string {
  const payload = action.payload ?? action.intent ?? {};
  const value = payload.text ?? payload.prompt ?? payload.transcript ?? payload.command;
  return typeof value === "string" ? value : "";
}

function draftFrom(action: SavedAction): ActionDraft {
  const intentType = typeof action.intent?.type === "string" ? action.intent.type : "";
  const mediaKind = action.payload?.mediaKind === "audio" || intentType === "audio_prompt" ? "audio" : "image";
  return {
    id: action.id,
    label: action.label,
    type: action.type,
    text: actionText(action),
    mediaKind,
    environmentId: action.environmentId ?? "",
    threadId: action.threadId ?? "",
    steps: action.steps?.map((step, index) => ({ ...step, position: index })) ?? [],
  };
}

function payloadFromDraft(draft: ActionDraft): JsonRecord {
  if (draft.type === "prompt") return { text: draft.text.trim() };
  if (draft.type === "shell") return { command: draft.text.trim() };
  if (draft.type === "media") return { mediaKind: draft.mediaKind, prompt: draft.text.trim() };
  return {};
}

function actionSummary(action: SavedAction, actions: SavedAction[]): string {
  if (action.type === "macro") {
    const labels = (action.steps ?? [])
      .map((step) => actions.find((candidate) => candidate.id === step.actionId)?.label)
      .filter(Boolean);
    return labels.length ? labels.join(" → ") : "No steps configured";
  }
  return actionText(action) || (action.type === "media" ? "Capture media and send it as context" : "No content");
}

export function ActionsPage({ controller: c }: { controller: Controller }) {
  const confirm = useConfirm();
  const actions = c.actions ?? [];
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | SavedActionType>("all");
  const [draft, setDraft] = useState<ActionDraft | null>(null);
  const [mediaSelections, setMediaSelections] = useState<Record<string, string>>({});

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return actions.filter((action) =>
      (filter === "all" || action.type === filter)
      && (!needle || `${action.label} ${actionSummary(action, actions)}`.toLowerCase().includes(needle))
    );
  }, [actions, filter, query]);

  const save = async () => {
    if (!draft?.label.trim()) return;
    const body = {
      label: draft.label.trim(),
      type: draft.type,
      payload: payloadFromDraft(draft),
      steps: draft.type === "macro"
        ? draft.steps.map((step, position) => ({ ...step, position }))
        : undefined,
      environmentId: draft.environmentId || null,
      threadId: draft.threadId.trim() || null,
      targetMode: draft.environmentId ? "fixed" : "device-current",
    };
    const result = await c.run(
      draft.id ? `update-action-${draft.id}` : "create-action",
      draft.id ? "Action updated." : "Action created.",
      async () => {
        const response = await c.api(
          draft.id ? `/v1/actions/${encodeURIComponent(draft.id)}` : "/v1/actions",
          { method: draft.id ? "PUT" : "POST", body },
        );
        await c.refreshAll();
        return response;
      },
    );
    if (result) setDraft(null);
  };

  const duplicate = async (action: SavedAction) => {
    await c.run(`duplicate-action-${action.id}`, "Action duplicated.", async () => {
      const response = await c.api("/v1/actions", {
        method: "POST",
        body: {
          label: `${action.label} copy`,
          type: action.type,
          payload: action.payload ?? payloadFromDraft(draftFrom(action)),
          steps: action.steps,
          environmentId: action.environmentId ?? null,
          threadId: action.threadId ?? null,
          targetMode: action.targetMode ?? (action.environmentId ? "fixed" : "device-current"),
        },
      });
      await c.refreshAll();
      return response;
    });
  };

  const remove = async (action: SavedAction) => {
    const accepted = await confirm({
      title: `Delete “${action.label}”?`,
      description: "It will also disappear from controller menus that reference it. Command history is retained.",
      confirmLabel: "Delete action",
    });
    if (!accepted) return;
    await c.run(`delete-action-${action.id}`, "Action deleted.", async () => {
      const response = await c.api(`/v1/actions/${encodeURIComponent(action.id)}`, { method: "DELETE" });
      await c.refreshAll();
      return response;
    });
  };

  const test = async (action: SavedAction) => {
    const mediaKind = action.payload?.mediaKind;
    const selectedMediaId = mediaSelections[action.id];
    const mediaUpload = action.type === "media"
      ? c.media.find((item) => item.id === selectedMediaId && item.kind === mediaKind)
      : null;
    if (action.type === "media" && !mediaUpload) {
      c.setNotice({ tone: "info", message: `Select a compatible ${mediaKind ?? "media"} upload before testing this action.` });
      return;
    }
    await c.run(`test-action-${action.id}`, "Action dispatched.", async () => {
      const pending = await durableMutationRequest({
        operation: "action.run",
        actionId: action.id,
        environmentId: c.selectedEnvironmentId || null,
        threadId: c.selectedThreadId || null,
        mediaUploadId: mediaUpload?.id ?? null,
      });
      const response = await c.api(`/v1/actions/${encodeURIComponent(action.id)}/run`, {
        method: "POST",
        body: {
          environmentId: c.selectedEnvironmentId || undefined,
          threadId: c.selectedThreadId || undefined,
          ...(mediaUpload ? { mediaUploadId: mediaUpload.id } : {}),
          clientRequestId: pending.clientRequestId,
        },
      });
      clearDurableMutationRequest(pending.storageKey);
      await c.refreshAll();
      return response;
    });
  };

  return (
    <div className="actions-workspace ic-scope ic-actions">
      <header className="actions-header">
        <div>
          <p className="ac-eyebrow">Reusable operations</p>
          <h2 className="ac-display-title">Actions library</h2>
          <p>Author once, then assign it to compatible controllers. On hardware it appears inside an opened thread, never in the root menu.</p>
        </div>
        <Button variant="primary" onClick={() => setDraft(emptyDraft())}><Plus className="size-4" /> New action</Button>
      </header>

      <div className="actions-toolbar">
        <label className="actions-search">
          <Search className="size-4" aria-hidden="true" />
          <span className="sr-only">Search actions</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search actions" />
        </label>
        <div className="actions-filters" role="group" aria-label="Filter action type">
          {(["all", "prompt", "shell", "media", "macro"] as const).map((value) => (
            <button key={value} type="button" data-active={filter === value || undefined} onClick={() => setFilter(value)}>
              {value}
            </button>
          ))}
        </div>
      </div>

      {visible.length ? (
        <section className="action-grid" aria-label="Saved actions">
          {visible.map((action) => {
            const kind = actionKinds.find((entry) => entry.value === action.type) ?? actionKinds[0];
            const Icon = kind.icon;
            const requiredMediaKind = action.payload?.mediaKind === "audio" ? "audio" : "image";
            const compatibleMedia = action.type === "media"
              ? c.media.filter((item) => item.kind === requiredMediaKind)
              : [];
            const selectedMediaId = mediaSelections[action.id] ?? "";
            return (
              <article key={action.id} className="action-card">
                <div className="action-card__topline">
                  <span className="action-card__icon"><Icon className="size-4" /></span>
                  <StatusBadge label={kind.label} tone={action.type === "shell" ? "warning" : action.type === "macro" ? "info" : "neutral"} />
                  {action.deviceIds?.length ? <span className="action-card__usage">{action.deviceIds.length} devices</span> : null}
                </div>
                <div className="action-card__copy">
                  <h3>{action.label}</h3>
                  <p>{actionSummary(action, actions)}</p>
                </div>
                <div className="action-card__target">
                  <span>{action.environmentId ? c.environments.find((item) => item.id === action.environmentId)?.label ?? action.environmentId : "Device context"}</span>
                  <span>{action.threadId || "Current thread"}</span>
                </div>
                {action.type === "media" ? (
                  <div className="action-card__media">
                    <select
                      aria-label={`Media for ${action.label}`}
                      value={selectedMediaId}
                      disabled={!compatibleMedia.length}
                      onChange={(event) => setMediaSelections((current) => ({ ...current, [action.id]: event.target.value }))}
                    >
                      <option value="">Choose {requiredMediaKind}</option>
                      {compatibleMedia.map((item) => (
                        <option key={item.id} value={item.id}>{mediaLabel(item)}</option>
                      ))}
                    </select>
                    {!compatibleMedia.length ? <small>Upload a compatible {requiredMediaKind} to test this action.</small> : null}
                  </div>
                ) : null}
                <div className="action-card__actions">
                  <Button
                    size="sm"
                    busy={c.busyAction === `test-action-${action.id}`}
                    disabled={action.type === "media" && !selectedMediaId}
                    title={action.type === "media" && !selectedMediaId ? `Choose a compatible ${requiredMediaKind} first` : undefined}
                    onClick={() => void test(action)}
                  ><Play className="size-3.5" /> Run</Button>
                  <Button size="icon" variant="ghost" aria-label={`Edit ${action.label}`} onClick={() => setDraft(draftFrom(action))}><Pencil className="size-3.5" /></Button>
                  <Button size="icon" variant="ghost" aria-label={`Duplicate ${action.label}`} onClick={() => void duplicate(action)}><Copy className="size-3.5" /></Button>
                  <Button size="icon" variant="danger-ghost" aria-label={`Delete ${action.label}`} onClick={() => void remove(action)}><Trash2 className="size-3.5" /></Button>
                </div>
              </article>
            );
          })}
        </section>
      ) : (
        <div className="actions-empty">
          <EmptyState
            icon={Braces}
            title={actions.length ? "No matching actions" : "Build your first reusable action"}
            description={actions.length ? "Try a different filter or search term." : "Save a prompt, shell command, media capture, or ordered macro for the web and hardware controllers."}
            action={!actions.length ? <Button onClick={() => setDraft(emptyDraft())}><Plus className="size-4" /> Create action</Button> : undefined}
          />
        </div>
      )}

      {draft ? (
        <ActionEditor
          draft={draft}
          actions={actions}
          controller={c}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSave={() => void save()}
        />
      ) : null}
    </div>
  );
}

function ActionEditor({
  draft,
  actions,
  controller: c,
  onChange,
  onClose,
  onSave,
}: {
  draft: ActionDraft;
  actions: SavedAction[];
  controller: Controller;
  onChange: (draft: ActionDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const [stepActionId, setStepActionId] = useState("");
  // Media steps require a fresh capture/upload ID at runtime. Until macro steps can declare that
  // input explicitly, keep them out of the builder instead of creating macros that always fail.
  const candidates = actions.filter((action) => action.id !== draft.id && action.type !== "macro" && action.type !== "media");
  const valid = Boolean(draft.label.trim()) && (draft.type === "macro" ? draft.steps.length > 0 : Boolean(draft.text.trim()));
  const moveStep = (index: number, offset: number) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[index], steps[nextIndex]] = [steps[nextIndex], steps[index]];
    onChange({ ...draft, steps });
  };
  return (
    <div className="action-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="action-editor" role="dialog" aria-modal="true" aria-labelledby="action-editor-title">
        <header>
          <div>
            <p className="ac-eyebrow">{draft.id ? "Edit definition" : "New reusable operation"}</p>
            <h2 id="action-editor-title">{draft.id ? draft.label : "Create action"}</h2>
          </div>
          <Button size="icon" variant="ghost" aria-label="Close action editor" onClick={onClose}><X className="size-4" /></Button>
        </header>
        <div className="action-editor__body">
          <fieldset>
            <legend>Action type</legend>
            <div className="action-kind-grid">
              {actionKinds.map(({ value, label, description, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  data-active={draft.type === value || undefined}
                  onClick={() => onChange({ ...draft, type: value })}
                >
                  <Icon className="size-4" />
                  <span><strong>{label}</strong><small>{description}</small></span>
                </button>
              ))}
            </div>
          </fieldset>
          <Field label="Display label" htmlFor="action-label" hint="Keep it short enough for the controller display.">
            <input id="action-label" autoFocus value={draft.label} maxLength={48} onChange={(event) => onChange({ ...draft, label: event.target.value })} placeholder="Run tests" />
          </Field>

          {draft.type === "media" ? (
            <Field label="Capture source" htmlFor="action-media-kind">
              <select id="action-media-kind" value={draft.mediaKind} onChange={(event) => onChange({ ...draft, mediaKind: event.target.value as "image" | "audio" })}>
                <option value="image">Camera image</option>
                <option value="audio">Voice recording</option>
              </select>
            </Field>
          ) : null}

          {draft.type !== "macro" ? (
            <Field
              label={draft.type === "shell" ? "Command" : draft.type === "media" ? "Prompt after capture" : "Prompt"}
              htmlFor="action-content"
              hint={draft.type === "shell" ? "Shell actions remain subject to policy and runtime approval." : undefined}
            >
              <textarea
                id="action-content"
                className={draft.type === "shell" ? "font-mono" : undefined}
                rows={5}
                value={draft.text}
                onChange={(event) => onChange({ ...draft, text: event.target.value })}
                placeholder={draft.type === "shell" ? "npm test" : "Describe what the agent should do…"}
              />
            </Field>
          ) : (
            <fieldset className="macro-builder">
              <legend>Ordered steps</legend>
              <div className="macro-builder__add">
                <select aria-label="Action to add" value={stepActionId} onChange={(event) => setStepActionId(event.target.value)}>
                  <option value="">Choose an action</option>
                  {candidates.map((action) => <option key={action.id} value={action.id}>{action.label}</option>)}
                </select>
                <Button
                  size="sm"
                  disabled={!stepActionId}
                  onClick={() => {
                    onChange({ ...draft, steps: [...draft.steps, { actionId: stepActionId, continueOnFailure: false }] });
                    setStepActionId("");
                  }}
                ><Plus className="size-3.5" /> Add step</Button>
              </div>
              <ol className="macro-steps">
                {draft.steps.map((step, index) => {
                  const action = actions.find((candidate) => candidate.id === step.actionId);
                  return (
                    <li key={`${step.actionId}-${index}`}>
                      <span className="macro-steps__number">{index + 1}</span>
                      <span className="macro-steps__label">{action?.label ?? step.actionId}</span>
                      <label><input type="checkbox" checked={Boolean(step.continueOnFailure)} onChange={(event) => {
                        const steps = draft.steps.map((item, itemIndex) => itemIndex === index ? { ...item, continueOnFailure: event.target.checked } : item);
                        onChange({ ...draft, steps });
                      }} /> Continue on failure</label>
                      <Button size="icon" variant="ghost" aria-label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => moveStep(index, -1)}><ArrowUp className="size-3.5" /></Button>
                      <Button size="icon" variant="ghost" aria-label={`Move step ${index + 1} down`} disabled={index === draft.steps.length - 1} onClick={() => moveStep(index, 1)}><ArrowDown className="size-3.5" /></Button>
                      <Button size="icon" variant="danger-ghost" aria-label={`Remove step ${index + 1}`} onClick={() => onChange({ ...draft, steps: draft.steps.filter((_, itemIndex) => itemIndex !== index) })}><X className="size-3.5" /></Button>
                    </li>
                  );
                })}
              </ol>
              {!draft.steps.length ? <p className="macro-builder__empty">Add at least one prompt or shell action.</p> : null}
            </fieldset>
          )}

          <div className="action-target-grid">
            <Field label="Environment" htmlFor="action-environment" hint="Leave blank to inherit the device or Operations context.">
              <select id="action-environment" value={draft.environmentId} onChange={(event) => onChange({ ...draft, environmentId: event.target.value })}>
                <option value="">Inherit at run time</option>
                {c.environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.label}</option>)}
              </select>
            </Field>
            <Field label="Thread ID" htmlFor="action-thread">
              <input id="action-thread" className="font-mono" value={draft.threadId} onChange={(event) => onChange({ ...draft, threadId: event.target.value })} placeholder="Current thread" />
            </Field>
          </div>
        </div>
        <footer>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={c.busyAction === (draft.id ? `update-action-${draft.id}` : "create-action")} disabled={!valid} onClick={onSave}><Save className="size-4" /> {draft.id ? "Save changes" : "Create action"}</Button>
        </footer>
      </section>
    </div>
  );
}
