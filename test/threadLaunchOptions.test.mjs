import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app.mjs";

// Real captures from a live T3 host: genuine Codex `reasoningEffort` and Claude `effort`
// descriptors, so no option id in this file is invented.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const CACHES = JSON.parse(readFileSync(join(FIXTURES, "t3-provider-caches.json"), "utf8"));
const SNAPSHOT = JSON.parse(readFileSync(join(FIXTURES, "t3-snapshot.json"), "utf8"));
const PROJECT_ID = SNAPSHOT.projects[0].id;

async function launchFixture(t, { catalogue = true } = {}) {
  const originalFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/orchestration/snapshot") return jsonResponse(SNAPSHOT, 200);
    if (path === "/api/orchestration/dispatch") {
      dispatches.push(JSON.parse(init.body));
      return jsonResponse({ sequence: dispatches.length }, 200);
    }
    return jsonResponse({ error: "not found" }, 404);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { server } = createApp({ config: { demoMode: false } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dev = await call(originalFetch, baseUrl, "/v1/users/dev", {
    method: "POST",
    body: { userId: "user_dev", email: "dev@example.local" },
  });
  assert.equal(dev.status, 201, JSON.stringify(dev.body));
  const headers = { authorization: `Bearer ${dev.body.apiToken.secret}` };
  const created = await call(originalFetch, baseUrl, "/v1/t3/environments", {
    method: "POST",
    headers,
    body: { label: "Mac T3", baseUrl: "https://mock-t3.example", accessToken: "token" },
  });
  const environmentId = created.body.environment.id;
  if (catalogue) {
    const registered = await call(originalFetch, baseUrl, `/v1/t3/environments/${environmentId}/catalogue`, {
      method: "PUT",
      headers,
      body: { instances: CACHES },
    });
    assert.equal(registered.status, 200);
  }
  return {
    dispatches,
    launch: (modelSelection, extra = {}) => call(
      originalFetch,
      baseUrl,
      `/v1/t3/environments/${environmentId}/threads`,
      { method: "POST", headers, body: { projectId: PROJECT_ID, text: "hi", modelSelection, ...extra } },
    ),
  };
}

test("launch with valid provider options forwards them to T3 under the provider's own ids", async (t) => {
  const { launch, dispatches } = await launchFixture(t);

  const codex = await launch({
    instanceId: "codex",
    model: "gpt-5.6-sol",
    options: [{ id: "reasoningEffort", value: "ultra" }, { id: "serviceTier", value: "priority" }],
  });
  assert.equal(codex.status, 202);
  assert.equal(codex.body.modelRecovery, null);
  assert.deepEqual(codex.body.modelSelection.options, [
    { id: "reasoningEffort", value: "ultra" },
    { id: "serviceTier", value: "priority" },
  ]);
  assert.deepEqual(dispatches[0].modelSelection.options, codex.body.modelSelection.options);

  // Claude names the same switch `effort`; nothing in the gateway hardcodes either.
  const claude = await launch({
    instanceId: "claudeAgent",
    model: "claude-fable-5",
    options: [{ id: "effort", value: "ultrathink" }],
  });
  assert.equal(claude.status, 202);
  assert.deepEqual(dispatches[2].modelSelection.options, [{ id: "effort", value: "ultrathink" }]);
});

test("launch refuses an option value the provider does not offer instead of substituting a default", async (t) => {
  const { launch, dispatches } = await launchFixture(t);

  // `ultrathink` is Claude's value; Codex offers `ultra`. Falling back to the default here would
  // launch a thread on a setting the owner did not choose.
  const wrongValue = await launch({
    instanceId: "codex",
    model: "gpt-5.6-sol",
    options: [{ id: "reasoningEffort", value: "ultrathink" }],
  });
  assert.equal(wrongValue.status, 422);
  assert.equal(wrongValue.body.error.details.code, "invalid_model_options");
  assert.match(wrongValue.body.error.message, /Unknown value "ultrathink"/u);
  assert.deepEqual(wrongValue.body.error.details.known, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(wrongValue.body.modelRecovery, undefined);

  const wrongId = await launch({
    instanceId: "codex",
    model: "gpt-5.6-sol",
    options: [{ id: "effort", value: "high" }],
  });
  assert.equal(wrongId.status, 422);
  assert.equal(wrongId.body.error.details.code, "invalid_model_options");
  assert.deepEqual(wrongId.body.error.details.known, ["reasoningEffort", "serviceTier"]);

  assert.equal(dispatches.length, 0, "nothing reaches T3 when an option is refused");
});

for (const catalogue of [true, false]) {
  test(`launch refuses oversized and malformed options arrays (catalogue registered: ${catalogue})`, async (t) => {
    const { launch, dispatches } = await launchFixture(t, { catalogue });
    const base = { instanceId: "codex", model: "gpt-5.6-sol" };
    const cases = {
      "too many entries": Array.from({ length: 17 }, (_, index) => ({ id: `opt${index}`, value: "x" })),
      "not an array": { id: "reasoningEffort", value: "high" },
      "entry without an id": [{ value: "high" }],
      "entry without a value": [{ id: "reasoningEffort" }],
      "oversized id": [{ id: "i".repeat(121), value: "high" }],
      "oversized value": [{ id: "reasoningEffort", value: "v".repeat(201) }],
      "one good and one bad entry": [{ id: "reasoningEffort", value: "high" }, "nonsense"],
    };
    for (const [label, options] of Object.entries(cases)) {
      const response = await launch({ ...base, options });
      assert.equal(response.status, 422, `${label} (catalogue=${catalogue})`);
      assert.equal(response.body.error.details.code, "invalid_model_options", label);
    }

    // Options with no model to apply them to cannot be honoured, so they are not dropped quietly.
    const orphan = await launch({ options: [{ id: "reasoningEffort", value: "high" }] });
    assert.equal(orphan.status, 422);
    assert.equal(orphan.body.error.details.code, "invalid_model_options");

    assert.equal(dispatches.length, 0);
  });
}

test("an empty options array is no options at all", async (t) => {
  const { launch, dispatches } = await launchFixture(t);
  const response = await launch({ instanceId: "codex", model: "gpt-5.6-sol", options: [] });
  assert.equal(response.status, 202);
  assert.equal(response.body.modelRecovery, null);
  assert.equal(dispatches[0].modelSelection.options, undefined);
});

test("without a registered catalogue well-formed options pass through unvalidated", async (t) => {
  const { launch, dispatches } = await launchFixture(t, { catalogue: false });

  // A user-defined provider instance cannot be proven wrong from snapshot-derived data, so the
  // value is forwarded; only its shape and size are bounded.
  const response = await launch({
    instanceId: "myCustomProvider",
    model: "custom-model",
    options: [{ id: "reasoningEffort", value: "turbo" }, { id: "fastMode", value: true }],
  });
  assert.equal(response.status, 202);
  assert.equal(response.body.modelRecovery, null);
  assert.deepEqual(dispatches[0].modelSelection, {
    instanceId: "myCustomProvider",
    model: "custom-model",
    options: [{ id: "reasoningEffort", value: "turbo" }, { id: "fastMode", value: true }],
  });
});

test("an unknown model slug still recovers to the latest model, and says its options were not applied", async (t) => {
  const { launch, dispatches } = await launchFixture(t);

  // No options: recovery is byte-for-byte what it was.
  const plain = await launch({ instanceId: "codex", model: "gpt-5..6" });
  assert.equal(plain.status, 202);
  assert.equal(plain.body.modelSelection.model, "gpt-5.6-sol");
  assert.deepEqual(plain.body.modelRecovery.requested, { instanceId: "codex", model: "gpt-5..6" });
  assert.equal(plain.body.modelRecovery.selected.model, "gpt-5.6-sol");
  assert.match(plain.body.modelRecovery.reason, /Unknown model "gpt-5\.\.6"/u);
  assert.equal("optionsApplied" in plain.body.modelRecovery, false);

  // With options: the slug is still recovered (not refused), and the recovery names the gap.
  const withOptions = await launch({
    instanceId: "codex",
    model: "gpt-5..6",
    options: [{ id: "reasoningEffort", value: "ultra" }],
  });
  assert.equal(withOptions.status, 202);
  assert.equal(withOptions.body.modelSelection.model, "gpt-5.6-sol");
  assert.deepEqual(withOptions.body.modelRecovery.requested.options, [{ id: "reasoningEffort", value: "ultra" }]);
  assert.equal(withOptions.body.modelRecovery.optionsApplied, false);
  assert.notDeepEqual(
    withOptions.body.modelSelection.options,
    [{ id: "reasoningEffort", value: "ultra" }],
    "the requested option must not appear as applied",
  );
  assert.equal(dispatches.length, 4);
});

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function call(fetchImpl, baseUrl, path, { method = "GET", headers = {}, body } = {}) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}
