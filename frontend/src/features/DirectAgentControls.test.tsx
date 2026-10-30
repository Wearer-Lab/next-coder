import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import type { Controller } from "../controller";
import { ConfirmProvider } from "../ui";
import { DirectAgentControls } from "./DirectAgentControls";

function controller(direct = true) {
  return {
    selectedEnvironmentId: "environment", selectedProjectId: "project", selectedThreadId: "thread",
    selectedEnvironment: { health: { capabilities: { runtimeKind: direct ? "direct" : undefined } } },
    busyAction: null,
    api: vi.fn(async (_path: string, input?: { method?: string }) => input?.method === "POST"
      ? { command: { status: "completed", result: { threadId: "imported" } } }
      : { sessions: [{ id: "native", title: "Existing conversation", attachment: "resume" }], nextCursor: null }),
    run: vi.fn(async (_id: string, _message: string, task: () => Promise<unknown>) => task()),
    loadSnapshot: vi.fn(), setSelectedThreadId: vi.fn(),
  } as unknown as Controller;
}

test("direct sessions require explicit resume confirmation and use durable gateway intents", async () => {
  const c = controller();
  render(<ConfirmProvider><DirectAgentControls controller={c} runtimeId="codex" model="default" /></ConfirmProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Saved agent sessions" }));
  await screen.findByText("Existing conversation");
  fireEvent.click(screen.getByRole("button", { name: "Continue here" }));
  expect(c.api).toHaveBeenCalledTimes(1);
  await screen.findByText(/Stop this session in its other terminal/);
  fireEvent.click(screen.getAllByRole("button", { name: "Continue here" }).at(-1)!);
  await waitFor(() => expect(c.setSelectedThreadId).toHaveBeenCalledWith("imported"));
  const call = vi.mocked(c.api).mock.calls.find((row) => row[0] === "/v1/intents");
  expect(call?.[1]?.body).toMatchObject({ clientRequestId: expect.any(String), intent: { type: "runtime_import", confirmResume: true, nativeSessionId: "native" } });
});

test("agent changes apply to the selected conversation without sending a new prompt", async () => {
  const c = controller();
  render(<ConfirmProvider><DirectAgentControls controller={c} runtimeId="claude" model="default" /></ConfirmProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Use selected agent in this conversation" }));
  await waitFor(() => expect(c.api).toHaveBeenCalledTimes(1));
  expect(vi.mocked(c.api).mock.calls[0][1]?.body).toMatchObject({ intent: { type: "runtime_switch", runtimeId: "claude", model: "default" } });
});

test("T3 environments keep their existing controls and discovery failures have a retry path", async () => {
  const c = controller(false);
  const view = render(<ConfirmProvider><DirectAgentControls controller={c} runtimeId="codex" model="default" /></ConfirmProvider>);
  expect(screen.queryByRole("button", { name: "Saved agent sessions" })).toBeNull();
  vi.mocked(c.api).mockRejectedValue(new Error("offline"));
  const direct = { ...c, selectedEnvironment: controller().selectedEnvironment } as Controller;
  view.rerender(<ConfirmProvider><DirectAgentControls controller={direct} runtimeId="codex" model="default" /></ConfirmProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Saved agent sessions" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not list saved sessions");
  expect(screen.getByRole("button", { name: "Saved agent sessions" })).toBeEnabled();
});
