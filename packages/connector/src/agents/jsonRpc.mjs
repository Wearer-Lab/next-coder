import { spawn } from "node:child_process";

export function agentError(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

// LF framing, bounded buffers, literal argv and no shell. stdout is protocol data only.
export class AgentRpc {
  constructor({ command, args = [], cwd, includeJsonRpc = true, onNotification = () => {}, onRequest = async () => { throw agentError("AGENT_METHOD_UNSUPPORTED", "Client method is unsupported."); }, spawnImpl = spawn }) {
    this.pending = new Map(); this.nextId = 0; this.buffer = ""; this.closed = false;
    this.onNotification = onNotification; this.onRequest = onRequest;
    this.includeJsonRpc = includeJsonRpc;
    this.child = spawnImpl(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.read(chunk));
    // A write callback does not consume the stream's error event (for example EPIPE).
    // Native crashes must fail owned requests rather than terminate the connector.
    const streamFailed = () => this.close(agentError("AGENT_EXITED", "Agent protocol stream closed."));
    this.child.stdin.on("error", streamFailed);
    this.child.stdout.on("error", streamFailed);
    this.child.stderr.on("error", streamFailed);
    // Do not retain or forward stderr: it can contain prompts, paths and credentials.
    this.child.stderr.resume();
    this.child.on("error", () => this.fail(agentError("AGENT_UNAVAILABLE", "The configured agent could not start.")));
    this.child.on("exit", () => this.fail(agentError("AGENT_EXITED", "The local agent connection closed.")));
  }
  read(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 1024 * 1024) return this.close(agentError("AGENT_FRAME_LIMIT", "Agent frame exceeded the local limit."));
    let at;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at).replace(/\r$/u, ""); this.buffer = this.buffer.slice(at + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { this.close(agentError("AGENT_PROTOCOL_INVALID", "Agent emitted invalid protocol data.")); return; }
      if (frame.method) {
        if (frame.id != null) {
          void Promise.resolve().then(() => this.onRequest(frame.method, frame.params ?? {})).then(
            (result) => this.send({ jsonrpc: "2.0", id: frame.id, result }),
            () => this.send({ jsonrpc: "2.0", id: frame.id, error: { code: -32603, message: "Request declined or no longer available." } }),
          ).catch(() => {});
        } else {
          try { this.onNotification(frame.method, frame.params ?? {}); } catch { this.close(agentError("AGENT_PROTOCOL_INVALID", "Agent notification was incompatible.")); }
        }
      } else if (frame.id != null) {
        const pending = this.pending.get(frame.id);
        if (!pending) continue;
        this.pending.delete(frame.id); clearTimeout(pending.timer);
        if (frame.error) {
          const error = agentError("AGENT_REQUEST_REJECTED", "The agent rejected this operation.");
          if (Number.isInteger(frame.error.code)) error.rpcCode = frame.error.code;
          pending.reject(error);
        } else pending.resolve(frame.result);
      }
    }
  }
  send(frame) {
    if (this.closed || this.child.stdin.destroyed) throw agentError("AGENT_EXITED", "The agent connection is closed.");
    if (!this.includeJsonRpc) { const { jsonrpc, ...body } = frame; frame = body; }
    const data = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(data) > 1024 * 1024 || this.child.stdin.writableLength > 1024 * 1024) throw agentError("AGENT_BACKPRESSURE", "Agent input buffer is full.");
    this.child.stdin.write(data, (error) => { if (error) this.fail(agentError("AGENT_EXITED", "Agent input closed.")); });
  }
  request(method, params = {}, timeoutMs = 15_000) {
    if (this.pending.size >= 32) return Promise.reject(agentError("AGENT_BACKPRESSURE", "Too many agent requests."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(agentError("AGENT_REQUEST_UNCERTAIN", "Agent request timed out; inspect the session before retrying.")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params = {}) { this.send({ jsonrpc: "2.0", method, params }); }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.onExit?.(error);
  }
  close(error = agentError("AGENT_EXITED", "Agent connection closed.")) {
    this.fail(error);
    // Only the exact subprocess created here is owned by this transport.
    this.child.kill();
  }
}
