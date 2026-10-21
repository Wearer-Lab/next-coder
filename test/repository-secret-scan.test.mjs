import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { scanText, scanTrackedPaths } from "../scripts/check-repository-secrets.mjs";

test("repository secret scan rejects live controller configs but permits examples", () => {
  assert.deepEqual(scanTrackedPaths([
    "firmware/Board/include/controller_config.example.h",
    "firmware/Board/include/controller_config.h",
    "firmware/Board/include/controller_config.old.h",
    "firmware/Board/include/controller_config.backup.h",
    "firmware/Board/include/controller_config.h.bak",
    "firmware/Board/include/controller_config.local.hpp",
  ]), [
    { path: "firmware/Board/include/controller_config.h", rule: "live-controller-config" },
    { path: "firmware/Board/include/controller_config.old.h", rule: "live-controller-config" },
    { path: "firmware/Board/include/controller_config.backup.h", rule: "live-controller-config" },
    { path: "firmware/Board/include/controller_config.h.bak", rule: "live-controller-config" },
    { path: "firmware/Board/include/controller_config.local.hpp", rule: "live-controller-config" },
  ]);
});

test("Git ignores every local controller config variant while retaining examples", async () => {
  const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^firmware\/\*\/include\/controller_config\*$/mu);
  assert.match(ignore, /^!firmware\/\*\/include\/controller_config\.example\.h$/mu);
});

test("repository secret scan blocks runtime data and private credential files", () => {
  assert.deepEqual(scanTrackedPaths([
    ".env.example",
    ".env.local",
    ".data/next-coder.json",
    "certs/device.key",
  ]), [
    { path: ".env.local", rule: "environment-file" },
    { path: ".data/next-coder.json", rule: "runtime-data" },
    { path: "certs/device.key", rule: "private-key-file" },
  ]);
});

test("repository secret scan reports signatures without retaining matched values", () => {
  // Assembled at runtime so this test file does not itself trip the tracked-file scan.
  const findings = scanText("fixture.txt", [
    ["-----BEGIN ", "PRIVATE KEY-----"].join(""),
    ["sk_", "live_", "1234567890abcdefghijkl"].join(""),
    ["ghp", "_123456789012345678901234567890"].join(""),
  ].join("\n"));
  assert.deepEqual(findings, [
    { path: "fixture.txt", rule: "private-key-material" },
    { path: "fixture.txt", rule: "stripe-live-key" },
    { path: "fixture.txt", rule: "github-token" },
  ]);
  assert.equal(JSON.stringify(findings).includes("1234567890"), false);
});
