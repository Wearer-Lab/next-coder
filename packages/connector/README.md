# Next Coder connector

`@wearer-haitch/connector` is the local, outbound bridge between T3 Code on a user's machine and
the Next Coder cloud service. It does not expose T3 to the internet and does not send the T3
access token to the cloud.

The package requires Node 22 or newer. Foreground operation and managed per-user lifecycle are
implemented for macOS, Linux, and Windows. The Windows implementation is covered by platform-mocked
tests but has not yet been exercised on a real Windows host. A manual, environment-protected npm
trusted-publishing workflow now validates and can publish an exact tagged tarball with OIDC
provenance. Version 0.1.0 was published by an npm owner bootstrap on October 23, 2026 and verified
through a fresh public-registry installation; that bootstrap does not claim OIDC provenance. See
[`docs/npm-connector-release.md`](../../docs/npm-connector-release.md).

## Connect

Create an enrollment code in the Next Coder console, then run:

```bash
npx @wearer-haitch/connector connect \
  --server https://controller.example.com \
  --code YOUR-SHORT-LIVED-CODE \
  --t3-url http://127.0.0.1:3773
```

The connector first reuses an existing loopback T3. On macOS, Linux, and Windows, if none is ready, it starts the repository's
documented `npx --yes t3 serve` command on `127.0.0.1`, waits up to 60 seconds, and creates/exchanges
a short-lived T3 pairing token locally. The owned T3 uses a private state directory, not the user's
project, and is never bound to a LAN interface. `--no-start-t3` disables launch, while `--start-t3`
makes the intent explicit. `--t3-port`, `--t3-base-dir`, and `--t3-start-timeout-ms` tune this path.
Starting through `npx` may require registry access when T3 is not already cached.

The connector supports the legacy T3 orchestration protocol and protocol 2 advertised by T3
v0.1.1. Protocol 2 uses authenticated WebSocket snapshots and dispatch, translates absolute
streaming messages into deltas, and resets from an authoritative snapshot after reconnect.
Provider approvals and user-input requests remain separate. Historical pagination is not yet
advertised for protocol 2. Live v0.1.1 Codex reply and stream checks were exercised locally;
production enrollment and physical-device checks are separate verification steps.

On Windows, the connector resolves `npx.cmd` to npm's verified JavaScript entrypoint and launches it
through the current `node.exe` with an argument array; it does not interpolate a command through
`cmd.exe`. Process identity comes from a bounded PowerShell/CIM query. The connector records the
exact executable, arguments, base directory, PID, creation identity, and command fingerprint before
claiming ownership. Stop escalates only that reverified PID tree through `taskkill.exe /PID ... /T`;
it never kills by image name. A private launch journal allows a verified process to be adopted after
an interruption and fails closed instead of spawning or killing when ownership cannot be proven.

For an independently managed or non-loopback T3, pass its URL and a local credential explicitly.
The pairing token is exchanged locally. The T3 access token remains in the private platform config
directory. The standing connector credential is placed in macOS Keychain, Linux Secret Service, or
Windows Credential Manager when that native facility is available. The adapters use exact
service/account namespaces, bounded subprocesses, argument arrays, and private stdin; the credential
never appears in a command line. Existing mode-`0600` JSON enrollment is migrated by writing and
verifying the native value before atomically removing the plaintext field.

Local state lives in a private per-user directory; `NEXT_CODER_CONFIG_DIR` overrides it. A
directory created before the rename keeps being used until a new one exists, and a credential
stored under the pre-rename native service name is still read, so an existing enrollment is never
orphaned by the rename.

Headless Linux sessions commonly have neither `secret-tool` nor a Secret Service session. When the
native facility is genuinely absent, the connector explicitly reports a `private-file` fallback and
retains the standing credential in its mode-`0600` state. This fallback is automatic so an outbound
connector remains usable on headless machines. Once an enrollment points at a native store, an
unavailable or failing store is a hard error; the connector never silently copies that credential
back into JSON. Native-operation failures during enrollment also fail closed while leaving any
pre-migration private file intact for a safe retry. Windows service installation additionally applies
an argument-safe, best-effort `icacls` restriction to the current user. To avoid putting the T3
access token in shell history, set `NEXT_CODER_T3_TOKEN` (the legacy `AGENT_CONTROLLER_T3_TOKEN` is still read) or use
`--t3-token-file PATH`.

The connector runs in the foreground and writes redacted operational logs to stdout/stderr. It
requests a short-lived socket ticket, opens an outbound WSS connection, sends health heartbeats, and
routes bounded cloud requests to local T3. Disconnects retry with capped exponential jitter.

