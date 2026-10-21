# Staging qualification

This runbook produces a redacted, machine-readable check of a deployed Next Coder origin. It
does not deploy anything, provision resources, create credentials, or infer that local tests are
hosted proof. An operator must run it after an explicitly authorized staging deployment.

For the repository's manual, environment-protected deployment order, race checks, named credential
contract, evidence artifact, and explicit rollback procedure, first follow
[Protected staging release and rollback](staging-release.md). The release workflow automatically
runs the credential-free mode below; authenticated and mutating modes remain separate operator
evidence.

The command has three progressively stronger modes. It performs no network request when the target
origin is missing or invalid, requires HTTPS for non-loopback targets, refuses redirects, bounds
every response and timeout, and exits nonzero if any requested check fails or is skipped.

## 1. Credential-free cloud boundary

Run this first:

```bash
npm run qualify:staging -- --base-url 'https://staging.example.com' \
  > staging-boundary-evidence.json
```

This mode verifies that:

- `/health` identifies the staging Cloudflare Worker and reports the private control-plane binding,
  connector event sink, background Queue, quarantine Queue, and Queue-owned scheduling as ready;
- the public, non-credentialed `/v1/auth/config` request traverses the Service Binding and Container,
  reports cloud mode, and confirms development-token issuance is disabled;
- the three `/v1/internal/*` Container capabilities return exactly `404` at the public origin;
- the local connector-router HTTP bridge and development ticket issuer also return exactly `404`.

The probes use inert bodies and no credential. A `401`, `403`, redirect, timeout, invalid body, or
any success response is a failed boundary check rather than being interpreted optimistically.

## 2. Authenticated connector-first readiness

Use a dedicated staging user and connector-backed environment. Put the short-lived platform session
token in an environment variable so it does not enter shell history or the process argument list:

```bash
export NEXT_CODER_STAGING_ACCESS_TOKEN='staging-session-token'
npm run qualify:staging -- \
  --base-url 'https://staging.example.com' \
  --environment-id 'env_staging_test' \
  --project-id 'project_staging_test' \
  --provider-instance 'codex' \
  --model 'staging-model' \
  > staging-readiness-evidence.json
unset NEXT_CODER_STAGING_ACCESS_TOKEN
```

The token may instead be placed in a regular mode-`0600` file and supplied with
`--access-token-file PATH`. The command rejects a group/world-readable token file. Never put the
token in a command-line option; no such option exists.

This mode additionally proves, through authenticated same-origin APIs, that:

- production development-token issuance is disabled;
- the selected environment is connector-backed;
- its active connector is online on protocol v1 and has fresh presence plus fresh `ready` T3
  health (120 seconds by default);
- a fresh snapshot traverses cloud → connector → local T3 and reports the environment reachable;
- the explicitly named test project exists and the requested provider/model is currently usable.

Omit the project/provider/model flags when only environment-level readiness is required. Supplying
a platform token without an environment, or test resources without a token, fails before any
authenticated request.

## 3. Completed first-command proof

This mode is intentionally mutating. It creates exactly one new test thread and sends the supplied
prompt. Use only an isolated test project and add the explicit `--exercise-first-command` flag:

```bash
export NEXT_CODER_STAGING_ACCESS_TOKEN='staging-session-token'
export NEXT_CODER_STAGING_PROMPT='Staging qualification: reply with a short readiness confirmation.'
npm run qualify:staging -- \
  --base-url 'https://staging.example.com' \
  --environment-id 'env_staging_test' \
  --project-id 'project_staging_test' \
  --provider-instance 'codex' \
  --model 'staging-model' \
  --exercise-first-command \
  > staging-first-command-evidence.json
unset NEXT_CODER_STAGING_ACCESS_TOKEN NEXT_CODER_STAGING_PROMPT
```

The command refuses to launch until every boundary and readiness check has passed. It requires the
gateway launch response to be `dispatched`, then polls the authenticated command ledger until the
same command is `completed`. Completion must retain the exact environment, thread, project,
provider, model, and `thread.launch` contract. An acknowledgement alone does not pass. A terminal
failure or the bounded three-minute timeout fails the evidence.

The prompt may instead be placed in a regular mode-`0600` file and supplied with
`--prompt-file PATH`. There is no command-line prompt-value option, so private prompt text does not
enter shell history or the process argument list.
The command never archives or deletes the created thread, because cleanup is a separate potentially
destructive operator decision.

## Evidence and redaction

Standard output is one JSON object with schema
`next-coder.staging-qualification.v1`. It contains the target public origin, timestamps,
durations, fixed check names and failure codes, safe state labels/counts, and truncated SHA-256
references for resource correlation. It never contains:

- the platform token or connector credential;
- raw environment, connector, project, thread, command, provider, or model identifiers;
- the prompt, transcript, provider response, error body, stack, or idempotency key.

Treat the evidence file as operational data anyway. Store it with the release record, alongside the
Cloudflare deployment ID and separately collected Queue/R2/Convex/rollover evidence. A passing JSON
result proves only the checks named above. It does not prove hosted Queue retries/DLQ retention,
R2/Convex durability, WebSocket streaming, approval/input flows, sleep/WAN recovery, load, cost,
rollback, browser GPU behavior, or physical controller TLS.

## Hermetic verification

The automated suite never contacts a deployed service. It uses loopback mock servers and verifies
the success, fail-closed, opt-in mutation, timeout/terminal-failure, argument, and redaction paths:

```bash
npm run test:staging-qualification
```

`--allow-http-loopback` exists only for this hermetic test path. It cannot permit plaintext to a
non-loopback origin.
