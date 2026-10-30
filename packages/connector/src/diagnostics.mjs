import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { arch as currentArch } from "node:os";
import { inspectStatePermissions } from "./config.mjs";
import { t3CliPlatformSupport } from "./t3Process.mjs";

const execFileAsync = promisify(execFile);
const TAILSCALE_STATUS_TIMEOUT_MS = 3_000;
const TAILSCALE_STATUS_MAX_BYTES = 256 * 1024;

export async function cloudReachability(server, { fetchImpl = globalThis.fetch, timeoutMs = 3_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL("/health", server), { signal: controller.signal });
    return { reachable: true, status: response.status };
  } catch (error) {
    return { reachable: false, error: error?.name === "AbortError" ? "timed_out" : "connection_failed" };
  } finally {
    clearTimeout(timer);
  }
}

export async function tailscaleStatus({ exec = execFileAsync, platform = process.platform } = {}) {
  for (const executable of tailscaleExecutables(platform)) {
    try {
      // This is deliberately the only Tailscale subprocess the connector owns. Status is
      // read-only; setup, login, `tailscale up`, Serve and Funnel remain operator-managed.
      const { stdout } = await exec(executable, ["status", "--json"], {
        timeout: TAILSCALE_STATUS_TIMEOUT_MS,
        maxBuffer: TAILSCALE_STATUS_MAX_BYTES,
        windowsHide: true,
      });
      let value;
      try {
        value = JSON.parse(String(stdout ?? ""));
      } catch {
        return tailscaleProjection({ installed: true, state: "invalid_response" });
      }
      return tailscaleProjection({
        installed: true,
        state: normalizeTailscaleState(value?.BackendState),
      });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      return tailscaleProjection({ installed: true, state: "unavailable" });
    }
  }
  return tailscaleProjection({ installed: false, state: "not_installed" });
}

