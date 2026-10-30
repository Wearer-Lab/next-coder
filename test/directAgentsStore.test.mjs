import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "convex/values";
import { createFileStore } from "../src/fileStore.mjs";
import { createConvexStoreAdapter } from "../src/convexStore.mjs";
import { buildProviderCatalogue, extractHarnesses } from "../src/t3Harness.mjs";

test("direct catalogue remains selectable with honest unknown auth through file persistence and Convex arguments", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "next-coder-direct-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "store.json");
  const store = await createFileStore(path);
  const environment = store.upsertEnvironment({ userId: "owner", label: "Direct", transportMode: "connector" });
  const catalogue = buildProviderCatalogue([{ id: "claude", runtimeKind: "direct", enabled: true, installed: true, status: "ready", auth: { status: "unknown" }, models: [{ id: "default" }] }]);
  await store.updateEnvironmentCatalogue({ userId: "owner", environmentId: environment.id, catalogue }); await store.flush();
  const restored = await createFileStore(path);
  const persisted = restored.getEnvironmentForUser("owner", environment.id).providerCatalogue;
  assert.equal(persisted.instances[0].runtimeKind, "direct"); assert.equal(persisted.instances[0].auth.status, "unknown");
  assert.equal(extractHarnesses({ projects: [], threads: [] }, { catalogue: persisted })[0].available, true);
  let mutation;
  const convex = createConvexStoreAdapter({ gatewaySecret: "test-only-gateway-secret", client: { mutation: async (name, args) => { mutation = { name, args }; return {}; }, query: async () => null } });
  await convex.updateEnvironmentCatalogue({ userId: "owner", environmentId: environment.id, catalogue });
  assert.equal(mutation.args.catalogue.instances[0].runtimeKind, "direct");
  // Evaluate the actual validator expression: adding a field only to the Node projection would
  // otherwise pass these persistence tests but fail Convex's strict object validation in production.
  const source = await readFile(new URL("../convex/schema.ts", import.meta.url), "utf8");
  const start = source.indexOf("export const providerCatalogueValidator = ") + "export const providerCatalogueValidator = ".length;
  const end = source.indexOf("\n});", start) + "\n})".length;
  const validator = new Function("v", `return (${source.slice(start, end)});`)(v);
  assert.deepEqual(validator.fields.instances.element.fields.runtimeKind.json, { type: "literal", value: "direct" });
  assert.equal(validator.fields.instances.element.fields.runtimeKind.isOptional, "optional");
});
