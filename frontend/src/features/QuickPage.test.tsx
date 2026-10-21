import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import type { Controller } from "../controller";
import { capableT3Environment } from "../test/t3Capabilities";
import type { Command, MediaItem } from "../types";
import { ConfirmProvider } from "../ui";
import { QuickPage } from "./QuickPage";

const approval: Command = {
  id: "cmd_1",
  status: "approval_required",
  risk: "high",
  intent: { type: "shell_input", command: "rm -rf build" },
  createdAt: "2026-08-07T09:00:00.000Z",
};

const CLIP: MediaItem = {
  id: "media_clip",
  kind: "audio",
  contentType: "audio/webm",
  originalName: "note.webm",
};

function controller(overrides: Record<string, unknown> = {}) {
  const selectedEnvironment = capableT3Environment({
    label: "Studio Mac",
    baseUrl: "http://127.0.0.1:3773",
  });
  return {
    busyAction: null,
    selectedEnvironment,
    environments: [selectedEnvironment],
    threads: [{ id: "thread_1", label: "Next Coder", status: "running", messages: [] }],
    projects: [{ id: "project_1", label: "next-coder" }],
    actions: [],
    media: [CLIP],
    pendingApprovals: [],
    selectedEnvironmentId: "env_1",
    selectedThreadId: "thread_1",
    setNotice: vi.fn(),
    api: vi.fn(async () => ({ command: { id: "cmd_9" } })),
    refreshAll: vi.fn(),
    refreshMedia: vi.fn(),
    uploadMedia: vi.fn(async () => ({ id: "media_new", kind: "audio", contentType: "audio/webm" })),
    loadSnapshot: vi.fn(async () => ({})),
    setSelectedEnvironmentId: vi.fn(),
    setSelectedThreadId: vi.fn(),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
    ...overrides,
  } as unknown as Controller;
}

function renderDashboard(c: Controller, onNavigate = vi.fn()) {
  render(
    <ConfirmProvider>
      <QuickPage controller={c} onNavigate={onNavigate} />
    </ConfirmProvider>,
  );
  return onNavigate;
}

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

afterEach(() => {
  if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
});

/** Enough of MediaRecorder to drive one push-to-talk round trip in jsdom. */
function stubRecorder() {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) },
  });
  class FakeMediaRecorder {
    state = "inactive";
    private listeners: Record<string, Array<(event: unknown) => void>> = {};
    addEventListener(name: string, handler: (event: unknown) => void) {
      (this.listeners[name] ??= []).push(handler);
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      for (const handler of this.listeners.dataavailable ?? []) {
        handler({ data: new Blob(["clip"], { type: "audio/webm" }) });
      }
      for (const handler of this.listeners.stop ?? []) handler({});
    }
  }
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
}

function chipNames() {
  return within(screen.getByRole("list", { name: "Attachments" }))
    .getAllByRole("listitem")
    .map((chip) => chip.querySelector(".thread-attachment-chip__name")?.textContent);
}

test("offers a composer alongside workspace, attention, and saved actions", () => {
  renderDashboard(controller());

  expect(screen.getByText("Current workspace")).toBeVisible();
  expect(screen.getByText("Needs attention")).toBeVisible();
  expect(screen.getByText("Quick actions")).toBeVisible();
  // The dashboard can now send: one field, one attachment button, push-to-talk, Send. No project,
  // model or shell controls — those stay in Operations.
  expect(screen.getByLabelText("Message this thread")).toBeVisible();
  expect(screen.getByRole("button", { name: "Add attachment" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Record voice" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Shell" })).toBeNull();
  expect(screen.queryByText(/Device setup/u)).toBeNull();
});

test("keeps the composer compact so the approval queue stays on screen", () => {
  const c = controller({ pendingApprovals: [approval] });
  renderDashboard(c);

  // Two rows, not the Operate composer's nine — the attention section must not be pushed past
  // the fold on a phone.
  expect(screen.getByLabelText("Message this thread")).toHaveAttribute("rows", "2");

  const composer = document.querySelector(".dashboard-composer");
  const attention = document.querySelector(".dashboard-home__attention");
  expect(composer).not.toBeNull();
  expect(attention).not.toBeNull();
  // The composer sits in the workspace section, above attention, and never inside it.
  expect(attention?.contains(composer as Node)).toBe(false);
  expect(composer?.compareDocumentPosition(attention as Node))
    .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(within(attention as HTMLElement).getByRole("button", { name: /approve/i })).toBeEnabled();
});

test("sends a free-form prompt into the selected thread", async () => {
  const c = controller();
  renderDashboard(c);

  const textarea = screen.getByLabelText("Message this thread");
  fireEvent.change(textarea, { target: { value: "Ship the release notes" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/intents", {
    method: "POST",
    body: {
      environmentId: "env_1",
      clientRequestId: expect.stringMatching(/^web:/u),
      threadId: "thread_1",
      intent: { type: "agent_prompt", text: "Ship the release notes" },
    },
  }));
  // A sent message clears the draft rather than inviting a duplicate send.
  await waitFor(() => expect(textarea).toHaveValue(""));
});

