# Direct coding agents

The connector can run Codex, Claude Code and ACP agents without T3. T3 remains the default
integration when no direct-agent configuration is supplied. Both modes use the same outbound
authenticated connector, cloud ownership checks, gateway policy, command receipts and device APIs.
Agents run on the user's computer; the cloud never runs an agent or receives its login credentials.

This feature requires a connector build containing `--agents-file`. Source implementation and
isolated protocol tests do not mean the currently published npm package or production firmware
already contains the feature. No publication, deployment or flashing is part of this change.

## Configure a machine

Install and sign into the agents on the computer that will run them. Claude uses the packaged
Claude Agent SDK and the local Claude configuration; an optional `command` selects an installed
Claude executable. Codex uses `codex app-server` over private stdio. ACP runs a locally configured
executable with a literal argument array, without a shell. It negotiates stable ACP v1; agents
requiring only v2 are explicitly unsupported. No agent is downloaded or signed in by discovery.

Create `agents.json` on that computer:

```json
{
  "agents": [
    { "id": "codex", "kind": "codex", "label": "Codex" },
    { "id": "claude", "kind": "claude", "label": "Claude" },
    {
      "id": "gemini",
      "kind": "acp",
      "label": "Gemini CLI",
      "command": "gemini",
      "args": ["--experimental-acp"]
    }
  ],
  "projects": [
    {
      "id": "my-project",
      "title": "My project",
      "cwd": "/absolute/path/to/project",
      "defaultAgent": "codex",
      "defaultModel": "default"
    }
  ]
}
```

Use the ACP launch arguments documented by the installed agent version. For other agents, replace
the command and arguments with their ACP entry point. `models` may provide a bounded list of
explicit model IDs on Claude/ACP entries; otherwise the local agent's `default` is offered.
Codex models are read from its native catalogue. Configuring a model does not establish account
access to it. Authentication remains unknown until the native agent checks it; failed login or
model access fails the turn rather than inventing successful availability.

Only configured project folders are exposed. The config file is local input, never a remote shell
command API; do not put credentials in it. Run the repository build with:

```bash
npm install --prefix packages/connector
node packages/connector/bin/next-coder-connect.mjs connect \
  --server https://YOUR-NEXT-CODER-ORIGIN \
  --code YOUR-SINGLE-USE-CODE \
  --agents-file /absolute/path/to/agents.json
```

The dashboard's environment enrollment command also offers **Codex, Claude and ACP directly** and
a local configuration-file path. Once this connector version is published, the equivalent `npx
@wearer-haitch/connector connect ... --agents-file ...` command works outside a checkout. Add
`--install-service` to install the existing per-user service. Subsequent service starts use the
saved configuration without requiring the original file. Built-in local voice uses the existing
connector speech runtime and can send transcribed text to a direct agent.

Stop the existing managed service before changing runtime configuration. To return an enrollment
to T3 mode, connect with an explicit `--t3-url` and no `--agents-file`. Local direct conversation
history is retained, so a later return to direct mode can recover it.

## Dashboard and device

In Operate, select the folder, harness and model. Launching a new thread uses that selection.
**Use selected agent in this conversation** changes the next turn's agent without sending a prompt.
It refuses while a turn is active. Select the earlier agent to switch back.

**Saved agent sessions** lists the selected agent's saved conversations in the selected folder.
**Continue here** asks you to stop the session in its other app first, then imports its native
reference and available history. Discovery is separate from resuming and does not submit a prompt.
Imported sessions already linked to a Next Coder conversation reuse that conversation rather than
creating a second writer. Providers that cannot list/load sessions report that limitation.

On Hosyond, open Choose → Agents, select an agent/model, then choose **Use agent** or **Sessions**.
**Resume** requires explicit confirmation that the other app has stopped. The import passes through
device policy and durable request receipts; selecting its destination is a separate confirmed
write. All networking runs on the UI network worker. Other boards retain their existing prompt,
reply, stop, approval and voice behavior through the shared projection and transport; the new
discovery/selection client is shared in `GatewayBrowse`, but dedicated picker UI is currently
implemented only on Hosyond.

Gateway holds, provider permissions and structured questions remain different states and routes.
Direct permission replies are allow once, decline and cancel; no persistent permission grants are
offered. ACP agents retain their own native sandbox and permission configuration. A gateway policy
check does not create a sandbox inside a provider that does not enforce one.

## Conversation continuity and recovery

Each application conversation retains separate native session references for each configured agent.
Returning to an agent resumes that reference and supplies bounded user/assistant history it missed.
The handoff is explicit local metadata; it never copies hidden reasoning or permissions. A changed
agent executable/protocol configuration invalidates native continuity. Uncertain handoff delivery
discards that native binding before another attempt, avoiding blind duplicate context injection.
History may be shortened; the next agent is told to re-check current workspace files.
An interrupted connector restart or lost native transport/result also clears that agent's binding.
Inspect the previous native session before continuing: its work may still be running. The next
explicit request starts a fresh native session with retained conversation context rather than
resuming the session whose ownership or completion is uncertain.

This is saved-session continuation, not arbitrary live attachment to a terminal or desktop process.
It does not list ordinary ChatGPT web chats. Native histories remain with their agents when a
Next Coder conversation is removed; local removal deletes the connector's mapping and retained copy.

Private local files use restricted permissions and atomic replacement. Limits are 16 agents,
64 projects, 256 application conversations, eight active turns, 64 retained messages per conversation,
bounded retained text, 32 handoff records, 64 pending provider requests and 1,000 command receipts
for up to 24 hours. New writes fail when the 32 MiB local journal is full. A single-writer lock
refuses another connector using the same directory; a proven dead PID can be recovered, while
ambiguous ownership fails closed. A restart marks interrupted turns failed and never replays prompts.

Streams batch text deltas at 100 ms and reconnect with an authoritative snapshot. Native process
exit, refusal, missing terminal output and uncertain dispatch never count as completed agent work.
Read responses are not persisted in connector request receipts. Detailed history stays local;
dashboard and device reads receive the existing bounded conversation projections.

## Verification boundary

Isolated mock subprocesses exercise the real Codex/ACP framing and adapters; a mock SDK exercises
Claude questions and resume. These tests do not establish compatibility with a user's installed
agent version, authentication, model entitlement, machine sleep/wake or physical display behavior.
Before release, qualify each configured agent with a real prompt, permission, question where
supported, stop, disconnect/reconnect and restart, then verify dashboard and physical-device output.
