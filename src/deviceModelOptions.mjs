// What a 240x320 controller needs to show and pick a model's own switches — reasoning effort,
// context window, fast mode — and nothing more.
//
// T3 has no bespoke "thinking budget" field. A model declares `capabilities.optionDescriptors` and
// takes chosen values back as `modelSelection.options: [{id, value}]`, and the ids are the
// provider's own (Codex `reasoningEffort`, Claude `effort` / `contextWindow`). So nothing in this
// file may name one: the projection is a bounded, credential-free copy of whatever the catalogue
// declared. src/t3Harness.mjs owns the full descriptors and the validation of a chosen value;
// this module only decides how much of them a bezel can carry.

export const DEVICE_MODEL_OPTION_LIMITS = Object.freeze({
  descriptors: 3,
  choices: 8,
  label: 16,
  // The id round-trips verbatim into `runtime_switch.options`, so it cannot be clipped to fit.
  // One too long to send back unchanged is omitted instead of offered as a button that would
  // select something else.
  id: 64,
});

/**
 * Project the current model's declared option descriptors for a controller.
 *
 * `harnesses` is the output of extractHarnesses(); `selection` is the thread's own
 * `{instanceId, model, options}`. A model the catalogue does not know yields an empty descriptor
 * list rather than an error — a snapshot-only environment has no descriptors to show, and the
 * controller's job there is to say so, not to fail.
 *
 * Deliberately dropped: descriptor/choice descriptions (provider prose, unbounded), the auth block,
 * status and any diagnostic text from the harness. Only ids, short labels, the value type and the
 * current value cross to the device.
 */
export function projectDeviceModelOptions({ harnesses, selection, limits = DEVICE_MODEL_OPTION_LIMITS }) {
  const instanceId = text(selection?.instanceId);
  const modelSlug = text(selection?.model);
  const harness = (Array.isArray(harnesses) ? harnesses : [])
    .find((entry) => entry?.instanceId === instanceId) ?? null;
  const model = (Array.isArray(harness?.models) ? harness.models : [])
    .find((entry) => entry?.slug === modelSlug) ?? null;

  const chosen = new Map((Array.isArray(selection?.options) ? selection.options : [])
    .filter((entry) => text(entry?.id))
    .map((entry) => [entry.id, entry.value]));

  const usable = (Array.isArray(model?.options) ? model.options : [])
    .map((descriptor) => projectDescriptor(descriptor, chosen, limits))
    .filter(Boolean);

  return {
    instanceId: instanceId ?? null,
    model: modelSlug ?? null,
    modelLabel: clip(model?.name ?? modelSlug, limits.label),
    providerLabel: clip(harness?.label ?? instanceId, limits.label),
    // Whether the gateway knows this model's switches at all, so "none declared" and "could not
    // tell" are not the same screen.
    known: model !== null,
    descriptors: usable.slice(0, limits.descriptors),
    truncated: usable.length > limits.descriptors,
  };
}

function projectDescriptor(descriptor, chosen, limits) {
  const id = text(descriptor?.id);
  if (!id || id.length > limits.id) return null;

  // Current value: what the thread actually has selected, else what the provider declared as its
  // default. A thread that never set the option is running on the default, and showing "unset"
  // would misreport it.
  const declaredDefault = descriptor.currentValue
    ?? (Array.isArray(descriptor.choices) ? descriptor.choices.find((choice) => choice?.isDefault)?.id : undefined)
    ?? null;
  const current = chosen.has(id) ? chosen.get(id) : declaredDefault;

  if (descriptor.type === "boolean") {
    return {
      id,
      label: clip(descriptor.label ?? id, limits.label),
      type: "boolean",
      current: typeof current === "boolean" ? current : null,
      choices: [],
      choicesTruncated: false,
    };
  }

  const all = (Array.isArray(descriptor.choices) ? descriptor.choices : [])
    .filter((choice) => text(choice?.id) && choice.id.length <= limits.id);
  // A select the provider declared without enumerating its values has nothing for a bezel to pick.
  if (all.length === 0) return null;

  let shown = all.slice(0, limits.choices);
  // The value in force must be visible even when it sits past the cut; swap it in for the last
  // slot rather than hiding the one fact the owner is most likely checking.
  const currentChoice = all.find((choice) => choice.id === current);
  if (currentChoice && !shown.includes(currentChoice)) shown = [...shown.slice(0, limits.choices - 1), currentChoice];

  return {
    id,
    label: clip(descriptor.label ?? id, limits.label),
    type: "select",
    current: typeof current === "string" ? current : null,
    choices: shown.map((choice) => ({ id: choice.id, label: clip(choice.label ?? choice.id, limits.label) })),
    choicesTruncated: all.length > shown.length,
  };
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function clip(value, limit) {
  const compact = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  if (!compact) return "";
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}
