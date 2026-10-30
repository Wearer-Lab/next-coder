import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { diagnose, tailscaleStatus } from "../src/diagnostics.mjs";

test("macOS Tailscale inspection uses a bounded read-only fallback and redacts peer data", async () => {
  const calls = [];
  const status = await tailscaleStatus({
    platform: "darwin",
    exec: async (executable, args, options) => {
      calls.push({ executable, args, options });
      if (executable === "tailscale") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { HostName: "private-mac", TailscaleIPs: ["100.64.0.1"] },
          Peer: { secret: { HostName: "private-peer" } },
          User: { 1: { LoginName: "private@example.com" } },
        }),
      };
    },
  });

  assert.deepEqual(calls.map(({ executable, args }) => ({ executable, args })), [
    { executable: "tailscale", args: ["status", "--json"] },
    { executable: "/Applications/Tailscale.app/Contents/MacOS/Tailscale", args: ["status", "--json"] },
  ]);
  assert.equal(calls[1].options.timeout, 3_000);
  assert.equal(calls[1].options.maxBuffer, 256 * 1024);
  assert.equal(calls[1].options.windowsHide, true);
  assert.deepEqual(status, {
    installed: true,
    connected: true,
    state: "running",
    optional: true,
    managedByConnector: false,
    serveManagedByConnector: false,
    guidance: [],
  });
  assert.doesNotMatch(JSON.stringify(status), /private-mac|private-peer|private@example|100\.64/u);
  assert.equal(calls.some(({ args }) => args.includes("up") || args.includes("serve") || args.includes("funnel")), false);
});

test("Windows Tailscale inspection returns static operator guidance without mutating the host", async () => {
  const calls = [];
  const status = await tailscaleStatus({
    platform: "win32",
    exec: async (executable, args) => {
      calls.push({ executable, args });
      return { stdout: JSON.stringify({ BackendState: "NeedsLogin", CurrentTailnet: { Name: "private-tailnet" } }) };
    },
  });

  assert.deepEqual(calls, [{ executable: "tailscale.exe", args: ["status", "--json"] }]);
  assert.equal(status.state, "needs_login");
  assert.equal(status.optional, true);
  assert.equal(status.guidance[0].operatorRequired, true);
  assert.match(status.guidance[0].message, /yourself/u);
  assert.doesNotMatch(JSON.stringify(status), /private-tailnet/u);
});

test("doctor treats missing Tailscale as optional and exposes safe setup guidance", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-tailscale-doctor-"));
  const commands = [];
  const report = await diagnose({
    stateDir,
    state: null,
    platform: "linux",
    exec: async (executable, args) => {
      commands.push([executable, ...args]);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });

  assert.deepEqual(commands, [["tailscale", "status", "--json"]]);
  assert.equal(report.tailscale.state, "not_installed");
  assert.equal(report.tailscale.optional, true);
  assert.equal(report.tailscale.managedByConnector, false);
  assert.equal(report.tailscale.serveManagedByConnector, false);
  assert.deepEqual(report.checks.find((check) => check.id === "tailscale"), {
    id: "tailscale",
    ok: true,
    detail: "not_installed; optional and operator-managed",
  });
  assert.equal(report.healthy, false, "missing enrollment remains unhealthy even though Tailscale is optional");
});

test("malformed Tailscale JSON is reduced to a safe bounded state", async () => {
  const status = await tailscaleStatus({
    platform: "linux",
    exec: async () => ({ stdout: "not-json and not operator data" }),
  });
  assert.equal(status.installed, true);
  assert.equal(status.connected, false);
  assert.equal(status.state, "invalid_response");
  assert.equal(status.guidance[0].id, "inspect");
  assert.doesNotMatch(JSON.stringify(status), /not-json/u);
});

test("doctor reports host platform and whether T3 publishes a build, without failing overall health", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-platform-doctor-"));
  const exec = async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
  for (const [platform, arch, supported] of [["win32", "x64", true], ["linux", "arm64", true], ["darwin", "arm64", true], ["darwin", "x64", false], ["linux", "ia32", false]]) {
    const report = await diagnose({ stateDir, state: null, platform, arch, exec });
    const check = report.checks.find((entry) => entry.id === "t3_platform");
    assert.equal(check.ok, supported, `${platform}-${arch}`);
    assert.equal(check.required, false);
    assert.match(check.detail, new RegExp(`^${platform}-${arch}: `, "u"));
    assert.deepEqual(report.hostPlatform, {
      platform, arch, key: `${platform}-${arch}`, t3CliSupported: supported,
      supported: ["darwin-arm64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"],
    });
    if (!supported) {
      assert.match(check.detail, /does not publish a command-line build/u);
      assert.match(check.detail, /win32-x64/u);
      assert.match(check.detail, /--agents-file/u);
    }
  }
});

test("an unsupported platform alone does not turn an otherwise healthy direct-agent connector unhealthy", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-platform-direct-"));
  const state = { connectorId: "con_1", server: "https://cloud.example", agentConfig: { agents: [] }, lastHeartbeatAt: new Date().toISOString(), runtimeHealth: "ready" };
  const report = await diagnose({
    stateDir, state, platform: "darwin", arch: "x64",
    fetchImpl: async () => new Response("ok"),
    exec: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  });
  assert.equal(report.checks.find((check) => check.id === "t3_platform").ok, false);
  const requiredFailures = report.checks.filter((check) => check.required !== false && !check.ok && check.id !== "tailscale").map((check) => check.id);
  assert.equal(report.healthy, requiredFailures.length === 0);
  assert.equal(requiredFailures.includes("t3_platform"), false);
});

test("platform diagnostics expose only the public platform and arch identifiers", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "connector-platform-redaction-"));
  const report = await diagnose({ stateDir, state: null, platform: "win32", arch: "x64", exec: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
  const serialized = JSON.stringify({ check: report.checks.find((check) => check.id === "t3_platform"), host: report.hostPlatform });
  assert.doesNotMatch(serialized, /Users|home|\\\\|hostname|token|secret/iu);
  assert.deepEqual(Object.keys(report.hostPlatform).sort(), ["arch", "key", "platform", "supported", "t3CliSupported"]);
});
