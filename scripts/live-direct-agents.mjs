// Opt-in live qualification, never discovered by npm test. Runs real signed-in local agents.
// The loopback WebSocket router is test infrastructure, not a Cloudflare deployment substitute.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { createServer as createVite } from "vite";
import { createApp } from "../src/app.mjs";
import { createMemoryStore } from "../src/store.mjs";
import { loadConfig } from "../src/config.mjs";
import { ConnectorT3Transport, createT3TransportResolver } from "../src/t3Transport.mjs";
import { createConnectorInternalService } from "../src/connectorInternalService.mjs";
import { parseConnectorFrame, encodeConnectorFrame, CONNECTOR_TICKET_AUDIENCE } from "../src/connectorProtocol.mjs";
import { DirectAgentRuntime } from "../packages/connector/src/agents/runtime.mjs";
import { ConnectorClient } from "../packages/connector/src/connector.mjs";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize real local agent usage. This command keeps an isolated dashboard running until Ctrl-C.");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "next-coder-live-e2e-"));
const projectDir = join(root, "project"), stateDir = join(root, "state");
await mkdir(projectDir); await mkdir(stateDir, { mode: 0o700 });
await writeFile(join(projectDir, "README.md"), "Disposable live Next Coder qualification workspace. Work only in this directory.\n");
const runtime = await new DirectAgentRuntime({ stateDir, config: {
  agents: [{ id: "codex", kind: "codex", label: "Codex (live)" }, { id: "claude", kind: "claude", label: "Claude (live)", command: "claude" }],
  projects: [{ id: "qualification", title: "Live qualification", cwd: projectDir }],
} }).initialize();
const store = createMemoryStore();
const userId = "live-qualification";
const token = store.createUserToken({ userId, label: "Ephemeral loopback qualification" }).secret;
const environment = store.upsertEnvironment({ userId, label: "Live local agents", transportMode: "connector", scopes: ["orchestration:read", "orchestration:operate"] });
const enrollment = store.createConnector({ userId, environmentId: environment.id });
const device = store.createDevice({ userId, label: "API qualification controller (not physical)", profile: "next-coder" });
const internal = createConnectorInternalService({ store });
let socket, connectionId, client;
const pending = new Map(), subscriptions = new Map();
const send = (type, body) => {
  if (!socket || socket.readyState !== 1) throw new Error("Live connector is offline.");
  socket.send(encodeConnectorFrame({ protocolVersion: 1, type, connectionId, body }, { direction: "cloud" }));
};
const router = {
  async request(_environment, input, options = {}) {
    if (pending.size >= 32) throw new Error("Loopback router is at capacity.");
    const requestId = randomUUID();
    return await new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Live connector request timed out.")); }, 30000);
      pending.set(requestId, { resolve: resolveResult, reject, timer });
      try { send("request", { requestId, idempotencyKey: options.idempotencyKey ?? randomUUID(), method: input.method, payload: input.payload, deadlineAt: new Date(Date.now() + 30000).toISOString() }); }
      catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
    });
  },
  openThreadStream(_environment, input, callbacks) {
    const leaseId = randomUUID(); subscriptions.set(leaseId, callbacks);
    send("subscribe", { ...input, leaseId, expiresAt: new Date(Date.now() + 90000).toISOString() });
    return { close() { subscriptions.delete(leaseId); if (socket?.readyState === 1) send("unsubscribe", { leaseId }); } };
  },
};
const app = createApp({ store, config: loadConfig({ AUTH_PROVIDER: "dev", DEMO_MODE: "1", MEDIA_DIR: join(root, "media"), FIRMWARE_DIR: join(root, "firmware") }),
  connectorRouter: router, t3TransportResolver: createT3TransportResolver({ connector: new ConnectorT3Transport(router) }) });
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
app.server.on("upgrade", (request, transport, head) => {
  void (async () => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname !== "/v1/connectors/socket") throw new Error("Unknown upgrade.");
    const redeemed = await store.consumeConnectorTicket({ ticket: url.searchParams.get("ticket"), audience: CONNECTOR_TICKET_AUDIENCE, now: Date.now() });
    if (redeemed?.connector?.id !== enrollment.connector.id) throw new Error("Invalid connector ticket.");
    wss.handleUpgrade(request, transport, head, (ws) => {
      socket = ws;
      ws.on("message", (raw) => {
        void (async () => {
          const frame = parseConnectorFrame(raw, { direction: "connector" });
          if (frame.type === "hello" || frame.type === "heartbeat") {
            if (frame.type === "hello") {
              if (frame.body.connectorId !== enrollment.connector.id || frame.body.environmentId !== environment.id) throw new Error("Mismatched connector identity.");
              connectionId = frame.connectionId;
            } else if (frame.connectionId !== connectionId) throw new Error("Stale connection.");
            await internal.fetch(new Request("https://internal/v1/internal/connector-events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventVersion: 1, kind: `connector.${frame.type}`, environmentId: environment.id, connectorId: enrollment.connector.id, connectionId, occurredAt: Date.now(), body: frame.body }) }));
            if (frame.type === "hello") send("welcome", { serverTime: new Date().toISOString(), heartbeatIntervalMs: 20000, maxFrameBytes: 1024 * 1024, maxInFlight: 32 });
          } else if (frame.type === "response.completed" || frame.type === "response.failed") {
            const request = pending.get(frame.body.requestId); if (!request) return;
            pending.delete(frame.body.requestId); clearTimeout(request.timer);
            if (frame.type === "response.completed") request.resolve(frame.body.result);
            else request.reject(Object.assign(new Error(frame.body.detail), { code: frame.body.code, retryable: frame.body.retryable }));
          } else if (["snapshot", "event"].includes(frame.type)) {
            const callbacks = subscriptions.get(frame.body.leaseId);
            if (frame.type === "snapshot") callbacks?.onItem?.({ kind: "snapshot", snapshot: frame.body.snapshot });
            else callbacks?.onItem?.(frame.body.payload);
          }
        })().catch(() => ws.close(1008, "invalid qualification frame"));
      });
      ws.on("close", () => {
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Live connector disconnected.")); } pending.clear();
        for (const callbacks of subscriptions.values()) callbacks.onClose?.({ reason: "disconnected" }); subscriptions.clear();
      });
    });
  })().catch(() => transport.destroy());
});

