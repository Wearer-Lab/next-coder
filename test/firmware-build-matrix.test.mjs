import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HARDWARE_BOARDS } from "../src/hardware.mjs";
import { stageFirmwareSources } from "../scripts/build-firmware-matrix.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIRMWARE = join(ROOT, "firmware");
const matrix = JSON.parse(await readFile(join(FIRMWARE, "build-matrix.json"), "utf8"));

function iniEnvironments(source) {
  return [...source.matchAll(/^\[env:([^\]]+)\]$/gmu)].map((match) => match[1]);
}

function iniSection(source, environment) {
  const marker = `[env:${environment}]`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${environment} is missing from platformio.ini`);
  const next = source.indexOf("\n[env:", start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

test("the firmware build matrix covers every PlatformIO environment on one pinned toolchain", async () => {
  assert.equal(matrix.schemaVersion, 1);
  assert.equal(matrix.environments.length, 15);

  const expected = new Set();
  for (const entry of matrix.environments) {
    assert.ok(!expected.has(entry.environment), `duplicate matrix environment ${entry.environment}`);
    expected.add(entry.environment);
  }

  const actual = new Set();
  for (const directory of new Set(matrix.environments.map((entry) => entry.directory))) {
    const ini = await readFile(join(FIRMWARE, directory, "platformio.ini"), "utf8");
    assert.match(ini, new RegExp(`platform = ${matrix.platform.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
    for (const environment of iniEnvironments(ini)) {
      assert.ok(!actual.has(environment), `duplicate PlatformIO environment ${environment}`);
      actual.add(environment);
    }
  }
  assert.deepEqual([...actual].sort(), [...expected].sort());
});

test("release firmware environments force verified TLS even with an insecure bench seed", async () => {
  const releases = matrix.environments.filter((entry) => entry.role === "release");
  assert.deepEqual(releases.map((entry) => entry.hardwareModel).sort(), ["e213-esp32-s3r8", "ips28-esp32-s3r8"]);
  for (const release of releases) {
    const ini = await readFile(join(FIRMWARE, release.directory, "platformio.ini"), "utf8");
    assert.match(iniSection(ini, release.environment), /-DSECURE_BUILD_TLS_VERIFY=1/u);
  }
});

test("the hardware catalogue points at the matrix environment intended for each board", () => {
  for (const board of HARDWARE_BOARDS) {
    const entry = matrix.environments.find((candidate) =>
      candidate.hardwareModel === board.id && candidate.environment === board.firmwareEnv);
    assert.ok(entry, `${board.id} points at an environment outside the firmware matrix`);
    assert.equal(`firmware/${entry.directory}`, board.firmwareDir);
    if (matrix.environments.some((candidate) => candidate.hardwareModel === board.id && candidate.role === "release")) {
      assert.equal(entry.role, "release", `${board.id} does not select its release environment`);
    }
  }
});

test("placeholder configs fail closed and the build runner excludes live configuration names", async () => {
  for (const directory of new Set(matrix.environments.map((entry) => entry.directory))) {
    const example = await readFile(join(FIRMWARE, directory, "include", "controller_config.example.h"), "utf8");
    assert.match(example, /#define INSECURE_SKIP_TLS_VERIFY 0/u);
    assert.match(example, /#define GATEWAY_TLS_ROOT_CA_PEM ""/u);
  }
  const runner = await readFile(join(ROOT, "scripts", "build-firmware-matrix.mjs"), "utf8");
  assert.match(runner, /"controller_config\.h"/u);
  assert.match(runner, /"controller_config\.old\.h"/u);
  assert.match(runner, /controller_config\.example\.h/u);
  assert.match(runner, /mkdtemp\(join\(tmpdir\(\), "next-coder-firmware-matrix-"\)\)/u);
});

test("the isolated build staging step copies placeholders instead of live board configuration", async (t) => {
  const releases = matrix.environments.filter((entry) => entry.role === "release");
  const stagedRoot = await stageFirmwareSources(releases);
  t.after(() => rm(stagedRoot, { recursive: true, force: true }));

  for (const release of releases) {
    const sourceExample = await readFile(
      join(FIRMWARE, release.directory, "include", "controller_config.example.h"),
      "utf8",
    );
    const stagedConfig = await readFile(
      join(stagedRoot, release.directory, "include", "controller_config.h"),
      "utf8",
    );
    assert.equal(stagedConfig, sourceExample);
    assert.equal(await readFile(join(stagedRoot, release.directory, "include", "controller_config.example.h"), "utf8"), sourceExample,
      "placeholder environments must retain the directly included example header");
    await assert.rejects(
      access(join(stagedRoot, release.directory, "include", "controller_config.old.h")),
      { code: "ENOENT" },
    );
    await assert.rejects(access(join(stagedRoot, release.directory, ".pio")), { code: "ENOENT" });
    await assert.rejects(access(join(stagedRoot, release.directory, "docs")), { code: "ENOENT" });
  }
});
