import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";

import type { Controller } from "../controller";
import { capableT3Environment } from "../test/t3Capabilities";
import type { T3Harness, T3HarnessModel, T3ModelOption, T3SessionFailure } from "../types";
import { ConfirmProvider } from "../ui";
import { OperatePage } from "./OperatePage";

// Mirrors the real catalogue registered from a T3 host: codex and claudeAgent ready, cursor
// disabled, grok not installed.
const HARNESSES: T3Harness[] = [
  {
    instanceId: "codex",
    label: "Codex",
    version: "0.146.0",
    status: "ready",
    available: true,
    unavailableReason: null,
    models: [
      { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, options: [] },
      { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, options: [] },
    ],
  },
  {
    instanceId: "claudeAgent",
    label: "Claude",
    status: "ready",
    available: true,
    unavailableReason: null,
    models: [{ slug: "claude-fable-5", name: "Claude Fable 5", isCustom: false, options: [] }],
  },
  {
    instanceId: "grok",
    label: "Grok",
    status: "error",
    available: false,
    unavailableReason: "Not installed on the T3 host.",
    models: [],
  },
];

const FAILURE: T3SessionFailure = {
  threadId: "thread_1",
  title: "Verify Workspace and Current Branch",
  status: "stopped",
  instanceId: "codex",
  model: "gpt-5..6",
  message: "The 'gpt-5..6' model is not supported when using Codex with a ChatGPT account.",
  code: "invalid_request_error",
  updatedAt: "2026-07-24T19:27:48.334Z",
};

function controller(overrides: Record<string, unknown> = {}) {
  const selectedEnvironment = capableT3Environment({ label: "Mac T3" });
  return {
    selectedEnvironmentId: "env_1",
    selectedThreadId: "thread_1",
    selectedProjectId: "project_1",
    selectedProject: { id: "project_1", title: "Tacs", defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" } },
    selectedEnvironment,
    environments: [selectedEnvironment],
    threads: [{ id: "thread_1", label: "Thread" }],
    projects: [{ id: "project_1", title: "Tacs" }],
    harnesses: HARNESSES,
    harnessCatalogueSource: "registered",
    sessionFailures: [],
    suggestedModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
    // Every collection OperatePage iterates; a missing one throws before assertions run.
    commands: [],
    commandEvents: [],
    macros: [],
    media: [],
    pendingApprovals: [],
    recentCommands: [],
    display: { counts: {} },
    busyAction: null,
    setNotice: vi.fn(),
    setSelectedEnvironmentId: vi.fn(),
    setSelectedProjectId: vi.fn(),
    setSelectedThreadId: vi.fn(),
    api: vi.fn(),
    // The Operate view leases a live thread watch while a thread is on screen; without these the
    // page throws in an effect before a single assertion runs.
    liveThread: null,
    watchThread: vi.fn(),
    refreshAll: vi.fn(),
    loadSnapshot: vi.fn(),
    launchProject: vi.fn(),
    run: vi.fn(async (_key: string, _message: string, task: () => Promise<unknown>) => task()),
    ...overrides,
  } as unknown as Controller;
}

test("automatically loads the selected workspace without waiting for a button click", async () => {
  const loadSnapshot = vi.fn(async () => new Promise(() => {}));
  const c = controller({
    selectedThreadId: "",
    selectedProjectId: "",
    selectedProject: null,
    threads: [],
    projects: [],
    loadSnapshot,
  });

  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);

  await waitFor(() => expect(loadSnapshot).toHaveBeenCalledWith("env_1"));
  expect(loadSnapshot).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: /Load workspace/u })).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Loading workspace…");
});

test("shows a refresh action only after an automatically loaded workspace is confirmed empty", async () => {
  const loadSnapshot = vi.fn(async () => ({}));
  const c = controller({
    selectedThreadId: "",
    selectedProjectId: "",
    selectedProject: null,
    threads: [],
    projects: [],
    loadSnapshot,
  });

  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);

  expect(await screen.findByText("Workspace is empty")).toBeTruthy();
  expect(loadSnapshot).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Refresh workspace" })).toBeTruthy();
});