Foreground operation remains the reference path. To install a per-user background service, add
`--install-service` to `connect`. On macOS this installs only
`~/Library/LaunchAgents/com.agent-controller.connector.plist`; on Linux it installs only the
`agent-controller-connector.service` systemd user unit. Those registration names are the ones an
already-installed service is registered under, so they keep their existing names. On Windows it registers a deterministic,
per-installation Task Scheduler task for the current interactive user, at least privilege, and starts
it immediately; it also starts at that user's logon. It does not run as `SYSTEM`, request elevation,
or persist a Windows account password. No command uses `sudo`, a system service, or process-name
matching. A pinned copy of the connector runtime lives under its private state directory.
When the connector launched T3, it records the exact PID, process-control scope, command fingerprint,
origin, and base directory. Stop and disconnect operations signal only that verified POSIX process
group or Windows PID tree; a reused user-started T3 process is never stopped.

Useful commands:

```bash
next-coder-connect status
next-coder-connect doctor
next-coder-connect rotate --code NEW-ONE-TIME-CODE --yes
next-coder-connect update --check
next-coder-connect update --apply --yes --restart-service
next-coder-connect update --apply --yes --restart-service --version 0.2.0
next-coder-connect disconnect --revoke-cloud --yes
```

`start`, `stop`, and `restart` operate only that exact user service or scheduled task. `status` and
`doctor` also distinguish a user-managed T3 process from a verified connector-owned process,
stopped ownership metadata, an interrupted launch, and PID identity mismatch. `logs --lines 100` reads the
bounded, rotated connector log and redacts known credentials. `disconnect --revoke-cloud --yes`
authenticates only as the current connector, revokes outstanding socket tickets, closes the edge
session and terminalizes its in-flight work before unloading the local service and deleting native
or file credentials. If any cloud step fails, local credentials remain available for an idempotent
retry. `disconnect --force-local --yes` is the explicit recovery escape hatch when the cloud cannot
be reached; it removes only local state and leaves cloud revocation to the operator.

When locally authenticated, `status` and `doctor` also run the versioned read-only T3 capability
probe. Diagnostics report only pass/fail counts and the adapter contract; the connector hello sends
only supported adapter method names. Project/thread identifiers, provider configuration, paths,
prompts, and response content never enter either projection. A capability-probe failure is visible
but does not replace the primary process/authentication result.

### Optional Tailscale diagnostics

Tailscale is an optional local network layer, not part of connector enrollment and not a route from
the managed cloud into the Tailnet. The common same-machine path remains connector -> loopback T3.
When T3 is elsewhere on the user's Tailnet, the operator can install, authenticate, and operate
Tailscale independently.

`status` and `doctor` make one bounded, read-only call equivalent to `tailscale status --json` (three
seconds and 256 KiB maximum). On macOS they also check the standard application CLI path; Windows
uses `tailscale.exe`. Their JSON output reduces the response to connection state and static guidance.
It never includes peer names, Tailnet names, user profiles, addresses, or raw CLI errors.

The connector never installs Tailscale, runs `tailscale up`, signs a machine in, changes Tailscale
Serve or Funnel, or treats missing Tailscale as a failed connector health check. If inspection finds
that Tailscale is missing or disconnected, the diagnostics print an explicit action for the operator
to perform outside the connector. Re-run `next-coder-connect doctor` after completing that
action. Existing Serve/Funnel configuration is neither inspected nor changed.

`rotate --code ... --yes` performs an overlap-safe rotation for an installed managed service. The
server stages a second hash for the same connector id for at most ten minutes. The active credential
continues serving while the CLI writes a private interruption journal and opens a temporary bridge
with the staged credential. Consumption of that bridge's one-use socket ticket atomically promotes
the new hash and invalidates unconsumed old-generation tickets. The bridge stays online until the
restarted managed service authenticates, so the environment always has one authoritative socket.
An interrupted command can be resumed with `rotate --yes`; a new code replaces an uncommitted staged
attempt. Runtime health/cursor writes use a separate private sidecar, so the old service cannot erase
or roll back the credential journal while handoff is in progress. Foreground-only installations are
rejected because they cannot prove a gap-free handoff.

