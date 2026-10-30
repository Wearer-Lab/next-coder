import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.mjs";
import { loadState } from "../src/config.mjs";

test("direct enrollment never starts or pairs T3, persists configuration and restarts without the source file", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "next-coder-direct-cli-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const agentsFile = join(stateDir, "agents.json");
  await writeFile(agentsFile, JSON.stringify({ agents: [{ id: "claude", kind: "claude" }], projects: [{ id: "project", cwd: stateDir }] }));
  const enrollmentBodies = []; let runs = 0, closes = 0;
  const deps = {
    stateDir, stdout: { write() {} }, stderr: { write() {} }, credentialStore: null,
    fetchImpl: async (url, input) => {
      assert.ok(String(url).endsWith("/v1/connectors/enroll")); enrollmentBodies.push(input.body);
      return new Response(JSON.stringify({ connector: { id: "connector" }, environment: { id: "environment" }, secret: "fixture-secret" }), { status: 201 });
    },
    ensureT3: () => assert.fail("T3 must remain optional"),
    createDirectRuntime: async () => ({ close: async () => { closes++; } }),
    prepareVoiceRuntime: async () => ({ url: "http://127.0.0.1:8977/v1/transcribe", ensureReady() {}, async close() {} }),
    Connector: class { async run() { runs++; } stop() {} },
  };
  assert.equal(await main(["connect", "--server", "https://cloud.example", "--code", "fixture-code", "--agents-file", agentsFile, "--once"], deps), 0);
  const state = await loadState(stateDir);
  assert.equal(state.t3BaseUrl, undefined); assert.equal(state.t3AccessToken, undefined); assert.equal(state.agentConfig.agents[0].kind, "claude");
  assert.equal(enrollmentBodies[0].includes(stateDir), false); assert.equal(enrollmentBodies[0].includes("runtime.direct"), true);
  await rm(agentsFile);
  assert.equal(await main(["connect", "--once"], deps), 0);
  assert.equal(runs, 2); assert.equal(closes, 2); assert.equal(enrollmentBodies.length, 1);
});