// A real ephemeral platform token supplies the source dashboard's session bridge. This is only
// served on the isolated loopback test origin; no production auth/session is altered.
const entry = join(root, "entry.tsx");
await writeFile(entry, `import React from "react";
import {createRoot} from "react-dom/client";
import App from ${JSON.stringify(join(repo, "frontend/src/App.tsx"))};
import ${JSON.stringify(join(repo, "frontend/src/styles.css"))};
import ${JSON.stringify(join(repo, "frontend/src/intelligence.css"))};
const bridge={loaded:true,signedIn:true,userLabel:'Isolated live qualification',getToken:async()=> (await (await fetch('/__live/session')).json()).token,openSignIn(){},openSignUp(){},openUserProfile(){},async signOut(){}};
createRoot(document.getElementById('root')!).render(<App authConfig={{authProvider:'dev',gatewayReachable:true,demoMode:true}} clerk={bridge}/>);`);
const vite = await createVite({ configFile: join(repo, "frontend/vite.config.ts"), resolve: { dedupe: ["react", "react-dom"] }, appType: "custom", server: { middlewareMode: true, hmr: false, fs: { allow: [repo, root] } } });
const gateway = app.server.listeners("request")[0]; app.server.removeAllListeners("request");
app.server.on("request", (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (path === "/__live/session") { res.setHeader("cache-control", "no-store"); res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ token })); }
  if (path.startsWith("/v1/") || path === "/health") return gateway(req, res);
  vite.middlewares(req, res, () => {
    void vite.transformIndexHtml(req.url, `<html><head><title>Isolated live agent qualification</title></head><body><div id="root"></div><script type="module" src="/@fs/${entry}"></script></body></html>`).then((html) => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(() => { res.statusCode = 500; res.end("Qualification dashboard could not load."); });
  });
});
await new Promise((resolveListen) => app.server.listen(0, "127.0.0.1", resolveListen));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const state = { server: origin, connectorId: enrollment.connector.id, environmentId: environment.id, secret: enrollment.secret, agentConfig: runtime.config };
client = new ConnectorClient({ state, t3: runtime, logger: { log() {}, error(_message, error) { console.error("Connector:", error?.code ?? "connection_error"); } } });
void client.run();
for (let n = 0; n < 100 && !connectionId; n++) await new Promise((r) => setTimeout(r, 100));
if (!connectionId) throw new Error("Live connector failed to connect.");
await runtime.dispatch({ type: "thread.create", commandId: randomUUID(), threadId: "live-conversation", projectId: "qualification", modelSelection: { instanceId: "codex", model: "default" } });
store.updateDeviceConfig({ userId, deviceId: device.device.id, config: { environmentId: environment.id, projectId: "qualification", threadId: "live-conversation" } });
app.snapshotPoller.start(); app.threadStreams.start();
await writeFile(join(root, "access.json"), JSON.stringify({ origin, token, environmentId: environment.id, deviceId: device.device.id, deviceSecret: device.secret, projectDir }), { mode: 0o600 });
console.log(JSON.stringify({ phase: "live-qualification-ready", origin, workspace: root, physicalDevice: false, transport: "authenticated loopback WebSocket; not deployed Cloudflare" }));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  app.snapshotPoller.stop(); app.threadStreams.stop(); client.stop();
  for (const ws of wss.clients) ws.close();
  await runtime.close(); await vite.close(); app.server.closeAllConnections();
  await new Promise((r) => app.server.close(r)); wss.close();
}
process.on("SIGINT", () => { void close(); }); process.on("SIGTERM", () => { void close(); });