test("keeps the full command context available while a workspace is fetching", () => {
  render(<ConfirmProvider><OperatePage controller={controller({
    selectedThreadId: "",
    selectedProjectId: "",
    selectedProject: null,
    threads: [],
    projects: [],
    loadSnapshot: vi.fn(async () => new Promise(() => {})),
  })} /></ConfirmProvider>);

  expect(screen.getByLabelText("Environment")).toBeVisible();
  expect(screen.getByLabelText("Project")).toBeVisible();
  expect(screen.getByLabelText("Thread")).toBeVisible();
  expect(screen.getByLabelText("Agent harness")).toBeVisible();
  expect(screen.getByLabelText("Model")).toBeVisible();
});

test("changing environment immediately fetches its complete workspace", async () => {
  const c = controller({
    environments: [
      { id: "env_1", label: "Mac T3" },
      { id: "env_2", label: "Build server" },
    ],
  });
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);

  fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "env_2" } });

  expect(c.setSelectedEnvironmentId).toHaveBeenCalledWith("env_2");
  await waitFor(() => expect(c.loadSnapshot).toHaveBeenCalledWith("env_2"));
});

test("changing project selects one of that project's threads and filters the thread field", () => {
  const c = controller({
    projects: [
      { id: "project_1", title: "Tacs" },
      { id: "project_2", title: "Console" },
    ],
    threads: [
      { id: "thread_1", label: "Tacs thread", projectId: "project_1" },
      { id: "thread_2", label: "Console thread", projectId: "project_2" },
    ],
  });
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);

  expect(within(screen.getByLabelText("Thread")).queryByText("Console thread")).toBeNull();
  fireEvent.change(screen.getByLabelText("Project"), { target: { value: "project_2" } });

  expect(c.setSelectedProjectId).toHaveBeenCalledWith("project_2");
  expect(c.setSelectedThreadId).toHaveBeenCalledWith("thread_2");
});

test("the model field is a list of real models, not free text", async () => {
  render(<ConfirmProvider><OperatePage controller={controller()} /></ConfirmProvider>);

  const modelSelect = await screen.findByLabelText("Model");
  expect(modelSelect.tagName).toBe("SELECT");

  const slugs = Array.from(modelSelect.querySelectorAll("option")).map((option) => option.value);
  expect(slugs).toEqual(["gpt-5.6-sol", "gpt-5.4"]);
  // The slug that silently failed on the real environment is not offerable.
  expect(slugs).not.toContain("gpt-5..6");
});

test("the harness field lists usable harnesses and disables unavailable ones with a reason", async () => {
  render(<ConfirmProvider><OperatePage controller={controller()} /></ConfirmProvider>);

  const harnessSelect = await screen.findByLabelText("Agent harness");
  const options = Array.from(harnessSelect.querySelectorAll("option"));

  const usable = options.filter((option) => !option.disabled).map((option) => option.value);
  expect(usable).toEqual(["codex", "claudeAgent"]);

  const grok = options.find((option) => option.value === "grok");
  expect(grok?.disabled).toBe(true);
  expect(grok?.textContent).toContain("Not installed on the T3 host.");
});

test("the latest model for the project's provider is preselected", async () => {
  render(<ConfirmProvider><OperatePage controller={controller()} /></ConfirmProvider>);
  await waitFor(() => {
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("gpt-5.6-sol");
  });
});

test("an existing thread synchronizes its harness and model into the toolbar", async () => {
  render(<ConfirmProvider><OperatePage controller={controller({
    threads: [{
      id: "thread_1",
      label: "Thread",
      projectId: "project_1",
      modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5" },
    }],
  })} /></ConfirmProvider>);

  await waitFor(() => {
    expect(screen.getByLabelText("Agent harness")).toHaveValue("claudeAgent");
    expect(screen.getByLabelText("Model")).toHaveValue("claude-fable-5");
  });
});

