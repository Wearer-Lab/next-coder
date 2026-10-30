// Reads agent harnesses (T3 "provider instances"), their models, and live session health out of a
// T3 orchestration snapshot.
//
// Verified against live T3 Code 0.0.28 and 0.0.32 servers.
// `GET /api/orchestration/snapshot` returns exactly:
//   { snapshotSequence, projects, threads, updatedAt }
// There is no provider catalogue on that endpoint — T3 publishes the full catalogue to its own web
// UI over the authenticated WebSocket instead (server spans: upsertProviders, syncProvider,
// publishEnrichedSnapshot). So the instances and models reachable over the paired HTTP API are the
// ones actually referenced by projects:
//   projects[].defaultModelSelection = { instanceId, model }
//   threads[].session                = { status, providerInstanceId, lastError, activeTurnId, ... }
//
// A host-side catalogue (T3's <base-dir>/caches/<instanceId>.json) can be registered separately to
// enrich this; see mergeHostCatalogue. Historical thread model selections are intentionally not
// treated as available models: failed threads can contain malformed or retired slugs.

export function extractHarnesses(snapshot, { catalogue = null } = {}) {
  const byInstance = new Map();

  const record = (selection, source) => {
    const instanceId = string(selection?.instanceId);
    const model = string(selection?.model);
    if (!instanceId) return;
    const harness = byInstance.get(instanceId) ?? {
      instanceId,
      label: instanceId,
      models: new Map(),
      observedIn: new Set(),
    };
    if (model) {
      const existing = harness.models.get(model) ?? { slug: model, name: model, seenIn: new Set() };
      existing.seenIn.add(source);
      harness.models.set(model, existing);
    }
    harness.observedIn.add(source);
    byInstance.set(instanceId, harness);
  };

  for (const project of array(snapshot?.projects)) record(project?.defaultModelSelection, "project");
  for (const thread of array(snapshot?.threads)) {
    const instanceId = string(thread?.session?.providerInstanceId);
    if (instanceId) record({ instanceId }, "session");
  }

  const harnesses = [...byInstance.values()].map((harness) => ({
    instanceId: harness.instanceId,
    label: harness.label,
    source: "snapshot",
    models: [...harness.models.values()].map((model) => ({
      slug: model.slug,
      name: model.name,
      isCustom: false,
      options: [],
      observed: true,
    })),
  }));

  return catalogue ? mergeHostCatalogue(harnesses, catalogue) : harnesses;
}

/**
 * Merges an authoritative host-side catalogue over what the snapshot revealed.
 *
 * `entries` are T3 provider status records, the exact shape T3 writes to
 * <base-dir>/caches/<instanceId>.json:
 *   { instanceId, displayName, badgeLabel, enabled, installed, version, status, message,
 *     auth: { status, type, label },
 *     models: [{ slug, name, isCustom, capabilities: { optionDescriptors: [...] } }] }
 */
export function mergeHostCatalogue(harnesses, entries) {
  // Accepts either raw cache records or a persisted catalogue envelope.
  const records = Array.isArray(entries) ? entries : array(entries?.instances);
  const catalogued = new Map();

  for (const raw of records) {
    const normalized = normalizeCatalogueEntry(raw);
    if (!normalized) continue;
    catalogued.set(normalized.instanceId, normalized);
  }

  // Prefer the current project's provider ordering, then append the other providers in the order
  // T3 returned them. Only catalogue entries survive: snapshot values describe history, not what
  // can be launched now.
  const merged = [];
  for (const harness of array(harnesses)) {
    const normalized = catalogued.get(harness.instanceId);
    if (!normalized) continue;
    merged.push(normalized);
    catalogued.delete(harness.instanceId);
  }
  merged.push(...catalogued.values());
  return merged;
}

