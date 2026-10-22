import { HttpError, optionalString, requireString } from "./http.mjs";

export const ACTION_TYPES = Object.freeze(["prompt", "shell", "media", "macro"]);
// Why a saved action or macro is parked. Removing the T3 environment a fixed action targets leaves
// a row that could not be created from scratch, so it is disabled with this reason instead.
export const ENVIRONMENT_REMOVED_REASON = "environment_removed";
export const SYSTEM_CONTROL_IDS = Object.freeze({
  status: "system_status",
  stop: "system_stop",
  reset: "system_reset",
});

export function normalizeActionInput(body, existing = null) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Action body is required.");
  }
  const type = optionalString(body.type) ?? existing?.type;
  if (!ACTION_TYPES.includes(type)) throw new HttpError(400, `Unsupported action type: ${type ?? "missing"}.`);
  const label = Object.hasOwn(body, "label") ? requireString(body.label, "label") : existing?.label;
  if (!label) throw new HttpError(400, "label is required.");
  if (label.length > 80) throw new HttpError(400, "label must be 80 characters or fewer.");

  const targetMode = optionalString(body.targetMode) ?? existing?.targetMode ?? "device-current";
  if (!["device-current", "fixed"].includes(targetMode)) {
    throw new HttpError(400, "targetMode must be device-current or fixed.");
  }
  const environmentId = Object.hasOwn(body, "environmentId")
    ? optionalString(body.environmentId) ?? null
    : existing?.environmentId ?? null;
  const threadId = Object.hasOwn(body, "threadId")
    ? optionalString(body.threadId) ?? null
    : existing?.threadId ?? null;
  if (targetMode === "fixed" && !environmentId) {
    throw new HttpError(400, "A fixed action requires environmentId.");
  }

  const payloadInput = Object.hasOwn(body, "payload") ? body.payload : existing?.payload;
  const stepsInput = Object.hasOwn(body, "steps") ? body.steps : existing?.steps;
  const payload = normalizeActionPayload(type, payloadInput, body.intent);
  const steps = type === "macro" ? normalizeMacroSteps(stepsInput) : [];

  // Saving an action always re-enables it: an edit is the owner's explicit statement that the
  // record is good again, and nothing else can clear a disabled flag.
  const disabled = body.disabled === true;
  return {
    type,
    label,
    payload,
    targetMode,
    environmentId,
    threadId,
    steps,
    disabled,
    disabledReason: disabled ? optionalString(body.disabledReason) ?? null : null,
  };
}

export function normalizeDeviceControlItems(input, { menuItems = 8 } = {}) {
  if (!Array.isArray(input)) throw new HttpError(400, "controls must be an array.");
  const maximum = Math.max(1, Math.min(32, Number.isInteger(menuItems) ? menuItems : 8));
  if (input.length > maximum) {
    throw new HttpError(400, `This device supports at most ${maximum} controls.`);
  }
  const seen = new Set();
  return input.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, `controls[${index}] must be an object.`);
    }
    const actionId = optionalString(item.actionId);
    const systemKind = Object.entries(SYSTEM_CONTROL_IDS).find(([, id]) => id === actionId)?.[0];
    if (actionId && !systemKind) {
      const id = optionalString(item.id) ?? actionId;
      if (seen.has(id)) throw new HttpError(400, `Duplicate control id: ${id}.`);
      seen.add(id);
      return {
        id,
        kind: "action",
        actionId,
        ...(optionalString(item.label) ? { label: optionalString(item.label) } : {}),
      };
    }
    const control = systemKind ?? optionalString(item.control) ?? optionalString(item.kind);
    if (!Object.hasOwn(SYSTEM_CONTROL_IDS, control)) {
      throw new HttpError(400, `controls[${index}] requires an actionId or a supported system control.`);
    }
    const id = SYSTEM_CONTROL_IDS[control];
    if (seen.has(id)) throw new HttpError(400, `Duplicate control id: ${id}.`);
    seen.add(id);
    return {
      id,
      kind: control,
      label: optionalString(item.label) ?? systemControlLabel(control),
    };
  });
}

export function actionIntent(action, runtime = {}) {
  switch (action?.type) {
    case "prompt":
      return { type: "agent_prompt", text: action.payload.text, source: "saved_action" };
    case "shell":
      return { type: "shell_input", command: action.payload.command };
    case "media": {
      const mediaUploadId = optionalString(runtime.mediaUploadId);
      if (!mediaUploadId) throw new HttpError(400, "mediaUploadId is required for a media action.");
      return action.payload.mediaKind === "audio"
        ? { type: "audio_prompt", prompt: action.payload.prompt, mediaUploadId }
        : { type: "camera_prompt", prompt: action.payload.prompt, mediaUploadId };
    }
    default:
      throw new HttpError(400, "Macro actions resolve to their ordered steps, not a single intent.");
  }
}

export function actionControlKind(action) {
  if (action?.type !== "media") return "remote_action";
  return action.payload?.mediaKind === "audio" ? "capture_audio" : "capture_image";
}

export function hardwareSupportsAction(action, status = {}) {
  if (action?.type !== "media") return { supported: true, reason: null };
  const features = new Set(Array.isArray(status.features) ? status.features : []);
  const required = action.payload?.mediaKind === "audio" ? "microphone" : "camera";
  return features.has(required)
    ? { supported: true, reason: null }
    : { supported: false, reason: `This controller has no ${required}.` };
}

function normalizeActionPayload(type, value, legacyIntent) {
  const payload = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const intent = legacyIntent && typeof legacyIntent === "object" && !Array.isArray(legacyIntent)
    ? legacyIntent
    : {};
  if (type === "prompt") {
    return { text: requireString(payload.text ?? intent.text, "payload.text") };
  }
  if (type === "shell") {
    return { command: requireString(payload.command ?? intent.command, "payload.command") };
  }
  if (type === "media") {
    const mediaKind = optionalString(payload.mediaKind)
      ?? (intent.type === "audio_prompt" ? "audio" : intent.type === "camera_prompt" ? "image" : null);
    if (!["audio", "image"].includes(mediaKind)) {
      throw new HttpError(400, "payload.mediaKind must be audio or image.");
    }
    return {
      mediaKind,
      prompt: optionalString(payload.prompt ?? intent.prompt) ?? "Describe this media and continue the current task.",
    };
  }
  return {};
}

function normalizeMacroSteps(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "A macro requires at least one step.");
  }
  if (value.length > 32) throw new HttpError(400, "A macro supports at most 32 steps.");
  return value.map((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new HttpError(400, `steps[${index}] must be an object.`);
    }
    return {
      actionId: requireString(step.actionId, `steps[${index}].actionId`),
      continueOnFailure: step.continueOnFailure === true,
    };
  });
}

function systemControlLabel(control) {
  if (control === "status") return "Status";
  if (control === "stop") return "Stop run";
  return "Reset";
}
