import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractHarnesses,
  extractSessionFailures,
  mergeHostCatalogue,
  normalizeCatalogueEntry,
  reconcileCommandStatus,
  resolveLatestModelSelection,
  resolveModelSelection,
  usableHarnesses,
  validateModelSelection,
} from "../src/t3Harness.mjs";

// Captured from a live T3 Code 0.0.28 server and revalidated against 0.0.32 on this machine:
//   t3-snapshot.json        GET /api/orchestration/snapshot
//   t3-provider-caches.json <base-dir>/caches/*.json
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SNAPSHOT = JSON.parse(readFileSync(join(FIXTURES, "t3-snapshot.json"), "utf8"));
const CATALOGUE = JSON.parse(readFileSync(join(FIXTURES, "t3-provider-caches.json"), "utf8"));

test("the live snapshot exposes only projects and threads, never a provider catalogue", () => {
  // Guards the assumption the reader is built on. If a future T3 adds a catalogue here, this
  // fails and the reader should be extended to use it.
  assert.deepEqual(
    Object.keys(SNAPSHOT).sort(),
    ["projects", "snapshotSequence", "threads", "updatedAt"],
  );
});

test("snapshot-only harnesses use project defaults but exclude historical thread models", () => {
  const harnesses = extractHarnesses(SNAPSHOT);
  assert.deepEqual(harnesses.map((harness) => harness.instanceId), ["codex"]);

  const slugs = harnesses[0].models.map((model) => model.slug).sort();
  assert.deepEqual(slugs, ["gpt-5.4"]);
});

test("the host catalogue is normalized from T3's real provider cache shape", () => {
  const normalized = CATALOGUE.map(normalizeCatalogueEntry);
  const byId = new Map(normalized.map((entry) => [entry.instanceId, entry]));

  const codex = byId.get("codex");
  assert.equal(codex.label, "Codex");
  assert.equal(codex.available, true);
  assert.equal(codex.unavailableReason, null);
  assert.deepEqual(codex.models.map((model) => model.slug), [
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
    "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.2",
  ]);
  assert.equal(codex.models[0].options[0].id, "reasoningEffort");

  const claude = byId.get("claudeAgent");
  assert.equal(claude.available, true);
  assert.equal(claude.models.length, 7);

  // Real unavailable harnesses, each with the real reason.
  assert.equal(byId.get("cursor").available, false);
  assert.equal(byId.get("cursor").unavailableReason, "Disabled in T3.");
  assert.equal(byId.get("grok").available, false);
  assert.equal(byId.get("grok").unavailableReason, "Not installed on the T3 host.");
  assert.equal(byId.get("opencode").available, false);
});

test("merging the catalogue exposes only models T3 currently offers", () => {
  const harnesses = extractHarnesses(SNAPSHOT, { catalogue: CATALOGUE });
  const codex = harnesses.find((harness) => harness.instanceId === "codex");

  assert.equal(codex.label, "Codex", "catalogue metadata wins over the bare instance id");
  assert.equal(codex.available, true);

  const slugs = codex.models.map((model) => model.slug);
  assert.ok(slugs.includes("gpt-5.6-sol"), "catalogue models are present");
  assert.ok(!slugs.includes("gpt-5..6"), "historical malformed models are not selectable");
  assert.ok(!slugs.includes("gpt-5.6"), "historical retired aliases are not selectable");

  assert.deepEqual(usableHarnesses(harnesses).map((h) => h.instanceId), ["codex", "claudeAgent"]);
});

test("the malformed model that broke these threads is rejected by validation", () => {
  const harnesses = extractHarnesses(SNAPSHOT, { catalogue: CATALOGUE });

  // This exact selection was dispatched and failed on the provider.
  const bad = validateModelSelection({ instanceId: "codex", model: "gpt-5..6" }, harnesses);
  assert.ok(bad, "gpt-5..6 must not validate");
  assert.match(bad.reason, /Unknown model "gpt-5\.\.6"/u);
  assert.ok(bad.known.includes("gpt-5.6-sol"));

  // gpt-5.6 is also not a real slug; the real ones are suffixed.
  assert.ok(validateModelSelection({ instanceId: "codex", model: "gpt-5.6" }, harnesses));

  // Real slugs pass.
  assert.equal(validateModelSelection({ instanceId: "codex", model: "gpt-5.4" }, harnesses), null);
  assert.equal(
    validateModelSelection({ instanceId: "claudeAgent", model: "claude-fable-5" }, harnesses),
    null,
  );

  // Unavailable harness is refused with its reason.
  const grok = validateModelSelection({ instanceId: "grok", model: "grok-build" }, harnesses);
  assert.equal(grok.reason, "Not installed on the T3 host.");

  const unknown = validateModelSelection({ instanceId: "nope", model: "x" }, harnesses);
  assert.match(unknown.reason, /Unknown provider instance/u);
  assert.ok(unknown.known.includes("codex"));
});