export function normalizeCatalogueEntry(raw) {
  const instanceId = string(raw?.instanceId) ?? string(raw?.id);
  if (!instanceId) return null;

  const status = string(raw.status) ?? "unknown";
  const authStatus = string(raw.auth?.status) ?? "unknown";
  const enabled = raw.enabled !== false;
  const installed = raw.installed !== false;

  return {
    instanceId,
    label: string(raw.displayName) ?? string(raw.label) ?? instanceId,
    badge: string(raw.badgeLabel) ?? null,
    version: string(raw.version) ?? null,
    source: "catalogue",
    ...(raw.runtimeKind === "direct" ? { runtimeKind: "direct" } : {}),
    status,
    enabled,
    installed,
    auth: {
      status: authStatus,
      type: string(raw.auth?.type) ?? null,
      label: string(raw.auth?.label) ?? null,
    },
    available: enabled && installed && status === "ready" && (authStatus === "authenticated" || (raw.runtimeKind === "direct" && authStatus === "unknown")),
    unavailableReason: raw.runtimeKind === "direct" && enabled && installed && status === "ready" && authStatus === "unknown" ? null : unavailableReason({ enabled, installed, status, authStatus, message: raw.message }),
    models: array(raw.models).map(normalizeModel).filter(Boolean),
  };
}

/**
 * Normalizes a set of raw T3 provider-status records into the catalogue we persist against an
 * environment. Input is what T3 writes to <base-dir>/caches/<instanceId>.json; anything not part of
 * that documented shape is dropped rather than stored.
 */
export function buildProviderCatalogue(entries, { source = "setup-script", updatedAt = new Date().toISOString() } = {}) {
  const instances = array(entries)
    .map(normalizeCatalogueEntry)
    .filter(Boolean)
    .map((entry) => ({
      instanceId: entry.instanceId,
      ...(entry.runtimeKind === "direct" ? { runtimeKind: "direct" } : {}),
      label: entry.label,
      badge: entry.badge,
      version: entry.version,
      status: entry.status,
      enabled: entry.enabled,
      installed: entry.installed,
      auth: entry.auth,
      models: entry.models.map((model) => ({
        slug: model.slug,
        name: model.name,
        isCustom: model.isCustom,
        options: model.options,
      })),
    }));

  return { updatedAt, source, instances };
}

/**
 * Per-thread outcome, used to reconcile commands the gateway only knows as "dispatched".
 *
 * Verified against real T3 state. A session reads `status: "stopped"` whether the turn succeeded or
 * failed, so session status alone proves nothing. The reliable discriminators are:
 *   failed    → session.lastError is set (turn state "error", no assistant message)
 *   completed → an assistant message exists (turn state "completed")
 *   running   → session.activeTurnId is set, or neither of the above holds yet
 */
export function extractThreadOutcomes(snapshot) {
  const outcomes = new Map();

  for (const thread of array(snapshot?.threads)) {
    const threadId = string(thread.id);
    if (!threadId) continue;

    const session = thread.session ?? {};
    const failure = parseProviderError(session.lastError);
    const assistantMessages = array(thread.messages)
      .filter((message) => string(message.role) === "assistant" && !message.streaming);
    const lastAssistantMessage = assistantMessages
      .map((message, index) => ({
        text: string(message.text) ?? "",
        createdAt: string(message.createdAt) ?? null,
        index,
      }))
      .sort((left, right) => {
        if (left.createdAt && right.createdAt) return left.createdAt.localeCompare(right.createdAt);
        if (left.createdAt) return 1;
        if (right.createdAt) return -1;
        return left.index - right.index;
      })
      .at(-1) ?? null;

    outcomes.set(threadId, {
      threadId,
      ...(thread.runtimeKind === "direct" ? { runtimeKind: "direct", evidenceTurnId: session.lastTurnId ?? null,
        lastAssistantTurnId: thread.lastOutcome?.status === "completed" ? thread.lastOutcome.turnId : null } : {}),
      sessionStatus: string(session.status) ?? "unknown",
      activeTurnId: string(session.activeTurnId) ?? null,
      failure: failure
        ? { message: failure.message, code: failure.code, at: string(session.updatedAt) ?? null }
        : null,
      assistantMessageCount: assistantMessages.length,
      lastAssistantAt: lastAssistantMessage?.createdAt ?? (thread.runtimeKind === "direct" && thread.lastOutcome?.status === "completed" ? thread.lastOutcome.completedAt : null),
      lastAssistantText: lastAssistantMessage?.text ?? (thread.runtimeKind === "direct" ? thread.lastOutcome?.preview : null) ?? null,
    });
  }

  return outcomes;
}

