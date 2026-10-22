import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Guard tests for logic that has to exist twice.
//
// The storage layer has three implementations and the memory store is the reference, but Convex
// runs its own copy inside the deployment and cannot import the .mjs one — its tsconfig sets
// allowJs:false and only covers convex/. Every test in this suite drives createApp(), which uses
// the memory store, so a Convex-only divergence would ship unnoticed.
//
// These compare the two sources directly. Same idea as the await guard in rateLimit.test.mjs:
// cheaper than standing up a deployment, and it fails at the moment the copies drift rather than
// when a user hits the difference.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Extracts a top-level `function name(...) { ... }` body by brace matching. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() not found — did it get renamed?`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`${name}() has unbalanced braces.`);
}

/** Strips comments, TypeScript annotations, and formatting so only the logic is compared. */
function normalize(body) {
  return body
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/\/\/[^\n]*/gu, "")
    .replaceAll(/:\s*any\b/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

test("deviceActions() agrees between the memory store and the Convex function", async () => {
  const [memory, convex] = await Promise.all([
    readFile(join(ROOT, "src", "store.mjs"), "utf8"),
    readFile(join(ROOT, "convex", "gatewayStore.ts"), "utf8"),
  ]);

  const memoryBody = normalize(extractFunction(memory, "deviceActions"));
  const convexBody = normalize(extractFunction(convex, "deviceActions"));

  assert.equal(
    convexBody,
    memoryBody,
    "deviceActions() has drifted between src/store.mjs and convex/gatewayStore.ts. A client that "
      + "trusts device.actions must get the same answer from either backend, so both copies have to "
      + "state the same rules.",
  );
});

test("every action deviceActions() reports is one a store method actually guards", async () => {
  const memory = await readFile(join(ROOT, "src", "store.mjs"), "utf8");
  const body = extractFunction(memory, "deviceActions");

  // The declaration is only worth trusting if each key corresponds to a real method. A key naming
  // a method that no longer exists would advertise a capability nothing enforces.
  const declared = [...body.matchAll(/^\s*(\w+):/gmu)].map((match) => match[1]);
  assert.ok(declared.length > 0, "deviceActions() declared no actions.");

  const methods = {
    rotateSecret: "rotateDeviceSecret",
    transferReset: "resetDeviceForTransfer",
    updateConfig: "updateDeviceConfig",
    updateProfile: "updateDeviceProfile",
    revoke: "revokeDevice",
    delete: "deleteDevice",
  };
  for (const action of declared) {
    const method = methods[action];
    assert.ok(method, `deviceActions() declares "${action}" with no known store method behind it.`);
    assert.match(
      memory,
      new RegExp(`function ${method}\\(`, "u"),
      `deviceActions() declares "${action}" but ${method}() is gone.`,
    );
  }
});

/** Brace-matches a body starting at `open`, which must index a `{`. */
function matchBraces(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error("Unbalanced braces.");
}

/** Like extractFunction, but tolerates a destructured parameter list. */
function extractFunctionWithParams(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() not found — did it get renamed?`);
  let depth = 0;
  for (let index = source.indexOf("(", start); index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return matchBraces(source, source.indexOf("{", index));
    }
  }
  throw new Error(`${name}() has an unbalanced parameter list.`);
}

/** Extracts an `export const name = wrapper({ ... })` body by brace matching. */
function extractConvexHandler(source, name) {
  const start = source.indexOf(`export const ${name} = `);
  assert.notEqual(start, -1, `${name} not found in convex/gatewayStore.ts — did it get renamed?`);
  return matchBraces(source, source.indexOf("{", start));
}

test("environment archive and delete repair the same dependencies in both store implementations", async () => {
  const [memory, convex] = await Promise.all([
    readFile(join(ROOT, "src", "store.mjs"), "utf8"),
    readFile(join(ROOT, "convex", "gatewayStore.ts"), "utf8"),
  ]);

  const memoryBody = extractFunctionWithParams(memory, "disconnectEnvironmentReferences");
  const convexBody = extractFunctionWithParams(convex, "disconnectEnvironmentReferences");

  // The summary keys are the contract: an owner who removes an environment is told exactly what
  // was cleared, and a backend that repairs one fewer thing leaves an orphan behind.
  const summaryKeys = (body) => [...new Set([...body.matchAll(/removed\.(\w+)/gu)].map((match) => match[1]))].sort();
  assert.deepEqual(summaryKeys(memoryBody), ["actions", "devices", "macros", "onboarding"]);
  assert.deepEqual(
    summaryKeys(convexBody),
    summaryKeys(memoryBody),
    "disconnectEnvironmentReferences() reports a different removal summary from src/store.mjs and "
      + "convex/gatewayStore.ts. Both backends must repair — and report — the same dependencies.",
  );

  for (const [label, body] of [["memory", memoryBody], ["convex", convexBody]]) {
    assert.match(body, /ENVIRONMENT_REMOVED_REASON/u, `${label} disconnect no longer disables orphans.`);
    assert.match(body, /targetMode\s*[:=]\s*"device-current"/u, `${label} disconnect leaves a fixed action without a target.`);
    assert.match(body, /firstThreadId: null/u, `${label} disconnect no longer clears the onboarding selection.`);
  }

  for (const [label, source] of [["memory", memory], ["convex", convex]]) {
    const archiveBody = label === "convex"
      ? extractConvexHandler(source, "archiveEnvironment")
      : extractFunctionWithParams(source, "archiveEnvironment");
    assert.match(archiveBody, /disconnectEnvironmentReferences/u,
      `${label} archiveEnvironment() bypasses dependency repair.`);
    const deleteBody = label === "convex"
      ? extractConvexHandler(source, "deleteEnvironment")
      : extractFunctionWithParams(source, "deleteEnvironment");
    assert.match(deleteBody, /disconnectEnvironmentReferences/u,
      `${label} deleteEnvironment() bypasses dependency repair.`);
  }
});

test("resumeStageFor() agrees between the memory store and the Convex function", async () => {
  const [memory, convex] = await Promise.all([
    readFile(join(ROOT, "src", "store.mjs"), "utf8"),
    readFile(join(ROOT, "convex", "gatewayStore.ts"), "utf8"),
  ]);

  // Where a claimed job restarts decides whether a crashed worker re-pays for the ASR call. Two
  // backends answering differently would mean the same job costs money on one and not the other.
  assert.equal(
    normalize(extractFunction(convex, "resumeStageFor")),
    normalize(extractFunction(memory, "resumeStageFor")),
    "resumeStageFor() has drifted between src/store.mjs and convex/gatewayStore.ts.",
  );
  assert.equal(
    normalize(extractFunction(convex, "normalizeRawTranscript")),
    normalize(extractFunction(memory, "normalizeRawTranscript")),
    "normalizeRawTranscript() has drifted; the raw ASR version must be stored identically.",
  );
  // The two files spell their constants differently by house style, so fold the one name that
  // legitimately differs rather than comparing the identifier.
  const foldAttemptDefault = (body) =>
    normalize(body).replaceAll(/DEFAULT_MEDIA_JOB_MAX_ATTEMPTS|defaultMediaJobMaxAttempts/gu, "DEFAULT");
  assert.equal(
    foldAttemptDefault(extractFunction(convex, "normalizeAttemptLimit")),
    foldAttemptDefault(extractFunction(memory, "normalizeAttemptLimit")),
    "normalizeAttemptLimit() has drifted; the retry budget must be the same on both backends.",
  );
  assert.match(memory, /const DEFAULT_MEDIA_JOB_MAX_ATTEMPTS = 3;/u);
  assert.match(convex, /const defaultMediaJobMaxAttempts = 3;/u);
});

test("the auto-send decision is resolved identically on both backends", async () => {
  const [memory, convex] = await Promise.all([
    readFile(join(ROOT, "src", "store.mjs"), "utf8"),
    readFile(join(ROOT, "convex", "gatewayStore.ts"), "utf8"),
  ]);

  // Auto-send is a standing licence for a microphone to send what it hears to a coding agent. A
  // backend that derived it differently would either withhold a grant the owner can see in the
  // console, or issue one they never made.
  for (const name of ["normalizeVoiceAutoSend", "normalizeVoiceAutoSendChoice", "deviceReportsMicrophone"]) {
    assert.equal(
      normalize(extractFunction(convex, name)),
      normalize(extractFunction(memory, name)),
      `${name}() has drifted between src/store.mjs and convex/gatewayStore.ts.`,
    );
  }

  // The third state is the whole point: without it "off" cannot be told from "nobody has said",
  // and the default would switch an owner's refusal back on at the next heartbeat.
  for (const [label, source] of [["memory", memory], ["convex", convex]]) {
    assert.match(
      source,
      /ownerChoice/u,
      `${label} no longer records the owner's decision separately from the effective answer.`,
    );
  }
});