`update --check` explicitly queries npm. `update --apply --yes` updates only an installed,
connector-owned pinned runtime, installs with package scripts disabled, and verifies the downloaded
package name, version, bin, and Node engine before replacing it. A running service is never replaced
unless `--restart-service` is also present; a stopped service remains stopped. The command never uses
global npm mutation or `sudo`. After an authorized restart, it waits up to 30 seconds for the exact
user service, local T3 metadata endpoint, verified owned-process identity when applicable, and a
fresh cloud `lastConnectedAt` observation. If restart
or health verification fails, an on-disk private transaction journal restores the verified previous
runtime and original running state. `--health-timeout-ms` changes the bounded verification window.
An interrupted transaction is conservatively rolled back before a later update proceeds.
`--version` resolves an exact published semantic version and supports an operator-authorized staged
upgrade or rollback. It does not accept tags or ranges, and the downloaded manifest still has to
match the exact package name, version, bin, and Node engine before replacement.

Every lifecycle operation verifies the local definition and manifest fingerprint. Windows operations
also export and verify the registered task's marker, executable, exact argument string, working
directory, interactive logon type, and least-privilege run level before acting. Commands call
`schtasks.exe`, PowerShell status inspection, and `icacls.exe` with argument arrays rather than
interpolating user-controlled paths into a shell command.

`disconnect --revoke-cloud --yes` uses the connector's own credential to revoke its cloud record and
close the active edge session before removing the managed service and local credentials. If that
cloud step fails, cleanup stops so the same credential can retry safely; `--force-local` is the
explicit operator escape hatch. Native credential adapters and migration are covered by
platform-mocked tests only; clean-host Keychain, Secret Service, and Credential Manager qualification
is still required before release. Mode-`0600` local state is the intentional fallback when no native
facility exists. Windows Task Scheduler, Credential Manager, T3 launch/pairing, sleep/wake, update
recovery, and PID-tree shutdown still require clean-host validation.

## Protocol and limits

The connector implements protocol v1 hello/welcome, heartbeat, accepted/completed/failed request
responses, cancellation, thread subscriptions, snapshot resets, and graceful shutdown. JSON frames
are limited to 1 MiB, in-flight cloud requests to 32, and completed idempotency decisions to 1,000
entries or 24 hours. T3 Effect RPC chunks are acknowledged, and closing a thread subscription sends
`Interrupt`. While its cloud lease remains active, an unexpected local T3 thread-stream close is
retried with bounded backoff from the last observed global cursor; a replay gap returns T3's
authoritative snapshot reset. Terminal request results attempt their atomic runtime-state write before
being emitted to cloud, so normal process restart preserves the completed-effect cache.

Local HTTP is accepted only for loopback T3 and loopback development cloud servers. Non-loopback
origins must use HTTPS/WSS with normal Node certificate validation.

## Development

```bash
npm test
npm run pack:smoke
```

The package has no runtime dependencies and no imports outside its packed files.

## Built-in local voice

`connect` prepares and maintains the local speech runtime automatically. First use downloads an
approximately 660 MB English Parakeet model, a managed Python runtime and inference dependencies
into the per-user connector state directory. The packaged connector includes its own installer and
sidecar source; no repository checkout or separately installed Python is required. Startup launches
its owned sidecar on a private loopback port. Explicit bench configuration can reuse a compatible
external service. An unhealthy runtime is repaired
on the next transcription request; failure produces an actionable voice error.

```bash
next-coder-connect voice status --json
next-coder-connect voice setup
```

`voice status` checks readiness without downloading anything. `voice setup` explicitly installs or
repairs the runtime; the next `connect` starts it. Voice processes audio locally, then returns the
transcript through the authenticated outbound connector channel. Cloud media downloads use a fixed,
connector-authenticated route, a SHA-256 checksum and a 2 MiB limit. Only one local transcription can
run at a time. Cancellation/deadline abort its fetches; transcript results are never written to the
connector's completed-request disk cache. Native T3 dispatch still uses durable idempotency receipts.

Clean-host Windows/Linux installation, model download and microphone-to-agent behavior require
qualification on those systems; mocked lifecycle tests do not establish hardware support. The
English model does not provide multilingual transcription.

The NVIDIA Parakeet TDT 0.6B v2 model and
[Istupakov ONNX conversion](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx)
are distributed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
This package uses int8 inference at model revision
`0bbb45a3365852604aef28b538a8f066f4ccaa85`; model terms are separate from its Apache-2.0 source license.
## Direct agents

`connect --agents-file /absolute/path/to/agents.json` selects native Codex, Claude and generic
ACP integration without starting T3. The configuration and conversation journal stay local.
See [direct-agent setup and limitations](../../docs/direct-agents.md) in the source repository.
For an installed npm package, consult the repository documentation at the package homepage.
