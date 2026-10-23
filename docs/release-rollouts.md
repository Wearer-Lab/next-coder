# Release Rollouts

Release rollouts are owner-scoped control-plane records for controller firmware and the connector
CLI. They select a bounded cohort, apply compatibility gates, and retain per-target evidence. They
do not publish packages, deploy cloud services, flash hardware, or promote a cohort automatically.

## Safety model

- A rollout begins as `draft`. `start`, `pause`, `resume`, `expand`, `cancel`, `rollback`, and
  `complete` require an explicit, non-secret `evidenceRef` such as a test-run or incident id.
- Percentage cohorts use a stable SHA-256 bucket of rollout id plus target id. Reconciliation cannot
  move a target between buckets. Only an owner may increase the percentage through `expand`.
- Allowlists contain only active devices or connectors owned by the caller. Cross-account and
  revoked targets are rejected when the draft is created.
- Protocol and required-capability checks run again when background work executes. A target that no
  longer qualifies becomes `blocked`; delayed work never relies only on authorization at creation.
- The worker never changes a rollout to `completed` or `rolled_back`. Completion requires every
  assignment to report the expected version and a separate owner action.
- Audit metadata contains ids, versions, states, failure codes, cohort type, percentage, and the
  evidence reference. It does not contain logs, paths, prompts, transcripts, provider output, or
  connector/T3 credentials.

## Target behavior

### Firmware

A firmware rollout references an existing signed release, hardware model, channel, and version.
The reconciler sets the selected device's desired version only after the release, protocol, and
capability gates pass. Devices continue to verify manifest signature, size, SHA-256, OTA partition,
and post-boot health. Status is derived from the device's firmware telemetry.

Rollback requires a prevalidated release for the same hardware and channel. An explicit rollback
pin may select an older version; it still follows the same signed OTA path. `cancel` restores the
desired-version value that existed before this rollout when the rollout still owns the pin. It
cannot undo an image already installed.

### Connector

The current connector contract has no remotely invokable self-update operation. A connector
rollout therefore selects and observes a cohort but reports `awaiting_operator_update` with
`connector_update_requires_local_cli` until that computer reports the target version. The operator
runs the existing local update command on that computer:

```bash
npx @wearer-haitch/connector update --apply --yes --restart-service --version TARGET_VERSION
```

The cloud never runs package-manager commands on a user's machine and never fabricates successful
installation evidence.

## Operator procedure

1. Publish and verify the signed firmware artifact, or use the protected npm connector release
   procedure in [npm-connector-release.md](npm-connector-release.md). A local pack smoke alone is not
   a published connector artifact.
2. In **Settings → Staged fleet rollouts**, create a draft with a small stable percentage or an
   explicit internal allowlist. Set a known rollback version before starting if rollback may be
   required.
3. Inspect the target set, protocol floor, capabilities, and versions. Enter the test evidence id,
   then start the rollout.
4. Inspect each target. Treat `blocked`, `failed`, and `awaiting_operator_update` as distinct states;
   do not infer success from elapsed time or an empty error field.
5. Pause before investigation. Pausing prevents new assignment reconciliation but cannot interrupt
   flash writes or package work already started on a target.
6. Expand only after reviewing external health evidence and entering its reference. Expansion is
   monotonic; create another rollout when the selection policy must change.
7. Complete only after every selected target reports the expected terminal version.
8. On regression, pause, record the incident reference, and choose rollback. Complete the rollback
   only after every assignment reports the rollback version. Cancel a rollout to withdraw remaining
   queued pins without claiming an installed version was reversed.

## Background ownership and recovery

The Node adapter constructs `releaseRolloutRunner` in `createApp()` and starts its 30-second timer
only from `src/server.mjs`. Cloudflare Cron enqueues `rollout.reconcile`; Queue invokes the same
runtime-neutral `runOnce()` through the private Container binding. Repeated Queue delivery and
process restart are safe: assignments are keyed by rollout plus target and a desired-version pin is
idempotent.

Store state is durable in the FileStore and Convex adapters. The owner APIs return summary counts;
the detail API returns bounded per-target rows. A target's failure detail is represented by a stable
reason code rather than arbitrary device or package-manager output.

## API summary

```text
GET  /v1/firmware/releases
GET  /v1/release-rollouts
POST /v1/release-rollouts
GET  /v1/release-rollouts/:id
POST /v1/release-rollouts/:id/actions
```

See [api.md](api.md#release-rollout-controls) for request and response examples.

## Evidence that remains external

Local tests prove state transitions, ownership, Store parity, deterministic selection, idempotency,
compatibility blocks, rollback pinning, Cloudflare Queue ownership, and UI recovery states. They do
not prove npm publication, a hosted Cloudflare rollout, WAN/sleep recovery, package installation on
clean macOS/Linux/Windows hosts, signed downgrade on silicon, or physical bootloader rollback. Record those
separately before broad release.
