import { useEffect, useRef, useState } from "react";
import type { Controller } from "../controller";
import { durableMutationRequest, clearDurableMutationRequest } from "../requestId";
import { Button, useConfirm } from "../ui";

interface NativeSession { id: string; title: string; updatedAt: string | null; attachment: "resume" | "view" }
interface SessionPage { sessions: NativeSession[]; nextCursor: string | null; truncated?: boolean }

export function DirectAgentControls({ controller: c, runtimeId, model }: { controller: Controller; runtimeId: string; model: string }) {
  const confirm = useConfirm();
  const [page, setPage] = useState<SessionPage | null>(null);
  const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const target = `${c.selectedEnvironmentId}:${c.selectedProjectId}:${runtimeId}`;
  useEffect(() => { generation.current++; setPage(null); setError(""); setLoading(false); }, [target]);
  const direct = c.selectedEnvironment?.health?.capabilities?.runtimeKind === "direct";
  if (!direct) return null;
  const load = async (cursor?: string | null) => {
    const current = ++generation.current; setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ runtimeId, projectId: c.selectedProjectId });
      if (cursor) query.set("cursor", cursor);
      const result = await c.api<SessionPage>(`/v1/t3/environments/${encodeURIComponent(c.selectedEnvironmentId)}/sessions?${query}`);
      if (generation.current === current) setPage(result);
    } catch { if (generation.current === current) setError("Could not list saved sessions. Check the agent connection and discovery support."); }
    finally { if (generation.current === current) setLoading(false); }
  };
  const submit = async (intent: Record<string, unknown>) => {
    const current = generation.current;
    const environmentId = c.selectedEnvironmentId;
    const body = { environmentId: c.selectedEnvironmentId, threadId: c.selectedThreadId || "native-import", intent };
    const request = await durableMutationRequest({ operation: "intent", ...body });
    const result = await c.api<{ command?: { status: string; result?: { threadId?: string } } }>("/v1/intents", { method: "POST", body: { ...body, clientRequestId: request.clientRequestId } });
    if (result.command && ["completed", "approval_required", "failed", "blocked", "rejected"].includes(result.command.status)) clearDurableMutationRequest(request.storageKey);
    if (result.command?.status !== "completed") {
      await c.refreshAll();
      throw new Error(result.command?.status === "approval_required" ? "Gateway approval required. Review the pending command before continuing." : "The request is not confirmed. Check its activity before retrying.");
    }
    if (generation.current === current && result.command?.status === "completed" && result.command.result?.threadId) {
      await c.loadSnapshot(environmentId);
      if (generation.current === current) c.setSelectedThreadId(result.command.result.threadId);
    }
    return result;
  };
  const resume = async (session: NativeSession) => {
    if (!await confirm({ title: "Continue saved session?", description: "Stop this session in its other terminal or app first. Next Coder will resume its saved history; it cannot take control of an unrelated running process.", confirmLabel: "Continue here" })) return;
    await c.run("runtime-import", "Saved conversation added.", () => submit({ type: "runtime_import", runtimeId, model, projectId: c.selectedProjectId, nativeSessionId: session.id, confirmResume: true }));
  };
  return <section aria-label="Direct agent conversations">
    <p>Switching agents shares recent conversation context. Each agent keeps its own saved history.</p>
    <Button disabled={!runtimeId || !model || !c.selectedProjectId || loading} onClick={() => void load()}>Saved agent sessions</Button>
    <Button disabled={!c.selectedThreadId || !runtimeId || !model || Boolean(c.busyAction)} onClick={() => void c.run("runtime-switch", "Agent selected for the next turn.", () => submit({ type: "runtime_switch", runtimeId, model }))}>Use selected agent in this conversation</Button>
    {loading ? <p role="status">Loading saved sessions…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {page && !loading ? <>
      {page.sessions.length ? <ul>{page.sessions.map((session) => <li key={session.id}>
        <span>{session.title}</span>{" "}
        <Button disabled={session.attachment !== "resume" || Boolean(c.busyAction)} onClick={() => void resume(session)}>Continue here</Button>
      </li>)}</ul> : <p>No saved sessions found for this agent and folder.</p>}
      {page.truncated ? <p>Only the most recent sessions are shown.</p> : null}
      {page.nextCursor ? <Button onClick={() => void load(page.nextCursor)}>Next sessions</Button> : null}
    </> : null}
  </section>;
}