/**
 * Decides what a dispatched command should become, given its thread's outcome.
 * Returns null when there is no evidence to change it, so a running turn is left alone.
 */
export function reconcileCommandStatus(command, outcome) {
  if (!outcome || command?.status !== "dispatched") return null;
  if (outcome.runtimeKind === "direct" && command.result?.turnId && outcome.evidenceTurnId !== command.result.turnId) return null;

  const recordedAt = Date.parse(command.updatedAt ?? command.createdAt ?? "");
  const acknowledgedAt = Date.parse(command.metrics?.completedAt ?? "");
  const dispatchDuration = command.metrics?.dispatchDurationMs;
  const explicitDispatchAt = Date.parse(command.metrics?.dispatchStartedAt ?? "");
  // The command is stored after T3 acknowledges dispatch. A real reply can arrive while that
  // acknowledgement is in transit; freshness starts when dispatch began, not when it returned.
  const dispatchedAt = Number.isFinite(explicitDispatchAt) ? explicitDispatchAt
    : Number.isFinite(acknowledgedAt) && Number.isFinite(dispatchDuration)
    && dispatchDuration >= 0 ? acknowledgedAt - dispatchDuration : recordedAt;

  if (outcome.failure) {
    // Only attribute a failure that is not older than the command itself.
    const failedAt = Date.parse(outcome.failure.at ?? "");
    if (Number.isFinite(dispatchedAt) && Number.isFinite(failedAt) && failedAt < dispatchedAt) return null;
    return {
      status: "failed",
      result: {
        reason: outcome.failure.message,
        ...(outcome.failure.code ? { code: outcome.failure.code } : {}),
        source: "t3-session",
      },
    };
  }

  if (outcome.lastAssistantAt) {
    if (outcome.runtimeKind === "direct" && command.result?.turnId && outcome.lastAssistantTurnId !== command.result.turnId) return null;
    const repliedAt = Date.parse(outcome.lastAssistantAt);
    // A reply that predates the dispatch belongs to an earlier turn on the same thread.
    if (Number.isFinite(dispatchedAt) && Number.isFinite(repliedAt) && repliedAt < dispatchedAt) return null;
    return {
      status: "completed",
      result: {
        response: outcome.lastAssistantText || "The agent replied.",
        repliedAt: outcome.lastAssistantAt,
        source: "t3-session",
      },
    };
  }

  return null;
}

/** Every thread whose provider session is reporting a failure, with T3's own error text. */
export function extractSessionFailures(snapshot) {
  const failures = [];
  for (const thread of array(snapshot?.threads)) {
    const session = thread?.session;
    if (!session) continue;
    const lastError = parseProviderError(session.lastError);
    if (!lastError) continue;
    failures.push({
      threadId: string(thread.id) ?? string(session.threadId) ?? null,
      title: string(thread.title) ?? null,
      status: string(session.status) ?? "unknown",
      instanceId: string(session.providerInstanceId) ?? null,
      model: string(thread.modelSelection?.model) ?? null,
      message: lastError.message,
      code: lastError.code,
      updatedAt: string(session.updatedAt) ?? null,
    });
  }
  return failures;
}

/**
 * Checks a selection against a catalogue. Returns null when the pair is valid, otherwise an
 * explanation. This is what stops a mistyped slug reaching a provider.
 */
export function validateModelSelection(selection, harnesses) {
  const instanceId = string(selection?.instanceId);
  const model = string(selection?.model);
  if (!instanceId || !model) return { reason: "A provider instance and model are both required." };

  // Only a registered catalogue is authoritative. Derived-from-snapshot harnesses show what is in
  // use, not what exists, so rejecting against them would break user-defined provider instances.
  const authoritative = harnesses.some((entry) => entry.source === "catalogue");
  if (!authoritative) return null;

  const harness = harnesses.find((entry) => entry.instanceId === instanceId);
  if (!harness) {
    return {
      reason: `Unknown provider instance "${instanceId}".`,
      known: harnesses.map((entry) => entry.instanceId),
    };
  }
  if (harness.available === false) {
    return { reason: harness.unavailableReason ?? `Provider instance "${instanceId}" is unavailable.` };
  }
  if (harness.models.length === 0) return null;
  const entry = harness.models.find((candidate) => candidate.slug === model);
  if (entry) return validateModelOptionSelections(selection?.options, entry);

  return {
    reason: `Unknown model "${model}" for provider instance "${instanceId}".`,
    known: harness.models.map((entry) => entry.slug),
  };
}