test("changing harness starts a new thread with that harness's available model", async () => {
  const c = controller();
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);

  fireEvent.change(screen.getByLabelText("Agent harness"), { target: { value: "claudeAgent" } });

  expect(c.setSelectedThreadId).toHaveBeenCalledWith("");
  await waitFor(() => {
    expect(screen.getByLabelText("Agent harness")).toHaveValue("claudeAgent");
    expect(screen.getByLabelText("Model")).toHaveValue("claude-fable-5");
  });
});

test("a project default T3 no longer offers falls back to the resolved selection", async () => {
  const c = controller({
    selectedProject: {
      id: "project_1",
      title: "Tacs",
      defaultModelSelection: { instanceId: "codex", model: "gpt-5..6" },
    },
  });
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);

  await waitFor(() => {
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("gpt-5.6-sol");
  });
});

test("stopped sessions surface T3's provider error instead of staying silent", async () => {
  render(
    <ConfirmProvider><OperatePage controller={controller({ sessionFailures: [FAILURE] })} /></ConfirmProvider>,
  );
  expect(await screen.findByText(/not supported when using Codex/u)).toBeTruthy();
  expect(screen.getByText(/Verify Workspace and Current Branch/u)).toBeTruthy();
});

test("a failed unsupported-model session offers a safe replacement without relaunching immediately", async () => {
  const c = controller({ sessionFailures: [FAILURE] });
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);

  fireEvent.click(await screen.findByRole("button", { name: /Prepare replacement/u }));

  expect(c.setSelectedThreadId).toHaveBeenCalledWith("");
  expect(screen.getByLabelText("Command or prompt")).toHaveValue("Verify Workspace and Current Branch");
  expect(screen.getByLabelText("Model")).toHaveValue("gpt-5.6-sol");
  expect(c.launchProject).not.toHaveBeenCalled();
  expect(c.setNotice).toHaveBeenCalledWith(expect.objectContaining({
    tone: "info",
    message: expect.stringContaining("replacement is ready with codex/gpt-5.6-sol"),
  }));
});

test("a recovered launch tells the user which model was substituted", async () => {
  const c = controller({
    selectedThreadId: "",
    launchProject: vi.fn(async () => ({
      threadId: "thread_new",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      modelRecovery: {
        requested: { instanceId: "codex", model: "gpt-5..6" },
        selected: { instanceId: "codex", model: "gpt-5.6-sol" },
        reason: "Unknown model",
        catalogueSource: "registered",
      },
      command: { id: "command_new", status: "dispatched" },
    })),
  });
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);

  fireEvent.change(screen.getByLabelText("Command or prompt"), { target: { value: "Verify workspace" } });
  fireEvent.click(await screen.findByRole("button", { name: "Start new thread" }));

  await waitFor(() => expect(c.setNotice).toHaveBeenCalledWith({
    tone: "info",
    message: "codex/gpt-5..6 is unavailable. Started this thread with codex/gpt-5.6-sol instead.",
  }));
});

test("loads only the selected thread's messages and failures into the Operations feed", () => {
  const otherFailure = { ...FAILURE, threadId: "thread_2", title: "Other thread", message: "Other failure" };
  render(
    <ConfirmProvider>
      <OperatePage controller={controller({
        threads: [
          {
            id: "thread_1",
            label: "Selected thread",
            projectId: "project_1",
            messages: [
              { id: "message_1", role: "user", text: "Review the selected branch" },
              { id: "message_2", role: "assistant", text: "The selected branch is ready" },
            ],
          },
          {
            id: "thread_2",
            label: "Other thread",
            projectId: "project_1",
            messages: [{ id: "message_3", role: "user", text: "This belongs elsewhere" }],
          },
        ],
        sessionFailures: [FAILURE, otherFailure],
      })} />
    </ConfirmProvider>,
  );

  expect(screen.getByText("Review the selected branch")).toBeVisible();
  expect(screen.getByText("The selected branch is ready")).toBeVisible();
  expect(screen.queryByText("This belongs elsewhere")).toBeNull();
  expect(screen.getByText("1 failed")).toBeVisible();
  expect(screen.queryByText("Other failure")).toBeNull();
});