export async function diagnose({ stateDir, state, t3, fetchImpl, exec, platform = process.platform, arch = currentArch(), credentialStore = null, ownedT3 = null } = {}) {
  const permissions = await inspectStatePermissions(stateDir);
  const checks = [
    { id: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: `Node ${process.versions.node}` },
    { id: "state", ok: Boolean(state), detail: state ? `connector ${state.connectorId}` : "not enrolled" },
    { id: "permissions", ok: permissions.secure, detail: permissions.exists ? `mode ${permissions.mode.toString(8).padStart(3, "0")}` : "no state file" },
  ];
  // Lets an owner learn before enrolling that T3 cannot run here (there is no darwin-x64 build).
  // Informational for health: a T3 someone already runs, or direct agents, work on any platform,
  // so this never fails `healthy` by itself; the t3 reachability checks remain authoritative.
  const hostPlatform = hostPlatformReport({ platform, arch });
  checks.push({
    id: "t3_platform",
    ok: hostPlatform.t3CliSupported,
    required: false,
    detail: hostPlatform.t3CliSupported
      ? `${hostPlatform.key}: T3 publishes a command-line build for this platform`
      : `${hostPlatform.key}: T3 does not publish a command-line build for this platform, so the connector cannot start T3 here (supported: ${hostPlatform.supported.join(", ")}). Run T3 elsewhere or on a supported computer, or use direct agents with --agents-file`,
  });
  if (credentialStore) checks.push({
    id: "credential_storage",
    ok: true,
    detail: credentialStore.native ? credentialStore.backend : `private-file fallback (${credentialStore.fallbackReason})`,
  });
  if (!state?.agentConfig && ownedT3?.managed) checks.push({
    id: "t3_process",
    ok: ownedT3.running && ownedT3.verified,
    detail: ownedT3.running && ownedT3.verified ? `connector-owned process verified (PID ${ownedT3.pid})` : ownedT3.status,
  });
  else checks.push({ id: "t3_process", ok: true, detail: state?.agentConfig ? "not required for direct agents" : "user-managed or not started yet" });
  if (state) {
    const cloud = await cloudReachability(state.server, { fetchImpl });
    checks.push({ id: "cloud", ok: cloud.reachable, detail: cloud.reachable ? `HTTP ${cloud.status}` : cloud.error });
    if (!state.agentConfig) { try {
      const info = await t3.environmentInfo();
      checks.push({ id: "t3", ok: true, detail: `reachable${info?.version ? ` (${info.version})` : ""}` });
    } catch (error) {
      checks.push({ id: "t3", ok: false, detail: error?.code ?? "connection_failed" });
    } }
    if (state.agentConfig) {
      checks.push({ id: "direct_agents", ok: true, detail: "Direct agent configuration is present. Authentication and native capabilities are verified when used; T3 is optional." });
      const age = Date.now() - Date.parse(state.lastHeartbeatAt ?? "");
      const fresh = Number.isFinite(age) && age >= 0 && age < 90_000 && state.runtimeHealth === "ready";
      checks.push({ id: "direct_connection", ok: fresh, detail: fresh ? "The local direct bridge recently sent an outbound heartbeat. Check dashboard health for cloud acceptance." : "No current direct-runtime heartbeat. Start the connector and check dashboard health." });
    } else if (state.t3AccessToken) {
      try { await t3.snapshot(); checks.push({ id: "t3_auth", ok: true, detail: "authenticated" }); }
      catch (error) { checks.push({ id: "t3_auth", ok: false, detail: error?.code ?? "authentication_failed" }); }
      if (typeof t3.capabilityProbe === "function") {
        try {
          const probe = await t3.capabilityProbe();
          const passed = Object.values(probe?.probes ?? {}).filter((state) => state === "passed").length;
          const failed = Object.values(probe?.probes ?? {}).filter((state) => state === "failed").length;
          checks.push({
            id: "t3_capabilities",
            ok: probe?.schema === "next-coder.t3-probe.v1" && failed === 0,
            required: false,
            detail: `${passed} read-only probes passed; adapter probe v1`,
          });
        } catch (error) {
          checks.push({ id: "t3_capabilities", ok: false, required: false, detail: error?.code ?? "capability_probe_failed" });
        }
      }
    } else checks.push({ id: "t3_auth", ok: false, detail: "access token not configured" });
  }
  const tailscale = await tailscaleStatus({ exec, platform });
  checks.push({
    id: "tailscale",
    ok: true,
    detail: `${tailscale.connected ? "connected" : tailscale.state}; optional and operator-managed`,
  });
  return {
    healthy: checks.filter((check) => check.id !== "tailscale" && check.required !== false).every((check) => check.ok),
    checks,
    tailscale,
    hostPlatform,
  };
}

// Only the two public Node identifiers; no hostname, OS build, user or home path.
function hostPlatformReport({ platform, arch }) {
  const support = t3CliPlatformSupport({ platform, arch });
  return { platform: support.platform, arch: support.arch, key: support.key, t3CliSupported: support.supported, supported: support.supportedKeys };
}

function tailscaleProjection({ installed, state }) {
  const connected = state === "running";
  const guidance = [];
  if (!installed) {
    guidance.push({
      id: "install",
      operatorRequired: true,
      message: "If this machine needs Tailnet access to T3, install Tailscale from its official distribution and sign in yourself.",
    });
  } else if (state === "needs_login" || state === "needs_machine_authorization") {
    guidance.push({
      id: "sign_in",
      operatorRequired: true,
      message: "Open Tailscale and complete sign-in or machine authorization yourself, then rerun connector doctor.",
    });
  } else if (!connected) {
    guidance.push({
      id: "inspect",
      operatorRequired: true,
      message: "Open Tailscale and restore its connection yourself if this machine needs Tailnet access to T3, then rerun connector doctor.",
    });
  }
  return {
    installed,
    connected,
    state,
    optional: true,
    managedByConnector: false,
    serveManagedByConnector: false,
    guidance,
  };
}

function normalizeTailscaleState(value) {
  switch (value) {
    case "Running": return "running";
    case "Stopped": return "stopped";
    case "NeedsLogin": return "needs_login";
    case "NeedsMachineAuth": return "needs_machine_authorization";
    case "NoState": return "no_state";
    case "Starting": return "starting";
    default: return "unknown";
  }
}

function tailscaleExecutables(platform) {
  if (platform === "darwin") return ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  if (platform === "win32") return ["tailscale.exe"];
  return ["tailscale"];
}