/**
 * Reasoning effort, service tier and the rest of the per-model switches.
 *
 * T3 does not have a "thinking budget" field. It declares whatever switches a model supports as
 * `capabilities.optionDescriptors` and takes the chosen values back as
 * `modelSelection.options: [{id, value}]`. The descriptor ids are the provider's own, which is why
 * nothing here may hardcode one: Codex calls its reasoning control `reasoningEffort` and offers
 * `ultra`, while Claude calls it `effort` and offers `ultrathink`. A gateway that hardcoded either
 * name would silently drop the other provider's control.
 *
 * Validated before dispatch for the same reason model slugs are: T3 accepts a dispatch and lets
 * the provider reject the value later, which surfaces as a turn stuck mid-flight rather than as an
 * error anyone can act on.
 */
export function validateModelOptionSelections(options, model) {
  if (options === undefined || options === null) return null;
  if (!Array.isArray(options)) return { reason: "Model options must be an array of {id, value} entries." };
  if (options.length > MAX_MODEL_OPTION_SELECTIONS) {
    return { reason: `A model selection carries at most ${MAX_MODEL_OPTION_SELECTIONS} options.` };
  }

  const descriptors = new Map(array(model?.options).map((descriptor) => [descriptor.id, descriptor]));
  const seen = new Set();
  for (const entry of options) {
    const id = string(entry?.id);
    if (!id) return { reason: "Every model option needs an id." };
    if (seen.has(id)) return { reason: `Model option "${id}" was set twice.` };
    seen.add(id);

    const descriptor = descriptors.get(id);
    // An unknown id is refused rather than forwarded. A catalogue that declares no descriptors at
    // all cannot prove anything, so that case is handled by the caller's authoritative check.
    if (!descriptor) {
      return { reason: `Unknown option "${id}" for model "${model?.slug}".`, known: [...descriptors.keys()] };
    }
    if (descriptor.type === "boolean") {
      if (typeof entry.value !== "boolean") return { reason: `Option "${id}" is a switch and takes true or false.` };
      continue;
    }
    const value = string(entry.value);
    if (!value) return { reason: `Option "${id}" needs a value.` };
    // An empty choice list means the provider declared a select it did not enumerate; refusing
    // every value there would block a legitimate selection, so the bounded string is accepted.
    if (descriptor.choices.length > 0 && !descriptor.choices.some((choice) => choice.id === value)) {
      return {
        reason: `Unknown value "${value}" for option "${id}".`,
        known: descriptor.choices.map((choice) => choice.id),
      };
    }
  }
  return null;
}

/**
 * Normalize an owner-supplied option array onto the wire shape, dropping anything unusable.
 *
 * Shape only — whether a value is *allowed* is validateModelOptionSelections's job against the
 * catalogue. Kept separate so a request can be rejected with a reason instead of silently
 * sanitized into something the owner did not ask for.
 */
export function normalizeModelOptionSelections(value) {
  if (!Array.isArray(value)) return null;
  const normalized = [];
  for (const entry of value.slice(0, MAX_MODEL_OPTION_SELECTIONS)) {
    const id = string(entry?.id);
    if (!id || id.length > 120) continue;
    if (typeof entry.value === "boolean") { normalized.push({ id, value: entry.value }); continue; }
    const text = string(entry?.value);
    if (text && text.length <= 200) normalized.push({ id, value: text });
  }
  return normalized.length > 0 ? normalized : null;
}

export function usableHarnesses(harnesses) {
  return harnesses.filter((harness) => harness.available !== false && harness.models.length > 0);
}

