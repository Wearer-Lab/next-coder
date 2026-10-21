# Next Coder onboarding flow

Current implementation supports the six-step workbench, host command generation, manual token
pairing, reachability verification, project/provider/model selection, first-thread proof, and the
controller/browser-only choice. The active roadmap still treats console-first handoff, LAN
discovery, polling-based pairing, and guided in-place re-pairing as unfinished Milestone 2 work.
See [roadmap/IMPLEMENTATION-STATUS.md](../roadmap/IMPLEMENTATION-STATUS.md).

## Activation goal

A user is ready when all of the following are true:

1. Clerk authentication is active.
2. A T3 Code environment is paired and reachable from Next Coder.
3. The user has chosen how that environment is exposed: local, LAN, Tailnet, or a custom URL.
4. A T3 workspace/project is visible in the live snapshot.
5. A provider instance and model have been selected.
6. A first thread has produced a completed agent reply, and the command arbiter has marked the matching gateway launch command `completed` for the selected environment, project, provider instance, and model. Dispatch acknowledgement alone is insufficient. This is the activation event because it proves the T3 connection, workspace, provider authentication, model, and reply path all work together.
7. A controller has been claimed/registered and pointed at the environment/thread, or the user has explicitly chosen browser-only operation. A development-device credential must be confirmed as saved.

Completion is derived from operational evidence plus a durable per-user setup record. It is not inferred from visiting screens.

## Flow

### 1. Welcome and readiness

- Explain the outcome in one sentence: connect T3 Code and launch the first working agent thread.
- Show the six-step path and estimated requirements.
- Require Clerk sign-in before setup state or resources can be read.
- Resume the first incomplete step for returning users.
- Allow `Exit for now`; persist the pause so the wizard does not trap the user on every load.

### 2. T3 host plan

Collect configuration that belongs on the machine running T3 Code:

- provider harness: automatic, Codex/OpenAI, Claude Code, Cursor, OpenCode, Grok, or custom;
- provider instance and model when automatic defaults are not sufficient;
- network mode: local, LAN, Tailscale, or custom URL;
- workspace path and display name.

Generate a copyable, shell-safe `npm run setup:t3 -- ...` command. Never put Clerk, gateway, T3, or provider secrets in the generated command.

The user runs the command on the T3 host. Provider login and network permission prompts stay on that trusted machine.

### 3. Pair and verify T3

Collect:

- environment label;
- reachable base URL;
- one-time pairing token or existing access token.

Next Coder creates the environment, encrypts the resulting access token, immediately runs a reachability check, and loads the live snapshot. The step completes only when the environment is reachable.

Errors stay inline and preserve entered non-secret values. Submitted credentials are cleared.

### 4. Workspace, provider, and first run

- Present projects from the live T3 snapshot.
- Default to the project’s configured provider/model when available.
- Allow the provider instance and model to be changed.
- Launch a short readiness thread in the selected project.
- Treat the returned thread ID as proof of activation.

If no project appears, return the user to the host-plan step with the workspace command intact.

### 5. Controller

Offer four explicit paths:

- use an already claimed controller;
- claim existing hardware with its claim code;
- register a development controller and reveal its secret once;
- continue browser-only.

For a claimed or registered controller, save the activated environment and thread as its defaults. The one-time secret remains visible until the user confirms it has been copied. If the browser reloads after registration, setup never creates a duplicate silently: the user must confirm the credential was already saved or deliberately register a replacement.

Browser-only is a valid deliberate choice, not an implicit skip.

### 6. Ready

Show a requirement-by-requirement summary:

- T3 reachability;
- network mode;
- workspace;
- provider/model;
- first thread;
- controller or browser-only choice.

The primary action opens Operate with the activated environment/project/thread selected. Setup remains available from Settings for later changes.

## Persistence model

The user record stores an evolvable onboarding document:

- `version`;
- `status`: `not_started`, `in_progress`, `paused`, or `completed`;
- `currentStep`;
- `networkMode` and the verified or custom `networkUrl`;
- provider `harness`, `instanceId`, and `model`;
- workspace `path`, `title`, and selected `projectId`;
- `environmentId`;
- `firstThreadId`;
- device `mode`, optional `deviceId`, and development credential confirmation;
- `startedAt`, `updatedAt`, `completedAt`, and `pausedAt`.

Server responses also include derived readiness. Resource ownership is validated before environment or device identifiers are accepted.

## Recovery and responsive behavior

- Refresh/reload resumes from persisted progress.
- An unreachable environment returns to Pair and Verify.
- Expired T3 credentials invalidate reachability without erasing workspace/provider choices.
- A removed environment or device invalidates the corresponding readiness item.
- A first-thread identifier without a matching accepted launch command for the selected environment, project, provider instance, and model does not satisfy activation.
- A controller moved to another environment/thread invalidates device readiness.
- Wide screens use a compact step rail and one task canvas.
- Narrow screens use a horizontal progress summary and one step at a time.
- All inputs retain persistent labels, errors are adjacent to the failing action, and focus moves to the step heading after navigation.

## Measurement events

Audit events provide the initial funnel:

- `user.onboarding_started`;
- `user.onboarding_updated` with the current step and status;
- `user.onboarding_paused`;
- `user.onboarding_completed`;
- the existing environment, device, and command audit events prove operational milestones.

The first successfully dispatched onboarding thread is the activation event.