test("the media job failure causes are spelled the same way in both backends", async () => {
  const [memory, convex, transcription] = await Promise.all([
    readFile(join(ROOT, "src", "store.mjs"), "utf8"),
    readFile(join(ROOT, "convex", "gatewayStore.ts"), "utf8"),
    readFile(join(ROOT, "src", "transcription.mjs"), "utf8"),
  ]);

  const causes = (source, name) => {
    const start = source.indexOf(name);
    assert.notEqual(start, -1, `${name} not found.`);
    const open = source.indexOf("[", start);
    const close = source.indexOf("]", open);
    return [...source.slice(open, close).matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]);
  };

  // The category decides what the owner-driven retry will re-run. A backend that stored a cause the
  // other does not recognise would drop it to null and hide a requeueable job forever.
  const declared = causes(transcription, "export const TRANSCRIPTION_FAILURE_CAUSES");
  assert.deepEqual(declared, ["configuration", "input", "provider", "unknown"]);
  assert.deepEqual(causes(memory, "const MEDIA_JOB_FAILURE_CAUSES"), declared);
  assert.deepEqual(causes(convex, "const mediaJobFailureCauses"), declared);
});

test("the media job stage machine is spelled the same way in both backends", async () => {
  const [memory, convex] = await Promise.all([
    readFile(join(ROOT, "src", "store.mjs"), "utf8"),
    readFile(join(ROOT, "convex", "gatewayStore.ts"), "utf8"),
  ]);

  const stages = (source, name) => {
    const start = source.indexOf(name);
    assert.notEqual(start, -1, `${name} not found.`);
    const open = source.indexOf("[", start);
    const close = source.indexOf("]", open);
    return [...source.slice(open, close).matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]);
  };

  const memoryStages = stages(memory, "export const MEDIA_JOB_STAGES");
  assert.deepEqual(memoryStages, [
    "queued",
    "transcribing",
    "normalizing",
    "review_required",
    "ready",
    "dispatching",
    "dispatched",
    "failed",
  ]);
  assert.deepEqual(
    stages(convex, "const mediaJobStages"),
    memoryStages,
    "The media job stages have drifted between src/store.mjs and convex/gatewayStore.ts.",
  );

  // Terminal stages are what stop a restart from dispatching the same transcript twice.
  for (const [label, source] of [["memory", memory], ["convex", convex]]) {
    assert.match(
      source,
      /(MEDIA_JOB_TERMINAL_STAGES|mediaJobTerminalStages) = new Set\(\["dispatched", "failed"\]\)/u,
      `${label} no longer treats dispatched and failed as terminal.`,
    );
  }
});