export function resolveLatestModelSelection({ harnesses, preferredInstanceId = null }) {
  const usable = usableHarnesses(harnesses);
  const harness = usable.find((entry) => entry.instanceId === preferredInstanceId) ?? usable[0];
  if (!harness) return null;
  const model = harness.models[0];
  return {
    instanceId: harness.instanceId,
    model: model.slug,
    options: defaultModelOptions(model),
  };
}

export function resolveModelSelection({ harnesses, requested = null, projectDefault = null }) {
  if (requested && validateModelSelection(requested, harnesses) === null) {
    return {
      instanceId: requested.instanceId,
      model: requested.model,
      ...(requested.options ? { options: requested.options } : {}),
    };
  }

  return resolveLatestModelSelection({
    harnesses,
    preferredInstanceId: projectDefault?.instanceId ?? requested?.instanceId ?? null,
  });
}

// Bounded because the array is owner input that reaches a provider. T3's own descriptor sets are
// two or three entries per model; sixteen leaves room without letting a request carry a payload.
export const MAX_MODEL_OPTION_SELECTIONS = 16;

export function defaultModelOptions(model) {
  const options = [];
  for (const descriptor of array(model?.options)) {
    const value = descriptor.currentValue ?? descriptor.choices?.find((choice) => choice.isDefault)?.id;
    if (value !== undefined && value !== null) options.push({ id: descriptor.id, value });
  }
  return options;
}

function normalizeModel(raw) {
  const slug = string(raw?.slug) ?? string(raw?.id);
  if (!slug) return null;
  // Raw T3 cache records nest descriptors under capabilities; a persisted catalogue has already
  // flattened them to `options`.
  const descriptors = raw.capabilities?.optionDescriptors ?? raw.options;
  return {
    slug,
    name: string(raw.name) ?? slug,
    isCustom: raw.isCustom === true,
    options: array(descriptors).map(normalizeOptionDescriptor).filter(Boolean),
  };
}

function normalizeOptionDescriptor(raw) {
  const id = string(raw?.id);
  if (!id) return null;
  return {
    id,
    label: string(raw.label) ?? id,
    type: string(raw.type) ?? "select",
    currentValue: raw.currentValue ?? null,
    description: string(raw.description) ?? null,
    choices: array(raw.options ?? raw.choices).map((choice) => ({
      id: string(choice?.id) ?? "",
      label: string(choice?.label) ?? string(choice?.id) ?? "",
      isDefault: choice?.isDefault === true,
      // Kept because the provider's own wording is the only thing that explains a value like
      // Claude's `ultracode` ("xhigh effort plus multi-agent workflow orchestration"); inventing
      // that text in the console would be guessing at another product's behaviour.
      description: string(choice?.description) ?? null,
    })).filter((choice) => choice.id),
  };
}

// T3 stores lastError as a JSON string carrying the provider's own error envelope.
/**
 * T3's `session.lastError` is sometimes an object and sometimes a JSON string holding one. Exported
 * so the live thread stream parses a session error exactly as the snapshot path does — two
 * readings of the same field must not disagree about whether a turn failed.
 */
export function parseProviderError(lastError) {
  if (!lastError) return null;
  if (typeof lastError === "object") {
    return { message: string(lastError.message) ?? JSON.stringify(lastError), code: string(lastError.type) ?? null };
  }
  const text = string(lastError);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const inner = parsed?.error ?? parsed;
    return {
      message: string(inner?.message) ?? text,
      code: string(inner?.type) ?? string(parsed?.type) ?? null,
    };
  } catch {
    return { message: text, code: null };
  }
}

function unavailableReason({ enabled, installed, status, authStatus, message }) {
  if (!enabled) return "Disabled in T3.";
  if (!installed) return "Not installed on the T3 host.";
  if (status !== "ready") return string(message) ?? `Harness status is ${status}.`;
  if (authStatus !== "authenticated") return "Not authenticated. Sign in to this provider in T3.";
  return null;
}

function array(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry && typeof entry === "object");
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, entry]) => entry && typeof entry === "object")
      .map(([instanceId, entry]) => ({ instanceId, ...entry }));
  }
  return [];
}

function string(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
