import { HttpError, requireString } from "./http.mjs";
import { normalizeMediaIntent, normalizeMediaUploadIds } from "./media.mjs";
import { normalizeModelOptionSelections } from "./t3Harness.mjs";
import {
  PROVIDER_APPROVAL_DECISIONS,
  normalizeProviderApprovalDecision,
} from "./providerApprovals.mjs";

export async function normalizeIntent(payload, context = {}) {
  const type = requireString(payload.type, "type");

  switch (type) {
    case "status":
      return { type };
    case "runtime_switch":
    case "runtime_import": {
      const runtimeId = requireString(payload.runtimeId, "runtimeId");
      const model = requireString(payload.model, "model");
      if (!/^[a-zA-Z0-9_.:-]{1,180}$/u.test(runtimeId) || model.length > 200) throw new HttpError(400, "Invalid agent selection.");
      // Per-model switches the provider itself declared — reasoning effort, service tier, fast
      // mode. Shape only here; the values are checked against the catalogue's own descriptors in
      // validateModelSelection, which is the only thing that knows what this model allows.
      const modelOptions = normalizeModelOptionSelections(payload.options);
      if (type === "runtime_switch") return { type, runtimeId, model, ...(modelOptions ? { options: modelOptions } : {}) };
      if (payload.confirmResume !== true) throw new HttpError(400, "Confirm the native session is idle before continuing it here.");
      const nativeSessionId = requireString(payload.nativeSessionId, "nativeSessionId");
      if (!/^[a-zA-Z0-9_.:-]{1,180}$/u.test(nativeSessionId)) throw new HttpError(400, "Invalid native session id.");
      return { type, runtimeId, model, ...(modelOptions ? { options: modelOptions } : {}),
        nativeSessionId, projectId: requireString(payload.projectId, "projectId"), confirmResume: true };
    }
    case "agent_prompt":
      return {
        type,
        text: requireString(payload.text, "text"),
        source: payload.source ?? "device",
      };
    case "audio_prompt":
      return normalizeMediaIntent({
        type,
        transcript: typeof payload.transcript === "string" ? payload.transcript : undefined,
        prompt: typeof payload.prompt === "string" ? payload.prompt : undefined,
        mediaUploadIds: normalizeMediaUploadIds(payload),
      }, context);
    case "camera_prompt":
      return normalizeMediaIntent({
        type,
        prompt: typeof payload.prompt === "string" ? payload.prompt : undefined,
        mediaUploadIds: normalizeMediaUploadIds(payload),
      }, context);
    case "shell_input":
      return { type, command: requireString(payload.command, "command") };
    case "terminal_input": {
      // T3 terminal ids are always chosen by the client, never allocated server-side.
      const data = requireString(payload.data, "data");
      if (data.length > 65_536) {
        throw new HttpError(400, "terminal_input data exceeds 65536 characters.");
      }
      return {
        type,
        terminalId: requireString(payload.terminalId, "terminalId"),
        data,
        ...(typeof payload.cwd === "string" && payload.cwd.trim() ? { cwd: payload.cwd.trim() } : {}),
      };
    }
    case "session_control": {
      const action = requireString(payload.action, "action");
      if (!["continue", "stop", "interrupt"].includes(action)) {
        throw new HttpError(400, "Unsupported session_control action.");
      }
      return { type, action };
    }
    // Answering a question T3 asked, not one the gateway asked. The decision set is T3's own
    // four-value `ProviderApprovalDecision` (see src/providerApprovals.mjs for the contract
    // citations); `approve`/`reject` are kept as aliases because firmware in the field posts them.
    case "approval_response": {
      const raw = requireString(payload.decision, "decision");
      const decision = normalizeProviderApprovalDecision(raw);
      if (!decision) {
        throw new HttpError(
          400,
          `approval_response decision must be one of ${PROVIDER_APPROVAL_DECISIONS.join(", ")}.`,
        );
      }
      return {
        type,
        requestId: requireString(payload.requestId, "requestId"),
        decision,
        // The pre-canonical spelling, kept only when it differs, so an audit row shows what the
        // caller actually said rather than what the gateway translated it into.
        ...(decision === raw.trim() ? {} : { requestedDecision: raw.trim() }),
      };
    }
    // Answering a QUESTION T3 asked — not a permission request, and not a gateway policy hold.
    // The answer is a value, not a verdict. See src/userInput.mjs for the contract citations.
    //
    // Only the SHAPE is checked here, because normalizeIntent() has no thread and therefore no
    // questions to check against. The semantic validation — every question answered, every choice
    // an exact option label — happens in answerUserInputRequest() before the dispatch is built.
    // Both run before anything leaves the gateway, which is the part that matters.
    case "user_input_response": {
      const answers = payload.answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
        throw new HttpError(400, "user_input_response answers must be an object keyed by question id.");
      }
      if (Object.keys(answers).length === 0) {
        throw new HttpError(400, "user_input_response answers must not be empty.");
      }
      // `string | string[]` is the intersection of what every T3 adapter accepts; the Codex-only
      // `{answers: […]}` object form is deliberately not offered, because Claude hands the record
      // to its SDK verbatim and would not understand it.
      for (const [questionId, value] of Object.entries(answers)) {
        const ok = typeof value === "string"
          || (Array.isArray(value) && value.every((entry) => typeof entry === "string"));
        if (!ok) {
          throw new HttpError(
            400,
            `user_input_response answer for ${JSON.stringify(questionId)} must be a string or an array of strings.`,
          );
        }
      }
      return {
        type,
        requestId: requireString(payload.requestId, "requestId"),
        answers,
      };
    }
    default:
      throw new HttpError(400, `Unsupported intent type: ${type}.`);
  }
}