test("filters command activity and approvals to the selected thread", () => {
  render(
    <ConfirmProvider>
      <OperatePage controller={controller({
        recentCommands: [
          { id: "command_selected", environmentId: "env_1", threadId: "thread_1", status: "completed", intent: { type: "agent_prompt", text: "Selected command" } },
          { id: "command_other", environmentId: "env_1", threadId: "thread_2", status: "completed", intent: { type: "agent_prompt", text: "Other command" } },
        ],
        pendingApprovals: [
          { id: "approval_selected", environmentId: "env_1", threadId: "thread_1", status: "approval_required", intent: { type: "shell_input", command: "npm test" } },
          { id: "approval_other", environmentId: "env_1", threadId: "thread_2", status: "approval_required", intent: { type: "shell_input", command: "npm publish" } },
        ],
      })} />
    </ConfirmProvider>,
  );

  expect(screen.getByText("Selected command")).toBeVisible();
  expect(screen.getByText("npm test")).toBeVisible();
  expect(screen.queryByText("Other command")).toBeNull();
  expect(screen.queryByText("npm publish")).toBeNull();
});

test("renders the T3 reply instead of dispatch receipt JSON", () => {
  const command = {
    id: "command_selected",
    environmentId: "env_1",
    threadId: "thread_1",
    status: "completed",
    intent: { type: "agent_prompt", text: "Verify the current branch" },
  };
  render(
    <ConfirmProvider>
      <OperatePage controller={controller({
        recentCommands: [command],
        timelineCommand: command,
        commandEvents: [
          {
            id: "event_dispatched",
            status: "dispatched",
            result: { createThread: { sequence: 2 }, startTurn: { sequence: 4 } },
          },
          {
            id: "event_completed",
            status: "completed",
            result: { response: "The current branch is codex/render-t3-response." },
          },
        ],
      })} />
    </ConfirmProvider>,
  );

  expect(screen.getByText("Sent to T3 Code")).toBeVisible();
  expect(screen.getByText("The current branch is codex/render-t3-response.")).toBeVisible();
  expect(screen.queryByText('{"createThread":{"sequence":2},"startTurn":{"sequence":4}}')).toBeNull();
});

test("an unregistered catalogue tells the user how to register it", async () => {
  render(
    <ConfirmProvider>
      <OperatePage controller={controller({ harnessCatalogueSource: "snapshot-only" })} />
    </ConfirmProvider>,
  );
  expect(await screen.findByText(/setup:t3/u)).toBeTruthy();
});

test("starting a new thread is blocked when no model can be selected", async () => {
  const c = controller({
    selectedThreadId: "",
    harnesses: [],
    suggestedModelSelection: null,
    selectedProject: { id: "project_1", title: "Tacs" },
  });
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);

  fireEvent.change(screen.getByLabelText("Command or prompt"), { target: { value: "Start reviewing" } });
  const start = await screen.findByRole("button", { name: "Start new thread" });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(true));
});

test("sends composer messages to the selected thread instead of launching another thread", async () => {
  const c = controller();
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);

  fireEvent.change(screen.getByLabelText("Command or prompt"), { target: { value: "Review the next change" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/intents", {
    method: "POST",
    body: {
      environmentId: "env_1",
      clientRequestId: expect.stringMatching(/^web:/u),
      threadId: "thread_1",
      intent: { type: "agent_prompt", text: "Review the next change" },
    },
  }));
  expect(c.launchProject).not.toHaveBeenCalled();
  expect(c.loadSnapshot).toHaveBeenCalledWith("env_1");
});

test("creates a separate T3 thread only from explicit new-thread mode", async () => {
  const c = controller({ selectedThreadId: "" });
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);

  fireEvent.change(screen.getByLabelText("Command or prompt"), { target: { value: "Build the release checklist" } });
  const start = await screen.findByRole("button", { name: "Start new thread" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);

  await waitFor(() => expect(c.launchProject).toHaveBeenCalledWith(expect.objectContaining({
    projectId: "project_1",
    text: "Build the release checklist",
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
  })));
});