test("every Convex function the adapter maps actually exists", async () => {
  const [adapter, convex] = await Promise.all([
    readFile(join(ROOT, "src", "convexStore.mjs"), "utf8"),
    readFile(join(ROOT, "convex", "gatewayStore.ts"), "utf8"),
  ]);

  // A mapping to a function that was never written fails only on the live backend, at the moment
  // a user hits it — the missing updateMediaDescription went unnoticed exactly this way.
  const mapped = [...new Set([...adapter.matchAll(/name: "gatewayStore:(\w+)"/gu)].map((match) => match[1]))];
  const exported = new Set(
    [...convex.matchAll(/export const (\w+) = gateway(?:Query|Mutation)/gu)].map((match) => match[1]),
  );
  // Was `> 40` when the table held roughly that many. It has since grown past ninety, so the
  // sentinel stopped being able to notice a table that had lost half its entries.
  assert.ok(mapped.length > 85, "the adapter's function table looks truncated.");
  assert.deepEqual(
    mapped.filter((name) => !exported.has(name)),
    [],
    "src/convexStore.mjs maps a gatewayStore function that convex/gatewayStore.ts does not export.",
  );
});

test("every store method exists on the Convex adapter", async () => {
  // CLAUDE.md's rule is that adding a store method means touching all three implementations, and
  // this is the case that rule exists for: a method present only on the memory store passes the
  // whole suite, because every test runs against memory, and then throws "not a function" the
  // first time a Convex deployment reaches it. Nothing here checked that until now — the previous
  // test only checks the reverse direction, that mapped names exist in Convex.
  const { createStore } = await import(pathToFileURL(join(ROOT, "src", "store.mjs")).href);
  const adapter = await readFile(join(ROOT, "src", "convexStore.mjs"), "utf8");

  const memoryMethods = Object.entries(createStore())
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name);

  // The adapter defines its surface as `name(...)` or `name: async (...)` or via the mapped
  // function table; a method it never names cannot be reachable.
  const missing = memoryMethods.filter((name) => !new RegExp(`\\b${name}\\b`, "u").test(adapter));

  assert.deepEqual(
    missing,
    [],
    `src/store.mjs exposes methods that src/convexStore.mjs never names, so they throw under `
      + `STORAGE_PROVIDER=convex: ${missing.join(", ")}`,
  );
});

