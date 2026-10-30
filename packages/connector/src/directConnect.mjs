import { readFile, stat } from "node:fs/promises";
import { DirectAgentRuntime, validateAgentConfig } from "./agents/runtime.mjs";
import { enrollConnector } from "./cloud.mjs";
import { saveState, saveRuntimeState, STATE_VERSION, validateHttpUrl } from "./config.mjs";
import { ConnectorClient } from "./connector.mjs";
import { installService } from "./service.mjs";
import { prepareVoiceRuntime } from "./voiceRuntime.mjs";
import { createBoundedFileLogger } from "./fileLogger.mjs";

export async function connectDirect(options, existing, dependencies) {
  const { stateDir, stdout, stderr, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, credentialStore = null } = dependencies;
  if (options.agentsFile && (await stat(options.agentsFile)).size > 256 * 1024) throw new Error("Agent configuration exceeds 256 KiB.");
  const config = validateAgentConfig(options.agentsFile ? JSON.parse(await readFile(options.agentsFile, "utf8")) : existing.agentConfig);
  let state = existing;
  if (!state || options.code) {
    if (!options.server || !options.code) throw new Error("First-time connect requires --server and --code.");
    const server = validateHttpUrl(options.server, "server", { allowHttpLoopback: true });
    const enrolled = await enrollConnector({ server, code: options.code, label: options.label, capabilities: ["runtime.direct", "runtime.sessions", "environmentInfo", "snapshot", "threadDetail", "dispatch", "callRpc", "threadStream"], fetchImpl });
    state = { version: STATE_VERSION, server, connectorId: enrolled.connectorId, environmentId: enrolled.environmentId, secret: enrolled.secret, createdAt: new Date().toISOString(), agentConfig: config };
  } else state = { ...state, agentConfig: config };
  await saveState(stateDir, state, { credentialStore });
  if (options.installService) {
    await installService({ ...dependencies, stateDir, run: dependencies.runServiceCommand });
    stdout.write("Direct-agent connector service installed and started.\n"); return 0;
  }
  const runtime = await (dependencies.createDirectRuntime?.({ config, stateDir }) ?? new DirectAgentRuntime({ config, stateDir }).initialize());
  const fileLogger = options.serviceLog ? createBoundedFileLogger(options.serviceLog, { secrets: [state.secret] }) : null;
  const logger = fileLogger ?? { log: (message) => stdout.write(`${message}\n`), error: (message) => stderr.write(`${message}\n`) };
  let voice;
  const abort = new AbortController(); let connector;
  const stop = () => { abort.abort(); connector?.stop(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    voice = await (dependencies.prepareVoiceRuntime ?? prepareVoiceRuntime)({ stateDir, fetchImpl, logger, signal: abort.signal });
    state = { ...state, voice: { enabled: true, url: voice.url } }; await saveState(stateDir, state, { credentialStore });
    const Connector = dependencies.Connector ?? ConnectorClient;
    connector = new Connector({ state, t3: runtime, fetchImpl, WebSocketImpl, logger,
      ensureLocalTranscription: (input) => voice.ensureReady(input), persistState: (nextState) => saveRuntimeState(stateDir, nextState) });
    stdout.write("Starting direct-agent connector; T3 is not required.\n");
    if (!abort.signal.aborted) await connector.run({ once: options.once });
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    connector?.stop(); state.runtimeHealth = "stopped";
    await saveRuntimeState(stateDir, state).catch(() => {});
    await runtime.close(); await voice?.close(); await fileLogger?.flush();
  }
  return 0;
}