test("saves the current composer as a reusable payload-backed action", async () => {
  const c = controller({ actions: [] });
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);

  fireEvent.change(screen.getByLabelText("Command or prompt"), { target: { value: "Review this branch" } });
  fireEvent.click(screen.getByText(/Saved actions \(0\)/u));
  fireEvent.change(screen.getByLabelText("Action label"), { target: { value: "Review branch" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/actions", {
    method: "POST",
    body: expect.objectContaining({
      label: "Review branch",
      type: "prompt",
      payload: { text: "Review this branch" },
      targetMode: "fixed",
    }),
  }));
});

test("loads a saved action back into the composer for editing", async () => {
  const c = controller({
    actions: [{ id: "action_review", label: "Review branch", type: "prompt", payload: { text: "Review this branch" } }],
  });
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);

  fireEvent.click(screen.getByText(/Saved actions \(1\)/u));
  fireEvent.click(screen.getByRole("button", { name: "Edit Review branch" }));
  expect(screen.getByLabelText("Command or prompt")).toHaveValue("Review this branch");
  expect(screen.getByLabelText("Action label")).toHaveValue("Review branch");
  fireEvent.change(screen.getByLabelText("Command or prompt"), { target: { value: "Review release branch" } });
  fireEvent.click(screen.getByRole("button", { name: "Update" }));

  await waitFor(() => expect(c.api).toHaveBeenCalledWith("/v1/actions/action_review", expect.objectContaining({
    method: "PUT",
    body: expect.objectContaining({ payload: { text: "Review release branch" } }),
  })));
});

test("does not run a media action without selecting an upload", () => {
  const c = controller({
    actions: [{
      id: "action_photo",
      label: "Inspect photo",
      type: "media",
      payload: { mediaKind: "image", prompt: "Inspect this image" },
    }],
  });
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);

  fireEvent.click(screen.getByText(/Saved actions \(1\)/u));
  const guidance = screen.getByText("Choose media in Actions");
  const row = guidance.closest(".thread-tool-row");
  expect(row).not.toBeNull();
  expect(within(row as HTMLElement).getByRole("button", { name: "Run" })).toBeDisabled();
  expect(c.api).not.toHaveBeenCalledWith("/v1/actions/action_photo/run", expect.anything());
});

// Model-declared options. Ids and choices are the provider's own: Codex calls its control
// `reasoningEffort`, Claude calls it `effort`, and the console must render whichever it is handed.
const choice = (id: string, label: string, isDefault = false) => ({ id, label, isDefault });

const CODEX_REASONING: T3ModelOption = {
  id: "reasoningEffort",
  label: "Reasoning",
  type: "select",
  currentValue: null,
  choices: [
    choice("low", "Low"),
    choice("medium", "Medium", true),
    choice("high", "High"),
    choice("xhigh", "Extra high"),
    choice("max", "Max"),
    choice("ultra", "Ultra"),
  ],
};

const CLAUDE_EFFORT: T3ModelOption = {
  id: "effort",
  label: "Effort",
  type: "select",
  currentValue: "high",
  choices: [choice("low", "Low"), choice("high", "High"), choice("ultrathink", "Ultrathink")],
};

const FAST_MODE: T3ModelOption = {
  id: "fastMode",
  label: "Fast mode",
  type: "boolean",
  currentValue: false,
  choices: [],
};

const REASONING_MODEL: T3HarnessModel = {
  slug: "gpt-5.6-sol",
  name: "GPT-5.6-Sol",
  isCustom: false,
  options: [CODEX_REASONING],
};

const FAST_MODEL: T3HarnessModel = {
  slug: "gpt-5.4",
  name: "GPT-5.4",
  isCustom: false,
  options: [FAST_MODE],
};

function harnessesWithCodexModels(models: T3HarnessModel[]): T3Harness[] {
  return [{ ...HARNESSES[0], models }, HARNESSES[1], HARNESSES[2]];
}

function renderNewThread(overrides: Record<string, unknown> = {}) {
  const c = controller({ selectedThreadId: "", ...overrides });
  render(<ConfirmProvider><OperatePage controller={c} /></ConfirmProvider>);
  return c;
}