test("attaches stored media, and removing it puts the draft back", async () => {
  const c = controller();
  renderDashboard(c);

  fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Choose from media library" }));
  fireEvent.click(screen.getByRole("button", { name: "Attach note.webm" }));

  expect(chipNames()).toEqual(["note.webm"]);
  // An attachment alone is a sendable request.
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();

  fireEvent.click(screen.getByRole("button", { name: "Remove note.webm" }));

  expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(c.api).not.toHaveBeenCalled();
});

test("push-to-talk records, attaches, and sends as an audio prompt", async () => {
  stubRecorder();
  const c = controller({
    uploadMedia: vi.fn(async () => ({ id: "media_voice", kind: "audio", contentType: "audio/webm" })),
    media: [{ id: "media_voice", kind: "audio", contentType: "audio/webm", originalName: "voice.webm" }],
  });
  renderDashboard(c);

  fireEvent.click(screen.getByRole("button", { name: "Record voice" }));
  fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
  fireEvent.click(await screen.findByRole("button", { name: "Stop recording" }));

  await waitFor(() => expect(chipNames()).toEqual(["voice.webm"]));
  expect(screen.queryByRole("dialog", { name: "Record a voice message" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/intents", {
    method: "POST",
    body: {
      environmentId: "env_1",
      clientRequestId: expect.stringMatching(/^web:/u),
      threadId: "thread_1",
      intent: { type: "audio_prompt", transcript: "", mediaUploadIds: ["media_voice"] },
    },
  }));
});

test("without a thread the composer stays inert and points at the picker on this page", () => {
  const c = controller({ selectedThreadId: "" });
  renderDashboard(c);

  expect(screen.getByRole("button", { name: "Add attachment" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Record voice" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(screen.getByText("Choose a thread above to send from here.")).toBeVisible();
});

test("environment and thread are chosen here, without a detour through Operations", () => {
  const c = controller({ selectedThreadId: "" });
  renderDashboard(c);

  // Arriving on the dashboard is enough: the selected environment's workspace is fetched here.
  expect(c.loadSnapshot).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText("Thread"), { target: { value: "thread_1" } });
  expect(c.setSelectedThreadId).toHaveBeenCalledWith("thread_1");

  fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "env_1" } });
  expect(c.setSelectedEnvironmentId).toHaveBeenCalledWith("env_1");
  expect(c.loadSnapshot).toHaveBeenCalledWith("env_1");
});

test("an environment with nothing loaded yet is fetched on arrival", async () => {
  const c = controller({ threads: [], projects: [], selectedThreadId: "" });
  renderDashboard(c);

  await waitFor(() => expect(c.loadSnapshot).toHaveBeenCalledWith("env_1"));
});

test("resumes the selected thread in Operations", () => {
  const onNavigate = renderDashboard(controller());

  expect(screen.getByRole("heading", { name: "Next Coder" })).toBeVisible();
  expect(screen.getByText("Studio Mac · 0 messages")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Open Operations/u }));

  expect(onNavigate).toHaveBeenCalledWith("operate");
});

test("routes an operator without an environment to pairing", () => {
  const onNavigate = renderDashboard(controller({
    environments: [],
    threads: [],
    projects: [],
    selectedEnvironmentId: "",
    selectedThreadId: "",
  }));

  expect(screen.getByText("Connect T3 Code to begin")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Pair an environment/u }));

  expect(onNavigate).toHaveBeenCalledWith("environments");
});

test("approves a waiting command from the attention section", async () => {
  const c = controller({ pendingApprovals: [approval] });
  renderDashboard(c);

  expect(screen.getByText("1 approval")).toBeVisible();
  expect(screen.getByText("rm -rf build")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /approve/i }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/commands/cmd_1/approve", {
    method: "POST",
    body: {},
  }));
});

test("runs a saved action against the selected thread", async () => {
  const c = controller({
    actions: [{ id: "action_1", label: "Run the test suite", type: "shell", payload: { command: "npm test" } }],
  });
  renderDashboard(c);

  fireEvent.click(screen.getByRole("button", { name: "Run Run the test suite" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/actions/action_1/run", {
    method: "POST",
    body: {
      environmentId: "env_1",
      threadId: "thread_1",
      clientRequestId: expect.stringMatching(/^web:/u),
    },
  }));
});

test("sends media actions to their dedicated flow", () => {
  renderDashboard(controller({
    actions: [{ id: "action_1", label: "Inspect photo", type: "media", payload: { mediaKind: "image" } }],
  }));

  expect(screen.getByText("Choose media from Actions")).toBeVisible();
  expect(screen.getByRole("button", { name: "Run Inspect photo" })).toBeDisabled();
});