test("without a registered catalogue nothing is rejected", () => {
  // T3 provider instance ids are not restricted to built-ins, and a snapshot only shows what is
  // in use. Rejecting against it would block legitimate user-defined instances.
  const snapshotOnly = extractHarnesses(SNAPSHOT);
  assert.equal(validateModelSelection({ instanceId: "claudeAgent", model: "claude-sonnet-5" }, snapshotOnly), null);
  assert.equal(validateModelSelection({ instanceId: "anything", model: "any-model" }, snapshotOnly), null);
  // A missing half is still a client error.
  assert.ok(validateModelSelection({ instanceId: "codex" }, snapshotOnly));

  // Once a catalogue is registered the same selection is checked.
  const withCatalogue = extractHarnesses(SNAPSHOT, { catalogue: CATALOGUE });
  assert.ok(validateModelSelection({ instanceId: "anything", model: "any-model" }, withCatalogue));
});

test("session failures are surfaced with T3's own provider error text", () => {
  const failures = extractSessionFailures(SNAPSHOT);
  assert.equal(failures.length, 3, "all three threads on this environment failed");

  for (const failure of failures) {
    assert.equal(failure.status, "stopped");
    assert.equal(failure.instanceId, "codex");
    assert.equal(failure.code, "invalid_request_error");
    assert.match(failure.message, /model is not supported when using Codex with a ChatGPT account/u);
    assert.ok(failure.threadId);
  }

  assert.ok(failures.some((failure) => failure.model === "gpt-5..6"));
  assert.ok(failures.some((failure) => failure.model === "gpt-5.6"));
});

test("a healthy snapshot reports no session failures", () => {
  const healthy = {
    projects: [],
    threads: [{ id: "t1", session: { status: "running", providerInstanceId: "codex", lastError: null } }],
  };
  assert.deepEqual(extractSessionFailures(healthy), []);
  assert.deepEqual(extractSessionFailures({}), []);
  assert.deepEqual(extractSessionFailures(null), []);
});

test("selection falls back to a real usable model when the request is invalid", () => {
  const harnesses = extractHarnesses(SNAPSHOT, { catalogue: CATALOGUE });

  const resolved = resolveModelSelection({
    harnesses,
    requested: { instanceId: "codex", model: "gpt-5..6" },
    projectDefault: SNAPSHOT.projects[0].defaultModelSelection,
  });
  // The bad request and older project default are discarded in favor of the first model in T3's
  // ordered catalogue for the project's provider.
  assert.equal(resolved.instanceId, "codex");
  assert.equal(resolved.model, "gpt-5.6-sol");
  assert.deepEqual(resolved.options, [
    { id: "reasoningEffort", value: "low" },
    { id: "serviceTier", value: "default" },
  ]);

  const noHints = resolveModelSelection({ harnesses });
  assert.equal(noHints.instanceId, "codex");
  assert.equal(noHints.model, "gpt-5.6-sol");
  assert.deepEqual(noHints.options, [
    { id: "reasoningEffort", value: "low" },
    { id: "serviceTier", value: "default" },
  ]);

  const claudeLatest = resolveLatestModelSelection({
    harnesses,
    preferredInstanceId: "claudeAgent",
  });
  assert.equal(claudeLatest.instanceId, "claudeAgent");
  assert.equal(claudeLatest.model, "claude-fable-5");

  assert.equal(resolveModelSelection({ harnesses: mergeHostCatalogue([], []) }), null);
});

test("completion evidence is timed from dispatch start across a delayed acknowledgement", () => {
  const command = { status: "dispatched", createdAt: "2026-10-22T12:00:23.000Z", updatedAt: "2026-10-22T12:00:23.000Z", metrics: { completedAt: "2026-10-22T12:00:23.000Z", dispatchDurationMs: 23000 } };
  const outcome = { lastAssistantAt: "2026-10-22T12:00:22.800Z", lastAssistantText: "OK" };
  assert.equal(reconcileCommandStatus(command, outcome).status, "completed");
  assert.equal(reconcileCommandStatus(command, { ...outcome, lastAssistantAt: "2026-10-22T11:59:59.999Z" }), null);
  assert.equal(reconcileCommandStatus(command, {}), null, "an acknowledgement alone is never completion");
});

test("explicit dispatch start survives later updates of completion timestamps", () => {
  const command = { status: "dispatched", createdAt: "2026-10-22T12:00:23.000Z", metrics: { dispatchStartedAt: "2026-10-22T12:00:00.000Z", completedAt: "2026-10-22T12:01:00.000Z", dispatchDurationMs: 23000 } };
  assert.equal(reconcileCommandStatus(command, { lastAssistantAt: "2026-10-22T12:00:22.800Z", lastAssistantText: "OK" }).status, "completed");
});