/** Launches a new thread and returns the model selection the controller was handed. */
async function launchAndReadModelSelection(c: Controller) {
  fireEvent.change(screen.getByLabelText("Command or prompt"), { target: { value: "Review the release" } });
  const start = await screen.findByRole("button", { name: "Start new thread" });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await waitFor(() => expect(c.launchProject).toHaveBeenCalled());
  const [request] = vi.mocked(c.launchProject).mock.calls[0] as unknown as [
    { modelSelection?: Record<string, unknown> },
  ];
  return request.modelSelection;
}

test("renders a model's Codex-style reasoning control with its declared choices", () => {
  renderNewThread({ harnesses: harnessesWithCodexModels([REASONING_MODEL]) });

  const reasoning = screen.getByLabelText("Reasoning");
  expect(reasoning.tagName).toBe("SELECT");
  const values = Array.from(reasoning.querySelectorAll("option")).map((option) => option.value);
  expect(values).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  // Untouched, it shows the choice the provider marked default.
  expect(reasoning).toHaveValue("medium");
});

test("renders a Claude-style effort control from its own ids, not a hardcoded provider name", async () => {
  renderNewThread({
    harnesses: [
      HARNESSES[0],
      { ...HARNESSES[1], models: [{ slug: "claude-fable-5", name: "Claude Fable 5", isCustom: false, options: [CLAUDE_EFFORT] }] },
      HARNESSES[2],
    ],
  });

  fireEvent.change(screen.getByLabelText("Agent harness"), { target: { value: "claudeAgent" } });

  const effort = await screen.findByLabelText("Effort");
  expect(effort.tagName).toBe("SELECT");
  expect(Array.from(effort.querySelectorAll("option")).map((option) => option.value))
    .toEqual(["low", "high", "ultrathink"]);
  // The provider's own current value wins over the first choice.
  expect(effort).toHaveValue("high");
  expect(screen.queryByLabelText("Reasoning")).toBeNull();
});

test("choosing a value and launching submits exactly that one option", async () => {
  const c = renderNewThread({ harnesses: harnessesWithCodexModels([REASONING_MODEL]) });

  fireEvent.change(screen.getByLabelText("Reasoning"), { target: { value: "high" } });
  const modelSelection = await launchAndReadModelSelection(c);

  expect(modelSelection).toEqual({
    instanceId: "codex",
    model: "gpt-5.6-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  });
});

test("launching without touching the option sends no options key at all", async () => {
  const c = renderNewThread({ harnesses: harnessesWithCodexModels([REASONING_MODEL]) });

  const modelSelection = await launchAndReadModelSelection(c);

  expect(modelSelection).toEqual({ instanceId: "codex", model: "gpt-5.6-sol" });
  expect(modelSelection).not.toHaveProperty("options");
});

test("switching model clears a previously chosen option so it is never carried over", async () => {
  const c = renderNewThread({ harnesses: harnessesWithCodexModels([REASONING_MODEL, FAST_MODEL]) });

  fireEvent.change(screen.getByLabelText("Reasoning"), { target: { value: "high" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-5.4" } });
  // The second model never declared a reasoning control.
  expect(screen.queryByLabelText("Reasoning")).toBeNull();
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-5.6-sol" } });

  // Back on the first model the choice is gone, not remembered: the default is shown again.
  expect(screen.getByLabelText("Reasoning")).toHaveValue("medium");
  const modelSelection = await launchAndReadModelSelection(c);
  expect(modelSelection).not.toHaveProperty("options");
});

test("a boolean option renders as a checkbox and submits a real boolean", async () => {
  const c = renderNewThread({ harnesses: harnessesWithCodexModels([FAST_MODEL]) });

  const fastMode = screen.getByRole("checkbox", { name: "Fast mode" });
  expect(fastMode).not.toBeChecked();
  fireEvent.click(fastMode);
  expect(screen.getByRole("checkbox", { name: "Fast mode" })).toBeChecked();

  const modelSelection = await launchAndReadModelSelection(c);
  const options = modelSelection?.options as Array<{ id: string; value: unknown }>;
  expect(options).toEqual([{ id: "fastMode", value: true }]);
  expect(typeof options[0].value).toBe("boolean");
});
