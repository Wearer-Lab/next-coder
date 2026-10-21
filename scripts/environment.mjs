// Environment variable reads shared by the repository scripts.
//
// The product was renamed from "Agent Controller" to "Next Coder", so every operator-facing
// environment variable now starts with NEXT_CODER_. A workstation, CI runner, or shell that still
// exports the previous AGENT_CONTROLLER_ name has to keep working, so every read prefers the new
// name and falls back to the legacy one. Variables that are not part of the rename are read
// exactly as before.

const CURRENT_PREFIX = "NEXT_CODER_";
const LEGACY_PREFIX = "AGENT_CONTROLLER_";

/** The pre-rename spelling of a renamed variable, or null when the name was never renamed. */
export function legacyVariableName(name) {
  if (typeof name !== "string" || !name.startsWith(CURRENT_PREFIX)) return null;
  return LEGACY_PREFIX + name.slice(CURRENT_PREFIX.length);
}

/**
 * Read `name` from `environment`, preferring the new spelling and falling back to the legacy one.
 *
 * An unset, null, or empty new value falls back, so a workflow that expands a missing repository
 * variable to an empty string still resolves the value an operator configured under the old name.
 */
export function readEnv(environment, name) {
  const value = environment?.[name];
  if (value !== undefined && value !== null && value !== "") return value;
  const legacy = legacyVariableName(name);
  if (!legacy) return value;
  const fallback = environment?.[legacy];
  return fallback === undefined || fallback === null || fallback === "" ? value : fallback;
}