test("the Convex media serialisers return every field written to the row", async () => {
  const convex = await readFile(join(ROOT, "convex", "gatewayStore.ts"), "utf8");
  const schema = await readFile(join(ROOT, "convex", "schema.ts"), "utf8");

  // A field a mutation writes but the serialiser drops reads back null on the live backend, which
  // is silent and has bitten this project before.
  const tableFields = (name) => {
    const start = schema.indexOf(`${name}: defineTable({`);
    assert.notEqual(start, -1, `${name} table not found.`);
    const body = matchBraces(schema, schema.indexOf("{", schema.indexOf("(", start)));
    return [...body.matchAll(/^\s{4}(\w+):/gmu)].map((match) => match[1]);
  };

  const jobBody = extractFunctionWithParams(convex, "mediaJobForGateway");
  for (const field of tableFields("mediaJobs")) {
    if (field === "userExternalId") continue;
    assert.match(jobBody, new RegExp(`\\b${field}\\b`, "u"), `mediaJobForGateway() drops ${field}.`);
  }
  assert.match(jobBody, /userId: job\.userExternalId/u);

  const mediaBody = extractFunctionWithParams(convex, "mediaForGateway");
  for (const field of tableFields("mediaUploads")) {
    if (field === "userExternalId") continue;
    assert.match(mediaBody, new RegExp(`\\b${field}\\b`, "u"), `mediaForGateway() drops ${field}.`);
  }
});

test("the two blocking-request claims are the same check-and-set on both backends", async () => {
  const [memory, convex, schema] = await Promise.all([
    readFile(join(ROOT, "src", "store.mjs"), "utf8"),
    readFile(join(ROOT, "convex", "gatewayStore.ts"), "utf8"),
    readFile(join(ROOT, "convex", "schema.ts"), "utf8"),
  ]);

  // An owner running on Convex must get the same "already answered" answer as one running on
  // memory, or a second console tab silently sends a second answer to a live provider callback.
  // Compared structurally rather than textually: the Convex handler is a Convex function wrapper
  // and cannot match the .mjs body line for line, so what is asserted is that both make the SAME
  // three decisions.
  for (const [label, body] of [
    ["memory", extractFunctionWithParams(memory, "claimProviderUserInputAnswer")],
    ["convex", extractConvexHandler(convex, "claimProviderUserInputAnswer")],
  ]) {
    // 1. A live record blocks a re-claim; a failed one does not, or a one-second T3 outage would
    //    lock the question out of reach for the rest of the session.
    assert.match(body, /status\s*!==\s*"failed"/u, `${label} claim no longer allows a retry after a failed dispatch.`);
    // 2. A different answer is a conflict, the same answer is a duplicate.
    assert.match(body, /conflict:\s*existing\.answersHash\s*!==/u, `${label} claim no longer detects a conflicting answer.`);
    // 3. The row records a fingerprint, never the answers.
    assert.match(body, /answersHash/u, `${label} claim no longer stores an answer fingerprint.`);
    // Comments stripped: the note explaining WHY the answers are absent must not read as their
    // presence.
    assert.doesNotMatch(
      normalize(body),
      /\banswers\b\s*[:,]/u,
      `${label} claim persists the answers themselves.`,
    );
  }

  // The audit row must not leak them either: this is exactly where user content would hide.
  for (const [label, source] of [["memory", memory], ["convex", convex]]) {
    const body = label === "memory"
      ? extractFunctionWithParams(memory, "claimProviderUserInputAnswer")
      : extractConvexHandler(convex, "claimProviderUserInputAnswer");
    assert.match(body, /action:\s*"provider_user_input\.claimed"/u, `${label} claim writes no audit row.`);
    assert.ok(source.length > 0);
  }

  // And the durable schema has no column that could hold them.
  const start = schema.indexOf("providerUserInputAnswers: defineTable({");
  assert.notEqual(start, -1, "the providerUserInputAnswers table is missing from convex/schema.ts.");
  const table = matchBraces(schema, schema.indexOf("{", schema.indexOf("(", start)));
  const fields = [...table.matchAll(/^\s{4}(\w+):/gmu)].map((match) => match[1]);
  assert.ok(fields.includes("answersHash"), "the table does not carry the fingerprint.");
  assert.ok(!fields.includes("answers"), "the table carries the answers, which are user content.");
});

test("command metric normalization, including dispatch start, agrees across durable stores", async () => {
  const [memory, convex] = await Promise.all([readFile(join(ROOT, "src", "store.mjs"), "utf8"), readFile(join(ROOT, "convex", "gatewayStore.ts"), "utf8")]);
  assert.equal(normalize(extractFunction(memory, "normalizeCommandMetrics")), normalize(extractFunction(convex, "normalizeCommandMetrics")));
});
